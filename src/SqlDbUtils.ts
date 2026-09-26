import Database from "better-sqlite3";
import * as fs from "fs-extra";
import { Span } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  StandardTracer,
  StandardLogger,
  ModuleLogger,
} from "@devopsplaybook.io/otel-utils";

/**
 * Configuration subset required by the SQLite module.
 */
export interface SqlDbConfig {
  DATA_DIR: string;
}

let database: Database.Database;
let tracer: StandardTracer;
let logger: ModuleLogger;

/**
 * Compiled statements are cached: `better-sqlite3` has no internal cache and
 * `prepare()` is the dominant cost on hot paths.  The cache is bounded and is
 * reset by {@link SqlDbUtilsInit} (statements belong to one `Database` handle).
 */
const PREPARED_STATEMENT_CACHE_MAX = 100;
let preparedStatements = new Map<string, Database.Statement>();

function prepareCached(sql: string): Database.Statement {
  let statement = preparedStatements.get(sql);
  if (!statement) {
    if (preparedStatements.size >= PREPARED_STATEMENT_CACHE_MAX) {
      const oldest = preparedStatements.keys().next().value;
      if (oldest !== undefined) {
        preparedStatements.delete(oldest);
      }
    }
    statement = database.prepare(sql);
    preparedStatements.set(sql, statement);
  }
  return statement;
}

/**
 * Injects the OTel tracer and logger instances used by all SQL operations.
 * Must be called once at startup, before {@link SqlDbUtilsInit}.
 */
export function SqlDbUtilsSetOTel(
  tracerIn: StandardTracer,
  loggerIn: StandardLogger,
): void {
  tracer = tracerIn;
  logger = loggerIn.createModuleLogger("SqlDbUtils");
}

/**
 * Opens the SQLite database and applies pending migration files from `sqlDir`.
 *
 * Migration files must follow the naming convention `init-NNNN.sql` and are
 * applied in lexicographic order.  A `metadata` table tracks which migrations
 * have already been applied so they are idempotent.  Each migration file and
 * its `db_version` row are applied inside a single transaction; a failing
 * migration is rolled back and never recorded.
 *
 * SQLite only supports a single writer: run exactly one instance against a
 * given database file.
 *
 * @param context  Parent OTel span.
 * @param config   Configuration with `DATA_DIR`.
 * @param sqlDir   Absolute path to the directory containing SQL migration files.
 */
export async function SqlDbUtilsInit(
  context: Span,
  config: SqlDbConfig,
  sqlDir: string,
): Promise<void> {
  const span = tracer.startSpan("SqlDbUtilsInit", context);
  try {
    await fs.ensureDir(config.DATA_DIR);
    database = new Database(`${config.DATA_DIR}/database.db`);
    preparedStatements = new Map();
    SqlDbUtilsExecSQLFile(span, `${sqlDir}/init-0000.sql`);
    const initFiles = (await fs.readdir(sqlDir)).sort();
    let dbVersionApplied = 0;
    // `metadata.value` has text affinity: a plain MAX(value) is lexicographic and
    // ranks "9" above "10", which re-applies init-0010.sql on every boot.
    const rows = SqlDbUtilsQuerySQL(
      span,
      "SELECT MAX(CAST(value AS INTEGER)) as maxVersion FROM metadata WHERE type='db_version'",
    );
    if (rows.length > 0 && rows[0].maxVersion !== null && rows[0].maxVersion !== undefined) {
      dbVersionApplied = Number(rows[0].maxVersion);
    }
    logger.info(`Current DB Version: ${dbVersionApplied}`, span);
    for (const initFile of initFiles) {
      const regex = /init-(\d+)\.sql/g;
      const match = regex.exec(initFile);
      if (match) {
        const dbVersionInitFile = Number(match[1]);
        if (dbVersionInitFile > dbVersionApplied) {
          logger.info(`Loading init file: ${initFile}`, span);
          applyMigration(span, `${sqlDir}/${initFile}`, dbVersionInitFile);
        }
      }
    }
  } finally {
    span.end();
  }
}

/** Apply one migration file and record its version atomically. */
function applyMigration(context: Span, filename: string, version: number): void {
  const apply = database.transaction(() => {
    SqlDbUtilsExecSQLFile(context, filename);
    SqlDbUtilsExecSQL(
      context,
      "INSERT INTO metadata (type, value, dateCreated) VALUES ('db_version',?,?)",
      [version, new Date().toISOString()],
    );
  });
  apply();
}

/** Returns the underlying `better-sqlite3` Database instance. */
export function SqlDbUtilsGetDatabase(): Database.Database {
  return database;
}

/**
 * Execute a write SQL statement with OTel tracing.
 * @returns Number of rows changed.
 */
export function SqlDbUtilsExecSQL(
  context: Span | undefined,
  sql: string,
  params: unknown[] = [],
): number {
  const span = tracer.startSpan("SqlDbUtilsExecSQL", context);
  try {
    const stmt = prepareCached(sql);
    const result = stmt.run(params);
    span.addEvent(`Impacted Rows: ${result.changes}`);
    return result.changes;
  } catch (error) {
    const err = error as Error;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Execute an entire SQL file (used for migrations).
 * Migration files must not contain their own transaction control statements.
 */
export function SqlDbUtilsExecSQLFile(context: Span, filename: string): void {
  const span = tracer.startSpan("SqlDbUtilsExecSQLFile", context);
  try {
    const sql = fs.readFileSync(filename).toString();
    database.exec(sql);
  } catch (error) {
    const err = error as Error;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Execute a read SQL query with OTel tracing.
 * @returns Array of row objects.
 */
export function SqlDbUtilsQuerySQL(
  context: Span | undefined,
  sql: string,
  params: unknown[] = [],
  debug = false,
): any[] {
  const span = tracer.startSpan("SqlDbUtilsQuerySQL", context);
  if (debug) {
    console.log(sql);
  }
  try {
    const stmt = prepareCached(sql);
    const rows = stmt.all(params);
    return rows;
  } catch (error) {
    const err = error as Error;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw error;
  } finally {
    span.end();
  }
}

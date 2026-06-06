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
 * have already been applied so they are idempotent.
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
  await fs.ensureDir(config.DATA_DIR);
  database = new Database(`${config.DATA_DIR}/database.db`);
  SqlDbUtilsExecSQLFile(span, `${sqlDir}/init-0000.sql`);
  const initFiles = (await fs.readdir(sqlDir)).sort();
  let dbVersionApplied = 0;
  const rows = SqlDbUtilsQuerySQL(
    span,
    "SELECT MAX(value) as maxVersion FROM metadata WHERE type='db_version'",
  );
  if (rows.length > 0 && rows[0].maxVersion) {
    dbVersionApplied = Number(rows[0].maxVersion);
  }
  logger.info(`Current DB Version: ${dbVersionApplied}`, span);
  for (const initFile of initFiles) {
    const regex = /init-(\d+).sql/g;
    const match = regex.exec(initFile);
    if (match) {
      const dbVersionInitFile = Number(match[1]);
      if (dbVersionInitFile > dbVersionApplied) {
        logger.info(`Loading init file: ${initFile}`, span);
        SqlDbUtilsExecSQLFile(span, `${sqlDir}/${initFile}`);
        SqlDbUtilsExecSQL(
          span,
          "INSERT INTO metadata (type, value, dateCreated) VALUES ('db_version',?,?)",
          [dbVersionInitFile, new Date().toISOString()],
        );
      }
    }
  }
  span.end();
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
  context: Span,
  sql: string,
  params: unknown[] = [],
): number {
  const span = tracer.startSpan("SqlDbUtilsExecSQL", context);
  try {
    const stmt = database.prepare(sql);
    const result = stmt.run(params);
    span.addEvent(`Impacted Rows: ${result.changes}`);
    span.end();
    return result.changes;
  } catch (error) {
    const err = error as Error;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.end();
    throw error;
  }
}

/** Execute an entire SQL file (used for migrations). */
export function SqlDbUtilsExecSQLFile(context: Span, filename: string): void {
  const span = tracer.startSpan("SqlDbUtilsExecSQLFile", context);
  try {
    const sql = fs.readFileSync(filename).toString();
    database.exec(sql);
    span.end();
  } catch (error) {
    const err = error as Error;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.end();
    throw error;
  }
}

/**
 * Execute a read SQL query with OTel tracing.
 * @returns Array of row objects.
 */
export function SqlDbUtilsQuerySQL(
  context: Span,
  sql: string,
  params: unknown[] = [],
  debug = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  const span = tracer.startSpan("SqlDbUtilsQuerySQL", context);
  if (debug) {
    console.log(sql);
  }
  try {
    const stmt = database.prepare(sql);
    const rows = stmt.all(params);
    span.end();
    return rows;
  } catch (error) {
    const err = error as Error;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.end();
    throw error;
  }
}

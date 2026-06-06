import { Pool } from "pg";
import * as fs from "fs-extra";
import { Span } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  StandardTracer,
  StandardLogger,
  ModuleLogger,
} from "@devopsplaybook.io/otel-utils";

/**
 * Configuration subset required by the Postgres module.
 */
export interface PostgresDbConfig {
  DATABASE_POSTGRES_HOST: string;
  DATABASE_POSTGRES_PORT: number;
  DATABASE_POSTGRES_USER: string;
  DATABASE_POSTGRES_PASSWORD: string;
  DATABASE_POSTGRES_DATABASE: string;
}

let pool: Pool;
let tracer: StandardTracer;
let logger: ModuleLogger;

/**
 * Injects the OTel tracer and logger instances used by all Postgres operations.
 * Must be called once at startup, before {@link PostgresDbUtilsInit}.
 */
export function PostgresDbUtilsSetOTel(
  tracerIn: StandardTracer,
  loggerIn: StandardLogger,
): void {
  tracer = tracerIn;
  logger = loggerIn.createModuleLogger("PostgresDbUtils");
}

/**
 * Creates the Postgres connection pool and applies pending migration files
 * from `sqlDir`.
 *
 * Migration files must follow the naming convention `init-NNNN.sql` and are
 * applied in lexicographic order.  A `metadata` table tracks which migrations
 * have already been applied so they are idempotent.
 *
 * @param context  Parent OTel span.
 * @param config   Configuration with Postgres connection fields.
 * @param sqlDir   Absolute path to the directory containing SQL migration files
 *                 written for Postgres (with `$1,$2...` placeholders).
 *                 If migrations are SQLite-first, use `convertToPostgresPlaceholders`
 *                 before passing them.
 */
export async function PostgresDbUtilsInit(
  context: Span,
  config: PostgresDbConfig,
  sqlDir: string,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsInit", context);

  pool = new Pool({
    host: config.DATABASE_POSTGRES_HOST,
    port: config.DATABASE_POSTGRES_PORT || 5432,
    user: config.DATABASE_POSTGRES_USER,
    password: config.DATABASE_POSTGRES_PASSWORD,
    database: config.DATABASE_POSTGRES_DATABASE,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  });

  pool.on("error", (err: Error) => {
    logger.error("PostgreSQL pool connection error", err);
  });

  await PostgresDbUtilsExecSQLFile(span, `${sqlDir}/init-0000.sql`);
  const initFiles = (await fs.readdir(sqlDir)).sort();
  let dbVersionApplied = 0;
  const dbVersionQuery = await PostgresDbUtilsQuerySQL(
    span,
    "SELECT MAX(value) as version FROM metadata WHERE \"type\" = 'db_version'",
  );
  if (dbVersionQuery.length > 0 && dbVersionQuery[0].version) {
    dbVersionApplied = Number(dbVersionQuery[0].version);
  }
  logger.info(`Current DB Version: ${dbVersionApplied}`, span);
  for (const initFile of initFiles) {
    const regex = /init-(\d+).sql/g;
    const match = regex.exec(initFile);
    if (match) {
      const dbVersionInitFile = Number(match[1]);
      if (dbVersionInitFile > dbVersionApplied) {
        logger.info(`Loading init file: ${initFile}`, span);
        await PostgresDbUtilsExecSQLFile(span, `${sqlDir}/${initFile}`);
        await PostgresDbUtilsQuerySQL(
          span,
          'INSERT INTO metadata ("type", "value", "dateCreated") VALUES ($1, $2, $3)',
          ["db_version", dbVersionInitFile, new Date().toISOString()],
        );
      }
    }
  }
  span.end();
}

/** Returns the underlying `pg.Pool` instance. */
export function PostgresDbUtilsGetPool(): Pool {
  return pool;
}

/**
 * Execute a write SQL statement with OTel tracing.
 * @returns Number of rows changed.
 */
export function PostgresDbUtilsExecSQL(
  context: Span,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const span = tracer.startSpan("PostgresDbUtilsExecSQL", context);
  return new Promise((resolve, reject) => {
    pool.query(
      sql,
      params,
      (error: Error | null, result: { rowCount: number | null }) => {
        if (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          span.end();
          reject(error);
        } else {
          span.addEvent(`Impacted Rows: ${result.rowCount || 0}`);
          span.end();
          resolve(result.rowCount || 0);
        }
      },
    );
  });
}

/** Execute an entire SQL file (used for migrations). */
export async function PostgresDbUtilsExecSQLFile(
  context: Span,
  filename: string,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsExecSQLFile", context);
  const sql = (await fs.readFile(filename)).toString();
  return new Promise((resolve, reject) => {
    pool.query(sql, (error: Error | null) => {
      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        reject(error);
      } else {
        span.end();
        resolve();
      }
    });
  });
}

/**
 * Execute a read SQL query with OTel tracing.
 * @returns Array of row objects.
 */
export function PostgresDbUtilsQuerySQL(
  context: Span,
  sql: string,
  params: unknown[] = [],
  debug = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const span = tracer.startSpan("PostgresDbUtilsQuerySQL", context);
  if (debug) {
    console.log(sql);
  }
  return new Promise((resolve, reject) => {
    pool.query(
      sql,
      params,
      (error: Error | null, result: { rows: unknown[] }) => {
        if (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          logger.error(`SQL ERROR: ${sql}`, error, span);
          span.end();
          reject(error);
        } else {
          span.end();
          resolve(result.rows);
        }
      },
    );
  });
}

/** Start a transaction. */
export function PostgresDbUtilsTransactionStart(context: Span): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsTransactionStart", context);
  return new Promise((resolve, reject) => {
    pool.query("BEGIN", (error: Error | null) => {
      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        reject(error);
      } else {
        span.end();
        resolve();
      }
    });
  });
}

/** Commit a transaction. */
export function PostgresDbUtilsTransactionCommit(context: Span): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsTransactionCommit", context);
  return new Promise((resolve, reject) => {
    pool.query("COMMIT", (error: Error | null) => {
      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.end();
        reject(error);
      } else {
        span.end();
        resolve();
      }
    });
  });
}

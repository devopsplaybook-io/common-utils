import { Span } from "@opentelemetry/sdk-trace-base";
import { StandardTracer, StandardLogger } from "@devopsplaybook.io/otel-utils";
import * as SqlDbUtils from "./SqlDbUtils";
import * as PostgresDbUtils from "./PostgresDbUtils";

/**
 * Configuration subset required by the unified DB facade.
 */
export interface DbUtilsConfig
  extends SqlDbUtils.SqlDbConfig, PostgresDbUtils.PostgresDbConfig {
  DATABASE_TYPE: "sqlite" | "postgres";
}

let databaseType: "sqlite" | "postgres" = "sqlite";

/**
 * Injects the OTel tracer and logger instances used by the DB layer.
 * Must be called once at startup, before {@link DbUtilsInit}.
 */
export function DbUtilsSetOTel(
  tracer: StandardTracer,
  logger: StandardLogger,
): void {
  SqlDbUtils.SqlDbUtilsSetOTel(tracer, logger);
  PostgresDbUtils.PostgresDbUtilsSetOTel(tracer, logger);
}

/**
 * Initialise the database layer.
 *
 * Dispatches to the SQLite or Postgres backend depending on
 * `config.DATABASE_TYPE` and runs pending migration files from `sqlDir`.
 *
 * @param context  Parent OTel span.
 * @param config   Server configuration.
 * @param sqlDir   Absolute path to the directory containing SQL migration files.
 */
export async function DbUtilsInit(
  context: Span,
  config: DbUtilsConfig,
  sqlDir: string,
): Promise<void> {
  databaseType = config.DATABASE_TYPE;
  if (databaseType === "postgres") {
    await PostgresDbUtils.PostgresDbUtilsInit(context, config, sqlDir);
  } else {
    await SqlDbUtils.SqlDbUtilsInit(context, config, sqlDir);
  }
}

/**
 * Returns the native database handle.
 * - SQLite: `better-sqlite3` `Database` instance
 * - Postgres: `pg` `Pool` instance
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DbUtilsGetDatabase(): any {
  if (databaseType === "postgres") {
    return PostgresDbUtils.PostgresDbUtilsGetPool();
  }
  return SqlDbUtils.SqlDbUtilsGetDatabase();
}

/** Convert SQLite `?` placeholders to PostgreSQL `$1, $2, ...` numbering. */
export function convertToPostgresPlaceholders(sql: string): string {
  let paramIndex = 1;
  return sql.replace(/\?/g, () => `$${paramIndex++}`);
}

/**
 * Execute a write SQL statement with OTel tracing.
 * Automatically converts `?` placeholders to `$N` when using Postgres.
 *
 * @returns Number of rows changed.
 */
export function DbUtilsExecSQL(
  context: Span,
  sql: string,
  params: unknown[] = [],
): number | Promise<number> {
  if (databaseType === "postgres") {
    return PostgresDbUtils.PostgresDbUtilsExecSQL(
      context,
      convertToPostgresPlaceholders(sql),
      params,
    );
  }
  return SqlDbUtils.SqlDbUtilsExecSQL(context, sql, params);
}

/**
 * Execute a read SQL query with OTel tracing.
 * Automatically converts `?` placeholders to `$N` when using Postgres.
 *
 * @returns Array of row objects.
 */
export function DbUtilsQuerySQL(
  context: Span,
  sql: string,
  params: unknown[] = [],
  debug = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] | Promise<any[]> {
  if (databaseType === "postgres") {
    return PostgresDbUtils.PostgresDbUtilsQuerySQL(
      context,
      convertToPostgresPlaceholders(sql),
      params,
      debug,
    );
  }
  return SqlDbUtils.SqlDbUtilsQuerySQL(context, sql, params, debug);
}

/** Returns the active database type (`"sqlite"` or `"postgres"`). */
export function DbUtilsGetType(): "sqlite" | "postgres" {
  return databaseType;
}

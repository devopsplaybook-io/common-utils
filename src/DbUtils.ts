import { Span } from "@opentelemetry/sdk-trace-base";
import { StandardTracer, StandardLogger } from "@devopsplaybook.io/otel-utils";
import * as SqlDbUtils from "./SqlDbUtils";
import * as PostgresDbUtils from "./PostgresDbUtils";

/**
 * Configuration subset required by the unified DB facade.
 */
export interface DbUtilsConfig
  extends SqlDbUtils.SqlDbConfig,
    PostgresDbUtils.PostgresDbConfig {
  DATABASE_TYPE: "sqlite" | "postgres";
}

/**
 * Advisory-lock purposes used by the facade. SQLite has a single writer and
 * runs the callback directly; Postgres serialises concurrently booting
 * replicas on the named lock.
 */
export type DbUtilsLockName = "auth_token" | "users_bootstrap";

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
  if (config.DATABASE_TYPE !== "sqlite" && config.DATABASE_TYPE !== "postgres") {
    throw new Error(
      `Invalid DATABASE_TYPE: ${config.DATABASE_TYPE} (expected "sqlite" or "postgres")`,
    );
  }
  databaseType = config.DATABASE_TYPE;
  if (databaseType === "postgres") {
    await PostgresDbUtils.PostgresDbUtilsInit(context, config, sqlDir);
  } else {
    await SqlDbUtils.SqlDbUtilsInit(context, config, sqlDir);
  }
}

/**
 * Run a bootstrap callback while holding the named advisory lock. Replicas
 * booting concurrently serialise the callback on Postgres; SQLite has a
 * single writer and runs it directly.
 */
export async function DbUtilsWithLock<T>(
  lock: DbUtilsLockName,
  callback: () => Promise<T>,
): Promise<T> {
  if (databaseType === "postgres") {
    return PostgresDbUtils.PostgresDbUtilsWithAdvisoryLock(lock, callback);
  }
  return callback();
}

/**
 * Returns the native database handle.
 * - SQLite: `better-sqlite3` `Database` instance
 * - Postgres: `pg` `Pool` instance
 */
export function DbUtilsGetDatabase(): any {
  if (databaseType === "postgres") {
    return PostgresDbUtils.PostgresDbUtilsGetPool();
  }
  return SqlDbUtils.SqlDbUtilsGetDatabase();
}

/**
 * Convert SQLite `?` placeholders to PostgreSQL `$1, $2, ...` numbering.
 * `?` characters inside single- or double-quoted values, dollar-quoted
 * strings and `--` / block comments are left untouched. The Postgres jsonb
 * `?` operator is not supported: use the function form (`jsonb_exists`).
 */
export function convertToPostgresPlaceholders(sql: string): string {
  let converted = "";
  let paramIndex = 1;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    // Single-quoted literal: '' is an escaped quote.
    if (char === "'") {
      const end = skipQuoted(sql, i, "'");
      converted += sql.slice(i, end);
      i = end;
      continue;
    }
    // Double-quoted identifier, same '' escaping rule.
    if (char === '"') {
      const end = skipQuoted(sql, i, '"');
      converted += sql.slice(i, end);
      i = end;
      continue;
    }
    // Dollar-quoted string: $tag$ ... $tag$ (or $$ ... $$).
    if (char === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const closing = sql.indexOf(tag[0], i + tag[0].length);
        const end = closing === -1 ? sql.length : closing + tag[0].length;
        converted += sql.slice(i, end);
        i = end;
        continue;
      }
      converted += char;
      i++;
      continue;
    }
    // Line comment.
    if (char === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      const end = newline === -1 ? sql.length : newline;
      converted += sql.slice(i, end);
      i = end;
      continue;
    }
    // Block comment.
    if (char === "/" && sql[i + 1] === "*") {
      const closing = sql.indexOf("*/", i + 2);
      const end = closing === -1 ? sql.length : closing + 2;
      converted += sql.slice(i, end);
      i = end;
      continue;
    }
    if (char === "?") {
      converted += `$${paramIndex++}`;
      i++;
      continue;
    }
    converted += char;
    i++;
  }
  return converted;
}

/** Returns the index just past the closing quote (unterminated → end of string). */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/**
 * Execute a write SQL statement with OTel tracing.
 * Automatically converts `?` placeholders to `$N` when using Postgres.
 *
 * @returns Number of rows changed.
 */
export function DbUtilsExecSQL(
  context: Span | undefined,
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
  context: Span | undefined,
  sql: string,
  params: unknown[] = [],
  debug = false,
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

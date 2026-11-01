import type { Span } from "@opentelemetry/sdk-trace";
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
 * runs the callback directly; Postgres serialises concurrent callers and
 * replicas on the named lock. Any name is accepted: the Postgres backend
 * derives a deterministic key for names outside the historical set.
 */
export type DbUtilsLockName = "auth_token" | "users_bootstrap" | (string & {});

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
 *
 * @param context  Optional parent span forwarded to the Postgres advisory
 *                 lock so the wait appears in the caller's trace.
 */
export async function DbUtilsWithLock<T>(
  lock: DbUtilsLockName,
  callback: () => Promise<T>,
  context?: Span,
): Promise<T> {
  if (databaseType === "postgres") {
    return PostgresDbUtils.PostgresDbUtilsWithAdvisoryLock(
      lock,
      callback,
      context,
    );
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
 * strings and `--` / block comments are left untouched. Single-quoted
 * literals honour the standard `''` doubled-quote escape; when the literal
 * is prefixed with `E`/`e` backslash escapes are honoured as well
 * (`E'it\'s ?'`). Ordinary strings follow `standard_conforming_strings`.
 * The Postgres jsonb `?` operator is not supported: use the function form
 * (`jsonb_exists`).
 */
export function convertToPostgresPlaceholders(sql: string): string {
  let converted = "";
  let paramIndex = 1;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    // Single-quoted literal: '' is an escaped quote; an E-prefixed literal
    // also honours backslash escapes.
    if (char === "'") {
      const end = skipQuoted(sql, i, "'", isEStringPrefix(sql, i));
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

/**
 * Whether the single quote at `quoteIndex` opens an E-string (`E'...'`) whose
 * body honours backslash escapes. The `E` must not itself be the tail of an
 * identifier (e.g. `SOMEE'...'`).
 */
function isEStringPrefix(sql: string, quoteIndex: number): boolean {
  const prefix = sql[quoteIndex - 1];
  if (prefix !== "E" && prefix !== "e") {
    return false;
  }
  const beforePrefix = sql[quoteIndex - 2];
  return beforePrefix === undefined || !/[A-Za-z0-9_$]/.test(beforePrefix);
}

/** Returns the index just past the closing quote (unterminated → end of string). */
function skipQuoted(
  sql: string,
  start: number,
  quote: string,
  backslashEscapes = false,
): number {
  let i = start + 1;
  while (i < sql.length) {
    if (backslashEscapes && sql[i] === "\\") {
      // Skip the escaped character so `\'` does not close the literal.
      i += 2;
      continue;
    }
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
 * `convertToPostgresPlaceholders` is linear in the SQL length and runs on
 * every facade call, including hot paths that re-use the same generated
 * statement. Results are cached in a bounded LRU so a stream of one-shot
 * statements cannot grow the cache without limit.
 */
const CONVERTED_SQL_CACHE_MAX = 500;
const convertedSqlCache = new Map<string, string>();

/** {@link convertToPostgresPlaceholders} with a bounded LRU result cache. */
export function convertToPostgresPlaceholdersCached(sql: string): string {
  const cached = convertedSqlCache.get(sql);
  if (cached !== undefined) {
    // LRU: move the hit to the most-recently-used position.
    convertedSqlCache.delete(sql);
    convertedSqlCache.set(sql, cached);
    return cached;
  }
  const converted = convertToPostgresPlaceholders(sql);
  if (convertedSqlCache.size >= CONVERTED_SQL_CACHE_MAX) {
    const oldest = convertedSqlCache.keys().next().value;
    if (oldest !== undefined) {
      convertedSqlCache.delete(oldest);
    }
  }
  convertedSqlCache.set(sql, converted);
  return converted;
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
      convertToPostgresPlaceholdersCached(sql),
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
      convertToPostgresPlaceholdersCached(sql),
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

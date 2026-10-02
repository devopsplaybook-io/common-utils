import { StandardLogger, ModuleLogger } from "@devopsplaybook.io/otel-utils";
import {
  DbUtilsGetDatabase,
  DbUtilsGetType,
  convertToPostgresPlaceholders,
} from "./DbUtils";

let logger: ModuleLogger;

/** Promise-based view of the `pg.Pool` handle returned by {@link DbUtilsGetDatabase}. */
interface PgQueryable {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

/**
 * Compiled SQLite statements are cached per database handle: `better-sqlite3`
 * has no internal cache and `prepare()` dominates the ingestion hot path.
 * The cache evicts the least-recently-used entry (a hit re-inserts the
 * statement), so a hot statement survives a stream of one-shot statements.
 */
const PREPARED_STATEMENT_CACHE_MAX = 100;
const statementCaches = new WeakMap<object, Map<string, any>>();

function prepareCached(db: object, sql: string): any {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map<string, any>();
    statementCaches.set(db, cache);
  }
  const cached = cache.get(sql);
  if (cached !== undefined) {
    // LRU: move the hit to the most-recently-used position.
    cache.delete(sql);
    cache.set(sql, cached);
    return cached;
  }
  if (cache.size >= PREPARED_STATEMENT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  const statement = (db as { prepare: (sql: string) => any }).prepare(sql);
  cache.set(sql, statement);
  return statement;
}

/** Maximum number of bound parameters per statement on each backend. */
const PARAMS_PER_STATEMENT = { postgres: 65535, sqlite: 32766 };

/**
 * Injects the OTel logger instance used by no-telemetry DB operations.
 * Must be called once at startup.
 */
export function DbUtilsNoTelemetrySetLogger(loggerIn: StandardLogger): void {
  logger = loggerIn.createModuleLogger("DbUtilsNoTelemetry");
}

/**
 * Execute a multi-row INSERT with a flat parameter array.
 * Builds: INSERT INTO <tableCols> VALUES (?,?...),(?,?...),...
 *
 * Large inputs are chunked so the statement never exceeds the backend's
 * bound-parameter limit (65535 on Postgres, 32766 on SQLite).
 *
 * @returns Number of rows inserted (summed across chunks).
 */
export function DbUtilsNoTelemetryBatchInsert(
  tableCols: string,
  numCols: number,
  rows: any[][],
): number | Promise<number> {
  if (rows.length === 0) return 0;
  const dbType = DbUtilsGetType();
  const maxRowsPerChunk = Math.max(
    1,
    Math.floor(PARAMS_PER_STATEMENT[dbType] / Math.max(1, numCols)),
  );
  if (rows.length <= maxRowsPerChunk) {
    return DbUtilsNoTelemetryExecSQL(
      buildBatchInsertSQL(tableCols, numCols, rows.length),
      rows.flat(),
    );
  }
  const chunks: any[][][] = [];
  for (let i = 0; i < rows.length; i += maxRowsPerChunk) {
    chunks.push(rows.slice(i, i + maxRowsPerChunk));
  }
  if (dbType === "postgres") {
    return execChunksSequentially(chunks, tableCols, numCols);
  }
  let total = 0;
  for (const chunk of chunks) {
    total += DbUtilsNoTelemetryExecSQL(
      buildBatchInsertSQL(tableCols, numCols, chunk.length),
      chunk.flat(),
    ) as number;
  }
  return total;
}

function buildBatchInsertSQL(
  tableCols: string,
  numCols: number,
  rowCount: number,
): string {
  const rowSQL = `(${Array.from({ length: numCols }, () => "?").join(",")})`;
  const multiValues = Array.from({ length: rowCount }, () => rowSQL).join(",");
  return `INSERT ${tableCols} VALUES ${multiValues}`;
}

async function execChunksSequentially(
  chunks: any[][][],
  tableCols: string,
  numCols: number,
): Promise<number> {
  let total = 0;
  for (const chunk of chunks) {
    total += (await DbUtilsNoTelemetryExecSQL(
      buildBatchInsertSQL(tableCols, numCols, chunk.length),
      chunk.flat(),
    )) as number;
  }
  return total;
}

/**
 * Execute a write SQL statement **without** creating an OTel span.
 * Use this on high-throughput paths where span overhead matters.
 *
 * @returns Number of rows changed.
 */
export function DbUtilsNoTelemetryExecSQL(
  sql: string,
  params: unknown[] = [],
): number | Promise<number> {
  const dbType = DbUtilsGetType();
  if (dbType === "postgres") {
    const pgSql = convertToPostgresPlaceholders(sql);
    return (DbUtilsGetDatabase() as PgQueryable)
      .query(pgSql, params)
      .then((result) => result.rowCount || 0)
      .catch((error: Error) => {
        logger.error(`SQL INSERT ERROR: ${sql.substring(0, 200)}`, error);
        throw error;
      });
  }
  // SQLite (better-sqlite3) – synchronous
  const db = DbUtilsGetDatabase();
  const stmt = prepareCached(db, sql);
  const result = stmt.run(params);
  return result.changes;
}

/**
 * Execute a read SQL query **without** creating an OTel span.
 * Use this on high-throughput paths where span overhead matters.
 *
 * @returns Array of row objects.
 */
export function DbUtilsNoTelemetryQuerySQL(
  sql: string,
  params: unknown[] = [],
  debug = false,
): any[] | Promise<any[]> {
  if (debug) {
    console.log(sql);
  }
  const dbType = DbUtilsGetType();
  if (dbType === "postgres") {
    const pgSql = convertToPostgresPlaceholders(sql);
    return (DbUtilsGetDatabase() as PgQueryable)
      .query(pgSql, params)
      .then((result) => result.rows)
      .catch((error: Error) => {
        logger.error(`SQL ERROR: ${sql}`, error);
        throw error;
      });
  }
  // SQLite (better-sqlite3) – synchronous
  const stmt = prepareCached(DbUtilsGetDatabase(), sql);
  return stmt.all(params);
}

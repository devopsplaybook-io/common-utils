import { StandardLogger, ModuleLogger } from "@devopsplaybook.io/otel-utils";
import {
  DbUtilsGetDatabase,
  DbUtilsGetType,
  convertToPostgresPlaceholders,
} from "./DbUtils";

let logger: ModuleLogger | undefined;

/** Promise-based view of the `pg.Pool` handle returned by {@link DbUtilsGetDatabase}. */
interface PgQueryable {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

/** Optional `pg.Pool.connect` used to pin one client for a batch insert. */
interface PgPoolLike extends PgQueryable {
  connect?: () => Promise<PgQueryable & { release: () => void }>;
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
 * `convertToPostgresPlaceholders` is linear in the SQL length and runs on
 * every call, including hot ingestion paths that re-use the same generated
 * statement. Results are cached in a bounded LRU so a stream of one-shot
 * statements cannot grow the cache without limit.
 */
const CONVERTED_SQL_CACHE_MAX = 500;
const convertedSqlCache = new Map<string, string>();

function convertCached(sql: string): string {
  const cached = convertedSqlCache.get(sql);
  if (cached !== undefined) {
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

function logError(message: string, error: Error): void {
  logger?.error(message, error);
}

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
 * bound-parameter limit (65535 on Postgres, 32766 on SQLite). A chunked
 * batch is atomic: all chunks commit together or the batch rolls back.
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
    return execChunksInTransaction(chunks, tableCols, numCols);
  }
  return execChunksSqliteTransactional(chunks, tableCols, numCols);
}

/** Insert every chunk, returning the summed row count. */
function insertChunks(
  chunks: any[][][],
  tableCols: string,
  numCols: number,
): number {
  let total = 0;
  for (const chunk of chunks) {
    total += DbUtilsNoTelemetryExecSQL(
      buildBatchInsertSQL(tableCols, numCols, chunk.length),
      chunk.flat(),
    ) as number;
  }
  return total;
}

/**
 * SQLite: run all chunks inside one `better-sqlite3` transaction so a
 * failure mid-batch rolls the whole insert back instead of leaving the
 * caller with an unknown prefix of the rows.
 */
function execChunksSqliteTransactional(
  chunks: any[][][],
  tableCols: string,
  numCols: number,
): number {
  const db = DbUtilsGetDatabase() as {
    transaction?: (fn: () => number) => () => number;
  };
  if (typeof db.transaction === "function") {
    return db.transaction(() => insertChunks(chunks, tableCols, numCols))();
  }
  return insertChunks(chunks, tableCols, numCols);
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
 * Postgres: run all chunks on one pooled client inside BEGIN/COMMIT. The
 * whole batch commits or rolls back together; without `connect()` (e.g. a
 * bare queryable) the chunks fall back to sequential autocommit inserts.
 */
async function execChunksInTransaction(
  chunks: any[][][],
  tableCols: string,
  numCols: number,
): Promise<number> {
  const db = DbUtilsGetDatabase() as PgPoolLike;
  if (typeof db.connect !== "function") {
    return execChunksSequentially(chunks, tableCols, numCols);
  }
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("BEGIN", []);
    let total = 0;
    for (const chunk of chunks) {
      const sql = convertCached(
        buildBatchInsertSQL(tableCols, numCols, chunk.length),
      );
      const result = await client.query(sql, chunk.flat());
      total += result.rowCount || 0;
    }
    await client.query("COMMIT", []);
    committed = true;
    return total;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK", []).catch(() => {
        // Connection failure: nothing to roll back.
      });
    }
    logError(`SQL BATCH INSERT ERROR: ${tableCols}`, error as Error);
    throw error;
  } finally {
    client.release();
  }
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
    const pgSql = convertCached(sql);
    return (DbUtilsGetDatabase() as PgQueryable)
      .query(pgSql, params)
      .then((result) => result.rowCount || 0)
      .catch((error: Error) => {
        logError(`SQL INSERT ERROR: ${sql.substring(0, 200)}`, error);
        throw error;
      });
  }
  // SQLite (better-sqlite3) – synchronous
  try {
    const db = DbUtilsGetDatabase();
    const stmt = prepareCached(db, sql);
    const result = stmt.run(params);
    return result.changes;
  } catch (error) {
    logError(`SQL INSERT ERROR: ${sql.substring(0, 200)}`, error as Error);
    throw error;
  }
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
    const pgSql = convertCached(sql);
    return (DbUtilsGetDatabase() as PgQueryable)
      .query(pgSql, params)
      .then((result) => result.rows)
      .catch((error: Error) => {
        logError(`SQL ERROR: ${sql}`, error);
        throw error;
      });
  }
  // SQLite (better-sqlite3) – synchronous
  try {
    const stmt = prepareCached(DbUtilsGetDatabase(), sql);
    return stmt.all(params);
  } catch (error) {
    logError(`SQL ERROR: ${sql}`, error as Error);
    throw error;
  }
}

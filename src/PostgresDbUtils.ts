import { Pool, PoolClient, PoolConfig } from "pg";
import * as fs from "fs-extra";
import type { Span } from "@opentelemetry/sdk-trace";
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
  /**
   * Optional per-session `statement_timeout` (milliseconds) applied to every
   * pool. Disabled when absent or 0 (backward-compatible default).
   */
  DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS?: number;
  /**
   * Optional per-session `idle_in_transaction_session_timeout` (milliseconds)
   * applied to every pool. Disabled when absent or 0.
   */
  DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS?: number;
}

/**
 * Named advisory-lock purposes. The three historical names keep a fixed
 * 32-bit key (the first four ASCII characters of the purpose) so that every
 * replica of every service booting against the same database serialises the
 * same operation; any other name is accepted and hashed deterministically.
 */
export type PostgresLockName =
  | "migration"
  | "auth_token"
  | "users_bootstrap"
  | (string & {});

export const POSTGRES_LOCK_KEYS: Record<string, number> = {
  migration: 0x6d696772, // "migr"
  auth_token: 0x61757468, // "auth"
  users_bootstrap: 0x75736572, // "user"
};

/**
 * Schema and search_path segments are interpolated into SQL, so they must be
 * plain unquoted identifiers. Rejecting anything else prevents an injection
 * through a misconfigured schema name.
 */
const SCHEMA_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidSchemaName(name: string): void {
  if (!SCHEMA_NAME_RE.test(name)) {
    throw new Error(
      `Invalid PostgreSQL schema name: "${name}" (expected an unquoted identifier)`,
    );
  }
}

/** Validate every comma-separated segment of a `search_path` setting. */
function assertValidSearchPath(searchPath: string): void {
  for (const rawSegment of searchPath.split(",")) {
    const segment = rawSegment.trim();
    // `$user` is a built-in search_path keyword, not an identifier.
    if (segment === "$user" || segment === '"$user"') {
      continue;
    }
    assertValidSchemaName(segment);
  }
}

/** Cap applied to the `db.statement` span attribute (placeholders only). */
const DB_STATEMENT_MAX_LENGTH = 4096;

function truncateDbStatement(sql: string): string {
  return sql.length <= DB_STATEMENT_MAX_LENGTH
    ? sql
    : sql.slice(0, DB_STATEMENT_MAX_LENGTH);
}

/** Add the standard `db.*` attributes to a Postgres span. */
function setDbSpanAttributes(span: { setAttributes: (a: any) => void }, sql: string): void {
  span.setAttributes({
    "db.system": "postgresql",
    "db.statement": truncateDbStatement(sql),
  });
}

/**
 * 32-bit FNV-1a hash, stable across processes, replicas and restarts.
 * Returns an unsigned 32-bit integer.
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Resolve the Postgres advisory-lock key of a purpose name. The three
 * historical names keep their exact keys; every other name is mapped through
 * the deterministic {@link fnv1a32} hash so all replicas agree on it.
 */
export function PostgresAdvisoryLockKey(lock: PostgresLockName): number {
  const knownKey = POSTGRES_LOCK_KEYS[lock];
  return knownKey !== undefined ? knownKey : fnv1a32(lock);
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let pool: Pool | undefined;
let tracer: StandardTracer;
let logger: ModuleLogger;
let standardLogger: StandardLogger;

/** @throws when called before {@link PostgresDbUtilsInit}. */
function requirePool(): Pool {
  if (!pool) {
    throw new Error(
      "Postgres pool not initialized; call PostgresDbUtilsInit first",
    );
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build the connection options shared by every pool. */
function buildPoolConfig(
  config: PostgresDbConfig,
  searchPath: string | undefined,
  max: number,
  keepAlive: boolean,
): PoolConfig {
  const poolConfig: PoolConfig = {
    host: config.DATABASE_POSTGRES_HOST,
    port: config.DATABASE_POSTGRES_PORT || 5432,
    user: config.DATABASE_POSTGRES_USER,
    password: config.DATABASE_POSTGRES_PASSWORD,
    database: config.DATABASE_POSTGRES_DATABASE,
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive,
  };
  if (searchPath) {
    poolConfig.options = `-c search_path=${searchPath}`;
  }
  if (config.DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS) {
    poolConfig.statement_timeout = config.DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS;
  }
  if (config.DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS) {
    poolConfig.idle_in_transaction_session_timeout =
      config.DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS;
  }
  return poolConfig;
}

/**
 * Run a callback while holding a session-level advisory lock on the given
 * client. Replicas booting concurrently serialise on the lock instead of
 * applying the same migration twice.
 *
 * When a parent span is given (`context`), a `PostgresDbUtilsAdvisoryLock`
 * span is created under it so lock waits appear in the trace of the caller.
 */
async function withAdvisoryLockOnClient<T>(
  client: PoolClient,
  lockKey: number,
  callback: () => Promise<T>,
  context?: Span,
): Promise<T> {
  const span = context
    ? tracer.startSpan("PostgresDbUtilsAdvisoryLock", context)
    : undefined;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
    try {
      return await callback();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {
        // The connection may already be broken; the lock dies with it.
      });
    }
  } finally {
    span?.end();
  }
}

/** Run one query on a dedicated client with its own span. */
async function queryOnClient(
  client: PoolClient,
  context: Span,
  spanName: string,
  sql: string,
  params: unknown[] = [],
): Promise<any[]> {
  const span = tracer.startSpan(spanName, context);
  setDbSpanAttributes(span, sql);
  try {
    const result = await client.query(sql, params);
    span.setAttributes({ "db.rows_returned": result.rows.length });
    return result.rows;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Apply one SQL file on a dedicated client inside a transaction, together
 * with its `metadata` version row when a version is given. On failure the
 * transaction is rolled back: no partial state, no version row.
 *
 * Migration files must not contain their own transaction control statements.
 */
async function applyMigrationOnClient(
  client: PoolClient,
  context: Span,
  filename: string,
  version: number | null,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsExecSQLFile", context);
  try {
    const sql = (await fs.readFile(filename)).toString();
    setDbSpanAttributes(span, sql);
    span.setAttributes({ "db.sql.file": filename });
    await client.query("BEGIN");
    try {
      await client.query(sql);
      if (version !== null) {
        await client.query(
          'INSERT INTO metadata ("type", "value", "dateCreated") VALUES ($1, $2, $3)',
          ["db_version", version, new Date().toISOString()],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // Connection failure: nothing to roll back.
      });
      throw error;
    }
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

/** Read the highest applied migration version (numeric, not lexicographic). */
async function readAppliedVersion(
  client: PoolClient,
  context: Span,
  spanName: string,
): Promise<number> {
  // `metadata.value` has text affinity: a plain MAX(value) is lexicographic and
  // ranks "9" above "10", which re-applies init-0010.sql on every boot.
  const rows = await queryOnClient(
    client,
    context,
    spanName,
    "SELECT MAX(CAST(value AS INTEGER)) as version FROM metadata WHERE \"type\" = 'db_version'",
  );
  if (rows.length > 0 && rows[0].version !== null && rows[0].version !== undefined) {
    return Number(rows[0].version);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Class-based API – supports per-schema pools + shared runtime pool
// ---------------------------------------------------------------------------

/**
 * Class-based PostgreSQL utility that manages a schema-specific pool (used
 * during migrations) and an optional shared runtime pool (used for
 * application queries).
 *
 * Multiple instances can coexist, each bound to a different PostgreSQL
 * schema, while sharing a single runtime pool that has all schemas in its
 * `search_path`.
 */
export class PostgresSchemaDbUtils {
  private schemaPool: Pool | null = null;
  private runtimePool: Pool | null = null;
  private readonly schemaName: string;
  private _moduleLogger: ModuleLogger | null = null;

  constructor(schemaName: string) {
    assertValidSchemaName(schemaName);
    this.schemaName = schemaName;
  }

  private get moduleLogger(): ModuleLogger {
    if (!this._moduleLogger) {
      this._moduleLogger = standardLogger.createModuleLogger(
        `PostgresSchemaDbUtils[${this.schemaName}]`,
      );
    }
    return this._moduleLogger;
  }

  /**
   * Create the schema-specific pool, ensure the schema exists, and apply
   * any pending migration files from `sqlDir`.
   */
  async initSchema(
    context: Span,
    config: PostgresDbConfig,
    sqlDir: string,
  ): Promise<void> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsInit", context);
    try {
      if (this.schemaPool) {
        this.moduleLogger.info("Closing existing schema pool");
        await this.schemaPool.end().catch(() => {
          // Ignore errors on close
        });
      }
      const schemaPool = new Pool(
        buildPoolConfig(config, this.schemaName, 5, false),
      );
      this.schemaPool = schemaPool;
      this.moduleLogger.info(
        `Schema pool initialized with search_path: ${this.schemaName}`,
      );

      const client = await schemaPool.connect();
      try {
        await withAdvisoryLockOnClient(
          client,
          POSTGRES_LOCK_KEYS.migration,
          async () => {
            await queryOnClient(
              client,
              span,
              "PostgresSchemaDbUtilsExecSQLForSchema",
              `CREATE SCHEMA IF NOT EXISTS ${this.schemaName};`,
            );
            await queryOnClient(
              client,
              span,
              "PostgresSchemaDbUtilsExecSQLForSchema",
              `SET search_path TO ${this.schemaName};`,
            );
            await applyMigrationOnClient(
              client,
              span,
              `${sqlDir}/init-0000.sql`,
              null,
            );

            let dbVersionApplied = 0;
            try {
              dbVersionApplied = await readAppliedVersion(
                client,
                span,
                "PostgresSchemaDbUtilsQuerySQLForSchema",
              );
            } catch {
              // The metadata table might not exist yet
            }
            this.moduleLogger.info(`Current DB Version: ${dbVersionApplied}`);

            const initFiles = (await fs.readdir(sqlDir)).sort();
            for (const initFile of initFiles) {
              const match = /^init-(\d+)\.sql$/.exec(initFile);
              if (match) {
                const dbVersionInitFile = Number(match[1]);
                if (dbVersionInitFile > dbVersionApplied) {
                  this.moduleLogger.info(`Applying migration: ${initFile}`);
                  await applyMigrationOnClient(
                    client,
                    span,
                    `${sqlDir}/${initFile}`,
                    dbVersionInitFile,
                  );
                }
              }
            }
          },
        );
      } finally {
        client.release();
      }
    } finally {
      span.end();
    }
  }

  /**
   * Initialise (or replace) the shared runtime pool.
   * Typically called once with a pool whose `search_path` includes all
   * application schemas.
   *
   * The new pool is assigned before the previous pool is closed and the
   * closure is awaited, so concurrent re-initialisations cannot leave a
   * half-initialised state or an unclosed pool behind: every caller awaits
   * a fully initialised pool.
   */
  async initRuntimePool(
    config: PostgresDbConfig,
    searchPath?: string,
  ): Promise<void> {
    const effectiveSearchPath = searchPath || this.schemaName;
    assertValidSearchPath(effectiveSearchPath);
    const previousPool = this.runtimePool;
    this.runtimePool = new Pool(
      buildPoolConfig(config, effectiveSearchPath, 20, true),
    );
    if (previousPool) {
      await previousPool.end().catch(() => {
        // Ignore errors on close
      });
    }
    this.moduleLogger.info(
      `Runtime pool initialized (search_path: ${effectiveSearchPath})`,
    );
  }

  /**
   * Execute a write SQL statement with OTel tracing.
   * @param useSchemaPool  When `true` use the schema-specific pool;
   *                       otherwise use the runtime pool (default).
   * @returns Number of rows changed.
   */
  async execSQL(
    context: Span,
    sql: string,
    params: any[] = [],
    useSchemaPool = false,
  ): Promise<number> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsExecSQL", context);
    let targetPool: Pool | null = null;
    try {
      targetPool = useSchemaPool ? this.schemaPool : this.runtimePool;
      if (!targetPool) {
        throw new Error(
          `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
        );
      }
      setDbSpanAttributes(span, sql);
      const result = await targetPool.query(sql, params);
      span.setAttributes({ "db.rows_affected": result.rowCount || 0 });
      return result.rowCount || 0;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      if (targetPool) {
        this.moduleLogger.error(
          `[${useSchemaPool ? this.schemaName : "RUNTIME"}] SQL EXEC ERROR: ${sql}`,
          error as Error,
        );
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Execute an entire SQL file (used for migrations).
   * Migration files must not contain their own transaction control statements.
   */
  async execSQLFile(
    context: Span,
    filename: string,
    useSchemaPool = false,
  ): Promise<void> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsExecSQLFile", context);
    let targetPool: Pool | null = null;
    try {
      targetPool = useSchemaPool ? this.schemaPool : this.runtimePool;
      if (!targetPool) {
        throw new Error(
          `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
        );
      }
      const sql = (await fs.readFile(filename)).toString();
      setDbSpanAttributes(span, sql);
      span.setAttributes({ "db.sql.file": filename });
      await targetPool.query(sql);
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Execute a read SQL query with OTel tracing.
   * @returns Array of row objects.
   */
  async querySQL(
    context: Span,
    sql: string,
    params: any[] = [],
    useSchemaPool = false,
  ): Promise<any[]> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsQuerySQL", context);
    let targetPool: Pool | null = null;
    try {
      targetPool = useSchemaPool ? this.schemaPool : this.runtimePool;
      if (!targetPool) {
        throw new Error(
          `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
        );
      }
      setDbSpanAttributes(span, sql);
      const result = await targetPool.query(sql, params);
      span.setAttributes({ "db.rows_returned": result.rows.length });
      return result.rows;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      if (targetPool) {
        this.moduleLogger.error(
          `[${useSchemaPool ? this.schemaName : "RUNTIME"}] SQL QUERY ERROR: ${sql}`,
          error as Error,
        );
      }
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Run a callback inside a transaction.
   */
  async transaction(
    context: Span,
    callback: (client: any) => Promise<void>,
    useSchemaPool = false,
  ): Promise<void> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsTransaction", context);
    let client: PoolClient | null = null;
    try {
      const pool = useSchemaPool ? this.schemaPool : this.runtimePool;
      if (!pool) {
        throw new Error(
          `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
        );
      }
      client = await pool.connect();
      await client.query("BEGIN");
      await callback(client);
      await client.query("COMMIT");
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {
          // Connection failure: nothing to roll back.
        });
        this.moduleLogger.error(
          `[${useSchemaPool ? this.schemaName : "RUNTIME"}] Transaction rolled back`,
          error as Error,
        );
      }
      throw error;
    } finally {
      if (client) {
        client.release();
      }
      span.end();
    }
  }

  /** Close both the schema pool and the runtime pool. */
  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.schemaPool) {
      this.moduleLogger.info("Closing schema pool");
      promises.push(
        this.schemaPool.end().catch(() => {
          this.moduleLogger.warn("Error closing schema pool");
        }),
      );
      this.schemaPool = null;
    }

    if (this.runtimePool) {
      this.moduleLogger.info("Closing runtime pool");
      promises.push(
        this.runtimePool.end().catch(() => {
          this.moduleLogger.warn("Error closing runtime pool");
        }),
      );
      this.runtimePool = null;
    }

    await Promise.all(promises);
    this.moduleLogger.info("All database pools closed");
  }
}

// ---------------------------------------------------------------------------
// Functional API – single-pool mode used by the DbUtils facade.
// ---------------------------------------------------------------------------

/**
 * Injects the OTel tracer and logger instances used by all Postgres operations.
 * Must be called once at startup, before {@link PostgresDbUtilsInit}.
 */
export function PostgresDbUtilsSetOTel(
  tracerIn: StandardTracer,
  loggerIn: StandardLogger,
): void {
  tracer = tracerIn;
  standardLogger = loggerIn;
  logger = loggerIn.createModuleLogger("PostgresDbUtils");
}

/**
 * Creates the Postgres connection pool and applies pending migration files
 * from `sqlDir`.
 *
 * Migrations are applied under a session-level advisory lock (concurrently
 * booting replicas serialise instead of double-applying) and each file plus
 * its `db_version` row runs in its own transaction: a failing migration is
 * rolled back and never recorded.
 *
 * Intended to be called once at startup. Calling it again replaces the pool
 * and closes the previous one, so no connections are leaked.
 */
export async function PostgresDbUtilsInit(
  context: Span,
  config: PostgresDbConfig,
  sqlDir: string,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsInit", context);
  try {
    const previousPool = pool;
    pool = undefined;
    if (previousPool) {
      await previousPool.end().catch(() => {
        // Ignore errors on close
      });
    }
    const newPool = new Pool(buildPoolConfig(config, undefined, 20, true));
    pool = newPool;

    newPool.on("error", (err: Error) => {
      logger.error("PostgreSQL pool connection error", err);
    });

    const client = await newPool.connect();
    try {
      await withAdvisoryLockOnClient(
        client,
        POSTGRES_LOCK_KEYS.migration,
        async () => {
          await applyMigrationOnClient(
            client,
            span,
            `${sqlDir}/init-0000.sql`,
            null,
          );
          const dbVersionApplied = await readAppliedVersion(
            client,
            span,
            "PostgresDbUtilsQuerySQL",
          );
          logger.info(`Current DB Version: ${dbVersionApplied}`, span);
          const initFiles = (await fs.readdir(sqlDir)).sort();
          for (const initFile of initFiles) {
            const match = /^init-(\d+)\.sql$/.exec(initFile);
            if (match) {
              const dbVersionInitFile = Number(match[1]);
              if (dbVersionInitFile > dbVersionApplied) {
                logger.info(`Loading init file: ${initFile}`, span);
                await applyMigrationOnClient(
                  client,
                  span,
                  `${sqlDir}/${initFile}`,
                  dbVersionInitFile,
                );
              }
            }
          }
        },
      );
    } finally {
      client.release();
    }
  } finally {
    span.end();
  }
}

/**
 * Run a callback while holding a Postgres advisory lock, serialising the
 * callback across every replica of every service booting against the same
 * database (used for the `auth_token` and first-user bootstrap races).
 *
 * @param context  Optional parent span: when given, a connected
 *                 `PostgresDbUtilsAdvisoryLock` span is created under it.
 */
export async function PostgresDbUtilsWithAdvisoryLock<T>(
  lock: PostgresLockName,
  callback: () => Promise<T>,
  context?: Span,
): Promise<T> {
  const client = await requirePool().connect();
  try {
    return await withAdvisoryLockOnClient(
      client,
      PostgresAdvisoryLockKey(lock),
      callback,
      context,
    );
  } finally {
    client.release();
  }
}

/** Returns the underlying `pg.Pool` instance (undefined before init). */
export function PostgresDbUtilsGetPool(): Pool {
  return pool as Pool;
}

/**
 * Execute a write SQL statement with OTel tracing.
 * @returns Number of rows changed.
 */
export async function PostgresDbUtilsExecSQL(
  context: Span | undefined,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const span = tracer.startSpan("PostgresDbUtilsExecSQL", context);
  try {
    setDbSpanAttributes(span, sql);
    const result = await requirePool().query(sql, params);
    span.setAttributes({ "db.rows_affected": result.rowCount || 0 });
    span.addEvent(`Impacted Rows: ${result.rowCount || 0}`);
    return result.rowCount || 0;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Execute an entire SQL file (used for migrations).
 * Migration files must not contain their own transaction control statements.
 */
export async function PostgresDbUtilsExecSQLFile(
  context: Span | undefined,
  filename: string,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsExecSQLFile", context);
  try {
    const sql = (await fs.readFile(filename)).toString();
    setDbSpanAttributes(span, sql);
    span.setAttributes({ "db.sql.file": filename });
    await requirePool().query(sql);
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Execute a read SQL query with OTel tracing.
 * @returns Array of row objects.
 */
export async function PostgresDbUtilsQuerySQL(
  context: Span | undefined,
  sql: string,
  params: unknown[] = [],
  debug = false,
): Promise<any[]> {
  const span = tracer.startSpan("PostgresDbUtilsQuerySQL", context);
  setDbSpanAttributes(span, sql);
  if (debug) {
    console.log(sql);
  }
  try {
    const result = await requirePool().query(sql, params);
    span.setAttributes({ "db.rows_returned": result.rows.length });
    return result.rows;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    logger.error(`SQL ERROR: ${sql}`, error as Error, span);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Run a callback inside a transaction on a single pooled connection.
 *
 * `BEGIN`, the callback and `COMMIT` all run on the same client; on error the
 * transaction is rolled back and the client is always released. This is the
 * safe replacement for {@link PostgresDbUtilsTransactionStart} /
 * {@link PostgresDbUtilsTransactionCommit}, which issued `BEGIN` and `COMMIT`
 * through the pool and could therefore land on different connections.
 */
export async function PostgresDbUtilsTransaction<T>(
  context: Span | undefined,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan("PostgresDbUtilsTransaction", context);
  let client: PoolClient | null = null;
  let committed = false;
  try {
    client = await requirePool().connect();
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (client && !committed) {
      await client.query("ROLLBACK").catch(() => {
        // Connection failure: nothing to roll back.
      });
    }
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    client?.release();
    span.end();
  }
}

/**
 * Start a transaction.
 *
 * @deprecated `BEGIN` runs on a pooled connection that `COMMIT` may not
 * reuse, so the statements can execute in different sessions. Use
 * {@link PostgresDbUtilsTransaction}, which pins one client for the whole
 * transaction.
 */
export async function PostgresDbUtilsTransactionStart(
  context: Span | undefined,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsTransactionStart", context);
  try {
    await requirePool().query("BEGIN");
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Commit a transaction.
 *
 * @deprecated See {@link PostgresDbUtilsTransactionStart}.
 */
export async function PostgresDbUtilsTransactionCommit(
  context: Span | undefined,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsTransactionCommit", context);
  try {
    await requirePool().query("COMMIT");
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    throw error;
  } finally {
    span.end();
  }
}

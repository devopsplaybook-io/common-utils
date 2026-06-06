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

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let pool: Pool;
let tracer: StandardTracer;
let logger: ModuleLogger;
let standardLogger: StandardLogger;

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

    const poolOptions = {
      host: config.DATABASE_POSTGRES_HOST,
      port: config.DATABASE_POSTGRES_PORT || 5432,
      user: config.DATABASE_POSTGRES_USER,
      password: config.DATABASE_POSTGRES_PASSWORD,
      database: config.DATABASE_POSTGRES_DATABASE,
      options: `-c search_path=${this.schemaName}`,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };

    if (this.schemaPool) {
      this.moduleLogger.info("Closing existing schema pool");
      await this.schemaPool.end().catch(() => {
        // Ignore errors on close
      });
    }
    this.schemaPool = new Pool(poolOptions);
    this.moduleLogger.info(
      `Schema pool initialized with search_path: ${this.schemaName}`,
    );

    // Create schema if not exists
    await this.execSQLForSchema(
      span,
      `CREATE SCHEMA IF NOT EXISTS ${this.schemaName};`,
    );
    await this.execSQLForSchema(span, `SET search_path TO ${this.schemaName};`);

    // Run init SQL files
    await this.execSQLFileForSchema(span, `${sqlDir}/init-0000.sql`);
    const initFiles = (await fs.readdir(sqlDir)).sort();
    let dbVersionApplied = 0;

    try {
      const dbVersionQuery = await this.querySQLForSchema(
        span,
        "SELECT MAX(value) as version FROM metadata WHERE type='db_version'",
      );
      if ((dbVersionQuery[0] as Record<string, unknown>).version) {
        dbVersionApplied = Number(
          (dbVersionQuery[0] as Record<string, unknown>).version,
        );
      }
    } catch {
      // Table might not exist yet
    }

    this.moduleLogger.info(`Current DB Version: ${dbVersionApplied}`);

    for (const initFile of initFiles) {
      const regex = /init-(\d+)\.sql/g;
      const match = regex.exec(initFile);
      if (match) {
        const dbVersionInitFile = Number(match[1]);
        if (dbVersionInitFile > dbVersionApplied) {
          this.moduleLogger.info(`Applying migration: ${initFile}`);
          await this.execSQLFileForSchema(span, `${sqlDir}/${initFile}`);
          await this.querySQLForSchema(
            span,
            'INSERT INTO metadata ("type", "value", "dateCreated") VALUES ($1, $2, $3)',
            ["db_version", dbVersionInitFile, new Date().toISOString()],
          );
        }
      }
    }

    span.end();
  }

  /**
   * Initialise (or replace) the shared runtime pool.
   * Typically called once with a pool whose `search_path` includes all
   * application schemas.
   */
  initRuntimePool(config: PostgresDbConfig, searchPath?: string): void {
    if (this.runtimePool) {
      this.runtimePool.end().catch(() => {
        // Ignore errors on close
      });
    }
    this.runtimePool = new Pool({
      host: config.DATABASE_POSTGRES_HOST,
      port: config.DATABASE_POSTGRES_PORT || 5432,
      user: config.DATABASE_POSTGRES_USER,
      password: config.DATABASE_POSTGRES_PASSWORD,
      database: config.DATABASE_POSTGRES_DATABASE,
      options: searchPath
        ? `-c search_path=${searchPath}`
        : `-c search_path=${this.schemaName}`,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
    });
    this.moduleLogger.info(
      `Runtime pool initialized (search_path: ${searchPath || this.schemaName})`,
    );
  }

  /**
   * Execute a write SQL statement with OTel tracing.
   * @param useSchemaPool  When `true` use the schema-specific pool;
   *                       otherwise use the runtime pool (default).
   * @returns Number of rows changed.
   */
  execSQL(
    context: Span,
    sql: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any[] = [],
    useSchemaPool = false,
  ): Promise<number> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsExecSQL", context);
    const pool = useSchemaPool ? this.schemaPool : this.runtimePool;

    if (!pool) {
      throw new Error(
        `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
      );
    }

    return new Promise((resolve, reject) => {
      pool.query(
        sql,
        params,
        (error: Error | null, result: { rowCount: number | null }) => {
          span.end();
          if (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            this.moduleLogger.error(
              `[${useSchemaPool ? this.schemaName : "RUNTIME"}] SQL EXEC ERROR: ${sql}`,
              error,
            );
            reject(error);
          } else {
            resolve(result.rowCount || 0);
          }
        },
      );
    });
  }

  /** Execute an entire SQL file (used for migrations). */
  async execSQLFile(
    context: Span,
    filename: string,
    useSchemaPool = false,
  ): Promise<void> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsExecSQLFile", context);
    const sql = (await fs.readFile(filename)).toString();
    const pool = useSchemaPool ? this.schemaPool : this.runtimePool;

    if (!pool) {
      throw new Error(
        `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
      );
    }

    return new Promise((resolve, reject) => {
      pool.query(sql, (error: Error | null) => {
        span.end();
        if (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Execute a read SQL query with OTel tracing.
   * @returns Array of row objects.
   */
  querySQL(
    context: Span,
    sql: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any[] = [],
    useSchemaPool = false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any[]> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsQuerySQL", context);
    const pool = useSchemaPool ? this.schemaPool : this.runtimePool;

    if (!pool) {
      throw new Error(
        `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
      );
    }

    return new Promise((resolve, reject) => {
      pool.query(
        sql,
        params,
        (error: Error | null, result: { rows: unknown[] }) => {
          span.end();
          if (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            this.moduleLogger.error(
              `[${useSchemaPool ? this.schemaName : "RUNTIME"}] SQL QUERY ERROR: ${sql}`,
              error,
            );
            reject(error);
          } else {
            resolve(result.rows);
          }
        },
      );
    });
  }

  /**
   * Run a callback inside a transaction.
   */
  async transaction(
    context: Span,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (client: any) => Promise<void>,
    useSchemaPool = false,
  ): Promise<void> {
    const span = tracer.startSpan("PostgresSchemaDbUtilsTransaction", context);
    const pool = useSchemaPool ? this.schemaPool : this.runtimePool;

    if (!pool) {
      throw new Error(
        `Pool not initialized${useSchemaPool ? ` for schema: ${this.schemaName}` : ""}`,
      );
    }

    this.moduleLogger.info(
      `[${useSchemaPool ? this.schemaName : "RUNTIME"}] Starting transaction`,
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await callback(client);
      await client.query("COMMIT");
      this.moduleLogger.info(
        `[${useSchemaPool ? this.schemaName : "RUNTIME"}] Transaction committed`,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      this.moduleLogger.error(
        `[${useSchemaPool ? this.schemaName : "RUNTIME"}] Transaction rolled back`,
        error as Error,
      );
      throw error;
    } finally {
      client.release();
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

  // -- Internal helpers (schema pool only) ----------------------------------

  private execSQLForSchema(
    context: Span,
    sql: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any[] = [],
  ): Promise<void> {
    const span = tracer.startSpan(
      "PostgresSchemaDbUtilsExecSQLForSchema",
      context,
    );

    if (!this.schemaPool) {
      throw new Error(`Pool not initialized for schema: ${this.schemaName}`);
    }

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.schemaPool!.query(sql, params, (error: Error | null) => {
        span.end();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private async execSQLFileForSchema(
    context: Span,
    filename: string,
  ): Promise<void> {
    try {
      const span = tracer.startSpan(
        "PostgresSchemaDbUtilsExecSQLFileForSchema",
        context,
      );
      const sql = (await fs.readFile(filename)).toString();

      if (!this.schemaPool) {
        throw new Error(`Pool not initialized for schema: ${this.schemaName}`);
      }

      return new Promise((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.schemaPool!.query(sql, (error: Error | null) => {
          span.end();
          if (error) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((error as any).code === "ENOENT") {
              resolve();
            } else {
              reject(error);
            }
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((error as any).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private querySQLForSchema(
    context: Span,
    sql: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any[]> {
    const span = tracer.startSpan(
      "PostgresSchemaDbUtilsQuerySQLForSchema",
      context,
    );

    if (!this.schemaPool) {
      throw new Error(`Pool not initialized for schema: ${this.schemaName}`);
    }

    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.schemaPool!.query(
        sql,
        params,
        (error: Error | null, result: { rows: unknown[] }) => {
          span.end();
          if (error) {
            reject(error);
          } else {
            resolve(result.rows);
          }
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Functional API – single-pool mode used by the DbUtils facade.
// An internal PostgresSchemaDbUtils instance backs these functions so the
// behaviour is identical to before.
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
 */
export async function PostgresDbUtilsInit(
  context: Span,
  config: PostgresDbConfig,
  sqlDir: string,
): Promise<void> {
  const span = tracer.startSpan("PostgresDbUtilsInit", context);

  // Use the schema-level init but without schema creation (single-pool mode)
  const poolOptions = {
    host: config.DATABASE_POSTGRES_HOST,
    port: config.DATABASE_POSTGRES_PORT || 5432,
    user: config.DATABASE_POSTGRES_USER,
    password: config.DATABASE_POSTGRES_PASSWORD,
    database: config.DATABASE_POSTGRES_DATABASE,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  };

  // Create a simple pool directly for the functional API
  pool = new Pool(poolOptions);

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

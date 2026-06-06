import { StandardLogger, ModuleLogger } from "@devopsplaybook.io/otel-utils";
import {
  DbUtilsGetDatabase,
  DbUtilsGetType,
  convertToPostgresPlaceholders,
} from "./DbUtils";

let logger: ModuleLogger;

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
 * @returns Number of rows inserted.
 */
export function DbUtilsNoTelemetryBatchInsert(
  tableCols: string,
  numCols: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[][],
): number | Promise<number> {
  if (rows.length === 0) return 0;
  const rowSQL = `(${Array.from({ length: numCols }, () => "?").join(",")})`;
  const multiValues = Array.from({ length: rows.length }, () => rowSQL).join(
    ",",
  );
  const sql = `INSERT ${tableCols} VALUES ${multiValues}`;
  return DbUtilsNoTelemetryExecSQL(sql, rows.flat());
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
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (DbUtilsGetDatabase() as any).query(
        pgSql,
        params,
        (error: Error | null, result: { rowCount: number | null }) => {
          if (error) {
            logger.error(`SQL INSERT ERROR: ${sql.substring(0, 200)}`, error);
            reject(error);
          } else {
            resolve(result.rowCount || 0);
          }
        },
      );
    });
  }
  // SQLite (better-sqlite3) – synchronous
  const stmt = (
    DbUtilsGetDatabase() as {
      prepare: (sql: string) => {
        run: (params: unknown[]) => { changes: number };
      };
    }
  ).prepare(sql);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] | Promise<any[]> {
  if (debug) {
    console.log(sql);
  }
  const dbType = DbUtilsGetType();
  if (dbType === "postgres") {
    const pgSql = convertToPostgresPlaceholders(sql);
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (DbUtilsGetDatabase() as any).query(
        pgSql,
        params,
        (error: Error | null, result: { rows: unknown[] }) => {
          if (error) {
            logger.error(`SQL ERROR: ${sql}`, error);
            reject(error);
          } else {
            resolve(result.rows);
          }
        },
      );
    });
  }
  // SQLite (better-sqlite3) – synchronous
  const stmt = (
    DbUtilsGetDatabase() as {
      prepare: (sql: string) => { all: (params: unknown[]) => unknown[] };
    }
  ).prepare(sql);
  return stmt.all(params);
}

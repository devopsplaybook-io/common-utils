import type { Span } from "@opentelemetry/sdk-trace";
import {
  LoginCodeApproveInput,
  LoginCodeAttemptInput,
  LoginCodeCancelInput,
  LoginCodeCleanupInput,
  LoginCodeConsumeInput,
  LoginCodeCreateInput,
  LoginCodeCreateResult,
  LoginCodeMarkInput,
  LoginCodeRecord,
  LoginCodeRotateInput,
  LoginCodesStore,
} from "./LoginCodes";

/**
 * Reference {@link LoginCodesStore} backed by the common-utils database
 * facade. The facade is imported lazily inside the store methods so that
 * importing the login-code module never loads a database driver (or the
 * shared users stack), which keeps custom-auth servers free to use it.
 *
 * SQL is written SQLite-first with quoted camelCase identifiers; the facade
 * converts `?` placeholders to `$N` for Postgres. Every mutation is a single
 * conditional statement (compare-and-set), so the state machine is safe
 * across replicas without in-memory state.
 */

/** Table name used by the documented migration snippet. */
export const LOGIN_CODES_TABLE = "users_login_codes";

/**
 * DDL for the login-code table. Identical for SQLite and Postgres (`TEXT` /
 * `INTEGER`, quoted camelCase identifiers); ship it as an `init-NNNN.sql`
 * migration. `requestTokenHash` uniqueness comes from the `UNIQUE` column.
 * There is no foreign key on `approvedByUserId`: user deletion must neither
 * cascade nor block, and the routes fail closed when the approver is gone.
 */
export const LOGIN_CODES_DDL_SQLITE = `CREATE TABLE IF NOT EXISTS "users_login_codes" (
  "id" TEXT PRIMARY KEY,
  "requestTokenHash" TEXT NOT NULL UNIQUE,
  "codeHash" TEXT NOT NULL,
  "previousCodeHash" TEXT,
  "codeExpiresAt" TEXT NOT NULL,
  "previousCodeExpiresAt" TEXT,
  "status" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "approvedAt" TEXT,
  "approvedByUserId" TEXT,
  "consumedAt" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "requestUserAgent" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_login_codes_code_hash" ON "users_login_codes" ("codeHash");
CREATE INDEX IF NOT EXISTS "users_login_codes_status_expires" ON "users_login_codes" ("status", "expiresAt");`;

/** Postgres DDL (textually identical to the SQLite DDL). */
export const LOGIN_CODES_DDL_POSTGRES = LOGIN_CODES_DDL_SQLITE;

export type DbUtilsModule = typeof import("../DbUtils");

let dbModulePromise: Promise<DbUtilsModule> | undefined;

/**
 * Load the database facade on first use. Kept lazy so importing
 * `./users/login-codes` in a custom-auth server does not pull in
 * `better-sqlite3` / `pg`.
 */
function loadDb(): Promise<DbUtilsModule> {
  if (!dbModulePromise) {
    dbModulePromise = import("../DbUtils");
  }
  return dbModulePromise;
}

/** A definitive "table does not exist" error, cached by the probe. */
function isMissingTableError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  if (err?.code === "42P01") {
    return true;
  }
  const message = typeof err?.message === "string" ? err.message : "";
  return (
    /no such table/i.test(message) ||
    /relation "[^"]*" does not exist/i.test(message) ||
    /undefined table/i.test(message)
  );
}

/** Local unique-violation detector (avoids loading the users data module). */
function isUniqueViolationError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  if (
    err?.code === "23505" ||
    err?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return true;
  }
  const message = typeof err?.message === "string" ? err.message : "";
  return (
    /UNIQUE constraint failed/i.test(message) ||
    /duplicate key value violates unique constraint/i.test(message)
  );
}

function fromRaw(row: Record<string, unknown>): LoginCodeRecord {
  return {
    id: String(row.id),
    requestTokenHash: String(row.requestTokenHash),
    codeHash: String(row.codeHash),
    previousCodeHash:
      row.previousCodeHash === undefined || row.previousCodeHash === null
        ? null
        : String(row.previousCodeHash),
    codeExpiresAt: String(row.codeExpiresAt),
    previousCodeExpiresAt:
      row.previousCodeExpiresAt === undefined ||
      row.previousCodeExpiresAt === null
        ? null
        : String(row.previousCodeExpiresAt),
    status: row.status as LoginCodeRecord["status"],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    expiresAt: String(row.expiresAt),
    approvedAt:
      row.approvedAt === undefined || row.approvedAt === null
        ? null
        : String(row.approvedAt),
    approvedByUserId:
      row.approvedByUserId === undefined || row.approvedByUserId === null
        ? null
        : String(row.approvedByUserId),
    consumedAt:
      row.consumedAt === undefined || row.consumedAt === null
        ? null
        : String(row.consumedAt),
    attempts: Number(row.attempts ?? 0),
    requestUserAgent:
      row.requestUserAgent === undefined || row.requestUserAgent === null
        ? null
        : String(row.requestUserAgent),
  };
}

// SQL
// Written SQLite-first with quoted identifiers (valid for both backends);
// the DbUtils facade converts `?` placeholders for Postgres.

const SQL = {
  SELECT_BY_REQUEST_TOKEN_HASH:
    'SELECT * FROM "users_login_codes" WHERE "requestTokenHash" = ? LIMIT 1',
  SELECT_BY_CODE_HASH:
    'SELECT * FROM "users_login_codes" WHERE "codeHash" = ? OR "previousCodeHash" = ? ORDER BY CASE WHEN "codeHash" = ? THEN 0 ELSE 1 END LIMIT 1',
  INSERT_IF_BELOW_PENDING_CAP:
    'INSERT INTO "users_login_codes" ("id", "requestTokenHash", "codeHash", "codeExpiresAt", "status", "createdAt", "updatedAt", "expiresAt", "attempts", "requestUserAgent") ' +
    `SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ? ` +
    `WHERE (SELECT COUNT(*) FROM "users_login_codes" WHERE "status" = 'pending') < ?`,
  ROTATE:
    'UPDATE "users_login_codes" SET "previousCodeHash" = "codeHash", "previousCodeExpiresAt" = ?, "codeHash" = ?, "codeExpiresAt" = ?, "updatedAt" = ? ' +
    `WHERE "id" = ? AND "status" = 'pending' AND "codeHash" = ?`,
  APPROVE:
    'UPDATE "users_login_codes" SET "status" = \'approved\', "approvedAt" = ?, "approvedByUserId" = ?, "updatedAt" = ? ' +
    `WHERE "id" = ? AND "status" = 'pending' AND ("codeHash" = ? OR ("previousCodeHash" = ? AND "previousCodeExpiresAt" > ?))`,
  CONSUME:
    'UPDATE "users_login_codes" SET "status" = \'consumed\', "consumedAt" = ?, "updatedAt" = ? ' +
    `WHERE "requestTokenHash" = ? AND "status" = 'approved'`,
  CANCEL:
    'UPDATE "users_login_codes" SET "status" = \'cancelled\', "updatedAt" = ? ' +
    `WHERE "requestTokenHash" = ? AND "status" = 'pending'`,
  MARK_EXPIRED:
    'UPDATE "users_login_codes" SET "status" = \'expired\', "updatedAt" = ? ' +
    `WHERE "id" = ? AND "status" IN ('pending', 'approved')`,
  MARK_FAILED:
    'UPDATE "users_login_codes" SET "status" = \'failed\', "updatedAt" = ? ' +
    `WHERE "id" = ? AND "status" IN ('pending', 'approved')`,
  RECORD_ATTEMPT:
    'UPDATE "users_login_codes" SET "attempts" = "attempts" + 1, "updatedAt" = ? ' +
    `WHERE "id" = ? AND "status" = 'pending' AND "attempts" < ?`,
  CLEANUP:
    'DELETE FROM "users_login_codes" WHERE "id" IN (' +
    'SELECT "id" FROM "users_login_codes" WHERE "createdAt" < ? ORDER BY "createdAt" ASC LIMIT ?)',
};

/**
 * Create a {@link LoginCodesStore} backed by the common-utils `DbUtils`
 * facade. The database must be initialised (`DbUtilsInit`) and the
 * `users_login_codes` migration applied before the mutating routes are used.
 */
export function createLoginCodesStoreCommonUtils(): LoginCodesStore {
  // Per-instance probe cache: only a definitive missing-table result is cached.
  let missingTable = false;

  async function exec(
    context: Span | undefined,
    sql: string,
    params: unknown[],
  ): Promise<number> {
    const db = await loadDb();
    return db.DbUtilsExecSQL(context, sql, params);
  }

  async function query(
    context: Span | undefined,
    sql: string,
    params: unknown[],
  ): Promise<Record<string, unknown>[]> {
    const db = await loadDb();
    return db.DbUtilsQuerySQL(context, sql, params);
  }

  return {
    async available(context?: Span): Promise<boolean> {
      if (missingTable) {
        return false;
      }
      try {
        await query(
          context,
          `SELECT "id" FROM "${LOGIN_CODES_TABLE}" LIMIT 1`,
          [],
        );
        return true;
      } catch (error) {
        if (isMissingTableError(error)) {
          missingTable = true;
          return false;
        }
        throw error;
      }
    },

    async create(
      input: LoginCodeCreateInput,
      context?: Span,
    ): Promise<LoginCodeCreateResult> {
      const db = await loadDb();
      return db.DbUtilsWithLock(
        "login_codes_create",
        async (): Promise<LoginCodeCreateResult> => {
          try {
            const changes = await db.DbUtilsExecSQL(
              context,
              SQL.INSERT_IF_BELOW_PENDING_CAP,
              [
                input.id,
                input.requestTokenHash,
                input.codeHash,
                input.codeExpiresAt,
                input.createdAt,
                input.updatedAt,
                input.expiresAt,
                input.requestUserAgent,
                input.maxPending,
              ],
            );
            if (Number(changes) === 0) {
              return { ok: false, reason: "pending_cap" };
            }
            return { ok: true };
          } catch (error) {
            if (isUniqueViolationError(error)) {
              return { ok: false, reason: "conflict" };
            }
            throw error;
          }
        },
        context,
      );
    },

    async getByRequestTokenHash(
      requestTokenHash: string,
      context?: Span,
    ): Promise<LoginCodeRecord | null> {
      const rows = await query(context, SQL.SELECT_BY_REQUEST_TOKEN_HASH, [
        requestTokenHash,
      ]);
      return rows.length > 0 ? fromRaw(rows[0]) : null;
    },

    async getByCodeHash(
      codeHash: string,
      context?: Span,
    ): Promise<LoginCodeRecord | null> {
      const rows = await query(context, SQL.SELECT_BY_CODE_HASH, [
        codeHash,
        codeHash,
        codeHash,
      ]);
      return rows.length > 0 ? fromRaw(rows[0]) : null;
    },

    async rotate(
      input: LoginCodeRotateInput,
      context?: Span,
    ): Promise<boolean> {
      const changes = await exec(context, SQL.ROTATE, [
        input.previousCodeExpiresAt,
        input.newCodeHash,
        input.codeExpiresAt,
        input.updatedAt,
        input.id,
        input.expectedCodeHash,
      ]);
      return changes > 0;
    },

    async approve(
      input: LoginCodeApproveInput,
      context?: Span,
    ): Promise<boolean> {
      const changes = await exec(context, SQL.APPROVE, [
        input.approvedAt,
        input.approvedByUserId,
        input.now,
        input.id,
        input.submittedCodeHash,
        input.submittedCodeHash,
        input.now,
      ]);
      return changes > 0;
    },

    async consume(
      input: LoginCodeConsumeInput,
      context?: Span,
    ): Promise<LoginCodeRecord | null> {
      const changes = await exec(context, SQL.CONSUME, [
        input.consumedAt,
        input.updatedAt,
        input.requestTokenHash,
      ]);
      if (changes === 0) {
        return null;
      }
      const rows = await query(context, SQL.SELECT_BY_REQUEST_TOKEN_HASH, [
        input.requestTokenHash,
      ]);
      return rows.length > 0 ? fromRaw(rows[0]) : null;
    },

    async cancel(
      input: LoginCodeCancelInput,
      context?: Span,
    ): Promise<boolean> {
      const changes = await exec(context, SQL.CANCEL, [
        input.updatedAt,
        input.requestTokenHash,
      ]);
      return changes > 0;
    },

    async markExpired(
      input: LoginCodeMarkInput,
      context?: Span,
    ): Promise<boolean> {
      const changes = await exec(context, SQL.MARK_EXPIRED, [
        input.updatedAt,
        input.id,
      ]);
      return changes > 0;
    },

    async markFailed(
      input: LoginCodeMarkInput,
      context?: Span,
    ): Promise<boolean> {
      const changes = await exec(context, SQL.MARK_FAILED, [
        input.updatedAt,
        input.id,
      ]);
      return changes > 0;
    },

    async recordAttempt(
      input: LoginCodeAttemptInput,
      context?: Span,
    ): Promise<boolean> {
      const changes = await exec(context, SQL.RECORD_ATTEMPT, [
        input.updatedAt,
        input.id,
        input.maxAttempts,
      ]);
      return changes > 0;
    },

    async cleanup(
      input: LoginCodeCleanupInput,
      context?: Span,
    ): Promise<number> {
      return exec(context, SQL.CLEANUP, [input.olderThan, input.limit]);
    },
  };
}

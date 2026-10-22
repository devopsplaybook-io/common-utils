import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import type { Span } from "@opentelemetry/sdk-trace";
import {
  DbUtilsExecSQL,
  DbUtilsGetDatabase,
  DbUtilsGetType,
  DbUtilsQuerySQL,
  convertToPostgresPlaceholders,
} from "../DbUtils";
import { User } from "./User";

let tracer: StandardTracer;

/**
 * Injects the OTel tracer instance used by the users data module.
 * Must be called once at startup, before any `UsersData*` function.
 */
export function UsersDataSetOTel(tracerIn: StandardTracer): void {
  tracer = tracerIn;
}

export async function UsersDataGet(
  context: Span | undefined,
  id: string,
): Promise<User | null> {
  const span = tracer.startSpan("UsersDataGet", context);
  try {
    const usersRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.GET_USER_BY_ID, [
      id,
    ]);
    if (usersRaw.length > 0) {
      return fromRaw(usersRaw[0]);
    }
    return null;
  } finally {
    span.end();
  }
}

export async function UsersDataGetByName(
  context: Span | undefined,
  name: string,
): Promise<User | null> {
  const span = tracer.startSpan("UsersDataGetByName", context);
  try {
    const usersRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.GET_USER_BY_NAME, [
      name,
    ]);
    if (usersRaw.length > 0) {
      return fromRaw(usersRaw[0]);
    }
    return null;
  } finally {
    span.end();
  }
}

/**
 * List users, ordered by name, optionally paginated. `offset` is only
 * applied together with a `limit` (SQLite requires a LIMIT clause for
 * OFFSET).
 */
export async function UsersDataList(
  context: Span | undefined,
  limit?: number,
  offset?: number,
): Promise<User[]> {
  const span = tracer.startSpan("UsersDataList", context);
  try {
    let sql = SQL_QUERIES.LIST_USERS;
    const params: unknown[] = [];
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
      if (offset !== undefined) {
        sql += " OFFSET ?";
        params.push(offset);
      }
    }
    const usersRaw = await DbUtilsQuerySQL(span, sql, params);
    return usersRaw.map(fromRaw);
  } finally {
    span.end();
  }
}

/** Number of users (COUNT(*) – used instead of loading the full list). */
export async function UsersDataCount(
  context: Span | undefined,
): Promise<number> {
  const span = tracer.startSpan("UsersDataCount", context);
  try {
    const rows = await DbUtilsQuerySQL(span, SQL_QUERIES.COUNT_USERS);
    return Number(rows[0]?.count ?? 0);
  } finally {
    span.end();
  }
}

/** Number of admin users (COUNT(*) – used by the last-admin guards). */
export async function UsersDataCountAdmins(
  context: Span | undefined,
): Promise<number> {
  const span = tracer.startSpan("UsersDataCountAdmins", context);
  try {
    const rows = await DbUtilsQuerySQL(span, SQL_QUERIES.COUNT_ADMINS);
    return Number(rows[0]?.count ?? 0);
  } finally {
    span.end();
  }
}

export async function UsersDataAdd(
  context: Span | undefined,
  user: User,
): Promise<void> {
  const span = tracer.startSpan("UsersDataAdd", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_USER, [
      user.id,
      user.name,
      user.passwordEncrypted,
      user.role,
      JSON.stringify(user.scopes),
    ]);
  } finally {
    span.end();
  }
}

/**
 * Insert the first administrator only when the `users` table is empty.
 * The condition is part of the INSERT so two concurrent bootstraps cannot
 * both create an admin: the loser inserts 0 rows.
 *
 * @returns `true` when the user was inserted, `false` when another user
 *          already exists.
 */
export async function UsersDataAddIfEmpty(
  context: Span | undefined,
  user: User,
): Promise<boolean> {
  const span = tracer.startSpan("UsersDataAddIfEmpty", context);
  try {
    const changes = await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_USER_IF_EMPTY, [
      user.id,
      user.name,
      user.passwordEncrypted,
      user.role,
      JSON.stringify(user.scopes),
    ]);
    return changes > 0;
  } finally {
    span.end();
  }
}

export async function UsersDataUpdatePassword(
  context: Span | undefined,
  user: User,
): Promise<number> {
  const span = tracer.startSpan("UsersDataUpdatePassword", context);
  try {
    return await DbUtilsExecSQL(span, SQL_QUERIES.UPDATE_PASSWORD, [
      user.passwordEncrypted,
      user.id,
    ]);
  } finally {
    span.end();
  }
}

export async function UsersDataUpdateUser(
  context: Span | undefined,
  user: User,
): Promise<number> {
  const span = tracer.startSpan("UsersDataUpdateUser", context);
  try {
    return await DbUtilsExecSQL(span, SQL_QUERIES.UPDATE_USER, [
      user.role,
      JSON.stringify(user.scopes),
      user.id,
    ]);
  } finally {
    span.end();
  }
}

/**
 * Demote an administrator only when another administrator exists. The guard
 * is part of the UPDATE, so concurrent demotions can never remove the last
 * admin (run it under {@link DbUtilsWithLock} to serialise Postgres replicas).
 *
 * @returns Number of rows changed (0 → the user is not an admin or is the
 *          last one).
 */
export async function UsersDataDemoteAdminIfNotLast(
  context: Span | undefined,
  id: string,
  scopes: unknown,
): Promise<number> {
  const span = tracer.startSpan("UsersDataDemoteAdminIfNotLast", context);
  try {
    return await DbUtilsExecSQL(
      span,
      SQL_QUERIES.DEMOTE_ADMIN_IF_NOT_LAST,
      [JSON.stringify(scopes), id],
    );
  } finally {
    span.end();
  }
}

export async function UsersDataDelete(
  context: Span | undefined,
  id: string,
): Promise<number> {
  const span = tracer.startSpan("UsersDataDelete", context);
  try {
    return await DbUtilsExecSQL(span, SQL_QUERIES.DELETE_USER, [id]);
  } finally {
    span.end();
  }
}

/**
 * Delete a user and every API token it owns atomically, refusing to remove
 * the last administrator. The token cleanup cannot be skipped by a crash
 * between two statements, and a last-admin refusal leaves both tables
 * untouched.
 *
 * @returns `true` when the user was deleted, `false` when it is the last
 *          admin.
 */
export async function UsersDataDeleteWithTokens(
  context: Span | undefined,
  id: string,
): Promise<boolean> {
  const span = tracer.startSpan("UsersDataDeleteWithTokens", context);
  try {
    if (DbUtilsGetType() === "postgres") {
      return await deleteWithTokensPostgres(id);
    }
    const db = DbUtilsGetDatabase() as {
      prepare: (sql: string) => { run: (...params: any[]) => { changes: number } };
      transaction: <T>(fn: (arg: string) => T) => (arg: string) => T;
    };
    const deleteGuarded = db.prepare(SQL_QUERIES.DELETE_USER_IF_NOT_LAST_ADMIN);
    const deleteTokens = db.prepare(SQL_QUERIES.DELETE_TOKENS_BY_USER);
    const tx = db.transaction((userId: string) => {
      const result = deleteGuarded.run(userId);
      if (result.changes === 0) {
        return false;
      }
      deleteTokens.run(userId);
      return true;
    });
    return tx(id);
  } finally {
    span.end();
  }
}

async function deleteWithTokensPostgres(id: string): Promise<boolean> {
  const pool = DbUtilsGetDatabase() as {
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
      release: () => void;
    }>;
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const deleted = await client.query(
        convertToPostgresPlaceholders(SQL_QUERIES.DELETE_USER_IF_NOT_LAST_ADMIN),
        [id],
      );
      if ((deleted.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        convertToPostgresPlaceholders(SQL_QUERIES.DELETE_TOKENS_BY_USER),
        [id],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // Connection failure: nothing to roll back.
      });
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Invalidate the JWTs issued for a user by incrementing `tokenVersion`.
 * Only called when `JWT_REVOCATION_ENABLED` is on: the column is part of the
 * documented `users` migration and absent otherwise.
 */
export async function UsersDataBumpTokenVersion(
  context: Span | undefined,
  id: string,
): Promise<void> {
  const span = tracer.startSpan("UsersDataBumpTokenVersion", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.BUMP_TOKEN_VERSION, [id]);
  } finally {
    span.end();
  }
}

/**
 * Whether an error is a unique-constraint violation (`SQLITE_CONSTRAINT*` /
 * Postgres `23505`) – used to turn the user-name uniqueness race into a 400.
 */
export function isUniqueViolationError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const err = error as { code?: string; message?: string };
  if (
    err.code === "23505" ||
    err.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    err.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  ) {
    return true;
  }
  const message = typeof err.message === "string" ? err.message : "";
  return (
    /UNIQUE constraint failed/i.test(message) ||
    /duplicate key value violates unique constraint/i.test(message)
  );
}

// Private Functions

function fromRaw(userRaw: any): User {
  const user = new User();
  user.id = userRaw.id;
  user.name = userRaw.name;
  user.passwordEncrypted = userRaw.passwordEncrypted;
  user.role = userRaw.role || "user";
  user.tokenVersion = Number(userRaw.tokenVersion ?? 0) || 0;
  if (userRaw.scopes) {
    user.scopes = User.normalizeScopes(userRaw.scopes);
  }
  return user;
}

// SQL
// Written SQLite-first with quoted identifiers (valid for both backends);
// the DbUtils facade converts `?` placeholders for Postgres.

const SQL_QUERIES = {
  GET_USER_BY_ID: 'SELECT * FROM users WHERE "id" = ?',
  GET_USER_BY_NAME: 'SELECT * FROM users WHERE "name" = ?',
  LIST_USERS: 'SELECT * FROM users ORDER BY "name" ASC, "id" ASC',
  COUNT_USERS: "SELECT COUNT(*) as count FROM users",
  COUNT_ADMINS: "SELECT COUNT(*) as count FROM users WHERE \"role\" = 'admin'",
  INSERT_USER:
    'INSERT INTO users ("id", "name", "passwordEncrypted", "role", "scopes") VALUES (?, ?, ?, ?, ?)',
  INSERT_USER_IF_EMPTY:
    'INSERT INTO users ("id", "name", "passwordEncrypted", "role", "scopes") SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)',
  UPDATE_USER: 'UPDATE users SET "role" = ?, "scopes" = ? WHERE "id" = ?',
  UPDATE_PASSWORD: 'UPDATE users SET "passwordEncrypted" = ? WHERE "id" = ?',
  DEMOTE_ADMIN_IF_NOT_LAST:
    'UPDATE users SET "role" = \'user\', "scopes" = ? WHERE "id" = ? AND "role" = \'admin\' AND (SELECT COUNT(*) FROM users WHERE "role" = \'admin\') > 1',
  BUMP_TOKEN_VERSION:
    'UPDATE users SET "tokenVersion" = COALESCE("tokenVersion", 0) + 1 WHERE "id" = ?',
  DELETE_USER: 'DELETE FROM users WHERE "id" = ?',
  DELETE_USER_IF_NOT_LAST_ADMIN:
    'DELETE FROM users WHERE "id" = ? AND ("role" <> \'admin\' OR (SELECT COUNT(*) FROM users WHERE "role" = \'admin\') > 1)',
  DELETE_TOKENS_BY_USER: 'DELETE FROM users_api_tokens WHERE "userId" = ?',
};

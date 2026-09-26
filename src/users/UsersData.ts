import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Span } from "@opentelemetry/sdk-trace-base";
import { DbUtilsExecSQL, DbUtilsQuerySQL } from "../DbUtils";
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
 * List users, optionally paginated. `offset` is only applied together with a
 * `limit` (SQLite requires a LIMIT clause for OFFSET).
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

export async function UsersDataUpdatePassword(
  context: Span | undefined,
  user: User,
): Promise<void> {
  const span = tracer.startSpan("UsersDataUpdatePassword", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.UPDATE_PASSWORD, [
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
): Promise<void> {
  const span = tracer.startSpan("UsersDataUpdateUser", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.UPDATE_USER, [
      user.role,
      JSON.stringify(user.scopes),
      user.id,
    ]);
  } finally {
    span.end();
  }
}

export async function UsersDataDelete(
  context: Span | undefined,
  id: string,
): Promise<void> {
  const span = tracer.startSpan("UsersDataDelete", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.DELETE_USER, [id]);
  } finally {
    span.end();
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
  LIST_USERS: "SELECT * FROM users",
  COUNT_USERS: "SELECT COUNT(*) as count FROM users",
  COUNT_ADMINS: "SELECT COUNT(*) as count FROM users WHERE \"role\" = 'admin'",
  INSERT_USER:
    'INSERT INTO users ("id", "name", "passwordEncrypted", "role", "scopes") VALUES (?, ?, ?, ?, ?)',
  UPDATE_USER: 'UPDATE users SET "role" = ?, "scopes" = ? WHERE "id" = ?',
  UPDATE_PASSWORD: 'UPDATE users SET "passwordEncrypted" = ? WHERE "id" = ?',
  BUMP_TOKEN_VERSION:
    'UPDATE users SET "tokenVersion" = COALESCE("tokenVersion", 0) + 1 WHERE "id" = ?',
  DELETE_USER: 'DELETE FROM users WHERE "id" = ?',
};

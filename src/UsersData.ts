import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Span } from "@opentelemetry/sdk-trace-base";
import { DbUtilsExecSQL, DbUtilsQuerySQL } from "./DbUtils";
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
  const usersRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.GET_USER_BY_ID, [
    id,
  ]);
  let user: User | null = null;
  if (usersRaw.length > 0) {
    user = fromRaw(usersRaw[0]);
  }
  span.end();
  return user;
}

export async function UsersDataGetByName(
  context: Span | undefined,
  name: string,
): Promise<User | null> {
  const span = tracer.startSpan("UsersDataGetByName", context);
  const usersRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.GET_USER_BY_NAME, [
    name,
  ]);
  let user: User | null = null;
  if (usersRaw.length > 0) {
    user = fromRaw(usersRaw[0]);
  }
  span.end();
  return user;
}

export async function UsersDataList(
  context: Span | undefined,
): Promise<User[]> {
  const span = tracer.startSpan("UsersDataList", context);
  const usersRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.LIST_USERS);
  const users: User[] = [];
  for (const userRaw of usersRaw) {
    users.push(fromRaw(userRaw));
  }
  span.end();
  return users;
}

export async function UsersDataAdd(
  context: Span | undefined,
  user: User,
): Promise<void> {
  const span = tracer.startSpan("UsersDataAdd", context);
  await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_USER, [
    user.id,
    user.name,
    user.passwordEncrypted,
    user.role,
    JSON.stringify(user.scopes),
  ]);
  span.end();
}

export async function UsersDataUpdatePassword(
  context: Span | undefined,
  user: User,
): Promise<void> {
  const span = tracer.startSpan("UsersDataUpdatePassword", context);
  await DbUtilsExecSQL(span, SQL_QUERIES.UPDATE_PASSWORD, [
    user.passwordEncrypted,
    user.id,
  ]);
  span.end();
}

export async function UsersDataUpdateUser(
  context: Span | undefined,
  user: User,
): Promise<void> {
  const span = tracer.startSpan("UsersDataUpdateUser", context);
  await DbUtilsExecSQL(span, SQL_QUERIES.UPDATE_USER, [
    user.role,
    JSON.stringify(user.scopes),
    user.id,
  ]);
  span.end();
}

export async function UsersDataDelete(
  context: Span | undefined,
  id: string,
): Promise<void> {
  const span = tracer.startSpan("UsersDataDelete", context);
  await DbUtilsExecSQL(span, SQL_QUERIES.DELETE_USER, [id]);
  span.end();
}

// Private Functions

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromRaw(userRaw: any): User {
  const user = new User();
  user.id = userRaw.id;
  user.name = userRaw.name;
  user.passwordEncrypted = userRaw.passwordEncrypted;
  user.role = userRaw.role || "user";
  if (userRaw.scopes) {
    try {
      user.scopes = JSON.parse(userRaw.scopes);
    } catch {
      user.scopes = [...User.DEFAULT_SCOPES];
    }
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
  INSERT_USER:
    'INSERT INTO users ("id", "name", "passwordEncrypted", "role", "scopes") VALUES (?, ?, ?, ?, ?)',
  UPDATE_USER: 'UPDATE users SET "role" = ?, "scopes" = ? WHERE "id" = ?',
  UPDATE_PASSWORD: 'UPDATE users SET "passwordEncrypted" = ? WHERE "id" = ?',
  DELETE_USER: 'DELETE FROM users WHERE "id" = ?',
};

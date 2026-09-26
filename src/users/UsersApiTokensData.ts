import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Span } from "@opentelemetry/sdk-trace-base";
import { DbUtilsExecSQL, DbUtilsQuerySQL } from "../DbUtils";
import { UserApiToken } from "./UserApiToken";

let tracer: StandardTracer;

/**
 * Whether the optional `expiresAt` / `lastUsedAt` columns exist. Probed once
 * per process so a database that did not run the documented migration never
 * breaks the auth path.
 */
let optionalColumnsAvailable: boolean | null = null;

/**
 * Injects the OTel tracer instance used by the API tokens data module.
 * Must be called once at startup, before any `UsersApiTokensData*` function.
 */
export function UsersApiTokensDataSetOTel(tracerIn: StandardTracer): void {
  tracer = tracerIn;
}

/**
 * One-time capability probe for the optional `users_api_tokens` columns
 * (`expiresAt`, `lastUsedAt`) added by the documented migration.
 */
export async function UsersApiTokensDataSupportsOptionalColumns(
  context: Span | undefined,
): Promise<boolean> {
  if (optionalColumnsAvailable === null) {
    try {
      await DbUtilsQuerySQL(
        context,
        'SELECT "expiresAt" FROM users_api_tokens LIMIT 1',
      );
      optionalColumnsAvailable = true;
    } catch {
      optionalColumnsAvailable = false;
    }
  }
  return optionalColumnsAvailable;
}

export async function UsersApiTokensDataGet(
  context: Span | undefined,
  id: string,
): Promise<UserApiToken | null> {
  const span = tracer.startSpan("UsersApiTokensDataGet", context);
  try {
    const tokensRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.GET_TOKEN_BY_ID, [
      id,
    ]);
    if (tokensRaw.length > 0) {
      return fromRaw(tokensRaw[0]);
    }
    return null;
  } finally {
    span.end();
  }
}

export async function UsersApiTokensDataGetByTokenHash(
  context: Span | undefined,
  tokenHash: string,
): Promise<UserApiToken | null> {
  const span = tracer.startSpan("UsersApiTokensDataGetByTokenHash", context);
  try {
    const tokensRaw = await DbUtilsQuerySQL(
      span,
      SQL_QUERIES.GET_TOKEN_BY_HASH,
      [tokenHash],
    );
    if (tokensRaw.length > 0) {
      return fromRaw(tokensRaw[0]);
    }
    return null;
  } finally {
    span.end();
  }
}

export async function UsersApiTokensDataListByUser(
  context: Span | undefined,
  userId: string,
): Promise<UserApiToken[]> {
  const span = tracer.startSpan("UsersApiTokensDataListByUser", context);
  try {
    const tokensRaw = await DbUtilsQuerySQL(
      span,
      SQL_QUERIES.LIST_TOKENS_BY_USER,
      [userId],
    );
    return tokensRaw.map(fromRaw);
  } finally {
    span.end();
  }
}

/** Number of tokens owned by a user (per-user cap check). */
export async function UsersApiTokensDataCountByUser(
  context: Span | undefined,
  userId: string,
): Promise<number> {
  const span = tracer.startSpan("UsersApiTokensDataCountByUser", context);
  try {
    const rows = await DbUtilsQuerySQL(span, SQL_QUERIES.COUNT_TOKENS_BY_USER, [
      userId,
    ]);
    return Number(rows[0]?.count ?? 0);
  } finally {
    span.end();
  }
}

export async function UsersApiTokensDataAdd(
  context: Span | undefined,
  apiToken: UserApiToken,
): Promise<void> {
  const span = tracer.startSpan("UsersApiTokensDataAdd", context);
  try {
    if (apiToken.expiresAt) {
      if (!(await UsersApiTokensDataSupportsOptionalColumns(context))) {
        throw new Error(
          "users_api_tokens.expiresAt does not exist: run the documented migration to enable API token expiry",
        );
      }
      await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_TOKEN_WITH_EXPIRY, [
        apiToken.id,
        apiToken.name,
        apiToken.userId,
        apiToken.tokenHash,
        apiToken.dateCreated,
        apiToken.expiresAt,
      ]);
      return;
    }
    await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_TOKEN, [
      apiToken.id,
      apiToken.name,
      apiToken.userId,
      apiToken.tokenHash,
      apiToken.dateCreated,
    ]);
  } finally {
    span.end();
  }
}

export async function UsersApiTokensDataDelete(
  context: Span | undefined,
  id: string,
): Promise<void> {
  const span = tracer.startSpan("UsersApiTokensDataDelete", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.DELETE_TOKEN, [id]);
  } finally {
    span.end();
  }
}

export async function UsersApiTokensDataDeleteByUser(
  context: Span | undefined,
  userId: string,
): Promise<void> {
  const span = tracer.startSpan("UsersApiTokensDataDeleteByUser", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.DELETE_TOKENS_BY_USER, [userId]);
  } finally {
    span.end();
  }
}

/**
 * Record a token's last successful use. Best effort: only attempted when the
 * optional columns exist, and failures never break authentication.
 */
export async function UsersApiTokensDataSetLastUsed(
  context: Span | undefined,
  id: string,
  lastUsedAt: string,
): Promise<void> {
  if (!(await UsersApiTokensDataSupportsOptionalColumns(context))) {
    return;
  }
  const span = tracer.startSpan("UsersApiTokensDataSetLastUsed", context);
  try {
    await DbUtilsExecSQL(span, SQL_QUERIES.UPDATE_TOKEN_LAST_USED, [
      lastUsedAt,
      id,
    ]);
  } finally {
    span.end();
  }
}

// Private Functions

function fromRaw(tokenRaw: any): UserApiToken {
  const apiToken = new UserApiToken();
  apiToken.id = tokenRaw.id;
  apiToken.name = tokenRaw.name;
  apiToken.userId = tokenRaw.userId;
  apiToken.tokenHash = tokenRaw.tokenHash;
  apiToken.dateCreated = tokenRaw.dateCreated;
  apiToken.expiresAt = tokenRaw.expiresAt ?? null;
  apiToken.lastUsedAt = tokenRaw.lastUsedAt ?? null;
  return apiToken;
}

// SQL
// Written SQLite-first with quoted identifiers (valid for both backends);
// the DbUtils facade converts `?` placeholders for Postgres.

const SQL_QUERIES = {
  GET_TOKEN_BY_ID: 'SELECT * FROM users_api_tokens WHERE "id" = ?',
  GET_TOKEN_BY_HASH: 'SELECT * FROM users_api_tokens WHERE "tokenHash" = ?',
  LIST_TOKENS_BY_USER: 'SELECT * FROM users_api_tokens WHERE "userId" = ?',
  COUNT_TOKENS_BY_USER:
    'SELECT COUNT(*) as count FROM users_api_tokens WHERE "userId" = ?',
  INSERT_TOKEN:
    'INSERT INTO users_api_tokens ("id", "name", "userId", "tokenHash", "dateCreated") VALUES (?, ?, ?, ?, ?)',
  INSERT_TOKEN_WITH_EXPIRY:
    'INSERT INTO users_api_tokens ("id", "name", "userId", "tokenHash", "dateCreated", "expiresAt") VALUES (?, ?, ?, ?, ?, ?)',
  UPDATE_TOKEN_LAST_USED:
    'UPDATE users_api_tokens SET "lastUsedAt" = ? WHERE "id" = ?',
  DELETE_TOKEN: 'DELETE FROM users_api_tokens WHERE "id" = ?',
  DELETE_TOKENS_BY_USER: 'DELETE FROM users_api_tokens WHERE "userId" = ?',
};

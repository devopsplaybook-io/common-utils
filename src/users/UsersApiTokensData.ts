import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Span } from "@opentelemetry/sdk-trace-base";
import { DbUtilsExecSQL, DbUtilsQuerySQL } from "../DbUtils";
import { UserApiToken } from "./UserApiToken";

let tracer: StandardTracer;

/**
 * Injects the OTel tracer instance used by the API tokens data module.
 * Must be called once at startup, before any `UsersApiTokensData*` function.
 */
export function UsersApiTokensDataSetOTel(tracerIn: StandardTracer): void {
  tracer = tracerIn;
}

export async function UsersApiTokensDataGet(
  context: Span | undefined,
  id: string,
): Promise<UserApiToken | null> {
  const span = tracer.startSpan("UsersApiTokensDataGet", context);
  const tokensRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.GET_TOKEN_BY_ID, [
    id,
  ]);
  let apiToken: UserApiToken | null = null;
  if (tokensRaw.length > 0) {
    apiToken = fromRaw(tokensRaw[0]);
  }
  span.end();
  return apiToken;
}

export async function UsersApiTokensDataGetByTokenHash(
  context: Span | undefined,
  tokenHash: string,
): Promise<UserApiToken | null> {
  const span = tracer.startSpan("UsersApiTokensDataGetByTokenHash", context);
  const tokensRaw = await DbUtilsQuerySQL(
    span,
    SQL_QUERIES.GET_TOKEN_BY_HASH,
    [tokenHash],
  );
  let apiToken: UserApiToken | null = null;
  if (tokensRaw.length > 0) {
    apiToken = fromRaw(tokensRaw[0]);
  }
  span.end();
  return apiToken;
}

export async function UsersApiTokensDataListByUser(
  context: Span | undefined,
  userId: string,
): Promise<UserApiToken[]> {
  const span = tracer.startSpan("UsersApiTokensDataListByUser", context);
  const tokensRaw = await DbUtilsQuerySQL(
    span,
    SQL_QUERIES.LIST_TOKENS_BY_USER,
    [userId],
  );
  const apiTokens: UserApiToken[] = [];
  for (const tokenRaw of tokensRaw) {
    apiTokens.push(fromRaw(tokenRaw));
  }
  span.end();
  return apiTokens;
}

export async function UsersApiTokensDataAdd(
  context: Span | undefined,
  apiToken: UserApiToken,
): Promise<void> {
  const span = tracer.startSpan("UsersApiTokensDataAdd", context);
  await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_TOKEN, [
    apiToken.id,
    apiToken.name,
    apiToken.userId,
    apiToken.tokenHash,
    apiToken.dateCreated,
  ]);
  span.end();
}

export async function UsersApiTokensDataDelete(
  context: Span | undefined,
  id: string,
): Promise<void> {
  const span = tracer.startSpan("UsersApiTokensDataDelete", context);
  await DbUtilsExecSQL(span, SQL_QUERIES.DELETE_TOKEN, [id]);
  span.end();
}

export async function UsersApiTokensDataDeleteByUser(
  context: Span | undefined,
  userId: string,
): Promise<void> {
  const span = tracer.startSpan("UsersApiTokensDataDeleteByUser", context);
  await DbUtilsExecSQL(span, SQL_QUERIES.DELETE_TOKENS_BY_USER, [userId]);
  span.end();
}

// Private Functions

function fromRaw(tokenRaw: any): UserApiToken {
  const apiToken = new UserApiToken();
  apiToken.id = tokenRaw.id;
  apiToken.name = tokenRaw.name;
  apiToken.userId = tokenRaw.userId;
  apiToken.tokenHash = tokenRaw.tokenHash;
  apiToken.dateCreated = tokenRaw.dateCreated;
  return apiToken;
}

// SQL
// Written SQLite-first with quoted identifiers (valid for both backends);
// the DbUtils facade converts `?` placeholders for Postgres.

const SQL_QUERIES = {
  GET_TOKEN_BY_ID: 'SELECT * FROM users_api_tokens WHERE "id" = ?',
  GET_TOKEN_BY_HASH: 'SELECT * FROM users_api_tokens WHERE "tokenHash" = ?',
  LIST_TOKENS_BY_USER: 'SELECT * FROM users_api_tokens WHERE "userId" = ?',
  INSERT_TOKEN:
    'INSERT INTO users_api_tokens ("id", "name", "userId", "tokenHash", "dateCreated") VALUES (?, ?, ?, ?, ?)',
  DELETE_TOKEN: 'DELETE FROM users_api_tokens WHERE "id" = ?',
  DELETE_TOKENS_BY_USER: 'DELETE FROM users_api_tokens WHERE "userId" = ?',
};

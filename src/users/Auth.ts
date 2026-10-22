import { createHash } from "crypto";
import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Span } from "@opentelemetry/sdk-trace-base";
import * as jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { DbUtilsExecSQL, DbUtilsQuerySQL, DbUtilsWithLock } from "../DbUtils";
import { User, UserScope } from "./User";
import { UserSession } from "./UserSession";
import {
  UsersApiTokensDataGetByTokenHash,
  UsersApiTokensDataSetLastUsed,
} from "./UsersApiTokensData";
import { UsersDataGet } from "./UsersData";

/**
 * Configuration subset required by the auth module.
 */
export interface AuthConfig {
  JWT_KEY: string;
  JWT_VALIDITY_DURATION: number;
  DATABASE_TYPE: "sqlite" | "postgres";
  /** Opt-in JWT revocation (requires the `users.tokenVersion` migration). */
  JWT_REVOCATION_ENABLED?: boolean;
  /** Per-user API token cap (defaults to 100 when unset). */
  API_TOKENS_MAX_PER_USER?: number;
  /** Login attempts allowed per window (defaults to 10; <= 0 disables). */
  AUTH_RATE_LIMIT_LOGIN_MAX?: number;
  /** Session refreshes allowed per window (defaults to 60; <= 0 disables). */
  AUTH_RATE_LIMIT_REFRESH_MAX?: number;
  /** Rate-limit window in seconds (defaults to 60). */
  AUTH_RATE_LIMIT_WINDOW_SECONDS?: number;
}

/**
 * Stable machine-readable error codes so API clients can tell an
 * unauthenticated request (401, session expired / logged out) apart from an
 * authenticated-but-forbidden one (403) and from bad login credentials (401
 * with `INVALID_CREDENTIALS`, which must not destroy an existing session).
 */
export const AUTH_ERROR_CODE_UNAUTHENTICATED = "UNAUTHENTICATED";
export const AUTH_ERROR_CODE_FORBIDDEN = "FORBIDDEN";
export const AUTH_ERROR_CODE_INVALID_CREDENTIALS = "INVALID_CREDENTIALS";

/** Default per-user API token cap when the config field is not set. */
const DEFAULT_API_TOKENS_MAX_PER_USER = 100;
const DEFAULT_RATE_LIMIT_LOGIN_MAX = 10;
const DEFAULT_RATE_LIMIT_REFRESH_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Rejected non-JWT credentials are remembered for a short time so that a
 * flood of bad tokens does not hit the database twice per request. Only the
 * SHA-256 hash of the presented value is stored, never the plaintext.
 */
const REJECTED_CREDENTIALS_MAX = 1024;
const REJECTED_CREDENTIALS_TTL_MS = 60_000;
const rejectedCredentials = new Map<string, number>();

/** `lastUsedAt` is written at most once per hour per token. */
const LAST_USED_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const LAST_USED_TRACKED_MAX = 4096;
const lastUsedWrites = new Map<string, number>();

let tracer: StandardTracer;
let config: AuthConfig;

/**
 * Injects the OTel tracer instance used by the auth module.
 * Must be called once at startup, before {@link AuthInit}.
 */
export function AuthSetOTel(tracerIn: StandardTracer): void {
  tracer = tracerIn;
}

/** Whether the opt-in `JWT_REVOCATION_ENABLED` config flag is on. */
export function AuthJwtRevocationEnabled(): boolean {
  return config?.JWT_REVOCATION_ENABLED === true;
}

/** Configured per-user API token cap (`API_TOKENS_MAX_PER_USER`). */
export function AuthGetApiTokensMaxPerUser(): number {
  return config?.API_TOKENS_MAX_PER_USER ?? DEFAULT_API_TOKENS_MAX_PER_USER;
}

/** Configured login rate limit (`AUTH_RATE_LIMIT_LOGIN_MAX`). */
export function AuthGetRateLimitLoginMax(): number {
  return config?.AUTH_RATE_LIMIT_LOGIN_MAX ?? DEFAULT_RATE_LIMIT_LOGIN_MAX;
}

/** Configured session-refresh rate limit (`AUTH_RATE_LIMIT_REFRESH_MAX`). */
export function AuthGetRateLimitRefreshMax(): number {
  return config?.AUTH_RATE_LIMIT_REFRESH_MAX ?? DEFAULT_RATE_LIMIT_REFRESH_MAX;
}

/** Configured rate-limit window in seconds (`AUTH_RATE_LIMIT_WINDOW_SECONDS`). */
export function AuthGetRateLimitWindowSeconds(): number {
  return (
    config?.AUTH_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS
  );
}

/**
 * Initialise the auth module.
 *
 * Registers the full scope set of the host application and resolves the JWT
 * signing key. An explicitly configured (non-empty) `JWT_KEY` always wins and
 * is never read from or written to the database; when it is empty the key is
 * loaded from the `metadata` table, and a fresh one is generated and
 * persisted when none is stored yet. The read/create sequence runs under an
 * advisory lock on Postgres so concurrently booting replicas agree on a
 * single key; SQLite has a single writer (see README).
 *
 * Changing the key invalidates every previously issued JWT.
 *
 * @param context    Parent OTel span.
 * @param configIn   Server configuration (JWT_KEY is updated in place when
 *                   it is DB-managed).
 * @param allScopes  All scopes supported by the host application.
 */
export async function AuthInit(
  context: Span,
  configIn: AuthConfig,
  allScopes: UserScope[] = [],
): Promise<void> {
  config = configIn;
  User.ALL_SCOPES = [...allScopes];
  const span = tracer.startSpan("AuthInit", context);
  try {
    if ((configIn.JWT_KEY ?? "") !== "") {
      // Operator-provided key: honor it, never read or overwrite the DB key.
      return;
    }
    await DbUtilsWithLock(
      "auth_token",
      async () => {
        const authKeyRaw = await DbUtilsQuerySQL(
          span,
          SQL_QUERIES.GET_AUTH_TOKEN,
        );
        if (authKeyRaw.length == 0) {
          configIn.JWT_KEY = uuidv4();
          await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_AUTH_TOKEN, [
            configIn.JWT_KEY,
            new Date().toISOString(),
          ]);
        } else {
          configIn.JWT_KEY = authKeyRaw[0].value;
        }
      },
      span,
    );
  } finally {
    span.end();
  }
}

export async function AuthGenerateJWT(user: User): Promise<string> {
  return jwt.sign(
    {
      exp: Math.floor(Date.now() / 1000) + config.JWT_VALIDITY_DURATION,
      userId: user.id,
      userName: user.name,
      role: user.role,
      scopes: user.role === "admin" ? User.ALL_SCOPES : user.scopes,
      tokenVersion: user.tokenVersion ?? 0,
    },
    config.JWT_KEY,
    { algorithm: "HS256" },
  );
}

/**
 * Decode credentials from request, caching result on req._jwtPayload to
 * avoid redundant resolution when multiple auth functions are called per
 * request.
 *
 * A `Bearer` credential is first verified as a JWT (HS256 only). When JWT
 * verification fails, the credential is resolved as a user API token: the
 * value is SHA-256 hashed and looked up in `users_api_tokens`; on match, a
 * payload mirroring the owning user's live role and scopes is built (valid
 * until the token is revoked or expires).
 *
 * When `JWT_REVOCATION_ENABLED` is on, the live user is loaded (and cached on
 * the request) after verification and the token is rejected when the user is
 * gone or its `tokenVersion` differs from the claim.
 */
async function jwtDecodeCached(req: any): Promise<any | null> {
  if (req._jwtPayload) {
    return req._jwtPayload;
  }
  const authorization = req.headers?.authorization;
  if (!authorization) {
    return null;
  }
  const token = authorization.split(" ")[1];
  if (!token) {
    return null;
  }
  let info: any;
  try {
    info = jwt.verify(token, config.JWT_KEY, { algorithms: ["HS256"] });
  } catch {
    const apiInfo = await resolveApiToken(req, token);
    if (apiInfo) {
      req._jwtPayload = apiInfo;
      return apiInfo;
    }
    return null;
  }
  if (config.JWT_REVOCATION_ENABLED) {
    const user = await loadLiveUser(req, info);
    if (
      !user ||
      Number(user.tokenVersion ?? 0) !== Number(info.tokenVersion ?? 0)
    ) {
      return null;
    }
  }
  req._jwtPayload = info;
  return info;
}

/**
 * Resolve the user referenced by the verified credentials from the database,
 * caching the result (including a missing user) on the request so a guard and
 * route handlers share one query.
 */
async function loadLiveUser(req: any, info: any): Promise<User | null> {
  if (req._authLiveUserLoaded) {
    return req._authLiveUser;
  }
  req._authLiveUserLoaded = true;
  const span = tracer.startSpan("AuthGetLiveUser");
  try {
    req._authLiveUser = info?.userId
      ? await UsersDataGet(span, info.userId)
      : null;
  } finally {
    span.end();
  }
  return req._authLiveUser;
}

/**
 * Return the live user behind the request credentials or `null` when the
 * request is unauthenticated, the user was deleted, or (with
 * `JWT_REVOCATION_ENABLED`) the token was issued before a role/scope/password
 * change. Authorization must use this function (or the guards below), not the
 * role/scopes claims of `AuthGetUserSession`.
 */
export async function AuthGetLiveUser(req: any): Promise<User | null> {
  if (req._authLiveUserLoaded) {
    return req._authLiveUser;
  }
  const info = await jwtDecodeCached(req);
  if (!info) {
    return null;
  }
  return loadLiveUser(req, info);
}

function isKnownRejectedCredential(tokenHash: string): boolean {
  const expiresAt = rejectedCredentials.get(tokenHash);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    rejectedCredentials.delete(tokenHash);
    return false;
  }
  return true;
}

function rememberRejectedCredential(tokenHash: string): void {
  if (rejectedCredentials.size >= REJECTED_CREDENTIALS_MAX) {
    const oldest = rejectedCredentials.keys().next().value;
    if (oldest !== undefined) {
      rejectedCredentials.delete(oldest);
    }
  }
  rejectedCredentials.set(tokenHash, Date.now() + REJECTED_CREDENTIALS_TTL_MS);
}

function shouldWriteLastUsed(tokenId: string): boolean {
  const lastWrite = lastUsedWrites.get(tokenId);
  const now = Date.now();
  if (lastWrite !== undefined && now - lastWrite < LAST_USED_UPDATE_INTERVAL_MS) {
    return false;
  }
  if (lastUsedWrites.size >= LAST_USED_TRACKED_MAX) {
    const oldest = lastUsedWrites.keys().next().value;
    if (oldest !== undefined) {
      lastUsedWrites.delete(oldest);
    }
  }
  lastUsedWrites.set(tokenId, now);
  return true;
}

/**
 * Resolve an API token bearer credential to a user-backed payload.
 * Permissions are read from the user record at resolution time, so
 * role/scope changes apply to existing tokens immediately.
 */
async function resolveApiToken(req: any, token: string): Promise<any | null> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  if (isKnownRejectedCredential(tokenHash)) {
    return null;
  }
  const span = tracer.startSpan("AuthResolveApiToken");
  try {
    const apiToken = await UsersApiTokensDataGetByTokenHash(span, tokenHash);
    if (!apiToken) {
      rememberRejectedCredential(tokenHash);
      return null;
    }
    if (apiToken.expiresAt && Date.parse(apiToken.expiresAt) <= Date.now()) {
      rememberRejectedCredential(tokenHash);
      return null;
    }
    const user = await UsersDataGet(span, apiToken.userId);
    if (!user) {
      rememberRejectedCredential(tokenHash);
      return null;
    }
    // Share the freshly loaded user with AuthGetLiveUser / the guards.
    req._authLiveUser = user;
    req._authLiveUserLoaded = true;
    if (shouldWriteLastUsed(apiToken.id)) {
      try {
        await UsersApiTokensDataSetLastUsed(
          span,
          apiToken.id,
          new Date().toISOString(),
        );
      } catch {
        // Best effort: a failed lastUsedAt write never breaks authentication.
      }
    }
    return {
      userId: user.id,
      userName: user.name,
      role: user.role,
      scopes: user.role === "admin" ? [...User.ALL_SCOPES] : user.scopes,
    };
  } finally {
    span.end();
  }
}

export async function AuthMustBeAuthenticated(
  req: any,
  res: any,
): Promise<void> {
  const user = await AuthGetLiveUser(req);
  if (!user) {
    res.status(401).send({
      error: "Authentication Required",
      code: AUTH_ERROR_CODE_UNAUTHENTICATED,
    });
    throw new Error("Authentication Required");
  }
}

export async function AuthMustBeAdmin(req: any, res: any): Promise<void> {
  const user = await AuthGetLiveUser(req);
  if (!user) {
    res.status(401).send({
      error: "Authentication Required",
      code: AUTH_ERROR_CODE_UNAUTHENTICATED,
    });
    throw new Error("Authentication Required");
  }
  if (user.role !== "admin") {
    res.status(403).send({
      error: "Access Denied",
      code: AUTH_ERROR_CODE_FORBIDDEN,
    });
    throw new Error("Access Denied");
  }
}

export async function AuthHasScope(
  req: any,
  res: any,
  scope: UserScope,
): Promise<void> {
  const user = await AuthGetLiveUser(req);
  if (!user) {
    res.status(401).send({
      error: "Authentication Required",
      code: AUTH_ERROR_CODE_UNAUTHENTICATED,
    });
    throw new Error("Authentication Required");
  }
  if (user.role === "admin") {
    return;
  }
  const scopes: UserScope[] = user.scopes || [];
  if (scopes.includes(scope)) {
    return;
  }
  res.status(403).send({
    error: "Access Denied",
    code: AUTH_ERROR_CODE_FORBIDDEN,
  });
  throw new Error("Access Denied");
}

/**
 * Decoded session claims for display purposes only. Authorization must never
 * rely on these role/scopes claims: use `AuthGetLiveUser` or the guards,
 * which resolve the live user from the database.
 */
export async function AuthGetUserSession(req: any): Promise<UserSession> {
  const userSession: UserSession = { isAuthenticated: false };
  const info = await jwtDecodeCached(req);
  if (info) {
    userSession.userId = info.userId;
    userSession.userName = info.userName;
    userSession.role = info.role;
    userSession.scopes = info.scopes;
    userSession.isAuthenticated = true;
  }
  return userSession;
}

// SQL
// Written SQLite-first with quoted identifiers (valid for both backends);
// the DbUtils facade converts `?` placeholders for Postgres.

const SQL_QUERIES = {
  GET_AUTH_TOKEN:
    "SELECT value FROM metadata WHERE \"type\" = 'auth_token' ORDER BY \"dateCreated\" DESC LIMIT 1",
  INSERT_AUTH_TOKEN:
    'INSERT INTO metadata ("type", "value", "dateCreated") VALUES (\'auth_token\', ?, ?)',
};

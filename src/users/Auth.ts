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
}

/** Default per-user API token cap when the config field is not set. */
const DEFAULT_API_TOKENS_MAX_PER_USER = 100;

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

/**
 * Initialise the auth module.
 *
 * Registers the full scope set of the host application and loads the JWT
 * signing key from the `metadata` table. When no key is stored yet, a fresh
 * one is generated and persisted. The read/create sequence runs under an
 * advisory lock on Postgres so concurrently booting replicas agree on a
 * single key; SQLite has a single writer (see README).
 *
 * @param context    Parent OTel span.
 * @param configIn   Server configuration (JWT_KEY is updated in place).
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
    await DbUtilsWithLock("auth_token", async () => {
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
    });
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
 * When `JWT_REVOCATION_ENABLED` is on, the live user is re-read after
 * verification and the token is rejected when the user is gone or its
 * `tokenVersion` differs from the claim.
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
    const apiInfo = await resolveApiToken(token);
    if (apiInfo) {
      req._jwtPayload = apiInfo;
      return apiInfo;
    }
    return null;
  }
  if (config.JWT_REVOCATION_ENABLED && !(await isTokenVersionCurrent(info))) {
    return null;
  }
  req._jwtPayload = info;
  return info;
}

/** Re-read the user and compare its live `tokenVersion` with the claim. */
async function isTokenVersionCurrent(info: any): Promise<boolean> {
  const span = tracer.startSpan("AuthCheckTokenVersion");
  try {
    const user = await UsersDataGet(span, info.userId);
    if (!user) {
      return false;
    }
    return Number(user.tokenVersion ?? 0) === Number(info.tokenVersion ?? 0);
  } finally {
    span.end();
  }
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
async function resolveApiToken(token: string): Promise<any | null> {
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
  if (!(await jwtDecodeCached(req))) {
    res.status(403).send({ error: "Access Denied" });
    throw new Error("Access Denied");
  }
}

export async function AuthMustBeAdmin(req: any, res: any): Promise<void> {
  const info = await jwtDecodeCached(req);
  if (info?.role === "admin") {
    return;
  }
  res.status(403).send({ error: "Access Denied" });
  throw new Error("Access Denied");
}

export async function AuthHasScope(
  req: any,
  res: any,
  scope: UserScope,
): Promise<void> {
  const info = await jwtDecodeCached(req);
  if (!info) {
    res.status(403).send({ error: "Access Denied" });
    throw new Error("Access Denied");
  }
  if (info.role === "admin") {
    return;
  }
  const scopes: UserScope[] = info.scopes || [];
  if (scopes.includes(scope)) {
    return;
  }
  res.status(403).send({ error: "Access Denied" });
  throw new Error("Access Denied");
}

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

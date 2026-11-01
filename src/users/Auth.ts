import { createHash, randomUUID } from "crypto";
import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import type { Span } from "@opentelemetry/sdk-trace";
import * as jwt from "jsonwebtoken";
import { DbUtilsExecSQL, DbUtilsQuerySQL, DbUtilsWithLock } from "../DbUtils";
import { User, UserScope } from "./User";
import { UserPasswordSetPolicy } from "./UserPassword";
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
  /**
   * Absolute session lifetime in seconds measured from the first login
   * (`defaults to 30 days; <= 0` disables the cap).
   */
  JWT_SESSION_MAX_DURATION?: number;
  /** JWT `iss` claim (`""` disables it; defaults to `devopsplaybook.io`). */
  JWT_ISSUER?: string;
  /** JWT `aud` claim (`""` disables it; defaults to `devopsplaybook.io`). */
  JWT_AUDIENCE?: string;
  /** Per-user API token cap (defaults to 100 when unset). */
  API_TOKENS_MAX_PER_USER?: number;
  /** Login attempts allowed per window (defaults to 10; <= 0 disables). */
  AUTH_RATE_LIMIT_LOGIN_MAX?: number;
  /** Per-IP login attempts allowed per window (defaults to 0 = disabled). */
  AUTH_RATE_LIMIT_LOGIN_IP_MAX?: number;
  /** Status-endpoint reads allowed per window (defaults to 60; <= 0 disables). */
  AUTH_RATE_LIMIT_STATUS_MAX?: number;
  /** Session refreshes allowed per window (defaults to 60; <= 0 disables). */
  AUTH_RATE_LIMIT_REFRESH_MAX?: number;
  /** Rate-limit window in seconds (defaults to 60). */
  AUTH_RATE_LIMIT_WINDOW_SECONDS?: number;
  /** Minimum password length (defaults to 0: no minimum). */
  PASSWORD_MIN_LENGTH?: number;
  /** bcrypt cost factor for new hashes (default 10, clamped to 10-15). */
  BCRYPT_ROUNDS?: number;
  /** Revoke every API token when a password changes (defaults to false). */
  API_TOKENS_REVOKE_ON_PASSWORD_CHANGE?: boolean;
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
const DEFAULT_RATE_LIMIT_STATUS_MAX = 60;
const DEFAULT_JWT_SESSION_MAX_DURATION = 30 * 24 * 3600;
const DEFAULT_JWT_ISSUER = "devopsplaybook.io";
const DEFAULT_JWT_AUDIENCE = "devopsplaybook.io";

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
 * Extract the credential from an `Authorization` header. Only the `Bearer`
 * scheme (case-insensitive, RFC 6750) is accepted: another scheme carrying a
 * valid JWT must not authenticate a request.
 */
function extractBearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string") {
    return null;
  }
  const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

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

/** Configured per-IP login rate limit (`AUTH_RATE_LIMIT_LOGIN_IP_MAX`). */
export function AuthGetRateLimitLoginIpMax(): number {
  return config?.AUTH_RATE_LIMIT_LOGIN_IP_MAX ?? 0;
}

/** Configured status-endpoint rate limit (`AUTH_RATE_LIMIT_STATUS_MAX`). */
export function AuthGetRateLimitStatusMax(): number {
  return config?.AUTH_RATE_LIMIT_STATUS_MAX ?? DEFAULT_RATE_LIMIT_STATUS_MAX;
}

/** Configured absolute session lifetime in seconds (`JWT_SESSION_MAX_DURATION`). */
export function AuthGetJwtSessionMaxDuration(): number {
  return (
    config?.JWT_SESSION_MAX_DURATION ?? DEFAULT_JWT_SESSION_MAX_DURATION
  );
}

/** Configured JWT issuer (`JWT_ISSUER`, `""` disables the claim). */
export function AuthGetJwtIssuer(): string {
  return config?.JWT_ISSUER ?? DEFAULT_JWT_ISSUER;
}

/** Configured JWT audience (`JWT_AUDIENCE`, `""` disables the claim). */
export function AuthGetJwtAudience(): string {
  return config?.JWT_AUDIENCE ?? DEFAULT_JWT_AUDIENCE;
}

/** Configured rate-limit window in seconds (`AUTH_RATE_LIMIT_WINDOW_SECONDS`). */
export function AuthGetRateLimitWindowSeconds(): number {
  return (
    config?.AUTH_RATE_LIMIT_WINDOW_SECONDS ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS
  );
}

/** Whether API tokens are revoked when a password changes. */
export function AuthGetApiTokensRevokeOnPasswordChange(): boolean {
  return config?.API_TOKENS_REVOKE_ON_PASSWORD_CHANGE === true;
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
  UserPasswordSetPolicy({
    minLength: configIn.PASSWORD_MIN_LENGTH ?? 0,
    bcryptRounds: configIn.BCRYPT_ROUNDS ?? 10,
  });
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
          configIn.JWT_KEY = randomUUID();
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

/** Optional parameters for {@link AuthGenerateJWT}. */
export interface AuthGenerateJWTOptions {
  /**
   * Mint time of the current session, in seconds since the epoch. Renewals
   * must carry the original value so `JWT_SESSION_MAX_DURATION` bounds the
   * session independently of how often it is refreshed.
   */
  sessionStartedAt?: number;
}

/**
 * Sign an HS256 JWT for a user (admins get all scopes).
 *
 * The token carries `iat`, `exp`, `sessionStartedAt`, `userId`, `userName`,
 * `role`, `scopes` and `tokenVersion`. `iss`/`aud` are set unless the
 * corresponding config field is empty, and a random `jti` is always added.
 * `exp` is `JWT_VALIDITY_DURATION` from now, capped by
 * `sessionStartedAt + JWT_SESSION_MAX_DURATION` when that limit is enabled.
 */
export async function AuthGenerateJWT(
  user: User,
  options: AuthGenerateJWTOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sessionStartedAt = options.sessionStartedAt ?? now;
  const sessionMaxDuration = AuthGetJwtSessionMaxDuration();
  const expiresAt =
    sessionMaxDuration > 0
      ? Math.min(
          now + config.JWT_VALIDITY_DURATION,
          sessionStartedAt + sessionMaxDuration,
        )
      : now + config.JWT_VALIDITY_DURATION;
  const issuer = AuthGetJwtIssuer();
  const audience = AuthGetJwtAudience();
  return jwt.sign(
    {
      exp: expiresAt,
      iat: now,
      sessionStartedAt,
      userId: user.id,
      userName: user.name,
      role: user.role,
      scopes: user.role === "admin" ? User.ALL_SCOPES : user.scopes,
      tokenVersion: user.tokenVersion ?? 0,
    },
    config.JWT_KEY,
    {
      algorithm: "HS256",
      jwtid: randomUUID(),
      ...(issuer !== "" ? { issuer } : {}),
      ...(audience !== "" ? { audience } : {}),
    },
  );
}

/**
 * Validate the optional `iss`/`aud` claims. Missing claims are accepted so
 * tokens issued before 2.6.0 keep working until they expire; a claim that is
 * present must match the configured value. `aud` may be a string or an array.
 */
function claimsAccepted(info: any): boolean {
  const expectedIssuer = AuthGetJwtIssuer();
  if (info.iss !== undefined) {
    if (expectedIssuer === "" || info.iss !== expectedIssuer) {
      return false;
    }
  }
  const expectedAudience = AuthGetJwtAudience();
  if (info.aud !== undefined) {
    if (expectedAudience === "") {
      return false;
    }
    const audiences = Array.isArray(info.aud) ? info.aud : [info.aud];
    if (!audiences.includes(expectedAudience)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a decoded session exceeded the absolute session lifetime
 * (`JWT_SESSION_MAX_DURATION`, `<= 0` disables the check). The start is the
 * `sessionStartedAt` claim, falling back to `iat` for tokens issued before
 * 2.6.0. An unknown start is not considered expired.
 */
export function AuthSessionExpired(session: UserSession): boolean {
  const sessionMaxDuration = AuthGetJwtSessionMaxDuration();
  if (sessionMaxDuration <= 0) {
    return false;
  }
  const startedAt = session.sessionStartedAt ?? session.issuedAt;
  if (startedAt === undefined) {
    return false;
  }
  return Math.floor(Date.now() / 1000) >= startedAt + sessionMaxDuration;
}

/**
 * Decode credentials from request, caching the resolution on the request
 * (`req._jwtResolved` / `req._jwtPayload`) so multiple auth helpers called
 * per request never resolve the credential twice. Rejections are cached too:
 * `_jwtPayload` stays `null`, so a revoked or invalid credential is not
 * re-verified by a later guard or route handler (see H1/L11).
 *
 * A `Bearer` credential is first verified as a JWT (HS256 only); the
 * optional `iss`/`aud` claims are validated when present. When JWT
 * verification fails, the credential is resolved as a user API token: the
 * value is SHA-256 hashed and looked up in `users_api_tokens`; on match, a
 * payload mirroring the owning user's live role and scopes is built (valid
 * until the token is revoked or expires).
 *
 * When `JWT_REVOCATION_ENABLED` is on, the live user is loaded (and cached on
 * the request) before the token is accepted, and the token is rejected when
 * the user is gone or its `tokenVersion` differs from the claim. The
 * rejection is cached, so a stale credential cannot authorize any later
 * helper call within the same request.
 */
async function jwtDecodeCached(req: any): Promise<any | null> {
  if (req._jwtResolved) {
    return req._jwtPayload ?? null;
  }
  req._jwtResolved = true;
  req._jwtPayload = null;
  const token = extractBearerToken(req.headers?.authorization);
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
      req._authCredentialType = "api_token";
      return apiInfo;
    }
    return null;
  }
  if (!claimsAccepted(info)) {
    return null;
  }
  if (config.JWT_REVOCATION_ENABLED) {
    const user = await loadLiveUser(req, info);
    if (
      !user ||
      Number(user.tokenVersion ?? 0) !== Number(info.tokenVersion ?? 0)
    ) {
      // Defence in depth: never leave the stale user reachable on the request.
      req._authLiveUser = null;
      return null;
    }
  }
  req._jwtPayload = info;
  req._authCredentialType = "jwt";
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
 *
 * Credential resolution always goes through {@link jwtDecodeCached} first, so
 * a rejection (including a stale `tokenVersion`) is cached and cannot be
 * bypassed by an earlier live-user read.
 */
export async function AuthGetLiveUser(req: any): Promise<User | null> {
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
    if (apiToken.expiresAt) {
      // Fail closed: an expiry that does not parse must never extend a token
      // indefinitely (a NaN comparison would otherwise be false).
      const expiresAtMs = Date.parse(apiToken.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        rememberRejectedCredential(tokenHash);
        return null;
      }
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
 *
 * The credential resolution is cached per request (including rejections), so
 * a revoked token yields `isAuthenticated: false` here and cannot be reused
 * by a guard later in the same request. `credentialType`, `issuedAt`,
 * `expiresAt` and `sessionStartedAt` are display metadata only.
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
    userSession.credentialType = req._authCredentialType;
    userSession.issuedAt =
      typeof info.iat === "number" ? info.iat : undefined;
    userSession.expiresAt =
      typeof info.exp === "number" ? info.exp : undefined;
    userSession.sessionStartedAt = userSession.issuedAt;
    if (typeof info.sessionStartedAt === "number") {
      userSession.sessionStartedAt = info.sessionStartedAt;
    }
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

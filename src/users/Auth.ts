import { createHash } from "crypto";
import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Span } from "@opentelemetry/sdk-trace-base";
import * as jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { DbUtilsExecSQL, DbUtilsQuerySQL } from "../DbUtils";
import { User, UserScope } from "./User";
import { UserSession } from "./UserSession";
import { UsersApiTokensDataGetByTokenHash } from "./UsersApiTokensData";
import { UsersDataGet } from "./UsersData";

/**
 * Configuration subset required by the auth module.
 */
export interface AuthConfig {
  JWT_KEY: string;
  JWT_VALIDITY_DURATION: number;
  DATABASE_TYPE: "sqlite" | "postgres";
}

let tracer: StandardTracer;
let config: AuthConfig;

/**
 * Injects the OTel tracer instance used by the auth module.
 * Must be called once at startup, before {@link AuthInit}.
 */
export function AuthSetOTel(tracerIn: StandardTracer): void {
  tracer = tracerIn;
}

/**
 * Initialise the auth module.
 *
 * Registers the full scope set of the host application and loads the JWT
 * signing key from the `metadata` table. When no key is stored yet, a fresh
 * one is generated and persisted.
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
  const authKeyRaw = await DbUtilsQuerySQL(span, SQL_QUERIES.GET_AUTH_TOKEN);
  if (authKeyRaw.length == 0) {
    configIn.JWT_KEY = uuidv4();
    await DbUtilsExecSQL(span, SQL_QUERIES.INSERT_AUTH_TOKEN, [
      configIn.JWT_KEY,
      new Date().toISOString(),
    ]);
  } else {
    configIn.JWT_KEY = authKeyRaw[0].value;
  }
  span.end();
}

export async function AuthGenerateJWT(user: User): Promise<string> {
  return jwt.sign(
    {
      exp: Math.floor(Date.now() / 1000) + config.JWT_VALIDITY_DURATION,
      userId: user.id,
      userName: user.name,
      role: user.role,
      scopes: user.role === "admin" ? User.ALL_SCOPES : user.scopes,
    },
    config.JWT_KEY,
  );
}

/**
 * Decode credentials from request, caching result on req._jwtPayload to
 * avoid redundant resolution when multiple auth functions are called per
 * request.
 *
 * A `Bearer` credential is first verified as a JWT. When JWT verification
 * fails, the credential is resolved as a user API token: the value is
 * SHA-256 hashed and looked up in `users_api_tokens`; on match, a payload
 * mirroring the owning user's live role and scopes is built (valid until
 * the token is revoked).
 */
async function jwtDecodeCached(req: any): Promise<any | null> {
  if (req._jwtPayload) {
    return req._jwtPayload;
  }
  if (!req.headers.authorization) {
    return null;
  }
  try {
    const info = jwt.verify(
      req.headers.authorization.split(" ")[1],
      config.JWT_KEY,
    );
    req._jwtPayload = info;
    return info;
  } catch {
    const info = await resolveApiToken(req.headers.authorization);
    if (info) {
      req._jwtPayload = info;
      return info;
    }
    return null;
  }
}

/**
 * Resolve an API token bearer credential to a user-backed payload.
 * Permissions are read from the user record at resolution time, so
 * role/scope changes apply to existing tokens immediately.
 */
async function resolveApiToken(authorizationHeader: string): Promise<any | null> {
  const token = authorizationHeader.split(" ")[1];
  if (!token) {
    return null;
  }
  const span = tracer.startSpan("AuthResolveApiToken");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const apiToken = await UsersApiTokensDataGetByTokenHash(span, tokenHash);
  let payload: any | null = null;
  if (apiToken) {
    const user = await UsersDataGet(span, apiToken.userId);
    if (user) {
      payload = {
        userId: user.id,
        userName: user.name,
        role: user.role,
        scopes: user.role === "admin" ? [...User.ALL_SCOPES] : user.scopes,
      };
    }
  }
  span.end();
  return payload;
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
  GET_AUTH_TOKEN: "SELECT value FROM metadata WHERE \"type\" = 'auth_token' LIMIT 1",
  INSERT_AUTH_TOKEN:
    'INSERT INTO metadata ("type", "value", "dateCreated") VALUES (\'auth_token\', ?, ?)',
};

import { createHash, randomBytes } from "crypto";
import { OTelRequestSpan } from "@devopsplaybook.io/otel-utils-fastify";
import rateLimit from "@fastify/rate-limit";
import { FastifyInstance, FastifyRequest, RequestGenericInterface } from "fastify";
import {
  AUTH_ERROR_CODE_FORBIDDEN,
  AUTH_ERROR_CODE_INVALID_CREDENTIALS,
  AUTH_ERROR_CODE_UNAUTHENTICATED,
  AuthGenerateJWT,
  AuthGetApiTokensMaxPerUser,
  AuthGetApiTokensRevokeOnPasswordChange,
  AuthGetLiveUser,
  AuthGetRateLimitLoginMax,
  AuthGetRateLimitRefreshMax,
  AuthGetRateLimitWindowSeconds,
  AuthGetUserSession,
  AuthJwtRevocationEnabled,
  AuthMustBeAdmin,
} from "./Auth";
import { DbUtilsWithLock } from "../DbUtils";
import { User } from "./User";
import { UserApiToken } from "./UserApiToken";
import {
  UserPasswordCheckPassword,
  UserPasswordCheckPasswordDummy,
  UserPasswordSetPassword,
  UserPasswordValidate,
} from "./UserPassword";
import {
  UsersApiTokensDataAddIfBelowCap,
  UsersApiTokensDataDelete,
  UsersApiTokensDataDeleteByUser,
  UsersApiTokensDataGet,
  UsersApiTokensDataListByUser,
  UsersApiTokensDataSupportsOptionalColumns,
} from "./UsersApiTokensData";
import {
  UsersDataAdd,
  UsersDataAddIfEmpty,
  UsersDataBumpTokenVersion,
  UsersDataCount,
  UsersDataDeleteWithTokens,
  UsersDataDemoteAdminIfNotLast,
  UsersDataGet,
  UsersDataGetByName,
  UsersDataList,
  UsersDataUpdatePassword,
  UsersDataUpdateUser,
  isUniqueViolationError,
} from "./UsersData";

/** Maximum accepted API token name length. */
const API_TOKEN_NAME_MAX_LENGTH = 255;
/** Default page size of `GET /` and the largest accepted `limit`. */
const USERS_LIST_DEFAULT_LIMIT = 100;
const USERS_LIST_MAX_LIMIT = 1000;

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Validate a `{ name, password }` body; returns an error message or `null`. */
function validateCredentialsBody(body: Record<string, unknown>): string | null {
  if (isMissing(body.name)) {
    return "Missing: Name";
  }
  if (typeof body.name !== "string") {
    return "Invalid: Name";
  }
  if (isMissing(body.password)) {
    return "Missing: Password";
  }
  if (typeof body.password !== "string") {
    return "Invalid: Password";
  }
  return null;
}

/** Validate the user-creation body; returns an error message or `null`. */
function validateCreateBody(body: Record<string, unknown>): string | null {
  const credentialsError = validateCredentialsBody(body);
  if (credentialsError) {
    return credentialsError;
  }
  if (
    body.role !== undefined &&
    body.role !== "admin" &&
    body.role !== "user"
  ) {
    return "Invalid: role";
  }
  if (body.scopes !== undefined) {
    if (
      !Array.isArray(body.scopes) ||
      body.scopes.some((scope) => typeof scope !== "string")
    ) {
      return "Invalid: scopes";
    }
  }
  return null;
}

/** Build a user from an already validated body. */
function buildNewUser(body: Record<string, unknown>, isFirstUser: boolean): User {
  const newUser = new User();
  newUser.name = body.name as string;
  if (isFirstUser) {
    // First user is always admin
    newUser.role = "admin";
    newUser.scopes = [...User.ALL_SCOPES];
  } else {
    newUser.role = body.role === "admin" ? "admin" : "user";
    if (Array.isArray(body.scopes)) {
      newUser.scopes = (body.scopes as string[]).filter((scope) =>
        User.ALL_SCOPES.includes(scope),
      );
    }
  }
  return newUser;
}

/** Parse an optional non-negative integer query parameter. */
function parseNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

/** Credential-bearing responses must never be cached by browsers or proxies. */
function setNoStoreHeaders(res: any): void {
  res
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .header("vary", "Authorization");
}

/** 401 with the stable unauthenticated code (session expired or logged out). */
function sendUnauthenticated(res: any): any {
  return res.status(401).send({
    error: "Authentication Required",
    code: AUTH_ERROR_CODE_UNAUTHENTICATED,
  });
}

/**
 * Standard user management routes shared across applications:
 * initialization status, login (session), user CRUD and password changes.
 *
 * Register on a fastify instance:
 * ```ts
 * fastify.register(new UsersRoutes().getRoutes, { prefix: "/api/users" });
 * ```
 */
export class UsersRoutes {
  //

  public async getRoutes(fastify: FastifyInstance): Promise<void> {
    //
    // Per-route limits protect the credential endpoints below. The preHandler
    // hook makes the parsed login body available to the key generator.
    if (!fastify.hasDecorator("rateLimit")) {
      await fastify.register(rateLimit, {
        global: false,
        hook: "preHandler",
        errorResponseBuilder: (
          _req: FastifyRequest,
          context: { after: string; statusCode: number },
        ) => ({
          statusCode: context.statusCode,
          error: "Too Many Requests",
          code: "RATE_LIMITED",
          message: `Rate limit exceeded, retry in ${context.after}`,
        }),
      });
    }
    const loginMax = AuthGetRateLimitLoginMax();
    const refreshMax = AuthGetRateLimitRefreshMax();
    const rateLimitWindowMs = AuthGetRateLimitWindowSeconds() * 1000;

    fastify.get("/status/initialization", async (req, res) => {
      const count = await UsersDataCount(OTelRequestSpan(req));
      return res.status(200).send({ initialized: count > 0 });
    });

    // ==================== SESSION (Login) ====================

    interface PostSession extends RequestGenericInterface {
      Body: {
        name: string;
        password: string;
      };
    }
    fastify.post<PostSession>(
      "/session",
      loginMax > 0
        ? {
            config: {
              rateLimit: {
                max: loginMax,
                timeWindow: rateLimitWindowMs,
                keyGenerator: (req: FastifyRequest) => {
                  const body = (req.body ?? {}) as { name?: unknown };
                  return `${req.ip}:${String(body.name ?? "")
                    .trim()
                    .toLowerCase()
                    .slice(0, 255)}`;
                },
              },
            },
          }
        : {},
      async (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        let user: User | null;
        // From token
        const userSession = await AuthGetUserSession(req);
        if (userSession.isAuthenticated) {
          // isAuthenticated implies userId is set
          user = await UsersDataGet(
            OTelRequestSpan(req),
            userSession.userId as string,
          );
          if (!user) {
            return sendUnauthenticated(res);
          }
          setNoStoreHeaders(res);
          return res.status(201).send({
            success: true,
            token: await AuthGenerateJWT(user),
            user: user.toTransportJson(),
          });
        }

        // From User/Pass
        const validationError = validateCredentialsBody(body);
        if (validationError) {
          return res.status(400).send({ error: validationError });
        }
        user = await UsersDataGetByName(
          OTelRequestSpan(req),
          body.name as string,
        );
        if (!user) {
          // Compare against a dummy hash so an unknown user costs the same as
          // a wrong password (no account enumeration through response time).
          await UserPasswordCheckPasswordDummy(body.password);
          return res.status(401).send({
            error: "Authentication Failed",
            code: AUTH_ERROR_CODE_INVALID_CREDENTIALS,
          });
        } else if (
          await UserPasswordCheckPassword(
            OTelRequestSpan(req),
            user,
            body.password as string,
          )
        ) {
          setNoStoreHeaders(res);
          return res.status(201).send({
            success: true,
            token: await AuthGenerateJWT(user),
            user: user.toTransportJson(),
          });
        } else {
          return res.status(401).send({
            error: "Authentication Failed",
            code: AUTH_ERROR_CODE_INVALID_CREDENTIALS,
          });
        }
      },
    );

    fastify.post(
      "/session/refresh",
      refreshMax > 0
        ? {
            config: {
              rateLimit: {
                max: refreshMax,
                timeWindow: rateLimitWindowMs,
                keyGenerator: (req: FastifyRequest) => req.ip,
              },
            },
          }
        : {},
      async (req, res) => {
        const user = await AuthGetLiveUser(req);
        if (!user) {
          return sendUnauthenticated(res);
        }
        setNoStoreHeaders(res);
        return res.status(201).send({
          success: true,
          token: await AuthGenerateJWT(user),
          user: user.toTransportJson(),
        });
      },
    );

    // ==================== LIST USERS (Admin only) ====================

    fastify.get("/", async (req, res) => {
      try {
        await AuthMustBeAdmin(req, res);
      } catch {
        return;
      }
      const query = (req.query ?? {}) as { limit?: string; offset?: string };
      const limit = parseNonNegativeInt(query.limit);
      const offset = parseNonNegativeInt(query.offset);
      if (query.limit !== undefined && limit === undefined) {
        return res.status(400).send({ error: "Invalid: limit" });
      }
      if (query.offset !== undefined && offset === undefined) {
        return res.status(400).send({ error: "Invalid: offset" });
      }
      if (offset !== undefined && limit === undefined) {
        return res.status(400).send({ error: "Invalid: offset (limit required)" });
      }
      if (limit !== undefined && limit > USERS_LIST_MAX_LIMIT) {
        return res
          .status(400)
          .send({ error: `Invalid: limit (maximum ${USERS_LIST_MAX_LIMIT})` });
      }
      const users = await UsersDataList(
        OTelRequestSpan(req),
        limit ?? USERS_LIST_DEFAULT_LIMIT,
        offset,
      );
      return res.status(200).send(users.map((u) => u.toTransportJson()));
    });

    // ==================== CREATE USER ====================

    interface PostUser extends RequestGenericInterface {
      Body: {
        name: string;
        password: string;
        role?: string;
        scopes?: string[];
      };
    }
    fastify.post<PostUser>("/", async (req, res) => {
      const context = OTelRequestSpan(req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const createUser = async (isFirstUser: boolean) => {
        const validationError = validateCreateBody(body);
        if (validationError) {
          return res.status(400).send({ error: validationError });
        }
        const passwordError = UserPasswordValidate(body.password);
        if (passwordError) {
          return res.status(400).send({ error: passwordError });
        }
        if (await UsersDataGetByName(context, body.name as string)) {
          return res.status(400).send({ error: "Username Already Exists" });
        }

        const newUser = buildNewUser(body, isFirstUser);
        await UserPasswordSetPassword(context, newUser, body.password as string);
        try {
          if (isFirstUser) {
            // The emptiness check is part of the INSERT: when another request
            // bootstrapped first, this inserts nothing and the caller falls
            // back to the admin-authenticated path.
            if (!(await UsersDataAddIfEmpty(context, newUser))) {
              return null;
            }
          } else {
            await UsersDataAdd(context, newUser);
          }
        } catch (error) {
          // Uniqueness also holds when the pre-check races another request
          // (unique index on LOWER("name") – see README migration).
          if (isUniqueViolationError(error)) {
            return res.status(400).send({ error: "Username Already Exists" });
          }
          throw error;
        }
        return res.status(201).send({ user: newUser.toTransportJson() });
      };

      if ((await UsersDataCount(context)) > 0) {
        // If initialized, only admin can create users
        try {
          await AuthMustBeAdmin(req, res);
        } catch {
          return;
        }
        return createUser(false);
      }

      // Bootstrap: serialise the "no user yet → first admin" sequence across
      // replicas (advisory lock on Postgres; single writer on SQLite).
      return DbUtilsWithLock(
        "users_bootstrap",
        async () => {
          if ((await UsersDataCount(context)) === 0) {
            const firstUserResult = await createUser(true);
            if (firstUserResult !== null) {
              return firstUserResult;
            }
          }
          // Another replica bootstrapped first: require admin credentials.
          try {
            await AuthMustBeAdmin(req, res);
          } catch {
            return;
          }
          return createUser(false);
        },
        context,
      );
    });

    // ==================== CHANGE OWN PASSWORD ====================

    interface PutOwnPassword extends RequestGenericInterface {
      Body: {
        password: string;
        passwordOld: string;
      };
    }
    fastify.put<PutOwnPassword>("/password", async (req, res) => {
      const context = OTelRequestSpan(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const user = await AuthGetLiveUser(req);
      if (!user) {
        return sendUnauthenticated(res);
      }
      if (isMissing(body.password)) {
        return res.status(400).send({ error: "Missing: Password" });
      }
      if (typeof body.password !== "string") {
        return res.status(400).send({ error: "Invalid: Password" });
      }
      if (isMissing(body.passwordOld)) {
        return res.status(400).send({ error: "Missing: PasswordOld" });
      }
      if (typeof body.passwordOld !== "string") {
        return res.status(400).send({ error: "Invalid: PasswordOld" });
      }
      const passwordError = UserPasswordValidate(body.password);
      if (passwordError) {
        return res.status(400).send({ error: passwordError });
      }
      if (
        !(await UserPasswordCheckPassword(context, user, body.passwordOld))
      ) {
        return res
          .status(403)
          .send({ error: "Old Password Wrong", code: AUTH_ERROR_CODE_FORBIDDEN });
      }
      await UserPasswordSetPassword(context, user, body.password);
      const changed = await UsersDataUpdatePassword(context, user);
      if (changed === 0) {
        return res.status(404).send({ error: "User Not Found" });
      }
      if (AuthJwtRevocationEnabled()) {
        await UsersDataBumpTokenVersion(context, user.id);
      }
      if (AuthGetApiTokensRevokeOnPasswordChange()) {
        await UsersApiTokensDataDeleteByUser(context, user.id);
      }
      return res.status(201).send({});
    });

    // ==================== ADMIN: UPDATE USER (role, scopes, password) ====================

    interface PutUser extends RequestGenericInterface {
      Params: {
        id: string;
      };
      Body: {
        role?: string;
        scopes?: string[];
        password?: string;
      };
    }
    fastify.put<PutUser>("/:id", async (req, res) => {
      const context = OTelRequestSpan(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        await AuthMustBeAdmin(req, res);
      } catch {
        return;
      }

      // A body expecting nothing to change is malformed: answer 400, not 404/201
      if (
        body.role === undefined &&
        body.scopes === undefined &&
        body.password === undefined
      ) {
        return res.status(400).send({ error: "Missing: Body" });
      }
      if (
        body.role !== undefined &&
        body.role !== "admin" &&
        body.role !== "user"
      ) {
        return res.status(400).send({ error: "Invalid: role" });
      }
      if (
        body.scopes !== undefined &&
        (!Array.isArray(body.scopes) ||
          body.scopes.some((scope) => typeof scope !== "string"))
      ) {
        return res.status(400).send({ error: "Invalid: scopes" });
      }
      if (body.password !== undefined && typeof body.password !== "string") {
        return res.status(400).send({ error: "Invalid: Password" });
      }
      if (typeof body.password === "string") {
        const passwordError = UserPasswordValidate(body.password);
        if (passwordError) {
          return res.status(400).send({ error: passwordError });
        }
      }

      const user = await UsersDataGet(context, req.params.id);
      if (!user) {
        return res.status(404).send({ error: "User Not Found" });
      }

      let changed = false;
      let lastAdminRefused = false;
      let notFound = false;

      if (typeof body.password === "string") {
        await UserPasswordSetPassword(context, user, body.password);
      }

      await DbUtilsWithLock(
        "users_admin_guard",
        async () => {
          const newRole =
            body.role !== undefined
              ? body.role === "admin"
                ? "admin"
                : "user"
              : user.role;
          const newScopes = Array.isArray(body.scopes)
            ? (body.scopes as string[]).filter((scope) =>
                User.ALL_SCOPES.includes(scope),
              )
            : user.scopes;
          const roleChanged = newRole !== user.role;
          const scopesChanged =
            JSON.stringify(newScopes) !== JSON.stringify(user.scopes);

          if (roleChanged && user.role === "admin" && newRole === "user") {
            // Demotion guarded by a conditional UPDATE: concurrent demotions
            // can never remove the last administrator.
            const updates = await UsersDataDemoteAdminIfNotLast(
              context,
              user.id,
              scopesChanged ? newScopes : user.scopes,
            );
            if (updates === 0) {
              lastAdminRefused = true;
              return;
            }
            user.role = "user";
            user.scopes = newScopes;
            changed = true;
          } else if (roleChanged || scopesChanged) {
            user.role = newRole;
            user.scopes = newScopes;
            const updates = await UsersDataUpdateUser(context, user);
            if (updates === 0) {
              notFound = true;
              return;
            }
            changed = true;
          }

          // If password change requested
          if (typeof body.password === "string") {
            const updates = await UsersDataUpdatePassword(context, user);
            if (updates === 0) {
              notFound = true;
              return;
            }
            changed = true;
          }
        },
        context,
      );

      if (lastAdminRefused) {
        return res
          .status(400)
          .send({ error: "At least 1 admin must be defined" });
      }
      if (notFound) {
        return res.status(404).send({ error: "User Not Found" });
      }

      if (changed && AuthJwtRevocationEnabled()) {
        await UsersDataBumpTokenVersion(context, user.id);
      }
      if (
        typeof body.password === "string" &&
        AuthGetApiTokensRevokeOnPasswordChange()
      ) {
        await UsersApiTokensDataDeleteByUser(context, user.id);
      }

      return res.status(201).send({ user: user.toTransportJson() });
    });

    // ==================== ADMIN: DELETE USER ====================

    interface DeleteUser extends RequestGenericInterface {
      Params: {
        id: string;
      };
    }
    fastify.delete<DeleteUser>("/:id", async (req, res) => {
      const context = OTelRequestSpan(req);
      try {
        await AuthMustBeAdmin(req, res);
      } catch {
        return;
      }

      const currentUser = await AuthGetLiveUser(req);

      // Cannot delete yourself
      if (currentUser?.id === req.params.id) {
        return res.status(400).send({ error: "Cannot Delete Yourself" });
      }

      const user = await UsersDataGet(context, req.params.id);
      if (!user) {
        return res.status(404).send({ error: "User Not Found" });
      }

      // The last-admin guard and the token cleanup run in one transaction:
      // a refusal leaves both tables untouched and a success leaves no
      // orphaned credentials.
      const deleted = await DbUtilsWithLock(
        "users_admin_guard",
        () => UsersDataDeleteWithTokens(context, req.params.id),
        context,
      );
      if (!deleted) {
        if (await UsersDataGet(context, req.params.id)) {
          return res
            .status(400)
            .send({ error: "At least 1 admin must be defined" });
        }
        return res.status(404).send({ error: "User Not Found" });
      }
      return res.status(200).send({});
    });

    // ==================== API TOKENS (self-service) ====================

    interface PostApiToken extends RequestGenericInterface {
      Body: {
        name: string;
        expiresAt?: string;
      };
    }
    fastify.post<PostApiToken>("/tokens", async (req, res) => {
      const context = OTelRequestSpan(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const user = await AuthGetLiveUser(req);
      if (!user) {
        return sendUnauthenticated(res);
      }
      if (isMissing(body.name)) {
        return res.status(400).send({ error: "Missing: Name" });
      }
      if (typeof body.name !== "string") {
        return res.status(400).send({ error: "Invalid: Name" });
      }
      if (body.name.length > API_TOKEN_NAME_MAX_LENGTH) {
        return res.status(400).send({
          error: `Name Too Long (max ${API_TOKEN_NAME_MAX_LENGTH} characters)`,
        });
      }
      let expiresAt: string | null = null;
      if (body.expiresAt !== undefined && body.expiresAt !== null) {
        if (typeof body.expiresAt !== "string") {
          return res
            .status(400)
            .send({ error: "Invalid: expiresAt (ISO 8601 date expected)" });
        }
        const parsed = Date.parse(body.expiresAt);
        if (!Number.isFinite(parsed)) {
          return res
            .status(400)
            .send({ error: "Invalid: expiresAt (ISO 8601 date expected)" });
        }
        if (parsed <= Date.now()) {
          return res
            .status(400)
            .send({ error: "Invalid: expiresAt must be in the future" });
        }
        if (!(await UsersApiTokensDataSupportsOptionalColumns(context))) {
          return res.status(400).send({
            error:
              "API token expiry requires the documented users_api_tokens migration",
          });
        }
        expiresAt = new Date(parsed).toISOString();
      }
      const maxTokens = AuthGetApiTokensMaxPerUser();
      const apiToken = new UserApiToken();
      apiToken.name = body.name;
      apiToken.userId = user.id;
      apiToken.dateCreated = new Date().toISOString();
      apiToken.expiresAt = expiresAt;
      const token = randomBytes(32).toString("base64url");
      apiToken.tokenHash = createHash("sha256").update(token).digest("hex");
      const inserted = await DbUtilsWithLock(
        `users_api_token_cap:${user.id}`,
        () => UsersApiTokensDataAddIfBelowCap(context, apiToken, maxTokens),
        context,
      );
      if (!inserted) {
        return res
          .status(400)
          .send({ error: `Too many API tokens (max ${maxTokens})` });
      }
      setNoStoreHeaders(res);
      // The plaintext token is returned once; only its hash is stored.
      return res.status(201).send({
        token,
        ...apiToken.toTransportJson(),
      });
    });

    fastify.get("/tokens", async (req, res) => {
      const context = OTelRequestSpan(req);
      const user = await AuthGetLiveUser(req);
      if (!user) {
        return sendUnauthenticated(res);
      }
      const apiTokens = await UsersApiTokensDataListByUser(context, user.id);
      return res
        .status(200)
        .send(apiTokens.map((t) => t.toTransportJson()));
    });

    interface DeleteApiToken extends RequestGenericInterface {
      Params: {
        id: string;
      };
    }
    fastify.delete<DeleteApiToken>("/tokens/:id", async (req, res) => {
      const context = OTelRequestSpan(req);
      const user = await AuthGetLiveUser(req);
      if (!user) {
        return sendUnauthenticated(res);
      }
      const apiToken = await UsersApiTokensDataGet(context, req.params.id);
      if (!apiToken) {
        return res.status(404).send({ error: "API Token Not Found" });
      }
      // Owner can always revoke; admins can revoke any token
      if (apiToken.userId !== user.id && user.role !== "admin") {
        return res
          .status(403)
          .send({ error: "Access Denied", code: AUTH_ERROR_CODE_FORBIDDEN });
      }
      await UsersApiTokensDataDelete(context, apiToken.id);
      return res.status(200).send({});
    });
  }
}

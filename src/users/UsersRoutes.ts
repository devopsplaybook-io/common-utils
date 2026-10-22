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
  UserPasswordSetPassword,
} from "./UserPassword";
import {
  UsersDataAdd,
  UsersDataBumpTokenVersion,
  UsersDataCount,
  UsersDataCountAdmins,
  UsersDataDelete,
  UsersDataGet,
  UsersDataGetByName,
  UsersDataList,
  UsersDataUpdatePassword,
  UsersDataUpdateUser,
  isUniqueViolationError,
} from "./UsersData";
import {
  UsersApiTokensDataAdd,
  UsersApiTokensDataCountByUser,
  UsersApiTokensDataDelete,
  UsersApiTokensDataDeleteByUser,
  UsersApiTokensDataGet,
  UsersApiTokensDataListByUser,
  UsersApiTokensDataSupportsOptionalColumns,
} from "./UsersApiTokensData";

/** Maximum accepted API token name length. */
const API_TOKEN_NAME_MAX_LENGTH = 255;

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
        const body = req.body ?? {};
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
        if (!body.name) {
          return res.status(400).send({ error: "Missing: Name" });
        }
        if (!body.password) {
          return res.status(400).send({ error: "Missing: Password" });
        }
        user = await UsersDataGetByName(OTelRequestSpan(req), body.name);
        if (!user) {
          return res.status(401).send({
            error: "Authentication Failed",
            code: AUTH_ERROR_CODE_INVALID_CREDENTIALS,
          });
        } else if (
          await UserPasswordCheckPassword(
            OTelRequestSpan(req),
            user,
            body.password,
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
      const users = await UsersDataList(OTelRequestSpan(req), limit, offset);
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
      const body = req.body ?? {};

      const createUser = async (isFirstUser: boolean) => {
        if (!body.name) {
          return res.status(400).send({ error: "Missing: Name" });
        }
        if (!body.password) {
          return res.status(400).send({ error: "Missing: Password" });
        }
        if (await UsersDataGetByName(context, body.name)) {
          return res.status(400).send({ error: "Username Already Exists" });
        }

        const newUser = new User();
        newUser.name = body.name;
        // First user is always admin
        if (isFirstUser) {
          newUser.role = "admin";
          newUser.scopes = [...User.ALL_SCOPES];
        } else {
          newUser.role = body.role === "admin" ? "admin" : "user";
          if (body.scopes && Array.isArray(body.scopes)) {
            newUser.scopes = body.scopes.filter((s) =>
              User.ALL_SCOPES.includes(s),
            );
          }
        }
        await UserPasswordSetPassword(context, newUser, body.password);
        try {
          await UsersDataAdd(context, newUser);
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
            return createUser(true);
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
      const body = req.body ?? {};
      const user = await AuthGetLiveUser(req);
      if (!user) {
        return sendUnauthenticated(res);
      }
      if (!body.password) {
        return res.status(400).send({ error: "Missing: Password" });
      }
      if (
        !(await UserPasswordCheckPassword(context, user, body.passwordOld))
      ) {
        return res
          .status(403)
          .send({ error: "Old Password Wrong", code: AUTH_ERROR_CODE_FORBIDDEN });
      }
      await UserPasswordSetPassword(context, user, body.password);
      await UsersDataUpdatePassword(context, user);
      if (AuthJwtRevocationEnabled()) {
        await UsersDataBumpTokenVersion(context, user.id);
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
      const body = req.body ?? {};
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

      const user = await UsersDataGet(context, req.params.id);
      if (!user) {
        return res.status(404).send({ error: "User Not Found" });
      }

      let changed = false;
      if (body.role) {
        const newRole = body.role === "admin" ? "admin" : "user";
        if (newRole !== user.role) {
          // At least 1 admin must remain (mirrors the delete guard)
          if (
            user.role === "admin" &&
            newRole === "user" &&
            (await UsersDataCountAdmins(context)) <= 1
          ) {
            return res
              .status(400)
              .send({ error: "At least 1 admin must be defined" });
          }
          user.role = newRole;
          changed = true;
        }
      }
      if (body.scopes && Array.isArray(body.scopes)) {
        const newScopes = body.scopes.filter((s) =>
          User.ALL_SCOPES.includes(s),
        );
        if (JSON.stringify(newScopes) !== JSON.stringify(user.scopes)) {
          user.scopes = newScopes;
          changed = true;
        }
      }

      if (changed) {
        await UsersDataUpdateUser(context, user);
      }

      // If password change requested
      if (body.password) {
        await UserPasswordSetPassword(context, user, body.password);
        await UsersDataUpdatePassword(context, user);
        changed = true;
      }

      if (changed && AuthJwtRevocationEnabled()) {
        await UsersDataBumpTokenVersion(context, user.id);
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

      // Check that at least 1 admin remains
      if (user.role === "admin") {
        const admins = await UsersDataCountAdmins(context);
        if (admins <= 1) {
          return res
            .status(400)
            .send({ error: "At least 1 admin must be defined" });
        }
      }

      await UsersDataDelete(context, req.params.id);
      await UsersApiTokensDataDeleteByUser(context, req.params.id);
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
      const body = req.body ?? {};
      const user = await AuthGetLiveUser(req);
      if (!user) {
        return sendUnauthenticated(res);
      }
      if (!body.name || typeof body.name !== "string") {
        return res.status(400).send({ error: "Missing: Name" });
      }
      if (body.name.length > API_TOKEN_NAME_MAX_LENGTH) {
        return res.status(400).send({
          error: `Name Too Long (max ${API_TOKEN_NAME_MAX_LENGTH} characters)`,
        });
      }
      let expiresAt: string | null = null;
      if (body.expiresAt !== undefined && body.expiresAt !== null) {
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
      if (
        (await UsersApiTokensDataCountByUser(context, user.id)) >= maxTokens
      ) {
        return res
          .status(400)
          .send({ error: `Too many API tokens (max ${maxTokens})` });
      }
      const apiToken = new UserApiToken();
      apiToken.name = body.name;
      apiToken.userId = user.id;
      apiToken.dateCreated = new Date().toISOString();
      apiToken.expiresAt = expiresAt;
      const token = randomBytes(32).toString("base64url");
      apiToken.tokenHash = createHash("sha256").update(token).digest("hex");
      await UsersApiTokensDataAdd(context, apiToken);
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

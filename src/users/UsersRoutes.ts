import { Span } from "@opentelemetry/sdk-trace-base";
import { FastifyInstance, RequestGenericInterface } from "fastify";
import { AuthGenerateJWT, AuthGetUserSession, AuthMustBeAdmin } from "./Auth";
import { User } from "./User";
import {
  UserPasswordCheckPassword,
  UserPasswordSetPassword,
} from "./UserPassword";
import {
  UsersDataAdd,
  UsersDataDelete,
  UsersDataGet,
  UsersDataGetByName,
  UsersDataList,
  UsersDataUpdatePassword,
  UsersDataUpdateUser,
} from "./UsersData";

/**
 * Retrieves the OTel span attached to the request by the
 * `@devopsplaybook.io/otel-utils-fastify` hooks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requestSpan(req: any): Span | undefined {
  return req?.tracerSpanApi;
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
    fastify.get("/status/initialization", async (req, res) => {
      if ((await UsersDataList(requestSpan(req))).length === 0) {
        res.status(201).send({ initialized: false });
      } else {
        res.status(201).send({ initialized: true });
      }
    });

    // ==================== SESSION (Login) ====================

    interface PostSession extends RequestGenericInterface {
      Body: {
        name: string;
        password: string;
      };
    }
    fastify.post<PostSession>("/session", async (req, res) => {
      let user: User | null;
      // From token
      const userSession = await AuthGetUserSession(req);
      if (userSession.isAuthenticated) {
        // isAuthenticated implies userId is set
        user = await UsersDataGet(
          requestSpan(req),
          userSession.userId as string,
        );
        if (!user) {
          return res.status(403).send({ error: "Authentication Failed" });
        }
        return res.status(201).send({
          success: true,
          token: await AuthGenerateJWT(user),
          user: user.toTransportJson(),
        });
      }

      // From User/Pass
      if (!req.body.name) {
        return res.status(400).send({ error: "Missing: Name" });
      }
      if (!req.body.password) {
        return res.status(400).send({ error: "Missing: Password" });
      }
      user = await UsersDataGetByName(requestSpan(req), req.body.name);
      if (!user) {
        return res.status(403).send({ error: "Authentication Failed" });
      } else if (
        await UserPasswordCheckPassword(
          requestSpan(req),
          user,
          req.body.password,
        )
      ) {
        return res.status(201).send({
          success: true,
          token: await AuthGenerateJWT(user),
          user: user.toTransportJson(),
        });
      } else {
        return res.status(403).send({ error: "Authentication Failed" });
      }
    });

    // ==================== LIST USERS (Admin only) ====================

    fastify.get("/", async (req, res) => {
      try {
        await AuthMustBeAdmin(req, res);
      } catch {
        return;
      }
      const users = await UsersDataList(requestSpan(req));
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
      const context = requestSpan(req);
      let isInitialized = true;
      if ((await UsersDataList(context)).length === 0) {
        isInitialized = false;
      }

      // If initialized, only admin can create users
      if (isInitialized) {
        try {
          await AuthMustBeAdmin(req, res);
        } catch {
          return;
        }
      }

      if (!req.body.name) {
        return res.status(400).send({ error: "Missing: Name" });
      }
      if (!req.body.password) {
        return res.status(400).send({ error: "Missing: Password" });
      }
      if (await UsersDataGetByName(context, req.body.name)) {
        return res.status(400).send({ error: "Username Already Exists" });
      }

      const newUser = new User();
      newUser.name = req.body.name;
      // First user is always admin
      if (isInitialized) {
        newUser.role = req.body.role === "admin" ? "admin" : "user";
        if (req.body.scopes && Array.isArray(req.body.scopes)) {
          newUser.scopes = req.body.scopes.filter((s) =>
            User.ALL_SCOPES.includes(s),
          );
        }
      } else {
        newUser.role = "admin";
        newUser.scopes = [...User.ALL_SCOPES];
      }
      await UserPasswordSetPassword(context, newUser, req.body.password);
      await UsersDataAdd(context, newUser);
      res.status(201).send({ user: newUser.toTransportJson() });
    });

    // ==================== ADMIN: CHANGE OWN PASSWORD ====================

    interface PutOwnPassword extends RequestGenericInterface {
      Body: {
        password: string;
        passwordOld: string;
      };
    }
    fastify.put<PutOwnPassword>("/password", async (req, res) => {
      const context = requestSpan(req);
      const userSession = await AuthGetUserSession(req);
      if (!userSession.isAuthenticated) {
        return res.status(403).send({ error: "Access Denied" });
      }
      // isAuthenticated implies userId is set
      const user = await UsersDataGet(context, userSession.userId as string);
      if (!user) {
        return res.status(403).send({ error: "Access Denied" });
      }
      if (!req.body.password) {
        return res.status(400).send({ error: "Missing: Password" });
      }
      if (
        !(await UserPasswordCheckPassword(context, user, req.body.passwordOld))
      ) {
        return res.status(403).send({ error: "Old Password Wrong" });
      }
      await UserPasswordSetPassword(context, user, req.body.password);
      await UsersDataUpdatePassword(context, user);
      res.status(201).send({});
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
      const context = requestSpan(req);
      try {
        await AuthMustBeAdmin(req, res);
      } catch {
        return;
      }

      const user = await UsersDataGet(context, req.params.id);
      if (!user) {
        return res.status(404).send({ error: "User Not Found" });
      }

      if (req.body.role) {
        user.role = req.body.role === "admin" ? "admin" : "user";
      }
      if (req.body.scopes && Array.isArray(req.body.scopes)) {
        user.scopes = req.body.scopes.filter((s) =>
          User.ALL_SCOPES.includes(s),
        );
      }

      await UsersDataUpdateUser(context, user);

      // If password change requested
      if (req.body.password) {
        await UserPasswordSetPassword(context, user, req.body.password);
        await UsersDataUpdatePassword(context, user);
      }

      res.status(201).send({ user: user.toTransportJson() });
    });

    // ==================== ADMIN: DELETE USER ====================

    interface DeleteUser extends RequestGenericInterface {
      Params: {
        id: string;
      };
    }
    fastify.delete<DeleteUser>("/:id", async (req, res) => {
      const context = requestSpan(req);
      try {
        await AuthMustBeAdmin(req, res);
      } catch {
        return;
      }

      const userSession = await AuthGetUserSession(req);

      // Cannot delete yourself
      if (userSession.userId === req.params.id) {
        return res.status(400).send({ error: "Cannot Delete Yourself" });
      }

      const user = await UsersDataGet(context, req.params.id);
      if (!user) {
        return res.status(404).send({ error: "User Not Found" });
      }

      // Check that at least 1 admin remains
      if (user.role === "admin") {
        const admins = (await UsersDataList(context)).filter(
          (u) => u.role === "admin",
        );
        if (admins.length <= 1) {
          return res
            .status(400)
            .send({ error: "At least 1 admin must be defined" });
        }
      }

      await UsersDataDelete(context, req.params.id);
      res.status(201).send({});
    });
  }
}

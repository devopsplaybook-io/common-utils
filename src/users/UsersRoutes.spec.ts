import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { FastifyInstance } from "fastify";
import * as jwt from "jsonwebtoken";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsExecSQL, DbUtilsGetDatabase, DbUtilsInit, DbUtilsQuerySQL, DbUtilsSetOTel } from "../DbUtils";
import {
  AuthGenerateJWT,
  AuthGetUserSession,
  AuthInit,
  AuthSetOTel,
} from "./Auth";
import { AuthAuditEvent, AuthSetAuditHandler } from "./AuthAudit";
import { User } from "./User";
import { UsersDataGetByName, UsersDataSetOTel } from "./UsersData";
import { UsersApiTokensDataSetOTel } from "./UsersApiTokensData";
import { UsersRoutes } from "./UsersRoutes";

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS metadata (type TEXT, value TEXT, dateCreated TEXT);",
  "CREATE TABLE IF NOT EXISTS users (",
  '  "id" TEXT PRIMARY KEY,',
  '  "name" TEXT NOT NULL,',
  '  "passwordEncrypted" TEXT,',
  '  "role" TEXT,',
  '  "scopes" TEXT,',
  '  "tokenVersion" INTEGER DEFAULT 0',
  ");",
  'CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower ON users (LOWER("name"));',
  "CREATE TABLE IF NOT EXISTS users_api_tokens (",
  '  "id" TEXT PRIMARY KEY,',
  '  "name" TEXT NOT NULL,',
  '  "userId" TEXT NOT NULL,',
  '  "tokenHash" TEXT NOT NULL UNIQUE,',
  '  "dateCreated" TEXT NOT NULL,',
  '  "expiresAt" TEXT,',
  '  "lastUsedAt" TEXT',
  ");",
].join("\n");

const APP_SCOPES = ["traces", "metrics", "logs"];

const mockTracer = {
  startSpan: jest.fn(() => ({
    end: jest.fn(),
    addEvent: jest.fn(),
    setAttributes: jest.fn(),
    setStatus: jest.fn(),
  })),
} as unknown as StandardTracer;

const mockModuleLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockStandardLogger = {
  createModuleLogger: jest.fn(() => mockModuleLogger),
} as unknown as StandardLogger;

let baseDir: string;
let dataDir: string;
let sqlDir: string;
let app: FastifyInstance;

async function initAuth(overrides: Record<string, unknown> = {}): Promise<void> {
  await AuthInit(
    undefined as never,
    {
      JWT_KEY: "",
      JWT_VALIDITY_DURATION: 3600,
      DATABASE_TYPE: "sqlite",
      // Keep the shared suite well below the limits: dedicated rate-limit
      // tests live in UsersRoutesRateLimit.spec.ts.
      AUTH_RATE_LIMIT_LOGIN_MAX: 1000,
      AUTH_RATE_LIMIT_REFRESH_MAX: 1000,
      AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
      ...overrides,
    } as never,
    APP_SCOPES,
  );
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function bootstrapAdmin(
  name = "root",
  password = "root-pass",
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/users/",
    payload: { name, password },
  });
  expect(created.statusCode).toBe(201);
  return login(name, password);
}

async function login(name: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/users/session",
    payload: { name, password },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

async function createUserViaAdmin(
  adminToken: string,
  name: string,
  password: string,
  role?: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/users/",
    payload: { name, password, role },
    headers: auth(adminToken),
  });
  expect(res.statusCode).toBe(201);
  return (await UsersDataGetByName(undefined, name))?.id as string;
}

function closeCurrentDb(): void {
  const db = DbUtilsGetDatabase() as unknown as
    | { close: () => void }
    | undefined;
  try {
    db?.close();
  } catch {
    // already closed
  }
}

beforeEach(async () => {
  AuthSetAuditHandler(undefined);
  baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "users-routes-"));
  dataDir = path.join(baseDir, "data");
  sqlDir = path.join(baseDir, "sql");
  nodeFs.mkdirSync(sqlDir, { recursive: true });
  nodeFs.writeFileSync(path.join(sqlDir, "init-0000.sql"), SCHEMA_SQL);

  DbUtilsSetOTel(mockTracer, mockStandardLogger);
  AuthSetOTel(mockTracer);
  UsersDataSetOTel(mockTracer);
  UsersApiTokensDataSetOTel(mockTracer);

  await DbUtilsInit(
    undefined as never,
    { DATABASE_TYPE: "sqlite", DATA_DIR: dataDir } as never,
    sqlDir,
  );
  await initAuth();

  app = Fastify();
  await app.register(new UsersRoutes().getRoutes, { prefix: "/api/users" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeCurrentDb();
  nodeFs.rmSync(baseDir, { recursive: true, force: true });
});

describe("UsersRoutes: bootstrap and session", () => {
  it("bootstraps the first admin and reports the initialization status", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/api/users/status/initialization",
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ initialized: false });

    const created = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "root", password: "root-pass" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.role).toBe("admin");
    expect(created.json().user.scopes).toEqual(APP_SCOPES);
    // The transport representation never exposes the password hash
    expect(created.json().user.passwordEncrypted).toBeUndefined();

    const after = await app.inject({
      method: "GET",
      url: "/api/users/status/initialization",
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ initialized: true });
  });

  it("does not bootstrap a second admin without admin credentials", async () => {
    await bootstrapAdmin("root", "root-pass");

    const res = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "intruder", password: "intruder-pass" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHENTICATED");
  });

  it("logs in with valid credentials and rejects invalid ones", async () => {
    await bootstrapAdmin("root", "root-pass");

    const ok = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "root", password: "root-pass" },
    });
    expect(ok.statusCode).toBe(201);
    expect(typeof ok.json().token).toBe("string");
    expect(ok.json().user.name).toBe("root");
    // Credential-bearing responses must never be cached.
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers.pragma).toBe("no-cache");
    expect(ok.headers.vary).toBe("Authorization");

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "root", password: "nope" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual({
      error: "Authentication Failed",
      code: "INVALID_CREDENTIALS",
    });

    const unknownUser = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "nobody", password: "nope" },
    });
    expect(unknownUser.statusCode).toBe(401);
    expect(unknownUser.json().code).toBe("INVALID_CREDENTIALS");

    const missing = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
  });

  it("renews an authenticated session without requesting credentials", async () => {
    const token = await bootstrapAdmin("root", "root-pass");

    const renewed = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
      headers: auth(token),
    });

    expect(renewed.statusCode).toBe(201);
    expect(renewed.json().success).toBe(true);
    expect(renewed.json().user.name).toBe("root");
    expect(renewed.headers["cache-control"]).toBe("no-store");
    expect(
      await AuthGetUserSession({ headers: auth(renewed.json().token) }),
    ).toMatchObject({ isAuthenticated: true, userName: "root" });
  });

  it("rejects session renewal without valid authentication", async () => {
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().code).toBe("UNAUTHENTICATED");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
      headers: auth("invalid-token"),
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().code).toBe("UNAUTHENTICATED");
  });
});

describe("UsersRoutes: malformed bodies answer 400 (not 500)", () => {
  it("answers 400 on a bodyless PUT /password", async () => {
    const token = await bootstrapAdmin();

    const res = await app.inject({
      method: "PUT",
      url: "/api/users/password",
      headers: auth(token),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Missing: Password");
  });

  it("answers 400 on a bodyless PUT /:id", async () => {
    const token = await bootstrapAdmin();
    const rootId = (await UsersDataGetByName(undefined, "root"))?.id as string;

    const res = await app.inject({
      method: "PUT",
      url: `/api/users/${rootId}`,
      headers: auth(token),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Missing: Body");
  });

  it("answers 400 when the new password is missing", async () => {
    const token = await bootstrapAdmin();

    const res = await app.inject({
      method: "PUT",
      url: "/api/users/password",
      payload: { passwordOld: "root-pass" },
      headers: auth(token),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Missing: Password");
  });
});

describe("UsersRoutes: user name boundary validation", () => {
  it("trims surrounding whitespace on creation and stores the trimmed name", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "  alice  ", password: "alice-pass" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().user.name).toBe("alice");
    expect(await UsersDataGetByName(undefined, "alice")).toBeDefined();
    expect(await UsersDataGetByName(undefined, "  alice  ")).toBeNull();

    // The same normalization applies on login.
    const loggedIn = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: " alice ", password: "alice-pass" },
    });
    expect(loggedIn.statusCode).toBe(201);
    expect(loggedIn.json().user.name).toBe("alice");
  });

  it.each([[""], ["   "]])(
    "rejects the empty or whitespace-only name %p",
    async (name) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/users/",
        payload: { name, password: "alice-pass" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Missing: Name");
    },
  );

  it("accepts a 64-character name", async () => {
    const max = "a".repeat(64);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: max, password: "alice-pass" },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().user.name).toBe(max);
  });

  it("rejects a 65-character name", async () => {
    const adminToken = await bootstrapAdmin();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "a".repeat(65), password: "alice-pass" },
      headers: auth(adminToken),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("Name Too Long");
  });

  it.each([["bad name"], ["a/b"], ["<script>"], ["-lead"], ["trail-"]])(
    "rejects the name %p outside the accepted charset",
    async (name) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/users/",
        payload: { name, password: "alice-pass" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Invalid: Name");
    },
  );

  it("applies the same validation on login", async () => {
    await bootstrapAdmin("root", "root-pass");

    const res = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "bad name", password: "root-pass" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid: Name");
  });
});

describe("UsersRoutes: last-admin guard", () => {
  it("prevents the last admin from demoting themselves", async () => {
    const adminToken = await bootstrapAdmin("root", "root-pass");
    const rootId = (await UsersDataGetByName(undefined, "root"))?.id as string;

    const demote = await app.inject({
      method: "PUT",
      url: `/api/users/${rootId}`,
      payload: { role: "user" },
      headers: auth(adminToken),
    });

    expect(demote.statusCode).toBe(400);
    expect(demote.json().error).toBe("At least 1 admin must be defined");

    // Still admin
    const session = await AuthGetUserSession({
      headers: auth(adminToken),
    });
    expect(session.role).toBe("admin");
  });

  it("allows the demotion when another admin exists", async () => {
    const adminToken = await bootstrapAdmin("root", "root-pass");
    await createUserViaAdmin(adminToken, "admin2", "admin2-pass", "admin");
    const rootId = (await UsersDataGetByName(undefined, "root"))?.id as string;

    const demote = await app.inject({
      method: "PUT",
      url: `/api/users/${rootId}`,
      payload: { role: "user" },
      headers: auth(adminToken),
    });

    expect(demote.statusCode).toBe(201);
    expect(demote.json().user.role).toBe("user");
  });

  it("refuses to delete the last admin and self-deletion", async () => {
    const adminToken = await bootstrapAdmin("root", "root-pass");
    const rootId = (await UsersDataGetByName(undefined, "root"))?.id as string;

    const selfDelete = await app.inject({
      method: "DELETE",
      url: `/api/users/${rootId}`,
      headers: auth(adminToken),
    });
    expect(selfDelete.statusCode).toBe(400);
    expect(selfDelete.json().error).toBe("Cannot Delete Yourself");

    const admin2Id = await createUserViaAdmin(
      adminToken,
      "admin2",
      "admin2-pass",
      "admin",
    );
    const otherAdminDelete = await app.inject({
      method: "DELETE",
      url: `/api/users/${admin2Id}`,
      headers: auth(adminToken),
    });
    expect(otherAdminDelete.statusCode).toBe(200);
  });
});

describe("UsersRoutes: user listing", () => {
  it("lists users with pagination and validates the parameters", async () => {
    const adminToken = await bootstrapAdmin("root", "root-pass");
    await createUserViaAdmin(adminToken, "bob", "bob-pass");
    await createUserViaAdmin(adminToken, "carol", "carol-pass");
    const bobToken = await login("bob", "bob-pass");

    const all = await app.inject({
      method: "GET",
      url: "/api/users/",
      headers: auth(adminToken),
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().length).toBe(3);
    expect(all.json()[0].passwordEncrypted).toBeUndefined();

    const limited = await app.inject({
      method: "GET",
      url: "/api/users/?limit=2",
      headers: auth(adminToken),
    });
    expect(limited.json().length).toBe(2);

    const offset = await app.inject({
      method: "GET",
      url: "/api/users/?limit=2&offset=2",
      headers: auth(adminToken),
    });
    expect(offset.json().length).toBe(1);

    const invalidLimit = await app.inject({
      method: "GET",
      url: "/api/users/?limit=abc",
      headers: auth(adminToken),
    });
    expect(invalidLimit.statusCode).toBe(400);

    const negativeOffset = await app.inject({
      method: "GET",
      url: "/api/users/?offset=-1",
      headers: auth(adminToken),
    });
    expect(negativeOffset.statusCode).toBe(400);

    // Non-admin users cannot list
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/users/",
      headers: auth(bobToken),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("FORBIDDEN");
  });
});

describe("UsersRoutes: API tokens", () => {
  it("creates, lists and revokes an API token (owner flow)", async () => {
    const jwtToken = await bootstrapAdmin();

    const created = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "ci" },
      headers: auth(jwtToken),
    });
    expect(created.statusCode).toBe(201);
    const apiToken = created.json().token as string;
    expect(apiToken.length).toBeGreaterThanOrEqual(40);
    expect(created.json().tokenHash).toBeUndefined();
    expect(created.json().expiresAt).toBeNull();
    // The plaintext token is a credential: the response must not be cached.
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.headers.pragma).toBe("no-cache");
    expect(created.headers.vary).toBe("Authorization");

    // The plaintext token authenticates as its owner
    const listed = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(apiToken),
    });
    expect(listed.statusCode).toBe(200);
    const list = listed.json();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("ci");
    expect(list[0].tokenHash).toBeUndefined();

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/users/tokens/${list[0].id}`,
      headers: auth(jwtToken),
    });
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(jwtToken),
    });
    expect(afterRevoke.json()).toEqual([]);

    // The revoked token no longer authenticates
    const rejected = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(apiToken),
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().code).toBe("UNAUTHENTICATED");
  });

  it("enforces the owner/admin revoke matrix", async () => {
    const adminToken = await bootstrapAdmin("root", "root-pass");
    await createUserViaAdmin(adminToken, "bob", "bob-pass");
    await createUserViaAdmin(adminToken, "carol", "carol-pass");
    const bobToken = await login("bob", "bob-pass");
    const carolToken = await login("carol", "carol-pass");

    const created = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "bob-ci" },
      headers: auth(bobToken),
    });
    expect(created.statusCode).toBe(201);
    const tokenId = created.json().id as string;

    // Another regular user cannot revoke it
    const forbidden = await app.inject({
      method: "DELETE",
      url: `/api/users/tokens/${tokenId}`,
      headers: auth(carolToken),
    });
    expect(forbidden.statusCode).toBe(403);

    // An admin can revoke any token
    const adminRevoke = await app.inject({
      method: "DELETE",
      url: `/api/users/tokens/${tokenId}`,
      headers: auth(adminToken),
    });
    expect(adminRevoke.statusCode).toBe(200);

    // Unauthenticated access is rejected
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().code).toBe("UNAUTHENTICATED");
  });

  it("rejects an expired stored token", async () => {
    const jwtToken = await bootstrapAdmin();

    const created = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "expiring" },
      headers: auth(jwtToken),
    });
    const apiToken = created.json().token as string;

    // Force the stored expiry into the past
    DbUtilsExecSQL(
      undefined,
      'UPDATE users_api_tokens SET "expiresAt" = ? WHERE "id" = ?',
      ["2020-01-01T00:00:00.000Z", created.json().id],
    );

    const rejected = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(apiToken),
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().code).toBe("UNAUTHENTICATED");
  });

  it("validates the token name and expiry", async () => {
    const jwtToken = await bootstrapAdmin();

    const missingName = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: {},
      headers: auth(jwtToken),
    });
    expect(missingName.statusCode).toBe(400);

    const longName = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "x".repeat(256) },
      headers: auth(jwtToken),
    });
    expect(longName.statusCode).toBe(400);
    expect(longName.json().error).toContain("Name Too Long");

    const maxName = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "y".repeat(255) },
      headers: auth(jwtToken),
    });
    expect(maxName.statusCode).toBe(201);

    const invalidDate = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "bad-date", expiresAt: "not-a-date" },
      headers: auth(jwtToken),
    });
    expect(invalidDate.statusCode).toBe(400);

    const pastDate = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "past", expiresAt: "2020-01-01T00:00:00.000Z" },
      headers: auth(jwtToken),
    });
    expect(pastDate.statusCode).toBe(400);
    expect(pastDate.json().error).toContain("must be in the future");

    const futureDate = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "future", expiresAt: "2999-01-01T00:00:00.000Z" },
      headers: auth(jwtToken),
    });
    expect(futureDate.statusCode).toBe(201);
    expect(futureDate.json().expiresAt).toBe("2999-01-01T00:00:00.000Z");
  });

  it("enforces the per-user token cap", async () => {
    const jwtToken = await bootstrapAdmin();
    await initAuth({ API_TOKENS_MAX_PER_USER: 1 });

    const first = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "first" },
      headers: auth(jwtToken),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "second" },
      headers: auth(jwtToken),
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toContain("Too many API tokens");
  });
});

describe("UsersRoutes: JWT revocation", () => {
  it("invalidates previously issued JWTs after a password change", async () => {
    await initAuth({ JWT_REVOCATION_ENABLED: true });
    const jwtToken = await bootstrapAdmin("root", "root-pass");

    const before = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(jwtToken),
    });
    expect(before.statusCode).toBe(200);

    const changed = await app.inject({
      method: "PUT",
      url: "/api/users/password",
      payload: { password: "new-pass", passwordOld: "root-pass" },
      headers: auth(jwtToken),
    });
    expect(changed.statusCode).toBe(201);

    const after = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(jwtToken),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe("UNAUTHENTICATED");

    // Repeated requests stay rejected (rejection is not cached across
    // requests) and every other guard rejects the stale credential too.
    const again = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(jwtToken),
    });
    expect(again.statusCode).toBe(401);

    const guard = await app.inject({
      method: "GET",
      url: "/api/users/",
      headers: auth(jwtToken),
    });
    expect(guard.statusCode).toBe(401);
    expect(guard.json().code).toBe("UNAUTHENTICATED");

    const refresh = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
      headers: auth(jwtToken),
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().code).toBe("UNAUTHENTICATED");

    // The new password still works
    const relogin = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "root", password: "new-pass" },
    });
    expect(relogin.statusCode).toBe(201);
  });

  it("rejects a demoted admin's previously issued JWT on every request", async () => {
    await initAuth({ JWT_REVOCATION_ENABLED: true });
    const rootToken = await bootstrapAdmin("root", "root-pass");
    await createUserViaAdmin(rootToken, "admin2", "admin2-pass", "admin");
    const admin2Token = await login("admin2", "admin2-pass");
    const rootId = (await UsersDataGetByName(undefined, "root"))?.id as string;

    const demote = await app.inject({
      method: "PUT",
      url: `/api/users/${rootId}`,
      payload: { role: "user" },
      headers: auth(admin2Token),
    });
    expect(demote.statusCode).toBe(201);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const denied = await app.inject({
        method: "GET",
        url: "/api/users/",
        headers: auth(rootToken),
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().code).toBe("UNAUTHENTICATED");
    }
  });

  it("keeps JWTs valid when revocation is disabled", async () => {
    const jwtToken = await bootstrapAdmin("root", "root-pass");

    const changed = await app.inject({
      method: "PUT",
      url: "/api/users/password",
      payload: { password: "new-pass", passwordOld: "root-pass" },
      headers: auth(jwtToken),
    });
    expect(changed.statusCode).toBe(201);

    const stillValid = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(jwtToken),
    });
    expect(stillValid.statusCode).toBe(200);
  });
});

describe("UsersRoutes: session lifetime and JWT claims", () => {
  function claimsOf(token: string): any {
    return (jwt.decode(token) as any) ?? {};
  }

  it("renews a valid session preserving sessionStartedAt with new iat/exp/jti", async () => {
    const token = await bootstrapAdmin("root", "root-pass");
    const before = claimsOf(token);

    const renewed = await app.inject({
      method: "POST",
      url: "/api/users/session",
      headers: auth(token),
    });
    expect(renewed.statusCode).toBe(201);
    const after = claimsOf(renewed.json().token as string);

    expect(after.sessionStartedAt).toBe(before.sessionStartedAt);
    expect(after.iat).toBeGreaterThanOrEqual(before.iat);
    expect(after.exp - after.iat).toBe(3600);
    expect(after.jti).not.toBe(before.jti);
    expect(before.iss).toBe("devopsplaybook.io");
    expect(before.aud).toBe("devopsplaybook.io");
    expect(typeof before.jti).toBe("string");
  });

  it("issues a distinct jti per token for the same user", async () => {
    const first = claimsOf(await bootstrapAdmin("root", "root-pass"));
    const second = claimsOf(await login("root", "root-pass"));
    expect(typeof first.jti).toBe("string");
    expect(typeof second.jti).toBe("string");
    expect(first.jti).not.toBe(second.jti);
  });

  it("caps the token expiry at the absolute session lifetime", async () => {
    await initAuth({ JWT_SESSION_MAX_DURATION: 60 });
    await bootstrapAdmin("root", "root-pass");
    const user = (await UsersDataGetByName(undefined, "root")) as User;

    const now = Math.floor(Date.now() / 1000);
    const sessionStartedAt = now - 120;
    const capped = await AuthGenerateJWT(user, { sessionStartedAt });
    const claims = claimsOf(capped);
    expect(claims.exp).toBe(sessionStartedAt + 60);

    const rejected = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(capped),
    });
    expect(rejected.statusCode).toBe(401);
  });

  it("rejects renewal of a session past the absolute lifetime", async () => {
    await bootstrapAdmin("root", "root-pass");
    const user = (await UsersDataGetByName(undefined, "root")) as User;
    const key = "test-key";
    await initAuth({ JWT_KEY: key, JWT_SESSION_MAX_DURATION: 60 });

    const now = Math.floor(Date.now() / 1000);
    const expiredSession = jwt.sign(
      {
        exp: now + 3600,
        iat: now - 120,
        sessionStartedAt: now - 120,
        userId: user.id,
        userName: user.name,
        role: user.role,
        scopes: user.scopes,
        tokenVersion: user.tokenVersion ?? 0,
      },
      key,
      {
        algorithm: "HS256",
        issuer: "devopsplaybook.io",
        audience: "devopsplaybook.io",
      },
    );

    const refresh = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
      headers: auth(expiredSession),
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().code).toBe("UNAUTHENTICATED");

    const existing = await app.inject({
      method: "POST",
      url: "/api/users/session",
      headers: auth(expiredSession),
    });
    expect(existing.statusCode).toBe(401);
    expect(existing.json().code).toBe("UNAUTHENTICATED");
  });

  it("allows renewal of a long-lived session when the absolute cap is disabled", async () => {
    await bootstrapAdmin("root", "root-pass");
    const user = (await UsersDataGetByName(undefined, "root")) as User;
    const key = "test-key";
    await initAuth({ JWT_KEY: key, JWT_SESSION_MAX_DURATION: 0 });

    const now = Math.floor(Date.now() / 1000);
    const longSession = jwt.sign(
      {
        exp: now + 3600,
        iat: now - 120,
        sessionStartedAt: now - 120,
        userId: user.id,
        userName: user.name,
        role: user.role,
        scopes: user.scopes,
        tokenVersion: user.tokenVersion ?? 0,
      },
      key,
      {
        algorithm: "HS256",
        issuer: "devopsplaybook.io",
        audience: "devopsplaybook.io",
      },
    );

    const refresh = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
      headers: auth(longSession),
    });
    expect(refresh.statusCode).toBe(201);
    expect(claimsOf(refresh.json().token as string).sessionStartedAt).toBe(
      now - 120,
    );
  });

  it("refuses to exchange an API token for a JWT", async () => {
    const jwtToken = await bootstrapAdmin("root", "root-pass");
    const created = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "exchange" },
      headers: auth(jwtToken),
    });
    expect(created.statusCode).toBe(201);
    const apiToken = created.json().token as string;

    const session = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "root", password: "root-pass" },
      headers: auth(apiToken),
    });
    expect(session.statusCode).toBe(403);
    expect(session.json().code).toBe("FORBIDDEN");
    expect(session.json().error).toBe("Session Token Required");

    const refresh = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
      headers: auth(apiToken),
    });
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json().code).toBe("FORBIDDEN");

    // The API token keeps authenticating the regular endpoints directly.
    const listed = await app.inject({
      method: "GET",
      url: "/api/users/tokens",
      headers: auth(apiToken),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.headers.pragma).toBe("no-cache");
    expect(listed.headers.vary).toBe("Authorization");
  });
});

describe("UsersRoutes: typed body validation", () => {
  it("answers 400 on non-string credentials", async () => {
    await bootstrapAdmin("root", "root-pass");

    const numericPassword = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "root", password: 123 },
    });
    expect(numericPassword.statusCode).toBe(400);
    expect(numericPassword.json().error).toBe("Invalid: Password");

    const objectName = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: { evil: true }, password: "root-pass" },
    });
    expect(objectName.statusCode).toBe(400);
    expect(objectName.json().error).toBe("Invalid: Name");
  });

  it("answers 400 on a missing or non-string old password", async () => {
    const token = await bootstrapAdmin("root", "root-pass");

    const missingOld = await app.inject({
      method: "PUT",
      url: "/api/users/password",
      payload: { password: "new-secret" },
      headers: auth(token),
    });
    expect(missingOld.statusCode).toBe(400);
    expect(missingOld.json().error).toBe("Missing: PasswordOld");

    const invalidOld = await app.inject({
      method: "PUT",
      url: "/api/users/password",
      payload: { password: "new-secret", passwordOld: 42 },
      headers: auth(token),
    });
    expect(invalidOld.statusCode).toBe(400);
    expect(invalidOld.json().error).toBe("Invalid: PasswordOld");
  });

  it("answers 400 on invalid create/update field types", async () => {
    const token = await bootstrapAdmin("root", "root-pass");
    const rootId = (await UsersDataGetByName(undefined, "root"))?.id as string;

    const numericPassword = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "someone", password: 123 },
      headers: auth(token),
    });
    expect(numericPassword.statusCode).toBe(400);
    expect(numericPassword.json().error).toBe("Invalid: Password");

    const objectName = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: { evil: true }, password: "valid-pass" },
      headers: auth(token),
    });
    expect(objectName.statusCode).toBe(400);
    expect(objectName.json().error).toBe("Invalid: Name");

    const invalidScopes = await app.inject({
      method: "PUT",
      url: `/api/users/${rootId}`,
      payload: { scopes: "traces" },
      headers: auth(token),
    });
    expect(invalidScopes.statusCode).toBe(400);
    expect(invalidScopes.json().error).toBe("Invalid: scopes");

    const invalidRole = await app.inject({
      method: "PUT",
      url: `/api/users/${rootId}`,
      payload: { role: { evil: true } },
      headers: auth(token),
    });
    expect(invalidRole.statusCode).toBe(400);
    expect(invalidRole.json().error).toBe("Invalid: role");
  });

  it("rejects an over-long password instead of truncating it", async () => {
    const token = await bootstrapAdmin("root", "root-pass");

    const res = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "long-pass", password: "a".repeat(73) },
      headers: auth(token),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Password Too Long");
  });
});

describe("UsersRoutes: pagination contract", () => {
  it("orders the list by name and rejects offset without limit", async () => {
    const token = await bootstrapAdmin("root", "root-pass");
    await createUserViaAdmin(token, "bob", "bob-pass");
    await createUserViaAdmin(token, "alice", "alice-pass");

    const list = await app.inject({
      method: "GET",
      url: "/api/users/",
      headers: auth(token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((u: { name: string }) => u.name)).toEqual([
      "alice",
      "bob",
      "root",
    ]);

    const offsetOnly = await app.inject({
      method: "GET",
      url: "/api/users/?offset=1",
      headers: auth(token),
    });
    expect(offsetOnly.statusCode).toBe(400);
    expect(offsetOnly.json().error).toContain("limit");

    const tooLarge = await app.inject({
      method: "GET",
      url: "/api/users/?limit=1001",
      headers: auth(token),
    });
    expect(tooLarge.statusCode).toBe(400);
  });
});

describe("UsersRoutes: bootstrap and deletion races", () => {
  it("creates only one admin when two first-user requests race", async () => {
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/users/",
        payload: { name: "first", password: "first-pass" },
      }),
      app.inject({
        method: "POST",
        url: "/api/users/",
        payload: { name: "second", password: "second-pass" },
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 401]);
  });

  it("deletes the user's API tokens together with the user", async () => {
    const adminToken = await bootstrapAdmin("root", "root-pass");
    const userId = await createUserViaAdmin(
      adminToken,
      "doomed",
      "doomed-pass",
    );
    const userToken = await login("doomed", "doomed-pass");

    const created = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "ci-token" },
      headers: auth(userToken),
    });
    expect(created.statusCode).toBe(201);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/users/${userId}`,
      headers: auth(adminToken),
    });
    expect(deleted.statusCode).toBe(200);

    const rows = await DbUtilsQuerySQL(
      undefined,
      'SELECT COUNT(*) as count FROM users_api_tokens WHERE "userId" = ?',
      [userId],
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});

describe("UsersRoutes: audit events", () => {
  it("emits login success and failure without credentials", async () => {
    const events: AuthAuditEvent[] = [];
    AuthSetAuditHandler((event) => events.push(event));

    const adminToken = await bootstrapAdmin("audit-admin", "audit-pass");
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "user_create",
        outcome: "success",
        reason: "bootstrap",
        targetUserName: "audit-admin",
      }),
    );
    events.length = 0;

    await login("audit-admin", "audit-pass");
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "login_success",
        outcome: "success",
        actorName: "audit-admin",
      }),
    );

    const failed = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "audit-admin", password: "wrong-pass" },
    });
    expect(failed.statusCode).toBe(401);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "login_failure",
        outcome: "failure",
        reason: "invalid_credentials",
        targetUserName: "audit-admin",
      }),
    );

    const unknown = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "no-such-user", password: "whatever" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "login_failure",
        targetUserName: "no-such-user",
      }),
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("audit-pass");
    expect(serialized).not.toContain("wrong-pass");
    expect(serialized).not.toContain(adminToken);
  });

  it("emits user, password and token events without secrets", async () => {
    const events: AuthAuditEvent[] = [];
    AuthSetAuditHandler((event) => events.push(event));

    const adminToken = await bootstrapAdmin("audit-admin", "audit-pass");
    const userId = await createUserViaAdmin(
      adminToken,
      "audit-user",
      "user-pass",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "user_create",
        actorName: "audit-admin",
        targetUserId: userId,
        targetUserName: "audit-user",
      }),
    );

    const userToken = await login("audit-user", "user-pass");

    const changed = await app.inject({
      method: "PUT",
      url: "/api/users/password",
      payload: { password: "new-user-pass", passwordOld: "user-pass" },
      headers: auth(userToken),
    });
    expect(changed.statusCode).toBe(201);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "password_change",
        reason: "self",
        actorId: userId,
        targetUserId: userId,
      }),
    );

    const updated = await app.inject({
      method: "PUT",
      url: `/api/users/${userId}`,
      payload: { role: "admin" },
      headers: auth(adminToken),
    });
    expect(updated.statusCode).toBe(201);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "user_update",
        actorName: "audit-admin",
        targetUserId: userId,
        fields: ["role"],
      }),
    );

    const createdToken = await app.inject({
      method: "POST",
      url: "/api/users/tokens",
      payload: { name: "audit-token" },
      headers: auth(userToken),
    });
    expect(createdToken.statusCode).toBe(201);
    const tokenId = createdToken.json().id as string;
    const plaintextToken = createdToken.json().token as string;
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "api_token_create",
        actorId: userId,
        tokenId,
      }),
    );

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/users/tokens/${tokenId}`,
      headers: auth(userToken),
    });
    expect(revoked.statusCode).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "api_token_revoke",
        actorId: userId,
        targetUserId: userId,
        tokenId,
      }),
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/users/${userId}`,
      headers: auth(adminToken),
    });
    expect(deleted.statusCode).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "user_delete",
        actorName: "audit-admin",
        targetUserId: userId,
        targetUserName: "audit-user",
      }),
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("user-pass");
    expect(serialized).not.toContain("new-user-pass");
    expect(serialized).not.toContain(plaintextToken);
    expect(serialized).not.toContain(adminToken);
  });
});

// Unique ids per entity so multiple users can coexist in one test DB.
jest.mock("uuid", () => {
  let counter = 0;
  return { v4: () => `mock-uuid-${++counter}` };
});

import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { FastifyInstance } from "fastify";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsExecSQL, DbUtilsGetDatabase, DbUtilsInit, DbUtilsSetOTel } from "../DbUtils";
import { AuthGetUserSession, AuthInit, AuthSetOTel } from "./Auth";
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

    expect(res.statusCode).toBe(403);
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

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "root", password: "nope" },
    });
    expect(wrongPassword.statusCode).toBe(403);

    const unknownUser = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "nobody", password: "nope" },
    });
    expect(unknownUser.statusCode).toBe(403);

    const missing = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
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
    expect(rejected.statusCode).toBe(403);
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
    expect(unauthenticated.statusCode).toBe(403);
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
    expect(rejected.statusCode).toBe(403);
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
    expect(after.statusCode).toBe(403);

    // The new password still works
    const relogin = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "root", password: "new-pass" },
    });
    expect(relogin.statusCode).toBe(201);
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

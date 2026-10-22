// Dedicated suite: the shared UsersRoutes.spec.ts runs with high limits so
// that its login-heavy flows are not throttled. This suite uses its own
// Fastify instance, database and low limits.
jest.mock("uuid", () => {
  let counter = 0;
  return { v4: () => `rate-limit-uuid-${++counter}` };
});

import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { FastifyInstance } from "fastify";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsGetDatabase, DbUtilsInit, DbUtilsSetOTel } from "../DbUtils";
import { AuthInit, AuthSetOTel } from "./Auth";
import { UsersDataSetOTel } from "./UsersData";
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
let app: FastifyInstance;

async function initAuth(overrides: Record<string, unknown> = {}): Promise<void> {
  await AuthInit(
    undefined as never,
    {
      JWT_KEY: "",
      JWT_VALIDITY_DURATION: 3600,
      DATABASE_TYPE: "sqlite",
      AUTH_RATE_LIMIT_LOGIN_MAX: 2,
      AUTH_RATE_LIMIT_REFRESH_MAX: 2,
      AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
      ...overrides,
    } as never,
    APP_SCOPES,
  );
}

async function createApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(new UsersRoutes().getRoutes, {
    prefix: "/api/users",
  });
  await instance.ready();
  return instance;
}

async function bootstrapAdmin(): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/users/",
    payload: { name: "root", password: "root-pass" },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: "POST",
    url: "/api/users/session",
    payload: { name: "root", password: "root-pass" },
  });
  expect(login.statusCode).toBe(201);
  return login.json().token as string;
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
  baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "users-rate-limit-"));
  dataDir = path.join(baseDir, "data");
  const sqlDir = path.join(baseDir, "sql");
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
  app = await createApp();
});

afterEach(async () => {
  await app.close();
  closeCurrentDb();
  nodeFs.rmSync(baseDir, { recursive: true, force: true });
});

describe("UsersRoutes rate limiting", () => {
  it("limits login attempts per IP + username and answers 429 with Retry-After", async () => {
    await bootstrapAdmin();

    // Two failed attempts for bob are allowed...
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/users/session",
        payload: { name: "bob", password: "wrong" },
      });
      expect(failed.statusCode).toBe(401);
      expect(failed.json().code).toBe("INVALID_CREDENTIALS");
    }

    // ...the third is throttled.
    const throttled = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "bob", password: "wrong" },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("RATE_LIMITED");
    expect(throttled.json().error).toBe("Too Many Requests");
    expect(throttled.headers["retry-after"]).toBeDefined();

    // The limit is keyed by username: another name from the same IP still
    // reaches credential validation instead of being throttled.
    const otherUser = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "carol", password: "whatever" },
    });
    expect(otherUser.statusCode).toBe(401);
    expect(otherUser.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("limits session refreshes per IP", async () => {
    const token = await bootstrapAdmin();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const renewed = await app.inject({
        method: "POST",
        url: "/api/users/session/refresh",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(renewed.statusCode).toBe(201);
    }

    const throttled = await app.inject({
      method: "POST",
      url: "/api/users/session/refresh",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("RATE_LIMITED");
    expect(throttled.headers["retry-after"]).toBeDefined();
  });

  it("disables the limiter when the configured max is 0", async () => {
    await app.close();
    await initAuth({ AUTH_RATE_LIMIT_LOGIN_MAX: 0 });
    app = await createApp();
    await bootstrapAdmin();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/users/session",
        payload: { name: "dave", password: "wrong" },
      });
      expect(failed.statusCode).toBe(401);
    }
  });
});

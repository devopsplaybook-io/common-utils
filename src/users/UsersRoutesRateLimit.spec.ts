// Dedicated suite: the shared UsersRoutes.spec.ts runs with high limits so
// that its login-heavy flows are not throttled. This suite uses its own
// Fastify instance, database and low limits.
import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit, { FastifyRateLimitStoreCtor } from "@fastify/rate-limit";
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

async function createApp(options: {
  rateLimitStore?: FastifyRateLimitStoreCtor;
} = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(new UsersRoutes().getRoutes, {
    prefix: "/api/users",
    ...options,
  });
  await instance.ready();
  return instance;
}

/**
 * Store double that never counts against the limit: injecting it proves the
 * route registration honours `rateLimitStore` instead of the local store.
 */
const NoopStore = class {
  public incr(
    _key: string,
    callback: (
      error: Error | null,
      result?: { current: number; ttl: number },
    ) => void,
  ): void {
    callback(null, { current: 0, ttl: 60000 });
  }
  public child(): unknown {
    return this;
  }
} as unknown as FastifyRateLimitStoreCtor;

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

  it("limits the initialization status endpoint per IP", async () => {
    await app.close();
    await initAuth({ AUTH_RATE_LIMIT_STATUS_MAX: 2 });
    app = await createApp();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const allowed = await app.inject({
        method: "GET",
        url: "/api/users/status/initialization",
      });
      expect(allowed.statusCode).toBe(200);
    }

    const throttled = await app.inject({
      method: "GET",
      url: "/api/users/status/initialization",
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("RATE_LIMITED");
    expect(throttled.headers["retry-after"]).toBeDefined();
  });

  it("uses an injected shared rate-limit store", async () => {
    await app.close();
    await initAuth({ AUTH_RATE_LIMIT_LOGIN_MAX: 1 });
    app = await createApp({ rateLimitStore: NoopStore });
    await bootstrapAdmin();

    // The local store would throttle the second attempt (max = 1); the
    // injected store never counts, proving it replaced the default one.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/users/session",
        payload: { name: "bob", password: "wrong" },
      });
      expect(failed.statusCode).toBe(401);
    }
  });

  it("applies the optional per-IP login limit", async () => {
    await app.close();
    await initAuth({
      AUTH_RATE_LIMIT_LOGIN_MAX: 100,
      AUTH_RATE_LIMIT_LOGIN_IP_MAX: 2,
    });
    app = await createApp();
    // Bootstrap through the create route (not /session) so the per-IP login
    // counter starts at zero.
    const created = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "root", password: "root-pass" },
    });
    expect(created.statusCode).toBe(201);

    for (const name of ["alice", "bob"]) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/users/session",
        payload: { name, password: "wrong" },
      });
      expect(failed.statusCode).toBe(401);
    }

    const throttled = await app.inject({
      method: "POST",
      url: "/api/users/session",
      payload: { name: "carol", password: "wrong" },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("RATE_LIMITED");
  });

  it("leaves the per-IP login limit disabled by default", async () => {
    await app.close();
    await initAuth({ AUTH_RATE_LIMIT_LOGIN_MAX: 100 });
    app = await createApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/users/",
      payload: { name: "root", password: "root-pass" },
    });
    expect(created.statusCode).toBe(201);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/users/session",
        payload: { name: `unknown-${attempt}`, password: "wrong" },
      });
      expect(failed.statusCode).toBe(401);
    }
  });

  it("refuses an injected store when the host registered the plugin", async () => {
    const instance = Fastify();
    instance.register(rateLimit, { global: false });
    instance.register(new UsersRoutes().getRoutes, {
      prefix: "/api/users",
      rateLimitStore: NoopStore,
    });
    await expect(instance.ready()).rejects.toThrow(
      "rateLimitStore cannot be set",
    );
  });
});

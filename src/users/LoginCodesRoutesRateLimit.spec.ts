import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { FastifyInstance } from "fastify";
import rateLimit, { FastifyRateLimitStoreCtor } from "@fastify/rate-limit";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsGetDatabase, DbUtilsInit, DbUtilsSetOTel } from "../DbUtils";
import { LoginCodesRoutes, LoginCodesRoutesOptions } from "./LoginCodesRoutes";
import {
  LOGIN_CODES_DDL_SQLITE,
  createLoginCodesStoreCommonUtils,
} from "./LoginCodesStoreCommonUtils";

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

const PREFIX = "/login-codes";
const APPROVER = { id: "user-1", name: "Ada Lovelace" };

let baseDir: string;
let app: FastifyInstance | undefined;

/**
 * Store double that never counts against the limit: injecting it proves the
 * plugin registration honours `rateLimitStore` instead of a local store.
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

async function initDb(): Promise<void> {
  baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "login-codes-limits-"));
  const dataDir = path.join(baseDir, "data");
  const sqlDir = path.join(baseDir, "sql");
  nodeFs.mkdirSync(sqlDir, { recursive: true });
  nodeFs.writeFileSync(
    path.join(sqlDir, "init-0000.sql"),
    [
      "CREATE TABLE IF NOT EXISTS metadata (type TEXT, value TEXT, dateCreated TEXT);",
      LOGIN_CODES_DDL_SQLITE,
    ].join("\n"),
  );
  DbUtilsSetOTel(mockTracer, mockStandardLogger);
  await DbUtilsInit(
    undefined as never,
    { DATABASE_TYPE: "sqlite", DATA_DIR: dataDir } as never,
    sqlDir,
  );
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
  nodeFs.rmSync(baseDir, { recursive: true, force: true });
}

async function createApp(
  overrides: Partial<LoginCodesRoutesOptions> = {},
): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.register(LoginCodesRoutes, {
    prefix: PREFIX,
    store: createLoginCodesStoreCommonUtils(),
    enabled: true,
    ttlSeconds: 300,
    rotationSeconds: 30,
    graceSeconds: 60,
    pollIntervalMs: 2000,
    maxAttempts: 100,
    maxPending: 1000,
    rateLimitCreateMax: 1000,
    rateLimitPollMax: 1000,
    rateLimitApproveMax: 1000,
    rateLimitWindowSeconds: 60,
    hashKey: "test-key",
    getApprovingUser: async () => ({ ...APPROVER }),
    getUserById: async () => ({ ...APPROVER }),
    issueSession: async (user) => ({
      token: `session-for-${user.id}`,
      user: { id: user.id, name: user.name },
    }),
    onEvent: () => undefined,
    ...overrides,
  });
  await instance.ready();
  return instance;
}

async function createRequest(instance: FastifyInstance): Promise<string> {
  const response = await instance.inject({
    method: "POST",
    url: `${PREFIX}/`,
  });
  expect(response.statusCode).toBe(201);
  return response.json().requestToken as string;
}

beforeEach(async () => {
  await initDb();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  closeCurrentDb();
});

describe("LoginCodesRoutes rate limiting", () => {
  it("limits creates per IP and answers 429 with Retry-After", async () => {
    app = await createApp({ rateLimitCreateMax: 2 });
    await createRequest(app);
    await createRequest(app);

    const throttled = await app.inject({ method: "POST", url: `${PREFIX}/` });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("RATE_LIMITED");
    expect(throttled.json().error).toBe("Too Many Requests");
    expect(throttled.json().serverTime).toBeDefined();
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(throttled.headers["cache-control"]).toBe("no-store");
  });

  it("limits polls per request token, not per IP", async () => {
    app = await createApp({ rateLimitPollMax: 2 });
    const first = await createRequest(app);
    const second = await createRequest(app);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const allowed = await app.inject({
        method: "POST",
        url: `${PREFIX}/poll`,
        payload: { requestToken: first },
      });
      expect(allowed.statusCode).toBe(200);
    }
    const throttled = await app.inject({
      method: "POST",
      url: `${PREFIX}/poll`,
      payload: { requestToken: first },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("RATE_LIMITED");
    expect(throttled.headers["retry-after"]).toBeDefined();

    // A different request token from the same IP is still served.
    const other = await app.inject({
      method: "POST",
      url: `${PREFIX}/poll`,
      payload: { requestToken: second },
    });
    expect(other.statusCode).toBe(200);
  });

  it("limits previews per IP", async () => {
    app = await createApp({ rateLimitApproveMax: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const allowed = await app.inject({
        method: "POST",
        url: `${PREFIX}/preview`,
        payload: { code: "BCDFGHJL" },
      });
      expect(allowed.statusCode).toBe(400);
    }
    const throttled = await app.inject({
      method: "POST",
      url: `${PREFIX}/preview`,
      payload: { code: "BCDFGHJL" },
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().code).toBe("RATE_LIMITED");
  });

  it("disables the limiter when the configured max is 0", async () => {
    app = await createApp({
      rateLimitCreateMax: 0,
      rateLimitPollMax: 0,
      rateLimitApproveMax: 0,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const created = await app.inject({ method: "POST", url: `${PREFIX}/` });
      expect(created.statusCode).toBe(201);
      const previewed = await app.inject({
        method: "POST",
        url: `${PREFIX}/preview`,
        payload: { code: "BCDFGHJL" },
      });
      expect(previewed.statusCode).toBe(400);
    }
  });

  it("uses an injected shared rate-limit store", async () => {
    app = await createApp({
      rateLimitCreateMax: 1,
      rateLimitStore: NoopStore,
    });
    // The local store would throttle the second create (max = 1); the
    // injected store never counts, proving it replaced the default one.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const created = await app.inject({ method: "POST", url: `${PREFIX}/` });
      expect(created.statusCode).toBe(201);
    }
  });

  it("refuses an injected store when the host registered the plugin", async () => {
    const instance = Fastify();
    instance.register(rateLimit, { global: false });
    instance.register(LoginCodesRoutes, {
      prefix: PREFIX,
      store: createLoginCodesStoreCommonUtils(),
      enabled: true,
      hashKey: "test-key",
      rateLimitStore: NoopStore,
    });
    await expect(instance.ready()).rejects.toThrow(
      "rateLimitStore cannot be set",
    );
  });
});

import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { FastifyInstance } from "fastify";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsGetDatabase, DbUtilsInit, DbUtilsSetOTel } from "../DbUtils";
import {
  LOGIN_CODE_ALPHABET,
  LoginCodeHashRequestToken,
  LoginCodesEvent,
} from "./LoginCodes";
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

const BASE_MS = 1_700_000_000_000;
const PREFIX = "/login-codes";

const APPROVER = { id: "user-1", name: "Ada Lovelace" };
const LONG_USER_AGENT = `Mozilla/5.0 (Macintosh) Chrome/120.0 ${"x".repeat(600)}`;

let baseDir: string;
let app: FastifyInstance | undefined;
let currentNow: number;
let approverExists: boolean;
let events: LoginCodesEvent[];

async function initDb(includeLoginCodesTable = true): Promise<void> {
  baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "login-codes-routes-"));
  const dataDir = path.join(baseDir, "data");
  const sqlDir = path.join(baseDir, "sql");
  nodeFs.mkdirSync(sqlDir, { recursive: true });
  nodeFs.writeFileSync(
    path.join(sqlDir, "init-0000.sql"),
    [
      "CREATE TABLE IF NOT EXISTS metadata (type TEXT, value TEXT, dateCreated TEXT);",
      includeLoginCodesTable ? LOGIN_CODES_DDL_SQLITE : "",
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
  if (baseDir) {
    nodeFs.rmSync(baseDir, { recursive: true, force: true });
  }
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
    maxAttempts: 5,
    maxPending: 100,
    rateLimitCreateMax: 1000,
    rateLimitPollMax: 1000,
    rateLimitApproveMax: 1000,
    rateLimitWindowSeconds: 60,
    hashKey: "test-key",
    now: () => currentNow,
    getApprovingUser: async () =>
      approverExists ? { ...APPROVER } : null,
    getUserById: async (id) =>
      approverExists && id === APPROVER.id ? { ...APPROVER } : null,
    issueSession: async (user) => ({
      token: `session-for-${user.id}`,
      user: { id: user.id, name: user.name },
    }),
    verifyPassword: async (_user, password) => password === "good",
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  await instance.ready();
  return instance;
}

type Json = Record<string, any>;

async function createRequest(
  instance: FastifyInstance,
  userAgent?: string,
): Promise<Json> {
  const response = await instance.inject({
    method: "POST",
    url: `${PREFIX}/`,
    headers: userAgent ? { "user-agent": userAgent } : {},
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Json;
}

async function poll(
  instance: FastifyInstance,
  requestToken: string,
  refreshCode?: boolean,
): Promise<Json> {
  const response = await instance.inject({
    method: "POST",
    url: `${PREFIX}/poll`,
    payload: { requestToken, refreshCode },
  });
  return { ...(response.json() as Json), _statusCode: response.statusCode };
}

async function preview(
  instance: FastifyInstance,
  code: string | undefined,
): Promise<Json> {
  const response = await instance.inject({
    method: "POST",
    url: `${PREFIX}/preview`,
    payload: { code },
  });
  return { ...(response.json() as Json), _statusCode: response.statusCode };
}

async function approve(
  instance: FastifyInstance,
  code: string | undefined,
  password?: string,
): Promise<Json> {
  const response = await instance.inject({
    method: "POST",
    url: `${PREFIX}/approve`,
    payload: { code, password },
  });
  return { ...(response.json() as Json), _statusCode: response.statusCode };
}

async function cancel(
  instance: FastifyInstance,
  requestToken: string | undefined,
): Promise<Json> {
  const response = await instance.inject({
    method: "POST",
    url: `${PREFIX}/cancel`,
    payload: { requestToken },
  });
  return { ...(response.json() as Json), _statusCode: response.statusCode };
}

function expectNoStore(headers: Record<string, unknown>): void {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers.pragma).toBe("no-cache");
  expect(headers.vary).toBe("Authorization");
}

describe("LoginCodesRoutes", () => {
  beforeEach(async () => {
    currentNow = BASE_MS;
    approverExists = true;
    events = [];
    await initDb();
    app = await createApp();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    closeCurrentDb();
  });

  describe("capabilities", () => {
    it("reports the enabled, available protocol and its settings", async () => {
      const response = await app!.inject({
        method: "GET",
        url: `${PREFIX}/capabilities`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        enabled: true,
        available: true,
        codeLength: 8,
        rotationSeconds: 30,
        graceSeconds: 60,
        ttlSeconds: 300,
        pollIntervalMs: 2000,
        approveRequiresPassword: false,
        serverTime: new Date(BASE_MS).toISOString(),
      });
      expectNoStore(response.headers);
    });

    it("reports a disabled feature without failing", async () => {
      await app!.close();
      app = await createApp({ enabled: false });
      const capabilities = await app.inject({
        method: "GET",
        url: `${PREFIX}/capabilities`,
      });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json().enabled).toBe(false);
      expect(capabilities.json().available).toBe(false);

      const created = await app.inject({
        method: "POST",
        url: `${PREFIX}/`,
      });
      expect(created.statusCode).toBe(503);
      expect(created.json().code).toBe("LOGIN_CODE_UNAVAILABLE");
      expect(created.json().error).toBe("Login Code Unavailable");
    });

    it("reports unavailable when the hash key is empty or unreadable", async () => {
      await app!.close();
      app = await createApp({ hashKey: "" });
      let capabilities = await app.inject({
        method: "GET",
        url: `${PREFIX}/capabilities`,
      });
      expect(capabilities.json().available).toBe(false);

      await app.close();
      app = await createApp({
        hashKey: () => {
          throw new Error("key store unavailable");
        },
      });
      capabilities = await app.inject({
        method: "GET",
        url: `${PREFIX}/capabilities`,
      });
      expect(capabilities.statusCode).toBe(200);
      expect(capabilities.json().available).toBe(false);

      const created = await app.inject({ method: "POST", url: `${PREFIX}/` });
      expect(created.statusCode).toBe(503);
    });
  });

  describe("create", () => {
    it("returns a request token and a base20 code, storing only hashes", async () => {
      const response = await app!.inject({
        method: "POST",
        url: `${PREFIX}/`,
        headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120.0" },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as Json;
      expect(body.requestToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.code).toHaveLength(8);
      for (const char of body.code as string) {
        expect(LOGIN_CODE_ALPHABET).toContain(char);
      }
      expect(body.codeExpiresAt).toBe(
        new Date(BASE_MS + 30_000).toISOString(),
      );
      expect(body.expiresAt).toBe(new Date(BASE_MS + 300_000).toISOString());
      expect(body.serverTime).toBe(new Date(BASE_MS).toISOString());
      expectNoStore(response.headers);

      const store = createLoginCodesStoreCommonUtils();
      const record = await store.getByRequestTokenHash(
        LoginCodeHashRequestToken(body.requestToken as string),
      );
      expect(record).not.toBeNull();
      expect(record!.codeHash).not.toBe(body.code);
      expect(record!.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(record!.requestUserAgent).toBe(
        "Mozilla/5.0 (Macintosh) Chrome/120.0",
      );
      expect(record!.status).toBe("pending");
      expect(record!.attempts).toBe(0);
    });

    it("truncates a huge user agent instead of rejecting the request", async () => {
      const body = await createRequest(app!, LONG_USER_AGENT);
      const store = createLoginCodesStoreCommonUtils();
      const record = await store.getByRequestTokenHash(
        LoginCodeHashRequestToken(body.requestToken as string),
      );
      expect(record!.requestUserAgent).toHaveLength(512);
    });

    it("enforces the global pending cap", async () => {
      await app!.close();
      app = await createApp({ maxPending: 1 });
      await createRequest(app);
      const throttled = await app.inject({ method: "POST", url: `${PREFIX}/` });
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json().code).toBe("RATE_LIMITED");
      expect(throttled.json().error).toBe("Too Many Requests");
    });
  });

  describe("poll", () => {
    it("returns pending without a code before the rotation window", async () => {
      const created = await createRequest(app!);
      const body = await poll(app!, created.requestToken as string);
      expect(body._statusCode).toBe(200);
      expect(body.status).toBe("pending");
      expect(body.code).toBeUndefined();
      expect(body.codeExpiresAt).toBe(created.codeExpiresAt);
      expect(body.expiresAt).toBe(created.expiresAt);
      expect(body.serverTime).toBe(new Date(BASE_MS).toISOString());
    });

    it("rotates after the window and accepts the previous code during grace", async () => {
      const created = await createRequest(app!);
      currentNow += 30_000;
      const rotated = await poll(app!, created.requestToken as string);
      expect(rotated.status).toBe("pending");
      expect(rotated.code).toHaveLength(8);
      expect(rotated.code).not.toBe(created.code);

      currentNow += 1_000;
      const gracePreview = await preview(
        app!,
        ` ${(created.code as string).slice(0, 4).toLowerCase()}-${(created.code as string)
          .slice(4)
          .toLowerCase()} `,
      );
      expect(gracePreview._statusCode).toBe(200);
      expect(gracePreview.deviceLabel).toBe("Unknown device");

      const currentPreview = await preview(app!, rotated.code as string);
      expect(currentPreview._statusCode).toBe(200);

      currentNow += 61_000;
      const expiredPrevious = await preview(app!, created.code as string);
      expect(expiredPrevious._statusCode).toBe(400);
      expect(expiredPrevious.code).toBe("INVALID_CODE");

      const stillCurrent = await preview(app!, rotated.code as string);
      expect(stillCurrent._statusCode).toBe(200);
    });

    it("honours refreshCode only after the minimum rotation interval", async () => {
      const created = await createRequest(app!);
      currentNow += 3_000;
      const early = await poll(app!, created.requestToken as string, true);
      expect(early.code).toBeUndefined();

      currentNow += 3_000;
      const refreshed = await poll(app!, created.requestToken as string, true);
      expect(refreshed.code).toHaveLength(8);
      expect(refreshed.code).not.toBe(created.code);
    });

    it("expires a request past its TTL", async () => {
      const created = await createRequest(app!);
      currentNow += 300_000;
      const body = await poll(app!, created.requestToken as string);
      expect(body.status).toBe("expired");
      expect(body.expiresAt).toBe(created.expiresAt);
      expect(events.map((event) => event.type)).toContain("login_code_failed");
      expect(events.find((event) => event.type === "login_code_failed")?.reason).toBe(
        "expired",
      );

      const late = await approve(app!, created.code as string);
      expect(late._statusCode).toBe(400);
      expect(late.code).toBe("INVALID_CODE");
    });

    it("rejects unknown request tokens and malformed bodies", async () => {
      const unknown = await poll(app!, "not-a-token");
      expect(unknown._statusCode).toBe(400);
      expect(unknown.code).toBe("INVALID_CODE");

      const missing = await app!.inject({
        method: "POST",
        url: `${PREFIX}/poll`,
        payload: {},
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("INVALID_CODE");
    });
  });

  describe("preview and approve", () => {
    it("previews the requesting device without revealing the code", async () => {
      const created = await createRequest(
        app!,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36",
      );
      const body = await preview(app!, created.code as string);
      expect(body._statusCode).toBe(200);
      expect(body.deviceLabel).toBe("Chrome on Windows");
      expect(body.userAgent).toBe(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36",
      );
      expect(body.userName).toBe("Ada Lovelace");
      expect(body.createdAt).toBe(new Date(BASE_MS).toISOString());
      expect(body.expiresAt).toBe(created.expiresAt);
      expect(body.code).toBeUndefined();
    });

    it("approves and redeems the session exactly once", async () => {
      const created = await createRequest(app!);
      const approved = await approve(app!, created.code as string);
      expect(approved._statusCode).toBe(200);
      expect(approved.approved).toBe(true);
      expect(approved.serverTime).toBe(new Date(BASE_MS).toISOString());

      const redeemed = await poll(app!, created.requestToken as string);
      expect(redeemed._statusCode).toBe(200);
      expect(redeemed.status).toBe("approved");
      expect(redeemed.token).toBe("session-for-user-1");
      expect(redeemed.user).toEqual({ id: "user-1", name: "Ada Lovelace" });

      const second = await poll(app!, created.requestToken as string);
      expect(second._statusCode).toBe(409);
      expect(second.code).toBe("ALREADY_USED");
      expect(second.error).toBe("Already Used");

      expect(events.map((event) => event.type)).toEqual([
        "login_code_approved",
        "login_code_consumed",
      ]);
      for (const event of events) {
        expect(event.requestId).toBeTruthy();
        expect(JSON.stringify(event)).not.toContain(created.code as string);
        expect(JSON.stringify(event)).not.toContain(
          created.requestToken as string,
        );
      }
    });

    it("rejects API tokens and unauthenticated approvals", async () => {
      await app!.close();
      app = await createApp({
        getApprovingUser: async () => ({
          ...APPROVER,
          isApiToken: true,
        }),
      });
      let response = await preview(app, "BCDFGHJK");
      expect(response._statusCode).toBe(403);
      expect(response.code).toBe("FORBIDDEN");
      expect(response.error).toBe("Session Token Required");

      await app.close();
      app = await createApp({ getApprovingUser: async () => null });
      response = await approve(app, "BCDFGHJK");
      expect(response._statusCode).toBe(401);
      expect(response.code).toBe("UNAUTHENTICATED");
      expect(response.error).toBe("Authentication Required");
    });

    it("rejects wrong and malformed codes", async () => {
      const created = await createRequest(app!);
      for (const code of ["BCDFGHJL", "nope", undefined]) {
        const response = await preview(app!, code);
        expect(response._statusCode).toBe(400);
        expect(response.code).toBe("INVALID_CODE");
        expect(response.error).toBe("Invalid Code");
      }
      const wrongCode = created.code === "BCDFGHJL" ? "BCDFGHJK" : "BCDFGHJL";
      const wrongApprove = await approve(app!, wrongCode);
      expect(wrongApprove._statusCode).toBe(400);
    });

    it("requires the configured password and counts wrong passwords as attempts", async () => {
      await app!.close();
      app = await createApp({
        approveRequiresPassword: true,
        maxAttempts: 2,
      });
      const created = await createRequest(app);

      const missing = await approve(app, created.code as string);
      expect(missing._statusCode).toBe(400);
      expect(missing.code).toBe("PASSWORD_REQUIRED");
      expect(missing.error).toBe("Password Required");
      // A missing password must not consume an attempt.
      expect((await poll(app, created.requestToken as string)).status).toBe(
        "pending",
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const wrong = await approve(app, created.code as string, "wrong");
        expect(wrong._statusCode).toBe(400);
        expect(wrong.code).toBe("INVALID_CODE");
      }
      // The second failure exhausts the cap; the next attempt locks it.
      expect((await poll(app, created.requestToken as string)).status).toBe(
        "pending",
      );
      const exhausted = await approve(app, created.code as string, "wrong");
      expect(exhausted._statusCode).toBe(400);
      expect((await poll(app, created.requestToken as string)).status).toBe(
        "failed",
      );
      expect(
        events.find((event) => event.reason === "attempts_exceeded"),
      ).toBeDefined();

      const locked = await approve(app, created.code as string, "good");
      expect(locked._statusCode).toBe(400);
    });

    it("approves with the correct password", async () => {
      await app!.close();
      app = await createApp({ approveRequiresPassword: true });
      const created = await createRequest(app);
      const approved = await approve(app, created.code as string, "good");
      expect(approved._statusCode).toBe(200);
      const redeemed = await poll(app, created.requestToken as string);
      expect(redeemed.token).toBe("session-for-user-1");
    });

    it("fails closed when the approver was deleted before redemption", async () => {
      const created = await createRequest(app!);
      expect((await approve(app!, created.code as string))._statusCode).toBe(
        200,
      );
      approverExists = false;
      const body = await poll(app!, created.requestToken as string);
      expect(body._statusCode).toBe(200);
      expect(body.status).toBe("failed");
      expect(body.token).toBeUndefined();
      expect(
        events.find((event) => event.reason === "approver_missing"),
      ).toBeDefined();
    });

    it("never caches success or error responses", async () => {
      const created = await createRequest(app!);
      const responses = [
        await app!.inject({ method: "GET", url: `${PREFIX}/capabilities` }),
        await app!.inject({ method: "POST", url: `${PREFIX}/` }),
        await app!.inject({
          method: "POST",
          url: `${PREFIX}/poll`,
          payload: { requestToken: created.requestToken },
        }),
        await app!.inject({
          method: "POST",
          url: `${PREFIX}/preview`,
          payload: { code: created.code },
        }),
        await app!.inject({
          method: "POST",
          url: `${PREFIX}/approve`,
          payload: { code: created.code },
        }),
        await app!.inject({
          method: "POST",
          url: `${PREFIX}/approve`,
          payload: { code: "BCDFGHJL" },
        }),
      ];
      for (const response of responses) {
        expectNoStore(response.headers);
        expect((response.json() as Json).serverTime).toBe(
          new Date(BASE_MS).toISOString(),
        );
      }
    });
  });

  describe("cancel", () => {
    it("cancels idempotently and blocks later approval", async () => {
      const created = await createRequest(app!);
      const first = await cancel(app!, created.requestToken as string);
      expect(first._statusCode).toBe(200);
      expect(first.status).toBe("cancelled");
      const second = await cancel(app!, created.requestToken as string);
      expect(second._statusCode).toBe(200);
      expect(second.status).toBe("cancelled");

      expect((await poll(app!, created.requestToken as string)).status).toBe(
        "cancelled",
      );
      const late = await approve(app!, created.code as string);
      expect(late._statusCode).toBe(400);
      expect(late.code).toBe("INVALID_CODE");
    });

    it("refuses to cancel an approved or consumed request", async () => {
      const created = await createRequest(app!);
      await approve(app!, created.code as string);
      const approvedCancel = await cancel(app!, created.requestToken as string);
      expect(approvedCancel._statusCode).toBe(409);
      expect(approvedCancel.code).toBe("ALREADY_USED");

      await poll(app!, created.requestToken as string);
      const consumedCancel = await cancel(app!, created.requestToken as string);
      expect(consumedCancel._statusCode).toBe(409);
    });

    it("rejects unknown tokens and malformed bodies", async () => {
      const unknown = await cancel(app!, "not-a-token");
      expect(unknown._statusCode).toBe(400);
      expect(unknown.code).toBe("INVALID_CODE");
      const missing = await cancel(app!, undefined);
      expect(missing._statusCode).toBe(400);
    });
  });

  describe("attempt cap", () => {
    it("locks preview after the configured number of wrong codes", async () => {
      await app!.close();
      app = await createApp({
        maxAttempts: 2,
        approveRequiresPassword: true,
      });
      const created = await createRequest(app);
      // The password gate does not consume attempts, so preview drives them.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await preview(app, created.code as string);
        if (attempt < 2) {
          expect(response._statusCode).toBe(200);
        } else {
          expect(response._statusCode).toBe(400);
        }
      }
      expect((await poll(app, created.requestToken as string)).status).toBe(
        "failed",
      );
    });
  });
});

describe("LoginCodesRoutes without the migration", () => {
  beforeEach(async () => {
    await initDb(false);
    app = await createApp();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    closeCurrentDb();
  });

  it("answers 503 instead of crashing when the table is missing", async () => {
    const capabilities = await app!.inject({
      method: "GET",
      url: `${PREFIX}/capabilities`,
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().enabled).toBe(true);
    expect(capabilities.json().available).toBe(false);

    const created = await app!.inject({ method: "POST", url: `${PREFIX}/` });
    expect(created.statusCode).toBe(503);
    expect(created.json().code).toBe("LOGIN_CODE_UNAVAILABLE");
  });
});

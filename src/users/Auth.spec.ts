jest.mock("crypto", () => ({
  ...jest.requireActual("crypto"),
  randomUUID: () => "mock-uuid-1234",
}));

jest.mock("../DbUtils", () => ({
  DbUtilsQuerySQL: jest.fn(),
  DbUtilsExecSQL: jest.fn(),
  DbUtilsWithLock: jest.fn(
    (
      _lock: string,
      callback: () => Promise<unknown>,
      _context?: unknown,
    ) => callback(),
  ),
}));

jest.mock("./UsersApiTokensData", () => ({
  UsersApiTokensDataGetByTokenHash: jest.fn(),
  UsersApiTokensDataSetLastUsed: jest.fn(),
}));

jest.mock("./UsersData", () => ({
  UsersDataGet: jest.fn(),
}));

import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import * as jwt from "jsonwebtoken";
import { DbUtilsExecSQL, DbUtilsQuerySQL, DbUtilsWithLock } from "../DbUtils";
import {
  AUTH_ERROR_CODE_FORBIDDEN,
  AUTH_ERROR_CODE_UNAUTHENTICATED,
  AuthGenerateJWT,
  AuthGetLiveUser,
  AuthGetRateLimitLoginMax,
  AuthGetRateLimitRefreshMax,
  AuthGetRateLimitWindowSeconds,
  AuthGetUserSession,
  AuthHasScope,
  AuthInit,
  AuthMustBeAdmin,
  AuthMustBeAuthenticated,
  AuthSessionExpired,
  AuthSetOTel,
} from "./Auth";
import { User } from "./User";
import { UserApiToken } from "./UserApiToken";
import { UserPasswordGetBcryptRounds } from "./UserPassword";
import {
  UsersApiTokensDataGetByTokenHash,
  UsersApiTokensDataSetLastUsed,
} from "./UsersApiTokensData";
import { UsersDataGet } from "./UsersData";

const mockedGetByHash = UsersApiTokensDataGetByTokenHash as jest.Mock;
const mockedSetLastUsed = UsersApiTokensDataSetLastUsed as jest.Mock;
const mockedUsersDataGet = UsersDataGet as jest.Mock;
const mockedQuery = DbUtilsQuerySQL as jest.Mock;
const mockedExec = DbUtilsExecSQL as jest.Mock;
const mockedWithLock = DbUtilsWithLock as jest.Mock;

const mockTracer = {
  startSpan: () => ({ end: () => undefined }),
} as unknown as StandardTracer;

const APP_SCOPES = ["traces", "metrics", "logs"];

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    JWT_KEY: "",
    JWT_VALIDITY_DURATION: 3600,
    DATABASE_TYPE: "sqlite" as const,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
  return res;
}

function mockReq(authorization?: string) {
  return {
    headers: authorization ? { authorization } : {},
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  const user = new User();
  user.name = "test-user";
  user.role = "user";
  user.scopes = ["traces"];
  return Object.assign(user, overrides);
}

function makeToken(overrides: Partial<UserApiToken> = {}): UserApiToken {
  const apiToken = new UserApiToken();
  apiToken.name = "test token";
  apiToken.userId = "user-1";
  apiToken.tokenHash = "abc123hash";
  apiToken.dateCreated = "2026-09-14T00:00:00.000Z";
  return Object.assign(apiToken, overrides);
}

async function expectUnauthenticated(
  guard: Promise<void>,
  res: ReturnType<typeof mockRes>,
) {
  await expect(guard).rejects.toThrow();
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.send).toHaveBeenCalledWith({
    error: "Authentication Required",
    code: AUTH_ERROR_CODE_UNAUTHENTICATED,
  });
}

async function expectForbidden(
  guard: Promise<void>,
  res: ReturnType<typeof mockRes>,
) {
  await expect(guard).rejects.toThrow("Access Denied");
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.send).toHaveBeenCalledWith({
    error: "Access Denied",
    code: AUTH_ERROR_CODE_FORBIDDEN,
  });
}

beforeAll(() => {
  AuthSetOTel(mockTracer);
});

beforeEach(async () => {
  mockedGetByHash.mockReset();
  mockedSetLastUsed.mockReset();
  mockedUsersDataGet.mockReset();
  mockedExec.mockReset();
  mockedQuery.mockReset();
  mockedQuery.mockResolvedValue([]);
  await AuthInit(undefined as never, makeConfig(), APP_SCOPES);
  // Ignore the setup init when tests assert on database access.
  mockedQuery.mockClear();
  mockedExec.mockClear();
  mockedWithLock.mockClear();
});

describe("JWT authentication", () => {
  it("should authenticate a valid JWT signed with HS256", async () => {
    const user = makeUser({ role: "user", scopes: ["traces"] });
    mockedUsersDataGet.mockResolvedValue(user);
    const jwtToken = await AuthGenerateJWT(user);

    const header = jwt.decode(jwtToken, { complete: true }) as {
      header: { alg: string };
    };
    expect(header.header.alg).toBe("HS256");

    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res);

    expect(res.status).not.toHaveBeenCalled();
  });

  it("should accept a case-insensitive Bearer scheme", async () => {
    const user = makeUser({ role: "user", scopes: ["traces"] });
    mockedUsersDataGet.mockResolvedValue(user);
    const jwtToken = await AuthGenerateJWT(user);

    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq(`bearer ${jwtToken}`), res);

    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject a valid JWT carried by a non-Bearer scheme", async () => {
    const user = makeUser({ role: "user", scopes: ["traces"] });
    const jwtToken = await AuthGenerateJWT(user);

    for (const header of [
      `Basic ${jwtToken}`,
      `Token ${jwtToken}`,
      `Bearer:${jwtToken}`,
    ]) {
      const res = mockRes();
      await expectUnauthenticated(
        AuthMustBeAuthenticated(mockReq(header), res),
        res,
      );
    }
    expect(mockedGetByHash).not.toHaveBeenCalled();
  });

  it("should tolerate surrounding whitespace and multiple separators", async () => {
    const user = makeUser({ role: "user", scopes: ["traces"] });
    mockedUsersDataGet.mockResolvedValue(user);
    const jwtToken = await AuthGenerateJWT(user);

    const res = mockRes();
    // Leading/trailing whitespace and multiple separators are tolerated by
    // RFC 6750; a credential containing spaces is not.
    await AuthMustBeAuthenticated(mockReq(`  Bearer  ${jwtToken}  `), res);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject a request without authorization header", async () => {
    const res = mockRes();
    await expectUnauthenticated(AuthMustBeAuthenticated(mockReq(), res), res);
  });

  it("should reject an invalid JWT", async () => {
    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq("Bearer not-a-jwt"), res),
      res,
    );
    expect(mockedGetByHash).toHaveBeenCalledTimes(1);
  });

  it("should reject an unsigned (alg=none) JWT", async () => {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      userId: "user-1",
      role: "admin",
      scopes: [],
    })}.`;

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq(`Bearer ${unsigned}`), res),
      res,
    );
  });

  it("should reject a JWT signed with another key", async () => {
    const foreign = jwt.sign(
      { exp: Math.floor(Date.now() / 1000) + 60, userId: "user-1" },
      "another-key",
      { algorithm: "HS256" },
    );

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq(`Bearer ${foreign}`), res),
      res,
    );
  });
});

describe("API token authentication", () => {
  it("should authenticate a valid API token and resolve the owning user session", async () => {
    const user = makeUser({ id: "user-1", name: "token-user" });
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-owned" }));
    mockedUsersDataGet.mockResolvedValue(user);

    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq("Bearer plain-api-token"), res);
    expect(res.status).not.toHaveBeenCalled();

    const session = await AuthGetUserSession(mockReq("Bearer plain-api-token-2"));
    expect(session.isAuthenticated).toBe(true);
    expect(session.userId).toBe("user-1");
    expect(session.userName).toBe("token-user");
    expect(session.role).toBe("user");
    expect(session.scopes).toEqual(["traces"]);
  });

  it("should pass AuthMustBeAdmin for an API token owned by an admin", async () => {
    const admin = makeUser({ id: "admin-1", name: "token-admin", role: "admin" });
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-admin" }));
    mockedUsersDataGet.mockResolvedValue(admin);

    const res = mockRes();
    await AuthMustBeAdmin(mockReq("Bearer admin-api-token"), res);
    expect(res.status).not.toHaveBeenCalled();

    // Admin tokens get the full scope set, mirroring JWT semantics
    const session = await AuthGetUserSession(
      mockReq("Bearer admin-api-token-2"),
    );
    expect(session.scopes).toEqual(["traces", "metrics", "logs"]);
  });

  it("should fail AuthMustBeAdmin for an API token owned by a non-admin", async () => {
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-non-admin" }));
    mockedUsersDataGet.mockResolvedValue(makeUser({ id: "user-1" }));

    const res = mockRes();
    await expectForbidden(
      AuthMustBeAdmin(mockReq("Bearer user-api-token"), res),
      res,
    );
  });

  it("should pass AuthHasScope when the owning user has the scope", async () => {
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-scoped" }));
    mockedUsersDataGet.mockResolvedValue(
      makeUser({ id: "user-1", scopes: ["traces"] }),
    );

    const res = mockRes();
    await AuthHasScope(mockReq("Bearer scoped-api-token"), res, "traces");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should fail AuthHasScope when the owning user lacks the scope", async () => {
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-unscoped" }));
    mockedUsersDataGet.mockResolvedValue(
      makeUser({ id: "user-1", scopes: ["traces"] }),
    );

    const res = mockRes();
    await expectForbidden(
      AuthHasScope(mockReq("Bearer unscoped-api-token"), res, "metrics"),
      res,
    );
  });

  it("should reject an expired API token without loading the user", async () => {
    mockedGetByHash.mockResolvedValue(
      makeToken({
        id: "token-expired",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq("Bearer expired-api-token"), res),
      res,
    );
    expect(mockedUsersDataGet).not.toHaveBeenCalled();
  });

  it("should reject an API token whose stored expiry does not parse", async () => {
    mockedGetByHash.mockResolvedValue(
      makeToken({ id: "token-bad-expiry", expiresAt: "not-a-date" }),
    );

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq("Bearer bad-expiry-token"), res),
      res,
    );
    expect(mockedUsersDataGet).not.toHaveBeenCalled();
  });

  it("should accept an API token whose expiry is still in the future", async () => {
    mockedGetByHash.mockResolvedValue(
      makeToken({
        id: "token-future",
        expiresAt: "2999-01-01T00:00:00.000Z",
      }),
    );
    mockedUsersDataGet.mockResolvedValue(makeUser({ id: "user-1" }));

    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq("Bearer future-api-token"), res);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject an unknown or revoked API token", async () => {
    mockedGetByHash.mockResolvedValue(null);

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq("Bearer revoked-token"), res),
      res,
    );
    expect(mockedUsersDataGet).not.toHaveBeenCalled();
  });

  it("should not re-resolve a rejected credential within the cache TTL", async () => {
    mockedGetByHash.mockResolvedValue(null);

    const res1 = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq("Bearer negative-cached-token"), res1),
      res1,
    );
    const res2 = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq("Bearer negative-cached-token"), res2),
      res2,
    );

    expect(mockedGetByHash).toHaveBeenCalledTimes(1);
  });

  it("should reject an API token whose user no longer exists", async () => {
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-orphan" }));
    mockedUsersDataGet.mockResolvedValue(null);

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq("Bearer orphan-token"), res),
      res,
    );
  });

  it("should resolve the token only once per request (payload caching)", async () => {
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-cached" }));
    mockedUsersDataGet.mockResolvedValue(makeUser({ id: "user-1" }));

    const req = mockReq("Bearer cached-token");
    await AuthMustBeAuthenticated(req, mockRes());
    await AuthHasScope(req, mockRes(), "traces");
    await AuthGetUserSession(req);

    expect(mockedGetByHash).toHaveBeenCalledTimes(1);
    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });

  it("should write lastUsedAt at most once per hour per token", async () => {
    mockedGetByHash
      .mockResolvedValueOnce(makeToken({ id: "token-last-used" }))
      .mockResolvedValueOnce(makeToken({ id: "token-last-used" }));
    mockedUsersDataGet.mockResolvedValue(makeUser({ id: "user-1" }));

    await AuthMustBeAuthenticated(mockReq("Bearer last-used-token"), mockRes());
    await AuthMustBeAuthenticated(mockReq("Bearer last-used-token"), mockRes());

    expect(mockedSetLastUsed).toHaveBeenCalledTimes(1);
    const [, tokenId, timestamp] = mockedSetLastUsed.mock.calls[0];
    expect(tokenId).toBe("token-last-used");
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });
});

describe("AuthInit JWT key precedence", () => {
  it("should load the existing JWT key from metadata when no key is configured", async () => {
    mockedQuery.mockResolvedValue([{ value: "stored-key" }]);
    const config = makeConfig();
    await AuthInit(undefined as never, config, ["traces"]);

    expect(config.JWT_KEY).toBe("stored-key");
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedWithLock).toHaveBeenCalledWith(
      "auth_token",
      expect.any(Function),
      expect.objectContaining({ end: expect.any(Function) }),
    );
  });

  it("should generate and persist a JWT key when none is stored", async () => {
    mockedQuery.mockResolvedValue([]);
    const config = makeConfig();
    await AuthInit(undefined as never, config, ["traces"]);

    expect(config.JWT_KEY).toBe("mock-uuid-1234");
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });

  it("should honor an explicitly configured key and never touch the database", async () => {
    mockedWithLock.mockClear();
    const config = makeConfig({ JWT_KEY: "operator-configured-key" });
    await AuthInit(undefined as never, config, ["traces"]);

    expect(config.JWT_KEY).toBe("operator-configured-key");
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedWithLock).not.toHaveBeenCalled();
  });
});

describe("AuthInit password policy", () => {
  it("should pass the configured bcrypt cost to the password module", async () => {
    await AuthInit(
      undefined as never,
      makeConfig({ BCRYPT_ROUNDS: 12 }),
      APP_SCOPES,
    );
    expect(UserPasswordGetBcryptRounds()).toBe(12);

    // Restore the default for the rest of the suite.
    await AuthInit(undefined as never, makeConfig(), APP_SCOPES);
    expect(UserPasswordGetBcryptRounds()).toBe(10);
  });
});

describe("Live authorization", () => {
  it("should reject an admin JWT whose live role is user", async () => {
    const claimedAdmin = makeUser({ role: "admin" });
    const jwtToken = await AuthGenerateJWT(claimedAdmin);
    mockedUsersDataGet.mockResolvedValue(makeUser({ role: "user" }));

    const res = mockRes();
    await expectForbidden(
      AuthMustBeAdmin(mockReq(`Bearer ${jwtToken}`), res),
      res,
    );
  });

  it("should answer 401 when an admin JWT belongs to a deleted user", async () => {
    const jwtToken = await AuthGenerateJWT(makeUser({ role: "admin" }));
    mockedUsersDataGet.mockResolvedValue(null);

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAdmin(mockReq(`Bearer ${jwtToken}`), res),
      res,
    );
  });

  it("should allow an admin JWT whose live role is admin", async () => {
    const admin = makeUser({ role: "admin" });
    mockedUsersDataGet.mockResolvedValue(admin);
    const jwtToken = await AuthGenerateJWT(admin);

    const res = mockRes();
    await AuthMustBeAdmin(mockReq(`Bearer ${jwtToken}`), res);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should load the live user once per request across guards", async () => {
    const admin = makeUser({ role: "admin" });
    mockedUsersDataGet.mockResolvedValue(admin);
    const req = mockReq(`Bearer ${await AuthGenerateJWT(admin)}`);

    await AuthMustBeAdmin(req, mockRes());
    await AuthMustBeAuthenticated(req, mockRes());
    await AuthHasScope(req, mockRes(), "traces");

    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });

  it("should answer 401 for an authenticated JWT whose user was deleted", async () => {
    const user = makeUser();
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(null);

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res),
      res,
    );
  });

  it("should deny a scope that was revoked after the JWT was issued", async () => {
    const user = makeUser({ role: "user", scopes: ["traces"] });
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(makeUser({ role: "user", scopes: [] }));

    const res = mockRes();
    await expectForbidden(
      AuthHasScope(mockReq(`Bearer ${jwtToken}`), res, "traces"),
      res,
    );
  });

  it("should return the live user from AuthGetLiveUser rather than the claims", async () => {
    const token = await AuthGenerateJWT(
      makeUser({ name: "old-name", role: "admin" }),
    );
    const liveUser = makeUser({ name: "new-name", role: "user" });
    mockedUsersDataGet.mockResolvedValue(liveUser);

    const result = await AuthGetLiveUser(mockReq(`Bearer ${token}`));
    expect(result).toBe(liveUser);
  });

  it("should keep AuthGetUserSession claim-based for display use", async () => {
    const user = makeUser({ role: "admin", name: "display-name" });
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(makeUser({ role: "user" }));

    const session = await AuthGetUserSession(mockReq(`Bearer ${jwtToken}`));
    expect(session.isAuthenticated).toBe(true);
    expect(session.role).toBe("admin");
    expect(session.userName).toBe("display-name");
  });

  it("should expose display metadata for JWTs and API tokens", async () => {
    const user = makeUser();
    mockedUsersDataGet.mockResolvedValue(user);

    const session = await AuthGetUserSession(
      mockReq(`Bearer ${await AuthGenerateJWT(user)}`),
    );
    expect(session.credentialType).toBe("jwt");
    expect(session.issuedAt).toBeGreaterThan(0);
    expect(session.expiresAt).toBe((session.issuedAt as number) + 3600);
    expect(session.sessionStartedAt).toBe(session.issuedAt);

    mockedGetByHash.mockResolvedValue(makeToken({}));
    const apiSession = await AuthGetUserSession(
      mockReq("Bearer api-token-session"),
    );
    expect(apiSession.credentialType).toBe("api_token");
    expect(apiSession.issuedAt).toBeUndefined();
    expect(apiSession.expiresAt).toBeUndefined();
    expect(apiSession.sessionStartedAt).toBeUndefined();
  });

  it("should cache an unauthenticated resolution across helper calls", async () => {
    const req = mockReq();
    await expect(AuthGetLiveUser(req)).resolves.toBeNull();
    await expect(AuthGetLiveUser(req)).resolves.toBeNull();
    expect((await AuthGetUserSession(req)).isAuthenticated).toBe(false);

    expect(mockedUsersDataGet).not.toHaveBeenCalled();
    expect(mockedGetByHash).not.toHaveBeenCalled();
  });

  it("should keep accepting a stale tokenVersion when revocation is off", async () => {
    const user = makeUser({ id: "off-user", tokenVersion: 0 });
    const jwtToken = await AuthGenerateJWT(user);
    const liveUser = makeUser({ id: "off-user", tokenVersion: 5 });
    mockedUsersDataGet.mockResolvedValue(liveUser);

    const req = mockReq(`Bearer ${jwtToken}`);
    await expect(AuthGetLiveUser(req)).resolves.toBe(liveUser);
    const session = await AuthGetUserSession(req);
    expect(session.isAuthenticated).toBe(true);
  });
});

describe("JWT claims and session lifetime", () => {
  const KEY = "mock-uuid-1234";

  function claimsOf(token: string): any {
    return (jwt.decode(token) as any) ?? {};
  }

  it("should add iss/aud/jti/iat/sessionStartedAt and a 1 h expiry", async () => {
    const token = await AuthGenerateJWT(makeUser());
    const claims = claimsOf(token);

    expect(claims.iss).toBe("devopsplaybook.io");
    expect(claims.aud).toBe("devopsplaybook.io");
    expect(typeof claims.jti).toBe("string");
    expect(claims.jti.length).toBeGreaterThan(0);
    expect(typeof claims.iat).toBe("number");
    expect(claims.sessionStartedAt).toBe(claims.iat);
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("should reject a token with a wrong iss or aud", async () => {
    const user = makeUser();
    mockedUsersDataGet.mockResolvedValue(user);
    const base = {
      exp: Math.floor(Date.now() / 1000) + 60,
      userId: user.id,
      role: user.role,
      scopes: user.scopes,
      tokenVersion: 0,
    };

    for (const claims of [
      { ...base, iss: "evil.example", aud: "devopsplaybook.io" },
      { ...base, iss: "devopsplaybook.io", aud: "evil.example" },
      { ...base, iss: "devopsplaybook.io", aud: ["other", "evil"] },
    ]) {
      const token = jwt.sign(claims, KEY, { algorithm: "HS256" });
      const res = mockRes();
      await expectUnauthenticated(
        AuthMustBeAuthenticated(mockReq(`Bearer ${token}`), res),
        res,
      );
    }
  });

  it("should accept legacy tokens without iss/aud and an aud array containing ours", async () => {
    const user = makeUser({ id: "legacy-user" });
    mockedUsersDataGet.mockResolvedValue(user);
    const base = {
      exp: Math.floor(Date.now() / 1000) + 60,
      userId: user.id,
      role: user.role,
      scopes: user.scopes,
      tokenVersion: 0,
    };

    const legacy = jwt.sign(base, KEY, { algorithm: "HS256" });
    const legit = jwt.sign(
      {
        ...base,
        iss: "devopsplaybook.io",
        aud: ["devopsplaybook.io", "another-audience"],
      },
      KEY,
      { algorithm: "HS256" },
    );
    for (const token of [legacy, legit]) {
      const res = mockRes();
      await AuthMustBeAuthenticated(mockReq(`Bearer ${token}`), res);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it("should omit iss/aud when the config fields are empty", async () => {
    await AuthInit(
      undefined as never,
      makeConfig({ JWT_ISSUER: "", JWT_AUDIENCE: "" }),
      APP_SCOPES,
    );
    const claims = claimsOf(await AuthGenerateJWT(makeUser()));
    expect(claims.iss).toBeUndefined();
    expect(claims.aud).toBeUndefined();
  });

  it("should cap the expiry at the absolute session lifetime", async () => {
    await AuthInit(
      undefined as never,
      makeConfig({ JWT_SESSION_MAX_DURATION: 60 }),
      APP_SCOPES,
    );
    const now = Math.floor(Date.now() / 1000);
    const sessionStartedAt = now - 120;
    const claims = claimsOf(
      await AuthGenerateJWT(makeUser(), { sessionStartedAt }),
    );
    expect(claims.sessionStartedAt).toBe(sessionStartedAt);
    expect(claims.exp).toBe(sessionStartedAt + 60);
    expect(claims.exp).toBeLessThanOrEqual(now);
  });

  it("should report expired absolute sessions and honour the disabled flag", async () => {
    await AuthInit(
      undefined as never,
      makeConfig({ JWT_SESSION_MAX_DURATION: 60 }),
      APP_SCOPES,
    );
    const now = Math.floor(Date.now() / 1000);
    expect(
      AuthSessionExpired({ isAuthenticated: true, sessionStartedAt: now - 61 }),
    ).toBe(true);
    expect(
      AuthSessionExpired({ isAuthenticated: true, sessionStartedAt: now - 59 }),
    ).toBe(false);
    // Legacy tokens fall back to iat.
    expect(
      AuthSessionExpired({ isAuthenticated: true, issuedAt: now - 120 }),
    ).toBe(true);
    expect(AuthSessionExpired({ isAuthenticated: true })).toBe(false);

    await AuthInit(
      undefined as never,
      makeConfig({ JWT_SESSION_MAX_DURATION: 0 }),
      APP_SCOPES,
    );
    expect(
      AuthSessionExpired({
        isAuthenticated: true,
        sessionStartedAt: now - 1000000,
      }),
    ).toBe(false);
  });
});

describe("Rate limit defaults", () => {
  it("should expose the default login/refresh limits and window", async () => {
    await AuthInit(undefined as never, makeConfig(), APP_SCOPES);
    expect(AuthGetRateLimitLoginMax()).toBe(10);
    expect(AuthGetRateLimitRefreshMax()).toBe(60);
    expect(AuthGetRateLimitWindowSeconds()).toBe(60);
  });

  it("should expose configured rate limits", async () => {
    await AuthInit(
      undefined as never,
      makeConfig({
        AUTH_RATE_LIMIT_LOGIN_MAX: 3,
        AUTH_RATE_LIMIT_REFRESH_MAX: 7,
        AUTH_RATE_LIMIT_WINDOW_SECONDS: 30,
      }),
      APP_SCOPES,
    );
    expect(AuthGetRateLimitLoginMax()).toBe(3);
    expect(AuthGetRateLimitRefreshMax()).toBe(7);
    expect(AuthGetRateLimitWindowSeconds()).toBe(30);
  });
});

describe("JWT revocation (JWT_REVOCATION_ENABLED)", () => {
  beforeEach(async () => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([{ value: "revocation-key" }]);
    await AuthInit(
      undefined as never,
      makeConfig({ JWT_REVOCATION_ENABLED: true }),
      ["traces", "metrics", "logs"],
    );
  });

  it("should accept a JWT whose tokenVersion matches the live user", async () => {
    const user = makeUser({ id: "revoke-user-1", tokenVersion: 0 });
    mockedUsersDataGet.mockResolvedValue(user);

    const jwtToken = await AuthGenerateJWT(user);
    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject a JWT after the user's tokenVersion is bumped", async () => {
    const user = makeUser({ id: "revoke-user-2", tokenVersion: 0 });
    const jwtToken = await AuthGenerateJWT(user);

    mockedUsersDataGet.mockResolvedValue(
      makeUser({ id: "revoke-user-2", tokenVersion: 1 }),
    );

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res),
      res,
    );
  });

  it("should reject a JWT whose user no longer exists", async () => {
    const user = makeUser({ id: "revoke-user-3" });
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(null);

    const res = mockRes();
    await expectUnauthenticated(
      AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res),
      res,
    );
  });

  it("should check the live user once per request across guards", async () => {
    const admin = makeUser({ id: "revoke-admin", role: "admin" });
    mockedUsersDataGet.mockResolvedValue(admin);

    const req = mockReq(`Bearer ${await AuthGenerateJWT(admin)}`);
    const res = mockRes();
    await AuthMustBeAdmin(req, res);
    await AuthGetUserSession(req);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });

  // Reproduction of the H1 bypass: the rejection was never cached, so the
  // second live-user read returned the raw (stale) user and guards passed.
  it("should reject a revoked JWT on repeated live-user reads", async () => {
    const user = makeUser({ id: "revoke-repeat", tokenVersion: 0 });
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(
      makeUser({ id: "revoke-repeat", tokenVersion: 1 }),
    );

    const req = mockReq(`Bearer ${jwtToken}`);
    await expect(AuthGetLiveUser(req)).resolves.toBeNull();
    await expect(AuthGetLiveUser(req)).resolves.toBeNull();

    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });

  it("should reject every guard after session resolution of a revoked JWT", async () => {
    const user = makeUser({ id: "revoke-session", tokenVersion: 0 });
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(
      makeUser({ id: "revoke-session", tokenVersion: 1 }),
    );

    const req = mockReq(`Bearer ${jwtToken}`);
    const session = await AuthGetUserSession(req);
    expect(session.isAuthenticated).toBe(false);

    for (const guard of [
      (res: ReturnType<typeof mockRes>) =>
        AuthMustBeAuthenticated(req, res),
      (res: ReturnType<typeof mockRes>) => AuthMustBeAdmin(req, res),
      (res: ReturnType<typeof mockRes>) =>
        AuthHasScope(req, res, "traces"),
    ]) {
      const res = mockRes();
      await expectUnauthenticated(guard(res), res);
    }

    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });

  it("should reject session resolution after a guard of a revoked JWT", async () => {
    const user = makeUser({ id: "revoke-reverse", tokenVersion: 0 });
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(
      makeUser({ id: "revoke-reverse", tokenVersion: 1 }),
    );

    const req = mockReq(`Bearer ${jwtToken}`);
    const res = mockRes();
    await expectUnauthenticated(AuthMustBeAdmin(req, res), res);

    const session = await AuthGetUserSession(req);
    expect(session.isAuthenticated).toBe(false);
    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });

  it("should keep API tokens working and skip the tokenVersion comparison", async () => {
    mockedGetByHash.mockResolvedValue(makeToken({ id: "api-revocation" }));
    // The live user has a different (nonzero) tokenVersion: only JWTs carry
    // the claim, API tokens are re-validated per request instead.
    mockedUsersDataGet.mockResolvedValue(
      makeUser({ id: "user-api-revocation", tokenVersion: 9 }),
    );

    const req = mockReq("Bearer api-token-revocation");
    const res = mockRes();
    await AuthMustBeAuthenticated(req, res);
    await AuthHasScope(req, mockRes(), "traces");
    expect((await AuthGetUserSession(req)).credentialType).toBe("api_token");
    expect(res.status).not.toHaveBeenCalled();
    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });
});

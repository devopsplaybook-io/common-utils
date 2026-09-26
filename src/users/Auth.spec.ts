jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

jest.mock("../DbUtils", () => ({
  DbUtilsQuerySQL: jest.fn(),
  DbUtilsExecSQL: jest.fn(),
  DbUtilsWithLock: jest.fn((_lock: string, callback: () => Promise<unknown>) =>
    callback(),
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
  AuthGenerateJWT,
  AuthGetUserSession,
  AuthHasScope,
  AuthInit,
  AuthMustBeAdmin,
  AuthMustBeAuthenticated,
  AuthSetOTel,
} from "./Auth";
import { User } from "./User";
import { UserApiToken } from "./UserApiToken";
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

async function expectAccessDenied(
  guard: Promise<void>,
  res: ReturnType<typeof mockRes>,
) {
  await expect(guard).rejects.toThrow("Access Denied");
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.send).toHaveBeenCalledWith({ error: "Access Denied" });
}

beforeAll(async () => {
  AuthSetOTel(mockTracer);
  mockedQuery.mockResolvedValue([]);
  await AuthInit(null as never, makeConfig(), ["traces", "metrics", "logs"]);
});

beforeEach(() => {
  mockedGetByHash.mockReset();
  mockedSetLastUsed.mockReset();
  mockedUsersDataGet.mockReset();
});

describe("JWT authentication", () => {
  it("should authenticate a valid JWT signed with HS256", async () => {
    const user = makeUser({ role: "user", scopes: ["traces"] });
    const jwtToken = await AuthGenerateJWT(user);

    const header = jwt.decode(jwtToken, { complete: true }) as {
      header: { alg: string };
    };
    expect(header.header.alg).toBe("HS256");

    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res);

    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject a request without authorization header", async () => {
    const res = mockRes();
    await expectAccessDenied(AuthMustBeAuthenticated(mockReq(), res), res);
  });

  it("should reject an invalid JWT", async () => {
    const res = mockRes();
    await expectAccessDenied(
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
    await expectAccessDenied(
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
    await expectAccessDenied(
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
    await expectAccessDenied(
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
    await expectAccessDenied(
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
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq("Bearer expired-api-token"), res),
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
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq("Bearer revoked-token"), res),
      res,
    );
    expect(mockedUsersDataGet).not.toHaveBeenCalled();
  });

  it("should not re-resolve a rejected credential within the cache TTL", async () => {
    mockedGetByHash.mockResolvedValue(null);

    const res1 = mockRes();
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq("Bearer negative-cached-token"), res1),
      res1,
    );
    const res2 = mockRes();
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq("Bearer negative-cached-token"), res2),
      res2,
    );

    expect(mockedGetByHash).toHaveBeenCalledTimes(1);
  });

  it("should reject an API token whose user no longer exists", async () => {
    mockedGetByHash.mockResolvedValue(makeToken({ id: "token-orphan" }));
    mockedUsersDataGet.mockResolvedValue(null);

    const res = mockRes();
    await expectAccessDenied(
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

describe("AuthInit", () => {
  it("should load the existing JWT key from metadata", async () => {
    mockedExec.mockReset();
    mockedQuery.mockReset();
    const config = makeConfig();
    mockedQuery.mockResolvedValue([{ value: "stored-key" }]);
    await AuthInit(null as never, config, ["traces"]);

    expect(config.JWT_KEY).toBe("stored-key");
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedWithLock).toHaveBeenCalledWith(
      "auth_token",
      expect.any(Function),
    );
  });

  it("should generate and persist a JWT key when none is stored", async () => {
    mockedExec.mockReset();
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([]);
    const config = makeConfig();
    await AuthInit(null as never, config, ["traces"]);

    expect(config.JWT_KEY).toBe("mock-uuid-1234");
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });
});

describe("JWT revocation (JWT_REVOCATION_ENABLED)", () => {
  beforeEach(async () => {
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue([{ value: "revocation-key" }]);
    await AuthInit(
      null as never,
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
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res),
      res,
    );
  });

  it("should reject a JWT whose user no longer exists", async () => {
    const user = makeUser({ id: "revoke-user-3" });
    const jwtToken = await AuthGenerateJWT(user);
    mockedUsersDataGet.mockResolvedValue(null);

    const res = mockRes();
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq(`Bearer ${jwtToken}`), res),
      res,
    );
  });

  it("should accept admin JWTs even when the user row is only re-read once", async () => {
    const admin = makeUser({ id: "revoke-admin", role: "admin" });
    mockedUsersDataGet.mockResolvedValue(admin);

    const jwtToken = await AuthGenerateJWT(admin);
    const res = mockRes();
    await AuthMustBeAdmin(mockReq(`Bearer ${jwtToken}`), res);
    await AuthGetUserSession(mockReq(`Bearer ${jwtToken}-second`));
    expect(res.status).not.toHaveBeenCalled();
  });
});

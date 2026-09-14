jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

jest.mock("../DbUtils", () => ({
  DbUtilsQuerySQL: jest.fn(),
  DbUtilsExecSQL: jest.fn(),
}));

jest.mock("./UsersApiTokensData", () => ({
  UsersApiTokensDataGetByTokenHash: jest.fn(),
}));

jest.mock("./UsersData", () => ({
  UsersDataGet: jest.fn(),
}));

import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsExecSQL, DbUtilsQuerySQL } from "../DbUtils";
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
import { UsersApiTokensDataGetByTokenHash } from "./UsersApiTokensData";
import { UsersDataGet } from "./UsersData";

const mockedGetByHash = UsersApiTokensDataGetByTokenHash as jest.Mock;
const mockedUsersDataGet = UsersDataGet as jest.Mock;
const mockedQuery = DbUtilsQuerySQL as jest.Mock;
const mockedExec = DbUtilsExecSQL as jest.Mock;

const mockTracer = {
  startSpan: () => ({ end: () => undefined }),
} as unknown as StandardTracer;

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

async function expectAccessDenied(guard: Promise<void>, res: ReturnType<typeof mockRes>) {
  await expect(guard).rejects.toThrow("Access Denied");
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.send).toHaveBeenCalledWith({ error: "Access Denied" });
}

beforeAll(async () => {
  AuthSetOTel(mockTracer);
  const config = {
    JWT_KEY: "",
    JWT_VALIDITY_DURATION: 3600,
    DATABASE_TYPE: "sqlite" as const,
  };
  mockedQuery.mockResolvedValue([]);
  await AuthInit(null as never, config, ["traces", "metrics", "logs"]);
});

beforeEach(() => {
  mockedGetByHash.mockReset();
  mockedUsersDataGet.mockReset();
});

describe("JWT authentication", () => {
  it("should authenticate a valid JWT", async () => {
    const user = new User();
    user.name = "jwt-user";
    user.role = "user";
    user.scopes = ["traces"];
    const jwt = await AuthGenerateJWT(user);

    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq(`Bearer ${jwt}`), res);

    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject a request without authorization header", async () => {
    const res = mockRes();
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq(), res),
      res,
    );
  });

  it("should reject an invalid JWT", async () => {
    const res = mockRes();
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq("Bearer not-a-jwt"), res),
      res,
    );
    expect(mockedGetByHash).toHaveBeenCalledTimes(1);
  });
});

describe("API token authentication", () => {
  it("should authenticate a valid API token and resolve the owning user session", async () => {
    const user = new User();
    user.id = "user-1";
    user.name = "token-user";
    user.role = "user";
    user.scopes = ["traces"];
    const apiToken = new User();
    apiToken.id = "token-1";
    mockedGetByHash.mockResolvedValue(apiToken);
    mockedUsersDataGet.mockResolvedValue(user);

    const res = mockRes();
    await AuthMustBeAuthenticated(mockReq("Bearer plain-api-token"), res);
    expect(res.status).not.toHaveBeenCalled();

    const session = await AuthGetUserSession(mockReq("Bearer plain-api-token"));
    expect(session.isAuthenticated).toBe(true);
    expect(session.userId).toBe("user-1");
    expect(session.userName).toBe("token-user");
    expect(session.role).toBe("user");
    expect(session.scopes).toEqual(["traces"]);
  });

  it("should pass AuthMustBeAdmin for an API token owned by an admin", async () => {
    const admin = new User();
    admin.id = "admin-1";
    admin.name = "token-admin";
    admin.role = "admin";
    mockedGetByHash.mockResolvedValue(new User());
    mockedUsersDataGet.mockResolvedValue(admin);

    const res = mockRes();
    await AuthMustBeAdmin(mockReq("Bearer admin-api-token"), res);
    expect(res.status).not.toHaveBeenCalled();

    // Admin tokens get the full scope set, mirroring JWT semantics
    const session = await AuthGetUserSession(mockReq("Bearer admin-api-token"));
    expect(session.scopes).toEqual(["traces", "metrics", "logs"]);
  });

  it("should fail AuthMustBeAdmin for an API token owned by a non-admin", async () => {
    const user = new User();
    user.id = "user-1";
    user.name = "token-user";
    user.role = "user";
    user.scopes = ["traces"];
    mockedGetByHash.mockResolvedValue(new User());
    mockedUsersDataGet.mockResolvedValue(user);

    const res = mockRes();
    await expectAccessDenied(
      AuthMustBeAdmin(mockReq("Bearer user-api-token"), res),
      res,
    );
  });

  it("should pass AuthHasScope when the owning user has the scope", async () => {
    const user = new User();
    user.id = "user-1";
    user.name = "token-user";
    user.role = "user";
    user.scopes = ["traces"];
    mockedGetByHash.mockResolvedValue(new User());
    mockedUsersDataGet.mockResolvedValue(user);

    const res = mockRes();
    await AuthHasScope(mockReq("Bearer scoped-api-token"), res, "traces");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should fail AuthHasScope when the owning user lacks the scope", async () => {
    const user = new User();
    user.id = "user-1";
    user.name = "token-user";
    user.role = "user";
    user.scopes = ["traces"];
    mockedGetByHash.mockResolvedValue(new User());
    mockedUsersDataGet.mockResolvedValue(user);

    const res = mockRes();
    await expectAccessDenied(
      AuthHasScope(mockReq("Bearer scoped-api-token"), res, "metrics"),
      res,
    );
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

  it("should reject an API token whose user no longer exists", async () => {
    mockedGetByHash.mockResolvedValue(new User());
    mockedUsersDataGet.mockResolvedValue(null);

    const res = mockRes();
    await expectAccessDenied(
      AuthMustBeAuthenticated(mockReq("Bearer orphan-token"), res),
      res,
    );
  });

  it("should resolve the token only once per request (payload caching)", async () => {
    const user = new User();
    user.id = "user-1";
    user.name = "token-user";
    user.role = "user";
    user.scopes = ["traces"];
    mockedGetByHash.mockResolvedValue(new User());
    mockedUsersDataGet.mockResolvedValue(user);

    const req = mockReq("Bearer cached-token");
    await AuthMustBeAuthenticated(req, mockRes());
    await AuthHasScope(req, mockRes(), "traces");
    await AuthGetUserSession(req);

    expect(mockedGetByHash).toHaveBeenCalledTimes(1);
    expect(mockedUsersDataGet).toHaveBeenCalledTimes(1);
  });
});

describe("AuthInit", () => {
  it("should load the existing JWT key from metadata", async () => {
    mockedExec.mockReset();
    mockedQuery.mockReset();
    const config = {
      JWT_KEY: "",
      JWT_VALIDITY_DURATION: 3600,
      DATABASE_TYPE: "sqlite" as const,
    };
    mockedQuery.mockResolvedValue([{ value: "stored-key" }]);
    await AuthInit(null as never, config, ["traces"]);

    expect(config.JWT_KEY).toBe("stored-key");
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("should generate and persist a JWT key when none is stored", async () => {
    mockedExec.mockReset();
    mockedQuery.mockReset();
    const config = {
      JWT_KEY: "",
      JWT_VALIDITY_DURATION: 3600,
      DATABASE_TYPE: "sqlite" as const,
    };
    mockedQuery.mockResolvedValue([]);
    await AuthInit(null as never, config, ["traces"]);

    expect(config.JWT_KEY).toBe("mock-uuid-1234");
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });
});

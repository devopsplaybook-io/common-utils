jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

const mockQuery = jest.fn();
const mockExec = jest.fn();

jest.mock("../DbUtils", () => ({
  DbUtilsQuerySQL: (...args: unknown[]) => mockQuery(...args),
  DbUtilsExecSQL: (...args: unknown[]) => mockExec(...args),
}));

import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { UserApiToken } from "./UserApiToken";
import {
  UsersApiTokensDataAdd,
  UsersApiTokensDataCountByUser,
  UsersApiTokensDataDelete,
  UsersApiTokensDataDeleteByUser,
  UsersApiTokensDataGet,
  UsersApiTokensDataGetByTokenHash,
  UsersApiTokensDataListByUser,
  UsersApiTokensDataSetLastUsed,
  UsersApiTokensDataSetOTel,
} from "./UsersApiTokensData";

const mockedQuery = mockQuery as jest.Mock;
const mockedExec = mockExec as jest.Mock;

const mockTracer = {
  startSpan: () => ({ end: () => undefined }),
} as unknown as StandardTracer;

function makeToken(overrides: Partial<UserApiToken> = {}): UserApiToken {
  const apiToken = new UserApiToken();
  apiToken.name = "CI token";
  apiToken.userId = "user-1";
  apiToken.tokenHash = "abc123hash";
  apiToken.dateCreated = "2026-09-14T00:00:00.000Z";
  return Object.assign(apiToken, overrides);
}

beforeAll(() => {
  UsersApiTokensDataSetOTel(mockTracer);
});

beforeEach(() => {
  mockedQuery.mockReset();
  mockedExec.mockReset();
  mockedQuery.mockResolvedValue([]);
  mockedExec.mockResolvedValue(undefined);
});

describe("UsersApiTokensData", () => {
  it("should add a token storing only its hash", async () => {
    const apiToken = makeToken();

    await UsersApiTokensDataAdd(undefined, apiToken);

    expect(mockedExec).toHaveBeenCalledTimes(1);
    const [, sql, params] = mockedExec.mock.calls[0];
    expect(sql).toContain("INSERT INTO users_api_tokens");
    expect(sql).not.toContain("expiresAt");
    expect(params).toEqual([
      "mock-uuid-1234",
      "CI token",
      "user-1",
      "abc123hash",
      "2026-09-14T00:00:00.000Z",
    ]);
    expect(sql).toContain("tokenHash");
  });

  it("should persist expiresAt when the optional columns exist", async () => {
    const apiToken = makeToken({ expiresAt: "2999-01-01T00:00:00.000Z" });

    await UsersApiTokensDataAdd(undefined, apiToken);

    const [, sql, params] = mockedExec.mock.calls[0];
    expect(sql).toContain("INSERT INTO users_api_tokens");
    expect(sql).toContain("expiresAt");
    expect(params).toEqual([
      "mock-uuid-1234",
      "CI token",
      "user-1",
      "abc123hash",
      "2026-09-14T00:00:00.000Z",
      "2999-01-01T00:00:00.000Z",
    ]);
  });

  it("should throw when expiresAt is set but the column is missing", async () => {
    await jest.isolateModulesAsync(async () => {
      const freshModule =
        require("./UsersApiTokensData") as typeof import("./UsersApiTokensData");
      freshModule.UsersApiTokensDataSetOTel(mockTracer);
      mockedQuery.mockRejectedValueOnce(
        new Error('no such column: "expiresAt"'),
      );

      const apiToken = makeToken({ expiresAt: "2999-01-01T00:00:00.000Z" });
      await expect(
        freshModule.UsersApiTokensDataAdd(undefined, apiToken),
      ).rejects.toThrow("run the documented migration");
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  it("should get a token by hash", async () => {
    mockedQuery.mockResolvedValue([
      {
        id: "token-1",
        name: "CI token",
        userId: "user-1",
        tokenHash: "abc123hash",
        dateCreated: "2026-09-14T00:00:00.000Z",
      },
    ]);

    const apiToken = await UsersApiTokensDataGetByTokenHash(
      undefined,
      "abc123hash",
    );

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const [, sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toBe('SELECT * FROM users_api_tokens WHERE "tokenHash" = ?');
    expect(params).toEqual(["abc123hash"]);
    expect(apiToken?.id).toBe("token-1");
    expect(apiToken?.userId).toBe("user-1");
    expect(apiToken?.expiresAt).toBeNull();
    expect(apiToken?.lastUsedAt).toBeNull();
  });

  it("should return null when no token matches the hash", async () => {
    mockedQuery.mockResolvedValue([]);

    const apiToken = await UsersApiTokensDataGetByTokenHash(
      undefined,
      "unknown-hash",
    );

    expect(apiToken).toBeNull();
  });

  it("should get a token by id", async () => {
    mockedQuery.mockResolvedValue([
      {
        id: "token-1",
        name: "CI token",
        userId: "user-1",
        tokenHash: "abc123hash",
        dateCreated: "2026-09-14T00:00:00.000Z",
      },
    ]);

    const apiToken = await UsersApiTokensDataGet(undefined, "token-1");

    const [, sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toBe('SELECT * FROM users_api_tokens WHERE "id" = ?');
    expect(params).toEqual(["token-1"]);
    expect(apiToken?.name).toBe("CI token");
  });

  it("should list tokens of a user without exposing the hash in transport json", async () => {
    mockedQuery.mockResolvedValue([
      {
        id: "token-1",
        name: "CI token",
        userId: "user-1",
        tokenHash: "abc123hash",
        dateCreated: "2026-09-14T00:00:00.000Z",
      },
    ]);

    const apiTokens = await UsersApiTokensDataListByUser(undefined, "user-1");

    const [, sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toBe('SELECT * FROM users_api_tokens WHERE "userId" = ?');
    expect(params).toEqual(["user-1"]);
    expect(apiTokens.length).toBe(1);
    const transport = apiTokens[0].toTransportJson();
    expect(transport).toEqual({
      id: "token-1",
      name: "CI token",
      userId: "user-1",
      dateCreated: "2026-09-14T00:00:00.000Z",
      expiresAt: null,
      lastUsedAt: null,
    });
    expect(transport.tokenHash).toBeUndefined();
  });

  it("should count the tokens of a user", async () => {
    mockedQuery.mockResolvedValue([{ count: 3 }]);

    const count = await UsersApiTokensDataCountByUser(undefined, "user-1");

    expect(count).toBe(3);
    const [, sql, params] = mockedQuery.mock.calls[0];
    expect(sql).toBe(
      'SELECT COUNT(*) as count FROM users_api_tokens WHERE "userId" = ?',
    );
    expect(params).toEqual(["user-1"]);
  });

  it("should record lastUsedAt on an explicit call", async () => {
    await UsersApiTokensDataSetLastUsed(
      undefined,
      "token-1",
      "2026-09-14T12:00:00.000Z",
    );

    const [, sql, params] = mockedExec.mock.calls[0];
    expect(sql).toBe(
      'UPDATE users_api_tokens SET "lastUsedAt" = ? WHERE "id" = ?',
    );
    expect(params).toEqual(["2026-09-14T12:00:00.000Z", "token-1"]);
  });

  it("should skip lastUsedAt writes when the column is missing", async () => {
    await jest.isolateModulesAsync(async () => {
      const freshModule =
        require("./UsersApiTokensData") as typeof import("./UsersApiTokensData");
      freshModule.UsersApiTokensDataSetOTel(mockTracer);
      mockedQuery.mockRejectedValueOnce(
        new Error('no such column: "expiresAt"'),
      );

      await freshModule.UsersApiTokensDataSetLastUsed(
        undefined,
        "token-1",
        "2026-09-14T12:00:00.000Z",
      );

      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  it("should delete a token by id", async () => {
    await UsersApiTokensDataDelete(undefined, "token-1");

    const [, sql, params] = mockedExec.mock.calls[0];
    expect(sql).toBe('DELETE FROM users_api_tokens WHERE "id" = ?');
    expect(params).toEqual(["token-1"]);
  });

  it("should delete all tokens of a user", async () => {
    await UsersApiTokensDataDeleteByUser(undefined, "user-1");

    const [, sql, params] = mockedExec.mock.calls[0];
    expect(sql).toBe('DELETE FROM users_api_tokens WHERE "userId" = ?');
    expect(params).toEqual(["user-1"]);
  });
});

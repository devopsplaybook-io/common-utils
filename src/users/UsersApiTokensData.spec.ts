jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

jest.mock("../DbUtils", () => ({
  DbUtilsQuerySQL: jest.fn(),
  DbUtilsExecSQL: jest.fn(),
}));

import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsExecSQL, DbUtilsQuerySQL } from "../DbUtils";
import { UserApiToken } from "./UserApiToken";
import {
  UsersApiTokensDataAdd,
  UsersApiTokensDataDelete,
  UsersApiTokensDataDeleteByUser,
  UsersApiTokensDataGet,
  UsersApiTokensDataGetByTokenHash,
  UsersApiTokensDataListByUser,
  UsersApiTokensDataSetOTel,
} from "./UsersApiTokensData";

const mockedQuery = DbUtilsQuerySQL as jest.Mock;
const mockedExec = DbUtilsExecSQL as jest.Mock;

const mockTracer = {
  startSpan: () => ({ end: () => undefined }),
} as unknown as StandardTracer;

beforeAll(() => {
  UsersApiTokensDataSetOTel(mockTracer);
});

beforeEach(() => {
  mockedQuery.mockReset();
  mockedExec.mockReset();
});

describe("UsersApiTokensData", () => {
  it("should add a token storing only its hash", async () => {
    const apiToken = new UserApiToken();
    apiToken.name = "CI token";
    apiToken.userId = "user-1";
    apiToken.tokenHash = "abc123hash";
    apiToken.dateCreated = "2026-09-14T00:00:00.000Z";

    await UsersApiTokensDataAdd(undefined, apiToken);

    expect(mockedExec).toHaveBeenCalledTimes(1);
    const [, sql, params] = mockedExec.mock.calls[0];
    expect(sql).toContain("INSERT INTO users_api_tokens");
    expect(params).toEqual([
      "mock-uuid-1234",
      "CI token",
      "user-1",
      "abc123hash",
      "2026-09-14T00:00:00.000Z",
    ]);
    expect(sql).toContain("tokenHash");
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
    });
    expect(transport.tokenHash).toBeUndefined();
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

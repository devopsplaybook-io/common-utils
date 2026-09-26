jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import {
  DbUtilsExecSQL,
  DbUtilsGetDatabase,
  DbUtilsInit,
  DbUtilsQuerySQL,
  DbUtilsSetOTel,
} from "../DbUtils";
import { User } from "./User";
import {
  UsersDataAdd,
  UsersDataBumpTokenVersion,
  UsersDataCount,
  UsersDataCountAdmins,
  UsersDataDelete,
  UsersDataGet,
  UsersDataGetByName,
  UsersDataList,
  UsersDataSetOTel,
  UsersDataUpdatePassword,
  UsersDataUpdateUser,
  isUniqueViolationError,
} from "./UsersData";

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
  // Documented additive migration: case-insensitive uniqueness of user names
  'CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower ON users (LOWER("name"));',
].join("\n");

const mockSpans: any[] = [];
const mockTracer = {
  startSpan: jest.fn((name: string) => {
    const span = {
      name,
      end: jest.fn(),
      addEvent: jest.fn(),
      setStatus: jest.fn(),
    };
    mockSpans.push(span);
    return span;
  }),
} as unknown as StandardTracer;

const mockModuleLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockStandardLogger = {
  createModuleLogger: jest.fn(() => mockModuleLogger),
} as unknown as StandardLogger;

let baseDir: string;
let dataDir: string;
let sqlDir: string;

function allSpansEnded(): boolean {
  return (
    mockSpans.length > 0 &&
    mockSpans.every((span) => span.end.mock.calls.length === 1)
  );
}

function makeUser(
  id: string,
  name: string,
  role: "user" | "admin" = "user",
  scopes: string[] = ["traces"],
): User {
  const user = new User();
  user.id = id;
  user.name = name;
  user.passwordEncrypted = `hash-${id}`;
  user.role = role;
  user.scopes = scopes;
  return user;
}

async function initTempDb(): Promise<void> {
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
}

beforeEach(() => {
  mockSpans.length = 0;
  baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "users-data-"));
  dataDir = path.join(baseDir, "data");
  sqlDir = path.join(baseDir, "sql");
  nodeFs.mkdirSync(sqlDir, { recursive: true });
  nodeFs.writeFileSync(path.join(sqlDir, "init-0000.sql"), SCHEMA_SQL);
  DbUtilsSetOTel(mockTracer, mockStandardLogger);
  UsersDataSetOTel(mockTracer);
});

afterEach(() => {
  closeCurrentDb();
  nodeFs.rmSync(baseDir, { recursive: true, force: true });
});

describe("UsersData CRUD (real SQLite database)", () => {
  beforeEach(async () => {
    await initTempDb();
  });

  it("should add a user and read it back with parsed scopes", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "alice", "admin", ["traces", "metrics"]));

    const user = await UsersDataGet(undefined, "user-1");
    expect(user).not.toBeNull();
    expect(user?.name).toBe("alice");
    expect(user?.role).toBe("admin");
    expect(user?.passwordEncrypted).toBe("hash-user-1");
    expect(Array.isArray(user?.scopes)).toBe(true);
    expect(user?.scopes).toEqual(["traces", "metrics"]);
    expect(user?.tokenVersion).toBe(0);

    // The raw column stores a JSON string, parsed on read
    const raw = DbUtilsQuerySQL(
      undefined,
      'SELECT "scopes" FROM users WHERE "id" = ?',
      ["user-1"],
    ) as any[];
    expect(raw[0].scopes).toBe('["traces","metrics"]');
    expect(allSpansEnded()).toBe(true);
  });

  it("should find a user by name and return null when missing", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "alice"));

    const found = await UsersDataGetByName(undefined, "alice");
    expect(found?.id).toBe("user-1");

    expect(await UsersDataGetByName(undefined, "nobody")).toBeNull();
    expect(await UsersDataGet(undefined, "unknown-id")).toBeNull();
  });

  it("should count users and admins", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "alice", "admin"));
    await UsersDataAdd(undefined, makeUser("user-2", "bob"));
    await UsersDataAdd(undefined, makeUser("user-3", "carol", "admin"));

    expect(await UsersDataCount(undefined)).toBe(3);
    expect(await UsersDataCountAdmins(undefined)).toBe(2);
  });

  it("should list users with optional pagination", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "alice"));
    await UsersDataAdd(undefined, makeUser("user-2", "bob"));
    await UsersDataAdd(undefined, makeUser("user-3", "carol"));

    const all = await UsersDataList(undefined);
    expect(all.length).toBe(3);
    expect(all.map((user) => user.id).sort()).toEqual([
      "user-1",
      "user-2",
      "user-3",
    ]);

    const firstPage = await UsersDataList(undefined, 2);
    expect(firstPage.length).toBe(2);

    const secondPage = await UsersDataList(undefined, 2, 2);
    expect(secondPage.length).toBe(1);

    // pagination is a partition of the full list
    const paged = [...firstPage, ...secondPage].map((user) => user.id);
    expect(new Set(paged)).toEqual(new Set(["user-1", "user-2", "user-3"]));
  });

  it("should update password and role/scopes", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "alice"));

    const user = (await UsersDataGet(undefined, "user-1")) as User;
    user.passwordEncrypted = "new-hash";
    user.role = "admin";
    user.scopes = ["metrics"];
    await UsersDataUpdatePassword(undefined, user);
    await UsersDataUpdateUser(undefined, user);

    const updated = await UsersDataGet(undefined, "user-1");
    expect(updated?.passwordEncrypted).toBe("new-hash");
    expect(updated?.role).toBe("admin");
    expect(updated?.scopes).toEqual(["metrics"]);
  });

  it("should bump the token version", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "alice"));

    await UsersDataBumpTokenVersion(undefined, "user-1");
    expect((await UsersDataGet(undefined, "user-1"))?.tokenVersion).toBe(1);

    await UsersDataBumpTokenVersion(undefined, "user-1");
    expect((await UsersDataGet(undefined, "user-1"))?.tokenVersion).toBe(2);
  });

  it("should delete a user", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "alice"));

    await UsersDataDelete(undefined, "user-1");

    expect(await UsersDataGet(undefined, "user-1")).toBeNull();
    expect(await UsersDataCount(undefined)).toBe(0);
  });

  it("should reject a case-insensitive duplicate name via the unique index", async () => {
    await UsersDataAdd(undefined, makeUser("user-1", "Admin"));

    const duplicateError = await UsersDataAdd(
      undefined,
      makeUser("user-2", "admin"),
    ).then(
      () => null,
      (error) => error,
    );

    expect(duplicateError).not.toBeNull();
    expect(isUniqueViolationError(duplicateError)).toBe(true);
    expect(await UsersDataCount(undefined)).toBe(1);
  });

  it("should end the span and rethrow when the query fails", async () => {
    DbUtilsExecSQL(undefined, "DROP TABLE users");

    await expect(UsersDataGet(undefined, "user-1")).rejects.toThrow(
      "no such table",
    );

    const getSpan = mockSpans.find((span) => span.name === "UsersDataGet");
    expect(getSpan.end).toHaveBeenCalledTimes(1);
    expect(allSpansEnded()).toBe(true);
  });
});

describe("isUniqueViolationError", () => {
  it("should detect Postgres and SQLite unique violations", () => {
    expect(isUniqueViolationError({ code: "23505" })).toBe(true);
    expect(isUniqueViolationError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(
      true,
    );
    expect(isUniqueViolationError({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" })).toBe(
      true,
    );
    expect(
      isUniqueViolationError({
        message: "UNIQUE constraint failed: users.name",
      }),
    ).toBe(true);
    expect(
      isUniqueViolationError({
        message:
          'duplicate key value violates unique constraint "users_name_key"',
      }),
    ).toBe(true);
  });

  it("should return false for unrelated errors", () => {
    expect(isUniqueViolationError(new Error("no such table: users"))).toBe(
      false,
    );
    expect(isUniqueViolationError({ code: "42P01" })).toBe(false);
    expect(isUniqueViolationError(null)).toBe(false);
    expect(isUniqueViolationError(undefined)).toBe(false);
  });
});

describe("User.normalizeScopes", () => {
  it("should accept arrays and JSON strings", () => {
    expect(User.normalizeScopes(["traces", "metrics"])).toEqual([
      "traces",
      "metrics",
    ]);
    expect(User.normalizeScopes('["traces"]')).toEqual(["traces"]);
  });

  it("should fall back to the default scopes for invalid input", () => {
    const previousDefaults = User.DEFAULT_SCOPES;
    User.DEFAULT_SCOPES = ["logs"];
    try {
      expect(User.normalizeScopes("not-json")).toEqual(["logs"]);
      expect(User.normalizeScopes(42)).toEqual(["logs"]);
      expect(User.normalizeScopes(null)).toEqual(["logs"]);
      expect(User.normalizeScopes('{"a":1}')).toEqual(["logs"]);
    } finally {
      User.DEFAULT_SCOPES = previousDefaults;
    }
  });
});

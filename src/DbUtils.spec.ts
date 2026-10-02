import {
  DbUtilsGetType,
  DbUtilsInit,
  DbUtilsWithLock,
  convertToPostgresPlaceholders,
} from "./DbUtils";
import * as PostgresDbUtils from "./PostgresDbUtils";

jest.mock("./PostgresDbUtils", () => ({
  PostgresDbUtilsSetOTel: jest.fn(),
  PostgresDbUtilsInit: jest.fn().mockResolvedValue(undefined),
  PostgresDbUtilsGetPool: jest.fn(),
  PostgresDbUtilsExecSQL: jest.fn(),
  PostgresDbUtilsQuerySQL: jest.fn(),
  PostgresDbUtilsWithAdvisoryLock: jest.fn(
    async (_lock: string, callback: () => Promise<unknown>) => callback(),
  ),
}));

describe("convertToPostgresPlaceholders", () => {
  it("should convert single ?", () => {
    expect(convertToPostgresPlaceholders("SELECT * FROM t WHERE id = ?")).toBe(
      "SELECT * FROM t WHERE id = $1",
    );
  });

  it("should convert multiple ? to $1, $2, ...", () => {
    expect(
      convertToPostgresPlaceholders("INSERT INTO t (a,b,c) VALUES (?,?,?)"),
    ).toBe("INSERT INTO t (a,b,c) VALUES ($1,$2,$3)");
  });

  it("should return SQL unchanged when no ? present", () => {
    expect(convertToPostgresPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("should handle empty string", () => {
    expect(convertToPostgresPlaceholders("")).toBe("");
  });

  it("should keep ? inside single-quoted literals", () => {
    expect(
      convertToPostgresPlaceholders(
        "SELECT * FROM t WHERE note = 'why?' AND id = ?",
      ),
    ).toBe("SELECT * FROM t WHERE note = 'why?' AND id = $1");
  });

  it("should not count escaped quotes as literal end", () => {
    expect(
      convertToPostgresPlaceholders("SELECT * FROM t WHERE a = 'it''s ?' AND b = ?"),
    ).toBe("SELECT * FROM t WHERE a = 'it''s ?' AND b = $1");
  });

  it("should keep ? inside double-quoted identifiers", () => {
    expect(
      convertToPostgresPlaceholders('SELECT "weird?col" FROM t WHERE id = ?'),
    ).toBe('SELECT "weird?col" FROM t WHERE id = $1');
  });

  it("should keep ? inside line comments", () => {
    expect(
      convertToPostgresPlaceholders("SELECT ? -- is this ? a placeholder?\nFROM t"),
    ).toBe("SELECT $1 -- is this ? a placeholder?\nFROM t");
  });

  it("should keep ? inside block comments", () => {
    expect(
      convertToPostgresPlaceholders("SELECT /* ?: not a param */ ? FROM t"),
    ).toBe("SELECT /* ?: not a param */ $1 FROM t");
  });

  it("should keep ? inside dollar-quoted strings", () => {
    expect(
      convertToPostgresPlaceholders("SELECT $$literal ?$$, ? FROM t"),
    ).toBe("SELECT $$literal ?$$, $1 FROM t");
    expect(
      convertToPostgresPlaceholders("SELECT $tag$literal ?$tag$, ? FROM t"),
    ).toBe("SELECT $tag$literal ?$tag$, $1 FROM t");
  });

  it("should convert the jsonb ? operator too (documented limitation)", () => {
    // The jsonb existence operator is not supported: use jsonb_exists(data, 'key').
    expect(convertToPostgresPlaceholders("SELECT data ? 'key' FROM t")).toBe(
      "SELECT data $1 'key' FROM t",
    );
  });

  it("should number parameters across literals sequentially", () => {
    expect(
      convertToPostgresPlaceholders(
        "INSERT INTO t (a,b) VALUES (?, 'const?') RETURNING id -- ?\n, ?",
      ),
    ).toBe(
      "INSERT INTO t (a,b) VALUES ($1, 'const?') RETURNING id -- ?\n, $2",
    );
  });
});

describe("DbUtilsInit", () => {
  it("should reject an unsupported DATABASE_TYPE", async () => {
    await expect(
      DbUtilsInit(
        undefined as never,
        { DATABASE_TYPE: "mysql" } as never,
        "/sql",
      ),
    ).rejects.toThrow('Invalid DATABASE_TYPE: mysql');
  });

  it("should default to sqlite before init", () => {
    expect(DbUtilsGetType()).toBe("sqlite");
  });
});

describe("DbUtilsWithLock", () => {
  it("runs the callback directly on sqlite, without any advisory lock", async () => {
    const callback = jest.fn(async () => "sqlite-result");

    const result = await DbUtilsWithLock("auth_token", callback);

    expect(result).toBe("sqlite-result");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(
      PostgresDbUtils.PostgresDbUtilsWithAdvisoryLock,
    ).not.toHaveBeenCalled();
  });

  it("delegates to the Postgres advisory lock with the span context", async () => {
    await jest.isolateModulesAsync(async () => {
      const dbUtils = require("./DbUtils") as typeof import("./DbUtils");
      const postgresDbUtils =
        require("./PostgresDbUtils") as typeof import("./PostgresDbUtils");

      await dbUtils.DbUtilsInit(
        undefined as never,
        { DATABASE_TYPE: "postgres" } as never,
        "/sql",
      );

      const context = { name: "request-span" } as never;
      const result = await dbUtils.DbUtilsWithLock(
        "users_bootstrap",
        async () => "pg-result",
        context,
      );

      expect(result).toBe("pg-result");
      expect(
        postgresDbUtils.PostgresDbUtilsWithAdvisoryLock,
      ).toHaveBeenCalledWith(
        "users_bootstrap",
        expect.any(Function),
        context,
      );
    });
  });
});

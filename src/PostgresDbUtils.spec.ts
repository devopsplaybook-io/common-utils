import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";

const mockReadFile = jest.fn();
const mockReaddir = jest.fn();

jest.mock("fs-extra", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

const mockConnect = jest.fn();
const mockClientRelease = jest.fn();
const mockClientQuery = jest.fn();
const mockCreatedPools: any[] = [];

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(function (config: any) {
    const mockPoolInstance = {
      config,
      query: jest.fn(),
      connect: (...args: unknown[]) => mockConnect(...args),
      on: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
    };
    mockCreatedPools.push(mockPoolInstance);
    return mockPoolInstance;
  }),
}));

import {
  POSTGRES_LOCK_KEYS,
  PostgresDbConfig,
  PostgresDbUtilsExecSQL,
  PostgresDbUtilsExecSQLFile,
  PostgresDbUtilsInit,
  PostgresDbUtilsQuerySQL,
  PostgresDbUtilsSetOTel,
  PostgresDbUtilsTransactionCommit,
  PostgresDbUtilsTransactionStart,
  PostgresDbUtilsWithAdvisoryLock,
  PostgresSchemaDbUtils,
} from "./PostgresDbUtils";

const mockClient = {
  query: (...args: unknown[]) => mockClientQuery(...args),
  release: (...args: unknown[]) => mockClientRelease(...args),
};

const mockSpans: any[] = [];
const mockTracer = {
  startSpan: jest.fn((name: string) => {
    const span = {
      name,
      end: jest.fn(),
      setStatus: jest.fn(),
      addEvent: jest.fn(),
    };
    mockSpans.push(span);
    return span;
  }),
} as unknown as StandardTracer;

const mockModuleLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockStandardLogger = {
  createModuleLogger: jest.fn(() => mockModuleLogger),
} as unknown as StandardLogger;

function makeConfig(overrides: Partial<PostgresDbConfig> = {}): PostgresDbConfig {
  return {
    DATABASE_POSTGRES_HOST: "localhost",
    DATABASE_POSTGRES_PORT: 5432,
    DATABASE_POSTGRES_USER: "user",
    DATABASE_POSTGRES_PASSWORD: "pass",
    DATABASE_POSTGRES_DATABASE: "db",
    ...overrides,
  };
}

function executedSql(): string[] {
  return mockClientQuery.mock.calls.map((call) => String(call[0]));
}

/** Every created span must have been ended exactly once. */
function allSpansEnded(): boolean {
  return (
    mockSpans.length > 0 &&
    mockSpans.every((span) => span.end.mock.calls.length === 1)
  );
}

function functionalPool(): any {
  return mockCreatedPools[mockCreatedPools.length - 1];
}

/**
 * Fake `metadata` table with TEXT affinity, mirroring Postgres semantics:
 * `MAX(CAST(value AS INTEGER))` is numeric, a plain `MAX(value)` is
 * lexicographic ("9" > "10").
 */
function setupFakeMetadataTable(initialVersions: number[]): string[] {
  const storedVersions = initialVersions.map((version) => String(version));
  mockClientQuery.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const statement = String(sql);
      if (statement.includes("MAX(CAST(value AS INTEGER))")) {
        const numeric = storedVersions.map(Number);
        return {
          rows: [{ version: numeric.length > 0 ? Math.max(...numeric) : null }],
          rowCount: 1,
        };
      }
      if (/\bMAX\(value\)/.test(statement)) {
        const textMax = storedVersions.reduce<string | null>(
          (max, value) => (max === null || value > max ? value : max),
          null,
        );
        return { rows: [{ version: textMax }], rowCount: 1 };
      }
      if (statement.includes("INSERT INTO metadata")) {
        storedVersions.push(String(params?.[1]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  );
  return storedVersions;
}

beforeAll(() => {
  PostgresDbUtilsSetOTel(mockTracer, mockStandardLogger);
});

beforeEach(() => {
  mockCreatedPools.length = 0;
  mockSpans.length = 0;
  mockReadFile.mockReset();
  mockReaddir.mockReset();
  mockConnect.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockReadFile.mockImplementation(async (filename: string) =>
    Buffer.from(`SQL:${filename}`),
  );
  mockReaddir.mockResolvedValue([]);
  mockConnect.mockResolvedValue(mockClient);
});

describe("PostgresDbUtilsInit migrations", () => {
  it("applies only pending migrations under the advisory lock", async () => {
    mockReaddir.mockResolvedValue([
      "init-0010.sql",
      "init-0000.sql",
      "init-0002.sql",
    ]);
    setupFakeMetadataTable([2]);

    await PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql");

    const statements = executedSql();
    expect(statements[0]).toBe("SELECT pg_advisory_lock($1)");
    expect(statements).toContain(
      'SELECT MAX(CAST(value AS INTEGER)) as version FROM metadata WHERE "type" = \'db_version\'',
    );
    // init-0000.sql always runs, init-0010.sql is pending, init-0002.sql is not
    expect(statements).toContain("SQL:/sql/init-0000.sql");
    expect(statements).toContain("SQL:/sql/init-0010.sql");
    expect(statements).not.toContain("SQL:/sql/init-0002.sql");
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    expect(statements.slice(-1)[0]).toBe("SELECT pg_advisory_unlock($1)");
    expect(mockClientQuery).toHaveBeenCalledWith("SELECT pg_advisory_lock($1)", [
      POSTGRES_LOCK_KEYS.migration,
    ]);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(allSpansEnded()).toBe(true);
  });

  it("applies 10+ migrations exactly once across two boots (text-affinity metadata.value)", async () => {
    const filenames = Array.from(
      { length: 11 },
      (_, index) => `init-${String(index).padStart(4, "0")}.sql`,
    );
    mockReaddir.mockResolvedValue([...filenames].reverse());
    setupFakeMetadataTable([]);

    await PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql");

    const versionRows = mockClientQuery.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO metadata"),
    );
    expect(versionRows.length).toBe(10);
    expect(versionRows.map((call) => (call[1] as unknown[])[1])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);

    const secondBootStart = mockClientQuery.mock.calls.length;
    await PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql");

    const secondBootMigrations = mockClientQuery.mock.calls
      .slice(secondBootStart)
      .map((call) => String(call[0]))
      .filter((sql) => sql.startsWith("SQL:"));
    // Only the idempotent init-0000.sql runs on the second boot
    expect(secondBootMigrations).toEqual(["SQL:/sql/init-0000.sql"]);
  });

  it("rolls back a failing migration and never records its version", async () => {
    mockReaddir.mockResolvedValue(["init-0000.sql", "init-0001.sql"]);
    mockReadFile.mockImplementation(async (filename: string) =>
      Buffer.from(filename.endsWith("init-0001.sql") ? "SQL:BROKEN" : `SQL:${filename}`),
    );
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql) === "SQL:BROKEN") {
        throw new Error("syntax error at or near BROKEN");
      }
      return { rows: [{ version: 0 }], rowCount: 1 };
    });

    await expect(
      PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql"),
    ).rejects.toThrow("syntax error at or near BROKEN");

    const statements = executedSql();
    expect(statements).toContain("ROLLBACK");
    // The successful init-0000.sql committed; the broken migration did not
    expect(statements.filter((sql) => sql === "COMMIT").length).toBe(1);
    expect(statements.slice(-4)).toEqual([
      "BEGIN",
      "SQL:BROKEN",
      "ROLLBACK",
      "SELECT pg_advisory_unlock($1)",
    ]);
    const versionRows = mockClientQuery.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO metadata"),
    );
    expect(versionRows.length).toBe(0);
    // The advisory lock is released even though the migration failed
    expect(statements.slice(-1)[0]).toBe("SELECT pg_advisory_unlock($1)");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(allSpansEnded()).toBe(true);
  });

  it("throws when init-0000.sql is missing", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    );

    await expect(
      PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql"),
    ).rejects.toThrow("ENOENT");

    expect(executedSql()).not.toContain("BEGIN");
    expect(allSpansEnded()).toBe(true);
  });

  it("ends the init span when the pool connection is rejected", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql"),
    ).rejects.toThrow("ECONNREFUSED");

    expect(allSpansEnded()).toBe(true);
  });

  it("applies the configured timeouts to the pool", async () => {
    setupFakeMetadataTable([99]);
    await PostgresDbUtilsInit(
      undefined as never,
      makeConfig({
        DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS: 15000,
        DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS: 60000,
      }),
      "/sql",
    );

    const config = functionalPool().config;
    expect(config.max).toBe(20);
    expect(config.keepAlive).toBe(true);
    expect(config.idleTimeoutMillis).toBe(30000);
    expect(config.connectionTimeoutMillis).toBe(10000);
    expect(config.statement_timeout).toBe(15000);
    expect(config.idle_in_transaction_session_timeout).toBe(60000);
  });

  it("omits the timeouts from the pool when disabled", async () => {
    setupFakeMetadataTable([99]);
    await PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql");

    const config = functionalPool().config;
    expect(config.statement_timeout).toBeUndefined();
    expect(config.idle_in_transaction_session_timeout).toBeUndefined();
  });
});

describe("PostgresDbUtilsWithAdvisoryLock", () => {
  beforeEach(async () => {
    setupFakeMetadataTable([99]);
    await PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql");
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientRelease.mockClear();
    mockSpans.length = 0;
  });

  it("runs the callback under the named advisory lock and releases it", async () => {
    const result = await PostgresDbUtilsWithAdvisoryLock(
      "users_bootstrap",
      async () => "done",
    );

    expect(result).toBe("done");
    expect(mockClientQuery).toHaveBeenCalledWith(
      "SELECT pg_advisory_lock($1)",
      [POSTGRES_LOCK_KEYS.users_bootstrap],
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      [POSTGRES_LOCK_KEYS.users_bootstrap],
    );
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it("releases the lock and the client when the callback throws", async () => {
    await expect(
      PostgresDbUtilsWithAdvisoryLock("auth_token", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(mockClientQuery).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      [POSTGRES_LOCK_KEYS.auth_token],
    );
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});

describe("PostgresDbUtils functional API", () => {
  beforeEach(async () => {
    setupFakeMetadataTable([99]);
    await PostgresDbUtilsInit(undefined as never, makeConfig(), "/sql");
    mockSpans.length = 0;
  });

  it("executes writes and returns the row count", async () => {
    functionalPool().query.mockResolvedValue({ rows: [], rowCount: 5 });

    const changes = await PostgresDbUtilsExecSQL(
      undefined,
      "UPDATE t SET c = $1",
      ["x"],
    );

    expect(changes).toBe(5);
    expect(functionalPool().query).toHaveBeenCalledWith(
      "UPDATE t SET c = $1",
      ["x"],
    );
    const execSpan = mockSpans.find(
      (span) => span.name === "PostgresDbUtilsExecSQL",
    );
    expect(execSpan.addEvent).toHaveBeenCalledWith("Impacted Rows: 5");
    expect(allSpansEnded()).toBe(true);
  });

  it("marks the span and rethrows on a failed write", async () => {
    functionalPool().query.mockRejectedValue(new Error("deadlock detected"));

    await expect(
      PostgresDbUtilsExecSQL(undefined, "UPDATE t SET c = $1", ["x"]),
    ).rejects.toThrow("deadlock detected");

    const execSpan = mockSpans.find(
      (span) => span.name === "PostgresDbUtilsExecSQL",
    );
    expect(execSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ message: "deadlock detected" }),
    );
    expect(allSpansEnded()).toBe(true);
  });

  it("executes reads and returns the rows", async () => {
    functionalPool().query.mockResolvedValue({
      rows: [{ id: 1 }],
      rowCount: 1,
    });

    const rows = await PostgresDbUtilsQuerySQL(undefined, "SELECT * FROM t");

    expect(rows).toEqual([{ id: 1 }]);
    expect(allSpansEnded()).toBe(true);
  });

  it("marks the span and rethrows on a failed read", async () => {
    functionalPool().query.mockRejectedValue(new Error("connection lost"));

    await expect(
      PostgresDbUtilsQuerySQL(undefined, "SELECT * FROM t"),
    ).rejects.toThrow("connection lost");

    const querySpan = mockSpans.find(
      (span) => span.name === "PostgresDbUtilsQuerySQL",
    );
    expect(querySpan.setStatus).toHaveBeenCalled();
    expect(mockModuleLogger.error).toHaveBeenCalled();
    expect(allSpansEnded()).toBe(true);
  });

  it("executes an entire SQL file and ends the span on failure", async () => {
    functionalPool().query.mockResolvedValue({ rows: [], rowCount: 0 });

    await PostgresDbUtilsExecSQLFile(undefined, "/sql/extra.sql");
    expect(functionalPool().query).toHaveBeenCalledWith("SQL:/sql/extra.sql");

    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await expect(
      PostgresDbUtilsExecSQLFile(undefined, "/sql/missing.sql"),
    ).rejects.toThrow("ENOENT");
    expect(allSpansEnded()).toBe(true);
  });

  it("starts and commits transactions", async () => {
    functionalPool().query.mockResolvedValue({ rows: [], rowCount: 0 });

    await PostgresDbUtilsTransactionStart(undefined);
    await PostgresDbUtilsTransactionCommit(undefined);

    const statements = functionalPool().query.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(statements).toEqual(["BEGIN", "COMMIT"]);
    expect(allSpansEnded()).toBe(true);
  });
});

describe("PostgresSchemaDbUtils", () => {
  it("creates the schema and applies migrations through a dedicated client", async () => {
    mockReaddir.mockResolvedValue(["init-0000.sql", "init-0001.sql"]);
    setupFakeMetadataTable([]);

    const schemaDb = new PostgresSchemaDbUtils("myschema");
    await schemaDb.initSchema(undefined as never, makeConfig(), "/sql");

    const schemaPool = mockCreatedPools[0];
    expect(schemaPool.config.max).toBe(5);
    expect(schemaPool.config.keepAlive).toBe(false);
    expect(schemaPool.config.options).toBe("-c search_path=myschema");
    // Migrations run on the dedicated client, not through the pool
    expect(schemaPool.query).not.toHaveBeenCalled();

    const statements = executedSql();
    expect(statements).toContain("CREATE SCHEMA IF NOT EXISTS myschema;");
    expect(statements).toContain("SET search_path TO myschema;");
    expect(statements).toContain("SQL:/sql/init-0000.sql");
    expect(statements).toContain("SQL:/sql/init-0001.sql");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(allSpansEnded()).toBe(true);
  });

  it("treats a missing metadata table as version 0", async () => {
    mockReaddir.mockResolvedValue(["init-0000.sql", "init-0001.sql"]);
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("MAX(CAST(value AS INTEGER))")) {
        throw new Error('relation "metadata" does not exist');
      }
      return { rows: [], rowCount: 0 };
    });

    const schemaDb = new PostgresSchemaDbUtils("myschema");
    await schemaDb.initSchema(undefined as never, makeConfig(), "/sql");

    expect(executedSql()).toContain("SQL:/sql/init-0001.sql");
    expect(allSpansEnded()).toBe(true);
  });

  it("uses the runtime pool by default and the schema pool on request", async () => {
    mockReaddir.mockResolvedValue([]);
    const schemaDb = new PostgresSchemaDbUtils("myschema");
    await schemaDb.initSchema(undefined as never, makeConfig(), "/sql");

    await expect(
      schemaDb.querySQL(undefined as never, "SELECT 1"),
    ).rejects.toThrow("Pool not initialized");

    mockCreatedPools[0].query.mockResolvedValue({
      rows: [{ one: 1 }],
      rowCount: 1,
    });
    await expect(
      schemaDb.querySQL(undefined as never, "SELECT 1", [], true),
    ).resolves.toEqual([{ one: 1 }]);

    schemaDb.initRuntimePool(makeConfig());
    const runtimePool = mockCreatedPools[1];
    expect(runtimePool.config.max).toBe(20);
    expect(runtimePool.config.options).toBe("-c search_path=myschema");
    runtimePool.query.mockResolvedValue({ rows: [{ two: 2 }], rowCount: 1 });

    await expect(schemaDb.querySQL(undefined as never, "SELECT 2")).resolves.toEqual(
      [{ two: 2 }],
    );

    runtimePool.query.mockResolvedValue({ rows: [], rowCount: 4 });
    await expect(
      schemaDb.execSQL(undefined as never, "UPDATE t SET x = $1", [1]),
    ).resolves.toBe(4);

    await schemaDb.closeAll();
    expect(mockCreatedPools[0].end).toHaveBeenCalled();
    expect(runtimePool.end).toHaveBeenCalled();
    expect(allSpansEnded()).toBe(true);
  });

  it("runs callbacks inside a transaction on a dedicated client", async () => {
    mockReaddir.mockResolvedValue([]);
    const schemaDb = new PostgresSchemaDbUtils("myschema");
    await schemaDb.initSchema(undefined as never, makeConfig(), "/sql");
    schemaDb.initRuntimePool(makeConfig());
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await schemaDb.transaction(undefined as never, async (client) => {
      await client.query("INSERT INTO t VALUES ($1)", [1]);
    });

    const statements = executedSql();
    expect(statements).toEqual([
      "BEGIN",
      "INSERT INTO t VALUES ($1)",
      "COMMIT",
    ]);
    expect(mockClientRelease).toHaveBeenCalledTimes(2);
    expect(allSpansEnded()).toBe(true);
  });

  it("rolls back and rethrows when the transaction callback fails", async () => {
    mockReaddir.mockResolvedValue([]);
    const schemaDb = new PostgresSchemaDbUtils("myschema");
    await schemaDb.initSchema(undefined as never, makeConfig(), "/sql");
    schemaDb.initRuntimePool(makeConfig());
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      schemaDb.transaction(undefined as never, async () => {
        throw new Error("constraint violation");
      }),
    ).rejects.toThrow("constraint violation");

    expect(executedSql()).toEqual(["BEGIN", "ROLLBACK"]);
    expect(mockClientRelease).toHaveBeenCalledTimes(2);
    expect(allSpansEnded()).toBe(true);
  });
});

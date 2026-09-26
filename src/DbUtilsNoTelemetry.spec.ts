import {
  DbUtilsNoTelemetryBatchInsert,
  DbUtilsNoTelemetryExecSQL,
  DbUtilsNoTelemetryQuerySQL,
} from "./DbUtilsNoTelemetry";


// Shared mock DB handle – defined BEFORE jest.mock factory so it's hoisted correctly.
// We use jest.fn() at module scope; the mock factory captures the same reference.
const mockPrepare = jest.fn((_sql: string) => ({
  run: jest.fn().mockReturnValue({ changes: 0 }),
  all: jest.fn().mockReturnValue([]),
}));
const mockQuery = jest.fn();
const mockDbHandle = { prepare: mockPrepare, query: mockQuery };

let currentDbType: "sqlite" | "postgres" = "sqlite";

jest.mock("./DbUtils", () => ({
  DbUtilsGetDatabase: jest.fn(() => mockDbHandle),
  DbUtilsGetType: jest.fn(() => currentDbType),
  convertToPostgresPlaceholders: jest.fn((sql: string) => {
    let idx = 1;
    return sql.replace(/\?/g, () => `$${idx++}`);
  }),
}));

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  ModuleLogger: jest.fn(),
  StandardLogger: jest.fn(),
}));

import * as DbUtilsNoTelemetryModule from "./DbUtilsNoTelemetry";

beforeAll(() => {
  const mockLogger = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  } as any;
  DbUtilsNoTelemetryModule.DbUtilsNoTelemetrySetLogger({
    createModuleLogger: () => mockLogger,
  } as any);
});

beforeEach(() => {
  jest.clearAllMocks();
  currentDbType = "sqlite";
});

describe("DbUtilsNoTelemetryBatchInsert", () => {
  it("returns 0 for empty rows", () => {
    const result = DbUtilsNoTelemetryBatchInsert("INTO t (c)", 1, []);
    expect(result).toBe(0);
  });

  it("generates correct multi-row VALUES SQL (sqlite)", () => {
    currentDbType = "sqlite";
    mockPrepare.mockReturnValue({
      run: jest.fn().mockReturnValue({ changes: 2 }),
      all: jest.fn(),
    } as any);

    const rows = [
      ["a1", "b1"],
      ["a2", "b2"],
    ];
    const result = DbUtilsNoTelemetryBatchInsert("INTO t (c1,c2)", 2, rows);
    expect(result).toBe(2);
  });

  it("chunks large inserts below the SQLite parameter limit", () => {
    currentDbType = "sqlite";
    const run = jest.fn((params: unknown[]) => ({
      changes: params.length / 9,
    }));
    mockPrepare.mockImplementation(
      () => ({ run, all: jest.fn() }) as any,
    );

    const rows = Array.from({ length: 7000 }, (_, rowIndex) =>
      Array.from({ length: 9 }, (_, colIndex) => `${rowIndex}-${colIndex}`),
    );
    const result = DbUtilsNoTelemetryBatchInsert(
      "INTO chunk_test (c1,c2,c3,c4,c5,c6,c7,c8,c9)",
      9,
      rows,
    );

    // floor(32766 / 9) = 3640 rows per chunk
    expect(result).toBe(7000);
    expect(run).toHaveBeenCalledTimes(2);
    const paramsPerCall = run.mock.calls.map((call) => call[0].length);
    expect(paramsPerCall).toEqual([3640 * 9, 3360 * 9]);
    const sqlPerCall = mockPrepare.mock.calls.map((call) => call[0]);
    expect(sqlPerCall[0].match(/\(\?/g)?.length).toBe(3640);
    expect(sqlPerCall[1].match(/\(\?/g)?.length).toBe(3360);
  });

  it("chunks large inserts below the Postgres parameter limit sequentially", async () => {
    currentDbType = "postgres";
    mockQuery.mockImplementation(
      (_sql: string, params: unknown[], cb: Function) => {
        cb(null, { rowCount: params.length / 9 });
      },
    );

    const rows = Array.from({ length: 8000 }, (_, rowIndex) =>
      Array.from({ length: 9 }, (_, colIndex) => `${rowIndex}-${colIndex}`),
    );
    const result = await DbUtilsNoTelemetryBatchInsert(
      "INTO chunk_test_pg (c1,c2,c3,c4,c5,c6,c7,c8,c9)",
      9,
      rows,
    );

    // floor(65535 / 9) = 7281 rows per chunk
    expect(result).toBe(8000);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const paramsPerCall = mockQuery.mock.calls.map(
      (call) => (call[1] as unknown[]).length,
    );
    expect(paramsPerCall).toEqual([7281 * 9, 719 * 9]);

    const firstSql = mockQuery.mock.calls[0][0] as string;
    expect(firstSql).toContain("$1");
    expect(firstSql).toContain(`$${7281 * 9}`);
    expect(firstSql).not.toContain("?");
  });
});

describe("DbUtilsNoTelemetryExecSQL (sqlite)", () => {
  beforeEach(() => {
    currentDbType = "sqlite";
  });

  it("resolves with changes count on success", () => {
    mockPrepare.mockReturnValue({
      run: jest.fn().mockReturnValue({ changes: 3 }),
      all: jest.fn(),
    } as any);

    const result = DbUtilsNoTelemetryExecSQL(
      "INSERT INTO no_telemetry_exec (c) VALUES (?)",
      ["x"],
    );
    expect(result).toBe(3);
  });

  it("prepares each distinct statement at most once", () => {
    const run = jest.fn().mockReturnValue({ changes: 1 });
    mockPrepare.mockReturnValue({ run, all: jest.fn() } as any);

    DbUtilsNoTelemetryExecSQL("UPDATE cache_target SET a = ?", [1]);
    DbUtilsNoTelemetryExecSQL("UPDATE cache_target SET a = ?", [2]);

    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("DbUtilsNoTelemetryExecSQL (postgres)", () => {
  beforeEach(() => {
    currentDbType = "postgres";
  });

  it("resolves with rowCount on success", async () => {
    mockQuery.mockImplementation(
      (_sql: string, _params: unknown[], cb: Function) => {
        cb(null, { rowCount: 5 });
      },
    );

    const result = await DbUtilsNoTelemetryExecSQL(
      "INSERT INTO t (c) VALUES (?)",
      ["x"],
    );
    expect(result).toBe(5);
  });

  it("rejects on error", async () => {
    mockQuery.mockImplementation(
      (_sql: string, _params: unknown[], cb: Function) => {
        cb(new Error("deadlock detected"));
      },
    );

    await expect(
      DbUtilsNoTelemetryExecSQL("INSERT INTO pg_fail (c) VALUES (?)", ["x"]),
    ).rejects.toThrow("deadlock detected");
  });
});

describe("DbUtilsNoTelemetryQuerySQL (sqlite)", () => {
  beforeEach(() => {
    currentDbType = "sqlite";
  });

  it("returns rows on success", () => {
    const expectedRows = [{ id: 1 }, { id: 2 }];
    mockPrepare.mockReturnValue({
      run: jest.fn(),
      all: jest.fn().mockReturnValue(expectedRows),
    } as any);

    const result = DbUtilsNoTelemetryQuerySQL("SELECT * FROM t");
    expect(result).toEqual(expectedRows);
  });
});

describe("DbUtilsNoTelemetryQuerySQL (postgres)", () => {
  beforeEach(() => {
    currentDbType = "postgres";
  });

  it("returns rows on success", async () => {
    const expectedRows = [{ id: 1 }, { id: 2 }];
    mockQuery.mockImplementation(
      (_sql: string, _params: unknown[], cb: Function) => {
        cb(null, { rows: expectedRows });
      },
    );

    const result = await DbUtilsNoTelemetryQuerySQL("SELECT * FROM t");
    expect(result).toEqual(expectedRows);
  });

  it("rejects on error", async () => {
    mockQuery.mockImplementation(
      (_sql: string, _params: unknown[], cb: Function) => {
        cb(new Error("connection lost"));
      },
    );

    await expect(DbUtilsNoTelemetryQuerySQL("SELECT * FROM t")).rejects.toThrow(
      "connection lost",
    );
  });
});

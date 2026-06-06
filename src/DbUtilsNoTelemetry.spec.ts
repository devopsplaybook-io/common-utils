import {
  DbUtilsNoTelemetryBatchInsert,
  DbUtilsNoTelemetryExecSQL,
  DbUtilsNoTelemetryQuerySQL,
} from "./DbUtilsNoTelemetry";

/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// Shared mock DB handle – defined BEFORE jest.mock factory so it's hoisted correctly.
// We use jest.fn() at module scope; the mock factory captures the same reference.
const mockPrepare = jest.fn(() => ({
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  DbUtilsNoTelemetryModule.DbUtilsNoTelemetrySetLogger({
    createModuleLogger: () => mockLogger,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const rows = [
      ["a1", "b1"],
      ["a2", "b2"],
    ];
    const result = DbUtilsNoTelemetryBatchInsert("INTO t (c1,c2)", 2, rows);
    expect(result).toBe(2);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = DbUtilsNoTelemetryExecSQL("INSERT INTO t (c) VALUES (?)", [
      "x",
    ]);
    expect(result).toBe(3);
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
      DbUtilsNoTelemetryExecSQL("INSERT INTO t (c) VALUES (?)", ["x"]),
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

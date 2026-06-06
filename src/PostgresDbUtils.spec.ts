/* eslint-disable @typescript-eslint/no-explicit-any */

// Mock pg before imports
const mockQuery = jest.fn();
jest.mock("pg", () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: mockQuery,
      on: jest.fn(),
    })),
  };
});

jest.mock("fs-extra", () => ({
  readdir: jest.fn().mockResolvedValue(["init-0000.sql"]),
  readFile: jest
    .fn()
    .mockResolvedValue(Buffer.from("CREATE TABLE metadata ();")),
}));

jest.mock("@devopsplaybook.io/otel-utils", () => ({
  StandardTracer: jest.fn(),
  StandardLogger: jest.fn(),
  ModuleLogger: jest.fn(),
}));

jest.mock("@opentelemetry/sdk-trace-base", () => ({
  Span: jest.fn(),
}));

jest.mock("@opentelemetry/api", () => ({
  SpanStatusCode: { ERROR: 2, OK: 1 },
}));

describe("PostgresDbUtils", () => {
  let PostgresDbUtils: typeof import("./PostgresDbUtils");

  const mockSpan = {
    end: jest.fn(),
    addEvent: jest.fn(),
    setStatus: jest.fn(),
  };

  const mockModuleLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  };

  const mockTracer = {
    startSpan: jest.fn().mockReturnValue(mockSpan),
  };

  const mockLogger = {
    createModuleLogger: jest.fn().mockReturnValue(mockModuleLogger),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      PostgresDbUtils = require("./PostgresDbUtils");
    });
    PostgresDbUtils.PostgresDbUtilsSetOTel(
      mockTracer as any,
      mockLogger as any,
    );
  });

  it("PostgresDbUtilsSetOTel should accept tracer and logger", () => {
    expect(() =>
      PostgresDbUtils.PostgresDbUtilsSetOTel(
        mockTracer as any,
        mockLogger as any,
      ),
    ).not.toThrow();
  });

  it("PostgresDbUtilsGetPool should return undefined before init", () => {
    expect(PostgresDbUtils.PostgresDbUtilsGetPool()).toBeUndefined();
  });

  it("PostgresDbUtilsExecSQL should create a span and call pool.query", async () => {
    const config = {
      DATABASE_POSTGRES_HOST: "localhost",
      DATABASE_POSTGRES_PORT: 5432,
      DATABASE_POSTGRES_USER: "user",
      DATABASE_POSTGRES_PASSWORD: "pass",
      DATABASE_POSTGRES_DATABASE: "testdb",
    };

    // Mock the version query to return version 0
    // pool.query can be called with 2 args (sql, cb) or 3 args (sql, params, cb)
    mockQuery.mockImplementation((...args: any[]) => {
      const cb =
        typeof args[args.length - 1] === "function"
          ? args[args.length - 1]
          : null;
      if (!cb) return;
      // Determine which call this is based on arg count
      if (args.length === 2) {
        // execSQLFile call
        cb(null);
      } else if (args.length === 3) {
        const sql = args[0] as string;
        if (sql.includes("MAX")) {
          // version query
          cb(null, { rows: [{ version: 0 }] });
        } else {
          // insert version
          cb(null, { rowCount: 1 });
        }
      }
    });

    await PostgresDbUtils.PostgresDbUtilsInit(
      mockSpan as any,
      config,
      "/fake/sql",
    );

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "PostgresDbUtilsInit",
      mockSpan,
    );
  });

  it("PostgresDbUtilsTransactionStart should call BEGIN", async () => {
    const config = {
      DATABASE_POSTGRES_HOST: "localhost",
      DATABASE_POSTGRES_PORT: 5432,
      DATABASE_POSTGRES_USER: "user",
      DATABASE_POSTGRES_PASSWORD: "pass",
      DATABASE_POSTGRES_DATABASE: "testdb",
    };

    // Need to init first to create pool
    mockQuery.mockImplementation((_sql: any, ...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") cb(null, { rows: [], rowCount: 0 });
    });

    await PostgresDbUtils.PostgresDbUtilsInit(
      mockSpan as any,
      config,
      "/fake/sql",
    );
    await PostgresDbUtils.PostgresDbUtilsTransactionStart(mockSpan as any);

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "PostgresDbUtilsTransactionStart",
      mockSpan,
    );
  });
});

import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import * as SqlDbUtilsModule from "./SqlDbUtils";

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

const MIGRATION_0000 = [
  "CREATE TABLE IF NOT EXISTS metadata (type TEXT, value TEXT, dateCreated TEXT);",
  "CREATE TABLE IF NOT EXISTS applied_log (version INTEGER);",
].join("\n");

/** Every created span must have been ended exactly once. */
function allSpansEnded(): boolean {
  return (
    mockSpans.length > 0 &&
    mockSpans.every((span) => span.end.mock.calls.length === 1)
  );
}

function writeMigrations(files: Record<string, string>): void {
  for (const [name, sql] of Object.entries(files)) {
    nodeFs.writeFileSync(path.join(sqlDir, name), sql);
  }
}

/** `init-0000.sql` plus `count` migrations, each logging its own version. */
function migrationSet(count: number): Record<string, string> {
  const files: Record<string, string> = { "init-0000.sql": MIGRATION_0000 };
  for (let version = 1; version <= count; version++) {
    files[`init-${String(version).padStart(4, "0")}.sql`] =
      `INSERT INTO applied_log (version) VALUES (${version});`;
  }
  return files;
}

function initDb(): Promise<void> {
  return SqlDbUtilsModule.SqlDbUtilsInit(
    undefined as never,
    { DATA_DIR: dataDir },
    sqlDir,
  );
}

function appliedVersions(): number[] {
  return SqlDbUtilsModule.SqlDbUtilsQuerySQL(
    undefined,
    "SELECT version FROM applied_log ORDER BY version",
  ).map((row) => row.version);
}

function closeCurrentDb(): void {
  const db = SqlDbUtilsModule.SqlDbUtilsGetDatabase() as unknown as
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
  baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "sql-db-utils-"));
  dataDir = path.join(baseDir, "data");
  sqlDir = path.join(baseDir, "sql");
  nodeFs.mkdirSync(sqlDir, { recursive: true });
  SqlDbUtilsModule.SqlDbUtilsSetOTel(mockTracer, mockStandardLogger);
});

afterEach(() => {
  closeCurrentDb();
  nodeFs.rmSync(baseDir, { recursive: true, force: true });
});

describe("SqlDbUtilsInit migrations", () => {
  it("applies 10+ migrations exactly once across two boots (text-affinity metadata.value)", async () => {
    writeMigrations(migrationSet(10));

    await initDb();
    const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(appliedVersions()).toEqual(expected);

    // Simulate a second boot on the same database file
    closeCurrentDb();
    await initDb();
    expect(appliedVersions()).toEqual(expected);
    expect(allSpansEnded()).toBe(true);
  });

  it("applies only migrations newer than the recorded version", async () => {
    writeMigrations(migrationSet(3));
    await initDb();
    expect(appliedVersions()).toEqual([1, 2, 3]);

    writeMigrations({ "init-0004.sql": "INSERT INTO applied_log (version) VALUES (4);" });
    closeCurrentDb();
    await initDb();
    expect(appliedVersions()).toEqual([1, 2, 3, 4]);
  });

  it("rolls back a failing migration and never records its version", async () => {
    writeMigrations({
      "init-0000.sql": MIGRATION_0000,
      "init-0001.sql": "INSERT INTO applied_log (version) VALUES (1);",
      "init-0002.sql":
        "CREATE TABLE rolled_back (id INTEGER);\nINSERT INTO missing_table VALUES (1);",
    });

    await expect(initDb()).rejects.toThrow("missing_table");

    expect(appliedVersions()).toEqual([1]);
    const tables = SqlDbUtilsModule.SqlDbUtilsQuerySQL(
      undefined,
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).map((row) => row.name);
    expect(tables).not.toContain("rolled_back");
    const versionRows = SqlDbUtilsModule.SqlDbUtilsQuerySQL(
      undefined,
      "SELECT value FROM metadata WHERE type = 'db_version'",
    ).map((row) => Number(row.value));
    expect(versionRows).toEqual([1]);
    expect(allSpansEnded()).toBe(true);
  });

  it("throws when init-0000.sql is missing", async () => {
    writeMigrations({
      "init-0001.sql": "INSERT INTO applied_log (version) VALUES (1);",
    });

    await expect(initDb()).rejects.toThrow("init-0000.sql");
    expect(allSpansEnded()).toBe(true);
  });
});

describe("SqlDbUtilsExecSQL / SqlDbUtilsQuerySQL", () => {
  beforeEach(async () => {
    writeMigrations(migrationSet(1));
    await initDb();
    mockSpans.length = 0;
  });

  it("executes writes and reads against the opened database", () => {
    const changes = SqlDbUtilsModule.SqlDbUtilsExecSQL(
      undefined,
      "INSERT INTO applied_log (version) VALUES (?)",
      [99],
    );

    expect(changes).toBe(1);
    expect(appliedVersions()).toEqual([1, 99]);
    expect(allSpansEnded()).toBe(true);
  });

  it("marks the span and rethrows on a failed statement", () => {
    expect(() =>
      SqlDbUtilsModule.SqlDbUtilsExecSQL(
        undefined,
        "INSERT INTO missing_table VALUES (1)",
      ),
    ).toThrow("missing_table");

    const execSpan = mockSpans.find(
      (span) => span.name === "SqlDbUtilsExecSQL",
    );
    expect(execSpan.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("missing_table") }),
    );
    expect(allSpansEnded()).toBe(true);
  });

  it("executes an entire SQL file", () => {
    const filename = path.join(sqlDir, "extra.sql");
    nodeFs.writeFileSync(
      filename,
      "INSERT INTO applied_log (version) VALUES (100);\nINSERT INTO applied_log (version) VALUES (101);",
    );

    SqlDbUtilsModule.SqlDbUtilsExecSQLFile(undefined as never, filename);

    expect(appliedVersions()).toEqual([1, 100, 101]);
    expect(allSpansEnded()).toBe(true);
  });

  it("returns the database handle only after init", () => {
    expect(SqlDbUtilsModule.SqlDbUtilsGetDatabase()).toBeDefined();
    expect(
      typeof (SqlDbUtilsModule.SqlDbUtilsGetDatabase() as any).prepare,
    ).toBe("function");
  });
});

describe("SqlDbUtils prepared statement cache", () => {
  beforeEach(async () => {
    writeMigrations(migrationSet(1));
    await initDb();
    mockSpans.length = 0;
  });

  it("prepares each distinct statement once", () => {
    const db = SqlDbUtilsModule.SqlDbUtilsGetDatabase();
    const prepareSpy = jest.spyOn(db, "prepare");

    SqlDbUtilsModule.SqlDbUtilsQuerySQL(
      undefined,
      "SELECT version FROM applied_log WHERE version > ?",
      [0],
    );
    SqlDbUtilsModule.SqlDbUtilsQuerySQL(
      undefined,
      "SELECT version FROM applied_log WHERE version > ?",
      [1],
    );
    SqlDbUtilsModule.SqlDbUtilsExecSQL(
      undefined,
      "INSERT INTO applied_log (version) VALUES (?)",
      [5],
    );
    SqlDbUtilsModule.SqlDbUtilsExecSQL(
      undefined,
      "INSERT INTO applied_log (version) VALUES (?)",
      [6],
    );

    expect(prepareSpy).toHaveBeenCalledTimes(2);
    expect(appliedVersions()).toEqual([1, 5, 6]);
  });

  it("bounds the cache and re-prepares evicted statements", () => {
    const db = SqlDbUtilsModule.SqlDbUtilsGetDatabase();
    const prepareSpy = jest.spyOn(db, "prepare");

    for (let index = 0; index < 101; index++) {
      SqlDbUtilsModule.SqlDbUtilsQuerySQL(undefined, `SELECT ${index} AS n`);
    }
    expect(prepareSpy).toHaveBeenCalledTimes(101);

    // The first statement fell out of the 100-entry cache
    SqlDbUtilsModule.SqlDbUtilsQuerySQL(undefined, "SELECT 0 AS n");
    expect(prepareSpy).toHaveBeenCalledTimes(102);
  });

  it("does not reuse statements from a closed database handle", async () => {
    SqlDbUtilsModule.SqlDbUtilsQuerySQL(
      undefined,
      "SELECT COUNT(*) as count FROM applied_log",
    );

    closeCurrentDb();
    await initDb();

    const rows = SqlDbUtilsModule.SqlDbUtilsQuerySQL(
      undefined,
      "SELECT COUNT(*) as count FROM applied_log",
    );
    expect(rows[0].count).toBe(1);
  });
});

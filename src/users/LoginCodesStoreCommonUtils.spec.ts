import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { DbUtilsGetDatabase, DbUtilsInit, DbUtilsSetOTel } from "../DbUtils";
import { registerLoginCodesStoreConformance } from "./LoginCodesTesting";
import {
  LOGIN_CODES_DDL_POSTGRES,
  LOGIN_CODES_DDL_SQLITE,
  LOGIN_CODES_TABLE,
  createLoginCodesStoreCommonUtils,
} from "./LoginCodesStoreCommonUtils";

const mockTracer = {
  startSpan: jest.fn(() => ({
    end: jest.fn(),
    addEvent: jest.fn(),
    setAttributes: jest.fn(),
    setStatus: jest.fn(),
  })),
} as unknown as StandardTracer;

const mockModuleLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockStandardLogger = {
  createModuleLogger: jest.fn(() => mockModuleLogger),
} as unknown as StandardLogger;

const METADATA_DDL =
  "CREATE TABLE IF NOT EXISTS metadata (type TEXT, value TEXT, dateCreated TEXT);";

let baseDir: string;

async function initDb(includeLoginCodesTable: boolean): Promise<void> {
  baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "login-codes-store-"));
  const dataDir = path.join(baseDir, "data");
  const sqlDir = path.join(baseDir, "sql");
  nodeFs.mkdirSync(sqlDir, { recursive: true });
  nodeFs.writeFileSync(
    path.join(sqlDir, "init-0000.sql"),
    [
      METADATA_DDL,
      includeLoginCodesTable ? LOGIN_CODES_DDL_SQLITE : "",
    ].join("\n"),
  );

  DbUtilsSetOTel(mockTracer, mockStandardLogger);
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
  nodeFs.rmSync(baseDir, { recursive: true, force: true });
}

describe("createLoginCodesStoreCommonUtils", () => {
  beforeEach(async () => {
    await initDb(true);
  });

  afterEach(() => {
    closeCurrentDb();
  });

  it("documents the table name and a backend-agnostic DDL", () => {
    expect(LOGIN_CODES_TABLE).toBe("users_login_codes");
    expect(LOGIN_CODES_DDL_POSTGRES).toBe(LOGIN_CODES_DDL_SQLITE);
    expect(LOGIN_CODES_DDL_SQLITE).toContain(
      'CREATE TABLE IF NOT EXISTS "users_login_codes"',
    );
    expect(LOGIN_CODES_DDL_SQLITE).toContain(
      '"requestTokenHash" TEXT NOT NULL UNIQUE',
    );
    expect(LOGIN_CODES_DDL_SQLITE).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "users_login_codes_code_hash"',
    );
  });

  it("reports availability for the migrated table", async () => {
    const store = createLoginCodesStoreCommonUtils();
    await expect(store.available()).resolves.toBe(true);
  });

  it("returns null for unknown hashes and zero cleanup rows", async () => {
    const store = createLoginCodesStoreCommonUtils();
    await expect(store.getByRequestTokenHash("missing")).resolves.toBeNull();
    await expect(store.getByCodeHash("missing")).resolves.toBeNull();
    await expect(
      store.cleanup({ olderThan: "2000-01-01T00:00:00.000Z", limit: 10 }),
    ).resolves.toBe(0);
  });

  registerLoginCodesStoreConformance(
    {
      describe,
      it: it as unknown as (
        name: string,
        callback: () => Promise<void> | void,
      ) => void,
    },
    { createStore: () => createLoginCodesStoreCommonUtils() },
  );
});

describe("createLoginCodesStoreCommonUtils without the migration", () => {
  beforeEach(async () => {
    await initDb(false);
  });

  afterEach(() => {
    closeCurrentDb();
  });

  it("answers available:false and caches the missing table", async () => {
    const store = createLoginCodesStoreCommonUtils();
    await expect(store.available()).resolves.toBe(false);
    await expect(store.available()).resolves.toBe(false);
  });
});

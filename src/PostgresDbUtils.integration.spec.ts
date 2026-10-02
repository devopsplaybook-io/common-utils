import { execSync } from "child_process";
import * as nodeFs from "fs";
import * as os from "os";
import * as path from "path";
import { Pool } from "pg";
import { StandardLogger, StandardTracer } from "@devopsplaybook.io/otel-utils";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  PostgresDbConfig,
  PostgresDbUtilsExecSQL,
  PostgresDbUtilsGetPool,
  PostgresDbUtilsInit,
  PostgresDbUtilsQuerySQL,
  PostgresDbUtilsSetOTel,
  PostgresDbUtilsWithAdvisoryLock,
  PostgresSchemaDbUtils,
} from "./PostgresDbUtils";

/**
 * Integration tests against a real PostgreSQL server
 * (`postgres:18` in a testcontainers container).
 *
 * Skipped when Docker is not available (e.g. local sandboxes); the GitHub
 * Actions runners provide Docker, so the suite runs in CI.
 */

jest.setTimeout(180_000);

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithDocker = dockerAvailable() ? describe : describe.skip;

const mockTracer = {
  startSpan: () => ({
    end: () => undefined,
    setStatus: () => undefined,
    addEvent: () => undefined,
  }),
} as unknown as StandardTracer;

const mockStandardLogger = {
  createModuleLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
} as unknown as StandardLogger;

const MIGRATION_0000 = [
  'CREATE TABLE IF NOT EXISTS metadata ("type" TEXT, "value" TEXT, "dateCreated" TEXT);',
  "CREATE TABLE IF NOT EXISTS applied_log (version INTEGER);",
].join("\n");

let container: StartedPostgreSqlContainer;
let baseDir: string;
let sqlDir: string;

function makeConfig(): PostgresDbConfig {
  return {
    DATABASE_POSTGRES_HOST: container.getHost(),
    DATABASE_POSTGRES_PORT: container.getPort(),
    DATABASE_POSTGRES_USER: container.getUsername(),
    DATABASE_POSTGRES_PASSWORD: container.getPassword(),
    DATABASE_POSTGRES_DATABASE: container.getDatabase(),
  };
}

function writeMigration(name: string, sql: string): void {
  nodeFs.writeFileSync(path.join(sqlDir, name), sql);
}

/** `init-0000.sql` plus `count` migrations, each logging its own version. */
function writeMigrationSet(count: number): void {
  writeMigration("init-0000.sql", MIGRATION_0000);
  for (let version = 1; version <= count; version++) {
    writeMigration(
      `init-${String(version).padStart(4, "0")}.sql`,
      `INSERT INTO applied_log (version) VALUES (${version});`,
    );
  }
}

async function appliedVersions(): Promise<number[]> {
  const rows = await PostgresDbUtilsQuerySQL(
    undefined,
    "SELECT version FROM applied_log ORDER BY version",
  );
  return rows.map((row) => Number(row.version));
}

async function endCurrentPool(): Promise<void> {
  const currentPool = PostgresDbUtilsGetPool();
  if (currentPool) {
    await currentPool.end().catch(() => undefined);
  }
}

/**
 * Drop and recreate the schemas used by the tests. The container hosts one
 * database shared by the whole file and applied migration versions persist in
 * `metadata`, so without this a later test's migration set (different files
 * under the same version numbers) would be skipped as "already applied".
 */
async function resetDatabase(): Promise<void> {
  const resetPool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
  });
  try {
    await resetPool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; " +
        "DROP SCHEMA IF EXISTS integration_app CASCADE;",
    );
  } finally {
    await resetPool.end();
  }
}

describeWithDocker("PostgresDbUtils integration (real PostgreSQL)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18").start();
    PostgresDbUtilsSetOTel(mockTracer, mockStandardLogger);
  });

  afterAll(async () => {
    await endCurrentPool();
    await container?.stop();
  });

  beforeEach(async () => {
    await resetDatabase();
    baseDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "pg-integration-"));
    sqlDir = path.join(baseDir, "sql");
    nodeFs.mkdirSync(sqlDir, { recursive: true });
  });

  afterEach(async () => {
    await endCurrentPool();
    nodeFs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("applies migrations in numeric order and is idempotent across re-inits", async () => {
    writeMigrationSet(10);

    await PostgresDbUtilsInit(undefined as never, makeConfig(), sqlDir);
    expect(await appliedVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // A second boot on the same database re-applies nothing.
    await endCurrentPool();
    await PostgresDbUtilsInit(undefined as never, makeConfig(), sqlDir);
    expect(await appliedVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("rolls back a failing migration and applies it after the file is fixed", async () => {
    writeMigration("init-0000.sql", MIGRATION_0000);
    writeMigration("init-0001.sql", "INSERT INTO applied_log (version) VALUES (1);");
    writeMigration(
      "init-0002.sql",
      "CREATE TABLE rolled_back (id INTEGER);\nINSERT INTO missing_table VALUES (1);",
    );

    await expect(
      PostgresDbUtilsInit(undefined as never, makeConfig(), sqlDir),
    ).rejects.toThrow("missing_table");

    expect(await appliedVersions()).toEqual([1]);
    const rolledBack = await PostgresDbUtilsQuerySQL(
      undefined,
      "SELECT to_regclass('public.rolled_back') AS table_name",
    );
    expect(rolledBack[0].table_name).toBeNull();
    await endCurrentPool();

    // Fix the migration and boot again: the version is recorded exactly once.
    writeMigration(
      "init-0002.sql",
      "CREATE TABLE rolled_back (id INTEGER);\nINSERT INTO applied_log (version) VALUES (2);",
    );
    await PostgresDbUtilsInit(undefined as never, makeConfig(), sqlDir);
    expect(await appliedVersions()).toEqual([1, 2]);
  });

  it("round-trips writes and reads with bound parameters", async () => {
    writeMigration("init-0000.sql", MIGRATION_0000);
    writeMigration(
      "init-0001.sql",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL);",
    );
    await PostgresDbUtilsInit(undefined as never, makeConfig(), sqlDir);

    const changes = await PostgresDbUtilsExecSQL(
      undefined,
      "INSERT INTO items (name) VALUES ($1), ($2)",
      ["first", "second"],
    );
    expect(changes).toBe(2);

    const rows = await PostgresDbUtilsQuerySQL(
      undefined,
      "SELECT name FROM items ORDER BY id",
    );
    expect(rows.map((row) => row.name)).toEqual(["first", "second"]);
  });

  it("serialises concurrent callbacks on the advisory lock", async () => {
    writeMigration("init-0000.sql", MIGRATION_0000);
    await PostgresDbUtilsInit(undefined as never, makeConfig(), sqlDir);

    const events: string[] = [];
    const run = (name: string) =>
      PostgresDbUtilsWithAdvisoryLock("users_bootstrap", async () => {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 150));
        events.push(`${name}:end`);
      });

    await Promise.all([run("a"), run("b")]);

    // The two callbacks must not interleave: each start is immediately
    // followed by its own end.
    expect(events).toHaveLength(4);
    expect(events[0].split(":")[0]).toBe(events[1].split(":")[0]);
    expect(events[2].split(":")[0]).toBe(events[3].split(":")[0]);
    expect(new Set(events.map((event) => event.split(":")[0]))).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("initialises a schema, applies migrations and serves both pools", async () => {
    writeMigration("init-0000.sql", MIGRATION_0000);
    writeMigration(
      "init-0001.sql",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL);",
    );

    const schemaDb = new PostgresSchemaDbUtils("integration_app");
    await schemaDb.initSchema(undefined as never, makeConfig(), sqlDir);

    const inserted = await schemaDb.execSQL(
      undefined as never,
      "INSERT INTO items (name) VALUES ($1)",
      ["via schema pool"],
      true,
    );
    expect(inserted).toBe(1);

    const extraFile = path.join(sqlDir, "extra.sql");
    nodeFs.writeFileSync(extraFile, "INSERT INTO items (name) VALUES ('via file');");
    await schemaDb.execSQLFile(undefined as never, extraFile, true);

    const schemaRows = await schemaDb.querySQL(
      undefined as never,
      "SELECT name FROM items ORDER BY id",
      [],
      true,
    );
    expect(schemaRows.map((row) => row.name)).toEqual([
      "via schema pool",
      "via file",
    ]);

    await schemaDb.initRuntimePool(makeConfig(), "integration_app");
    const runtimeRows = await schemaDb.querySQL(
      undefined as never,
      "SELECT COUNT(*)::int AS count FROM items",
    );
    expect(runtimeRows[0].count).toBe(2);

    await schemaDb.closeAll();
  });
});

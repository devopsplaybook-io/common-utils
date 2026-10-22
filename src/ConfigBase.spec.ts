import * as fse from "fs-extra";
import * as path from "path";
import * as os from "os";

jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import { ConfigBase } from "./ConfigBase";
import { DbUtilsInit } from "./DbUtils";

/** Concrete subclass for testing. */
class TestConfig extends ConfigBase {
  public MY_SETTING = "default_value";
  public SECRET_KEY = "secret_default";

  constructor(configFile?: string) {
    super("test-service", configFile);
    this.addConfigField({ field: "MY_SETTING" });
    this.addConfigField({ field: "SECRET_KEY", sensitive: true });
  }
}

describe("ConfigBase", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fse.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    configPath = path.join(tmpDir, "config.json");
  });

  afterEach(() => {
    fse.removeSync(tmpDir);
    // Clean up env vars that tests may have set
    delete process.env.MY_SETTING;
    delete process.env.SECRET_KEY;
    delete process.env.LOG_LEVEL;
    delete process.env.DATA_DIR;
    delete process.env.VERSION;
    delete process.env.SERVICE_ID;
    delete process.env.API_PORT;
    delete process.env.DATABASE_POSTGRES_PORT;
    delete process.env.DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS;
    delete process.env.OPENTELEMETRY_COLLECTOR_AWS;
    delete process.env.AUTH_RATE_LIMIT_LOGIN_MAX;
    delete process.env.AUTH_RATE_LIMIT_REFRESH_MAX;
    delete process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS;
    delete process.env.PASSWORD_MIN_LENGTH;
    delete process.env.API_TOKENS_REVOKE_ON_PASSWORD_CHANGE;
    delete process.env.DATABASE_SQLITE_JOURNAL_MODE;
    delete process.env.DATABASE_SQLITE_BUSY_TIMEOUT_MS;
    delete process.env.DATABASE_SQLITE_FOREIGN_KEYS;
  });

  it("should initialise with default values", () => {
    const config = new TestConfig(configPath);
    expect(config.SERVICE_ID).toBe("test-service");
    expect(config.MY_SETTING).toBe("default_value");
    expect(config.SECRET_KEY).toBe("secret_default");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DATABASE_TYPE).toBe("sqlite");
  });

  it("should default JWT_KEY to empty (DB-managed) and rate limits to 10/60/60", () => {
    const config = new TestConfig(configPath);
    expect(config.JWT_KEY).toBe("");
    expect(config.AUTH_RATE_LIMIT_LOGIN_MAX).toBe(10);
    expect(config.AUTH_RATE_LIMIT_REFRESH_MAX).toBe(60);
    expect(config.AUTH_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(config.PASSWORD_MIN_LENGTH).toBe(0);
    expect(config.API_TOKENS_REVOKE_ON_PASSWORD_CHANGE).toBe(false);
  });

  it("should load the password policy and SQLite pragma settings", async () => {
    process.env.PASSWORD_MIN_LENGTH = "12";
    process.env.API_TOKENS_REVOKE_ON_PASSWORD_CHANGE = "true";
    process.env.DATABASE_SQLITE_JOURNAL_MODE = "wal";
    process.env.DATABASE_SQLITE_BUSY_TIMEOUT_MS = "2500";
    process.env.DATABASE_SQLITE_FOREIGN_KEYS = "yes";
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.PASSWORD_MIN_LENGTH).toBe(12);
    expect(config.API_TOKENS_REVOKE_ON_PASSWORD_CHANGE).toBe(true);
    expect(config.DATABASE_SQLITE_JOURNAL_MODE).toBe("wal");
    expect(config.DATABASE_SQLITE_BUSY_TIMEOUT_MS).toBe(2500);
    expect(config.DATABASE_SQLITE_FOREIGN_KEYS).toBe(true);
  });

  it("should load the rate-limit settings from the environment", async () => {
    process.env.AUTH_RATE_LIMIT_LOGIN_MAX = "5";
    process.env.AUTH_RATE_LIMIT_REFRESH_MAX = "30";
    process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "120";
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.AUTH_RATE_LIMIT_LOGIN_MAX).toBe(5);
    expect(config.AUTH_RATE_LIMIT_REFRESH_MAX).toBe(30);
    expect(config.AUTH_RATE_LIMIT_WINDOW_SECONDS).toBe(120);
  });

  it("should load values from config.json", async () => {
    fse.writeJsonSync(configPath, {
      MY_SETTING: "from_file",
      LOG_LEVEL: "debug",
    });
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.MY_SETTING).toBe("from_file");
    expect(config.LOG_LEVEL).toBe("debug");
  });

  it("should prefer environment variables over config.json", async () => {
    fse.writeJsonSync(configPath, {
      MY_SETTING: "from_file",
    });
    process.env.MY_SETTING = "from_env";
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.MY_SETTING).toBe("from_env");
  });

  it("should mask sensitive fields in log output", async () => {
    const logs: string[] = [];
    const config = new TestConfig(configPath);
    await config.reload((msg) => logs.push(msg));
    const secretLog = logs.find((l) => l.includes("SECRET_KEY"));
    expect(secretLog).toContain("********************");
    expect(secretLog).not.toContain("secret_default");
  });

  it("should not mask non-sensitive fields in log output", async () => {
    const logs: string[] = [];
    const config = new TestConfig(configPath);
    await config.reload((msg) => logs.push(msg));
    const settingLog = logs.find((l) => l.includes("MY_SETTING"));
    expect(settingLog).toContain("default_value");
  });

  it("should survive missing config.json gracefully", async () => {
    const config = new TestConfig("/nonexistent/path/config.json");
    await config.reload();
    // Should keep defaults
    expect(config.MY_SETTING).toBe("default_value");
  });

  it("should register additional fields via addConfigField", async () => {
    fse.writeJsonSync(configPath, { MY_SETTING: "updated" });
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.MY_SETTING).toBe("updated");
  });

  it("should handle DATABASE_TYPE field", async () => {
    fse.writeJsonSync(configPath, { DATABASE_TYPE: "postgres" });
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.DATABASE_TYPE).toBe("postgres");
  });

  it("should report the library version from its own package.json", () => {
    const config = new TestConfig(configPath);
    const pkg = fse.readJsonSync(path.resolve(__dirname, "../package.json"));
    expect(pkg.name).toBe("@devopsplaybook.io/common-utils");
    expect(config.VERSION).toBe(pkg.version);
  });

  it("should allow overriding VERSION and SERVICE_ID from the environment", async () => {
    process.env.VERSION = "9.9.9";
    process.env.SERVICE_ID = "other-service";
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.VERSION).toBe("9.9.9");
    expect(config.SERVICE_ID).toBe("other-service");
  });

  it("should allow overriding VERSION and SERVICE_ID from the config file", async () => {
    fse.writeJsonSync(configPath, {
      VERSION: "8.8.8",
      SERVICE_ID: "file-service",
    });
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.VERSION).toBe("8.8.8");
    expect(config.SERVICE_ID).toBe("file-service");
  });

  it("should coerce config-file string values to the default value type", async () => {
    fse.writeJsonSync(configPath, {
      API_PORT: "9090",
      DATABASE_POSTGRES_PORT: "5433",
      DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS: "30000",
      OPENTELEMETRY_COLLECTOR_AWS: "true",
    });
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.API_PORT).toBe(9090);
    expect(config.DATABASE_POSTGRES_PORT).toBe(5433);
    expect(config.DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS).toBe(30000);
    expect(config.OPENTELEMETRY_COLLECTOR_AWS).toBe(true);
  });

  it("should keep already-typed config-file values unchanged", async () => {
    fse.writeJsonSync(configPath, { API_PORT: 7070 });
    const config = new TestConfig(configPath);
    await config.reload();
    expect(config.API_PORT).toBe(7070);
    expect(Number.isInteger(config.API_PORT)).toBe(true);
  });

  it("should disable the Postgres pool timeouts by default", () => {
    const config = new TestConfig(configPath);
    expect(config.DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS).toBe(0);
    expect(config.DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(0);
  });

  it("should reject an unsupported DATABASE_TYPE at database init", async () => {
    const config = new TestConfig(configPath);
    (config as any).DATABASE_TYPE = "mysql";
    await expect(
      DbUtilsInit(undefined as never, config as never, "/sql"),
    ).rejects.toThrow('Invalid DATABASE_TYPE: mysql');
  });
});

describe("ConfigBase: strict coercion and field registration", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fse.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    configPath = path.join(tmpDir, "config.json");
  });

  afterEach(() => {
    fse.removeSync(tmpDir);
    delete process.env.OPENTELEMETRY_COLLECTOR_AWS;
    delete process.env.API_PORT;
    delete process.env.JWT_KEY;
  });

  it("parses boolean environment values case-insensitively", async () => {
    for (const [raw, expected] of [
      ["TRUE", true],
      ["Yes", true],
      ["0", false],
      ["NO", false],
    ] as const) {
      process.env.OPENTELEMETRY_COLLECTOR_AWS = raw;
      const config = new TestConfig(configPath);
      await config.reload();
      expect(config.OPENTELEMETRY_COLLECTOR_AWS).toBe(expected);
    }
  });

  it("rejects an invalid boolean with a clear startup error", async () => {
    process.env.OPENTELEMETRY_COLLECTOR_AWS = "maybe";
    const config = new TestConfig(configPath);
    await expect(config.reload()).rejects.toThrow(
      "Invalid boolean value for OPENTELEMETRY_COLLECTOR_AWS",
    );
  });

  it("rejects an invalid number with a clear startup error", async () => {
    process.env.API_PORT = "eighty";
    const config = new TestConfig(configPath);
    await expect(config.reload()).rejects.toThrow(
      "Invalid numeric value for API_PORT",
    );
  });

  it("keeps a base field sensitive when it is re-registered", async () => {
    class ReRegisterConfig extends TestConfig {
      constructor() {
        super();
        this.addConfigField({ field: "JWT_KEY" });
      }
    }
    process.env.JWT_KEY = "super-secret-key";
    const logs: string[] = [];
    const config = new ReRegisterConfig();
    await config.reload((msg) => logs.push(msg));
    const keyLog = logs.find((line) => line.includes("JWT_KEY"));
    expect(keyLog).toContain("********************");
    expect(keyLog).not.toContain("super-secret-key");
  });

  it("logs a config file that exists but cannot be parsed", async () => {
    fse.writeFileSync(configPath, "{ not json");
    const logs: string[] = [];
    const config = new TestConfig(configPath);
    await config.reload((msg) => logs.push(msg));
    expect(
      logs.some((line) => line.includes("could not be read")),
    ).toBe(true);
  });

  it("does not log a missing config file", async () => {
    const logs: string[] = [];
    const config = new TestConfig(path.join(tmpDir, "absent.json"));
    await config.reload((msg) => logs.push(msg));
    expect(logs.some((line) => line.includes("could not be read"))).toBe(false);
  });
});

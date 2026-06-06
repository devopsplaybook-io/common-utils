import * as fse from "fs-extra";
import * as path from "path";
import * as os from "os";

jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import { ConfigBase } from "./ConfigBase";

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
  });

  it("should initialise with default values", () => {
    const config = new TestConfig(configPath);
    expect(config.SERVICE_ID).toBe("test-service");
    expect(config.MY_SETTING).toBe("default_value");
    expect(config.SECRET_KEY).toBe("secret_default");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DATABASE_TYPE).toBe("sqlite");
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
});

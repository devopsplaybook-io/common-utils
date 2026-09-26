import { ConfigOTelInterface } from "@devopsplaybook.io/otel-utils";
import * as fse from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import path from "path";

/**
 * Configuration field descriptor used by {@link ConfigBase.addConfigField}.
 */
export interface ConfigFieldDef {
  /** Property name on the config instance. */
  field: string;
  /** When `true` the value is masked in log output. */
  sensitive?: boolean;
  /**
   * Alternative environment variable names to check when the primary field
   * name is not found in `process.env`.  Aliases are tried in order and the
   * first match wins.  Only checked in the environment layer, never in the
   * config-file layer.
   *
   * @example
   * ```ts
   * // Look for DATABASE_POSTGRES_HOST first, then fall back to POSTGRES_HOST
   * { field: "DATABASE_POSTGRES_HOST", envAliases: ["POSTGRES_HOST"] }
   * ```
   */
  envAliases?: string[];
}

/**
 * Database-specific configuration fields shared by every project that
 * supports both SQLite and PostgreSQL backends.
 */
export interface ConfigDatabaseInterface {
  DATABASE_TYPE: "sqlite" | "postgres";
  DATABASE_POSTGRES_HOST: string;
  DATABASE_POSTGRES_PORT: number;
  DATABASE_POSTGRES_USER: string;
  DATABASE_POSTGRES_PASSWORD: string;
  DATABASE_POSTGRES_DATABASE: string;
  /** Per-session `statement_timeout` in ms (0 = disabled). */
  DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS: number;
  /** Per-session `idle_in_transaction_session_timeout` in ms (0 = disabled). */
  DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS: number;
}

/**
 * Common server configuration fields shared across projects.
 */
export interface ConfigCommonInterface
  extends ConfigOTelInterface, ConfigDatabaseInterface {
  CONFIG_FILE: string;
  API_PORT: number;
  JWT_VALIDITY_DURATION: number;
  JWT_REVOCATION_ENABLED: boolean;
  API_TOKENS_MAX_PER_USER: number;
  CORS_POLICY_ORIGIN: string;
  DATA_DIR: string;
  JWT_KEY: string;
  LOG_LEVEL: string;
}

/**
 * Coerce a value read from an environment variable (always a string) or from
 * the config file to match the type of the default value (number →
 * parseFloat, boolean → "true"/"1", array → JSON.parse, etc.).  Values that
 * are already typed correctly (config file JSON) pass through unchanged; when
 * the default is a string or there is no default, the value is returned as-is.
 */
function coerceValue(value: unknown, defaultValue: any): any {
  if (typeof value !== "string") {
    return value;
  }
  if (defaultValue === undefined || defaultValue === null) {
    return value;
  }

  switch (typeof defaultValue) {
    case "number": {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    }
    case "boolean": {
      return value === "true" || value === "1" || value === "yes";
    }
    case "object": {
      if (Array.isArray(defaultValue)) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      if (defaultValue !== null) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * Abstract base class for project configuration.
 *
 * Implements the three-layer override strategy used across all
 * devopsplaybook.io server projects:
 *   1. **Environment variable** (highest priority)
 *   2. **config.json** file value
 *   3. **Default** declared on the class property
 *
 * Subclasses add project-specific fields and call {@link addConfigField}
 * inside their constructor so that {@link reload} picks them up.
 *
 * @example
 * ```ts
 * class MyConfig extends ConfigBase {
 *   public MY_SETTING = "default";
 *   constructor() {
 *     super("my-service");
 *     this.addConfigField({ field: "MY_SETTING" });
 *   }
 * }
 * ```
 */
export abstract class ConfigBase implements ConfigCommonInterface {
  // -- OTel fields (ConfigOTelInterface) --
  public SERVICE_ID: string;
  public VERSION = "1";
  public OPENTELEMETRY_COLLECTOR_HTTP_TRACES = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_METRICS = "";
  public OPENTELEMETRY_COLLECTOR_HTTP_LOGS = "";
  public OPENTELEMETRY_COLLECTOR_AWS = false;
  public OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS = 60;
  public OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS = 60;
  public OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER = "";

  // -- Common server fields --
  public CONFIG_FILE: string;
  public API_PORT = 8080;
  public JWT_VALIDITY_DURATION = 3 * 31 * 24 * 3600;
  /**
   * Opt-in JWT revocation: when enabled, every JWT request re-reads the user
   * and rejects tokens whose `tokenVersion` claim is stale. Requires the
   * `users.tokenVersion` migration (see README).
   */
  public JWT_REVOCATION_ENABLED = false;
  /** Maximum number of API tokens a single user may create. */
  public API_TOKENS_MAX_PER_USER = 100;
  public CORS_POLICY_ORIGIN = "";
  public DATA_DIR = process.env.DATA_DIR || "/data";
  public JWT_KEY: string = uuidv4();
  public LOG_LEVEL = "info";

  // -- Database fields --
  public DATABASE_TYPE: "sqlite" | "postgres" = "sqlite";
  public DATABASE_POSTGRES_HOST = "";
  public DATABASE_POSTGRES_PORT = 5432;
  public DATABASE_POSTGRES_USER = "";
  public DATABASE_POSTGRES_PASSWORD = "";
  public DATABASE_POSTGRES_DATABASE = "";
  /**
   * Per-session `statement_timeout` applied to every Postgres pool.
   * `0` (default) disables the timeout, preserving the historical behaviour.
   */
  public DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS = 0;
  /**
   * Per-session `idle_in_transaction_session_timeout` applied to every
   * Postgres pool. `0` (default) disables the timeout.
   */
  public DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS = 0;

  /**
   * Fields registered by subclasses (or the base) that {@link reload}
   * should process.  Common / DB / OTel fields are pre-registered.
   */
  private _fields: {
    field: string;
    sensitive: boolean;
    envAliases: string[];
    defaultValue: any;
  }[] = [];

  /**
   * @param serviceId  Unique service identifier (e.g. `"cryptotrader-server"`).
   * @param configFile Optional path to the JSON config file. Defaults to `"config.json"`.
   */
  constructor(serviceId: string, configFile?: string) {
    this.SERVICE_ID = serviceId;
    this.CONFIG_FILE = configFile || process.env.CONFIG_FILE || "config.json";
    this.VERSION = ConfigBase.detectVersion();

    // Pre-register base + DB + OTel fields so reload() handles them
    const baseFields: ConfigFieldDef[] = [
      { field: "VERSION" },
      { field: "SERVICE_ID" },
      { field: "API_PORT" },
      { field: "JWT_VALIDITY_DURATION" },
      { field: "JWT_REVOCATION_ENABLED" },
      { field: "API_TOKENS_MAX_PER_USER" },
      { field: "CORS_POLICY_ORIGIN" },
      { field: "DATA_DIR" },
      { field: "JWT_KEY", sensitive: true },
      { field: "LOG_LEVEL" },
      { field: "DATABASE_TYPE" },
      { field: "DATABASE_POSTGRES_HOST", envAliases: ["POSTGRES_HOST"] },
      { field: "DATABASE_POSTGRES_PORT", envAliases: ["POSTGRES_PORT"] },
      { field: "DATABASE_POSTGRES_USER", envAliases: ["POSTGRES_USER"] },
      {
        field: "DATABASE_POSTGRES_PASSWORD",
        sensitive: true,
        envAliases: ["POSTGRES_PASSWORD"],
      },
      { field: "DATABASE_POSTGRES_DATABASE", envAliases: ["POSTGRES_DB"] },
      { field: "DATABASE_POSTGRES_STATEMENT_TIMEOUT_MS" },
      { field: "DATABASE_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS" },
      { field: "OPENTELEMETRY_COLLECTOR_HTTP_TRACES" },
      { field: "OPENTELEMETRY_COLLECTOR_HTTP_METRICS" },
      { field: "OPENTELEMETRY_COLLECTOR_HTTP_LOGS" },
      { field: "OPENTELEMETRY_COLLECTOR_AWS" },
      {
        field: "OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS",
      },
      {
        field: "OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS",
      },
      {
        field: "OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER",
        sensitive: true,
      },
    ];
    for (const f of baseFields) {
      this.addConfigField(f);
    }
  }

  /**
   * Resolve the library's own version from its published manifest.
   * `dist/src/ConfigBase.js` ships next to `../../package.json`; when running
   * from the TypeScript sources the manifest is at `../package.json`. Falls
   * back to `"1"` when neither resolves to this package.
   */
  private static detectVersion(): string {
    for (const candidate of [
      path.resolve(__dirname, "../../package.json"),
      path.resolve(__dirname, "../package.json"),
    ]) {
      try {
        const pkg = fse.readJsonSync(candidate);
        if (pkg && pkg.name === "@devopsplaybook.io/common-utils" && pkg.version) {
          return pkg.version;
        }
      } catch {
        // try the next candidate
      }
    }
    return "1";
  }

  /**
   * Register a configuration field so that {@link reload} processes it.
   * Call this in your subclass constructor for every project-specific field.
   */
  public addConfigField(def: ConfigFieldDef): void {
    this._fields.push({
      field: def.field,
      sensitive: def.sensitive ?? false,
      envAliases: def.envAliases ?? [],
      defaultValue: (this as any)[def.field],
    });
  }

  /**
   * Load (or reload) configuration from the JSON file and environment variables.
   * Environment variables always take precedence over file values.
   *
   * @param logger  Optional log callback `(message: string) => void`.
   *                When omitted nothing is logged (useful in tests).
   */
  public async reload(logger?: (message: string) => void): Promise<void> {
    const log = logger ?? (() => {});
    let content: Record<string, unknown> = {};
    try {
      content = await fse.readJson(this.CONFIG_FILE);
      // eslint-disable-next-line no-unused-vars -- catch binding kept so dist/ stays byte-identical to the TS6 build
    } catch (_e) {
      // config file is optional – fall back to env + defaults
    }

    log(`Configuration Value: CONFIG_FILE: ${this.CONFIG_FILE}`);
    log(`Configuration Value: SERVICE_ID: ${this.SERVICE_ID}`);
    log(`Configuration Value: VERSION: ${this.VERSION}`);

    for (const { field, sensitive, envAliases, defaultValue } of this._fields) {
      let from = "defaults";
      let foundValue: string | undefined;
      let usedAlias = false;

      // 1. Primary environment variable name
      if (process.env[field] !== undefined) {
        foundValue = process.env[field];
        from = "environment";
      }

      // 2. Check aliases if primary env var was not set
      if (foundValue === undefined && envAliases.length > 0) {
        for (const alias of envAliases) {
          if (process.env[alias] !== undefined) {
            foundValue = process.env[alias];
            from = "environment";
            usedAlias = true;
            break;
          }
        }
      }

      // 3. Apply environment value (full name or alias) if found,
      //    coercing strings to match the default value type
      if (foundValue !== undefined) {
        (this as any)[field] = coerceValue(foundValue, defaultValue);
      }

      // 4. Config file override (environment always wins, but if neither
      //    environment nor alias matched, check config file)
      if (foundValue === undefined && content[field] !== undefined) {
        (this as any)[field] = coerceValue(content[field], defaultValue);
        from = "config";
      }

      if (sensitive) {
        log(
          `Configuration Value: ${field}: ******************** (from ${from})`,
        );
      } else {
        log(
          `Configuration Value: ${field}: ${(this as any)[field]} (from ${from}${usedAlias ? ` via alias` : ""})`,
        );
      }
    }
  }
}

import { ConfigOTelInterface } from "@devopsplaybook.io/otel-utils";
import * as fse from "fs-extra";
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
  /** Login attempts allowed per rate-limit window (`<= 0` disables). */
  AUTH_RATE_LIMIT_LOGIN_MAX: number;
  /** Session refreshes allowed per rate-limit window (`<= 0` disables). */
  AUTH_RATE_LIMIT_REFRESH_MAX: number;
  /** Rate-limit window in seconds. */
  AUTH_RATE_LIMIT_WINDOW_SECONDS: number;
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
function coerceValue(value: unknown, defaultValue: any, field: string): any {
  if (typeof value !== "string") {
    return value;
  }
  if (defaultValue === undefined || defaultValue === null) {
    return value;
  }

  switch (typeof defaultValue) {
    case "number": {
      const trimmed = value.trim();
      const parsed = Number(trimmed);
      if (trimmed === "" || !Number.isFinite(parsed)) {
        throw new Error(
          `Invalid numeric value for ${field}: "${value}" (a finite number is required)`,
        );
      }
      return parsed;
    }
    case "boolean": {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no"].includes(normalized)) {
        return false;
      }
      throw new Error(
        `Invalid boolean value for ${field}: "${value}" (expected true/false, 1/0 or yes/no)`,
      );
    }
    case "object": {
      try {
        return JSON.parse(value);
      } catch {
        throw new Error(`Invalid JSON value for ${field}: "${value}"`);
      }
    }
    default:
      return value;
  }
}

/** Cached library version; the manifest is read at most once per process. */
let detectedVersion: string | undefined;

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
  /** Login attempts allowed per rate-limit window (per IP + username). */
  public AUTH_RATE_LIMIT_LOGIN_MAX = 10;
  /** Session refreshes allowed per rate-limit window (per IP). */
  public AUTH_RATE_LIMIT_REFRESH_MAX = 60;
  /** Rate-limit window in seconds. */
  public AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;
  public CORS_POLICY_ORIGIN = "";
  public DATA_DIR = process.env.DATA_DIR || "/data";
  /**
   * JWT signing key. Empty (the default) means DB-managed: `AuthInit` loads
   * the key from `metadata.auth_token` or generates and persists one. A
   * non-empty value (environment/config) takes precedence and is never
   * written to the database; changing it invalidates issued sessions.
   */
  public JWT_KEY: string = "";
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
      { field: "AUTH_RATE_LIMIT_LOGIN_MAX" },
      { field: "AUTH_RATE_LIMIT_REFRESH_MAX" },
      { field: "AUTH_RATE_LIMIT_WINDOW_SECONDS" },
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
    if (detectedVersion !== undefined) {
      return detectedVersion;
    }
    for (const candidate of [
      path.resolve(__dirname, "../../package.json"),
      path.resolve(__dirname, "../package.json"),
    ]) {
      try {
        const pkg = fse.readJsonSync(candidate);
        if (pkg && pkg.name === "@devopsplaybook.io/common-utils" && pkg.version) {
          const version = String(pkg.version);
          detectedVersion = version;
          return version;
        }
      } catch {
        // try the next candidate
      }
    }
    detectedVersion = "1";
    return detectedVersion;
  }

  /**
   * Register a configuration field so that {@link reload} processes it.
   * Call this in your subclass constructor for every project-specific field.
   */
  public addConfigField(def: ConfigFieldDef): void {
    const existing = this._fields.find((entry) => entry.field === def.field);
    if (existing) {
      // Re-registering a field (e.g. to add an alias) must never drop the
      // `sensitive` flag of the base registration and unmask the value in logs.
      existing.sensitive = existing.sensitive || (def.sensitive ?? false);
      existing.envAliases = [
        ...new Set([...existing.envAliases, ...(def.envAliases ?? [])]),
      ];
      existing.defaultValue = (this as any)[def.field];
      return;
    }
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
    } catch (error) {
      // A missing file is the normal "env + defaults" configuration. A file
      // that exists but cannot be read or parsed is almost always a mistake:
      // surface it instead of silently starting with defaults.
      const code = (error as { code?: string })?.code;
      if (code !== "ENOENT") {
        log(
          `Configuration file ${this.CONFIG_FILE} could not be read (${(error as Error).message}); using environment and defaults`,
        );
      }
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
        (this as any)[field] = coerceValue(foundValue, defaultValue, field);
      }

      // 4. Config file override (environment always wins, but if neither
      //    environment nor alias matched, check config file)
      if (foundValue === undefined && content[field] !== undefined) {
        (this as any)[field] = coerceValue(content[field], defaultValue, field);
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

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "crypto";
import type { Span } from "@opentelemetry/sdk-trace";

/**
 * Cross-device "login with a code" backend standard.
 *
 * This module is the dependency-free core: code generation, hashing, user
 * agent labelling, time helpers, the storage seam (`LoginCodesStore`) and the
 * configuration accessors. It deliberately does not import the database
 * facade, the shared auth stack or a web framework, so custom-auth servers
 * can use the module without initialising the common-utils users stack.
 *
 * The state machine is `pending → approved → consumed` plus the terminal
 * `cancelled`, `expired` and `failed` states. Codes and request tokens are
 * stored only as hashes; neither the codes nor the tokens are ever logged.
 */

/** RFC 8628 base20 alphabet (`~34.6` bits for an 8 character code). */
export const LOGIN_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
/** Number of characters of a login code. */
export const LOGIN_CODE_LENGTH = 8;
/** Maximum accepted user-agent length stored with a request. */
export const LOGIN_CODE_USER_AGENT_MAX_LENGTH = 512;
/** Rows older than this (by `createdAt`) are removed by lazy cleanup. */
export const LOGIN_CODE_RETENTION_HOURS = 24;
/** Bounded number of rows deleted per lazy cleanup call. */
export const LOGIN_CODE_CLEANUP_LIMIT = 100;
/** Minimum interval between code rotations (early `refreshCode` requests). */
export const LOGIN_CODE_MIN_ROTATION_MS = 5_000;

/** Stable machine-readable error codes returned by the routes. */
export const LOGIN_CODE_ERROR_INVALID_CODE = "INVALID_CODE";
export const LOGIN_CODE_ERROR_ALREADY_USED = "ALREADY_USED";
export const LOGIN_CODE_ERROR_RATE_LIMITED = "RATE_LIMITED";
export const LOGIN_CODE_ERROR_UNAVAILABLE = "LOGIN_CODE_UNAVAILABLE";
export const LOGIN_CODE_ERROR_PASSWORD_REQUIRED = "PASSWORD_REQUIRED";
export const LOGIN_CODE_ERROR_UNAUTHENTICATED = "UNAUTHENTICATED";
export const LOGIN_CODE_ERROR_FORBIDDEN = "FORBIDDEN";

/**
 * Audit actions emitted by the login-code flow. There is intentionally no
 * create or poll event: they are too noisy to be useful.
 */
export type LoginCodeEventType =
  | "login_code_approved"
  | "login_code_consumed"
  | "login_code_failed"
  | "login_code_cancelled";

/** An audit/event record. Never contains a code, request token or hash. */
export interface LoginCodesEvent {
  type: LoginCodeEventType;
  /** Login-code request row id. */
  requestId: string;
  /** Acting user id (approver/consumer) when known. */
  userId?: string;
  userName?: string;
  /** Parsed device label of the requesting device. */
  deviceLabel?: string;
  /** Machine-readable detail (`attempts_exceeded`, `approver_missing`, ...). */
  reason?: string;
  /** Remote IP address of the request, when available. */
  ip?: string;
}

/** The request lifecycle states. */
export type LoginCodeStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "cancelled"
  | "expired"
  | "failed";

/** A persisted login-code request row. */
export interface LoginCodeRecord {
  id: string;
  requestTokenHash: string;
  codeHash: string;
  previousCodeHash: string | null;
  codeExpiresAt: string;
  previousCodeExpiresAt: string | null;
  status: LoginCodeStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
  consumedAt: string | null;
  attempts: number;
  requestUserAgent: string | null;
}

export interface LoginCodeCreateInput {
  id: string;
  requestTokenHash: string;
  codeHash: string;
  codeExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  requestUserAgent: string | null;
  maxPending: number;
}

export type LoginCodeCreateResult =
  | { ok: true }
  | { ok: false; reason: "pending_cap" | "conflict" };

export interface LoginCodeRotateInput {
  id: string;
  expectedCodeHash: string;
  newCodeHash: string;
  codeExpiresAt: string;
  previousCodeExpiresAt: string;
  updatedAt: string;
}

export interface LoginCodeApproveInput {
  id: string;
  submittedCodeHash: string;
  now: string;
  approvedByUserId: string;
  approvedAt: string;
}

export interface LoginCodeConsumeInput {
  requestTokenHash: string;
  consumedAt: string;
  updatedAt: string;
}

export interface LoginCodeCancelInput {
  requestTokenHash: string;
  updatedAt: string;
}

export interface LoginCodeMarkInput {
  id: string;
  updatedAt: string;
}

export interface LoginCodeAttemptInput {
  id: string;
  maxAttempts: number;
  updatedAt: string;
}

export interface LoginCodeCleanupInput {
  olderThan: string;
  limit: number;
}

/**
 * Storage seam: an application supplies atomic primitives over its own
 * database. Every method must be safe to run concurrently across replicas
 * (single SQL statements / compare-and-set updates, no in-memory state).
 */
export interface LoginCodesStore {
  /**
   * Cheap probe of the backing table. A definitive "missing table" result is
   * cached per store instance so the routes can answer `available:false`
   * without crashing at boot.
   */
  available(context?: Span): Promise<boolean>;
  /** Atomic conditional insert enforcing the global pending cap. */
  create(
    input: LoginCodeCreateInput,
    context?: Span,
  ): Promise<LoginCodeCreateResult>;
  getByRequestTokenHash(
    requestTokenHash: string,
    context?: Span,
  ): Promise<LoginCodeRecord | null>;
  /**
   * Matches the current or the previous code hash. The caller enforces the
   * grace window on the previous hash, keeping the store a pure data layer.
   */
  getByCodeHash(
    codeHash: string,
    context?: Span,
  ): Promise<LoginCodeRecord | null>;
  /** Compare-and-set rotation: pending + current code hash must match. */
  rotate(input: LoginCodeRotateInput, context?: Span): Promise<boolean>;
  /**
   * Compare-and-set approval: pending only, the submitted hash must match the
   * current or the grace-period previous code. The first approval wins.
   */
  approve(input: LoginCodeApproveInput, context?: Span): Promise<boolean>;
  /** Compare-and-set `approved → consumed`; returns the row or `null`. */
  consume(
    input: LoginCodeConsumeInput,
    context?: Span,
  ): Promise<LoginCodeRecord | null>;
  /** Compare-and-set `pending → cancelled`. */
  cancel(input: LoginCodeCancelInput, context?: Span): Promise<boolean>;
  /** Compare-and-set `pending|approved → expired`. */
  markExpired(input: LoginCodeMarkInput, context?: Span): Promise<boolean>;
  /** Compare-and-set `pending|approved → failed`. */
  markFailed(input: LoginCodeMarkInput, context?: Span): Promise<boolean>;
  /**
   * Atomically increment the attempt counter only while it is below the cap.
   * Returns `false` when the request is already locked.
   */
  recordAttempt(
    input: LoginCodeAttemptInput,
    context?: Span,
  ): Promise<boolean>;
  /**
   * Bounded lazy cleanup: delete rows created before `olderThan`, removing at
   * most `limit` rows. Returns the number of deleted rows.
   */
  cleanup(input: LoginCodeCleanupInput, context?: Span): Promise<number>;
}

/** Configuration fields read by the login-code module. */
export interface LoginCodesConfig {
  LOGIN_CODE_ENABLED?: boolean | string;
  LOGIN_CODE_TTL_SECONDS?: number | string;
  LOGIN_CODE_ROTATION_SECONDS?: number | string;
  LOGIN_CODE_GRACE_SECONDS?: number | string;
  LOGIN_CODE_POLL_INTERVAL_MS?: number | string;
  LOGIN_CODE_MAX_ATTEMPTS?: number | string;
  LOGIN_CODE_MAX_PENDING?: number | string;
  LOGIN_CODE_RATE_LIMIT_CREATE_MAX?: number | string;
  LOGIN_CODE_RATE_LIMIT_POLL_MAX?: number | string;
  LOGIN_CODE_RATE_LIMIT_APPROVE_MAX?: number | string;
  AUTH_RATE_LIMIT_WINDOW_SECONDS?: number | string;
  LOGIN_CODE_APPROVE_REQUIRE_PASSWORD?: boolean | string;
}

/** Resolved settings with every default and clamp applied. */
export interface LoginCodesSettings {
  enabled: boolean;
  ttlSeconds: number;
  rotationSeconds: number;
  graceSeconds: number;
  pollIntervalMs: number;
  maxAttempts: number;
  maxPending: number;
  rateLimitCreateMax: number;
  rateLimitPollMax: number;
  rateLimitApproveMax: number;
  rateLimitWindowSeconds: number;
  approveRequiresPassword: boolean;
}

export const LOGIN_CODES_DEFAULT_SETTINGS: Readonly<LoginCodesSettings> =
  Object.freeze({
    enabled: false,
    ttlSeconds: 300,
    rotationSeconds: 30,
    graceSeconds: 60,
    pollIntervalMs: 2000,
    maxAttempts: 5,
    maxPending: 100,
    rateLimitCreateMax: 10,
    rateLimitPollMax: 120,
    rateLimitApproveMax: 10,
    rateLimitWindowSeconds: 60,
    approveRequiresPassword: false,
  });

function toInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  let parsed = NaN;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    parsed = Number(value.trim());
  }
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

/** Whether the feature is enabled (`LOGIN_CODE_ENABLED`, default `false`). */
export function LoginCodesGetEnabled(config: LoginCodesConfig = {}): boolean {
  return toBoolean(config.LOGIN_CODE_ENABLED, false);
}

/** Request lifetime in seconds (`LOGIN_CODE_TTL_SECONDS`, default 300). */
export function LoginCodesGetTtlSeconds(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_TTL_SECONDS,
    LOGIN_CODES_DEFAULT_SETTINGS.ttlSeconds,
    30,
    3600,
  );
}

/** Code rotation interval in seconds (default 30, never below 5). */
export function LoginCodesGetRotationSeconds(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_ROTATION_SECONDS,
    LOGIN_CODES_DEFAULT_SETTINGS.rotationSeconds,
    LOGIN_CODE_MIN_ROTATION_MS / 1000,
    300,
  );
}

/** Grace period of a rotated-out code in seconds (default 60). */
export function LoginCodesGetGraceSeconds(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_GRACE_SECONDS,
    LOGIN_CODES_DEFAULT_SETTINGS.graceSeconds,
    0,
    600,
  );
}

/** Client poll interval hint in milliseconds (default 2000). */
export function LoginCodesGetPollIntervalMs(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_POLL_INTERVAL_MS,
    LOGIN_CODES_DEFAULT_SETTINGS.pollIntervalMs,
    250,
    60000,
  );
}

/** Attempts allowed per request (`LOGIN_CODE_MAX_ATTEMPTS`, default 5). */
export function LoginCodesGetMaxAttempts(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_MAX_ATTEMPTS,
    LOGIN_CODES_DEFAULT_SETTINGS.maxAttempts,
    1,
    100,
  );
}

/** Global pending request cap (`LOGIN_CODE_MAX_PENDING`, default 100). */
export function LoginCodesGetMaxPending(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_MAX_PENDING,
    LOGIN_CODES_DEFAULT_SETTINGS.maxPending,
    1,
    1_000_000,
  );
}

/** Per-IP create limit (`LOGIN_CODE_RATE_LIMIT_CREATE_MAX`, default 10). */
export function LoginCodesGetRateLimitCreateMax(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_RATE_LIMIT_CREATE_MAX,
    LOGIN_CODES_DEFAULT_SETTINGS.rateLimitCreateMax,
    0,
    1_000_000,
  );
}

/** Per-token poll limit (`LOGIN_CODE_RATE_LIMIT_POLL_MAX`, default 120). */
export function LoginCodesGetRateLimitPollMax(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_RATE_LIMIT_POLL_MAX,
    LOGIN_CODES_DEFAULT_SETTINGS.rateLimitPollMax,
    0,
    1_000_000,
  );
}

/** Per-IP preview/approve/cancel limit (default 10). */
export function LoginCodesGetRateLimitApproveMax(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.LOGIN_CODE_RATE_LIMIT_APPROVE_MAX,
    LOGIN_CODES_DEFAULT_SETTINGS.rateLimitApproveMax,
    0,
    1_000_000,
  );
}

/** Rate-limit window in seconds (reuses `AUTH_RATE_LIMIT_WINDOW_SECONDS`). */
export function LoginCodesGetRateLimitWindowSeconds(
  config: LoginCodesConfig = {},
): number {
  return toInteger(
    config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    LOGIN_CODES_DEFAULT_SETTINGS.rateLimitWindowSeconds,
    1,
    3600,
  );
}

/** Whether approval requires the account password (default `false`). */
export function LoginCodesGetApproveRequiresPassword(
  config: LoginCodesConfig = {},
): boolean {
  return toBoolean(
    config.LOGIN_CODE_APPROVE_REQUIRE_PASSWORD,
    LOGIN_CODES_DEFAULT_SETTINGS.approveRequiresPassword,
  );
}

/** Resolve every login-code setting from a configuration object. */
export function LoginCodesOptionsFromConfig(
  config: LoginCodesConfig = {},
): LoginCodesSettings {
  return {
    enabled: LoginCodesGetEnabled(config),
    ttlSeconds: LoginCodesGetTtlSeconds(config),
    rotationSeconds: LoginCodesGetRotationSeconds(config),
    graceSeconds: LoginCodesGetGraceSeconds(config),
    pollIntervalMs: LoginCodesGetPollIntervalMs(config),
    maxAttempts: LoginCodesGetMaxAttempts(config),
    maxPending: LoginCodesGetMaxPending(config),
    rateLimitCreateMax: LoginCodesGetRateLimitCreateMax(config),
    rateLimitPollMax: LoginCodesGetRateLimitPollMax(config),
    rateLimitApproveMax: LoginCodesGetRateLimitApproveMax(config),
    rateLimitWindowSeconds: LoginCodesGetRateLimitWindowSeconds(config),
    approveRequiresPassword: LoginCodesGetApproveRequiresPassword(config),
  };
}

/**
 * Generate a fresh 8 character code over the base20 alphabet.
 * Uses `crypto.randomInt` (uniform, cryptographically secure).
 */
export function LoginCodeGenerateCode(): string {
  let code = "";
  for (let index = 0; index < LOGIN_CODE_LENGTH; index += 1) {
    code += LOGIN_CODE_ALPHABET[randomInt(0, LOGIN_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Normalise a user-submitted code: uppercase and strip spaces/hyphens.
 * Returns `null` when the result is not exactly 8 characters of the alphabet
 * (so callers answer the generic `INVALID_CODE` without enumeration).
 */
export function LoginCodeNormalize(code: unknown): string | null {
  if (typeof code !== "string") {
    return null;
  }
  const normalized = code.toUpperCase().replace(/[\s-]/g, "");
  if (normalized.length !== LOGIN_CODE_LENGTH) {
    return null;
  }
  for (const char of normalized) {
    if (!LOGIN_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return normalized;
}

/** Generate a 256-bit request token, encoded as base64url. */
export function LoginCodeGenerateRequestToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 (hex) of a request token; only the hash is ever stored. */
export function LoginCodeHashRequestToken(requestToken: string): string {
  return createHash("sha256").update(requestToken).digest("hex");
}

/**
 * HMAC-SHA256 (hex) of a code keyed with the deployment's secret key (the
 * JWT key by default). Codes are never stored in plaintext.
 */
export function LoginCodeHashCode(code: string, key: string): string {
  return createHmac("sha256", key).update(code).digest("hex");
}

/** A fresh row id (UUID v4), matching the repository id convention. */
export function LoginCodeNewId(): string {
  return randomUUID();
}

/** Truncate a user agent and normalise empty values to `null`. */
export function LoginCodeTruncateUserAgent(
  userAgent: unknown,
): string | null {
  if (typeof userAgent !== "string") {
    return null;
  }
  const trimmed = userAgent.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed.slice(0, LOGIN_CODE_USER_AGENT_MAX_LENGTH);
}

/**
 * Parse a user agent into a short, human-readable device label shown to the
 * approver before consent (e.g. `Chrome on macOS`). Unknown input never
 * throws and falls back to `Unknown browser` / `Unknown OS`.
 */
export function LoginCodeDeviceLabel(userAgent: unknown): string {
  const ua = typeof userAgent === "string" ? userAgent.trim() : "";
  if (ua === "") {
    return "Unknown device";
  }
  let browser: string | null = null;
  if (/Edg(?:\/|A|iOS)/i.test(ua)) {
    browser = "Edge";
  } else if (/OPR\/|Opera/i.test(ua)) {
    browser = "Opera";
  } else if (/FxiOS\//i.test(ua)) {
    browser = "Firefox";
  } else if (/Firefox\//i.test(ua)) {
    browser = "Firefox";
  } else if (/CriOS\//i.test(ua)) {
    browser = "Chrome";
  } else if (/Chrome\/|Chromium\//i.test(ua)) {
    browser = "Chrome";
  } else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) {
    browser = "Safari";
  } else if (/^curl\//i.test(ua)) {
    browser = "curl";
  }

  let os: string | null = null;
  if (/iPhone|iPad|iPod/i.test(ua)) {
    os = "iOS";
  } else if (/Android/i.test(ua)) {
    os = "Android";
  } else if (/Windows/i.test(ua)) {
    os = "Windows";
  } else if (/Mac OS X|Macintosh/i.test(ua)) {
    os = "macOS";
  } else if (/Linux/i.test(ua)) {
    os = "Linux";
  }

  if (browser && os) {
    return `${browser} on ${os}`;
  }
  if (browser) {
    return `${browser} on Unknown OS`;
  }
  if (os) {
    return `Unknown browser on ${os}`;
  }
  return "Unknown device";
}

/** Current time in milliseconds (indirection for tests/determinism). */
export function LoginCodeNowMs(): number {
  return Date.now();
}

/** Convert epoch milliseconds to the ISO-8601 form used by the database. */
export function LoginCodeIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** Parse an ISO timestamp; returns `NaN` for invalid input. */
export function LoginCodeParseIso(value: string | null | undefined): number {
  if (typeof value !== "string" || value === "") {
    return NaN;
  }
  return Date.parse(value);
}

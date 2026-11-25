/**
 * Auth session policy: the documented validity / absolute-cap / renewal rules
 * shared by every deployed application, plus a startup validator.
 *
 * The single source of truth for humans is `docs/auth-session-policy.md`; the
 * application table there is parsed by `AuthSessionPolicy.spec.ts` and compared
 * with {@link AUTH_SESSION_POLICY_APPS}, so a configuration that drifts from the
 * document fails the test suite.
 *
 * PITFALL — `addConfigField` re-registration: a `JWT_VALIDITY_DURATION` (or any
 * field) declared in a `Config` subclass is silently discarded by `reload()`
 * when using `@devopsplaybook.io/common-utils <= 2.9.2` unless it is
 * re-registered with `addConfigField` after assignment: the base constructor
 * registers the field with its 1-hour default before the subclass field
 * initializer runs, and `reload()` restores that default. From 2.10.1 the
 * defaults are captured on the first `reload()`, after the subclass initializer
 * has run, so the declared value is honoured. Re-registering remains harmless.
 * Renewal thresholds must always stay below the token lifetime, otherwise the
 * renewal can never fire.
 */

/** Standard rule for user-facing applications. */
export interface AuthSessionPolicyStandard {
  /** Sliding access-token lifetime: 30 days. */
  validitySeconds: number;
  /** Absolute session cap from the first login: 90 days. */
  maxDurationSeconds: number;
  /** Renew when this fraction (or less) of the lifetime remains. */
  renewalRatio: number;
  /** Shortest validity an application may use without an explicit exception. */
  minValiditySeconds: number;
}

export const AUTH_SESSION_STANDARD: AuthSessionPolicyStandard = {
  validitySeconds: 2592000,
  maxDurationSeconds: 7776000,
  renewalRatio: 0.2,
  minValiditySeconds: 3600,
};

/** Documented values for one application. */
export interface AuthSessionPolicyApp {
  validitySeconds: number;
  /** `0` disables the absolute cap. */
  maxDurationSeconds: number;
  /** `true` when the client renews before expiry (sliding sessions). */
  slidingRenewal: boolean;
  /** Allow a validity below {@link AUTH_SESSION_STANDARD.minValiditySeconds}. */
  allowShortValidity?: boolean;
}

/**
 * Documented policy values per deployed application. Keep this map and the
 * table in `docs/auth-session-policy.md` in sync; the spec enforces it.
 */
export const AUTH_SESSION_POLICY_APPS: Record<string, AuthSessionPolicyApp> = {
  notifications: {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  "sourcecode-editor": {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  "otel-light": {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  "kubernetes-web-lightclient": {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  telepathy: {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  feedwatcher: {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  "devopsplaybook-viewer": {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  "health-tracker": {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  "telepathy-monitor": {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  storyhero: {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  cryptotrader: {
    validitySeconds: 2592000,
    maxDurationSeconds: 7776000,
    slidingRenewal: true,
  },
  planner: {
    validitySeconds: 2592000,
    maxDurationSeconds: 0,
    slidingRenewal: false,
  },
  "quality-dashboard": {
    validitySeconds: 8035200,
    maxDurationSeconds: 0,
    slidingRenewal: false,
  },
  storywriter: {
    validitySeconds: 2592000,
    maxDurationSeconds: 2592000,
    slidingRenewal: false,
  },
  "book-reader": {
    validitySeconds: 2592000,
    maxDurationSeconds: 2592000,
    slidingRenewal: true,
  },
  stocktrader: {
    validitySeconds: 604800,
    maxDurationSeconds: 2592000,
    slidingRenewal: false,
  },
  chinesetextreader: {
    validitySeconds: 2592000,
    maxDurationSeconds: 0,
    slidingRenewal: false,
  },
  "restic-secrets-manager": {
    validitySeconds: 3600,
    maxDurationSeconds: 3600,
    slidingRenewal: false,
  },
  cloudphotomanager: {
    validitySeconds: 2592000,
    maxDurationSeconds: 0,
    slidingRenewal: false,
  },
  studyguide: {
    validitySeconds: 900,
    maxDurationSeconds: 7776000,
    slidingRenewal: false,
    allowShortValidity: true,
  },
};

/** The configuration fields the policy reads. */
export interface AuthSessionPolicyConfig {
  JWT_VALIDITY_DURATION: number;
  JWT_SESSION_MAX_DURATION: number;
}

/** Explicit expected values (alternative to `app`). */
export interface AuthSessionPolicyExpected {
  validitySeconds?: number;
  maxDurationSeconds?: number;
}

export interface AuthSessionPolicyOptions {
  /** Documented application id (key of {@link AUTH_SESSION_POLICY_APPS}). */
  app?: string;
  /** Expected values; defaults to the documented values of `app`. */
  expected?: AuthSessionPolicyExpected;
  /** Allow a validity below the 1-hour minimum (Study Guide). */
  allowShortValidity?: boolean;
  /** Override the 1-hour minimum. */
  minValiditySeconds?: number;
  /** Override whether the app is expected to renew before expiry. */
  slidingRenewal?: boolean;
}

export interface AuthSessionPolicyResult {
  ok: boolean;
  app: string;
  validitySeconds: number;
  maxDurationSeconds: number;
  slidingRenewal: boolean;
  errors: string[];
  warnings: string[];
}

/** Log callback accepted by {@link AuthSessionPolicyLog}. */
export type AuthSessionPolicyLogMessage = (message: string) => void;

export interface AuthSessionPolicyLoggerObject {
  info: AuthSessionPolicyLogMessage;
}

export type AuthSessionPolicyLogger =
  | AuthSessionPolicyLogMessage
  | AuthSessionPolicyLoggerObject;

export interface AuthSessionPolicyLogOptions extends AuthSessionPolicyOptions {
  logger: AuthSessionPolicyLogger;
  /** Throw after logging when the check failed (fail-fast opt-in). */
  throwOnError?: boolean;
}

function emit(logger: AuthSessionPolicyLogger, message: string): void {
  if (typeof logger === "function") {
    logger(message);
    return;
  }
  if (typeof logger.info === "function") {
    logger.info(message);
  }
}

function formatSeconds(value: number): string {
  return Number.isFinite(value) ? String(value) : "invalid";
}

/**
 * Validate the effective session values against the documented policy.
 * Pure: never logs and never throws; {@link AuthSessionPolicyLog} and
 * {@link AuthSessionPolicyAssert} build on it.
 */
export function AuthSessionPolicyCheck(
  config: AuthSessionPolicyConfig,
  options: AuthSessionPolicyOptions = {},
): AuthSessionPolicyResult {
  const validity = config?.JWT_VALIDITY_DURATION;
  const maxDuration = config?.JWT_SESSION_MAX_DURATION;
  const appDef = options.app
    ? AUTH_SESSION_POLICY_APPS[options.app]
    : undefined;
  const slidingRenewal =
    options.slidingRenewal ?? appDef?.slidingRenewal ?? false;
  const expectedValidity =
    options.expected?.validitySeconds ?? appDef?.validitySeconds;
  const expectedMaxDuration =
    options.expected?.maxDurationSeconds ?? appDef?.maxDurationSeconds;
  const minValidity =
    options.minValiditySeconds ?? AUTH_SESSION_STANDARD.minValiditySeconds;
  const allowShortValidity =
    options.allowShortValidity ?? appDef?.allowShortValidity ?? false;

  const errors: string[] = [];
  const warnings: string[] = [];

  if (options.app && !appDef) {
    errors.push(
      `Unknown application "${options.app}" in the auth session policy`,
    );
  }

  if (!Number.isFinite(validity) || validity <= 0) {
    errors.push(
      `JWT_VALIDITY_DURATION must be a finite positive number (got ${String(validity)})`,
    );
  } else if (validity < minValidity && !allowShortValidity) {
    errors.push(
      `JWT_VALIDITY_DURATION ${validity}s is below the ${minValidity}s minimum; declare an explicit exception for a deliberately short session`,
    );
  }

  if (!Number.isFinite(maxDuration)) {
    errors.push(
      `JWT_SESSION_MAX_DURATION must be a finite number (got ${String(maxDuration)})`,
    );
  } else if (
    slidingRenewal &&
    maxDuration > 0 &&
    Number.isFinite(validity) &&
    validity > 0 &&
    maxDuration < validity
  ) {
    errors.push(
      `JWT_SESSION_MAX_DURATION ${maxDuration}s is smaller than JWT_VALIDITY_DURATION ${validity}s; a sliding renewal can never fire`,
    );
  }

  if (
    expectedValidity !== undefined &&
    Number.isFinite(validity) &&
    validity !== expectedValidity
  ) {
    errors.push(
      `JWT_VALIDITY_DURATION is ${validity}s but the documented policy expects ${expectedValidity}s`,
    );
  }
  if (
    expectedMaxDuration !== undefined &&
    Number.isFinite(maxDuration) &&
    maxDuration !== expectedMaxDuration
  ) {
    errors.push(
      `JWT_SESSION_MAX_DURATION is ${maxDuration}s but the documented policy expects ${expectedMaxDuration}s`,
    );
  }

  if (slidingRenewal && Number.isFinite(maxDuration) && maxDuration <= 0) {
    warnings.push(
      "JWT_SESSION_MAX_DURATION is disabled while sliding renewal is expected: sessions never require a fresh login",
    );
  } else if (
    Number.isFinite(maxDuration) &&
    maxDuration > 0 &&
    maxDuration === validity
  ) {
    warnings.push(
      "JWT_SESSION_MAX_DURATION equals JWT_VALIDITY_DURATION: sliding renewal has no headroom beyond the first token",
    );
  }

  return {
    ok: errors.length === 0,
    app: options.app ?? "unknown",
    validitySeconds: validity,
    maxDurationSeconds: maxDuration,
    slidingRenewal,
    errors,
    warnings,
  };
}

/**
 * Log the one stable startup line plus any error/warning detail:
 * `Auth session policy: app=<id> validity=<s>s cap=<s>s renewal=<sliding|fixed> status=ok`
 */
export function AuthSessionPolicyLog(
  config: AuthSessionPolicyConfig,
  options: AuthSessionPolicyLogOptions,
): AuthSessionPolicyResult {
  const result = AuthSessionPolicyCheck(config, options);

  emit(
    options.logger,
    `Auth session policy: app=${result.app} validity=${formatSeconds(result.validitySeconds)}s cap=${formatSeconds(result.maxDurationSeconds)}s renewal=${result.slidingRenewal ? "sliding" : "fixed"} status=${result.ok ? "ok" : "error"}`,
  );
  for (const error of result.errors) {
    emit(options.logger, `Auth session policy error: ${error}`);
  }
  for (const warning of result.warnings) {
    emit(options.logger, `Auth session policy warning: ${warning}`);
  }

  if (options.throwOnError && !result.ok) {
    throw new Error(
      `Auth session policy violation for app=${result.app}: ${result.errors.join("; ")}`,
    );
  }

  return result;
}

/**
 * Fail-fast variant: throws an `Error` listing every policy violation.
 * Prefer {@link AuthSessionPolicyLog} at startup unless the app should refuse
 * to boot with an invalid session configuration.
 */
export function AuthSessionPolicyAssert(
  config: AuthSessionPolicyConfig,
  options: AuthSessionPolicyOptions = {},
): AuthSessionPolicyResult {
  const result = AuthSessionPolicyCheck(config, options);
  if (!result.ok) {
    throw new Error(
      `Auth session policy violation for app=${result.app}: ${result.errors.join("; ")}`,
    );
  }
  return result;
}

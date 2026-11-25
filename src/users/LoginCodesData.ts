import type { Span } from "@opentelemetry/sdk-trace";
import {
  LOGIN_CODE_MIN_ROTATION_MS,
  LoginCodeGenerateCode,
  LoginCodeHashCode,
  LoginCodeIso,
  LoginCodeNormalize,
  LoginCodeParseIso,
  LoginCodeRecord,
  LoginCodesStore,
} from "./LoginCodes";

/**
 * Store orchestration helpers shared by the routes: resolving a submitted
 * code (including the grace-period previous code), attempt accounting and
 * lazy rotation. Imports only {@link ./LoginCodes}, so it stays free of the
 * database facade and the shared auth stack.
 */

/** A recorded match between a submitted code and a stored request. */
export interface LoginCodeResolved {
  record: LoginCodeRecord;
  /** Hash that matched (the current or the previous code). */
  matchedCodeHash: string;
  usedPrevious: boolean;
}

/**
 * Normalise and hash a submitted code, then resolve the matching request.
 * Matches the current code or the previous code while its grace period is
 * still active. Returns `null` for malformed, unknown or grace-expired codes.
 */
export async function LoginCodeResolveByCode(
  store: LoginCodesStore,
  args: {
    code: unknown;
    hashKey: string;
    nowMs: number;
    context?: Span;
  },
): Promise<LoginCodeResolved | null> {
  const normalized = LoginCodeNormalize(args.code);
  if (!normalized || args.hashKey === "") {
    return null;
  }
  const matchedCodeHash = LoginCodeHashCode(normalized, args.hashKey);
  const record = await store.getByCodeHash(matchedCodeHash, args.context);
  if (!record) {
    return null;
  }
  if (record.codeHash === matchedCodeHash) {
    return { record, matchedCodeHash, usedPrevious: false };
  }
  if (record.previousCodeHash === matchedCodeHash) {
    const previousExpiresAt = LoginCodeParseIso(record.previousCodeExpiresAt);
    if (
      Number.isFinite(previousExpiresAt) &&
      previousExpiresAt > args.nowMs
    ) {
      return { record, matchedCodeHash, usedPrevious: true };
    }
  }
  return null;
}

/** Outcome of consuming one attempt against a request. */
export type LoginCodeAttemptResult =
  | { allowed: true }
  | { allowed: false; record: LoginCodeRecord | null };

/**
 * Atomically consume one attempt. When the store reports the request can no
 * longer take an attempt, re-read it so the caller can tell a locked request
 * (`attempts_exceeded`) from one approved concurrently by another device.
 */
export async function LoginCodeConsumeAttempt(
  store: LoginCodesStore,
  args: {
    record: LoginCodeRecord;
    maxAttempts: number;
    nowMs: number;
    context?: Span;
  },
): Promise<LoginCodeAttemptResult> {
  const allowed = await store.recordAttempt(
    {
      id: args.record.id,
      maxAttempts: args.maxAttempts,
      updatedAt: LoginCodeIso(args.nowMs),
    },
    args.context,
  );
  if (allowed) {
    return { allowed: true };
  }
  const refreshed = await store.getByRequestTokenHash(
    args.record.requestTokenHash,
    args.context,
  );
  return { allowed: false, record: refreshed };
}

/** Whether a request is past its absolute TTL (invalid timestamps fail closed). */
export function LoginCodeIsExpiredAt(
  record: LoginCodeRecord,
  nowMs: number,
): boolean {
  const expiresAt = LoginCodeParseIso(record.expiresAt);
  return !Number.isFinite(expiresAt) || nowMs >= expiresAt;
}

/**
 * Whether a pending request should rotate its code now: the current code
 * window elapsed, or an explicit `refreshCode` request arrived at least the
 * 5 s minimum interval into the current window.
 */
export function LoginCodeRotationDue(
  record: LoginCodeRecord,
  args: { rotationSeconds: number; nowMs: number; refreshCode?: boolean },
): boolean {
  if (record.status !== "pending") {
    return false;
  }
  const codeExpiresAt = LoginCodeParseIso(record.codeExpiresAt);
  if (!Number.isFinite(codeExpiresAt)) {
    return true;
  }
  const remainingMs = codeExpiresAt - args.nowMs;
  if (remainingMs <= 0) {
    return true;
  }
  if (!args.refreshCode) {
    return false;
  }
  const elapsedInWindowMs = args.rotationSeconds * 1000 - remainingMs;
  return elapsedInWindowMs >= LOGIN_CODE_MIN_ROTATION_MS;
}

/** Outcome of a lazy rotation attempt. */
export interface LoginCodeRotationResult {
  rotated: boolean;
  /** Plaintext code, returned only by the response that rotated it. */
  code: string | null;
  record: LoginCodeRecord;
}

/**
 * Rotate the code when due. The old hash stays valid for the grace period.
 * Losing the compare-and-set race (another replica rotated first) re-reads the
 * row and returns it without a code.
 */
export async function LoginCodeRotateIfDue(
  store: LoginCodesStore,
  args: {
    record: LoginCodeRecord;
    hashKey: string;
    rotationSeconds: number;
    graceSeconds: number;
    refreshCode?: boolean;
    nowMs: number;
    context?: Span;
  },
): Promise<LoginCodeRotationResult> {
  const record = args.record;
  if (
    args.hashKey === "" ||
    !LoginCodeRotationDue(record, {
      rotationSeconds: args.rotationSeconds,
      nowMs: args.nowMs,
      refreshCode: args.refreshCode,
    })
  ) {
    return { rotated: false, code: null, record };
  }
  const newCode = LoginCodeGenerateCode();
  const newCodeHash = LoginCodeHashCode(newCode, args.hashKey);
  const codeExpiresAt = LoginCodeIso(
    args.nowMs + args.rotationSeconds * 1000,
  );
  const previousCodeExpiresAt = LoginCodeIso(
    args.nowMs + args.graceSeconds * 1000,
  );
  const updatedAt = LoginCodeIso(args.nowMs);
  const ok = await store.rotate(
    {
      id: record.id,
      expectedCodeHash: record.codeHash,
      newCodeHash,
      codeExpiresAt,
      previousCodeExpiresAt,
      updatedAt,
    },
    args.context,
  );
  if (!ok) {
    const refreshed = await store.getByRequestTokenHash(
      record.requestTokenHash,
      args.context,
    );
    return { rotated: false, code: null, record: refreshed ?? record };
  }
  return {
    rotated: true,
    code: newCode,
    record: {
      ...record,
      codeHash: newCodeHash,
      previousCodeHash: record.codeHash,
      codeExpiresAt,
      previousCodeExpiresAt,
      updatedAt,
    },
  };
}

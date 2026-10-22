import type { Span } from "@opentelemetry/sdk-trace";
import * as bcrypt from "bcrypt";
import { User } from "./User";

/** bcrypt only uses the first 72 bytes of a password. */
const BCRYPT_MAX_PASSWORD_BYTES = 72;

/**
 * Bcrypt hash of a random value used to keep the login timing independent of
 * whether the username exists: an unknown user costs the same compare.
 */
const DUMMY_PASSWORD_HASH =
  "$2b$10$YTEjZB73URB5hX4i8ATVHu7ZWZusJSRSLSw3tZpsSSFGuPBK/eQCq";

let minLength = 0;
let customValidator: ((password: string) => string | null) | null = null;

/**
 * Configure the password policy applied by {@link UserPasswordValidate} and
 * {@link UserPasswordSetPassword}.
 *
 * @param policy.minLength  Minimum number of characters (default 0: no
 *                          minimum). The 72-byte bcrypt limit is always
 *                          enforced.
 * @param policy.validator  Application-defined check returning an error
 *                          message or `null`. Pass `null` to remove it.
 */
export function UserPasswordSetPolicy(policy: {
  minLength?: number;
  validator?: ((password: string) => string | null) | null;
}): void {
  if (policy.minLength !== undefined) {
    minLength = Number.isFinite(policy.minLength)
      ? Math.max(0, Math.floor(policy.minLength))
      : 0;
  }
  if (policy.validator !== undefined) {
    customValidator = policy.validator;
  }
}

/** Configured minimum password length (0 = no minimum). */
export function UserPasswordGetMinLength(): number {
  return minLength;
}

/**
 * Validate a password against the configured policy and the bcrypt limit.
 *
 * @returns An error message, or `null` when the password is acceptable.
 */
export function UserPasswordValidate(password: unknown): string | null {
  if (typeof password !== "string") {
    return "Invalid: Password";
  }
  if (password === "") {
    return "Missing: Password";
  }
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_PASSWORD_BYTES) {
    return `Password Too Long (maximum ${BCRYPT_MAX_PASSWORD_BYTES} bytes)`;
  }
  if (minLength > 0 && [...password].length < minLength) {
    return `Password Too Short (minimum ${minLength} characters)`;
  }
  return customValidator ? customValidator(password) : null;
}

export async function UserPasswordSetPassword(
  context: Span | undefined,
  user: User,
  password: string,
): Promise<void> {
  const error = UserPasswordValidate(password);
  if (error) {
    throw new Error(error);
  }
  const salt = await bcrypt.genSalt(10);
  user.passwordEncrypted = await bcrypt.hash(password, salt);
}

export async function UserPasswordCheckPassword(
  context: Span | undefined,
  user: User,
  password: string,
): Promise<boolean> {
  return await bcrypt.compare(password, user.passwordEncrypted);
}

/**
 * Run a bcrypt comparison against a fixed dummy hash. Used on the
 * unknown-user login path so response timing does not disclose whether an
 * account exists.
 */
export async function UserPasswordCheckPasswordDummy(
  password: unknown,
): Promise<void> {
  await bcrypt.compare(
    typeof password === "string" ? password : "",
    DUMMY_PASSWORD_HASH,
  );
}

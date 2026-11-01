import type { Span } from "@opentelemetry/sdk-trace";
import * as bcrypt from "bcrypt";
import { User } from "./User";

/** bcrypt only uses the first 72 bytes of a password. */
const BCRYPT_MAX_PASSWORD_BYTES = 72;

/** Default bcrypt cost factor (kept at the historical value). */
export const BCRYPT_ROUNDS_DEFAULT = 10;
/** Lowest accepted bcrypt cost factor. */
export const BCRYPT_ROUNDS_MIN = 10;
/** Highest accepted bcrypt cost factor. */
export const BCRYPT_ROUNDS_MAX = 15;

let minLength = 0;
let customValidator: ((password: string) => string | null) | null = null;
let bcryptRounds = BCRYPT_ROUNDS_DEFAULT;

/**
 * Configure the password policy applied by {@link UserPasswordValidate} and
 * {@link UserPasswordSetPassword}.
 *
 * @param policy.minLength     Minimum number of characters (default 0: no
 *                             minimum). The 72-byte bcrypt limit is always
 *                             enforced.
 * @param policy.validator     Application-defined check returning an error
 *                             message or `null`. Pass `null` to remove it.
 * @param policy.bcryptRounds  Cost factor for new hashes (default 10, clamped
 *                             to 10-15). Each increment doubles the CPU cost;
 *                             stored hashes keep the cost they were created
 *                             with.
 */
export function UserPasswordSetPolicy(policy: {
  minLength?: number;
  validator?: ((password: string) => string | null) | null;
  bcryptRounds?: number;
}): void {
  if (policy.minLength !== undefined) {
    minLength = Number.isFinite(policy.minLength)
      ? Math.max(0, Math.floor(policy.minLength))
      : 0;
  }
  if (policy.validator !== undefined) {
    customValidator = policy.validator;
  }
  if (policy.bcryptRounds !== undefined) {
    bcryptRounds = Number.isFinite(policy.bcryptRounds)
      ? Math.min(
          BCRYPT_ROUNDS_MAX,
          Math.max(BCRYPT_ROUNDS_MIN, Math.floor(policy.bcryptRounds)),
        )
      : BCRYPT_ROUNDS_DEFAULT;
  }
}

/** Configured minimum password length (0 = no minimum). */
export function UserPasswordGetMinLength(): number {
  return minLength;
}

/** Configured bcrypt cost factor for new hashes (10-15). */
export function UserPasswordGetBcryptRounds(): number {
  return bcryptRounds;
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
  const salt = await bcrypt.genSalt(bcryptRounds);
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
 * Run one bcrypt operation at the configured cost. Used on the unknown-user
 * login path so response timing does not disclose whether an account exists:
 * the result is discarded and the cost matches a real password check.
 */
export async function UserPasswordCheckPasswordDummy(
  password: unknown,
): Promise<void> {
  const salt = await bcrypt.genSalt(bcryptRounds);
  await bcrypt.hash(typeof password === "string" ? password : "", salt);
}

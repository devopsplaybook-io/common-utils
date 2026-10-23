/**
 * Largest delay `setTimeout` accepts; larger values overflow and fire almost
 * immediately (1 ms), so they are rejected instead.
 */
export const TIMEOUT_MAX_DURATION_MS = 2_147_483_647;

/**
 * Promise-based wrapper around `setTimeout`.
 *
 * @param duration  Delay in milliseconds: a finite, non-negative number no
 *                  larger than {@link TIMEOUT_MAX_DURATION_MS}.
 * @returns Resolves after the delay; rejects with a `RangeError` when the
 *          duration is invalid.
 */
export function TimeoutWait(duration: number): Promise<void> {
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0
  ) {
    return Promise.reject(
      new RangeError(
        `Invalid timeout duration: ${String(duration)} (expected a finite non-negative number of milliseconds)`,
      ),
    );
  }
  if (duration > TIMEOUT_MAX_DURATION_MS) {
    return Promise.reject(
      new RangeError(
        `Invalid timeout duration: ${duration} (maximum ${TIMEOUT_MAX_DURATION_MS} ms)`,
      ),
    );
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
}

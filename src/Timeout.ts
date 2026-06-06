/**
 * Promise-based wrapper around `setTimeout`.
 *
 * @param duration  Delay in milliseconds.
 */
export function TimeoutWait(duration: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
}

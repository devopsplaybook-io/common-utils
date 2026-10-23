import { TIMEOUT_MAX_DURATION_MS, TimeoutWait } from "./Timeout";

describe("TimeoutWait", () => {
  it("should resolve after the specified duration", async () => {
    const start = Date.now();
    const delayMs = 50;
    await TimeoutWait(delayMs);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
  });

  it("should resolve immediately for duration 0", async () => {
    const start = Date.now();
    await TimeoutWait(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5])(
    "should reject invalid duration %s with a RangeError",
    async (duration) => {
      await expect(TimeoutWait(duration)).rejects.toBeInstanceOf(RangeError);
    },
  );

  it("should reject durations beyond the setTimeout maximum", async () => {
    await expect(
      TimeoutWait(TIMEOUT_MAX_DURATION_MS + 1),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("should reject non-number durations", async () => {
    await expect(
      TimeoutWait("100" as unknown as number),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

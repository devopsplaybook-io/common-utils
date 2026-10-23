import {
  HttpRetry,
  HttpRetryIsRetryable,
  HttpRetryNormalizeOptions,
} from "./HttpRetry";

function axiosError(status?: number): Error {
  return Object.assign(new Error(status ? `HTTP ${status}` : "network down"), {
    isAxiosError: true,
    response: status === undefined ? undefined : { status },
  });
}

describe("HttpRetryNormalizeOptions", () => {
  it("should be disabled by default", () => {
    expect(HttpRetryNormalizeOptions()).toEqual({
      maxAttempts: 1,
      baseDelayMs: 250,
      maxDelayMs: 10000,
    });
  });

  it("should keep explicit values", () => {
    expect(
      HttpRetryNormalizeOptions({
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 2000,
      }),
    ).toEqual({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 2000 });
  });

  it("should cap maxAttempts at 10", () => {
    expect(
      HttpRetryNormalizeOptions({ maxAttempts: 100 }).maxAttempts,
    ).toBe(10);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "should fall back to no retry for invalid maxAttempts %s",
    (maxAttempts) => {
      expect(
        HttpRetryNormalizeOptions({ maxAttempts }).maxAttempts,
      ).toBe(1);
    },
  );

  it("should fall back to defaults for invalid delays", () => {
    expect(
      HttpRetryNormalizeOptions({
        baseDelayMs: Number.NaN,
        maxDelayMs: -5,
      }),
    ).toEqual({
      maxAttempts: 1,
      baseDelayMs: 250,
      maxDelayMs: 10000,
    });
  });

  it("should never let maxDelayMs be lower than baseDelayMs", () => {
    expect(
      HttpRetryNormalizeOptions({ baseDelayMs: 500, maxDelayMs: 100 }),
    ).toEqual({
      maxAttempts: 1,
      baseDelayMs: 500,
      maxDelayMs: 500,
    });
  });
});

describe("HttpRetryIsRetryable", () => {
  it("should retry network errors without a response", () => {
    expect(HttpRetryIsRetryable(axiosError())).toBe(true);
  });

  it.each([429, 500, 502, 503, 599])(
    "should retry HTTP %s",
    (status) => {
      expect(HttpRetryIsRetryable(axiosError(status))).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 408, 422])(
    "should not retry HTTP %s",
    (status) => {
      expect(HttpRetryIsRetryable(axiosError(status))).toBe(false);
    },
  );

  it("should not retry non-Axios errors", () => {
    expect(HttpRetryIsRetryable(new Error("plain failure"))).toBe(false);
    expect(HttpRetryIsRetryable("boom")).toBe(false);
    expect(HttpRetryIsRetryable(undefined)).toBe(false);
  });
});

describe("HttpRetry", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("should call the operation once when retry is not configured", async () => {
    const operation = jest.fn().mockRejectedValue(axiosError(503));

    await expect(HttpRetry(operation)).rejects.toThrow("HTTP 503");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should return the first successful result without retrying", async () => {
    const operation = jest.fn().mockResolvedValue("ok");

    await expect(HttpRetry(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should retry retryable failures until success", async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(axiosError(503))
      .mockRejectedValueOnce(axiosError(429))
      .mockResolvedValueOnce("ok");
    const onRetry = jest.fn();

    await expect(
      HttpRetry(operation, { maxAttempts: 3, baseDelayMs: 0 }, onRetry),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 0, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 0, expect.any(Error));
  });

  it("should rethrow the last error after exhausting maxAttempts", async () => {
    const operation = jest.fn().mockRejectedValue(axiosError(500));

    await expect(
      HttpRetry(operation, { maxAttempts: 3, baseDelayMs: 0 }),
    ).rejects.toThrow("HTTP 500");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should not retry non-retryable failures", async () => {
    const operation = jest.fn().mockRejectedValue(axiosError(400));
    const onRetry = jest.fn();

    await expect(
      HttpRetry(operation, { maxAttempts: 5, baseDelayMs: 0 }, onRetry),
    ).rejects.toThrow("HTTP 400");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("should not retry non-Axios failures", async () => {
    const operation = jest.fn().mockRejectedValue(new Error("plain failure"));

    await expect(
      HttpRetry(operation, { maxAttempts: 5, baseDelayMs: 0 }),
    ).rejects.toThrow("plain failure");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should apply exponential backoff with jitter", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    const operation = jest.fn().mockRejectedValue(axiosError(503));
    const onRetry = jest.fn();

    await expect(
      HttpRetry(
        operation,
        { maxAttempts: 3, baseDelayMs: 4, maxDelayMs: 100 },
        onRetry,
      ),
    ).rejects.toThrow("HTTP 503");

    // random = 0.5 → delays of 0.5 * 4 = 2 ms, then 0.5 * 8 = 4 ms.
    expect(onRetry.mock.calls.map((call) => call[1])).toEqual([2, 4]);
  });

  it("should cap the backoff delay at maxDelayMs", async () => {
    jest.spyOn(Math, "random").mockReturnValue(1);
    const operation = jest.fn().mockRejectedValue(axiosError(503));
    const onRetry = jest.fn();

    await expect(
      HttpRetry(
        operation,
        { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 15 },
        onRetry,
      ),
    ).rejects.toThrow("HTTP 503");

    expect(onRetry.mock.calls.map((call) => call[1])).toEqual([10, 15, 15]);
  });
});

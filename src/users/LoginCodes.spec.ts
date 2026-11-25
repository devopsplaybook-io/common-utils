import {
  LOGIN_CODE_ALPHABET,
  LOGIN_CODE_ERROR_ALREADY_USED,
  LOGIN_CODE_ERROR_FORBIDDEN,
  LOGIN_CODE_ERROR_INVALID_CODE,
  LOGIN_CODE_ERROR_PASSWORD_REQUIRED,
  LOGIN_CODE_ERROR_RATE_LIMITED,
  LOGIN_CODE_ERROR_UNAUTHENTICATED,
  LOGIN_CODE_ERROR_UNAVAILABLE,
  LOGIN_CODE_LENGTH,
  LOGIN_CODES_DEFAULT_SETTINGS,
  LoginCodeDeviceLabel,
  LoginCodeGenerateCode,
  LoginCodeGenerateRequestToken,
  LoginCodeHashCode,
  LoginCodeHashRequestToken,
  LoginCodeIso,
  LoginCodeNewId,
  LoginCodeNormalize,
  LoginCodeParseIso,
  LoginCodeTruncateUserAgent,
  LoginCodesGetApproveRequiresPassword,
  LoginCodesGetEnabled,
  LoginCodesGetGraceSeconds,
  LoginCodesGetMaxAttempts,
  LoginCodesGetMaxPending,
  LoginCodesGetPollIntervalMs,
  LoginCodesGetRateLimitApproveMax,
  LoginCodesGetRateLimitCreateMax,
  LoginCodesGetRateLimitPollMax,
  LoginCodesGetRateLimitWindowSeconds,
  LoginCodesGetRotationSeconds,
  LoginCodesGetTtlSeconds,
  LoginCodesOptionsFromConfig,
} from "./LoginCodes";

describe("LoginCodes core", () => {
  describe("code generation", () => {
    it("uses the RFC 8628 base20 alphabet", () => {
      expect(LOGIN_CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
      expect(LOGIN_CODE_ALPHABET).toHaveLength(20);
      expect(LOGIN_CODE_LENGTH).toBe(8);
    });

    it("generates 8 characters strictly from the alphabet", () => {
      for (let index = 0; index < 200; index += 1) {
        const code = LoginCodeGenerateCode();
        expect(code).toHaveLength(8);
        for (const char of code) {
          expect(LOGIN_CODE_ALPHABET).toContain(char);
        }
      }
    });

    it("normalises case, whitespace and hyphens", () => {
      expect(LoginCodeNormalize("bcdf-ghjk")).toBe("BCDFGHJK");
      expect(LoginCodeNormalize(" BCDF GHJK ")).toBe("BCDFGHJK");
      expect(LoginCodeNormalize("bcdfghjk")).toBe("BCDFGHJK");
    });

    it("rejects codes outside the alphabet or of the wrong length", () => {
      expect(LoginCodeNormalize("ABCDEFGH")).toBeNull(); // vowels not allowed
      expect(LoginCodeNormalize("BCDFGHJ")).toBeNull();
      expect(LoginCodeNormalize("BCDFGHJKL")).toBeNull();
      expect(LoginCodeNormalize("BCDF0HJK")).toBeNull();
      expect(LoginCodeNormalize("")).toBeNull();
      expect(LoginCodeNormalize(12345678)).toBeNull();
      expect(LoginCodeNormalize(undefined)).toBeNull();
    });
  });

  describe("hashing", () => {
    it("generates a 256-bit base64url request token", () => {
      const token = LoginCodeGenerateRequestToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(LoginCodeGenerateRequestToken()).not.toBe(token);
    });

    it("hashes request tokens with SHA-256 hex", () => {
      const hash = LoginCodeHashRequestToken("token");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(LoginCodeHashRequestToken("token")).toBe(hash);
      expect(LoginCodeHashRequestToken("other")).not.toBe(hash);
    });

    it("hashes codes with a keyed HMAC (key sensitive)", () => {
      const first = LoginCodeHashCode("BCDFGHJK", "key-1");
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(LoginCodeHashCode("BCDFGHJK", "key-1")).toBe(first);
      expect(LoginCodeHashCode("BCDFGHJK", "key-2")).not.toBe(first);
      expect(LoginCodeHashCode("BCDFGHJL", "key-1")).not.toBe(first);
    });

    it("generates UUID ids", () => {
      expect(LoginCodeNewId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("user agent helpers", () => {
    it("labels common browsers and operating systems", () => {
      expect(
        LoginCodeDeviceLabel(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ),
      ).toBe("Chrome on macOS");
      expect(
        LoginCodeDeviceLabel(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
        ),
      ).toBe("Firefox on Windows");
      expect(
        LoginCodeDeviceLabel(
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        ),
      ).toBe("Safari on iOS");
      expect(
        LoginCodeDeviceLabel(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
        ),
      ).toBe("Edge on Windows");
      expect(
        LoginCodeDeviceLabel(
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 SamsungBrowser/23.0 Safari/537.36",
        ),
      ).toBe("Chrome on Linux");
    });

    it("falls back to the unknown labels", () => {
      expect(LoginCodeDeviceLabel("")).toBe("Unknown device");
      expect(LoginCodeDeviceLabel(null)).toBe("Unknown device");
      expect(LoginCodeDeviceLabel("some-agent/1.0")).toBe("Unknown device");
      expect(LoginCodeDeviceLabel("Mozilla/5.0 (Windows NT 10.0)")).toBe(
        "Unknown browser on Windows",
      );
      expect(LoginCodeDeviceLabel("Mozilla/5.0 Chrome/120.0")).toBe(
        "Chrome on Unknown OS",
      );
    });

    it("truncates the stored user agent to 512 characters", () => {
      const long = "a".repeat(600);
      expect(LoginCodeTruncateUserAgent(long)).toHaveLength(512);
      expect(LoginCodeTruncateUserAgent("  ")).toBeNull();
      expect(LoginCodeTruncateUserAgent(123)).toBeNull();
      expect(LoginCodeTruncateUserAgent(" agent ")).toBe("agent");
    });
  });

  describe("time helpers", () => {
    it("converts epoch milliseconds to ISO and parses it back", () => {
      const iso = LoginCodeIso(1_700_000_000_000);
      expect(iso).toBe("2023-11-14T22:13:20.000Z");
      expect(LoginCodeParseIso(iso)).toBe(1_700_000_000_000);
      expect(LoginCodeParseIso("nonsense")).toBeNaN();
      expect(LoginCodeParseIso(null)).toBeNaN();
    });
  });

  describe("configuration", () => {
    it("exposes safe defaults with the feature off", () => {
      expect(LoginCodesGetEnabled()).toBe(false);
      expect(LOGIN_CODES_DEFAULT_SETTINGS).toEqual({
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
      expect(LoginCodesOptionsFromConfig()).toEqual({
        ...LOGIN_CODES_DEFAULT_SETTINGS,
      });
    });

    it("reads and coerces explicit values", () => {
      const config = {
        LOGIN_CODE_ENABLED: "yes",
        LOGIN_CODE_TTL_SECONDS: "120",
        LOGIN_CODE_ROTATION_SECONDS: 10,
        LOGIN_CODE_GRACE_SECONDS: 15,
        LOGIN_CODE_POLL_INTERVAL_MS: 1000,
        LOGIN_CODE_MAX_ATTEMPTS: 3,
        LOGIN_CODE_MAX_PENDING: 7,
        LOGIN_CODE_RATE_LIMIT_CREATE_MAX: 2,
        LOGIN_CODE_RATE_LIMIT_POLL_MAX: 20,
        LOGIN_CODE_RATE_LIMIT_APPROVE_MAX: 4,
        AUTH_RATE_LIMIT_WINDOW_SECONDS: 30,
        LOGIN_CODE_APPROVE_REQUIRE_PASSWORD: "true",
      };
      expect(LoginCodesGetEnabled(config)).toBe(true);
      expect(LoginCodesGetTtlSeconds(config)).toBe(120);
      expect(LoginCodesGetRotationSeconds(config)).toBe(10);
      expect(LoginCodesGetGraceSeconds(config)).toBe(15);
      expect(LoginCodesGetPollIntervalMs(config)).toBe(1000);
      expect(LoginCodesGetMaxAttempts(config)).toBe(3);
      expect(LoginCodesGetMaxPending(config)).toBe(7);
      expect(LoginCodesGetRateLimitCreateMax(config)).toBe(2);
      expect(LoginCodesGetRateLimitPollMax(config)).toBe(20);
      expect(LoginCodesGetRateLimitApproveMax(config)).toBe(4);
      expect(LoginCodesGetRateLimitWindowSeconds(config)).toBe(30);
      expect(LoginCodesGetApproveRequiresPassword(config)).toBe(true);
    });

    it("clamps pathological values and falls back on invalid input", () => {
      expect(
        LoginCodesGetRotationSeconds({ LOGIN_CODE_ROTATION_SECONDS: 1 }),
      ).toBe(5);
      expect(LoginCodesGetTtlSeconds({ LOGIN_CODE_TTL_SECONDS: 1 })).toBe(30);
      expect(LoginCodesGetMaxAttempts({ LOGIN_CODE_MAX_ATTEMPTS: 0 })).toBe(1);
      expect(
        LoginCodesGetTtlSeconds({ LOGIN_CODE_TTL_SECONDS: "not-a-number" }),
      ).toBe(300);
      expect(LoginCodesGetEnabled({ LOGIN_CODE_ENABLED: "maybe" })).toBe(false);
      expect(
        LoginCodesGetRateLimitCreateMax({
          LOGIN_CODE_RATE_LIMIT_CREATE_MAX: 0,
        }),
      ).toBe(0);
      expect(
        LoginCodesGetApproveRequiresPassword({
          LOGIN_CODE_APPROVE_REQUIRE_PASSWORD: "no",
        }),
      ).toBe(false);
    });

    it("exposes stable error codes", () => {
      expect(LOGIN_CODE_ERROR_INVALID_CODE).toBe("INVALID_CODE");
      expect(LOGIN_CODE_ERROR_ALREADY_USED).toBe("ALREADY_USED");
      expect(LOGIN_CODE_ERROR_RATE_LIMITED).toBe("RATE_LIMITED");
      expect(LOGIN_CODE_ERROR_UNAVAILABLE).toBe("LOGIN_CODE_UNAVAILABLE");
      expect(LOGIN_CODE_ERROR_PASSWORD_REQUIRED).toBe("PASSWORD_REQUIRED");
      expect(LOGIN_CODE_ERROR_UNAUTHENTICATED).toBe("UNAUTHENTICATED");
      expect(LOGIN_CODE_ERROR_FORBIDDEN).toBe("FORBIDDEN");
    });
  });
});

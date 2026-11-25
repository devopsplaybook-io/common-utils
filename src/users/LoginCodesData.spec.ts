import {
  LoginCodeConsumeAttempt,
  LoginCodeIsExpiredAt,
  LoginCodeResolveByCode,
  LoginCodeRotateIfDue,
  LoginCodeRotationDue,
} from "./LoginCodesData";
import {
  LoginCodeHashCode,
  LoginCodeIso,
  LoginCodeRecord,
  LoginCodesStore,
} from "./LoginCodes";

const KEY = "test-key";
const BASE_MS = 1_700_000_000_000;
const CODE = "BCDFGHJK";
const HASH = LoginCodeHashCode(CODE, KEY);

function makeRecord(overrides: Partial<LoginCodeRecord> = {}): LoginCodeRecord {
  return {
    id: "request-1",
    requestTokenHash: "token-hash",
    codeHash: HASH,
    previousCodeHash: null,
    codeExpiresAt: LoginCodeIso(BASE_MS + 30_000),
    previousCodeExpiresAt: null,
    status: "pending",
    createdAt: LoginCodeIso(BASE_MS),
    updatedAt: LoginCodeIso(BASE_MS),
    expiresAt: LoginCodeIso(BASE_MS + 300_000),
    approvedAt: null,
    approvedByUserId: null,
    consumedAt: null,
    attempts: 0,
    requestUserAgent: null,
    ...overrides,
  };
}

function makeStore(overrides: Partial<Record<string, jest.Mock>> = {}): {
  store: LoginCodesStore;
  getByCodeHash: jest.Mock;
  getByRequestTokenHash: jest.Mock;
  recordAttempt: jest.Mock;
  rotate: jest.Mock;
} {
  const getByCodeHash = jest.fn(async () => null);
  const getByRequestTokenHash = jest.fn(async () => null);
  const recordAttempt = jest.fn(async () => true);
  const rotate = jest.fn(async () => true);
  const store = {
    available: jest.fn(async () => true),
    create: jest.fn(async () => ({ ok: true })),
    getByCodeHash,
    getByRequestTokenHash,
    rotate,
    approve: jest.fn(async () => true),
    consume: jest.fn(async () => null),
    cancel: jest.fn(async () => true),
    markExpired: jest.fn(async () => true),
    markFailed: jest.fn(async () => true),
    recordAttempt,
    cleanup: jest.fn(async () => 0),
    ...overrides,
  } as unknown as LoginCodesStore;
  return {
    store,
    getByCodeHash: store.getByCodeHash as jest.Mock,
    getByRequestTokenHash: store.getByRequestTokenHash as jest.Mock,
    recordAttempt: store.recordAttempt as jest.Mock,
    rotate: store.rotate as jest.Mock,
  };
}

describe("LoginCodesData", () => {
  describe("LoginCodeResolveByCode", () => {
    it("resolves the current code", async () => {
      const { store, getByCodeHash } = makeStore();
      const record = makeRecord();
      getByCodeHash.mockResolvedValue(record);

      const resolved = await LoginCodeResolveByCode(store, {
        code: "bcdf-ghjk",
        hashKey: KEY,
        nowMs: BASE_MS,
      });

      expect(getByCodeHash).toHaveBeenCalledWith(HASH, undefined);
      expect(resolved).toEqual({
        record,
        matchedCodeHash: HASH,
        usedPrevious: false,
      });
    });

    it("accepts the previous code while its grace period is active", async () => {
      const previousHash = LoginCodeHashCode("BCDFGHJL", KEY);
      const record = makeRecord({
        codeHash: LoginCodeHashCode("BCDFGHJM", KEY),
        previousCodeHash: previousHash,
        previousCodeExpiresAt: LoginCodeIso(BASE_MS + 60_000),
      });
      const { store, getByCodeHash } = makeStore();
      getByCodeHash.mockResolvedValue(record);

      const resolved = await LoginCodeResolveByCode(store, {
        code: "BCDFGHJL",
        hashKey: KEY,
        nowMs: BASE_MS + 59_000,
      });

      expect(resolved?.usedPrevious).toBe(true);
      expect(resolved?.matchedCodeHash).toBe(previousHash);
    });

    it("rejects the previous code once the grace period elapsed", async () => {
      const previousHash = LoginCodeHashCode("BCDFGHJL", KEY);
      const record = makeRecord({
        codeHash: LoginCodeHashCode("BCDFGHJM", KEY),
        previousCodeHash: previousHash,
        previousCodeExpiresAt: LoginCodeIso(BASE_MS + 60_000),
      });
      const { store, getByCodeHash } = makeStore();
      getByCodeHash.mockResolvedValue(record);

      await expect(
        LoginCodeResolveByCode(store, {
          code: "BCDFGHJL",
          hashKey: KEY,
          nowMs: BASE_MS + 60_000,
        }),
      ).resolves.toBeNull();
    });

    it("answers null for malformed codes without querying the store", async () => {
      const { store, getByCodeHash } = makeStore();
      for (const code of ["nope", "ABCDEFGH", 42, null]) {
        await expect(
          LoginCodeResolveByCode(store, { code, hashKey: KEY, nowMs: BASE_MS }),
        ).resolves.toBeNull();
      }
      expect(getByCodeHash).not.toHaveBeenCalled();
    });

    it("answers null when no key or no row is available", async () => {
      const { store, getByCodeHash } = makeStore();
      await expect(
        LoginCodeResolveByCode(store, {
          code: CODE,
          hashKey: "",
          nowMs: BASE_MS,
        }),
      ).resolves.toBeNull();
      await expect(
        LoginCodeResolveByCode(store, {
          code: CODE,
          hashKey: KEY,
          nowMs: BASE_MS,
        }),
      ).resolves.toBeNull();
      expect(getByCodeHash).toHaveBeenCalledTimes(1);
    });
  });

  describe("LoginCodeConsumeAttempt", () => {
    it("reports the attempt as allowed", async () => {
      const { store, recordAttempt } = makeStore();
      await expect(
        LoginCodeConsumeAttempt(store, {
          record: makeRecord(),
          maxAttempts: 5,
          nowMs: BASE_MS,
        }),
      ).resolves.toEqual({ allowed: true });
      expect(recordAttempt).toHaveBeenCalledWith(
        { id: "request-1", maxAttempts: 5, updatedAt: LoginCodeIso(BASE_MS) },
        undefined,
      );
    });

    it("re-reads the row when the attempt is refused", async () => {
      const refreshed = makeRecord({ attempts: 5 });
      const { store, recordAttempt, getByRequestTokenHash } = makeStore();
      recordAttempt.mockResolvedValue(false);
      getByRequestTokenHash.mockResolvedValue(refreshed);

      await expect(
        LoginCodeConsumeAttempt(store, {
          record: makeRecord(),
          maxAttempts: 5,
          nowMs: BASE_MS,
        }),
      ).resolves.toEqual({ allowed: false, record: refreshed });
      expect(getByRequestTokenHash).toHaveBeenCalledWith(
        "token-hash",
        undefined,
      );
    });
  });

  describe("LoginCodeIsExpiredAt", () => {
    it("compares against the absolute TTL and fails closed", () => {
      expect(LoginCodeIsExpiredAt(makeRecord(), BASE_MS)).toBe(false);
      expect(LoginCodeIsExpiredAt(makeRecord(), BASE_MS + 300_000)).toBe(true);
      expect(
        LoginCodeIsExpiredAt(makeRecord({ expiresAt: "broken" }), BASE_MS),
      ).toBe(true);
    });
  });

  describe("LoginCodeRotationDue", () => {
    const args = { rotationSeconds: 30, nowMs: BASE_MS };

    it("rotates when the code window elapsed", () => {
      expect(LoginCodeRotationDue(makeRecord(), args)).toBe(false);
      expect(
        LoginCodeRotationDue(makeRecord(), {
          ...args,
          nowMs: BASE_MS + 30_000,
        }),
      ).toBe(true);
    });

    it("rotates immediately when the code window is unreadable", () => {
      expect(
        LoginCodeRotationDue(makeRecord({ codeExpiresAt: "broken" }), args),
      ).toBe(true);
    });

    it("never rotates a request that left the pending state", () => {
      expect(
        LoginCodeRotationDue(makeRecord({ status: "approved" }), {
          ...args,
          nowMs: BASE_MS + 60_000,
        }),
      ).toBe(false);
    });

    it("honours refreshCode only after the minimum interval", () => {
      expect(
        LoginCodeRotationDue(makeRecord(), {
          ...args,
          nowMs: BASE_MS + 4_999,
          refreshCode: true,
        }),
      ).toBe(false);
      expect(
        LoginCodeRotationDue(makeRecord(), {
          ...args,
          nowMs: BASE_MS + 5_000,
          refreshCode: true,
        }),
      ).toBe(true);
    });
  });

  describe("LoginCodeRotateIfDue", () => {
    const args = {
      hashKey: KEY,
      rotationSeconds: 30,
      graceSeconds: 60,
      nowMs: BASE_MS + 30_000,
    };

    it("returns the record unchanged when a rotation is not due", async () => {
      const record = makeRecord();
      const { store, rotate } = makeStore();
      const result = await LoginCodeRotateIfDue(store, {
        ...args,
        record,
        nowMs: BASE_MS,
      });
      expect(result).toEqual({ rotated: false, code: null, record });
      expect(rotate).not.toHaveBeenCalled();
    });

    it("rotates with a grace window and returns the new code", async () => {
      const record = makeRecord();
      const { store, rotate } = makeStore();
      const result = await LoginCodeRotateIfDue(store, { ...args, record });

      expect(result.rotated).toBe(true);
      expect(result.code).toHaveLength(8);
      expect(result.record.codeHash).toBe(
        LoginCodeHashCode(result.code as string, KEY),
      );
      expect(result.record.previousCodeHash).toBe(HASH);
      expect(result.record.codeExpiresAt).toBe(
        LoginCodeIso(BASE_MS + 30_000 + 30_000),
      );
      expect(result.record.previousCodeExpiresAt).toBe(
        LoginCodeIso(BASE_MS + 30_000 + 60_000),
      );
      expect(rotate).toHaveBeenCalledTimes(1);
    });

    it("re-reads the row when it loses the compare-and-set race", async () => {
      const refreshed = makeRecord({
        codeHash: LoginCodeHashCode("BCDFGHJM", KEY),
      });
      const { store, rotate, getByRequestTokenHash } = makeStore();
      rotate.mockResolvedValue(false);
      getByRequestTokenHash.mockResolvedValue(refreshed);

      const result = await LoginCodeRotateIfDue(store, {
        ...args,
        record: makeRecord(),
      });
      expect(result).toEqual({ rotated: false, code: null, record: refreshed });
    });

    it("does not rotate without a hash key", async () => {
      const record = makeRecord();
      const { store, rotate } = makeStore();
      const result = await LoginCodeRotateIfDue(store, {
        ...args,
        record,
        hashKey: "",
      });
      expect(result.rotated).toBe(false);
      expect(rotate).not.toHaveBeenCalled();
    });
  });
});

import { createHash } from "crypto";
import {
  LoginCodeCreateInput,
  LoginCodesStore,
} from "./LoginCodes";

/**
 * Conformance kit for any {@link LoginCodesStore} implementation.
 *
 * Security-critical store logic (single use, first-approval-wins, atomic
 * attempt and pending caps, rotation compare-and-set, cleanup bounds) must not
 * be left to each application's interpretation. Run this suite against a
 * store backed by an empty table (reset your database first) and fail the
 * build when any invariant does not hold.
 *
 * The file is dependency-free: it exports plain async functions and a loose
 * Jest/Vitest adapter, and is safe to publish.
 */

export interface LoginCodesStoreConformanceOptions {
  /** Build the store to test. Called once per run (once per test in the adapter). */
  createStore: () => LoginCodesStore | Promise<LoginCodesStore>;
  /** Clock override (defaults to `Date.now`). */
  now?: () => number;
}

export interface LoginCodesStoreConformanceResult {
  passed: boolean;
  results: { name: string; ok: boolean; error?: string }[];
}

interface ConformanceCheck {
  name: string;
  run: (store: LoginCodesStore) => Promise<void>;
}

type TestApi = {
  describe: (name: string, callback: () => void) => void;
  it: (name: string, callback: () => Promise<void> | void) => void;
  expect?: unknown;
};

/** Deterministic base clock so timestamps do not depend on the wall clock. */
const BASE_MS = 1_700_000_000_000;

function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

let counter = 0;

function nextKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${BASE_MS}-${counter}`;
}

/** A create input with an explicit id, token and code hash. */
function makeInput(
  id: string,
  overrides: Partial<LoginCodeCreateInput> = {},
): LoginCodeCreateInput {
  return {
    id,
    requestTokenHash: hash(`token:${id}`),
    codeHash: hash(`code:${id}`),
    codeExpiresAt: iso(30_000),
    createdAt: iso(0),
    updatedAt: iso(0),
    expiresAt: iso(300_000),
    requestUserAgent: "conformance-suite",
    maxPending: 1_000_000,
    ...overrides,
  };
}

/**
 * Remove every row this suite could have written. All rows use a `createdAt`
 * well below the fixed clock's far-future cutoff, while rows the application
 * created with the real clock (2026) are newer and stay untouched.
 */
async function reset(store: LoginCodesStore): Promise<void> {
  await store.cleanup({ olderThan: iso(1_000_000_000), limit: 1_000_000 });
}

async function createOk(
  store: LoginCodesStore,
  input: LoginCodeCreateInput,
): Promise<void> {
  const result = await store.create(input);
  assert(
    result.ok === true,
    `expected create(${input.id}) to succeed, got ${JSON.stringify(result)}`,
  );
}

async function getRow(
  store: LoginCodesStore,
  input: LoginCodeCreateInput,
) {
  const row = await store.getByRequestTokenHash(input.requestTokenHash);
  assert(row, `expected a row for request token hash ${input.requestTokenHash}`);
  return row;
}

const CHECKS: ConformanceCheck[] = [
  {
    name: "available() reports true for an initialised store",
    async run(store) {
      assert((await store.available()) === true, "available() must return true");
    },
  },
  {
    name: "create/getByRequestTokenHash round-trip preserves the record",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("round-trip"));
      await createOk(store, input);
      const row = await getRow(store, input);
      assert(row.id === input.id, "id mismatch");
      assert(row.requestTokenHash === input.requestTokenHash, "token hash mismatch");
      assert(row.codeHash === input.codeHash, "code hash mismatch");
      assert(row.codeExpiresAt === input.codeExpiresAt, "codeExpiresAt mismatch");
      assert(row.expiresAt === input.expiresAt, "expiresAt mismatch");
      assert(row.status === "pending", "new row must be pending");
      assert(row.attempts === 0, "attempts must start at 0");
      assert(row.approvedAt === null, "approvedAt must start null");
      assert(row.approvedByUserId === null, "approvedByUserId must start null");
      assert(row.consumedAt === null, "consumedAt must start null");
    },
  },
  {
    name: "create rejects a duplicate requestTokenHash",
    async run(store) {
      await reset(store);
      const first = makeInput(nextKey("dupe-token"));
      await createOk(store, first);
      const second = makeInput(nextKey("dupe-token"), {
        requestTokenHash: first.requestTokenHash,
        codeHash: hash(`code:${nextKey("dupe-token")}`),
      });
      const result = await store.create(second);
      assert(
        result.ok === false && result.reason === "conflict",
        `expected a conflict, got ${JSON.stringify(result)}`,
      );
    },
  },
  {
    name: "create rejects a duplicate codeHash",
    async run(store) {
      await reset(store);
      const first = makeInput(nextKey("dupe-code"));
      await createOk(store, first);
      const second = makeInput(nextKey("dupe-code"), {
        codeHash: first.codeHash,
      });
      const result = await store.create(second);
      assert(
        result.ok === false && result.reason === "conflict",
        `expected a conflict, got ${JSON.stringify(result)}`,
      );
    },
  },
  {
    name: "create enforces the global pending cap",
    async run(store) {
      await reset(store);
      const first = makeInput(nextKey("cap"), { maxPending: 2 });
      const second = makeInput(nextKey("cap"), { maxPending: 2 });
      const third = makeInput(nextKey("cap"), { maxPending: 2 });
      await createOk(store, first);
      await createOk(store, second);
      const result = await store.create(third);
      assert(
        result.ok === false && result.reason === "pending_cap",
        `expected pending_cap, got ${JSON.stringify(result)}`,
      );
    },
  },
  {
    name: "create enforces the pending cap atomically under concurrency",
    async run(store) {
      await reset(store);
      const inputs = Array.from({ length: 5 }, () =>
        makeInput(nextKey("cap-concurrent"), { maxPending: 2 }),
      );
      const results = await Promise.all(inputs.map((input) => store.create(input)));
      const okCount = results.filter((result) => result.ok).length;
      assert(okCount === 2, `expected exactly 2 successful creates, got ${okCount}`);
      const capped = results.filter(
        (result) => !result.ok && result.reason === "pending_cap",
      ).length;
      assert(capped === 3, `expected 3 pending_cap rejections, got ${capped}`);
    },
  },
  {
    name: "getByCodeHash matches the current and the previous code",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("by-code"));
      await createOk(store, input);
      const current = await store.getByCodeHash(input.codeHash);
      assert(current?.id === input.id, "current code hash must resolve the row");
      const newCodeHash = hash(`new-code:${input.id}`);
      const rotated = await store.rotate({
        id: input.id,
        expectedCodeHash: input.codeHash,
        newCodeHash,
        codeExpiresAt: iso(60_000),
        previousCodeExpiresAt: iso(90_000),
        updatedAt: iso(30_000),
      });
      assert(rotated === true, "rotate must succeed");
      const afterCurrent = await store.getByCodeHash(newCodeHash);
      assert(afterCurrent?.id === input.id, "new code hash must resolve the row");
      const afterPrevious = await store.getByCodeHash(input.codeHash);
      assert(afterPrevious?.id === input.id, "previous code hash must resolve the row");
    },
  },
  {
    name: "rotate is a compare-and-set on the current code hash",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("rotate"));
      await createOk(store, input);
      const newCodeHash = hash(`rotated:${input.id}`);
      const stale = await store.rotate({
        id: input.id,
        expectedCodeHash: hash("not-the-current-hash"),
        newCodeHash,
        codeExpiresAt: iso(60_000),
        previousCodeExpiresAt: iso(90_000),
        updatedAt: iso(30_000),
      });
      assert(stale === false, "a stale expected hash must not rotate");
      const ok = await store.rotate({
        id: input.id,
        expectedCodeHash: input.codeHash,
        newCodeHash,
        codeExpiresAt: iso(60_000),
        previousCodeExpiresAt: iso(90_000),
        updatedAt: iso(30_000),
      });
      assert(ok === true, "rotate with the current hash must succeed");
      const row = await getRow(store, input);
      assert(row.codeHash === newCodeHash, "codeHash not updated");
      assert(row.previousCodeHash === input.codeHash, "previousCodeHash not set");
      assert(row.previousCodeExpiresAt === iso(90_000), "previousCodeExpiresAt not set");
      assert(row.codeExpiresAt === iso(60_000), "codeExpiresAt not updated");
    },
  },
  {
    name: "rotate only applies to pending requests",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("rotate-approved"));
      await createOk(store, input);
      const approved = await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now: iso(1),
        approvedByUserId: "user-1",
        approvedAt: iso(1),
      });
      assert(approved === true, "approve must succeed");
      const rotated = await store.rotate({
        id: input.id,
        expectedCodeHash: input.codeHash,
        newCodeHash: hash(`late:${input.id}`),
        codeExpiresAt: iso(60_000),
        previousCodeExpiresAt: iso(90_000),
        updatedAt: iso(30_000),
      });
      assert(rotated === false, "an approved request must not rotate");
    },
  },
  {
    name: "approve is first-approval-wins",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("approve-once"));
      await createOk(store, input);
      const first = await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now: iso(1),
        approvedByUserId: "user-1",
        approvedAt: iso(1),
      });
      assert(first === true, "first approval must succeed");
      const second = await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now: iso(2),
        approvedByUserId: "user-2",
        approvedAt: iso(2),
      });
      assert(second === false, "second approval must be rejected");
      const row = await getRow(store, input);
      assert(row.status === "approved", "row must be approved");
      assert(row.approvedByUserId === "user-1", "first approver must win");
      assert(row.approvedAt === iso(1), "approvedAt must be recorded");
    },
  },
  {
    name: "approve is one-approval-wins under concurrency",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("approve-concurrent"));
      await createOk(store, input);
      const results = await Promise.all(
        ["user-1", "user-2", "user-3"].map((userId) =>
          store.approve({
            id: input.id,
            submittedCodeHash: input.codeHash,
            now: iso(1),
            approvedByUserId: userId,
            approvedAt: iso(1),
          }),
        ),
      );
      assert(
        results.filter((result) => result === true).length === 1,
        "exactly one concurrent approval must win",
      );
    },
  },
  {
    name: "approve only accepts the current or the previous code hash",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("approve-hash"));
      await createOk(store, input);
      const wrong = await store.approve({
        id: input.id,
        submittedCodeHash: hash("wrong"),
        now: iso(1),
        approvedByUserId: "user-1",
        approvedAt: iso(1),
      });
      assert(wrong === false, "an unknown code hash must not approve");
      const newCodeHash = hash(`rotated:${input.id}`);
      await store.rotate({
        id: input.id,
        expectedCodeHash: input.codeHash,
        newCodeHash,
        codeExpiresAt: iso(30_000),
        previousCodeExpiresAt: iso(90_000),
        updatedAt: iso(1),
      });
      const previous = await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now: iso(60_000),
        approvedByUserId: "user-1",
        approvedAt: iso(60_000),
      });
      assert(previous === true, "the previous hash must approve within grace");
    },
  },
  {
    name: "approve rejects the previous hash after its grace period",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("approve-grace"));
      await createOk(store, input);
      const newCodeHash = hash(`rotated:${input.id}`);
      await store.rotate({
        id: input.id,
        expectedCodeHash: input.codeHash,
        newCodeHash,
        codeExpiresAt: iso(30_000),
        previousCodeExpiresAt: iso(50_000),
        updatedAt: iso(1),
      });
      const expiredPrevious = await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now: iso(60_000),
        approvedByUserId: "user-1",
        approvedAt: iso(60_000),
      });
      assert(expiredPrevious === false, "the previous hash must expire with its grace");
    },
  },
  {
    name: "consume is single-use and returns the consumed row",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("consume"));
      await createOk(store, input);
      const approved = await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now: iso(1),
        approvedByUserId: "user-1",
        approvedAt: iso(1),
      });
      assert(approved === true, "approve must succeed");
      const consumed = await store.consume({
        requestTokenHash: input.requestTokenHash,
        consumedAt: iso(2),
        updatedAt: iso(2),
      });
      assert(consumed?.id === input.id, "consume must return the row");
      assert(consumed.status === "consumed", "consumed status must be set");
      assert(consumed.consumedAt === iso(2), "consumedAt must be recorded");
      const second = await store.consume({
        requestTokenHash: input.requestTokenHash,
        consumedAt: iso(3),
        updatedAt: iso(3),
      });
      assert(second === null, "a second consume must return null");
    },
  },
  {
    name: "consume is single-use under concurrency",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("consume-concurrent"));
      await createOk(store, input);
      await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now: iso(1),
        approvedByUserId: "user-1",
        approvedAt: iso(1),
      });
      const results = await Promise.all([
        store.consume({
          requestTokenHash: input.requestTokenHash,
          consumedAt: iso(2),
          updatedAt: iso(2),
        }),
        store.consume({
          requestTokenHash: input.requestTokenHash,
          consumedAt: iso(3),
          updatedAt: iso(3),
        }),
      ]);
      assert(
        results.filter((row) => row !== null).length === 1,
        "exactly one concurrent consume must win",
      );
    },
  },
  {
    name: "consume cannot redeem a request that was never approved",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("consume-pending"));
      await createOk(store, input);
      const consumed = await store.consume({
        requestTokenHash: input.requestTokenHash,
        consumedAt: iso(2),
        updatedAt: iso(2),
      });
      assert(consumed === null, "a pending request must not be redeemable");
    },
  },
  {
    name: "cancel only affects pending requests and is idempotent",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("cancel"));
      await createOk(store, input);
      const first = await store.cancel({
        requestTokenHash: input.requestTokenHash,
        updatedAt: iso(1),
      });
      assert(first === true, "cancel must succeed on a pending request");
      const second = await store.cancel({
        requestTokenHash: input.requestTokenHash,
        updatedAt: iso(2),
      });
      assert(second === false, "cancel must be a no-op once cancelled");
      const row = await getRow(store, input);
      assert(row.status === "cancelled", "status must be cancelled");

      const approvedInput = makeInput(nextKey("cancel-approved"));
      await createOk(store, approvedInput);
      await store.approve({
        id: approvedInput.id,
        submittedCodeHash: approvedInput.codeHash,
        now: iso(1),
        approvedByUserId: "user-1",
        approvedAt: iso(1),
      });
      const cancelApproved = await store.cancel({
        requestTokenHash: approvedInput.requestTokenHash,
        updatedAt: iso(2),
      });
      assert(cancelApproved === false, "an approved request must not cancel");
    },
  },
  {
    name: "recordAttempt enforces the cap atomically",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("attempts"));
      await createOk(store, input);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const allowed = await store.recordAttempt({
          id: input.id,
          maxAttempts: 2,
          updatedAt: iso(1),
        });
        assert(allowed === true, `attempt ${attempt + 1} must be allowed`);
      }
      const locked = await store.recordAttempt({
        id: input.id,
        maxAttempts: 2,
        updatedAt: iso(2),
      });
      assert(locked === false, "the attempt cap must lock the request");
      const row = await getRow(store, input);
      assert(row.attempts === 2, `attempts must stop at the cap, got ${row.attempts}`);
    },
  },
  {
    name: "recordAttempt is capped under concurrency",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("attempts-concurrent"));
      await createOk(store, input);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.recordAttempt({
            id: input.id,
            maxAttempts: 2,
            updatedAt: iso(1),
          }),
        ),
      );
      assert(
        results.filter((result) => result === true).length === 2,
        "exactly two concurrent attempts must be allowed",
      );
    },
  },
  {
    name: "markExpired and markFailed transition only active requests",
    async run(store) {
      await reset(store);
      const expiredInput = makeInput(nextKey("mark-expired"));
      await createOk(store, expiredInput);
      const expired = await store.markExpired({
        id: expiredInput.id,
        updatedAt: iso(1),
      });
      assert(expired === true, "markExpired must succeed on a pending request");
      const expiredAgain = await store.markExpired({
        id: expiredInput.id,
        updatedAt: iso(2),
      });
      assert(expiredAgain === false, "markExpired must be a no-op afterwards");
      assert((await getRow(store, expiredInput)).status === "expired", "status must be expired");

      const failedInput = makeInput(nextKey("mark-failed"));
      await createOk(store, failedInput);
      const failed = await store.markFailed({
        id: failedInput.id,
        updatedAt: iso(1),
      });
      assert(failed === true, "markFailed must succeed on a pending request");
      const failedAgain = await store.markFailed({
        id: failedInput.id,
        updatedAt: iso(2),
      });
      assert(failedAgain === false, "markFailed must be a no-op afterwards");
      assert((await getRow(store, failedInput)).status === "failed", "status must be failed");

      const consumedInput = makeInput(nextKey("mark-consumed"));
      await createOk(store, consumedInput);
      await store.approve({
        id: consumedInput.id,
        submittedCodeHash: consumedInput.codeHash,
        now: iso(1),
        approvedByUserId: "user-1",
        approvedAt: iso(1),
      });
      await store.consume({
        requestTokenHash: consumedInput.requestTokenHash,
        consumedAt: iso(2),
        updatedAt: iso(2),
      });
      const failConsumed = await store.markFailed({
        id: consumedInput.id,
        updatedAt: iso(3),
      });
      assert(failConsumed === false, "a consumed request must not fail");
    },
  },
  {
    name: "cleanup removes old rows only and respects the limit",
    async run(store) {
      await reset(store);
      const oldInputs = Array.from({ length: 3 }, () =>
        makeInput(nextKey("cleanup-old"), { createdAt: iso(0) }),
      );
      const newInputs = Array.from({ length: 2 }, () =>
        makeInput(nextKey("cleanup-new"), {
          createdAt: iso(10_000),
        }),
      );
      for (const input of [...oldInputs, ...newInputs]) {
        await createOk(store, input);
      }
      const firstPass = await store.cleanup({ olderThan: iso(5_000), limit: 2 });
      assert(firstPass === 2, `cleanup must respect the limit, got ${firstPass}`);
      const secondPass = await store.cleanup({ olderThan: iso(5_000), limit: 10 });
      assert(secondPass === 1, `cleanup must finish the old rows, got ${secondPass}`);
      for (const input of oldInputs) {
        const row = await store.getByRequestTokenHash(input.requestTokenHash);
        assert(row === null, "old rows must be deleted");
      }
      for (const input of newInputs) {
        const row = await store.getByRequestTokenHash(input.requestTokenHash);
        assert(row !== null, "recent rows must be kept");
      }
    },
  },
  {
    name: "a request row remains readable after its TTL so the route can expire it",
    async run(store) {
      await reset(store);
      const input = makeInput(nextKey("expired-row"), {
        expiresAt: iso(-1_000),
      });
      await createOk(store, input);
      const row = await getRow(store, input);
      assert(row.status === "pending", "the store must not silently expire rows");
    },
  },
];

async function runCheck(
  store: LoginCodesStore,
  check: ConformanceCheck,
): Promise<{ name: string; ok: boolean; error?: string }> {
  try {
    await check.run(store);
    return { name: check.name, ok: true };
  } catch (error) {
    return {
      name: check.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run every invariant against a store and return a pass/fail report. The
 * backing table must be empty (or contain only rows with a `createdAt` older
 * than the suite's fixed clock) when the suite starts.
 */
export async function runLoginCodesStoreConformance(
  options: LoginCodesStoreConformanceOptions,
): Promise<LoginCodesStoreConformanceResult> {
  const store = await options.createStore();
  const results: { name: string; ok: boolean; error?: string }[] = [];
  for (const check of CHECKS) {
    results.push(await runCheck(store, check));
  }
  return { passed: results.every((result) => result.ok), results };
}

/** Run the suite and throw with the first failure's details. */
export async function assertLoginCodesStoreConformance(
  options: LoginCodesStoreConformanceOptions,
): Promise<void> {
  const report = await runLoginCodesStoreConformance(options);
  const failure = report.results.find((result) => !result.ok);
  if (failure) {
    throw new Error(
      `LoginCodesStore conformance failed: ${failure.name}: ${failure.error ?? "unknown error"}`,
    );
  }
}

/**
 * Register the suite with a Jest/Vitest-style API (`{ describe, it }`). Each
 * test builds its own store instance so availability caches stay isolated.
 */
export function registerLoginCodesStoreConformance(
  api: TestApi,
  options: LoginCodesStoreConformanceOptions,
): void {
  api.describe("LoginCodesStore conformance", () => {
    for (const check of CHECKS) {
      api.it(check.name, async () => {
        const store = await options.createStore();
        await check.run(store);
      });
    }
  });
}

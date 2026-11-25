# Login with a code

Opt-in cross-device login standard for `@devopsplaybook.io/common-utils` 2.12.0.
A device that has no usable credentials creates a short-lived request and shows
an 8 character code; a device where the user is already signed in previews the
request and approves it; the first device redeems the approval for a session.

The feature is **disabled by default** and enabled per application with
`LOGIN_CODE_ENABLED=true` (or by registering `LoginCodesRoutes` explicitly).
Enabling it is additive: no existing export, route or table changes.

- Implementation: [`src/users/LoginCodesRoutes.ts`](../src/users/LoginCodesRoutes.ts),
  [`src/users/LoginCodes.ts`](../src/users/LoginCodes.ts),
  [`src/users/LoginCodesStoreCommonUtils.ts`](../src/users/LoginCodesStoreCommonUtils.ts).
- Conformance kit: `@devopsplaybook.io/common-utils/users/login-codes/testing`.
- A companion client/UI standard for `common-web` 0.14.0 is planned as a
  follow-up; this document is the backend contract it will target.

## Protocol

The routes live under a configurable prefix. `UsersRoutes` mounts them at
`/api/users/login-codes`; the collection create endpoint is `POST <prefix>/`
**with the trailing slash**.

| Method | Path | Auth | Success | Main errors |
| --- | --- | --- | --- | --- |
| `GET` | `/capabilities` | none | `200 { enabled, available, codeLength, rotationSeconds, graceSeconds, ttlSeconds, pollIntervalMs, approveRequiresPassword, serverTime }` | never 5xx; probe/key errors answer `available:false` |
| `POST` | `/` | none, per-IP limit | `201 { requestToken, code, codeExpiresAt, expiresAt, serverTime }` | `503 LOGIN_CODE_UNAVAILABLE`, `429 RATE_LIMITED` |
| `POST` | `/poll` | request token in body, per-token limit | pending / approved / expired / cancelled / failed (below) | `400 INVALID_CODE`, `409 ALREADY_USED`, `429`, `503` |
| `POST` | `/preview` | interactive session | `200 { deviceLabel, userAgent, createdAt, expiresAt, userName, serverTime }` | `400 INVALID_CODE`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `429`, `503` |
| `POST` | `/approve` | interactive session | `200 { approved: true, expiresAt, serverTime }` | `400 INVALID_CODE`, `400 PASSWORD_REQUIRED`, `401`, `403`, `429`, `503` |
| `POST` | `/cancel` | request token in body | `200 { status: "cancelled", serverTime }` (idempotent) | `400 INVALID_CODE`, `409 ALREADY_USED`, `429`, `503` |

Every response carries `Cache-Control: no-store`, `Pragma: no-cache`,
`Vary: Authorization` and a `serverTime` ISO timestamp. Error bodies are
`{ error: <message>, code: <stable code>, serverTime }`; rate-limit answers add
`statusCode`, `message` and a `Retry-After` header.

Stable codes: `INVALID_CODE`, `ALREADY_USED`, `RATE_LIMITED`,
`LOGIN_CODE_UNAVAILABLE`, `PASSWORD_REQUIRED`, `UNAUTHENTICATED`, `FORBIDDEN`.

### Lifecycle

```
                 POST /                     POST /approve
   (no request) ───────► pending ──────────────────────► approved
                            │  ▲                           │
             rotation ──────┘  │ (grace window)            │ POST /poll (consume)
                                │                           ▼
                            previous code                 consumed
                            
   terminal states: cancelled (POST /cancel), expired (TTL), failed (attempts/approver gone)
```

`pending → approved → consumed`, plus the terminal `cancelled`, `expired` and
`failed` states. `expired` and `failed` are reachable from `pending` and
`approved`. Transitions are lazy (evaluated on the next request); there is no
scheduler and no in-memory state.

### Create

1. Resolve availability: feature enabled, HMAC key present, table present —
   otherwise `503 LOGIN_CODE_UNAVAILABLE`.
2. Lazy cleanup: delete up to 100 rows created more than 24 h ago.
3. Generate a 256-bit base64url request token (only its SHA-256 is stored), an
   8 character base20 code (`BCDFGHJKLMNPQRSTVWXZ`, ~34.6 bits; only its
   HMAC-SHA256 is stored) and a UUID row id.
4. Insert under a global pending cap (`LOGIN_CODE_MAX_PENDING`, default 100).
   The insert is a single conditional statement serialised with an advisory
   lock on Postgres, so concurrent replicas cannot exceed the cap. Unique
   collisions are retried up to three times.
5. Return the token and the plaintext code **once**. The store never has the
   plaintext code after this response.

### Poll

`POST /poll` with `{ requestToken, refreshCode? }`:

- Unknown token → `400 INVALID_CODE`.
- `consumed` → `409 ALREADY_USED`.
- TTL elapsed (`now >= expiresAt`) → mark `expired`, audit failure, return
  `200 { status: "expired", expiresAt, serverTime }` (even when approved).
- `approved` → re-read the approver live. If the user is gone, mark `failed`
  and audit `approver_missing` (fail closed, no session). Otherwise atomically
  consume (`approved → consumed`); a lost race → `409 ALREADY_USED`. Then issue
  the session and return `200 { status: "approved", token, user, expiresAt, serverTime }`.
- `pending` → rotate lazily:
  - when `now >= codeExpiresAt`, generate a new code and compare-and-set the
    rotation (the old hash moves to `previousCodeHash` with
    `previousCodeExpiresAt = now + grace`);
  - `refreshCode: true` forces the same rotation, but only once at least
    5 seconds of the current window elapsed (to prevent rotation flooding and
    code loss);
  - the response includes the new plaintext `code` **only when this response
    rotated it**; otherwise it returns the current `codeExpiresAt`.
- `cancelled` / `failed` → `200 { status, expiresAt, serverTime }`.

The 5 minute TTL bounds the whole request. Rotation (default 30 s) bounds how
long any displayed code remains current; the grace window (default 60 s) keeps
the previous code valid for an approver who was typing when the client polled.

### Preview and approve

Both require an interactive session. The default hook resolves the live JWT
user and rejects API tokens (`403 FORBIDDEN "Session Token Required"`), because
an automation credential must not silently approve a human login.
`401 UNAUTHENTICATED` means no session.

The submitted code is normalised (uppercase, spaces and hyphens stripped) and
must be exactly 8 characters of the alphabet; anything else is the generic
`400 INVALID_CODE`. The lookup matches the current code or the previous code
while its grace window is open. Then:

1. If `LOGIN_CODE_APPROVE_REQUIRE_PASSWORD=true` and the password is missing →
   `400 PASSWORD_REQUIRED` (**not** counted as an attempt).
2. Atomically increment the attempt counter while below
   `LOGIN_CODE_MAX_ATTEMPTS` (default 5). At the cap the request is marked
   `failed` and audited (`attempts_exceeded`); the answer stays the generic
   `INVALID_CODE`.
3. If a password is required, verify it. A wrong password answers
   `INVALID_CODE`; the attempt was already consumed.
4. Compare-and-set approval (first approval wins). The response is
   `{ approved: true }`; the code is not echoed back.

`/preview` performs the same lookup and attempt accounting but changes no
other state. It returns the parsed device label, the raw user agent (truncated
to 512 characters), the request timestamps and the approving user's name so the
approver can recognise the request.

### Cancel

`POST /cancel` with `{ requestToken }` cancels a pending request. Cancelling an
already cancelled request is idempotent (`200`); an approved or consumed
request answers `409 ALREADY_USED`; an unknown token answers `400 INVALID_CODE`.
Cancellation does not issue any session.

## Configuration

All settings are read through `LoginCodesOptionsFromConfig()`; invalid values
fall back to the default and numeric values are clamped.

| Setting | Environment variable | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | `LOGIN_CODE_ENABLED` | `false` | Opt-in; `false` answers `503` on mutating routes |
| `ttlSeconds` | `LOGIN_CODE_TTL_SECONDS` | `300` | Clamped 30–3600 |
| `rotationSeconds` | `LOGIN_CODE_ROTATION_SECONDS` | `30` | Clamped 5–300 (5 s minimum rotation interval) |
| `graceSeconds` | `LOGIN_CODE_GRACE_SECONDS` | `60` | Clamped 0–600; previous code validity |
| `pollIntervalMs` | `LOGIN_CODE_POLL_INTERVAL_MS` | `2000` | Client hint; clamped 250–60000 |
| `maxAttempts` | `LOGIN_CODE_MAX_ATTEMPTS` | `5` | Per request; clamped 1–100 |
| `maxPending` | `LOGIN_CODE_MAX_PENDING` | `100` | Global pending cap; clamped 1–1000000 |
| `rateLimitCreateMax` | `LOGIN_CODE_RATE_LIMIT_CREATE_MAX` | `10` | Per IP per window; `0` disables |
| `rateLimitPollMax` | `LOGIN_CODE_RATE_LIMIT_POLL_MAX` | `120` | Per request-token hash per window; `0` disables |
| `rateLimitApproveMax` | `LOGIN_CODE_RATE_LIMIT_APPROVE_MAX` | `10` | Per IP per window for preview/approve/cancel; `0` disables |
| `rateLimitWindowSeconds` | `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` | Shared with the auth routes |
| `approveRequiresPassword` | `LOGIN_CODE_APPROVE_REQUIRE_PASSWORD` | `false` | Step-up password on approve |

The HMAC key is the deployment JWT key by default (`AuthGetJwtKey()`). An empty
key makes the feature unavailable (`503`) instead of crashing at boot. Rotating
the key invalidates outstanding codes (their hashes no longer match), which is
an acceptable consequence of a signing-key rotation.

## Database schema

Add this DDL as the next `init-NNNN.sql` migration (identical for SQLite and
Postgres; the `DbUtils` facade converts `?` placeholders). See
[`src/users/LoginCodesStoreCommonUtils.ts`](../src/users/LoginCodesStoreCommonUtils.ts)
for the exported constants used as test fixtures.

```sql
CREATE TABLE IF NOT EXISTS "users_login_codes" (
  "id" TEXT PRIMARY KEY,
  "requestTokenHash" TEXT NOT NULL UNIQUE,
  "codeHash" TEXT NOT NULL,
  "previousCodeHash" TEXT,
  "codeExpiresAt" TEXT NOT NULL,
  "previousCodeExpiresAt" TEXT,
  "status" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "approvedAt" TEXT,
  "approvedByUserId" TEXT,
  "consumedAt" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "requestUserAgent" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_login_codes_code_hash" ON "users_login_codes" ("codeHash");
CREATE INDEX IF NOT EXISTS "users_login_codes_status_expires" ON "users_login_codes" ("status", "expiresAt");
```

All timestamps are ISO-8601 UTC `TEXT`, so lexicographic order is chronological.
There is no foreign key on `approvedByUserId`: deleting a user must neither
cascade nor block, and redemption fails closed when the approver no longer
exists. Rows are removed lazily by the create path (older than 24 h, at most
100 per call); no scheduler is required and a row is never deleted while it
could still be redeemed.

## Mounting

### Shared auth stack (`UsersRoutes`)

```ts
import { UsersRoutes } from "@devopsplaybook.io/common-utils";
import { createLoginCodesStoreCommonUtils } from "@devopsplaybook.io/common-utils/users/login-codes";

await fastify.register(new UsersRoutes().getRoutes, {
  prefix: "/api/users",
  loginCodes: {
    store: createLoginCodesStoreCommonUtils(), // optional; this is the default
    rateLimitStore: sharedStore,               // optional, multi-replica limits
  },
});
```

With `LOGIN_CODE_ENABLED=true` the routes are registered automatically with the
common-utils store. Supplying `loginCodes` registers them even when the env flag
is unset (`enabled` still defaults to `false`, so the routes answer `503` until
it is enabled). When the host application already registered
`@fastify/rate-limit`, do not pass `rateLimitStore` to the login-code plugin
(it throws) — configure the store on the host registration instead.

### Custom auth stack

```ts
import {
  LoginCodesRoutes,
  createLoginCodesStoreCommonUtils,
} from "@devopsplaybook.io/common-utils/users/login-codes";

await fastify.register(LoginCodesRoutes, {
  prefix: "/api/login-codes",
  enabled: true,
  store: createLoginCodesStoreCommonUtils(),
  hashKey: () => mySigningKey,
  getApprovingUser: async (req) => myLiveSessionUser(req),
  getUserById: async (id) => myUserLookup(id),
  issueSession: async (user) => ({ token: myJwt(user), user }),
  verifyPassword: async (user, password) => myCheck(user, password),
  onEvent: (event) => myAudit(event),
});
```

`LoginCodesRoutesOptions` accepts every setting plus these hooks:

| Hook | Default | Purpose |
| --- | --- | --- |
| `store` (required) | — | Atomic storage seam |
| `hashKey` | `AuthGetJwtKey()` | Code HMAC key; `string` or `() => string \| Promise<string>` |
| `getApprovingUser` | live JWT user, API tokens flagged | Resolve the approving session |
| `getUserById` | `UsersDataGet` | Re-read the approver at redemption (fail closed) |
| `issueSession` | `AuthGenerateJWT` with fresh `sessionStartedAt` | Mint the redeemed session |
| `verifyPassword` | `UserPasswordCheckPassword` | Password step-up |
| `onEvent` | `AuthAuditEmit` | Audit sink; never receives secrets |
| `rateLimitStore` | none (local store) | Shared `@fastify/rate-limit` store |
| `now` | `Date.now` | Clock override for tests |

Importing `./users/login-codes` loads no database driver, `ConfigBase` or the
shared users routes, so a custom-auth server can use it without initialising the
common-utils stack.

## Custom `LoginCodesStore` implementations

The store is the only place that must be trusted for atomicity. Implement
`LoginCodesStore` and run the conformance suite in CI:

```ts
import { registerLoginCodesStoreConformance } from "@devopsplaybook.io/common-utils/users/login-codes/testing";

registerLoginCodesStoreConformance(
  { describe, it },
  { createStore: () => myLoginCodesStore },
);
```

The suite covers availability, round-trips, duplicate token/code conflicts, the
pending cap (sequential and concurrent), current/previous code lookup, rotation
compare-and-set, first-approval-wins (sequential and concurrent), grace expiry,
single-use redemption (sequential and concurrent), cancel, attempt caps
(sequential and concurrent), `markExpired`/`markFailed`, bounded cleanup and the
"do not silently expire" rule. It resets rows through `cleanup()` with a fixed
clock, so the table must contain no application rows when the suite starts. The
same runner is available programmatically as `runLoginCodesStoreConformance()`
and `assertLoginCodesStoreConformance()`.

Implementation requirements:

- every mutation is a single SQL statement (conditional update/insert) or an
  equivalent atomic operation — no read-modify-write in application code;
- `create` enforces the global pending cap atomically (the reference store
  wraps the conditional insert in an advisory lock on Postgres) and reports
  `pending_cap` or `conflict`;
- `approve` is a compare-and-set that accepts the current hash or the previous
  hash while `previousCodeExpiresAt > now` and wins only once;
- `consume` transitions `approved → consumed` and returns the row (or `null`);
- `recordAttempt` increments only while `attempts < maxAttempts`;
- `cleanup` deletes at most `limit` rows older than `olderThan`;
- `available()` is a cheap probe that caches only a definitive missing-table
  result;
- timestamps follow the existing row format (ISO-8601 UTC).

## Client guidance

- `POST /capabilities` first; render the UI only when `available` is true.
- Create once, display the returned `code`, and poll every `pollIntervalMs`.
  Keep the code in memory; it is never returned again unless a rotation
  produces a new one.
- Treat `codeExpiresAt`/`expiresAt` countdowns against `serverTime`
  (compute the offset between the server clock and the local clock), not the
  local clock alone.
- When a pending poll returns a `code`, replace the displayed code: this
  response performed the rotation.
- If the code is lost, poll with `refreshCode: true` (honoured after 5 s) to
  receive a new one.
- On `approved`, store the session as any other login. `409 ALREADY_USED`
  means the request was redeemed already (or raced); start over.
- On `expired`, `cancelled` or `failed`, stop polling and offer a fresh
  request.
- The approving client should show the device label/user agent and creation
  time before approving, and should confirm the code out-of-band when the
  product supports it.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Code brute force | 8 characters over a 20 symbol alphabet (~34.6 bits), 5 attempts per request by default, per-IP approve/preview limit, 30 s rotation and 5 min TTL |
| Request-token theft/replay | 256-bit random token, only its SHA-256 is stored, single-use redemption (`approved → consumed`), `409 ALREADY_USED` |
| Code replay after rotation | Only the current and previous hashes are stored; the previous hash expires with the grace window |
| Consent/remote phishing (RFC 10027) | The approver sees the requesting device and time before consenting, API tokens cannot approve, optional password step-up, short TTL; the device label is a heuristic (a user agent can be spoofed) and must never be treated as proof of identity |
| Flooding / DoS | Per-IP create limit, global pending cap, per-token poll limit, bounded lazy cleanup, no expensive cryptography on the hot path (HMAC/SHA-256 only; bcrypt is used just for the optional password step-up) |
| Database enumeration | Every invalid, expired or non-pending code answers the same `INVALID_CODE`; codes are looked up by hash, never by prefix |
| Secret leakage | Codes, request tokens and hashes are never logged or audited; the audit event carries only the request id, actor, device label and reason |
| Transport / key compromise | Run behind TLS; the HMAC key is the deployment signing key, so a key rotation invalidates outstanding codes and existing sessions |

Wider consequences: a redeemed login issues a normal session (JWT) with a
fresh `sessionStartedAt`, so it is bounded by the application's absolute session
lifetime. The feature grants exactly the session a password login would grant;
it does not bypass password policy, role, scope or revocation checks.

## Multi-replica notes

- Every state transition is a database compare-and-set (and the pending-cap
  insert an advisory-locked conditional insert), so correctness does not depend
  on replicas sharing memory.
- Rate limits are **per process** by default. Inject a shared
  `@fastify/rate-limit` store so N replicas do not grant N times the limit.
  The pending cap, attempt cap, rotation and redemption remain strict because
  they are enforced in SQL.
- Lazy cleanup runs on create in every replica with a bounded delete; two
  replicas may run it concurrently, which is safe.
- Codes created on one replica are redeemable on any replica: there is no
  sticky session requirement.

## Audit events

The four added `AuthAuditAction` values are emitted through `AuthAuditEmit` (or
the `onEvent` hook): `login_code_approved`, `login_code_consumed`,
`login_code_failed` and `login_code_cancelled`. The event contains the request
id, the acting user id/name when known, the parsed device label, the request IP
and a machine-readable reason (`expired`, `approver_missing`,
`attempts_exceeded`). Request creation and polling are intentionally not
audited (too noisy). No code, request token or hash ever appears in an event.

## Rollback

Set `LOGIN_CODE_ENABLED=false` (or stop registering the route): mutating routes
answer `503 LOGIN_CODE_UNAVAILABLE` and `GET /capabilities` reports
`enabled:false`. The table can stay in place; nothing else reads it. Removing
the routes entirely is safe once no client is mid-flow (pending rows simply
expire).

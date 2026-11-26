# Changelog

All notable changes to `@devopsplaybook.io/common-utils` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.13.0] - 2026-11-26

### Added

- **Docker registry layer cache** in the shared PR build workflows. The
  multi-platform image build in `reusable-pr-verify.yml` now exports and
  imports a shared buildx registry cache at
  `<dockerhub-user>/<image>:buildcache` (`type=registry`, `mode=max`,
  `image-manifest=false`, `ignore-error=true`), so distro packages,
  compiled dependencies and `npm ci` layers are reused across pull requests
  and branches instead of being rebuilt under QEMU on every run. The rare
  merge fallback build in `reusable-merge-build.yml` imports the same ref
  read-only. The registry backend is used instead of the branch-scoped GitHub
  Actions cache because `main` never builds under the immutable-promotion
  design.

### Documentation

- Documented the cache in `AGENTS.md` (ref name, `mode=max`, registry-vs-gha
  rationale, per-platform fallback, purge, size monitoring) and in the
  README (`Docker Layer Cache` section). No library code, export or runtime
  behaviour changed.

## [2.12.0] - 2026-11-25

### Added

- **Login with code** (opt-in, disabled by default): a reusable, security-reviewed
  cross-device login standard at `@devopsplaybook.io/common-utils/users/login-codes`.
  - `LoginCodesRoutes` Fastify plugin with six protocol routes:
    `GET /capabilities`, `POST /`, `POST /poll`, `POST /preview`,
    `POST /approve` and `POST /cancel` (prefix configurable, default
    `/api/users/login-codes` when mounted by `UsersRoutes`).
  - `LoginCodesStore` storage seam with atomic conditional writes
    (pending cap, rotation and approval compare-and-set, single-use
    redemption, attempt cap, bounded cleanup) and
    `createLoginCodesStoreCommonUtils()`, a reference implementation over the
    `DbUtils` facade for SQLite and PostgreSQL, plus exported DDL constants.
  - `LoginCodesStore` conformance suite published at
    `@devopsplaybook.io/common-utils/users/login-codes/testing`, so custom
    implementations can prove the security invariants in their own CI.
  - Dependency-free core (`LoginCodes.ts`): RFC 8628 base20 code generation,
    HMAC-SHA256 code hashing, SHA-256 request-token hashing, user-agent device
    labels, time helpers and configuration accessors.
  - Lazy rotation with a grace window, 5 minute request TTL, atomic single-use
    redemption, live approver re-read (fail closed), API-token rejection,
    per-IP/per-token rate limiting and `Cache-Control: no-store` on every
    response.
- `AuthGetJwtKey()` and `AuthGetConfig()` accessors.
- Audit actions `login_code_approved`, `login_code_consumed`,
  `login_code_failed` and `login_code_cancelled`, with optional `requestId` and
  `deviceLabel` fields on `AuthAuditEvent`. Codes, request tokens and hashes are
  never emitted.
- `UsersRoutesOptions.loginCodes` passthrough: `UsersRoutes` auto-registers the
  login-code plugin when `LOGIN_CODE_ENABLED=true` or when a `loginCodes`
  option is supplied.

### Configuration

- New `ConfigBase` fields with safe defaults: `LOGIN_CODE_ENABLED` (`false`),
  `LOGIN_CODE_TTL_SECONDS` (`300`), `LOGIN_CODE_ROTATION_SECONDS` (`30`,
  minimum 5), `LOGIN_CODE_GRACE_SECONDS` (`60`), `LOGIN_CODE_POLL_INTERVAL_MS`
  (`2000`), `LOGIN_CODE_MAX_ATTEMPTS` (`5`), `LOGIN_CODE_MAX_PENDING` (`100`),
  `LOGIN_CODE_RATE_LIMIT_CREATE_MAX` (`10`),
  `LOGIN_CODE_RATE_LIMIT_POLL_MAX` (`120`),
  `LOGIN_CODE_RATE_LIMIT_APPROVE_MAX` (`10`) and
  `LOGIN_CODE_APPROVE_REQUIRE_PASSWORD` (`false`). The rate-limit window reuses
  `AUTH_RATE_LIMIT_WINDOW_SECONDS`.
- New `users_login_codes` table (DDL in the README and
  [`docs/login-with-code.md`](./docs/login-with-code.md)); no data migration
  and no change to existing tables.

### Documentation

- New [`docs/login-with-code.md`](./docs/login-with-code.md): protocol,
  lifecycle, configuration, DDL, client guidance, threat model, multi-replica
  notes and a custom-auth integration guide.
- README: login-code module section, configuration table, subpath exports,
  migration snippet and `users_login_codes` schema row.
- AGENTS.md: module list and lean-import/DDL conventions.

### Tests

- Unit tests for the core helpers and configuration, orchestration tests with a
  fake store, Fastify `inject` route tests against SQLite, a dedicated
  low-limit rate-limit suite, the conformance suite against the SQLite store
  and the PostgreSQL store (Docker-gated), and an import-graph test proving
  `./users/login-codes` does not load `better-sqlite3` or `pg`.

### Notes

- **No breaking changes**: all additions are additive and the feature is off by
  default. Existing exports, routes and behaviour are unchanged.
- Multi-replica deployments should inject a shared `@fastify/rate-limit` store
  and rely on the database-level compare-and-set statements for correctness.

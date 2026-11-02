# AGENTS.md

This file provides context for AI coding agents working on this repository.

## Repository Overview

`@devopsplaybook.io/common-utils` is a shared npm library that centralizes utility modules used across devopsplaybook.io server projects. It serves two purposes:

1. **Node.js library** (`src/`): Database access (SQLite via `better-sqlite3`, PostgreSQL via `pg.Pool`), configuration loading, OpenTelemetry context management, and small helpers.
2. **Reusable GitHub Actions workflows** (`.github/workflows/reusable-*.yml`): Standardized CI/CD pipelines adopted by all projects in the organization.

## Architecture

```
index.ts                    # Barrel re-exports for all modules
src/
  OTelContext.ts            # createOTelContext() factory (tracer/meter/logger singletons)
  ConfigBase.ts             # Abstract base class for 3-layer config (env > config.json > defaults)
  SqlDbUtils.ts             # SQLite operations (better-sqlite3, synchronous)
  PostgresDbUtils.ts        # PostgreSQL operations (pg.Pool, async/Promise)
  DbUtils.ts                # Unified facade dispatching to Sql or Postgres
  DbUtilsNoTelemetry.ts     # Same DB ops without OTel span overhead
  users/                    # Auth & user management module set
    User.ts                 # User model, roles and application-defined scopes
    UserSession.ts          # Decoded JWT session
    UserApiToken.ts         # User API token model (SHA-256 hash only)
    Auth.ts                 # JWT auth (key init, guards, session decode) + API token resolution
    UserPassword.ts         # bcrypt password hashing/verification
    UsersData.ts            # Users table CRUD (SQLite/Postgres)
    UsersApiTokensData.ts   # users_api_tokens table CRUD (SQLite/Postgres)
    UsersRoutes.ts          # Standard fastify user management routes (incl. self-service API tokens)
  FastifyErrorHandler.ts    # Safe Fastify error handler (5xx hide internal code/message)
  SystemCommand.ts          # Promise wrapper around child_process.exec
  Timeout.ts                # Promise wrapper around setTimeout
  LLM.ts                    # OpenAI-compatible chat completions client (LLMClient)
  *.spec.ts                 # Co-located test files
.github/workflows/
  main-build.yml            # Caller: push to main -> reusable-npm-merge
  pr-check.yml              # Caller: PR to main -> actionlint workflow-lint job + reusable-npm-pr
  reusable-npm-merge.yml    # Lint + test + build + publish release to npm
  reusable-npm-pr.yml       # Lint + test + build + publish beta tag + comment PR
  reusable-npm-upgrade.yml  # npm-check-updates + auto PR (manual, workflow_call); skips only for an open dependency-update PR, bumps each changed package
  reusable-pr-verify.yml    # Matrix Node.js + multi-platform Docker build -> beta-pr-<PR> and beta, labelled with the PR head commit (+ optional dependency audit)
  reusable-merge-build.yml  # Promotes the PR image to the version tags on merge (no build/lint/test; optional dependency audit)
  reusable-npm-audit.yml    # Dependency audit gate: fails on unallowlisted high/critical production advisories, reports dev advisories
```

## Dependency Audit

`reusable-npm-audit.yml` is called by `reusable-pr-verify.yml` and `reusable-merge-build.yml` when the caller sets `audit_enabled: true` (default `false`, so existing consumers with pre-existing advisories keep working). It runs `npm audit --omit=dev` per app directory: unallowlisted `high`/`critical` advisories on production dependencies fail the job, while the full audit (dev/build-only findings included) is reported in the job summary. Accepted exceptions live in the consuming repository's `.github/audit-allowlist.json` (`id`, `package`, `scope` `runtime|dev`, `reason`, `owner`, `expires` `YYYY-MM-DD`); only unexpired `runtime` entries suppress the blocking gate. Never silence an advisory by weakening a check: allowlist entries are time-boxed and owned. Optional npm caches are not used in this job because it only reads the lockfile.

`reusable-npm-pr.yml` and `reusable-npm-merge.yml` follow the same policy for this package: they block on `npm audit --omit=dev --audit-level=high` and report the full tree with a non-blocking `npm audit` (dev-only advisories never block a release).

`reusable-npm-merge.yml` publishes with `--provenance` when the caller passes `publish_provenance: true` and grants `id-token: write`. The permission is not declared inside the shared workflow: a called workflow cannot elevate its caller's token, so adding it there would break existing consumers (`otel-utils`, `otel-utils-fastify`) whose callers do not grant it.

## Weekly Dependency Updates

The scheduled `npm-upgrade.yml` caller was retired: it created dependency upgrade pull requests every week that no one merged. `reusable-npm-upgrade.yml` is kept for manual, on-demand upgrades (`workflow_call`; adopting repositories can trigger it through their own `workflow_dispatch` caller).

The weekly update of the shared npm libraries is agent-driven instead: a Kubernetes CronJob (`planner-shared-libraries-update` in the `DidierHoarau/didier-home` GitOps repository) creates a Planner task in the `Projects/xMaintenance` project every Friday, and the planner-llm-agent executes the `update-shared-libraries` skill from `DidierHoarau/planner-llm-agent-config`. The skill updates `otel-utils` first, then `otel-utils-fastify` and `common-utils` once the freshly published `otel-utils` version is visible on npm, then the consumer repositories discovered with GitHub code search. It applies minor/patch updates only (majors are reported, never applied), skips repositories already current against the npm registry, and delivers one squash-merged pull request per repository after green checks. Do not reintroduce a scheduled upgrade workflow in this repository: it would compete with the agent-driven update.

## Key Conventions

- **TypeScript**: Target ES2019, CommonJS output, strict mode enabled, declarations generated.
- **Linting**: Uses `oxlint` with its default **recommended** preset. Minimize disable comments (`eslint-disable`-style comments are honored by oxlint); use them only when the rule cannot be satisfied (e.g. `no-explicit-any` is not enabled by the recommended preset, so `any` needs no directive).
- **Tests**: Jest with `@swc/jest` transform (`jsc.target` matches tsconfig ES2019) and `v8` coverage provider. Spec files live next to source (`*.spec.ts`). Run with `npm run test`. The `tsconfig.spec.json` includes jest types; `npm run build` also type-checks specs (`tsc -p tsconfig.spec.json --noEmit`).
- **No default exports**: All modules use named exports only.
- **OTel dependency injection**: Every DB module exposes a `*SetOTel(tracer, logger)` function that must be called before `*Init()`. OTel instances are stored as module-level singletons.
- **Auth modules**: `AuthSetOTel(tracer)` and `UsersDataSetOTel(tracer)` must be called before `AuthInit`. Application scopes are registered through `AuthInit(context, config, allScopes)`; `UsersRoutes` retrieves the request span via `OTelRequestSpan(req)` from `@devopsplaybook.io/otel-utils-fastify` (populated by its Fastify hooks).
- **Auth request resolution**: `jwtDecodeCached` resolves the credential once per request and caches rejections too (`_jwtResolved` + `_jwtPayload = null`), so a revoked token rejected by one helper cannot authorize a later guard or route handler. `tokenVersion` is compared only when `JWT_REVOCATION_ENABLED` is on; the live user read is shared by all helpers. Access tokens default to 1 h (`JWT_VALIDITY_DURATION`), renewal is bounded by the absolute 30-day `JWT_SESSION_MAX_DURATION` carried in the `sessionStartedAt` claim, and tokens carry `iss`/`aud` (`JWT_ISSUER`/`JWT_AUDIENCE`) plus a random `jti`. API tokens cannot be exchanged for a JWT (`POST /session` / `/session/refresh` answer 403) because they are re-validated per request. Security-sensitive auth changes must cover repeated helper calls and session-then-guard sequences in tests.
- **User boundary and bcrypt cost**: `UsersRoutes` trims user names at the request boundary and enforces 1-64 characters of `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$` (`Missing: Name` / `Name Too Long` / `Invalid: Name`); the trimmed value is used for lookup, uniqueness, audit and rate-limit keys. New password hashes use `BCRYPT_ROUNDS` (default 10, clamped 10-15); stored hashes keep their embedded cost and the unknown-user dummy runs at the configured cost.
- **ModuleLogger pattern**: `StandardLogger` only exposes `createModuleLogger(name)`. DB modules call `logger.createModuleLogger("ModuleName")` internally. Never call `.info()` or `.error()` directly on a `StandardLogger`.
- **Error responses**: Fastify services call `FastifyErrorHandlerRegister(fastify)` right after creating the instance (before routes/plugins) so unexpected failures never send driver codes or internal messages to clients. 5xx responses are reduced to the status label and the original error is logged at error level; 4xx responses keep their message and code. Add tests through `fastify.inject` rather than calling the handler directly.
- **SQLite-first SQL**: Write SQL with `?` placeholders. The `DbUtils` facade and `DbUtilsNoTelemetry` module auto-convert to `$1, $2, ...` for Postgres via `convertToPostgresPlaceholders()`.
- **Ids**: Use `crypto.randomUUID()` (UUID v4) — there is no `uuid` dependency. Tests that need deterministic ids replace it with a partial `jest.mock("crypto", () => ({ ...jest.requireActual("crypto"), randomUUID: () => "..." }))`.
- **Migration convention**: SQL files named `init-NNNN.sql`. `init-0000.sql` must create the `metadata` table. Subsequent files are applied in lexicographic order; applied versions are tracked in `metadata` for idempotency.
- **Immutable Docker builds**: images are built once on the pull request (`reusable-pr-verify.yml` pushes `beta-pr-<PR number>` and `beta`, labelled `org.opencontainers.image.revision=<PR head commit>`) and promoted unchanged on merge (`reusable-merge-build.yml` writes `<version>`, `<major>`, `<minor>`, `beta` and `latest`). The merge workflow runs no build, lint or test: it resolves the merged PR, fetches `refs/pull/<N>/head`, and promotes the `beta-pr-<N>` image only when its revision label equals that head commit and the head's tree equals `GITHUB_SHA` (`git diff --quiet`). A missing label, moved head, outdated branch or unresolvable PR falls back to a full build from `GITHUB_SHA` (also revision-labelled); an unverified image is never promoted. It then carbon-copies the manifest with `docker buildx imagetools create --prefer-index=false`, reads back each published digest and fails on a mismatch. Image name and version come from the root `package.json`, and PR branches must be up to date with the default branch before merging.
- **Workflow self-validation**: `pr-check.yml` runs an `actionlint` v1.7.7 `workflow-lint` job on every PR; locally use `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`. Reusable calls remain pinned at `@main` on purpose: local `./.github/workflows/...` refs would let a PR execute a modified copy of the workflow that gates it.
- **Reusable workflow permissions ceiling**: `reusable-merge-build.yml` may request only `contents: read`. A called workflow cannot exceed its caller's permissions, and callers use the default read-only token whose ceiling is `contents: read, pull-requests: none`. Adding `pull-requests: read` does not fail here — it fails in every consuming repo at startup with `Invalid workflow file ... requesting 'pull-requests: read', but is only allowed 'pull-requests: none'`. `GET /repos/{owner}/{repo}/commits/{sha}/pulls` works with `contents: read`, so no extra scope is needed.

## Build and Verification

```bash
npm install
npm run build    # tsc -> dist/
npm run lint     # oxlint src (must pass with 0 errors)
npm run test     # jest --coverage (all tests must pass)
```

All three commands must pass before committing. The CI pipeline (`reusable-npm-merge.yml`) runs the same checks.

## Dependencies

| Package                                 | Role                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@devopsplaybook.io/otel-utils`         | `StandardTracer`, `StandardLogger`, `StandardMeter`, `ModuleLogger`, `ConfigOTelInterface` |
| `@devopsplaybook.io/otel-utils-fastify` | `OTelRequestSpan` request-span lookup used by `UsersRoutes`                                |
| `better-sqlite3`                        | Synchronous SQLite driver (NOT the callback-based `sqlite3`)                               |
| `pg`                                    | PostgreSQL client with connection pooling                                                  |
| `fs-extra`                              | Async/sync file operations, `readJson`/`ensureDir`                                         |
| `bcrypt`                                | Password hashing (users module)                                                            |
| `jsonwebtoken`                          | JWT signing/verification (auth module)                                                     |
| `@fastify/rate-limit`                   | Per-route login/refresh/status throttling registered by `UsersRoutes` (in-memory store by default; an optional shared store can be injected through `UsersRoutesOptions.rateLimitStore`) |
| `fastify`                               | HTTP framework types used by `UsersRoutes`                                                 |

## Known Gotchas

- **better-sqlite3 is synchronous**: `SqlDbUtils` functions return values directly (not Promises). `PostgresDbUtils` functions return Promises. The `DbUtils` facade returns `number | Promise<number>` depending on the active backend.
- **Disable-comment placement**: `eslint-disable-next-line` applies to the **immediately following line only** (oxlint honors these comments too). When disabling a rule inside a function call argument, place the comment directly before the offending expression, not before the function call.
- **pg callback typing**: Always explicitly type pg callback parameters: `(error: Error | null, result: { rowCount: number | null })`. TypeScript cannot infer these from the overloaded `pool.query` signature.

## Adopting in Other Projects

See the [README](./README.md) for full adoption instructions. The typical pattern:

1. Add `@devopsplaybook.io/common-utils` as a dependency.
2. Replace the project's `OTelContext.ts` with `createOTelContext()`.
3. Replace the project's `Config` class to `extend ConfigBase`.
4. Replace DB utility files with re-exports from `common-utils`.
5. Update `App.ts` to call `*SetOTel()` and `*Init()` from `common-utils`.

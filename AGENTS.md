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
    Auth.ts                 # JWT auth (key init, guards, session decode)
    UserPassword.ts         # bcrypt password hashing/verification
    UsersData.ts            # Users table CRUD (SQLite/Postgres)
    UsersRoutes.ts          # Standard fastify user management routes
  SystemCommand.ts          # Promise wrapper around child_process.exec
  Timeout.ts                # Promise wrapper around setTimeout
  *.spec.ts                 # Co-located test files
.github/workflows/
  main-build.yml            # Caller: push to main -> reusable-npm-merge
  pr-check.yml              # Caller: PR to main -> reusable-npm-pr
  npm-upgrade.yml           # Caller: weekly schedule -> reusable-npm-upgrade
  reusable-npm-merge.yml    # Lint + test + build + publish release to npm
  reusable-npm-pr.yml       # Lint + test + build + publish beta tag + comment PR
  reusable-npm-upgrade.yml  # npm-check-updates + auto PR
  reusable-pr-verify.yml    # Matrix Node.js + multi-platform Docker build for PRs
  reusable-merge-build.yml  # Matrix Node.js + Docker build with version tags on merge
```

## Key Conventions

- **TypeScript**: Target ES2019, CommonJS output, strict mode enabled, declarations generated.
- **ESLint**: Uses `typescript-eslint` with `strict` and `stylistic` rule sets. Minimize `eslint-disable` comments; use them only when the type system cannot express the constraint (e.g., `@typescript-eslint/no-explicit-any` for `this as any` dynamic field access in `ConfigBase`).
- **Tests**: Jest with `ts-jest`. Spec files live next to source (`*.spec.ts`). Run with `npm run test`. The `tsconfig.spec.json` includes jest types.
- **No default exports**: All modules use named exports only.
- **OTel dependency injection**: Every DB module exposes a `*SetOTel(tracer, logger)` function that must be called before `*Init()`. OTel instances are stored as module-level singletons.
- **Auth modules**: `AuthSetOTel(tracer)` and `UsersDataSetOTel(tracer)` must be called before `AuthInit`. Application scopes are registered through `AuthInit(context, config, allScopes)`; `UsersRoutes` relies on `req.tracerSpanApi` set by the `otel-utils-fastify` hooks.
- **ModuleLogger pattern**: `StandardLogger` only exposes `createModuleLogger(name)`. DB modules call `logger.createModuleLogger("ModuleName")` internally. Never call `.info()` or `.error()` directly on a `StandardLogger`.
- **SQLite-first SQL**: Write SQL with `?` placeholders. The `DbUtils` facade and `DbUtilsNoTelemetry` module auto-convert to `$1, $2, ...` for Postgres via `convertToPostgresPlaceholders()`.
- **Migration convention**: SQL files named `init-NNNN.sql`. `init-0000.sql` must create the `metadata` table. Subsequent files are applied in lexicographic order; applied versions are tracked in `metadata` for idempotency.

## Build and Verification

```bash
npm install
npm run build    # tsc -> dist/
npm run lint     # eslint src (must pass with 0 errors)
npm run test     # jest --coverage (all tests must pass)
```

All three commands must pass before committing. The CI pipeline (`reusable-npm-merge.yml`) runs the same checks.

## Dependencies

| Package                         | Role                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `@devopsplaybook.io/otel-utils` | `StandardTracer`, `StandardLogger`, `StandardMeter`, `ModuleLogger`, `ConfigOTelInterface` |
| `better-sqlite3`                | Synchronous SQLite driver (NOT the callback-based `sqlite3`)                               |
| `pg`                            | PostgreSQL client with connection pooling                                                  |
| `uuid`                          | v14+ (ESM -- requires `jest.mock("uuid")` in tests)                                        |
| `fs-extra`                      | Async/sync file operations, `readJson`/`ensureDir`                                         |
| `bcrypt`                        | Password hashing (users module)                                                            |
| `jsonwebtoken`                  | JWT signing/verification (auth module)                                                     |
| `fastify`                       | HTTP framework types used by `UsersRoutes`                                                 |

## Known Gotchas

- **uuid ESM**: `uuid` v14+ ships ESM. In any test that transitively imports `uuid`, add `jest.mock("uuid", () => ({ v4: () => "mock-uuid-1234" }))` to avoid `SyntaxError: Unexpected token 'export'`.
- **better-sqlite3 is synchronous**: `SqlDbUtils` functions return values directly (not Promises). `PostgresDbUtils` functions return Promises. The `DbUtils` facade returns `number | Promise<number>` depending on the active backend.
- **eslint-disable placement**: `eslint-disable-next-line` applies to the **immediately following line only**. When disabling a rule inside a function call argument, place the comment directly before the offending expression, not before the function call.
- **pg callback typing**: Always explicitly type pg callback parameters: `(error: Error | null, result: { rowCount: number | null })`. TypeScript cannot infer these from the overloaded `pool.query` signature.

## Adopting in Other Projects

See the [README](./README.md) for full adoption instructions. The typical pattern:

1. Add `@devopsplaybook.io/common-utils` as a dependency.
2. Replace the project's `OTelContext.ts` with `createOTelContext()`.
3. Replace the project's `Config` class to `extend ConfigBase`.
4. Replace DB utility files with re-exports from `common-utils`.
5. Update `App.ts` to call `*SetOTel()` and `*Init()` from `common-utils`.

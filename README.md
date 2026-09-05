# @devopsplaybook.io/common-utils

Shared utility modules for [devopsplaybook.io](https://github.com/devopsplaybook-io) projects. Provides OpenTelemetry-aware database access (SQLite and PostgreSQL), configuration loading, telemetry context management, and reusable GitHub Actions CI/CD workflows.

## Contents

- [Node.js Library](#nodejs-library)
  - [Installation](#installation)
  - [Modules](#modules)
  - [Quick Start](#quick-start)
- [Shared GitHub Actions Workflows](#shared-github-actions-workflows)
  - [Reusable Workflows](#reusable-workflows)
  - [Adopting in Your Project](#adopting-in-your-project)

---

## Node.js Library

### Installation

```bash
npm install @devopsplaybook.io/common-utils
```

**Peer dependencies** (installed automatically):

| Package                         | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `@devopsplaybook.io/otel-utils` | `StandardTracer`, `StandardLogger`, `StandardMeter` |
| `@opentelemetry/api`            | OTel API (`SpanStatusCode`)                         |
| `@opentelemetry/sdk-trace-base` | `Span` type                                         |
| `better-sqlite3`                | Synchronous SQLite driver                           |
| `pg`                            | PostgreSQL client (`Pool`)                          |
| `fs-extra`                      | File system helpers                                 |
| `uuid`                          | UUID generation for JWT keys                        |
| `axios`                         | HTTP client for the notifications and LLM integrations |
| `bcrypt`                        | Password hashing for the users module               |
| `jsonwebtoken`                  | JWT signing/verification for the auth module        |
| `fastify`                       | HTTP framework types for the users routes           |

### Modules

#### `OTelContext` -- Telemetry Singleton Factory

Creates an isolated set of OTel singletons (tracer, meter, logger) for a server process.

```ts
import { createOTelContext } from "@devopsplaybook.io/common-utils";
import { StandardTracer, StandardMeter } from "@devopsplaybook.io/otel-utils";

const otel = createOTelContext();
otel.OTelSetTracer(new StandardTracer(config));
otel.OTelSetMeter(new StandardMeter(config));
otel.OTelLogger().initOTel(config);

// Later:
const tracer = otel.OTelTracer();
const span = tracer.startSpan("my-operation");
```

| Export                | Description                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `createOTelContext()` | Returns `{ OTelTracer, OTelSetTracer, OTelMeter, OTelSetMeter, OTelLogger, OTelRequestSpan }` |

---

#### `ConfigBase` -- Configuration Base Class

Abstract class implementing the three-layer override strategy:

1. **Environment variable** (highest priority)
2. **config.json** file value
3. **Default** declared on the class property

```ts
import { ConfigBase } from "@devopsplaybook.io/common-utils";

class MyConfig extends ConfigBase {
  public MY_SETTING = "default";

  constructor() {
    super("my-service");
    this.addConfigField({ field: "MY_SETTING" });
  }

  async reload(): Promise<void> {
    await super.reload((msg) => console.log(msg));
  }
}

const config = new MyConfig();
await config.reload();
```

**Built-in fields** (pre-registered, no `addConfigField` needed):

| Field                                  | Default              | Sensitive                           |
| -------------------------------------- | -------------------- | ----------------------------------- |
| `API_PORT`                             | `8080`               | No                                  |
| `JWT_VALIDITY_DURATION`                | `8035200` (3 months) | No                                  |
| `CORS_POLICY_ORIGIN`                   | `""`                 | No                                  |
| `DATA_DIR`                             | `/data`              | No                                  |
| `JWT_KEY`                              | `uuidv4()`           | Yes                                 |
| `LOG_LEVEL`                            | `"info"`             | No                                  |
| `DATABASE_TYPE`                        | `"sqlite"`           | No                                  |
| `DATABASE_POSTGRES_HOST`               | `""`                 | No                                  |
| `DATABASE_POSTGRES_PORT`               | `5432`               | No                                  |
| `DATABASE_POSTGRES_USER`               | `""`                 | No                                  |
| `DATABASE_POSTGRES_PASSWORD`           | `""`                 | Yes                                 |
| `DATABASE_POSTGRES_DATABASE`           | `""`                 | No                                  |
| All `OPENTELEMETRY_COLLECTOR_*` fields | Various              | No (except `_AUTHORIZATION_HEADER`) |

---

#### `SqlDbUtils` -- SQLite Database Access

Synchronous database operations using `better-sqlite3`, with OTel tracing on every call.

```ts
import {
  SqlDbUtilsSetOTel,
  SqlDbUtilsInit,
  SqlDbUtilsExecSQL,
  SqlDbUtilsQuerySQL,
} from "@devopsplaybook.io/common-utils";

// At startup
SqlDbUtilsSetOTel(tracer, logger);
await SqlDbUtilsInit(span, config, path.resolve(__dirname, "../sql"));

// Read
const rows = SqlDbUtilsQuerySQL(span, "SELECT * FROM users WHERE id = ?", [
  userId,
]);

// Write
const changes = SqlDbUtilsExecSQL(
  span,
  "UPDATE users SET name = ? WHERE id = ?",
  [name, userId],
);
```

| Export                  | Signature                      | Description                                      |
| ----------------------- | ------------------------------ | ------------------------------------------------ |
| `SqlDbUtilsSetOTel`     | `(tracer, logger)`             | Inject OTel instances                            |
| `SqlDbUtilsInit`        | `(span, config, sqlDir)`       | Open DB and run migrations                       |
| `SqlDbUtilsExecSQL`     | `(span, sql, params?)`         | Execute write, returns `number` (changes)        |
| `SqlDbUtilsQuerySQL`    | `(span, sql, params?, debug?)` | Execute read, returns `any[]`                    |
| `SqlDbUtilsExecSQLFile` | `(span, filename)`             | Execute an entire SQL file                       |
| `SqlDbUtilsGetDatabase` | `()`                           | Returns the `better-sqlite3` `Database` instance |

**Migration convention**: Files named `init-NNNN.sql` in `sqlDir`, applied in order. A `metadata` table tracks applied versions for idempotent re-runs. `init-0000.sql` must exist (creates the `metadata` table).

---

#### `PostgresDbUtils` -- PostgreSQL Database Access

Async (Promise-based) database operations using `pg.Pool`, with OTel tracing.

| Export                             | Signature                      | Description                              |
| ---------------------------------- | ------------------------------ | ---------------------------------------- |
| `PostgresDbUtilsSetOTel`           | `(tracer, logger)`             | Inject OTel instances                    |
| `PostgresDbUtilsInit`              | `(span, config, sqlDir)`       | Create pool and run migrations           |
| `PostgresDbUtilsExecSQL`           | `(span, sql, params?)`         | Execute write, returns `Promise<number>` |
| `PostgresDbUtilsQuerySQL`          | `(span, sql, params?, debug?)` | Execute read, returns `Promise<any[]>`   |
| `PostgresDbUtilsExecSQLFile`       | `(span, filename)`             | Execute an entire SQL file               |
| `PostgresDbUtilsGetPool`           | `()`                           | Returns the `pg.Pool` instance           |
| `PostgresDbUtilsTransactionStart`  | `(span)`                       | Begin a transaction (`BEGIN`)            |
| `PostgresDbUtilsTransactionCommit` | `(span)`                       | Commit a transaction (`COMMIT`)          |

Pool defaults: `max: 20`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 10000`.

---

#### `PostgresSchemaDbUtils` -- Multi-Schema PostgreSQL Access

Class-based PostgreSQL utility that manages per-schema connection pools (used during migrations) and an optional shared runtime pool (used for application queries). Ideal for multi-schema setups where each module owns its own schema.

```ts
import { PostgresSchemaDbUtils } from "@devopsplaybook.io/common-utils";

// Create one instance per schema
const AuthDb = new PostgresSchemaDbUtils("AUTH");
const DictionaryDb = new PostgresSchemaDbUtils("DICTIONARY");

// Initialize OTel (once, shared across all instances)
AuthDb.initOTel(tracer, logger);

// Init schema pool (creates schema + runs migrations)
await AuthDb.initSchema(span, config, path.resolve(__dirname, "../sql/auth"));
await DictionaryDb.initSchema(span, config, path.resolve(__dirname, "../sql/dictionary"));

// Init shared runtime pool (call on any instance)
AuthDb.initRuntimePool(config);

// Query using the schema-specific pool
const users = await AuthDb.querySQL(span, "SELECT * FROM users WHERE id = $1", [userId]);

// Or use the runtime pool for non-migration queries
const rows = await AuthDb.querySQL(span, "SELECT ...", [], false);

// Transactions
await AuthDb.transaction(span, async (client) => {
  await client.query("INSERT INTO ...", [...]);
  await client.query("UPDATE ...", [...]);
});

// Cleanup
await AuthDb.closeAll();
```

| Method                                            | Description                                         |
| ------------------------------------------------- | --------------------------------------------------- |
| `new PostgresSchemaDbUtils(schemaName)`           | Create instance for a specific schema               |
| `initOTel(tracer, logger)`                        | Inject OTel instances (shared across all instances) |
| `initSchema(context, config, sqlDir)`             | Create schema pool and run migrations               |
| `initRuntimePool(config)`                         | Create shared runtime pool                          |
| `execSQL(context, sql, params?, useSchemaPool?)`  | Execute write, returns `Promise<number>`            |
| `execSQLFile(context, filename, useSchemaPool?)`  | Execute an entire SQL file                          |
| `querySQL(context, sql, params?, useSchemaPool?)` | Execute read, returns `Promise<any[]>`              |
| `transaction(context, callback, useSchemaPool?)`  | Run callback inside a transaction                   |
| `closeAll()`                                      | Close all pools managed by this instance            |

`useSchemaPool` (default `true`) selects between the schema-specific pool (migrations) and the shared runtime pool (application queries).

---

#### `DbUtils` -- Unified Database Facade

Dispatches to SQLite or Postgres based on `config.DATABASE_TYPE`. Write SQL using SQLite-style `?` placeholders; they are automatically converted to `$1, $2, ...` for Postgres.

```ts
import {
  DbUtilsSetOTel,
  DbUtilsInit,
  DbUtilsExecSQL,
  DbUtilsQuerySQL,
} from "@devopsplaybook.io/common-utils";

DbUtilsSetOTel(tracer, logger);
await DbUtilsInit(span, config, sqlDir);

// Works with both SQLite and Postgres -- placeholders auto-converted
const rows = DbUtilsQuerySQL(span, "SELECT * FROM users WHERE id = ?", [
  userId,
]);
```

| Export                                        | Description                                  |
| --------------------------------------------- | -------------------------------------------- |
| `DbUtilsSetOTel(tracer, logger)`              | Set OTel on both backends                    |
| `DbUtilsInit(span, config, sqlDir)`           | Init the active backend                      |
| `DbUtilsExecSQL(span, sql, params?)`          | Write with auto-conversion                   |
| `DbUtilsQuerySQL(span, sql, params?, debug?)` | Read with auto-conversion                    |
| `DbUtilsGetDatabase()`                        | Returns native handle (`Database` or `Pool`) |
| `DbUtilsGetType()`                            | Returns `"sqlite"` or `"postgres"`           |
| `convertToPostgresPlaceholders(sql)`          | Converts `?` to `$1, $2, ...`                |

---

#### `DbUtilsNoTelemetry` -- High-Throughput Path

Same SQL operations but **without** creating OTel spans. Use on hot paths where span overhead matters.

```ts
import {
  DbUtilsNoTelemetrySetLogger,
  DbUtilsNoTelemetryExecSQL,
  DbUtilsNoTelemetryBatchInsert,
} from "@devopsplaybook.io/common-utils";

DbUtilsNoTelemetrySetLogger(logger);

DbUtilsNoTelemetryExecSQL("INSERT INTO log (msg) VALUES (?)", [message]);

// Batch insert: builds multi-row INSERT
DbUtilsNoTelemetryBatchInsert(
  "INTO prices (token, price, ts)", // table + columns
  3, // number of columns
  [
    ["BTC", 65000, "2024-01-01"],
    ["ETH", 3200, "2024-01-01"],
  ], // rows
);
```

| Export                                                    | Description                       |
| --------------------------------------------------------- | --------------------------------- |
| `DbUtilsNoTelemetrySetLogger(logger)`                     | Inject logger for error reporting |
| `DbUtilsNoTelemetryExecSQL(sql, params?)`                 | Write without spans               |
| `DbUtilsNoTelemetryQuerySQL(sql, params?, debug?)`        | Read without spans                |
| `DbUtilsNoTelemetryBatchInsert(tableCols, numCols, rows)` | Optimized multi-row INSERT        |

---

#### `Notifications` -- Central Notifications Client

Fail-safe client for sending notifications to the central notifications service (the `notifications` project). The client never throws when misconfigured: it is simply disabled, the integration status is logged exactly once at construction time, and follow-up `send` calls on a disabled client are silent and resolve to `null`.

```ts
import { NotificationsClient } from "@devopsplaybook.io/common-utils";

const client = new NotificationsClient({
  apiEndpoint: config.NOTIFICATIONS_API,
  apiToken: config.NOTIFICATIONS_TOKEN,
  logger: OTelLogger().createModuleLogger("notifications"),
});

// Optional helpers per severity
await client.info("Job started", "Nightly sync running", "my-app");
await client.success("Job finished", "Nightly sync done", "my-app");
await client.warning("Disk usage high", "85% on /data", "my-app");
await client.error("Job failed", "Nightly sync crashed", "my-app");

// Or a full payload
await client.send({
  title: "Deployment finished",
  body: "Version 1.2.3 deployed to production",
  source: "my-app",
  severity: "success",
  data: JSON.stringify({ version: "1.2.3" }),
});
```

| Export                 | Description                                                       |
| ---------------------- | ----------------------------------------------------------------- |
| `NotificationsClient`  | HTTP client with `send` plus `info`/`success`/`warning`/`error` helpers |
| `NotificationsConfig`  | `{ apiEndpoint, apiToken, logger? }` constructor configuration      |
| `NotificationPayload`  | `{ title, body?, source?, severity?, data? }` request payload      |
| `NotificationResponse` | Shape returned by the notifications API                            |
| `NotificationSeverity` | `"info" \| "warning" \| "error" \| "success"`                    |
| `NotificationsLogger` | Minimal logger interface (`info`/`warn`/`error`), console by default |

**Behaviour when not configured**: when `apiEndpoint` or `apiToken` is empty the client logs `"Notifications integration disabled (...)"` once at construction and every `send`/helper call resolves to `null` without logging, so the parent application never fails.

---

#### `LLM` -- OpenAI-Compatible Chat Completions Client

Client for any OpenAI-compatible chat completions API (DeepSeek, Moonshot, Ollama, etc.), centralizing the `LLM_API_KEY` / `LLM_API_URL` / `LLM_MODEL` integration used across server projects. The client follows the same fail-safe pattern as the notifications client: it is disabled (and logs once at construction) when `apiKey`, `apiUrl` or `model` is missing. Unlike notifications, `request` on a disabled client throws, since a silently empty LLM result is rarely what the caller wants — check `isEnabled()` first.

```ts
import { LLMClient } from "@devopsplaybook.io/common-utils";

const llm = new LLMClient({
  apiKey: config.LLM_API_KEY,
  apiUrl: config.LLM_API_URL,
  model: config.LLM_MODEL,
  logger: OTelLogger().createModuleLogger("llm"),
});

if (llm.isEnabled()) {
  const response = await llm.request([
    { role: "system", content: "You summarize text." },
    { role: "user", content: someText },
  ]);
  console.log(response.content, response.totalTokens);

  // JSON output mode (response_format: json_object) and per-call model override
  const json = await llm.request(
    [{ role: "user", content: "Reply with a JSON object" }],
    { jsonMode: true, model: "other-model" },
  );
}
```

| Export               | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `LLMClient`          | HTTP client with `isEnabled()` and `request(messages, options?)`           |
| `LLMClientConfig`    | `{ apiKey, apiUrl, model, timeoutMs?, logger? }` constructor configuration |
| `LLMMessage`         | `{ role, content }` chat message                                           |
| `LLMRequestOptions`  | `{ jsonMode?, model? }` per-request overrides                              |
| `LLMResponse`        | `{ content, totalTokens }` normalized response                             |
| `LLMLogger`          | Minimal logger interface (`info`/`error`), console by default              |

**Behaviour details**: requests are sent with `stream: false` and Bearer authentication; the default timeout is 120 seconds (`timeoutMs` overrides it). Provider errors are rethrown as `Error` carrying the provider message when available (e.g., `error.message` from the HTTP response). An empty content is returned as-is — applications that need an empty-content policy (e.g., retry on reasoning models) keep it in their own code.

---

#### `Auth`, `User`, `UserSession`, `UserPassword`, `UsersData`, `UsersRoutes` -- Authentication and User Management

Standard JWT-based authentication and user management shared across all server projects: JWT key persistence in the `metadata` table, request authentication helpers, bcrypt password hashing, users CRUD, and ready-to-register fastify routes (login, user CRUD, password change).

```ts
import {
  AuthSetOTel,
  AuthInit,
  UsersDataSetOTel,
  UsersRoutes,
} from "@devopsplaybook.io/common-utils";

// At startup, after DbUtilsInit:
AuthSetOTel(otel.OTelTracer());
UsersDataSetOTel(otel.OTelTracer());
await AuthInit(span, config, ["traces", "metrics", "logs"]); // app scopes

// Register the standard user routes:
fastify.register(new UsersRoutes().getRoutes, { prefix: "/api/users" });
```

| Export                       | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `AuthSetOTel`                | Injects the OTel tracer used by the auth module (before `AuthInit`)    |
| `AuthInit`                   | Registers app scopes, loads or generates the JWT key from `metadata`   |
| `AuthGenerateJWT`            | Signs a JWT for a user (admins get all scopes)                         |
| `AuthMustBeAuthenticated`    | 403 guard: any valid JWT                                               |
| `AuthMustBeAdmin`            | 403 guard: `role === "admin"`                                          |
| `AuthHasScope`               | 403 guard: admin or JWT containing the requested scope                 |
| `AuthGetUserSession`         | Returns the `UserSession` decoded from the request JWT                 |
| `User`, `UserRole`, `UserScope` | User model; scopes are application-defined strings                  |
| `UserSession`                | Decoded session: `isAuthenticated`, `userId`, `userName`, `role`, `scopes` |
| `UserPasswordSetPassword` / `UserPasswordCheckPassword` | bcrypt hashing and verification             |
| `UsersDataSetOTel`           | Injects the OTel tracer used by the users data module                  |
| `UsersData*`                 | Users table CRUD (`Get`, `GetByName`, `List`, `Add`, `UpdateUser`, `UpdatePassword`, `Delete`) |
| `UsersRoutes`                | Fastify routes: `GET /status/initialization`, `POST /session`, user CRUD, `PUT /password` |

**Requirements**: a `users` table (columns `id`, `name`, `passwordEncrypted`, `role`, `scopes`) and the standard `metadata` table created by `init-0000.sql`. SQL is written SQLite-first; the `DbUtils` facade converts placeholders for Postgres.

---

#### `SystemCommand` -- Shell Command Execution

```ts
import { SystemCommandExecute } from "@devopsplaybook.io/common-utils";

const output = await SystemCommandExecute("ls -la /tmp", { cwd: "/home" });
```

#### `Timeout` -- Promise-based Delay

```ts
import { TimeoutWait } from "@devopsplaybook.io/common-utils";

await TimeoutWait(5000); // wait 5 seconds
```

### Quick Start

```ts
import {
  createOTelContext,
  ConfigBase,
  DbUtilsSetOTel,
  DbUtilsInit,
} from "@devopsplaybook.io/common-utils";
import { StandardTracer, StandardMeter } from "@devopsplaybook.io/otel-utils";

// 1. Config
class AppConfig extends ConfigBase {
  constructor() {
    super("my-app");
  }
  async reload() {
    await super.reload((m) => console.log(m));
  }
}
const config = new AppConfig();
await config.reload();

// 2. OTel
const otel = createOTelContext();
otel.OTelSetTracer(new StandardTracer(config));
otel.OTelSetMeter(new StandardMeter(config));
otel.OTelLogger().initOTel(config);

// 3. Database
DbUtilsSetOTel(otel.OTelTracer(), otel.OTelLogger());
const span = otel.OTelTracer().startSpan("init");
await DbUtilsInit(span, config, path.resolve(__dirname, "../sql"));
span.end();
```

---

## Shared GitHub Actions Workflows

The `.github/workflows/` directory contains **reusable workflows** that other repositories can call to standardize their CI/CD pipelines.

### Reusable Workflows

| Workflow        | File                       | Trigger         | Purpose                                                                                                                                                       |
| --------------- | -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NPM Merge**   | `reusable-npm-merge.yml`   | `workflow_call` | Lint, test, build, and publish a release to npm on merge to main. Uploads coverage to Quality Dashboard. Only publishes if the version doesn't already exist. |
| **NPM PR**      | `reusable-npm-pr.yml`      | `workflow_call` | Lint, test, and build on PR. Publishes a **beta** version tagged `beta` and comments the PR with install instructions.                                        |
| **NPM Upgrade** | `reusable-npm-upgrade.yml` | `workflow_call` | Runs `npm-check-updates -u`, bumps the patch version, and opens a PR. Supports monorepo sub-folders via `npm_services` input.                                 |
| **PR Verify**   | `reusable-pr-verify.yml`   | `workflow_call` | Matrix build/lint/test for multiple Node.js apps, plus a multi-platform Docker build pushed as `beta-pr-<PR number>` and `beta`. For monorepos with Docker images. |
| **Merge Build** | `reusable-merge-build.yml` | `workflow_call` | Promotes the image validated by the merged PR to the `latest`, version, major and minor tags. Runs no build, lint or test.                                      |

### Inputs and Secrets

#### NPM Workflows (`reusable-npm-merge`, `reusable-npm-pr`)

| Input              | Required | Default | Description                                               |
| ------------------ | -------- | ------- | --------------------------------------------------------- |
| `node_version`     | No       | `"18"`  | Node.js version                                           |
| `npm_package_name` | Yes      | --      | npm package name (e.g. `@devopsplaybook.io/common-utils`) |

| Secret                    | Required | Description                               |
| ------------------------- | -------- | ----------------------------------------- |
| `NPM_TOKEN`               | Yes      | npm publish token                         |
| `QUALITY_DASHBOARD_URL`   | No       | Quality Dashboard URL for coverage upload |
| `QUALITY_DASHBOARD_TOKEN` | No       | Quality Dashboard upload token            |

#### NPM Upgrade (`reusable-npm-upgrade`)

| Input          | Required | Default                                 | Description                                                   |
| -------------- | -------- | --------------------------------------- | ------------------------------------------------------------- |
| `npm_services` | Yes      | --                                      | JSON array of sub-folder paths (e.g. `'["server","client"]'`) |
| `pr_branch`    | No       | `feature/YYYY.MM.DD-dependency-updates` | Branch name for the PR                                        |

#### Docker/Node Workflows (`reusable-pr-verify`, `reusable-merge-build`)

| Input                  | Required | Default                      | Description                           |
| ---------------------- | -------- | ---------------------------- | ------------------------------------- |
| `docker_platforms`     | No       | `linux/arm64/v8,linux/amd64` | Docker build platforms                |
| `node_app_directories` | No       | `""`                         | JSON array of Node.js app directories |
| `node_version`         | No       | `"22"`                       | Node.js version                       |

`reusable-merge-build` declares the same inputs so existing callers keep working, but it only reads `docker_platforms`, and only on the build fallback path. `node_app_directories` and `node_version` are ignored there because merging runs no Node.js job.

| Secret                    | Required | Description                    |
| ------------------------- | -------- | ------------------------------ |
| `DOCKER_HUB_USERNAME`     | Yes      | Docker Hub username            |
| `DOCKER_HUB_ACCESS_TOKEN` | Yes      | Docker Hub access token        |
| `QUALITY_DASHBOARD_URL`   | No       | Quality Dashboard URL          |
| `QUALITY_DASHBOARD_TOKEN` | No       | Quality Dashboard upload token |

`reusable-merge-build` also still declares the Quality Dashboard secrets for backward compatibility, but no longer uploads coverage: each report is produced once, on the pull request.

### Immutable Docker Build Strategy

Docker images are built **once**, on the pull request, and **promoted** on merge. The artifact you test is bit-for-bit the artifact you release.

| Stage            | Workflow               | Registry tags written                                                                                       |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pull request     | `reusable-pr-verify`   | `beta-pr-<PR number>` (identifies this PR's artifact) and `beta` (moving pointer to the latest PR build)     |
| Merge to default | `reusable-merge-build` | `<version>`, `<major>`, `<minor>` and `latest`, copied from `beta-pr-<PR number>`                            |

On merge the workflow:

1. Resolves the pull request behind the commit pushed to the default branch through `GET /repos/{owner}/{repo}/commits/{sha}/pulls`, falling back to the PR number in the commit **title** (`<title> (#123)` for squash and rebase, `Merge pull request #123` for merge commits). Only the title is parsed, so a `fixes #99` reference in the commit body cannot select the wrong pull request.
2. Carbon-copies the manifest with `docker buildx imagetools create --prefer-index=false`, which preserves the exact digest and the full multi-platform image index.
3. Reads back the digest of every tag it published and fails if one differs from the source.

The resolve step logs how it reached its answer, which is the first thing to check when a merge falls back to a build:

```text
Service:  planner-llm-agent 0.2.0
PR:       2 (resolved via api)
Source:   <namespace>/planner-llm-agent:beta-pr-2
Strategy: retag
```

`Strategy` is `retag` when the PR image was found and `build` when it was not.

No `npm ci`, build, lint or test runs on merge, and no Docker build happens unless promotion is impossible. The build fallback keeps releases working when a commit reaches the default branch with no matching `beta-pr-<PR number>` image, such as a direct push, a rebase merge (which leaves no PR number in the commit title), or a PR whose image was deleted from the registry.

> **Callers need no `permissions:` block.** `reusable-merge-build` requests only `contents: read`. A reusable workflow cannot ask for more than its caller is allowed, and the default read-only token ceiling is `contents: read, pull-requests: none` — requesting `pull-requests: read` makes the caller fail to start with `Invalid workflow file … The workflow is requesting 'pull-requests: read', but is only allowed 'pull-requests: none'`. The API lookup above works with `contents: read` alone.

The image name and version come from the root `package.json`, so bump the minor version in the pull request that carries the change.

> **Keep PR branches up to date with the default branch before merging.** The promoted image is the one built from the PR head, so if the default branch moved in the meantime the released artifact will not contain those commits.

Validated end to end on `planner-llm-agent` 0.2.0: the pull request pushed `beta-pr-2` and `beta`, the merge promoted that image in **40 seconds** with no build, and `beta-pr-2`, `beta`, `0.2.0`, `0.2`, `0` and `latest` all resolve to the single digest `sha256:710fed19…` with identical per-architecture digests.

### Adopting in Your Project

Create a caller workflow in `.github/workflows/main-build.yml`:

```yaml
name: Main Build
on:
  push:
    branches: ["main"]
jobs:
  npm-merge:
    uses: devopsplaybook-io/common-utils/.github/workflows/reusable-npm-merge.yml@main
    with:
      npm_package_name: "@your-scope/your-package"
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

And `.github/workflows/pr-check.yml`:

```yaml
name: PR Check
on:
  pull_request:
    branches: ["main"]
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  npm-pr:
    uses: devopsplaybook-io/common-utils/.github/workflows/reusable-npm-pr.yml@main
    with:
      npm_package_name: "@your-scope/your-package"
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

And `.github/workflows/npm-upgrade.yml` for weekly dependency updates:

```yaml
name: NPM Upgrade
on:
  schedule:
    - cron: "0 6 * * 1" # Monday 6am UTC
jobs:
  npm-upgrade:
    uses: devopsplaybook-io/common-utils/.github/workflows/reusable-npm-upgrade.yml@main
    permissions:
      contents: write
      pull-requests: write
    with:
      npm_services: "[]"
```

---

## Development

```bash
npm install
npm run build    # TypeScript compilation -> dist/
npm run lint     # ESLint (strict + stylistic)
npm run test     # Jest with coverage
```

## License

ISC

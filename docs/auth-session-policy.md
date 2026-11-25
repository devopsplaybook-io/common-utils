# Auth session policy

Single source of truth for how long a user session lasts, how it is renewed and
where it is configured in every deployed devopsplaybook.io / Didier Hoarau
application. The table below is checked against `AUTH_SESSION_POLICY_APPS` in
`src/users/AuthSessionPolicy.ts` by an automated test, so a configuration that
drifts from this document fails `npm test` in CI instead of surfacing as a
silent logout months later.

## Standard rule

User-facing applications use a **30-day sliding validity** together with a **90-day absolute cap**:

- `JWT_VALIDITY_DURATION = 2592000` (30 days): an access token stays valid for
  a month, so an idle browser session does not require a login.
- `JWT_SESSION_MAX_DURATION = 7776000` (90 days): every renewal carries the
  original `sessionStartedAt` forward, so a session cannot be extended forever
  without a fresh login.
- Renewal happens on **application start**, on **visibilitychange** (when the
  document becomes visible), on **focus**, and whenever the token has **20 % or
  less** of its lifetime remaining. The renewal threshold must always stay
  below the token lifetime, otherwise it can never fire.

## Documented exceptions

These applications intentionally run a different model. Their behaviour is
part of the policy and must not be changed by a cleanup of the standard rule:

| Application | Model | Why |
| --- | --- | --- |
| Restic Secrets Manager | 1-hour session, no renewal, the UI warns before expiry | The app exposes backup secrets; a short session limits the exposure window of an unattended browser. |
| Study Guide | 15-minute access token + 90-day rotating refresh token | The rotating refresh token is the long-lived credential; the access token stays short. |
| Cloud Photo Manager | 30-day httpOnly cookie with server-side sliding, no absolute cap | The session lives in an httpOnly cookie validated by the server; it slides at half-life instead of using a stored JWT. |

## Other documented deviations

These apps keep their current values/mechanisms and are **not** brought back to
the standard rule by this policy:

- **Planner** uses a 30-day token and no absolute cap; the client re-issues the
  session on startup with `POST /users/session`.
- **Quality Dashboard** uses a 93-day token (its own historical value) and no
  absolute cap; the custom `users/Auth.ts` signs `exp = now + validity` and does
  not use the cap field. The client re-issues the session after 10 seconds.
- **Story Writer** uses a 30-day token capped at 30 days; the client re-issues
  the session on startup with `POST /users/session`.
- **Book Reader** uses a 30-day token capped at 30 days and renews with the
  shared `common-web` helper; the absolute cap means the session requires a new
  login after a month.
- **Stock Trader** uses a 7-day token capped at 30 days; the client refreshes on
  a 401 with `POST /users/session/refresh`.
- **Chinese Text Reader** deploys a 30-day token (declared fallback 93 days) and
  no absolute cap; the custom `auth/Auth.ts` re-signs `exp = now + validity` and
  the Config cap field is unused.
- **OpenTelemetry Light** renews from a Navigation timer at 20 % remaining; it
  has no visibility/focus trigger.

## Application table

| App | Validity (s) | Absolute cap (s) | Renewal | Key persistence | Configuration source |
| --- | ---: | ---: | --- | --- | --- |
| notifications | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal (start/visibility/focus/20%) plus X-Renewed-Token via authenticated POST /api/users/session | env-only JWT_KEY in Secret didiercloud-notifications | notifications-server/src/Config.ts; clusters/homelab-apps/notifications/base/deployment.yaml |
| sourcecode-editor | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal (start/visibility/focus/20%) | DB metadata.auth_token (common-utils) | sourcecode-editor-server/src/Config.ts; clusters/homelab-apps/sourcecode-editor/base/deployment.yaml and the sandbox overlay |
| otel-light | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal timer from Navigation (20%) | DB metadata.auth_token | otel-light-server/src/Config.ts; clusters/homelab-apps/otel/otel-light/otel-light/deployment.yaml |
| kubernetes-web-lightclient | 2592000 (30 days) | 7776000 (90 days) | shared common-web helper (start/visibility/focus/interval/20%) | DB metadata.auth_token when JWT_KEY is empty | kubernetes-web-lightclient-server/src/Config.ts; clusters/homelab-apps/kubernetes-management and the cloudserver-prod deployment |
| telepathy | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal plugin (start/visibility/focus/20%) | /data/config.json init-generated JWT_KEY shared with the agent | telepathy-server/src/Config.ts and config-docker/config-server.json; clusters/homelab-apps/telepathy/telepathy/deployment.yaml |
| feedwatcher | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal (start/visibility/focus/20%) | DB metadata.auth_token | feedwatcher-server/src/Config.ts; clusters/homelab-apps/feedwatcher/base/deployment.yaml |
| devopsplaybook-viewer | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal plugin (start/visibility/focus/20%) | SQLite metadata.auth_token (custom Auth) | devopsplaybook-viewer-server/src/Config.ts; clusters/cloudserver-prod-apps/devopsplaybook/base/deployment.yaml |
| health-tracker | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal (start/visibility/focus/20%) | DB metadata.auth_token | health-tracker-server/src/Config.ts; clusters/homelab-apps/health-tracker/base/deployment.yaml |
| telepathy-monitor | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal (start/visibility/focus/20%) | DB metadata.auth_token | telepathy-monitor-server/src/Config.ts; clusters/homelab-apps/telepathy/telepathy-monitor/deployment.yaml |
| storyhero | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal (start/visibility/focus/20%) | Postgres metadata | storyhero-server/src/Config.ts; clusters/sandbox/sandbox-cloudserver-prod/storyhero/storyhero-server/base/deployment.yaml |
| cryptotrader | 2592000 (30 days) | 7776000 (90 days) | local SessionRenewal (start/visibility/focus/20%) | DB metadata.auth_token | cryptotrader-server/src/Config.ts and config.json; clusters/homelab-apps/investments/cryptotrader/deployment.yaml |
| planner | 2592000 (30 days) | 0 (no absolute cap) | client reissues on startup via POST /users/session | mandatory env JWT_KEY in Secret didiercloud-planner | planner-server/src/Config.ts; clusters/homelab-apps/planner/planner/deployment.yaml |
| quality-dashboard | 8035200 (93 days) | 0 (no absolute cap) | Navigation reissues after 10 s via POST /users/session | DB metadata.auth_token | quality-dashboard-server/src/Config.ts; clusters/homelab-apps/quality-dashboard/base/deployment.yaml |
| storywriter | 2592000 (30 days) | 2592000 (30 days) | client reissues on startup via POST /users/session | DB metadata.auth_token | storywriter-server/src/Config.ts; clusters/homelab-apps/storywriter/base/deployment.yaml |
| book-reader | 2592000 (30 days) | 2592000 (30 days) | shared common-web helper (start/visibility/focus/interval/20%) | DB metadata.auth_token | book-reader-server/src/Config.ts; clusters/homelab-apps/book-reader/base/deployment.yaml |
| stocktrader | 604800 (7 days) | 2592000 (30 days) | client refreshes on 401 via /users/session/refresh | DB metadata.auth_token | stocktrader-server/src/Config.ts and config.json; clusters/homelab-apps/investments/stocktrader/deployment.yaml |
| chinesetextreader | 2592000 deployed (8035200 declared fallback) | 0 (no absolute cap; the custom Auth re-signs exp = now + validity and the Config cap field is unused) | client POST /api/auth/sessions/renewal | DB JWTKeyData | chinesetextreader-server-v3/src/Config.ts; clusters/sandbox/sandbox-cloudserver-prod/chinesetextreader-micro/chinesetextreader-config/base/configmap-server.yaml |
| restic-secrets-manager | 3600 (1 hour) | 3600 (1 hour effective; no renewal and the cap field is unused) | none (the UI warns before expiry) | DB metadata.auth_token or an optional Secret | restic-secrets-manager-server/src/Config.ts; clusters/homelab-apps/kubernetes-management/restic-secrets-manager/base/deployment.yaml |
| cloudphotomanager | 2592000 (30 days) | 0 (no absolute cap) | server-side cookie sliding at half-life via /session and /access/validate | DB metadata.auth_token | cloudphotomanager-server/src/Config.ts; clusters/homelab-apps/cloudphotomanager/base/deployment.yaml and its configmap |
| studyguide | 900 (15 minutes) | 7776000 (90 days, rotating refresh chain) | rotating refresh via POST /api/auth/session/refresh | DB metadata and Secret didiercloud-studyguide | studyguide-server/src/Config.ts; clusters/cloudserver-prod-apps/studyguide/studyguide-config/base/configmap-server.yaml |

## Applications without a JWT session

`carol-contact-card`, `voice-recorder` and `dsc-edsembli-report` do not issue
JWTs: they have no server-side session and are intentionally absent from the
table.

## Startup validation

`AuthSessionPolicyCheck(config)` (and the log/assert wrappers described in the
README) validates the effective values after `config.reload()`:

- the validity must be a finite positive number and at least 1 hour, unless the
  app is declared with `allowShortValidity` (Study Guide);
- when sliding renewal is expected and an absolute cap is configured, the cap
  must not be smaller than the validity (a cap below the token lifetime would
  log users out before renewal can ever help);
- the effective values must match the documented values of the app;
- a disabled absolute cap and a cap equal to the validity are reported as
  warnings.

## Renewal in the browser

All Nuxt applications renew the session **before** the token expires. The
standard mechanism is `AuthService.startSessionRenewal()` from
`@devopsplaybook.io/common-web`:

```ts
// plugins/auth-renewal.client.ts
import { AuthService } from "@devopsplaybook.io/common-web/services/AuthService";

export default defineNuxtPlugin(() => {
  AuthService.startSessionRenewal();
});
```

It checks the token immediately, on `visibilitychange` when the document is
visible, on `focus`, and every 5 minutes, and renews when 20 % or less of the
lifetime remains. `AuthService.getToken()` also renews on data access.

Applications without `common-web` use an equivalent local `SessionRenewal`
helper with the same triggers (start, visibility, focus, 20 % remaining) or
their documented app-specific mechanism in the table above. A renewal
threshold longer than the token lifetime can never fire: Notifications once
used a 24-hour threshold with 1-hour tokens, which is the failure this rule
prevents.

## Signing-key rotation

Changing the configured `JWT_KEY` (environment or `config.json`) invalidates
**every** existing session: tokens signed with the previous key no longer
verify. For DB-managed keys, update the stored value in the same way:

```sql
UPDATE metadata SET value = '<new-key>' WHERE "type" = 'auth_token';
```

A non-empty configured key always takes precedence and is never persisted. For
DB-managed keys, `AuthInit` generates and persists one when none exists.
Planner and Notifications require a configured key and fail startup without
one. Rotation is an operational decision: schedule it, expect all users to log
in again, and never commit a real key to a repository.

## The `addConfigField` pitfall

A `JWT_VALIDITY_DURATION` (or any field) declared in a `Config` subclass is
**silently ignored** unless it is re-registered with `addConfigField` after
assignment when using `@devopsplaybook.io/common-utils <= 2.9.2`: the base
constructor registers the field with its 1-hour default before the subclass
field initializer runs, and `reload()` restores that default. From 2.10.1 the
defaults are captured on the first `reload()`, after the subclass initializer
has run, so the declared value is honoured. Re-registering stays harmless and
is the safest habit across versions:

```ts
class Config extends ConfigBase {
  public JWT_VALIDITY_DURATION = 2592000;
  public JWT_SESSION_MAX_DURATION = 7776000;

  constructor() {
    super("my-server");
    this.addConfigField({ field: "JWT_VALIDITY_DURATION" });
    this.addConfigField({ field: "JWT_SESSION_MAX_DURATION" });
  }
}
```

Renewal thresholds must stay below the token lifetime. Both rules are covered
by the per-application config tests and by the doc consistency test in
`src/users/AuthSessionPolicy.spec.ts`.

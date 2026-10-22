/**
 * Structured authentication/authorization audit events.
 *
 * The library emits events at security-relevant points (login, user
 * management, password and API-token changes) to a handler installed by the
 * consumer. Without a handler the events are dropped, so the default is a
 * no-op and no output format is imposed.
 *
 * Events never contain credentials: no passwords, password hashes, JWT
 * values, API-token values or token hashes are included.
 */

/** Stable, machine-readable action identifiers. */
export type AuthAuditAction =
  | "login_success"
  | "login_failure"
  | "user_create"
  | "user_update"
  | "user_delete"
  | "password_change"
  | "api_token_create"
  | "api_token_revoke";

/** A single audit record. */
export interface AuthAuditEvent {
  action: AuthAuditAction;
  outcome: "success" | "failure";
  /** ISO 8601 timestamp added by {@link AuthAuditEmit}. */
  timestamp: string;
  /**
   * Machine-readable detail (e.g. `invalid_credentials`, `bootstrap`,
   * `self`, `admin_reset`). Never contains user input beyond a username.
   */
  reason?: string;
  /** Authenticated user performing the action (absent during bootstrap). */
  actorId?: string;
  actorName?: string;
  /** User affected by an admin action (absent for self-service actions). */
  targetUserId?: string;
  targetUserName?: string;
  /** API token row id. The token value and hash are never included. */
  tokenId?: string;
  /** Names of the fields changed by an update (never their values). */
  fields?: string[];
  /** Remote IP address of the request, when available. */
  ip?: string;
}

/** Receives every emitted event. Must not throw for normal operation. */
export type AuthAuditHandler = (event: AuthAuditEvent) => void;

let auditHandler: AuthAuditHandler | undefined;

/**
 * Install (or remove, with `undefined`) the audit handler.
 * Typical use: forward events to the service logger or an audit sink.
 */
export function AuthSetAuditHandler(
  handler: AuthAuditHandler | undefined,
): void {
  auditHandler = handler;
}

/**
 * Emit an audit event. A missing handler is a no-op; a throwing handler is
 * swallowed so auditing can never fail an authentication or management
 * request.
 */
export function AuthAuditEmit(
  event: Omit<AuthAuditEvent, "timestamp">,
): void {
  if (!auditHandler) {
    return;
  }
  try {
    auditHandler({ ...event, timestamp: new Date().toISOString() });
  } catch {
    // Audit must never break the request path.
  }
}

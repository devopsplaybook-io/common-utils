import {
  AuthAuditEmit,
  AuthAuditEvent,
  AuthSetAuditHandler,
} from "./AuthAudit";

describe("AuthAudit", () => {
  afterEach(() => {
    AuthSetAuditHandler(undefined);
  });

  it("drops events when no handler is installed", () => {
    expect(() =>
      AuthAuditEmit({ action: "login_success", outcome: "success" }),
    ).not.toThrow();
  });

  it("adds an ISO timestamp and forwards the event unchanged otherwise", () => {
    const events: AuthAuditEvent[] = [];
    AuthSetAuditHandler((event) => events.push(event));

    AuthAuditEmit({
      action: "login_failure",
      outcome: "failure",
      reason: "invalid_credentials",
      targetUserName: "alice",
      ip: "127.0.0.1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        action: "login_failure",
        outcome: "failure",
        reason: "invalid_credentials",
        targetUserName: "alice",
        ip: "127.0.0.1",
      }),
    );
    expect(new Date(events[0].timestamp).toISOString()).toBe(
      events[0].timestamp,
    );
  });

  it("never lets a throwing handler break the request path", () => {
    AuthSetAuditHandler(() => {
      throw new Error("audit sink unavailable");
    });

    expect(() =>
      AuthAuditEmit({ action: "user_create", outcome: "success" }),
    ).not.toThrow();
  });

  it("stops emitting after the handler is removed", () => {
    const handler = jest.fn();
    AuthSetAuditHandler(handler);
    AuthSetAuditHandler(undefined);

    AuthAuditEmit({ action: "user_delete", outcome: "success" });

    expect(handler).not.toHaveBeenCalled();
  });
});

jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import { User } from "./User";

describe("User.fromJson", () => {
  it("should return null for falsy payloads", () => {
    expect(User.fromJson(null)).toBeNull();
    expect(User.fromJson(undefined)).toBeNull();
    expect(User.fromJson(0)).toBeNull();
    expect(User.fromJson("")).toBeNull();
  });

  it("should return null when the payload has no id (no fabricated identity)", () => {
    expect(User.fromJson({ name: "No Id" })).toBeNull();
    expect(User.fromJson({ id: "", name: "Empty Id" })).toBeNull();
    expect(User.fromJson({ id: null, name: "Null Id" })).toBeNull();
  });

  it("should round-trip a stored payload", () => {
    const user = User.fromJson({
      id: "user-1",
      name: "Alice",
      passwordEncrypted: "bcrypt-hash",
      role: "admin",
      scopes: ["traces", "metrics"],
      tokenVersion: 3,
    });

    expect(user).not.toBeNull();
    expect(user!.id).toBe("user-1");
    expect(user!.name).toBe("Alice");
    expect(user!.role).toBe("admin");
    expect(user!.scopes).toEqual(["traces", "metrics"]);
    expect(user!.tokenVersion).toBe(3);
    expect(user!.toJson()).toEqual({
      id: "user-1",
      name: "Alice",
      passwordEncrypted: "bcrypt-hash",
      role: "admin",
      scopes: ["traces", "metrics"],
      tokenVersion: 3,
    });
  });

  it("should default role, scopes and tokenVersion when absent", () => {
    const user = User.fromJson({ id: "user-2", name: "Bob" });

    expect(user!.role).toBe("user");
    expect(user!.scopes).toEqual(User.DEFAULT_SCOPES);
    expect(user!.tokenVersion).toBe(0);
  });

  it("should accept JSON-string scopes and fall back for invalid values", () => {
    const fromString = User.fromJson({
      id: "user-3",
      name: "Carol",
      scopes: '["traces"]',
    });
    expect(fromString!.scopes).toEqual(["traces"]);

    const fromInvalidJson = User.fromJson({
      id: "user-4",
      name: "Dave",
      scopes: "not-json",
    });
    expect(fromInvalidJson!.scopes).toEqual(User.DEFAULT_SCOPES);

    const fromNumber = User.fromJson({ id: "user-5", name: "Eve", scopes: 42 });
    expect(fromNumber!.scopes).toEqual(User.DEFAULT_SCOPES);
  });

  it("should normalize a non-numeric tokenVersion to 0", () => {
    const user = User.fromJson({ id: "user-6", name: "Frank", tokenVersion: "abc" });

    expect(user!.tokenVersion).toBe(0);
  });
});

describe("User.toTransportJson", () => {
  it("should expose identity, role and scopes without credentials", () => {
    const user = new User();
    user.id = "user-7";
    user.name = "Grace";
    user.role = "user";
    user.scopes = ["traces"];
    user.passwordEncrypted = "secret-hash";
    user.tokenVersion = 9;

    const transport = user.toTransportJson();

    expect(transport).toEqual({
      id: "user-7",
      name: "Grace",
      role: "user",
      scopes: ["traces"],
    });
    expect(transport.passwordEncrypted).toBeUndefined();
    expect(transport.tokenVersion).toBeUndefined();
  });
});

describe("User.normalizeScopes", () => {
  it("should return a copy of the default scopes for unknown values", () => {
    const scopes = User.normalizeScopes(undefined);

    expect(scopes).toEqual(User.DEFAULT_SCOPES);
    expect(scopes).not.toBe(User.DEFAULT_SCOPES);
  });

  it("should copy array values instead of aliasing them", () => {
    const input = ["traces"];

    const scopes = User.normalizeScopes(input);

    expect(scopes).toEqual(["traces"]);
    expect(scopes).not.toBe(input);
  });
});

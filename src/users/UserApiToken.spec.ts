jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import { UserApiToken } from "./UserApiToken";

describe("UserApiToken.fromJson", () => {
  it("should return null for falsy payloads", () => {
    expect(UserApiToken.fromJson(null)).toBeNull();
    expect(UserApiToken.fromJson(undefined)).toBeNull();
  });

  it("should round-trip a stored payload", () => {
    const apiToken = UserApiToken.fromJson({
      id: "token-1",
      name: "CI token",
      userId: "user-1",
      tokenHash: "abc123hash",
      dateCreated: "2026-09-14T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      lastUsedAt: "2026-09-15T00:00:00.000Z",
    });

    expect(apiToken).not.toBeNull();
    expect(apiToken!.id).toBe("token-1");
    expect(apiToken!.name).toBe("CI token");
    expect(apiToken!.userId).toBe("user-1");
    expect(apiToken!.expiresAt).toBe("2027-01-01T00:00:00.000Z");
    expect(apiToken!.lastUsedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(apiToken!.toJson()).toEqual({
      id: "token-1",
      name: "CI token",
      userId: "user-1",
      tokenHash: "abc123hash",
      dateCreated: "2026-09-14T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      lastUsedAt: "2026-09-15T00:00:00.000Z",
    });
  });

  it("should default the optional columns to null", () => {
    const apiToken = UserApiToken.fromJson({
      id: "token-2",
      name: "Legacy token",
      userId: "user-1",
      tokenHash: "hash",
      dateCreated: "2026-09-14T00:00:00.000Z",
    });

    expect(apiToken!.expiresAt).toBeNull();
    expect(apiToken!.lastUsedAt).toBeNull();
  });
});

describe("UserApiToken.toTransportJson", () => {
  it("should never expose the token hash", () => {
    const apiToken = new UserApiToken();
    apiToken.name = "CI token";
    apiToken.userId = "user-1";
    apiToken.tokenHash = "super-secret-hash";
    apiToken.dateCreated = "2026-09-14T00:00:00.000Z";
    apiToken.expiresAt = "2027-01-01T00:00:00.000Z";
    apiToken.lastUsedAt = "2026-09-15T00:00:00.000Z";

    const transport = apiToken.toTransportJson();

    expect(transport).toEqual({
      id: "mock-uuid-1234",
      name: "CI token",
      userId: "user-1",
      dateCreated: "2026-09-14T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      lastUsedAt: "2026-09-15T00:00:00.000Z",
    });
    expect(transport.tokenHash).toBeUndefined();
    expect(JSON.stringify(transport)).not.toContain("super-secret-hash");
  });
});

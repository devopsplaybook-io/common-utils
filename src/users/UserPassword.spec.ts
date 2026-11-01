// Wrap `genSalt` so tests can observe the configured cost: the real function
// is still called, and the mock instance is the one the module uses.
jest.mock("bcrypt", () => {
  const actual = jest.requireActual("bcrypt") as typeof import("bcrypt");
  return {
    ...actual,
    genSalt: jest.fn(actual.genSalt),
  };
});

import * as bcrypt from "bcrypt";
import { User } from "./User";
import {
  BCRYPT_ROUNDS_DEFAULT,
  UserPasswordCheckPassword,
  UserPasswordCheckPasswordDummy,
  UserPasswordGetBcryptRounds,
  UserPasswordSetPassword,
  UserPasswordSetPolicy,
  UserPasswordValidate,
} from "./UserPassword";

beforeEach(() => {
  jest.clearAllMocks();
});

test("Password should be successfully verified if it's the same", async () => {
  const password = "testPassword1234";
  const user = new User();
  await UserPasswordSetPassword(null as never, user, password);
  expect(
    await UserPasswordCheckPassword(null as never, user, password),
  ).toBeTruthy();
});

test("Password should be faile to be verified if it's not the same", async () => {
  const password = "testPassword1234";
  const passwordWrong = "testPassword12345";
  const user = new User();
  await UserPasswordSetPassword(null as never, user, password);
  expect(
    await UserPasswordCheckPassword(null as never, user, passwordWrong),
  ).toBeFalsy();
});

describe("UserPasswordValidate", () => {
  beforeEach(() => {
    UserPasswordSetPolicy({ minLength: 0, validator: null });
  });

  it("rejects missing, non-string and empty passwords", () => {
    expect(UserPasswordValidate(undefined)).toBe("Invalid: Password");
    expect(UserPasswordValidate(42)).toBe("Invalid: Password");
    expect(UserPasswordValidate("")).toBe("Missing: Password");
    expect(UserPasswordValidate("valid-pass")).toBeNull();
  });

  it("rejects passwords longer than bcrypt's 72-byte limit", () => {
    expect(UserPasswordValidate("a".repeat(72))).toBeNull();
    expect(UserPasswordValidate("a".repeat(73))).toBe(
      "Password Too Long (maximum 72 bytes)",
    );
    // Multi-byte characters count by UTF-8 byte length.
    expect(UserPasswordValidate("é".repeat(37))).toBe(
      "Password Too Long (maximum 72 bytes)",
    );
  });

  it("applies the configured minimum length", () => {
    UserPasswordSetPolicy({ minLength: 12 });
    expect(UserPasswordValidate("short")).toBe(
      "Password Too Short (minimum 12 characters)",
    );
    expect(UserPasswordValidate("long-enough-1")).toBeNull();
  });

  it("applies and can remove the application-defined validator", () => {
    UserPasswordSetPolicy({
      validator: (password) =>
        password.includes("!") ? null : "Password must contain !",
    });
    expect(UserPasswordValidate("no-bang")).toBe("Password must contain !");
    expect(UserPasswordValidate("bang!")).toBeNull();

    UserPasswordSetPolicy({ validator: null });
    expect(UserPasswordValidate("no-bang")).toBeNull();
  });
});

describe("UserPasswordSetPassword policy enforcement", () => {
  it("throws instead of silently truncating an over-long password", async () => {
    const user = new User();
    await expect(
      UserPasswordSetPassword(null as never, user, "x".repeat(73)),
    ).rejects.toThrow("Password Too Long");
  });
});

describe("UserPasswordCheckPasswordDummy", () => {
  afterEach(() => {
    UserPasswordSetPolicy({ bcryptRounds: BCRYPT_ROUNDS_DEFAULT });
  });

  it("resolves without revealing whether the account exists", async () => {
    await expect(
      UserPasswordCheckPasswordDummy("anything"),
    ).resolves.toBeUndefined();
    await expect(
      UserPasswordCheckPasswordDummy(undefined),
    ).resolves.toBeUndefined();
  });

  it("uses the configured bcrypt cost for the timing-equalizing operation", async () => {
    UserPasswordSetPolicy({ bcryptRounds: 12 });

    await UserPasswordCheckPasswordDummy("anything");

    expect(bcrypt.genSalt).toHaveBeenCalledWith(12);
  });
});

describe("UserPassword bcrypt cost", () => {
  afterEach(() => {
    UserPasswordSetPolicy({ bcryptRounds: BCRYPT_ROUNDS_DEFAULT });
  });

  it("defaults to cost 10", () => {
    expect(BCRYPT_ROUNDS_DEFAULT).toBe(10);
    expect(UserPasswordGetBcryptRounds()).toBe(BCRYPT_ROUNDS_DEFAULT);
  });

  it("uses the configured cost for new hashes", async () => {
    UserPasswordSetPolicy({ bcryptRounds: 12 });
    expect(UserPasswordGetBcryptRounds()).toBe(12);

    const user = new User();
    await UserPasswordSetPassword(null as never, user, "testPassword1234");
    expect(user.passwordEncrypted).toMatch(/^\$2[aby]\$12\$/);
  });

  it.each([
    [4, 10],
    [9, 10],
    [10, 10],
    [15, 15],
    [20, 15],
    [12.7, 12],
    [Number.NaN, 10],
    [Number.POSITIVE_INFINITY, 10],
  ])("clamps the requested cost %s to %s", (requested, expected) => {
    UserPasswordSetPolicy({ bcryptRounds: requested });
    expect(UserPasswordGetBcryptRounds()).toBe(expected);
  });
});

jest.mock("uuid", () => ({
  v4: () => "mock-uuid-1234",
}));

import { User } from "./User";
import {
  UserPasswordCheckPassword,
  UserPasswordSetPassword,
} from "./UserPassword";

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

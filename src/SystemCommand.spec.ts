import { SystemCommandExecute } from "./SystemCommand";

describe("SystemCommandExecute", () => {
  it("should resolve with stdout on success", async () => {
    const result = await SystemCommandExecute("echo hello");
    expect(result.trim()).toBe("hello");
  });

  it("should reject on command failure", async () => {
    await expect(SystemCommandExecute("exit 1")).rejects.toThrow();
  });

  it("should reject on non-existent command", async () => {
    await expect(
      SystemCommandExecute("nonexistent_command_xyz_123"),
    ).rejects.toThrow();
  });
});

import {
  SystemCommandExecFile,
  SystemCommandExecFileWithOutput,
  SystemCommandExecute,
  SystemCommandExecuteWithOutput,
} from "./SystemCommand";

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

  it("should surface stderr through the rejection error", async () => {
    try {
      await SystemCommandExecute("echo failure-details >&2; exit 1");
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as { stderr?: string }).stderr).toContain(
        "failure-details",
      );
    }
  });
});

describe("SystemCommandExecuteWithOutput", () => {
  it("should resolve with both stdout and stderr on success", async () => {
    const output = await SystemCommandExecuteWithOutput(
      "echo to-out; echo to-err >&2",
    );

    expect(output.stdout.trim()).toBe("to-out");
    expect(output.stderr.trim()).toBe("to-err");
  });

  it("should resolve with an empty stderr when nothing is written to it", async () => {
    const output = await SystemCommandExecuteWithOutput("echo only-out");

    expect(output.stdout.trim()).toBe("only-out");
    expect(output.stderr).toBe("");
  });

  it("should reject on command failure", async () => {
    await expect(
      SystemCommandExecuteWithOutput("exit 3"),
    ).rejects.toThrow();
  });
});

describe("SystemCommandExecFileWithOutput", () => {
  it("should resolve with both stdout and stderr", async () => {
    const output = await SystemCommandExecFileWithOutput("sh", [
      "-c",
      "echo to-out; echo to-err >&2",
    ]);

    expect(output.stdout.trim()).toBe("to-out");
    expect(output.stderr.trim()).toBe("to-err");
  });

  it("should resolve with an empty stderr when nothing is written to it", async () => {
    const output = await SystemCommandExecFileWithOutput("echo", ["only-out"]);

    expect(output.stdout.trim()).toBe("only-out");
    expect(output.stderr).toBe("");
  });

  it("should pass arguments verbatim, without shell interpretation", async () => {
    const output = await SystemCommandExecFileWithOutput("echo", [
      "$(whoami)",
      "; rm -rf /",
    ]);

    expect(output.stdout.trim()).toBe("$(whoami) ; rm -rf /");
  });

  it("should surface captured output through the rejection error", async () => {
    try {
      await SystemCommandExecFileWithOutput("sh", [
        "-c",
        "echo out-details; echo err-details >&2; exit 7",
      ]);
      throw new Error("expected rejection");
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string };
      expect(execError.stdout).toContain("out-details");
      expect(execError.stderr).toContain("err-details");
    }
  });

  it("should reject on non-existent executable", async () => {
    await expect(
      SystemCommandExecFileWithOutput("nonexistent_command_xyz_123", []),
    ).rejects.toThrow();
  });

  it("should honor an explicit timeout option", async () => {
    await expect(
      SystemCommandExecFileWithOutput("sh", ["-c", "sleep 5"], {
        timeout: 100,
      }),
    ).rejects.toThrow();
  });
});

describe("SystemCommandExecFile", () => {
  it("should run the executable without a shell and resolve with stdout", async () => {
    const result = await SystemCommandExecFile("echo", ["hello"]);

    expect(result.trim()).toBe("hello");
  });

  it("should pass arguments verbatim, without shell interpretation", async () => {
    const result = await SystemCommandExecFile("echo", ["$(whoami)", "; rm -rf /"]);

    expect(result.trim()).toBe("$(whoami) ; rm -rf /");
  });

  it("should reject on non-zero exit", async () => {
    await expect(
      SystemCommandExecFile("sh", ["-c", "exit 5"]),
    ).rejects.toThrow();
  });

  it("should reject on non-existent executable", async () => {
    await expect(
      SystemCommandExecFile("nonexistent_command_xyz_123", []),
    ).rejects.toThrow();
  });
});

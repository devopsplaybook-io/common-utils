import * as childProcess from "child_process";

/**
 * Shell execution helpers.
 *
 * SECURITY CONTRACT: {@link SystemCommandExecute} and
 * {@link SystemCommandExecuteWithOutput} pass the command string to a shell
 * (`child_process.exec`), so shell metacharacters in it are interpreted.
 * Never interpolate untrusted input (user input, request payloads, stored
 * values) into the command string: doing so allows command injection.
 *
 * When the executable and its arguments are known literals, prefer
 * {@link SystemCommandExecFile}: it runs the program without a shell and
 * passes arguments verbatim, so user-controlled values cannot be interpreted
 * as shell syntax.
 */

/**
 * Execute a shell command and return its stdout.
 *
 * The command runs through a shell: never interpolate untrusted input into
 * `command` (see the module security contract above).
 *
 * @param command  The command string to execute.
 * @param options  Optional `child_process.exec` options.
 * @returns Resolves with stdout on success, rejects on error (the error
 *          carries the captured stderr).
 */
export function SystemCommandExecute(
  command: string,
  options?: childProcess.ExecOptions,
): Promise<string> {
  return SystemCommandExecuteWithOutput(command, options).then(
    (output) => output.stdout,
  );
}

/**
 * Execute a shell command and return both output streams.
 *
 * The command runs through a shell: never interpolate untrusted input into
 * `command` (see the module security contract above).
 *
 * @param command  The command string to execute.
 * @param options  Optional `child_process.exec` options.
 * @returns Resolves with stdout and stderr on success, rejects on error
 *          (the error carries the captured stdout/stderr).
 */
export function SystemCommandExecuteWithOutput(
  command: string,
  options?: childProcess.ExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    childProcess.exec(command, options || {}, (error, stdout, stderr) => {
      if (error) {
        reject(withCapturedOutput(error, stdout, stderr));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

/**
 * Attach the captured streams to the rejection error so a failed command is
 * always diagnosable: not every Node.js version copies them onto the error.
 */
function withCapturedOutput(
  error: Error,
  stdout: string | Buffer,
  stderr: string | Buffer,
): Error {
  const execError = error as Error & { stdout: string; stderr: string };
  execError.stdout = String(stdout);
  execError.stderr = String(stderr);
  return execError;
}

/**
 * Execute an executable without a shell and return its stdout.
 *
 * No shell is involved: `command` is run directly and every entry of `args`
 * is passed to it verbatim, so quotes and shell metacharacters have no
 * special meaning. This is the safe form for user-controlled values.
 *
 * @param command  The executable name or path.
 * @param args     Literal arguments for the executable.
 * @param options  Optional `child_process.execFile` options.
 * @returns Resolves with stdout on success, rejects on error (the error
 *          carries the captured stdout/stderr).
 */
export function SystemCommandExecFile(
  command: string,
  args: string[] = [],
  options?: childProcess.ExecFileOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    childProcess.execFile(command, args, options || {}, (error, stdout, stderr) => {
      if (error) {
        reject(withCapturedOutput(error, stdout, stderr));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

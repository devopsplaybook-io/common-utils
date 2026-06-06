import * as childProcess from "child_process";

/**
 * Execute a shell command and return its stdout.
 *
 * @param command  The command string to execute.
 * @param options  Optional `child_process.exec` options.
 * @returns Resolves with stdout on success, rejects on error.
 */
export function SystemCommandExecute(
  command: string,
  options?: childProcess.ExecOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    childProcess.exec(command, options || {}, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(String(stdout));
      }
    });
  });
}

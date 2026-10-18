import { execFile } from 'node:child_process';

/** The fixture serves the operator itself, so control commands must yield to HTTP/PG. */
export function runWorkbenchCommand(program: string, args: string[], {
  env,
  timeoutMs = 15_000,
}: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    errorCode?: string;
    signal?: NodeJS.Signals | null;
  }>((resolve) => {
    execFile(program, args, { encoding: 'utf8', env, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout,
        stderr,
        errorCode: typeof error?.code === 'string' ? error.code : undefined,
        signal: error?.signal,
      });
    });
  });
}

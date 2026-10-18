import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pollUntil } from './poll-until';

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

/** Zellij 0.44 emits exit 1 for this exact empty inventory; other failures stay failures. */
export function workbenchSessionList(result: Awaited<ReturnType<typeof runWorkbenchCommand>>): string {
  if (result.status === 0 && !result.signal && !result.errorCode) return result.stdout;
  if (result.status === 1 && !result.signal && !result.errorCode
    && result.stdout === '' && result.stderr.trim() === 'No active zellij sessions found.') return '';
  throw new Error(`zellij session inventory failed: ${JSON.stringify(result)}`);
}

/** Observe only this fixture's socket, without an IPC request to a retiring server. */
export async function workbenchSessionSockets(socketRoot: string, session: string): Promise<string[]> {
  const contracts = await readdir(socketRoot, { withFileTypes: true });
  const sockets: string[] = [];
  for (const contract of contracts) {
    if (!contract.isDirectory()) continue;
    const socket = path.join(socketRoot, contract.name, session);
    try {
      const entry = await lstat(socket);
      if (!entry.isSocket()) throw new Error(`workbench session path is not a socket: ${socket}`);
      sockets.push(socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return sockets;
}

export async function waitForWorkbenchSessionEnd(socketRoot: string, session: string, timeoutMs = 15_000) {
  let sockets: string[] = [];
  const outcome = await pollUntil(async () => {
    sockets = await workbenchSessionSockets(socketRoot, session);
    return sockets.length === 0;
  }, { timeoutMs });
  if (!outcome.ok) throw new Error(`workbench session socket did not retire: ${JSON.stringify({ session, sockets, ...outcome })}`);
}

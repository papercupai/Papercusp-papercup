import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pollUntil } from './poll-until';
import { captureProcessSnapshot } from './process-snapshot';

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

type WorkbenchIdentity = { serverPids: number[]; chatPid?: number; transcriptPath?: string };

/** Transparent, launch-local timing of the native command found on the stuck PTY thread. */
export function installWorkbenchPsTrace(directory: string, nativePs = '/usr/bin/ps') {
  const binDirectory = path.join(directory, 'trace-bin');
  const tracePath = path.join(directory, 'ps-trace.jsonl');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  mkdirSync(binDirectory);
  writeFileSync(tracePath, '', { flag: 'wx' });
  // Forward the original streams and status; never record the process listing.
  const script = ['#!/bin/sh', `trace=${quote(tracePath)}`,
    'record() { printf \'{"phase":"%s","pid":%s,"parentPid":%s,"at":"%s","status":%s}\\n\' "$1" "$$" "$PPID" "$(/usr/bin/date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$2" >> "$trace"; }',
    'record start null', `${quote(nativePs)} "$@"`, 'result=$?', 'record end "$result"', 'exit "$result"', ''].join('\n');
  writeFileSync(path.join(binDirectory, 'ps'), script, { mode: 0o755, flag: 'wx' });
  return { binDirectory, tracePath };
}

async function readEvidenceTail(filePath?: string): Promise<Record<string, unknown>> {
  if (!filePath) return { path: filePath, observed: false };
  try {
    const handle = await open(filePath, 'r');
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, 65_536);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
      return { path: filePath, observed: true, exists: true, bytes: info.size,
        truncated: info.size > length, text: buffer.subarray(0, bytesRead).toString('utf8') };
    } finally { await handle.close(); }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return failure.code === 'ENOENT'
      ? { path: filePath, observed: true, exists: false }
      : { path: filePath, observed: false, error: { code: failure.code, message: failure.message } };
  }
}

/** The server daemon is detached from the launcher: follow only this session's socket owners. */
export async function captureWorkbenchSessionEvidence(socketRoot: string, session: string, {
  previous = { serverPids: [] },
  runCommand = runWorkbenchCommand,
  snapshot = captureProcessSnapshot,
  logPath,
  psTracePath,
}: { previous?: WorkbenchIdentity; runCommand?: typeof runWorkbenchCommand; snapshot?: typeof captureProcessSnapshot; logPath?: string; psTracePath?: string } = {}) {
  const sockets = await workbenchSessionSockets(socketRoot, session);
  const socketOwners = await Promise.all(sockets.map(async (socket) => {
    // fuser compares filesystem inodes and misses live AF_UNIX listeners.
    // ss resolves the kernel socket inode; its src filter avoids a host dump.
    const result = await runCommand('ss', ['--unix', '--listening', '--processes', '--no-header', '--numeric', 'src', socket], { timeoutMs: 5_000 });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const exact = lines.filter((line) => line.trim().split(/\s+/).includes(socket));
    const pids = [...new Set(exact.flatMap((line) => [...line.matchAll(/\bpid=(\d+)/g)].map((match) => Number(match[1]))))];
    const valid = result.status === 0 && !result.signal && !result.errorCode
      && (lines.length === 0 || (exact.length === lines.length && pids.length > 0));
    return { socket, pids: valid ? pids : [],
      error: valid ? undefined : result };
  }));
  const serverPids = [...new Set(socketOwners.flatMap((owner) => owner.pids))];
  const roots = [...new Set([...serverPids, ...previous.serverPids,
    ...(previous.chatPid ? [previous.chatPid] : [])])];
  const processes = await Promise.all(roots.map(async (pid) => ({ pid,
    ...await snapshot(pid, { includeWorkbenchEnvironment: true,
      includeRootThreads: serverPids.includes(pid) || previous.serverPids.includes(pid) }) })));
  const commands = Object.assign({}, ...processes.map((entry) => entry.processCommands)) as Record<string, string[]>;
  const environment = Object.assign({}, ...processes.map((entry) => entry.workbenchEnvironment)) as Record<string, Record<string, string>>;
  const chatPanes = Object.entries(commands).filter(([, args]) =>
    path.basename(args[0] ?? '') === 'pui' && args.includes('--solo') && args.includes('--workbench-pane'))
    .map(([pid, args]) => ({ pid: Number(pid), args, environment: environment[pid] }));
  const chat = chatPanes.length === 1 ? chatPanes[0] : undefined;
  const transcriptPath = chat?.environment?.PUI_CHAT_WORKBENCH_TRANSCRIPT ?? previous.transcriptPath;
  const identity: WorkbenchIdentity = { serverPids: [...new Set([...previous.serverPids, ...serverPids])],
    chatPid: chat?.pid ?? previous.chatPid, transcriptPath };
  let completionReceipt: Record<string, unknown> = { path: transcriptPath, observed: false };
  if (transcriptPath) {
    try {
      const receipt = await stat(transcriptPath);
      completionReceipt = { path: transcriptPath, observed: true, exists: true, isFile: receipt.isFile(), bytes: receipt.size };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      completionReceipt = failure.code === 'ENOENT'
        ? { path: transcriptPath, observed: true, exists: false }
        : { path: transcriptPath, observed: false, error: { code: failure.code, message: failure.message } };
    }
  }
  // The caller supplies this launch's private TMPDIR log, never the host log.
  const [sessionLog, psTrace] = await Promise.all([readEvidenceTail(logPath), readEvidenceTail(psTracePath)]);
  return { identity, sockets, socketOwners, processes, chatPanes, completionReceipt, sessionLog, psTrace,
    probeError: socketOwners.some((owner) => owner.error) || processes.some((entry) => entry.processProbeError || entry.threadProbeError)
      || Boolean(sessionLog.error || psTrace.error)
      ? 'workbench diagnostic incomplete' : undefined };
}

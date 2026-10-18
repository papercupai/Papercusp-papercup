import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolveGovernedProcessTree } from '../../../../scripts/lib/governed-test-process.mjs';

type ReadProc = (file: string, options: { encoding: 'utf8'; signal: AbortSignal }) => Promise<string>;
const WORKBENCH_ENV = new Set([
  'PUI_CHAT_WORKBENCH', 'PUI_CHAT_WORKBENCH_TRANSCRIPT', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_SOCKET_DIR',
]);

/** Test diagnostics for one launch; reuse the governed tree walk, never `ps --ppid`'s host census. */
export async function captureProcessSnapshot(rootPid: number, {
  timeoutMs = 2_000,
  resolveTree = resolveGovernedProcessTree,
  readProc = readFile as ReadProc,
  includeWorkbenchEnvironment = false,
  includeRootThreads = false,
  listTasks = (directory: string) => readdir(directory),
}: { timeoutMs?: number; resolveTree?: typeof resolveGovernedProcessTree; readProc?: ReadProc; includeWorkbenchEnvironment?: boolean;
  includeRootThreads?: boolean; listTasks?: (directory: string) => Promise<string[]> } = {}) {
  const descendants: string[] = [];
  const processCommands: Record<string, string[]> = {};
  const workbenchEnvironment: Record<string, Record<string, string>> = {};
  const processProbeFailures: Array<Record<string, unknown>> = [];
  const vanishedPids: number[] = [];
  const rootThreads: Array<{ tid: number; name: string; state: string; wchan: string }> = [];
  const vanishedThreads: number[] = [];
  const threadProbeFailures: Array<Record<string, unknown>> = [];
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let processTreeMethod: string | undefined;
  try {
    const tree = resolveTree(rootPid);
    processTreeMethod = tree.method;
    await Promise.all(tree.pids.map(async (pid: number) => {
      let file = `/proc/${pid}/stat`;
      try {
        const stat = await readProc(file, { encoding: 'utf8', signal });
        // comm may contain spaces and parentheses. Everything after its LAST
        // ')' has fixed field positions: state, ppid, ... starttime.
        const end = stat.lastIndexOf(')');
        const fields = stat.slice(end + 2).trim().split(/\s+/);
        if (end < 0 || !fields[0] || !/^\d+$/.test(fields[1] ?? '')) throw new Error('invalid proc stat');
        const comm = stat.slice(stat.indexOf('(') + 1, end);
        // Save state before optional details so a failed argv read cannot erase it.
        const rowIndex = descendants.push(`${pid} ${fields[1]} ${fields[0]} unknown ${comm}`) - 1;
        file = `/proc/${pid}/wchan`;
        const wchan = (await readProc(file, { encoding: 'utf8', signal })).trim();
        descendants[rowIndex] = `${pid} ${fields[1]} ${fields[0]} ${wchan} ${comm}`;
        file = `/proc/${pid}/cmdline`;
        processCommands[pid] = (await readProc(file, { encoding: 'utf8', signal })).split('\0').filter(Boolean);
        if (includeWorkbenchEnvironment) {
          file = `/proc/${pid}/environ`;
          const entries = (await readProc(file, { encoding: 'utf8', signal })).split('\0');
          workbenchEnvironment[pid] = Object.fromEntries(entries.flatMap((entry) => {
            const split = entry.indexOf('=');
            const key = entry.slice(0, split);
            return split > 0 && WORKBENCH_ENV.has(key) ? [[key, entry.slice(split + 1)]] : [];
          }));
        }
      } catch (error) {
        const failure = error as Error & { code?: string; cause?: unknown };
        if (failure.code === 'ENOENT' || failure.code === 'ESRCH') {
          vanishedPids.push(pid); // a process can exit between discovery and read
        } else {
          processProbeFailures.push({ pid, file, code: failure.code, name: failure.name, message: failure.message });
        }
      }
    }));
  } catch (error) {
    const failure = error as Error & { code?: string };
    processProbeFailures.push({ pid: rootPid, name: failure.name, code: failure.code, message: failure.message });
  }
  if (includeRootThreads && !vanishedPids.includes(rootPid)) {
    let file = `/proc/${rootPid}/task`;
    try {
      const tasks = await listTasks(file);
      await Promise.all(tasks.filter((tid) => /^\d+$/.test(tid)).map(async (tid) => {
        let taskFile = `/proc/${rootPid}/task/${tid}/stat`;
        try {
          const stat = await readProc(taskFile, { encoding: 'utf8', signal });
          const end = stat.lastIndexOf(')');
          const state = stat.slice(end + 2).trim().split(/\s+/, 1)[0];
          if (end < 0 || !state) throw new Error('invalid thread stat');
          const name = stat.slice(stat.indexOf('(') + 1, end);
          taskFile = `/proc/${rootPid}/task/${tid}/wchan`;
          const wchan = (await readProc(taskFile, { encoding: 'utf8', signal })).trim();
          rootThreads.push({ tid: Number(tid), name, state, wchan });
        } catch (error) {
          const failure = error as NodeJS.ErrnoException;
          if (failure.code === 'ENOENT' || failure.code === 'ESRCH') vanishedThreads.push(Number(tid));
          else threadProbeFailures.push({ tid: Number(tid), file: taskFile, code: failure.code, message: failure.message });
        }
      }));
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      threadProbeFailures.push({ file, code: failure.code, message: failure.message });
    }
  }
  return {
    descendants, processCommands, workbenchEnvironment, processTreeMethod, vanishedPids,
    rootThreads: rootThreads.sort((a, b) => a.tid - b.tid), vanishedThreads,
    threadProbeError: threadProbeFailures.length ? 'thread snapshot incomplete' : undefined,
    threadProbeFailures,
    processProbeElapsedMs: performance.now() - started,
    processProbeError: processProbeFailures.length ? 'process snapshot incomplete' : undefined,
    processProbeFailure: processProbeFailures.length ? processProbeFailures : undefined,
  };
}

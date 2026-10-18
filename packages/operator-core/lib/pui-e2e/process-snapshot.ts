import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolveGovernedProcessTree } from '../../../../scripts/lib/governed-test-process.mjs';

type ReadProc = (file: string, options: { encoding: 'utf8'; signal: AbortSignal }) => Promise<string>;

/** Test diagnostics for one launch; reuse the governed tree walk, never `ps --ppid`'s host census. */
export async function captureProcessSnapshot(rootPid: number, {
  timeoutMs = 2_000,
  resolveTree = resolveGovernedProcessTree,
  readProc = readFile as ReadProc,
}: { timeoutMs?: number; resolveTree?: typeof resolveGovernedProcessTree; readProc?: ReadProc } = {}) {
  const descendants: string[] = [];
  const processCommands: Record<string, unknown> = {};
  const processProbeFailures: Array<Record<string, unknown>> = [];
  const vanishedPids: number[] = [];
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
  return {
    descendants, processCommands, processTreeMethod, vanishedPids,
    processProbeElapsedMs: performance.now() - started,
    processProbeError: processProbeFailures.length ? 'process snapshot incomplete' : undefined,
    processProbeFailure: processProbeFailures.length ? processProbeFailures : undefined,
  };
}

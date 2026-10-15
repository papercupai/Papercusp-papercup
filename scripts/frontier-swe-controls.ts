/**
 * Run the FrontierSWE v2 gold + empty CONTROLS (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-007) one task
 * at a time on the isolated bench Docker daemon. No LLM spend: gold runs the task's reference `solve.sh`, empty
 * grades the untouched scaffold. See packages/operator-core/lib/external-bench/frontier-swe-controls.ts for what
 * "gold" means in v2 (the verifier scores the image's own reference; parity = 0.0 for performance tasks).
 *
 *   DOCKER_HOST=unix:///run/docker-bench.sock npx tsx scripts/frontier-swe-controls.ts \
 *     [--repo /mnt/bench/work/frontier-swe-v2] [--out /mnt/bench/work/controls/<UTC date>] \
 *     [--tasks id1,id2] [--modes gold,empty] [--solve-timeout-sec N] [--keep-images]
 *
 * Resumable: a (task, mode) pair already in <out>/results.jsonl with a non-error status is skipped, so a re-run
 * retries only infra errors. Each task's agent + verifier images are removed after the task unless --keep-images.
 * Refuses to run without DOCKER_HOST (the bench volume, not the main daemon's disk) and refuses a checkout whose
 * HEAD is not the corpus pin (solution/ and task.toml must be the files the corpus was ingested from).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadFrontierSweTaskSet } from '../packages/operator-core/lib/external-bench/task-sets';
import { liveProcExec } from '../packages/operator-core/lib/external-bench/grader/index';
import {
  runFrontierSweControl,
  type FrontierSweControlMode,
} from '../packages/operator-core/lib/external-bench/frontier-swe-controls';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readDone(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return done;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { instanceId?: string; mode?: string; graderStatus?: string };
      if (r.instanceId && r.mode && r.graderStatus !== 'error') done.add(`${r.instanceId}\t${r.mode}`);
    } catch {
      /* a torn last line from a killed run — that pair simply re-runs */
    }
  }
  return done;
}

/** Best-effort image cleanup through the seam's own shell-free exec — a failure is logged, never fatal. */
async function docker(args: string[]): Promise<void> {
  const r = await liveProcExec('docker', args);
  if (r.code !== 0) console.error(`docker ${args.join(' ')}: exit ${r.code}: ${r.stderr.split('\n')[0]}`);
}

async function main(): Promise<number> {
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost) {
    console.error('refusing: set DOCKER_HOST=unix:///run/docker-bench.sock (controls run on the bench daemon, not the main one)');
    return 2;
  }
  const repoDir = resolve(arg('repo') ?? '/mnt/bench/work/frontier-swe-v2');
  const outDir = resolve(arg('out') ?? `/mnt/bench/work/controls/${new Date().toISOString().slice(0, 10)}`);
  const modes = (arg('modes') ?? 'gold,empty').split(',').filter(Boolean) as FrontierSweControlMode[];
  if (modes.some((m) => m !== 'gold' && m !== 'empty')) {
    console.error(`--modes must be gold and/or empty, got ${modes.join(',')}`);
    return 2;
  }
  const ids = arg('tasks')?.split(',').filter(Boolean);
  const solveTimeoutSec = arg('solve-timeout-sec') ? Number(arg('solve-timeout-sec')) : undefined;
  const keepImages = process.argv.includes('--keep-images');

  // The loader applies taskIds ONLY to the '-custom' set, so narrow the CPU set here (an unknown id is an error,
  // never a silent run of the whole set — the first smoke attempt started all 19 tasks that way).
  // controls:'ignore' — this runner PRODUCES the control ledger that gates every scored v2 set, so it must load the
  // tasks before they have (or after they fail) controls.
  const cpu = loadFrontierSweTaskSet('frontier-swe-v2-cpu', undefined, { controls: 'ignore' });
  const unknown = (ids ?? []).filter((id) => !cpu.some((t) => t.instanceId === id));
  if (unknown.length) {
    console.error(`not in frontier-swe-v2-cpu: ${unknown.join(',')}`);
    return 2;
  }
  const tasks = ids ? cpu.filter((t) => ids.includes(t.instanceId)) : cpu;
  if (!tasks.length) {
    console.error('no tasks selected');
    return 2;
  }
  const head = (await liveProcExec('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).stdout.trim();
  const pins = new Set(tasks.map((t) => String(t.graderMeta?.['upstreamCommit'] ?? '')));
  if (pins.size !== 1 || !pins.has(head)) {
    console.error(`refusing: checkout ${repoDir} is at ${head}, corpus pin(s) ${[...pins].join(',')}`);
    return 2;
  }

  await mkdir(outDir, { recursive: true });
  const resultsPath = `${outDir}/results.jsonl`;
  const done = await readDone(resultsPath);
  console.log(`controls: ${tasks.length} task(s), modes ${modes.join(',')}, out ${resultsPath}, ${done.size} pair(s) already done`);

  for (const task of tasks) {
    const meta = (task.graderMeta ?? {}) as Record<string, unknown>;
    for (const mode of modes) {
      if (mode === 'gold' && !meta['solutionCmd']) continue;
      if (done.has(`${task.instanceId}\t${mode}`)) continue;
      console.log(`[${new Date().toISOString()}] ${task.instanceId} ${mode} …`);
      const r = await runFrontierSweControl({ task, mode, repoDir, solveTimeoutSec });
      const row = {
        ...r,
        corpusCommit: head,
        dockerImage: meta['dockerImage'],
        verifierDockerImage: meta['verifierDockerImage'],
        dockerHost,
      };
      await appendFile(resultsPath, `${JSON.stringify(row)}\n`);
      console.log(
        `[${r.finishedAt}] ${task.instanceId} ${mode} → ${r.graderStatus} score=${r.score}` +
          (r.oracle ? ` solveExit=${r.oracle.exitCode}${r.oracle.timedOut ? ' TIMEOUT' : ''}` : '') +
          (r.error ? ` error=${r.error.slice(0, 200)}` : '') +
          ` (${Math.round(r.durationMs / 1000)}s)`,
      );
    }
    if (!keepImages) {
      const images = [...new Set([meta['dockerImage'], meta['verifierDockerImage']].filter((x): x is string => typeof x === 'string'))];
      if (images.length) await docker(['rmi', '-f', ...images]);
      await docker(['image', 'prune', '-f']);
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

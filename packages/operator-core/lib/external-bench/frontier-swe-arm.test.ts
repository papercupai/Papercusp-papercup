import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoordinationSpec } from './coordination-topology';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import type { ProcExec } from './grader/swe-bench-pro';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import { runFrontierSweArm, runFrontierSweResilient } from './frontier-swe-arm';
import { readRunResults } from './frontier-swe-resume';

const SPEC: CoordinationSpec = {
  arm: 'su-independent',
  claimModel: 'self-claim-fifo',
  broadcast: 'none',
  review: 'none',
  sharedState: 'both',
  team: 'per-backlog',
  disciplineForbid: [],
  central: false,
  aggregate: 'none',
  coordinator: 'none',
};

const ROW_META = { version: 'fs@test', modelId: 'claude-opus-4-8', harnessVersion: 'h1', preregHash: 'p1', rolloutId: 'r1' };

const CORPUS = [
  { instanceId: 'cranelift-codegen-opt', tier: 'performance', prompt: 'opt cranelift', dockerImage: 'img/cranelift:v6', gpus: 0, verifierCmd: 'bash /tests/test.sh', rewardPath: '/logs/verifier/reward.txt', rewardJsonPath: '/logs/verifier/reward.json' },
  { instanceId: 'git-to-zig', tier: 'implementation', prompt: 'port git', dockerImage: 'img/git:v4', gpus: 0, verifierCmd: 'bash /tests/test.sh', rewardPath: '/logs/verifier/reward.txt', rewardJsonPath: '/logs/verifier/reward.json' },
];

/**
 * Fake docker for the seam: run→cid, verifier exec→0, rm→ok, and a container filesystem holding ONLY reward.txt.
 * The live reward reader probes before it reads (`test -e <path>` → 0 present / 1 absent, then `cat`), so an absent
 * reward.json must probe 1 — a probe that said "present" followed by a failing `cat` is a docker fault (graderError).
 */
function fakeSeamExec(reward = '0.5'): ProcExec {
  let n = 0;
  return async (_cmd, args) => {
    if (args[0] === 'run') return { stdout: `cid-${n++}\n`, stderr: '', code: 0 };
    if (args[0] === 'rm') return { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'exec' && args[2] === 'test') {
      const path = args[args.length - 1];
      return { stdout: '', stderr: '', code: path.endsWith('reward.txt') ? 0 : 1 };
    }
    if (args[0] === 'exec' && args.includes('cat')) {
      const path = args[args.length - 1];
      return path.endsWith('reward.txt') ? { stdout: reward, stderr: '', code: 0 } : { stdout: '', stderr: 'no', code: 1 };
    }
    return { stdout: '', stderr: '', code: 0 }; // the verifier exec
  };
}

/** Fake agent: always completes with a small fixed usage; submission = the container handle. */
const fakeRunAgent = async (input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> => ({
  submission: input.handle,
  status: 'completed',
  modelCalls: 1,
  tokensIn: 10,
  tokensOut: 10,
  costUsd: 0.01,
  turns: 1,
});

let dir: string;
const prev = process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frontier-arm-'));
  writeFileSync(join(dir, 'tasks.jsonl'), CORPUS.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = join(dir, 'tasks.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;
  else process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = prev;
});

function clock() {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

describe('runFrontierSweArm', () => {
  it('refuses a current Papercusp arm using legacy injected runAgent before cloning or spending', () => {
    expect(() => runFrontierSweArm({ spec: { ...SPEC, arm: 'papercusp' }, runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000 }, seed: 0, runId: 'fixture-current', rowMeta: ROW_META,
    })).toThrow(/legacy runAgent injection is retired/);
  });

  it('runs the arm over the cpu task-set → one frontier-swe row per task with the seam-read score', async () => {
    const res = await runFrontierSweArm({
      spec: SPEC,
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000, maxWallMs: 1e9 },
      seed: 0,
      runId: 'run1',
      rowMeta: ROW_META,
      now: clock(),
      seamExec: fakeSeamExec('0.5'),
    });
    expect(res.rows).toHaveLength(2);
    expect(res.rows.every((r) => r.suite === 'frontier-swe')).toBe(true);
    expect(res.rows.every((r) => r.arm === 'su-independent')).toBe(true);
    expect(res.rows.every((r) => r.score === 0.5 && r.resolved === false)).toBe(true);
    expect(res.rows.every((r) => r.modality === 'in-container')).toBe(true);
    expect(res.skippedTaskIds).toEqual([]);
  });

  it('honours the iso-budget — exhausting maxModelCalls skips later tasks (counted false at report time)', async () => {
    const res = await runFrontierSweArm({
      spec: SPEC,
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1 }, // one task spends 1 call → the next is skipped
      seed: 0,
      runId: 'run2',
      rowMeta: ROW_META,
      now: clock(),
      cap: 1,
      seamExec: fakeSeamExec('0.7'),
    });
    expect(res.rows.length + res.skippedTaskIds.length).toBe(2); // same denominator: every task accounted for
    expect(res.budgetExhausted).toBe(true);
  });
});

describe('runFrontierSweResilient — self-healing resume (P-010)', () => {
  it('runs only the missing (task, seed) trials and durably appends them', async () => {
    const resultsPath = join(dir, 'results.jsonl');
    // Pre-seed: cranelift seed 0 already scored → must NOT be re-run.
    writeFileSync(
      resultsPath,
      JSON.stringify({ instanceId: 'cranelift-codegen-opt', seed: 0, arm: 'su-independent', score: 0.5, resolved: false, graderStatus: 'failed' }) + '\n',
    );

    const { perSeed, rows, alreadyComplete } = await runFrontierSweResilient({
      spec: SPEC,
      k: 2,
      resultsPath,
      runIdBase: 'resume1',
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000, maxWallMs: 1e9 },
      rowMeta: ROW_META,
      now: clock(),
      seamExec: fakeSeamExec('0.6'),
      bundleDir: join(dir, 'out'),
    });

    expect(alreadyComplete).toBe(false);
    // Missing trials: cranelift seed1; git-to-zig seed0 + seed1 = 3 new rows (cranelift seed0 was skipped).
    expect(rows).toHaveLength(3);
    const ran = rows.map((r) => `${r.taskId}@${r.seed}`).sort();
    expect(ran).toEqual(['cranelift-codegen-opt@1', 'git-to-zig@0', 'git-to-zig@1']);
    expect(rows.every((r) => r.score === 0.6)).toBe(true);

    // Durable file now has the pre-seed + 3 appended = 4 records.
    const persisted = readRunResults(resultsPath);
    expect(persisted).toHaveLength(4);
    expect(perSeed.length).toBe(2); // seed 0 (git only) + seed 1 (both)
    // P-022 / D-009: every appended trial keeps the seam's scorer output (its integrity verdict) for campaign bundles.
    for (const rec of persisted.slice(1)) {
      expect(rec.graderDetail).toMatchObject({ integrity: { verdict: 'clean' } });
    }
  });

  it('a fully-complete results file is a no-op resume (alreadyComplete)', async () => {
    const resultsPath = join(dir, 'results.jsonl');
    const full = [];
    for (const id of ['cranelift-codegen-opt', 'git-to-zig']) {
      for (const seed of [0, 1]) {
        full.push(JSON.stringify({ instanceId: id, seed, arm: 'su-independent', score: 0.5, resolved: false, graderStatus: 'failed' }));
      }
    }
    writeFileSync(resultsPath, full.join('\n') + '\n');

    const { rows, alreadyComplete } = await runFrontierSweResilient({
      spec: SPEC,
      k: 2,
      resultsPath,
      runIdBase: 'resume2',
      runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000 },
      rowMeta: ROW_META,
      now: clock(),
      seamExec: fakeSeamExec(),
      bundleDir: join(dir, 'out'),
    });
    expect(alreadyComplete).toBe(true);
    expect(rows).toHaveLength(0);
  });
});

describe('runFrontierSweResilient — dated campaign bundle (P-022 / D-010, FSWE-P022-BUNDLE@1)', () => {
  /** The fake agent reports its transcript pointer, as the live runAgent must (D-010 item 1). */
  const tracingRunAgent = async (input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> => ({
    ...(await fakeRunAgent(input)),
    traceRef: `traces/${input.task.instanceId}.jsonl`,
  });
  const readBundle = (bundleDir: string, root: string) => {
    const manifest = JSON.parse(readFileSync(join(bundleDir, root, 'manifest.json'), 'utf8'));
    const tasks = (manifest.files as string[]).map((rel) => JSON.parse(readFileSync(join(bundleDir, root, rel), 'utf8')));
    return { manifest, tasks };
  };

  it('a completed two-task campaign writes a dated bundle holding every task\'s trace with its scorer output', async () => {
    const resultsPath = join(dir, 'results.jsonl');
    const bundleDir = join(dir, 'out');
    const { bundle } = await runFrontierSweResilient({
      spec: SPEC, k: 1, resultsPath, runIdBase: 'camp1', runAgent: tracingRunAgent,
      budget: { maxModelCalls: 1000, maxWallMs: 1e9 }, rowMeta: ROW_META, now: clock(), seamExec: fakeSeamExec('0.6'), bundleDir,
    });
    expect(bundle.root).toMatch(/^benchmarks\/campaigns\/\d{4}-\d{2}-\d{2}-camp1$/);
    expect(bundle).toMatchObject({ complete: true, missing: [] });
    const { manifest, tasks } = readBundle(bundleDir, bundle.root);
    expect(manifest).toMatchObject({ complete: true, taskCount: 2 });
    expect(tasks.map((t) => t.trace.ref).sort()).toEqual(['traces/cranelift-codegen-opt.jsonl', 'traces/git-to-zig.jsonl']);
    for (const t of tasks) {
      expect(t.scorer.score).toBe(0.6);
      expect(t.scorer.status).not.toMatch(/^(error|timeout|invalid|not-graded)$/);
      expect(t.scorer.detail).toMatchObject({ integrity: { verdict: 'clean' } }); // the seam's scorer output, kept
    }
    // The durable record carries the pointer too, so a later re-bundle keeps it.
    expect(readRunResults(resultsPath).map((r) => r.traceRefs)).toEqual(
      expect.arrayContaining([['traces/cranelift-codegen-opt.jsonl'], ['traces/git-to-zig.jsonl']]),
    );
  });

  it('an agent that reports no transcript leaves the bundle incomplete and names each missing trace', async () => {
    const bundleDir = join(dir, 'out');
    const { bundle } = await runFrontierSweResilient({
      spec: SPEC, k: 1, resultsPath: join(dir, 'results.jsonl'), runIdBase: 'camp2', runAgent: fakeRunAgent,
      budget: { maxModelCalls: 1000, maxWallMs: 1e9 }, rowMeta: ROW_META, now: clock(), seamExec: fakeSeamExec('0.6'), bundleDir,
    });
    expect(bundle.complete).toBe(false);
    expect(bundle.missing.map((m) => `${m.taskId}:${m.lacks.join('+')}`).sort())
      .toEqual(['cranelift-codegen-opt:trace', 'git-to-zig:trace']);
    // The incomplete bundle is still written: the gap is evidence, not a dropped campaign.
    expect(readBundle(bundleDir, bundle.root).manifest.complete).toBe(false);
  });

  it('a resumed campaign bundles the earlier trials from the durable record, not only this pass', async () => {
    const resultsPath = join(dir, 'results.jsonl');
    writeFileSync(resultsPath, JSON.stringify({
      instanceId: 'cranelift-codegen-opt', seed: 0, arm: 'su-independent', score: 0.5, resolved: false, graderStatus: 'failed',
      traceRefs: ['traces/earlier.jsonl'],
    }) + '\n');
    const bundleDir = join(dir, 'out');
    const { rows, bundle } = await runFrontierSweResilient({
      spec: SPEC, k: 1, resultsPath, runIdBase: 'camp3', runAgent: tracingRunAgent,
      budget: { maxModelCalls: 1000, maxWallMs: 1e9 }, rowMeta: ROW_META, now: clock(), seamExec: fakeSeamExec('0.6'), bundleDir,
    });
    expect(rows.map((r) => r.taskId)).toEqual(['git-to-zig']); // only the missing trial ran
    expect(bundle).toMatchObject({ complete: true, missing: [] });
    const refs = readBundle(bundleDir, bundle.root).tasks.map((t) => t.trace.ref).sort();
    expect(refs).toEqual(['traces/earlier.jsonl', 'traces/git-to-zig.jsonl']);
  });
});

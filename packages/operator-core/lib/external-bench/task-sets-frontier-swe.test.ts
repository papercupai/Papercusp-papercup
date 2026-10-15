import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFrontierSweTaskSet,
  frontierSweRowToBenchTask,
  frontierSwePilotSubset,
  frontierSweV2PilotStrata,
  frontierSweTaskSetVersion,
  frontierSweCpuRunnable,
  isFrontierSweTaskSet,
  knownTaskSets,
  FRONTIER_SWE_TASK_SET_IDS,
  FRONTIER_SWE_V2_SUITE_CATEGORIES,
  type FrontierSweTaskRow,
} from './task-sets';
import { loadBenchTaskSet } from './task-sets';
import { FRONTIER_SWE_V2_SUITE_CATEGORIES as INGEST_SUITE_CATEGORIES } from './frontier-swe-ingest';
import { admitByFrontierSweControls, readFrontierSweControlLedger } from './frontier-swe-control-ledger';

const V2_COMMIT = 'da83f84f8fbcec3cbf0f2b17c98ebc811355c2df';
const v2Row = (o: Partial<FrontierSweTaskRow> & Pick<FrontierSweTaskRow, 'instanceId' | 'suiteCategories'>): FrontierSweTaskRow => ({
  prompt: `Do ${o.instanceId}.`,
  dockerImage: `us-docker.pkg.dev/proximal-evals-public/${o.instanceId}@sha256:${'a'.repeat(64)}`,
  verifierDockerImage: `us-docker.pkg.dev/proximal-evals-public/${o.instanceId}@sha256:${'b'.repeat(64)}`,
  verifierEnvironmentMode: 'separate',
  verifierCmd: 'bash /tests/test.sh',
  rewardPath: '/logs/verifier/reward.txt',
  rewardJsonPath: '/logs/verifier/reward.json',
  solutionCmd: 'bash /solution/solve.sh',
  agentTimeoutSec: 72000,
  gpus: 0,
  externalNeeds: [],
  artifacts: [{ source: '/app/', exclude: ['.git'] }],
  corpusVersion: 'v2',
  networkMode: 'allowlist',
  upstreamCommit: V2_COMMIT,
  ...o,
});

/** Overlapping multi-label strata: Scientific Computing is scarcest (1), Visual + AI must fall past reused tasks. */
const V2_ROWS: FrontierSweTaskRow[] = [
  v2Row({ instanceId: 'vis-impl', suiteCategories: ['Visual Reasoning', 'Implementation'], memoryMb: 4096 }),
  v2Row({ instanceId: 'impl-only', suiteCategories: ['Implementation'], memoryMb: 8192 }),
  v2Row({ instanceId: 'sci', suiteCategories: ['Scientific Computing'], memoryMb: 32768, verifierEnv: { MODE: 'eval' } }),
  v2Row({ instanceId: 'perf-modal', suiteCategories: ['Performance Optimisation'], memoryMb: 4096, externalNeeds: ['modal-vm-runtime'] }),
  v2Row({ instanceId: 'perf-local', suiteCategories: ['Performance Optimisation'], memoryMb: 16384 }),
  v2Row({ instanceId: 'ai-gpu', suiteCategories: ['AI Research'], gpus: 1, verifierNetworkMode: 'no-network' }),
  v2Row({ instanceId: 'vis-ai', suiteCategories: ['Visual Reasoning', 'AI Research'], memoryMb: 32768 }),
];

const ROWS: FrontierSweTaskRow[] = [
  {
    instanceId: 'cranelift-codegen-opt',
    category: 'programming',
    tier: 'performance',
    difficulty: 'hard',
    tags: ['compiler-optimization'],
    prompt: 'Improve Cranelift codegen speed.',
    dockerImage: 'ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6',
    agentTimeoutSec: 72000,
    verifierTimeoutSec: 86400,
    cpus: 8,
    memoryMb: 131072,
    storageMb: 50000,
    gpus: 0,
    gpuTypes: [],
    allowInternet: false,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
    rewardJsonPath: '/logs/verifier/reward.json',
    solutionCmd: 'bash /solution/solve.sh',
    hasOracle: true,
  },
  {
    instanceId: 'git-to-zig',
    category: 'c-to-zig',
    tier: 'implementation',
    difficulty: 'very_hard',
    tags: ['zig'],
    prompt: 'Reimplement git in Zig.',
    dockerImage: 'ghcr.io/proximal-labs/frontier-swe/git-to-zig:v4',
    agentTimeoutSec: 72000,
    verifierTimeoutSec: 86400,
    cpus: 4,
    memoryMb: 16384,
    storageMb: 30720,
    gpus: 0,
    gpuTypes: [],
    allowInternet: false,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
    solutionCmd: 'bash /solution/solve.sh',
    hasOracle: true,
  },
  {
    instanceId: 'optimizer-design',
    category: 'ml-research',
    tier: 'research',
    difficulty: 'frontier',
    tags: ['optimizer'],
    prompt: 'Design a better optimizer.',
    dockerImage: 'ghcr.io/proximal-labs/frontier-swe/optimizer-design-task:v4',
    agentTimeoutSec: 72000,
    verifierTimeoutSec: 10800,
    cpus: 8,
    memoryMb: 131072,
    storageMb: 102400,
    gpus: 1,
    gpuTypes: ['H100'],
    allowInternet: false,
    verifierCmd: 'bash /tests/test.sh',
    rewardPath: '/logs/verifier/reward.txt',
    solutionCmd: null,
    hasOracle: false,
  },
];

let dir: string;
const prevEnv = process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;
const prevV2Env = process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_JSONL;
const writeJsonl = (name: string, rows: FrontierSweTaskRow[]) => {
  const path = join(dir, name);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
};

const prevControlsEnv = process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL;

/** A control row as scripts/frontier-swe-controls.ts writes it, at the fixture's own version by default. */
const control = (
  row: FrontierSweTaskRow,
  mode: 'gold' | 'empty',
  score: number | null,
  o: { graderStatus?: string; finishedAt?: string; corpusCommit?: string; dockerImage?: string;
    networkPolicy?: { declaredMode: string; agentNetworkMode: string } } = {},
) => ({
  instanceId: row.instanceId,
  mode,
  graderStatus: o.graderStatus ?? (score === null ? 'error' : score >= 1 ? 'passed' : 'failed'),
  score,
  finishedAt: o.finishedAt ?? '2026-10-11T16:00:00.000Z',
  corpusCommit: o.corpusCommit ?? row.upstreamCommit,
  dockerImage: 'dockerImage' in o ? o.dockerImage : row.dockerImage,
  networkPolicy: 'networkPolicy' in o ? o.networkPolicy : { declaredMode: row.networkMode ?? 'allowlist', agentNetworkMode: 'none' },
});
const passingControls = (rows: FrontierSweTaskRow[]) => rows.flatMap((r) => [control(r, 'gold', 1), control(r, 'empty', 0)]);
const writeControls = (rows: unknown[]) => {
  const path = join(dir, `controls-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL = path;
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frontier-swe-ts-'));
  process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = writeJsonl('tasks.jsonl', ROWS);
  process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_JSONL = writeJsonl('tasks-v2.jsonl', V2_ROWS);
  // Every v2 set is control-gated (P-007): the shared fixture publishes passing controls for every v2 row so the
  // set-shape tests below test set shape; the control-gating block replaces the ledger per case.
  writeControls(passingControls(V2_ROWS));
});

afterEach(() => {
  if (prevControlsEnv === undefined) delete process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL;
  else process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL = prevControlsEnv;
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL;
  else process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = prevEnv;
  if (prevV2Env === undefined) delete process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_JSONL;
  else process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_JSONL = prevV2Env;
});

describe('isFrontierSweTaskSet', () => {
  it('recognizes the FrontierSWE set ids', () => {
    for (const id of FRONTIER_SWE_TASK_SET_IDS) expect(isFrontierSweTaskSet(id)).toBe(true);
    expect(isFrontierSweTaskSet('metr-hcast')).toBe(false);
    expect(isFrontierSweTaskSet('gdpval-pilot')).toBe(false);
  });
});

describe('frontierSweRowToBenchTask', () => {
  it('exposes only the prompt to the arm; scorer cmd + image + budgets ride graderMeta (un-gameable)', () => {
    const t = frontierSweRowToBenchTask(ROWS[0]);
    expect(t.benchmark).toBe('frontier-swe');
    expect(t.instanceId).toBe('cranelift-codegen-opt');
    expect(t.problemStatement).toBe('Improve Cranelift codegen speed.');
    // The arm-facing fields must NOT carry the scorer/image.
    expect(JSON.stringify(t.problemStatement)).not.toContain('reward');
    expect(t.graderMeta.dockerImage).toBe('ghcr.io/proximal-labs/frontier-swe/cranelift-codegen-opt:v6');
    expect(t.graderMeta.verifierCmd).toBe('bash /tests/test.sh');
    expect(t.graderMeta.rewardPath).toBe('/logs/verifier/reward.txt');
    expect(t.graderMeta.bucket).toBe('performance');
    expect(t.graderMeta.agentTimeoutSec).toBe(72000);
    expect(t.graderMeta.gpus).toBe(0);
  });
});

describe('task creation date (D-007, WI-6554700010008413)', () => {
  it('maps the ingest taskCreatedAt to BenchTask.createdAt and omits it on an undated row', () => {
    const dated = frontierSweRowToBenchTask(v2Row({ instanceId: 'd', suiteCategories: ['Implementation'], taskCreatedAt: '2026-09-03T12:00:00+00:00' }));
    expect(dated.createdAt).toBe('2026-09-03T12:00:00+00:00');
    expect('createdAt' in frontierSweRowToBenchTask(v2Row({ instanceId: 'u', suiteCategories: ['Implementation'] }))).toBe(false);
  });
});

describe('verifier GPUs (WI-6554700010008334)', () => {
  it('a GPU-free agent with a GPU verifier is NOT CPU-runnable; a GPU-free pair is', () => {
    expect(frontierSweCpuRunnable({ gpus: 0, verifierGpus: 1, externalNeeds: [] })).toBe(false);
    expect(frontierSweCpuRunnable({ gpus: 1, verifierGpus: 0, externalNeeds: [] })).toBe(false);
    expect(frontierSweCpuRunnable({ gpus: 0, verifierGpus: 0, externalNeeds: [] })).toBe(true);
    expect(frontierSweCpuRunnable({ gpus: 0, externalNeeds: [] })).toBe(true);
  });

  it('graderMeta carries the verifier count, and null (unknown) for a row ingested before the field existed', () => {
    const known = frontierSweRowToBenchTask(v2Row({ instanceId: 'm', suiteCategories: ['AI Research'], gpus: 2, verifierGpus: 4, verifierGpuTypes: ['H100'] }));
    expect(known.graderMeta).toMatchObject({ gpus: 2, verifierGpus: 4, verifierGpuTypes: ['H100'] });
    const stale = frontierSweRowToBenchTask(v2Row({ instanceId: 's', suiteCategories: ['AI Research'], gpus: 1 }));
    expect(stale.graderMeta.verifierGpus).toBeNull();
  });
});

describe('loadFrontierSweTaskSet', () => {
  it('frontier-swe loads the full corpus', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe');
    expect(tasks.map((t) => t.instanceId).sort()).toEqual(['cranelift-codegen-opt', 'git-to-zig', 'optimizer-design']);
    expect(tasks.every((t) => t.benchmark === 'frontier-swe')).toBe(true);
  });

  it('frontier-swe-pilot picks 1 task per bucket (impl/perf/research)', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe-pilot');
    const buckets = tasks.map((t) => t.graderMeta.bucket).sort();
    expect(buckets).toEqual(['implementation', 'performance', 'research']);
    expect(tasks).toHaveLength(3);
  });

  it('frontier-swe-cpu excludes GPU tasks (the B200/H100 infra gate)', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe-cpu');
    expect(tasks.map((t) => t.instanceId).sort()).toEqual(['cranelift-codegen-opt', 'git-to-zig']);
    expect(tasks.find((t) => t.instanceId === 'optimizer-design')).toBeUndefined();
  });

  it('frontier-swe-custom filters to taskIds; empty list throws', () => {
    const tasks = loadFrontierSweTaskSet('frontier-swe-custom', ['git-to-zig']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('git-to-zig');
    expect(() => loadFrontierSweTaskSet('frontier-swe-custom', [])).toThrow(/non-empty/);
    expect(() => loadFrontierSweTaskSet('frontier-swe-custom', ['nope'])).toThrow(/matched/);
  });

  it('a missing corpus file throws an actionable error', () => {
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = join(dir, 'does-not-exist.jsonl');
    expect(() => loadFrontierSweTaskSet('frontier-swe')).toThrow(/ingest the corpus/);
  });
});

describe('frontierSwePilotSubset', () => {
  it('prefers GPU-free, then a gold-solution control, per bucket', () => {
    const picked = frontierSwePilotSubset(ROWS);
    // research bucket only has the GPU task → it is still picked (the only option)
    expect(picked.find((r) => r.tier === 'research')?.instanceId).toBe('optimizer-design');
    expect(picked.find((r) => r.tier === 'performance')?.instanceId).toBe('cranelift-codegen-opt');
    expect(picked.find((r) => r.tier === 'implementation')?.instanceId).toBe('git-to-zig');
  });
});

describe('loadBenchTaskSet routes FrontierSWE ids', () => {
  it('resolves frontier-swe through the central dispatcher', async () => {
    const tasks = await loadBenchTaskSet('frontier-swe');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].benchmark).toBe('frontier-swe');
  });

  it('rejects frontier-swe-custom with no ids via the dispatcher', async () => {
    await expect(loadBenchTaskSet('frontier-swe-custom', [])).rejects.toThrow(/non-empty/);
  });

  it('resolves frontier-swe-v2 through the central dispatcher from the v2 corpus', async () => {
    const tasks = await loadBenchTaskSet('frontier-swe-v2');
    expect(tasks).toHaveLength(V2_ROWS.length);
    expect(tasks.every((t) => t.graderMeta.corpusVersion === 'v2')).toBe(true);
  });
});

describe('FrontierSWE v2 task sets (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-003)', () => {
  it('every id maps to exactly one corpus version', () => {
    expect(frontierSweTaskSetVersion('frontier-swe')).toBe('v1');
    expect(frontierSweTaskSetVersion('frontier-swe-cpu')).toBe('v1');
    for (const id of ['frontier-swe-v2', 'frontier-swe-v2-cpu', 'frontier-swe-v2-pilot', 'frontier-swe-v2-custom']) {
      expect(frontierSweTaskSetVersion(id)).toBe('v2');
      expect(isFrontierSweTaskSet(id)).toBe(true);
    }
    expect(frontierSweTaskSetVersion('metr-hcast')).toBeNull();
  });

  it('the ingest validates against the same suite-category list the pilot stratifies on', () => {
    expect(INGEST_SUITE_CATEGORIES).toBe(FRONTIER_SWE_V2_SUITE_CATEGORIES);
  });

  it('graderMeta carries the version tag and the separate-verifier contract; the brief stays clean', () => {
    const t = frontierSweRowToBenchTask(V2_ROWS[2]);
    expect(t.graderMeta).toMatchObject({
      corpusVersion: 'v2',
      upstreamCommit: V2_COMMIT,
      verifierEnvironmentMode: 'separate',
      verifierDockerImage: expect.stringMatching(/@sha256:b{64}$/),
      verifierEnv: { MODE: 'eval' },
      artifacts: [{ source: '/app/', exclude: ['.git'] }],
      suiteCategories: ['Scientific Computing'],
      externalNeeds: [],
    });
    expect(t.problemStatement).toBe('Do sci.');
    // A legacy untagged v1 row reads as v1 + the shared in-container verifier.
    expect(frontierSweRowToBenchTask(ROWS[0]).graderMeta).toMatchObject({
      corpusVersion: 'v1',
      verifierEnvironmentMode: 'shared',
      artifacts: [],
    });
  });

  it('frontier-swe-v2-pilot picks ONE DISTINCT task per suite category, scarcest first, cheapest within', () => {
    const strata = frontierSweV2PilotStrata(V2_ROWS);
    expect(strata.map((s) => [s.category, s.row.instanceId])).toEqual([
      ['Implementation', 'vis-impl'],
      ['Scientific Computing', 'sci'],
      ['Performance Optimisation', 'perf-local'], // CPU-runnable beats the cheaper Modal-gated task
      ['Visual Reasoning', 'vis-ai'], // vis-impl is already Implementation's pick → never reused
      ['AI Research', 'ai-gpu'], // vis-ai already taken → falls to the GPU task
    ]);
    const ids = loadFrontierSweTaskSet('frontier-swe-v2-pilot').map((t) => t.instanceId);
    expect(new Set(ids).size).toBe(FRONTIER_SWE_V2_SUITE_CATEGORIES.length);
  });

  it('frontier-swe-v2-pilot refuses a corpus that cannot cover every category', () => {
    expect(() => frontierSweV2PilotStrata(V2_ROWS.filter((r) => r.instanceId !== 'sci'))).toThrow(
      /no unused task in suite category 'Scientific Computing'/,
    );
    // Rows with no README categories (e.g. a v1-shaped row) cannot stratify at all.
    expect(() => frontierSweV2PilotStrata(V2_ROWS.map((r) => ({ ...r, suiteCategories: undefined })))).toThrow(
      /cannot cover all 5/,
    );
  });

  it('frontier-swe-v2-cpu excludes GPU tasks AND tasks needing an external service', () => {
    const ids = loadFrontierSweTaskSet('frontier-swe-v2-cpu').map((t) => t.instanceId).sort();
    expect(ids).toEqual(['impl-only', 'perf-local', 'sci', 'vis-ai', 'vis-impl']);
  });

  it('frontier-swe-v2-custom filters the v2 corpus only', () => {
    expect(loadFrontierSweTaskSet('frontier-swe-v2-custom', ['sci']).map((t) => t.instanceId)).toEqual(['sci']);
    // git-to-zig exists only in the v1 fixture → a v2 custom set must not find it.
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2-custom', ['git-to-zig'])).toThrow(/FrontierSWE v2 corpus matched/);
  });

  it('v1 and v2 never mix: each loader refuses rows of the other version', () => {
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL = writeJsonl('mixed-v1.jsonl', [...ROWS, V2_ROWS[0]]);
    expect(() => loadFrontierSweTaskSet('frontier-swe')).toThrow(/1 row\(s\) of another corpus version \(vis-impl=v2\)/);
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_JSONL = writeJsonl('mixed-v2.jsonl', [...V2_ROWS, ROWS[1]]);
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2')).toThrow(/git-to-zig=v1/);
  });

  it('a missing v2 corpus names the v2 ingest', () => {
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_JSONL = join(dir, 'absent.jsonl');
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2')).toThrow(/ingest the v2 corpus/);
  });

  it('the launch listing derives every FrontierSWE count and labels v1 as history', () => {
    const byId = new Map(knownTaskSets().map((s) => [s.id, s]));
    expect(byId.get('frontier-swe-v2')?.count).toBe(V2_ROWS.length);
    expect(byId.get('frontier-swe-v2-cpu')?.count).toBe(5);
    expect(byId.get('frontier-swe-v2-pilot')?.count).toBe(5);
    expect(byId.get('frontier-swe')?.count).toBe(ROWS.length);
    for (const id of ['frontier-swe', 'frontier-swe-cpu', 'frontier-swe-pilot']) {
      expect(byId.get(id)?.label).toMatch(/v1 history/);
    }
    // No FrontierSWE label hard-codes a task count (the count column is derived).
    for (const s of knownTaskSets().filter((x) => x.id.startsWith('frontier-swe'))) {
      expect(s.label).not.toMatch(/\b\d+ (ultra-long-horizon )?tasks\b/);
    }
  });
});

describe('FrontierSWE v2 control gating (P-007: FSWE-P007-GOLD@1, FSWE-P007-EMPTY@1, acceptance R-5)', () => {
  const [A, B, C] = V2_ROWS; // vis-impl, impl-only, sci — all CPU-runnable
  const others = V2_ROWS.slice(3);
  const ids = (setId = 'frontier-swe-v2') => loadFrontierSweTaskSet(setId).map((t) => t.instanceId);

  it('historical, open or mismatched network evidence cannot admit a task with otherwise passing controls', () => {
    for (const networkPolicy of [undefined, { declaredMode: 'allowlist', agentNetworkMode: 'bridge' },
      { declaredMode: 'no-network', agentNetworkMode: 'none' }]) {
      writeControls([...passingControls([B, C, ...others]), control(A, 'gold', 1, { networkPolicy }), control(A, 'empty', 0)]);
      expect(ids()).not.toContain(A.instanceId);
      expect(() => loadFrontierSweTaskSet('frontier-swe-v2-custom', [A.instanceId])).toThrow(/gold-network-unverified/);
    }
    writeControls([...passingControls([B, C, ...others]), control(A, 'gold', 1), control(A, 'empty', 0, { networkPolicy: undefined })]);
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2-custom', [A.instanceId])).toThrow(/empty-network-unverified/);
  });

  it('missing image pins and out-of-range rewards are unusable evidence', () => {
    for (const badGold of [control(A, 'gold', 1, { dockerImage: undefined }), control(A, 'gold', 1.1)]) {
      writeControls([...passingControls([B, C, ...others]), badGold, control(A, 'empty', 0)]);
      expect(ids()).not.toContain(A.instanceId);
    }
    writeControls([...passingControls([B, C, ...others]), control(A, 'gold', 1), control(A, 'empty', -0.01)]);
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2-custom', [A.instanceId])).toThrow(/empty-control-error/);
  });

  it('FSWE-P007-GOLD: a task whose gold control scores below full reward is not in any scored v2 set', () => {
    writeControls([...passingControls(others), ...passingControls([B, C]), control(A, 'gold', 0.98), control(A, 'empty', 0)]);
    expect(ids()).not.toContain(A.instanceId);
    expect(ids('frontier-swe-v2-cpu')).not.toContain(A.instanceId);
    expect(ids()).toEqual(expect.arrayContaining([B.instanceId, C.instanceId]));
  });

  it('FSWE-P007-EMPTY: a task whose empty control earns any reward is not in any scored v2 set', () => {
    writeControls([...passingControls(others), ...passingControls([A, C]), control(B, 'gold', 1), control(B, 'empty', 0.01)]);
    expect(ids()).not.toContain(B.instanceId);
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2-custom', [B.instanceId])).toThrow(/impl-only: empty-above-zero/);
  });

  it('R-5: a task with no control evidence, or only an errored control, stays out (fail closed)', () => {
    writeControls([...passingControls(others), control(A, 'gold', 1) /* no empty row */, control(B, 'gold', null), control(B, 'empty', 0)]);
    const got = ids();
    for (const t of [A, B, C]) expect(got).not.toContain(t.instanceId);
    const { excluded } = admitByFrontierSweControls(
      [A, B, C].map(frontierSweRowToBenchTask),
      readFrontierSweControlLedger(process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL!),
    );
    expect(excluded.map((x) => [x.instanceId, x.reasons])).toEqual([
      [A.instanceId, ['no-empty-control']],
      [B.instanceId, ['gold-control-error']],
      [C.instanceId, ['no-gold-control', 'no-empty-control']],
    ]);
  });

  it('evidence counts only at the task’s own version: another corpus commit or image is no evidence', () => {
    writeControls([
      ...passingControls([B, C, ...others]),
      control(A, 'gold', 1, { corpusCommit: 'f'.repeat(40) }),
      control(A, 'empty', 0, { dockerImage: `${A.dockerImage.split('@')[0]}@sha256:${'c'.repeat(64)}` }),
    ]);
    expect(ids()).not.toContain(A.instanceId);
  });

  it('the latest re-run of a control supersedes the earlier verdict, in either direction', () => {
    const base = passingControls([B, C, ...others]);
    writeControls([...base, control(A, 'gold', 0, { finishedAt: '2026-10-11T16:43:00Z' }), control(A, 'gold', 1, { finishedAt: '2026-10-11T17:30:00Z' }), control(A, 'empty', 0)]);
    expect(ids()).toContain(A.instanceId);
    writeControls([...base, control(A, 'gold', 1, { finishedAt: '2026-10-11T16:43:00Z' }), control(A, 'gold', 0.5, { finishedAt: '2026-10-11T17:30:00Z' }), control(A, 'empty', 0)]);
    expect(ids()).not.toContain(A.instanceId);
  });

  it('with no ledger at all, a scored v2 set refuses to load and names the ledger to publish', () => {
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL = join(dir, 'absent-controls.jsonl');
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2-cpu')).toThrow(/absent-controls\.jsonl.*FSWE-P007-GOLD/);
  });

  it("controls:'ignore' (the controls runner) loads tasks regardless of their controls; v1 history is never gated", () => {
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_V2_CONTROLS_JSONL = join(dir, 'absent-controls.jsonl');
    expect(loadFrontierSweTaskSet('frontier-swe-v2-cpu', undefined, { controls: 'ignore' })).toHaveLength(5);
    expect(loadFrontierSweTaskSet('frontier-swe')).toHaveLength(ROWS.length);
  });

  it('a corrupt ledger line throws instead of silently becoming missing evidence', () => {
    const path = writeControls(passingControls(V2_ROWS));
    writeFileSync(path, '{"instanceId":"vis-impl","mode":"gold"\n', { flag: 'a' });
    expect(() => loadFrontierSweTaskSet('frontier-swe-v2')).toThrow(/controls-.*\.jsonl:\d+ is not JSON/);
  });
});

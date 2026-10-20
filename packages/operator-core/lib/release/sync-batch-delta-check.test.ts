/**
 * Unit tests for the sync-batch delta check (gate-verdict-liveness P-012).
 *
 * Everything runs against plain `SyncBatchDeltaDeps` fakes — no `vi.mock`, so the
 * full-replacement-mock-guard has nothing to trip on. One test pins
 * `parseFailingFilesLine` against the REAL emitter
 * (`formatFailingFilesLine`, scripts/lib/vitest-summary.mjs) so the two cannot
 * drift, per the module header's contract.
 */
import { describe, expect, it } from 'vitest';
import { formatFailingFilesLine } from '../../../../scripts/lib/vitest-summary.mjs';
import { knownGoodShaOf, parseConfirmOutput, SYNC_DELTA_TIMEOUTS_MS } from './sync-batch-delta-check-deps';
import {
  conditionKeyForRed,
  DEFAULT_RADIUS_CAPS,
  etaIsUsable,
  evaluateRadius,
  parseAffectedEtaLine,
  grownWindowCommitCap,
  UNDETERMINED_STREAK_LIMIT,
  parseAffectedProbe,
  parseFailingFilesLine,
  parseSyncBatches,
  planStaleBacklogSkip,
  SYNC_DELTA_MAX_LISTED_COMMITS,
  runSyncBatchDeltaCheck,
  STALE_BACKLOG_MS,
  COVERAGE_JUDGE_DEADLINE_MS,
  unionBatchPaths,
  type AffectedProbe,
  type FailingFile,
  type RedFinding,
  type SyncBatch,
  type SyncBatchDeltaDeps,
  type SyncDeltaCursor,
} from './sync-batch-delta-check';

const NUL = String.fromCharCode(0);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function makeBatch(overrides: Partial<SyncBatch> = {}): SyncBatch {
  return { sha: SHA_B, committedAtMs: 1_700_000_000_000, agent: 'su-test', paths: ['packages/foo/src/a.ts'], ...overrides };
}

function makeProbe(overrides: Partial<AffectedProbe> = {}): AffectedProbe {
  return {
    workspaces: ['foo'],
    guards: [],
    taskCommands: [{ workspace: 'foo', command: 'npm run test' }],
    derivation: null,
    ...overrides,
  };
}

interface FakeState {
  cursor: SyncDeltaCursor | null;
  filed: RedFinding[];
  logs: string[];
}

function makeDeps(
  overrides: Partial<SyncBatchDeltaDeps> = {},
  initialCursor: SyncDeltaCursor | null = null,
): { deps: SyncBatchDeltaDeps; state: FakeState } {
  const state: FakeState = { cursor: initialCursor, filed: [], logs: [] };
  const deps: SyncBatchDeltaDeps = {
    readCursor: async () => state.cursor,
    writeCursor: async (n) => {
      state.cursor = n;
    },
    hostLoad: () => ({ load1: 2, cores: 128 }),
    // async by contract — these legs shell out; see SyncBatchDeltaDeps (WI-10001771).
    greenCheckpointRunning: async () => false,
    headSha: async () => SHA_B,
    listBatches: async () => [makeBatch()],
    probeRadius: async () => makeProbe(),
    runAffected: async () => ({ ok: true, failing: [] }),
    runTsc: async () => ({ ok: true, failing: [] }),
    confirmOne: async () => false,
    fileRed: async (f) => {
      state.filed.push(f);
      return { ok: true, id: 'WI-1' };
    },
    now: () => 1_000,
    log: (m) => state.logs.push(m),
    ...overrides,
  };
  return { deps, state };
}

describe('parseSyncBatches', () => {
  it('parses NUL-separated blocks: sha + epoch header, Papercusp-Agent trailer, changed paths', () => {
    const raw =
      `${NUL}${SHA_C} 1700000000\nPapercusp-Agent: su-1\npackages/foo/a.ts\npackages/foo/b.ts\n` +
      `${NUL}${SHA_A} 1700000100\npackages/bar/c.ts\n`;
    const batches = parseSyncBatches(raw);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual({
      sha: SHA_C,
      committedAtMs: 1_700_000_000_000,
      agent: 'su-1',
      paths: ['packages/foo/a.ts', 'packages/foo/b.ts'],
    });
    expect(batches[1]?.agent).toBeNull();
    expect(batches[1]?.paths).toEqual(['packages/bar/c.ts']);
  });

  it('skips malformed headers instead of inventing a batch', () => {
    expect(parseSyncBatches(`${NUL}not-a-sha 123\nfoo.ts\n`)).toEqual([]);
  });
});

describe('unionBatchPaths', () => {
  it('dedupes in first-seen order and reports truncation as a refusal, not a narrower set', () => {
    const b1 = makeBatch({ paths: ['a.ts', 'b.ts'] });
    const b2 = makeBatch({ sha: SHA_A, paths: ['b.ts', 'c.ts', 'd.ts'] });
    const capped = unionBatchPaths([b1, b2], 3);
    expect(capped.truncated).toBe(true);
    expect(capped.totalPaths).toBe(4);
    expect(capped.paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const fits = unionBatchPaths([b1, b2], 10);
    expect(fits.truncated).toBe(false);
    expect(fits.paths).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });
});

describe('parseAffectedProbe and evaluateRadius — production radius bounds', () => {
  it('parses task commands and guards as separate measured cardinalities', () => {
    const probe = parseAffectedProbe([
      'AFFECTED_DERIVATION source=explicit changedPaths=80 workspaces=10 guards=52 tasks=64',
      'AFFECTED_WS\toperator-core',
      'AFFECTED_WS_CMD\toperator-core\tnpm run test:lane-pure --workspace @papercusp/operator-core',
      'AFFECTED_GUARD\toperator-core\tlint:tsc\tnpm run lint:tsc -- --files=a.ts',
    ].join('\n'));
    expect(probe.taskCommands).toEqual([
      { workspace: 'operator-core', command: 'npm run test:lane-pure --workspace @papercusp/operator-core' },
    ]);
    expect(probe.guards).toEqual(['operator-core:lint:tsc']);
    expect(probe.derivation?.counts).toMatchObject({ changedPaths: 80, workspaces: 10, guards: 52, tasks: 64 });
  });

  it('accepts the observed 10-workspace ceiling and still refuses wider batches', () => {
    const union = unionBatchPaths([makeBatch()], 80);
    const accepted = evaluateRadius({
      probe: makeProbe({ workspaces: Array.from({ length: 10 }, (_, i) => `ws-${i}`) }),
      union,
      batchCount: 1,
    });
    expect(accepted).toEqual({ run: true, workspaces: Array.from({ length: 10 }, (_, i) => `ws-${i}`) });

    const refused = evaluateRadius({
      probe: makeProbe({ workspaces: Array.from({ length: 11 }, (_, i) => `ws-${i}`) }),
      union,
      batchCount: 1,
    });
    expect(refused).toMatchObject({ run: false, reason: 'radius-too-wide' });
  });

  it('refuses the measured task-heavy radius and independently caps guards', () => {
    const union = unionBatchPaths([makeBatch()], 80);
    const observed = makeProbe({
      workspaces: Array.from({ length: 10 }, (_, i) => `ws-${i}`),
      taskCommands: Array.from({ length: 64 }, (_, i) => ({ workspace: `ws-${i}`, command: `npm run task-${i}` })),
      guards: Array.from({ length: 52 }, (_, i) => `ws-${i}:guard-${i}`),
    });
    const tasksRefused = evaluateRadius({ probe: observed, union, batchCount: 1 });
    expect(tasksRefused).toMatchObject({ run: false, reason: 'radius-too-wide' });
    if (!tasksRefused.run) {
      expect(tasksRefused.detail).toContain('tasks=64');
      expect(tasksRefused.detail).toContain('guards=52');
      expect(tasksRefused.detail).toContain('maxTaskCommands=32');
    }

    const guardsRefused = evaluateRadius({
      probe: makeProbe({
        taskCommands: Array.from({ length: 20 }, (_, i) => ({ workspace: 'foo', command: `npm run task-${i}` })),
        guards: Array.from({ length: 27 }, (_, i) => `foo:guard-${i}`),
      }),
      union,
      batchCount: 1,
    });
    expect(guardsRefused).toMatchObject({ run: false, reason: 'radius-too-wide' });
    if (!guardsRefused.run) expect(guardsRefused.detail).toContain('maxGuards=26');
  });

  it('runs a guard-only radius instead of treating zero workspaces as no work', () => {
    const verdict = evaluateRadius({
      probe: makeProbe({
        workspaces: [],
        taskCommands: [{ workspace: 'root', command: 'npm run lint:root' }],
        guards: ['root:lint:root'],
      }),
      union: unionBatchPaths([makeBatch()], 80),
      batchCount: 1,
    });
    expect(verdict).toEqual({ run: true, workspaces: [] });
  });

  it('treats workspace names without runnable tasks or guards as nothing selected', () => {
    const verdict = evaluateRadius({
      probe: makeProbe({ taskCommands: [] }),
      union: unionBatchPaths([makeBatch()], 80),
      batchCount: 1,
    });
    expect(verdict).toMatchObject({ run: false, reason: 'nothing-selected' });
  });
});

// green-main-ratchet-convergence-2026-10-17#D-030 (WI-6554700010018036): admission by the
// runner's projected wall time instead of by task count.
describe('parseAffectedProbe and evaluateRadius — projected-time admission (D-030)', () => {
  // The line affected-tests.mjs printed for one operator-core path on 2026-10-20.
  const MEASURED_ETA =
    'AFFECTED_ETA status=projected projectedSec=1435 workSec=2790 knownTasks=40 tasks=40 unknownTasks=0 ' +
    'concurrency=2 narrowedTasks=1 heaviestSec=767 heaviestTask=@papercusp/operator-core::test:lane-stateful';

  const etaLine = (projectedSec: number, tasks: number, unknownTasks = 0) =>
    `AFFECTED_ETA status=projected projectedSec=${projectedSec} workSec=${projectedSec * 2} ` +
    `knownTasks=${tasks - unknownTasks} tasks=${tasks} unknownTasks=${unknownTasks} concurrency=2 ` +
    `narrowedTasks=1 heaviestSec=500 heaviestTask=@papercusp/web::test`;

  /** A 40-task, 29-guard radius: over both count caps (32/26), like the measured commits. */
  const wideProbe = (eta: string | null) =>
    parseAffectedProbe(
      [
        ...Array.from({ length: 9 }, (_, i) => `AFFECTED_WS\tws-${i}`),
        ...Array.from({ length: 40 }, (_, i) => `AFFECTED_WS_CMD\tws-${i % 9}\tnpm run task-${i}`),
        ...Array.from({ length: 29 }, (_, i) => `AFFECTED_GUARD\tws-0\tguard-${i}\tnpm run guard-${i}`),
        ...(eta ? [eta] : []),
      ].join('\n'),
    );
  const union = unionBatchPaths([makeBatch()], 80);

  it('parses the AFFECTED_ETA line the runner prints', () => {
    expect(parseAffectedEtaLine(MEASURED_ETA)).toEqual({
      status: 'projected',
      projectedSec: 1435,
      knownTasks: 40,
      tasks: 40,
      unknownTasks: 0,
      heaviestTask: '@papercusp/operator-core::test:lane-stateful',
      heaviestSec: 767,
      raw: MEASURED_ETA,
    });
    expect(parseAffectedEtaLine('AFFECTED_ETA status=unavailable reason=boom')).toMatchObject({
      status: 'unavailable',
      projectedSec: null,
    });
    expect(parseAffectedEtaLine('AFFECTED_WS\tfoo')).toBeNull();
    expect(parseAffectedProbe(MEASURED_ETA).eta?.projectedSec).toBe(1435);
    expect(parseAffectedProbe('AFFECTED_WS\tfoo').eta).toBeNull();
  });

  it('admits a 40-task / 29-guard radius whose projection fits the leg budget', () => {
    const verdict = evaluateRadius({ probe: wideProbe(etaLine(588, 40)), union, batchCount: 1 });
    expect(verdict).toEqual({ run: true, workspaces: Array.from({ length: 9 }, (_, i) => `ws-${i}`) });
  });

  it('admits the measured 1435s single-commit radius that the 25-min leg refused (D-034)', () => {
    // Under the 25-min affected leg (admission 1350s) this commit was refused unjudged; single
    // commits measured 1176-1750s, so most slots went unjudged. 0.9 x 45 min = 2430s admits it.
    expect(DEFAULT_RADIUS_CAPS.maxProjectedSec).toBe(2430);
    const verdict = evaluateRadius({ probe: wideProbe(MEASURED_ETA), union, batchCount: 1 });
    expect(verdict).toEqual({ run: true, workspaces: Array.from({ length: 9 }, (_, i) => `ws-${i}`) });
  });

  it('refuses a radius whose projection exceeds maxProjectedSec, naming the heaviest task', () => {
    const over = DEFAULT_RADIUS_CAPS.maxProjectedSec + 1;
    const overEta = MEASURED_ETA.replace('projectedSec=1435', `projectedSec=${over}`);
    const verdict = evaluateRadius({ probe: wideProbe(overEta), union, batchCount: 1 });
    expect(verdict).toMatchObject({ run: false, reason: 'radius-too-wide' });
    if (!verdict.run) {
      expect(verdict.detail).toContain(`projected ${over}s exceeds maxProjectedSec=2430s`);
      expect(verdict.detail).toContain('heaviest @papercusp/operator-core::test:lane-stateful 767s');
      expect(verdict.detail).toContain('40/40 tasks with history');
    }
  });

  it('keeps the 32/26 count caps when the probe printed no projection', () => {
    const verdict = evaluateRadius({ probe: wideProbe(null), union, batchCount: 1 });
    expect(verdict).toMatchObject({ run: false, reason: 'radius-too-wide' });
    if (!verdict.run) expect(verdict.detail).toContain('maxTaskCommands=32');
  });

  it('keeps the count caps when history covers too little of the radius to trust the projection', () => {
    const probe = wideProbe(etaLine(100, 40, 11));
    expect(etaIsUsable(probe.eta)).toBe(false);
    const verdict = evaluateRadius({ probe, union, batchCount: 1 });
    expect(verdict).toMatchObject({ run: false, reason: 'radius-too-wide' });
    if (!verdict.run) expect(verdict.detail).toContain('maxTaskCommands=32');
    expect(etaIsUsable(wideProbe(etaLine(100, 40, 10)).eta)).toBe(true);
  });

  it('keeps the count caps when the projection is unavailable', () => {
    const verdict = evaluateRadius({
      probe: wideProbe('AFFECTED_ETA status=unavailable reason=history-unreadable'),
      union,
      batchCount: 1,
    });
    if (!verdict.run) expect(verdict.detail).toContain('maxTaskCommands=32');
    expect(verdict.run).toBe(false);
  });

  it('still refuses past the count backstops on the projected-time path', () => {
    const probe = parseAffectedProbe(
      [
        'AFFECTED_WS\tws-0',
        ...Array.from({ length: 97 }, (_, i) => `AFFECTED_WS_CMD\tws-0\tnpm run task-${i}`),
        etaLine(100, 97),
      ].join('\n'),
    );
    const verdict = evaluateRadius({ probe, union, batchCount: 1 });
    expect(verdict).toMatchObject({ run: false, reason: 'radius-too-wide' });
    if (!verdict.run) expect(verdict.detail).toContain('maxEtaTaskCommands=96');
  });

  it('ties the default time budget to 0.9 x the affected leg timeout', () => {
    expect(DEFAULT_RADIUS_CAPS.maxProjectedSec).toBe(Math.round((0.9 * SYNC_DELTA_TIMEOUTS_MS.affected) / 1000));
  });
});

describe('runSyncBatchDeltaCheck — cursor discipline', () => {
  it('bootstraps the cursor at tip on first run (never scans history backwards)', async () => {
    const { deps, state } = makeDeps();
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('bootstrapped');
    expect(state.cursor?.sha).toBe(SHA_B);
  });

  it('reports up-to-date when the cursor already sits at head', async () => {
    const { deps, state } = makeDeps({}, { sha: SHA_B, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('up-to-date');
    expect(state.cursor?.sha).toBe(SHA_B);
  });

  it('a skip does NOT advance the cursor, only annotates the skip', async () => {
    const { deps, state } = makeDeps({ listBatches: async () => null }, { sha: SHA_A, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('git-log-unreadable');
    expect(state.cursor?.sha).toBe(SHA_A); // window stays unjudged
    expect(state.cursor?.lastSkipReason).toBe('git-log-unreadable');
  });

  // green-main-ratchet-convergence-2026-10-17 P-009 / D-017: load never skips. Above the
  // hard ceiling, or with an unreadable load, the window is judged on the reduced budget.
  it.each([
    ['load above the hard ceiling', () => ({ load1: 500, cores: 128 })],
    ['an unreadable load', () => null],
  ])('%s does NOT skip: the window is judged and the cursor advances', async (_label, hostLoad) => {
    const { deps, state } = makeDeps({ hostLoad }, { sha: SHA_A, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).not.toBe('skipped');
    expect(state.cursor?.sha).not.toBe(SHA_A);
    expect(state.cursor?.lastSkipReason).toBeUndefined();
  });

  it('a running green-checkpoint suite REDUCES the budget instead of skipping (P-001)', async () => {
    // The old rule skipped here; with the gate running for hours that judged almost
    // nothing. Legs run at idle priority instead, so the window IS judged.
    const { deps, state } = makeDeps({ greenCheckpointRunning: async () => true }, { sha: SHA_A, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('green');
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.logs.some((l) => l.includes('reduced budget') && l.includes('green-checkpoint-running'))).toBe(true);
  });

  it('an undetermined affected run (red, no break-set line) holds the cursor', async () => {
    const { deps, state } = makeDeps(
      { runAffected: async () => ({ ok: false, failing: null }) },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('affected-run-missing-terminal-break-set');
    expect(state.cursor?.sha).toBe(SHA_A); // re-judged next tick
  });

  it('a single commit wider than the workspace cap is explicitly skipped without evaluating it', async () => {
    const { deps, state } = makeDeps(
      {
        probeRadius: async () => ({
          workspaces: Array.from({ length: 11 }, (_, i) => `ws-${i}`),
          guards: [],
          taskCommands: [],
          derivation: null,
        }),
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('radius-too-wide');
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.cursor?.lastSkipReason).toContain('single commit');
    expect(state.cursor?.lastSkipReason).toContain('maxWorkspaces=10');
    expect(state.cursor?.coverage?.ticks.at(-1)?.evaluated).toBe(false);
  });

  it('judges the oldest path-bounded prefix and leaves the newer backlog behind the cursor', async () => {
    let testedPaths: string[] = [];
    const oldest = makeBatch({ sha: SHA_A, paths: ['oldest.ts'] });
    const middle = makeBatch({ sha: SHA_B, paths: ['middle.ts'] });
    const newest = makeBatch({ sha: SHA_C, paths: ['newest.ts'] });
    const { deps, state } = makeDeps(
      {
        headSha: async () => SHA_C,
        listBatches: async () => [newest, middle, oldest], // source order is newest first
        runAffected: async (paths) => {
          testedPaths = [...paths];
          return { ok: true, failing: [] };
        },
      },
      { sha: 'd'.repeat(40), updatedAtMs: 1 },
    );

    const res = await runSyncBatchDeltaCheck(deps, { caps: { maxWorkspaces: 10, maxPaths: 2, maxCommits: 10 } });

    expect(res.status).toBe('green');
    expect(res.batchCount).toBe(2);
    expect(new Set(testedPaths)).toEqual(new Set(['oldest.ts', 'middle.ts']));
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.cursor?.lastBatchCommits).toBe(2);
  });

  it('keeps the commit cap on the oldest side of a newer backlog', async () => {
    const oldest = makeBatch({ sha: SHA_A, paths: ['same.ts'] });
    const middle = makeBatch({ sha: SHA_B, paths: ['same.ts'] });
    const newest = makeBatch({ sha: SHA_C, paths: ['same.ts'] });
    const { deps, state } = makeDeps(
      {
        headSha: async () => SHA_C,
        listBatches: async () => [newest, middle, oldest],
      },
      { sha: 'd'.repeat(40), updatedAtMs: 1 },
    );

    const res = await runSyncBatchDeltaCheck(deps, { caps: { maxWorkspaces: 10, maxPaths: 10, maxCommits: 2 } });

    expect(res.status).toBe('green');
    expect(res.batchCount).toBe(2);
    expect(state.cursor?.sha).toBe(SHA_B);
  });

  it('shrinks a workspace-wide prefix until the oldest bounded prefix fits', async () => {
    const probed: string[][] = [];
    let testedPaths: string[] = [];
    const oldest = makeBatch({ sha: SHA_A, paths: ['oldest.ts'] });
    const middle = makeBatch({ sha: SHA_B, paths: ['middle.ts'] });
    const newest = makeBatch({ sha: SHA_C, paths: ['newest.ts'] });
    const { deps, state } = makeDeps(
      {
        headSha: async () => SHA_C,
        listBatches: async () => [newest, middle, oldest],
        probeRadius: async (paths) => {
          probed.push([...paths]);
          return paths.length > 1
            ? makeProbe({ workspaces: ['ws-a', 'ws-b'] })
            : makeProbe({ workspaces: ['ws-a'] });
        },
        runAffected: async (paths) => {
          testedPaths = [...paths];
          return { ok: true, failing: [] };
        },
      },
      { sha: 'd'.repeat(40), updatedAtMs: 1 },
    );

    const res = await runSyncBatchDeltaCheck(deps, { caps: { maxWorkspaces: 1, maxPaths: 10, maxCommits: 10 } });

    expect(res.status).toBe('green');
    expect(probed).toHaveLength(2);
    expect(probed[1]).toEqual(['oldest.ts']);
    expect(testedPaths).toEqual(['oldest.ts']);
    expect(state.cursor?.sha).toBe(SHA_A);
  });

  it('shrinks a task- and guard-heavy prefix before executing it', async () => {
    const probed: string[][] = [];
    let testedPaths: string[] = [];
    const oldest = makeBatch({ sha: SHA_A, paths: ['oldest.ts'] });
    const middle = makeBatch({ sha: SHA_B, paths: ['middle.ts'] });
    const newest = makeBatch({ sha: SHA_C, paths: ['newest.ts'] });
    const { deps, state } = makeDeps(
      {
        headSha: async () => SHA_C,
        listBatches: async () => [newest, middle, oldest],
        probeRadius: async (paths) => {
          probed.push([...paths]);
          return paths.length > 1
            ? makeProbe({
                taskCommands: Array.from({ length: 3 }, (_, i) => ({ workspace: 'foo', command: `npm run task-${i}` })),
                guards: ['foo:guard-a', 'foo:guard-b'],
              })
            : makeProbe({
                taskCommands: [{ workspace: 'foo', command: 'npm run task-a' }],
                guards: ['foo:guard-a'],
              });
        },
        runAffected: async (paths) => {
          testedPaths = [...paths];
          return { ok: true, failing: [] };
        },
      },
      { sha: 'd'.repeat(40), updatedAtMs: 1 },
    );

    const res = await runSyncBatchDeltaCheck(deps, {
      caps: { maxWorkspaces: 10, maxPaths: 10, maxCommits: 10, maxTaskCommands: 1, maxGuards: 1 },
    });

    expect(res.status).toBe('green');
    expect(probed).toHaveLength(2);
    expect(probed[1]).toEqual(['oldest.ts']);
    expect(testedPaths).toEqual(['oldest.ts']);
    expect(state.cursor?.sha).toBe(SHA_A);
  });

  it('advances past only a path-oversized oldest commit with an explicit non-evaluated reason', async () => {
    let probes = 0;
    const oversized = makeBatch({ sha: SHA_A, paths: Array.from({ length: 81 }, (_, i) => `path-${i}.ts`) });
    const newer = makeBatch({ sha: SHA_B, paths: ['newer.ts'] });
    const { deps, state } = makeDeps(
      {
        headSha: async () => SHA_B,
        listBatches: async () => [newer, oversized],
        probeRadius: async () => {
          probes += 1;
          return makeProbe();
        },
      },
      { sha: 'd'.repeat(40), updatedAtMs: 1 },
    );

    const res = await runSyncBatchDeltaCheck(deps, { caps: { maxWorkspaces: 10, maxPaths: 80, maxCommits: 40 } });

    expect(res.status).toBe('radius-too-wide');
    expect(res.pathCount).toBe(81);
    expect(res.reason).toContain(SHA_A.slice(0, 12));
    expect(res.reason).toContain('maxPaths=80');
    expect(state.cursor?.sha).toBe(SHA_A);
    expect(state.cursor?.coverage?.ticks.at(-1)?.evaluated).toBe(false);
    expect(probes).toBe(0);
  });
});

describe('runSyncBatchDeltaCheck — known-good point (green-main-cycle-time P-012)', () => {
  const failingFile: FailingFile = { workspace: 'foo', file: 'packages/foo/src/a.test.ts' };
  const OLD_GOOD = { sha: SHA_C, atMs: 5 };

  it('a fully green window records the judged commit as the known-good point', async () => {
    const { deps, state } = makeDeps({ now: () => 42 }, { sha: SHA_A, updatedAtMs: 1, lastPassed: OLD_GOOD });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('green');
    expect(state.cursor?.lastPassed).toEqual({ sha: SHA_B, atMs: 42 });
  });

  it('a confirmed affected-tests red carries the previous known-good point', async () => {
    const { deps, state } = makeDeps(
      { runAffected: async () => ({ ok: false, failing: [failingFile] }), confirmOne: async () => false },
      { sha: SHA_A, updatedAtMs: 1, lastPassed: OLD_GOOD },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('red');
    expect(state.cursor?.sha).toBe(SHA_B); // the cursor advances
    expect(state.cursor?.lastPassed).toEqual(OLD_GOOD); // the known-good point does not
  });

  it('an UNCONFIRMED red is still a red leg: the window reports green but is not known-good', async () => {
    const { deps, state } = makeDeps(
      { runAffected: async () => ({ ok: false, failing: [failingFile] }), confirmOne: async () => null },
      { sha: SHA_A, updatedAtMs: 1, lastPassed: OLD_GOOD },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('green');
    expect(state.cursor?.lastPassed).toEqual(OLD_GOOD);
  });

  it('a typecheck red carries the previous known-good point', async () => {
    const { deps, state } = makeDeps(
      { runTsc: async () => ({ ok: false, failing: ['packages/foo/src/a.ts'] }), confirmOne: async () => false },
      { sha: SHA_A, updatedAtMs: 1, lastPassed: OLD_GOOD },
    );
    await runSyncBatchDeltaCheck(deps);
    expect(state.cursor?.lastPassed).toEqual(OLD_GOOD);
  });

  it('a still-failing held-open red keeps a green window from becoming known-good', async () => {
    const openRed = { path: failingFile.file, workspace: 'foo', introducedBy: SHA_C, firstSeenMs: 1, confirmations: 1 };
    const { deps, state } = makeDeps(
      { confirmOne: async () => false },
      { sha: SHA_A, updatedAtMs: 1, openReds: [openRed], lastPassed: OLD_GOOD },
    );
    await runSyncBatchDeltaCheck(deps);
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.cursor?.openReds?.[0]?.path).toBe(failingFile.file);
    expect(state.cursor?.lastPassed).toEqual(OLD_GOOD);
  });

  it('a held cursor (undetermined run) and an up-to-date tick both keep the known-good point', async () => {
    const held = makeDeps(
      { runAffected: async () => ({ ok: false, failing: null }) },
      { sha: SHA_A, updatedAtMs: 1, lastPassed: OLD_GOOD },
    );
    expect((await runSyncBatchDeltaCheck(held.deps)).status).toBe('skipped');
    expect(held.state.cursor?.lastPassed).toEqual(OLD_GOOD);

    const idle = makeDeps({}, { sha: SHA_B, updatedAtMs: 1, lastPassed: OLD_GOOD });
    expect((await runSyncBatchDeltaCheck(idle.deps)).status).toBe('up-to-date');
    expect(idle.state.cursor?.lastPassed).toEqual(OLD_GOOD);
  });

  it('bootstrapping at the tip never claims the tip as known-good (nothing was judged)', async () => {
    const { deps, state } = makeDeps();
    expect((await runSyncBatchDeltaCheck(deps)).status).toBe('bootstrapped');
    expect(state.cursor?.lastPassed).toBeUndefined();
  });

  it('knownGoodShaOf accepts only a full lowercase sha, never a ref or abbreviation', () => {
    expect(knownGoodShaOf(SHA_B)).toBe(SHA_B);
    expect(knownGoodShaOf('staging')).toBeNull();
    expect(knownGoodShaOf(SHA_B.slice(0, 12))).toBeNull();
    expect(knownGoodShaOf(SHA_B.toUpperCase())).toBeNull();
    expect(knownGoodShaOf(null)).toBeNull();
    expect(knownGoodShaOf(undefined)).toBeNull();
  });
});

describe('runSyncBatchDeltaCheck — reds, confirmation, filing', () => {
  const failingFile: FailingFile = { workspace: 'foo', file: 'packages/foo/src/a.test.ts' };

  it('a confirmed red files ONE deduped item under its conditionKey, attributed to the touching batch', async () => {
    const batch = makeBatch({ paths: ['packages/foo/src/a.test.ts'] });
    const { deps, state } = makeDeps(
      {
        listBatches: async () => [batch],
        runAffected: async () => ({ ok: false, failing: [failingFile] }),
        confirmOne: async () => false, // re-confirmed red in its own invocation
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('red');
    expect(state.filed).toHaveLength(1);
    const finding = state.filed[0]!;
    expect(finding.conditionKey).toBe(conditionKeyForRed(failingFile.file));
    expect(finding.body).toContain(`Introducing batch: ${batch.sha}`);
    expect(finding.body).toContain('Papercusp-Agent trailer: su-test');
    expect(res.filed[0]?.introducedBy).toBe(batch.sha);
    // the red is held open on the advanced cursor for cheap re-verification
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.cursor?.openReds?.[0]?.path).toBe(failingFile.file);
  });

  it('attributes a red to a commit NEWER than a capped judged prefix (the legs ran on the whole tree)', async () => {
    // WI-6554700010018334: a learned cap of 1 judged only the oldest commit, but the legs ran
    // on the shared tree at HEAD. The break was in a newer commit, so a prefix-only search
    // either found nothing or (via radius) blamed the innocent oldest commit.
    const innocentOldest = makeBatch({ sha: SHA_C, agent: 'su-innocent', paths: ['packages/foo/src/unrelated.ts'] });
    const culprit = makeBatch({ sha: SHA_B, agent: 'su-culprit', paths: ['packages/foo/src/a.test.ts'] });
    const { deps, state } = makeDeps(
      {
        listBatches: async () => [culprit, innocentOldest], // newest first
        runAffected: async () => ({ ok: false, failing: [failingFile] }),
        confirmOne: async () => false,
      },
      { sha: SHA_A, updatedAtMs: 1, windowCommitCap: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('red');
    expect(state.filed).toHaveLength(1);
    expect(res.filed[0]?.introducedBy).toBe(culprit.sha);
    const body = state.filed[0]!.body;
    expect(body).toContain(`Introducing batch: ${culprit.sha}`);
    expect(body).toContain('the batch touched this exact file');
    expect(body).not.toContain('NOT ATTRIBUTED');
    expect(body).toContain('test radius taken from the oldest 1; the tested tree contains all 2');
  });

  it('a red the single-file re-run does NOT reproduce is reported unconfirmed, never filed', async () => {
    const { deps, state } = makeDeps(
      {
        runAffected: async () => ({ ok: false, failing: [failingFile] }),
        confirmOne: async () => null, // collection-abort false positive: undetermined
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(state.filed).toHaveLength(0);
    expect(res.unconfirmed).toEqual([failingFile.file]);
    expect(res.status).toBe('green'); // nothing was PROVEN red
  });

  it('re-verifies held-open reds even with no new commits, refreshing the same conditionKey', async () => {
    const openRed = {
      path: failingFile.file,
      workspace: failingFile.workspace,
      introducedBy: SHA_C,
      firstSeenMs: 500,
      confirmations: 1,
    };
    const { deps, state } = makeDeps(
      { headSha: async () => SHA_A, confirmOne: async () => false },
      { sha: SHA_A, updatedAtMs: 1, openReds: [openRed] },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('up-to-date');
    expect(state.filed).toHaveLength(1);
    expect(state.filed[0]?.conditionKey).toBe(conditionKeyForRed(failingFile.file));
    expect(state.cursor?.openReds?.[0]?.confirmations).toBe(2);
  });

  it('retries a notification miss on the next cursor tick and preserves the filing error', async () => {
    const openRed = {
      path: failingFile.file,
      workspace: failingFile.workspace,
      introducedBy: SHA_C,
      firstSeenMs: 500,
      confirmations: 1,
    };
    let deliveryAttempts = 0;
    const { deps, state } = makeDeps(
      {
        headSha: async () => SHA_A,
        confirmOne: async () => false,
        fileRed: async (finding) => {
          deliveryAttempts += 1;
          state.filed.push(finding);
          return deliveryAttempts === 1
            ? { ok: true, id: 'WI-77', notificationError: 'required wake not queued' }
            : { ok: true, id: 'WI-77' };
        },
      },
      { sha: SHA_A, updatedAtMs: 1, openReds: [openRed] },
    );

    const first = await runSyncBatchDeltaCheck(deps);
    expect(first.status).toBe('up-to-date');
    expect(first.filed).toMatchObject([{ id: 'WI-77', notificationError: 'required wake not queued' }]);
    expect(state.cursor?.openReds?.[0]?.confirmations).toBe(2);
    expect(deliveryAttempts).toBe(1);

    const second = await runSyncBatchDeltaCheck(deps);
    expect(second.status).toBe('up-to-date');
    expect(second.filed).toMatchObject([{ id: 'WI-77' }]);
    expect(second.filed[0]).not.toHaveProperty('notificationError');
    expect(state.cursor?.openReds?.[0]?.confirmations).toBe(3);
    expect(deliveryAttempts).toBe(2);
  });

  it('a held-open red that re-runs green stops being held', async () => {
    const openRed = { path: failingFile.file, workspace: null, introducedBy: null, firstSeenMs: 500, confirmations: 1 };
    const { deps, state } = makeDeps(
      { headSha: async () => SHA_A, confirmOne: async () => true },
      { sha: SHA_A, updatedAtMs: 1, openReds: [openRed] },
    );
    await runSyncBatchDeltaCheck(deps);
    expect(state.filed).toHaveLength(0);
    expect(state.cursor?.openReds ?? []).toHaveLength(0);
  });
});

describe('parseFailingFilesLine — pinned against the REAL emitter', () => {
  const emit = (entries: Array<{ workspace: string; file: string }>): string =>
    formatFailingFilesLine({
      runToken: 'r-test',
      entries,
      unattributed: [],
      transformCulprits: [],
      attributionFallbacks: [],
    });

  it('round-trips formatFailingFilesLine output', () => {
    const line = emit([{ workspace: 'foo', file: 'packages/foo/src/a.test.ts' }]);
    expect(parseFailingFilesLine(line)).toEqual([{ workspace: 'foo', file: 'packages/foo/src/a.test.ts' }]);
  });

  it('a PRESENT line with files=[] is [] (red, but unattributed) — an ABSENT line is null (no verdict)', () => {
    expect(parseFailingFilesLine(emit([]))).toEqual([]);
    expect(parseFailingFilesLine('vitest exploded before the summary\n')).toBeNull();
  });

  it('control: a deliberately-wrong parser that reads absence as "no failures" disagrees with the real one', () => {
    // The naive shape this contract exists to forbid: absent line ⇒ [].
    const naive = (text: string): FailingFile[] =>
      parseFailingFilesLine(text) ?? []; // collapses null into []
    const aborted = 'run killed during collection\n';
    expect(naive(aborted)).toEqual([]); // the false green
    expect(parseFailingFilesLine(aborted)).toBeNull(); // the real parser refuses to call it green
  });
});

describe('parseConfirmOutput (deps leg)', () => {
  it('reads status=passed / status=failed from the terminal TEST_FILE_RESULT line', () => {
    expect(parseConfirmOutput('TEST_FILE_RESULT requested=1 matched=1 status=passed durationMs=12\n')).toBe(true);
    expect(parseConfirmOutput('noise\nTEST_FILE_RESULT requested=1 matched=1 status=failed x=1\n')).toBe(false);
  });

  it('matched=0 and an absent line are BOTH undetermined (null), never false', () => {
    expect(parseConfirmOutput('TEST_FILE_ROUTE_ERROR requested=1 matched=0\nTEST_FILE_RESULT requested=1 matched=0 status=failed\n')).toBeNull();
    expect(parseConfirmOutput('vitest never reached its terminal line\n')).toBeNull();
  });
});

// green-main-cycle-time-2026-10-08 P-011. Measured 2026-10-12: the cursor sat on ONE
// window for 24h (0 of ~291 ticks evaluated) because the affected leg ran first, hit
// its 25-minute timeout, and the early return discarded the typecheck verdict; the
// next tick re-ran the identical window into the identical timeout.
describe('runSyncBatchDeltaCheck — P-011 typecheck-first and budget-exhaustion window shrink', () => {
  const C1 = '1'.repeat(40);
  const C2 = '2'.repeat(40);
  const C3 = '3'.repeat(40);
  const C4 = '4'.repeat(40);
  const START = 'f'.repeat(40);
  const TYPE_ERROR_FILE = 'packages/foo/src/c1.ts';
  const fourCommitsNewestFirst = () => [
    makeBatch({ sha: C4, paths: ['packages/foo/src/c4.ts'] }),
    makeBatch({ sha: C3, paths: ['packages/foo/src/c3.ts'] }),
    makeBatch({ sha: C2, paths: ['packages/foo/src/c2.ts'] }),
    makeBatch({ sha: C1, paths: [TYPE_ERROR_FILE] }),
  ];
  const affectedTimeout = {
    ok: false,
    failing: null,
    diagnostic: { outcome: 'timeout' as const, durationMs: 1_501_514, exitCode: null },
  };

  it('files a typecheck red BEFORE the affected leg runs, and keeps it when that leg times out', async () => {
    const calls: string[] = [];
    const { deps, state } = makeDeps(
      {
        headSha: async () => C4,
        listBatches: async () => fourCommitsNewestFirst(),
        runTsc: async () => {
          calls.push('tsc');
          return { ok: false, failing: [TYPE_ERROR_FILE] };
        },
        runAffected: async () => {
          calls.push('affected');
          return affectedTimeout;
        },
        fileRed: async (f) => {
          calls.push(`file:${f.conditionKey}`);
          state.filed.push(f);
          return { ok: true, id: 'WI-1' };
        },
      },
      { sha: START, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);

    const key = conditionKeyForRed(TYPE_ERROR_FILE);
    expect(calls).toEqual(['tsc', `file:${key}`, 'affected']);
    expect(res.filed.map((f) => f.file)).toEqual([TYPE_ERROR_FILE]);
    expect(state.filed.map((f) => f.conditionKey)).toEqual([key]);
    // Not measured ⇒ the cursor is held, but the typecheck red is HELD with it.
    expect(res.status).toBe('skipped');
    expect(state.cursor?.sha).toBe(START);
    expect(state.cursor?.updatedAtMs).toBe(1);
    expect(state.cursor?.openReds?.map((r) => r.path)).toEqual([TYPE_ERROR_FILE]);
    expect(state.cursor?.coverage?.ticks.at(-1)?.evaluated).toBe(false);
  });

  it('halves the window on an affected timeout, so the next tick judges an older, smaller prefix', async () => {
    let affectedPaths: string[] = [];
    let affectedResult: Awaited<ReturnType<SyncBatchDeltaDeps['runAffected']>> = affectedTimeout;
    const { deps, state } = makeDeps(
      {
        headSha: async () => C4,
        listBatches: async () => fourCommitsNewestFirst(),
        runAffected: async (paths) => {
          affectedPaths = [...paths];
          return affectedResult;
        },
      },
      { sha: START, updatedAtMs: 1 },
    );

    const first = await runSyncBatchDeltaCheck(deps);
    expect(first.reason).toBe('affected-tests-budget-exhausted: window halved from 4 to 2 commit(s)');
    expect(first.diagnostic).toBe('outcome=timeout durationMs=1501514 exitCode=unknown');
    expect(affectedPaths).toHaveLength(4);
    expect(state.cursor?.sha).toBe(START);
    expect(state.cursor?.windowCommitCap).toBe(2);

    // Still too slow at 2: halve again to 1.
    const second = await runSyncBatchDeltaCheck(deps);
    expect(affectedPaths).toHaveLength(2);
    expect(new Set(affectedPaths)).toEqual(new Set([TYPE_ERROR_FILE, 'packages/foo/src/c2.ts']));
    expect(second.reason).toBe('affected-tests-budget-exhausted: window halved from 2 to 1 commit(s)');
    expect(state.cursor?.windowCommitCap).toBe(1);

    // The smaller window measures: the cursor ADVANCES past the oldest commit only,
    // and the learned cap grows back (1 -> 2) instead of resetting to the static 40.
    affectedResult = { ok: true, failing: [] };
    const third = await runSyncBatchDeltaCheck(deps);
    expect(third.status).toBe('green');
    expect(affectedPaths).toEqual([TYPE_ERROR_FILE]);
    expect(state.cursor?.sha).toBe(C1);
    expect(state.cursor?.windowCommitCap).toBe(2);
  });

  it('explicitly skips a SINGLE commit that exhausts the affected budget and advances past it', async () => {
    const { deps, state } = makeDeps(
      {
        headSha: async () => C1,
        listBatches: async () => [makeBatch({ sha: C1, paths: [TYPE_ERROR_FILE] })],
        runAffected: async () => affectedTimeout,
      },
      { sha: START, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('leg-timeout');
    expect(res.diagnostic).toBe('outcome=timeout durationMs=1501514 exitCode=unknown');
    expect(state.cursor?.sha).toBe(C1);
    expect(state.cursor?.lastSkipReason).toContain('leg-timeout: commit 111111111111 explicitly skipped');
    expect(state.cursor?.lastSkipReason).toContain('affected-tests leg exhausted its budget on this single commit');
    expect(state.cursor?.windowCommitCap).toBe(1);
    expect(state.cursor?.coverage?.ticks.at(-1)).toMatchObject({ evaluated: false, status: 'leg-timeout' });
  });

  it('a typecheck that exhausts its budget halves the window without spending the affected leg', async () => {
    let affectedRuns = 0;
    const { deps, state } = makeDeps(
      {
        headSha: async () => C4,
        listBatches: async () => fourCommitsNewestFirst(),
        runTsc: async () => ({
          ok: false,
          failing: [],
          diagnostic: { outcome: 'timeout', durationMs: 600_000, exitCode: null },
        }),
        runAffected: async () => {
          affectedRuns += 1;
          return { ok: true, failing: [] };
        },
      },
      { sha: START, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(affectedRuns).toBe(0);
    expect(res.reason).toBe('lint-tsc-budget-exhausted: window halved from 4 to 2 commit(s)');
    expect(state.cursor?.sha).toBe(START);
    expect(state.cursor?.windowCommitCap).toBe(2);
  });

  it('an undetermined affected run that did NOT exhaust its budget holds without shrinking the window', async () => {
    const { deps, state } = makeDeps(
      {
        headSha: async () => C4,
        listBatches: async () => fourCommitsNewestFirst(),
        runAffected: async () => ({
          ok: false,
          failing: null,
          diagnostic: { outcome: 'nonzero-exit', durationMs: 4_000, exitCode: 1 },
        }),
      },
      { sha: START, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.reason).toBe('affected-run-missing-terminal-break-set');
    expect(state.cursor?.sha).toBe(START);
    expect(state.cursor?.windowCommitCap).toBeUndefined();
  });

  // WI-6554700010017999: an unattributable red (exit 1, empty break set) re-ran one
  // package-lock.json window for two days. The streak is bounded per window.
  const undeterminedEmpty: Awaited<ReturnType<SyncBatchDeltaDeps['runAffected']>> = {
    ok: false,
    failing: [],
    diagnostic: { outcome: 'nonzero-exit', durationMs: 103_000, exitCode: 1 },
  };

  it('a window that stays undetermined is halved after UNDETERMINED_STREAK_LIMIT tries, then its single commit is skipped', async () => {
    const affectedSizes: number[] = [];
    const { deps, state } = makeDeps(
      {
        headSha: async () => C4,
        listBatches: async () => fourCommitsNewestFirst(),
        runAffected: async (paths) => {
          affectedSizes.push(paths.length);
          return undeterminedEmpty;
        },
      },
      { sha: START, updatedAtMs: 1 },
    );
    expect(UNDETERMINED_STREAK_LIMIT).toBe(3);

    for (let i = 1; i < UNDETERMINED_STREAK_LIMIT; i++) {
      const held = await runSyncBatchDeltaCheck(deps);
      expect(held.reason).toBe('affected-run-empty-terminal-break-set');
      expect(state.cursor?.sha).toBe(START);
      expect(state.cursor?.undeterminedStreak).toEqual({ windowHead: C4, count: i });
    }
    const halved = await runSyncBatchDeltaCheck(deps);
    expect(halved.reason).toBe('affected-run-undetermined-repeatedly: window halved from 4 to 2 commit(s)');
    expect(state.cursor?.sha).toBe(START);
    expect(state.cursor?.windowCommitCap).toBe(2);
    expect(state.cursor?.undeterminedStreak).toBeUndefined();

    // The smaller windows get their own tries: 2 commits, then 1 commit.
    for (let i = 0; i < UNDETERMINED_STREAK_LIMIT; i++) await runSyncBatchDeltaCheck(deps);
    expect(state.cursor?.windowCommitCap).toBe(1);
    for (let i = 1; i < UNDETERMINED_STREAK_LIMIT; i++) await runSyncBatchDeltaCheck(deps);
    expect(state.cursor?.sha).toBe(START);
    expect(state.cursor?.undeterminedStreak).toEqual({ windowHead: C1, count: UNDETERMINED_STREAK_LIMIT - 1 });

    const skipped = await runSyncBatchDeltaCheck(deps);
    expect(skipped.status).toBe('undetermined');
    expect(state.cursor?.sha).toBe(C1);
    expect(state.cursor?.undeterminedStreak).toBeUndefined();
    expect(state.cursor?.lastSkipReason).toContain('undetermined: commit 111111111111 explicitly skipped');
    expect(state.cursor?.lastSkipReason).toContain('3 times in a row');
    // An explicit skip is not a judged slot.
    expect(state.cursor?.coverage?.ticks.at(-1)).toMatchObject({ evaluated: false, status: 'undetermined' });
    expect(affectedSizes).toEqual([4, 4, 4, 2, 2, 2, 1, 1, 1]);
  });

  it('a measured run on the window clears the undetermined streak instead of carrying it', async () => {
    let affectedResult = undeterminedEmpty;
    const { deps, state } = makeDeps(
      {
        headSha: async () => C1,
        listBatches: async () => [makeBatch({ sha: C1, paths: [TYPE_ERROR_FILE] })],
        runAffected: async () => affectedResult,
      },
      { sha: START, updatedAtMs: 1 },
    );
    await runSyncBatchDeltaCheck(deps);
    expect(state.cursor?.undeterminedStreak).toEqual({ windowHead: C1, count: 1 });
    affectedResult = { ok: true, failing: [] };
    const green = await runSyncBatchDeltaCheck(deps);
    expect(green.status).toBe('green');
    expect(state.cursor?.sha).toBe(C1);
    expect(state.cursor?.undeterminedStreak).toBeUndefined();
  });

  it('a held typecheck red re-runs the typecheck leg and refreshes the same filing', async () => {
    let affectedResult: Awaited<ReturnType<SyncBatchDeltaDeps['runAffected']>> = affectedTimeout;
    const { deps, state } = makeDeps(
      {
        headSha: async () => C4,
        listBatches: async () => fourCommitsNewestFirst(),
        runTsc: async () => ({ ok: false, failing: [TYPE_ERROR_FILE] }),
        runAffected: async () => affectedResult,
        // Re-verification of a held red is undetermined here, so it stays held
        // without a refresh; the point is that the new tsc report is not a NEW filing.
        confirmOne: async () => null,
      },
      { sha: START, updatedAtMs: 1 },
    );
    await runSyncBatchDeltaCheck(deps);
    affectedResult = { ok: true, failing: [] };
    const second = await runSyncBatchDeltaCheck(deps);
    expect(second.status).toBe('red');
    expect(state.filed).toHaveLength(2);
    expect(state.cursor?.openReds?.map((r) => r.path)).toEqual([TYPE_ERROR_FILE]);
  });
});

describe('stale backlog skip-ahead (WI-6554700010018028)', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;
  const ADMISSION_MS = Date.parse('2000-01-01T00:00:00Z');
  const sha = (n: number) => n.toString(16).padStart(40, '0');
  /** The credit (keep) window in minutes: the derived slot-credit deadline (D-031, 135 today).
   *  Fixture ages "outside the window" are W + n, still younger than STALE_BACKLOG_MS. */
  const W = COVERAGE_JUDGE_DEADLINE_MS / MIN;
  /** Newest first, one commit per `ages` entry (minutes before NOW). */
  const backlog = (ages: Array<number | null>): SyncBatch[] =>
    ages.map((age, i) =>
      makeBatch({ sha: sha(i + 1), committedAtMs: age === null ? null : NOW - age * MIN, paths: [`p/${i}.ts`] }),
    );

  it('leaves a backlog younger than STALE_BACKLOG_MS to the normal oldest-first walk', () => {
    expect(planStaleBacklogSkip(backlog([1, 10, 60, 119]), NOW)).toBeNull();
    // D-034: derived from the credit deadline (135 min with the 45-min affected leg) plus 5
    // slot intervals, not a fixed 2 h that the deadline could outgrow. The literal is a tripwire.
    expect(STALE_BACKLOG_MS).toBe(COVERAGE_JUDGE_DEADLINE_MS + 25 * MIN);
    expect(STALE_BACKLOG_MS).toBe(160 * MIN);
    // The fixtures below need room between the keep window and the stale threshold.
    expect(W + 15).toBeLessThan(STALE_BACKLOG_MS / MIN);
  });

  it('keeps the commits inside the credit window and anchors on the newest one outside it', () => {
    const batches = backlog([2, 20, W + 1, W + 15, 60 * 24 * 18]);
    const skip = planStaleBacklogSkip(batches, NOW);
    expect(skip?.remaining.map((b) => b.sha)).toEqual([sha(1), sha(2)]);
    expect(skip?.anchor.sha).toBe(sha(3));
    expect(skip?.skippedCount).toBe(3);
    expect(skip?.oldestMs).toBe(NOW - 60 * 24 * 18 * MIN);
  });

  it('never judges age from an admission commit date or an unparseable time', () => {
    const admission = makeBatch({ sha: sha(9), committedAtMs: ADMISSION_MS });
    // A fresh backlog that merely contains a synthetic 2000-01-01 commit is not stale.
    expect(planStaleBacklogSkip([...backlog([1, 5]), admission], NOW)).toBeNull();
    // Nothing dated at all: nothing proves the backlog stale.
    expect(planStaleBacklogSkip(backlog([null, null]), NOW)).toBeNull();
  });

  it('skips a listing that hit SYNC_DELTA_MAX_LISTED_COMMITS even when no listed commit is 2h old', () => {
    const ages = [1, 2, 3, ...Array.from({ length: SYNC_DELTA_MAX_LISTED_COMMITS - 3 }, () => W + 10)];
    const batches = backlog(ages);
    // By age alone this backlog is fresh: the uncapped planner leaves it to the walk.
    expect(planStaleBacklogSkip(batches, NOW)).toBeNull();
    const skip = planStaleBacklogSkip(batches, NOW, { truncated: true });
    expect(skip?.truncated).toBe(true);
    expect(skip?.remaining.map((b) => b.sha)).toEqual([sha(1), sha(2), sha(3)]);
    expect(skip?.anchor.sha).toBe(sha(4));
    expect(skip?.skippedCount).toBe(SYNC_DELTA_MAX_LISTED_COMMITS - 3);
  });

  it('anchors a capped listing that sits wholly inside the credit window on its oldest listed commit', () => {
    const skip = planStaleBacklogSkip(backlog([1, 2, 3, 4]), NOW, { truncated: true });
    expect(skip?.anchor.sha).toBe(sha(4));
    expect(skip?.remaining.map((b) => b.sha)).toEqual([sha(1), sha(2), sha(3)]);
    expect(skip?.skippedCount).toBe(1);
    // An undated capped listing still re-anchors: its size is the proof.
    expect(planStaleBacklogSkip(backlog([null, null]), NOW, { truncated: true })?.anchor.sha).toBe(sha(1));
  });

  it('re-anchors from a capped listing without running a leg and records the cap in the reason', async () => {
    const ages = Array.from({ length: SYNC_DELTA_MAX_LISTED_COMMITS }, (_, i) => (i < 2 ? i + 1 : W + 10));
    const batches = backlog(ages);
    let affectedRuns = 0;
    const { deps, state } = makeDeps(
      {
        headSha: async () => sha(1),
        listBatches: async () => batches,
        runAffected: async () => {
          affectedRuns += 1;
          return { ok: true, failing: [] };
        },
        now: () => NOW,
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('backlog-skipped');
    expect(affectedRuns).toBe(0);
    expect(state.cursor?.sha).toBe(sha(3));
    expect(state.cursor?.lastSkipReason).toMatch(
      new RegExp(
        `^backlog-skipped: at least ${SYNC_DELTA_MAX_LISTED_COMMITS - 2} commit\\(s\\) through 0{12} skipped unjudged: ` +
          `the listing hit SYNC_DELTA_MAX_LISTED_COMMITS=${SYNC_DELTA_MAX_LISTED_COMMITS}`,
      ),
    );
  });

  it('re-anchors the cursor, resets the learned window state, and records an unjudged slot', async () => {
    const batches = backlog([3, W + 10, 60 * 24 * 18]);
    let affectedRuns = 0;
    const { deps, state } = makeDeps(
      {
        headSha: async () => sha(1),
        listBatches: async () => batches,
        runAffected: async () => {
          affectedRuns += 1;
          return { ok: true, failing: [] };
        },
        now: () => NOW,
      },
      { sha: SHA_A, updatedAtMs: 1, windowCommitCap: 1, undeterminedStreak: { windowHead: sha(3), count: 2 } },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('backlog-skipped');
    expect(res.batchCount).toBe(2);
    expect(affectedRuns).toBe(0);
    expect(state.cursor?.sha).toBe(sha(2));
    expect(state.cursor?.windowCommitCap).toBeUndefined();
    expect(state.cursor?.undeterminedStreak).toBeUndefined();
    expect(state.cursor?.lastSkipReason).toMatch(/^backlog-skipped: 2 commit\(s\) through 0{12} skipped unjudged/);
    const tick = state.cursor?.coverage?.ticks.at(-1);
    expect(tick).toMatchObject({ evaluated: false, status: 'backlog-skipped' });

    // The next tick judges only the kept window from the re-anchored cursor.
    const seenSince: string[] = [];
    deps.listBatches = async (since) => {
      seenSince.push(since);
      return batches.slice(0, 1);
    };
    const next = await runSyncBatchDeltaCheck(deps);
    expect(seenSince).toEqual([sha(2)]);
    expect(next.status).toBe('green');
    expect(affectedRuns).toBe(1);
    expect(state.cursor?.sha).toBe(sha(1));
  });
});

describe('grownWindowCommitCap', () => {
  it('doubles a learned cap after a measured run and drops it once back at the static cap', () => {
    expect(grownWindowCommitCap(undefined, 40)).toBeUndefined();
    expect(grownWindowCommitCap(1, 40)).toBe(2);
    expect(grownWindowCommitCap(16, 40)).toBe(32);
    expect(grownWindowCommitCap(20, 40)).toBeUndefined();
    expect(grownWindowCommitCap(39, 40)).toBeUndefined();
  });
});

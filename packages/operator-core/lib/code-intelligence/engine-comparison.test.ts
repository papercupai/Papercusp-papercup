import { describe, expect, it } from 'vitest';
import {
  DELETE_FIXTURE,
  EDIT_FIXTURE,
  answered,
  runEngineArm,
  summarizeArm,
  type EngineArm,
  type EngineComparisonDeps,
  type EngineQueryResult,
  type PhaseCost,
} from './engine-comparison';
import {
  parseElapsedMs,
  parseLoadAvg1,
  phaseCostFromTimeLogs,
  withPrecomputedIndex,
} from './engine-comparison-precomputed';
import { correctStartLineBase } from './engine-comparison-arms';
import type { CorpusCase } from './acceptance-corpus';
import { SELECTIVE_ACCEPTANCE_CORPUS } from './selective-corpus';

const ROOT = '/t';
const OK: PhaseCost = { wallMs: 5, peakRssKb: 1000, ok: true, error: null, loadAvg1: 1 };

interface World {
  readonly disk: Map<string, string>;
  readonly baseline: Map<string, string>;
  readonly modes: Map<string, number>;
  readonly deps: EngineComparisonDeps;
}

function makeWorld(): World {
  const disk = new Map<string, string>();
  disk.set(`${ROOT}/${EDIT_FIXTURE.file}`, 'a\nb\n');
  disk.set(`${ROOT}/${DELETE_FIXTURE.file}`, 'consumer\n');
  const baseline = new Map(disk);
  const modes = new Map<string, number>();
  let clock = 0;
  const deps: EngineComparisonDeps = {
    now: () => (clock += 3),
    loadAvg1: () => 1,
    readFile: async (p) => {
      const v = disk.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: async (p, c) => void disk.set(p, c),
    rm: async (p) => void disk.delete(p),
    chmod: async (p, m) => void modes.set(p, m),
    gitRestore: async (root, rels) => {
      for (const r of rels) disk.set(`${root}/${r}`, baseline.get(`${root}/${r}`) ?? '');
    },
    treeFingerprint: async () => 'fp-1',
  };
  return { disk, baseline, modes, deps };
}

/**
 * A scripted engine. `live` engines re-read the tree on refresh (so they see edits and
 * deletes); a stale engine snapshots once at index time and never again.
 */
function fakeArm(
  world: World,
  opts: {
    live: boolean;
    surfaceFault?: boolean;
    /** A caveat the engine attaches to EVERY answer (the GitNexus facade does: index health unmeasured). */
    note?: string;
    /** The engine declines every query: no sites, `error` set. */
    declines?: string;
  },
): EngineArm & { refreshes: number } {
  let snapshot = new Map(world.disk);
  const arm = {
    id: opts.live ? 'fake-live' : 'fake-stale',
    version: '0',
    treeRoot: ROOT,
    unavailable: null,
    refreshes: 0,
    async index() {
      snapshot = new Map(world.disk);
      return OK;
    },
    async refresh(): Promise<PhaseCost> {
      arm.refreshes += 1;
      if (opts.surfaceFault && world.modes.get(`${ROOT}/scripts`) === 0) {
        return { ...OK, ok: false, error: 'EACCES scripts' };
      }
      if (opts.live) snapshot = new Map(world.disk);
      return OK;
    },
    async query(kase: CorpusCase): Promise<EngineQueryResult> {
      if (opts.declines) return { sites: [], responseBytes: 10, error: opts.declines };
      const error = opts.note ?? null;
      if (kase.id === 'fixture-edit-new-symbol') {
        const text = snapshot.get(`${ROOT}/${EDIT_FIXTURE.file}`) ?? '';
        const idx = text.split('\n').findIndex((l) => l.includes(`export function ${EDIT_FIXTURE.symbol}`));
        const sites = idx < 0 ? [] : [{ path: EDIT_FIXTURE.file, line1: idx + 1, kind: null, detail: '' }];
        return { sites, responseBytes: 40, error };
      }
      const sites = kase.expectedSites
        .filter((s) => s.path !== DELETE_FIXTURE.file || snapshot.has(`${ROOT}/${s.path}`))
        .map((s) => ({ path: s.path, line1: s.line1, kind: null, detail: '' }));
      return { sites, responseBytes: 100, error };
    },
    async indexBytes() {
      return 123;
    },
  };
  return arm;
}

const OPTS = { warmSamples: 2, cases: SELECTIVE_ACCEPTANCE_CORPUS };

describe('runEngineArm (fake engines)', () => {
  it('scores a live engine fully correct and passes every update fixture', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: true }), OPTS, world.deps);
    expect(report.error).toBeNull();
    expect(report.cases.every((c) => c.correct)).toBe(true);
    expect(report.fixtures.map((f) => [f.name, f.pass])).toEqual([
      ['edit', true],
      ['delete', true],
      ['refresh-failure', true],
    ]);
    // the runner must put the tree back: fixtures never leave edits behind
    expect(world.disk.get(`${ROOT}/${EDIT_FIXTURE.file}`)).toBe('a\nb\n');
    expect(world.disk.has(`${ROOT}/${DELETE_FIXTURE.file}`)).toBe(true);
    expect(world.modes.get(`${ROOT}/scripts`)).toBe(0o755);
    const s = summarizeArm(report);
    expect(s.correct).toBe(s.total);
    expect(s.fixturesPassed).toBe(3);
  });

  it('FAILS the edit and delete fixtures for an engine that never refreshes (stale index)', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: false }), OPTS, world.deps);
    const byName = Object.fromEntries(report.fixtures.map((f) => [f.name, f]));
    expect(byName.edit?.pass).toBe(false);
    expect(byName.delete?.pass).toBe(false);
    expect(byName.delete?.detail).toMatch(/STALE sites still returned/);
  });

  it('records whether a failed refresh was SURFACED, and still restores the tree', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: true, surfaceFault: true }), OPTS, world.deps);
    const refreshFailure = report.fixtures.find((f) => f.name === 'refresh-failure');
    expect(refreshFailure?.faultSurfaced).toBe(true);
    expect(refreshFailure?.recoveryCost?.ok).toBe(true);
  });

  it('turns an unavailable arm into explicit residue instead of a pass or a crash', async () => {
    const world = makeWorld();
    const arm = { ...fakeArm(world, { live: true }), unavailable: 'binary not built' };
    const report = await runEngineArm(arm, OPTS, world.deps);
    expect(report.unavailable).toBe('binary not built');
    expect(report.cases).toEqual([]);
    expect(summarizeArm(report).available).toBe(false);
  });

  it('grades an engine that attaches a caveat note to every answer on its sites, not on the note (WI-10001405)', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: true, note: 'index health UNMEASURED' }), OPTS, world.deps);
    // the same engine graded without the note passes everything (first test) — the note must not flip that
    expect(report.cases.every((c) => c.correct)).toBe(true);
    expect(report.cases.every((c) => c.recall === 1)).toBe(true);
    expect(report.cases.every((c) => c.error === 'index health UNMEASURED')).toBe(true);
    expect(report.fixtures.map((f) => [f.name, f.pass])).toEqual([
      ['edit', true],
      ['delete', true],
      ['refresh-failure', true],
    ]);
    // the note is surfaced in the detail, never dropped
    expect(report.fixtures.find((f) => f.name === 'edit')?.detail).toMatch(/\[engine note: index health UNMEASURED\]/);
  });

  it('a noted answer is still graded on content: a stale engine with a note still FAILS edit and delete', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: false, note: 'index health UNMEASURED' }), OPTS, world.deps);
    const byName = Object.fromEntries(report.fixtures.map((f) => [f.name, f]));
    expect(byName.edit?.pass).toBe(false);
    expect(byName.delete?.pass).toBe(false);
    expect(byName.delete?.detail).toMatch(/STALE sites still returned/);
  });

  it('an engine that DECLINES every query (error and no sites) scores 0 correct, 0 recall and fails the fixtures', async () => {
    const world = makeWorld();
    const report = await runEngineArm(fakeArm(world, { live: true, declines: 'tool call failed' }), OPTS, world.deps);
    expect(report.cases.every((c) => !c.correct && c.recall === 0)).toBe(true);
    const byName = Object.fromEntries(report.fixtures.map((f) => [f.name, f]));
    expect(byName.edit?.pass).toBe(false);
    expect(byName.delete?.pass).toBe(false);
    expect(byName.delete?.detail).toMatch(/query FAILED \(error and no sites\)/);
    expect(byName.delete?.detail).toMatch(/\[engine note: tool call failed\]/);
    // nothing was correct cold, so "stays as correct while a refresh is broken" would hold vacuously (0 >= 0)
    expect(byName['refresh-failure']?.pass).toBe(false);
    expect(byName['refresh-failure']?.detail).toMatch(/NOT MEASURABLE/);
  });

  it('reports a failed cold index as an error and measures nothing after it', async () => {
    const world = makeWorld();
    const arm = { ...fakeArm(world, { live: true }), index: async (): Promise<PhaseCost> => ({ ...OK, ok: false, error: 'boom' }) };
    const report = await runEngineArm(arm, OPTS, world.deps);
    expect(report.error).toMatch(/cold index failed: boom/);
    expect(report.cases).toEqual([]);
  });
});

const TIME_V_OK = [
  '\tCommand being timed: "gitnexus analyze"',
  '\tElapsed (wall clock) time (h:mm:ss or m:ss): 14:49.45',
  '\tMaximum resident set size (kbytes): 8354216',
  '\tExit status: 0',
].join('\n');

describe('precomputed cold-index cost', () => {
  it('parses m:ss.ss and h:mm:ss wall clocks', () => {
    expect(parseElapsedMs(TIME_V_OK)).toBe(889450);
    expect(parseElapsedMs('\tElapsed (wall clock) time (h:mm:ss or m:ss): 1:02:03')).toBe(3723000);
    expect(parseElapsedMs('no timing here')).toBeNull();
  });

  it('reads the load average from uptime output and from a load-before line', () => {
    expect(parseLoadAvg1(' 09:34:57 up 1 day,  load average: 95.64, 132.54, 144.20')).toBe(95.64);
    expect(parseLoadAvg1('load-before: 131.65 124.84 128.63 101/54567 196618')).toBe(131.65);
    expect(parseLoadAvg1('nothing')).toBeNull();
  });

  it('turns a clean log into an ok PhaseCost carrying wall, RSS and load', () => {
    const c = phaseCostFromTimeLogs({ timeV: TIME_V_OK, stdout: '', loadAfter: 'load average: 95.64, 1, 1' });
    expect(c).toEqual({ wallMs: 889450, peakRssKb: 8354216, ok: true, error: null, loadAvg1: 95.64 });
  });

  it('REFUSES (ok:false) a nonzero exit and an unfinished log — never a silent pass', () => {
    const failed = phaseCostFromTimeLogs({ timeV: TIME_V_OK.replace('Exit status: 0', 'Exit status: 137'), stdout: 'killed', loadAfter: null });
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/exit 137/);
    const unfinished = phaseCostFromTimeLogs({ timeV: 'GitNexus Analyzer (1.6.12)\nSkipped 2 large files', stdout: '', loadAfter: null });
    expect(unfinished.ok).toBe(false);
    expect(unfinished.error).toMatch(/no Elapsed\/Exit status/);
  });

  it('withPrecomputedIndex re-uses the measured cost and never re-runs the real index', async () => {
    const world = makeWorld();
    let realIndexCalls = 0;
    const base = fakeArm(world, { live: true });
    const arm = withPrecomputedIndex({ ...base, index: async () => { realIndexCalls += 1; return OK; } }, async () => ({ ...OK, wallMs: 889450 }));
    const cost = await arm.index();
    expect(cost.wallMs).toBe(889450);
    expect(realIndexCalls).toBe(0);
    // refresh/query/indexBytes stay live
    expect(await arm.indexBytes()).toBe(123);
  });
});

describe('correctStartLineBase (GitNexus raw startLine base is per-version)', () => {
  // The facade already added +1 (toOneIndexed('gitnexus')): a 1-based version (1.6.12) arrives one line late.
  const site = (line1: number | null) => ({ path: 'a.ts', line1, kind: null, detail: '' });

  it('base 1 undoes the facade +1 so a 1.6.12 site lands on the grep -n line; null stays null', () => {
    // getLongLivedAdminPool is declared on 1-based line 145: 1.6.12 raw startLine=145 -> facade 146 -> corrected 145.
    expect(correctStartLineBase([site(146), site(null)], 1).map((s) => s.line1)).toEqual([145, null]);
  });

  it('base 0 (1.6.9, the facade assumption) and an unset base are the identity', () => {
    const sites = [site(145), site(null)];
    expect(correctStartLineBase(sites, 0)).toBe(sites);
    expect(correctStartLineBase(sites, undefined)).toBe(sites);
  });

  it('does not mutate its input', () => {
    const sites = [site(146)];
    correctStartLineBase(sites, 1);
    expect(sites[0]!.line1).toBe(146);
  });
});

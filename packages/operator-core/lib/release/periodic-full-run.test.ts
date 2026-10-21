import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PERIODIC_FULL_RUN_ESCALATE_AFTER_MS,
  PERIODIC_FULL_RUN_INTERVAL_MS,
  attributeFailures,
  bisectionPoints,
  failureDelta,
  fullRunArgv,
  fullRunDue,
  fullRunPayload,
  parseMainReflog,
  probeArgv,
  probePayload,
  routeFailure,
  runPeriodicFullRun,
  type FailingFile,
  type FullRunState,
  type PeriodicFullRunDeps,
  type Promotion,
  type RunFilesAt,
} from './periodic-full-run';
import { SOURCE_CHECK_SLICE } from './sync-batch-delta-check';
import { buildPeriodicFullRunDeps, classifyFullSuiteOutput } from './periodic-full-run-deps';

describe('periodic command evidence retention (WI-6554700010018216)', () => {
  it('retains exact inconclusive, measured and probe output privately, with independent references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'periodic-evidence-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const results = [
        { status: 2, stdout: 'private stdout\n', stderr: 'ENOSPC: historical fixture\n' },
        { status: 0, stdout: 'AFFECTED_TESTS_FAILING_FILES run=r1 files=[] unattributed=0\n', stderr: '' },
        { status: 1, stdout: 'private probe output', stderr: 'probe failed' },
        null,
      ];
      let i = 0;
      const deps = buildPeriodicFullRunDeps({ installSlug: 'fixture', workspaceId: 'ws', root: '/fixture',
        releaseRef: 'main', evidenceRoot: root, exec: async () => results[i++] ?? null });
      expect(await deps.runFullSuite('abc')).toEqual({ status: 'inconclusive', reason: 'environment: ENOSPC' });
      expect(await deps.runFullSuite('def')).toEqual({ status: 'measured', failing: [] });
      await deps.runFilesAt('ghi', ['a.test.ts']);
      expect(await deps.runFullSuite('jkl')).toEqual({ status: 'inconclusive', reason: 'spawn-unmeasured' });
      const references = log.mock.calls.map(([line]) => JSON.parse(String(line).split('evidence ')[1]));
      expect(references).toHaveLength(4);
      expect(new Set(references.map(ref => ref.path)).size).toBe(4);
      for (const [index, ref] of references.entries()) {
        const body = await readFile(ref.path, 'utf8');
        expect(JSON.parse(body).result).toEqual(results[index]);
        expect(JSON.parse(body).leg).toBe(index === 2 ? 'probe' : 'full-suite');
        expect(createHash('sha256').update(body).digest('hex')).toBe(ref.sha256);
        expect(Buffer.byteLength(body)).toBe(ref.bytes);
        expect((await stat(ref.path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(ref.path, '..'))).mode & 0o777).toBe(0o700);
      }
      expect(JSON.stringify(log.mock.calls)).not.toContain('private stdout');
      expect(JSON.stringify(log.mock.calls)).not.toContain('private probe output');
    } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it('refuses to execute when evidence storage cannot be prepared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'periodic-evidence-'));
    try {
      const blocked = join(root, 'file');
      await writeFile(blocked, 'not a directory');
      const exec = vi.fn();
      const deps = buildPeriodicFullRunDeps({ installSlug: 'fixture', workspaceId: 'ws', root: '/fixture',
        releaseRef: 'main', evidenceRoot: blocked, exec });
      await expect(deps.runFullSuite('abc')).rejects.toThrow('evidence setup failed');
      expect(exec).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual(['file']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not classify or publish success when the completed command evidence cannot be saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'periodic-evidence-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const deps = buildPeriodicFullRunDeps({ installSlug: 'fixture', workspaceId: 'ws', root: '/fixture',
        releaseRef: 'main', evidenceRoot: root, exec: async () => {
          const [scope] = await readdir(root);
          const [run] = await readdir(join(root, scope));
          // An existing file forces wx to fail, even when tests run as root.
          await writeFile(join(root, scope, run, 'command.json'), 'existing evidence');
          return { status: 0, stdout: 'AFFECTED_TESTS_FAILING_FILES run=r1 files=[] unattributed=0', stderr: '' };
        } });
      await expect(deps.runFullSuite('abc')).rejects.toThrow('evidence retention failed (EEXIST)');
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

describe('classifyFullSuiteOutput: only a terminal break-set line measures a full run', () => {
  const line = 'AFFECTED_TESTS_FAILING_FILES run=r1 files=[{"workspace":"ws","file":"x.test.ts"}] unattributed=0';
  it('reads the failing files from the runner line', () => {
    expect(classifyFullSuiteOutput({ status: 1, stdout: `noise\n${line}\n`, stderr: '' })).toEqual({ status: 'measured', failing: [{ workspace: 'ws', file: 'x.test.ts' }] });
  });
  it('is inconclusive with no terminal line, on ENOSPC, or when the spawn was unmeasured', () => {
    expect(classifyFullSuiteOutput({ status: 1, stdout: 'killed early', stderr: '' })).toMatchObject({ status: 'inconclusive' });
    expect(classifyFullSuiteOutput({ status: 1, stdout: line, stderr: 'ENOSPC: no space left on device' })).toMatchObject({ status: 'inconclusive', reason: 'environment: ENOSPC' });
    expect(classifyFullSuiteOutput(null)).toMatchObject({ status: 'inconclusive', reason: 'spawn-unmeasured' });
  });
});

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const HOUR = 3_600_000;

/** A fixture promotion history: promotion i is sha(i + 1), one hour apart. */
function history(n: number): Promotion[] {
  return Array.from({ length: n }, (_, i) => ({ sha: sha(i + 1), atMs: (i + 1) * HOUR }));
}

/** A fake clean-tree runner over a fixture: `file` fails at points[i] iff i >= breakAt[file].
 *  `flakyAtTip` files pass on re-run at the tip; `undetermined` files never get a verdict. */
function fixtureRunner(points: readonly string[], breakAt: Record<string, number>, opts: { flakyAtTip?: string[]; undetermined?: string[] } = {}) {
  const calls: Array<{ sha: string; files: string[] }> = [];
  const run: RunFilesAt = async (at, files) => {
    calls.push({ sha: at, files: [...files] });
    const i = points.indexOf(at);
    const out = new Map<string, boolean | null>();
    for (const f of files) {
      if (opts.undetermined?.includes(f)) out.set(f, null);
      else if (opts.flakyAtTip?.includes(f) && i === points.length - 1) out.set(f, true);
      else out.set(f, i < breakAt[f]);
    }
    return out;
  };
  return { run, calls };
}

describe('parseMainReflog (P-013 promotion history)', () => {
  it('returns promotions oldest first, one per sha, ignoring malformed lines', () => {
    const text = [`${sha(3)}\t300`, `${sha(2)}\t200`, 'not a reflog line', `${sha(2)}\t150`, `${sha(1)}\t100`, ''].join('\n');
    expect(parseMainReflog(text)).toEqual([
      { sha: sha(1), atMs: 100_000 },
      { sha: sha(2), atMs: 150_000 },
      { sha: sha(3), atMs: 300_000 },
    ]);
  });
});

describe('bisectionPoints', () => {
  it('slices baseline through tip out of the promotion history', () => {
    expect(bisectionPoints(history(6), sha(2), sha(5))).toEqual([sha(2), sha(3), sha(4), sha(5)]);
  });
  it('returns null when the baseline is not in the history (reflog expired or main rewritten)', () => {
    expect(bisectionPoints(history(6), sha(99), sha(5))).toBeNull();
  });
});

describe('failureDelta', () => {
  it('splits fresh, carried and resolved files and drops excluded ones', () => {
    const previous: FailingFile[] = [
      { workspace: 'a', file: 'old.test.ts', cases: ['x'] },
      { workspace: 'a', file: 'grew.test.ts', cases: ['x'] },
      { workspace: 'a', file: 'gone.test.ts' },
    ];
    const current: FailingFile[] = [
      { workspace: 'a', file: 'old.test.ts', cases: ['x'] },
      { workspace: 'a', file: 'grew.test.ts', cases: ['x', 'y'] },
      { workspace: 'a', file: 'new.test.ts', cases: ['z'] },
      { workspace: 'a', file: 'quarantined.test.ts' },
    ];
    const d = failureDelta({ previous, current, isExcluded: (f) => f === 'quarantined.test.ts' });
    expect(d.fresh).toEqual([
      { workspace: 'a', file: 'grew.test.ts', cases: ['y'] },
      { workspace: 'a', file: 'new.test.ts', cases: ['z'] },
    ]);
    expect(d.carried.map((f) => f.file)).toEqual(['old.test.ts']);
    expect(d.resolved).toEqual(['gone.test.ts']);
  });
});

describe('attributeFailures: bisection over promotions since the last full run (R-11)', () => {
  const points = [sha(1), ...history(9).slice(1).map((p) => p.sha)]; // baseline sha(1) + 8 promotions

  it('attributes each new failure to the single promotion that introduced it', async () => {
    const breakAt = { 'a.test.ts': 5, 'b.test.ts': 2, 'c.test.ts': 8 };
    const { run } = fixtureRunner(points, breakAt);
    const { attributions } = await attributeFailures({ files: Object.keys(breakAt), points, runFilesAt: run });
    expect(attributions).toEqual([
      expect.objectContaining({ file: 'a.test.ts', kind: 'attributed', culprit: points[5], previous: points[4] }),
      expect.objectContaining({ file: 'b.test.ts', kind: 'attributed', culprit: points[2], previous: points[1] }),
      expect.objectContaining({ file: 'c.test.ts', kind: 'attributed', culprit: points[8], previous: points[7] }),
    ]);
  });

  it('every attribution passes the blame check: green on the promotion before, red on the culprit', async () => {
    for (let at = 1; at < points.length; at += 1) {
      const { run, calls } = fixtureRunner(points, { 'f.test.ts': at });
      const { attributions } = await attributeFailures({ files: ['f.test.ts'], points, runFilesAt: run });
      const a = attributions[0];
      expect(a.kind).toBe('attributed');
      if (a.kind !== 'attributed') continue;
      expect(points.indexOf(a.culprit) - points.indexOf(a.previous)).toBe(1);
      expect(points.indexOf(a.culprit)).toBe(at);
      // Probe count stays logarithmic: tip + baseline confirm, then ceil(log2(8)) = 3.
      expect(a.probes).toBeLessThanOrEqual(2 + 3);
      expect(calls[0].sha).toBe(points[points.length - 1]);
      expect(calls[1].sha).toBe(points[0]);
    }
  });

  it('groups probes by sha, so several failures share one clean-tree run per point', async () => {
    const breakAt = { 'a.test.ts': 5, 'b.test.ts': 6, 'c.test.ts': 7 };
    const { run, calls } = fixtureRunner(points, breakAt);
    const { probeRuns, attributions } = await attributeFailures({ files: Object.keys(breakAt), points, runFilesAt: run });
    const totalProbes = attributions.reduce((n, a) => n + a.probes, 0);
    expect(probeRuns).toBe(calls.length);
    expect(probeRuns).toBeLessThan(totalProbes);
    expect(calls[0].files.sort()).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts']);
  });

  it('a file that passes when re-run at the tip is a flip, not a culprit', async () => {
    const { run } = fixtureRunner(points, { 'f.test.ts': 3 }, { flakyAtTip: ['f.test.ts'] });
    const { attributions } = await attributeFailures({ files: ['f.test.ts'], points, runFilesAt: run });
    expect(attributions[0]).toMatchObject({ kind: 'unattributable', reason: 'flaky-at-tip', probes: 1 });
  });

  it('a file that also fails at the baseline has no promotion to blame', async () => {
    const { run } = fixtureRunner(points, { 'f.test.ts': 0 });
    const { attributions } = await attributeFailures({ files: ['f.test.ts'], points, runFilesAt: run });
    expect(attributions[0]).toMatchObject({ kind: 'unattributable', reason: 'fails-at-baseline', probes: 2 });
  });

  it('an undetermined probe (no verdict line, matched=0) stays unattributable, never a pass or fail', async () => {
    const { run } = fixtureRunner(points, { 'f.test.ts': 4 }, { undetermined: ['f.test.ts'] });
    const { attributions } = await attributeFailures({ files: ['f.test.ts'], points, runFilesAt: run });
    expect(attributions[0]).toMatchObject({ kind: 'unattributable', reason: 'probe-undetermined' });
  });

  it('reports no-baseline when the history cannot be bisected, and fails-at-baseline when main has not moved', async () => {
    const { run, calls } = fixtureRunner(points, { 'f.test.ts': 4 });
    expect((await attributeFailures({ files: ['f.test.ts'], points: null, runFilesAt: run })).attributions[0]).toMatchObject({ reason: 'no-baseline' });
    expect((await attributeFailures({ files: ['f.test.ts'], points: [sha(1)], runFilesAt: run })).attributions[0]).toMatchObject({ reason: 'fails-at-baseline' });
    expect(calls).toHaveLength(0);
  });

  it('bounds bisection cost: an exhausted budget is reported, never guessed', async () => {
    const long = [sha(1), ...history(33).slice(1).map((p) => p.sha)];
    const { run, calls } = fixtureRunner(long, { 'f.test.ts': 17 });
    const { attributions, probeRuns } = await attributeFailures({ files: ['f.test.ts'], points: long, runFilesAt: run, maxProbeRuns: 3 });
    expect(probeRuns).toBe(3);
    expect(calls).toHaveLength(3);
    expect(attributions[0]).toMatchObject({ kind: 'unattributable', reason: 'budget-exhausted' });
  });
});

describe('routeFailure: fix, then eject, then downgrade (D-002)', () => {
  const attributed = { file: 'f.test.ts', kind: 'attributed' as const, culprit: sha(5), previous: sha(4), probes: 5 };
  const unattributable = { file: 'f.test.ts', kind: 'unattributable' as const, reason: 'fails-at-baseline' as const, probes: 2 };
  const t0 = 1_000 * HOUR;
  const later = t0 + PERIODIC_FULL_RUN_ESCALATE_AFTER_MS;

  it('routes a fresh attributed failure to fix, naming the culprit promotion', () => {
    expect(routeFailure({ attribution: attributed, prior: null, nowMs: t0 })).toMatchObject({ route: 'fix', culprit: sha(5), sinceMs: t0, escalated: false });
  });
  it('escalates an unresolved fix to eject, then an unresolved eject to downgrade', () => {
    const eject = routeFailure({ attribution: attributed, prior: { route: 'fix', sinceMs: t0, culprit: sha(5) }, nowMs: later });
    expect(eject).toMatchObject({ route: 'eject', culprit: sha(5), escalated: true });
    const downgrade = routeFailure({ attribution: attributed, prior: { route: 'eject', sinceMs: later, culprit: sha(5) }, nowMs: later + PERIODIC_FULL_RUN_ESCALATE_AFTER_MS });
    expect(downgrade).toMatchObject({ route: 'downgrade', escalated: true });
  });
  it('keeps the route while it is younger than the escalation window', () => {
    expect(routeFailure({ attribution: attributed, prior: { route: 'fix', sinceMs: t0, culprit: sha(5) }, nowMs: later - 1 })).toMatchObject({ route: 'fix', escalated: false });
  });
  it('never ejects an unattributable failure: fix, then downgrade', () => {
    expect(routeFailure({ attribution: unattributable, prior: null, nowMs: t0 })).toMatchObject({ route: 'fix', culprit: null });
    expect(routeFailure({ attribution: unattributable, prior: { route: 'fix', sinceMs: t0, culprit: null }, nowMs: later })).toMatchObject({ route: 'downgrade', escalated: true });
  });
  it('routes a verdict flip straight to the flaky quarantine', () => {
    const flaky = { file: 'f.test.ts', kind: 'unattributable' as const, reason: 'flaky-at-tip' as const, probes: 1 };
    expect(routeFailure({ attribution: flaky, prior: null, nowMs: t0 })).toMatchObject({ route: 'downgrade' });
  });
});

describe('cadence and reserved capacity (R-11 falsifier 3)', () => {
  it('is due with no prior run and again once the interval has passed', () => {
    expect(fullRunDue({ lastFullRunAtMs: null, nowMs: 0 })).toBe(true);
    expect(fullRunDue({ lastFullRunAtMs: 0, nowMs: PERIODIC_FULL_RUN_INTERVAL_MS - 1 })).toBe(false);
    expect(fullRunDue({ lastFullRunAtMs: 0, nowMs: PERIODIC_FULL_RUN_INTERVAL_MS })).toBe(true);
  });
  it('runs the whole suite and every probe inside the reserved source-checks slice', () => {
    for (const argv of [fullRunArgv(sha(7)), probeArgv(sha(7), 'x.test.ts')]) {
      expect(argv.cmd).toBe('systemd-run');
      expect(argv.args).toContain(`--slice=${SOURCE_CHECK_SLICE}`);
      expect(argv.args).toContain(`--ref=${sha(7)}`);
    }
    expect(fullRunArgv(sha(7)).args).toContain('test:all');
    expect(probeArgv(sha(7), 'x.test.ts').args.slice(-2)).toEqual(['--', 'x.test.ts']);
  });
});

describe('payloads are accepted by lint-as-committed (WI-6554700010018216)', () => {
  // The first live fire (2026-10-20 17:55Z) was inconclusive: lint-as-committed refused
  // 'test:all' as a non-lint script with exit 2, because the payload had no --any. Parse the
  // payloads with the runner's OWN parser so a change on either side fails here, not live.
  // npm hands the script everything after the first '--' (npm's own separator).
  const scriptArgv = (args: string[]) => args.slice(args.indexOf('--') + 1);
  async function parse(args: string[]) {
    // @ts-expect-error TS7016 — plain-JS script with no .d.mts; the cast names the one export used.
    const mod = (await import('../../../../scripts/lint-as-committed.mjs')) as {
      parseArgs: (argv: string[]) => { scripts: string[]; forward: string[]; ref: string; any: boolean; unknown: string[]; nonLint: string[] };
    };
    return mod.parseArgs(scriptArgv(args));
  }
  it('runs test:all at the sha without a non-lint refusal or unknown flag', async () => {
    const p = await parse(fullRunPayload(sha(7)).args);
    expect(p).toMatchObject({ scripts: ['test:all'], ref: sha(7), any: true, nonLint: [], unknown: [], forward: [] });
  });
  it('runs test:file at the sha on exactly the one forwarded file', async () => {
    const p = await parse(probePayload(sha(7), 'x.test.ts').args);
    expect(p).toMatchObject({ scripts: ['test:file'], ref: sha(7), any: true, nonLint: [], unknown: [], forward: ['x.test.ts'] });
  });
});

describe('runPeriodicFullRun (orchestration with fakes)', () => {
  function harness(opts: { state: FullRunState; tip: string; failing: FailingFile[] | null; promotions: Promotion[]; breakAt?: Record<string, number>; excluded?: string[]; now?: number }) {
    let state = opts.state;
    const filed: Array<{ file: string; route: string; culprit: string | null }> = [];
    const pts = bisectionPoints(opts.promotions, opts.state.lastFullRun?.sha ?? '', opts.tip) ?? [];
    const runner = fixtureRunner(pts, opts.breakAt ?? {});
    const deps: PeriodicFullRunDeps = {
      now: () => opts.now ?? 100 * HOUR,
      readState: async () => state,
      writeState: async (s) => {
        state = s;
      },
      mainSha: async () => opts.tip,
      promotions: async () => opts.promotions,
      runFullSuite: async () => (opts.failing ? { status: 'measured', failing: opts.failing } : { status: 'inconclusive', reason: 'ENOSPC-dominated' }),
      runFilesAt: runner.run,
      isExcluded: async (f) => opts.excluded?.includes(f) ?? false,
      fileRoute: async ({ file, route }) => {
        filed.push({ file, route: route.route, culprit: route.culprit });
        return `WI-${file}`;
      },
      log: () => {},
    };
    return { deps, filed, state: () => state, calls: runner.calls };
  }

  it('does nothing before the cadence interval has passed', async () => {
    const h = harness({ state: { lastFullRun: { sha: sha(1), atMs: 99 * HOUR, failing: [] }, routes: {} }, tip: sha(3), failing: [], promotions: history(3) });
    expect(await runPeriodicFullRun(h.deps)).toEqual({ status: 'not-due' });
  });

  it('records the first full run as the baseline without attributing the backlog', async () => {
    const h = harness({ state: { lastFullRun: null, routes: {} }, tip: sha(3), failing: [{ workspace: 'a', file: 'old.test.ts' }], promotions: history(3) });
    expect(await runPeriodicFullRun(h.deps)).toMatchObject({ status: 'baseline-recorded', failing: 1 });
    expect(h.state().lastFullRun?.sha).toBe(sha(3));
    expect(h.filed).toHaveLength(0);
  });

  it('does not move the baseline on an inconclusive run (like with like)', async () => {
    const before: FullRunState = { lastFullRun: { sha: sha(1), atMs: 0, failing: [] }, routes: {} };
    const h = harness({ state: before, tip: sha(5), failing: null, promotions: history(5) });
    expect(await runPeriodicFullRun(h.deps)).toMatchObject({ status: 'inconclusive' });
    expect(h.state()).toBe(before);
  });

  it('attributes a new failure to its promotion, files a fix route and moves the baseline', async () => {
    const h = harness({
      state: { lastFullRun: { sha: sha(1), atMs: 0, failing: [] }, routes: {} },
      tip: sha(9),
      failing: [{ workspace: 'a', file: 'new.test.ts' }, { workspace: 'a', file: 'quarantined.test.ts' }],
      promotions: history(9),
      breakAt: { 'new.test.ts': 6 },
      excluded: ['quarantined.test.ts'],
    });
    const report = await runPeriodicFullRun(h.deps);
    expect(report).toMatchObject({ status: 'judged', sha: sha(9), baseline: sha(1), fresh: 1 });
    expect(h.filed).toEqual([{ file: 'new.test.ts', route: 'fix', culprit: sha(7) }]);
    expect(h.state().lastFullRun?.sha).toBe(sha(9));
    expect(h.state().routes['new.test.ts']).toMatchObject({ route: 'fix', culprit: sha(7), itemId: 'WI-new.test.ts' });
    expect(h.calls.every((c) => !c.files.includes('quarantined.test.ts'))).toBe(true);
  });

  it('escalates a carried failure past the window to eject, and drops resolved routes', async () => {
    const now = 100 * HOUR + PERIODIC_FULL_RUN_ESCALATE_AFTER_MS;
    const h = harness({
      state: {
        lastFullRun: { sha: sha(3), atMs: 0, failing: [{ workspace: 'a', file: 'stuck.test.ts' }, { workspace: 'a', file: 'fixed.test.ts' }] },
        routes: {
          'stuck.test.ts': { route: 'fix', sinceMs: 100 * HOUR, culprit: sha(2), itemId: 'WI-1' },
          'fixed.test.ts': { route: 'fix', sinceMs: 100 * HOUR, culprit: sha(2), itemId: 'WI-2' },
        },
      },
      tip: sha(5),
      failing: [{ workspace: 'a', file: 'stuck.test.ts' }],
      promotions: history(5),
      now,
    });
    const report = await runPeriodicFullRun(h.deps);
    expect(report).toMatchObject({ status: 'judged', carried: 1, resolved: 1, fresh: 0 });
    expect(h.filed).toEqual([{ file: 'stuck.test.ts', route: 'eject', culprit: sha(2) }]);
    expect(Object.keys(h.state().routes)).toEqual(['stuck.test.ts']);
  });
});

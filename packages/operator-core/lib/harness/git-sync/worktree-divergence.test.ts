import { describe, expect, it } from 'vitest';
import {
  DIVERGENCE_REFRESH_MS,
  applyResolverRuntimeProbe,
  describeDivergenceTransition,
  describeResolverRuntimeChange,
  divergenceAwaitsResolver,
  divergenceResolverDispatch,
  nextWorktreeDivergence,
  parseWorktreeDivergence,
  resolverFailureDetail,
  type WorktreeDivergence,
} from './worktree-divergence';

// WI-10006476 / plan agent-capacity-and-cost-gcp-2026-09-30 D-055. S6 (P-525) ran
// 55+ min with a joiner and the tower forked on a content conflict and nothing
// recorded it. These pin the rules that make that fork a visible, persisted state.

const T0 = 1_791_000_000_000;
const L1 = 'a'.repeat(40);
const L2 = 'b'.repeat(40);
const H1 = 'c'.repeat(40);
const H2 = 'd'.repeat(40);

const conflict = (paths: string[], localHead = L1, hiveSha = H1) =>
  ({ kind: 'diverged', localHead, hiveSha, paths }) as const;

const prior = (over: Partial<WorktreeDivergence> = {}): WorktreeDivergence => ({
  since: T0,
  lastSeenAt: T0,
  localHead: L1,
  hiveSha: H1,
  paths: ['soak-heartbeat.txt'],
  ...over,
});

describe('nextWorktreeDivergence (D-055)', () => {
  it('a conflicting divergence with no prior state STARTS: persisted, logged, paths sorted', () => {
    const t = nextWorktreeDivergence(null, conflict(['z.txt', 'a.txt']), T0);
    expect(t).toEqual({
      next: { since: T0, lastSeenAt: T0, localHead: L1, hiveSha: H1, paths: ['a.txt', 'z.txt'] },
      log: 'started',
      write: true,
    });
  });

  it('a CLEAN divergence is not recorded (the integrator merges it itself)', () => {
    expect(nextWorktreeDivergence(null, conflict([]), T0)).toEqual({ next: null, log: null, write: false });
  });

  it('a clean divergence or containment CLEARS a recorded conflict', () => {
    expect(nextWorktreeDivergence(prior(), conflict([]), T0 + 1)).toEqual({ next: null, log: 'cleared', write: true });
    expect(nextWorktreeDivergence(prior(), { kind: 'contained' }, T0 + 1)).toEqual({
      next: null,
      log: 'cleared',
      write: true,
    });
  });

  it('steady containment is free: no write, no log', () => {
    expect(nextWorktreeDivergence(null, { kind: 'contained' }, T0)).toEqual({ next: null, log: null, write: false });
  });

  it('an unknown tick or a failed probe keeps the prior state untouched (never clears on no evidence)', () => {
    const p = prior();
    expect(nextWorktreeDivergence(p, { kind: 'unknown' }, T0 + 99)).toEqual({ next: p, log: null, write: false });
    expect(nextWorktreeDivergence(p, conflict(null as unknown as string[]), T0 + 99)).toEqual({
      next: p,
      log: null,
      write: false,
    });
  });

  it('a persisting conflict keeps `since` while both heads move, and writes without re-logging', () => {
    const t = nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt'], L2, H2), T0 + 60_000);
    expect(t.log).toBeNull();
    expect(t.write).toBe(true);
    expect(t.next).toEqual({ since: T0, lastSeenAt: T0 + 60_000, localHead: L2, hiveSha: H2, paths: ['soak-heartbeat.txt'] });
  });

  it('a changed conflicting path set is logged again', () => {
    const t = nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt', 'b.txt']), T0 + 1);
    expect(t.log).toBe('paths-changed');
    expect(t.next?.since).toBe(T0);
  });

  it('identical observations write only once per refresh window', () => {
    expect(nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt']), T0 + 1).write).toBe(false);
    const late = nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt']), T0 + DIVERGENCE_REFRESH_MS);
    expect(late.write).toBe(true);
    expect(late.next?.lastSeenAt).toBe(T0 + DIVERGENCE_REFRESH_MS);
  });
});

// WI-10006507 / D-055 step 2: a recorded conflict is handed to the merge-resolver once per
// conflicting path set, with the hive head (not the push remote) as the side to merge.
describe('divergenceResolverDispatch (D-055 step 2)', () => {
  it('a recorded, undispatched conflict dispatches a superproject merge of the hive head sha', () => {
    expect(divergenceResolverDispatch(prior({ paths: ['a.txt', 'b.txt'], hiveSha: H2 }))).toEqual({
      conflicts: [{ scope: 'superproject', conflictedFiles: ['a.txt', 'b.txt'] }],
      mergeRef: H2,
    });
  });

  it('nothing to dispatch with no divergence, or once the resolver was dispatched for it', () => {
    expect(divergenceResolverDispatch(null)).toBeNull();
    expect(divergenceResolverDispatch(prior({ resolverDispatchedAt: T0 + 5 }))).toBeNull();
  });

  it('the dispatch mark survives a persisting conflict (heads moving, refresh writes): one dispatch per conflict', () => {
    const marked = prior({ resolverDispatchedAt: T0 + 5 });
    const moved = nextWorktreeDivergence(marked, conflict(['soak-heartbeat.txt'], L2, H2), T0 + 10);
    expect(moved.write).toBe(true);
    expect(moved.next?.resolverDispatchedAt).toBe(T0 + 5);
    expect(divergenceResolverDispatch(moved.next)).toBeNull();
    const refreshed = nextWorktreeDivergence(marked, conflict(['soak-heartbeat.txt']), T0 + DIVERGENCE_REFRESH_MS);
    expect(refreshed.next?.resolverDispatchedAt).toBe(T0 + 5);
  });

  it('a changed conflicting path set drops the mark, so the new conflict is dispatched again', () => {
    const t = nextWorktreeDivergence(prior({ resolverDispatchedAt: T0 + 5 }), conflict(['x.txt']), T0 + 10);
    expect(t.log).toBe('paths-changed');
    expect(t.next?.resolverDispatchedAt).toBeUndefined();
    expect(divergenceResolverDispatch(t.next)?.conflicts[0].conflictedFiles).toEqual(['x.txt']);
  });

  it('a cleared divergence has nothing to dispatch', () => {
    const t = nextWorktreeDivergence(prior({ resolverDispatchedAt: T0 + 5 }), { kind: 'contained' }, T0 + 10);
    expect(t.next).toBeNull();
    expect(divergenceResolverDispatch(t.next)).toBeNull();
  });
});

describe('parseWorktreeDivergence', () => {
  it('round-trips a persisted value and rejects malformed or empty-path rows', () => {
    expect(parseWorktreeDivergence(JSON.parse(JSON.stringify(prior())))).toEqual(prior());
    const marked = prior({ resolverDispatchedAt: T0 + 5 });
    expect(parseWorktreeDivergence(JSON.parse(JSON.stringify(marked)))).toEqual(marked);
    expect(parseWorktreeDivergence({ ...marked, resolverDispatchedAt: 'soon' })).toEqual(prior());
    expect(parseWorktreeDivergence(null)).toBeNull();
    expect(parseWorktreeDivergence({ ...prior(), paths: [] })).toBeNull();
    expect(parseWorktreeDivergence({ ...prior(), since: 'yesterday' })).toBeNull();
  });
});

describe('describeDivergenceTransition', () => {
  it('names the slug, both heads, the paths and the decision; silent when nothing is logged', () => {
    const t = nextWorktreeDivergence(null, conflict(['soak-heartbeat.txt']), T0);
    const line = describeDivergenceTransition('hello-world-3-pot', null, t, T0) ?? '';
    expect(line).toContain('hello-world-3-pot');
    expect(line).toContain('DIVERGED');
    expect(line).toContain(H1.slice(0, 12));
    expect(line).toContain(L1.slice(0, 12));
    expect(line).toContain('soak-heartbeat.txt');
    expect(line).toContain('D-055');
    expect(describeDivergenceTransition('s', null, { next: null, log: null, write: false }, T0)).toBeNull();
  });

  it('a cleared divergence reports how long the fork lasted', () => {
    const p = prior();
    const t = nextWorktreeDivergence(p, { kind: 'contained' }, T0 + 55 * 60_000);
    expect(describeDivergenceTransition('s', p, t, T0 + 55 * 60_000)).toContain('CLEARED after ~55m');
  });
});

// WI-10006833: on c1010k (a GCP joiner with no agent CLI) D-055 step 2 dispatched the
// merge-resolver, which died `spawn claude ENOENT` (rc 127, empty stderr) each time, and
// nothing recorded why. These pin the preflight that withholds such a dispatch.
describe('WI-10006833: resolver runtime preflight', () => {
  const pending = (): WorktreeDivergence => ({
    since: T0,
    lastSeenAt: T0,
    localHead: L1,
    hiveSha: H1,
    paths: ['d055-conflict.txt'],
  });

  it('a missing runtime is recorded and withholds the dispatch', () => {
    const { next, change } = applyResolverRuntimeProbe(pending(), { ok: false, runtime: 'claude' }, T0 + 1);
    expect(change).toBe('unavailable');
    expect(next.resolverUnavailable).toEqual({ runtime: 'claude', reason: 'runtime-missing', since: T0 + 1 });
    expect(divergenceResolverDispatch(next)).toBeNull();
    expect(describeResolverRuntimeChange('s', next, change)).toContain("would exec 'claude'");
  });

  it('a runtime that stays missing is not rewritten, so since keeps its age', () => {
    const first = applyResolverRuntimeProbe(pending(), { ok: false, runtime: 'claude' }, T0 + 1).next;
    const again = applyResolverRuntimeProbe(first, { ok: false, runtime: 'claude' }, T0 + 99);
    expect(again.change).toBeNull();
    expect(again.next).toBe(first);
  });

  it('a runtime that appears re-enables the dispatch on the same tick', () => {
    const missing = applyResolverRuntimeProbe(pending(), { ok: false, runtime: 'claude' }, T0 + 1).next;
    const { next, change } = applyResolverRuntimeProbe(missing, { ok: true }, T0 + 2);
    expect(change).toBe('available');
    expect(next.resolverUnavailable).toBeUndefined();
    expect(divergenceResolverDispatch(next)).toEqual({
      conflicts: [{ scope: 'superproject', conflictedFiles: ['d055-conflict.txt'] }],
      mergeRef: H1,
    });
  });

  it('a present runtime on a clean record changes nothing', () => {
    const d = pending();
    expect(applyResolverRuntimeProbe(d, { ok: true }, T0 + 1)).toEqual({ next: d, change: null });
  });

  it('the unavailability is carried across a path-set change and survives a round-trip parse', () => {
    const missing = applyResolverRuntimeProbe(pending(), { ok: false, runtime: 'claude' }, T0 + 1).next;
    const t = nextWorktreeDivergence(
      missing,
      { kind: 'diverged', localHead: L2, hiveSha: H2, paths: ['other.txt'] },
      T0 + 5,
    );
    expect(t.log).toBe('paths-changed');
    expect(t.next?.resolverUnavailable?.runtime).toBe('claude');
    expect(parseWorktreeDivergence(JSON.parse(JSON.stringify(t.next)))?.resolverUnavailable?.since).toBe(T0 + 1);
  });

  it('only a conflict still awaiting its dispatch is worth probing', () => {
    expect(divergenceAwaitsResolver(pending())).toBe(true);
    expect(divergenceAwaitsResolver({ ...pending(), resolverDispatchedAt: T0 })).toBe(false);
    expect(divergenceAwaitsResolver(null)).toBe(false);
  });
});

describe('WI-10006833: resolverFailureDetail keeps the cause of a resolver that never started', () => {
  it('falls back to the stdout tail and names the missing runtime (c1010k shape)', () => {
    const r = resolverFailureDetail({
      decisionLine: '',
      stderr: '',
      rawStdoutTail: '[invoke-once] prompt budget ok\nspawn error: spawn claude ENOENT\n',
    });
    expect(r.detail).toContain('spawn claude ENOENT');
    expect(r.unavailable).toEqual({ runtime: 'claude', reason: 'runtime-missing' });
  });

  it('prefers the decision line and reports no runtime problem for an ordinary failure', () => {
    const r = resolverFailureDetail({ decisionLine: 'gave up: unresolvable', stderr: 'x', rawStdoutTail: 'y' });
    expect(r).toEqual({ detail: 'gave up: unresolvable' });
  });
});

import { describe, expect, it } from 'vitest';
import { GATE_LIVENESS_REESCALATE_MS, type GateLivenessEvent } from './gate-liveness-sentinel';
import {
  readGateLivenessSnapshot,
  runGateLivenessSentinelTick,
  type GateLivenessNotification,
  type GateLivenessSentinelDeps,
  type GateLivenessSentinelState,
  type GateLivenessSnapshot,
} from './gate-liveness-sentinel-run';

const T0 = Date.parse('2026-10-12T16:00:00Z');
const MIN = 60_000;

function harness(opts: { snapshot: GateLivenessSnapshot | (() => GateLivenessSnapshot); ownerUp?: boolean; desktopUp?: boolean }) {
  let now = T0;
  let state: GateLivenessSentinelState | null = null;
  const alerts: string[] = [];
  const owner: GateLivenessNotification[] = [];
  const desktop: GateLivenessNotification[] = [];
  const logs: string[] = [];
  const io = { ownerUp: opts.ownerUp ?? true, desktopUp: opts.desktopUp ?? true };
  const deps: GateLivenessSentinelDeps = {
    installSlug: 'papercusp',
    nowMs: () => now,
    readSnapshot: async () => (typeof opts.snapshot === 'function' ? opts.snapshot() : opts.snapshot),
    loadState: async () => state,
    saveState: async (s) => { state = { ...s }; },
    recordAlert: async (d) => { alerts.push(d.episodeKey!); },
    notifyOwner: async (n) => { if (!io.ownerUp) return false; owner.push(n); return true; },
    notifyDesktop: async (n) => { if (!io.desktopUp) return false; desktop.push(n); return true; },
    log: (l) => logs.push(l),
  };
  return {
    deps, alerts, owner, desktop, logs, io,
    advance: (ms: number) => { now += ms; },
    state: () => state,
  };
}

// The 10-03..10-05 outage: main red, the last gate activity 3h ago, nothing since.
const stalled: GateLivenessSnapshot = { mainRed: true, events: [{ kind: 'fire', atMs: T0 - 180 * MIN }] };

describe('runGateLivenessSentinelTick — P-023 out-of-operator alarm', () => {
  it('a breach records one alert row and notifies the owner once per episode', async () => {
    const h = harness({ snapshot: stalled });
    const r = await runGateLivenessSentinelTick(h.deps);
    expect(r.decision?.state).toBe('no-runs');
    expect(r.alertRecorded && r.ownerNotified).toBe(true);
    expect(h.owner[0].title).toMatch(/Gate stalled/);
    h.advance(10 * MIN);
    await runGateLivenessSentinelTick(h.deps);
    expect(h.alerts).toHaveLength(1);
    expect(h.owner).toHaveLength(1);
    expect(h.logs.filter((l) => l.includes('state=no-runs'))).toHaveLength(2);
  });

  it('an undelivered owner notification is retried every tick, with the desktop as fallback', async () => {
    const h = harness({ snapshot: stalled, ownerUp: false });
    const first = await runGateLivenessSentinelTick(h.deps);
    expect(first.ownerNotified).toBe(false);
    expect(first.desktopNotified).toBe(true);
    h.advance(10 * MIN);
    await runGateLivenessSentinelTick(h.deps);
    // Desktop is rate-limited to the re-escalation cadence while the owner path is down.
    expect(h.desktop).toHaveLength(1);
    h.io.ownerUp = true;
    h.advance(10 * MIN);
    const third = await runGateLivenessSentinelTick(h.deps);
    expect(third.ownerNotified).toBe(true);
    expect(h.owner).toHaveLength(1);
    expect(h.state()?.deliveredAtMs).toBe(T0 + 20 * MIN);
  });

  it('a delivered episode re-escalates on the cadence with a fresh dedupe key', async () => {
    const h = harness({ snapshot: stalled });
    await runGateLivenessSentinelTick(h.deps);
    h.advance(GATE_LIVENESS_REESCALATE_MS);
    await runGateLivenessSentinelTick(h.deps);
    expect(h.owner).toHaveLength(2);
    expect(h.owner[1].dedupeKey).not.toBe(h.owner[0].dedupeKey);
  });

  it('recovery clears the episode; unknown does not', async () => {
    let snap: GateLivenessSnapshot = stalled;
    const h = harness({ snapshot: () => snap });
    await runGateLivenessSentinelTick(h.deps);
    snap = { mainRed: null, events: [] };
    await runGateLivenessSentinelTick(h.deps);
    expect(h.state()?.episodeKey).not.toBeNull();
    const fresh: GateLivenessEvent[] = [{ kind: 'fire', atMs: T0 - 5 * MIN }];
    snap = { mainRed: true, events: fresh };
    await runGateLivenessSentinelTick(h.deps);
    expect(h.state()).toEqual({ episodeKey: null, deliveredAtMs: null, alertedEpisodeKey: null, desktopNotifiedAtMs: null });
    expect(h.logs.some((l) => l.includes('recovered'))).toBe(true);
  });

  it('a crash loop escalates with its own title', async () => {
    const events: GateLivenessEvent[] = [
      { kind: 'ending', atMs: T0 - 300 * MIN, ending: 'verdict' },
      { kind: 'ending', atMs: T0 - 90 * MIN, ending: 'conflict' },
      { kind: 'ending', atMs: T0 - 30 * MIN, ending: 'conflict' },
    ];
    const h = harness({ snapshot: { mainRed: true, events } });
    const r = await runGateLivenessSentinelTick(h.deps);
    expect(r.decision?.state).toBe('crash-loop');
    expect(h.owner[0].title).toMatch(/crash loop/);
  });

  it('reads fires, classified endings and main state from the ledger rows', async () => {
    const results: unknown[][] = [
      [
        { kind: 'green_checkpoint_fire', status: 'fired', detail: {}, created_at: new Date(T0 - 30 * MIN) },
        { kind: 'green_checkpoint', status: 'unchanged-since-verdict', detail: { green: null }, created_at: new Date(T0 - 29 * MIN) },
        { kind: 'green_checkpoint', status: 'skipped-qualification-conflict', detail: { reason: 'conflict' }, created_at: new Date(T0 - 20 * MIN) },
      ],
      [{ green: false }],
    ];
    const fakeSql = (() => Promise.resolve(results.shift())) as unknown as Parameters<typeof readGateLivenessSnapshot>[0];
    const snap = await readGateLivenessSnapshot(fakeSql, { workspaceId: 'w', installSlug: 'papercusp', nowMs: T0 });
    expect(snap.mainRed).toBe(true);
    expect(snap.events.map((e) => e.ending ?? e.kind)).toEqual(['fire', 'deferred', 'conflict']);
  });

  it('an empty ledger with no verdict ever is a wrong-database error, never a quiet unknown', async () => {
    const results: unknown[][] = [[], []];
    const fakeSql = (() => Promise.resolve(results.shift())) as unknown as Parameters<typeof readGateLivenessSnapshot>[0];
    await expect(readGateLivenessSnapshot(fakeSql, { workspaceId: 'w', installSlug: 'papercusp', nowMs: T0 }))
      .rejects.toThrow(/wrong database/);
  });

  it('an unreadable ledger is reported, not treated as healthy', async () => {
    const h = harness({ snapshot: () => { throw new Error('ECONNREFUSED 127.0.0.1:5432'); } });
    const r = await runGateLivenessSentinelTick(h.deps);
    expect(r.readError).toMatch(/ECONNREFUSED/);
    expect(r.decision).toBeNull();
    expect(h.logs[0]).toMatch(/state=unreadable/);
  });
});

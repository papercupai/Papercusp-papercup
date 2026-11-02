/**
 * liveness-oracle-totality.test.ts — the oracle's TOTALITY contract
 * (EI-18771777750306094 / unified-agent-state-plane-2026-07-27 #D-038 axis 2).
 *
 * THE EXECUTABLE SPEC: `resolveSessionStates` returns an entry for EVERY
 * subject it was handed. An owner whose wakeability signal is missing gets an
 * explicit in-band UNKNOWN verdict (`sessionState: null` + `signalMissing`),
 * never silent omission from the result Map.
 *
 * WHY THIS IS GUARDED. The oracle used to `continue` past such a subject, so
 * the returned Map was SHORTER than the subject list and a missing key meant
 * two incompatible things at once — "we could not measure this owner" and "you
 * never asked about this owner". A Map lookup cannot tell those apart, so every
 * caller had to re-derive its own unknown handling from an absent key: 28 of 30
 * did it correctly with `?? null`, two rendered the literal text "undefined"
 * into a human-facing routing explanation, and `delegated-spawn-outcome-resolve`
 * had to fail closed on a missing key purely to stay safe.
 *
 * The silent-shrink path was unreachable through the default fetch
 * (`fetchWakeability` emits an entry per requested id, and its rejection
 * propagates rather than degrading per-subject) — it was reachable only through
 * the `fetchWakeabilityFn` DI seam. That is exactly what these tests inject,
 * because an unreachable-today hazard is precisely the kind that gets armed by
 * a later change (a per-id try/catch, a cache layer) and then goes unnoticed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyReadActionability,
  resolveSessionStates,
  type LivenessSubject,
} from './liveness-oracle';
import type { WakeabilitySignals } from './presence-wakeability';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** Every leg pinned to a PG-free seam; only the wakeability map varies. */
const opts = (wake: Map<string, WakeabilitySignals>) => ({
  nowMs: NOW,
  fetchWakeabilityFn: async () => wake,
  fetchRecordedLiveFn: async () => new Set<string>(),
  fetchRecordedEndedFn: async () => new Set<string>(),
  probePidFn: () => null,
  findHostFn: () => null,
});

const SIGNALLED: WakeabilitySignals = { wakeable: true, liveTurn: false };

describe('resolveSessionStates is TOTAL — unknown is in band, never omitted', () => {
  // The mixed batch is the whole point: `measured` is a POSITIVE CONTROL riding
  // in the same call as the unmeasured pair. Without it, an oracle that
  // returned unknown for EVERYTHING would satisfy every assertion below, and
  // the test would pass while measuring nothing.
  const subjects: LivenessSubject[] = [
    { ownerId: 'su-measured', heartbeatAt: iso(5_000), stale: false },
    { ownerId: 'su-unmeasured-fresh', heartbeatAt: iso(5_000) },
    { ownerId: 'su-unmeasured-cold', heartbeatAt: iso(PRESENCE_STALE_MS * 4) },
  ];

  it('returns one entry per subject even when the fetch omits two of them', async () => {
    const out = await resolveSessionStates(
      subjects,
      opts(new Map([['su-measured', SIGNALLED]])),
    );

    expect(out.size).toBe(subjects.length);
    for (const s of subjects) expect(out.has(s.ownerId)).toBe(true);

    // POSITIVE CONTROL: the measured subject still gets a real, definite
    // verdict — so the totality above is not "everything degraded to unknown".
    const measured = out.get('su-measured')!;
    expect(measured.sessionState).toBe('parked');
    expect(measured.signalMissing).toBeUndefined();
  });

  it('reports request-scoped timings for each async liveness I/O leg', async () => {
    const timings: Array<{ leg: string; durationMs: number; outcome: string }> = [];
    const ownerId = 'su-timing-probe';
    const out = await resolveSessionStates([{ ownerId }], {
      nowMs: NOW,
      hydrateBatch: true,
      listPresenceFn: async () => [],
      fetchRecordedSessionsFn: async () => new Map(),
      fetchWakeabilityFn: async () => new Map([[ownerId, SIGNALLED]]),
      fetchRecordedLiveFn: async () => new Set<string>(),
      fetchRecordedEndedFn: async () => new Set<string>(),
      probePidFn: () => null,
      findHostFn: () => null,
      onTiming: (leg, durationMs, outcome) => timings.push({ leg, durationMs, outcome }),
    });

    expect(out.get(ownerId)?.sessionState).toBe('parked');
    expect(timings.map(({ leg }) => leg)).toEqual(expect.arrayContaining([
      'presence_hydration',
      'absent_presence_fallback',
      'fetchWakeability',
      'recordedLiveOwnerIds',
      'endedRecordedOwnerIds',
    ]));
    expect(timings.every(({ durationMs, outcome }) => Number.isInteger(durationMs) && durationMs >= 0 && outcome === 'ok')).toBe(true);
    expect(JSON.stringify(timings)).not.toContain(ownerId);
  });

  it('fills a freed host-discovery slot while an earlier lookup is blocked, with at most sixteen active', async () => {
    const owners = Array.from({ length: 33 }, (_, i) => `su-host-discovery-${i}`);
    let releaseFirst!: () => void;
    let sawLaterOwner!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const laterOwner = new Promise<void>((resolve) => { sawLaterOwner = resolve; });
    const lookups: string[] = [];
    let active = 0;
    let peak = 0;
    const discovery = resolveSessionStates(owners.map((ownerId, i) => ({
      ownerId, heartbeatAt: iso(5_000), stale: false, host: 'test-host', pid: i + 1,
    })), {
      nowMs: NOW,
      fetchWakeabilityFn: async () => new Map(owners.map(ownerId => [ownerId, SIGNALLED])),
      fetchRecordedLiveFn: async () => new Set<string>(),
      fetchRecordedEndedFn: async () => new Set<string>(),
      probePidFn: () => false,
      findHostAsyncFn: async (ownerId) => {
        lookups.push(ownerId);
        active += 1;
        peak = Math.max(peak, active);
        try {
          if (ownerId === owners[0]) await first;
          else await Promise.resolve();
          if (ownerId === owners[16]) sawLaterOwner();
          if (ownerId === owners[17]) throw new Error('unreadable discovery record');
          return ownerId === owners[32] ? { pid: 1000 } : null;
        } finally { active -= 1; }
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let filledFreedSlot: boolean;
    try {
      filledFreedSlot = await Promise.race([
        laterOwner.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 200); }),
      ]);
    } finally { clearTimeout(timer); releaseFirst(); }
    const out = await discovery;
    expect(filledFreedSlot, 'a slow owner must not leave fifteen discovery slots idle').toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
    expect(lookups).toEqual(owners);
    expect([...out.keys()]).toEqual(owners);
    expect(out.get(owners[17])?.sessionState).toBe('ended');
    expect(out.get(owners[32])?.sessionState).toBe('parked');
  });

  it('marks an unmeasured subject UNKNOWN in band, on three independent channels', async () => {
    const out = await resolveSessionStates(
      subjects,
      opts(new Map([['su-measured', SIGNALLED]])),
    );
    const unknown = out.get('su-unmeasured-fresh')!;

    // A reader that checks ANY one of these cannot mistake absence of evidence
    // for evidence of absence.
    expect(unknown.sessionState).toBeNull();
    expect(unknown.signalMissing).toBe(true);
    expect(unknown.confirmLiveness).toBe(true);

    // ...and it reads as 'unknown' through the shared read-side classifier,
    // rather than as an actionable state.
    expect(classifyReadActionability(unknown.sessionState)).toBe('unknown');
  });

  it('never fabricates a leg it did not measure, but keeps the one it DID know', async () => {
    const out = await resolveSessionStates(subjects, opts(new Map()));

    // heartbeatFresh comes from the subject's OWN caller-supplied heartbeat,
    // which is not part of the wakeability leg — so it stays honest here and
    // must still discriminate fresh from cold.
    expect(out.get('su-unmeasured-fresh')!.heartbeatFresh).toBe(true);
    expect(out.get('su-unmeasured-cold')!.heartbeatFresh).toBe(false);

    // The wakeability-derived legs are absence-of-evidence, flagged as such.
    const unknown = out.get('su-unmeasured-fresh')!;
    expect(unknown.wakeable).toBe(false);
    expect(unknown.liveTurn).toBe(false);
    expect(unknown.signalMissing).toBe(true);
  });

  it('recorded end evidence overrides a fresh heartbeat', async () => {
    const ownerId = 'su-recorded-ended-fresh-heartbeat';
    const subject = { ownerId, heartbeatAt: iso(5_000), stale: false };
    const wake = new Map([[ownerId, { wakeable: true, liveTurn: false }]]);
    const ordinary = await resolveSessionStates([subject], opts(wake));
    const ended = await resolveSessionStates([subject], {
      ...opts(wake),
      fetchRecordedEndedFn: async () => new Set([ownerId]),
    });

    expect(ordinary.get(ownerId)).toMatchObject({
      sessionState: 'parked',
      heartbeatFresh: true,
    });
    expect(ended.get(ownerId)).toMatchObject({
      sessionState: 'ended',
      heartbeatFresh: true,
    });
  });

  it('does not turn a bare owner id with only negative wakeability into ended', async () => {
    const bare = { ownerId: 'su-never-heard-of' };
    const control = {
      ownerId: 'su-positive-control',
      heartbeatAt: iso(5_000),
      stale: false,
    };
    const out = await resolveSessionStates([bare, control], {
      nowMs: NOW,
      fetchWakeabilityFn: async () =>
        new Map([
          [bare.ownerId, { wakeable: false, liveTurn: false }],
          [control.ownerId, { wakeable: true, liveTurn: true }],
        ]),
      fetchRecordedLiveFn: async () => new Set<string>(),
      fetchRecordedEndedFn: async () => new Set<string>(),
      probePidFn: () => null,
    });

    expect(out.get(bare.ownerId)).toMatchObject({
      sessionState: null,
      signalMissing: true,
      confirmLiveness: true,
      heartbeatFresh: false,
    });
    expect(out.get(control.ownerId)).toMatchObject({
      sessionState: 'live',
      heartbeatFresh: true,
    });
    expect(out.get(control.ownerId)?.signalMissing).toBeUndefined();
  });

  it('does not silently shrink the result when the fetch returns nothing at all', async () => {
    // The exact regression: a wholly-degraded injected fetch used to yield an
    // EMPTY map, which is indistinguishable from "no subjects were asked about".
    const out = await resolveSessionStates(subjects, opts(new Map()));

    expect(out.size).toBe(subjects.length);
    expect([...out.values()].every((v) => v.sessionState === null)).toBe(true);
    expect([...out.values()].every((v) => v.signalMissing === true)).toBe(true);
  });

  it('still returns an empty map for an empty subject list', async () => {
    // Totality is "one entry per SUBJECT" — not "never empty". Guards against
    // over-correcting the fix into synthesising rows nobody asked for.
    const out = await resolveSessionStates([], opts(new Map()));
    expect(out.size).toBe(0);
  });

  it('hydrates a 200-owner candidate pool with one batch read and preserves per-id verdicts', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ownerId: `su-candidate-${i}` }));
    const rows = many.map((subject) => ({
      ownerId: subject.ownerId,
      heartbeatAt: iso(5_000),
      stale: false,
      host: null,
      pid: null,
      source: 'test',
      agentRole: 'su',
    }));
    const byOwner = new Map(rows.map((row) => [row.ownerId, row]));
    const perIdRead = vi.fn(async (ownerId: string) => byOwner.get(ownerId) ?? null);
    const batchRead = vi.fn(async ({ ownerIds }: { ownerIds?: readonly string[] }) =>
      (ownerIds ?? []).flatMap((ownerId) => {
        const row = byOwner.get(ownerId);
        return row ? [row] : [];
      }),
    );
    const common = {
      nowMs: NOW,
      fetchWakeabilityFn: async (ids: string[]) => new Map(ids.map((id) => [id, SIGNALLED])),
      fetchRecordedLiveFn: async () => new Set<string>(),
      fetchRecordedEndedFn: async () => new Set<string>(),
      probePidFn: () => null,
      findHostFn: () => null,
    };

    const perId = await resolveSessionStates(many, {
      ...common,
      hydratePerId: true,
      getPresenceFn: perIdRead,
    });
    const batched = await resolveSessionStates(many, {
      ...common,
      hydrateBatch: true,
      listPresenceFn: batchRead as never,
    });

    expect(perIdRead).toHaveBeenCalledTimes(200);
    expect(batchRead).toHaveBeenCalledTimes(1);
    expect(batchRead).toHaveBeenCalledWith({ ownerIds: many.map((subject) => subject.ownerId) });
    expect(batched).toEqual(perId);
  });
});

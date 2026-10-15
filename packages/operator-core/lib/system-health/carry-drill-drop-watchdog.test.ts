import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ORPHANED_RESPAWN_MAX_AGE_MS,
  PRODUCTION_CARRY_DELIVERY_RATE_FLOOR,
  PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES,
  listOrphanCandidateOwners,
  orphanedRespawnAlert,
  type OrphanedRespawnAlert,
  readRecentProductionCarryEvents,
  runCarryDrillDropSweepOnce,
  runOrphanedRespawnSweepOnce,
  runProductionCarryDeliverySweepOnce,
  summarizeProductionCarryDelivery,
} from './carry-drill-drop-watchdog';
import { deriveLastRespawnOutcome, type PriorRespawn } from '../carry-respawn-outcome';
import type { ColdBootDrillHostEvent, ColdBootDrillLedgerEvent } from '../cold-boot-drill-live';
import type { PtyHostEvent } from '../events/await/psu-pty-discovery';
import { readColdBootDrillLedger } from '../cold-boot-drill-live';
import { readPriorRespawnOutcome } from '../carry-respawn-outcome';

// Legacy predicate tests also exercise the new production-default rail. Keep
// those reads/deliveries isolated; lifecycle cases below inject a durable rail.
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: async () => true, broadcastSevereEventResolved: async () => true,
}));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  computeConditionStates: () => [], readConditionEnvelopes: async () => [],
  readLatestConditionEnvelope: async () => null,
}));

const T0 = Date.parse('2026-07-15T12:00:00.000Z');

function drop(drillId: string, offsetMs: number, reason = 'busy-gate-expired'): ColdBootDrillLedgerEvent {
  return {
    ts: new Date(T0 + offsetMs).toISOString(),
    kind: 'carry-drill-carry-dropped',
    drillId,
    ownerId: 'su-w',
    sessionClass: 'gateway-claude-headless',
    reason,
  };
}

describe('runCarryDrillDropSweepOnce (EI-12755)', () => {
  it('skips entirely (no ledger read) when the flag is OFF', async () => {
    const readLedger = vi.fn();
    const result = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => false,
      readLedger,
      escalate: vi.fn(),
    });
    expect(result).toEqual({ watermarkMs: T0, escalated: 0, skipped: true });
    expect(readLedger).not.toHaveBeenCalled();
  });

  it('escalates each fresh drop once and advances the watermark', async () => {
    const escalate = vi.fn(async () => {});
    const result = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => true,
      readLedger: async () => [drop('d-1', 1_000), drop('d-2', 2_000, 'never-settled')],
      escalate,
    });
    expect(escalate).toHaveBeenCalledTimes(2);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ drillId: 'd-2', reason: 'never-settled' }),
    );
    expect(result).toEqual({ watermarkMs: T0 + 2_000, escalated: 2, skipped: false });
  });

  it('a second sweep from the advanced watermark re-alerts nothing', async () => {
    const events = [drop('d-1', 1_000)];
    const escalate = vi.fn(async () => {});
    const first = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => true,
      readLedger: async () => events,
      escalate,
    });
    const second = await runCarryDrillDropSweepOnce(first.watermarkMs, {
      flagEnabled: async () => true,
      readLedger: async () => events,
      escalate,
    });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ watermarkMs: first.watermarkMs, escalated: 0, skipped: false });
  });

  it('keeps the OLD watermark when an escalate fails, so the batch retries next tick', async () => {
    const escalate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('coord log down'));
    const result = await runCarryDrillDropSweepOnce(T0, {
      flagEnabled: async () => true,
      readLedger: async () => [drop('d-1', 1_000), drop('d-2', 2_000)],
      escalate,
    });
    expect(result).toEqual({ watermarkMs: T0, escalated: 1, skipped: false });
  });
});

describe('production carry delivery rate (EI-18168050721107453)', () => {
  const NOW = Date.parse('2026-08-23T20:00:00.000Z');
  const event = (kind: string, offsetMs: number, extra: Record<string, unknown> = {}): PtyHostEvent => ({
    ts: new Date(NOW + offsetMs).toISOString(),
    kind,
    mode: 'carry-respawn',
    ...extra,
  });

  it('uses mutually-exclusive terminal outcomes and breaks failures down by reason', () => {
    const reading = summarizeProductionCarryDelivery(
      [
        event('respawned', -1_000, { nativeId: 'n-1' }),
        event('respawn-carry-delivered', -900, { nativeId: 'n-1' }),
        event('respawned', -800, { nativeId: 'n-2' }),
        event('respawn-carry-dropped', -700, { nativeId: 'n-2', reason: 'never-settled' }),
        event('respawn-failed', -600, { reason: 'spawn-failed' }),
        event('respawn-carry-dropped', -2 * 60 * 60_000, { reason: 'outside-window' }),
        event('respawn-carry-delivered', 1_000),
        event('respawn-carry-delivered', -500, { mode: 'recycle' }),
      ],
      NOW,
    );

    expect(reading).toEqual({
      windowStartMs: NOW - 60 * 60_000,
      windowEndMs: NOW,
      delivered: 1,
      dropped: 1,
      respawnFailed: 1,
      retiredSuperseded: 0,
      terminalOutcomes: 3,
      deliveryRate: 1 / 3,
      failureReasons: {
        'never-settled': 1,
        'respawn-failed:spawn-failed': 1,
      },
    });
  });

  // WI-10005752: `respawn-carry-dropped {reason:'superseded'}` is the host RETIRING a moot request
  // because a real successor already exists — not a lost continuation. Measured 2026-10-03 over
  // 4,263 owner ledgers: 5,433 such rows against ~1.6k deliveries, so counting them as drops
  // pins the rate under the 0.5 floor with nothing actually lost.
  it('does not count superseded retirements as failed deliveries (WI-10005752)', () => {
    const events: PtyHostEvent[] = [
      ...Array.from({ length: 12 }, (_, i) => event('respawn-carry-delivered', -10_000 - i)),
      ...Array.from({ length: 30 }, (_, i) =>
        event('respawn-carry-dropped', -5_000 - i, { reason: 'superseded', rearmed: true })),
      event('respawn-carry-dropped', -4_000, { reason: 'turn-start-unverified' }),
    ];
    const reading = summarizeProductionCarryDelivery(events, NOW);

    expect(reading).toMatchObject({
      delivered: 12,
      dropped: 1,
      respawnFailed: 0,
      retiredSuperseded: 30,
      terminalOutcomes: 13,
      failureReasons: { 'turn-start-unverified': 1 },
    });
    expect(reading.deliveryRate).toBeCloseTo(12 / 13);
    expect(reading.failureReasons).not.toHaveProperty('superseded');

    // CONTROL: the pre-fix tally (every respawn-carry-dropped is a drop) reads the SAME window as
    // 12/43 ≈ 28% — under the 0.5 floor with 43 ≥ the 20-outcome minimum, i.e. a false alarm.
    const naiveDropped = events.filter((e) => e.kind === 'respawn-carry-dropped').length;
    const naiveRate = 12 / (12 + naiveDropped);
    expect(naiveRate).toBeLessThan(PRODUCTION_CARRY_DELIVERY_RATE_FLOOR);
    expect(12 + naiveDropped).toBeGreaterThanOrEqual(PRODUCTION_CARRY_MIN_TERMINAL_OUTCOMES);
    expect(reading.deliveryRate!).toBeGreaterThanOrEqual(PRODUCTION_CARRY_DELIVERY_RATE_FLOOR);
  });

  it('reads recent per-owner bounded tails and excludes the shared drill ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'production-carry-watchdog-'));
    try {
      writeFileSync(
        join(dir, 'su-recent.events.jsonl'),
        `${JSON.stringify(event('respawn-carry-delivered', -1_000))}\n`,
      );
      writeFileSync(
        join(dir, 'carry-drills.events.jsonl'),
        `${JSON.stringify(event('respawn-carry-dropped', -1_000, { reason: 'mirrored' }))}\n`,
      );
      const stalePath = join(dir, 'su-stale.events.jsonl');
      writeFileSync(stalePath, `${JSON.stringify(event('respawn-carry-dropped', -1_000))}\n`);
      const stale = new Date(NOW - 2 * 60 * 60_000);
      utimesSync(stalePath, stale, stale);

      expect(await readRecentProductionCarryEvents(dir, NOW)).toEqual([
        expect.objectContaining({ kind: 'respawn-carry-delivered' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escalates only below the delivery-rate floor with enough terminal samples', async () => {
    const events = [
      event('respawn-carry-delivered', -3_000),
      event('respawn-carry-dropped', -2_000, { reason: 'busy-gate-expired' }),
      event('respawn-carry-dropped', -1_000, { reason: 'carry-stale' }),
    ];
    const escalate = vi.fn(async () => {});
    const breached = await runProductionCarryDeliverySweepOnce({
      flagEnabled: async () => true,
      readEvents: async () => events,
      escalate,
      now: () => NOW,
      minTerminalOutcomes: 3,
      deliveryRateFloor: 0.5,
    });
    expect(breached.escalated).toBe(true);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: 1, terminalOutcomes: 3, deliveryRate: 1 / 3 }),
    );

    escalate.mockClear();
    const atFloor = await runProductionCarryDeliverySweepOnce({
      flagEnabled: async () => true,
      readEvents: async () => [event('respawn-carry-delivered', -2_000), event('respawn-carry-dropped', -1_000)],
      escalate,
      now: () => NOW,
      minTerminalOutcomes: 2,
      deliveryRateFloor: 0.5,
    });
    expect(atFloor.escalated).toBe(false);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('skips the production ledger read when the existing watchdog flag is off', async () => {
    const readEvents = vi.fn();
    const result = await runProductionCarryDeliverySweepOnce({
      flagEnabled: async () => false,
      readEvents,
    });
    expect(result).toEqual({ reading: null, escalated: false, skipped: true });
    expect(readEvents).not.toHaveBeenCalled();
  });
});

/* ── Orphaned carry-respawn sweep (WI-10001537) ─────────────────────────── */

const ORPHAN_NOW = Date.parse('2026-09-16T01:00:00.000Z');
/** Comfortably past the default 360s cap + 120s grace. */
const PAST_CAP_MS = 600_000;

function pending(overrides: Partial<PriorRespawn> = {}): PriorRespawn {
  return {
    outcome: 'pending',
    reason: 'busy-gate-expired',
    ts: new Date(ORPHAN_NOW - PAST_CAP_MS).toISOString(),
    ageMs: PAST_CAP_MS,
    capMs: 360_000,
    ...overrides,
  };
}

describe('orphanedRespawnAlert (WI-10001537)', () => {
  it('alarms on a pending respawn past cap+grace whose host is gone', () => {
    const alert = orphanedRespawnAlert('su-dead', pending(), false);
    expect(alert).toMatchObject({ ownerId: 'su-dead', reason: 'busy-gate-expired', ageMs: PAST_CAP_MS });
  });

  it('STAYS SILENT when the host is still live, however long it has been pending', () => {
    // The load-bearing conjunct. A live host may legitimately retry across
    // several capMs windows, so elapsed time alone is a DELAY, not a loss.
    expect(orphanedRespawnAlert('su-live', pending({ ageMs: 10 * 60 * 60 * 1000 }), true)).toBeNull();
  });

  it('stays silent inside cap+grace even with a dead host', () => {
    // 360s cap + 120s grace = 480s; 400s is still within the host's own window.
    expect(orphanedRespawnAlert('su-early', pending({ ageMs: 400_000 }), false)).toBeNull();
  });

  it.each(['delivered', 'dropped', 'none'] as const)('stays silent on a %s outcome', (outcome) => {
    expect(orphanedRespawnAlert('su-x', pending({ outcome }), false)).toBeNull();
  });

  it('stays silent on an orphan older than the recency horizon', () => {
    const ancient = pending({ ageMs: ORPHANED_RESPAWN_MAX_AGE_MS + 1 });
    expect(orphanedRespawnAlert('su-ancient', ancient, false)).toBeNull();
  });

  it('stays silent when the age is unknown rather than guessing "recent"', () => {
    expect(orphanedRespawnAlert('su-noage', pending({ ageMs: null }), false)).toBeNull();
    expect(orphanedRespawnAlert('su-nil', null, false)).toBeNull();
  });

  /**
   * REGRESSION, built from the real rows of the 2026-09-16 incident ledger
   * (~/.papercusp/psu-pty/su-66826cba-….events.jsonl). `deriveLastRespawnOutcome`
   * counts `respawned` as pending only for mode==='carry-respawn', so the owner's
   * MANUAL recovery (mode:'self-relaunch') is skipped and the scan keeps returning
   * the stale 00:46 pending row. A timer-only reconciler would therefore have
   * alarmed on a session that was alive and working, for ~5.5 minutes.
   */
  it('does not alarm on a session the owner already recovered via self-relaunch', () => {
    const rows: ColdBootDrillHostEvent[] = [
      { kind: 'respawn-rearm-queued', ts: '2026-09-16T00:46:09.599Z', reason: 'busy-gate-expired', capMs: 360_000 },
      { kind: 'respawned', ts: '2026-09-16T00:52:58.671Z', mode: 'self-relaunch' },
    ] as unknown as ColdBootDrillHostEvent[];
    // 00:56Z — past the 00:54:09 cap+grace expiry, before the 00:59:47 delivery.
    const now = Date.parse('2026-09-16T00:56:00.000Z');
    const prior = deriveLastRespawnOutcome(rows, { now });

    // The derivation itself still reports a stale pending — that is the trap.
    expect(prior.outcome).toBe('pending');
    // Timer-only would fire here…
    expect(orphanedRespawnAlert('su-66826cba', prior, false)).not.toBeNull();
    // …but the host is live, so the real predicate is silent.
    expect(orphanedRespawnAlert('su-66826cba', prior, true)).toBeNull();
  });
});

describe('listOrphanCandidateOwners (WI-10001537)', () => {
  it('bounds the scan by ledger mtime and ignores the shared drill ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-candidates-'));
    try {
      const write = (name: string, ageMs: number) => {
        const p = join(dir, name);
        writeFileSync(p, '{}\n');
        const t = (ORPHAN_NOW - ageMs) / 1000;
        utimesSync(p, t, t);
      };
      write('su-recent.events.jsonl', 60_000);
      write('su-ancient.events.jsonl', ORPHANED_RESPAWN_MAX_AGE_MS + 60_000);
      write('carry-drills.events.jsonl', 60_000); // shared ledger, not an owner
      write('su-notaledger.json', 60_000); // discovery file, wrong suffix

      expect(await listOrphanCandidateOwners(dir, ORPHAN_NOW)).toEqual(['su-recent']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty rather than throwing when the directory is absent', async () => {
    expect(await listOrphanCandidateOwners(join(tmpdir(), 'no-such-psu-pty-dir-xyz'), ORPHAN_NOW)).toEqual([]);
  });
});

describe('runOrphanedRespawnSweepOnce (WI-10001537)', () => {
  const baseDeps = {
    flagEnabled: async () => true,
    now: () => ORPHAN_NOW,
    maxAgeMs: ORPHANED_RESPAWN_MAX_AGE_MS,
  };

  it('escalates one alert per orphaned owner', async () => {
    const escalate = vi.fn(async (_alert: OrphanedRespawnAlert) => {});
    const result = await runOrphanedRespawnSweepOnce({
      ...baseDeps,
      listCandidates: async () => ['su-a', 'su-b'],
      readPrior: async (ownerId) => (ownerId === 'su-a' ? pending() : pending({ outcome: 'delivered' })),
      hostLive: () => false,
      escalate,
    });
    expect(result).toEqual({ scanned: 2, alerts: 1, escalated: 1, skipped: false });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][0]).toMatchObject({ ownerId: 'su-a' });
  });

  it('reads nothing when the watchdog flag is off', async () => {
    const listCandidates = vi.fn();
    const result = await runOrphanedRespawnSweepOnce({ ...baseDeps, flagEnabled: async () => false, listCandidates });
    expect(result).toEqual({ scanned: 0, alerts: 0, escalated: 0, skipped: true });
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it('FAILS SAFE TOWARD SILENCE when liveness cannot be measured', async () => {
    // Liveness is the evidence that turns a delay into a loss. If the probe
    // throws we have not established loss — alarming there would invert the
    // rule the predicate exists to enforce.
    const escalate = vi.fn(async () => {});
    const result = await runOrphanedRespawnSweepOnce({
      ...baseDeps,
      listCandidates: async () => ['su-unknown'],
      readPrior: async () => pending(),
      hostLive: async () => {
        throw new Error('procfs unreadable');
      },
      escalate,
    });
    expect(result.alerts).toBe(0);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('prefilters non-delayed outcomes before awaiting host liveness', async () => {
    const order: string[] = [];
    const priorByOwner: Record<string, PriorRespawn> = {
      delivered: pending({ outcome: 'delivered' }),
      early: pending({ ageMs: 400_000 }),
      unknownAge: pending({ ageMs: null }),
      orphan: pending(),
    };
    const hostLive = vi.fn(async (ownerId: string) => {
      order.push(`live:${ownerId}`);
      return false;
    });
    const escalate = vi.fn(async (alert: OrphanedRespawnAlert) => {
      order.push(`escalate:${alert.ownerId}`);
    });

    const result = await runOrphanedRespawnSweepOnce({
      ...baseDeps,
      listCandidates: async () => Object.keys(priorByOwner),
      readPrior: async (ownerId) => {
        order.push(`prior:${ownerId}`);
        return priorByOwner[ownerId];
      },
      hostLive,
      escalate,
    });

    expect(result).toMatchObject({ scanned: 4, alerts: 1, escalated: 1 });
    expect(hostLive).toHaveBeenCalledTimes(1);
    expect(hostLive).toHaveBeenCalledWith('orphan');
    expect(order).toEqual([
      'prior:delivered',
      'prior:early',
      'prior:unknownAge',
      'prior:orphan',
      'live:orphan',
      'escalate:orphan',
    ]);
  });

  it('keeps sweeping when one ledger is unreadable, so a bad file cannot hide other orphans', async () => {
    const escalate = vi.fn(async (_alert: OrphanedRespawnAlert) => {});
    const result = await runOrphanedRespawnSweepOnce({
      ...baseDeps,
      listCandidates: async () => ['su-broken', 'su-orphan'],
      readPrior: async (ownerId) => {
        if (ownerId === 'su-broken') throw new Error('corrupt ledger');
        return pending();
      },
      hostLive: () => false,
      escalate,
    });
    expect(result).toMatchObject({ scanned: 2, alerts: 1, escalated: 1 });
    expect(escalate.mock.calls[0][0]).toMatchObject({ ownerId: 'su-orphan' });
  });

  it('survives a failing escalate and leaves it to be retried next tick', async () => {
    const escalate = vi.fn(async () => {
      throw new Error('escalation backend down');
    });
    const result = await runOrphanedRespawnSweepOnce({
      ...baseDeps,
      listCandidates: async () => ['su-a'],
      readPrior: async () => pending(),
      hostLive: () => false,
      escalate,
    });
    expect(result).toMatchObject({ alerts: 1, escalated: 0, skipped: false });
  });
});

describe('carry-delivery condition rail', () => {
  function fixture() {
    const open = new Set<string>();
    const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
      expect(event.oneShot).toBe(true);
      open.add(event.conditionKey!); return true;
    });
    const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
    return { open, broadcast, resolve, deps: { host: () => 'fixture-host',
      rail: { broadcast, resolve }, readOpenConditionKeys: async () => [...open],
      flagEnabled: async () => true, now: () => ORPHAN_NOW } };
  }

  it('opens drill conditions before failed legacy delivery and resolves only the matching later terminal success', async () => {
    const { deps, open, broadcast } = fixture();
    const failed = drop('fixture-drill', 1_000);
    const escalate = vi.fn(async () => { expect(broadcast).toHaveBeenCalled(); throw new Error('legacy down'); });
    expect(await runCarryDrillDropSweepOnce(T0, { ...deps, readLedger: async () => [failed], escalate }))
      .toMatchObject({ watermarkMs: T0, escalated: 0 });
    expect(open.size).toBe(1);
    // Durable keys survive watermark advancement/restart. Empty/malformed/foreign
    // readings and delivery before the failure cannot clear the episode.
    for (const events of [[], [{ ...failed, kind: 'carry-drill-carry-delivered' as const, ts: 'invalid' }],
      [{ ...failed, kind: 'carry-drill-carry-delivered' as const, drillId: 'sibling', ts: new Date(T0 + 2_000).toISOString() }],
      [{ ...failed, kind: 'carry-drill-carry-delivered' as const, ts: new Date(T0).toISOString() }]]) {
      await runCarryDrillDropSweepOnce(T0 + 1_000, { ...deps, readLedger: async () => events, escalate });
      expect(open.size).toBe(1);
    }
    const success = { ...failed, kind: 'carry-drill-carry-delivered' as const, ts: new Date(T0 + 2_000).toISOString() };
    // A later failure outranks an earlier success even with out-of-order IO rows.
    await runCarryDrillDropSweepOnce(T0 + 3_000, { ...deps,
      readLedger: async () => [drop('fixture-drill', 3_000), success], escalate });
    expect(open.size).toBe(1);
    await runCarryDrillDropSweepOnce(T0 + 3_000, { ...deps, readLedger: async () => [success], escalate });
    expect(open.size).toBe(0);
  });

  it('keeps the drill watermark for a failed broadcast and still runs legacy delivery', async () => {
    const { deps } = fixture();
    const escalate = vi.fn(async () => {});
    expect(await runCarryDrillDropSweepOnce(T0, { ...deps, readLedger: async () => [drop('d', 1_000)],
      rail: { broadcast: async () => { throw new Error('rail down'); } }, escalate }))
      .toEqual({ watermarkMs: T0, escalated: 1, skipped: false });
    expect(escalate).toHaveBeenCalledTimes(1);
  });

  it('preserves low-rate conditions on sparse, empty, skipped or failed scans and recovers on enough measured successes', async () => {
    const { deps, open } = fixture();
    const row = (kind: string): PtyHostEvent => ({ kind, mode: 'carry-respawn', ts: new Date(ORPHAN_NOW - 1_000).toISOString() });
    let events = [row('respawn-carry-dropped'), row('respawn-failed')];
    const rateDeps = { ...deps, minTerminalOutcomes: 2, readEvents: async () => events, escalate: async () => {} };
    await runProductionCarryDeliverySweepOnce(rateDeps);
    expect(open.size).toBe(1);
    events = [row('respawn-carry-delivered')];
    await runProductionCarryDeliverySweepOnce(rateDeps);
    events = [];
    await runProductionCarryDeliverySweepOnce(rateDeps);
    await runProductionCarryDeliverySweepOnce({ ...rateDeps, flagEnabled: async () => false });
    await expect(runProductionCarryDeliverySweepOnce({ ...rateDeps,
      readEvents: async () => { throw new Error('unreadable'); } })).rejects.toThrow('unreadable');
    events = [row('respawn-carry-delivered'), row('respawn-carry-delivered')];
    await runProductionCarryDeliverySweepOnce({ ...rateDeps, host: () => 'sibling-host' });
    expect(open.size).toBe(1);
    await runProductionCarryDeliverySweepOnce(rateDeps);
    expect(open.size).toBe(0);
  });

  it('opens the low-rate condition before a failed escalation', async () => {
    const { deps, open } = fixture();
    await expect(runProductionCarryDeliverySweepOnce({ ...deps, minTerminalOutcomes: 1,
      readEvents: async () => [{ kind: 'respawn-failed', mode: 'carry-respawn', ts: new Date(ORPHAN_NOW - 1).toISOString() }],
      escalate: async () => { throw new Error('legacy down'); } })).rejects.toThrow('legacy down');
    expect(open.size).toBe(1);
  });

  it('recovers a durable orphan outside the candidate list only from its measured later delivery', async () => {
    const { deps, open } = fixture();
    const prior = pending();
    let owners = ['fixture-owner'], current = prior;
    const orphanDeps = { ...deps, listCandidates: async () => owners, readPrior: async () => current,
      hostLive: async () => false, escalate: async () => { throw new Error('legacy down'); } };
    await runOrphanedRespawnSweepOnce(orphanDeps);
    expect(open.size).toBe(1);
    owners = [];
    for (const unknown of [{ outcome: 'none' as const }, pending({ ageMs: null }),
      pending({ ageMs: ORPHANED_RESPAWN_MAX_AGE_MS + 1 }), pending({ outcome: 'dropped' }),
      pending({ outcome: 'delivered', ts: new Date(ORPHAN_NOW + 1).toISOString() })]) {
      current = unknown;
      await runOrphanedRespawnSweepOnce(orphanDeps);
      expect(open.size).toBe(1);
    }
    current = pending({ outcome: 'delivered', ts: new Date(ORPHAN_NOW - 1).toISOString() });
    await runOrphanedRespawnSweepOnce({ ...orphanDeps, host: () => 'sibling-host' });
    expect(open.size).toBe(1);
    await runOrphanedRespawnSweepOnce(orphanDeps);
    expect(open.size).toBe(0);
  });

  it('resolves an aged-out orphan from matching live-host recovery, preserving failed and unrelated probes', async () => {
    const { deps, open } = fixture();
    const prior = pending();
    const orphanDeps = { ...deps, listCandidates: async () => ['fixture-owner'], readPrior: async () => prior,
      hostLive: async () => false, escalate: async () => {} };
    await runOrphanedRespawnSweepOnce(orphanDeps);
    expect(open.size).toBe(1);
    const recovery = { ...orphanDeps, listCandidates: async () => [],
      readPrior: async () => ({ ...prior, ageMs: ORPHANED_RESPAWN_MAX_AGE_MS + 1 }) };
    await runOrphanedRespawnSweepOnce({ ...recovery, hostLive: async () => { throw new Error('unknown liveness'); } });
    await runOrphanedRespawnSweepOnce({ ...recovery, readPrior: async () => pending({ ts: 'invalid' }), hostLive: async () => true });
    expect(open.size).toBe(1);
    await runOrphanedRespawnSweepOnce({ ...recovery, hostLive: async () => true });
    expect(open.size).toBe(0);
  });

  it('rejects incomplete production ledger censuses rather than manufacturing a healthy rate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'carry-census-'));
    const file = join(dir, 'fixture-owner.events.jsonl');
    try {
      await expect(readRecentProductionCarryEvents(join(dir, 'absent'), ORPHAN_NOW)).rejects.toThrow();
      const delivered = JSON.stringify({ kind: 'respawn-carry-delivered', mode: 'carry-respawn',
        ts: new Date(ORPHAN_NOW - 1).toISOString() });
      for (const body of [delivered, `${delivered}\n{broken}\n`, `${delivered}\nnull\n`,
        `${delivered}\n${JSON.stringify({ kind: 'respawn-failed', mode: 'carry-respawn', ts: 'invalid' })}\n`]) {
        writeFileSync(file, body);
        await expect(readRecentProductionCarryEvents(dir, ORPHAN_NOW)).rejects.toThrow();
      }
      writeFileSync(file, `${delivered}\n`);
      await expect(readRecentProductionCarryEvents(dir, ORPHAN_NOW, 60_000, 1)).rejects.toThrow('complete-read bound');
      expect(await readRecentProductionCarryEvents(dir, ORPHAN_NOW)).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects corrupt shared drill/owner ledgers while retaining the legacy best-effort reader contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'carry-drill-census-'));
    try {
      const success = { ...drop('fixture', 1_000), kind: 'carry-drill-carry-delivered' };
      writeFileSync(join(dir, 'carry-drills.events.jsonl'), `${JSON.stringify(success)}\n{broken}\n`);
      expect(await readColdBootDrillLedger(dir)).toHaveLength(1);
      await expect(readColdBootDrillLedger(dir, { requireComplete: true })).rejects.toThrow();
      for (const invalid of ['null', '{}', JSON.stringify({ kind: 'carry-drill-carry-dropped', ts: 'invalid' })]) {
        writeFileSync(join(dir, 'carry-drills.events.jsonl'), `${JSON.stringify(success)}\n${invalid}\n`);
        await expect(readColdBootDrillLedger(dir, { requireComplete: true })).rejects.toThrow();
      }
      const ownerSuccess = { kind: 'respawn-carry-delivered', ts: new Date(ORPHAN_NOW - 1).toISOString() };
      writeFileSync(join(dir, 'fixture-owner.events.jsonl'), `${JSON.stringify(ownerSuccess)}\n{broken}\n`);
      expect((await readPriorRespawnOutcome('fixture-owner', { dir, now: ORPHAN_NOW })).outcome).toBe('delivered');
      expect((await readPriorRespawnOutcome('fixture-owner', { dir, now: ORPHAN_NOW, requireComplete: true })).outcome).toBe('none');
      writeFileSync(join(dir, 'fixture-owner.events.jsonl'), `${JSON.stringify(ownerSuccess)}\n`);
      expect((await readPriorRespawnOutcome('fixture-owner', { dir, now: ORPHAN_NOW, requireComplete: true })).outcome).toBe('delivered');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

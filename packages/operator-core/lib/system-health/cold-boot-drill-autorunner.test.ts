/**
 * cold-boot-drill-autorunner.test.ts — the P-021 cold-by-default bootstrap runner
 * (cold-with-carry-activation-2026-07-20 A2). Pure helpers + the injected-deps sweep;
 * no real fs/PG/host is touched.
 *
 * Run: cd packages/operator-core && npx vitest run lib/system-health/cold-boot-drill-autorunner.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import type { ColdBootDrillLedgerEvent } from '../cold-boot-drill-live';
import { sessionClassForHost, type PsuPtyHost } from '../events/await/psu-pty-discovery';
import {
  respawnedUngradedDrills,
  hasPendingDrillForClass,
  gradedDrillCountForClass,
  pickEligibleHost,
  runColdBootDrillAutorunOnce,
  AUTO_DRILL_CLASSES,
  MAX_DRILLS_BEFORE_GIVEUP,
  type ColdBootDrillAutorunDeps,
} from './cold-boot-drill-autorunner';

const HEADLESS = 'claude-headless';
const INTERACTIVE = 'claude-interactive';

function ev(kind: string, drillId: string, sessionClass = HEADLESS, ownerId = 'su-h1'): ColdBootDrillLedgerEvent {
  return { ts: new Date().toISOString(), kind: kind as ColdBootDrillLedgerEvent['kind'], drillId, ownerId, sessionClass };
}

function host(over: Partial<PsuPtyHost>): PsuPtyHost {
  return {
    ownerId: 'su-h1',
    advSessionId: null,
    pid: 1,
    ptyPid: 1,
    sock: '/tmp/s.sock',
    command: 'psu',
    startedAt: 0,
    bridgeTty: false,
    caps: ['carry-respawn'],
    ...over,
  };
}

// A1 (cold-with-carry-activation-2026-07-20): the runner's target classes must be
// EXACTLY what the live classifier emits, so a drill's grade lands under the class a
// real wake gets (the EI-18133456688790756 mismatch was drills graded under a string
// sessionClassForHost never produces).
describe('A1 class-vocabulary correctness', () => {
  it('AUTO_DRILL_CLASSES matches sessionClassForHost for a headless host', () => {
    expect(sessionClassForHost({ bridgeTty: false })).toBe(HEADLESS);
    expect(AUTO_DRILL_CLASSES).toContain(sessionClassForHost({ bridgeTty: false }));
  });
  it('an interactive host is NOT an auto-drill target (never auto-cut a human)', () => {
    expect(sessionClassForHost({ bridgeTty: true })).toBe(INTERACTIVE);
    expect(AUTO_DRILL_CLASSES).not.toContain(sessionClassForHost({ bridgeTty: true }));
  });
});

describe('respawnedUngradedDrills', () => {
  it('returns respawned drills with no grade / no dead-terminal, deduped', () => {
    const events = [
      ev('carry-drill-respawned', 'd1'),
      ev('carry-drill-carry-delivered', 'd1'),
      ev('carry-drill-respawned', 'd2'),
      ev('carry-drill-graded', 'd2'), // graded ⇒ excluded
      ev('carry-drill-respawned', 'd3'),
      ev('carry-drill-carry-dropped', 'd3'), // dead ⇒ excluded
      ev('carry-drill-respawned', 'd4'),
      ev('carry-drill-respawned', 'd4'), // dup respawn ⇒ one entry
    ];
    const got = respawnedUngradedDrills(events).map((d) => d.drillId).sort();
    expect(got).toEqual(['d1', 'd4']);
    expect(respawnedUngradedDrills(events).find((d) => d.drillId === 'd1')?.ownerId).toBe('su-h1');
  });
  it('a requested-but-never-respawned drill is NOT a grade candidate', () => {
    expect(respawnedUngradedDrills([ev('carry-drill-requested', 'd9')])).toEqual([]);
  });
});

describe('hasPendingDrillForClass', () => {
  it('true while a drill of the class is in flight (respawned, not graded)', () => {
    expect(hasPendingDrillForClass([ev('carry-drill-respawned', 'd1', HEADLESS)], HEADLESS)).toBe(true);
  });
  it('false once the in-flight drill graded', () => {
    const events = [ev('carry-drill-queued', 'd1', HEADLESS), ev('carry-drill-graded', 'd1', HEADLESS)];
    expect(hasPendingDrillForClass(events, HEADLESS)).toBe(false);
  });
  it('false once the in-flight drill dropped', () => {
    const events = [ev('carry-drill-respawned', 'd1', HEADLESS), ev('carry-drill-carry-dropped', 'd1', HEADLESS)];
    expect(hasPendingDrillForClass(events, HEADLESS)).toBe(false);
  });
  it('ignores other classes', () => {
    expect(hasPendingDrillForClass([ev('carry-drill-respawned', 'd1', INTERACTIVE)], HEADLESS)).toBe(false);
  });
});

describe('gradedDrillCountForClass', () => {
  it('counts distinct graded drillIds for the class', () => {
    const events = [
      ev('carry-drill-graded', 'd1', HEADLESS),
      ev('carry-drill-graded', 'd1', HEADLESS), // dup
      ev('carry-drill-graded', 'd2', HEADLESS),
      ev('carry-drill-graded', 'd3', INTERACTIVE), // other class
    ];
    expect(gradedDrillCountForClass(events, HEADLESS)).toBe(2);
  });
});

describe('pickEligibleHost', () => {
  it('picks a headless carry-respawn-capable host of the class, most-idle first', () => {
    const busy = host({ ownerId: 'busy', lastActivityAt: 1000 });
    const idle = host({ ownerId: 'idle', lastActivityAt: 10 });
    const got = pickEligibleHost([busy, idle], HEADLESS);
    expect(got?.ownerId).toBe('idle');
  });
  it('excludes an interactive host (bridgeTty true) — never auto-cut a human', () => {
    expect(pickEligibleHost([host({ bridgeTty: true })], HEADLESS)).toBeNull();
  });
  it('excludes a host without the carry-respawn capability', () => {
    expect(pickEligibleHost([host({ caps: [] })], HEADLESS)).toBeNull();
  });
  it('never picks a protected (goal-holder) owner, even when it is the most idle — WI-10005559', () => {
    const holder = host({ ownerId: 'su-goal-holder', lastActivityAt: 1 });
    const other = host({ ownerId: 'su-plain', lastActivityAt: 500 });
    expect(pickEligibleHost([holder, other], HEADLESS, new Set(['su-goal-holder']))?.ownerId).toBe('su-plain');
    expect(pickEligibleHost([holder], HEADLESS, new Set(['su-goal-holder']))).toBeNull();
  });
  it('null when no host matches the class', () => {
    // a headless host classifies as claude-headless, never claude-interactive
    expect(pickEligibleHost([host({ bridgeTty: false })], INTERACTIVE)).toBeNull();
  });
});

function deps(over: Partial<ColdBootDrillAutorunDeps>): Partial<ColdBootDrillAutorunDeps> {
  return {
    readLedger: async () => [],
    report: async () => ({ perClass: [], params: { minDrills: 1, maxGapsPerDrill: 0 } as never, sufficientClasses: [], terminalOutcomes: [] }),
    listHosts: () => [],
    startDrill: async () => ({ ok: true, drillId: 'new-drill', sessionClass: HEADLESS, queued: true, nextAllowedAt: '' }),
    gradeDrill: async () => ({ ok: true, drillId: 'g', sample: { sessionClass: HEADLESS, lookups: [] }, report: { perClass: [], params: {} as never, sufficientClasses: [], terminalOutcomes: [] }, transcriptPath: '', alreadyGraded: false }),
    listProtectedOwners: async () => new Set<string>(),
    flagEnabled: async () => true,
    now: () => 0,
    ...over,
  };
}

describe('runColdBootDrillAutorunOnce', () => {
  it('flag OFF ⇒ skipped, no grade, no start', async () => {
    const startDrill = vi.fn();
    const r = await runColdBootDrillAutorunOnce(deps({ flagEnabled: async () => false, startDrill }));
    expect(r.skipped).toBe(true);
    expect(startDrill).not.toHaveBeenCalled();
  });

  it('grades a respawned-ungraded drill AND starts one on an eligible headless host when unproven', async () => {
    // A MUTABLE ledger: grading appends a graded row (as the real gradeColdBootDrill
    // does), so the runner's post-grade re-read no longer sees d1 as in-flight.
    const ledger: ColdBootDrillLedgerEvent[] = [ev('carry-drill-respawned', 'd1', HEADLESS, 'su-old')];
    const startDrill = vi.fn(async () => ({ ok: true as const, drillId: 'nd', sessionClass: HEADLESS, queued: true as const, nextAllowedAt: '' }));
    const gradeDrill = vi.fn(async (ownerId: string, drillId: string) => {
      ledger.push(ev('carry-drill-graded', drillId, HEADLESS, ownerId));
      return { ok: true as const, drillId, sample: { sessionClass: HEADLESS, lookups: [] }, report: { perClass: [], params: {} as never, sufficientClasses: [], terminalOutcomes: [] }, transcriptPath: '', alreadyGraded: false };
    });
    const r = await runColdBootDrillAutorunOnce(
      deps({
        readLedger: async () => [...ledger],
        report: async () => ({ perClass: [], params: {} as never, sufficientClasses: [], terminalOutcomes: [] }),
        listHosts: () => [host({ ownerId: 'su-h1' })],
        startDrill,
        gradeDrill,
      }),
    );
    expect(r.skipped).toBe(false);
    expect(gradeDrill).toHaveBeenCalledWith('su-old', 'd1');
    expect(r.graded).toEqual(['d1']);
    expect(startDrill).toHaveBeenCalledTimes(1);
    expect(r.started).toEqual([{ sessionClass: HEADLESS, ownerId: 'su-h1', drillId: 'nd' }]);
  });

  it('does NOT start when the class is already proven', async () => {
    const startDrill = vi.fn();
    const r = await runColdBootDrillAutorunOnce(
      deps({
        report: async () => ({ perClass: [], params: {} as never, sufficientClasses: [HEADLESS], terminalOutcomes: [] }),
        listHosts: () => [host({})],
        startDrill,
      }),
    );
    expect(startDrill).not.toHaveBeenCalled();
    expect(r.proven).toEqual([HEADLESS]);
  });

  it('does NOT start when a drill for the class is already in flight', async () => {
    const startDrill = vi.fn();
    const r = await runColdBootDrillAutorunOnce(
      deps({
        readLedger: async () => [ev('carry-drill-queued', 'inflight', HEADLESS)],
        listHosts: () => [host({})],
        startDrill,
      }),
    );
    expect(startDrill).not.toHaveBeenCalled();
    expect(r.skippedClasses).toContainEqual({ sessionClass: HEADLESS, reason: 'drill-in-flight' });
  });

  it('gives up after MAX_DRILLS_BEFORE_GIVEUP graded-but-insufficient drills', async () => {
    const startDrill = vi.fn();
    const ledger = Array.from({ length: MAX_DRILLS_BEFORE_GIVEUP }, (_, i) => ev('carry-drill-graded', `g${i}`, HEADLESS));
    const r = await runColdBootDrillAutorunOnce(
      deps({ readLedger: async () => ledger, listHosts: () => [host({})], startDrill }),
    );
    expect(startDrill).not.toHaveBeenCalled();
    expect(r.skippedClasses).toContainEqual({ sessionClass: HEADLESS, reason: 'gave-up-carry-insufficient' });
  });

  it('skips with no-eligible-headless-host when only interactive hosts exist', async () => {
    const startDrill = vi.fn();
    const r = await runColdBootDrillAutorunOnce(
      deps({ listHosts: () => [host({ bridgeTty: true })], startDrill }),
    );
    expect(startDrill).not.toHaveBeenCalled();
    expect(r.skippedClasses).toContainEqual({ sessionClass: HEADLESS, reason: 'no-eligible-headless-host' });
  });

  it('does not drill a goal holder: the only headless host is protected ⇒ no start (WI-10005559)', async () => {
    const startDrill = vi.fn();
    const r = await runColdBootDrillAutorunOnce(
      deps({
        listHosts: () => [host({ ownerId: 'su-goal-holder' })],
        listProtectedOwners: async () => new Set(['su-goal-holder']),
        startDrill,
      }),
    );
    expect(startDrill).not.toHaveBeenCalled();
    expect(r.skippedClasses).toContainEqual({ sessionClass: HEADLESS, reason: 'no-eligible-headless-host' });
  });

  it('drills an unprotected host when a goal holder is also eligible', async () => {
    const startDrill = vi.fn(async () => ({ ok: true as const, drillId: 'nd', sessionClass: HEADLESS, queued: true as const, nextAllowedAt: '' }));
    await runColdBootDrillAutorunOnce(
      deps({
        listHosts: () => [host({ ownerId: 'su-goal-holder', lastActivityAt: 1 }), host({ ownerId: 'su-plain', lastActivityAt: 9 })],
        listProtectedOwners: async () => new Set(['su-goal-holder']),
        startDrill,
      }),
    );
    expect(startDrill).toHaveBeenCalledTimes(1);
    expect(startDrill).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-plain' }));
  });

  it('fails CLOSED when the protected-owner read throws: no drill this pass', async () => {
    const startDrill = vi.fn();
    const r = await runColdBootDrillAutorunOnce(
      deps({
        listHosts: () => [host({ ownerId: 'su-plain' })],
        listProtectedOwners: async () => {
          throw new Error('pg down');
        },
        startDrill,
      }),
    );
    expect(startDrill).not.toHaveBeenCalled();
    expect(r.skippedClasses).toContainEqual({ sessionClass: HEADLESS, reason: 'protected-owner-read-failed:pg down' });
  });
});

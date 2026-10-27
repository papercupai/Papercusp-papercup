import { isDeepStrictEqual } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const escalations = vi.hoisted(() => ({ openEscalation: vi.fn(async () => ({ ok: true })) }));
vi.mock('../agent-tools/coordination/escalations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/escalations')>()),
  openEscalation: escalations.openEscalation,
}));
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'ws-park-recheck-test',
}));

import type { ExternalConditionReachability } from '../external-condition-reachability';
import { assertHoldRegistered } from '../hold-registry';
import {
  backfillUnprovableParkRecheckDates,
  defaultDurableParkRecheckDeps,
  sweepDueParkRechecks,
  UNPROVABLE_PARK_RECHECK_ACTOR,
  type DurableParkRecheckDeps,
  type ParkRecheckCandidate,
} from './durable-park-recheck';

const NOW = new Date('2026-10-27T20:00:00.000Z');
const DAY_MS = assertHoldRegistered('park', 'park').recheckSec * 1000;

const at = (iso: string) => iso;
const uncertified = (reason: 'broad' | 'uncatalogued' | 'change-notification'): ExternalConditionReachability => ({
  verdict: 'unknown', basis: 'unmeasured', authoritative: false, evidence: `refused: ${reason}`,
  checkedAt: NOW.toISOString(), uncertifiedReason: reason,
});
const VERDICTS: Record<string, ExternalConditionReachability> = {
  'coord:inbox-wake:su-a': uncertified('broad'),
  'A new coord message from the fleet leader changes scope.': uncertified('uncatalogued'),
  'work-item:status:WI-9': uncertified('change-notification'),
  'conversation:answered:conv-1': {
    verdict: 'reachable', basis: 'live-resolver', authoritative: true, evidence: 'catalogued', checkedAt: NOW.toISOString(),
  },
  'fleet:x:expired-gate': {
    verdict: 'impossible', basis: 'expired-registration', authoritative: true,
    evidence: 'the latest authoritative producer registration expired', checkedAt: NOW.toISOString(),
  },
  'flaky:resolver': {
    verdict: 'unknown', basis: 'unmeasured', authoritative: false, evidence: 'reachability resolver failed: boom',
    checkedAt: NOW.toISOString(),
  },
  // The catalogue's live resolver calls a completion key reachable even when it is the park's own.
  'work-item:done:WI-P7': {
    verdict: 'reachable', basis: 'live-resolver', authoritative: true, evidence: 'catalogued', checkedAt: NOW.toISOString(),
  },
};

interface StoredPark { harness: string; parked: boolean; release: Record<string, unknown> | null; parkedBy: string; parkedAt: string }

function contract(trigger: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    condition: `resume when ${trigger} is satisfied`, owner: 'su-parker', trigger,
    reachability: 'blocked', evidence: 'stamped at park time', ...over,
  };
}

/** An in-memory park store with the production listing and compare-and-set semantics. */
function store(parks: Record<string, StoredPark>, verdicts: Record<string, ExternalConditionReachability> = VERDICTS) {
  const writes: Array<{ id: string; next: Record<string, unknown>; expected: unknown }> = [];
  const escalated: Array<{ id: string; release: Record<string, unknown>; reachability: ExternalConditionReachability }> = [];
  const candidate = (id: string): ParkRecheckCandidate => ({
    id, harness: parks[id]!.harness, release: structuredClone(parks[id]!.release),
    parkedBy: parks[id]!.parkedBy, parkedAt: parks[id]!.parkedAt,
  });
  const ids = () => Object.keys(parks).sort().filter((id) => parks[id]!.parked && parks[id]!.release);
  const classify = vi.fn(async (trigger: string) => verdicts[trigger]!);
  const deps: DurableParkRecheckDeps = {
    listUnstampedParks: async (limit, afterId) => ids()
      .filter((id) => typeof parks[id]!.release!.trigger === 'string' && parks[id]!.release!.recheckAt == null)
      .filter((id) => id > (afterId ?? ''))
      .slice(0, limit).map(candidate),
    listDueParks: async (nowIso, limit) => ids()
      .filter((id) => typeof parks[id]!.release!.recheckAt === 'string' && String(parks[id]!.release!.recheckAt) <= nowIso)
      .slice(0, limit).map(candidate),
    classify,
    writeRelease: async (id, _harness, next, expected) => {
      if (!parks[id]!.parked || !isDeepStrictEqual(parks[id]!.release, expected)) return false;
      writes.push({ id, next: structuredClone(next), expected });
      parks[id]!.release = structuredClone(next);
      return true;
    },
    escalate: vi.fn(async (park, release, reachability) => {
      escalated.push({ id: park.id, release: structuredClone(release), reachability });
    }),
  };
  return { deps, writes, escalated, classify };
}

const park = (release: Record<string, unknown> | null, over: Partial<StoredPark> = {}): StoredPark => ({
  harness: 'papercusp', parked: true, release, parkedBy: 'su-parker', parkedAt: at('2026-10-10T00:00:00.000Z'), ...over,
});

describe('backfillUnprovableParkRecheckDates (WI-6554700010030346, blind review #110 G-5)', () => {
  it('stamps every park no fire can prove, leaves provable parks alone, and changes nothing else', async () => {
    const legacy = contract('coord:inbox-wake:su-a', { legacyNote: 'kept' });
    const parks: Record<string, StoredPark> = {
      'WI-P1': park(legacy),
      'WI-P2': park(contract('A new coord message from the fleet leader changes scope.')),
      'WI-P3': park(contract('work-item:status:WI-9', { reachability: 'reachable' })),
      'WI-P4': park(contract('conversation:answered:conv-1', { reachability: 'reachable' })),
      'WI-P5': park(contract('fleet:x:expired-gate', { reachability: 'unreachable' })),
      'WI-P6': park(contract('flaky:resolver')),
      'WI-P7': park(contract('work-item:done:WI-P7', { reachability: 'reachable' })),
    };
    const { deps, writes, classify } = store(parks);

    const out = await backfillUnprovableParkRecheckDates({ now: NOW, deps });

    expect(out).toMatchObject({
      parks: 7, unprovable: 5, stamped: 5, provable: 1, skipped: { unmeasured: 1 }, nextAfterId: null, truncatedByLimit: false,
    });
    expect(out.byReason).toEqual({
      broad: 1, uncatalogued: 1, 'change-notification': 1, 'expired-registration': 1, contradiction: 1,
    });
    expect(writes.map((w) => w.id).sort()).toEqual(['WI-P1', 'WI-P2', 'WI-P3', 'WI-P5', 'WI-P7']);
    // Compare-and-set against the exact listed contract, preserving unknown fields.
    expect(writes.find((w) => w.id === 'WI-P1')!.expected).toEqual(legacy);
    expect(parks['WI-P1']!.release).toMatchObject({
      ...legacy, recheckAt: NOW.toISOString(), recheckSource: UNPROVABLE_PARK_RECHECK_ACTOR, recheckReason: 'broad',
      recheckReachability: expect.objectContaining({ uncertifiedReason: 'broad' }),
    });
    // The stored reachability/evidence the scheduler and the audit read are untouched, and so are
    // condition/owner/trigger (the fields a durable-park disposition fingerprints).
    expect(parks['WI-P3']!.release).toMatchObject({ reachability: 'reachable', evidence: 'stamped at park time',
      condition: 'resume when work-item:status:WI-9 is satisfied', owner: 'su-parker', trigger: 'work-item:status:WI-9' });
    expect(parks['WI-P7']!.release).toMatchObject({ recheckReason: 'contradiction',
      recheckReachability: expect.objectContaining({ evidence: expect.stringContaining("parked item's own terminal event") }) });
    expect(parks['WI-P4']!.release).not.toHaveProperty('recheckAt');
    expect(parks['WI-P6']!.release).not.toHaveProperty('recheckAt');
    // A contradiction needs no ledger read; an unmeasured read is retried once.
    expect(classify).not.toHaveBeenCalledWith('work-item:done:WI-P7');
    expect(classify.mock.calls.filter(([t]) => t === 'flaky:resolver')).toHaveLength(2);
  });

  it('classifies a shared trigger once per pass', async () => {
    const parks: Record<string, StoredPark> = {
      'WI-A': park(contract('coord:inbox-wake:su-a')),
      'WI-B': park(contract('coord:inbox-wake:su-a')),
      'WI-C': park(contract('coord:inbox-wake:su-a')),
    };
    const { deps, classify } = store(parks);
    expect((await backfillUnprovableParkRecheckDates({ now: NOW, deps })).stamped).toBe(3);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a stamped park is no longer a candidate', async () => {
    const parks: Record<string, StoredPark> = { 'WI-A': park(contract('coord:inbox-wake:su-a')) };
    const { deps, writes } = store(parks);
    await backfillUnprovableParkRecheckDates({ now: NOW, deps });
    const again = await backfillUnprovableParkRecheckDates({ now: new Date(NOW.getTime() + 60_000), deps });
    expect(again).toMatchObject({ parks: 0, stamped: 0 });
    expect(writes).toHaveLength(1);
  });

  it('pages by id so a bounded pass reaches every park even when provable parks sort first', async () => {
    const parks: Record<string, StoredPark> = {
      'WI-01': park(contract('conversation:answered:conv-1', { reachability: 'reachable' })),
      'WI-02': park(contract('conversation:answered:conv-1', { reachability: 'reachable' })),
      'WI-03': park(contract('coord:inbox-wake:su-a')),
    };
    const { deps } = store(parks);
    const first = await backfillUnprovableParkRecheckDates({ now: NOW, limit: 2, deps });
    expect(first).toMatchObject({ parks: 2, stamped: 0, provable: 2, nextAfterId: 'WI-02', truncatedByLimit: true });
    const second = await backfillUnprovableParkRecheckDates({ now: NOW, limit: 2, afterId: first.nextAfterId, deps });
    expect(second).toMatchObject({ parks: 1, stamped: 1, nextAfterId: null, truncatedByLimit: false });
    expect(parks['WI-03']!.release).toHaveProperty('recheckAt', NOW.toISOString());
  });

  it('a dry run counts but writes nothing; a concurrent re-park is a counted lost race', async () => {
    const dryParks: Record<string, StoredPark> = { 'WI-A': park(contract('coord:inbox-wake:su-a')) };
    const dry = store(dryParks);
    expect(await backfillUnprovableParkRecheckDates({ now: NOW, dryRun: true, deps: dry.deps }))
      .toMatchObject({ unprovable: 1, stamped: 0 });
    expect(dry.writes).toHaveLength(0);

    const racedParks: Record<string, StoredPark> = { 'WI-A': park(contract('coord:inbox-wake:su-a')) };
    const raced = store(racedParks);
    const listed = raced.deps.listUnstampedParks;
    raced.deps.listUnstampedParks = async (limit, afterId) => {
      const rows = await listed(limit, afterId);
      racedParks['WI-A']!.release = contract('conversation:answered:conv-1');
      return rows;
    };
    expect(await backfillUnprovableParkRecheckDates({ now: NOW, deps: raced.deps }))
      .toMatchObject({ unprovable: 1, stamped: 0, skipped: { 'lost-race': 1 } });
    expect(racedParks['WI-A']!.release).not.toHaveProperty('recheckAt');
  });
});

describe('sweepDueParkRechecks (WI-6554700010030346)', () => {
  beforeEach(() => escalations.openEscalation.mockClear());

  it('the backfill and the sweep together escalate each unprovable park and re-arm it a day out', async () => {
    const parks: Record<string, StoredPark> = {
      'WI-A': park(contract('coord:inbox-wake:su-a')),
      'WI-B': park(contract('conversation:answered:conv-1', { reachability: 'reachable' })),
    };
    const { deps, escalated } = store(parks);
    await backfillUnprovableParkRecheckDates({ now: NOW, deps });

    const out = await sweepDueParkRechecks({ now: NOW, deps });

    expect(out).toEqual({ examined: 1, escalated: 1, provable: 0, skipped: {}, truncatedByLimit: false });
    expect(escalated.map((e) => e.id)).toEqual(['WI-A']);
    expect(escalated[0]!.release.recheckAt).toBe(NOW.toISOString());
    expect(parks['WI-A']!.release).toMatchObject({
      trigger: 'coord:inbox-wake:su-a', reachability: 'blocked',
      recheckAt: new Date(NOW.getTime() + DAY_MS).toISOString(), recheckedAt: NOW.toISOString(),
      recheckDisposition: 'escalated',
    });
    // Not due again until the re-armed date; due again once it passes.
    expect((await sweepDueParkRechecks({ now: new Date(NOW.getTime() + DAY_MS - 1), deps })).examined).toBe(0);
    expect((await sweepDueParkRechecks({ now: new Date(NOW.getTime() + DAY_MS), deps })).escalated).toBe(1);
    expect(escalated).toHaveLength(2);
  });

  it('a failed escalation leaves the park due for the next tick instead of deferring it', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const parks: Record<string, StoredPark> = {
        'WI-A': park(contract('coord:inbox-wake:su-a', { recheckAt: NOW.toISOString() })),
      };
      const { deps, writes } = store(parks);
      deps.escalate = vi.fn(async () => { throw new Error('escalation store down'); });
      expect(await sweepDueParkRechecks({ now: NOW, deps }))
        .toMatchObject({ examined: 1, escalated: 0, skipped: { 'read-failed': 1 } });
      expect(writes).toHaveLength(0);
      expect(parks['WI-A']!.release!.recheckAt).toBe(NOW.toISOString());
    } finally {
      warning.mockRestore();
    }
  });

  it('drops the date, without escalating, once the trigger has become provable', async () => {
    const parks: Record<string, StoredPark> = {
      'WI-A': park(contract('conversation:answered:conv-1', {
        recheckAt: NOW.toISOString(), recheckSource: UNPROVABLE_PARK_RECHECK_ACTOR, recheckReason: 'uncatalogued',
      })),
    };
    const { deps, escalated } = store(parks);
    expect(await sweepDueParkRechecks({ now: NOW, deps })).toMatchObject({ examined: 1, provable: 1, escalated: 0 });
    expect(escalated).toHaveLength(0);
    expect(parks['WI-A']!.release).not.toHaveProperty('recheckAt');
    expect(parks['WI-A']!.release).not.toHaveProperty('recheckReason');
    expect(parks['WI-A']!.release).toMatchObject({ recheckDisposition: 'provable', recheckedAt: NOW.toISOString() });
  });

  it('a cleared park is never escalated', async () => {
    const parks: Record<string, StoredPark> = {
      'WI-A': park(contract('coord:inbox-wake:su-a', { recheckAt: NOW.toISOString() }), { parked: false }),
    };
    const { deps, escalated } = store(parks);
    expect((await sweepDueParkRechecks({ now: NOW, deps })).examined).toBe(0);
    expect(escalated).toHaveLength(0);
  });

  it('the production escalation names the park, its owner, the next action, and a per-item subject', async () => {
    await defaultDurableParkRecheckDeps.escalate(
      { id: 'WI-A', harness: 'papercusp', release: null, parkedBy: 'su-parker', parkedAt: '2026-10-10T00:00:00.000Z' },
      contract('coord:inbox-wake:su-a', { recheckAt: NOW.toISOString() }),
      uncertified('broad'),
    );
    expect(escalations.openEscalation).toHaveBeenCalledOnce();
    const [caller, input] = escalations.openEscalation.mock.calls[0] as unknown as [
      { ownerId: string; workspaceId: string },
      { severity: string; summary: string; body: string; harness_slug: string; meta: { subjectSignature: string } },
    ];
    expect(caller).toMatchObject({ ownerId: UNPROVABLE_PARK_RECHECK_ACTOR, workspaceId: 'ws-park-recheck-test' });
    expect(input).toMatchObject({
      severity: 'advisory', harness_slug: 'papercusp', meta: { subjectSignature: 'park-recheck:papercusp:WI-A' },
    });
    expect(input.body).toContain('Trigger: coord:inbox-wake:su-a.');
    expect(input.body).toContain('Owner: su-parker; parked by su-parker');
    expect(input.body).toContain('work_items:release { claimHold:false }');
  });
});

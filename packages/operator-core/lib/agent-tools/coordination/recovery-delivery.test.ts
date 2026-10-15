import { describe, expect, it } from 'vitest';
import type { CompactionRecovery } from './compaction-recovery';
import {
  applyCarryDeliveredStubs,
  carryDeliveryStillInContext,
  digestRecoveryLegs,
  recordRecoveryDelivery,
  stubCarryDeliveredLegs,
  type RecoveryDeliveryRecord,
} from './recovery-delivery';

const BUILT_AT = '2026-10-13T15:00:00.000Z';
const BUMPED_AFTER = '2026-10-13T15:00:05.000Z';
// Real held-item excerpts are 400-650 chars (carry document, 2026-10-13); the stub only pays off at that size.
const CP_ONE = '## Did\ncheckpoint one '.repeat(20);
const CP_TWO = '## Did\ncheckpoint two '.repeat(20);

function recovery(overrides: Partial<CompactionRecovery> = {}): CompactionRecovery {
  return {
    selfRecall: 'sessions:search { session:"self" }',
    coverage: { selfSession: true, control: true, heldItems: true, planAuthority: true, staleness: null },
    planAuthority: {
      resolution: 'current',
      controlGeneration: 45,
      workspaceId: 'ws',
      harness: 'papercusp',
      planSlug: 'demo-plan',
      version: 15,
      contentHash: 'abc',
      planStatus: 'draft',
      decisions: [
        { id: 'D-001', title: 'first', body: 'x'.repeat(600), truncated: true },
        { id: 'D-002', title: 'second', body: 'short body', truncated: false },
      ],
      items: [{ id: 'P-006', status: 'todo', text: 'item text', missing: false }],
      specs: [],
    },
    checkpoints: [
      { id: 'WI-1', harness: 'papercusp', title: 'one', body: 'desc one', checkpoint: CP_ONE },
      { id: 'WI-2', harness: 'papercusp', title: 'two', checkpoint: CP_TWO, checkpointTruncated: { shownChars: 10, totalChars: 99, more: 'x' } as never },
      { id: 'WI-3', harness: 'papercusp', checkpoint: null, ownershipWarning: 'not yours' },
    ],
    ...overrides,
  };
}

function recordFor(r: CompactionRecovery, buildEpoch = 70): RecoveryDeliveryRecord {
  return { v: 1, builtAt: BUILT_AT, buildEpoch, ...digestRecoveryLegs(r) };
}

const ONE_BUMP_AFTER = { epoch: 71, bumpedAt: BUMPED_AFTER };

describe('carryDeliveryStillInContext — D-006 epoch guard', () => {
  const rec = recordFor(recovery());

  it('trusts the record across exactly one bump that happened after the build', () => {
    expect(carryDeliveryStillInContext(rec, ONE_BUMP_AFTER)).toBe(true);
  });

  it('rejects when no bump happened (the respawn never landed; old context never saw the carry)', () => {
    expect(carryDeliveryStillInContext(rec, { epoch: 70, bumpedAt: '2026-10-13T14:00:00.000Z' })).toBe(false);
  });

  it('rejects a second bump (a later wipe with no new carry document)', () => {
    expect(carryDeliveryStillInContext(rec, { epoch: 72, bumpedAt: '2026-10-13T16:00:00.000Z' })).toBe(false);
  });

  it('rejects a bump older than the build even when the count matches', () => {
    expect(carryDeliveryStillInContext(rec, { epoch: 71, bumpedAt: '2026-10-13T14:59:00.000Z' })).toBe(false);
  });

  it('rejects missing data and an unknown record version', () => {
    expect(carryDeliveryStillInContext(null, ONE_BUMP_AFTER)).toBe(false);
    expect(carryDeliveryStillInContext(rec, null)).toBe(false);
    expect(carryDeliveryStillInContext({ ...rec, v: 2 as never }, ONE_BUMP_AFTER)).toBe(false);
  });
});

describe('stubCarryDeliveredLegs — D-006', () => {
  it('empties decision bodies and replaces unchanged checkpoints with a re-fetch pointer', () => {
    const live = recovery();
    const { recovery: out, stubbed } = stubCarryDeliveredLegs(live, recordFor(live), ONE_BUMP_AFTER);

    expect(stubbed).toEqual(['planAuthority.decisions', 'checkpoints:WI-1', 'checkpoints:WI-2']);
    const pa = out.planAuthority;
    expect(pa?.resolution).toBe('current');
    if (pa?.resolution !== 'current') throw new Error('unreachable');
    expect(pa.decisions.map((d) => [d.id, d.title, d.body])).toEqual([
      ['D-001', 'first', ''],
      ['D-002', 'second', ''],
    ]);
    // Revision, item state and spec identity stay: they are the authority, and small.
    expect(pa.version).toBe(15);
    expect(pa.items[0]).toEqual({ id: 'P-006', status: 'todo', text: 'item text', missing: false });
    expect(pa.deliveredInCarry?.refetch).toContain("plans:get { slug: 'demo-plan', harness: 'papercusp'");

    const [one, two, three] = out.checkpoints!;
    expect(one.checkpoint).toContain('unchanged since your carry document');
    expect(one.checkpoint).toContain('WI-1');
    expect(one.body).toBe('desc one'); // the carry document does not render bodies
    expect(two.checkpointTruncated).toBeUndefined();
    // Ownership warnings are never stubbed.
    expect(three).toEqual(live.checkpoints![2]);
    // The input is not mutated.
    expect(live.checkpoints![0].checkpoint).toBe(CP_ONE);
  });

  it('delivers a changed leg in full', () => {
    const delivered = recovery();
    const record = recordFor(delivered);
    const live = recovery({
      checkpoints: [
        { id: 'WI-1', harness: 'papercusp', checkpoint: `NEW ${CP_ONE}` },
        { id: 'WI-2', harness: 'papercusp', checkpoint: CP_TWO },
      ],
    });
    if (live.planAuthority?.resolution === 'current') live.planAuthority = { ...live.planAuthority, version: 16 };

    const { recovery: out, stubbed } = stubCarryDeliveredLegs(live, record, ONE_BUMP_AFTER);
    expect(stubbed).toEqual(['checkpoints:WI-2']);
    expect(out.checkpoints![0].checkpoint).toBe(`NEW ${CP_ONE}`);
    expect(out.planAuthority).toBe(live.planAuthority);
  });

  it('returns the input untouched when the carry is not provably in context', () => {
    const live = recovery();
    const result = stubCarryDeliveredLegs(live, recordFor(live), { epoch: 72, bumpedAt: BUMPED_AFTER });
    expect(result.recovery).toBe(live);
    expect(result.stubbed).toEqual([]);
  });

  it('cuts the measured size of both legs', () => {
    const live = recovery();
    const before = JSON.stringify(live).length;
    const after = JSON.stringify(stubCarryDeliveredLegs(live, recordFor(live), ONE_BUMP_AFTER).recovery).length;
    expect(after).toBeLessThan(before - 500);
  });

  it('never replaces a leg with a pointer larger than what it replaces', () => {
    const live = recovery({
      checkpoints: [{ id: 'WI-1', harness: 'papercusp', checkpoint: 'short' }],
    });
    if (live.planAuthority?.resolution === 'current') {
      live.planAuthority = {
        ...live.planAuthority,
        decisions: [{ id: 'D-001', title: 'first', body: 'tiny', truncated: false }],
      };
    }
    const result = stubCarryDeliveredLegs(live, recordFor(live), ONE_BUMP_AFTER);
    expect(result.stubbed).toEqual([]);
    expect(result.recovery).toBe(live);
  });

  it('never grows serialized plan authority at the pointer boundary', () => {
    for (let size = 1; size <= 512; size++) {
      const live = recovery({ checkpoints: [] });
      if (live.planAuthority?.resolution !== 'current') throw new Error('unreachable');
      live.planAuthority.decisions = [{ id: 'D-001', title: 'first', body: 'x'.repeat(size), truncated: false }];
      const out = stubCarryDeliveredLegs(live, recordFor(live), ONE_BUMP_AFTER).recovery;
      expect(Buffer.byteLength(JSON.stringify(out)), `decision body length ${size}`)
        .toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(live)));
    }
  });

  it('never grows serialized checkpoints at the UTF-8 pointer boundary', () => {
    for (let size = 1; size <= 512; size++) {
      const live = recovery({
        planAuthority: null,
        checkpoints: [{ id: 'WI-1', harness: 'papercusp', checkpoint: 'x'.repeat(size) }],
      });
      const out = stubCarryDeliveredLegs(live, recordFor(live), ONE_BUMP_AFTER).recovery;
      expect(Buffer.byteLength(JSON.stringify(out)), `checkpoint length ${size}`)
        .toBeLessThanOrEqual(Buffer.byteLength(JSON.stringify(live)));
    }
  });
});

describe('record / read seams — D-006', () => {
  it('records the digest with the pre-wipe epoch on the owner session_briefs row', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return [];
    };
    await recordRecoveryDelivery('su-1', recovery(), 70, { sql, now: Date.parse(BUILT_AT) });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('UPDATE harness_shared.session_briefs');
    expect(calls[0].text).toContain('recovery_delivery');
    const record = JSON.parse(calls[0].values[0] as string) as RecoveryDeliveryRecord;
    expect(record).toMatchObject({ v: 1, builtAt: BUILT_AT, buildEpoch: 70, planAuthority: 'papercusp/demo-plan@15:abc' });
    expect(Object.keys(record.checkpoints)).toEqual(['WI-1', 'WI-2']);
    expect(calls[0].values[1]).toBe('su-1');
  });

  it('fails soft: a throwing write or read never throws and delivers in full', async () => {
    const boom = async () => {
      throw new Error('db down');
    };
    await expect(recordRecoveryDelivery('su-1', recovery(), 70, { sql: boom })).resolves.toBeUndefined();
    const live = recovery();
    const result = await applyCarryDeliveredStubs('su-1', live, { sql: boom });
    expect(result.recovery).toBe(live);
    expect(result.stubbed).toEqual([]);
  });

  it('stubs end-to-end from the joined row', async () => {
    const live = recovery();
    const sql = async () => [{ record: recordFor(live), epoch: 71, bumped_at: new Date(BUMPED_AFTER) }];
    const result = await applyCarryDeliveredStubs('su-1', live, { sql });
    expect(result.stubbed).toContain('planAuthority.decisions');
  });
});

/**
 * P-010 (derived-status-not-hand-written-2026-10-12#D-006): derived intent on coord:presence.
 *
 * Drives the same pure path coord:presence takes after its batched reads —
 * selectHeldWorkIntents (the held-work join) → mergeTier1 (the row derivation) →
 * toStableRosterRow (the emitted row) — so each assertion is on what a reader sees.
 * Expected intent strings are written out literally here, never rebuilt with the module.
 */
import { describe, expect, it } from 'vitest';
import {
  DERIVED_INTENT_TITLE_MAX,
  mergeTier1,
  selectHeldWorkIntents,
  type HeldWorkRow,
  type PresenceTier1Joins,
} from './presence-tier1';
import { PLACEHOLDER_INTENT, toStableRosterRow, type RosterRow } from './presence-payload';

const NOW = 1_800_000_000_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const STALE_SEC = 30 * 60;

function heldRow(over: Partial<HeldWorkRow> & { feature_id: string }): HeldWorkRow {
  return {
    taken_by: 'agent-a',
    status: 'wip',
    plan_slug: null,
    item_id: null,
    title: null,
    taken_at: iso(10 * MIN),
    ...over,
  };
}

function baseJoin(held: HeldWorkRow[]): Map<string, PresenceTier1Joins> {
  const heldWork = selectHeldWorkIntents(held).get('agent-a');
  return new Map([
    [
      'agent-a',
      {
        claimedItems: [],
        model: null,
        awaitingEvent: false,
        awaitingEventKey: null,
        awaitingNote: null,
        wakeMode: 'auto',
        ...(heldWork ? { heldWorkIntent: heldWork } : {}),
      },
    ],
  ]);
}

/** The emitted coord:presence row for agent-a. */
function emitted(intent: string | null, intentAgeMs: number | null, held: HeldWorkRow[]) {
  const record = {
    ownerId: 'agent-a',
    lastActiveAt: iso(1 * MIN),
    intent,
    intentDeclaredAt: intentAgeMs == null ? null : iso(intentAgeMs),
  };
  const [merged] = mergeTier1([record], baseJoin(held), NOW, STALE_SEC);
  return toStableRosterRow(merged as unknown as RosterRow);
}

const PLAN_HELD = heldRow({
  feature_id: 'WI-77',
  title: 'Make presence derive intent',
  plan_slug: 'derived-status',
  item_id: 'P-010',
});

describe('AUTO-BAR-R-9: a holding agent with no fresh declared intent reports its held work item as a derived intent', () => {
  it('an EMPTY declaration reports the held item title, id and plan item, marked derived', () => {
    const row = emitted(null, null, [PLAN_HELD]);
    expect(row.intent).toBe('Make presence derive intent (WI-77 · derived-status#P-010)');
    expect(row.intentSource).toBe('derived');
    expect(row.intentDerivedFrom).toEqual({ workItemId: 'WI-77', planItemRef: 'derived-status#P-010' });
  });

  it('the placeholder declaration is not an intent: the held item replaces it instead of reading null', () => {
    const row = emitted(PLACEHOLDER_INTENT, 1 * MIN, [PLAN_HELD]);
    expect(row.intent).toBe('Make presence derive intent (WI-77 · derived-status#P-010)');
    expect(row.intentSource).toBe('derived');
  });

  it('a lifecycle label (a hook name) is not an intent either', () => {
    const row = emitted('PreToolUse:Edit', 1 * MIN, [PLAN_HELD]);
    expect(row.intent).toBe('Make presence derive intent (WI-77 · derived-status#P-010)');
  });

  it('a STALE declaration (older than the threshold) is replaced by the held item', () => {
    const row = emitted('old lane from this morning', 31 * MIN, [PLAN_HELD]);
    expect(row.intent).toBe('Make presence derive intent (WI-77 · derived-status#P-010)');
    expect(row.intentSource).toBe('derived');
  });

  it('a held item with no plan stamp reports title and id only', () => {
    const row = emitted(null, null, [heldRow({ feature_id: 'EI-5', title: 'Fix the flaky probe' })]);
    expect(row.intent).toBe('Fix the flaky probe (EI-5)');
    expect(row.intentDerivedFrom).toEqual({ workItemId: 'EI-5' });
  });

  it('picks the most recently taken NON-TERMINAL held item; a done item never becomes the intent', () => {
    const row = emitted(null, null, [
      heldRow({ feature_id: 'WI-1', title: 'Older work', taken_at: iso(50 * MIN) }),
      heldRow({ feature_id: 'WI-2', title: 'Newer work', taken_at: iso(5 * MIN) }),
      heldRow({ feature_id: 'WI-3', title: 'Finished work', taken_at: iso(1 * MIN), status: 'done' }),
    ]);
    expect(row.intent).toBe('Newer work (WI-2)');
  });

  it('equal taken_at breaks on the larger id, so the derived text is stable across reads', () => {
    const rows = [
      heldRow({ feature_id: 'WI-8', title: 'Eight', taken_at: iso(5 * MIN) }),
      heldRow({ feature_id: 'WI-9', title: 'Nine', taken_at: iso(5 * MIN) }),
    ];
    expect(emitted(null, null, rows).intent).toBe('Nine (WI-9)');
    expect(emitted(null, null, [...rows].reverse()).intent).toBe('Nine (WI-9)');
  });

  it('a long title is clipped so one item cannot bloat the roster', () => {
    const row = emitted(null, null, [heldRow({ feature_id: 'WI-4', title: 'x'.repeat(500) })]);
    expect(row.intent).toBe(`${'x'.repeat(DERIVED_INTENT_TITLE_MAX - 1)}… (WI-4)`);
  });

  it('the derivation input itself never rides the emitted row', () => {
    const row = emitted(null, null, [PLAN_HELD]);
    expect(row).not.toHaveProperty('heldWorkIntent');
  });

  it('holding nothing non-terminal leaves an empty declaration empty (no fabricated intent)', () => {
    const row = emitted(null, null, [heldRow({ feature_id: 'WI-3', title: 'Finished', status: 'done' })]);
    expect(row.intent ?? null).toBeNull();
    expect(row.intentSource).toBeNull();
    expect(row).not.toHaveProperty('intentDerivedFrom');
  });
});

describe('SPEC-P-010: an explicit fresh declared intent wins over the derived one', () => {
  it('a fresh declaration is reported verbatim and marked declared, even while holding work', () => {
    const row = emitted('Reviewing the presence payload', 2 * MIN, [PLAN_HELD]);
    expect(row.intent).toBe('Reviewing the presence payload');
    expect(row.intentSource).toBe('declared');
    expect(row).not.toHaveProperty('intentDerivedFrom');
  });

  it('a declaration exactly AT the threshold is still fresh', () => {
    const row = emitted('Right at the edge', STALE_SEC * 1000, [PLAN_HELD]);
    expect(row.intent).toBe('Right at the edge');
    expect(row.intentSource).toBe('declared');
  });

  it('an unmeasured declaration age counts as fresh: staleness is never asserted without a measurement', () => {
    const row = emitted('Federated-style row with no declared-at', null, [PLAN_HELD]);
    expect(row.intent).toBe('Federated-style row with no declared-at');
    expect(row.intentSource).toBe('declared');
  });
});

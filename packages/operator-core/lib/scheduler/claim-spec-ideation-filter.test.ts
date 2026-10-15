/**
 * Claim-spec `item_class` — exclude or target ideation work-items
 * (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-005, R-10/R-11; EI-18697923246606437).
 *
 * The originating incident: a p2p-release lane's keyword title globs (`*p2p*`, `*federation*`)
 * served Scout product ideas that merely MENTION a lane keyword to an engineering member, twice.
 * No field could fence them out. These tests pin that a lane can now exclude them, a lane can
 * target only them, and the JS leg classifies every payload shape the way FIELD_MAP.item_class's
 * SQL CASE does (the live SQL/JS agreement is pinned by claim-spec-evaluator-parity).
 */
import { describe, expect, it } from 'vitest';
import {
  IDEA_ORIGIN_PAYLOAD_KEY,
  IDEATION_LEDGER_ORIGINS,
  ITEM_CLASS_SQL_TEXT,
  isIdeationLedgerOrigin,
  itemClassOfPayload,
} from '../scout/ideation-origin';
import { FILTERABLE_ITEM_FIELDS, RANKABLE_ITEM_FIELDS, validateClaimSpec, type FilterNode } from './claim-spec';
import { matchesClaimSpecFilter, type ClaimSpecSubject } from './claim-spec-match';

const BASE: ClaimSpecSubject = {
  id: null, title: null, summary: null, kind: 'change', priority: null, tags: [], paths: [], plan: null,
  planItem: [], fleet: null, triageGate: null, itemClass: 'work', age: null, riskTier: null, redundancy: null,
  estCost: null, assignee: null, severity: null, goal: null,
};

function subject(id: string, title: string, payload: unknown): ClaimSpecSubject {
  return { ...BASE, id, title, itemClass: itemClassOfPayload(payload) };
}

// The EI-18697923246606437 reproduction: two Scout ideas that mention lane keywords, beside a
// real engineering item and a su-ideate routed idea (which carries NO sourceRole — only the
// routed-ledger stamp).
const CORPUS = [
  subject('EI-5946', 'auto-synth floors, benign p2p churn — a cluster of false-positive alerts', { sourceRole: 'Scout', ideaLifecycle: { state: 'open' } }),
  subject('EI-7429', 'silently reopened (EI-7422) and out_of_scope-rejected federation', { sourceRole: 'Scout' }),
  subject('WI-1', 'p2p federation handshake drops the second peer', { ideaLifecycle: { state: 'open' } }),
  subject('WI-2', 'federation sync idea: route peers by latency', { [IDEA_ORIGIN_PAYLOAD_KEY]: 'su-ideate' }),
];
const IDEATION_IDS = new Set(['EI-5946', 'EI-7429', 'WI-2']);

const LANE_GLOBS: FilterNode = { any: [{ field: 'title', op: 'glob', value: '*p2p*' }, { field: 'title', op: 'glob', value: '*federation*' }] };
const admitted = (filter: FilterNode) => CORPUS.filter((s) => matchesClaimSpecFilter(s, filter)).map((s) => s.id);

describe('itemClassOfPayload — the JS leg of FIELD_MAP.item_class', () => {
  it.each([
    ['Scout sourceRole', { sourceRole: 'Scout' }, 'ideation'],
    ['su-ideate routed stamp', { ideaOrigin: 'su-ideate' }, 'ideation'],
    ['dream routed stamp', { ideaOrigin: 'dream' }, 'ideation'],
    ['empty-string stamp (SQL ->> yields \'\', not NULL)', { ideaOrigin: '' }, 'ideation'],
    ['object stamp (SQL ->> yields its text)', { ideaOrigin: { x: 1 } }, 'ideation'],
    ['JSON-null stamp (SQL ->> yields NULL)', { ideaOrigin: null }, 'work'],
    ['ideaLifecycle alone is NOT ideation (rides on ~48.6k rows)', { ideaLifecycle: { state: 'open', triageDecision: 'place' } }, 'work'],
    ['system sourceRole', { sourceRole: 'system' }, 'work'],
    ['lower-case scout (SQL = is case-sensitive)', { sourceRole: 'scout' }, 'work'],
    ['empty payload', {}, 'work'],
    ['null payload', null, 'work'],
    ['array payload (SQL ->> on an array yields NULL)', [{ sourceRole: 'Scout' }], 'work'],
    ['scalar payload', 'Scout', 'work'],
  ])('%s → %s', (_label, payload, expected) => {
    expect(itemClassOfPayload(payload)).toBe(expected);
  });

  it('the SQL CASE reads exactly the two markers the JS leg reads, and is never NULL', () => {
    expect(ITEM_CLASS_SQL_TEXT).toContain(`payload->>'sourceRole' = 'Scout'`);
    expect(ITEM_CLASS_SQL_TEXT).toContain(`payload->>'${IDEA_ORIGIN_PAYLOAD_KEY}' IS NOT NULL`);
    expect(ITEM_CLASS_SQL_TEXT).toMatch(/ELSE 'work' END$/);
  });

  it('agent-review / drill / shadow-variant ledger origins are not ideation origins', () => {
    expect([...IDEATION_LEDGER_ORIGINS]).toEqual(['scout', 'su-ideate', 'dream']);
    for (const o of ['agent-review', 'drill', 'shadow-variant', null, undefined]) expect(isIdeationLedgerOrigin(o)).toBe(false);
  });
});

describe('claim-spec item_class filter (R-10 exclude / R-11 target)', () => {
  it('reproduces the incident: keyword globs alone admit the Scout ideas', () => {
    expect(admitted(LANE_GLOBS)).toEqual(['EI-5946', 'EI-7429', 'WI-1', 'WI-2']);
  });

  it('R-10: a claim that excludes ideation returns no ideation-origin item', () => {
    const lane: FilterNode = { all: [LANE_GLOBS, { field: 'item_class', op: '=', value: 'work' }] };
    const ids = admitted(lane);
    expect(ids).toEqual(['WI-1']);
    for (const id of ids) expect(IDEATION_IDS.has(id as string)).toBe(false);
  });

  it('R-10: the negated form excludes identically (two-valued, so no NULL hole)', () => {
    const lane: FilterNode = { all: [LANE_GLOBS, { not: { field: 'item_class', op: '=', value: 'ideation' } }] };
    expect(admitted(lane)).toEqual(['WI-1']);
  });

  it('R-11: a claim that targets ideation returns only ideation-origin items', () => {
    const ids = admitted({ field: 'item_class', op: '=', value: 'ideation' });
    expect(new Set(ids)).toEqual(IDEATION_IDS);
  });

  it('the validator accepts item_class as a filter field and keeps it out of rank', () => {
    expect(FILTERABLE_ITEM_FIELDS).toContain('item_class');
    expect(RANKABLE_ITEM_FIELDS).not.toContain('item_class');
    const v = validateClaimSpec({
      specVersion: '1.0',
      specId: 'p2p-release-lane-no-ideas',
      revision: 1,
      view: { filter: { all: [LANE_GLOBS, { field: 'item_class', op: '=', value: 'work' }] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(v.ok, v.errors.join('; ')).toBe(true);
  });
});

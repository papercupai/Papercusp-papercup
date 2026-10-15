/**
 * P-007 unit tests: consumer evidence for the existing acceptance outcome.
 *
 * Every control here is permanent. The point of the suite is the DISTINCTION
 * between missing evidence and complete verification, so each negative case is a
 * single-element removal/corruption of one shared COMPLETE record that must
 * verify — if the complete record stops verifying, every negative would pass
 * vacuously, so the positive control is asserted first and again per mutation.
 */
import { describe, expect, it } from 'vitest';
import { isForbiddenMandatoryPassRating, isUnknownRatingEquivalent } from '../agent-tools/plans/rubric-template';
import {
  CONSUMER_EVIDENCE_METHOD,
  CONSUMER_EVIDENCE_METHOD_TERMS,
  consumerEvidenceRecordSchema,
  evaluateConsumerEvidence,
  gateConsumerRating,
  type ConsumerEvidenceGap,
  type ConsumerEvidenceRecord,
} from './consumer-evidence';

const INDEX = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

/** A COMPLETE, verified record: one corroborated consumer, identities bound, behavior + tests + fallback. */
function complete(): ConsumerEvidenceRecord {
  return {
    schemaVersion: 1,
    subject: { symbol: 'getNextWorkItem', path: 'packages/operator-core/lib/scheduler/get-next.ts', change: 'signature' },
    identity: { indexRevision: INDEX, sourceRevision: INDEX },
    graph: { invoked: true, outcome: 'graph-used', unverifiedSiteCount: 0 },
    consumers: [{ path: 'packages/operator-core/lib/scheduler/claim-spec-store.ts', line1: 548, corroboratedBy: 'source-read' }],
    absenceSweeps: [],
    behavior: { checked: ['claim spec still resolves the next item'], notChecked: [] },
    tests: [{ path: 'packages/operator-core/lib/scheduler/get-next.test.ts', result: 'pass' }],
    fallback: { route: 'lsp', used: false, reason: null },
  };
}

function gapsOf(record: unknown): ConsumerEvidenceGap[] {
  return evaluateConsumerEvidence(record).gaps.map((g) => g.gap);
}

describe('evaluateConsumerEvidence — positive control', () => {
  it('a complete record verifies with zero gaps', () => {
    expect(evaluateConsumerEvidence(complete())).toEqual({ verdict: 'verified', gaps: [] });
  });

  it('a prefix of the same commit is the same revision; a different commit is not', () => {
    const r = complete();
    r.identity.sourceRevision = INDEX.slice(0, 12);
    expect(evaluateConsumerEvidence(r).verdict).toBe('verified');
    r.identity.sourceRevision = OTHER;
    expect(gapsOf(r)).toEqual(['index-source-mismatch']);
  });
});

describe('invocation-only and empty-graph negative cases (GN-CONSUMER-ACCEPTANCE)', () => {
  it('a graph INVOCATION with no consumers and no independent sweep is not evidence', () => {
    const r = complete();
    r.consumers = [];
    const e = evaluateConsumerEvidence(r);
    expect(e.verdict).toBe('unverified');
    expect(e.gaps.map((g) => g.gap)).toContain('graph-invocation-only');
  });

  it('ZERO callers from the graph alone (graph-empty) is not evidence of absence', () => {
    const r = complete();
    r.consumers = [];
    r.graph = { invoked: true, outcome: 'graph-empty', unverifiedSiteCount: 0 };
    expect(gapsOf(r)).toContain('graph-invocation-only');
    expect(evaluateConsumerEvidence(r).verdict).not.toBe('verified');
  });

  it('...but zero callers WITH an independent non-graph sweep that also found none verifies', () => {
    const r = complete();
    r.consumers = [];
    r.graph = { invoked: true, outcome: 'graph-empty', unverifiedSiteCount: 0 };
    r.absenceSweeps = [{ route: 'rg', query: 'getNextWorkItem', matches: 0 }];
    expect(evaluateConsumerEvidence(r)).toEqual({ verdict: 'verified', gaps: [] });
  });

  it('an empty graph answer CONTRADICTED by an independent sweep is incomplete, not verified', () => {
    const r = complete();
    r.consumers = [];
    r.graph = { invoked: true, outcome: 'graph-empty', unverifiedSiteCount: 0 };
    r.absenceSweeps = [{ route: 'rg', query: 'getNextWorkItem', matches: 3 }];
    expect(gapsOf(r)).toContain('sweep-contradicts-graph');
    expect(evaluateConsumerEvidence(r).verdict).toBe('unverified');
  });

  it('graph-only consumers that no source read confirmed do not count', () => {
    const r = complete();
    r.consumers = [{ path: 'packages/a/b.ts', line1: 3, corroboratedBy: null }];
    expect(gapsOf(r)).toEqual(expect.arrayContaining(['graph-invocation-only', 'consumers-uncorroborated']));
    expect(evaluateConsumerEvidence(r).verdict).toBe('unverified');
  });

  it('one uncorroborated consumer among corroborated ones still leaves the set unverified', () => {
    const r = complete();
    r.consumers.push({ path: 'packages/a/b.ts', line1: 3, corroboratedBy: null });
    expect(gapsOf(r)).toEqual(['consumers-uncorroborated']);
  });

  it('with the graph never invoked and nothing else, consumers are simply unresolved', () => {
    const r = complete();
    r.consumers = [];
    r.graph = { invoked: false, outcome: 'not-invoked', unverifiedSiteCount: 0 };
    expect(gapsOf(r)).toContain('consumers-not-resolved');
  });
});

describe('identity, backend, behavior, tests, fallback — each missing element is nonpassing', () => {
  const mutations: Array<[string, (r: ConsumerEvidenceRecord) => void, ConsumerEvidenceGap]> = [
    ['index revision missing', (r) => (r.identity.indexRevision = null), 'identity-unbound'],
    ['source revision missing', (r) => (r.identity.sourceRevision = null), 'identity-unbound'],
    ['index behind source', (r) => (r.identity.indexRevision = OTHER), 'index-source-mismatch'],
    ['no behavior checked', (r) => (r.behavior.checked = []), 'behavior-unchecked'],
    ['some behavior declared NOT checked', (r) => r.behavior.notChecked.push('error path of callers'), 'behavior-partially-unchecked'],
    ['no tests recorded', (r) => (r.tests = []), 'tests-missing'],
    ['a recorded test was not run', (r) => r.tests.push({ path: 'x.test.ts', result: 'not-run' }), 'tests-not-run'],
    ['fallback route undeclared', (r) => (r.fallback.route = null), 'fallback-undeclared'],
    [
      'graph failed and the existing route was not used',
      (r) => {
        r.graph.outcome = 'graph-failed';
      },
      'graph-unusable-uncompensated',
    ],
  ];

  for (const [label, mutate, gap] of mutations) {
    it(`${label} -> ${gap}; the complete record it was derived from verifies`, () => {
      expect(evaluateConsumerEvidence(complete()).verdict).toBe('verified');
      const r = complete();
      mutate(r);
      const e = evaluateConsumerEvidence(r);
      expect(e.verdict).toBe('unverified');
      expect(e.gaps.map((g) => g.gap)).toContain(gap);
    });
  }

  it('a failing recorded test is FAILED, not merely unknown', () => {
    const r = complete();
    r.tests.push({ path: 'broken.test.ts', result: 'fail' });
    const e = evaluateConsumerEvidence(r);
    expect(e.verdict).toBe('failed');
    expect(e.gaps.map((g) => g.gap)).toContain('tests-failing');
  });

  it('a graph failure compensated by the existing route and an independent sweep verifies', () => {
    const r = complete();
    r.consumers = [];
    r.graph = { invoked: true, outcome: 'graph-failed', unverifiedSiteCount: 0 };
    r.fallback = { route: 'rg', used: true, reason: 'graph timed out' };
    r.absenceSweeps = [{ route: 'rg', query: 'getNextWorkItem', matches: 0 }];
    expect(evaluateConsumerEvidence(r)).toEqual({ verdict: 'verified', gaps: [] });
  });
});

describe('a stored record is validated, never trusted', () => {
  it('malformed input is record-invalid (unverified), never a throw', () => {
    for (const bad of [null, undefined, 'consumer evidence', 42, {}, { schemaVersion: 2 }, { ...complete(), extra: true }]) {
      const e = evaluateConsumerEvidence(bad);
      expect(e.verdict).toBe('unverified');
      expect(e.gaps.map((g) => g.gap)).toEqual(['record-invalid']);
    }
  });

  it('every top-level element is individually REQUIRED by the schema', () => {
    for (const key of Object.keys(complete())) {
      const r: Record<string, unknown> = { ...complete() };
      delete r[key];
      expect(evaluateConsumerEvidence(r).gaps.map((g) => g.gap), `without ${key}`).toEqual(['record-invalid']);
    }
  });
});

describe('gateConsumerRating — the EXISTING outcome stays nonpassing', () => {
  const ratingScale = ['healthy — evidence establishes the outcome', 'degraded', 'broken', 'unknown — evidence does not establish an outcome'];
  const passRatings = ['healthy'];
  const gate = (record: unknown, proposedRating = 'healthy', scale: readonly string[] = ratingScale) =>
    gateConsumerRating({ proposedRating, passRatings, ratingScale: scale, record });

  it('verified evidence leaves a passing rating untouched', () => {
    expect(gate(complete())).toMatchObject({ rating: 'healthy', downgraded: false });
  });

  it('unverified evidence downgrades a pass to the scale\'s unknown label, which cannot satisfy a mandatory BAR', () => {
    const r = complete();
    r.consumers = [];
    const g = gate(r);
    expect(g.downgraded).toBe(true);
    expect(g.rating).toBe('unknown — evidence does not establish an outcome');
    expect(isUnknownRatingEquivalent(g.rating!)).toBe(true);
    // The existing guard resolves a scale entry by its LEADING label (an inline definition
    // such as "unknown — …" is not itself a token), so judge the label the card would carry.
    expect(isForbiddenMandatoryPassRating(g.rating!.split(' — ')[0]!)).toBe(true);
  });

  it('failed evidence downgrades a pass to the scale\'s failure label', () => {
    const r = complete();
    r.tests = [{ path: 'x.test.ts', result: 'fail' }];
    expect(gate(r).rating).toBe('broken');
  });

  it('falls back to unknown when a failed record has no failure label in the scale', () => {
    const r = complete();
    r.tests = [{ path: 'x.test.ts', result: 'fail' }];
    expect(gate(r, 'healthy', ['healthy', 'unknown']).rating).toBe('unknown');
  });

  it('refuses (null) when the scale has no honest nonpassing label at all', () => {
    const r = complete();
    r.consumers = [];
    const g = gate(r, 'healthy', ['healthy']);
    expect(g.rating).toBeNull();
    expect(g.downgraded).toBe(true);
  });

  it('only ever moves a rating DOWN: an unknown or failing proposal is never upgraded', () => {
    expect(gate(complete(), 'unknown')).toMatchObject({ rating: 'unknown', downgraded: false });
    const r = complete();
    r.consumers = [];
    expect(gate(r, 'broken')).toMatchObject({ rating: 'broken', downgraded: false });
  });

  it('a record that is not even valid cannot sustain a pass', () => {
    expect(gate({ not: 'a record' })).toMatchObject({
      downgraded: true,
      rating: 'unknown — evidence does not establish an outcome',
    });
  });

  it('every single-element corruption of the complete record loses the pass', () => {
    const corrupt: Array<(r: ConsumerEvidenceRecord) => void> = [
      (r) => (r.identity.indexRevision = null),
      (r) => (r.identity.sourceRevision = OTHER),
      (r) => (r.consumers = []),
      (r) => (r.consumers[0]!.corroboratedBy = null),
      (r) => (r.behavior.checked = []),
      (r) => r.behavior.notChecked.push('x'),
      (r) => (r.tests = []),
      (r) => (r.fallback.route = null),
    ];
    for (const [i, mutate] of corrupt.entries()) {
      expect(gate(complete()).downgraded, 'control').toBe(false);
      const r = complete();
      mutate(r);
      expect(gate(r).downgraded, `mutation ${i}`).toBe(true);
    }
  });
});

describe('the code-owned METHOD text', () => {
  it('names every element of the record contract', () => {
    const method = CONSUMER_EVIDENCE_METHOD.toLowerCase();
    for (const term of CONSUMER_EVIDENCE_METHOD_TERMS) expect(method, term).toContain(term);
  });

  it('states that neither a graph invocation nor zero callers satisfies the outcome', () => {
    expect(CONSUMER_EVIDENCE_METHOD).toMatch(/graph invocation, or zero callers from the graph alone, does not satisfy/);
  });

  it('the record schema carries exactly the elements the METHOD names', () => {
    expect(Object.keys(consumerEvidenceRecordSchema.shape).sort()).toEqual(
      ['absenceSweeps', 'behavior', 'consumers', 'fallback', 'graph', 'identity', 'schemaVersion', 'subject', 'tests'],
    );
  });
});

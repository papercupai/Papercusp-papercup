/**
 * WI-6554700010008923 — `scheduler:get_next` payload-tier shape. See get-next-shape.ts
 * for the measurement that motivates each rule.
 */
import { describe, expect, it } from 'vitest';
import { shapeGetNextResult } from './get-next-shape';

const counters = (over: Record<string, number> = {}) => ({
  taken: 18,
  claimHold: 7,
  needsOwnerAction: 0,
  agentReview: 34,
  observationLane: 468,
  externalBlocker: 1,
  federationDetector: 0,
  loopNoise: 0,
  alreadyCompleted: 0,
  watchdogRecovery: 0,
  cooldown: 0,
  ...over,
});

const claim = () => ({
  ok: true,
  claimReceipt: { committed: true, workItemId: 'EI-1' },
  planDecisions: [{ id: 'D-001' }],
  workItem: {
    id: 'EI-1',
    title: 't',
    summary: 'the task body',
    payload: {
      paths: ['a.ts'],
      reporter: { ownerId: 'su-x' },
      reportContext: { tool: 'x' },
      toolFailureProbation: { detail: 'p'.repeat(1300) },
      toolFailureSignature: { sig: 's'.repeat(780) },
      freshnessEnvelope: { at: 'f'.repeat(280) },
      implementationReadiness: { r: 'r'.repeat(180) },
      admissionReview: { a: 'a'.repeat(440) },
      dedupCandidates: [{ id: 'EI-2' }],
      _ei: { internal: true },
      _claimSubjectBaseline: { b: 'b'.repeat(560) },
    },
  },
  claimedUnder: { specId: 's', revision: 3 },
});

const noClaim = () => ({
  ok: false,
  claimability: {
    value: 0,
    population: {
      kind: 'fleet-claim-spec',
      matchedByFilter: 547,
      excluded: counters(),
      families: { issue: { claimable: 0, matchedByFilter: 547, excluded: counters() } },
    },
  },
  excludedBreakdown: { matchedByFilter: 547, claimable: 0, excluded: counters() },
  error: 'POOL BLOCKED',
});

describe('shapeGetNextResult — claim responses', () => {
  it('omits payload bookkeeping, names every omitted key, and points at the full read', () => {
    const out = shapeGetNextResult(claim()) as ReturnType<typeof claim>;
    const payload = out.workItem.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['omittedKeys', 'omittedKeysRead', 'paths', 'reportContext', 'reporter']);
    expect((payload.omittedKeys as string[]).sort()).toEqual([
      '_claimSubjectBaseline',
      '_ei',
      'admissionReview',
      'dedupCandidates',
      'freshnessEnvelope',
      'implementationReadiness',
      'toolFailureProbation',
      'toolFailureSignature',
    ]);
    expect(payload.omittedKeysRead).toBe("work_items:get { id: 'EI-1', payloadTier: 'full' }");
    expect(out.workItem.summary).toBe('the task body');
  });

  it('keeps the prefix-preserving key order (claimReceipt first, workItem in place)', () => {
    const original = claim();
    const out = shapeGetNextResult(original) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(Object.keys(original));
  });

  it('shrinks a realistic claim echo by more than half and leaves a clean payload untouched', () => {
    const original = claim();
    expect(JSON.stringify(shapeGetNextResult(original)).length).toBeLessThan(JSON.stringify(original).length / 2);
    const clean = { ...original, workItem: { ...original.workItem, payload: { paths: ['a.ts'] } } };
    expect(shapeGetNextResult(clean)).toBe(clean);
  });
});

describe('shapeGetNextResult — no-claim responses', () => {
  it('drops zero counters and de-dupes the repeated exclusion maps', () => {
    const out = shapeGetNextResult(noClaim()) as ReturnType<typeof noClaim>;
    expect(out.claimability.population.excluded).toEqual({
      taken: 18,
      claimHold: 7,
      agentReview: 34,
      observationLane: 468,
      externalBlocker: 1,
    });
    expect(out.claimability.population.families.issue.excluded).toBe('same as claimability.population.excluded');
    expect(out.excludedBreakdown.excluded).toBe('same as claimability.population.excluded');
    expect(out.claimability.population.families.issue.matchedByFilter).toBe(547);
    expect(out.error).toBe('POOL BLOCKED');
  });

  it('a family whose counters DIFFER from the population keeps its own (non-zero) counters', () => {
    const input = noClaim();
    input.claimability.population.families.issue.excluded = counters({ taken: 3, claimHold: 0 });
    const out = shapeGetNextResult(input) as ReturnType<typeof noClaim>;
    const fam = out.claimability.population.families.issue.excluded as unknown as Record<string, number>;
    expect(fam.taken).toBe(3);
    expect(fam).not.toHaveProperty('claimHold');
    expect(fam).not.toHaveProperty('cooldown');
  });
});

describe('shapeGetNextResult — passthrough and wiring', () => {
  it('passes non-objects and unrelated objects through unchanged', () => {
    expect(shapeGetNextResult(null)).toBeNull();
    expect(shapeGetNextResult('x')).toBe('x');
    const other = { ok: false, error: 'windDown' };
    expect(shapeGetNextResult(other)).toBe(other);
  });

  it('scheduler:get_next DECLARES this shape for both agent tiers (a shaper nobody wires is dead)', async () => {
    const tool = (await import('./get_next')).default as unknown as {
      shape?: { standard?: unknown; trimmed?: unknown };
      def?: { shape?: { standard?: unknown; trimmed?: unknown } };
    };
    const shape = tool.shape ?? tool.def?.shape;
    expect(shape?.trimmed).toBe(shapeGetNextResult);
    expect(shape?.standard).toBe(shapeGetNextResult);
  });
});

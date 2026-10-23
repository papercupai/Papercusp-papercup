import { describe, expect, it } from 'vitest';
import {
  compileSpecClauses,
  computeSpecSetHash,
  specBehaviorNonFalsifiableReason,
  type SpecClauseEnrichment,
} from '../spec-clause-compiler';

function plan(...lines: string[]): string {
  return ['- **P-001** `todo` Define the behavior.', ...lines].join('\n');
}

const ACTIVE_HTTP_SPEC: Readonly<Record<string, SpecClauseEnrichment>> = {
  'VAL-demo-001': {
    behaviorClass: 'happy-path',
    requiredTestLayers: ['integration'],
    lifecycleStatus: 'active',
  },
};

describe('compileSpecClauses', () => {
  it('preserves stable ids/VAL aliases and hashes semantic content independently of Markdown formatting', () => {
    const canonical = plan(
      '  - **[VAL-demo-001]**',
      '    - **Verify:** `GET /health` returns 200',
      '    - **Evidence:** `health.integration.test.ts`',
    );
    const restyled = plan(
      '  - [VAL-demo-001]',
      '    - **Verify:** **GET /health**     returns 200',
      '    - **Evidence:** health.integration.test.ts',
    );

    const first = compileSpecClauses(canonical, { enrichments: ACTIVE_HTTP_SPEC });
    const second = compileSpecClauses(restyled, {
      enrichments: ACTIVE_HTTP_SPEC,
      previousSpecSetHash: first.specSetHash,
    });

    expect(first.ok).toBe(true);
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]).toMatchObject({
      specId: 'SPEC-demo-001',
      sourceValId: 'VAL-demo-001',
      planItemId: 'P-001',
      behavior: 'GET /health returns 200',
      behaviorClass: 'happy-path',
      lifecycleStatus: 'active',
      materializationReady: true,
    });
    expect(second.specSetHash).toBe(first.specSetHash);
    expect(second.invalidated).toBe(false);
  });

  it('invalidates a prior hash when semantic behavior changes', () => {
    const before = compileSpecClauses(plan('  - **[VAL-demo-001]**', '    - **Verify:** GET /health returns 200'), {
      enrichments: ACTIVE_HTTP_SPEC,
    });
    const after = compileSpecClauses(plan('  - **[VAL-demo-001]**', '    - **Verify:** GET /health returns 201'), {
      enrichments: ACTIVE_HTTP_SPEC,
      previousSpecSetHash: before.specSetHash,
    });

    expect(after.specSetHash).not.toBe(before.specSetHash);
    expect(after.invalidated).toBe(true);
  });

  it.each([
    { observation: 'The child reports a different interpreter.' },
    { probeMethod: 'Launch a second controlled child.' },
    { requiredScenarios: ['child-pass', 'child-timeout'] },
    { causalPairing: 'one-to-one' as const },
  ])('invalidates spec-set identity when a declared falsifier changes: %j', (change) => {
    const [clause] = compileSpecClauses(
      plan('  - **[VAL-demo-001]**', '    - **Verify:** GET /health returns 200'),
      { enrichments: ACTIVE_HTTP_SPEC },
    ).candidates;
    const falsifier = {
      observation: 'The child exits without its completion marker.',
      probeMethod: 'Launch a controlled child.',
      requiredScenarios: ['child-pass'],
    };

    expect(computeSpecSetHash([{ ...clause, falsifier: { ...falsifier, ...change } }]))
      .not.toBe(computeSpecSetHash([{ ...clause, falsifier }]));
    expect(computeSpecSetHash([{ ...clause, falsifier }])).not.toBe(computeSpecSetHash([clause]));
  });

  it('normalizes falsifier formatting and scenario order without changing legacy undeclared identities', () => {
    const [clause] = compileSpecClauses(
      plan('  - **[VAL-demo-001]**', '    - **Verify:** GET /health returns 200'),
      { enrichments: ACTIVE_HTTP_SPEC },
    ).candidates;
    const falsifier = {
      observation: 'The child exits without its completion marker.',
      probeMethod: 'Launch a controlled child.',
      requiredScenarios: ['child-pass', 'child-timeout'],
    };

    expect(computeSpecSetHash([{ ...clause, falsifier: {
      observation: '  The child exits  without its completion marker. ',
      probeMethod: '**Launch a controlled child.**',
      requiredScenarios: ['child-timeout', 'child-pass', 'child-pass'],
    } }])).toBe(computeSpecSetHash([{ ...clause, falsifier }]));
    expect(computeSpecSetHash([{ ...clause, falsifier: null }])).toBe(computeSpecSetHash([clause]));
    expect(computeSpecSetHash([{ ...clause, falsifier: undefined }])).toBe(computeSpecSetHash([clause]));
  });

  it('hashes the spec set independently of clause source order', () => {
    const enrichment: Readonly<Record<string, SpecClauseEnrichment>> = {
      'VAL-demo-a': { behaviorClass: 'happy-path', lifecycleStatus: 'active' },
      'VAL-demo-b': { behaviorClass: 'failure', lifecycleStatus: 'active' },
    };
    const first = compileSpecClauses(
      plan(
        '  - **[VAL-demo-a]**',
        '    - **Verify:** GET /a returns 200',
        '  - **[VAL-demo-b]**',
        '    - **Verify:** GET /b rejects an invalid token',
      ),
      { enrichments: enrichment },
    );
    const reordered = compileSpecClauses(
      plan(
        '  - **[VAL-demo-b]**',
        '    - **Verify:** GET /b rejects an invalid token',
        '  - **[VAL-demo-a]**',
        '    - **Verify:** GET /a returns 200',
      ),
      { enrichments: enrichment },
    );

    expect(reordered.specSetHash).toBe(first.specSetHash);
    expect(reordered.candidates.map((candidate) => candidate.specId)).toEqual(
      first.candidates.map((candidate) => candidate.specId),
    );
  });

  it('preserves parseable header-only legacy behavior as an unresolved draft', () => {
    const result = compileSpecClauses(plan('  - [VAL-demo-legacy] GET /legacy returns 410'));

    expect(result.ok).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      specId: 'SPEC-demo-legacy',
      sourceValId: 'VAL-demo-legacy',
      behavior: 'GET /legacy returns 410',
      behaviorClass: null,
      lifecycleStatus: 'draft',
      materializationReady: false,
    });
    expect(result.candidates[0].diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['legacy-header-behavior-draft', 'behavior-class-unresolved']),
    );
  });

  it('reports an unparseable legacy block instead of dropping or silently waiving it', () => {
    const result = compileSpecClauses(plan('  - **[VAL-demo-empty]**'));

    expect(result.candidates).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.candidates[0]).toMatchObject({
      sourceValId: 'VAL-demo-empty',
      behavior: '',
      lifecycleStatus: 'draft',
      materializationReady: false,
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('behavior-missing');
  });

  it('does not reinterpret RequiresTest:false as an exemption without justification', () => {
    const result = compileSpecClauses(
      plan(
        '  - **[VAL-demo-manual]**',
        '    - **Verify:** The release note contains the migration warning',
        '    - **RequiresTest:** false',
      ),
      {
        enrichments: {
          'VAL-demo-manual': {
            behaviorClass: 'non-automated',
            lifecycleStatus: 'active',
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.candidates[0].lifecycleStatus).toBe('draft');
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('legacy-test-exemption-unjustified');
  });

  it('records an explicit exemption only when justification and provenance are present', () => {
    const raw = plan(
      '  - **[VAL-demo-manual]**',
      '    - **Verify:** The release note contains the migration warning',
      '    - **RequiresTest:** false',
    );
    const valid = compileSpecClauses(raw, {
      enrichments: {
        'VAL-demo-manual': {
          behaviorClass: 'non-automated',
          lifecycleStatus: 'exempt',
          exemption: {
            justification: 'Requires human editorial judgement.',
            provenance: 'plan:first-class-spec-clauses#D-003',
          },
        },
      },
    });
    const invalid = compileSpecClauses(raw, {
      enrichments: {
        'VAL-demo-manual': {
          behaviorClass: 'non-automated',
          lifecycleStatus: 'exempt',
          exemption: { justification: 'Requires human editorial judgement.' },
        },
      },
    });

    expect(valid.ok).toBe(true);
    expect(valid.candidates[0]).toMatchObject({
      lifecycleStatus: 'exempt',
      materializationReady: true,
      exemption: {
        justification: 'Requires human editorial judgement.',
        provenance: 'plan:first-class-spec-clauses#D-003',
      },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.candidates[0].materializationReady).toBe(false);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toContain('exemption-provenance-missing');
  });

  it('reports duplicate source aliases and stable spec ids deterministically', () => {
    const result = compileSpecClauses(
      plan(
        '  - **[VAL-demo-duplicate]**',
        '    - **Verify:** GET /one returns 200',
        '  - **[VAL-demo-duplicate]**',
        '    - **Verify:** GET /two returns 200',
      ),
      {
        enrichments: {
          'VAL-demo-duplicate': {
            behaviorClass: 'happy-path',
            lifecycleStatus: 'active',
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(new Set(result.diagnostics.map((diagnostic) => diagnostic.code))).toEqual(
      new Set(['duplicate-source-val-id', 'duplicate-spec-id']),
    );
    expect(result.candidates.every((candidate) => !candidate.materializationReady)).toBe(true);
  });

  it('emits atomicity and falsifiability diagnostics without rewriting behavior', () => {
    const result = compileSpecClauses(
      plan(
        '  - **[VAL-demo-compound]**',
        '    - **Verify:** GET /x returns 200 and POST /audit emits a record',
        '  - **[VAL-demo-vague]**',
        '    - **Verify:** The feature works correctly',
      ),
      {
        enrichments: {
          'VAL-demo-compound': { behaviorClass: 'happy-path', lifecycleStatus: 'active' },
          'VAL-demo-vague': { behaviorClass: 'happy-path', lifecycleStatus: 'active' },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['behavior-non-atomic', 'behavior-not-falsifiable']),
    );
    expect(result.candidates.find((candidate) => candidate.sourceValId === 'VAL-demo-compound')?.behavior).toBe(
      'GET /x returns 200 and POST /audit emits a record',
    );
  });

  it('rejects coordinated subject lists with a source-presence predicate', () => {
    const behavior =
      'Implemented provider contracts, durable controller, credential lifecycle, artifact boundaries, and ordinary lifecycle semantics are present in the current tree.';
    const result = compileSpecClauses(
      plan('  - **[VAL-demo-bundled]**', '    - **Verify:** ' + behavior),
      {
        enrichments: {
          'VAL-demo-bundled': { behaviorClass: 'happy-path', lifecycleStatus: 'active' },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['behavior-non-atomic', 'behavior-not-falsifiable']),
    );
  });

  it('does not mistake an intake source record with an outcome for source-code presence', () => {
    const behavior = 'Every processed source has an attributable result or an owned next action.';
    const result = compileSpecClauses(
      plan('  - **[VAL-demo-source-record]**', '    - **Verify:** ' + behavior),
      {
        enrichments: {
          'VAL-demo-source-record': { behaviorClass: 'happy-path', lifecycleStatus: 'active' },
        },
      },
    );

    expect(specBehaviorNonFalsifiableReason(behavior)).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('behavior-not-falsifiable');
  });

  it('still rejects explicit source-code presence claims as non-falsifiable', () => {
    expect(specBehaviorNonFalsifiableReason('The current source code contains a matching handler.')).toBe(
      'behavior asserts source-code presence instead of an observable outcome',
    );
    expect(specBehaviorNonFalsifiableReason('The current implementation has a matching handler.')).toBe(
      'behavior asserts source-code presence instead of an observable outcome',
    );
    expect(specBehaviorNonFalsifiableReason('The expected handler is present in the current source code.')).toBe(
      'behavior asserts source-code presence instead of an observable outcome',
    );
  });

  it.each([
    'The operation succeeds after the shared tree has moved past the checkpoint.',
    'The operation succeeds after the shared repository has changed.',
    'The operation succeeds after the implementation has been updated.',
  ])('does not mistake present-perfect outcome wording for source-code presence: %s', (behavior) => {
    expect(specBehaviorNonFalsifiableReason(behavior)).toBeNull();
  });

  it.each(['receives', 'received', 'is receiving'])('rejects independently missing output objects under %s', (verb) => {
    const behavior = `Each daily task ${verb} the approved source watchlist and a ten-item brief limit.`;
    const result = compileSpecClauses(
      plan('  - **[VAL-demo-outputs]**', '    - **Verify:** ' + behavior),
      { enrichments: { 'VAL-demo-outputs': { behaviorClass: 'happy-path', lifecycleStatus: 'active' } } },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('behavior-non-atomic');
    expect(result.candidates[0].behavior).toBe(behavior);
  });

  it('keeps receiving one output under multiple input conditions atomic', () => {
    const result = compileSpecClauses(
      plan('  - **[VAL-demo-receive]**', '    - **Verify:** Each task receives the approved watchlist for daily and weekly runs.'),
      { enrichments: { 'VAL-demo-receive': { behaviorClass: 'happy-path', lifecycleStatus: 'active' } } },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps one observable behavior over multiple input values atomic', () => {
    const result = compileSpecClauses(
      plan(
        '  - **[VAL-demo-inputs]**',
        '    - **Verify:** GET /events returns 202 for alpha, beta, and gamma event types',
      ),
      {
        enrichments: {
          'VAL-demo-inputs': { behaviorClass: 'happy-path', lifecycleStatus: 'active' },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});

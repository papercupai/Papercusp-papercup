import { describe, expect, it } from 'vitest';
import { RECORDED_TEST_LAYERS } from '@papercusp/test-config/execution-details';
import type { SpecClauseRevision } from './spec-clauses-store';
import { specBehaviorNonAtomicReason } from './spec-clause-compiler';
import { evaluatePlanSpecQuality, specQualityPlanItemIds } from './spec-quality';
import { deriveIndexFromContent } from './derive-index';
import { parsePlan } from './parser';
import evaluateSpecQualityTool from './evaluate-spec-quality';
import startPlanTool from './start';

function clause(over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: 'quality-plan',
    specId: 'SPEC-001-01',
    sourceValId: 'VAL-001-01',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'POST /events returns 202 for a valid request',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:spec-one',
    createdBy: 'author',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-001',
    ...over,
  };
}

describe('evaluatePlanSpecQuality', () => {
  describe('WI-6554700010017412 recorded layer declarations', () => {
    it.each(['concurrency', 'performance', 'failure-injection', 'recovery', 'rendered', 'user-journey'])(
      'rejects an active unrecordable %s obligation without changing it',
      (layer) => {
        const legacy = clause({ requiredTestLayers: ['integration', layer] });
        const before = structuredClone(legacy);
        const result = evaluatePlanSpecQuality({
          planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
          clauses: [legacy], classRef: 'plan-class-feature-ship',
        });
        expect(result.verdict).toBe('fail');
        expect(result.ratings['plan-class-specialization']).toMatchObject({ rating: 'fail' });
        expect(result.ratings['plan-class-specialization'].evidence).toContain('SPEC-001-01');
        expect(result.ratings['plan-class-specialization'].evidence).toContain(JSON.stringify(layer));
        expect(result.ratings['plan-class-specialization'].suggestion).toContain('preserve');
        expect(legacy).toEqual(before);
      },
    );

    it('accepts every recordable layer and leaves historical draft obligations outside the active check', () => {
      const result = evaluatePlanSpecQuality({
        planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
        clauses: [
          clause({ requiredTestLayers: [...RECORDED_TEST_LAYERS] }),
          clause({ specId: 'LEGACY-DRAFT', sourceValId: null, lifecycleStatus: 'draft', requiredTestLayers: ['concurrency'] }),
        ],
        classRef: 'plan-class-feature-ship',
      });
      expect(result.verdict).toBe('pass');
    });
  });

  it('uses the same quality evidence for the stored index and locked Markdown with dropped items', () => {
    const markdown = [
      '---', 'title: Quality plan', 'status: ready', '---', '## Items',
      '- **P-001** `todo` Accept an event',
      '- **P-002** `done` Reject an invalid event',
      '- **P-003** `dropped` Abandoned editorial work',
    ].join('\n');
    const clauses = [
      clause(),
      clause({ specId: 'SPEC-002-01', sourceValId: 'VAL-002-01', planItemId: 'P-002', behavior: 'POST /events returns 400 for an invalid request' }),
    ];
    const input = { planSlug: 'quality-plan', harnessSlug: 'papercusp', classRef: 'plan-class-feature-ship' as const, clauses };
    const fromIndex = evaluatePlanSpecQuality({ ...input, planItemIds: specQualityPlanItemIds(deriveIndexFromContent(markdown).items) });
    const fromMarkdown = evaluatePlanSpecQuality({ ...input, planItemIds: specQualityPlanItemIds(parsePlan(markdown).items) });

    expect(fromIndex.planItemCount).toBe(2);
    expect(fromIndex.verdict).toBe('pass');
    expect(fromIndex.ratings).toEqual(fromMarkdown.ratings);
    expect(fromIndex.scorecardDraft.subject).toEqual(fromMarkdown.scorecardDraft.subject);
  });

  it('passes a fully covered feature plan and pins an exact specSetHash subject', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.specSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.scorecardDraft.subject.ref).toContain(result.specSetHash);
    for (const [criterion, entry] of Object.entries(result.ratings)) {
      expect(entry.evidence).toContain('Source store: plans:get-specs { slug:"quality-plan", harness:"papercusp" }.');
      expect(entry.evidence).toContain(
        `Re-run exactly: plans:evaluate-spec-quality { slug:"quality-plan", harness:"papercusp", classRef:"plan-class-feature-ship", expectedSpecSetHash:"${result.specSetHash}" }`,
      );
      expect(entry.evidence).toContain(`confirm the returned specSetHash equals "${result.specSetHash}"`);
      expect(entry.evidence).toContain(`expectedSpecSetHash:"${result.specSetHash}"`);
      expect(entry.evidence).toContain(`inspect ratings["${criterion}"]`);
    }
  });

  it('reports zero active sourceBar projections in atomicity coverage', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].evidence).toContain(
      'Coverage: 1 of 1 active behavioral clause(s) evaluated; 0 active sourceBar-pinned BAR projection(s) excluded',
    );
  });

  it('requires every plan item to carry behavior or an explicit exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001', 'P-002'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.verdict).toBe('fail');
    expect(result.details.uncoveredPlanItemIds).toEqual(['P-002']);
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  // EI-24372921924901236: one canonical BAR is projected onto several items.
  // Those projections are not item contracts; each item needs its own contract.
  describe('shared BAR projection coverage', () => {
    const planItemIds = ['P-001', 'P-002', 'P-003'];
    const sourceBar = {
      barKey: 'R-1',
      barHash: 'a'.repeat(64),
      barSetHash: 'b'.repeat(64),
      rubricSlug: 'quality-plan-acceptance',
      rubricRevision: 4,
      evidencePlane: 'tree' as const,
    };
    const projections = () =>
      planItemIds.map((planItemId) =>
        clause({
          specId: `AUTO-BAR-R-1-${planItemId}`,
          sourceValId: null,
          planItemId,
          sourceBar: { ...sourceBar },
          behavior: 'Accepted event requests preserve their declared identity. Rejected requests leave no side effect.',
        }),
      );
    const contracts = () => [
      clause({ specId: 'CONTRACT-P-001', sourceValId: null, behavior: 'A valid event request returns 202.' }),
      clause({ specId: 'CONTRACT-P-002', sourceValId: null, planItemId: 'P-002', behavior: 'An invalid event request returns 400.' }),
      clause({ specId: 'CONTRACT-P-003', sourceValId: null, planItemId: 'P-003', behavior: 'A replayed event request returns 409.' }),
    ];
    const evaluate = (clauses: SpecClauseRevision[]) =>
      evaluatePlanSpecQuality({
        planSlug: 'quality-plan',
        harnessSlug: 'papercusp',
        planItemIds,
        clauses,
        classRef: 'plan-class-feature-ship',
      });

    it('accepts one multi-sentence BAR projection across three items with independent item contracts', () => {
      const result = evaluate([...projections(), ...contracts()]);
      expect(result.ratings['item-contract-coverage'].rating).toBe('pass');
      expect(result.ratings['atomic-observable-behavior'].rating).toBe('pass');
      expect(result.ratings.falsifiability.rating).toBe('pass');
      expect(result.ratings['implementation-independence'].rating).toBe('pass');
      expect(result.ratings['implementation-independence'].evidence).toContain(
        'including 3 sourceBar-pinned acceptance BAR projection(s)',
      );
      expect(result.ratings['implementation-independence'].evidence).toContain('Detector coverage:');
      expect(result.verdict).toBe('pass');
      expect(result.details.atomicityClauseDiagnostics).toHaveLength(6);
      expect(result.details.atomicityClauseDiagnostics.find((entry) => entry.specId === 'AUTO-BAR-R-1-P-001'))
        .toMatchObject({ disposition: 'excluded', rating: 'not-applicable' });
      expect(result.details.atomicityClauseDiagnostics.find((entry) => entry.specId === 'CONTRACT-P-001'))
        .toMatchObject({ disposition: 'evaluated', rating: 'pass', reason: null });
    });

    it('blocks runtime BARs on an explicitly exempt prerequisite when a dependent implementation owns the same BAR', () => {
      const inventoryExemption = clause({
        specId: 'INVENTORY-P-001',
        sourceValId: null,
        planItemId: 'P-001',
        behaviorClass: 'non-automated',
        requiredTestLayers: [],
        mutationRequired: false,
        lifecycleStatus: 'exempt',
        exemption: { justification: 'Read-only inventory.', provenance: 'D-006' },
      });
      const inventoryProjection = clause({
        specId: 'AUTO-BAR-R-1-P-001', sourceValId: null, planItemId: 'P-001', sourceBar: { ...sourceBar },
      });
      const implementationProjection = clause({
        specId: 'AUTO-BAR-R-1-P-002', sourceValId: null, planItemId: 'P-002', sourceBar: { ...sourceBar },
      });
      const implementationContract = clause({
        specId: 'CONTRACT-P-002',
        sourceValId: null,
        planItemId: 'P-002',
        behavior: 'A valid event request returns 202.',
      });
      const result = evaluatePlanSpecQuality({
        planSlug: 'quality-plan',
        harnessSlug: 'papercusp',
        planItemIds: ['P-001', 'P-002'],
        planItems: [
          { id: 'P-001', blockedBy: [] },
          { id: 'P-002', blockedBy: ['P-001'] },
        ],
        clauses: [inventoryExemption, inventoryProjection, implementationProjection, implementationContract],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings['item-contract-coverage'].rating).toBe('fail');
      expect(result.wouldBlock).toContain('item-contract-coverage');
      expect(result.details.prerequisiteRuntimeBarMismatches).toEqual([{
        prerequisiteItemId: 'P-001',
        barKey: 'R-1',
        projectionSpecId: 'AUTO-BAR-R-1-P-001',
        dependentImplementationItemIds: ['P-002'],
      }]);
      expect(result.ratings['item-contract-coverage'].evidence).toContain('AUTO-BAR-R-1-P-001 on P-001 -> P-002');
    });

    it.each(['active', 'accepted'] as const)(
      'blocks runtime BARs on a manual %s prerequisite when a dependent implementation owns the same BAR',
      (lifecycleStatus) => {
        const manualInventoryContract = clause({
          specId: 'INVENTORY-P-001',
          sourceValId: null,
          planItemId: 'P-001',
          behaviorClass: 'non-automated',
          requiredTestLayers: [],
          requiredEvidence: ['manual'],
          mutationRequired: false,
          lifecycleStatus,
          exemption: null,
        });
        const inventoryProjection = clause({
          specId: 'AUTO-BAR-R-1-P-001', sourceValId: null, planItemId: 'P-001', sourceBar: { ...sourceBar },
        });
        const implementationProjection = clause({
          specId: 'AUTO-BAR-R-1-P-002', sourceValId: null, planItemId: 'P-002', sourceBar: { ...sourceBar },
        });
        const implementationContract = clause({
          specId: 'CONTRACT-P-002',
          sourceValId: null,
          planItemId: 'P-002',
          behavior: 'A valid event request returns 202.',
        });
        const result = evaluatePlanSpecQuality({
          planSlug: 'quality-plan',
          harnessSlug: 'papercusp',
          planItemIds: ['P-001', 'P-002'],
          planItems: [
            { id: 'P-001', blockedBy: [] },
            { id: 'P-002', blockedBy: ['P-001'] },
          ],
          clauses: [manualInventoryContract, inventoryProjection, implementationProjection, implementationContract],
          classRef: 'plan-class-feature-ship',
        });

        expect(result.ratings['item-contract-coverage'].rating).toBe('fail');
        expect(result.wouldBlock).toContain('item-contract-coverage');
        expect(result.details.prerequisiteRuntimeBarMismatches).toEqual([{
          prerequisiteItemId: 'P-001',
          barKey: 'R-1',
          projectionSpecId: 'AUTO-BAR-R-1-P-001',
          dependentImplementationItemIds: ['P-002'],
        }]);
        expect(result.ratings['item-contract-coverage'].evidence).toContain('AUTO-BAR-R-1-P-001 on P-001 -> P-002');
      },
    );

    it('keeps a prerequisite with its own executable implementation out of the manual-only classification', () => {
      const manualInventoryContract = clause({
        specId: 'INVENTORY-P-001',
        sourceValId: null,
        planItemId: 'P-001',
        behaviorClass: 'non-automated',
        requiredTestLayers: [],
        requiredEvidence: ['manual'],
        mutationRequired: false,
        lifecycleStatus: 'active',
        exemption: null,
      });
      const independentImplementationContract = clause({
        specId: 'IMPLEMENT-P-001',
        sourceValId: null,
        planItemId: 'P-001',
        behaviorClass: 'happy-path',
        requiredTestLayers: ['integration'],
        requiredEvidence: ['tree'],
      });
      const inventoryProjection = clause({
        specId: 'AUTO-BAR-R-1-P-001', sourceValId: null, planItemId: 'P-001', sourceBar: { ...sourceBar },
      });
      const implementationProjection = clause({
        specId: 'AUTO-BAR-R-1-P-002', sourceValId: null, planItemId: 'P-002', sourceBar: { ...sourceBar },
      });
      const dependentImplementationContract = clause({
        specId: 'CONTRACT-P-002',
        sourceValId: null,
        planItemId: 'P-002',
        behavior: 'A valid event request returns 202.',
      });
      const result = evaluatePlanSpecQuality({
        planSlug: 'quality-plan',
        harnessSlug: 'papercusp',
        planItemIds: ['P-001', 'P-002'],
        planItems: [
          { id: 'P-001', blockedBy: [] },
          { id: 'P-002', blockedBy: ['P-001'] },
        ],
        clauses: [
          manualInventoryContract,
          independentImplementationContract,
          inventoryProjection,
          implementationProjection,
          dependentImplementationContract,
        ],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.details.prerequisiteRuntimeBarMismatches).toEqual([]);
    });

    it('blocks an active BAR projection on a later exempt verification item', () => {
      const verificationExemption = clause({
        specId: 'VERIFY-P-002',
        sourceValId: null,
        planItemId: 'P-002',
        behaviorClass: 'non-automated',
        requiredTestLayers: [],
        mutationRequired: false,
        lifecycleStatus: 'exempt',
        exemption: { justification: 'Review generated acceptance evidence.', provenance: 'D-006' },
      });
      const verificationProjection = clause({
        specId: 'AUTO-BAR-R-1-P-002', sourceValId: null, planItemId: 'P-002', sourceBar: { ...sourceBar },
      });
      const result = evaluatePlanSpecQuality({
        planSlug: 'quality-plan',
        harnessSlug: 'papercup',
        planItemIds: ['P-001', 'P-002'],
        planItems: [
          { id: 'P-001', blockedBy: [] },
          { id: 'P-002', blockedBy: ['P-001'] },
        ],
        clauses: [
          clause({
            specId: 'CONTRACT-P-001', sourceValId: null,
            behavior: 'A valid request produces an acceptance receipt.',
          }),
          verificationExemption,
          verificationProjection,
        ],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings['item-contract-coverage'].rating).toBe('fail');
      expect(result.wouldBlock).toContain('item-contract-coverage');
      expect(result.details.exemptSourceBarProjectionMismatches).toEqual([{
        exemptItemId: 'P-002',
        barKey: 'R-1',
        projectionSpecId: 'AUTO-BAR-R-1-P-002',
      }]);
      expect(result.details.prerequisiteRuntimeBarMismatches).toEqual([]);
    });

    it('reports the exact cloud dashboard AUTO-BAR bundles as excluded from atomicity claims', () => {
      const bundles = [
        {
          specId: 'AUTO-BAR-R-1-P-001',
          planItemId: 'P-001',
          behavior: 'Both distinct configured offers are test-only and the runtime refuses wrong-account or unapproved live credentials.',
        },
        {
          specId: 'AUTO-BAR-R-2-P-002',
          planItemId: 'P-002',
          behavior: 'Billing-authorized organizations can complete either deployed cloud subscription lifecycle through real TEST Checkout, webhook-persisted active state and customer-portal cancellation while organization isolation and non-manager mutation denial remain enforced.',
        },
        {
          specId: 'AUTO-BAR-R-3-P-003',
          planItemId: 'P-003',
          behavior: 'Real-suite tests pass and exact deployed artifact/config has verified test-mode checkout, signed webhook state and cancellation evidence for both offers.',
        },
      ] as const;
      const bundleProjections = bundles.map((entry, index) =>
        clause({
          specId: entry.specId,
          sourceValId: null,
          planItemId: entry.planItemId,
          behavior: entry.behavior,
          sourceBar: { ...sourceBar, barKey: 'R-' + (index + 1) },
        }),
      );
      const independentContracts = [
        clause({
          specId: 'CLOUD-DASHBOARD-TEST-LIFECYCLE',
          sourceValId: null,
          planItemId: 'P-002',
          behavior: 'A billing-authorized organization can complete the subscription lifecycle of either dashboard cloud offer through Stripe TEST Checkout, signed webhook activation and customer-portal cancellation.',
        }),
        clause({
          specId: 'CLOUD-JOURNEY-SERVED-ARTIFACT',
          sourceValId: null,
          planItemId: 'P-003',
          behavior: 'Each deployed cloud billing journey records the immutable artifact served at its authenticated start.',
        }),
        clause({
          specId: 'CLOUD-TEST-OFFER-ACCOUNT',
          sourceValId: null,
          planItemId: 'P-001',
          behavior: 'Configured cloud offers can create TEST Checkout sessions only within the expected Papercups LLC Stripe account.',
        }),
      ];

      const result = evaluate([...bundleProjections, ...independentContracts]);
      const atomicity = result.ratings['atomic-observable-behavior'];
      expect(atomicity.rating).toBe('pass');
      expect(atomicity.evidence).toContain('3 independent item behavior clause(s) passed the supported structural atomicity checks.');
      // WI-10006862: the rating states the population it covers, so a grader can tell the
      // excluded projections were not judged atomic.
      expect(atomicity.evidence).toContain(
        'Coverage: 3 of 6 active behavioral clause(s) evaluated; 3 active sourceBar-pinned BAR projection(s) excluded',
      );
      expect(atomicity.evidence).toContain(
        'new or meaning-changed canonical BAR projections are checked on rubric writes; unchanged legacy BARs are not re-certified here',
      );
      expect(atomicity.evidence).not.toContain('AUTO-BAR-');
      expect(result.details.atomicityClauseDiagnostics).toHaveLength(6);
      for (const bundle of bundles) {
        expect(result.details.atomicityClauseDiagnostics.find((entry) => entry.specId === bundle.specId))
          .toMatchObject({
            planItemId: bundle.planItemId,
            behavior: bundle.behavior,
            disposition: 'excluded',
            rating: 'not-applicable',
            reason: expect.stringContaining('sourceBar-pinned'),
          });
      }
      for (const contract of independentContracts) {
        expect(result.details.atomicityClauseDiagnostics.find((entry) => entry.specId === contract.specId))
          .toMatchObject({
            planItemId: contract.planItemId,
            behavior: contract.behavior,
            disposition: 'evaluated',
            rating: 'pass',
            reason: null,
          });
      }
    });

    it('does not count pinned BAR projections as item coverage', () => {
      const projectionOnly = evaluate(projections());
      expect(projectionOnly.ratings['item-contract-coverage'].rating).toBe('fail');
      expect(projectionOnly.details.uncoveredPlanItemIds).toEqual(planItemIds);
      const oneContract = evaluate([...projections(), contracts()[0]]);
      expect(oneContract.ratings['item-contract-coverage'].rating).toBe('fail');
      expect(oneContract.details.uncoveredPlanItemIds).toEqual(['P-002', 'P-003']);
      expect(
        evaluate([...projections(), ...contracts().map((c) => ({ ...c, lifecycleStatus: 'draft' as const }))])
          .ratings['item-contract-coverage'].rating,
      ).toBe('fail');
    });

    it('does not treat copied item contracts as independent coverage', () => {
      const copied = contracts().map((c) => ({ ...c, behavior: 'A request with a repeated identifier returns 409.' }));
      expect(evaluate([...projections(), ...copied]).ratings['item-contract-coverage'].rating).toBe('unknown');
    });

    it('corroborates identical shared BAR content pinned at different rubric revisions', () => {
      const shared = projections();
      shared[1] = { ...shared[1], sourceBar: { ...sourceBar, rubricRevision: 5 } };

      const result = evaluate([...shared, ...contracts()]);
      expect(result.ratings['item-contract-coverage'].rating).toBe('pass');
      expect(result.verdict).toBe('pass');
    });

    it.each(['rubricSlug', 'barKey', 'barHash', 'barSetHash', 'evidencePlane'] as const)(
      'keeps projections with different %s unknown',
      (field) => {
        const shared = projections();
        shared[1] = {
          ...shared[1],
          sourceBar: {
            ...sourceBar,
            [field]: field === 'evidencePlane' ? 'live' : 'different',
          },
        };
        expect(evaluate([...shared, ...contracts()]).ratings['item-contract-coverage'].rating).toBe('unknown');
      },
    );

    it('does not waive ordinary duplicate behavior or a projection missing its source pin', () => {
      const shared = projections().map((c) => ({ ...c, sourceBar: undefined }));
      expect(evaluate([...shared, ...contracts()]).ratings['item-contract-coverage'].rating).toBe('unknown');
      expect(evaluate(shared.map((c, index) => ({ ...c, specId: `COPY-${index}` }))).ratings['item-contract-coverage'].rating).toBe('unknown');
    });
  });

  it('does not lint immutable AUTO-BAR text as an independent item clause', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          specId: 'AUTO-BAR-R-1-P-001',
          behavior: 'The response contains the event. A second outcome is independently asserted.',
          sourceBar: {
            barKey: 'R-1',
            barHash: 'a'.repeat(64),
            barSetHash: 'b'.repeat(64),
            rubricSlug: 'quality-plan-acceptance',
            rubricRevision: 4,
            evidencePlane: 'tree',
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    const atomicity = result.ratings['atomic-observable-behavior'];
    expect(atomicity.rating).toBe('not-applicable');
    expect(atomicity.evidence).toContain('Only sourceBar-pinned projections are present');
    expect(atomicity.evidence).toContain('not independent item contracts');
    expect(result.ratings['item-contract-coverage'].rating).toBe('fail');
    expect(result.details.uncoveredPlanItemIds).toEqual(['P-001']);
  });

  it('flags a multi-subject source-presence clause instead of returning a false all-pass', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          behavior:
            'Implemented provider contracts, durable controller, credential lifecycle, artifact boundaries, and ordinary lifecycle semantics are present in the current tree.',
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    expect(result.ratings.falsifiability.rating).toBe('fail');
    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.verdict).toBe('fail');
    expect(result.wouldBlock).toEqual(
      expect.arrayContaining(['atomic-observable-behavior', 'falsifiability', 'implementation-independence']),
    );
  });

  it('does not mistake ordinary English uses of implementation nouns for code references', () => {
    const behaviors = [
      'A declared class is missing from any sink.',
      'Each orientation state class is declared once.',
      'The method for requesting an event returns a stable result.',
      'The function of this retry is to preserve request identity.',
      'The variable number of returned records matches the requested limit.',
      'The per-class carry decision remains available after compaction.',
    ];
    const clauses = behaviors.map((behavior, index) =>
      clause({
        specId: 'SPEC-ENGLISH-' + (index + 1),
        sourceValId: 'VAL-ENGLISH-' + (index + 1),
        planItemId: 'P-00' + (index + 1),
        behavior,
      }),
    );
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: clauses.map(({ planItemId }) => planItemId),
      clauses,
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('pass');
  });

  it('quotes the exact explicit construct reference in implementation-independence evidence', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'A class OrientationState is declared once.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.ratings['implementation-independence'].evidence).toContain('"class OrientationState"');
  });

  it.each([
    'A supported OpenRouter agent job completes through the existing runtime with correct provider-reported cost and the declared key/retention policy.',
    'The existing cloud organization subscription flow implements the owner-approved public self-service offer under cloud-portal-public-release-2026-10-13 with verified live billing and bounded disclosed consumption.',
    'A witnessed control-plane failure produces one accountable alarm through the existing alarm subscription mechanism.',
    'FAQ content stays synchronized through the existing source-linked maintenance pipeline.',
    'The FAQ maintenance process extends the existing source-linked pipeline.',
    'The existing source-linked maintenance pipeline provides FAQ revision tracking.',
    'Reuse the runtime usage ledger and existing workspace diagnostics for per-call token counts.',
    'Reuse PostHog for disclosed, consented hosted portal events.',
    'Extend existing lifecycle, health, public-ingress and API instrumentation.',
    'Reuse restricted audit records for accountable access observations.',
    'Evaluate existing PostHog error capability before adding another vendor.',
    'Reuse prior clean receipts when current; reuse PostHog for consented portal events.',
    'Reuse current verification evidence through the existing runtime.',
    'Reuse prior test results from verification.ts.',
    'Reuse prior clean receipts to implement the workflow.',
  ])('detects reuse prescriptions in both item and sourceBar contracts: %s', (behavior) => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      classRef: 'plan-class-feature-ship',
      clauses: [clause({ behavior }), clause({
        specId: 'AUTO-BAR-R-1-P-001', sourceValId: null, behavior,
        sourceBar: { barKey: 'R-1', barHash: 'a'.repeat(64), barSetHash: 'b'.repeat(64),
          rubricSlug: 'acceptance-quality-plan', rubricRevision: 1, evidencePlane: 'tree' },
      })],
    });
    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    for (const specId of ['SPEC-001-01', 'AUTO-BAR-R-1-P-001']) {
      expect(result.ratings['implementation-independence'].evidence).toContain(specId + ':');
      expect(result.details.implementationIndependenceClauseDiagnostics).toContainEqual(
        expect.objectContaining({ specId, behavior, disposition: 'evaluated', rating: 'fail', reason: expect.any(String) }),
      );
    }
  });

  it.each([
    'An existing customer sees their subscription after signing in.',
    'The customer reuses an existing account when accepting an invitation.',
    'The customer completes a job with the reported provider cost.',
    'Reuse of an expired invitation is refused.',
  ])('keeps observable existing-customer and reuse outcomes independent: %s', (behavior) => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      clauses: [clause({ behavior })], classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['implementation-independence'].rating).toBe('pass');
    expect(result.details.implementationIndependenceClauseDiagnostics).toContainEqual({
      specId: 'SPEC-001-01', planItemId: 'P-001', behavior,
      disposition: 'evaluated', rating: 'pass', reason: null,
    });
  });

  it.each([
    'Reuse prior clean receipts when current; do not recreate proof just for recovery.',
    'Reuse current verification evidence.',
    'Reuse prior passing test results when their source fingerprints are current.',
    'Reuse the current test receipts.',
  ])('keeps verification-proof reuse independent in item and sourceBar contracts: %s', (behavior) => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      classRef: 'plan-class-feature-ship',
      clauses: [clause({ behavior }), clause({
        specId: 'AUTO-BAR-R-1-P-001', sourceValId: null, behavior,
        sourceBar: { barKey: 'R-1', barHash: 'a'.repeat(64), barSetHash: 'b'.repeat(64),
          rubricSlug: 'acceptance-quality-plan', rubricRevision: 1, evidencePlane: 'tree' },
      })],
    });

    expect(result.ratings['implementation-independence'].rating).toBe('pass');
    for (const specId of ['SPEC-001-01', 'AUTO-BAR-R-1-P-001']) {
      expect(result.details.implementationIndependenceClauseDiagnostics).toContainEqual(
        expect.objectContaining({ specId, behavior, disposition: 'evaluated', rating: 'pass', reason: null }),
      );
    }
  });

  it('reports implementation-independence controls and explicit exclusions for the current clause population', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      classRef: 'plan-class-feature-ship', clauses: [
        clause({ lifecycleStatus: 'accepted' }),
        clause({ specId: 'DRAFT', lifecycleStatus: 'draft', behavior: 'Reuse the runtime usage ledger.' }),
        clause({ specId: 'EXEMPT', lifecycleStatus: 'exempt', behaviorClass: 'non-automated',
          exemption: { justification: 'Documentation only.', provenance: 'D-001' } }),
      ],
    });
    expect(result.details.implementationIndependenceClauseDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ specId: 'SPEC-001-01', disposition: 'evaluated', rating: 'pass', reason: null }),
      expect.objectContaining({ specId: 'DRAFT', disposition: 'excluded', rating: 'not-applicable', reason: expect.stringContaining('draft') }),
      expect.objectContaining({ specId: 'EXEMPT', disposition: 'excluded', rating: 'not-applicable', reason: expect.stringContaining('exempt') }),
    ]));
    const controls = result.details.implementationIndependenceDetectorControls;
    expect(controls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(controls.map(({ expected }) => expected))).toEqual(new Set(['coupled', 'independent']));
    expect(controls.every(({ expected, actual, passed }) => passed && actual === expected)).toBe(true);
    expect(controls).toContainEqual({
      behavior: 'FAQ content stays synchronized through the existing source-linked maintenance pipeline.',
      expected: 'coupled', actual: 'coupled', passed: true,
    });
    expect(controls).toContainEqual({
      behavior: 'The private field condition_key retains episode coalescing.',
      expected: 'coupled', actual: 'coupled', passed: true,
    });
    expect(controls).toContainEqual({
      behavior: 'runSyncBatchDeltaCheck evaluates the batch under sustained load.',
      expected: 'coupled', actual: 'coupled', passed: true,
    });
    expect(result.ratings['implementation-independence'].evidence).toContain('details.implementationIndependenceClauseDiagnostics');
    expect(result.ratings['implementation-independence'].evidence).toContain('details.implementationIndependenceDetectorControls');
    expect(result.ratings['implementation-independence'].evidence).toContain('explicitly qualified/quoted construct symbols');
    expect(result.ratings['implementation-independence'].evidence).toContain('structural pattern detection');
  });

  it.each([
    {
      label: 'internal routes and page reuse',
      behavior:
        'The Settings → Integrations UI calls the existing routes (/admin/triggers/slack/manifest, /admin/triggers/slack/connect, /api/oauth/start) and extends the existing page.',
      expected: 'internal route',
    },
    {
      label: 'a named internal operation',
      behavior: 'The Settings → Integrations UI invokes the configure-slack-bugs op.',
      expected: 'internal operation',
    },
    {
      label: 'an existing-page reuse mandate',
      behavior: 'The integration setup flow extends the existing page.',
      expected: 'existing implementation surface',
    },
    {
      label: 'an existing pipeline reuse mandate',
      behavior: 'FAQ content stays synchronized through the existing source-linked maintenance pipeline.',
      expected: 'implementation reuse or selection',
    },
    {
      label: 'filesystem permission mode',
      behavior: 'Secrets are stored in a 0600 file.',
      expected: 'storage mechanism',
    },
    {
      label: 'encrypted Postgres mirroring',
      behavior: 'Secrets are mirrored to encrypted Postgres storage.',
      expected: 'storage mechanism',
    },
    {
      label: 'the reported 0600 file plus encrypted Postgres mirror',
      behavior: 'Secrets are stored in a 0600 file plus encrypted Postgres mirror storage.',
      expected: 'storage mechanism',
    },
    {
      label: 'an explicit implementation construct in a BAR projection',
      behavior: 'A class IntegrationSettingsRouter is declared once.',
      expected: 'class IntegrationSettingsRouter',
    },
  ])('checks active sourceBar behavior for implementation coupling: $label', ({ behavior, expected }) => {
    const sourceBar = {
      barKey: 'R-2',
      barHash: '8b52c24e019f47c5453bdd6afb90c9cb276ceae2e2855ac6f0e3703f0737d669',
      barSetHash: '687b538a16ba79bec9c1216f1c64d9d479c209891511ef79106e692ee8850417',
      rubricSlug: 'acceptance-simplify-integration-setup-2026-10-10',
      rubricRevision: 1,
      evidencePlane: 'tree' as const,
    };
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          specId: 'AUTO-BAR-R-2-P-001',
          sourceValId: null,
          sourceBar,
          behavior,
        }),
        clause({
          specId: 'CONTRACT-P-001',
          sourceValId: 'VAL-CONTRACT-P-001',
          behavior: 'The integrations screen reports whether each provider is connected.',
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    const rating = result.ratings['implementation-independence'];
    expect(rating.rating).toBe('fail');
    expect(rating.evidence).toContain('AUTO-BAR-R-2-P-001');
    expect(rating.evidence).toContain(expected);
    expect(rating.evidence).toContain('Detector coverage:');
  });

  it.each([
    'Customer-local operation remains available during a vendor outage.',
    'Every foreign-tenant operation is denied.',
    'Read-only operation leaves customer content unchanged.',
  ])('accepts observable domain operation language: %s', (text) => {
    for (const field of ['behavior', 'observation'] as const) {
      const result = evaluatePlanSpecQuality({
        planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
        classRef: 'plan-class-feature-ship',
        clauses: [clause(field === 'behavior'
          ? { behavior: text }
          : { falsifier: { observation: text } })],
      });

      expect(result.ratings['implementation-independence'].rating, field).toBe('pass');
    }
  });

  it.each([
    'The UI invokes the configure-slack-bugs operation.',
    'The internal configure-slack-bugs operation configures the integration.',
    'The `configure-slack-bugs` operation configures the integration.',
  ])('still rejects an explicit internal operation reference: %s', (behavior) => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      classRef: 'plan-class-feature-ship', clauses: [clause({ behavior })],
    });

    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.ratings['implementation-independence'].evidence).toContain('internal operation');
  });

  it('rejects a bare camelCase function reference in implementation-independence', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'runSyncBatchDeltaCheck evaluates the batch under sustained load.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.ratings['implementation-independence'].evidence).toContain('"runSyncBatchDeltaCheck"');
  });

  it('accepts observable persistence without prescribing its storage mechanism', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'The user sees saved settings after reopening the page.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('pass');
    expect(result.ratings['implementation-independence'].evidence).toContain('named storage backends');
  });

  it.each(['macOS', 'iOS', 'iPadOS', 'watchOS', 'tvOS', 'visionOS'])(
    'accepts the public platform name %s in an observable contract',
    (platform) => {
      const result = evaluatePlanSpecQuality({
        planSlug: 'quality-plan',
        harnessSlug: 'papercusp',
        planItemIds: ['P-001'],
        clauses: [clause({ behavior: `On ${platform}, the application opens a usable composer.` })],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings['implementation-independence'].rating).toBe('pass');
    },
  );

  it.each(['iPhone', 'iPad', 'iPod', 'iMac'])(
    'accepts the public device product name %s in an observable contract',
    (device) => {
      const result = evaluatePlanSpecQuality({
        planSlug: 'quality-plan',
        harnessSlug: 'papercusp',
        planItemIds: ['P-001'],
        clauses: [clause({ behavior: `The ${device} app shows a refusal message.` })],
        classRef: 'plan-class-feature-ship',
      });

      expect(result.ratings['implementation-independence'].rating).toBe('pass');
    },
  );

  it('still rejects implementation symbols after public device product names', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'On the iPhone, runSyncBatch evaluates the batch.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.ratings['implementation-independence'].evidence).toContain('"runSyncBatch"');
  });

  it('still rejects implementation symbols after public platform names', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'On macOS and iOS, runSyncBatchDeltaCheck evaluates the batch.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.ratings['implementation-independence'].evidence).toContain('"runSyncBatchDeltaCheck"');
  });

  it('flags passive acceptance joined to streaming as multiple observable outcomes', () => {
    const compound = 'Opening one’s own personal desktop in watch mode through the hosted session host is accepted and streams the desktop.';

    expect(specBehaviorNonAtomicReason(compound)).toBe('behavior joins multiple independently observable outcomes');
    expect(specBehaviorNonAtomicReason('Opening one’s own personal desktop in watch mode is accepted.')).toBeNull();
    expect(specBehaviorNonAtomicReason('Opening one’s own personal desktop in watch mode streams the desktop.')).toBeNull();
  });

  it('fails atomicity for independently falsifiable outcomes joined across a clause', () => {
    const behaviors = [
      'Opening one’s own personal desktop in watch mode through the hosted session host is accepted and streams the desktop.',
      'orders:promote and orders:dismiss { reason } exist, dismiss refuses an empty reason, and a dismissed row stays queryable rather than being deleted.',
      'Every declared orientation category reaches a rendered prompt for a live-shaped session fixture, a build-time guard turns red when any declared category does not render, and a permanent control entry declared but deliberately left unrendered keeps that guard from passing vacuously.',
      'Class-A rows render exactly once per change and never on an unchanged turn, while class-B rows for walls-with-recheck and waiting-on render every turn until they are discharged.',
      'Both the engineer and power su prompts carry that instruction in a live launch-context render, guarded by a Vitest test that fails when it is absent and is proven falsifiable against the pre-fix commit.',
    ];
    const clauses = behaviors.map((behavior, index) =>
      clause({
        specId: 'SPEC-BUNDLED-' + (index + 1),
        sourceValId: 'VAL-BUNDLED-' + (index + 1),
        planItemId: 'P-00' + (index + 1),
        behavior,
      }),
    );
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: clauses.map(({ planItemId }) => planItemId),
      clauses,
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    for (const { specId } of clauses) {
      expect(result.ratings['atomic-observable-behavior'].evidence).toContain(specId + ':');
    }
  });

  it('fails atomicity when one liveness-backed lock clause bundles independent controls', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'main-greening-control-plane-durable-fix-2026-09-21',
      harnessSlug: 'papercusp',
      planItemIds: ['P-003'],
      clauses: [
        clause({
          specId: 'AUTO-BAR-R-004-P-003',
          sourceValId: 'VAL-AUTO-BAR-R-004-P-003',
          planItemId: 'P-003',
          behavior:
            'Preserve single-flight safety while making lock ownership liveness-backed with phase, heartbeat, owner identity, hard deadline, dead-owner reclaim, and explicit unknown-liveness escalation.',
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    expect(result.ratings['atomic-observable-behavior'].evidence).toContain('AUTO-BAR-R-004-P-003:');
    expect(result.details.atomicityClauseDiagnostics).toContainEqual(
      expect.objectContaining({
        specId: 'AUTO-BAR-R-004-P-003',
        disposition: 'evaluated',
        rating: 'fail',
        reason: expect.any(String),
      }),
    );
  });

  it('fails atomicity when one observable verb joins two independently testable objects', () => {
    const behavior = 'Each daily task receives the approved source watchlist and a ten-item brief limit.';
    expect(specBehaviorNonAtomicReason(behavior)).toBe('behavior joins multiple independently observable outcomes');

    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior })],
      classRef: 'plan-class-feature-ship',
    });
    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    expect(result.details.atomicityClauseDiagnostics).toContainEqual(
      expect.objectContaining({
        specId: 'SPEC-001-01',
        disposition: 'evaluated',
        rating: 'fail',
        reason: 'behavior joins multiple independently observable outcomes',
      }),
    );
  });

  it.each([
    'The audit has exactly one evidence-based disposition and never counts queued or delivered as pickup.',
    'The audit completes the parked-agent census and records complete coverage.',
  ])('detects compound clauses whose verbs were previously missing from the detector: %s', (behavior) => {
    expect(specBehaviorNonAtomicReason(behavior)).toBe('behavior joins multiple independently observable outcomes');
  });

  it('reports draft sourceBar projections as excluded from the active atomicity population', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause(),
        clause({
          specId: 'AUTO-BAR-R-1-P-001',
          sourceValId: null,
          lifecycleStatus: 'draft',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
          sourceBar: {
            barKey: 'R-1',
            barHash: 'a'.repeat(64),
            barSetHash: 'b'.repeat(64),
            rubricSlug: 'quality-plan-acceptance',
            rubricRevision: 4,
            evidencePlane: 'tree',
          },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    const atomicity = result.ratings['atomic-observable-behavior'];
    expect(atomicity.evidence).toContain('Coverage: 1 of 1 active behavioral clause(s) evaluated');
    expect(atomicity.evidence).toContain('1 draft sourceBar-pinned projection(s) excluded from the active population');
    expect(result.details.atomicityClauseDiagnostics).toContainEqual(
      expect.objectContaining({
        specId: 'AUTO-BAR-R-1-P-001',
        disposition: 'excluded',
        rating: 'not-applicable',
        reason: 'draft sourceBar-pinned BAR projection is not an active item behavior clause.',
      }),
    );
  });

  it('keeps a single outcome with a while-condition atomic', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behavior: 'The button remains disabled while a request is pending.' })],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('pass');
  });

  it.each([
    'A machine-submitted dialog answer remains attributable to automatic input when the model or a history verifier reads it.',
    'A completed dialog answer with missing, mixed or mismatched source evidence remains unknown.',
    'The access token remains usable if the owner or an administrator authorizes it.',
    'The reply remains unknown unless the requester or a reviewer supplies evidence.',
  ])('keeps one outcome with conditional alternatives atomic: %s', (behavior) => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      clauses: [clause({ behavior })], classRef: 'plan-class-bugfix',
    });

    expect(specBehaviorNonAtomicReason(behavior)).toBeNull();
    expect(result.ratings['atomic-observable-behavior'].rating).toBe('pass');
  });

  it.each([
    'The service returns a receipt and an audit record when the model or a verifier reads it.',
    'A completed request returns a receipt and records the request.',
    'The service returns a receipt when ready and records the request.',
  ])('still rejects independent outcomes around conditional alternatives: %s', (behavior) => {
    expect(specBehaviorNonAtomicReason(behavior)).toBe('behavior joins multiple independently observable outcomes');
  });

  // WI-6554700010018277: a stative verb after "while" is the guard, not a second outcome.
  it.each([
    'Portfolio closeout refuses shipment while a required driven plan remains nonterminal.',
    'The gate rejects the candidate while its seed manifest has no sparse-core entry.',
    'The installer refuses to start while another installer process exists.',
  ])('keeps an outcome guarded by a stative while-clause atomic: %s', (behavior) => {
    expect(specBehaviorNonAtomicReason(behavior)).toBeNull();
  });

  it('still rejects an outcome verb after while as a second outcome', () => {
    expect(
      specBehaviorNonAtomicReason('The dashboard renders the banner while the sidebar renders a warning.'),
    ).toBe('behavior joins multiple independently observable outcomes');
  });

  it.each([
    'A versioned pilot price sheet reproduces idle, normal, heavy and burst costs from measured inputs, separates platform/consumption margin and specifies finite allowances and numeric experiment thresholds.',
    'The pinned current-build customer journey satisfies the hosted security/privacy and operating promises.',
  ])('rejects the independently audited compound contract: %s', (behavior) => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      clauses: [clause({ behavior })], classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('fail');
    expect(result.details.atomicityClauseDiagnostics).toContainEqual(
      expect.objectContaining({ disposition: 'evaluated', rating: 'fail', reason: expect.any(String) }),
    );
  });

  it.each([
    'The price sheet reproduces the measured cost for each workload case.',
    'The price sheet reports the platform contribution margin.',
    'The price sheet specifies the inference allowance.',
    'A revoked customer session is denied access to its workspace.',
    'The customer journey stops when the inference allowance is exhausted.',
  ])('accepts a single observable obligation: %s', (behavior) => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      clauses: [clause({ behavior })], classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('pass');
    expect(result.details.atomicityDetectorControls).toEqual([
      expect.objectContaining({ expected: 'compound', actual: 'compound', passed: true }),
      expect.objectContaining({ expected: 'compound', actual: 'compound', passed: true }),
      expect.objectContaining({ expected: 'atomic', actual: 'atomic', passed: true }),
      expect.objectContaining({ expected: 'atomic', actual: 'atomic', passed: true }),
    ]);
    expect(result.ratings['atomic-observable-behavior'].evidence).toContain('not a proof of arbitrary natural-language semantics');
  });

  it('does not count byte-identical behavior text as independent coverage for multiple plan items', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001', 'P-002'],
      clauses: [
        clause(),
        clause({
          specId: 'SPEC-002-01',
          sourceValId: 'VAL-002-01',
          planItemId: 'P-002',
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['item-contract-coverage'].rating).toBe('unknown');
    expect(result.ratings['item-contract-coverage'].evidence).toContain('same behavior text');
    expect(result.verdict).toBe('unknown');
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });

  it('blocks replay probes when the current clause set no longer matches the expected hash', () => {
    const expectedSpecSetHash = '0'.repeat(64);
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-feature-ship',
      expectedSpecSetHash,
    });

    expect(result.ratings['spec-set-freshness'].rating).toBe('unknown');
    expect(result.ratings['spec-set-freshness'].evidence).toContain(expectedSpecSetHash);
    expect(result.ratings['spec-set-freshness'].evidence).toContain(result.specSetHash);
    expect(result.verdict).toBe('unknown');
    expect(result.wouldBlock).toContain('spec-set-freshness');
  });

  it('partitions draft clauses from acceptance-provenance evidence', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause(),
        clause({
          specId: 'SPEC-002-01',
          sourceValId: 'VAL-002-01',
          lifecycleStatus: 'draft',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    const evidence = result.ratings['stable-revision-identity'].evidence;
    expect(result.ratings['stable-revision-identity'].rating).toBe('pass');
    expect(evidence).toContain('1 active/accepted current clause(s) have unique identities');
    expect(evidence).toContain(
      '1 draft current clause(s) are present and excluded from the acceptance-provenance count',
    );
    expect(evidence).not.toContain(
      '2 current clause(s) have unique identities, content hashes, and acceptance provenance',
    );
  });

  it('does not pass empty behavioral evaluations when clauses are only draft', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          lifecycleStatus: 'draft',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.ratings['atomic-observable-behavior'].rating).toBe('not-applicable');
    expect(result.ratings.falsifiability.rating).toBe('not-applicable');
    expect(result.ratings['implementation-independence'].rating).toBe('not-applicable');
    expect(result.ratings['atomic-observable-behavior'].evidence).toContain('0 active behavioral clause(s)');
    expect(result.ratings.falsifiability.evidence).toContain('0 behavioral clause(s)');
    expect(result.ratings['implementation-independence'].evidence).toContain('0 behavioral clause(s)');
    expect(result.wouldBlock).toEqual(expect.arrayContaining(['item-contract-coverage', 'plan-class-specialization']));
  });

  it('accepts a fully explicit non-behavioral investigation exemption', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [
        clause({
          lifecycleStatus: 'exempt',
          behaviorClass: 'non-automated',
          acceptedBy: null,
          acceptedAt: null,
          acceptanceRef: null,
          exemption: { justification: 'Pure editorial classification.', provenance: 'quality-plan#D-002' },
        }),
      ],
      classRef: 'plan-class-investigation',
    });

    expect(result.verdict).toBe('pass');
    expect(result.details.uncoveredPlanItemIds).toEqual([]);
    expect(result.ratings['explicit-non-behavioral-exemptions'].rating).toBe('pass');
  });

  it('refuses a mislabeled exemption and implementation-coupled behavior', () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001', 'P-002'],
      clauses: [
        clause({ behavior: 'The handler.ts function returns true' }),
        clause({
          specId: 'SPEC-002-01',
          sourceValId: 'VAL-002-01',
          planItemId: 'P-002',
          lifecycleStatus: 'exempt',
          behaviorClass: 'happy-path',
          exemption: { justification: 'No code.', provenance: 'D-002' },
        }),
      ],
      classRef: 'plan-class-feature-ship',
    });

    expect(result.wouldBlock).toEqual(
      expect.arrayContaining(['implementation-independence', 'explicit-non-behavioral-exemptions']),
    );
  });

  it('specializes bugfix and migration plans by required behavior class', () => {
    const bug = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause()],
      classRef: 'plan-class-bugfix',
    });
    const migration = evaluatePlanSpecQuality({
      planSlug: 'quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause({ behaviorClass: 'migration-data-integrity' })],
      classRef: 'plan-class-migration',
    });

    expect(bug.wouldBlock).toContain('plan-class-specialization');
    expect(migration.wouldBlock).not.toContain('plan-class-specialization');
  });
});

describe('spec-quality activation guidance', () => {
  it('accepts only a valid exact specSetHash replay guard', () => {
    expect(
      evaluateSpecQualityTool.args.safeParse({
        harness: 'papercusp',
        slug: 'quality-plan',
        expectedSpecSetHash: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      evaluateSpecQualityTool.args.safeParse({
        harness: 'papercusp',
        slug: 'quality-plan',
        expectedSpecSetHash: 'not-a-hash',
      }).success,
    ).toBe(false);
  });

  it('publishes the scorecard → automatically routed audit → start sequence', () => {
    const evaluateGuidance = [
      evaluateSpecQualityTool.description,
      evaluateSpecQualityTool.guidance?.when,
      evaluateSpecQualityTool.guidance?.returns,
      evaluateSpecQualityTool.guidance?.chaining,
    ].join('\n');
    const evaluateChain = evaluateSpecQualityTool.guidance?.chaining ?? '';
    const startGuidance = [
      startPlanTool.description,
      startPlanTool.guidance?.when,
      startPlanTool.guidance?.chaining,
    ].join('\n');

    for (const guidance of [evaluateGuidance, startGuidance]) {
      expect(guidance).toContain('plans:evaluate-spec-quality');
      expect(guidance).toContain('scorecards:emit');
      expect(guidance).toContain('grading-integrity');
      expect(guidance).toContain('plans:start');
    }
    expect(evaluateGuidance).toContain('automatically route the independent non-author');
    expect(evaluateGuidance).toContain('scorecards:repair');
    expect(evaluateGuidance).not.toContain('capability:launch-agent');
    expect(evaluateGuidance).toContain('Never recruit the auditor yourself');
    expect(evaluateChain.indexOf('plans:evaluate-spec-quality')).toBeLessThan(evaluateChain.indexOf('scorecards:emit'));
    expect(evaluateChain.indexOf('scorecards:emit')).toBeLessThan(evaluateChain.indexOf('grading-integrity'));
    expect(evaluateChain.indexOf('grading-integrity')).toBeLessThan(evaluateChain.indexOf('plans:start'));
  });
});

// WI-6554700010017142: the implementation-independence pass used to read ONLY
// clause.behavior, so a sourceBar projection whose falsifier observation named
// src/*.html, out/ and tests/fixtures/*.json earned a confident pass.
describe('implementation-independence covers falsifier observations and repository paths', () => {
  const evaluateOne = (over: Partial<SpecClauseRevision>) =>
    evaluatePlanSpecQuality({
      planSlug: 'quality-plan', harnessSlug: 'papercusp', planItemIds: ['P-001'],
      classRef: 'plan-class-feature-ship', clauses: [clause(over)],
    });

  it.each([
    'BROKEN if a clickable block has no clip in src/cup-audio/.',
    'BROKEN if wording from tests/fixtures/cupboard-brief.json appears outside a coming-soon element.',
    'BROKEN if src/architecture.html contains an inline engine script.',
    'BROKEN if out/*/index.html leaves a placeholder behind.',
  ])('fails a clean behavior whose falsifier observation names a repo path: %s', (observation) => {
    const result = evaluateOne({
      behavior: 'Every clickable block of the map plays its own narration clip.',
      falsifier: { observation, probeMethod: 'Click each block in headless Chromium.' },
    });
    expect(result.ratings['implementation-independence'].rating).toBe('fail');
    expect(result.details.implementationIndependenceClauseDiagnostics).toContainEqual(
      expect.objectContaining({
        specId: 'SPEC-001-01', disposition: 'evaluated', rating: 'fail',
        reason: expect.stringMatching(/^falsifier observation names (?:a repository path|an implementation file) /),
      }),
    );
  });

  it('fails a behavior that names a repository directory or a markup/data file', () => {
    for (const behavior of [
      'Each clip ships from src/cup-audio/ unchanged.',
      'The map config in tests/fixtures/map.json lists every block.',
    ]) {
      expect(evaluateOne({ behavior }).ratings['implementation-independence'].rating).toBe('fail');
    }
  });

  it('passes served-site observations and a probe method that names the test file', () => {
    const result = evaluateOne({
      behavior: 'Every clickable block of the map plays its own narration clip.',
      falsifier: {
        observation:
          'BROKEN if GET /architecture/index.html or https://papercusp.com/cup-tour.mp3 does not return 200, ' +
          'or a visitor who opts out/in loses that choice after a reload.',
        probeMethod: 'Run vitest tests/cupboard-map.test.js against the built out/ directory.',
      },
    });
    expect(result.ratings['implementation-independence'].rating).toBe('pass');
    expect(result.ratings['implementation-independence'].evidence).toContain('falsifier.observation');
    expect(result.ratings['implementation-independence'].evidence).toContain('falsifier.probeMethod is excluded');
  });

  it.each([
    ['Persisted draft or authenticated events are absent; live state/OS keychain changes; negative selector control passes.', 'pass'],
    ['Persisted draft or authenticated events are absent. Live state/OS keychain changes. Negative selector control passes.', 'pass'],
    ['Live state/OS keychain changes.', 'pass'],
    ['Persisted draft is absent; Redis availability changes.', 'pass'],
    ['Secrets are encrypted; the database is unavailable.', 'pass'],
    ['The file is absent; 0600 is reported as the error code.', 'pass'],
    ['Drafts are persisted in the OS keychain.', 'fail'],
    ['Secrets are stored in a 0600 file.', 'fail'],
    ['Secrets are mirrored to encrypted Postgres storage.', 'fail'],
  ] as const)('confines storage prescriptions to one clause: %s', (text, expected) => {
    for (const field of ['behavior', 'observation'] as const) {
      const value = field === 'behavior'
        ? { behavior: text }
        : { behavior: 'The draft survives restart.', falsifier: { observation: text } };
      const before = structuredClone(value);
      const result = evaluateOne(value);
      expect(result.ratings['implementation-independence'].rating, field).toBe(expected);
      expect(value).toEqual(before);
    }
  });
});

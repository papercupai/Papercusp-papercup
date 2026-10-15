/**
 * OP-BRIEF-P007-PLAN unit layer. Falsifier: FAIL if the brief reports a phase
 * or next item that differs from the authoritative plan state, or silently
 * substitutes zero for missing evidence. Fixtures: an actionable item, a
 * blocked item, and no baseline. Expected values are written out by hand from
 * the fixture graph — never recomputed through the ranking under test.
 */
import { describe, expect, it } from 'vitest';
import { renderOperationalBrief } from './brief';
import { projectPlanOperationalBrief } from './plan-brief';

type Item = {
  id: string;
  storedStatus: string;
  effectiveStatus: string;
  blockedBy?: string[];
  phase?: string | null;
  authority?: string;
};

function item(spec: Item) {
  return {
    text: `${spec.id} work`,
    importance: 'normal',
    decisionRefs: [],
    lineNumber: 1,
    blockedBy: [],
    phase: null,
    authority: 'system',
    ...spec,
  };
}

function planResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    slug: 'brief-fixture-plan',
    status: 'active',
    frontmatter: { title: 'Fixture' },
    items: [
      item({ id: 'P-001', storedStatus: 'done', effectiveStatus: 'done', phase: 'Phase 1 — core' }),
      item({ id: 'P-002', storedStatus: 'todo', effectiveStatus: 'todo', blockedBy: ['P-001'], phase: 'Phase 2 — briefs' }),
      item({ id: 'P-003', storedStatus: 'todo', effectiveStatus: 'blocked', blockedBy: ['P-002'], phase: 'Phase 2 — briefs' }),
    ],
    decisions: [
      { id: 'D-001', title: 'first', date: '2026-09-01' },
      { id: 'D-002', title: 'second', date: '2026-09-02' },
    ],
    linkedFeatures: { 'P-002': { featureId: 'WI-2', status: 'open', harnessSlug: 'h' } },
    latestAudit: {
      auditSeq: 4,
      auditKind: 'code-truth',
      createdAt: '2026-09-20T00:00:00.000Z',
      createdBy: 'su-auditor',
      items: [{ itemId: 'P-001' }],
    },
    acceptanceRubric: { rubricId: 'plan-accept-x', status: 'active', criteriaCount: 4 },
    ...overrides,
  };
}

describe('projectPlanOperationalBrief', () => {
  it('reports the actionable next item, its phase and plan-wide blockers from the items', () => {
    const brief = projectPlanOperationalBrief(planResult(), { itemsComplete: true });

    expect(brief.facts.nextItem).toMatchObject({
      status: 'known',
      value: { id: 'P-002', effectiveStatus: 'todo', reason: 'actionable', workItemId: 'WI-2' },
    });
    expect(brief.facts.phase).toMatchObject({ status: 'known', value: 'Phase 2 — briefs' });
    expect(brief.nextAction).toMatchObject({ status: 'known', value: 'Start P-002 (work-item WI-2)' });
    expect(brief.blockers).toMatchObject({ status: 'known', value: ['P-003 blocked by P-002'] });
    expect(brief.facts.counts).toMatchObject({ status: 'known', value: { total: 3, done: 1, dropped: 0, nonTerminal: 2 } });
    expect(brief.lastVerified).toMatchObject({
      status: 'known',
      value: { ref: 'plans:audit#4', at: '2026-09-20T00:00:00.000Z' },
    });
    expect(brief.facts.authority).toMatchObject({
      status: 'known',
      value: { decisionCount: 2, latestDecisions: [{ id: 'D-001' }, { id: 'D-002' }], ownerAuthorityItems: [] },
    });
  });

  it('never points at an item the same read reports as blocked (issue-block overlay)', () => {
    // P-001 is stored todo but plans:get's open-issue overlay resolved it to
    // blocked. The pure ranking alone would call it actionable.
    const result = planResult({
      items: [
        item({ id: 'P-001', storedStatus: 'todo', effectiveStatus: 'blocked', phase: 'Phase 1 — core' }),
        item({ id: 'P-002', storedStatus: 'todo', effectiveStatus: 'blocked', blockedBy: ['P-001'], phase: 'Phase 1 — core' }),
      ],
      linkedFeatures: {},
    });
    const brief = projectPlanOperationalBrief(result, { itemsComplete: true });

    expect(brief.facts.nextItem.status).toBe('known');
    const next = brief.facts.nextItem.status === 'known' ? brief.facts.nextItem.value : null;
    expect(next?.effectiveStatus).toBe('blocked');
    expect(next?.reason).toBe('blocked');
    expect(brief.nextAction.status === 'known' && brief.nextAction.value.startsWith('Unblock ')).toBe(true);
    expect(brief.blockers).toMatchObject({
      status: 'known',
      value: ['P-001 explicitly blocked', 'P-002 blocked by P-001'],
    });
  });

  it('keeps every missing baseline explicit instead of substituting zero or none', () => {
    const result = planResult({
      latestAudit: undefined,
      acceptanceRubric: undefined,
      decisions: undefined,
    });
    const brief = projectPlanOperationalBrief(result, { itemsComplete: true });

    expect(brief.lastVerified.status).toBe('unknown');
    expect(brief.owner.status).toBe('unknown');
    expect(brief.facts.acceptance.status).toBe('unknown');
    expect(brief.facts.authority.status).toBe('unknown');
    expect(brief.unknowns).toEqual(expect.arrayContaining(['owner', 'lastVerified', 'facts.acceptance', 'facts.authority']));
    expect(renderOperationalBrief(brief)).toContain('last verified: unknown (no plan audit is recorded for this plan)');
  });

  it('uses lifecycle rubric state and marks an omitted meta-mode audit as unmeasured', () => {
    const brief = projectPlanOperationalBrief(
      planResult({
        latestAudit: undefined,
        acceptanceRubric: undefined,
        lifecycle: { acceptance: { rubricActive: true, rubricRef: 'acceptance-plan-meta-fixture' } },
      }),
      { itemsComplete: true, acceptanceIncluded: true, auditIncluded: false },
    );

    expect(brief.facts.acceptance).toMatchObject({
      status: 'known',
      value: {
        source: 'acceptanceRubric',
        satisfied: null,
        summary: 'active acceptance rubric acceptance-plan-meta-fixture is attached; criteria details were not included in this read',
      },
      source: 'plans:get.lifecycle.acceptance',
    });
    expect(brief.lastVerified.status).toBe('unknown');
    expect(renderOperationalBrief(brief)).toContain(
      'last verified: unknown (plan audit was not included in this read; re-read with mode:"sections" and includeEnrichments:true)',
    );
  });

  it('refuses to report plan-wide blockers from a narrowed items selection', () => {
    const brief = projectPlanOperationalBrief(planResult(), { itemsComplete: false });
    expect(brief.blockers.status).toBe('unknown');
    expect(brief.unknowns).toContain('blockers');
  });

  it('reports an unknown next item — not null — when the read carries no item graph', () => {
    const brief = projectPlanOperationalBrief(
      { ok: true, slug: 'meta-only', status: 'draft', frontmatter: {} },
      { itemsComplete: true },
    );
    expect(brief.facts.nextItem.status).toBe('unknown');
    expect(brief.facts.counts.status).toBe('unknown');
    expect(brief.blockers.status).toBe('unknown');
    expect(brief.nextAction.status).toBe('unknown');
  });

  it('does not treat an activation audit as implementation evidence', () => {
    const brief = projectPlanOperationalBrief(
      planResult({ latestAudit: { auditSeq: 14, auditKind: 'activation', createdAt: '2026-09-19T00:00:00.000Z', items: [] } }),
      { itemsComplete: true },
    );
    expect(brief.lastVerified.status).toBe('unknown');
  });

  it('prefers a measured ship verdict and reports an unevaluable one as unknown', () => {
    const satisfied = projectPlanOperationalBrief(
      planResult({
        items: [item({ id: 'P-001', storedStatus: 'done', effectiveStatus: 'done' })],
        shipReadiness: { satisfied: true, code: null, message: 'ok' },
      }),
      { itemsComplete: true },
    );
    expect(satisfied.facts.acceptance).toMatchObject({ status: 'known', value: { source: 'shipReadiness', satisfied: true } });
    expect(satisfied.facts.phase).toMatchObject({ status: 'known', value: 'complete: every item is terminal' });
    expect(satisfied.nextAction).toMatchObject({
      status: 'known',
      value: 'All items are terminal and the ship gate is satisfied: plans:set-plan-status shipped',
    });

    const unevaluable = projectPlanOperationalBrief(
      planResult({ shipReadiness: { satisfied: false, unavailableReason: 'resolver-unavailable' } }),
      { itemsComplete: true },
    );
    expect(unevaluable.facts.acceptance.status).toBe('unknown');
  });
});

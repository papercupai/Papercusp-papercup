import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeReusePatterns,
  buildOwnerCorrectionPatterns,
  buildPlanHealthPatterns,
  buildSpendAnomalyPatterns,
  type PlanHealthRow,
} from './curation-signal-lanes';

const NOW = Date.parse('2026-07-14T00:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

describe('buildSpendAnomalyPatterns — attribution/concentration, not raw spend duplication', () => {
  it('surfaces missing trigger attribution and extreme role concentration', () => {
    const out = buildSpendAnomalyPatterns({
      windowMs: 7 * 24 * 60 * 60 * 1000,
      triggerAttributionAvailable: false,
      attributedCostShare: 0,
      byTrigger: [{ trigger: 'unattributed', costUsd: 66_000, tokens: 10, runs: 100 }],
      byRoleClass: [
        { roleClass: 'interactive', costUsd: 65_000, tokens: 9, runs: 90 },
        { roleClass: 'fleet', costUsd: 1_000, tokens: 1, runs: 10 },
      ],
    });
    expect(out.map((p) => p.ref)).toEqual(['spend:attribution-gap', 'spend:role-concentration:interactive']);
    expect(out.every((p) => p.category === 'spend-anomaly')).toBe(true);
  });

  it('stays silent below the material-spend floor', () => {
    expect(
      buildSpendAnomalyPatterns({
        windowMs: 1,
        triggerAttributionAvailable: false,
        attributedCostShare: 0,
        byTrigger: [{ trigger: 'unattributed', costUsd: 2, tokens: 10, runs: 1 }],
        byRoleClass: [],
      }),
    ).toEqual([]);
  });
});

describe('buildOwnerCorrectionPatterns — explicit owner teaching signals', () => {
  it('keeps low owner grades + verified owner-turn facts and rejects Queen/unverified noise', () => {
    const out = buildOwnerCorrectionPatterns({
      ideas: [
        {
          ideaId: 'i-low',
          routedRef: 'wi:EI-1',
          title: 'Weak idea',
          humanGrade: 2,
          humanFeedback: 'Mechanism is not falsifiable',
          gradedBy: 'owner',
          gradedAt: daysAgo(1),
        },
        { ideaId: 'i-high', routedRef: 'wi:EI-2', humanGrade: 5, gradedBy: 'owner' },
        { ideaId: 'i-queen', routedRef: 'wi:EI-3', humanGrade: 1, gradedBy: 'Queen' },
      ],
      facts: [
        {
          scope: 'harness',
          scopeRef: 'papercusp',
          key: 'prefer-push',
          body: 'Use pushed events instead of polling.',
          sourceRef: 'owner-turn',
          updatedAt: daysAgo(2),
          sourceProvenance: { kind: 'owner-turn', verified: true, verifiedAt: daysAgo(2) },
        },
        {
          scope: 'workspace',
          scopeRef: null,
          key: 'agent-guess',
          body: 'Unverified guess',
          sourceRef: null,
          updatedAt: daysAgo(1),
          sourceProvenance: null,
        },
      ],
    });
    expect(out.map((p) => p.ref)).toEqual([
      'owner-correction:idea:i-low',
      'owner-correction:fact:harness-papercusp-prefer-push',
    ]);
    expect(out[0].detail).toContain('not falsifiable');
  });
});

describe('buildKnowledgeReusePatterns — demand misses + aged one-offs', () => {
  it('turns repeated zero-hit queries and stale recipes into separate citable patterns', () => {
    const out = buildKnowledgeReusePatterns({
      demand: [
        {
          surface: 'docs',
          queryNorm: 'green checkpoint replay',
          exampleQuery: 'How do I replay the green checkpoint?',
          missCount: 9,
          distinctAgents: 4,
          lastMissedAt: daysAgo(1),
          candidateImprovementId: null,
        },
        {
          surface: 'plans',
          queryNorm: 'one fluke',
          exampleQuery: 'one fluke',
          missCount: 1,
          distinctAgents: 1,
          lastMissedAt: daysAgo(1),
          candidateImprovementId: null,
        },
      ],
      staleOneOffRecipes: [
        { id: 'reconcile-release', title: 'Reconcile release', runCount: 1, lastRunAt: daysAgo(40) },
      ],
    });
    expect(out.map((p) => p.ref)).toEqual([
      'knowledge:search-miss:docs:green-checkpoint-replay',
      'knowledge:recipe-reuse-gap',
    ]);
    expect(out[0].detail).toContain('4 distinct agent');
  });
});

function plan(over: Partial<PlanHealthRow>): PlanHealthRow {
  return {
    harnessSlug: 'papercusp',
    planSlug: 'p',
    title: 'Plan P',
    status: 'active',
    opStatus: null,
    updatedAt: daysAgo(1),
    items: [],
    ...over,
  };
}

describe('buildPlanHealthPatterns — lifecycle/index coherence, not stuck-run duplication', () => {
  it('ranks terminal/open drift ahead of drained-unclosed and stale planning backlog', () => {
    const out = buildPlanHealthPatterns(
      [
        plan({ planSlug: 'terminal-drift', status: 'shipped', items: [{ id: 'P-1', status: 'todo' }] }),
        plan({ planSlug: 'drained', status: 'active', updatedAt: daysAgo(8), items: [{ id: 'P-1', status: 'done' }] }),
        plan({
          planSlug: 'stale-draft',
          status: 'draft',
          updatedAt: daysAgo(30),
          items: [{ id: 'P-1', status: 'todo' }],
        }),
      ],
      { nowMs: NOW },
    );
    expect(out.map((p) => p.ref)).toEqual([
      'plan-health:lifecycle-drift:papercusp:terminal-drift',
      'plan-health:drained-unclosed:papercusp:drained',
      'plan-health:stale-backlog:papercusp:stale-draft',
    ]);
  });

  it('does not flag a stale operationally-started plan — watchdog already owns that signal', () => {
    expect(
      buildPlanHealthPatterns(
        [
          plan({
            planSlug: 'started',
            status: 'active',
            opStatus: 'started',
            updatedAt: daysAgo(30),
            items: [{ id: 'P-1', status: 'wip' }],
          }),
        ],
        { nowMs: NOW },
      ),
    ).toEqual([]);
  });
});

/**
 * Scout loop — `runScoutCycle` composition tests (hive-creative-ideation-2026-06-08, the P-003…P-007 seam).
 *
 * The cycle is pure orchestration over injected ports, so these tests use FAKE
 * ports + su-b6c3f's shared `./test-support` fakes (no network, $0). They pin
 * the composition's own invariants — the wiring, the survivor filter, the
 * per-idea provenance derivation (via ce4bd's `decisionsToProvenance`), the
 * budget short-circuits, and the no-human-prompt guarantee — independently of
 * any peer's step implementation.
 *
 * Run from inside the package: `cd packages/operator-core && npx vitest run lib/scout/cycle`.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeFakeScoutLlm, fixtureCorpusDigest, fixtureIdeasAllLenses, FIXTURE_PATTERN_REFS } from './test-support';
import type { CorpusEntry } from './critique-core';
import type { RoutingDecision } from './router';
import type { Idea, Proposal, ScoredIdea } from './types';
import { deriveProvenance, runScoutCycle, selectSurvivors, type ScoutCycleDeps, type ScoutCyclePorts } from './cycle';

describe('deriveProvenance — consult-deferred resume', () => {
  it('uses the carried source snapshot when the origin cycle ideas are no longer in memory', () => {
    const decisions: RoutingDecision[] = [
      {
        proposalId: 'consulted:old-cycle:proposal-1',
        sourceIdeaIds: ['idea-old'],
        rail: 'goal',
        reason: 'resumed after independent review',
        followedHint: true,
        routedRef: 'goal:goal-1',
        addressesPatternRefs: ['plan:decision-ref'],
        sourceIdeaProvenance: [
          {
            id: 'idea-old',
            lens: 'analogical',
            addressesPatternRefs: ['plan:source-ref'],
          },
        ],
      },
    ];

    expect(deriveProvenance(decisions, [], 'cycle-resume')).toEqual([
      {
        ideaId: 'idea-old',
        lens: 'analogical',
        rail: 'goal',
        routedRef: 'goal:goal-1',
        cycleId: 'cycle-resume',
        addressesPatternRefs: ['plan:source-ref', 'plan:decision-ref'],
      },
    ]);
  });
});

/* ── fixture builders ─────────────────────────────────────────────────── */

const NOVELTY_CORPUS: CorpusEntry[] = [
  { ref: 'plan:lock-contention-2026-06-01', kind: 'plan', text: 'lock contention re-queue' },
];

function scoredFrom(idea: Idea, verdict: ScoredIdea['verdict']): ScoredIdea {
  return { idea, novelty: 0.8, feasibility: 0.7, noveltyMatches: [], verdict, notes: `${verdict} note` };
}

function proposalFrom(id: string, sourceIdeaIds: string[], over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    framing: 'framing',
    mechanism: 'mechanism',
    whyNew: 'why-new',
    bet: 'the bet',
    cheapExperiment: { hypothesis: 'h', method: 'm', falsifiableSignal: 'f' },
    sourceIdeaIds,
    addressesPatternRefs: [FIXTURE_PATTERN_REFS[4]],
    ...over,
  };
}

/** A per-proposal routing decision (ce4bd's shape) the fake route port returns. */
function decisionFor(p: Proposal, rail: RoutingDecision['rail']): RoutingDecision {
  return {
    proposalId: p.id,
    sourceIdeaIds: [...p.sourceIdeaIds],
    rail,
    reason: `routed → ${rail}`,
    followedHint: false,
    title: p.framing,
    routedRef: `${rail === 'improvement' ? 'wi' : rail}:${p.id}`,
  };
}

/**
 * Build a full set of fake ports + a recording fake LLM. Each LLM-touching port
 * calls `ctx.llmCall` so the cycle's recorder + cost accounting are exercised.
 * Knobs let each test shape the per-step output + observe what the ports saw.
 */
function makeDeps(
  opts: {
    ideas?: Idea[];
    verdicts?: ScoredIdea['verdict'][]; // one per idea (default: all 'keep')
    proposals?: (scored: ScoredIdea[]) => Proposal[];
    routed?: (proposals: Proposal[]) => RoutingDecision[];
    costUsd?: number;
    limits?: ScoutCycleDeps['limits'];
    onPhase?: ScoutCycleDeps['onPhase'];
  } = {},
): {
  deps: ScoutCycleDeps;
  seen: { maxIdeators?: number; critiqueCorpus?: CorpusEntry[]; recombineInput?: ScoredIdea[] };
} {
  const ideas = opts.ideas ?? fixtureIdeasAllLenses();
  const fake = makeFakeScoutLlm({ costUsd: opts.costUsd ?? 0.01 });
  const seen: { maxIdeators?: number; critiqueCorpus?: CorpusEntry[]; recombineInput?: ScoredIdea[] } = {};

  const ports: ScoutCyclePorts = {
    readCorpus: async () => fixtureCorpusDigest(),
    readNoveltyCorpus: async () => NOVELTY_CORPUS,
    ideate: async (_digest, ctx) => {
      seen.maxIdeators = ctx.maxIdeators;
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'ideate' }], responseFormat: 'json' });
      return typeof ctx.maxIdeators === 'number' ? ideas.slice(0, ctx.maxIdeators) : ideas;
    },
    critique: async (ins, ctx) => {
      seen.critiqueCorpus = ctx.corpus;
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'critique' }], responseFormat: 'json' });
      return ins.map((idea, i) => scoredFrom(idea, opts.verdicts?.[i] ?? 'keep'));
    },
    recombine: async (scored, ctx) => {
      seen.recombineInput = scored;
      await ctx.llmCall({ model: 'm', messages: [{ role: 'user', content: 'recombine' }], responseFormat: 'json' });
      if (opts.proposals) return opts.proposals(scored);
      const survivors = selectSurvivors(scored);
      // one fused proposal over all surviving ideas (the realistic recombine output)
      return survivors.length
        ? [
            proposalFrom(
              'P-1',
              survivors.map((s) => s.idea.id),
            ),
          ]
        : [];
    },
    route: async (proposals) => (opts.routed ? opts.routed(proposals) : proposals.map((p) => decisionFor(p, 'plan'))),
  };

  return {
    deps: { ...ports, llmCall: fake.call, limits: opts.limits, ...(opts.onPhase ? { onPhase: opts.onPhase } : {}) },
    seen,
  };
}

/* ── happy path ───────────────────────────────────────────────────────── */

describe('runScoutCycle — full pass', () => {
  it('completes the digest→ideate→critique→recombine→route pipeline', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('completed');
    expect(r.digest.recurringFriction.length).toBeGreaterThan(0);
    expect(r.ideas).toHaveLength(4); // one per lens
    expect(r.scored).toHaveLength(4);
    expect(r.survivors).toHaveLength(4); // default all 'keep'
    expect(r.proposals).toHaveLength(1);
    expect(r.routed).toHaveLength(1);
    expect(r.routed[0]).toMatchObject({ proposalId: 'P-1', rail: 'plan', routedRef: 'plan:P-1' });
    expect(r.overBudget).toBe(false); // no cap set → not over budget
  });

  it('records every LLM call across the three spending steps and sums cost', async () => {
    const { deps } = makeDeps({ costUsd: 0.02 });
    const r = await runScoutCycle(deps);

    // ideate + critique + recombine each call once; route spends no LLM.
    expect(r.calls.map((c) => c.step)).toEqual(['ideate', 'critique', 'recombine']);
    expect(r.costUsd).toBeCloseTo(0.06, 5);
  });

  it('reports the active phase before each awaited cycle step', async () => {
    const phases: string[] = [];
    const { deps } = makeDeps({ onPhase: (phase) => phases.push(phase) });
    await runScoutCycle(deps);
    expect(phases).toEqual(['route', 'read-corpus', 'ideate', 'read-novelty-corpus', 'critique', 'recombine', 'route']);
  });

  it('feeds the novelty corpus to the critique step and the budget cap to ideate', async () => {
    const { deps, seen } = makeDeps({ limits: { maxIdeators: 2 } });
    const r = await runScoutCycle(deps);

    expect(seen.maxIdeators).toBe(2);
    expect(seen.critiqueCorpus).toEqual(NOVELTY_CORPUS);
    expect(r.ideas).toHaveLength(2); // clamped by maxIdeators
  });

  it('passes ALL scored ideas to recombine (the port filters survivors internally)', async () => {
    const { deps, seen } = makeDeps({ verdicts: ['keep', 'reject', 'moonshot', 'reject'] });
    await runScoutCycle(deps);
    expect(seen.recombineInput).toHaveLength(4); // not pre-filtered to survivors
  });
});

/* ── survivor selection (D-005) ───────────────────────────────────────── */

describe('selectSurvivors', () => {
  it('keeps keep + moonshot, drops reject', () => {
    const ideas = fixtureIdeasAllLenses();
    const scored = [
      scoredFrom(ideas[0], 'keep'),
      scoredFrom(ideas[1], 'reject'),
      scoredFrom(ideas[2], 'moonshot'),
      scoredFrom(ideas[3], 'reject'),
    ];
    expect(selectSurvivors(scored).map((s) => s.verdict)).toEqual(['keep', 'moonshot']);
  });
});

/* ── per-idea lens provenance (P-013 / D-009) ─────────────────────────── */

describe('runScoutCycle — provenance (P-013)', () => {
  it('attaches one provenance row per source idea of the routed proposal, carrying its lens', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle(deps);
    // 1 proposal fusing all 4 surviving ideas → 4 provenance rows, one per lens.
    expect(r.provenance).toHaveLength(4);
    expect(new Set(r.provenance.map((p) => p.lens))).toEqual(
      new Set(['analogical', 'first-principles', 'reframing', 'constraint-removal']),
    );
    for (const row of r.provenance) {
      expect(row.rail).toBe('plan');
      expect(row.routedRef).toBe('plan:P-1');
    }
  });

  it('carries the cycleId onto each provenance row when set', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle({ ...deps, cycleId: 'cyc-42' });
    expect(r.provenance.every((p) => p.cycleId === 'cyc-42')).toBe(true);
  });

  it('tags federated mutation seeds onto the routed-ledger refs without polluting grounding', async () => {
    const ideas = fixtureIdeasAllLenses().map((idea, index) =>
      index === 0 ? { ...idea, seededByRefs: ['elite:peer-a:module|sync|low:c1'] } : idea,
    );
    const { deps } = makeDeps({
      ideas,
      proposals: (scored) => [
        proposalFrom(
          'P-1',
          scored.map((s) => s.idea.id),
          {
            seededByRefs: ['elite:peer-a:module|sync|low:c1'],
          },
        ),
      ],
      routed: (proposals) =>
        proposals.map((p) => ({
          ...decisionFor(p, 'plan'),
          seededByRefs: [...(p.seededByRefs ?? [])],
        })),
    });
    const r = await runScoutCycle(deps);
    expect(r.provenance[0]?.addressesPatternRefs).toContain('seededBy:elite:peer-a:module|sync|low:c1');
    expect(r.proposals[0]?.addressesPatternRefs).toEqual([FIXTURE_PATTERN_REFS[4]]);
  });
});

/* ── short-circuits + budget (D-010) ──────────────────────────────────── */

describe('runScoutCycle — early exits', () => {
  it('drains an answered goal consult even when fresh ideation returns no ideas', async () => {
    const resumed: RoutingDecision = {
      proposalId: 'consulted:old-cycle:proposal-1',
      sourceIdeaIds: ['idea-old'],
      rail: 'goal',
      reason: 'independent review answered',
      followedHint: true,
      routedRef: 'goal:goal-reviewed',
      sourceIdeaProvenance: [{ id: 'idea-old', lens: 'analogical' }],
    };
    const { deps } = makeDeps({
      ideas: [],
      routed: (proposals) => (proposals.length === 0 ? [resumed] : []),
    });

    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('no-ideas');
    expect(r.routed).toEqual([resumed]);
    expect(r.provenance).toMatchObject([{ ideaId: 'idea-old', lens: 'analogical', routedRef: 'goal:goal-reviewed' }]);
  });

  it('stops at no-ideas when the ideators return nothing', async () => {
    const { deps } = makeDeps({ ideas: [] });
    const r = await runScoutCycle(deps);
    expect(r.stop).toBe('no-ideas');
    expect(r.proposals).toHaveLength(0);
  });

  it('stops at no-survivors when every idea is rejected', async () => {
    const { deps } = makeDeps({ verdicts: ['reject', 'reject', 'reject', 'reject'] });
    const r = await runScoutCycle(deps);
    expect(r.stop).toBe('no-survivors');
    expect(r.survivors).toHaveLength(0);
    expect(r.proposals).toHaveLength(0);
  });

  it('stops at no-proposals when recombine yields nothing', async () => {
    const { deps } = makeDeps({ proposals: () => [] });
    const r = await runScoutCycle(deps);
    expect(r.stop).toBe('no-proposals');
    expect(r.routed).toHaveLength(0);
  });

  it('EI-10779: an over-budget cap does NOT discard paid-for generation — it routes and flags overBudget', async () => {
    // ideate ($0.01) already exceeds the $0.005 cap. The OLD behavior stopped right
    // after ideate with stop='budget-exhausted' and routed NOTHING — pure sunk-cost
    // destruction (the measured $3.6-for-routed=0 pathology). The cap is now a SOFT
    // ceiling: once generation is paid for, the cycle completes the cheaper remaining
    // stages and routes what it generated, surfacing the overrun via `overBudget`.
    const { deps } = makeDeps({ costUsd: 0.01, limits: { maxCostUsd: 0.005 } });
    const r = await runScoutCycle(deps);

    expect(r.stop).toBe('completed'); // NOT 'budget-exhausted' — generation is not thrown away
    expect(r.overBudget).toBe(true); // the overrun is surfaced, not swallowed
    expect(r.calls.map((c) => c.step)).toEqual(['ideate', 'critique', 'recombine']);
    expect(r.routed).toHaveLength(1); // the paid-for ideas were ROUTED, not discarded
    expect(r.provenance.length).toBeGreaterThan(0);
  });

  it('a zero cap still refuses to spend at all — budget-exhausted, $0, overBudget false (EI-305)', async () => {
    // The read-only digest (including observation consumption stamps) still runs;
    // a 0 cap halts before the first costed step, so overBudget remains false.
    const { deps } = makeDeps({ costUsd: 0.01, limits: { maxCostUsd: 0 } });
    const readCorpus = vi.fn(deps.readCorpus);
    deps.readCorpus = readCorpus;
    const r = await runScoutCycle(deps);
    expect(readCorpus).toHaveBeenCalledTimes(1);
    expect(r.stop).toBe('budget-exhausted');
    expect(r.calls).toHaveLength(0);
    expect(r.costUsd).toBe(0);
    expect(r.overBudget).toBe(false);
    expect(r.routed).toHaveLength(0);
  });
});

/* ── autonomy: no human prompt entered the loop (D-010) ────────────────── */

describe('runScoutCycle — prompt-free autonomy', () => {
  it('issues only model calls with user/assistant roles — no human-input step', async () => {
    const { deps } = makeDeps();
    const r = await runScoutCycle(deps);
    expect(r.calls.length).toBeGreaterThan(0);
    for (const call of r.calls) {
      for (const m of call.messages) {
        expect(['user', 'assistant']).toContain(m.role);
      }
    }
    // The cycle's only input is `deps` (an injected llmCall + ports); there is
    // no human-input parameter and no human-gated step — autonomy is structural.
  });
});

/* ── WI-5391: retry-ladder deadline wiring ────────────────────────────── */

// The transport's transient-retry ladder (8 attempts + backoff) is deadline-blind;
// under a mid-cycle pool pause it outlives the cycle's own 600s timer, which then
// mislabels the honest capacity 429 as "Scout cycle timed out during phase ideate"
// (a hard error tick — the exact class that red-carded the 0.0.11-alpha blender leg,
// EI-16177). recordingLlm must therefore bound the ladder for EVERY phase's calls:
// retryDeadlineMs = cycle deadline − a 10s recording margin, so the classified error
// lands while the phase can still conclude and the tick record the true condition.
describe('runScoutCycle — WI-5391 retry-ladder deadline wiring', () => {
  it('forwards retryDeadlineMs = deadlineMs − 10s margin (and an admission bound) on every phase call', async () => {
    const { deps } = makeDeps();
    const captured: Array<{ governorMaxWaitMs?: number; retryDeadlineMs?: number }> = [];
    const inner = deps.llmCall;
    const deadlineMs = Date.now() + 600_000;
    const spied: typeof inner = async (o) => {
      captured.push({ governorMaxWaitMs: o.governorMaxWaitMs, retryDeadlineMs: o.retryDeadlineMs });
      return inner(o);
    };
    const r = await runScoutCycle({ ...deps, llmCall: spied, deadlineMs });

    expect(r.stop).toBe('completed');
    expect(captured.length).toBeGreaterThan(0); // ideate + critique + recombine all flow through
    for (const c of captured) {
      expect(c.retryDeadlineMs).toBe(deadlineMs - 10_000);
      expect(c.governorMaxWaitMs).toBeGreaterThan(0);
    }
  });

  it('injects nothing without a cycle deadline (legacy callers byte-identical)', async () => {
    const { deps } = makeDeps();
    const captured: Array<number | undefined> = [];
    const inner = deps.llmCall;
    const spied: typeof inner = async (o) => {
      captured.push(o.retryDeadlineMs);
      return inner(o);
    };
    const r = await runScoutCycle({ ...deps, llmCall: spied });

    expect(r.stop).toBe('completed');
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) expect(c).toBeUndefined();
  });
});

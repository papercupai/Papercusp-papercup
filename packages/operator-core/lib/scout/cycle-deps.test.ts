/**
 * Scout loop — `buildScoutCycleDeps` wiring tests (hive-creative-ideation-2026-06-08).
 *
 * These pin the PROD-WIRING this file uniquely owns — that each injected port is
 * bound to the right backend with options threaded through — WITHOUT re-driving
 * the full LLM pipeline (that's b6c3f's `cycle-e2e.test.ts`) or re-testing each
 * step module (their owners' suites). So: fake readers + the real `routeProposals`
 * with an injected ctx-bound plan creator, asserting the assembly + the ctx seam.
 *
 * Run from inside the package: `cd packages/operator-core && npx vitest run lib/scout/cycle-deps`.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

const getFlag = vi.hoisted(() => vi.fn(async () => false));
const createScoutPlanDraft = vi.hoisted(() =>
  vi.fn(async (input: { slug: string; title: string }) => ({ slug: `${input.slug}-2026-06-26`, created: true })),
);
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getFlag };
});
vi.mock('@papercusp/flags', () => ({ FLAGS: { SCOUT_RUBRIC_RAIL: 'scout-rubric-rail' } }));
vi.mock('./scout-plan-draft', () => ({ createScoutPlanDraft }));

// WI-5367: this is a UNIT suite — it must NEVER touch the real box-canonical :5432.
// buildScoutCycleDeps().readCorpus() (driven below) fires ~6 best-effort getOrgPg() read
// legs (watchdog/gate/coord/tool-telemetry/curation health lanes) AND a
// scout_digest_snapshots WRITE (persistDigestSnapshot, cycle_id 'cyc-deps-1'). Every leg is
// wrapped in a fail-soft try/catch, so unmocked getOrgPg silently resolved the LIVE DB and
// leaked fixture rows into it — poisoning readPreviousSnapshotRefs' newest-row read for the
// next real scout cycle. Stub getOrgPg to an empty no-op `sql` so every leg reads [] / writes
// nothing. (These lanes are incidental to what this suite pins — the assembly/ctx seam — which
// is driven entirely by the injected fake stateOfHiveReaders.)
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: (..._args: unknown[]) => Promise.resolve([] as unknown[]) }),
}));

// WI-37487/WI-37493/EI-19984192298526649 (recurring red-test watchdog flake): one of
// readCorpus()'s fail-soft health lanes transitively reaches `../dev-deploy-state`'s
// `devDeployState()`, which shells out to real `git` (optionally via the spawner
// sidecar). Under ANY ambient environment that enables/degrades the sidecar path (a
// leaked `PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR`/`PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR`,
// a slow/unavailable sidecar, or just a real subprocess spawn in general) this UNIT
// suite can trip `vitest-fail-on-console` on an unrelated `console.warn`, or simply
// perform real I/O it has no business doing — the exact same hermeticity gap WI-5367
// above closed for PG. Stub it the same way: no caller here asserts on its return
// value (every lane that reaches it is wrapped in a fail-soft try/catch), so a static
// all-null snapshot is a safe, deterministic substitute that can never shell out.
vi.mock('../dev-deploy-state', () => ({
  devDeployState: async () => ({
    integrationRoot: '/dev/null',
    releaseRoot: '/dev/null',
    releaseRef: 'main',
    integrationBranch: 'staging',
    stagingHead: null,
    originHead: null,
    stagingAheadOfOrigin: null,
    greenPin: null,
    deployed: null,
    deployedAtMs: null,
    deployedBehindStaging: null,
    greenPinBehindStaging: null,
    deployedBehindGreenPin: null,
    greenPinAtStagingHead: null,
    errors: [],
  }),
  resetDevDeployStateCache: () => {},
  classifyCommitRefFailure: (_ref: string, _repo: string, _message: string) => ({
    code: 'resolver-failed',
    reason: 'mocked in cycle-deps.test.ts',
  }),
}));

import { buildScoutCycleDeps, rosterForBudget } from './cycle-deps';
import { ScoutIdeatorsTransportError } from './ideators';
import { resolveScoutConfig } from './config';
import { makeFakeScoutLlm, fixtureProposal, fakeStateOfHiveReaders } from './test-support';
import {
  GRADER_FEEDBACK_HEADING,
  RECENT_SCOUT_FILINGS_HEADING,
  type GradedIdeaView,
  type RecentScoutFilingView,
} from './ideator-feedback-priming';
import type { StateOfHiveReaders } from './corpus-digest';
import type { CorpusEntry } from './critique-core';
import type { ArchiveEliteView, ArchivePort } from './gym-bridge';
import type { PlanDraftCreator } from './router-deps';
import type { CorpusDigest, Idea, ScoutLlmCall } from './types';

// All readers default to empty via the shared builder; override per-test as needed.
// (EI-1861 / F-FIX-040: the builder is the single place a new required reader gets
// its default, so adding one never breaks these fixtures again.)
const EMPTY_READERS: StateOfHiveReaders = fakeStateOfHiveReaders();

const NOVELTY: CorpusEntry[] = [{ ref: 'plan:prior', kind: 'plan', text: 'a prior plan' }];

beforeEach(() => {
  getFlag.mockResolvedValue(false);
  createScoutPlanDraft.mockReset();
  createScoutPlanDraft.mockImplementation(async (input: { slug: string; title: string }) => ({
    slug: `${input.slug}-2026-06-26`,
    created: true,
  }));
});

/** A never-exercised archive stub (the tests route to plan/improvement, not gym). */
const STUB_ARCHIVE = {} as ArchivePort;

function build(over: Partial<Parameters<typeof buildScoutCycleDeps>[0]> = {}) {
  const planDrafts: Array<{ slug: string; title: string }> = [];
  const createPlanDraft: PlanDraftCreator = async ({ slug, title }) => {
    planDrafts.push({ slug, title });
    return { slug };
  };
  const deps = buildScoutCycleDeps({
    harnessSlug: 'papercup',
    llmCall: makeFakeScoutLlm().call,
    createPlanDraft,
    archive: STUB_ARCHIVE,
    cycleId: 'cyc-deps-1',
    stateOfHiveReaders: EMPTY_READERS,
    digestOptions: { nowMs: 1_700_000_000_000 },
    noveltyCorpus: async () => NOVELTY,
    ...over,
  });
  return { deps, planDrafts };
}

describe('buildScoutCycleDeps — assembly', () => {
  it('defers both old consultations and all fresh dispatch rails during evaluation', async () => {
    getFlag.mockResolvedValue(true);
    const resolvedGoalConsultReader = vi.fn(async () => [fixtureProposal({ routeHint: 'goal' })]);
    const goalDispatch = vi.fn();
    const goalAmendmentDispatch = vi.fn();
    const goalFeedbackConsult = vi.fn();
    const capturePort = vi.fn();
    const experimentDispatch = vi.fn();
    const { deps, planDrafts } = build({
      deferDispatch: true, resolvedGoalConsultReader, goalDispatch,
      goalAmendmentDispatch, goalFeedbackConsult, capturePort, experimentDispatch,
    });
    expect(await deps.route([])).toEqual([]);
    expect(await deps.route(['goal', 'plan', 'gym', 'improvement', 'instance'].map(
      routeHint => fixtureProposal({ routeHint: routeHint as 'goal' }),
    ))).toEqual([]);
    for (const port of [resolvedGoalConsultReader, goalDispatch, goalAmendmentDispatch, goalFeedbackConsult, capturePort, experimentDispatch])
      expect(port).not.toHaveBeenCalled();
    expect(planDrafts).toEqual([]);
  });

  it('returns deps with every port + passthrough llmCall / limits / cycleId', () => {
    const onPhase = () => {};
    const deadlineMs = 1_700_001_200_000;
    const { deps } = build({ limits: { maxIdeators: 2, maxCostUsd: 1 }, deadlineMs, onPhase });
    for (const port of ['readCorpus', 'readNoveltyCorpus', 'ideate', 'critique', 'recombine', 'route'] as const) {
      expect(typeof deps[port]).toBe('function');
    }
    expect(deps.cycleId).toBe('cyc-deps-1');
    expect(deps.limits).toEqual({ maxIdeators: 2, maxCostUsd: 1 });
    expect(deps.deadlineMs).toBe(deadlineMs);
    expect(deps.onPhase).toBe(onPhase);
    expect(typeof deps.llmCall).toBe('function');
  });

  it('readCorpus delegates to the injected state-of-Hive readers → a CorpusDigest', async () => {
    const { deps } = build();
    const digest = await deps.readCorpus();
    for (const lane of ['recurringFriction', 'timeTokenSinks', 'chronicDeferrals', 'capabilityGaps'] as const) {
      expect(Array.isArray(digest[lane])).toBe(true);
    }
  });

  it('readNoveltyCorpus delegates to the injected reader', async () => {
    const { deps } = build();
    await expect(deps.readNoveltyCorpus()).resolves.toEqual(NOVELTY);
  });

  it.each([false, true])('readCorpus only authors rubric drafts when dispatch is enabled (deferred=%s)', async (deferDispatch) => {
    getFlag.mockResolvedValue(true);
    const onScoutDraftCreated = vi.fn(async () => {});
    const base = {
      kind: 'bug' as const,
      scope: 'harness:papercup',
      title: 'Hive coordination scorecard lacks a shared rubric',
      state: 'open' as const,
    };
    const { deps } = build({
      deferDispatch,
      onScoutDraftCreated,
      stateOfHiveReaders: fakeStateOfHiveReaders({
        friction: async () => [
          { ...base, id: 'EI-1', createdBy: 'a', createdAt: '2026-06-24T10:00:00.000Z' },
          { ...base, id: 'EI-2', createdBy: 'b', createdAt: '2026-06-24T11:00:00.000Z' },
          { ...base, id: 'EI-3', createdBy: 'c', createdAt: '2026-06-25T10:00:00.000Z' },
        ],
        rubrics: async () => [],
      }),
    });

    await deps.readCorpus();

    if (deferDispatch) {
      expect(createScoutPlanDraft).not.toHaveBeenCalled();
      expect(onScoutDraftCreated).not.toHaveBeenCalled();
      return;
    }
    expect(createScoutPlanDraft).toHaveBeenCalledTimes(1);
    expect(onScoutDraftCreated).toHaveBeenCalledWith({
      slug: 'scout-rubric-hive-coordination-scorecard-lacks-a-shared-rubric-2026-06-26',
      title: 'Rubric proposal: Hive coordination scorecard lacks a shared rubric',
    });
  });
});

describe('buildScoutCycleDeps — route wiring (ctx-bound plan creator)', () => {
  it('routes a broad proposal through the injected createPlanDraft → routedRef plan:<slug>', async () => {
    const { deps, planDrafts } = build();
    const proposal = fixtureProposal({ id: 'prop-broad', routeHint: 'plan', framing: 'a cross-cutting reframe' });

    const decisions = await deps.route([proposal]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].rail).toBe('plan');
    expect(decisions[0].routedRef).toMatch(/^plan:/);
    expect(decisions[0].proposalId).toBe('prop-broad');
    // The ctx-bound creator was actually invoked (the honest ctx seam).
    expect(planDrafts).toHaveLength(1);
    expect(decisions[0].routedRef).toBe(`plan:${planDrafts[0].slug}`);
  });

  it('wires the injected amendment port for goal-with-target without calling goal creation', async () => {
    const goalAmendmentDispatch = vi.fn(async ({ targetGoalId }: { targetGoalId: string }) => ({
      goalId: targetGoalId,
    }));
    const goalDispatch = vi.fn(async () => ({ goalId: 'wrong-new-goal' }));
    const goalFeedbackConsult = vi.fn(async ({ proposal }: { proposal: ReturnType<typeof fixtureProposal> }) => {
      const consultation = {
        originCycleId: 'cyc-deps-1',
        originalProposalId: proposal.id,
        conversationId: 'conv-test',
        status: 'unavailable' as const,
        state: 'no_qualified_responder',
        verdict: 'no_qualified_responder' as const,
        reason: 'unit fixture has no live reviewer',
      };
      return { proposal: { ...proposal, consultation }, consultation };
    });
    const { deps } = build({ goalAmendmentDispatch, goalDispatch, goalFeedbackConsult });
    const proposal = fixtureProposal({
      id: 'prop-amend',
      routeHint: 'goal',
      targetGoalId: 'goal-existing',
    });

    const decisions = await deps.route([proposal]);

    expect(decisions[0]).toMatchObject({
      proposalId: 'prop-amend',
      rail: 'goal',
      routedRef: 'goal:goal-existing',
    });
    expect(goalAmendmentDispatch).toHaveBeenCalledWith({ proposal, targetGoalId: 'goal-existing' });
    expect(goalDispatch).not.toHaveBeenCalled();
    expect(goalFeedbackConsult).toHaveBeenCalledWith({ proposal, targetGoalId: 'goal-existing' });
  });

  it('shares the one-goal creation cap across continuation and fresh route calls', async () => {
    getFlag.mockResolvedValue(true);
    const goalDispatch = vi.fn(async ({ proposal }: { proposal: ReturnType<typeof fixtureProposal> }) => ({
      goalId: `goal-${proposal.id}`,
    }));
    const resumed = fixtureProposal({
      id: 'consulted:old-cycle:resumed-goal',
      routeHint: 'goal',
      consultation: {
        originCycleId: 'old-cycle',
        originalProposalId: 'resumed-goal',
        conversationId: 'conv-resumed',
        status: 'unavailable',
        state: 'expired',
        verdict: 'failed',
        reason: 'review window expired',
      },
    });
    const fresh = fixtureProposal({ id: 'fresh-goal', routeHint: 'goal' });
    const { deps, planDrafts } = build({
      goalDispatch,
      resolvedGoalConsultReader: async () => [resumed],
    });

    const continuation = await deps.route([]);
    const freshResult = await deps.route([fresh]);

    expect(continuation[0]).toMatchObject({
      proposalId: resumed.id,
      rail: 'goal',
      routedRef: `goal:goal-${resumed.id}`,
    });
    expect(freshResult[0]).toMatchObject({
      proposalId: fresh.id,
      rail: 'plan',
    });
    expect(freshResult[0].reason).toContain('goal cap reached (0/cycle)');
    expect(goalDispatch).toHaveBeenCalledTimes(1);
    expect(planDrafts).toHaveLength(1);
  });
});

describe('buildScoutCycleDeps — ideate priming concat (C-4, scout-idea-grading P-005)', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    headline: 'busy week',
  };
  const GYM_HEADING = '## Gym stepping-stones';
  const ELITE: ArchiveEliteView = {
    nicheKey: 'module|sync|low',
    coords: { scope: 'module', domain: 'sync', risk: 'low' },
    candidateId: 'cand-1',
    fitness: 0.8,
    descriptor: { coords: { scope: 'module', domain: 'sync', risk: 'low' }, features: [0.5, 0.5, 1 / 3, 0] },
    source: 'gym',
  };
  const GRADED: GradedIdeaView[] = [
    {
      lens: 'reframing',
      ideaId: 'idea-g1',
      title: 'Speculative plan drafts',
      humanGrade: 5,
      humanFeedback: 'exactly the right altitude',
      gradedBy: 'owner',
      gradedAt: '2026-06-12T10:00:00.000Z',
    },
  ];
  const RECENT_FILINGS: RecentScoutFilingView[] = [
    {
      lens: 'reframing',
      ideaId: 'idea-recent-1',
      title: 'Retry diff summaries',
      routedAt: '2026-06-12T10:00:00.000Z',
    },
  ];

  /** A capturing fake LLM: records each ideator's user prompt, returns one valid idea. */
  function capturingLlm(): { seen: string[]; llmCall: ScoutLlmCall } {
    const seen: string[] = [];
    const llmCall: ScoutLlmCall = async (opts) => {
      seen.push([opts.system ?? '', ...opts.messages.map((m) => m.content)].join('\n'));
      return {
        text: '',
        json: { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] },
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    return { seen, llmCall };
  }

  it('grader feedback reaches EVERY ideator prompt, concatenated BELOW the gym stepping-stones', async () => {
    const { deps } = build({
      archive: { listElites: () => [ELITE], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => GRADED,
    });
    const { seen, llmCall } = capturingLlm();
    const ideas = await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    expect(ideas.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(2); // one per budget-clamped lens
    for (const prompt of seen) {
      const gymIdx = prompt.indexOf(GYM_HEADING);
      const graderIdx = prompt.indexOf(GRADER_FEEDBACK_HEADING);
      expect(gymIdx).toBeGreaterThan(-1);
      expect(graderIdx).toBeGreaterThan(gymIdx); // grader block sits BELOW the stones
      expect(prompt).toContain('- [★5 · Owner · reframing] Speculative plan drafts: exactly the right altitude');
    }
  });

  it('threads niche-map repulsion guidance into the ideator system prompt', async () => {
    const { deps } = build({
      archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => [],
    });
    const { seen, llmCall } = capturingLlm();
    await deps.ideate(
      {
        ...DIGEST,
        nicheMap: [
          {
            summary: 'crowded niche module|sync|low — 4 elites across 3 hives',
            ref: 'niche:v1:crowded:module|sync|low',
          },
          { summary: 'empty niche module|docs|low — adjacent to local winners', ref: 'niche:v1:empty:module|docs|low' },
        ],
      },
      { llmCall, maxIdeators: 2 },
    );
    for (const prompt of seen) {
      expect(prompt).toContain('## Federated niche guidance');
      expect(prompt).toContain('Crowded niches to avoid');
      expect(prompt).toContain('Empty niches to target');
    }
  });

  it('with no gym stones, the grader block still primes every ideator on its own', async () => {
    const { deps } = build({
      archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => GRADED,
    });
    const { seen, llmCall } = capturingLlm();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    for (const prompt of seen) {
      expect(prompt).not.toContain(GYM_HEADING);
      expect(prompt).toContain(GRADER_FEEDBACK_HEADING);
    }
  });

  it('with nothing graded and no stones, prompts carry no priming block (clean cold start)', async () => {
    const { deps } = build({
      archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => [],
    });
    const { seen, llmCall } = capturingLlm();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    for (const prompt of seen) {
      expect(prompt).not.toContain(GYM_HEADING);
      expect(prompt).not.toContain(GRADER_FEEDBACK_HEADING);
    }
  });

  it('primes every ideator with recent Scout filings from the injected reader', async () => {
    const { deps } = build({
      archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) },
      graderFeedbackReader: async () => [],
      recentScoutFilingReader: async () => RECENT_FILINGS,
    });
    const { seen, llmCall } = capturingLlm();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    expect(seen).toHaveLength(2);
    for (const prompt of seen) {
      expect(prompt).toContain(RECENT_SCOUT_FILINGS_HEADING);
      expect(prompt).toContain('Retry diff summaries');
      expect(prompt).toContain('Do not re-file one as-is');
    }
  });
});

describe('buildScoutCycleDeps — P-010 per-blueprint scout framing', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    headline: 'busy week',
  };
  // Hermetic ideate inputs: empty archive + empty grader reader ⇒ no PG, no priming.
  const HERMETIC = {
    archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) } as ArchivePort,
    graderFeedbackReader: async () => [] as GradedIdeaView[],
  };
  const WORK = {
    ideatorMission: 'You are a SCOUT for a WORK hive that ships deliverables.',
    criticMission: 'You are TWO critics judging an idea proposed for a WORK hive.',
  };

  /** Capturing fake recording each call's SYSTEM prompt; returns the shape each step needs. */
  function capturingSystems(): { systems: string[]; llmCall: ScoutLlmCall } {
    const systems: string[] = [];
    const llmCall: ScoutLlmCall = async (opts) => {
      const system = opts.system ?? '';
      systems.push(system);
      const json = system.includes('NOVELTY critic')
        ? { conceptualNovelty: 0.9, feasibility: 0.9, rationale: 'ok' }
        : { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] };
      return { text: '', json, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    };
    return { systems, llmCall };
  }

  it('threads framing.ideatorMission into every ideator system prompt', async () => {
    const { deps } = build({ ...HERMETIC, scoutConfig: resolveScoutConfig({ framing: WORK }) });
    const { systems, llmCall } = capturingSystems();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 2 });
    expect(systems).toHaveLength(2);
    for (const sys of systems) {
      expect(sys).toContain(WORK.ideatorMission);
      expect(sys).not.toContain('multi-agent coding platform');
      expect(sys).toContain('addressesPatternRefs'); // engine output contract preserved
    }
  });

  it('threads framing.criticMission into the critic system prompt', async () => {
    const { deps } = build({ scoutConfig: resolveScoutConfig({ framing: WORK }) });
    const { systems, llmCall } = capturingSystems();
    const i: Idea = {
      id: 'i1',
      lens: 'first-principles',
      title: 'x',
      body: 'y',
      mechanism: 'z',
      addressesPatternRefs: [],
    };
    await deps.critique([i], { llmCall, corpus: [] });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain(WORK.criticMission);
    expect(systems[0]).not.toContain('multi-agent coding platform');
    expect(systems[0]).toContain('FEASIBILITY critic'); // engine mechanism preserved
  });

  it('default config (no framing override) keeps the coding-platform framing', async () => {
    const { deps } = build(HERMETIC); // no scoutConfig ⇒ DEFAULT_SCOUT_CONFIG
    const { systems, llmCall } = capturingSystems();
    await deps.ideate(DIGEST, { llmCall, maxIdeators: 1 });
    expect(systems[0]).toContain('multi-agent coding platform');
  });
});

describe('buildScoutCycleDeps — per-blueprint model overrides', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    headline: 'busy week',
  };
  const HERMETIC = {
    archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) } as ArchivePort,
    graderFeedbackReader: async () => [] as GradedIdeaView[],
  };
  const MODEL = 'chatgpt:5.5';

  it('threads models into ideate, critique, and recombine LLM calls', async () => {
    const { deps } = build({
      ...HERMETIC,
      scoutConfig: resolveScoutConfig({
        models: { ideator: MODEL, critic: MODEL, recombine: MODEL },
      }),
    });
    const models: string[] = [];
    const llmCall: ScoutLlmCall = async (opts) => {
      models.push(opts.model);
      const system = opts.system ?? '';
      if (system.includes('NOVELTY critic')) {
        return {
          text: '',
          json: { conceptualNovelty: 0.9, feasibility: 0.9, rationale: 'ok' },
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      if (system.includes('Scout proposer')) {
        return {
          text: '',
          json: {
            framing: 'F',
            mechanism: 'M',
            whyNew: 'N',
            bet: 'B',
            experiment: { hypothesis: 'H', method: 'M', falsifiableSignal: 'S' },
            route: 'plan',
          },
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      }
      return {
        text: '',
        json: { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] },
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    };

    const ideas = await deps.ideate(DIGEST, { llmCall, maxIdeators: 1 });
    await deps.critique(ideas, { llmCall, corpus: [] });
    await deps.recombine(
      [{ idea: ideas[0], novelty: 0.9, feasibility: 0.9, noveltyMatches: [], verdict: 'keep', notes: 'ok' }],
      { llmCall },
    );

    expect(models).toEqual([MODEL, MODEL, MODEL]);
  });
});

describe('buildScoutCycleDeps — transport-death observability (P-002)', () => {
  const DIGEST: CorpusDigest = {
    recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    headline: 'busy week',
  };
  const HERMETIC = {
    archive: { listElites: () => [], seed: () => ({ admitted: false, nicheKey: '' }) } as ArchivePort,
    graderFeedbackReader: async () => [] as GradedIdeaView[],
  };

  it('throws ScoutIdeatorsTransportError when EVERY ideator LLM call fails and 0 ideas result', async () => {
    const { deps } = build(HERMETIC);
    const throwingLlm: ScoutLlmCall = async () => {
      throw new Error('gateway 401: upstream stall');
    };
    await expect(deps.ideate(DIGEST, { llmCall: throwingLlm, maxIdeators: 2 })).rejects.toThrow(
      ScoutIdeatorsTransportError,
    );
    await expect(deps.ideate(DIGEST, { llmCall: throwingLlm, maxIdeators: 2 })).rejects.toThrow(
      /all 2 ideator LLM call\(s\) failed/,
    );
  });

  it('does NOT throw when ideators run fine but genuinely produce no ideas (resolves to [])', async () => {
    const { deps } = build(HERMETIC);
    const emptyLlm: ScoutLlmCall = async () => ({
      text: '',
      json: { ideas: [] },
      costUsd: 0.01,
      inputTokens: 1,
      outputTokens: 1,
    });
    await expect(deps.ideate(DIGEST, { llmCall: emptyLlm, maxIdeators: 2 })).resolves.toEqual([]);
  });

  it('does NOT throw on a PARTIAL failure — one dead ideator never kills the batch', async () => {
    const { deps } = build(HERMETIC);
    let n = 0;
    const flakyLlm: ScoutLlmCall = async () => {
      n += 1;
      if (n === 1) throw new Error('one ideator 429');
      return {
        text: '',
        json: { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] },
        costUsd: 0.01,
        inputTokens: 1,
        outputTokens: 1,
      };
    };
    const ideas = await deps.ideate(DIGEST, { llmCall: flakyLlm, maxIdeators: 2 });
    expect(ideas.length).toBeGreaterThan(0);
  });
});

describe('rosterForBudget', () => {
  it('runs all lenses when the budget is undefined or ≥ the lens count', () => {
    expect(rosterForBudget(undefined)).toEqual({});
    expect(rosterForBudget(4)).toEqual({});
    expect(rosterForBudget(99)).toEqual({});
  });

  it('clamps to the first N lenses below the lens count, never below one', () => {
    expect(rosterForBudget(2)).toEqual({ lenses: ['analogical', 'first-principles'] });
    expect(rosterForBudget(1)).toEqual({ lenses: ['analogical'] });
    expect(rosterForBudget(0)).toEqual({ lenses: ['analogical'] });
  });

  // WI-5041: the capped roster ROTATES by staleness instead of pinning the
  // first N — the live defect that held the system at 2 distinct lenses for
  // weeks (multi-lens-routing v2 bar: >=4 distinct/7d).
  describe('lens rotation by recency (WI-5041)', () => {
    it('a capped roster runs the stalest lenses first (never-routed = most stale)', () => {
      // analogical/first-principles routed recently; the other two never routed.
      expect(rosterForBudget(2, undefined, { analogical: 1000, 'first-principles': 900 })).toEqual({
        lenses: ['reframing', 'constraint-removal'],
      });
    });

    it('alternates through the whole set across cycles (4 distinct within two capped cycles)', () => {
      // After the rotated pair routes, IT becomes the newest → the original pair returns.
      expect(
        rosterForBudget(2, undefined, {
          analogical: 1000,
          'first-principles': 900,
          reframing: 2000,
          'constraint-removal': 2100,
        }),
      ).toEqual({ lenses: ['first-principles', 'analogical'] });
    });

    it('visits every lens on a one-ideator budget even when every attempt routes zero ideas', () => {
      const recency: Record<string, number> = {};
      const visits: string[] = [];
      for (let cycle = 0; cycle < 8; cycle++) {
        const lens = rosterForBudget(1, undefined, recency).lenses![0];
        visits.push(lens);
        // The existing tick ledger records the attempt, not a fictitious route.
        recency[lens] = cycle + 1;
      }
      expect(visits.slice(0, 4)).toEqual(['analogical', 'first-principles', 'reframing', 'constraint-removal']);
      expect(visits.slice(4)).toEqual(visits.slice(0, 4));
    });

    it('empty/absent recency is byte-identical to the legacy first-N truncation (stable sort)', () => {
      expect(rosterForBudget(2, undefined, {})).toEqual({ lenses: ['analogical', 'first-principles'] });
      expect(rosterForBudget(1, undefined, {})).toEqual({ lenses: ['analogical'] });
    });

    it('the full-roster path ignores recency (weights/default roster stay in charge)', () => {
      expect(rosterForBudget(4, undefined, { analogical: 1 })).toEqual({});
      expect(rosterForBudget(undefined, undefined, { analogical: 1 })).toEqual({});
    });

    it('unknown lens keys in the recency map are harmless', () => {
      expect(rosterForBudget(1, undefined, { 'not-a-lens': 5, analogical: 10 })).toEqual({
        lenses: ['first-principles'],
      });
    });
  });
});

/**
 * EI-18697783591503819 — recurrence guard on `readNoveltyCorpus`'s routed-ledger leg.
 *
 * This is a SOURCE-POLICING test (the repo's established pattern for an invariant that
 * lives in a SQL string) because the defect it guards is invisible to every other lane:
 * the leg's own unit test injects a fake reader, so it never sees this SQL at all, and
 * this suite must never touch a real PG (WI-5367 above).
 *
 * What went wrong: the leg was `ORDER BY routed_at DESC LIMIT 500`, a recency window on a
 * ledger where `routed_ref` is NOT unique. Measured 2026-08-03 — 500 raw rows carried only
 * 275 distinct refs, the visible cutoff sat at 07-12 on a ledger reaching back to 06-11, and
 * the whole 07-01 immunology/self-tag idea cluster had aged out of view. Scout, unable to
 * see its own priors, re-generated that already-falsified idea 21 more times.
 *
 * The load-bearing insight is the ORDERING, not the limit: an "already tried and failed"
 * prior is the corpus's most decision-relevant entry and only grows more authoritative with
 * age, so evicting oldest-first discards exactly what novelty-checking depends on. Raising
 * the limit alone would NOT fix that, which is why both properties are asserted.
 */
describe('readNoveltyCorpus routed-ledger leg (EI-18697783591503819)', () => {
  const legSql = (() => {
    const src = readFileSync(new URL('./cycle-deps.ts', import.meta.url), 'utf8');
    const start = src.indexOf('FROM harness_shared.scout_routed_ideas');
    if (start < 0) throw new Error('routed-ledger leg not found in cycle-deps.ts');
    // The leg's statement: back up to its SELECT, forward to the closing backtick.
    return src.slice(src.lastIndexOf('SELECT', start), src.indexOf('`', start));
  })();

  it('dedupes by routed_ref — a re-routed idea must not spend N corpus slots', () => {
    expect(legSql).toMatch(/DISTINCT ON \(routed_ref\)/);
  });

  it('ranks DECIDED priors ("already tried, failed") ahead of recency', () => {
    // The alreadyTried signal must survive eviction; a bare recency sort drops it first.
    expect(legSql).toMatch(/ORDER BY\s+\(outcome IS NOT NULL\) DESC/);
  });

  it('does not reintroduce the bare recency window that caused the regression', () => {
    // The exact prior shape: a top-level recency sort with no dedup ahead of it.
    const bareRecencyWindow =
      /ORDER BY routed_at DESC\s+LIMIT/.test(legSql) && !/DISTINCT ON \(routed_ref\)/.test(legSql);
    expect(bareRecencyWindow).toBe(false);
  });
});

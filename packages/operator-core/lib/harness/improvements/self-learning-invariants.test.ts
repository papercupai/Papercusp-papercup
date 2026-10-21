/**
 * self-learning-invariants.test.ts — Phase 7 / P-060 of
 * self-learning-central-2026-06-06: the six load-bearing invariants of the
 * self-learning loop, pinned in one place.
 *
 *   1. Reflection fires at the work-item boundary + on each friction marker —
 *      and NOT as a per-turn reflection pass (a clean turn costs ~nothing).
 *   2. The matcher dedups across REPHRASINGS (stable signature, not raw title).
 *   3. Recurrence-decay REOPENS a regressed item (resolved → re-surfaced →
 *      re-filed → recurred → re-triaged).
 *   4. Type-routing (D-005): product → place; process-prompt → gym-or-gate
 *      (never auto-place); code-bug follows the POLICY tier (D-003).
 *   5. The never-auto set blocks graduation of a safety-gate path — even a
 *      fully-graduated autoKinds config cannot promote the safety surfaces.
 *   6. The Change Feed regenerates from completion records — a derived view,
 *      no parallel log (D-005).
 *
 * Per-module behavior lives in the colocated suites (friction-markers,
 * capture-core, digest, triage, policy, lifecycle, watchdog, change-feed,
 * complete.test.ts for the boundary wiring); THIS suite pins the cross-module
 * invariant arcs those tests don't compose.
 */

import { describe, it, expect, vi } from 'vitest';
import { loadObservationPractice } from '@papercusp/orchestrator/role-prompt';
import {
  UNIVERSAL_FRICTION_MARKERS,
  HARNESS_PIPELINE_FRICTION_MARKERS,
  renderFrictionTripwire,
  renderReflectStep,
} from './friction-markers';
import { captureImprovement, type CaptureDeps } from './capture-core';
import { IMPROVEMENT_TOPIC, OBSERVATION_TOPIC } from './read-items';
import { runWatchdogTick } from './watchdog';
import { dedupSignature, titleSimilarity, signatureRecurrence } from './digest';
import { classifyIdeaType, triageIdea } from './triage';
import {
  classifyImprovement,
  DEFAULT_RISK_TIER_POLICY,
  type ImprovementCandidate,
  type RiskTierPolicy,
  type WorkItemKind,
} from './policy';
import { checkDecayOutcome, isValidTransition } from './lifecycle';
import {
  gatherCompletions,
  type ChangeFeedEntry,
  type ChangeFeedReaders,
} from '../../curation/change-feed';
import type { EngineerIssue } from '../../issues-engineer';

// ── shared fixtures ──────────────────────────────────────────────────────────

function issue(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    parent: null,
    createdBy: null,
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    completionAuthority: null,
    featureOrder: null,
    goalId: null,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    closedAt: null,
    ...p,
  };
}

function captureDeps(found: EngineerIssue[] = []): CaptureDeps & { createdTitles: string[] } {
  const createdTitles: string[] = [];
  return {
    createdTitles,
    searchIssues: async () => found,
    createIssue: async (input) => {
      createdTitles.push(input.title);
      return issue({ id: `EI-${100 + createdTitles.length}`, title: input.title });
    },
  };
}

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: 'a thing', state: 'open', ...p };
}

// ── 1. reflection fires at boundary + on markers, NOT per turn ──────────────

describe('P-060.1 — reflection: boundary + friction markers, never a per-turn pass', () => {
  it('the per-turn surface is ONE shared trip-wire string — brain base ≡ bee base (no desync)', () => {
    // Both prompt paths load the same identity-owned section; if these ever
    // diverge, the Queen and the bees are reading different rules.
    expect(renderFrictionTripwire()).toBe(loadObservationPractice().frictionTripwire);
  });

  it('the trip-wire is NOT a reflection step: it fires on felt friction, and says so', () => {
    const t = renderFrictionTripwire();
    expect(t.toLowerCase()).toContain("don't reflect every turn");
    expect(t.toLowerCase()).toContain('trip on real friction');
    // The structured reflect language is reserved for the completion boundary.
    expect(t).not.toContain('Reflect (once');
  });

  it('the completion-boundary step enumerates EVERY universal marker (each marker fires)', () => {
    const step = renderReflectStep();
    for (const m of UNIVERSAL_FRICTION_MARKERS) {
      expect(step, `marker ${m.id} must be in the reflect step`).toContain(m.signal);
    }
  });

  it('the pipeline markers fire only when the unit of work ran the coding harness', () => {
    const free = renderReflectStep({ harnessActive: false });
    const piped = renderReflectStep({ harnessActive: true });
    for (const m of HARNESS_PIPELINE_FRICTION_MARKERS) {
      expect(free).not.toContain(m.signal);
      expect(piped).toContain(m.signal);
    }
  });

  it('a clean turn captures NOTHING: the watchdog tick with zero signals makes zero captures', async () => {
    const capture = vi.fn();
    const res = await runWatchdogTick('ws', {}, {
      collect: async () => [],
      capture,
      recordTick: async () => {},
      withTickLock: async (_ws, fn) => ({ ran: true, value: await fn() }),
    });
    expect(res).toMatchObject({ status: 'ran', signals: 0, captured: [], declinedDuplicates: 0, deferred: 0, selfEscalations: [] });
    expect(capture).not.toHaveBeenCalled();
  });

  it('a clean completion instructs capture-NOTHING (sparseness is the quality filter)', () => {
    expect(renderReflectStep().toLowerCase()).toContain('capture nothing');
  });
});

// ── 1b. observations (D-005) are isolated from the work/triage lane ──────────

describe('P-060.7 — D-005: observations never enter the work/triage lane', () => {
  function obsDeps() {
    const created: Array<{ topics?: string[]; kind?: string }> = [];
    const d: CaptureDeps = {
      // a same-title existing row — observations must STILL re-file (no dedup decline)
      searchIssues: async () => [issue({ id: 'EI-DUP', title: 'a recurring observation' })],
      createIssue: async (input) => {
        created.push({ topics: input.topics, kind: input.kind });
        return issue({ id: 'EI-OBS', title: input.title, kind: (input.kind as 'bug' | 'change') ?? 'change' });
      },
    };
    return { created, d };
  }

  it('the observation topic is DISTINCT from the improvement topic', () => {
    expect(OBSERVATION_TOPIC).not.toBe(IMPROVEMENT_TOPIC);
  });

  it('a lane:observation capture files the observation topic + a non-bug — no topic:improvement reader or the auto-implement lane ever sees it', async () => {
    const { created, d } = obsDeps();
    await captureImprovement({ title: 'a recurring observation', kind: 'bug', lane: 'observation' }, d);
    expect(created[0].topics).toContain(OBSERVATION_TOPIC);
    expect(created[0].topics).not.toContain(IMPROVEMENT_TOPIC); // invisible to readImprovementItems
    expect(created[0].kind).toBe('change'); // kind=bug ignored → splitCandidates (needs kind=bug) can never auto-implement it
  });

  it('observations skip dedup — a RECURRING one re-files (recurrence IS the signal Scout clusters)', async () => {
    const { d } = obsDeps();
    const res = await captureImprovement({ title: 'a recurring observation', kind: 'change', lane: 'observation' }, d);
    expect(res.created).toBe(true);
  });

  /**
   * EI-17036 — THE ONE FIELD THE WHOLE FLOOR RESTS ON.
   *
   * `observationLaneExclusionSql` (work-items.ts) is exactly `wi.lane IS DISTINCT FROM
   * 'observation'`, and `lane` is `GENERATED ALWAYS AS (payload ->> 'lane') STORED`
   * (migration 721). So D-005's "never enters the work queue" is carried by ONE payload
   * key — `payload.lane` — and by nothing else.
   *
   * In particular it does NOT key on `payload.observation`. A row carrying a full
   * observation (rubricRef, ratings, evidence) but no `lane` key reads `lane = NULL`, and
   * `NULL IS DISTINCT FROM 'observation'` is TRUE, so the floor INCLUDES it and
   * `scheduler:get_next` serves a scorecard as claimable work. That is not hypothetical:
   * 38 such rows existed (17 of them open, filed 2026-07-13..07-25 by a writer that has
   * since been fixed), and one — EI-17036, a `pot-coordination-health` scorecard — was
   * handed to an agent as work. Migration 793 backfilled them.
   *
   * The tests above pin the TOPIC and the KIND, which is what keeps an observation away
   * from the digest and the auto-implement tier. Neither of those is what the claim floor
   * reads, so neither would have caught the leak. This pins the field that actually does.
   */
  it('a lane:observation capture STAMPS payload.lane — the only field the D-005 claim floor reads', async () => {
    const payloads: Array<Record<string, unknown> | undefined> = [];
    const deps: CaptureDeps = {
      searchIssues: async () => [],
      createIssue: async (input) => {
        payloads.push(input.payload as Record<string, unknown> | undefined);
        return issue({ id: 'EI-OBS', title: input.title, kind: 'change' });
      },
    };

    await captureImprovement({ title: 'a sensor reading', kind: 'change', lane: 'observation' }, deps);

    // The exact string the floor compares against — not merely "some lane was set".
    expect(payloads[0]?.lane).toBe('observation');
  });

  it('an improvement capture does NOT stamp the observation lane — the floor must not swallow real work', async () => {
    // The opposite direction, and the dangerous one: over-stamping would hide genuine
    // claimable improvements from every agent, silently and with no error anywhere.
    const payloads: Array<Record<string, unknown> | undefined> = [];
    const deps: CaptureDeps = {
      searchIssues: async () => [],
      createIssue: async (input) => {
        payloads.push(input.payload as Record<string, unknown> | undefined);
        return issue({ id: 'EI-IMP', title: input.title, kind: 'bug' });
      },
    };

    await captureImprovement({ title: 'a real friction worth fixing', kind: 'bug' }, deps);

    // Asserted BEFORE the negative: `undefined?.lane` is also `not.toBe('observation')`, so
    // without this the negative would pass just as happily on a capture that wrote no payload
    // at all — a vacuous green exactly where the leak lives.
    expect(payloads[0]).toBeDefined();
    expect(payloads[0]?.lane).not.toBe('observation');
  });
});

// ── 2. the matcher dedups across rephrasings ─────────────────────────────────

describe('P-060.2 — the matcher dedups across rephrasings (stable signature)', () => {
  const PHRASINGS = [
    '[bug] Presence list dumps stale rows!',
    'STALE rows... dumps presence list',
    'presence dumps; list — stale rows',
  ];

  it('word order, case, punctuation, and the [kind] prefix all collapse to ONE signature', () => {
    const sigs = new Set(PHRASINGS.map(dedupSignature));
    expect(sigs.size).toBe(1);
  });

  it('a rephrased capture of an OPEN friction still FILES (P-002 D-001) but names the open twin', async () => {
    const open = issue({ id: 'EI-7', title: PHRASINGS[0], state: 'open' });
    const d = captureDeps([open]);
    const res = await captureImprovement({ title: PHRASINGS[1], kind: 'bug' }, d);
    // P-002 (D-001): the search-first DECLINE is retired — a duplicate-classified filing now
    // CREATES, and the 'likely-duplicate' verdict rides payload.dedupVerdict as an annotation,
    // never as a created:false gate. The twin is still surfaced so the caller can link/coalesce.
    expect(res.created).toBe(true);
    expect(res.reason).not.toBe('likely-duplicate');
    expect(res.possibleDuplicates?.[0]?.id).toBe('EI-7');
  });

  it('near-rephrasings (an extra filler word) still match above the capture threshold', () => {
    const sim = titleSimilarity(
      'coord inbox overflows the token budget',
      'token budget overflows coord inbox',
    );
    expect(sim).toBeGreaterThanOrEqual(0.6);
  });

  it('a genuinely different friction does NOT collide', () => {
    expect(
      titleSimilarity('presence list dumps stale rows', 'vite dev server drops websocket frames'),
    ).toBeLessThan(0.6);
  });
});

// ── 3. recurrence-decay reopens a regressed item ─────────────────────────────

describe('P-060.3 — recurrence-decay reopens a regressed item (the full arc)', () => {
  const NOW = Date.parse('2026-06-07T00:00:00Z');
  const original = issue({
    id: 'EI-1',
    title: 'lock contention stomps concurrent edits',
    state: 'resolved', // the idea was applied; the issue was resolved
    updatedAt: '2026-06-01T00:00:00Z',
  });

  it("step 1 — the regression RE-FILES: dedupScope:'open' does not decline on a RESOLVED match (even reworded)", async () => {
    const d = captureDeps([original]);
    const res = await captureImprovement(
      // The watchdog's mode — a resolved duplicate means the problem regressed.
      { title: 'concurrent edits stomps lock contention', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true); // re-filed, not declined
    expect(res.possibleDuplicates?.[0]?.id).toBe('EI-1'); // …with the original surfaced
  });

  it('step 2 — the recurrence shows on the STABLE signature: count > 1 across the rephrasings', () => {
    const refile = cand({
      id: 'EI-2',
      title: 'concurrent edits stomps lock contention',
      state: 'open',
      updatedAt: '2026-06-06T00:00:00Z',
    });
    const recs = signatureRecurrence(
      [cand({ id: 'EI-1', title: original.title, state: 'resolved', updatedAt: original.updatedAt }), refile],
      { nowMs: NOW },
    );
    expect(recs).toHaveLength(1); // one signature, two captures
    expect(recs[0].count).toBe(2);
    expect(recs[0].openCount).toBe(1);
    expect(recs[0].resolvedCount).toBe(1);
  });

  it('step 3 — the applied idea REOPENS: checkDecayOutcome moves it to recurred(regressed) → re-triage', () => {
    const lifecycle = {
      state: 'applied' as const,
      stateUpdatedAt: '2026-06-02T00:00:00Z',
      ideaType: 'product' as const,
    };
    const out = checkDecayOutcome(lifecycle, { count: 2, decayDays: 1, resolvedCount: 1 });
    expect(out?.state).toBe('recurred');
    expect(out?.decayResult).toBe('regressed');
    expect(isValidTransition('recurred', 'triaged')).toBe(true); // back into the Queen's queue
  });

  it('counter-case — NO recurrence for 14+ days verifies the idea instead (decay = worked)', () => {
    const lifecycle = {
      state: 'applied' as const,
      stateUpdatedAt: '2026-05-20T00:00:00Z',
      ideaType: 'product' as const,
    };
    const out = checkDecayOutcome(lifecycle, { count: 1, decayDays: 17, resolvedCount: 1 });
    expect(out?.state).toBe('verified');
    expect(out?.decayResult).toBe('worked');
  });
});

// ── 4. type-routing: product → place, process-prompt → gym-or-gate (D-005) ──

describe('P-060.4 — type-route: product → place, process-prompt → gym-or-gate', () => {
  const scored = (scope: string, title: string) =>
    ({ id: 't', kind: 'change', title, scope, score: 10 }) as Parameters<typeof triageIdea>[0];

  it('a product idea (another project) routes to PLACE with the target harness', () => {
    const d = triageIdea(scored('harness:sheets', 'add pivot tables to the grid'));
    expect(d.decision).toBe('place');
    expect(d.target).toBe('harness:sheets');
  });

  it('a prompt-change idea (the system itself) routes to gym-or-gate — NEVER auto-place', () => {
    for (const scope of ['operator', 'harness:papercup']) {
      const d = triageIdea(scored(scope, 'rewrite the validator prompt'));
      expect(['gate', 'gym']).toContain(d.decision);
      expect(d.decision).not.toBe('place');
      // The gate reason names the gym A/B alternative (D-003/P-040: the Queen
      // may override the recommendation to 'gym' for verification before live).
      expect(d.reason.toLowerCase()).toMatch(/gym/);
    }
  });

  it('an unscoped idea defaults to the cautious lane (code-bug WITHOUT a policy auto verdict → gate)', () => {
    const c = classifyIdeaType(scored(undefined as unknown as string, 'something vague'));
    expect(c.type).toBe('code-bug');
    // No tier on the item (the policy never ran) → never auto-place (D-003).
    expect(triageIdea(scored(undefined as unknown as string, 'something vague')).decision).not.toBe('place');
  });
});

// ── 5. the never-auto set blocks graduation of a safety-gate path ────────────

describe('P-060.5 — never-auto: graduation cannot promote a safety-gate surface (P-041)', () => {
  const ALL_KINDS: WorkItemKind[] = ['feature', 'bug', 'change', 'chunk'];
  /** The maximal graduation: every kind auto-eligible. The protected sets must STILL gate. */
  const FULLY_GRADUATED: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ALL_KINDS };

  const SAFETY_KEYWORD_TITLES: Array<[string, string]> = [
    ['dont-deploy-on-red', 'skip the dont-deploy-on-red check when the queue is long'],
    ['budget cap', 'raise the fleet budget cap automatically under load'],
    ['quota cap', 'lift the spawn quota cap on weekends'],
    ['auth perimeter', 'relax the auth perimeter for loopback tools'],
    ['double-allocate', 'allow double-allocate of work slots for throughput'],
  ];

  it('the P-041 autoloop safety-gate inventory IS in the never-auto keyword set', () => {
    for (const [keyword] of SAFETY_KEYWORD_TITLES) {
      expect(DEFAULT_RISK_TIER_POLICY.protectedKeywords).toContain(keyword);
    }
  });

  it.each(SAFETY_KEYWORD_TITLES)(
    'the autoloop safety-gate inventory blocks "%s" even under FULL graduation',
    (_keyword, title) => {
      const d = classifyImprovement(cand({ id: 'k', kind: 'change', title }), FULLY_GRADUATED);
      expect(d.tier).toBe('human');
      // The hit may be a broader keyword that matches first (e.g. 'deploy'
      // inside 'dont-deploy-on-red') — the invariant is that it IS a keyword block.
      expect(DEFAULT_RISK_TIER_POLICY.protectedKeywords).toContain(d.protectedHit);
    },
  );

  const SAFETY_PATHS = [
    'packages/operator-core/lib/release/deploy-cli.ts', // the deploy machinery
    'packages/operator-core/lib/dbos/engine.ts', // the loop's scheduler
    'packages/operator-core/lib/harness/routines/runner.ts',
    'packages/operator-core/lib/git-sync/sync.ts',
    'libs/papercusp/packages/locks/src/authority.ts',
    'libs/papercusp/libs/db/sql/200-anything.sql', // migrations
    'libs/flags/src/types.ts', // the loop's master switch
    'packages/operator-core/lib/harness/improvements/policy.ts', // the loop itself (bootstrapping)
    'packages/operator-core/lib/agent-tools/improvements/capture.ts',
    'apps/operator/lib/auth/session.ts',
    'apps/operator/lib/credentials/store.ts',
  ];

  it.each(SAFETY_PATHS.map((p) => [p]))('the protected-path set blocks %s under FULL graduation', (path) => {
    const d = classifyImprovement(cand({ id: 'p', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBeTruthy();
  });

  it('graduation still WORKS off the safety surfaces (the never-auto set is the only block)', () => {
    const d = classifyImprovement(
      cand({
        id: 'ok',
        kind: 'feature',
        title: 'nicer empty-state for the inbox panel',
        paths: ['apps/operator/app/inbox/EmptyState.tsx'],
      }),
      FULLY_GRADUATED,
    );
    expect(d.tier).toBe('auto');
  });

  it('the default (ungraduated) policy is stricter, never looser, than the graduated one', () => {
    // Everything human under default that is auto under graduation must be a
    // pure kind-gate difference — the protected sets are identical objects.
    expect(FULLY_GRADUATED.protectedPathPatterns).toEqual(DEFAULT_RISK_TIER_POLICY.protectedPathPatterns);
    expect(FULLY_GRADUATED.protectedKeywords).toEqual(DEFAULT_RISK_TIER_POLICY.protectedKeywords);
  });
});

// ── 6. the Change Feed regenerates from completions — no parallel log ────────

describe('P-060.6 — Change Feed: derived from completion records, no parallel log', () => {
  function entry(id: string, ts: string, kind: ChangeFeedEntry['kind'] = 'completion'): ChangeFeedEntry {
    return { id, kind, title: `t:${id}`, ref: id, ts };
  }

  /** A mutable "completion store" the readers derive from — the SOURCE of truth. */
  function sourceBackedReaders(store: { completions: ChangeFeedEntry[]; proposals: ChangeFeedEntry[] }) {
    const calls = { completions: 0, proposals: 0, plans: 0 };
    const readers: ChangeFeedReaders = {
      async workItemCompletions() {
        calls.completions += 1;
        return [...store.completions];
      },
      async gymProposals() {
        calls.proposals += 1;
        return [...store.proposals];
      },
      async planRuns() {
        calls.plans += 1;
        return [];
      },
    };
    return { readers, calls };
  }

  it('regenerating (same sources) produces the IDENTICAL feed — pure derivation, no internal state', async () => {
    const store = {
      completions: [entry('wi:F-1', '2026-06-06T10:00:00Z')],
      proposals: [entry('gym:p-1', '2026-06-06T09:00:00Z', 'proposal')],
    };
    const { readers } = sourceBackedReaders(store);
    const first = await gatherCompletions(readers);
    const second = await gatherCompletions(readers);
    expect(second).toEqual(first);
  });

  it('the feed FOLLOWS the sources: a new completion appears, a removed one vanishes (no log residue)', async () => {
    const store = {
      completions: [entry('wi:F-1', '2026-06-06T10:00:00Z')],
      proposals: [entry('gym:p-1', '2026-06-06T09:00:00Z', 'proposal')],
    };
    const { readers } = sourceBackedReaders(store);
    expect((await gatherCompletions(readers)).map((e) => e.id)).toEqual(['wi:F-1', 'gym:p-1']);

    // A new work-item completes → next regeneration includes it.
    store.completions.push(entry('wi:F-2', '2026-06-07T08:00:00Z'));
    expect((await gatherCompletions(readers)).map((e) => e.id)).toEqual(['wi:F-2', 'wi:F-1', 'gym:p-1']);

    // The source record goes away → the feed forgets it (derived, NOT logged:
    // a parallel log would still carry the dead entry).
    store.proposals.length = 0;
    expect((await gatherCompletions(readers)).map((e) => e.id)).toEqual(['wi:F-2', 'wi:F-1']);
  });

  it('every entry references its ORIGINAL record (the rationale:feed drill-in contract)', async () => {
    const store = {
      completions: [entry('wi:F-1', '2026-06-06T10:00:00Z')],
      proposals: [entry('gym:p-1', '2026-06-06T09:00:00Z', 'proposal')],
    };
    const { readers } = sourceBackedReaders(store);
    for (const e of await gatherCompletions(readers)) {
      expect(e.ref).toBeTruthy();
      expect(e.ref).toMatch(/^(wi|gym|plan):/);
    }
  });

  it('each gather reads each source exactly once — there is nowhere else to read from', async () => {
    const store = { completions: [], proposals: [] };
    const { readers, calls } = sourceBackedReaders(store);
    await gatherCompletions(readers);
    await gatherCompletions(readers);
    expect(calls).toEqual({ completions: 2, proposals: 2, plans: 2 });
  });
});

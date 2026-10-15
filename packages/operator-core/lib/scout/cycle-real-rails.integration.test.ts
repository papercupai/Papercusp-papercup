/**
 * cycle-real-rails.integration.test.ts — Scout loop against REAL storage
 * (scout-loop-test-plan-2026-06-11 P-002).
 *
 * Drives ONE `runScoutCycle` pass over the PRODUCTION composition
 * (`buildScoutCycleDeps` — real ideators / critics / recombine / router) with
 * the shared fake LLM (`makeFakeScoutLlm`) and REAL dispatch ports against a
 * fresh, fully-migrated testcontainers Postgres, proving all four routing
 * rails land in real storage in one cycle:
 *
 *   1. broad proposal     → a REAL draft plan row (`harness_shared.harness_plans`)
 *                           through the production system-side creator
 *                           (`createScoutPlanDraft` → withPlanLock → withWorkspace,
 *                           the same seam `productionScoutRunner` wires);
 *   2. testable proposal  → a REAL gym QD archive row (`harness_shared.gym_qd_archive`,
 *                           migration 193) through `buildScoutArchivePort` →
 *                           seedDistantNiches → flush → PgArchiveStore;
 *   3. concrete proposal  → a REAL improvements/idea-queue row
 *                           (`harness_shared.engineer_issues`) through the real
 *                           `captureImprovement` → `createIssue` (+ topic tag);
 *   4. provenance         → REAL rows in `harness_shared.scout_routed_ideas`
 *                           (migration 194) via `recordRoutedIdea`, persisted
 *                           exactly the way the scheduler's `persistRouted` does.
 *
 * What is faked (each an intentional, documented seam):
 *   - the LLM (`makeFakeScoutLlm` responders scripted so the real recombine step
 *     emits one proposal per rail via its routeHint — see the responders below);
 *   - the state-of-Hive readers + novelty corpus (the `stateOfHiveReaders` /
 *     `noveltyCorpus` overrides `buildScoutCycleDeps` documents for tests) —
 *     the digest SYNTHESIS itself is the real `synthesizeStateOfHive`;
 *   - `lib/sync-sse` (vi.mock): capture-core fire-and-forgets an SSE invalidate;
 *     the real module opens a long-lived PG LISTEN bus — out of scope here.
 *
 * Wiring: the real `@papercusp/db-org` connection path is ENV-ROUTED at the
 * throwaway migrated DB (`HARNESS_DATABASE_URL` / `HARNESS_ADMIN_DATABASE_URL`
 * + cache resets), the same pattern as agent-tools/plans/__tests__/
 * _pg-tool-fixture.ts and lib/_baseline-coord-fixture.ts — so every production
 * module (getOrgPg / withWorkspace / issues-engineer / PgArchiveStore /
 * routed-ledger) hits the same real schema with NO module mocks.
 *
 * (Historical note: until 2026-06-11 `deriveProvenance` dropped the routing
 * decision's `addressesPatternRefs` — `RoutedIdeaProvenance` had no refs field —
 * so `scout_routed_ideas.addresses_pattern_refs` was always NULL through the
 * production tick path. Fixed the same night this test pinned it: the refs now
 * thread idea → provenance → ledger, asserted below at both levels.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// capture-core lazily imports lib/sync-sse to fire a sync invalidate after a
// create; the real module wires a PG LISTEN bus (host-only). Stub the notify.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

// Pin the Scout OVERLAY rails OFF. This test asserts the BASE cycle = exactly 9
// step-tagged LLM calls (3 ideate / 3 critique / 3 recombine). SCOUT_EXPERIMENT_RAIL
// (and SCOUT_RUBRIC_RAIL) graduated default-ON and each spends an EXTRA, untagged
// LLM call per testable proposal (forkTestableToExperiments → generateExperimentRequest),
// pushing the count to 10. The overlay rails have their own coverage; keep this test on
// the base cycle. Other flags delegate to the real resolver.
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return {
    ...actual,
    getFlag: async (flag: Parameters<typeof actual.getFlag>[0], distinct: string) =>
      flag === 'papercusp-scout-experiment-rail' || flag === 'papercusp-scout-rubric-rail'
        ? false
        : actual.getFlag(flag, distinct),
  };
});

import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes (same as _pg-tool-fixture)
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { registerHarnessProject } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { runScoutCycle, type ScoutCycleResult } from './cycle';
import { buildScoutCycleDeps } from './cycle-deps';
import { createScoutPlanDraft } from './scout-plan-draft';
import { buildScoutArchivePort, type ScoutArchivePort } from './scout-archive-port';
import { readRoutedIdeas, recordRoutedIdea } from './routed-ledger';
import { makeFakeScoutLlm, fakeStateOfHiveReaders, type ScoutLlmResponder } from './test-support';
import type { StateOfHiveReaders } from './corpus-digest';
import type { RoutingDecision } from './router';
import { listIssues } from '../issues-engineer';
import { IMPROVEMENT_TOPIC } from '../harness/improvements/read-items';

const WS = 'ws-scout-real-rails';
const HARNESS = 'scout-rails-it';
const CYCLE_ID = 'cycle-real-rails-1';
/** Pinned through the createPlanDraft ctx seam so the dated slug is deterministic. */
const PLAN_DATE = '2026-06-10';
/** The one digest meta-pattern ref every fake idea grounds in (from the friction cluster). */
const PATTERN_REF = 'wi:F-101';

/* ────────────────────────────────────────────────────────────────────────
 * Fake-LLM script — one grounded idea per lens, one proposal per rail.
 *
 * limits.maxIdeators=3 clamps the roster to the first three lenses
 * (analogical, first-principles, reframing — rosterForBudget), so the cycle
 * issues exactly 3 ideator + 3 critic + 3 recombine calls. Novelty scores are
 * strictly descending so planRecombinations' novelty sort is total (no tie
 * order assumptions) and each survivor recombines alone (title/body token sets
 * are pairwise disjoint, far below the 0.25 pairing floor).
 * ──────────────────────────────────────────────────────────────────────── */

const LENS_IDEAS = {
  analogical: {
    label: 'Analogical transfer',
    title: 'Immune tolerance window for blocked edits',
    body: 'Treat a blocked edit like a self antigen: tolerate and requeue rather than attack with retries.',
    mechanism: 'Register a wake on lock grant and yield the executing turn instead of spinning.',
    novelty: 0.9,
    feasibility: 0.8,
  },
  'first-principles': {
    label: 'First-principles redesign',
    title: 'Derive reviewer rosters from ownership graphs',
    body: 'Compute which subsystems a change touches and pick reviewers from measured ownership data.',
    mechanism: 'Rank candidate reviewers nightly by blast radius coverage of touched modules.',
    novelty: 0.8,
    feasibility: 0.75,
  },
  reframing: {
    label: 'Reframing / problem-finding',
    title: 'Name idle waits as coordination debt',
    body: 'The unnamed constraint is unpriced waiting; surface a per session debt counter in reports.',
    mechanism: 'Emit a debt increment whenever a session sleeps on coordination and roll it up weekly.',
    novelty: 0.7,
    feasibility: 0.7,
  },
} as const;

/** Per-rail recombine outputs. The gym proposal's text deliberately avoids the
 *  WHOLE_SYSTEM_MARKERS vocabulary so wholeSystemInstanceOverride leaves it on
 *  the gym rail (a marker would bump it to 'instance'). */
const RAIL_PROPOSALS = {
  plan: {
    fromIdea: LENS_IDEAS.analogical.title,
    framing: 'Blocked edits are tolerance signals for the scheduler',
    mechanism: 'On a lock block, register an events wake on grant and yield the executing turn.',
    whyNew: 'Prior lock work retried aggressively; tolerance based yielding is untried.',
    bet: 'Retry storms disappear without raising time to edit.',
  },
  gym: {
    fromIdea: LENS_IDEAS['first-principles'].title,
    framing: 'Reviewer choice should follow measured blast radius',
    mechanism: 'Rank reviewers nightly by ownership coverage of the touched modules.',
    whyNew: 'Static reviewer lists ignore blast radius; coverage ranked rosters are untried.',
    bet: 'Review latency drops while the defect catch rate holds.',
  },
  improvement: {
    fromIdea: LENS_IDEAS.reframing.title,
    framing: 'Expose a per session coordination debt counter',
    mechanism: 'Increment a counter when a session sleeps on coordination and roll it up weekly.',
    whyNew: 'Waiting time is currently invisible; no surface prices it per session.',
    bet: 'The weekly rollup names the worst coordination sinks within one report cycle.',
  },
} as const;

const EXPECTED_PLAN_SLUG = `scout-blocked-edits-are-tolerance-signals-for-the-scheduler-${PLAN_DATE}`;

/** P-004 ideators: one grounded idea per lens (matched by the lens label the
 *  real buildIdeatorPrompt stamps into the system prompt). */
const ideatorResponder: ScoutLlmResponder = (opts) => {
  const sys = opts.system ?? '';
  if (!sys.includes('You are a SCOUT')) return undefined;
  const entry = Object.values(LENS_IDEAS).find((e) => sys.includes(`## Your lens: ${e.label}`));
  if (!entry) return undefined; // unexpected lens → fall through (defaultJsonResponder → no ideas → loud failure)
  const json = {
    ideas: [
      {
        title: entry.title,
        body: entry.body,
        mechanism: entry.mechanism,
        addressesPatternRefs: [PATTERN_REF],
      },
    ],
  };
  return { json, text: JSON.stringify(json) };
};

/** P-005 critics: keep-verdict scores per idea (matched by the idea title the
 *  real buildCriticPrompt puts in the user message). */
const criticResponder: ScoutLlmResponder = (opts) => {
  if (!(opts.system ?? '').includes('TWO adversarial critics')) return undefined;
  const user = opts.messages.map((m) => m.content).join('\n');
  const entry = Object.values(LENS_IDEAS).find((e) => user.includes(`Title: ${e.title}`));
  if (!entry) return undefined;
  const json = {
    conceptualNovelty: entry.novelty,
    feasibility: entry.feasibility,
    rationale: 'scripted keep verdict for the real-rails cycle',
  };
  return { json, text: JSON.stringify(json) };
};

/** P-006 recombine: one bettable proposal per group, each hinting a different
 *  rail (matched by which source idea sits in the group's user message). */
const recombineResponder: ScoutLlmResponder = (opts) => {
  if (!(opts.system ?? '').includes('Scout proposer')) return undefined;
  const user = opts.messages.map((m) => m.content).join('\n');
  const [rail, p] =
    Object.entries(RAIL_PROPOSALS).find(([, rp]) => user.includes(rp.fromIdea)) ?? [];
  if (!rail || !p) return undefined;
  const json = {
    framing: p.framing,
    mechanism: p.mechanism,
    whyNew: p.whyNew,
    bet: p.bet,
    experiment: {
      hypothesis: `If we ship this, the bet holds: ${p.bet}`,
      method: 'Run the cheapest instrumented A/B over one week of normal Hive traffic.',
      falsifiableSignal: 'The instrumented arm shows no measurable improvement over baseline.',
    },
    route: rail,
  };
  return { json, text: JSON.stringify(json) };
};

/** Digest substrate: a 2-member friction cluster whose newest member yields the
 *  `wi:F-101` meta-pattern ref every fake idea grounds in. Real synthesis. */
const fakeReaders: StateOfHiveReaders = fakeStateOfHiveReaders({
  friction: async () => [
    {
      id: 'F-100',
      kind: 'change',
      scope: 'operator',
      title: 'Lock blocked edits retried by hand',
      state: 'open',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    },
    {
      id: 'F-101',
      kind: 'change',
      scope: 'operator',
      title: 'Lock blocked edits retried by hand',
      state: 'open',
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-09T00:00:00.000Z',
    },
  ],
});

describe('Scout cycle — all four rails land in real PG storage (one cycle)', () => {
  let db: OrgTestDb;
  let archive: ScoutArchivePort;
  let fakeLlm: ReturnType<typeof makeFakeScoutLlm>;
  let result: ScoutCycleResult;
  let byRail: Record<string, RoutingDecision>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Fresh fully-migrated throwaway DB (000-baseline + 107…head, incl. 193/194).
    db = await createOrgTestDb();

    // Env-route the REAL db-org connection path at it (the _pg-tool-fixture /
    // _baseline-coord-fixture pattern) so every production module under test
    // resolves the same DB — no module mocks.
    savedEnv.HARNESS_DATABASE_URL = process.env.HARNESS_DATABASE_URL;
    savedEnv.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();

    // Register HARNESS (projects row + a synthetic Hive-home identity row):
    // resolvePlanScope is Hive-scoped (WI-1992) and the broad rail's
    // createScoutPlanDraft writes a REAL harness_plans row — an unregistered
    // concrete slug now THROWS instead of resolving.
    await registerHarnessProject(db.adminSql, WS, HARNESS);

    // A LIVE gym, so the testable proposal can route to the gym rail. The router asks
    // paused-rails.ts (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-002), which reads
    // the workspace from activeWorkspaceId(): pin it to WS (restored in afterAll) and seed
    // both halves of gym liveness there — an enabled autoloop AND an active gym-cycle
    // routine. Without them the gym rail is paused and gets no route by design.
    savedEnv.PAPERCUSP_WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
    await db.adminSql`
      INSERT INTO harness_shared.gym_autoloop_config (workspace_id, harness_slug, enabled, updated_at)
      VALUES (${WS}, ${HARNESS}, true, ${Date.now()})`;
    await db.adminSql`
      INSERT INTO harness_shared.routines (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id)
      VALUES ('real-rails-gym-cycle', ${HARNESS}, 'gym-cycle', 'schedule', '{}'::jsonb, 'worker', true, ${WS})`;

    fakeLlm = makeFakeScoutLlm({
      responders: [ideatorResponder, criticResponder, recombineResponder],
    });

    // Real P-012 archive port over the real PG store (empty snapshot → every
    // gym-routed proposal seeds a genuinely distant niche).
    archive = await buildScoutArchivePort({ workspaceId: WS, harnessSlug: HARNESS });

    // The production composition, exactly as productionScoutRunner assembles it
    // (register-scout-action.ts) — fake LLM + the documented test reader seams.
    const deps = buildScoutCycleDeps({
      harnessSlug: HARNESS,
      llmCall: fakeLlm.call,
      createPlanDraft: (args) =>
        createScoutPlanDraft({ ...args, harnessSlug: HARNESS, workspaceId: WS, date: PLAN_DATE }),
      archive,
      // Small POSITIVE cap (EI-305: a 0 cap now halts before the first costed
      // step) — proves the budget gate passes a full $0-spend fake-LLM cycle.
      limits: { maxIdeators: 3, maxCostUsd: 0.05 },
      cycleId: CYCLE_ID,
      stateOfHiveReaders: fakeReaders,
      digestOptions: { nowMs: Date.parse('2026-06-10T00:00:00.000Z') },
      noveltyCorpus: async () => [],
    });

    result = await runScoutCycle(deps);
    byRail = Object.fromEntries(result.routed.map((d) => [d.rail, d]));

    // Mirror productionScoutRunner's finally-block: persist buffered gym seeds.
    await archive.flush();

    // Mirror buildScoutTickDeps.persistRouted (scheduler.ts): one
    // recordRoutedIdea per provenance row — the production P-013 write path.
    for (const r of result.provenance) {
      await recordRoutedIdea({
        ideaId: r.ideaId,
        lens: r.lens,
        rail: r.rail,
        routedRef: r.routedRef,
        harnessSlug: HARNESS,
        cycleId: CYCLE_ID,
        title: r.title,
        addressesPatternRefs: r.addressesPatternRefs,
        workspaceId: WS,
      });
    }

    // Let capture-core's fire-and-forget SSE notify (mocked) settle before asserts.
    await new Promise((resolve) => setImmediate(resolve));
  }, 180_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetUrlCacheForTests();
    await _resetForTests();
    await db?.cleanup();
  });

  it('completes the full cycle, routing exactly one proposal to each of the three dispatch rails', () => {
    expect(result.stop).toBe('completed');
    expect(result.ideas).toHaveLength(3);
    expect(result.survivors).toHaveLength(3);
    expect(result.proposals).toHaveLength(3);
    expect(result.routed).toHaveLength(3);

    expect(Object.keys(byRail).sort()).toEqual(['gym', 'improvement', 'plan']);
    for (const d of result.routed) {
      expect(d.error).toBeUndefined();
      expect(d.routedRef).toBeTruthy();
      expect(d.followedHint).toBe(true); // the router followed each recombine routeHint
      // Grounding refs survive idea → proposal → decision (and since the
      // 2026-06-11 fix, on through provenance to the ledger — asserted below).
      expect(d.addressesPatternRefs).toEqual([PATTERN_REF]);
    }
  });

  it('spent $0 across exactly 9 step-tagged fake-LLM calls (3 ideate / 3 critique / 3 recombine)', () => {
    expect(fakeLlm.count()).toBe(9);
    expect(result.calls).toHaveLength(9);
    const byStep = result.calls.reduce<Record<string, number>>((acc, c) => {
      acc[c.step] = (acc[c.step] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStep).toEqual({ ideate: 3, critique: 3, recombine: 3 });
    expect(result.costUsd).toBe(0);
  });

  it('broad rail: the proposal landed as a REAL draft plan row in harness_shared.harness_plans', async () => {
    const dec = byRail.plan;
    expect(dec.routedRef).toBe(`plan:${EXPECTED_PLAN_SLUG}`);

    const rows = await db.adminSql<
      { plan_slug: string; title: string; status: string; version: string | number; origin: string; content: string }[]
    >`
      SELECT plan_slug, title, status, version, origin, content
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
    expect(rows).toHaveLength(1);
    const plan = rows[0];
    expect(plan.plan_slug).toBe(EXPECTED_PLAN_SLUG);
    expect(plan.title).toBe(RAIL_PROPOSALS.plan.framing);
    expect(plan.status).toBe('draft'); // Queen-gated: a DRAFT, not auto-active (D-002/D-010)
    expect(Number(plan.version)).toBe(1);
    expect(plan.origin).toBe('local');
    // The template body carries the Mug-triage Now block + the proposal rationale.
    expect(plan.content).toContain('Awaiting steward/owner triage');
    expect(plan.content).toContain(`Why new: ${RAIL_PROPOSALS.plan.whyNew}`);
    expect(plan.content).toContain(dec.sourceIdeaIds[0]); // provenance back to the source idea
  });

  it('testable rail: the proposal landed as a REAL scout-sourced row in harness_shared.gym_qd_archive (migration 193)', async () => {
    const dec = byRail.gym;
    expect(dec.routedRef).toBe(`gym:${dec.proposalId}`);

    const rows = await db.adminSql<
      {
        niche_key: string;
        candidate_id: string;
        scope: string;
        domain: string;
        risk: string;
        fitness: number;
        source: string;
        rationale: string | null;
        descriptor: { coords: Record<string, string>; features: number[] };
      }[]
    >`
      SELECT niche_key, candidate_id, scope, domain, risk, fitness, source, rationale, descriptor
        FROM harness_shared.gym_qd_archive
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
    expect(rows).toHaveLength(1);
    const elite = rows[0];
    // candidateId = the PROPOSAL id — what makes the `gym:<proposalId>` provenance ref join (P-013).
    expect(elite.candidate_id).toBe(dec.proposalId);
    expect(elite.source).toBe('scout');
    expect(elite.fitness).toBe(0); // a scout seed has no gym fitness yet
    // proposalToGymView carries no scope/domain/risk tags → describeScoutIdea defaults.
    expect(elite.niche_key).toBe('module|general|medium');
    expect(elite.scope).toBe('module');
    expect(elite.domain).toBe('general');
    expect(elite.risk).toBe('medium');
    expect(elite.rationale).toBe(RAIL_PROPOSALS.gym.framing); // the gym view's rationale = proposal title
    // Descriptor features: [novelty .5, feasibility .5, scopeOrd/3, riskOrd/2] defaults.
    expect(elite.descriptor.coords).toEqual({ scope: 'module', domain: 'general', risk: 'medium' });
    expect(elite.descriptor.features).toHaveLength(4);
    expect(elite.descriptor.features[0]).toBeCloseTo(0.5, 9);
    expect(elite.descriptor.features[1]).toBeCloseTo(0.5, 9);
    expect(elite.descriptor.features[2]).toBeCloseTo(1 / 3, 9);
    expect(elite.descriptor.features[3]).toBeCloseTo(0.5, 9);
  });

  it('concrete rail: the proposal landed as a REAL captured improvement in harness_shared.engineer_issues', async () => {
    const dec = byRail.improvement;
    expect(dec.routedRef).toMatch(/^wi:EI-\d+$/);
    const issueId = dec.routedRef!.slice('wi:'.length);

    const rows = await db.adminSql<
      {
        issue_id: string;
        kind: string;
        scope: string;
        title: string;
        body: string;
        state: string;
        found_during: string | null;
        payload: Record<string, unknown> | null;
      }[]
    >`
      SELECT issue_id, kind, scope, title, body, state, found_during, payload
        FROM harness_shared.engineer_issues
       WHERE issue_id = ${issueId}`;
    expect(rows).toHaveLength(1);
    const issue = rows[0];
    expect(issue.kind).toBe('change'); // Scout proposals are desired improvements
    expect(issue.scope).toBe(`harness:${HARNESS}`); // cycle-deps scopes the capture per-harness
    expect(issue.state).toBe('open');
    expect(issue.found_during).toBe('scout-loop');
    expect(issue.title).toBe(RAIL_PROPOSALS.improvement.framing);
    // Artifact-side provenance stamp (P-010 source-tag): scout-routed EIs are
    // filterable as improvement-source:Scout; the Queen still gates them (D-010).
    expect(issue.payload?.sourceRole).toBe('Scout');
    // The composed body carries the mechanism, the D-006 experiment, and idea provenance.
    expect(issue.body).toContain(`**Mechanism:** ${RAIL_PROPOSALS.improvement.mechanism}`);
    expect(issue.body).toContain('Falsified if:');
    expect(issue.body).toContain(dec.sourceIdeaIds[0]);

    // And it is discoverable through the production read path by the built-in
    // improvement topic (the tag write went through the real coordination store).
    const tagged = await listIssues({ topic: IMPROVEMENT_TOPIC });
    expect(tagged.map((i) => i.id)).toContain(issueId);
  });

  it('provenance rail: per-idea lens rows landed in harness_shared.scout_routed_ideas (migration 194)', async () => {
    // Production read path, scoped to this cycle.
    const rows = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, cycleId: CYCLE_ID });
    expect(rows).toHaveLength(3);

    const ideaByLens = new Map(result.ideas.map((i) => [i.lens, i]));
    const expected = [
      { lens: 'analogical', rail: 'plan', routedRef: byRail.plan.routedRef!, title: RAIL_PROPOSALS.plan.framing },
      { lens: 'first-principles', rail: 'gym', routedRef: byRail.gym.routedRef!, title: RAIL_PROPOSALS.gym.framing },
      { lens: 'reframing', rail: 'improvement', routedRef: byRail.improvement.routedRef!, title: RAIL_PROPOSALS.improvement.framing },
    ] as const;

    for (const exp of expected) {
      const idea = ideaByLens.get(exp.lens)!;
      expect(idea).toBeDefined();
      const row = rows.find((r) => r.ideaId === idea.id);
      expect(row, `ledger row for ${exp.lens} idea ${idea.id}`).toBeDefined();
      expect(row!.lens).toBe(exp.lens);
      expect(row!.rail).toBe(exp.rail);
      expect(row!.routedRef).toBe(exp.routedRef);
      expect(row!.cycleId).toBe(CYCLE_ID);
      expect(row!.title).toBe(exp.title);
      expect(Date.parse(row!.routedAt!)).toBeGreaterThan(0);
    }

    // Column-level scoping + the refs-threading fix (2026-06-11, see header):
    // deriveProvenance now carries the idea's addressesPatternRefs through to
    // the ledger, so the column lands populated through the production path.
    const raw = await db.adminSql<
      { idea_id: string; workspace_id: string; harness_slug: string; addresses_pattern_refs: string[] | null }[]
    >`
      SELECT idea_id, workspace_id, harness_slug, addresses_pattern_refs
        FROM harness_shared.scout_routed_ideas
       WHERE cycle_id = ${CYCLE_ID}`;
    expect(raw).toHaveLength(3);
    for (const r of raw) {
      expect(r.workspace_id).toBe(WS);
      expect(r.harness_slug).toBe(HARNESS);
      expect(r.addresses_pattern_refs).toEqual([PATTERN_REF]);
    }
  });

  it('grounding held end-to-end: the digest ref flowed digest → ideas → proposals', () => {
    // The real synthesizeStateOfHive produced the wi:F-101 meta-pattern from the
    // friction cluster, the ideators grounded in it, and recombine carried it.
    const digestRefs = [
      ...result.digest.recurringFriction,
      ...result.digest.timeTokenSinks,
      ...result.digest.chronicDeferrals,
      ...result.digest.capabilityGaps,
    ].map((p) => p.ref);
    expect(digestRefs).toContain(PATTERN_REF);
    for (const idea of result.ideas) expect(idea.addressesPatternRefs).toEqual([PATTERN_REF]);
    for (const proposal of result.proposals) expect(proposal.addressesPatternRefs).toEqual([PATTERN_REF]);
  });
});

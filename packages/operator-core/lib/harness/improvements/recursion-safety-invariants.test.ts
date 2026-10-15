/**
 * recursion-safety-invariants.test.ts — frontier P-049 / FB-22 of
 * self-learning-frontier-2026-06-12: the five rails that keep the learning
 * system's SELF-modification safe, pinned in one place so a refactor cannot
 * silently un-make them. Sibling of self-learning-invariants.test.ts (P-060),
 * which pins the loop's learning arcs; THIS suite pins the recursion guards
 * that make Phase 5/6 autonomy (Queen as decider, trust graduation) safe:
 *
 *   1. The never-auto protected set covers the loop itself / auth / deploy /
 *      budgets — and graduation (an autoKinds config edit, the ONLY widening
 *      dial) cannot promote any of it. New here vs P-060.5: the loop's
 *      governance rails (learning-governor = budgets, change-ledger = the
 *      mutation-attribution rail) are in the path set, and `needsHuman`
 *      survives full graduation.
 *   2. A drill/replay/shadow-origin row never reaches an organic learner
 *      END-TO-END: read seam → digest → triage queues → the P-040 ranked
 *      human queue — even when the storage layer ignores the SQL filter.
 *   3. An unbudgeted loop refuses unattended (D-004): the only allow paths
 *      carry an explicit owner-set budget, every frontier loop gate registers
 *      enforcement='governor' BORN-unbudgeted (refusing), and the preflight
 *      fails CLOSED (flag off / IO error ⇒ refuse).
 *   4. Every prompt mutation lands EXACTLY ONE change-ledger row: one
 *      recordChange per actual override mutation, every source has a mutation
 *      class, and the writer set is CLOSED — no synthetic lane (ablation /
 *      replay / transfer / the economics learners) writes the ledger. (The
 *      idempotent re-offer leg — ON CONFLICT dedupe — is pinned against real
 *      PG in change-ledger.integration.test.ts.)
 *   5. Triage CONSUMES the policy tier (D-003, one verdict chain): the policy
 *      verdict is the only safety input, cited verbatim, never re-derived —
 *      and the auto-implement lane is reachable through exactly one
 *      (ideaType, tier) combination.
 *
 * Per-module behavior lives in the colocated suites (policy, provenance,
 * read-items, digest, triage, learning-governor core/registrants, the eight
 * frontier governor gates, change-ledger, gym promotion, queue-ranker); this
 * suite pins the cross-module invariant arcs those tests don't compose.
 */

import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  classifyImprovement,
  partitionByTier,
  DEFAULT_RISK_TIER_POLICY,
  type ImprovementCandidate,
  type RiskTierPolicy,
  type WorkItemKind,
} from './policy';
import { classifyReversibility, isAutoReversible, type Reversibility } from './reversibility';
import { ORGANIC_ONLY, SIGNAL_ORIGINS, type SignalOrigin } from './provenance';
import { readImprovementItems } from './read-items';
import { buildDigest, type ScoredItem } from './digest';
import { triageIdea, type IdeaType } from './triage';
import type { EngineerIssue } from '../../issues-engineer';

// queen-autonomy-policy-2026-06-13 B-19 (P-090 / P-091): the per-category Queen-
// autonomy gate modules. Sections 1 + 6 above pin the IMPROVEMENTS-loop model
// (classifyImprovement / the autoKinds dial); the two sections at the BOTTOM of
// this file compose these into the D-004 unified gate to pin the Queen-as-decider
// per-category model's recursion-safety invariants (P-090) and the behavior-
// neutral migration proof (P-091) — the model B-12/P-070 will wire live.
import {
  RISK_TIERS,
  AUTONOMY_CEILINGS,
  DEFAULT_AUTHORITY,
  deriveNeedsHuman,
  type RiskTier,
  type AutonomyCeiling,
} from '@papercusp/plan-parser';
import {
  type AutonomyCategoryPolicy,
  effectiveCeiling,
  autoEverAllowed,
  defaultPolicyFor,
} from '../../autonomy/policy';
import {
  type AutonomyCategory,
  AUTONOMY_CATEGORY_IDS,
  PROTECTED_CATEGORIES,
  isProtectedCategory,
} from '../../autonomy/categories';
import { categoryForAction } from '../../autonomy/capability-category-map';
import { ACTION_SURFACE } from '../../autonomy/action-surface';
import { decideAutonomy } from '../../autonomy/decider';
// B-16 landed the real graduation engine AFTER P-090 shipped — §7.1b pins the
// "protected can't graduate" invariant against IT (the actual recursion hazard),
// not just the gate-time effectiveCeiling floor.
import {
  computeAutonomyStandings,
  computeCategoryGraduationTargets,
  DEFAULT_AUTONOMY_GRADUATION_POLICY,
} from '../../autonomy/tripwire/graduation';
import type { TripwireRow } from '../../autonomy/tripwire/store';

import {
  checkLoopVerdict,
  summarizeLearningSpend,
  type LearningLoopRegistration,
} from '../../learning-governor/core';
import { learningGovernorPreflight } from '../../learning-governor/registrants';
import { negativeSpaceRegistrationInput, NEGATIVE_SPACE_LOOP_ID } from '../../negative-space/governor';
import { neologismRegistrationInput, NEOLOGISM_LOOP_ID } from '../../neologism/governor';
import { fleetEkgRegistrationInput, FLEET_EKG_LOOP_ID } from '../../fleet-ekg/governor';
import { regretRegistrationInput, REGRET_LOOP_ID } from '../../replay/regret/governor';
import { transferRegistrationInput } from '../../transfer/governor';
import { TRANSFER_LOOP_ID } from '../../transfer/types';
import { promptAblationRegistrationInput, PROMPT_ABLATION_LOOP_ID } from '../../ablation/governor';
import { calibrationRegistrationInput, CALIBRATION_LOOP_ID } from '../../calibration/governor';
import { deferralInterestRegistrationInput, DEFERRAL_INTEREST_LOOP_ID } from '../../deferral-interest/governor';
import { REPLAY_LOOP_ID } from '../../replay/types';

import { promoteChampion } from '../../gym/promotion';
import { MUTATION_CLASS_FOR_SOURCE, type BehaviorChangeSource } from '../../change-ledger/change-ledger';
import { applyHumanQueueRanking } from '../../queue-ranker/human-queue';

// ── shared fixtures ──────────────────────────────────────────────────────────

const ALL_KINDS: WorkItemKind[] = ['feature', 'bug', 'change', 'chunk'];

/** The maximal graduation: every kind auto-eligible (the Phase 4 dial turned all
 *  the way). The protected sets must STILL gate — that is the invariant. */
const FULLY_GRADUATED: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ALL_KINDS };

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: 'a thing', state: 'open', ...p };
}

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
    parent: null,
    foundDuring: null,
    linkedFeatureId: null,
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
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    closedAt: null,
    goalId: null,
    ...p,
  };
}

// ── 1. never-auto covers loop/auth/deploy/budgets; graduation can't promote it ─

describe('P-049.1 — the never-auto set covers the loop / auth / deploy / budgets; no graduation path promotes it', () => {
  /** One live representative file per protected CLASS the invariant names.
   *  P-060.5 pins the wider path inventory; these are the four named classes
   *  plus the governance rails this suite adds to the set. */
  const PROTECTED_CLASS_REPRESENTATIVES: Array<[cls: string, path: string]> = [
    ['the loop itself', 'packages/operator-core/lib/harness/improvements/triage.ts'],
    ['the loop (capture edge)', 'packages/operator-core/lib/agent-tools/improvements/capture.ts'],
    ['auth', 'apps/operator/lib/auth/session.ts'],
    ['deploy', 'packages/operator-core/lib/release/deploy-cli.ts'],
    ['budgets (the learning governor, D-004)', 'packages/operator-core/lib/learning-governor/core.ts'],
    ['budgets (the spend ledger store)', 'packages/operator-core/lib/learning-governor/store.ts'],
    ['the mutation-attribution rail (change ledger, D-003)', 'packages/operator-core/lib/change-ledger/change-ledger.ts'],
    ["the loop's master switch (flags)", 'libs/flags/src/types.ts'],
    ["the loop's scheduler", 'packages/operator-core/lib/dbos/engine.ts'],
  ];

  it.each(PROTECTED_CLASS_REPRESENTATIVES)(
    '%s stays HUMAN under FULL graduation',
    (_cls, path) => {
      const d = classifyImprovement(cand({ id: 'p', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      expect(d.tier).toBe('human');
      expect(d.protectedHit).toBeTruthy();
    },
  );

  it('graduation changes NOTHING about protection: same protectedHit under default and graduated policy', () => {
    for (const [, path] of PROTECTED_CLASS_REPRESENTATIVES) {
      const base = classifyImprovement(cand({ id: 'b', kind: 'bug', paths: [path] }), DEFAULT_RISK_TIER_POLICY);
      const grad = classifyImprovement(cand({ id: 'g', kind: 'bug', paths: [path] }), FULLY_GRADUATED);
      expect(grad.tier).toBe('human');
      expect(grad.protectedHit).toBe(base.protectedHit);
    }
  });

  it('needsHuman (the explicit human-routing back-edge) survives FULL graduation on a clean candidate', () => {
    const d = classifyImprovement(
      cand({
        id: 'nh',
        kind: 'bug',
        title: 'nicer empty-state for the inbox panel',
        paths: ['apps/operator/app/inbox/EmptyState.tsx'],
        needsHuman: true,
      }),
      FULLY_GRADUATED,
    );
    expect(d.tier).toBe('human');
  });

  it('the dial still turns: graduation widens ONLY off-the-protected-set kinds (the set is the only block)', () => {
    const clean = cand({
      id: 'ok',
      kind: 'chunk', // not auto under the default policy…
      title: 'nicer empty-state for the inbox panel',
      paths: ['apps/operator/app/inbox/EmptyState.tsx'],
    });
    expect(classifyImprovement(clean, DEFAULT_RISK_TIER_POLICY).tier).toBe('human');
    expect(classifyImprovement(clean, FULLY_GRADUATED).tier).toBe('auto'); // …graduation promotes it
  });
});

// ── 2. drill/replay/shadow never reaches an organic learner, end-to-end ──────

describe('P-049.2 — a synthetic-origin row never reaches an organic learner (seam → digest → queues → ranker)', () => {
  /** One row per origin + a junk origin + a legacy (null-origin) row. The fake
   *  listIssues IGNORES the signalOrigins filter on purpose: the in-process
   *  gate at the read seam must hold even when the storage layer doesn't. */
  const ROWS: EngineerIssue[] = [
    issue({ id: 'EI-org', title: 'organic friction: inbox dedup misses rephrasings' }),
    issue({ id: 'EI-drill', title: 'drill friction planted by vaccination', signalOrigin: 'drill' }),
    issue({ id: 'EI-replay', title: 'replay-derived counterfactual finding', signalOrigin: 'replay' }),
    issue({ id: 'EI-shadow', title: 'shadow-ablation derived finding', signalOrigin: 'shadow' }),
    issue({ id: 'EI-junk', title: 'junk-origin row (corrupt value)', signalOrigin: 'mutant' as SignalOrigin }),
    issue({ id: 'EI-legacy', title: 'legacy pre-column row', signalOrigin: null as unknown as SignalOrigin }),
  ];
  const leakyDeps = { listIssues: async () => ROWS };

  it('the default read is organic-only (+ legacy-null as organic) even when storage ignores the filter', async () => {
    const got = await readImprovementItems({}, leakyDeps);
    expect(got.map((c) => c.id).sort()).toEqual(['EI-legacy', 'EI-org']);
  });

  it('an explicit drill opt-in is PARTITIONED both ways: only drill, no organic riding along', async () => {
    const got = await readImprovementItems({ origins: ['drill'] }, leakyDeps);
    expect(got.map((c) => c.id)).toEqual(['EI-drill']);
  });

  it('a junk origin fails CLOSED: it matches NO allowlist — not the default, not any single-origin opt-in', async () => {
    for (const origins of [undefined, ORGANIC_ONLY, ['drill'] as const, ['replay'] as const, ['shadow'] as const, SIGNAL_ORIGINS]) {
      const got = await readImprovementItems(origins ? { origins } : {}, leakyDeps);
      expect(got.map((c) => c.id)).not.toContain('EI-junk');
    }
  });

  it('END-TO-END: seam → buildDigest → both triage queues → the ranked human queue carry no synthetic id', async () => {
    const candidates = await readImprovementItems({}, leakyDeps);
    const digest = buildDigest(candidates, { nowMs: Date.parse('2026-06-12T00:00:00Z') });
    const ranked = await applyHumanQueueRanking(
      digest,
      { candidates },
      { readLinkCounts: async () => new Map() },
    );
    const everywhere = [
      ...digest.autoEligible.map((i) => i.id),
      ...digest.humanQueue.map((i) => i.id),
      ...ranked.humanQueue.map((i) => i.id),
    ];
    expect(everywhere.length).toBeGreaterThan(0); // the arc actually carried items
    for (const id of everywhere) expect(['EI-org', 'EI-legacy']).toContain(id);
    expect(digest.census.total).toBe(2); // even the rollup counts never saw the synthetic rows
  });
});

// ── 3. an unbudgeted loop refuses unattended (D-004) ─────────────────────────

describe('P-049.3 — unbudgeted loops refuse unattended; every frontier gate is born refusing', () => {
  const reg = (p: Partial<LearningLoopRegistration>): LearningLoopRegistration => ({
    workspaceId: 'ws',
    loopId: 'loop',
    potSlug: null,
    displayName: 'loop',
    budgetKind: 'lifetime',
    budgetUsd: null,
    spentUsd: 0,
    priority: 100,
    enabled: true,
    enforcement: 'governor',
    meta: null,
    registeredAt: 0,
    updatedAt: 0,
    ...p,
  });

  it('allow REQUIRES an enabled registration with an explicit (non-null) budget — the full grid', () => {
    for (const enabled of [true, false]) {
      for (const budgetKind of ['lifetime', 'per-cycle'] as const) {
        for (const budgetUsd of [null, 0, 5]) {
          for (const spentUsd of [0, 4.8]) {
            const v = checkLoopVerdict(reg({ enabled, budgetKind, budgetUsd, spentUsd }));
            if (v.allow) {
              expect(enabled).toBe(true);
              expect(budgetUsd).not.toBeNull();
            }
            if (enabled && budgetUsd === null) expect(v.reason).toBe('unbudgeted');
          }
        }
      }
    }
    expect(checkLoopVerdict(null).reason).toBe('unregistered');
    expect(checkLoopVerdict(undefined).reason).toBe('unregistered');
  });

  const FRONTIER_REGISTRATIONS: Array<[loopId: string, input: (ws: string) => Record<string, unknown>]> = [
    [NEGATIVE_SPACE_LOOP_ID, negativeSpaceRegistrationInput],
    [NEOLOGISM_LOOP_ID, neologismRegistrationInput],
    [FLEET_EKG_LOOP_ID, fleetEkgRegistrationInput],
    [REGRET_LOOP_ID, regretRegistrationInput],
    [TRANSFER_LOOP_ID, transferRegistrationInput],
    [PROMPT_ABLATION_LOOP_ID, promptAblationRegistrationInput],
    [CALIBRATION_LOOP_ID, calibrationRegistrationInput],
    [DEFERRAL_INTEREST_LOOP_ID, deferralInterestRegistrationInput],
  ];

  it.each(FRONTIER_REGISTRATIONS)(
    'frontier gate %s self-registers enforcement=governor with the budget OMITTED (born refusing)',
    (loopId, input) => {
      const row = input('ws');
      expect(row.loopId).toBe(loopId);
      expect(row.enforcement).toBe('governor');
      // The budget key is ABSENT — not null, not 0: the insert lands unbudgeted
      // and stays on the D-004 watch list until the owner's P-001 arming act.
      expect('budgetUsd' in row).toBe(false);
    },
  );

  it('all frontier loop ids are DISTINCT (one budget row each — no loop hides under another cap)', () => {
    const ids = [...FRONTIER_REGISTRATIONS.map(([id]) => id), REPLAY_LOOP_ID];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a born-unbudgeted registration refuses via the SAME verdict every gate consumes, and lands on the watch list', () => {
    const rows = FRONTIER_REGISTRATIONS.map(([loopId]) => reg({ loopId, budgetKind: 'per-cycle' }));
    for (const r of rows) {
      const v = checkLoopVerdict(r);
      expect(v.allow).toBe(false);
      expect(v.reason).toBe('unbudgeted');
    }
    expect(summarizeLearningSpend(rows).unbudgetedLoopIds.sort()).toEqual(
      FRONTIER_REGISTRATIONS.map(([id]) => id).sort(),
    );
  });

  it('the shared preflight fails CLOSED: governor flag OFF refuses, and an IO error refuses (never allows)', async () => {
    const dark = await learningGovernorPreflight(
      { workspaceId: 'ws', loopId: 'any' },
      { enabled: async () => false, log: () => {} },
    );
    expect(dark).toMatchObject({ allow: false, reason: 'governor-dark' });

    const broken = await learningGovernorPreflight(
      { workspaceId: 'ws', loopId: 'any' },
      {
        enabled: async () => true,
        getSql: async () => {
          throw new Error('pool exploded');
        },
        log: () => {},
      },
    );
    expect(broken).toMatchObject({ allow: false, reason: 'governor-error' });
  });

  it('the preflight passes the registration verdict through UNSOFTENED (an unbudgeted row refuses end-to-end)', async () => {
    const check = vi.fn(async () => checkLoopVerdict(reg({ budgetUsd: null })));
    const v = await learningGovernorPreflight(
      { workspaceId: 'ws', loopId: 'frontier-x' },
      { enabled: async () => true, getSql: async () => ({}) as never, check, log: () => {} },
    );
    expect(check).toHaveBeenCalledTimes(1);
    expect(v).toMatchObject({ allow: false, reason: 'unbudgeted' });
  });
});

// ── 4. every prompt mutation lands EXACTLY ONE change-ledger row ─────────────

describe('P-049.4 — one change-ledger row per prompt mutation; the writer set is closed', () => {
  it('promoteChampion records exactly ONE change per actual override mutation (N sets + M clears)', async () => {
    const recordChange = vi.fn<(entry: { role: string; action: 'set' | 'clear' }) => Promise<void>>(
      async () => {},
    );
    const out = await promoteChampion(
      'gym-h',
      { promptOverrides: { worker: 'W2', validator: 'V2' } } as never,
      {
        listExistingOverrideRoles: async () => ['validator', 'reviewer'], // reviewer must clear; validator replaces
        setOverride: async () => {},
        clearOverride: async () => {},
        recordChange,
      },
    );
    expect(out).toEqual({ rolesSet: ['validator', 'worker'], rolesCleared: ['reviewer'] });
    // 2 sets + 1 clear = 3 mutations = 3 ledger calls; a replace is ONE 'set',
    // never a clear+set pair, and the untouched roles record nothing.
    expect(recordChange).toHaveBeenCalledTimes(3);
    expect(recordChange.mock.calls.map(([e]) => e)).toEqual([
      { role: 'validator', action: 'set' },
      { role: 'worker', action: 'set' },
      { role: 'reviewer', action: 'clear' },
    ]);
  });

  it('every change source has a mutation class — nothing mutates off the D-003 calendar', () => {
    const SOURCES: BehaviorChangeSource[] = ['gym:accept', 'gym:promotion', 'prompts-api', 'repo-scan', 'ablation', 'manual'];
    for (const s of SOURCES) expect(MUTATION_CLASS_FOR_SOURCE[s]).toBeTruthy();
    expect(Object.keys(MUTATION_CLASS_FOR_SOURCE).sort()).toEqual([...SOURCES].sort());
  });

  // ── the writer set is CLOSED (static pin over the source tree) ────────────
  const LIB_ROOT = join(__dirname, '..', '..'); // packages/operator-core/lib

  function* tsSources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) yield* tsSources(p);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) yield p;
    }
  }

  /** Comment-stripped source, so a doc-comment MENTION (e.g. "champions ride
   *  the recordBehaviorChange hook") never reads as a writer — only real
   *  import/call/reference sites count. */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const referencingFiles = [...tsSources(LIB_ROOT)]
    .filter((p) => /\brecordBehaviorChange\b/.test(stripComments(readFileSync(p, 'utf8'))))
    .map((p) => relative(LIB_ROOT, p).replaceAll('\\', '/'))
    .sort();

  it('the ledger writers are EXACTLY the documented set — a new writer must consciously amend this invariant', () => {
    expect(referencingFiles).toEqual(
      [
        'change-ledger/change-ledger.ts', // the seam itself (+ gymPromotionRecorder)
        'change-ledger/scan-loop.ts', // repo-scan orchestration (runChangeLedgerScan) — the SHARED path the `system:change-ledger-scan` routine action AND the `change-ledger:scan` blueprint step both delegate to (deterministic-blueprints-migration P-004). The repo-scan WRITE moved HERE from harness/routines/change-ledger-scan-action.ts (which now only calls runChangeLedgerScan, no direct recordBehaviorChange). Same `repo-scan` source, allowed seam, NOT a learner lane.
        'gym/control-plane.ts', // gym:accept — the committer
        'endpoint-route/routes/harness/prompts.ts', // prompts-api (set/clear × both branches)
      ].sort(),
    );
  });

  it('NO synthetic/learner lane writes the ledger: ablation, replay, transfer, and the economics learners only read', () => {
    const FORBIDDEN_PREFIXES = [
      'ablation/', // shadow ablations never mutate live prompts (FB-09)
      'replay/', // counterfactual replays are reads of history
      'transfer/',
      'calibration/',
      'deferral-interest/',
      'fleet-ekg/', // the EKG CONDITIONS on the ledger — it must never feed it
      'negative-space/',
      'neologism/',
      'owner-preference/',
      'queue-ranker/',
      'learning-governor/',
    ];
    for (const f of referencingFiles) {
      for (const prefix of FORBIDDEN_PREFIXES) expect(f.startsWith(prefix)).toBe(false);
    }
  });
});

// ── 5. triage consumes the policy tier — one verdict chain (D-003) ───────────

describe('P-049.5 — triage consumes the policy tier verbatim; auto-implement is reachable exactly one way', () => {
  const scoredWith = (p: Partial<ScoredItem>): ScoredItem =>
    ({
      id: 't',
      kind: 'bug',
      title: 'a captured friction',
      scope: 'operator',
      state: 'open',
      assignee: null,
      assignedAt: null,
      attempts: 0,
      score: 10,
      ageDays: 1,
      tier: 'human',
      tierReason: '',
      ideaType: 'code-bug',
      ...p,
    }) as ScoredItem;

  it('the policy reason is cited VERBATIM — triage consumes the verdict, it does not re-derive one', () => {
    const sentinel = 'POLICY-SENTINEL kind=bug is auto-eligible; no protected path/keyword';
    const placed = triageIdea(scoredWith({ tier: 'auto', tierReason: sentinel }));
    expect(placed.decision).toBe('place');
    expect(placed.target).toBe('auto-implement');
    expect(placed.reason).toContain(sentinel);

    const gated = triageIdea(scoredWith({ tier: 'human', tierReason: sentinel }));
    expect(gated.decision).toBe('gate');
    expect(gated.reason).toContain(sentinel);
  });

  it('flipping ONLY the tier flips the verdict on an otherwise identical item — the tier is THE safety input', () => {
    const base = { title: 'fix the inbox dedup', ideaType: 'code-bug' as IdeaType };
    expect(triageIdea(scoredWith({ ...base, tier: 'auto' })).target).toBe('auto-implement');
    expect(triageIdea(scoredWith({ ...base, tier: 'human' })).target).toBe('human-review');
  });

  it('the auto-implement lane is reachable through EXACTLY (code-bug, tier=auto) — sweep of every combination', () => {
    const TYPES: IdeaType[] = ['product', 'code-bug', 'infra-environment', 'process-prompt', 'needs-design'];
    for (const ideaType of TYPES) {
      for (const tier of ['auto', 'human'] as const) {
        const d = triageIdea(
          scoredWith({
            ideaType,
            tier,
            tierReason: 'r',
            scope: ideaType === 'product' ? 'harness:sheets' : 'operator',
          }),
        );
        if (ideaType === 'code-bug' && tier === 'auto') {
          expect(d.target).toBe('auto-implement');
        } else {
          expect(d.target).not.toBe('auto-implement');
          // process-prompt / infra / needs-design GATE even when the policy
          // said auto — the taxonomy narrows, it never widens (D-003/D-005).
          if (ideaType !== 'product') expect(d.decision).toBe('gate');
        }
      }
    }
  });

  it('END-TO-END: the policy verdict computed in the digest is the verdict triage consumes (one chain)', () => {
    const protectedCand = cand({
      id: 'EI-prot',
      kind: 'bug',
      title: 'tighten the spend floor check',
      paths: ['packages/operator-core/lib/learning-governor/core.ts'],
    });
    const cleanCand = cand({
      id: 'EI-clean',
      kind: 'bug',
      title: 'fix the inbox empty-state flicker',
      paths: ['apps/operator/app/inbox/EmptyState.tsx'],
    });
    const digest = buildDigest([protectedCand, cleanCand], { nowMs: Date.parse('2026-06-12T00:00:00Z') });

    const prot = digest.humanQueue.find((i) => i.id === 'EI-prot')!;
    expect(prot).toBeTruthy(); // the protected item landed in the HUMAN queue
    const protTriage = triageIdea(prot);
    expect(protTriage.decision).toBe('gate');
    expect(protTriage.reason).toContain(prot.tierReason); // the policy's words, not triage's

    const clean = digest.autoEligible.find((i) => i.id === 'EI-clean')!;
    expect(clean).toBeTruthy();
    expect(triageIdea(clean).target).toBe('auto-implement');

    // And the digest's tier IS the policy's tier — same decision objects.
    const { decisions } = partitionByTier([protectedCand, cleanCand]);
    expect(prot.tier).toBe(decisions['EI-prot'].tier);
    expect(clean.tier).toBe(decisions['EI-clean'].tier);
  });
});

// ── 6. reversibility is a HARD fail-safe axis, orthogonal to the risk dial ────
//
// queen-autonomy-policy-2026-06-13 B-02 / P-012 pins the SECOND autonomy axis
// here (the recursion guards that keep Phase 5/6 autonomy safe): the model
// (P-090) makes "irreversible never auto" a hard gate, and the tag fails safe
// (unknown → irreversible). The recursion hazard this closes: the ONLY widening
// dial is graduation (the autoKinds config edit) — it must be impossible for any
// graduation to turn an irreversible action auto-runnable. Reversibility takes NO
// policy input, so the dial cannot reach it; this suite pins that orthogonality.

describe('P-049.6 — reversibility: irreversible/unknown never auto-safe; the graduation dial cannot reach this axis', () => {
  const REVERSIBILITY_VALUES: Reversibility[] = ['reversible', 'irreversible', 'unknown'];

  it('the fail-safe collapse: isAutoReversible passes ONLY "reversible" — irreversible AND unknown both fail (unknown→irreversible)', () => {
    expect(REVERSIBILITY_VALUES.filter(isAutoReversible)).toEqual(['reversible']);
  });

  /** Every irreversible surface the never-auto protected set names (P-090) must
   *  classify irreversible — the classifier is the source of "irreversible". */
  const IRREVERSIBLE_SURFACE_REPRESENTATIVES: Array<[cls: string, path: string]> = [
    ['schema/data migration', 'libs/papercusp/libs/db/sql/261-autonomy-policy.sql'],
    ['deploy/release (operator-core)', 'packages/operator-core/lib/release/deploy-cli.ts'],
    ['deploy/release (apps/operator)', 'apps/operator/lib/release/rollback.ts'],
    ['credentials', 'packages/operator-core/lib/credentials/store.ts'],
    ['auth', 'apps/operator/lib/auth/session.ts'],
  ];
  it.each(IRREVERSIBLE_SURFACE_REPRESENTATIVES)('%s classifies irreversible → never auto-safe', (_cls, path) => {
    const d = classifyReversibility(cand({ id: 'irr', kind: 'bug', paths: [path] }));
    expect(d.reversibility).toBe('irreversible');
    expect(isAutoReversible(d.reversibility)).toBe(false);
  });

  it('an un-scoped candidate (no paths, no marker) fails safe to unknown → never auto-safe (the scoper must supply paths first)', () => {
    const d = classifyReversibility(cand({ id: 'bare', kind: 'bug', title: 'fix the inbox dedup' }));
    expect(d.reversibility).toBe('unknown');
    expect(isAutoReversible(d.reversibility)).toBe(false);
  });

  it('the graduation dial (autoKinds) CANNOT make an irreversible action reversible — the axes are orthogonal', () => {
    const migration = cand({ id: 'mig', kind: 'bug', paths: ['libs/papercusp/libs/db/sql/261-x.sql'] });
    // The risk/tier dial graduates KINDS — even fully graduated, the protected path gates it…
    expect(classifyImprovement(migration, FULLY_GRADUATED).tier).toBe('human');
    // …and reversibility is computed with NO policy input, so no dial can reach it: it stays irreversible.
    for (const policy of [DEFAULT_RISK_TIER_POLICY, FULLY_GRADUATED]) {
      void policy; // reversibility takes no policy — same verdict regardless of the dial
      expect(classifyReversibility(migration).reversibility).toBe('irreversible');
    }
    expect(isAutoReversible(classifyReversibility(migration).reversibility)).toBe(false);
  });

  it('the axis is NOT vacuously closed: a clean repo edit IS positively reversible (auto-safe on this axis)', () => {
    const clean = cand({ id: 'clean', kind: 'bug', paths: ['apps/operator/app/inbox/EmptyState.tsx'] });
    const d = classifyReversibility(clean);
    expect(d.reversibility).toBe('reversible');
    expect(isAutoReversible(d.reversibility)).toBe(true);
  });

  it('behavior-neutral (P-091): today the auto lane is already free of irreversible actions, so wiring this axis later cannot change the partition', () => {
    // The irreversible surfaces (migration / deploy / credential / auth paths) are a
    // SUBSET of the tier policy's protected set, so EVERY irreversible item is already
    // gated to human by the existing policy — even fully graduated. There is no item
    // that is both tier=auto AND irreversible. Hence B-02 (which only EXPOSES the
    // axis) changes nothing live, and B-12 (which ANDs reversibility into the gate)
    // is redundant for today's vocabulary — the proof that adding the classifier is
    // safe. The axis earns its keep once B-04's category model admits categories
    // whose surfaces the protected-path list doesn't already cover.
    for (const [, path] of IRREVERSIBLE_SURFACE_REPRESENTATIVES) {
      const item = cand({ id: 'bn', kind: 'bug', paths: [path] });
      expect(classifyReversibility(item).reversibility).toBe('irreversible');
      expect(classifyImprovement(item, FULLY_GRADUATED).tier).toBe('human');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// queen-autonomy-policy-2026-06-13 — B-19 (P-090 / P-091)
//
// Sections 1 + 6 pin the IMPROVEMENTS-loop self-modification model. Sections 7 + 8
// pin the SIBLING model the same plan introduces: the per-category Queen-autonomy
// gate (B-01 risk-model · B-03 policy store · B-04 categories + action-surface),
// which B-12/P-070 will wire into the live decider. The unified gate (D-004) is:
//
//     auto ⟺ risk_tier ≤ min(ceiling, graduated) ∧ reversible
//                       ∧ ¬authority_owner ∧ ¬protected
//
// No production module composes that formula yet (P-070 is the wiring; today only
// the get/set tools + sync resolver read `effectiveCeiling` for DISPLAY). So this
// suite composes the SHIPPED pure functions into the gate and pins the invariants
// the live decider MUST satisfy — when B-12 lands a real `decide(...)`, repoint
// `autoAllowed` below at it and these stay the spec.
//   • `deriveNeedsHuman` folds in  risk ≤ effectiveCeiling ∧ ¬authority_owner
//                                   ∧ (effectiveCeiling ≠ never-auto)
//   • `effectiveCeiling`   folds in  ¬protected, via `locked ⇒ never-auto`
//   • reversibility (B-02) is the one orthogonal hard gate, ANDed here.
// ─────────────────────────────────────────────────────────────────────────────

/** A policy row for `category`, starting from the shipped default (so a PROTECTED
 *  category keeps its `locked: true`) with `over` applied on top. */
const policyFor = (
  category: AutonomyCategory,
  over: Partial<AutonomyCategoryPolicy> = {},
): AutonomyCategoryPolicy => ({ ...defaultPolicyFor(category), ...over });

/** The MOST PERMISSIVE policy an owner could ever set for a category: UNLOCKED,
 *  ceiling + graduation both cranked to the top. The hard-gate invariants
 *  (irreversible / authority=owner) must hold even against this worst case. */
const maximalPolicy = (category: AutonomyCategory): AutonomyCategoryPolicy =>
  policyFor(category, { locked: false, ceiling: 'critical', graduatedLevel: 'critical' });

/**
 * The D-004 unified gate. B-12 landed the real decider (`decideAutonomy`), so —
 * per the banner above ("when B-12 lands a real `decide(...)`, repoint
 * `autoAllowed` below at it and these stay the spec") — this now delegates to the
 * LIVE gate, armed, so every P-090/P-091 invariant pins the production decider
 * rather than a re-implementation. The decider derives the same verdict from the
 * same shipped pure functions (deriveNeedsHuman ∧ isAutoReversible, protection via
 * `effectiveCeiling`'s locked⇒never-auto), so the spec is unchanged.
 */
function autoAllowed(args: {
  policy: AutonomyCategoryPolicy;
  riskTier: RiskTier;
  authority: 'owner' | 'system';
  reversibility: Reversibility;
}): boolean {
  return (
    decideAutonomy({
      category: args.policy.category,
      effectiveCeiling: effectiveCeiling(args.policy),
      riskTier: args.riskTier,
      authority: args.authority,
      reversibility: args.reversibility,
      armed: true,
    }).posture === 'auto'
  );
}

// ── 7. the per-category autonomy gate's recursion-safety invariants (P-090) ───

describe('P-090 — per-category autonomy gate: the five recursion-safety invariants (B-19)', () => {
  // ── 7.1 the never-auto protected set cannot graduate ───────────────────────
  describe('7.1 — the never-auto protected set cannot graduate', () => {
    it('the protected set is EXACTLY the four named never-auto categories (no drift)', () => {
      expect(new Set(PROTECTED_CATEGORIES)).toEqual(
        new Set(['release-deploy', 'spend-budget', 'credentials-auth', 'system-control']),
      );
    });

    it('every protected category ships locked at never-auto (ceiling AND lock, both zero)', () => {
      for (const cat of PROTECTED_CATEGORIES) {
        const d = defaultPolicyFor(cat);
        expect(d.locked, `${cat} ships unlocked`).toBe(true);
        expect(d.ceiling, `${cat} ceiling`).toBe('never-auto');
        expect(d.graduatedLevel, `${cat} graduated`).toBe('never-auto');
        expect(autoEverAllowed(d), `${cat} can auto`).toBe(false);
      }
    });

    it('graduation CANNOT bypass the lock: a locked category stays never-auto even with ceiling+graduation cranked to critical', () => {
      // The graduation engine (B-16) only moves `graduatedLevel`; the store clamps
      // it ≤ ceiling. Model the worst the engine could ever attempt — both dials at
      // the top — while the category is still locked (its shipped posture):
      for (const cat of PROTECTED_CATEGORIES) {
        const graduated = policyFor(cat, {
          locked: true,
          ceiling: 'critical',
          graduatedLevel: 'critical',
        });
        expect(effectiveCeiling(graduated), `${cat} effective`).toBe('never-auto');
        // …so the gate is never-auto for EVERY risk tier + reversibility.
        for (const riskTier of RISK_TIERS) {
          expect(
            autoAllowed({ policy: graduated, riskTier, authority: 'system', reversibility: 'reversible' }),
            `${cat} @ ${riskTier} auto-ran while locked`,
          ).toBe(false);
        }
      }
    });

    it('the lock is the load-bearing floor: unlocking is the ONLY way to widen a protected category (a deliberate, audited owner act)', () => {
      // Proves the invariant isn't vacuous: the category CAN auto once the owner
      // explicitly unlocks + raises the ceiling — i.e. graduation alone never does
      // it; an owner authority decision (the unlock) is required (D-005).
      const cat: AutonomyCategory = 'release-deploy';
      const locked = policyFor(cat, { ceiling: 'critical', graduatedLevel: 'critical' }); // still locked
      const unlocked = policyFor(cat, { locked: false, ceiling: 'low', graduatedLevel: 'low' });
      expect(effectiveCeiling(locked)).toBe('never-auto');
      expect(effectiveCeiling(unlocked)).toBe('low');
    });
  });

  // ── 7.1b the REAL graduation engine refuses to graduate the protected set ──
  // §7.1 above pins the GATE-TIME floor (effectiveCeiling: locked ⇒ never-auto).
  // B-16's graduation engine (`tripwire/graduation.ts`) landed AFTER P-090 — it is
  // the actual recursion hazard: the learning loop's own engine raising autonomy on
  // its OWN governance (system-control = the loop's master switch). graduation.test
  // unit-pins ONE locked category; this pins the cross-cutting arc the unit suite
  // doesn't compose: ALL FOUR protected categories, at their SHIPPED defaults, under
  // maximal clean-streak evidence; the defense-in-depth belt (refuses even UNLOCKED);
  // and end-to-end into the LIVE decider.
  describe('7.1b — the REAL graduation engine (B-16) never graduates the protected set', () => {
    const tw = (
      over: Partial<TripwireRow> & { status: TripwireRow['status']; armedAtMs: number },
    ): TripwireRow => ({
      id: `tw-${over.armedAtMs}`,
      workspaceId: 'default',
      category: 'implementation',
      findingClass: 'work_items:create',
      action: 'work_items:create',
      riskTier: 'low',
      reversibility: 'reversible',
      revertHandle: { kind: 'config-edit' },
      decision: null,
      decisionId: null,
      tripReason: null,
      windowUntilMs: over.armedAtMs + 86_400_000,
      resolvedAtMs: over.status === 'armed' ? null : over.armedAtMs + 86_400_000,
      revertedAtMs: null,
      resolvedBy: over.status === 'armed' ? null : 'sweep',
      ...over,
    });
    /** A clean-streak FAR past the threshold (10) for one (category, class) — the
     *  most evidence the engine could ever see for that category. */
    const maximalCleanEvidence = (category: AutonomyCategory): TripwireRow[] =>
      Array.from({ length: 40 }, (_, i) =>
        tw({
          id: `tw-${category}-${i}`,
          category,
          findingClass: `${category}:verb`,
          action: `${category}:verb`,
          status: 'cleared',
          armedAtMs: 1000 + i * 1000,
        }),
      );
    const targetFor = (category: AutonomyCategory, policy: AutonomyCategoryPolicy) => {
      const standings = computeAutonomyStandings(
        maximalCleanEvidence(category),
        DEFAULT_AUTONOMY_GRADUATION_POLICY,
        1e15,
      );
      const targets = computeCategoryGraduationTargets(
        standings,
        new Map<AutonomyCategory, AutonomyCategoryPolicy>([[category, policy]]),
        DEFAULT_AUTONOMY_GRADUATION_POLICY,
      );
      return targets.find((t) => t.category === category) ?? null;
    };

    it('refuses to raise graduated_level on ANY protected category — shipped-locked defaults, 40 clean auto-passes', () => {
      for (const cat of PROTECTED_CATEGORIES) {
        const t = targetFor(cat, defaultPolicyFor(cat)); // the shipped default = locked
        expect(t?.shouldWrite ?? false, `${cat} would graduate`).toBe(false);
        if (t) {
          expect(t.targetGraduatedLevel, `${cat} earned a level`).toBe('never-auto');
          expect(t.reason).toMatch(/locked|protected/);
        }
      }
    });

    it('DEFENSE-IN-DEPTH: refuses even if a protected category is UNLOCKED with a high ceiling — the isProtectedCategory belt, so graduation is NEVER the widening path', () => {
      for (const cat of PROTECTED_CATEGORIES) {
        const unlocked = policyFor(cat, { locked: false, ceiling: 'high', graduatedLevel: 'never-auto' });
        const t = targetFor(cat, unlocked);
        expect(t?.shouldWrite ?? false, `${cat} graduated while unlocked`).toBe(false);
        if (t) expect(t.reason).toMatch(/protected/);
      }
      // …and the refusal is NOT vacuous: the SAME evidence on a non-protected
      // category WITH an owner-raised ceiling DOES graduate (the engine works).
      const grad = targetFor('implementation', policyFor('implementation', { locked: false, ceiling: 'high' }));
      expect(grad?.shouldWrite).toBe(true);
      expect(grad?.targetGraduatedLevel).not.toBe('never-auto');
    });

    it('THE RECURSION ARC end-to-end: the engine leaves system-control never-auto, so the LIVE decider still gates the loop’s master switch (autoloop:control)', () => {
      const cat: AutonomyCategory = 'system-control';
      const t = targetFor(cat, defaultPolicyFor(cat));
      expect(t?.shouldWrite ?? false).toBe(false); // engine refuses to raise the level…
      // …so the policy stays never-auto, and the live decider gates arming/disarming
      // the loop — the recursion crux (P-090; action-surface `system.arm-loop`).
      const d = decideAutonomy({
        action: 'autoloop:control',
        effectiveCeiling: effectiveCeiling(defaultPolicyFor(cat)),
        riskTier: 'trivial',
        authority: 'system',
        reversibility: 'reversible',
        armed: true,
      });
      expect(d.category).toBe('system-control');
      expect(d.posture).toBe('gated');
      expect(d.wouldAutoIfArmed).toBe(false);
    });
  });

  // ── 7.2 irreversible never auto ────────────────────────────────────────────
  describe('7.2 — irreversible (and unknown-reversibility) actions never auto, under ANY policy', () => {
    it('every IRREVERSIBLE action in the surface stays human even under the most permissive policy + full risk sweep', () => {
      const irreversible = ACTION_SURFACE.filter((a) => a.reversibility === 'irreversible');
      expect(irreversible.length).toBeGreaterThan(0); // the axis is exercised
      for (const a of irreversible) {
        for (const riskTier of RISK_TIERS) {
          expect(
            autoAllowed({ policy: maximalPolicy(a.category), riskTier, authority: 'system', reversibility: a.reversibility }),
            `${a.id} (${a.reversibility}) auto-ran @ ${riskTier}`,
          ).toBe(false);
        }
      }
    });

    it('reversibility is orthogonal to the risk dial: flipping risk/ceiling never makes an irreversible action auto', () => {
      // The same action, only its reversibility changed reversible→irreversible,
      // flips the gate from auto-eligible to gated — the proof reversibility is a
      // hard, dial-independent axis. Use a non-protected category so the risk half
      // alone WOULD permit it.
      const cat: AutonomyCategory = 'knowledge-curation';
      const policy = maximalPolicy(cat);
      expect(autoAllowed({ policy, riskTier: 'trivial', authority: 'system', reversibility: 'reversible' })).toBe(true);
      for (const reversibility of ['irreversible', 'unknown'] as Reversibility[]) {
        expect(autoAllowed({ policy, riskTier: 'trivial', authority: 'system', reversibility })).toBe(false);
      }
    });
  });

  // ── 7.3 authority = owner never auto ───────────────────────────────────────
  describe('7.3 — authority=owner gates unconditionally (the owner’s call, by right)', () => {
    it('deriveNeedsHuman is TRUE for owner-authority across every armed/ceiling/risk combination', () => {
      for (const armed of [false, true]) {
        for (const ceiling of AUTONOMY_CEILINGS) {
          for (const riskTier of RISK_TIERS) {
            expect(
              deriveNeedsHuman({ authority: 'owner', armed, ceiling, riskTier, storedNeedsHuman: false }),
              `owner auto-ran (armed=${armed}, ceiling=${ceiling}, risk=${riskTier})`,
            ).toBe(true);
          }
        }
      }
    });

    it('every OWNER-authority action in the surface stays human under the most permissive policy', () => {
      const ownerActions = ACTION_SURFACE.filter((a) => a.authority === 'owner');
      expect(ownerActions.length).toBeGreaterThan(0);
      for (const a of ownerActions) {
        for (const riskTier of RISK_TIERS) {
          // reversible on purpose — isolates the authority gate from the reversibility gate.
          expect(
            autoAllowed({ policy: maximalPolicy(a.category), riskTier, authority: 'owner', reversibility: 'reversible' }),
            `${a.id} (owner) auto-ran @ ${riskTier}`,
          ).toBe(false);
        }
      }
    });
  });

  // ── 7.4 unmapped category → never-auto (fail-safe) ─────────────────────────
  describe('7.4 — an unmapped action fails safe to never-auto', () => {
    it('a non-governance / unknown tool resolves to NO category (null)', () => {
      for (const action of ['search:fulltext', 'locks:acquire', 'coord:send', 'totally:unknown']) {
        expect(categoryForAction(action), action).toBeNull();
      }
    });

    it('with no category there is no policy row, so the gate consults the never-auto default ⇒ human', () => {
      // The decider's fail-safe (D-009): a null category has no policy, so the
      // effective ceiling defaults to never-auto. deriveNeedsHuman with an absent
      // ceiling models exactly that — and gates, for every risk tier.
      for (const riskTier of RISK_TIERS) {
        expect(deriveNeedsHuman({ armed: true, ceiling: null, riskTier }), `risk=${riskTier}`).toBe(true);
        expect(deriveNeedsHuman({ armed: true, ceiling: undefined, riskTier }), `risk=${riskTier}`).toBe(true);
      }
    });

    it('unknown risk also fails safe: armed + a real ceiling but a null risk tier ⇒ treated as critical', () => {
      // A governed action whose risk the scoper hasn't set yet must not slip
      // through just because its category has a non-zero ceiling.
      expect(deriveNeedsHuman({ armed: true, ceiling: 'high', riskTier: null })).toBe(true);
      expect(deriveNeedsHuman({ armed: true, ceiling: 'critical', riskTier: null })).toBe(false); // only a critical ceiling admits unknown(=critical) risk
    });
  });

  // ── 7.5 coverage: the gate sees the WHOLE human-driving surface ────────────
  describe('7.5 — coverage invariant: every covered human-driving action routes to a governed real category', () => {
    it('every COVERED action’s Queen verb resolves (via the runtime map) to a real, non-null category — no ungoverned auto escape', () => {
      const covered = ACTION_SURFACE.filter((a) => a.coverage === 'covered');
      expect(covered.length).toBeGreaterThan(0);
      for (const a of covered) {
        expect(a.queenVerbs.length, `${a.id} covered but verbless`).toBeGreaterThan(0);
        for (const verb of a.queenVerbs) {
          const cat = categoryForAction(verb);
          expect(cat, `${a.id}: verb ${verb} is ungoverned (null)`).not.toBeNull();
          expect(cat, `${a.id}: verb ${verb} routes to the wrong ceiling`).toBe(a.category);
        }
      }
    });

    it('the surface only ever assigns categories the gate knows: every action’s category has a default policy + a ceiling', () => {
      for (const a of ACTION_SURFACE) {
        const policy = defaultPolicyFor(a.category);
        expect(policy.category).toBe(a.category);
        expect(AUTONOMY_CEILINGS).toContain(effectiveCeiling(policy));
        expect(AUTONOMY_CATEGORY_IDS).toContain(a.category);
      }
    });

    it('every PROTECTED-category action in the surface is never-auto under its shipped policy', () => {
      for (const a of ACTION_SURFACE) {
        if (!isProtectedCategory(a.category)) continue;
        for (const riskTier of RISK_TIERS) {
          expect(
            autoAllowed({ policy: defaultPolicyFor(a.category), riskTier, authority: a.authority, reversibility: a.reversibility }),
            `${a.id} (protected) auto-ran`,
          ).toBe(false);
        }
      }
    });
  });
});

// ── 8. the behavior-neutral migration proof — identical to today (P-091) ──────
//
// D-007: every category ceiling ships never-auto and the gate stays behavior-
// neutral until the owner's P-092 arming act, so the day this lands behavior is
// IDENTICAL to today. This section is that proof, in four legs.

describe('P-091 — behavior-neutral migration proof: the model lands identical to today (B-19)', () => {
  const TIER_INPUTS: (RiskTier | null)[] = [...RISK_TIERS, null];
  const CEILING_INPUTS: (AutonomyCeiling | null)[] = [...AUTONOMY_CEILINGS, null];

  it('LEG 1 — unarmed, the gate is the IDENTITY on the legacy stored token, for EVERY risk/ceiling input', () => {
    // armed=false (no caller arms before P-092) ⇒ deriveNeedsHuman returns exactly
    // `storedNeedsHuman`, whatever the (unconsulted) risk/ceiling. This is the core
    // of the proof: with the model present-but-unarmed, the DONE-gate reads exactly
    // the same token it read before the migration.
    let sweep = 0;
    for (const storedNeedsHuman of [true, false]) {
      for (const riskTier of TIER_INPUTS) {
        for (const ceiling of CEILING_INPUTS) {
          for (const authority of [undefined, 'system'] as const) {
            expect(
              deriveNeedsHuman({ storedNeedsHuman, riskTier, ceiling, authority, armed: false }),
              `identity broke @ stored=${storedNeedsHuman} risk=${riskTier} ceiling=${ceiling} authority=${authority}`,
            ).toBe(storedNeedsHuman);
            sweep++;
          }
        }
      }
    }
    expect(sweep).toBe(2 * TIER_INPUTS.length * CEILING_INPUTS.length * 2); // the sweep actually ran
  });

  it('LEG 2 — authority=owner is the SINGLE unarmed exception, and no legacy item carries authority (default = system), so it never fires today', () => {
    // The one branch that fires while unarmed is authority=owner — but that axis is
    // net-new (B-01) and the default is `system`, so no pre-migration item triggers
    // it. Hence the unarmed gate is behavior-identical with no caveat in practice.
    expect(DEFAULT_AUTHORITY).toBe('system');
    expect(deriveNeedsHuman({ authority: 'owner', armed: false, storedNeedsHuman: false })).toBe(true);
    // …and with the default (system) authority, the identity of LEG 1 holds.
    expect(deriveNeedsHuman({ authority: DEFAULT_AUTHORITY, armed: false, storedNeedsHuman: false })).toBe(false);
    expect(deriveNeedsHuman({ authority: DEFAULT_AUTHORITY, armed: false, storedNeedsHuman: true })).toBe(true);
  });

  it('LEG 3 — even an ACCIDENTAL arm changes nothing: under the shipped defaults, every action in the surface still gates', () => {
    // The strongest form of behavior-neutral: were the policy somehow armed BEFORE
    // the owner lowers any ceiling, the armed path ALSO routes every human-driving
    // action to a human — because every shipped default is never-auto.
    for (const id of AUTONOMY_CATEGORY_IDS) {
      expect(autoEverAllowed(defaultPolicyFor(id)), `${id} could auto at ship`).toBe(false);
    }
    for (const a of ACTION_SURFACE) {
      for (const riskTier of RISK_TIERS) {
        expect(
          autoAllowed({ policy: defaultPolicyFor(a.category), riskTier, authority: a.authority, reversibility: a.reversibility }),
          `${a.id} auto-ran under shipped defaults`,
        ).toBe(false);
      }
    }
  });

  it('LEG 4 — the dial is REAL but ships at zero: widening requires a deliberate owner ceiling-lower (not graduation, not arming alone)', () => {
    // Proves the migration is behavior-neutral WITHOUT being vacuous — the gate
    // genuinely opens once, and only when, the owner acts. A reversible, system-
    // authority action in a non-protected category:
    const action = ACTION_SURFACE.find((a) => a.id === 'inbox.triage-item')!;
    expect(action.authority).toBe('system');
    expect(action.reversibility).toBe('reversible');
    const at = (policy: AutonomyCategoryPolicy, riskTier: RiskTier) =>
      autoAllowed({ policy, riskTier, authority: action.authority, reversibility: action.reversibility });

    // shipped default → gated even at the lowest risk.
    expect(at(defaultPolicyFor(action.category), 'trivial')).toBe(false);
    // owner lowers the ceiling to `low` (unlocked, graduated up to it) → NOW it opens,
    // but still only within the cap: trivial/low auto, moderate+ still gated.
    const opened = policyFor(action.category, { locked: false, ceiling: 'low', graduatedLevel: 'low' });
    expect(at(opened, 'trivial')).toBe(true);
    expect(at(opened, 'low')).toBe(true);
    expect(at(opened, 'moderate')).toBe(false);
    expect(at(opened, 'critical')).toBe(false);
    // graduation can't outrun the cap: ceiling stays `low`, so cranking graduated to
    // critical changes nothing above the ceiling.
    const overGraduated = policyFor(action.category, { locked: false, ceiling: 'low', graduatedLevel: 'critical' });
    expect(effectiveCeiling(overGraduated)).toBe('low');
    expect(at(overGraduated, 'moderate')).toBe(false);
  });

  // The store-level default-read (an unseeded workspace / pre-boot 42P01 → all
  // defaults) is pinned against real PG in policy-store.integration.test.ts; this
  // pure suite pins the gate arithmetic those defaults flow into.
});

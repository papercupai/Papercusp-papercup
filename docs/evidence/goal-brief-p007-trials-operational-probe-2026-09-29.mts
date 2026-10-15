// Operational probe for plan goal-brief-to-claimed-plan-work-2026-09-23, clause AUTO-BAR-R-7-P-007 (READ-ONLY).
// Run from the papercusp repo root:
//   npx tsx docs/evidence/goal-brief-p007-trials-operational-probe-2026-09-29.mts \
//     > docs/evidence/goal-brief-p007-trials-operational-probe-2026-09-29.json
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion passed.
//
// Subject: the two P-007 GOAL trials, re-measured from the live ledger (never from prose):
//   Arm A (need discovery -> goal-local plan, no Blender proposal): goals 9368ec -> 406e99 -> 8016e1,
//          plan papercusp-db-backup-invalid-db-2026-09-27.
//   Arm B (adopt an existing Blender plan, no clone): goals 956e4d -> a88411 -> 81a93e,
//          plan duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05.
// Reads (SELECT only, via sudo -n -u postgres psql): harness_shared.goals, harness_plans, plan_revisions,
// work_items, fleet_membership_events, scout_routed_ideas, test_runs, adv_sessions, session_turns.
// Writes nothing. The overall assertion id is the lowercased spec id; sub-assertions are prefixed r7-.
// Known residue is REPORTED in `residualUnknowns`, never suppressed to make an assertion pass.
import { execFileSync } from 'node:child_process';

const startedAt = new Date().toISOString();
const assertions: Array<{ id: string; passed: boolean; evidence: string }> = [];
const observations: Record<string, unknown> = {};
const residualUnknowns: string[] = [];
const assert = (id: string, passed: boolean, evidence: string) => assertions.push({ id, passed, evidence });
type Row = Record<string, any>;
const rows = (sql: string): Row[] => {
  const out = execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'papercusp', '-At', '-c',
    `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim()) as Row[];
};
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const inList = (xs: readonly string[]) => xs.map(lit).join(',');

const WS = 'papercusp-workspace';
const OPERATOR = 'su-cf569f3f-d560-4ae5-8a7a-bb4bdaeb21c7'; // the session that started the trials and ran the probe
// Counterexample mode: the falsifiability control for AUTO-BAR-R-7-P-007.
//   R7_COUNTEREXAMPLE=arm-a-blender-plan npx tsx <this file> > <this file stem>.counterexample.json
// re-points Arm A at the Arm B plan, a Blender-origin plan that existed before every trial goal and that no
// Arm A goal created. Claiming that plan as Arm A's "discovered need" is the exact defect R-7 rules out: a goal
// relabelling an existing Blender proposal as goal-local work. A sound instrument must report
// r7-arm-a-goal-local-plan=false and exit 1 on that input. Only the Arm A plan changes; every read and every
// other sub-assertion is the same code. Normal mode (variable unset) is unchanged.
const COUNTEREXAMPLE = process.env.R7_COUNTEREXAMPLE ?? null;
if (COUNTEREXAMPLE !== null && COUNTEREXAMPLE !== 'arm-a-blender-plan') {
  throw new Error(`unknown R7_COUNTEREXAMPLE=${COUNTEREXAMPLE}; the only counterexample is arm-a-blender-plan`);
}
const ARM_B_PLAN = 'duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05';
const ARMS = {
  A: {
    label: 'need discovery -> goal-local plan',
    goals: ['restore-reliable-hourly-papercusp-postgres-backu-9368ec', 'finish-restoring-reliable-hourly-papercusp-postg-406e99',
      'ship-plan-papercusp-db-backup-invalid-db-2026-09-8016e1'],
    plan: COUNTEREXAMPLE === 'arm-a-blender-plan' ? ARM_B_PLAN : 'papercusp-db-backup-invalid-db-2026-09-27',
  },
  B: {
    label: 'adopt existing Blender plan without cloning',
    goals: ['stop-work-item-duplicate-screening-from-admittin-956e4d', 'finish-shipping-the-duplicate-screening-fix-adop-a88411',
      'ship-adopted-plan-duplicate-screening-keys-on-au-81a93e'],
    plan: 'duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05',
    blenderIdea: 'EI-22406075136912314',
  },
} as const;
const allGoals = [...ARMS.A.goals, ...ARMS.B.goals];

// ── Shared reads ──
const goals = rows(`SELECT id, title, left(body, 240) AS body, status, budget_cents, created_at, updated_at,
    launch_settings->'defaults' AS defaults, metadata->>'agentOwnerId' AS holder, metadata->>'drainFleet' AS drain_fleet,
    metadata->>'spentCents' AS spent_cents, metadata->>'spentCentsSource' AS spent_source,
    metadata->'autoKilled'->>'reason' AS kill_reason, metadata->'autoKilled'->>'at' AS killed_at,
    metadata->'autoKilled'->'reasons' AS kill_reasons, outputs IS NOT NULL AND outputs::text NOT IN ('null','{}') AS has_outputs
  FROM harness_shared.goals WHERE workspace_id = ${lit(WS)} AND id IN (${inList(allGoals)})`);
const goal = (id: string) => goals.find((g) => g.id === id);
const plans = rows(`SELECT plan_slug, status, goal_id, is_blender_origin, origin, created_at, updated_at, version
  FROM harness_shared.harness_plans WHERE workspace_id = ${lit(WS)} AND harness_slug = 'papercusp'
    AND plan_slug IN (${inList([ARMS.A.plan, ARMS.B.plan])})`);
const plan = (slug: string) => plans.find((p) => p.plan_slug === slug);
const plansByTrialGoals = rows(`SELECT plan_slug, goal_id, created_at FROM harness_shared.harness_plans
  WHERE workspace_id = ${lit(WS)} AND goal_id IN (${inList(allGoals)})`);
const items = rows(`SELECT source_plan_slug AS plan, feature_id, status, source_plan_item_ids AS plan_items,
    first_claimed_at, terminal_owner FROM harness_shared.work_items
  WHERE workspace_id = ${lit(WS)} AND harness_slug = 'papercusp' AND lane IS DISTINCT FROM 'observation'
    AND source_plan_slug IN (${inList([ARMS.A.plan, ARMS.B.plan])}) ORDER BY created_ts`);
const membership = rows(`SELECT owner_id, fleet_slug, fleet_role, event, at FROM harness_shared.fleet_membership_events
  WHERE workspace_id = ${lit(WS)} ORDER BY at`);
const ideas = rows(`SELECT idea_id, outcome, rail, origin, created_by, routed_ref, graded_by
  FROM harness_shared.scout_routed_ideas WHERE workspace_id = ${lit(WS)}
    AND routed_ref IN (${inList([`plan:${ARMS.A.plan}`, `plan:${ARMS.B.plan}`])})`);
const shipRevs = rows(`SELECT DISTINCT ON (plan_slug) plan_slug, seq, author_kind, author_id, to_timestamp(created_at / 1000.0) AS at
  FROM harness_shared.plan_revisions WHERE workspace_id = ${lit(WS)} AND plan_slug IN (${inList([ARMS.A.plan, ARMS.B.plan])})
  ORDER BY plan_slug, created_at DESC`);

const holdersOf = (arm: keyof typeof ARMS) => ARMS[arm].goals.map((g) => goal(g)?.holder).filter(Boolean) as string[];
const fleetsOf = (arm: keyof typeof ARMS) => ARMS[arm].goals.map((g) => goal(g)?.drain_fleet).filter(Boolean) as string[];
/** Was `owner` a joined member (or leader) of one of `fleets` at instant `at`? Replays join/lead/leave events. */
const inFleetAt = (owner: string, fleets: readonly string[], at: string): string | null => {
  let current: string | null = null;
  for (const e of membership) {
    if (e.owner_id !== owner || Date.parse(e.at) > Date.parse(at)) continue;
    if (e.event === 'leave') current = null;
    else if (e.fleet_slug) current = e.fleet_slug;
  }
  return current && fleets.includes(current) ? current : null;
};

observations.goals = goals.map((g) => ({
  id: g.id, status: g.status, budgetCents: Number(g.budget_cents), spentCents: g.spent_cents === null ? null : Number(g.spent_cents),
  spentSource: g.spent_source, killReason: g.kill_reason, killedAt: g.killed_at, holder: g.holder, drainFleet: g.drain_fleet,
  model: g.defaults?.model ?? null, effort: g.defaults?.effort ?? null, agent: g.defaults?.agent ?? null, carry: g.defaults?.carry ?? null,
  account: g.defaults?.account ?? null, createdAt: g.created_at, workload: g.title,
}));

// ── Sub-assertion 1: Arm A discovered a need and created a goal-local plan, without any Blender proposal ──
{
  const p = plan(ARMS.A.plan);
  const g0 = goal(ARMS.A.goals[0]);
  const created = p ? Date.parse(p.created_at) : NaN;
  const inGoalLife = !!g0 && created > Date.parse(g0.created_at) && (!g0.killed_at || created < Date.parse(g0.killed_at));
  const goalLocalIdea = ideas.find((i) => i.routed_ref === `plan:${ARMS.A.plan}` && i.idea_id.startsWith('goal-plan:'));
  const blenderIdeas = ideas.filter((i) => i.routed_ref === `plan:${ARMS.A.plan}` && !i.idea_id.startsWith('goal-plan:'));
  const ok = !!p && p.goal_id === ARMS.A.goals[0] && p.is_blender_origin === false && inGoalLife
    && !!goalLocalIdea && goalLocalIdea.created_by === g0?.holder && blenderIdeas.length === 0;
  observations.armA = { plan: p, goalLocalIdea, blenderIdeasOnPlan: blenderIdeas.map((i) => i.idea_id) };
  assert('r7-arm-a-goal-local-plan', ok,
    `plan ${ARMS.A.plan} goal_id=${p?.goal_id} is_blender_origin=${p?.is_blender_origin} created ${p?.created_at} inside goal ${ARMS.A.goals[0]} `
    + `life (${g0?.created_at} .. ${g0?.killed_at ?? 'open'}); goal-local routed idea created_by=${goalLocalIdea?.created_by} `
    + `(goal holder ${g0?.holder}); Blender-origin ideas routed to this plan: ${blenderIdeas.length}`);
}

// ── Sub-assertion 2: Arm B adopted the pre-existing Blender plan and cloned nothing ──
{
  const p = plan(ARMS.B.plan);
  const g0 = goal(ARMS.B.goals[0]);
  const blender = ideas.find((i) => i.idea_id === ARMS.B.blenderIdea);
  const armBPlans = plansByTrialGoals.filter((r) => (ARMS.B.goals as readonly string[]).includes(r.goal_id));
  const ok = !!p && p.is_blender_origin === true && !!g0 && Date.parse(p.created_at) < Date.parse(g0.created_at)
    && !!blender && blender.routed_ref === `plan:${ARMS.B.plan}`
    && armBPlans.length === 1 && armBPlans[0].plan_slug === ARMS.B.plan;
  observations.armB = { plan: p, blenderIdea: blender, plansAttributedToArmBGoals: armBPlans };
  assert('r7-arm-b-adopted-no-clone', ok,
    `plan ${ARMS.B.plan} is_blender_origin=${p?.is_blender_origin} created ${p?.created_at}, before goal ${ARMS.B.goals[0]} `
    + `(${g0?.created_at}); Blender idea ${ARMS.B.blenderIdea} still routed_ref=${blender?.routed_ref}; plans attributed to any `
    + `Arm B goal: ${armBPlans.map((r) => r.plan_slug).join(',') || 'none'} (exactly the adopted plan, so no clone)`);
  if (p && p.goal_id !== ARMS.B.goals[0]) residualUnknowns.push(
    `Arm B plan goal attribution now reads ${p.goal_id}, not the adopting goal ${ARMS.B.goals[0]}. Whether the adopting goal ever stamped goal_id (and was later replaced) is not measured here; today the adopting goal is visible only through fleet membership and work-item claims, not on the plan row.`);
}

// ── Sub-assertion 3: independent member claims in both arms ──
{
  const perArm: Record<string, unknown> = {};
  let ok = true;
  for (const arm of ['A', 'B'] as const) {
    const holders = holdersOf(arm);
    const fleets = fleetsOf(arm);
    const claims = items.filter((i) => i.plan === ARMS[arm].plan).map((i) => {
      const claimer = i.terminal_owner as string | null;
      return { item: i.feature_id, planItems: i.plan_items, status: i.status, firstClaimedAt: i.first_claimed_at, claimer,
        independentOfHolderAndOperator: !!claimer && !holders.includes(claimer) && claimer !== OPERATOR,
        drainFleetAtClaim: claimer && i.first_claimed_at ? inFleetAt(claimer, fleets, i.first_claimed_at) : null };
    });
    const allIndependent = claims.length > 0 && claims.every((c) => c.independentOfHolderAndOperator);
    const anyFleetMember = claims.some((c) => c.drainFleetAtClaim !== null);
    ok &&= allIndependent && anyFleetMember;
    for (const c of claims) if (c.drainFleetAtClaim === null) residualUnknowns.push(
      `Arm ${arm} ${c.item} was first claimed at ${c.firstClaimedAt} by ${c.claimer}, who held no membership in any Arm ${arm} drain fleet at that instant: independent of the holder, but not provably a goal-fleet claim.`);
    perArm[arm] = { holders, fleets, claims };
  }
  observations.claims = perArm;
  assert('r7-independent-member-claims', ok,
    `every plan work item in both arms was claimed and closed by a session that is neither a goal holder nor the operator, and each arm has at least one claim made by a member of its own drain fleet at claim time (per-claim detail in observations.claims)`);
}

// ── Sub-assertion 4: at least one organic end-to-end terminal/verification/feedback/report trace (Arm B) ──
{
  const p = plan(ARMS.B.plan);
  const holders = holdersOf('B');
  const fleets = fleetsOf('B');
  const bItems = items.filter((i) => i.plan === ARMS.B.plan);
  const implementers = [...new Set(bItems.map((i) => i.terminal_owner))];
  const ship = shipRevs.find((r) => r.plan_slug === ARMS.B.plan);
  const shipByFleet = ship ? inFleetAt(ship.author_id, fleets, ship.at) : null;
  const [grade] = rows(`SELECT feature_id, status, payload->'_ei'->>'created_by' AS created_by FROM harness_shared.work_items
    WHERE workspace_id = ${lit(WS)} AND feature_id = 'EI-24557350775730459'`);
  const blender = ideas.find((i) => i.idea_id === ARMS.B.blenderIdea);
  const finalGoal = goal(ARMS.B.goals[2]);
  const graderIndependent = !!grade && grade.status === 'done' && !implementers.includes(grade.created_by)
    && !holders.includes(grade.created_by) && grade.created_by !== OPERATOR;
  const ok = bItems.length > 0 && bItems.every((i) => i.status === 'done') && p?.status === 'shipped'
    && !!ship && ship.author_id !== OPERATOR && shipByFleet !== null && graderIndependent
    && blender?.outcome === 'won' && finalGoal?.status === 'achieved';
  observations.armBTerminalChain = { items: bItems.map((i) => i.feature_id), implementers, ship, shipByFleet, grade,
    blenderOutcome: blender?.outcome, finalGoalStatus: finalGoal?.status, finalGoalHasOutputs: finalGoal?.has_outputs };
  assert('r7-organic-terminal-chain', ok,
    `Arm B: ${bItems.length}/${bItems.length} plan items done by ${implementers.join(',')}; plan ${p?.status} at rev ${ship?.seq} `
    + `authored by ${ship?.author_id} (member of ${shipByFleet ?? 'no Arm B fleet'} at ${ship?.at}, not the operator); `
    + `independent grade ${grade?.feature_id} by ${grade?.created_by} (${grade?.status}); Blender feedback idea outcome=${blender?.outcome}; `
    + `goal ${ARMS.B.goals[2]} status=${finalGoal?.status}`);
  const shipA = shipRevs.find((r) => r.plan_slug === ARMS.A.plan);
  observations.armATerminalChain = { ship: shipA, planStatus: plan(ARMS.A.plan)?.status };
  if (shipA?.author_id === OPERATOR) residualUnknowns.push(
    `Arm A's ship hop (rev ${shipA.seq}, ${shipA.at}) was authored by the operator ${OPERATOR}, not by a goal fleet (disclosed as goal-brief-to-claimed-plan-work-2026-09-23#D-017). Arm A is therefore NOT an organic end-to-end terminal trace; the organic-chain claim rests on Arm B alone.`);
  const armAIdea = ideas.find((i) => i.routed_ref === `plan:${ARMS.A.plan}` && i.idea_id.startsWith('goal-plan:'));
  if (armAIdea && armAIdea.outcome === 'pending') residualUnknowns.push(
    `Arm A's goal-local feedback row ${armAIdea.idea_id} is still outcome=pending after its plan shipped (plan-rail outcome propagation lag, WI-10003894).`);
}

// ── Sub-assertion 5: negative controls pass at the current build (tree-plane runs cited by WI-10002629) ──
{
  const CONTROLS: Array<[number, string]> = [
    [20095653, 'existing-plans-sufficient: goal-planning-review.test.ts'],
    [20095654, 'goal planning proof: goal-planning-proof.test.ts'],
    // 20095655 and 20095664 vanished from test_runs (WI-10005588); re-run 2026-10-02 18:30Z at ed336ea0e0 as 20553650/51.
    [20553650, 'terminal/no-demand after sufficient review + blocked-budget typed refusal (budget.unmeasured/exceeded, cap unchanged): goal-planning-obligation-proof.test.ts'],
    [20095657, 'sufficient review; blocked draft never produces an inadmissible launch: agent-obligation-planning-demand.integration.test.ts'],
    [20095659, 'cross-goal/unowned plan never re-attributed; Blender adoption adds no duplicate row: goal-feedback.integration.test.ts'],
    [20095661, 'goal feedback unit: goal-feedback.test.ts'],
    [20095663, 'missing-delivery/attribution reported unknown, not ignored: agent-obligation-reader.test.ts'],
    [20553651, 'absent vs wrong attribution: goal-launch-settings.test.ts'],
  ];
  const runs = rows(`SELECT id, status, file_path, commit_sha, finished_at FROM harness_shared.test_runs
    WHERE id IN (${CONTROLS.map(([id]) => id).join(',')})`);
  const table = CONTROLS.map(([id, control]) => ({ id, control, ...(runs.find((r) => Number(r.id) === id) ?? { status: 'missing' }) }));
  observations.negativeControls = table;
  assert('r7-negative-controls', table.every((r) => r.status === 'pass'),
    table.map((r) => `${r.id}=${r.status}`).join(' ') + ` (all at commit ${[...new Set(runs.map((r) => String(r.commit_sha).slice(0, 10)))].join(',')})`);
}

// ── Sub-assertion 6: no budget widening — every trial goal is terminal, and each breach kill fired against the SAME
// budget the goal row still carries (the cap in force at kill time == the cap at rest, so it was never raised). ──
// This asserts non-widening only. Kill LATENCY is reported separately as overshoot, because a late kill is not a widening.
{
  const trial = allGoals.map((id) => goal(id)).filter(Boolean) as Row[];
  const breach = trial.filter((g) => g.kill_reason === 'measured-goal-breach').map((g) => {
    const cited = /reached budget (\d+)c/.exec(JSON.stringify(g.kill_reasons ?? []))?.[1];
    const spent = g.spent_cents === null ? null : Number(g.spent_cents);
    return { id: g.id, budgetAtRest: Number(g.budget_cents), budgetCitedAtKill: cited ? Number(cited) : null, spent,
      overshootPct: spent === null ? null : Math.round(((spent - Number(g.budget_cents)) / Number(g.budget_cents)) * 100) };
  });
  const allTerminal = trial.length === allGoals.length && trial.every((g) => ['killed', 'achieved'].includes(g.status));
  const neverRaised = breach.every((b) => b.budgetCitedAtKill !== null && b.budgetCitedAtKill === b.budgetAtRest);
  observations.caps = { breachKills: breach };
  assert('r7-caps-not-widened', allTerminal && neverRaised,
    trial.map((g) => `${g.id.slice(-6)}:${g.status}/${g.spent_cents ?? '?'}c of ${g.budget_cents}c${g.kill_reason ? ` (${g.kill_reason})` : ''}`).join(' ')
    + `; every breach kill cited the budget still at rest (${breach.map((b) => `${b.id.slice(-6)} ${b.budgetCitedAtKill}c==${b.budgetAtRest}c`).join(', ')})`);
  const late = breach.filter((b) => (b.overshootPct ?? 0) > 0);
  if (late.length) residualUnknowns.push(
    `Budget kills fire AFTER the breach, not at it: measured overshoot ${late.map((b) => `${b.id.slice(-6)} +${b.overshootPct}%`).join(', ')}. The caps were not raised, but enforcement lag let spend run past them (worst: ${Math.max(...late.map((b) => b.overshootPct ?? 0))}%; tracked as WI-10003507).`);
  residualUnknowns.push(
    'Goal-pots spend rollups omit consult forks and orphan sessions. Decision goal-brief-to-claimed-plan-work-2026-09-23#D-016 records real cost of ~$19.44 for Arm A goal 8016e1 against a $15 cap (consult ~$7.19 uncounted) and ~$23.29 of $30 for Arm B goal 81a93e (orphan 2e21e6 ~$8.06 + consult ~$1.98 added by hand). The cap was not widened; the meter under-counted.');
}

// ── Records the clause requires (not pass/fail): exact brief exposure per goal holder ──
{
  const sessions = rows(`SELECT coord_owner_id, session_id FROM harness_shared.adv_sessions
    WHERE coord_owner_id IN (${inList(allGoals.map((g) => goal(g)?.holder).filter(Boolean) as string[])})`);
  const exposure = [];
  for (const g of allGoals) {
    const holder = goal(g)?.holder;
    const sids = sessions.filter((s) => s.coord_owner_id === holder).map((s) => s.session_id).filter(Boolean);
    const [first] = sids.length === 0 ? [] : rows(`SELECT session_id, turn_idx, turn_origin, ts, length(text) AS chars,
        encode(sha256(convert_to(text, 'UTF8')), 'hex') AS sha256
      FROM harness_shared.session_turns WHERE session_id IN (${inList(sids)}) AND speaker = 'user'
      ORDER BY ts, turn_idx LIMIT 1`);
    // session_turns stores user turns capped at 8000 chars (measured 2026-09-29: max 8000, none longer), so a hash of a
    // turn at the cap covers only its indexed prefix, never provably the full delivered brief.
    const isClassifiedKickoff = first?.turn_origin === 'fleet-kickoff';
    const truncatedAtIndexCap = !!first && Number(first.chars) >= 8000 - 10;
    exposure.push({ goal: g, holder, sessions: sids, firstHolderTurn: first ?? null, isClassifiedKickoff, truncatedAtIndexCap });
    if (!first) residualUnknowns.push(`No indexed first turn for goal ${g} holder ${holder}: its delivered kickoff brief cannot be hashed from the ledger.`);
    else if (!isClassifiedKickoff || truncatedAtIndexCap) residualUnknowns.push(
      `Brief exposure for goal ${g} is not exact: the first indexed holder turn is origin=${first.turn_origin ?? 'unclassified'}`
      + `${truncatedAtIndexCap ? `, ${first.chars} chars (at the 8000-char index cap, so only a prefix is hashed)` : ''}.`);
  }
  observations.briefExposure = exposure;
  observations.sourceGeneration = { planRevisionsAtShip: shipRevs, controlRunCommit: '1e46c027b5 (see negativeControls)' };
}

const subs = assertions.filter((a) => a.id.startsWith('r7-'));
assert('auto-bar-r-7-p-007', subs.every((a) => a.passed),
  `${subs.filter((a) => a.passed).length}/${subs.length} R-7 sub-assertions passed over both trial lineages (${subs.map((a) => `${a.id}=${a.passed}`).join(', ')}); `
  + `${residualUnknowns.length} residual unknown(s) disclosed`);

const passed = assertions.filter((a) => a.passed).length;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: COUNTEREXAMPLE
    ? 'goal-brief P-007 GOAL trials operational probe (R-7) — counterexample arm-a-blender-plan'
    : 'goal-brief P-007 GOAL trials operational probe (R-7)',
  framework: 'shell',
  command: [...(COUNTEREXAMPLE ? ['env', `R7_COUNTEREXAMPLE=${COUNTEREXAMPLE}`] : []),
    'npx', 'tsx', 'docs/evidence/goal-brief-p007-trials-operational-probe-2026-09-29.mts'],
  ...(COUNTEREXAMPLE
    ? {
        mode: 'counterexample',
        counterexample: {
          id: COUNTEREXAMPLE,
          targets: 'auto-bar-r-7-p-007',
          fault: `Arm A plan replaced by ${ARM_B_PLAN} (Blender-origin, created before every trial goal, created by no Arm A goal)`,
          expected: 'r7-arm-a-goal-local-plan=false, auto-bar-r-7-p-007=false, exitCode 1 (caught)',
        },
      }
    : {}),
  exitCode: passed === assertions.length ? 0 : 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  summary: `${passed}/${assertions.length} live assertions passed for plan goal-brief-to-claimed-plan-work-2026-09-23 clause AUTO-BAR-R-7-P-007.`,
  assertions,
  plan: 'goal-brief-to-claimed-plan-work-2026-09-23',
  residualUnknowns,
  observations,
}, null, 2)}\n`);
process.exitCode = passed === assertions.length ? 0 : 1;

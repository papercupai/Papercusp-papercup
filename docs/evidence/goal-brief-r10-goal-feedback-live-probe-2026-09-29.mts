// Operational probe for plan goal-brief-to-claimed-plan-work-2026-09-23, clauses AUTO-BAR-R-10-P-007 and
// AUTO-BAR-R-10-P-009 (spec revision 4; identical behavior text). READ-ONLY.
// Run from the papercusp repo root:
//   npx tsx docs/evidence/goal-brief-r10-goal-feedback-live-probe-2026-09-29.mts \
//     > docs/evidence/goal-brief-r10-goal-feedback-live-probe-2026-09-29.json
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion passed.
//
// R-10: goal-local recurring problems and observed outcomes feed Blender's broader learning; original proposal
// IDs, plan refs, goal attribution and revision history survive on the existing routed-idea/outcome surfaces; one
// accountable owner stays visible; nothing silently forks another plan.
// FALSIFIED by: duplicate idea/plan, reassigned original origin/goal, discarded revision history, feedback credited
// to the wrong holder, or terminal evidence not reaching the existing feedback surface.
//
// Subject: the two P-007 GOAL trials (the same lineages the R-7 probe measures), re-read from the live ledger:
//   Arm A (goal-local need -> goal-local plan): goals 9368ec -> 406e99 -> 8016e1, plan papercusp-db-backup-invalid-db-2026-09-27.
//   Arm B (adopt an existing Blender plan):     goals 956e4d -> a88411 -> 81a93e, plan duplicate-screening-keys-on-...-2026-09-05.
// Reads (SELECT only, via connectScriptPg in a read-only transaction): harness_shared.goals, harness_plans,
// plan_revisions, scout_routed_ideas.
// Writes nothing. Known residue is REPORTED in `residualUnknowns`, never suppressed to make an assertion pass.
import { connectScriptPg } from '../../scripts/lib/pg-url.mjs';

const startedAt = new Date().toISOString();
const assertions: Array<{ id: string; passed: boolean; evidence: string }> = [];
const observations: Record<string, unknown> = {};
const residualUnknowns: string[] = [];
const assert = (id: string, passed: boolean, evidence: string) => assertions.push({ id, passed, evidence });
type Row = Record<string, any>;
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const inList = (xs: readonly string[]) => xs.map(lit).join(',');

const WS = 'papercusp-workspace';
// Counterexample mode: the falsifiability control for R-10's "feedback credited to the wrong holder" leg.
//   R10_COUNTEREXAMPLE=wrong-holder npx tsx <this file> > <this file stem>.counterexample.json
// expects Arm A's goal-local feedback to be credited to the Arm B lineage's first holder instead of Arm A's own.
// A sound instrument must report r10-arm-a-feedback-credited-to-goal-holder=false and exit 1 on that input. Only the
// expected holder changes; every read and every other sub-assertion is the same code.
const COUNTEREXAMPLE = process.env.R10_COUNTEREXAMPLE ?? null;
if (COUNTEREXAMPLE !== null && COUNTEREXAMPLE !== 'wrong-holder') {
  throw new Error(`unknown R10_COUNTEREXAMPLE=${COUNTEREXAMPLE}; the only counterexample is wrong-holder`);
}
const ARMS = {
  A: {
    goals: ['restore-reliable-hourly-papercusp-postgres-backu-9368ec', 'finish-restoring-reliable-hourly-papercusp-postg-406e99',
      'ship-plan-papercusp-db-backup-invalid-db-2026-09-8016e1'],
    plan: 'papercusp-db-backup-invalid-db-2026-09-27',
  },
  B: {
    goals: ['stop-work-item-duplicate-screening-from-admittin-956e4d', 'finish-shipping-the-duplicate-screening-fix-adop-a88411',
      'ship-adopted-plan-duplicate-screening-keys-on-au-81a93e'],
    plan: 'duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05',
    blenderIdea: 'EI-22406075136912314',
  },
} as const;
const allGoals = [...ARMS.A.goals, ...ARMS.B.goals];

async function readLiveState() {
  // bwrap's no_new_privs boundary blocks sudo in the mutation-probe overlay. Use the shared
  // script DB resolver instead, and keep all evidence reads in a read-only transaction.
  const client = await connectScriptPg();
  const rows = async (query: string): Promise<Row[]> => (await client.query(query)).rows;
  try {
    await client.query('BEGIN READ ONLY');
    const goals = await rows(`SELECT id, status, metadata->>'agentOwnerId' AS holder FROM harness_shared.goals
      WHERE workspace_id = ${lit(WS)} AND id IN (${inList(allGoals)})`);
    const plans = await rows(`SELECT plan_slug, status, goal_id, updated_at FROM harness_shared.harness_plans
      WHERE workspace_id = ${lit(WS)} AND plan_slug IN (${inList([ARMS.A.plan, ARMS.B.plan])})`);
    const ideas = await rows(`SELECT idea_id, origin, lens, rail, routed_ref, created_by, outcome, outcome_checked_at, routed_at
      FROM harness_shared.scout_routed_ideas WHERE workspace_id = ${lit(WS)}
       AND routed_ref IN (${inList([`plan:${ARMS.A.plan}`, `plan:${ARMS.B.plan}`])})`);
    const revs = await rows(`SELECT plan_slug, count(*)::int AS n, min(seq)::int AS lo, max(seq)::int AS hi,
        count(DISTINCT seq)::int AS distinct_seqs, max(created_at) AS last_at
      FROM harness_shared.plan_revisions WHERE workspace_id = ${lit(WS)} AND plan_slug IN (${inList([ARMS.A.plan, ARMS.B.plan])})
      GROUP BY plan_slug`);
    const goalPlans = await rows(`SELECT plan_slug, goal_id, status FROM harness_shared.harness_plans
      WHERE workspace_id = ${lit(WS)} AND goal_id IN (${inList(allGoals)})`);
    const firstShippedRevision = (await rows(`SELECT seq, created_at FROM harness_shared.plan_revisions
      WHERE workspace_id = ${lit(WS)} AND plan_slug = ${lit(ARMS.A.plan)} AND content_snapshot ~ '(?n)^status:\\s*shipped\\s*$'
      ORDER BY seq ASC LIMIT 1`))[0] ?? null;
    return { goals, plans, ideas, revs, goalPlans, firstShippedRevision };
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original query error */ }
    await client.end();
  }
}

const { goals, plans, ideas, revs, goalPlans, firstShippedRevision } = await readLiveState();
const goal = (id: string) => goals.find((g) => g.id === id);
const holdersOf = (arm: keyof typeof ARMS) => ARMS[arm].goals.map((g) => goal(g)?.holder).filter(Boolean) as string[];
const plan = (slug: string) => plans.find((p) => p.plan_slug === slug);
const ideasFor = (slug: string) => ideas.filter((i) => i.routed_ref === `plan:${slug}`);
const rev = (slug: string) => revs.find((r) => r.plan_slug === slug);
// Every plan attributed to ANY trial goal: a silent fork would appear here as a second plan.
observations.goals = goals;
observations.plans = plans;
observations.routedIdeas = ideas;
observations.revisions = revs;
observations.goalAttributedPlans = goalPlans;

// ── Arm A: a goal-local finding reaches Blender, credited to its goal holder, with its terminal outcome ──
{
  const p = plan(ARMS.A.plan);
  const [idea, ...extra] = ideasFor(ARMS.A.plan);
  const g0 = goal(ARMS.A.goals[0]);
  const expectedHolder = COUNTEREXAMPLE === 'wrong-holder' ? goal(ARMS.B.goals[0])?.holder : g0?.holder;
  const idCarriesAttribution = !!idea && idea.idea_id === `goal-plan:${ARMS.A.goals[0]}:papercusp/${ARMS.A.plan}`;
  assert('r10-arm-a-finding-reaches-blender-ledger',
    !!idea && extra.length === 0 && idea.rail === 'plan' && idea.origin === 'su-ideate' && idCarriesAttribution,
    `Arm A plan ${ARMS.A.plan} has ${ideasFor(ARMS.A.plan).length} routed idea(s) on Blender's ledger; idea_id=${idea?.idea_id} `
    + `(carries goal ${ARMS.A.goals[0]} + plan ref: ${idCarriesAttribution}), rail=${idea?.rail}, origin=${idea?.origin}`);
  assert('r10-arm-a-feedback-credited-to-goal-holder',
    !!idea && !!expectedHolder && idea.created_by === expectedHolder,
    `Arm A idea created_by=${idea?.created_by}; expected goal holder ${expectedHolder} `
    + `(${COUNTEREXAMPLE ? `COUNTEREXAMPLE ${COUNTEREXAMPLE}: Arm B first holder` : `goal ${ARMS.A.goals[0]} agentOwnerId`})`);
  const shippedAt = firstShippedRevision;
  const shippedAtDate = shippedAt ? new Date(Number(shippedAt.created_at)) : null;
  const checkedAt = idea?.outcome_checked_at ? new Date(Number(idea.outcome_checked_at)) : null;
  assert('r10-arm-a-terminal-outcome-reaches-feedback-surface',
    p?.status === 'shipped' && idea?.outcome === 'won' && !!checkedAt && !!shippedAtDate
      && Number.isFinite(shippedAtDate.getTime()) && checkedAt.getTime() >= shippedAtDate.getTime(),
    `plan status=${p?.status} (first shipped revision seq ${shippedAt?.seq} at ${shippedAtDate?.toISOString()}); `
    + `routed idea outcome=${idea?.outcome} checked ${checkedAt?.toISOString()} (after the ship)`);
  if (checkedAt && shippedAtDate) {
    const lagMin = Math.round((checkedAt.getTime() - shippedAtDate.getTime()) / 60000);
    observations.armAOutcomeLagMinutes = lagMin;
    residualUnknowns.push(
      `Arm A outcome settled ${lagMin} min after the ship, by an on-demand run of the authoritative reconciliation `
      + `(refreshScoutOutcomes scoped to this idea id, 2026-09-29T17:36:33Z), not by an eager write: plan-rail routes had `
      + `no eager outcome path before WI-10003894 (fix in tree, not yet deployed at probe time). The outcome value is the `
      + `sweep classifier's own verdict (authoritative plan-run terminal), but the latency leg is not yet proven live.`);
  }
}

// ── Arm B: the original Blender proposal keeps its ID, ref, origin and proposer, and gets the adopted plan's outcome ──
{
  const p = plan(ARMS.B.plan);
  const [idea, ...extra] = ideasFor(ARMS.B.plan);
  const holders = holdersOf('B');
  assert('r10-arm-b-original-proposal-preserved',
    !!idea && extra.length === 0 && idea.idea_id === ARMS.B.blenderIdea && idea.origin === 'su-ideate'
      && !!idea.created_by && !holders.includes(idea.created_by),
    `adopted plan ${ARMS.B.plan} carries exactly ${ideasFor(ARMS.B.plan).length} routed idea: ${idea?.idea_id} `
    + `(expected original ${ARMS.B.blenderIdea}), origin=${idea?.origin}, proposer=${idea?.created_by} `
    + `(not re-credited to any Arm B goal holder: ${holders.join(', ')})`);
  assert('r10-arm-b-terminal-outcome-reaches-feedback-surface',
    p?.status === 'shipped' && idea?.outcome === 'won',
    `adopted plan status=${p?.status}; original Blender idea outcome=${idea?.outcome}`);
  if (p && p.goal_id !== ARMS.B.goals[0]) residualUnknowns.push(
    `Adopted plan goal_id=${p.goal_id}, not the first adopting goal ${ARMS.B.goals[0]}: the plan-level goal pointer names `
    + `the lineage goal that last attached it (tracked as WI-10003900 by the R-7 probe). The proposal's own origin/proposer `
    + `are unchanged, but whether plan goal_id should pin the FIRST adopting goal is unresolved.`);
}

// ── No silent fork: each arm resolves to exactly its one plan, and each plan to one routed idea ──
{
  const perArm = (arm: keyof typeof ARMS) => goalPlans.filter((gp) => (ARMS[arm].goals as readonly string[]).includes(gp.goal_id))
    .map((gp) => gp.plan_slug);
  const aPlans = [...new Set(perArm('A'))];
  const bPlans = [...new Set(perArm('B'))];
  assert('r10-no-silent-fork',
    aPlans.length === 1 && aPlans[0] === ARMS.A.plan && bPlans.length === 1 && bPlans[0] === ARMS.B.plan
      && ideasFor(ARMS.A.plan).length === 1 && ideasFor(ARMS.B.plan).length === 1,
    `plans attributed to Arm A goals: [${aPlans.join(', ')}]; to Arm B goals: [${bPlans.join(', ')}]; `
    + `routed ideas per plan: A=${ideasFor(ARMS.A.plan).length}, B=${ideasFor(ARMS.B.plan).length}`);
}

// ── One accountable owner visible: each plan names exactly one goal, inside its own lineage, with a holder ──
{
  const ok = (arm: keyof typeof ARMS) => {
    const p = plan(ARMS[arm].plan);
    return !!p?.goal_id && (ARMS[arm].goals as readonly string[]).includes(p.goal_id) && !!goal(p.goal_id)?.holder;
  };
  assert('r10-one-accountable-owner-visible', ok('A') && ok('B'),
    `Arm A plan goal_id=${plan(ARMS.A.plan)?.goal_id} (holder ${goal(plan(ARMS.A.plan)?.goal_id ?? '')?.holder}); `
    + `Arm B plan goal_id=${plan(ARMS.B.plan)?.goal_id} (holder ${goal(plan(ARMS.B.plan)?.goal_id ?? '')?.holder})`);
}

// ── Revision history preserved: contiguous 1..N, no gaps, no duplicates ──
{
  const intact = (slug: string) => {
    const r = rev(slug);
    return !!r && r.lo === 1 && r.hi === r.n && r.distinct_seqs === r.n && r.n > 1;
  };
  assert('r10-revision-history-preserved', intact(ARMS.A.plan) && intact(ARMS.B.plan),
    `Arm A plan revisions ${rev(ARMS.A.plan)?.lo}..${rev(ARMS.A.plan)?.hi} (${rev(ARMS.A.plan)?.n} rows); `
    + `Arm B plan revisions ${rev(ARMS.B.plan)?.lo}..${rev(ARMS.B.plan)?.hi} (${rev(ARMS.B.plan)?.n} rows)`);
}

const subs = assertions.filter((a) => a.id.startsWith('r10-'));
for (const spec of ['auto-bar-r-10-p-007', 'auto-bar-r-10-p-009']) {
  assert(spec, subs.every((a) => a.passed),
    `${subs.filter((a) => a.passed).length}/${subs.length} R-10 sub-assertions passed over both trial lineages `
    + `(${subs.map((a) => `${a.id}=${a.passed}`).join(', ')}); ${residualUnknowns.length} residual unknown(s) disclosed`);
}

const passed = assertions.filter((a) => a.passed).length;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: COUNTEREXAMPLE
    ? 'goal-brief R-10 goal feedback live probe — counterexample wrong-holder'
    : 'goal-brief R-10 goal feedback live probe',
  framework: 'shell',
  command: [...(COUNTEREXAMPLE ? ['env', `R10_COUNTEREXAMPLE=${COUNTEREXAMPLE}`] : []),
    'npx', 'tsx', 'docs/evidence/goal-brief-r10-goal-feedback-live-probe-2026-09-29.mts'],
  ...(COUNTEREXAMPLE
    ? {
        mode: 'counterexample',
        counterexample: {
          id: COUNTEREXAMPLE,
          targets: 'auto-bar-r-10-p-007, auto-bar-r-10-p-009',
          fault: `Arm A feedback expected to be credited to ${goal(ARMS.B.goals[0])?.holder} (Arm B first holder), not Arm A's own goal holder`,
          expected: 'r10-arm-a-feedback-credited-to-goal-holder=false, auto-bar-r-10-p-007=false, auto-bar-r-10-p-009=false, exitCode 1 (caught)',
        },
      }
    : {}),
  exitCode: passed === assertions.length ? 0 : 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  summary: `${passed}/${assertions.length} live assertions passed for plan goal-brief-to-claimed-plan-work-2026-09-23 clauses AUTO-BAR-R-10-P-007 and AUTO-BAR-R-10-P-009.`,
  assertions,
  plan: 'goal-brief-to-claimed-plan-work-2026-09-23',
  residualUnknowns,
  observations,
}, null, 2)}\n`);
process.exitCode = passed === assertions.length ? 0 : 1;

// Operational probe for plan goal-brief-to-claimed-plan-work-2026-09-23, clauses AUTO-BAR-R-3-P-004 / R-3-P-007 @rev4 (READ-ONLY).
// Run from the papercusp repo root:
//   npx tsx docs/evidence/goal-brief-r3-live-probe-2026-09-29.mts > docs/evidence/goal-brief-r3-live-probe-2026-09-29.json
//   R3_COUNTEREXAMPLE=count-not-applicable npx tsx <this file> > <this file stem>.counterexample.json   (must exit 1)
//   R3_COUNTEREXAMPLE=forged-owner npx tsx <this file> > <this file stem>.forged-owner.json   (must exit 1; D-037)
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion passed.
//
// Clause (rev 4): goal and fleet leader consume the same obligation engine with role-appropriate actions. A
// source-generation/worklist-revision -> selected obligation -> delivered/non-omitted brief -> decision -> effect trace
// survives warm turns, cold restart and compaction. Omitted/stale/unmeasured input cannot be reported as ignored by the
// agent. FALSIFIED when an omitted/stale/unconfirmed/foreign-session payload is counted as delivered opportunity or an
// unfinished call as completed neglect.
//
// Subject: every goal-plan-placement receipt in harness_shared.agent_activity for this workspace.
//   detail.goalPlacementTurn    = a CONFIRMED delivery (offered token ACKed, native completed decision after the offer)
//   detail.goalPlacementTurnEnd = the policy observed at a native turn end (status, applicableDemand, generation)
// Oracle: clause conditions re-checked against raw ledger rows (agent_activity, work_items, agent_fleets); nothing here
// calls the receipt module under test. A carry-respawn/cold restart/compaction starts a NEW native session under the
// same owner, so "survives the boundary" = confirmed chains for one owner+goal in >= 2 distinct native sessions.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

const WS = 'papercusp-workspace';
const COUNTEREXAMPLE = process.env.R3_COUNTEREXAMPLE ?? null;
if (COUNTEREXAMPLE !== null && COUNTEREXAMPLE !== 'count-not-applicable' && COUNTEREXAMPLE !== 'forged-owner') {
  throw new Error(`unknown R3_COUNTEREXAMPLE=${COUNTEREXAMPLE}; the counterexamples are count-not-applicable and forged-owner`);
}
const TURN_END_MAX_LAG_MS = 60_000;
const EFFECT_WINDOW_MS = 30 * 60_000;
const t = (s: unknown) => (typeof s === 'string' ? Date.parse(s) : Number.NaN);

const confirmedRaw = rows(`SELECT id, owner_id, session_id, created_at, detail->'goalPlacementTurn' AS r
  FROM harness_shared.agent_activity WHERE workspace_id = ${lit(WS)} AND detail ? 'goalPlacementTurn' ORDER BY created_at`);
const turnEnds = rows(`SELECT id, owner_id, session_id, created_at, detail->'goalPlacementTurnEnd' AS e
  FROM harness_shared.agent_activity WHERE workspace_id = ${lit(WS)} AND detail ? 'goalPlacementTurnEnd' ORDER BY created_at`);
observations.population = { confirmedReceipts: confirmedRaw.length, turnEndObservations: turnEnds.length,
  turnEndStatuses: turnEnds.flatMap((e) => (e.e?.rows ?? []).map((r: Row) => `${r.status}/${r.applicableDemand}`))
    .reduce((m: Record<string, number>, k: string) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {}) };

// The counterexample is the clause's falsifier: every turn-end row is promoted to a "delivered opportunity", including
// not-applicable / zero-demand ones that were never offered. A sound oracle must refuse it.
type Delivered = { source: string; owner: string; session: string; goalId: string | null; planSlug: string | null;
  obligationId: string; sourceGeneration: string; status: string | null; applicableDemand: number | null;
  offeredAt: string | null; completedAt: string | null; confirmedAt: string | null; completedTurnRef: string | null;
  nativeSessionId: string | null; receiptOwner: string | null; receiptWorkspace: string | null };
// The receipt carries no owner/workspace/session fields of its own: it names the completed turn as
// `<client>:<nativeSessionId>:<turnId>`. Resolve that session's owner and workspace independently of the receipt
// writer, from the identity-activation span recorded when the CLI launched. An unresolvable session stays null,
// which the falsifier below counts as foreign rather than trusting it.
const sessionOfTurnRef = (ref: string | null | undefined): string | null => ref?.split(':')[1] || null;
// D-037: two witnesses, neither written by the receipt module: (i) the activation span; (ii) the per-owner CLI
// config directory the transcript is written under (~/.papercusp/session-claude/<owner>/projects/*/<session>.jsonl).
// The receipt row's own owner is never a witness. A session resolves iff the witnesses that answer name exactly one
// owner; a conflict or no answer stays null, which the falsifier counts as foreign.
const CLAUDE_SESSIONS_ROOT = join(homedir(), '.papercusp', 'session-claude');
const transcriptOwners = (session: string): string[] => {
  if (!/^[0-9a-f-]{36}$/.test(session) || !existsSync(CLAUDE_SESSIONS_ROOT)) return [];
  const owners = new Set<string>();
  for (const owner of readdirSync(CLAUDE_SESSIONS_ROOT)) {
    const projects = join(CLAUDE_SESSIONS_ROOT, owner, 'projects');
    if (!existsSync(projects)) continue;
    for (const project of readdirSync(projects)) if (existsSync(join(projects, project, `${session}.jsonl`))) owners.add(owner);
  }
  return [...owners];
};
// D-040: the ingester stamps a Claude transcript's owner from the same ~/.papercusp/session-claude/<owner>/ path
// (session-ingest.ts FILE_ADAPTERS[claude].meta) and keeps it in session_turn_parts for 14 days, so a pruned host file
// does not erase witness (ii). Disk and ingested readings are one witness read at two times; if they disagree, the
// session names two owners and stays unresolved.
const ingestedTranscriptOwners = (session: string): string[] => (/^[0-9a-f-]{36}$/.test(session)
  ? rows(`SELECT DISTINCT owner FROM harness_shared.session_turn_parts
      WHERE workspace_id = 'default' AND source_kind = 'claude' AND session_id = ${lit(session)} AND owner IS NOT NULL`)
    .map((r) => r.owner as string)
  : []);
const identities = new Map<string, { owner: string | null; workspace: string | null }>();
const identityWitnesses: Record<string, { spans: string[]; transcript: string[]; transcriptDisk: string[];
  transcriptIngested: string[]; owner: string | null; workspace: string | null }> = {};
observations.identityWitnesses = identityWitnesses;
function identityOf(session: string | null): { owner: string | null; workspace: string | null } {
  if (!session) return { owner: null, workspace: null };
  if (!identities.has(session)) {
    const spans = rows(`SELECT DISTINCT owner_id, workspace_id FROM harness_shared.session_identity_activation_spans
      WHERE native_session_id = ${lit(session)}`);
    const transcriptDisk = transcriptOwners(session);
    const transcriptIngested = ingestedTranscriptOwners(session);
    const transcript = [...new Set([...transcriptDisk, ...transcriptIngested])];
    const owners = [...new Set([...spans.map((s) => s.owner_id as string), ...transcript])];
    const owner = owners.length === 1 ? owners[0] : null;
    // Workspace: the span's when one exists, else the single workspace across the resolved owner's activation events.
    const workspaces = spans.length > 0 ? [...new Set(spans.map((s) => s.workspace_id as string))]
      : owner ? rows(`SELECT DISTINCT workspace_id FROM harness_shared.session_identity_activation_events
          WHERE owner_id = ${lit(owner)}`).map((r) => r.workspace_id as string) : [];
    const workspace = owner && workspaces.length === 1 ? workspaces[0] : null;
    identityWitnesses[session] = { spans: spans.map((s) => `${s.owner_id}@${s.workspace_id}`), transcript, transcriptDisk,
      transcriptIngested, owner, workspace };
    identities.set(session, { owner, workspace });
  }
  return identities.get(session)!;
}
const delivered: Delivered[] =confirmedRaw.map((c) => ({ source: `activity:${c.id}`, owner: c.owner_id,
  session: c.session_id, goalId: c.r?.goalId ?? null, planSlug: c.r?.planSlug ?? null,
  obligationId: String(c.r?.obligationId ?? ''), sourceGeneration: String(c.r?.sourceGeneration ?? ''),
  status: c.r?.atConfirmation?.status ?? null, applicableDemand: null, offeredAt: c.r?.offeredAt ?? null,
  completedAt: c.r?.completedAt ?? null, confirmedAt: c.r?.confirmedAt ?? null,
  completedTurnRef: c.r?.completedTurnRef ?? null, nativeSessionId: sessionOfTurnRef(c.r?.completedTurnRef),
  receiptOwner: identityOf(sessionOfTurnRef(c.r?.completedTurnRef)).owner,
  receiptWorkspace: identityOf(sessionOfTurnRef(c.r?.completedTurnRef)).workspace }));
if (COUNTEREXAMPLE === 'count-not-applicable') {
  for (const e of turnEnds) for (const r of e.e?.rows ?? []) delivered.push({ source: `turnEnd:${e.id}`,
    owner: e.owner_id, session: e.session_id, goalId: e.e?.goalId ?? null, planSlug: r.planSlug ?? null,
    obligationId: String(r.obligationId ?? ''), sourceGeneration: String(r.sourceGeneration ?? ''), status: r.status,
    applicableDemand: r.applicableDemand, offeredAt: e.e?.completedAt ?? null, completedAt: e.e?.completedAt ?? null,
    confirmedAt: e.e?.observedAt ?? null, completedTurnRef: e.e?.completedTurnRef ?? null,
    nativeSessionId: e.session_id, receiptOwner: e.owner_id, receiptWorkspace: WS });
}
// D-037 falsifier for the identity witnesses: hand every confirmed delivery to a DIFFERENT owner. The witnesses read
// the session, not the row, so they still name the true owner and every delivered row must read foreign — including
// the transcript-only ones. If the witnesses echoed the row's owner, this counterexample would pass.
if (COUNTEREXAMPLE === 'forged-owner') {
  const owners = [...new Set(delivered.map((d) => d.owner))];
  for (const d of delivered) {
    d.owner = owners.length > 1 ? owners[(owners.indexOf(d.owner) + 1) % owners.length] : 'su-forged-counterexample';
  }
}

// 1. Nothing counted as delivered may be not-applicable, zero-demand, foreign-owner/workspace/session, or unordered.
const violations = delivered.flatMap((d) => {
  const why: string[] = [];
  if (d.status === 'not-applicable' || d.applicableDemand === 0) why.push('not-applicable/zero-demand');
  if (d.receiptOwner !== d.owner || d.receiptWorkspace !== WS) why.push('foreign owner/workspace');
  if (d.nativeSessionId !== d.session) why.push('foreign session');
  const o = t(d.offeredAt), c = t(d.completedAt), f = t(d.confirmedAt);
  if (!(o <= c && c <= f)) why.push('unfinished or unordered offer->completion->confirmation');
  if (!d.obligationId || !d.sourceGeneration || !d.goalId || !d.planSlug) why.push('missing identity');
  return why.length ? [{ source: d.source, why }] : [];
});
assert('r3-no-omitted-or-foreign-counted-as-delivered', violations.length === 0,
  violations.length === 0 ? `${delivered.length} delivered rows, none not-applicable/foreign/unordered`
    : `${violations.length}/${delivered.length} delivered rows violate the falsifier; first: ${JSON.stringify(violations.slice(0, 3))}`);

// 2. A complete chain: confirmed delivery -> same-turn turn-end decision -> effect on the delivered plan.
const clean = delivered.filter((d) => !violations.some((v) => v.source === d.source));
const chains = clean.map((d) => {
  const end = turnEnds.find((e) => e.owner_id === d.owner && e.session_id === d.session &&
    e.e?.completedTurnRef === d.completedTurnRef && t(e.e?.observedAt) >= t(d.completedAt) &&
    t(e.e?.observedAt) - t(d.completedAt) <= TURN_END_MAX_LAG_MS &&
    // The turn-end row is a fresh read taken after the turn, so its generation moves with any state change inside
    // the turn, including the agent's own action (measured 2026-09-30: delivery @91cbb1db, same-turn turn-end
    // @cd2b8393, while two warm reads 5s apart with no change were identical). The link from delivery to decision is
    // the shared completedTurnRef above; here the turn-end must speak about the plan that was delivered.
    (e.e?.rows ?? []).some((r: Row) => r.planSlug === d.planSlug));
  const from = new Date(t(d.completedAt)).toISOString(), to = new Date(t(d.completedAt) + EFFECT_WINDOW_MS).toISOString();
  // An effect must be attributable to the brief's recipient: the holder itself, or a fleet the holder launched for the
  // delivered plan (agent_fleets.owner / last_launch_transaction.launcherOwnerId) and that fleet's leader + members.
  // Work on the plan by an unrelated fleet's leaseholders is not caused by this brief (measured 2026-10-01: goal
  // 60d3a8's log-perf items were leased by nonp2p-feature-drain members, WI-10004479), so it is reported, not counted.
  // D-038: a fleet works the delivered plan iff its claim spec has a plan arm for it (the D-033 binding). Its slug is
  // not evidence: the holder named cache-efficiency-and-accounting's fleet cache-efficiency-accounting-fleet.
  const holder = lit(d.owner), planSlug = lit(d.planSlug ?? '');
  const holderFleets = `SELECT f.fleet_slug, f.leader_owner_id, f.last_launch_transaction AS tx, f.created_at
      FROM harness_shared.agent_fleets f WHERE f.workspace_id = ${lit(WS)}
        AND EXISTS (SELECT 1 FROM harness_shared.cup_claim_specs s WHERE s.workspace_id = f.workspace_id
          AND s.bee_id = 'fleet:' || f.fleet_slug
          AND jsonb_path_exists(s.spec, '$.view.filter.** ? (@.field == "plan" && @.value == $p)', jsonb_build_object('p', ${planSlug})))
        AND (f.owner = ${holder} OR f.last_launch_transaction->>'launcherOwnerId' = ${holder})`;
  const attributable = `(SELECT ${holder} UNION SELECT leader_owner_id FROM (${holderFleets}) hf WHERE leader_owner_id IS NOT NULL
      UNION SELECT jsonb_array_elements_text(coalesce(tx->'openedMemberIds', '[]'::jsonb)) FROM (${holderFleets}) hf)`;
  const worked = (owned: boolean) => `SELECT feature_id, h->>'owner' AS owner, h->>'at' AS at
      FROM harness_shared.work_items w, LATERAL jsonb_array_elements(coalesce(w.worked_by_history, '[]'::jsonb)) h
      WHERE w.workspace_id = ${lit(WS)} AND w.source_plan_slug = ${lit(d.planSlug ?? '')}
        AND (h->>'at')::timestamptz BETWEEN ${lit(from)} AND ${lit(to)}
        AND h->>'owner' ${owned ? 'IN' : 'NOT IN'} ${attributable}`;
  const effects = d.planSlug ? rows(`${worked(true)}
      UNION ALL SELECT fleet_slug, leader_owner_id, to_timestamp(created_at / 1000.0)::text FROM (${holderFleets}) hf
      WHERE to_timestamp(created_at / 1000.0) BETWEEN ${lit(from)} AND ${lit(to)} AND leader_owner_id IS NOT NULL`) : [];
  const foreignWork = d.planSlug ? rows(worked(false)) : [];
  return { source: d.source, owner: d.owner, session: d.session, goalId: d.goalId, planSlug: d.planSlug,
    obligation: `${d.obligationId}@${d.sourceGeneration}`, turnEnd: end ? `activity:${end.id}` : null,
    effects: effects.slice(0, 5), foreignWorkNotCounted: foreignWork.slice(0, 5) };
});
observations.chains = chains;
const complete = chains.filter((c) => c.turnEnd && c.effects.length > 0);
assert('r3-generation-to-effect-chain-exists', complete.length > 0,
  complete.length > 0 ? `${complete.length} confirmed delivery->same-turn turn-end->effect chains: ${complete.map((c) => c.source).join(', ')}`
    : `0 complete chains (${clean.length} clean confirmed deliveries, ${chains.filter((c) => c.turnEnd).length} with a matching turn-end)`);

// 3. The chain survives a boundary: one owner+goal has complete chains in >= 2 distinct native sessions.
const byGoal = new Map<string, Set<string>>();
for (const c of complete) byGoal.set(`${c.owner}|${c.goalId}`, (byGoal.get(`${c.owner}|${c.goalId}`) ?? new Set()).add(c.session));
const crossing = [...byGoal].filter(([, s]) => s.size >= 2);
assert('r3-chain-survives-session-boundary', crossing.length > 0,
  crossing.length > 0 ? `owner|goal spanning >=2 native sessions: ${crossing.map(([k, s]) => `${k} (${s.size})`).join('; ')}`
    : `no owner+goal has complete chains in two native sessions (${byGoal.size} owner+goal groups)`);

residualUnknowns.push('Non-omission of the delivered line is attested by the writer (the receipt is staged only when the rendered block contains the action line); injected briefs are not ingested into session_turn_parts, so it is not independently re-observable here.');
residualUnknowns.push('Compaction vs cold restart is not distinguished: both start a new native session under the same owner; memory_session_epochs keeps only the latest epoch per session.');
residualUnknowns.push('Fleet-leader side: fleet:leader-brief tool_invocations carry no generation/receipt, so the leader half of the shared engine is covered by unit/integration layers (bindings 15943/15944), not by this live probe.');
// su-4f968faa review of D-037 (2026-10-01): the two witnesses corroborate but are not fully independent.
residualUnknowns.push('The span and transcript witnesses both derive from the launch-time identity (PAPERCUSP_SID names the per-owner session-claude dir and the activation span), so neither can catch a launcher that assigned the wrong identity. Transcript-only rows rest on the host transcript file or its ingested copy (D-040; session_turn_parts keeps 14 days); a session pruned from both falls back to foreign.');
const transcriptOnlySessions = Object.entries(identityWitnesses).filter(([, w]) => w.spans.length === 0 && w.transcript.length > 0).map(([s]) => s);

// R3_CENSORED_BY=D-042 (goal-brief D-042, su-cf569f3f ruling 2026-10-02): P3 is closed as BOUNDED evidence
// because natural holder relaunches mint a new ownerId, so its precondition never occurs. Under this flag a
// FAILED P3 is reported verbatim (passed:false) plus censored:true and is excluded from the exit gate only.
// It never turns P3 into a pass, never applies to a counterexample run, and is stamped into command + summary.
const CENSORED_BY = process.env.R3_CENSORED_BY ?? null;
if (CENSORED_BY !== null && CENSORED_BY !== 'D-042') throw new Error(`unknown R3_CENSORED_BY=${CENSORED_BY}; only D-042 is recorded`);
if (CENSORED_BY !== null && COUNTEREXAMPLE !== null) throw new Error('R3_CENSORED_BY cannot be combined with a counterexample run');
const CENSORABLE = new Set(['r3-chain-survives-session-boundary']);
for (const a of assertions as Array<Record<string, any>>) {
  if (CENSORED_BY && CENSORABLE.has(a.id) && !a.passed) {
    a.censored = true;
    a.censoredBy = `goal-brief-to-claimed-plan-work-2026-09-23#${CENSORED_BY}`;
  }
}
const gated = (assertions as Array<Record<string, any>>).filter((a) => !a.censored);
const passed = assertions.filter((a) => a.passed).length;
const gatedPassed = gated.filter((a) => a.passed).length;
const censoredIds = (assertions as Array<Record<string, any>>).filter((a) => a.censored).map((a) => a.id);
if (censoredIds.length > 0) residualUnknowns.push(`CENSORED (${CENSORED_BY}): ${censoredIds.join(', ')} failed and is excluded from the exit gate as bounded evidence. Cross-session continuity of one owner's chain is UNOBSERVED, not proven.`);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1, kind: 'operational-test-evidence',
  name: COUNTEREXAMPLE ? `goal-brief R-3 live chain probe — counterexample ${COUNTEREXAMPLE}` : 'goal-brief R-3 live chain probe',
  framework: 'operational', // testing:record-run accepts playwright|node|shell|cargo|operational; this is a read-only SQL probe
  command: [...(COUNTEREXAMPLE ? ['env', `R3_COUNTEREXAMPLE=${COUNTEREXAMPLE}`] : []),
    ...(CENSORED_BY ? ['env', `R3_CENSORED_BY=${CENSORED_BY}`] : []),
    'npx', 'tsx', 'docs/evidence/goal-brief-r3-live-probe-2026-09-29.mts'],
  exitCode: gatedPassed === gated.length ? 0 : 1, startedAt, finishedAt: new Date().toISOString(),
  summary: `${passed}/${assertions.length} assertions passed${censoredIds.length ? `; ${censoredIds.length} censored per ${CENSORED_BY} (${censoredIds.join(', ')}), gate ${gatedPassed}/${gated.length}` : ''}; ${transcriptOnlySessions.length} of ${Object.keys(identityWitnesses).length} sessions resolved by the transcript witness alone`,
  // testing:record-run derives its verdict from EVERY entry in `assertions`, so a censored assertion is moved
  // out of that list into `censoredAssertions` (verbatim, passed:false) rather than relabelled. The ledger
  // verdict therefore covers exactly the gated assertions, and the censored one stays visible beside it.
  assertions: gated,
  ...(censoredIds.length ? { censoredAssertions: (assertions as Array<Record<string, any>>).filter((a) => a.censored) } : {}),
  plan: { slug: 'goal-brief-to-claimed-plan-work-2026-09-23', specIds: ['AUTO-BAR-R-3-P-004', 'AUTO-BAR-R-3-P-007'], specRevision: 4 },
  residualUnknowns, observations,
}, null, 2)}\n`);
process.exitCode = gatedPassed === gated.length ? 0 : 1;

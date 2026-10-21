/**
 * Plan-run executor recruiter (WI-6554700010019116).
 *
 * A plan run whose execution target names a stable agent (for example the bug-triage pack's
 * `agentName: 'bug-triage'`) assigns its actionable items to that NAME and wakes whichever
 * session has adopted it (plan-run-action.ts -> assignAndWakeActionableWorkItems). When no live
 * session has adopted the name, the wake reaches nobody and the run waits forever: measured
 * 2026-10-21, plan run 1355 sat open until a supervisor hand-launched an executor.
 *
 * This sweep closes that gap the same way the admission recruiter (D-058,
 * work-admission/repair-recruiter.ts) closed it for review and repair: once an item has waited
 * past the SLO with no live adopter, launch one headless agent that adopts the name and works
 * the run's items. Opt-in is the binding's declared execution target itself: a binding that names
 * an executor agent has asked for that agent to run the work. Bounded per run (2 attempts, then a
 * condition escalation) and per pass (2 launches). Idempotent through the task_ledger label, which
 * is also the launch idempotency key.
 */

export const PLAN_RUN_RECRUIT_ACTOR = 'system:plan-run-recruiter';
export const PLAN_RUN_RECRUIT_LABEL_PREFIX = 'plan-run-recruit:';
/** Dispatch wakes a live adopter at mint time, so a few minutes without one means none exists. */
export const PLAN_RUN_RECRUIT_SLO_MS = 3 * 60_000;
/** A recruited agent older than this no longer counts as in flight. */
export const PLAN_RUN_RECRUIT_STALE_MS = 3 * 60 * 60_000;
export const PLAN_RUN_RECRUIT_MAX_ATTEMPTS = 2;
export const PLAN_RUN_RECRUIT_MAX_LAUNCHES_PER_PASS = 2;

/** Presence states that mean an adopter can still take the work (suspect is often a carry-respawn). */
const ADOPTER_LIVE_STATES = new Set(['live', 'parked', 'draining', 'suspect']);

export interface PlanRunRecruitCandidate {
  workspaceId: string;
  runId: string;
  instanceSlug: string;
  /** The app harness that owns the run's items (execution.appHarnessSlug). */
  harnessSlug: string;
  agentName: string;
  workItemIds: string[];
  /** Earliest created_ts (epoch ms) of the run's open items assigned to the name. */
  mintedAtMs: number | null;
  adopterLive: boolean;
}

export interface PlanRunRecruitLaunchRecord {
  label: string;
  startedAtMs: number;
  live: boolean;
}

export type PlanRunRecruitAction = 'none' | 'wait' | 'in-flight' | 'launch' | 'escalate';

export interface PlanRunRecruitDecision {
  workspaceId: string;
  runId: string;
  agentName: string;
  harnessSlug: string;
  action: PlanRunRecruitAction;
  reason: string;
  waitedMs: number | null;
  attempts: number;
  key?: string;
}

export function planRunRecruitLabel(agentName: string, runId: string, attempt: number): string {
  return `${PLAN_RUN_RECRUIT_LABEL_PREFIX}${agentName}:${runId}:${attempt}`;
}

/** Parse a recruit label (agent names may not contain ':', but parse from the right regardless). */
export function parsePlanRunRecruitLabel(
  label: string | null | undefined,
): { agentName: string; runId: string; attempt: number } | null {
  if (typeof label !== 'string' || !label.startsWith(PLAN_RUN_RECRUIT_LABEL_PREFIX)) return null;
  const parts = label.slice(PLAN_RUN_RECRUIT_LABEL_PREFIX.length).split(':');
  if (parts.length < 3) return null;
  const attempt = Number(parts[parts.length - 1]);
  const runId = parts[parts.length - 2];
  const agentName = parts.slice(0, -2).join(':');
  if (!agentName || !runId || !Number.isFinite(attempt) || attempt < 1) return null;
  return { agentName, runId, attempt: Math.floor(attempt) };
}

export function planRunRecruitExhaustedConditionKey(runId: string, agentName: string): string {
  return `plan-run-recruit-exhausted:${runId}:${agentName}`;
}

/**
 * Pure: what to do for each candidate. Launches beyond `maxLaunches` are demoted to `wait`
 * (reason `launch-cap`), longest-waiting first, so a burst of runs cannot spawn a crowd.
 */
export function planPlanRunExecutorRecruitment(
  candidates: readonly PlanRunRecruitCandidate[],
  launches: readonly PlanRunRecruitLaunchRecord[],
  nowMs: number,
  opts: { maxLaunches?: number } = {},
): PlanRunRecruitDecision[] {
  const maxLaunches = Math.max(0, opts.maxLaunches ?? PLAN_RUN_RECRUIT_MAX_LAUNCHES_PER_PASS);
  const parsed = launches
    .map((l) => ({ l, p: parsePlanRunRecruitLabel(l.label) }))
    .filter((x): x is { l: PlanRunRecruitLaunchRecord; p: NonNullable<ReturnType<typeof parsePlanRunRecruitLabel>> } =>
      x.p !== null,
    );
  const decisions: PlanRunRecruitDecision[] = [];
  for (const c of candidates) {
    const waitedMs = c.mintedAtMs === null ? null : Math.max(0, nowMs - c.mintedAtMs);
    const mine = parsed.filter((x) => x.p.runId === c.runId && x.p.agentName === c.agentName);
    const attempts = mine.length;
    const base = {
      workspaceId: c.workspaceId,
      runId: c.runId,
      agentName: c.agentName,
      harnessSlug: c.harnessSlug,
      waitedMs,
      attempts,
    };
    if (c.workItemIds.length === 0) {
      decisions.push({ ...base, action: 'none', reason: 'no-open-items' });
      continue;
    }
    if (c.adopterLive) {
      decisions.push({ ...base, action: 'none', reason: 'adopter-live' });
      continue;
    }
    if (mine.some((x) => x.l.live && x.l.startedAtMs > nowMs - PLAN_RUN_RECRUIT_STALE_MS)) {
      decisions.push({ ...base, action: 'in-flight', reason: 'recruited-agent-live' });
      continue;
    }
    if (attempts >= PLAN_RUN_RECRUIT_MAX_ATTEMPTS) {
      decisions.push({
        ...base,
        action: 'escalate',
        reason: 'attempts-exhausted',
        key: planRunRecruitExhaustedConditionKey(c.runId, c.agentName),
      });
      continue;
    }
    if (waitedMs === null || waitedMs < PLAN_RUN_RECRUIT_SLO_MS) {
      decisions.push({ ...base, action: 'wait', reason: waitedMs === null ? 'wait-start-unknown' : 'within-slo' });
      continue;
    }
    decisions.push({
      ...base,
      action: 'launch',
      reason: 'past-slo',
      key: planRunRecruitLabel(c.agentName, c.runId, attempts + 1),
    });
  }
  const launchIdx = decisions
    .map((d, i) => ({ d, i }))
    .filter((x) => x.d.action === 'launch')
    .sort((a, b) => (b.d.waitedMs ?? 0) - (a.d.waitedMs ?? 0));
  for (const { i } of launchIdx.slice(maxLaunches)) {
    decisions[i] = { ...decisions[i], action: 'wait', reason: 'launch-cap' };
  }
  return decisions;
}

/** The recruited executor's one-job brief (its first turn). */
export function buildPlanRunExecutorBrief(input: {
  agentName: string;
  runId: string;
  instanceSlug: string;
  harnessSlug: string;
  workItemIds: readonly string[];
}): string {
  const ids = input.workItemIds.join(', ');
  return [
    `You are the '${input.agentName}' executor for plan run ${input.instanceSlug} (run ${input.runId}, harness ${input.harnessSlug}).`,
    `${PLAN_RUN_RECRUIT_ACTOR} launched you because the run assigned work to '${input.agentName}' and no live agent had adopted that name.`,
    '',
    `1. Run plan_items:adopt_name { name: '${input.agentName}' } first, so later wakes for this name reach you.`,
    `2. Work the run's items assigned to that name: ${ids}. Read each with work_items:get { id, harness: '${input.harnessSlug}' } and follow its instructions and the instance plan ${input.instanceSlug}.`,
    '3. Close each item with work_items:complete and real evidence. If you cannot finish one, record why with work_items:set_blocker instead of leaving it silent.',
    '4. Do only this run. Stop when its items are terminal.',
  ].join('\n');
}

export interface PlanRunRecruiterDeps {
  listCandidates(): Promise<PlanRunRecruitCandidate[]>;
  listLaunches(workspaceId: string): Promise<PlanRunRecruitLaunchRecord[]>;
  launch(input: {
    workspaceId: string;
    harnessSlug: string;
    key: string;
    brief: string;
  }): Promise<{ ok: boolean; deduped?: boolean; error?: string }>;
  escalate(input: {
    workspaceId: string;
    harnessSlug: string;
    key: string;
    title: string;
    body: string;
  }): Promise<{ id: string; created: boolean }>;
}

export interface PlanRunRecruiterResult {
  candidates: number;
  launched: Array<{ runId: string; agentName: string; key: string; deduped: boolean }>;
  escalated: Array<{ runId: string; agentName: string; key: string; id: string; created: boolean }>;
  failed: Array<{ runId: string; agentName: string; stage: 'launch' | 'escalate' | 'list'; error: string }>;
  decisions: PlanRunRecruitDecision[];
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One pass over every workspace's running plan runs. Per-run failures are recorded, never thrown. */
export async function runPlanRunExecutorRecruiter(
  input: { nowMs?: number; maxLaunches?: number },
  deps: PlanRunRecruiterDeps,
): Promise<PlanRunRecruiterResult> {
  const nowMs = input.nowMs ?? Date.now();
  const candidates = await deps.listCandidates();
  const result: PlanRunRecruiterResult = { candidates: candidates.length, launched: [], escalated: [], failed: [], decisions: [] };
  // Only a candidate that could launch needs the ledger read.
  const workspaces = [...new Set(candidates.filter((c) => !c.adopterLive && c.workItemIds.length > 0).map((c) => c.workspaceId))];
  const launches: PlanRunRecruitLaunchRecord[] = [];
  for (const ws of workspaces) {
    try {
      launches.push(...(await deps.listLaunches(ws)));
    } catch (e) {
      // Without the ledger the pass cannot prove idempotency: skip this workspace's launches.
      for (const c of candidates.filter((x) => x.workspaceId === ws)) {
        result.failed.push({ runId: c.runId, agentName: c.agentName, stage: 'list', error: errText(e) });
      }
    }
  }
  const unreadable = new Set(result.failed.map((f) => f.runId));
  const decisions = planPlanRunExecutorRecruitment(
    candidates.filter((c) => !unreadable.has(c.runId)),
    launches,
    nowMs,
    { maxLaunches: input.maxLaunches },
  );
  result.decisions = decisions;
  const byRun = new Map(candidates.map((c) => [`${c.runId}\u0000${c.agentName}`, c]));
  for (const d of decisions) {
    const c = byRun.get(`${d.runId}\u0000${d.agentName}`);
    if (d.action === 'launch' && d.key && c) {
      try {
        const res = await deps.launch({
          workspaceId: d.workspaceId,
          harnessSlug: d.harnessSlug,
          key: d.key,
          brief: buildPlanRunExecutorBrief({
            agentName: d.agentName,
            runId: d.runId,
            instanceSlug: c.instanceSlug,
            harnessSlug: d.harnessSlug,
            workItemIds: c.workItemIds,
          }),
        });
        if (res.ok) result.launched.push({ runId: d.runId, agentName: d.agentName, key: d.key, deduped: res.deduped === true });
        else result.failed.push({ runId: d.runId, agentName: d.agentName, stage: 'launch', error: res.error ?? 'launch refused' });
      } catch (e) {
        result.failed.push({ runId: d.runId, agentName: d.agentName, stage: 'launch', error: errText(e) });
      }
    } else if (d.action === 'escalate' && d.key) {
      try {
        const res = await deps.escalate({
          workspaceId: d.workspaceId,
          harnessSlug: d.harnessSlug,
          key: d.key,
          title: `Plan run ${c?.instanceSlug ?? d.runId}: no '${d.agentName}' executor after ${d.attempts} recruit attempt(s)`,
          body:
            `Plan run ${d.runId} assigned ${c?.workItemIds.join(', ') ?? 'its items'} to the agent name '${d.agentName}'. ` +
            `No live session has adopted that name, and ${d.attempts} recruited executor(s) ended without finishing the items. ` +
            `Find out why the recruited agents stopped (task_ledger labels ${PLAN_RUN_RECRUIT_LABEL_PREFIX}${d.agentName}:${d.runId}:*), ` +
            `then launch an agent that runs plan_items:adopt_name { name: '${d.agentName}' }, or cancel the run.`,
        });
        result.escalated.push({ runId: d.runId, agentName: d.agentName, key: d.key, id: res.id, created: res.created });
      } catch (e) {
        result.failed.push({ runId: d.runId, agentName: d.agentName, stage: 'escalate', error: errText(e) });
      }
    }
  }
  return result;
}

/** Production deps: lazily imported so this module and its tests never load PG or the launch door. */
export const defaultPlanRunRecruiterDeps: PlanRunRecruiterDeps = {
  async listCandidates() {
    const [{ getOrgPg }, { resolveStableAgentTarget }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../agent-tools/coordination/actionable-work-item-dispatch'),
    ]);
    const { sql } = getOrgPg();
    // Driven from RUNNING plan runs (a small set); an item belongs to its run through
    // payload.plan_run.runId, and is stranded when it is still assigned to the run's
    // declared executor name.
    const rows = await sql<
      Array<{
        workspace_id: string;
        run_id: string;
        instance_slug: string | null;
        harness_slug: string;
        agent_name: string;
        feature_id: string;
        created_ts: string | number | null;
      }>
    >`
      SELECT pr.workspace_id, pr.id::text AS run_id,
             COALESCE(w.payload->'plan_run'->>'instancePlanSlug', pr.instance_plan_slug) AS instance_slug,
             w.harness_slug, w.taken_by AS agent_name, w.feature_id, w.created_ts
        FROM harness_shared.plan_runs pr
        JOIN harness_shared.work_items w
          ON w.workspace_id = pr.workspace_id
         AND w.source_plan_slug = pr.plan_slug
         AND (w.payload->'plan_run'->>'runId') = pr.id::text
       WHERE pr.status = 'running'
         AND w.closed_ts IS NULL
         AND w.lane IS DISTINCT FROM 'observation'
         AND w.taken_by IS NOT NULL
         AND w.taken_by = w.payload->'plan_run'->'execution'->>'agentName'
       ORDER BY pr.id
       LIMIT 200`;
    const grouped = new Map<string, PlanRunRecruitCandidate>();
    for (const r of rows) {
      const k = `${r.workspace_id}\u0000${r.run_id}\u0000${r.agent_name}`;
      const created = r.created_ts == null ? NaN : Number(r.created_ts);
      const g = grouped.get(k) ?? {
        workspaceId: r.workspace_id,
        runId: r.run_id,
        instanceSlug: r.instance_slug ?? `run ${r.run_id}`,
        harnessSlug: r.harness_slug,
        agentName: r.agent_name,
        workItemIds: [],
        mintedAtMs: null,
        adopterLive: false,
      };
      g.workItemIds.push(r.feature_id);
      if (Number.isFinite(created)) g.mintedAtMs = g.mintedAtMs === null ? created : Math.min(g.mintedAtMs, created);
      grouped.set(k, g);
    }
    const out = [...grouped.values()];
    for (const c of out) {
      const target = await resolveStableAgentTarget({
        targetAgent: c.agentName,
        workspaceId: c.workspaceId,
        harness: c.harnessSlug,
      });
      c.adopterLive = target.present === true && ADOPTER_LIVE_STATES.has(String(target.sessionState));
    }
    return out;
  },
  async listLaunches(workspaceId) {
    const { listTasks } = await import('../../task-manager/store');
    const rows = await listTasks({
      workspaceId,
      launchedBy: PLAN_RUN_RECRUIT_ACTOR,
      labelPrefix: PLAN_RUN_RECRUIT_LABEL_PREFIX,
      includeEnded: true,
      limit: 500,
    });
    const out: PlanRunRecruitLaunchRecord[] = [];
    for (const r of rows) {
      const label = (r.detail as { label?: unknown } | null)?.label;
      const startedAtMs = r.startedAt ? new Date(r.startedAt).getTime() : NaN;
      if (typeof label !== 'string' || !Number.isFinite(startedAtMs)) continue;
      out.push({ label, startedAtMs, live: r.endedAt == null });
    }
    return out;
  },
  async launch(input) {
    const { launchRecruitedAgent } = await import('../../work-admission/repair-recruiter');
    return launchRecruitedAgent({ ...input, actor: PLAN_RUN_RECRUIT_ACTOR, actorLabel: 'plan-run recruiter' });
  },
  async escalate(input) {
    const { upsertConditionWorkItem } = await import('../../coord/condition-upsert');
    const res = await upsertConditionWorkItem(input.key, {
      kind: 'task',
      title: input.title,
      summary: input.body,
      severity: 'major',
      createdBy: PLAN_RUN_RECRUIT_ACTOR,
      harness: input.harnessSlug,
      workspaceId: input.workspaceId,
    } as never);
    return { id: String(res.id), created: res.created };
  },
};

/**
 * repair-recruiter.ts — the platform recruits the agents that move rule-admitted bugs from
 * "reported" to "fixed" (WI-6554700010018302; plan slack-asana-reproduced-bug-fix-pr-workflow-
 * 2026-10-08 D-057 / D-058).
 *
 * THE GAP. A bug report admitted by a rule (Slack → Asana → admission, or a ticket created
 * directly in Asana) enters agent review round 1 as `pending`. Review is pull-only
 * (scheduler/reviewable-miss.ts routes IDLE claimers of the same harness), and the claim floor
 * keeps a pending row away from implementers (agent-review-policy.ts). So a pot with an enabled
 * admission rule but no resident agents strands every report at review=pending, and a reviewed
 * bug nobody claims sits open forever. Measured 2026-10-20/21: BD004 and BD011 on the
 * slack-asana-bug-drill pot moved only because the supervising agent launched a reviewer and an
 * implementer by hand, which the PILOT acceptance spec counts as a failure (D-057).
 *
 * WHAT THIS DOES, once per source sync (connector-runtime `afterSourceSynced`, after the
 * lifecycle write-back pass, so no new poller or routine):
 *   - for each item admitted from that source, pick the leg it is waiting on:
 *       review — agent review round R is `pending`;
 *       repair — a bug whose review is approved (or absent), still `open`, nobody holds it;
 *   - rule lifecycle `recruit: true` (per-rule opt-in, default OFF): once the leg has waited
 *     past its SLO and no recruited agent for that leg + epoch is live, launch ONE headless,
 *     independent agent through capability:launch-agent with a one-job brief. Launches are
 *     idempotency-keyed by `admission-recruit:<leg>:<item>:<epoch>:<attempt>`, capped per pass,
 *     and stop after {@link ADMISSION_RECRUIT_MAX_ATTEMPTS} per leg + epoch;
 *   - when attempts are exhausted, or (recruit off) the leg has been stranded for
 *     {@link ADMISSION_STRANDED_SLO_MS}, raise ONE condition-keyed work-item so a stranded
 *     report always has an owner. That is the detector half and the recurrence guard.
 *
 * WHAT THIS MAY NEVER DO: grade a review, approve a report, claim or close work, or touch the
 * source system. The launched agents do those through the ordinary tools and gates
 * (improvements:agent-review + blender:grade-idea for review; work_items:claim / complete for
 * repair), so independence and evidence rules are enforced where they always are.
 *
 * Every read and the launch go through {@link AdmissionRecruiterDeps}; the unit tests drive the
 * whole decision with no Postgres and no process spawn.
 */

export const ADMISSION_RECRUIT_ACTOR = 'system:admission-recruiter';
/** Label + idempotency prefix: `admission-recruit:<leg>:<workItemId>:<epoch>:<attempt>`. */
export const ADMISSION_RECRUIT_LABEL_PREFIX = 'admission-recruit:';
/** A pending review round waits this long for a natural reviewer before one is recruited. */
export const ADMISSION_RECRUIT_REVIEW_SLO_MS = 10 * 60_000;
/** A reviewed, unclaimed bug waits this long for a natural implementer before one is recruited. */
export const ADMISSION_RECRUIT_REPAIR_SLO_MS = 10 * 60_000;
/** A live recruited agent older than this no longer blocks the next attempt (a repair is ~1h). */
export const ADMISSION_RECRUIT_STALE_MS = 3 * 60 * 60_000;
/** Recruited launches per leg + epoch before the pass stops launching and raises an owner. */
export const ADMISSION_RECRUIT_MAX_ATTEMPTS = 2;
/** With recruit OFF, a leg waiting this long raises a stranded-work condition item. */
export const ADMISSION_STRANDED_SLO_MS = 2 * 60 * 60_000;
/** Launches one pass may make across all items of a source. */
export const ADMISSION_RECRUIT_MAX_LAUNCHES_PER_PASS = 2;

const TERMINAL_STATES = new Set(['done', 'dropped', 'resolved', 'closed', 'cancelled', 'canceled', 'wontfix', 'duplicate']);

export type RecruitLeg = 'review' | 'repair';

/** One admitted work item as the pass sees it. */
export interface RecruitCandidate {
  workItemId: string;
  harnessSlug: string;
  kind: string;
  status: string;
  assignee: string | null;
  payload: unknown;
  title: string | null;
  /** The work_items.admission column ('pending' while admission dedup has not run). */
  admission: string | null;
  createdAtMs: number | null;
  /** The admitting rule's lifecycle.recruit switch (rule enabled AND recruit true). */
  recruit: boolean;
}

/** One recruited launch as the task ledger records it. */
export interface RecruitLaunchRecord {
  label: string;
  startedAtMs: number;
  /** The task has not ended. */
  live: boolean;
}

export interface RecruitLeg_Wait {
  leg: RecruitLeg;
  /** Distinguishes review rounds (`r<round>`) and a repair after a given approval (`a<round>`). */
  epoch: string;
  /** When the leg started waiting; null when unknown (treated as not yet due). */
  sinceMs: number | null;
}

export type RecruitAction = 'none' | 'wait' | 'in-flight' | 'launch' | 'escalate';

export interface RecruitDecision {
  workItemId: string;
  harnessSlug: string;
  action: RecruitAction;
  reason: string;
  leg?: RecruitLeg;
  epoch?: string;
  waitedMs?: number | null;
  attempts?: number;
  /** For `launch`: the label/idempotency key. For `escalate`: the condition key. */
  key?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The leg an admitted item is waiting on, or null when nothing recruitable is owed (terminal,
 * held for admission dedup, sent back to its submitter, already held by someone, not a bug).
 */
export function recruitLegFor(c: RecruitCandidate): RecruitLeg_Wait | { leg: null; reason: string } {
  if (TERMINAL_STATES.has(c.status)) return { leg: null, reason: 'terminal' };
  const review = record(record(c.payload).agentReview);
  const status = typeof review.status === 'string' ? review.status : null;
  const round = Number.isFinite(Number(review.round)) && Number(review.round) > 0 ? Math.floor(Number(review.round)) : 1;
  const timing = record(review.timing);
  const timingCurrent = Number(timing.round) === round;
  // The review leg is decided BEFORE the admission-pending skip. The admission promoter holds a
  // row at admission='pending' WHILE its agent review is pending (work-items-admission-promoter.ts
  // otherGuardBlocked / 'review-gated'), so skipping pending admission here first meant an
  // admission-rule bug report never got a reviewer and never left pending: a deadlock
  // (WI-6554700010018302, measured on BD016 EI-26578049744916274 2026-10-21 08:58Z).
  if (status === 'pending') {
    const entered = timingCurrent ? isoMs(timing.enteredAt) : null;
    return { leg: 'review', epoch: `r${round}`, sinceMs: entered ?? c.createdAtMs };
  }
  // The repair leg still waits for admission: an implementer cannot claim a pending-admission row.
  if (c.admission === 'pending') return { leg: null, reason: 'awaiting-admission-dedup' };
  if (status === 'revision-requested') return { leg: null, reason: 'revision-requested' };
  if (c.kind !== 'bug') return { leg: null, reason: 'not-a-bug' };
  if (c.status !== 'open') return { leg: null, reason: `state-${c.status}` };
  if (c.assignee && c.assignee.trim() && c.assignee.trim().toLowerCase() !== 'unassigned') {
    return { leg: null, reason: 'held' };
  }
  const readiness = record(record(c.payload).implementationReadiness);
  if (readiness.status === 'not-ready') return { leg: null, reason: 'implementation-not-ready' };
  if (status === 'approved') {
    const decided = timingCurrent ? isoMs(timing.decidedAt) : null;
    return { leg: 'repair', epoch: `a${round}`, sinceMs: decided ?? c.createdAtMs };
  }
  return { leg: 'repair', epoch: 'a0', sinceMs: c.createdAtMs };
}

export function recruitLabel(leg: RecruitLeg, workItemId: string, epoch: string, attempt: number): string {
  return `${ADMISSION_RECRUIT_LABEL_PREFIX}${leg}:${workItemId}:${epoch}:${attempt}`;
}

/** Parse a recruit label; null for any other label. */
export function parseRecruitLabel(
  label: string | null | undefined,
): { leg: RecruitLeg; workItemId: string; epoch: string; attempt: number } | null {
  if (typeof label !== 'string' || !label.startsWith(ADMISSION_RECRUIT_LABEL_PREFIX)) return null;
  const [leg, workItemId, epoch, attempt] = label.slice(ADMISSION_RECRUIT_LABEL_PREFIX.length).split(':');
  if ((leg !== 'review' && leg !== 'repair') || !workItemId || !epoch) return null;
  const n = Number(attempt);
  return { leg, workItemId, epoch, attempt: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1 };
}

export function recruitExhaustedConditionKey(workItemId: string, leg: RecruitLeg, epoch: string): string {
  return `admission-recruit-exhausted:${workItemId}:${leg}:${epoch}`;
}

export function admissionStrandedConditionKey(workItemId: string, leg: RecruitLeg, epoch: string): string {
  return `admission-stranded:${workItemId}:${leg}:${epoch}`;
}

/**
 * Pure: what to do for each candidate. Launch decisions beyond `maxLaunches` are demoted to
 * `wait` with reason `launch-cap`, oldest-waiting first, so one busy source cannot spawn a crowd.
 */
export function planAdmissionRecruitment(
  candidates: readonly RecruitCandidate[],
  launches: readonly RecruitLaunchRecord[],
  nowMs: number,
  opts: { maxLaunches?: number } = {},
): RecruitDecision[] {
  const maxLaunches = Math.max(0, opts.maxLaunches ?? ADMISSION_RECRUIT_MAX_LAUNCHES_PER_PASS);
  const parsed = launches
    .map((l) => ({ l, p: parseRecruitLabel(l.label) }))
    .filter((x): x is { l: RecruitLaunchRecord; p: NonNullable<ReturnType<typeof parseRecruitLabel>> } => x.p !== null);
  const decisions: RecruitDecision[] = [];
  for (const c of candidates) {
    const base = { workItemId: c.workItemId, harnessSlug: c.harnessSlug };
    const wait = recruitLegFor(c);
    if (wait.leg === null) {
      decisions.push({ ...base, action: 'none', reason: (wait as { reason: string }).reason });
      continue;
    }
    const { leg, epoch, sinceMs } = wait as RecruitLeg_Wait;
    const waitedMs = sinceMs === null ? null : Math.max(0, nowMs - sinceMs);
    const mine = parsed.filter((x) => x.p.workItemId === c.workItemId && x.p.leg === leg && x.p.epoch === epoch);
    const attempts = mine.length;
    const legBase = { ...base, leg, epoch, waitedMs, attempts };
    if (!c.recruit) {
      if (waitedMs !== null && waitedMs >= ADMISSION_STRANDED_SLO_MS) {
        decisions.push({
          ...legBase,
          action: 'escalate',
          reason: 'stranded-recruit-off',
          key: admissionStrandedConditionKey(c.workItemId, leg, epoch),
        });
      } else {
        decisions.push({ ...legBase, action: 'wait', reason: 'recruit-off' });
      }
      continue;
    }
    if (mine.some((x) => x.l.live && x.l.startedAtMs > nowMs - ADMISSION_RECRUIT_STALE_MS)) {
      decisions.push({ ...legBase, action: 'in-flight', reason: 'recruited-agent-live' });
      continue;
    }
    if (attempts >= ADMISSION_RECRUIT_MAX_ATTEMPTS) {
      decisions.push({
        ...legBase,
        action: 'escalate',
        reason: 'attempts-exhausted',
        key: recruitExhaustedConditionKey(c.workItemId, leg, epoch),
      });
      continue;
    }
    const slo = leg === 'review' ? ADMISSION_RECRUIT_REVIEW_SLO_MS : ADMISSION_RECRUIT_REPAIR_SLO_MS;
    if (waitedMs === null || waitedMs < slo) {
      decisions.push({ ...legBase, action: 'wait', reason: waitedMs === null ? 'wait-start-unknown' : 'within-slo' });
      continue;
    }
    decisions.push({
      ...legBase,
      action: 'launch',
      reason: 'past-slo',
      key: recruitLabel(leg, c.workItemId, epoch, attempts + 1),
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

/** The reviewer's one-job brief (its first turn). */
export function buildAdmissionReviewBrief(input: {
  workItemId: string;
  harnessSlug: string;
  title: string | null;
  epoch: string;
}): string {
  const { workItemId, harnessSlug, title, epoch } = input;
  return [
    `You are an INDEPENDENT reviewer recruited by ${ADMISSION_RECRUIT_ACTOR} (WI-6554700010018302) for one`,
    `bug report admitted by a rule into harness '${harnessSlug}': ${workItemId}${title ? ` — "${title}"` : ''}.`,
    `Its agent review (round ${epoch.replace(/^r/, '')}) has been pending past its SLO with no reviewer.`,
    '',
    'Do exactly ONE review, then end your session:',
    `1. improvements:agent-review { mode:'claim', id:'${workItemId}', harness:'${harnessSlug}' }. If it returns`,
    "   claimed:false (for example 'agent-review-not-pending'), the review was already taken: end the session.",
    `2. Read the report with work_items:get { id:'${workItemId}', harness:'${harnessSlug}' }. Judge whether it is a`,
    '   real, reproducible defect with enough evidence for an implementer to act on. Check the evidence it cites;',
    '   reproduce it when the harness lets you. Do not fix anything.',
    '3. Record your verdict with blender:grade-idea { ideaId, grade, feedback } using the gradeWith.ideaId (or',
    '   ledgerIdeaId) returned by step 1. Approve only a report you could act on; otherwise request a revision',
    '   and say exactly what is missing.',
    '4. End your session. Do NOT claim, implement, or close the work item, and do not arm a loop.',
  ].join('\n');
}

/** The implementer's one-job brief (its first turn). */
export function buildAdmissionRepairBrief(input: {
  workItemId: string;
  harnessSlug: string;
  title: string | null;
}): string {
  const { workItemId, harnessSlug, title } = input;
  return [
    `You are the IMPLEMENTER recruited by ${ADMISSION_RECRUIT_ACTOR} (WI-6554700010018302) for one reviewed bug`,
    `admitted by a rule into harness '${harnessSlug}': ${workItemId}${title ? ` — "${title}"` : ''}.`,
    'It passed review and nobody has claimed it past its SLO.',
    '',
    'Carry exactly this one bug to a verified fix, then end your session:',
    `1. work_items:claim { id:'${workItemId}', harness:'${harnessSlug}' }. If the claim is refused, comment the`,
    '   refusal on the item (work_items:comment) and end the session.',
    `2. Read the item (work_items:get) and the harness's own guide (harness:list { detail:'full' } gives its repo`,
    '   root; read its README/PROTOCOL/CLAUDE.md). Reproduce the defect first and record the reproduction on the item.',
    '3. Fix the ROOT cause and add a regression test in the harness\'s own test framework that fails without the',
    '   fix. Run the tests. Edit with the file tools; a background git-sync routine commits the tree, and the',
    "   admission rule's delivery (direct push or the pot's standing PR) carries the fix upstream. Never git add,",
    '   commit or push yourself.',
    '4. When the fix and its test pass, close with work_items:complete { id, state:\'done\', assumptions:\'none\',',
    '   completion:{ summary, testsRun, testResult, verifiedHow, filesChanged, rootCauseVerification:{ ... } } }.',
    '   If you are blocked, record it with work_items:set_blocker and end the session.',
    'Do not arm a loop, and do not take other work.',
  ].join('\n');
}

export interface AdmissionRecruitLaunchInput {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  leg: RecruitLeg;
  key: string;
  brief: string;
}

export interface AdmissionRecruitEscalation {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  key: string;
  title: string;
  body: string;
}

export interface AdmissionRecruiterDeps {
  /** Items admitted from this data source, with their rule's recruit switch resolved. */
  listCandidates(input: { workspaceId: string; dataSourceId: string }): Promise<RecruitCandidate[]>;
  /** Every launch this actor made (live and ended, bounded). */
  listLaunches(workspaceId: string): Promise<RecruitLaunchRecord[]>;
  launch(input: AdmissionRecruitLaunchInput): Promise<{ ok: boolean; deduped?: boolean; error?: string }>;
  /** Idempotent by key: an open item holding the key is adopted, never duplicated. */
  escalate(input: AdmissionRecruitEscalation): Promise<{ id: string; created: boolean }>;
}

export interface AdmissionRecruiterResult {
  candidates: number;
  launched: Array<{ workItemId: string; leg: RecruitLeg; key: string; deduped: boolean }>;
  escalated: Array<{ workItemId: string; key: string; id: string; created: boolean }>;
  failed: Array<{ workItemId: string; stage: 'launch' | 'escalate'; error: string }>;
  decisions: RecruitDecision[];
}

export function admissionRecruitEscalationText(d: RecruitDecision): { title: string; body: string } {
  const hours = d.waitedMs == null ? 'an unknown time' : `${(d.waitedMs / 3_600_000).toFixed(1)}h`;
  const what = d.leg === 'review' ? 'agent review' : 'a repair (reviewed, unclaimed)';
  const exhausted = d.reason === 'attempts-exhausted';
  return {
    title: `Admitted bug ${d.workItemId} in '${d.harnessSlug}' has waited ${hours} for ${what}${
      exhausted ? ' — recruited agents did not move it' : ' — no agent is recruited for it'
    }`,
    body: [
      `Work item ${d.workItemId} (harness ${d.harnessSlug}) was admitted by a rule and has waited ${hours} for ${what}.`,
      '',
      exhausted
        ? `The admission recruiter launched ${d.attempts} agent(s) for this leg (epoch ${d.epoch}) and it still did not move. Read the launches with processes:list { launchedBy:'${ADMISSION_RECRUIT_ACTOR}', includeEnded:true } and fix what stopped them.`
        : "The admitting rule has lifecycle.recruit off, so the platform does not launch a reviewer or implementer for it, and no agent picked it up. Either review/repair it, or turn recruit on for the rule (work_items:admit { op:'rules-set', rule:{ lifecycle:{ recruit:true } } }).",
      '',
      `Filed by ${ADMISSION_RECRUIT_ACTOR} (WI-6554700010018302). Condition-keyed (${d.key}): no second item is filed while this one is open.`,
    ].join('\n'),
  };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One pass for one data source. Per-item failures are recorded, never thrown. */
export async function runAdmissionRecruiter(
  input: { workspaceId: string; dataSourceId: string; nowMs?: number; maxLaunches?: number },
  deps: AdmissionRecruiterDeps,
): Promise<AdmissionRecruiterResult> {
  const nowMs = input.nowMs ?? Date.now();
  const candidates = await deps.listCandidates({ workspaceId: input.workspaceId, dataSourceId: input.dataSourceId });
  const result: AdmissionRecruiterResult = { candidates: candidates.length, launched: [], escalated: [], failed: [], decisions: [] };
  if (candidates.length === 0) return result;
  const needsLedger = candidates.some((c) => c.recruit);
  const launches = needsLedger ? await deps.listLaunches(input.workspaceId) : [];
  const decisions = planAdmissionRecruitment(candidates, launches, nowMs, { maxLaunches: input.maxLaunches });
  result.decisions = decisions;
  const byId = new Map(candidates.map((c) => [c.workItemId, c]));
  for (const d of decisions) {
    if (d.action === 'launch' && d.key && d.leg) {
      const c = byId.get(d.workItemId);
      const brief =
        d.leg === 'review'
          ? buildAdmissionReviewBrief({ workItemId: d.workItemId, harnessSlug: d.harnessSlug, title: c?.title ?? null, epoch: d.epoch ?? 'r1' })
          : buildAdmissionRepairBrief({ workItemId: d.workItemId, harnessSlug: d.harnessSlug, title: c?.title ?? null });
      try {
        const res = await deps.launch({
          workspaceId: input.workspaceId,
          harnessSlug: d.harnessSlug,
          workItemId: d.workItemId,
          leg: d.leg,
          key: d.key,
          brief,
        });
        if (res.ok) result.launched.push({ workItemId: d.workItemId, leg: d.leg, key: d.key, deduped: res.deduped === true });
        else result.failed.push({ workItemId: d.workItemId, stage: 'launch', error: res.error ?? 'launch refused' });
      } catch (e) {
        result.failed.push({ workItemId: d.workItemId, stage: 'launch', error: errText(e) });
      }
    } else if (d.action === 'escalate' && d.key) {
      const text = admissionRecruitEscalationText(d);
      try {
        const res = await deps.escalate({
          workspaceId: input.workspaceId,
          harnessSlug: d.harnessSlug,
          workItemId: d.workItemId,
          key: d.key,
          ...text,
        });
        result.escalated.push({ workItemId: d.workItemId, key: d.key, id: res.id, created: res.created });
      } catch (e) {
        result.failed.push({ workItemId: d.workItemId, stage: 'escalate', error: errText(e) });
      }
    }
  }
  return result;
}

/** Production deps — lazily imported so this module and its tests never load PG or the launch door. */
export const defaultAdmissionRecruiterDeps: AdmissionRecruiterDeps = {
  async listCandidates({ workspaceId, dataSourceId }) {
    const [{ getOrgPg }, { getWorkItem }, { resolveAdmissionLifecycle }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../work-items'),
      import('./lifecycle-config'),
    ]);
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        work_item_id: string;
        harness_slug: string;
        lifecycle: unknown;
        rule_enabled: boolean | null;
        item_kind: string | null;
        title: string | null;
        admission: string | null;
        created_ts: string | number | null;
      }>
    >`
      SELECT DISTINCT ON (a.work_item_id)
             a.work_item_id, a.harness_slug, r.lifecycle, r.enabled AS rule_enabled,
             w.item_kind, w.title, w.admission, w.created_ts
        FROM harness_shared.work_admissions a
        LEFT JOIN harness_shared.admission_rules r ON r.workspace_id = a.workspace_id AND r.id = a.rule_id
        JOIN harness_shared.work_items w
          ON w.workspace_id = a.workspace_id AND w.feature_id = a.work_item_id AND w.harness_slug = a.harness_slug
       WHERE a.workspace_id = ${workspaceId} AND a.data_source_id = ${dataSourceId}::uuid
         AND w.closed_ts IS NULL
       ORDER BY a.work_item_id, a.created_at DESC
       LIMIT 200`;
    const out: RecruitCandidate[] = [];
    for (const r of rows) {
      const item = await getWorkItem(r.work_item_id, r.harness_slug);
      if (!item) continue;
      const created = r.created_ts == null ? NaN : Number(r.created_ts);
      out.push({
        workItemId: r.work_item_id,
        harnessSlug: r.harness_slug,
        kind: r.item_kind ?? '',
        status: item.state,
        assignee: item.assignee ?? null,
        payload: item.payload,
        title: r.title,
        admission: r.admission,
        createdAtMs: Number.isFinite(created) ? created : null,
        recruit: r.rule_enabled === true && resolveAdmissionLifecycle(r.lifecycle).recruit,
      });
    }
    return out;
  },
  async listLaunches(workspaceId) {
    const { listTasks } = await import('../task-manager/store');
    const rows = await listTasks({
      workspaceId,
      launchedBy: ADMISSION_RECRUIT_ACTOR,
      labelPrefix: ADMISSION_RECRUIT_LABEL_PREFIX,
      includeEnded: true,
      limit: 500,
    });
    const out: RecruitLaunchRecord[] = [];
    for (const r of rows) {
      const label = (r.detail as { label?: unknown } | null)?.label;
      const startedAtMs = r.startedAt ? new Date(r.startedAt).getTime() : NaN;
      if (typeof label !== 'string' || !Number.isFinite(startedAtMs)) continue;
      out.push({ label, startedAtMs, live: r.endedAt == null });
    }
    return out;
  },
  async launch(input) {
    const [{ default: launchAgentTool }, { readScoutPoolSnapshot, scoutRoutableProviders, scoutPoolAffirmativelyExhausted }] =
      await Promise.all([import('../agent-tools/capability/launch-agent'), import('../scout/capacity-probe')]);
    // A scheduled launch cannot answer a usage-limit dialog: reuse Scout's provider probe and the
    // launcher's gateway routing, exactly as the su-ideate scheduler does.
    const pool = await readScoutPoolSnapshot();
    if (pool && scoutPoolAffirmativelyExhausted(pool)) {
      return { ok: false, error: 'admission-recruiter: no routable provider in the current gateway pool' };
    }
    const routes = pool ? scoutRoutableProviders(pool) : undefined;
    const agent = routes && !routes.claudeAvailable && routes.codexAvailable ? 'codex' : 'claude';
    const ctx = {
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      uiClientId: null,
      isSuperuser: false,
      isPowerUser: false,
      principal: { kind: 'system', slug: ADMISSION_RECRUIT_ACTOR, workspaceId: input.workspaceId },
      ownerId: ADMISSION_RECRUIT_ACTOR,
      ownerLabel: 'admission recruiter',
      userId: null,
    };
    const result = (await launchAgentTool.handler(
      {
        brief: input.brief,
        harness: input.harnessSlug,
        agent,
        account: 'auto',
        headless: true,
        independent: true,
        count: 1,
        label: input.key,
        idempotencyKey: input.key,
      } as never,
      ctx as never,
    )) as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { deduped?: boolean } };
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    if (result.isError) return { ok: false, error: text.slice(0, 500) || 'launch refused' };
    return { ok: true, deduped: result.structuredContent?.deduped === true || /deduped/i.test(text) };
  },
  async escalate(input) {
    const { upsertConditionWorkItem } = await import('../coord/condition-upsert');
    const res = await upsertConditionWorkItem(input.key, {
      kind: 'task',
      title: input.title,
      summary: input.body,
      severity: 'major',
      createdBy: ADMISSION_RECRUIT_ACTOR,
      harness: input.harnessSlug,
      workspaceId: input.workspaceId,
    } as never);
    return { id: String(res.id), created: res.created };
  },
};

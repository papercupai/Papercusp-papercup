/**
 * su-ideate-schedule.ts — the hourly evaluation that makes su ideate passes fire
 * on their own (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-007 / R-14,
 * design D-005, cost bound D-006).
 *
 * The gap it closes (measured 2026-10-08): the owner's D-015 "overdue" verdict
 * (observation-count keyed, never calendar keyed — su-ideate-learning-substrate-
 * 2026-07-10 D-015) was evaluated ONLY inside coord:orient for a caller already in
 * IDEATE mode, so a pass happened only when someone put an su into IDEATE by hand.
 * Every su-ideate tick ever recorded was install 'papercusp' (211) except two.
 *
 * What it does, once per routine tick (the hour is the EVALUATION heartbeat, not a
 * fire trigger — D-015 is unchanged):
 *  1. Budget: at most {@link suIdeateDailyLaunchBudget} scheduled launches per
 *     rolling 24h workspace-wide (D-006 — papercusp alone files ~9k organic
 *     observations/day, so a pure count-10 verdict would read overdue on every tick).
 *  2. In flight: at most ONE scheduled pass in flight workspace-wide. A launch is
 *     in flight while its task is live, it has not yet been followed by a recorded
 *     pass for its harness, and it is younger than {@link SU_IDEATE_PASS_STALE_MS}.
 *  3. Per harness, oldest last pass first (never-passed first): skip a harness whose
 *     pot has learning switched off, or whose launches since its last pass reached
 *     {@link SU_IDEATE_MAX_ATTEMPTS} (a circuit breaker for a pass that keeps dying
 *     without recording); otherwise compute the D-015 verdict
 *     ({@link ideateOverdueFromCounts}, the same function orient uses) over that
 *     harness's organic observations since its last pass and its su-ideate idea
 *     queue. The FIRST overdue harness gets ONE headless, independent su launched
 *     through capability:launch-agent with a one-pass brief; the tick then stops.
 *
 * Kill switch: the routine row's active flag (routines:set pause) — no new flag.
 * Every read and the launch go through {@link SuIdeateScheduleDeps}, so the unit
 * tests drive the whole decision with no Postgres and no process spawn.
 */
import { ideateOverdueFromCounts, suIdeateObsThreshold, type IdeateHint } from '../agent-tools/coordination/tools/orient-ideate-hint';

/** The system actor that owns every scheduled launch (task_ledger.launched_by). */
export const SU_IDEATE_SCHEDULE_ACTOR = 'system:su-ideate-schedule';
/** The origin tag su ideate passes record under on the scout ledgers (migration 571). */
export const SU_IDEATE_ORIGIN = 'su-ideate';
/** Label/idempotency prefix for a scheduled pass: `su-ideate-pass:<harness>:<lastPass>:<attempt>`. */
export const SU_IDEATE_PASS_LABEL_PREFIX = 'su-ideate-pass:';
/** A live scheduled pass older than this no longer blocks the next launch (a pass is ~30 min). */
export const SU_IDEATE_PASS_STALE_MS = 2 * 60 * 60 * 1000;
/** Scheduled launches per harness per last-pass epoch before the circuit opens. */
export const SU_IDEATE_MAX_ATTEMPTS = 3;
/** The su ideation stances, rotated per harness after the last recorded lens. */
export const SU_IDEATE_LENSES = ['risk-first', 'user-value-first', 'cost-leverage'] as const;
export type SuIdeateLens = (typeof SU_IDEATE_LENSES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rolling-24h ceiling on scheduled launches, workspace-wide (D-006). Tunable via
 * `PAPERCUSP_SU_IDEATE_MAX_LAUNCHES_PER_DAY`; default 6. A non-positive / non-finite
 * override falls back to the default — pausing is the routine's job, not this knob's.
 */
export function suIdeateDailyLaunchBudget(): number {
  const raw = Number(process.env.PAPERCUSP_SU_IDEATE_MAX_LAUNCHES_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

/** The lens after `last` in rotation; an unknown or absent last lens starts the rotation. */
export function nextSuIdeateLens(last: string | null | undefined): SuIdeateLens {
  const i = SU_IDEATE_LENSES.indexOf((last ?? '') as SuIdeateLens);
  return SU_IDEATE_LENSES[(i + 1) % SU_IDEATE_LENSES.length];
}

/** One scheduled launch as the task ledger records it. */
export interface SuIdeateLaunchRecord {
  harnessSlug: string;
  startedAtMs: number;
  /** The task is still pending/running (not ended). */
  live: boolean;
  taskId?: string;
}

/**
 * Scheduled launches for `harnessSlug` since its last recorded pass — the circuit-breaker
 * count (D-006 §4). The ONE definition both the scheduler (skip) and the producer-silence
 * alarm ({@link readSuIdeateOpenCircuits}) read, so "open" can never mean two things.
 */
export function suIdeateAttemptsSinceLastPass(
  launches: readonly SuIdeateLaunchRecord[],
  harnessSlug: string,
  lastPassMs: number | null,
): SuIdeateLaunchRecord[] {
  return launches.filter((l) => l.harnessSlug === harnessSlug && (lastPassMs == null || l.startedAtMs > lastPassMs));
}

/** Parse `su-ideate-pass:<harness>:…` → harness; null for any other label. */
export function harnessFromPassLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string' || !label.startsWith(SU_IDEATE_PASS_LABEL_PREFIX)) return null;
  const harness = label.slice(SU_IDEATE_PASS_LABEL_PREFIX.length).split(':')[0]?.trim();
  return harness ? harness : null;
}

export interface SuIdeateLaunchInput {
  workspaceId: string;
  harnessSlug: string;
  lens: SuIdeateLens;
  /** Label AND idempotency key: `su-ideate-pass:<harness>:<lastPassMs|never>:<attempt>`. */
  key: string;
  brief: string;
}

export interface SuIdeateLaunchResult {
  ok: boolean;
  deduped?: boolean;
  error?: string;
}

/** Injectable read/launch seam — unit tests supply fakes; production uses {@link defaultSuIdeateScheduleDeps}. */
export interface SuIdeateScheduleDeps {
  /** Every harness slug installed in the workspace. */
  listHarnesses: (workspaceId: string) => Promise<string[]>;
  /** The harness's last recorded su-ideate pass (status ran) and the lens it declared. */
  readLastPass: (workspaceId: string, harnessSlug: string) => Promise<{ lastPassMs: number | null; lastLens: string | null }>;
  /** False ⇔ the harness's pot has learning switched off (absent row = enabled). */
  learningEnabled: (workspaceId: string, harnessSlug: string) => Promise<boolean>;
  /** Organic lane:observation rows filed in the harness strictly after `sinceMs` (all-time when null). */
  countObservationsSince: (workspaceId: string, harnessSlug: string, sinceMs: number | null) => Promise<number>;
  /** The harness's su-ideate routed-idea queue. */
  readIdeaQueue: (workspaceId: string, harnessSlug: string) => Promise<{ total: number; pending: number }>;
  /** Every scheduled launch this actor made (bounded, newest first is fine). */
  listLaunches: (workspaceId: string) => Promise<SuIdeateLaunchRecord[]>;
  /** Open ONE headless independent su for the pass. */
  launch: (input: SuIdeateLaunchInput) => Promise<SuIdeateLaunchResult>;
}

export type SuIdeateHarnessDisposition =
  | 'learning-disabled'
  | 'attempts-exhausted'
  | 'not-overdue'
  | 'launched'
  | 'launch-failed';

export interface SuIdeateHarnessDecision {
  harnessSlug: string;
  disposition: SuIdeateHarnessDisposition;
  lastPassMs: number | null;
  verdict?: Pick<IdeateHint, 'verdict' | 'observationsSince' | 'ideasDrained' | 'reason' | 'threshold'>;
  attempts?: number;
  error?: string;
}

export interface SuIdeateScheduleOutcome {
  /** Why nothing was evaluated, when the tick stopped before the per-harness loop. */
  stopped?: 'daily-budget-exhausted' | 'pass-in-flight' | 'no-harnesses';
  launchesLast24h: number;
  budget: number;
  inFlight?: { harnessSlug: string; startedAtMs: number };
  launched?: { harnessSlug: string; lens: SuIdeateLens; key: string; deduped: boolean };
  /** The harnesses evaluated this tick, in evaluation order (stops at the first launch). */
  decisions: SuIdeateHarnessDecision[];
}

/** The one-pass brief handed to the launched su (its first turn). */
export function buildSuIdeatePassBrief(input: {
  harnessSlug: string;
  lens: SuIdeateLens;
  reason: string;
}): string {
  const { harnessSlug, lens, reason } = input;
  return [
    `You are a SCHEDULED su ideate pass for harness '${harnessSlug}', launched by ${SU_IDEATE_SCHEDULE_ACTOR}`,
    `(plan scout-su-ideate-pipeline-gaps-2026-10-08 D-005). The D-015 verdict for this harness read overdue: ${reason}.`,
    '',
    'Run exactly ONE ideate pass, then end your session:',
    `1. Ground first: blender:ideation-feedback — what your lens and past ideas for '${harnessSlug}' produced.`,
    `2. Mine the recent lane:observation rows filed in '${harnessSlug}' under ONE lens: ${lens}`,
    '   (risk-first = de-risk the riskiest assumption; user-value-first = work backward from felt owner/user value;',
    '   cost-leverage = a small change that removes a big recurring cost).',
    `3. File each concrete idea with improvements:capture (title prefix "[lens:${lens}]"); route a broad,`,
    '   cross-lane idea with blender:route-idea instead. Search first and do not duplicate an existing item.',
    `4. Close the pass once with blender:ideate-pass-record { ideasFiled, observationsMined, lens: '${lens}', notes }; use numeric counts you actually observed.`,
    '5. End your session with session:end. Do NOT arm a loop, claim backlog work, or implement any idea.',
    'If grounding shows nothing worth filing, still record the pass with zero counts and a one-line note why.',
  ].join('\n');
}

/**
 * One scheduling tick. Pure over {@link SuIdeateScheduleDeps}; deps may throw — the
 * blueprint op lets that surface as a failed step rather than swallowing it.
 */
export async function runSuIdeateSchedule(
  input: { workspaceId: string; nowMs?: number },
  deps: SuIdeateScheduleDeps,
): Promise<SuIdeateScheduleOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  const { workspaceId } = input;
  const budget = suIdeateDailyLaunchBudget();
  const threshold = suIdeateObsThreshold();

  const launches = await deps.listLaunches(workspaceId);
  const launchesLast24h = launches.filter((l) => l.startedAtMs > nowMs - DAY_MS).length;
  const base = { launchesLast24h, budget };
  if (launchesLast24h >= budget) return { ...base, stopped: 'daily-budget-exhausted', decisions: [] };

  const harnesses = [...new Set((await deps.listHarnesses(workspaceId)).filter((h) => typeof h === 'string' && h))];
  if (harnesses.length === 0) return { ...base, stopped: 'no-harnesses', decisions: [] };

  const passes = new Map<string, { lastPassMs: number | null; lastLens: string | null }>();
  for (const h of harnesses) passes.set(h, await deps.readLastPass(workspaceId, h));

  // A live launch blocks the tick only while it has not yet produced its pass and
  // is not stale — a pass that recorded and then parked must not hold the slot.
  const inFlight = launches.find((l) => {
    if (!l.live || l.startedAtMs <= nowMs - SU_IDEATE_PASS_STALE_MS) return false;
    const lastPassMs = passes.get(l.harnessSlug)?.lastPassMs ?? null;
    return lastPassMs == null || lastPassMs < l.startedAtMs;
  });
  if (inFlight) {
    return {
      ...base,
      stopped: 'pass-in-flight',
      inFlight: { harnessSlug: inFlight.harnessSlug, startedAtMs: inFlight.startedAtMs },
      decisions: [],
    };
  }

  // Oldest last pass first, never-passed first; ties by slug for determinism. Time
  // ORDERS the overdue harnesses here — it never makes one overdue (D-015).
  const order = [...harnesses].sort((a, b) => {
    const pa = passes.get(a)?.lastPassMs ?? null;
    const pb = passes.get(b)?.lastPassMs ?? null;
    if (pa !== pb) {
      if (pa == null) return -1;
      if (pb == null) return 1;
      return pa - pb;
    }
    return a.localeCompare(b);
  });

  const decisions: SuIdeateHarnessDecision[] = [];
  for (const harnessSlug of order) {
    const { lastPassMs, lastLens } = passes.get(harnessSlug) ?? { lastPassMs: null, lastLens: null };
    const attempts = suIdeateAttemptsSinceLastPass(launches, harnessSlug, lastPassMs).length;
    if (attempts >= SU_IDEATE_MAX_ATTEMPTS) {
      decisions.push({ harnessSlug, disposition: 'attempts-exhausted', lastPassMs, attempts });
      continue;
    }
    if (!(await deps.learningEnabled(workspaceId, harnessSlug))) {
      decisions.push({ harnessSlug, disposition: 'learning-disabled', lastPassMs });
      continue;
    }
    const [observationsSince, queue] = await Promise.all([
      deps.countObservationsSince(workspaceId, harnessSlug, lastPassMs),
      deps.readIdeaQueue(workspaceId, harnessSlug),
    ]);
    const hint = ideateOverdueFromCounts({ observationsSince, queue, lastPassMs, nowMs, threshold });
    const verdict = {
      verdict: hint.verdict,
      observationsSince: hint.observationsSince,
      ideasDrained: hint.ideasDrained,
      reason: hint.reason,
      threshold: hint.threshold,
    };
    if (hint.verdict !== 'overdue') {
      decisions.push({ harnessSlug, disposition: 'not-overdue', lastPassMs, verdict });
      continue;
    }

    const lens = nextSuIdeateLens(lastLens);
    const key = `${SU_IDEATE_PASS_LABEL_PREFIX}${harnessSlug}:${lastPassMs ?? 'never'}:${attempts + 1}`;
    const result = await deps.launch({
      workspaceId,
      harnessSlug,
      lens,
      key,
      brief: buildSuIdeatePassBrief({ harnessSlug, lens, reason: hint.reason }),
    });
    if (!result.ok) {
      decisions.push({ harnessSlug, disposition: 'launch-failed', lastPassMs, verdict, attempts, error: result.error });
      // The canonical scope refusal is local to this harness. Keep its denial recorded and
      // let the next candidate pass its OWN scope gate; a denied first slug must not starve
      // permitted harnesses. Global governor/quota/unknown refusals still end the tick.
      if (result.error?.startsWith('scope_denied:')) continue;
      return { ...base, decisions };
    }
    decisions.push({ harnessSlug, disposition: 'launched', lastPassMs, verdict, attempts: attempts + 1 });
    return { ...base, launched: { harnessSlug, lens, key, deduped: result.deduped === true }, decisions };
  }
  return { ...base, decisions };
}

/** Production deps — lazily imported so this module (and its tests) never statically load PG or the launch door. */
export const defaultSuIdeateScheduleDeps: SuIdeateScheduleDeps = {
  async listHarnesses(workspaceId) {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    return reg.projects.map((p) => p.slug).filter((s): s is string => typeof s === 'string' && s.length > 0);
  },
  async readLastPass(workspaceId, harnessSlug) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ tick_at: string | Date; lens: string | null }>>`
      SELECT tick_at, detail ->> 'lens' AS lens
        FROM harness_shared.scout_ticks
       WHERE workspace_id = ${workspaceId}
         AND origin = ${SU_IDEATE_ORIGIN}
         AND status IN ('ran', 'fired')
         AND install_slug = ${harnessSlug}
       ORDER BY tick_at DESC
       LIMIT 1`;
    const row = rows[0];
    if (!row) return { lastPassMs: null, lastLens: null };
    const ms = row.tick_at instanceof Date ? row.tick_at.getTime() : new Date(row.tick_at).getTime();
    return { lastPassMs: Number.isFinite(ms) ? ms : null, lastLens: row.lens ?? null };
  },
  async learningEnabled(workspaceId, harnessSlug) {
    const [{ resolveLearningPotSlug }, { potLearningEnabled }, { getOrgPg }] = await Promise.all([
      import('../learning/pot-scope'),
      import('../learning/pot-gate/store'),
      import('@papercusp/db-org'),
    ]);
    const potSlug = await resolveLearningPotSlug({ workspaceId, harnessSlug, potSlug: null });
    if (!potSlug) return true; // no owning pot ⇒ no switch to honour (absent row = enabled)
    return potLearningEnabled(getOrgPg().sql as never, { workspaceId, potSlug });
  },
  async countObservationsSince(_workspaceId, harnessSlug, sinceMs) {
    const { countHarnessObservationFilingsSince } = await import('../harness/improvements/read-items');
    return countHarnessObservationFilingsSince(harnessSlug, sinceMs == null ? null : new Date(sinceMs).toISOString());
  },
  async readIdeaQueue(workspaceId, harnessSlug) {
    const { readIdeaQueueStatus } = await import('./routed-ledger');
    return readIdeaQueueStatus({ workspaceId, origin: SU_IDEATE_ORIGIN, harnessSlug });
  },
  async listLaunches(workspaceId) {
    const { listTasks } = await import('../task-manager/store');
    const rows = await listTasks({
      workspaceId,
      launchedBy: SU_IDEATE_SCHEDULE_ACTOR,
      labelPrefix: SU_IDEATE_PASS_LABEL_PREFIX,
      includeEnded: true,
      limit: 200,
    });
    const out: SuIdeateLaunchRecord[] = [];
    for (const r of rows) {
      const harnessSlug = harnessFromPassLabel((r.detail as { label?: unknown } | null)?.label as string | undefined);
      const startedAtMs = r.startedAt ? new Date(r.startedAt).getTime() : NaN;
      if (!harnessSlug || !Number.isFinite(startedAtMs)) continue;
      out.push({ harnessSlug, startedAtMs, live: r.endedAt == null, taskId: r.taskId });
    }
    return out;
  },
  async launch(input) {
    const [{ default: launchAgentTool }, { readScoutPoolSnapshot, scoutRoutableProviders, scoutPoolAffirmativelyExhausted }] =
      await Promise.all([import('../agent-tools/capability/launch-agent'), import('./capacity-probe')]);
    // Scheduled launches cannot answer the workstation's usage-limit dialog. Reuse
    // Scout's provider probe and the launcher's gateway account routing instead.
    const pool = await readScoutPoolSnapshot();
    if (pool && scoutPoolAffirmativelyExhausted(pool)) {
      return { ok: false, error: 'su-ideate: no routable provider in the current gateway pool' };
    }
    const routes = pool ? scoutRoutableProviders(pool) : undefined;
    const agent = routes && !routes.claudeAvailable && routes.codexAvailable ? 'codex' : 'claude';
    const ctx = {
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      uiClientId: null,
      isSuperuser: false,
      isPowerUser: false,
      principal: { kind: 'system', slug: SU_IDEATE_SCHEDULE_ACTOR, workspaceId: input.workspaceId },
      ownerId: SU_IDEATE_SCHEDULE_ACTOR,
      ownerLabel: 'su-ideate schedule',
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
        stack: ['ideation:su.mode-ideate'],
        label: input.key,
        idempotencyKey: input.key,
      } as never,
      ctx as never,
    )) as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { deduped?: boolean } };
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    if (result.isError) return { ok: false, error: text.slice(0, 500) || 'launch refused' };
    return { ok: true, deduped: result.structuredContent?.deduped === true || /deduped/i.test(text) };
  },
};

/** One harness whose su-ideate circuit is open: its scheduled passes keep dying without recording. */
export interface SuIdeateOpenCircuit {
  harnessSlug: string;
  /** Scheduled launches since the last recorded pass (≥ {@link SU_IDEATE_MAX_ATTEMPTS}). */
  attempts: number;
  lastPassMs: number | null;
  /** The newest of those launches. */
  lastLaunchMs: number;
}

/**
 * Harnesses whose circuit is OPEN, for the producer-silence alarm (plan D-010, from the
 * outside-lineage objection to the R-14 BAR amendment): at least
 * {@link SU_IDEATE_MAX_ATTEMPTS} scheduled launches since the last recorded pass, every one
 * of them finished or stale (a live, fresh attempt may still record, so it is not yet a
 * dead circuit), and the harness's pot learning switch on (a switched-off pot is
 * deliberate silence). Without this the open circuit was only a scheduler decision
 * (`attempts-exhausted`) that nothing raised, so a harness whose passes always die was
 * caught by no alarm. Only harnesses with a scheduled launch can have an open circuit,
 * so the census is the launch ledger.
 */
export async function readSuIdeateOpenCircuits(
  workspaceId: string,
  nowMs: number = Date.now(),
  deps: Pick<SuIdeateScheduleDeps, 'listLaunches' | 'readLastPass' | 'learningEnabled'> = defaultSuIdeateScheduleDeps,
): Promise<{ harnessesChecked: number; open: SuIdeateOpenCircuit[] }> {
  const launches = await deps.listLaunches(workspaceId);
  const harnesses = [...new Set(launches.map((l) => l.harnessSlug))].sort();
  const open: SuIdeateOpenCircuit[] = [];
  for (const harnessSlug of harnesses) {
    const { lastPassMs } = await deps.readLastPass(workspaceId, harnessSlug);
    const since = suIdeateAttemptsSinceLastPass(launches, harnessSlug, lastPassMs);
    if (since.length < SU_IDEATE_MAX_ATTEMPTS) continue;
    if (since.some((l) => l.live && l.startedAtMs > nowMs - SU_IDEATE_PASS_STALE_MS)) continue;
    if (!(await deps.learningEnabled(workspaceId, harnessSlug))) continue;
    open.push({
      harnessSlug,
      attempts: since.length,
      lastPassMs,
      lastLaunchMs: Math.max(...since.map((l) => l.startedAtMs)),
    });
  }
  return { harnessesChecked: harnesses.length, open };
}

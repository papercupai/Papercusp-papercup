/**
 * Weekly owner grading sample — scout-su-ideate-pipeline-gaps-2026-10-08 P-008 / R-17.
 *
 * The ideation programme grades itself: the Mug writes `auto-grader` grades and su
 * sessions write their own ownerId. Nothing put a sample of routed ideas in front of
 * the HUMAN on a cadence, so agent grades were never calibrated against owner
 * judgement and owner grades (sovereign, D-004) accrued only by accident.
 *
 * Once per ~7-day window this sweep picks a small, stratified, deterministic sample of
 * recently routed IDEATION ideas (scout / su-ideate / dream — never the agent-review
 * bucket, which R-18 separates from ideation) that the owner has not graded yet, and
 * sends it to the owner inbox (`coord:send to:['human']`).
 *
 * Reuse, not a new system:
 *  - rows come from {@link readRoutedIdeas} (the routed ledger read every grading path uses);
 *  - "ideation" is {@link isIdeationLedgerOrigin} (the P-005 single source);
 *  - the weekly debounce is the shared `pot_watchdog_fires` ledger
 *    ({@link recentWatchdogFires} + {@link claimWatchdogFire}) under its own source;
 *  - delivery is the same `sendMessage(to:['human'])` the scout error-streak pager uses;
 *  - the run is a DBOS.runStep sibling of the su-ideate ungraded sweep (routines-workflow).
 *
 * Fail-soft: every error is returned as `{ outcome: 'error' }` (the routine step records
 * it in operation_outputs) and never thrown into the routines tick.
 * Tuning: `PAPERCUSP_SCOUT_WEEKLY_GRADING_SAMPLE_SIZE` (default 5; `<= 0` disables).
 */
import { activeWorkspaceId } from '../workspace-registry';
import { isIdeationLedgerOrigin } from './ideation-origin';
import type { RoutedIdeaProvenance } from './outcome-feedback';

export const WEEKLY_GRADING_SAMPLE_SOURCE = 'scout-weekly-grading-sample' as const;
export const WEEKLY_GRADING_SAMPLE_DEFAULT_SIZE = 5;
/** Ideas routed longer ago than this are too stale for the owner to judge usefully. */
export const WEEKLY_GRADING_LOOKBACK_DAYS = 28;
/**
 * Debounce window. One hour short of a full week so an hourly routine tick does not
 * push each week's delivery one tick later than the last (a 168h window on an hourly
 * tick drifts by up to an hour per week, forever).
 */
export const WEEKLY_GRADING_WINDOW_HOURS = 7 * 24 - 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export function weeklyGradingSampleSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCUSP_SCOUT_WEEKLY_GRADING_SAMPLE_SIZE;
  if (raw === undefined || raw.trim() === '') return WEEKLY_GRADING_SAMPLE_DEFAULT_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return WEEKLY_GRADING_SAMPLE_DEFAULT_SIZE;
  return Math.max(0, Math.min(25, Math.floor(n)));
}

/** ISO-8601 week key (`2026-W41`) for `nowMs`, in UTC. The sample's identity per week. */
export function isoWeekKey(nowMs: number): string {
  const d = new Date(nowMs);
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  // Shift to the Thursday of this ISO week; its year is the ISO week-year.
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** FNV-1a 32-bit — a stable, dependency-free ordering key (not a security hash). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type OutcomeBucket = 'won' | 'lost' | 'unresolved';

function bucketOf(outcome: string | undefined): OutcomeBucket {
  if (outcome === 'won') return 'won';
  if (outcome === 'lost') return 'lost';
  return 'unresolved';
}

/**
 * Pick the week's sample. Pure and deterministic for a given (rows, nowMs):
 *  - only IDEATION origins (a NULL origin is a legacy scout row);
 *  - never an idea the owner already graded (owner grades are sovereign — re-asking is noise);
 *  - only ideas routed within {@link WEEKLY_GRADING_LOOKBACK_DAYS} (and not in the future);
 *  - STRATIFIED round-robin over outcome buckets (won → lost → unresolved) so the owner
 *    sees both sides of the resolver instead of whatever bucket dominates the ledger;
 *  - within a bucket, ordered by a hash of (ISO week, ideaId): stable inside a week,
 *    rotating across weeks, never biased toward the newest rows.
 */
export function selectWeeklyGradingSample(
  rows: readonly RoutedIdeaProvenance[],
  opts: { nowMs: number; size?: number; lookbackDays?: number },
): RoutedIdeaProvenance[] {
  const size = opts.size ?? WEEKLY_GRADING_SAMPLE_DEFAULT_SIZE;
  if (size <= 0) return [];
  const floorMs = opts.nowMs - (opts.lookbackDays ?? WEEKLY_GRADING_LOOKBACK_DAYS) * DAY_MS;
  const week = isoWeekKey(opts.nowMs);
  const seen = new Set<string>();
  const buckets: Record<OutcomeBucket, Array<{ key: number; row: RoutedIdeaProvenance }>> = {
    won: [],
    lost: [],
    unresolved: [],
  };
  for (const row of rows) {
    if (!row.ideaId || seen.has(row.ideaId)) continue;
    if (!isIdeationLedgerOrigin(row.origin ?? 'scout')) continue;
    if (row.gradedBy === 'owner') continue;
    const routedMs = row.routedAt ? new Date(row.routedAt).getTime() : Number.NaN;
    if (!Number.isFinite(routedMs) || routedMs < floorMs || routedMs > opts.nowMs) continue;
    seen.add(row.ideaId);
    buckets[bucketOf(row.outcome)].push({ key: fnv1a(`${week}:${row.ideaId}`), row });
  }
  const order: OutcomeBucket[] = ['won', 'lost', 'unresolved'];
  for (const b of order) {
    buckets[b].sort((a, c) => a.key - c.key || (a.row.ideaId < c.row.ideaId ? -1 : 1));
  }
  const picked: RoutedIdeaProvenance[] = [];
  for (let i = 0; picked.length < size; i++) {
    let any = false;
    for (const b of order) {
      const entry = buckets[b][i];
      if (!entry) continue;
      any = true;
      picked.push(entry.row);
      if (picked.length >= size) break;
    }
    if (!any) break;
  }
  return picked;
}

/** Render the owner-inbox message. Self-contained: the owner may see only this message. */
export function formatWeeklyGradingSample(
  sample: readonly RoutedIdeaProvenance[],
  weekKey: string,
): { summary: string; body: string } {
  const summary = `Weekly grading sample ${weekKey}: ${sample.length} routed idea${sample.length === 1 ? '' : 's'} for you to grade (1–5)`;
  const lines = sample.map((r, i) => {
    const routed = r.routedAt ? new Date(r.routedAt).toISOString().slice(0, 10) : 'unknown date';
    const current =
      typeof r.humanGrade === 'number' ? `current grade ${r.humanGrade}/5 by ${r.gradedBy ?? 'unknown'}` : 'ungraded';
    return (
      `${i + 1}. ${r.title?.trim() || '(untitled idea)'}\n` +
      `   ideaId ${r.ideaId} · lens ${r.lens} · origin ${r.origin ?? 'scout'} · outcome ${r.outcome ?? 'pending'} · ` +
      `routed ${routed} · ${r.routedRef} · ${current}`
    );
  });
  const body =
    `${summary}.\n\n` +
    `These are routed ideation ideas from the last ${WEEKLY_GRADING_LOOKBACK_DAYS} days that you have not graded, ` +
    `sampled across won / lost / still-unresolved outcomes. Your grade is sovereign: an agent grader never ` +
    `overwrites it, and it calibrates the agent graders and the lens weights.\n\n` +
    `${lines.join('\n')}\n\n` +
    `Grade each with blender:grade-idea { ideaId, grade, feedback? } — 5 = clear win, 3 = neutral, ` +
    `1 = clear loss. A grade you enter from your own surface is recorded as yours ('owner'); asking an agent ` +
    `to enter it records that agent instead.`;
  return { summary, body };
}

export type WeeklyGradingSampleOutcome = 'sent' | 'debounced' | 'empty' | 'disabled' | 'error';

export interface WeeklyGradingSampleResult {
  outcome: WeeklyGradingSampleOutcome;
  workspaceId: string;
  weekKey: string;
  sampled: number;
  ideaIds: string[];
  reason: string;
}

/** Injectable seams so the sweep's control flow is unit-testable without PG or coord. */
export interface WeeklyGradingSampleDeps {
  readIdeas(workspaceId: string): Promise<RoutedIdeaProvenance[]>;
  firedWithinWindow(workspaceId: string): Promise<boolean>;
  claimFire(workspaceId: string, reason: string): Promise<boolean>;
  send(workspaceId: string, message: { summary: string; body: string }): Promise<void>;
}

const defaultDeps: WeeklyGradingSampleDeps = {
  async readIdeas(workspaceId) {
    const { readRoutedIdeas } = await import('./routed-ledger');
    // origin 'all' = every non-shadow, non-agent-review origin; the pure selector still
    // re-checks isIdeationLedgerOrigin so a future origin is excluded until it is ideation.
    return readRoutedIdeas({ workspaceId, origin: 'all', limit: 2000 });
  },
  async firedWithinWindow(workspaceId) {
    const { recentWatchdogFires } = await import('../pot/watchdog');
    const n = await recentWatchdogFires(
      workspaceId,
      workspaceId,
      WEEKLY_GRADING_WINDOW_HOURS,
      WEEKLY_GRADING_SAMPLE_SOURCE,
    );
    return n > 0;
  },
  async claimFire(workspaceId, reason) {
    const { claimWatchdogFire } = await import('../pot/watchdog');
    return claimWatchdogFire({
      workspaceId,
      installSlug: workspaceId,
      source: WEEKLY_GRADING_SAMPLE_SOURCE,
      reason,
      wakeAt: null,
      windowHours: WEEKLY_GRADING_WINDOW_HOURS,
    });
  },
  async send(workspaceId, message) {
    const [{ sendMessage }, { runWithWorkspace }] = await Promise.all([
      import('../agent-tools/coordination/messages'),
      import('../workspace-als'),
    ]);
    await runWithWorkspace(workspaceId, () =>
      sendMessage(
        {
          ownerId: WEEKLY_GRADING_SAMPLE_SOURCE,
          ownerLabel: WEEKLY_GRADING_SAMPLE_SOURCE,
          source: 'static-client',
          workspaceId,
          userId: null,
        },
        { to: ['human'], summary: message.summary, body: message.body },
      ),
    );
  },
};

/**
 * One sweep: debounce → read → select → claim → send. Claim-before-send (at-most-once per
 * window, like every other pot_watchdog_fires consumer): a send failure is reported as
 * `error` with the claim already recorded, so the next sample comes a window later rather
 * than as a duplicate.
 */
export async function weeklyGradingSampleSweep(
  opts: { now?: number; workspaceId?: string; size?: number; deps?: Partial<WeeklyGradingSampleDeps> } = {},
): Promise<WeeklyGradingSampleResult> {
  const nowMs = opts.now ?? Date.now();
  const weekKey = isoWeekKey(nowMs);
  const deps: WeeklyGradingSampleDeps = { ...defaultDeps, ...opts.deps };
  let workspaceId = opts.workspaceId ?? '';
  const base = { weekKey, sampled: 0, ideaIds: [] as string[] };
  try {
    workspaceId = workspaceId || activeWorkspaceId();
    const size = opts.size ?? weeklyGradingSampleSize();
    if (size <= 0) {
      return { ...base, workspaceId, outcome: 'disabled', reason: 'PAPERCUSP_SCOUT_WEEKLY_GRADING_SAMPLE_SIZE <= 0' };
    }
    if (await deps.firedWithinWindow(workspaceId)) {
      return { ...base, workspaceId, outcome: 'debounced', reason: `a sample was already sent within ${WEEKLY_GRADING_WINDOW_HOURS}h` };
    }
    const sample = selectWeeklyGradingSample(await deps.readIdeas(workspaceId), { nowMs, size });
    if (sample.length === 0) {
      return {
        ...base,
        workspaceId,
        outcome: 'empty',
        reason: `no owner-ungraded ideation idea routed in the last ${WEEKLY_GRADING_LOOKBACK_DAYS} days`,
      };
    }
    const ideaIds = sample.map((r) => r.ideaId);
    // The reason differs every week (weekKey + ids), so claimWatchdogFire's byte-identical
    // geometric backoff never stretches the weekly cadence.
    const claimed = await deps.claimFire(workspaceId, `weekly grading sample ${weekKey}: ${ideaIds.join(',')}`);
    if (!claimed) {
      return { ...base, workspaceId, outcome: 'debounced', reason: 'debounce slot raced or backed off' };
    }
    await deps.send(workspaceId, formatWeeklyGradingSample(sample, weekKey));
    return { workspaceId, weekKey, outcome: 'sent', sampled: sample.length, ideaIds, reason: 'sent to the owner inbox' };
  } catch (err) {
    return {
      ...base,
      workspaceId,
      outcome: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

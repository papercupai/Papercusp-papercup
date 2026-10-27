/**
 * Campaign outcome measurement (code-cleanup-campaigns-2026-10-26 P-008, D-013, D-014).
 *
 * The campaign outcome rubric (`code-cleanup-campaign-outcome`) grades three numbers on a
 * rescore schedule: batches landed, lines removed, and regression rate. This module is the
 * reader behind the three registered instruments that rubric binds.
 *
 * Source of truth: when a campaign batch lands, the campaign runner (P-009) records the batch's
 * outcome on the batch work-item as `payload.cleanupBatch` (see {@link CleanupBatchRecord}). A
 * landed batch is a work-item with that record whose status is a successful terminal state and
 * whose `closed_ts` falls in the measurement window. Nothing else is counted: a batch that never
 * landed has no record, so a campaign that only starts batches scores `unknown`, never a pass.
 *
 * Verdicts are honest about absence: with no landed batch in the window every metric is
 * `unknown`. A record that does not match the contract makes the metric `fail`, because the
 * runner broke the contract the rubric reads.
 */
import { DEFAULT_REGRESSION_THRESHOLD, DEFAULT_REGRESSION_WINDOW_MS, campaignOutcome, type LandedBatch } from './throttle';

export const CLEANUP_OUTCOME_INSTRUMENT_KEYS = {
  batchesLanded: 'code-cleanup:campaign-batches-landed',
  linesRemoved: 'code-cleanup:campaign-lines-removed',
  regressionRate: 'code-cleanup:campaign-regression-rate',
} as const;

export type CleanupOutcomeMetric = keyof typeof CLEANUP_OUTCOME_INSTRUMENT_KEYS;

/** The rescore window: the same 7 days the regression throttle counts over. */
export const CLEANUP_OUTCOME_WINDOW_MS = DEFAULT_REGRESSION_WINDOW_MS;

/** The work-item payload key the campaign runner writes when a batch lands. */
export const CLEANUP_BATCH_RECORD_KEY = 'cleanupBatch';

/** Successful terminal states that mean the batch landed. */
export const CLEANUP_LANDED_STATUSES: readonly string[] = ['done', 'resolved', 'closed', 'passed'];

/** What the runner records on a batch work-item when the batch lands. */
export interface CleanupBatchRecord {
  /** Campaign plan slug. */
  campaign: string;
  /** Batch id from the campaign's `campaign-batches` block (`<area>#<index>`). */
  batchId: string;
  /** Net lines the batch removed (deleted minus added), from the landed diff. */
  linesRemoved: number;
  /** Ids of gate reds the throttle attributed to this batch (each red once per batch). */
  attributedRedIds: string[];
}

/** One work-item row the reader returns. */
export interface LandedBatchRow {
  workItemId: string;
  closedTs: number;
  record: unknown;
}

export function metricForCleanupInstrument(key: string): CleanupOutcomeMetric | null {
  const hit = (Object.keys(CLEANUP_OUTCOME_INSTRUMENT_KEYS) as CleanupOutcomeMetric[])
    .find(metric => CLEANUP_OUTCOME_INSTRUMENT_KEYS[metric] === key);
  return hit ?? null;
}

/** The record, or the reason it does not match the contract. */
export function parseCleanupBatchRecord(raw: unknown): { ok: true; record: CleanupBatchRecord } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'record is not an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.campaign !== 'string' || !r.campaign.trim()) return { ok: false, reason: 'campaign is missing' };
  if (typeof r.batchId !== 'string' || !r.batchId.trim()) return { ok: false, reason: 'batchId is missing' };
  if (typeof r.linesRemoved !== 'number' || !Number.isInteger(r.linesRemoved)) return { ok: false, reason: 'linesRemoved is not an integer' };
  if (!Array.isArray(r.attributedRedIds) || !r.attributedRedIds.every(id => typeof id === 'string')) {
    return { ok: false, reason: 'attributedRedIds is not a string array' };
  }
  return {
    ok: true,
    record: { campaign: r.campaign, batchId: r.batchId, linesRemoved: r.linesRemoved, attributedRedIds: r.attributedRedIds as string[] },
  };
}

export interface CleanupOutcomeRating {
  verdict: 'pass' | 'fail' | 'unknown';
  detail: string;
  value?: number;
}

/**
 * Rate one metric over the landed batches in a window.
 *  - batchesLanded: pass when at least one batch landed; value = batches landed.
 *  - linesRemoved: pass when the landed batches removed more lines than they added; fail when
 *    they removed none (net); value = net lines removed.
 *  - regressionRate: pass when the attributed reds stay within the throttle threshold, the point
 *    at which the throttle would stop the campaign (R-9); value = attributed reds per landed batch.
 */
export function rateCleanupOutcome(
  rows: readonly LandedBatchRow[], metric: CleanupOutcomeMetric, opts: { threshold?: number } = {},
): CleanupOutcomeRating {
  const threshold = opts.threshold ?? DEFAULT_REGRESSION_THRESHOLD;
  const malformed: string[] = [];
  const landed: Array<{ workItemId: string; record: CleanupBatchRecord }> = [];
  for (const row of rows) {
    const parsed = parseCleanupBatchRecord(row.record);
    if (parsed.ok) landed.push({ workItemId: row.workItemId, record: parsed.record });
    else malformed.push(`${row.workItemId} (${parsed.reason})`);
  }
  if (malformed.length) {
    return { verdict: 'fail', detail: `${malformed.length} landed batch record(s) do not match the ${CLEANUP_BATCH_RECORD_KEY} contract: ${malformed.join('; ')}` };
  }
  if (!landed.length) return { verdict: 'unknown', detail: 'No campaign batch landed in the window.' };

  const records = landed.map(l => l.record);
  const batchKey = (r: CleanupBatchRecord) => `${r.campaign}/${r.batchId}`;
  const batches: LandedBatch[] = landed.map(l => ({ batchId: batchKey(l.record), workItemId: l.workItemId, linesRemoved: l.record.linesRemoved }));
  const attributed = records.flatMap(r => r.attributedRedIds.map(redId => ({ redId, testFile: '', at: new Date(0), batchIds: [batchKey(r)] })));
  const outcome = campaignOutcome(batches, attributed);
  const netLines = records.reduce((n, r) => n + r.linesRemoved, 0);
  const campaigns = [...new Set(records.map(r => r.campaign))].sort();
  const scope = `${outcome.batchesLanded} batch(es) across ${campaigns.length} campaign(s): ${campaigns.join(', ')}`;

  if (metric === 'batchesLanded') {
    return { verdict: 'pass', value: outcome.batchesLanded, detail: `${scope} landed.` };
  }
  if (metric === 'linesRemoved') {
    return netLines > 0
      ? { verdict: 'pass', value: netLines, detail: `${scope} removed ${netLines} net line(s).` }
      : { verdict: 'fail', value: netLines, detail: `${scope} removed no net lines (net ${netLines}).` };
  }
  const detail = `${outcome.attributedReds} attributed red(s) over ${scope} (rate ${outcome.regressionRate.toFixed(3)}; throttle threshold ${threshold}).`;
  return outcome.attributedReds <= threshold
    ? { verdict: 'pass', value: outcome.regressionRate, detail }
    : { verdict: 'fail', value: outcome.regressionRate, detail };
}

type OutcomeSql = { unsafe(query: string, params: unknown[]): Promise<unknown[]> };

/** Landed batch work-items with a `payload.cleanupBatch` record closed inside the window. */
export async function readLandedCleanupBatches(
  sql: OutcomeSql, window: { workspaceId: string; harnessSlug: string; windowStart: string; windowEnd: string },
): Promise<LandedBatchRow[]> {
  const rows = await sql.unsafe(
    `SELECT feature_id, closed_ts, payload->'${CLEANUP_BATCH_RECORD_KEY}' AS record
       FROM harness_shared.work_items
      WHERE workspace_id = $1 AND harness_slug = $2
        AND payload ? '${CLEANUP_BATCH_RECORD_KEY}'
        AND status = ANY($3::text[])
        AND closed_ts >= $4 AND closed_ts < $5
      ORDER BY closed_ts`,
    [window.workspaceId, window.harnessSlug, [...CLEANUP_LANDED_STATUSES],
      Date.parse(window.windowStart), Date.parse(window.windowEnd)],
  ) as Array<{ feature_id: string; closed_ts: string | number; record: unknown }>;
  return rows.map(r => ({ workItemId: r.feature_id, closedTs: Number(r.closed_ts), record: r.record }));
}

/** The registered instrument's scheduled measurement (run by the outcome rubric's `rubric-rescore`). */
export function cleanupOutcomeRescore(metric: CleanupOutcomeMetric) {
  return {
    windowMs: CLEANUP_OUTCOME_WINDOW_MS,
    unit: 'count' as const,
    scope: 'harness' as const,
    resolve: async (window: { workspaceId: string; harnessSlug?: string; windowStart: string; windowEnd: string }) => {
      if (!window.workspaceId.trim() || !window.harnessSlug?.trim()) {
        return { verdict: 'unknown' as const, detail: 'Exact workspace and harness required.' };
      }
      if (!Number.isFinite(Date.parse(window.windowStart)) || !Number.isFinite(Date.parse(window.windowEnd))) {
        return { verdict: 'unknown' as const, detail: 'A valid measurement window is required.' };
      }
      const { getOrgPg } = await import('@papercusp/db-org');
      const rows = await readLandedCleanupBatches(getOrgPg().sql as unknown as OutcomeSql, { ...window, harnessSlug: window.harnessSlug });
      return rateCleanupOutcome(rows, metric);
    },
  };
}

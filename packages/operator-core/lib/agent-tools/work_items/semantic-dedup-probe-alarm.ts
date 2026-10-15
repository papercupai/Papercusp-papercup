/**
 * semantic-dedup-probe-alarm — EI-22170937574367219: dedup screens fail OPEN
 * by design when a search leg is unavailable. That is correct for ordinary
 * captures: a filing must never be blocked by embedding or search health.
 *
 * But improvements:capture had no publisher for a degraded result: the response
 * included `dedupCoverage`, yet no durable signal identified repeated failures.
 * A separate work_items:create path already had an advisory for an unavailable
 * semantic probe because goal-mode creates can refuse under P-004.
 *
 * This module publishes a best-effort, deduplicated advisory for both paths:
 * `_create-core.ts` reports an unavailable semantic verdict, and
 * improvements:capture reports any `dedupCoverage.degraded` result. It reuses
 * the same dedup-by-(kind, signature) escalation primitive as the adjacent
 * embedding-desync alarm, so repeated occurrences bump one record's repeat
 * count instead of opening a new record per failed capture.
 *
 * Deliberately:
 *  - NEVER throws and NEVER rejects (internal try/catch; callers still treat
 *    the returned promise as fire-and-forget — see the call site).
 *  - NEVER logs via console. This codebase fails a vitest run on an
 *    unexpected console.warn/error (see
 *    `_create-core.goal-dedup-gate.test.ts`'s comment on the goal-context
 *    stamp for the precedent), and this path is exercised by ~15 existing
 *    dedup-gate test cases that mock `findSemanticDupes` to resolve `null`.
 *  - A NO-OP under vitest (checked first, before touching any real
 *    infrastructure) — mirrors the same-file convention in
 *    `semantic-dupe-guard.ts` (`if (process.env.VITEST && !deps) return
 *    null;`). This means the existing create-path test suites need no new
 *    mocking to stay green; this module's own behaviour is covered by its
 *    dedicated test file instead.
 */
import { openEscalation } from '../coordination/escalations';
import type { AgentIdentity } from '../coordination/identity';
import type { AlarmAttentionDeps } from '../../alarm-attention';
import { broadcastSevereEvent, broadcastSevereEventResolved } from '../../severe-event-broadcast';

const IDENTITY: AgentIdentity = {
  ownerId: 'system:semantic-dedup-probe-alarm',
  ownerLabel: 'system · semantic-dedup-probe-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

// Durable escalation dedup identity — bumps one open record's repeat count on
// every re-occurrence rather than opening a new one (same shape as
// embed-space-self-check.ts's DEDUP_KIND/SUBJECT_SIGNATURE).
const DEDUP_KIND = 'work-item-dedup-coverage-degraded';
const SUBJECT_SIGNATURE = 'papercusp-work-item-dedup';

export interface DedupCoverageDegradedDetail {
  source: 'work_items:create' | 'improvements:capture';
  /** The harness the degraded capture targeted, if known. */
  harnessSlug?: string;
  coverage?: { lexical?: string; semantic?: string; degraded?: boolean };
}

export interface DedupCoverageAlarmDeps {
  rail?: AlarmAttentionDeps;
  escalate?: (identity: AgentIdentity, input: Parameters<typeof openEscalation>[1]) => Promise<unknown>;
}

// Filing paths are fire-and-forget. Order observations in each source/harness
// partition so a slower degraded delivery cannot overwrite a later recovery.
const pending = new Map<string, Promise<void>>();

async function recoverDedupConditions(keys: string[], rail?: AlarmAttentionDeps): Promise<void> {
  if (!keys.length) return;
  let open: Set<string> | undefined;
  if (!rail?.resolve) {
    const { computeConditionStates, readConditionEnvelopes } = await import('../coordination/tools/conditions');
    open = new Set(computeConditionStates(await readConditionEnvelopes())
      .filter(condition => condition.open).map(condition => condition.condition_key));
  }
  for (const conditionKey of keys) {
    if (open && !open.has(conditionKey)) continue;
    const input = { conditionKey, summary: 'semantic-dedup-probe-alarm recovered' };
    try {
      if (rail?.resolve) await rail.resolve(input);
      else await broadcastSevereEventResolved(input);
    } catch { /* one failed recovery cannot suppress another measured leg */ }
  }
}

/**
 * Fire-and-forget: publish incomplete dedup coverage from any filing path.
 * The escalation is advisory and deduplicated so repeated failures raise the
 * same record's repeat count instead of opening one record per capture.
 */
export async function reportDedupCoverageDegraded(
  detail: DedupCoverageDegradedDetail,
  overrides?: DedupCoverageAlarmDeps,
): Promise<void> {
  await reportSemanticDedupProbeUnavailable(detail, overrides);
}

/**
 * Compatibility entry for the original unavailable-probe producer. Full measured
 * coverage can also recover each leg independently. Skipped, absent and unknown
 * statuses preserve that leg's episode; a healthy sibling cannot clear it.
 */
export async function reportSemanticDedupProbeUnavailable(detail: {
  harnessSlug?: string;
  source?: DedupCoverageDegradedDetail['source'];
  coverage?: DedupCoverageDegradedDetail['coverage'];
}, overrides?: DedupCoverageAlarmDeps): Promise<void> {
  if (process.env.VITEST && !overrides) return;
  const source = detail.source ?? 'work_items:create';
  const coverage = detail.coverage ?? {
    semantic: source === 'work_items:create' ? 'unavailable' : undefined,
    degraded: true,
  };
  const prefix = `alarm:work-item-dedup-coverage:${encodeURIComponent(source)}:${encodeURIComponent(detail.harnessSlug?.trim() || '<unscoped>')}:`;
  const run = async () => {
  const summary = 'Papercusp work-item dedup coverage is incomplete — empty duplicate results may miss existing work.';
  const body = `A dedup screening attempt from ${source}` +
    (detail.harnessSlug ? ` in harness '${detail.harnessSlug}'` : '') +
    ` reported coverage (lexical=${coverage.lexical ?? 'unknown'}, ` +
    `semantic=${coverage.semantic ?? 'unknown'}, degraded=${coverage.degraded ?? 'unknown'}). ` +
    'An empty possibleDuplicates list is inconclusive while coverage is degraded. ' +
    'Check the embedding provider, query path, and coverage readings to identify the cause; ' +
    'this alert does not distinguish among them.';
  let knownDegraded = false;
  const recoveredKeys: string[] = [];
  for (const leg of ['lexical', 'semantic'] as const) {
    const status = coverage[leg];
    const conditionKey = prefix + leg;
    if (status === 'ok') {
      recoveredKeys.push(conditionKey);
    } else if (status === 'unavailable' || status === 'partial') {
      knownDegraded = true;
      try {
        const event = { conditionKey, summary, body, oneShot: true };
        if (overrides?.rail?.broadcast) await overrides.rail.broadcast(event);
        else await broadcastSevereEvent(event);
      } catch { /* condition delivery cannot suppress the legacy advisory */ }
    }
  }
  // A degraded verdict with no classified failed leg is still an observation,
  // but only a complete measured two-leg verdict can recover that uncertainty.
  if (coverage.degraded === true && !knownDegraded) {
    try {
      const event = { conditionKey: prefix + 'unknown', summary, body, oneShot: true };
      if (overrides?.rail?.broadcast) await overrides.rail.broadcast(event);
      else await broadcastSevereEvent(event);
    } catch {}
  } else if (coverage.degraded === false && coverage.lexical === 'ok' && coverage.semantic === 'ok') {
    recoveredKeys.push(prefix + 'unknown');
  }
  try { await recoverDedupConditions(recoveredKeys, overrides?.rail); } catch {}
  if (!knownDegraded && coverage.degraded !== true) return;
  try {
    await (overrides?.escalate ?? openEscalation)(IDENTITY, {
      severity: 'advisory',
      summary,
      body,
      meta: { dedupKind: DEDUP_KIND, subjectSignature: SUBJECT_SIGNATURE },
    });
  } catch {
    /* an alarm-send failure must never crash the request worker */
  }
  };
  const next = (pending.get(prefix) ?? Promise.resolve()).catch(() => {}).then(run);
  pending.set(prefix, next);
  try { await next; } finally { if (pending.get(prefix) === next) pending.delete(prefix); }
}


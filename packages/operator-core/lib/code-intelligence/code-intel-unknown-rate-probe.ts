/**
 * Code-intel unknown-rate probe — plan code-intel-delivery-and-outcomes-2026-10-26, P-004 (R-9).
 *
 * Every native code-intel call stores one result status on its own invocation row
 * (`tool_invocations.metadata_json.codeIntelResult`, see `code-intel-result-status.ts`, R-2).
 * This probe judges one window of those rows:
 *
 *  1. RECONCILIATION — every invocation served by the running build must carry exactly one
 *     status row. An invocation with none (the writer missed an exit path) or with two (a
 *     duplicate record for the same call id) is a gap, and any gap alarms. Rows from other
 *     builds are judged only for the share: an older build that predates the writer is not a
 *     defect of the build running the probe.
 *  2. UNKNOWN SHARE — over NON-CANARY calls only (numerator and denominator). Canary calls are
 *     tagged by owner (`CODE_INTEL_CANARY_OWNER`) and counted only by the reconciliation. The
 *     threshold decision is `decideUnknownRateAlarm` (above 20% of at least 50 calls).
 *  3. INJECTED WINDOW — each run also replays a tagged fixture window that is above the
 *     threshold through the SAME reconciliation and decision, so the alarm path is exercised on
 *     every run without waiting for a real breach (D-013). Its alarm goes to a recorder, never
 *     to the fleet-wide severe-event broadcast: a daily fixture page would be noise.
 *
 * The probe is a registered platform instrument (`CODE_INTEL_UNKNOWN_RATE_INSTRUMENT_KEY`) run
 * by the plan's scheduled `rubric-rescore`; each run also writes one `audit_log` observation
 * carrying the build sha, so "the probe has a recorded run within its latest window on the
 * running build" (SPEC-P-004-D) is a read, not a claim.
 */
import {
  CODE_INTEL_UNKNOWN_REASONS,
  UNKNOWN_RATE_MIN_CALLS,
  decideUnknownRateAlarm,
  type CodeIntelUnknownReason,
  type UnknownRateDecision,
} from './code-intel-result-status.ts';
import { NATIVE_CODE_INTEL_TOOLS } from './native-adoption.ts';
import { CODE_INTEL_CANARY_OWNER, type CanaryJudgement } from './code-intel-canary.ts';

export { CODE_INTEL_CANARY_OWNER };

export const CODE_INTEL_UNKNOWN_RATE_INSTRUMENT_KEY = 'code-intel:unknown-rate-probe';
export const UNKNOWN_RATE_PROBE_WINDOW_MS = 24 * 60 * 60_000;
/** The live half grades only with at least this many distinct non-canary owners (D-014). */
export const UNKNOWN_RATE_MIN_OWNERS = 3;
export const UNKNOWN_RATE_PROBE_ACTOR = 'system:code-intel-unknown-rate-probe';
export const UNKNOWN_RATE_PROBE_ACTION = 'code-intel.unknown-rate.probe';

export function unknownRateConditionKey(workspaceId: string, fixture = false): string {
  return `alarm:code-intel-unknown-rate:${workspaceId}${fixture ? ':fixture' : ''}`;
}

/** One `tool_invocations` row as the probe reads it. */
export interface ProbeInvocationRow {
  readonly rowId: string;
  readonly toolName: string;
  readonly ownerId: string | null;
  readonly servingBuildSha: string | null;
  /** `metadata_json.codeIntelResult`, or null when the row has none. */
  readonly status: unknown;
  /** Set only on injected fixture rows. */
  readonly fixture?: boolean;
}

type ParsedStatus = { status: 'measured'; invocationId: string | null } | { status: 'unknown'; reason: CodeIntelUnknownReason; invocationId: string | null };

const REASONS = new Set<string>(CODE_INTEL_UNKNOWN_REASONS);
const NATIVE = new Set<string>(NATIVE_CODE_INTEL_TOOLS);

/** A status that does not parse is treated as absent: an unreadable status is not one status row. */
function parseStatus(value: unknown): ParsedStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const invocationId = typeof v.invocationId === 'string' && v.invocationId.trim() ? v.invocationId : null;
  if (v.status === 'measured') return { status: 'measured', invocationId };
  if (v.status === 'unknown' && typeof v.reason === 'string' && REASONS.has(v.reason)) {
    return { status: 'unknown', reason: v.reason as CodeIntelUnknownReason, invocationId };
  }
  return null;
}

export interface ReconciliationGap {
  readonly invocation: string;
  readonly toolName: string;
  readonly statusRows: number;
}

export interface ProbeReconciliation {
  /** Non-canary calls with a status (each call id counted once). */
  readonly total: number;
  readonly unknown: number;
  readonly owners: number;
  readonly canaryCalls: number;
  readonly unknownByReason: Readonly<Record<string, number>>;
  readonly byTool: Readonly<Record<string, { total: number; unknown: number; gaps: number }>>;
  /** Invocations on the running build without exactly one status row. */
  readonly gaps: readonly ReconciliationGap[];
}

/**
 * Reconcile one window. Rows for non-native tools are ignored. A call is keyed by the call id its
 * status carries; a row without a parseable status is its own call (keyed by row id) with zero
 * status rows. A retried call has a new call id and is a new call.
 */
export function reconcileCodeIntelWindow(
  rows: readonly ProbeInvocationRow[],
  opts: { runningBuildSha: string | null },
): ProbeReconciliation {
  interface Call { toolName: string; ownerId: string | null; canary: boolean; judged: boolean; statuses: ParsedStatus[] }
  const calls = new Map<string, Call>();
  for (const row of rows) {
    if (!NATIVE.has(row.toolName)) continue;
    const parsed = parseStatus(row.status);
    const key = parsed?.invocationId ? `call:${row.toolName}:${parsed.invocationId}` : `row:${row.rowId}`;
    const judged = row.fixture === true || (opts.runningBuildSha !== null && row.servingBuildSha === opts.runningBuildSha);
    const call = calls.get(key) ?? { toolName: row.toolName, ownerId: row.ownerId, canary: row.ownerId === CODE_INTEL_CANARY_OWNER, judged: false, statuses: [] };
    call.judged ||= judged;
    if (parsed) call.statuses.push(parsed);
    calls.set(key, call);
  }

  let total = 0, unknown = 0, canaryCalls = 0;
  const owners = new Set<string>();
  const unknownByReason: Record<string, number> = {};
  const byTool: Record<string, { total: number; unknown: number; gaps: number }> = {};
  for (const tool of NATIVE_CODE_INTEL_TOOLS) byTool[tool] = { total: 0, unknown: 0, gaps: 0 };
  const gaps: ReconciliationGap[] = [];
  for (const [invocation, call] of calls) {
    const tool = byTool[call.toolName] ??= { total: 0, unknown: 0, gaps: 0 };
    if (call.judged && call.statuses.length !== 1) {
      gaps.push({ invocation, toolName: call.toolName, statusRows: call.statuses.length });
      tool.gaps += 1;
    }
    if (call.canary) { canaryCalls += 1; continue; }
    const first = call.statuses[0];
    if (!first) continue;
    total += 1; tool.total += 1;
    if (call.ownerId) owners.add(call.ownerId);
    if (first.status === 'unknown') {
      unknown += 1; tool.unknown += 1;
      unknownByReason[first.reason] = (unknownByReason[first.reason] ?? 0) + 1;
    }
  }
  return { total, unknown, owners: owners.size, canaryCalls, unknownByReason, byTool, gaps };
}

export type ProbeAlarmReason = 'above-threshold' | 'reconciliation-gap';

export interface ProbeDecision {
  readonly alarm: boolean;
  readonly reasons: readonly ProbeAlarmReason[];
  readonly rate: UnknownRateDecision;
  /** A healthy window: within threshold, enough calls, no gaps. Only this clears an open alarm. */
  readonly recovered: boolean;
  /** Enough non-canary calls from enough owners for the live half to be graded (D-014). */
  readonly gradable: boolean;
}

export function decideUnknownRateProbe(recon: ProbeReconciliation): ProbeDecision {
  const rate = decideUnknownRateAlarm({ total: recon.total, unknown: recon.unknown });
  const reasons: ProbeAlarmReason[] = [];
  if (rate.alarm) reasons.push('above-threshold');
  if (recon.gaps.length > 0) reasons.push('reconciliation-gap');
  return {
    alarm: reasons.length > 0,
    reasons,
    rate,
    recovered: reasons.length === 0 && rate.reason === 'within-threshold',
    gradable: recon.total >= UNKNOWN_RATE_MIN_CALLS && recon.owners >= UNKNOWN_RATE_MIN_OWNERS,
  };
}

/**
 * The injected above-threshold window: 50 tagged fixture calls from 3 owners, 11 unknown (22%),
 * plus one canary call that must not move the share. Deterministic, so the expected decision is
 * known: alarm, reason above-threshold, no gaps.
 */
export function aboveThresholdFixtureRows(buildSha: string | null): ProbeInvocationRow[] {
  const owners = ['fixture:owner-a', 'fixture:owner-b', 'fixture:owner-c'];
  const unknownReasons: CodeIntelUnknownReason[] = ['timeout', 'scope-refused', 'partial', 'stale', 'index-missing'];
  const rows: ProbeInvocationRow[] = [];
  for (let i = 0; i < 50; i += 1) {
    const toolName = NATIVE_CODE_INTEL_TOOLS[i % NATIVE_CODE_INTEL_TOOLS.length]!;
    const invocationId = `fixture-${i}`;
    const status = i < 11
      ? { status: 'unknown', reason: unknownReasons[i % unknownReasons.length], invocationId }
      : { status: 'measured', invocationId };
    rows.push({ rowId: `fixture-row-${i}`, toolName, ownerId: owners[i % owners.length]!, servingBuildSha: buildSha, status, fixture: true });
  }
  rows.push({ rowId: 'fixture-row-canary', toolName: 'graph:query', ownerId: CODE_INTEL_CANARY_OWNER, servingBuildSha: buildSha,
    status: { status: 'unknown', reason: 'timeout', invocationId: 'fixture-canary' }, fixture: true });
  return rows;
}

export interface UnknownRateAlarmEvent {
  readonly conditionKey: string;
  readonly summary: string;
  readonly body: string;
}

export interface UnknownRateProbeDeps {
  readRows(window: { workspaceId: string; windowStart: string; windowEnd: string }): Promise<ProbeInvocationRow[]>;
  /** Raise the live alarm (the severe-event rail). Returns whether it was delivered. */
  raise(event: UnknownRateAlarmEvent): Promise<boolean>;
  /** Clear the live alarm after a healthy window. */
  resolve(conditionKey: string): Promise<boolean>;
  /** Record the injected window's alarm. Never the fleet-wide broadcast. */
  raiseFixture(event: UnknownRateAlarmEvent): Promise<boolean>;
  /** Persist the run observation. */
  record(observation: UnknownRateProbeObservation): Promise<void>;
  readonly runningBuildSha: string | null;
  now?(): number;
  /** Live canary (code-intel-canary.ts): forced exit classes through the real dispatcher. */
  runCanary?(): Promise<CanaryJudgement>;
}

export interface ProbeHalf {
  readonly reconciliation: ProbeReconciliation;
  readonly decision: ProbeDecision;
  readonly alarmRaised: boolean;
  readonly alarmCleared: boolean;
}

export interface UnknownRateProbeObservation {
  readonly workspaceId: string;
  readonly buildSha: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly observedAt: string;
  readonly live: ProbeHalf;
  readonly fixture: ProbeHalf;
  /** The canary half; null when the run had no canary dep. */
  readonly canary: CanaryJudgement | null;
  readonly canaryError: string | null;
}

export interface UnknownRateProbeResult {
  readonly verdict: 'pass' | 'fail' | 'unknown';
  readonly detail: string;
  /** Live unknown share in %, when the window had any non-canary calls. */
  readonly value?: number;
  readonly observation: UnknownRateProbeObservation;
}

function alarmEvent(conditionKey: string, workspaceId: string, recon: ProbeReconciliation, decision: ProbeDecision, label: string): UnknownRateAlarmEvent {
  const share = decision.rate.share === null ? 'n/a' : `${(decision.rate.share * 100).toFixed(1)}%`;
  const gapTools = recon.gaps.slice(0, 5).map(g => `${g.toolName}(${g.statusRows} status rows)`).join(', ');
  return {
    conditionKey,
    summary: `Code-intel unknown-rate alarm (${label}): ${decision.reasons.join(' + ')}`,
    body: `workspace ${workspaceId}: unknown ${recon.unknown}/${recon.total} non-canary calls (${share}, threshold >20% of >=${UNKNOWN_RATE_MIN_CALLS}); `
      + `${recon.gaps.length} reconciliation gap(s)${gapTools ? `: ${gapTools}` : ''}; ${recon.canaryCalls} canary call(s) excluded from the share.`,
  };
}

/** Run the probe once: live window, injected window, record, verdict. */
export async function runCodeIntelUnknownRateProbe(
  scope: { workspaceId: string; windowStart: string; windowEnd: string },
  deps: UnknownRateProbeDeps,
): Promise<UnknownRateProbeResult> {
  // The canary runs first so its rows (excluded from the share) show up as canaryCalls.
  let canary: CanaryJudgement | null = null, canaryError: string | null = null;
  if (deps.runCanary) {
    try { canary = await deps.runCanary(); } catch (e) { canaryError = e instanceof Error ? e.message : String(e); }
  }
  const liveKey = unknownRateConditionKey(scope.workspaceId);
  const liveRows = await deps.readRows(scope);
  const liveRecon = reconcileCodeIntelWindow(liveRows, { runningBuildSha: deps.runningBuildSha });
  const liveDecision = decideUnknownRateProbe(liveRecon);
  let liveRaised = false, liveCleared = false;
  if (liveDecision.alarm) liveRaised = await deps.raise(alarmEvent(liveKey, scope.workspaceId, liveRecon, liveDecision, 'live'));
  else if (liveDecision.recovered) liveCleared = await deps.resolve(liveKey);

  const fixtureRecon = reconcileCodeIntelWindow(aboveThresholdFixtureRows(deps.runningBuildSha), { runningBuildSha: deps.runningBuildSha });
  const fixtureDecision = decideUnknownRateProbe(fixtureRecon);
  const fixtureRaised = fixtureDecision.alarm
    ? await deps.raiseFixture(alarmEvent(unknownRateConditionKey(scope.workspaceId, true), scope.workspaceId, fixtureRecon, fixtureDecision, 'injected fixture window'))
    : false;

  const observation: UnknownRateProbeObservation = {
    workspaceId: scope.workspaceId,
    buildSha: deps.runningBuildSha,
    windowStart: scope.windowStart,
    windowEnd: scope.windowEnd,
    observedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    live: { reconciliation: liveRecon, decision: liveDecision, alarmRaised: liveRaised, alarmCleared: liveCleared },
    fixture: { reconciliation: fixtureRecon, decision: fixtureDecision, alarmRaised: fixtureRaised, alarmCleared: false },
    canary,
    canaryError,
  };
  await deps.record(observation);

  const value = liveRecon.total > 0 ? (liveRecon.unknown / liveRecon.total) * 100 : undefined;
  const base = { observation, ...(value === undefined ? {} : { value }) };
  const counts = `live ${liveRecon.unknown}/${liveRecon.total} unknown, ${liveRecon.owners} owner(s), ${liveRecon.gaps.length} gap(s), ${liveRecon.canaryCalls} canary`;
  if (!deps.runningBuildSha) return { ...base, verdict: 'unknown', detail: `Running build identity unavailable; reconciliation cannot be scoped. ${counts}.` };
  if (!fixtureDecision.alarm || !fixtureRaised) {
    return { ...base, verdict: 'fail', detail: `Injected above-threshold window did not produce an alarm (decision ${fixtureDecision.alarm}, recorded ${fixtureRaised}). ${counts}.` };
  }
  if (canaryError) return { ...base, verdict: 'fail', detail: `Canary could not run: ${canaryError}. ${counts}` };
  if (canary && !canary.ok) {
    const bad = canary.cases.filter(c => !c.ok).slice(0, 4).map(c => `${c.toolName}/${c.forced}: ${c.why ?? 'failed'}`).join('; ');
    return { ...base, verdict: 'fail', detail: `Canary: ${canary.failed}/${canary.cases.length} forced exit(s) not recorded as forced (${bad}). ${counts}` };
  }
  if (liveDecision.alarm && !liveRaised) {
    return { ...base, verdict: 'fail', detail: `Live window requires an alarm (${liveDecision.reasons.join(' + ')}) but none was delivered. ${counts}.` };
  }
  if (!liveDecision.gradable) {
    return { ...base, verdict: 'unknown', detail: `Live half not gradable: needs >=${UNKNOWN_RATE_MIN_CALLS} non-canary calls from >=${UNKNOWN_RATE_MIN_OWNERS} owners. Alarm path proven by the injected window. ${counts}.` };
  }
  return { ...base, verdict: 'pass', detail: `Probe ran; live decision ${liveDecision.alarm ? `alarm (${liveDecision.reasons.join(' + ')}), delivered` : liveDecision.rate.reason}; injected window alarmed. ${counts}.` };
}

type AuditSql = { unsafe(query: string, params: unknown[]): Promise<unknown[]> };

async function insertProbeAudit(sql: AuditSql, workspaceId: string, action: string, subject: string, details: unknown): Promise<void> {
  await sql.unsafe(
    `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [`ci-unknown-rate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, Date.now(),
      UNKNOWN_RATE_PROBE_ACTOR, action, subject, JSON.stringify(details), workspaceId],
  );
}

export const UNKNOWN_RATE_FIXTURE_ALARM_ACTION = 'code-intel.unknown-rate.fixture-alarm';

/**
 * The registered instrument's scheduled measurement (run by the plan's `rubric-rescore`). Live
 * alarms ride the severe-event rail and clear through `resolveAlarm`; the injected window's alarm
 * and every run observation are `audit_log` rows stamped with the running build.
 */
export function codeIntelUnknownRateRescore() {
  return {
    windowMs: UNKNOWN_RATE_PROBE_WINDOW_MS,
    unit: '%' as const,
    scope: 'workspace' as const,
    resolve: async (window: { workspaceId: string; windowStart: string; windowEnd: string }) => {
      if (!window.workspaceId.trim()) return { verdict: 'unknown' as const, detail: 'Exact workspace required.' };
      const [{ getOrgPg }, { getBuildInfo }, { broadcastSevereEvent }, { resolveAlarm }] = await Promise.all([
        import('@papercusp/db-org'), import('../build-info'), import('../severe-event-broadcast'), import('../alarm-attention'),
      ]);
      const sql = getOrgPg().sql as unknown as AuditSql;
      const result = await runCodeIntelUnknownRateProbe(window, {
        readRows: w => readCodeIntelProbeRows(sql, w),
        raise: event => broadcastSevereEvent(event),
        resolve: conditionKey => resolveAlarm(conditionKey, 'code-intel-unknown-rate'),
        raiseFixture: async event => {
          await insertProbeAudit(sql, window.workspaceId, UNKNOWN_RATE_FIXTURE_ALARM_ACTION, event.conditionKey, event);
          return true;
        },
        record: observation => insertProbeAudit(sql, window.workspaceId, UNKNOWN_RATE_PROBE_ACTION, CODE_INTEL_UNKNOWN_RATE_INSTRUMENT_KEY, observation),
        runningBuildSha: getBuildInfo().sha ?? null,
        runCanary: async () => {
          const { realCanaryDeps, runCodeIntelCanary } = await import('./code-intel-canary.ts');
          return runCodeIntelCanary(await realCanaryDeps(window.workspaceId));
        },
      });
      return { verdict: result.verdict, detail: result.detail, ...(result.value === undefined ? {} : { value: result.value }) };
    },
  };
}

/** SQL read for the live window. Exported for the instrument and the integration test. */
export async function readCodeIntelProbeRows(
  sql: { unsafe(query: string, params: unknown[]): Promise<unknown[]> },
  window: { workspaceId: string; windowStart: string; windowEnd: string },
): Promise<ProbeInvocationRow[]> {
  const rows = (await sql.unsafe(
    `SELECT id::text AS row_id, tool_name, coord_owner_id, serving_build_sha, metadata_json->'codeIntelResult' AS status
       FROM harness_shared.tool_invocations
      WHERE workspace_id = $1 AND tool_name = ANY($2::text[])
        AND invoked_at >= $3::timestamptz AND invoked_at < $4::timestamptz`,
    [window.workspaceId, [...NATIVE_CODE_INTEL_TOOLS], window.windowStart, window.windowEnd],
  )) as Array<{ row_id: string; tool_name: string; coord_owner_id: string | null; serving_build_sha: string | null; status: unknown }>;
  return rows.map(r => ({ rowId: r.row_id, toolName: r.tool_name, ownerId: r.coord_owner_id, servingBuildSha: r.serving_build_sha, status: r.status ?? null }));
}

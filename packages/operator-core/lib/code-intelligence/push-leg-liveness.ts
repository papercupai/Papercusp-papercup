/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-003 (bar R-1): the standing liveness check.
 *
 * For every ON code-intel signal — each PUSH_LEG_FLAGS leg, the graph:query / lsp:query /
 * code:pack ops, and edit-time symbol capture — it reads eligible triggers from an INDEPENDENT
 * ledger (the plan's ## Design push-leg table), reads outputs from the delivery/result ledgers,
 * decides with liveness.ts and raises one condition per alarmed signal on the severe-event rail
 * (the coord-conditions alarm surface). Eligibility never comes from push-channel.ts counters;
 * only the PUSH_LEG_FLAGS population (the set of legs and their flags) is imported.
 *
 * Disposition: an alarm is cleared here only when the leg is switched OFF, or when the caller
 * supplies a recorded fix time and two consecutive recorded runs show sustained recovery
 * (liveness.ts sustainedRecovery). A single healthy run never clears an alarm.
 *
 * A signal whose eligible count cannot be measured is `cannot-observe`; ON signals in that state
 * share ONE aggregated condition so an unmeasurable source is loud without paging per leg.
 */
import { PUSH_LEG_FLAGS, type PushLegId } from './push-channel';
import {
  LIVENESS_WINDOW_MS, evaluateLiveness, livenessWindowStart, sustainedRecovery,
  type ScheduledSignalRun, type SignalMeasurement, type SignalVerdict,
} from './liveness';

export const CODE_INTEL_LIVENESS_INSTRUMENT_KEY = 'code-intel:liveness-probe';
export const LIVENESS_OPS = ['graph:query', 'lsp:query', 'code:pack'] as const;
export type LivenessOp = (typeof LIVENESS_OPS)[number];
export const SYMBOL_CAPTURE_SIGNAL = 'symbol-capture';
export const LIVENESS_PROBE_ACTOR = 'system:code-intel-liveness-probe';
export const LIVENESS_PROBE_ACTION = 'code-intel.liveness.probe';
/** The plan whose implementer lineage is excluded from the outside-lineage counts. */
export const LIVENESS_SUBJECT_PLAN = 'code-intel-delivery-and-outcomes-2026-10-26';
/** The bar's maximum check interval. */
export const LIVENESS_CHECK_INTERVAL_MS = 24 * 3_600_000;

export function livenessConditionKey(workspaceId: string, signal: string): string {
  return `alarm:code-intel-liveness:${workspaceId}:${signal}`;
}
export function cannotObserveConditionKey(workspaceId: string): string {
  return livenessConditionKey(workspaceId, 'cannot-observe');
}

// ── grep leg eligibility (plan ## Design push-leg table, D-013) ──────────────────────────────

const DECL_KEYWORDS = ['function', 'class', 'interface', 'type', 'const', 'let', 'enum'];
const NOT_A_CALL = new Set([...DECL_KEYWORDS, 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await']);
const IDENT = '[A-Za-z0-9_$]{3,}';

/**
 * The pinned rule: after stripping regex escapes and anchors, the pattern holds a declaration
 * keyword followed by one identifier, or one identifier followed by an opening parenthesis; the
 * identifier is at least 3 characters of letters, digits, _ or $.
 */
export function isDeclarationLookupPattern(pattern: string): boolean {
  const stripped = pattern
    .replace(/\\[bB<>AzZ]/g, '')
    .replace(/\\s[+*?]?/g, ' ')
    .replace(/\\(.)/g, '$1')
    .replace(/[\^$]/g, '');
  const decl = new RegExp(`(?:^|[^A-Za-z0-9_$])(?:${DECL_KEYWORDS.join('|')})\\s+${IDENT}(?![A-Za-z0-9_$])`);
  if (decl.test(stripped)) return true;
  const call = new RegExp(`(?:^|[^A-Za-z0-9_$.])(${IDENT})\\s*\\(`, 'g');
  for (const m of stripped.matchAll(call)) if (!NOT_A_CALL.has(m[1])) return true;
  return false;
}

function shellTokens(segment: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (const m of segment.matchAll(re)) out.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(["\\$`])/g, '$1') : m[3]));
  return out;
}
const VALUE_FLAGS = new Set(['-A', '-B', '-C', '-m', '-g', '-t', '-T', '--glob', '--type', '--type-not', '--include', '--exclude', '--exclude-dir', '--max-count', '-f', '--file', '-d', '--max-depth']);

/** The search pattern a grep/rg/git-grep command line looks up, or null if it runs no search. */
export function searchPatternOf(command: string): string | null {
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const tokens = shellTokens(segment.trim());
    let i = tokens.findIndex(t => /^(?:.*\/)?(grep|egrep|fgrep|rg)$/.test(t));
    if (i < 0) {
      const git = tokens.indexOf('git');
      const g = git >= 0 ? tokens.indexOf('grep', git + 1) : -1;
      if (g < 0) continue;
      i = g;
    }
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t === '-e' || t === '--regexp') return tokens[j + 1] ?? null;
      if (t.startsWith('--regexp=')) return t.slice('--regexp='.length);
      if (t === '--') return tokens[j + 1] ?? null;
      if (t.startsWith('-')) { if (VALUE_FLAGS.has(t)) j++; continue; }
      return t;
    }
  }
  return null;
}

/** One agent_activity search row: a Bash command line or a Grep tool pattern. */
export function isEligibleGrepRow(row: { command?: string | null; pattern?: string | null }): boolean {
  const pattern = row.pattern ?? (row.command ? searchPatternOf(row.command) : null);
  return pattern !== null && isDeclarationLookupPattern(pattern);
}

// ── the probe ────────────────────────────────────────────────────────────────────────────────

export interface MeasureWindow { workspaceId: string; start: number; end: number }
export interface SignalCounts {
  eligible: number | null;
  outputs: number | null;
  outsideLineageOutputs: number | null;
  eligibleLineages?: number | null;
  eligibleMutations?: number | null;
  allTrackedMutations?: number | null;
}
export interface LivenessAlarmEvent { conditionKey: string; summary: string; body: string }
export interface LivenessObservation {
  workspaceId: string;
  buildSha: string | null;
  observedAt: string;
  verdicts: SignalVerdict[];
  raised: string[];
  resolved: string[];
}
export interface LivenessProbeDeps {
  enabled(flag: string): Promise<boolean>;
  /** Epoch ms the flag last went ON (or the window start when it was ON throughout); null = unmeasured. */
  flagOnAt(flag: string, now: number): Promise<number | null>;
  measureLeg(leg: PushLegId, window: MeasureWindow): Promise<SignalCounts>;
  measureOp(op: LivenessOp, window: MeasureWindow): Promise<SignalCounts>;
  measureSymbolCapture?(window: MeasureWindow): Promise<SignalCounts>;
  raise(event: LivenessAlarmEvent): Promise<boolean>;
  resolve(conditionKey: string): Promise<boolean>;
  record(observation: LivenessObservation): Promise<void>;
  /** Prior scheduled runs for one signal and its recorded fix time; enables sustained-recovery disposition. */
  recovery?(signal: string): Promise<{ runs: ScheduledSignalRun[]; fixedAt: number | null } | null>;
  readonly runningBuildSha: string | null;
  now?(): number;
}
export interface LivenessProbeResult {
  verdict: 'pass' | 'fail' | 'unknown';
  detail: string;
  value: number;
  observation: LivenessObservation;
}

/** Legs that must be live for a healthy grade (R-1). */
export const REQUIRED_LIVE_LEGS: readonly PushLegId[] = ['first-touch', 'resume', 'interface'];

const fmtRatio = (v: SignalVerdict) => (v.ratio === null ? 'n/a' : v.ratio.toFixed(3));
const iso = (ms: number) => new Date(ms).toISOString();

export function livenessAlarmEvent(workspaceId: string, v: SignalVerdict): LivenessAlarmEvent {
  return {
    conditionKey: livenessConditionKey(workspaceId, v.signal),
    summary: `Code-intel liveness alarm: ${v.signal} — ${v.reason}`,
    body: `workspace ${workspaceId}: signal ${v.signal}; eligible triggers ${v.eligible ?? 'unknown'}, outputs ${v.outputs ?? 'unknown'}, `
      + `delivery ratio ${fmtRatio(v)} over ${iso(v.windowStart)}..${iso(v.windowEnd)}`
      + (v.mutationShare === null ? '' : `; eligible share of tracked mutations ${v.mutationShare.toFixed(3)}`) + '.',
  };
}

/** Run the check once over the current window: measure, decide, raise/resolve, record. */
export async function runPushLegLivenessProbe(workspaceId: string, deps: LivenessProbeDeps): Promise<LivenessProbeResult> {
  const now = deps.now?.() ?? Date.now();
  const fullStart = now - LIVENESS_WINDOW_MS;
  const measurements: SignalMeasurement[] = [];
  const unknownCounts = { eligible: null, outputs: null, outsideLineageOutputs: null };
  for (const [leg, flag] of Object.entries(PUSH_LEG_FLAGS) as Array<[PushLegId, string]>) {
    const enabled = await deps.enabled(flag);
    if (!enabled) { measurements.push({ signal: leg, kind: 'push', enabled, windowStart: fullStart, windowEnd: now, ...unknownCounts }); continue; }
    const onAt = await deps.flagOnAt(flag, now);
    if (onAt === null || !Number.isFinite(onAt) || onAt > now) {
      measurements.push({ signal: leg, kind: 'push', enabled, windowStart: NaN, windowEnd: now, ...unknownCounts });
      continue;
    }
    const start = livenessWindowStart(now, onAt);
    measurements.push({ signal: leg, kind: 'push', enabled, windowStart: start, windowEnd: now, ...(await deps.measureLeg(leg, { workspaceId, start, end: now })) });
  }
  for (const op of LIVENESS_OPS) {
    measurements.push({ signal: op, kind: 'op', enabled: true, windowStart: fullStart, windowEnd: now, ...(await deps.measureOp(op, { workspaceId, start: fullStart, end: now })) });
  }
  if (deps.measureSymbolCapture) {
    measurements.push({ signal: SYMBOL_CAPTURE_SIGNAL, kind: 'symbol-capture', enabled: true, windowStart: fullStart, windowEnd: now,
      ...(await deps.measureSymbolCapture({ workspaceId, start: fullStart, end: now })) });
  }
  const verdicts = evaluateLiveness(measurements);
  const enabledBySignal = new Map(measurements.map(m => [m.signal, m.enabled]));
  const raised: string[] = [];
  const resolved: string[] = [];
  for (const v of verdicts) {
    const key = livenessConditionKey(workspaceId, v.signal);
    if (v.status === 'alarm') {
      if (await deps.raise(livenessAlarmEvent(workspaceId, v))) raised.push(key);
    } else if (v.status === 'off') {
      if (await deps.resolve(key)) resolved.push(key);
    } else if (v.status === 'healthy' && deps.recovery) {
      const history = await deps.recovery(v.signal);
      const current: ScheduledSignalRun = { sequence: (history?.runs.reduce((n, r) => Math.max(n, r.sequence), -1) ?? -1) + 1, scheduledAt: now, succeeded: true, verdict: v };
      if (history && history.fixedAt !== null && sustainedRecovery([...history.runs, current], history.fixedAt)
        && await deps.resolve(key)) resolved.push(key);
    }
  }
  const blind = verdicts.filter(v => v.status === 'cannot-observe' && enabledBySignal.get(v.signal));
  if (blind.length) {
    const key = cannotObserveConditionKey(workspaceId);
    const ok = await deps.raise({
      conditionKey: key,
      summary: `Code-intel liveness cannot observe ${blind.length} ON signal(s): ${blind.map(v => v.signal).join(', ')}`,
      body: `workspace ${workspaceId}: ${blind.map(v => `${v.signal} (${v.reason})`).join('; ')}. An unmeasured signal fails R-1; it never passes as healthy.`,
    });
    if (ok) raised.push(key);
  }
  const observation: LivenessObservation = { workspaceId, buildSha: deps.runningBuildSha, observedAt: iso(now), verdicts, raised, resolved };
  await deps.record(observation);
  const alarmed = verdicts.filter(v => v.status === 'alarm');
  const healthy = new Set(verdicts.filter(v => v.status === 'healthy').map(v => v.signal));
  const verdict = alarmed.length || blind.length ? 'fail' as const
    : REQUIRED_LIVE_LEGS.every(l => healthy.has(l)) ? 'pass' as const : 'unknown' as const;
  const detail = `${alarmed.length} alarm(s)${alarmed.length ? `: ${alarmed.map(v => `${v.signal} eligible=${v.eligible} outputs=${v.outputs}`).join(', ')}` : ''}; `
    + `${blind.length} cannot-observe${blind.length ? `: ${blind.map(v => v.signal).join(', ')}` : ''}; healthy: ${[...healthy].join(', ') || 'none'}.`;
  return { verdict, detail, value: alarmed.length + blind.length, observation };
}

// ── Postgres readers (the independent sources) ───────────────────────────────────────────────

type Sql = { unsafe(query: string, params: unknown[]): Promise<unknown[]> };
const CODE_FILE = '\\.(ts|tsx|mts|cts|js|mjs|cjs)$';
const TS_FILE = '\\.(ts|tsx|mts|cts)$';
const READ_EDIT_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'mcp__papercusp-su__capability_read', 'mcp__papercusp-su__capability_edit', 'mcp__papercusp-su__capability_write'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'mcp__papercusp-su__capability_edit', 'mcp__papercusp-su__capability_write'];
/** Calls that put a work item in the caller's hands. */
export const CLAIM_TOOLS = ['work_items:claim', 'work_items:claim_next', 'scheduler:get_next', 'plan_items:claim', 'work_items:create'];
const CANARY_OWNER = 'system:code-intel-canary';

async function one(sql: Sql, query: string, params: unknown[]): Promise<Record<string, unknown>> {
  return ((await sql.unsafe(query, params)) as Array<Record<string, unknown>>)[0] ?? {};
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Bound readers for one workspace. `implementerOwners` are excluded from outside-lineage outputs. */
export function pgLivenessReaders(sql: Sql, implementerOwners: readonly string[]) {
  const impl = [...implementerOwners];
  const pushOutputs = async (leg: string, w: MeasureWindow) => {
    const r = await one(sql, `SELECT count(*) AS n, count(*) FILTER (WHERE owner_id <> ALL($5::text[])) AS outside
        FROM harness_shared.code_intel_pushes WHERE workspace_id = $1 AND leg = $2 AND pushed_at >= $3 AND pushed_at < $4`,
      [w.workspaceId, leg, iso(w.start), iso(w.end), impl]);
    return { outputs: num(r.n), outsideLineageOutputs: num(r.outside) };
  };
  const claimedTouches = async (w: MeasureWindow, predicate: string): Promise<number> => {
    const r = await one(sql, `WITH claims AS (
          SELECT coord_owner_id AS owner, invoked_at FROM harness_shared.tool_invocations
           WHERE workspace_id = $1 AND tool_name = ANY($4::text[]) AND invoked_at >= $2::timestamptz - interval '1 day' AND invoked_at < $3)
        SELECT count(*) AS n FROM (SELECT DISTINCT a.owner_id, coalesce(a.detail->>'file', a.session_id) AS k
          FROM harness_shared.agent_activity a
         WHERE a.workspace_id = $1 AND a.created_at >= $2 AND a.created_at < $3 AND ${predicate}
           AND EXISTS (SELECT 1 FROM claims c WHERE c.owner = a.owner_id AND c.invoked_at <= a.created_at AND c.invoked_at > a.created_at - interval '1 day')) t`,
      [w.workspaceId, iso(w.start), iso(w.end), CLAIM_TOOLS, READ_EDIT_TOOLS]);
    return Number(r.n ?? 0);
  };
  const eligibleFor: Record<PushLegId, (w: MeasureWindow) => Promise<Partial<SignalCounts>>> = {
    grep: async w => {
      const rows = (await sql.unsafe(`SELECT detail->>'command' AS command, detail->>'pattern' AS pattern FROM harness_shared.agent_activity
          WHERE workspace_id = $1 AND kind = 'tool' AND phase = 'post' AND created_at >= $2 AND created_at < $3
            AND (tool_name = 'Grep' OR (tool_name = 'Bash' AND detail->>'command' ~ '(^|[|;&(\\s])(grep|egrep|rg)\\s'))`,
        [w.workspaceId, iso(w.start), iso(w.end)])) as Array<{ command: string | null; pattern: string | null }>;
      return { eligible: rows.filter(isEligibleGrepRow).length };
    },
    'first-touch': async w => ({ eligible: await claimedTouches(w, `a.kind = 'tool' AND a.phase = 'post' AND a.tool_name = ANY($5::text[]) AND a.detail->>'file' ~ '${CODE_FILE}'`) }),
    resume: async w => ({ eligible: await claimedTouches(w, `a.kind = 'lifecycle' AND a.summary LIKE '▶ session started%' AND $5::text[] IS NOT NULL`) }),
    interface: async w => {
      const r = await one(sql, `SELECT count(*) FILTER (WHERE signal_eligibility->'interface'->>'verdict' = 'eligible'
              AND jsonb_array_length(coalesce(signal_eligibility->'interface'->'peerEvidence'->'peers', '[]'::jsonb)) > 0) AS eligible,
            count(*) FILTER (WHERE signal_eligibility ? 'interface') AS observed, count(*) AS tracked
          FROM harness_shared.edit_attribution_ledger WHERE workspace_id = $1 AND ts >= $2 AND ts < $3`,
        [w.workspaceId, iso(w.start), iso(w.end)]);
      // No observed journal row means the edit-time detector is not writing: unmeasured, not zero.
      const eligible = Number(r.observed ?? 0) > 0 ? num(r.eligible) : null;
      return { eligible, eligibleMutations: eligible, allTrackedMutations: num(r.tracked) };
    },
    completion: async w => ({ eligible: num((await one(sql, `SELECT count(*) AS n FROM harness_shared.tool_invocations
        WHERE workspace_id = $1 AND tool_name = 'work_items:complete' AND error_code IS NULL AND invoked_at >= $2 AND invoked_at < $3`,
      [w.workspaceId, iso(w.start), iso(w.end)])).n) }),
    antipattern: async w => ({ eligible: num((await one(sql, `SELECT count(*) AS n FROM harness_shared.agent_activity
        WHERE workspace_id = $1 AND kind = 'tool' AND phase = 'post' AND tool_name = ANY($4::text[]) AND detail->>'file' ~ '${TS_FILE}'
          AND detail->>'file' !~ '(^|/)node_modules/' AND created_at >= $2 AND created_at < $3`,
      [w.workspaceId, iso(w.start), iso(w.end), EDIT_TOOLS])).n) }),
    intent: async w => ({ eligible: num((await one(sql, `SELECT count(*) AS n FROM harness_shared.tool_invocations
        WHERE workspace_id = $1 AND tool_name = 'coord:declare-intent' AND invoked_at >= $2 AND invoked_at < $3
          AND jsonb_typeof(args_json->'current_files') = 'array' AND jsonb_array_length(args_json->'current_files') > 0`,
      [w.workspaceId, iso(w.start), iso(w.end)])).n) }),
    // No independent ledger records these triggers yet: unmeasured (cannot-observe), never zero.
    incident: async () => ({ eligible: null }),
    clone: async () => ({ eligible: null }),
    notes: async () => ({ eligible: null }),
  };
  return {
    measureLeg: async (leg: PushLegId, w: MeasureWindow): Promise<SignalCounts> => {
      const [e, o] = await Promise.all([eligibleFor[leg](w), pushOutputs(leg, w)]);
      return { eligible: e.eligible ?? null, ...o, eligibleMutations: e.eligibleMutations, allTrackedMutations: e.allTrackedMutations };
    },
    measureOp: async (op: LivenessOp, w: MeasureWindow): Promise<SignalCounts> => {
      const r = await one(sql, `SELECT count(*) AS calls,
            count(*) FILTER (WHERE metadata_json->'codeIntelResult'->>'status' = 'measured') AS measured,
            count(*) FILTER (WHERE metadata_json->'codeIntelResult'->>'status' = 'measured' AND coord_owner_id <> ALL($5::text[])) AS outside
          FROM harness_shared.tool_invocations WHERE workspace_id = $1 AND tool_name = $2 AND invoked_at >= $3 AND invoked_at < $4
            AND coord_owner_id IS DISTINCT FROM '${CANARY_OWNER}'`,
        [w.workspaceId, op, iso(w.start), iso(w.end), impl]);
      return { eligible: num(r.calls), outputs: num(r.measured), outsideLineageOutputs: num(r.outside) };
    },
    measureSymbolCapture: async (w: MeasureWindow): Promise<SignalCounts> => {
      const r = await one(sql, `SELECT count(*) AS eligible, count(*) FILTER (WHERE symbols IS NOT NULL) AS captured,
            count(DISTINCT agent_id) AS lineages
          FROM harness_shared.edit_attribution_ledger WHERE workspace_id = $1 AND ts >= $2 AND ts < $3 AND file ~ '${TS_FILE}'
            AND agent_id IS NOT NULL AND agent_id <> ALL($4::text[])`,
        [w.workspaceId, iso(w.start), iso(w.end), impl]);
      return { eligible: num(r.eligible), outputs: num(r.captured), outsideLineageOutputs: num(r.captured), eligibleLineages: num(r.lineages) };
    },
  };
}

/** Flag-on time: an override's last write when the flag is overridden ON, else ON throughout the window. */
export async function overrideFlagOnAt(sql: Sql, workspaceId: string, flag: string, now: number): Promise<number | null> {
  const r = await one(sql, `SELECT payload->$2 AS v, updated_at FROM harness_shared.operator_flag_overrides WHERE workspace_id = $1`, [workspaceId, flag]);
  const v = r.v as unknown;
  const overriddenOn = v === true || (typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === true);
  const at = Number(r.updated_at);
  return overriddenOn && Number.isFinite(at) && at <= now ? Math.max(at, now - LIVENESS_WINDOW_MS) : now - LIVENESS_WINDOW_MS;
}

async function insertAudit(sql: Sql, workspaceId: string, subject: string, details: unknown): Promise<void> {
  await sql.unsafe(`INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
  [`ci-liveness-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, Date.now(),
    LIVENESS_PROBE_ACTOR, LIVENESS_PROBE_ACTION, subject, JSON.stringify(details), workspaceId]);
}

/** The registered instrument's scheduled measurement (run by the plan's rubric-rescore). */
export function codeIntelLivenessRescore() {
  return {
    windowMs: LIVENESS_WINDOW_MS,
    unit: 'count' as const,
    scope: 'workspace' as const,
    resolve: async (window: { workspaceId: string; windowStart: string; windowEnd: string }) => {
      if (!window.workspaceId.trim()) return { verdict: 'unknown' as const, detail: 'Exact workspace required.' };
      const [{ getOrgPg }, { getBuildInfo }, { broadcastSevereEvent }, { resolveAlarm }, { getFlag }, { resolvePlanImplementerIdentities }] = await Promise.all([
        import('@papercusp/db-org'), import('../build-info'), import('../severe-event-broadcast'), import('../alarm-attention'), import('@papercusp/flags/server'),
        import('../acceptance-author-identity'),
      ]);
      const sql = getOrgPg().sql as unknown as Sql;
      // WI-6554700010030221: the lineage comes from the shared, real-PG-tested resolver
      // (taken_by / terminal_owner / last_released_by / worked_by_history / auditors /
      // editors), never a hand-written work_items query — the previous one selected a
      // non-existent `assignee` column and threw 42703 on every scheduled rescore, so the
      // instrument never wrote a single probe row. Whole-plan lineage is a superset of the
      // P-002/P-003/P-007 holders: stricter, so it can only make a dead leg alarm sooner.
      const implementers = await resolvePlanImplementerIdentities(LIVENESS_SUBJECT_PLAN, { workspaceId: window.workspaceId });
      const readers = pgLivenessReaders(sql, [...implementers, CANARY_OWNER]);
      const result = await runPushLegLivenessProbe(window.workspaceId, {
        enabled: flag => getFlag(flag as never, 'system').then(Boolean).catch(() => false),
        flagOnAt: (flag, now) => overrideFlagOnAt(sql, window.workspaceId, flag, now),
        ...readers,
        raise: event => broadcastSevereEvent(event),
        resolve: conditionKey => resolveAlarm(conditionKey, 'code-intel-liveness'),
        record: observation => insertAudit(sql, window.workspaceId, CODE_INTEL_LIVENESS_INSTRUMENT_KEY, observation),
        runningBuildSha: getBuildInfo().sha ?? null,
      });
      return { verdict: result.verdict, detail: result.detail, value: result.value };
    },
  };
}

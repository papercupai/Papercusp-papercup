/**
 * Tool-latency-budget detector (WI-10005730, residue of WI-10005670).
 *
 * WHY: a MUTATING tool whose handler routinely runs close to its dispatch timeout will, on its
 * slow tail, finish AFTER the abort fires. The write has committed, but the caller receives a
 * bare `timeout` ("handler returned but signal had aborted") and cannot tell — the
 * commit-unknown failure that WI-10005670 (abort-completion receipts) and WI-10005718
 * (`work_items:create` landing unassigned) both traced to. An idempotent-completion contract or
 * receipt closes that ambiguity; THIS detector finds the next unsafe write sliding toward the
 * cliff BEFORE timeouts pile up, by comparing its measured p95 with its own budget.
 *
 * The budget is the dispatcher's own: `exec.timeoutSec = exec.tool.timeoutSec ?? 60`
 * (libs/generic/tooldef/src/dispatch-stack.ts). The default is mirrored here as
 * {@link TOOL_LATENCY_DEFAULT_BUDGET_SEC} — a tool that declares no `timeoutSec` is judged
 * against the same 60s the dispatcher will actually abort it at.
 *
 * Split on purpose: this module is PURE (rows + budgets in, signals out) so the threshold
 * calibration is unit-testable without a database or the full tool registry. The SQL
 * aggregate and the lazy registry read live in `collectToolErrorSignals` (watchdog.ts).
 */
import type { WatchdogSignal } from './watchdog';

/** Mirrors dispatch-stack.ts `exec.tool.timeoutSec ?? 60` — the budget a tool without `timeoutSec` is aborted at. */
export const TOOL_LATENCY_DEFAULT_BUDGET_SEC = 60;
/** A write tool is flagged when its p95 STRICTLY exceeds this fraction of its budget. */
export const TOOL_LATENCY_BUDGET_RATIO = 0.8;
/** Below this many samples a p95 is just "the max of a handful" — not evidence. */
export const TOOL_LATENCY_MIN_SAMPLES = 20;

// A dispatch timeout is a correctness boundary, not an acceptable interactive
// response time. Start with the completion API implicated by EI-27984315103577037;
// deliberately long-running tools (tests, builds) must not inherit this SLO.
export const TOOL_REQUEST_LATENCY_LIMITS = {
  'work_items:complete': { p95Ms: 20_000, outlierMs: 50_000 },
} as const;

export interface ToolRequestLatencyRow extends ToolLatencyRow {
  peak_ms: number | string | null;
  peak_invocation_id: string;
}

export interface ToolLatencyBudget {
  /** Declared `timeoutSec`; null/undefined/non-positive = the dispatcher default applies. */
  timeoutSec?: number | null;
  /** Only ambiguous `'write'` completions are judged: a slow read has no commit-unknown risk. */
  effect?: string | null;
  /** A completed idempotent mutation is returned as success past its deadline by dispatch. */
  idempotent?: boolean;
  /**
   * The tool declares an `abortCompletionReceipt` (WI-10005670): a late return is already
   * reported as recorded, so the commit-unknown hazard this detector exists to find is closed.
   * Such a tool is NOT judged — flagging it would re-file a mitigated risk.
   */
  hasAbortCompletionReceipt?: boolean;
}

/** One per-tool aggregate row from `harness_shared.tool_invocations` (SQL shapes numbers as text sometimes). */
export interface ToolLatencyRow {
  tool_name: string;
  n: number | string;
  p95_ms: number | string | null;
  latest_at?: string | Date | null;
  earliest_at?: string | Date | null;
}

export interface ToolLatencyOptions {
  /** Fraction of the budget above which a write tool's p95 is flagged. Default 0.8. */
  toolLatencyRatio?: number;
  /** Minimum sample count before a p95 counts. Default 20. */
  toolLatencyMinSamples?: number;
  /** Window the aggregate covers, for the signal body only. Default 24. */
  toolLatencyWindowHours?: number;
}

/** Structural view of a projected tool — only the three fields this detector reads. */
export interface ProjectedToolLike {
  expose?: { mcp?: { name?: string | null } | null } | null;
  timeoutSec?: number | null;
  effect?: string | null;
  idempotent?: boolean;
  /** A resolver function when the tool declares one (see {@link ToolLatencyBudget.hasAbortCompletionReceipt}). */
  abortCompletionReceipt?: unknown;
}

/** Effective dispatch budget in seconds, exactly as the dispatcher resolves it. */
export function effectiveToolBudgetSec(budget: ToolLatencyBudget | undefined): number {
  const declared = budget?.timeoutSec;
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
    ? declared
    : TOOL_LATENCY_DEFAULT_BUDGET_SEC;
}

/**
 * Build the tool-name → budget map from the projected tool registry. Keyed by the MCP name
 * (`scorecards:emit`), which is what `tool_invocations.tool_name` records. Tools with no MCP
 * exposure have no ledger rows under a stable name and are skipped.
 */
export function toolLatencyBudgetsFromProjected(
  tools: Iterable<ProjectedToolLike>,
): Map<string, ToolLatencyBudget> {
  const out = new Map<string, ToolLatencyBudget>();
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    out.set(name, {
      timeoutSec: tool.timeoutSec ?? null,
      effect: tool.effect ?? null,
      ...(tool.idempotent === true ? { idempotent: true } : {}),
      hasAbortCompletionReceipt: typeof tool.abortCompletionReceipt === 'function',
    });
  }
  return out;
}

/** True for a write tool whose late completion is not already safe to surface or recover. */
function isJudged(budget: ToolLatencyBudget | undefined): budget is ToolLatencyBudget {
  return budget?.effect === 'write' && budget.idempotent !== true && budget.hasAbortCompletionReceipt !== true;
}

/** Names of the judged tools (write, no idempotent completion or receipt) — the risky SQL population. */
export function writeToolNames(budgets: ReadonlyMap<string, ToolLatencyBudget>): string[] {
  const names: string[] = [];
  for (const [name, budget] of budgets) if (isJudged(budget)) names.push(name);
  return names.sort();
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function toIso(value: string | Date | null | undefined): string | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Successful/idempotent completions can still keep a ready answer waiting.
 * Judge full request latency independently of the late-write safety detector.
 * A severe single request is actionable even when p95 hides it among fast calls. */
export function toolRequestLatencySignalsFromRows(rows: readonly ToolRequestLatencyRow[]): WatchdogSignal[] {
  const signals: WatchdogSignal[] = [];
  for (const row of rows) {
    const limits = Object.entries(TOOL_REQUEST_LATENCY_LIMITS).find(([name]) => name === row.tool_name)?.[1];
    if (!limits) continue;
    const n = toNumber(row.n);
    const p95Ms = toNumber(row.p95_ms);
    const peakMs = toNumber(row.peak_ms);
    if (n == null || n < 1 || peakMs == null || peakMs < 0) continue;
    const severe = peakMs >= limits.outlierMs;
    const chronic = n >= TOOL_LATENCY_MIN_SAMPLES && p95Ms != null && p95Ms >= limits.p95Ms;
    if (!severe && !chronic) continue;
    signals.push({
      source: 'repeated-tool-error',
      key: `tool-request-latency:${row.tool_name}`,
      title: `Tool ${row.tool_name} exceeds its interactive request latency budget`,
      body: `Watchdog signal (tool-request-latency): \`${row.tool_name}\` measured peak ` +
        `${Math.round(peakMs)}ms (invocation ${row.peak_invocation_id}), p95 ` +
        `${p95Ms == null ? 'unknown' : `${Math.round(p95Ms)}ms`} over ${n} calls. ` +
        `Thresholds: p95 >= ${limits.p95Ms}ms with >= ${TOOL_LATENCY_MIN_SAMPLES} samples, ` +
        `or any request >= ${limits.outlierMs}ms.\n\n` +
        `Timing uses the greater of dispatch duration and recorded MCP request settlement elapsedMs; ` +
        `without request telemetry it is a dispatch-only lower bound. Successful calls and ` +
        `idempotent mutations are included. Inspect that invocation's pre-dispatch, dispatch and ` +
        `handler phases before diagnosing the cause. Reduce measured critical-path work, preserve ` +
        `authorization/completion checks, add a regression test and verify current-build timing. ` +
        `Raising the timeout or making retries safe does not resolve this latency finding.`,
      severity: severe ? 'major' : 'minor',
      kind: 'bug',
      latestAt: toIso(row.latest_at),
      earliestAt: toIso(row.earliest_at),
      findingClass: 'tool-request-latency',
    });
  }
  return signals.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Pure detector. One signal per write tool whose p95 STRICTLY exceeds `ratio × budget`.
 * Strict, so exactly-at-threshold is quiet; read tools, tools missing from `budgets`
 * (unknown budget ⇒ cannot judge), and thin samples are never flagged.
 */
export function toolLatencyBudgetSignalsFromRows(
  rows: readonly ToolLatencyRow[],
  budgets: ReadonlyMap<string, ToolLatencyBudget>,
  opts: ToolLatencyOptions = {},
): WatchdogSignal[] {
  const ratio = opts.toolLatencyRatio ?? TOOL_LATENCY_BUDGET_RATIO;
  const minSamples = opts.toolLatencyMinSamples ?? TOOL_LATENCY_MIN_SAMPLES;
  const windowHours = opts.toolLatencyWindowHours ?? 24;
  const signals: WatchdogSignal[] = [];

  for (const row of rows) {
    const budget = budgets.get(row.tool_name);
    if (!isJudged(budget)) continue;
    const n = toNumber(row.n);
    const p95Ms = toNumber(row.p95_ms);
    if (n == null || p95Ms == null || n < minSamples) continue;

    const budgetSec = effectiveToolBudgetSec(budget);
    const budgetMs = budgetSec * 1000;
    if (!(p95Ms > ratio * budgetMs)) continue;

    const usedPct = Math.round((p95Ms / budgetMs) * 100);
    const declared = typeof budget.timeoutSec === 'number' && budget.timeoutSec > 0;
    // Already at/over the budget = the tail is being aborted NOW; below it = approaching.
    const severity = p95Ms >= budgetMs ? 'major' : 'minor';
    signals.push({
      source: 'repeated-tool-error',
      key: `tool-latency-budget:${row.tool_name}`,
      // STABLE title — counts, percentages and timestamps live in the body so search-first
      // dedup matches this tool's finding across ticks.
      title: `Mutating tool ${row.tool_name} runs near its dispatch timeout budget (late-return risk)`,
      body:
        `Watchdog signal (tool-latency-budget): write tool \`${row.tool_name}\` measured p95 ` +
        `${Math.round(p95Ms)}ms over ${n} calls in the last ${windowHours}h — ${usedPct}% of its ` +
        `${budgetSec}s dispatch budget (${declared ? 'declared timeoutSec' : 'dispatcher default'}; ` +
        `flag threshold ${Math.round(ratio * 100)}%).\n\n` +
        `Why it matters: when a write handler finishes AFTER the abort fires, the write has ` +
        `committed but the caller sees a bare \`timeout\` ("handler returned but signal had aborted") ` +
        `and a retry duplicates the effect. Remedies, best first: (1) shorten the handler ` +
        `(move slow reads/fan-out off the critical path); (2) give the tool an ` +
        `\`abortCompletionReceipt\` so a late return is reported as recorded ` +
        `(see agent-tools/abort-completion-coverage.test.ts); (3) raise \`timeoutSec\` only if ` +
        `the long run is intended.`,
      severity,
      kind: 'bug',
      latestAt: toIso(row.latest_at),
      earliestAt: toIso(row.earliest_at),
      findingClass: 'tool-latency-budget',
    });
  }
  // Deterministic order (by key) so a tick's output is stable across row-order changes.
  return signals.sort((a, b) => a.key.localeCompare(b.key));
}

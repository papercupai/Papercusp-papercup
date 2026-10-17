/**
 * Native code-intelligence adoption instrument
 * (native-code-intelligence-ecosystem-and-dream-2026-10-09 P-033 / R-30, R-31; plan D-009).
 *
 * Answers "is the native code-intelligence plane (graph:query, lsp:query, code:pack) actually
 * used, and used well?" from the ledgers the deployed operator already writes — never from a
 * hand-written query:
 *
 *   - `harness_shared.tool_invocations` — every MCP call: native ops, direct `gitnexus.*` calls
 *     (the substitute the native plane replaces), status/error class, role, latency.
 *   - `harness_shared.agent_activity` — every client tool call, including shell commands
 *     (`detail.command` / `detail.cmd`), which is where raw-text definition and call-site
 *     lookups (grep/rg) live, and file reads/edits (`detail.file`), the follow-through proxy.
 *
 * Reuses the platform-instrument seam: the keys below are registered in
 * rubric-instrument-registry.ts (platformComputedInstrumentKeys) and resolved in-process by
 * scorecards.ts, so a rubric criterion binds them like the holder-behavior / gate-reuse keys.
 *
 * The reader is a two-step read on purpose: step 1 is an index-only scan of
 * `tool_invocations_invoked_at_cov_idx` (invoked_at INCLUDE tool_name) for the matching
 * timestamps; step 2 fetches the full rows by exact timestamp. A single filtered query with a
 * workspace predicate lets the planner skip-scan the telemetry index instead and read ~2M heap
 * rows for a 3-day window (measured 2026-10-14: 15.3 s vs 0.31 s).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export const NATIVE_ADOPTION_VERSION = 1;

/** One instrument key per acceptance criterion (R-30 measured, R-31 good use). */
export const NATIVE_ADOPTION_INSTRUMENT_KEYS = Object.freeze({
  measured: 'code-intel:native-adoption-measured',
  goodUse: 'code-intel:native-adoption-good-use',
} as const);
export type NativeAdoptionCriterion = keyof typeof NATIVE_ADOPTION_INSTRUMENT_KEYS;

export function nativeAdoptionCriterionForInstrument(key: string): NativeAdoptionCriterion | null {
  for (const [criterion, instrumentKey] of Object.entries(NATIVE_ADOPTION_INSTRUMENT_KEYS)) {
    if (instrumentKey === key) return criterion as NativeAdoptionCriterion;
  }
  return null;
}

/** P-041 measurement criteria, separate from the frozen D-011 adoption target. */
export const NATIVE_PUSH_INSTRUMENT_KEYS = Object.freeze({
  issued: 'code-intel:native-push-issued-measured',
  actedOn: 'code-intel:native-push-acted-on-measured',
  grepAfterPush: 'code-intel:native-push-grep-after-measured',
} as const);
export type NativePushCriterion = keyof typeof NATIVE_PUSH_INSTRUMENT_KEYS;
export function nativePushCriterionForInstrument(key: string): NativePushCriterion | null {
  return (Object.keys(NATIVE_PUSH_INSTRUMENT_KEYS) as NativePushCriterion[])
    .find(criterion => NATIVE_PUSH_INSTRUMENT_KEYS[criterion] === key) ?? null;
}

/** The native code-intelligence MCP operations this plan ships. */
export const NATIVE_CODE_INTEL_TOOLS: readonly string[] = Object.freeze(['graph:query', 'lsp:query', 'code:pack']);
/** Direct GitNexus MCP calls — the substitute the native plane routes through. */
export const GITNEXUS_DIRECT_PREFIX = 'gitnexus.';
/** agent_activity tool names whose `detail` carries a shell command. */
export const SHELL_ACTIVITY_TOOLS: readonly string[] = Object.freeze([
  'Bash', 'mcp__papercusp-su__capability_bash', 'mcp__papercusp__capability_bash',
]);
/** agent_activity tool names that read or change a file — the follow-through proxy. */
export const FILE_FOLLOW_TOOLS: readonly string[] = Object.freeze([
  'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'mcp__papercusp-su__capability_read', 'mcp__papercusp-su__capability_edit', 'mcp__papercusp-su__capability_write',
  'mcp__papercusp__capability_read', 'mcp__papercusp__capability_edit', 'mcp__papercusp__capability_write',
]);
/** A native answer counts as followed through when the same agent reads/edits a file within this window. */
export const FOLLOW_THROUGH_WINDOW_MS = 15 * 60_000;
/** Shell command text longer than this is truncated before classification (bounds transfer size). */
export const SHELL_COMMAND_MAX_CHARS = 4_000;

/** What this instrument structurally cannot see — reported with every measurement. */
export const NATIVE_ADOPTION_CANNOT_OBSERVE: readonly string[] = Object.freeze([
  'Lookups made by reading files directly (Read/cat/sed) without a search command are not classified as lookups.',
  'Shell commands from clients that do not report agent_activity (or report them under other tool names) are invisible.',
  'Follow-through is a proxy: a file read/edit by the same agent within 15 minutes, not proof that the file was among the returned results.',
  'Answer quality (empty, stale or wrong results) is not recorded in the invocation ledger; only status/error class is.',
  'Raw-text classification is pattern-based (declaration keywords or identifier-call patterns in a grep/rg/ag pattern); other text searches are not counted.',
]);

// ── Classification ───────────────────────────────────────────────────────────

export type NativeInvocationClass = 'ok' | 'refused' | 'invalid-input' | 'error';

const REFUSED_STATUSES = new Set(['role-not-allowed', 'refused', 'forbidden', 'denied', 'quota-exceeded', 'unauthorized']);
const REFUSED_ERROR_CODES = new Set(['missing_capability', 'forbidden', 'role_not_allowed', 'unauthorized', 'quota_exceeded']);

/** Status → class. Refusals (access/quota) are separated from caller mistakes and real errors. */
export function classifyInvocationStatus(status: string | null | undefined, errorCode?: string | null): NativeInvocationClass {
  const s = (status ?? '').trim().toLowerCase();
  const code = (errorCode ?? '').trim().toLowerCase();
  if (s === 'ok') return 'ok';
  if (REFUSED_STATUSES.has(s) || REFUSED_ERROR_CODES.has(code)) return 'refused';
  if (s === 'invalid-input' || s === 'invalid_input' || code === 'invalid_input' || code === 'invalid_args') return 'invalid-input';
  return 'error';
}

export type ShellLookupKind = 'definition' | 'call-site';

const SEARCH_COMMAND = /^(?:(?:sudo|env|command|nice|timeout\s+\S+)\s+)*(?:grep|egrep|fgrep|rg|ag|git\s+(?:-C\s+\S+\s+)?grep)(?:\s|$)/;
const DECLARATION =
  /(?:\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract\s+class)\b|\b(?:function|class|interface|enum|def|fn|struct|trait|impl|func)\s+\\?[A-Za-z_$][\w$]*)/;
const CALL_SITE = /[A-Za-z_$][\w$]{2,}\\*\(/;
const QUOTED = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;

/** The pattern-bearing texts of one search segment: every quoted string + the first bare non-flag token. */
function searchPatternTexts(segment: string): string[] {
  const texts: string[] = [];
  for (const match of segment.matchAll(QUOTED)) texts.push(match[2] ?? '');
  const unquoted = segment.replace(QUOTED, ' ');
  const tokens = unquoted.trim().split(/\s+/);
  // skip the command word(s), then flags; the first remaining token is the bare pattern (if unquoted).
  let i = 0;
  while (i < tokens.length && /^(?:sudo|env|command|nice|timeout|git|grep|egrep|fgrep|rg|ag|-C)$/.test(tokens[i] ?? '')) i += 1;
  while (i < tokens.length && (tokens[i] ?? '').startsWith('-')) i += 1;
  if (i < tokens.length && texts.length === 0) texts.push(tokens[i] ?? '');
  return texts;
}

/**
 * Classify one shell command as a raw-text definition / call-site lookup — a question the
 * native plane answers (lsp:query workspace_symbols / graph:query callers). Definition wins
 * over call-site when one command holds both. Returns null for every other command.
 */
export function classifyShellLookup(command: string | null | undefined): ShellLookupKind | null {
  if (!command) return null;
  const text = command.length > SHELL_COMMAND_MAX_CHARS ? command.slice(0, SHELL_COMMAND_MAX_CHARS) : command;
  let callSite = false;
  for (const raw of text.split(/\n|;|&&|\|\||\|/)) {
    const segment = raw.trim().replace(/^\(+/, '').replace(/^(?:cd\s+\S+\s*)+/, '').trim();
    if (!SEARCH_COMMAND.test(segment)) continue;
    for (const pattern of searchPatternTexts(segment)) {
      if (DECLARATION.test(pattern)) return 'definition';
      if (CALL_SITE.test(pattern)) callSite = true;
    }
  }
  return callSite ? 'call-site' : null;
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface NativeAdoptionWindow {
  workspaceId: string;
  windowStart: string;
  windowEnd: string;
}

export interface NativeAdoptionInvocation {
  toolName: string;
  ownerId: string | null;
  role: string | null;
  status: string | null;
  errorCode: string | null;
  durationMs: number | null;
  invokedAt: string;
  /** Native OK calls only: the same agent read/edited a file within the follow-through window. */
  followedThrough?: boolean | null;
}

export interface NativeAdoptionShellCommand {
  ownerId: string | null;
  command: string;
  at: string;
}

export interface NativeOpStats {
  calls: number;
  ok: number;
  refused: number;
  invalidInput: number;
  errored: number;
  distinctAgents: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface NativeAdoptionMetrics {
  version: number;
  window: NativeAdoptionWindow;
  native: NativeOpStats & {
    distinctOkAgents: number;
    /** refused / calls; null when there were no native calls. */
    refusalRate: number | null;
    /** errored / calls (caller invalid-input excluded); null when there were no native calls. */
    errorRate: number | null;
    byOp: Record<string, NativeOpStats>;
    refusalsByRole: Record<string, number>;
    followThrough: { measuredCalls: number; followed: number; rate: number | null };
  };
  substitutes: {
    gitnexusDirect: { calls: number; distinctAgents: number; byOp: Record<string, number> };
    rawTextLookups: { definition: number; callSite: number; total: number; distinctAgents: number; scannedCommands: number };
  };
  adoption: {
    /** Agents that asked any code-intelligence question (native, GitNexus direct, or raw-text lookup). */
    lookupAgents: number;
    /** Of those, agents with at least one successful native call. */
    nativeAgents: number;
    /** nativeAgents / lookupAgents; null when no agent looked anything up. */
    agentAdoptionRate: number | null;
    /** All lookups: native calls (any status) + GitNexus direct + raw-text lookups. */
    lookups: number;
    /** native OK calls / (native OK + GitNexus direct + raw-text lookups); null when zero. */
    nativeCallShare: number | null;
  };
  cannotObserve: readonly string[];
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function nearestRank(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

function opStats(rows: NativeAdoptionInvocation[]): NativeOpStats {
  const counts = { ok: 0, refused: 0, invalidInput: 0, errored: 0 };
  const owners = new Set<string>();
  const durations: number[] = [];
  for (const row of rows) {
    const cls = classifyInvocationStatus(row.status, row.errorCode);
    if (cls === 'ok') counts.ok += 1;
    else if (cls === 'refused') counts.refused += 1;
    else if (cls === 'invalid-input') counts.invalidInput += 1;
    else counts.errored += 1;
    if (row.ownerId) owners.add(row.ownerId);
    if (cls === 'ok' && typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) durations.push(row.durationMs);
  }
  durations.sort((a, b) => a - b);
  return {
    calls: rows.length, ...counts, distinctAgents: owners.size,
    p50Ms: nearestRank(durations, 0.5), p95Ms: nearestRank(durations, 0.95),
  };
}

/** Pure: ledger rows for one window → adoption metrics. */
export function summarizeNativeAdoption(input: {
  window: NativeAdoptionWindow;
  invocations: readonly NativeAdoptionInvocation[];
  shellCommands: readonly NativeAdoptionShellCommand[];
}): NativeAdoptionMetrics {
  const nativeSet = new Set(NATIVE_CODE_INTEL_TOOLS);
  const native = input.invocations.filter((row) => nativeSet.has(row.toolName));
  const gitnexus = input.invocations.filter((row) => row.toolName.startsWith(GITNEXUS_DIRECT_PREFIX));

  const byOp: Record<string, NativeOpStats> = {};
  for (const op of NATIVE_CODE_INTEL_TOOLS) byOp[op] = opStats(native.filter((row) => row.toolName === op));
  const all = opStats(native);

  const refusalsByRole: Record<string, number> = {};
  const okOwners = new Set<string>();
  let measuredFollow = 0;
  let followed = 0;
  for (const row of native) {
    const cls = classifyInvocationStatus(row.status, row.errorCode);
    if (cls === 'refused') {
      const role = row.role?.trim() || 'unknown';
      refusalsByRole[role] = (refusalsByRole[role] ?? 0) + 1;
    }
    if (cls === 'ok') {
      if (row.ownerId) okOwners.add(row.ownerId);
      if (typeof row.followedThrough === 'boolean') {
        measuredFollow += 1;
        if (row.followedThrough) followed += 1;
      }
    }
  }

  const gitnexusByOp: Record<string, number> = {};
  const gitnexusOwners = new Set<string>();
  for (const row of gitnexus) {
    gitnexusByOp[row.toolName] = (gitnexusByOp[row.toolName] ?? 0) + 1;
    if (row.ownerId) gitnexusOwners.add(row.ownerId);
  }

  let definition = 0;
  let callSite = 0;
  const rawOwners = new Set<string>();
  for (const command of input.shellCommands) {
    const kind = classifyShellLookup(command.command);
    if (!kind) continue;
    if (kind === 'definition') definition += 1;
    else callSite += 1;
    if (command.ownerId) rawOwners.add(command.ownerId);
  }
  const rawTotal = definition + callSite;

  const lookupOwners = new Set<string>([...gitnexusOwners, ...rawOwners]);
  for (const row of native) if (row.ownerId) lookupOwners.add(row.ownerId);
  const nativeAgents = [...okOwners].filter((owner) => lookupOwners.has(owner)).length;

  return {
    version: NATIVE_ADOPTION_VERSION,
    window: { ...input.window },
    native: {
      ...all,
      distinctOkAgents: okOwners.size,
      refusalRate: rate(all.refused, all.calls),
      errorRate: rate(all.errored, all.calls),
      byOp,
      refusalsByRole,
      followThrough: { measuredCalls: measuredFollow, followed, rate: rate(followed, measuredFollow) },
    },
    substitutes: {
      gitnexusDirect: { calls: gitnexus.length, distinctAgents: gitnexusOwners.size, byOp: gitnexusByOp },
      rawTextLookups: {
        definition, callSite, total: rawTotal, distinctAgents: rawOwners.size,
        scannedCommands: input.shellCommands.length,
      },
    },
    adoption: {
      lookupAgents: lookupOwners.size,
      nativeAgents,
      agentAdoptionRate: rate(nativeAgents, lookupOwners.size),
      lookups: native.length + gitnexus.length + rawTotal,
      nativeCallShare: rate(all.ok, all.ok + gitnexus.length + rawTotal),
    },
    cannotObserve: NATIVE_ADOPTION_CANNOT_OBSERVE,
  };
}

// ── Rating ───────────────────────────────────────────────────────────────────

/**
 * The R-31 target, frozen from the P-033 baseline window BEFORE any intervention (plan
 * decision). null until frozen — good-use then rates `unknown`, never pass.
 */
export interface NativeAdoptionTarget {
  decisionRef: string;
  frozenAt: string;
  baselineWindow: { windowStart: string; windowEnd: string };
  baseline: { agentAdoptionRate: number; nativeCallShare: number; refusalRate: number; lookups: number };
  /** Below this many lookups in the window the verdict is inconclusive (unknown). */
  minLookups: number;
  minAgentAdoptionRate: number;
  minNativeCallShare: number;
  maxRefusalRate: number;
}

/**
 * Frozen 2026-10-14 from the baseline window (plan D-011), before any P-033 intervention:
 * double agent adoption and native call share, halve the refusal rate, floor = 1/4 baseline lookups.
 * NEVER edit these numbers to fit a later window — a miss is reported as fail.
 */
export const NATIVE_ADOPTION_TARGET: NativeAdoptionTarget | null = Object.freeze({
  decisionRef: 'native-code-intelligence-ecosystem-and-dream-2026-10-09#D-011',
  frozenAt: '2026-10-14T06:45:00.000Z',
  baselineWindow: Object.freeze({ windowStart: '2026-10-11T06:00:00.000Z', windowEnd: '2026-10-14T06:00:00.000Z' }),
  baseline: Object.freeze({ agentAdoptionRate: 0.06, nativeCallShare: 0.0706, refusalRate: 0.177, lookups: 1857 }),
  minLookups: 464,
  minAgentAdoptionRate: 0.12,
  minNativeCallShare: 0.14,
  maxRefusalRate: 0.088,
});

export interface NativeAdoptionRating {
  verdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  unknownReason?: string;
}

const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** Metrics → one rating per criterion. Inconclusive is reported as unknown, never adjusted. */
export function rateNativeAdoption(
  metrics: NativeAdoptionMetrics,
  target: NativeAdoptionTarget | null = NATIVE_ADOPTION_TARGET,
): Record<NativeAdoptionCriterion, NativeAdoptionRating> {
  const a = metrics.adoption;
  const summary =
    `${a.lookups} lookups by ${a.lookupAgents} agents; native ok ${metrics.native.ok}/${metrics.native.calls} ` +
    `(refused ${metrics.native.refused}), gitnexus direct ${metrics.substitutes.gitnexusDirect.calls}, ` +
    `raw-text ${metrics.substitutes.rawTextLookups.total}; agent adoption ${pct(a.agentAdoptionRate)}, ` +
    `native call share ${pct(a.nativeCallShare)}.`;

  const measured: NativeAdoptionRating = a.lookups > 0
    ? { verdict: 'pass', reason: `Adoption measured from the invocation and activity ledgers: ${summary}` }
    : { verdict: 'unknown', reason: 'No code-intelligence lookups were observed in the window.',
      unknownReason: 'empty-population' };

  let goodUse: NativeAdoptionRating;
  if (!target) {
    goodUse = { verdict: 'unknown', reason: 'The R-31 adoption target has not been frozen from the baseline window.',
      unknownReason: 'target-not-frozen' };
  } else if (a.lookups < target.minLookups) {
    goodUse = { verdict: 'unknown',
      reason: `Inconclusive: ${a.lookups} lookups < ${target.minLookups} required (${target.decisionRef}). ${summary}`,
      unknownReason: 'insufficient-sample' };
  } else {
    const checks: Array<[boolean, string]> = [
      [(a.agentAdoptionRate ?? 0) >= target.minAgentAdoptionRate,
        `agent adoption ${pct(a.agentAdoptionRate)} ≥ ${pct(target.minAgentAdoptionRate)}`],
      [(a.nativeCallShare ?? 0) >= target.minNativeCallShare,
        `native call share ${pct(a.nativeCallShare)} ≥ ${pct(target.minNativeCallShare)}`],
      [(metrics.native.refusalRate ?? 0) <= target.maxRefusalRate,
        `native refusal rate ${pct(metrics.native.refusalRate)} ≤ ${pct(target.maxRefusalRate)}`],
    ];
    const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
    goodUse = failed.length === 0
      ? { verdict: 'pass', reason: `Meets the frozen target (${target.decisionRef}): ${checks.map(([, l]) => l).join('; ')}.` }
      : { verdict: 'fail', reason: `Misses the frozen target (${target.decisionRef}): ${failed.join('; ')} not met. ${summary}` };
  }
  return { measured, goodUse };
}

// ── Reader ───────────────────────────────────────────────────────────────────

export interface NativeAdoptionRead {
  invocations: NativeAdoptionInvocation[];
  shellCommands: NativeAdoptionShellCommand[];
}

/** P-041: evidence supplied by the ledger reader, never inferred from delivery alone. */
export interface NativePushOutcomeRow {
  id: string;
  workspaceId: string;
  leg: string;
  pushedAt: string;
  /** True only when the reader has observed the end of this push's turn window. */
  windowComplete: boolean;
  actedOn: boolean | null;
  grepAfterPush: boolean | null;
}

export interface NativePushOutcomeStats {
  /** Rows issued into a server hook response; client receipt is not measured. */
  issued: number;
  closedWindows: number;
  actedOn: { measured: number; positive: number; rate: number | null };
  grepAfterPush: { measured: number; positive: number; rate: number | null };
}

export interface NativePushActivity {
  tool: string;
  status: string | null;
  detail: Record<string, unknown> | null;
}

/** Interpret recorded post-tool evidence only. Unsupported/truncated inputs stay unknown. */
export function nativePushFollowThrough(input: {
  leg: string; subject: string; citedPaths: readonly string[]; suggestedCall: string | null;
  activities: readonly NativePushActivity[]; executedTests: readonly string[];
}): Pick<NativePushOutcomeRow, 'actedOn' | 'grepAfterPush'> {
  const relativePath = (value: unknown): value is string => typeof value === 'string'
    && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').some(part => part === '..' || part === '.' || part === '');
  const cited = new Set(input.citedPaths.filter(relativePath));
  let fileObserved = false;
  let fileUnknown = false;
  let grepObserved = false;
  let grepUnknown = false;
  let telemetry = false;
  for (const activity of input.activities) {
    if (activity.status !== 'ok') continue;
    telemetry = true;
    const detail = activity.detail ?? {};
    if (FILE_FOLLOW_TOOLS.includes(activity.tool)) {
      if (relativePath(detail.file)) fileObserved ||= cited.has(detail.file);
      else fileUnknown = true; // No persisted snapshot root: never match an absolute suffix/basename.
    }
    const command = detail.command ?? detail.cmd;
    const nativeGrep = /(?:^|_|:)Grep$/.test(activity.tool);
    if (nativeGrep) {
      if (typeof detail.pattern !== 'string' || detail.pattern.length >= 500) grepUnknown = true;
      else if (detail.pattern === input.subject) grepObserved = true;
      else if (!/^[A-Za-z_$][\w$]*$/.test(detail.pattern)) grepUnknown = true;
    } else if (SHELL_ACTIVITY_TOOLS.includes(activity.tool) || activity.tool === 'exec_command') {
      if (typeof command !== 'string' || command.length >= 500) { grepUnknown = true; continue; }
      for (const segment of command.split(/\n|;|&&|\|\||\|/).map(part => part.trim())) {
        if (!SEARCH_COMMAND.test(segment)) continue;
        // Deliberately narrow: a quoted path or an option argument must never masquerade
        // as the search pattern. D-011's broader lookup classifier remains unchanged.
        const literal = /^(?:rg|grep|git\s+grep)\s+(?:-[nrwHF]+\s+)*(?:--\s+)?(?:'([A-Za-z_$][\w$]*)'|"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))(?:\s+[\w./*-]+)*\s*$/.exec(segment);
        if (!literal) grepUnknown = true;
        else if ((literal[1] ?? literal[2] ?? literal[3]) === input.subject) grepObserved = true;
      }
    }
  }
  let suggested: string[] = [];
  if (input.suggestedCall?.startsWith('testing:run ')) {
    try {
      const args = JSON.parse(input.suggestedCall.slice('testing:run '.length));
      if (Array.isArray(args.files)) suggested = args.files.filter(relativePath);
    } catch { /* Unsupported suggestions are not execution evidence. */ }
  }
  const testObserved = suggested.some(file => input.executedTests.includes(file));
  return {
    actedOn: fileObserved || testObserved ? true
      : telemetry && cited.size > 0 && !fileUnknown && !input.suggestedCall ? false : null,
    grepAfterPush: input.leg !== 'grep' || !telemetry || !/^[A-Za-z_$][\w$]*$/.test(input.subject) ? null
      : grepObserved ? true : grepUnknown ? null : false,
  };
}

/**
 * P-041 historical reader. Reuses transcript prompt timestamps and the Stop-hook journal's
 * native final-message timestamp. The random current identity_hook_turns UUID is not history.
 * Native file prompts use the legacy default corpus partition (as in sessions:read); the
 * tenant-scoped journal, exact owner and native session/source kind anchor those reads.
 * A missing/overlapping native session, intervening prompt, or earlier completion fails closed.
 * No elapsed-time fallback, launch-time membership, or journal prose enters the measurement.
 */
export async function readNativePushOutcomes(window: NativeAdoptionWindow, sql: Sql = getOrgPg().sql): Promise<NativePushOutcomeRow[]> {
  // Share the pure summary's exact scope/window validation, without touching the frozen D-011 reader.
  summarizeNativePushOutcomes({ window, rows: [] });
  const end = new Date(window.windowEnd).toISOString();
  const rows = await sql<Array<{
    id: string; workspace_id: string; leg: string; subject: string; pushed_at: string | Date;
    cited_paths: string[]; suggested_call: string | null; window_count: number;
    activities: NativePushActivity[]; executed_tests: string[];
  }>>`
    WITH pushes AS MATERIALIZED (
      SELECT * FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${window.workspaceId}
        AND pushed_at >= ${window.windowStart}::timestamptz AND pushed_at < ${end}::timestamptz
    ), candidates AS MATERIALIZED (
      SELECT p.id, j.session_id, j.source_kind, u.ts AS started_at, j.turn_ts AS ended_at
      FROM pushes p CROSS JOIN LATERAL (
        SELECT DISTINCT ON (session_id, source_kind) session_id, source_kind, turn_ts
        FROM harness_shared.session_turn_journal
        WHERE workspace_id = p.workspace_id AND owner_id = p.owner_id
          AND turn_ts > p.pushed_at AND turn_ts <= ${end}::timestamptz
        ORDER BY session_id, source_kind, turn_ts
      ) j CROSS JOIN LATERAL (
        SELECT ts FROM harness_shared.session_turns
        WHERE (workspace_id = p.workspace_id OR workspace_id = 'default') AND owner = p.owner_id
          AND session_id = j.session_id AND source_kind = j.source_kind
          AND speaker = 'user' AND ts <= p.pushed_at
        ORDER BY ts DESC, turn_idx DESC LIMIT 1
      ) u
      WHERE EXISTS (
        SELECT 1 FROM harness_shared.agent_activity before_push
        WHERE before_push.workspace_id = p.workspace_id AND before_push.owner_id = p.owner_id
          AND before_push.session_id = j.session_id AND before_push.kind = 'tool'
          AND before_push.phase = 'post' AND before_push.created_at >= u.ts AND before_push.created_at <= p.pushed_at
      ) AND NOT EXISTS (
        SELECT 1 FROM harness_shared.session_turns n
        WHERE (n.workspace_id = p.workspace_id OR n.workspace_id = 'default') AND n.owner = p.owner_id
          AND n.session_id = j.session_id AND n.source_kind = j.source_kind
          AND n.speaker = 'user' AND n.ts > p.pushed_at AND n.ts <= j.turn_ts
      ) AND NOT EXISTS (
        SELECT 1 FROM harness_shared.session_turn_journal prior
        WHERE prior.workspace_id = p.workspace_id AND prior.owner_id = p.owner_id
          AND prior.session_id = j.session_id AND prior.source_kind = j.source_kind
          AND prior.turn_ts >= u.ts AND prior.turn_ts <= p.pushed_at
      ) AND NOT EXISTS (
        SELECT 1 FROM harness_shared.agent_activity other
        WHERE other.workspace_id = p.workspace_id AND other.owner_id = p.owner_id
          AND other.created_at >= u.ts AND other.created_at <= j.turn_ts
          AND other.session_id IS NOT NULL AND other.session_id <> j.session_id
      )
    )
    SELECT p.id::text, p.workspace_id, p.leg, p.subject, p.pushed_at, p.cited_paths, p.suggested_call,
      (SELECT count(*)::int FROM candidates c WHERE c.id = p.id) AS window_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('tool', a.tool_name, 'status', a.status, 'detail', a.detail))
        FROM candidates c JOIN harness_shared.agent_activity a
          ON a.workspace_id = p.workspace_id AND a.owner_id = p.owner_id AND a.session_id = c.session_id
          AND a.created_at > p.pushed_at AND a.created_at <= c.ended_at AND a.kind = 'tool' AND a.phase = 'post'
        WHERE c.id = p.id), '[]'::jsonb) AS activities,
      COALESCE((SELECT array_agg(DISTINCT r.file_path)
        FROM candidates c JOIN harness_shared.tool_invocations t
          ON t.workspace_id = p.workspace_id AND t.coord_owner_id = p.owner_id AND t.tool_name = 'testing:run'
          AND t.status = 'ok' AND t.invoked_at > p.pushed_at AND t.invoked_at <= c.ended_at
        JOIN harness_shared.test_runs r ON r.workspace_id = p.workspace_id
          AND r.run_group_id = t.metadata_json->'testingRun'->>'runId'
          AND r.started_at >= t.invoked_at AND r.finished_at <= c.ended_at
          AND r.status IN ('pass', 'fail')
        WHERE c.id = p.id), '{}'::text[]) AS executed_tests
    FROM pushes p ORDER BY p.pushed_at, p.id
  `;
  return rows.map(row => ({
    id: row.id, workspaceId: row.workspace_id, leg: row.leg, pushedAt: iso(row.pushed_at),
    windowComplete: row.window_count === 1,
    ...(row.window_count === 1 ? nativePushFollowThrough({
      leg: row.leg, subject: row.subject, citedPaths: row.cited_paths, suggestedCall: row.suggested_call,
      activities: row.activities, executedTests: row.executed_tests,
    }) : { actedOn: null, grepAfterPush: null }),
  }));
}

/** Separate from D-011's frozen adoption summary and rater. Null is never a negative. */
export function summarizeNativePushOutcomes(input: {
  window: NativeAdoptionWindow;
  rows: readonly NativePushOutcomeRow[];
}): { version: 1; window: NativeAdoptionWindow; byLeg: Record<string, NativePushOutcomeStats>;
  cannotObserve: readonly string[] } {
  const start = Date.parse(input.window.windowStart);
  const end = Date.parse(input.window.windowEnd);
  if (!input.window.workspaceId.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('An exact workspace and a valid [windowStart, windowEnd) are required.');
  }
  const unique = new Map<string, NativePushOutcomeRow>();
  for (const row of input.rows) {
    const at = Date.parse(row.pushedAt);
    if (row.workspaceId !== input.window.workspaceId || !Number.isFinite(at) || at < start || at >= end) continue;
    if (!row.id.trim() || !row.leg.trim()) throw new Error('A push ledger id and leg are required.');
    const previous = unique.get(row.id);
    if (previous && (previous.leg !== row.leg || previous.pushedAt !== row.pushedAt
      || previous.windowComplete !== row.windowComplete || previous.actedOn !== row.actedOn
      || previous.grepAfterPush !== row.grepAfterPush)) throw new Error('Conflicting evidence for one push ledger id.');
    unique.set(row.id, row);
  }
  const legs = new Map<string, NativePushOutcomeStats>();
  for (const row of unique.values()) {
    const stats = legs.get(row.leg) ?? {
      issued: 0, closedWindows: 0,
      actedOn: { measured: 0, positive: 0, rate: null },
      grepAfterPush: { measured: 0, positive: 0, rate: null },
    };
    stats.issued += 1;
    if (row.windowComplete) {
      stats.closedWindows += 1;
      for (const key of ['actedOn', 'grepAfterPush'] as const) {
        if (typeof row[key] !== 'boolean') continue;
        stats[key].measured += 1;
        if (row[key]) stats[key].positive += 1;
        stats[key].rate = rate(stats[key].positive, stats[key].measured);
      }
    }
    legs.set(row.leg, stats);
  }
  return { version: 1, window: { ...input.window }, byLeg: Object.fromEntries(legs), cannotObserve: [
    'Issued counts server hook-response ledger rows, not confirmed client receipt or attention.',
    'Open turn windows and unmeasured outcomes are excluded from each rate denominator.',
    'A read, edit or suggested-test execution is follow-through evidence, not proof of causation or usefulness.',
    'A leg without recorded symbol identity cannot measure same-symbol grep; that outcome stays unknown.',
    'Historical closure requires one correlated native prompt and Stop-hook completion; missing or overlapping sessions stay unknown.',
    'Only successful recorded post-tool events are observed; missing telemetry is not evidence of inactivity.',
    'Absolute file paths lack a persisted snapshot root and are not matched by suffix; truncated/unsupported search commands stay unknown.',
    'Suggested tests require matching completed test-run ledger rows linked through the testing invocation run group; requesting tests alone does not count.',
  ] };
}

export type NativePushOutcomeMetrics = ReturnType<typeof summarizeNativePushOutcomes>;

export async function measureNativePushOutcomesWindow(window: NativeAdoptionWindow, sql?: Sql): Promise<NativePushOutcomeMetrics> {
  return summarizeNativePushOutcomes({ window, rows: await readNativePushOutcomes(window, sql) });
}

/** These grade observability, not usefulness. Rates remain explicit per leg; no new success target is invented. */
export function rateNativePushOutcomes(metrics: NativePushOutcomeMetrics, criterion: NativePushCriterion): {
  verdict: 'pass' | 'unknown'; reason: string;
} {
  const legs = Object.entries(metrics.byLeg).filter(([leg]) => criterion !== 'grepAfterPush' || leg === 'grep');
  if (!legs.length) return { verdict: 'unknown', reason: 'No applicable push ledger rows in this window.' };
  const counts = legs.map(([leg, stats]) => ({ leg,
    measured: criterion === 'issued' ? stats.issued : stats[criterion].measured,
    rate: criterion === 'issued' ? null : stats[criterion].rate,
  }));
  const missing = counts.filter(row => row.measured === 0).map(row => row.leg);
  return { verdict: missing.length ? 'unknown' : 'pass',
    reason: `${criterion}: ${JSON.stringify(counts)}. ${missing.length ? `Unmeasured legs: ${missing.join(', ')}.` : 'Measurement available; this is not a usefulness or client-receipt verdict.'}` };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Read one window's ledger rows. Throws on an invalid window; the caller rates that unknown. */
export async function readNativeAdoptionWindow(
  window: NativeAdoptionWindow,
  sql: Sql = getOrgPg().sql,
): Promise<NativeAdoptionRead> {
  const start = Date.parse(window.windowStart);
  const end = Date.parse(window.windowEnd);
  if (!window.workspaceId.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('An exact workspace and a valid [windowStart, windowEnd) are required.');
  }
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const nativeTools = [...NATIVE_CODE_INTEL_TOOLS];
  const followTools = [...FILE_FOLLOW_TOOLS];
  const shellTools = [...SHELL_ACTIVITY_TOOLS];
  const gitnexusLike = `${GITNEXUS_DIRECT_PREFIX}%`;
  const followIntervalMs = FOLLOW_THROUGH_WINDOW_MS;

  const invocationRows = await sql<Array<{
    tool_name: string; coord_owner_id: string | null; role: string | null; status: string | null;
    error_code: string | null; duration_ms: number | null; invoked_at: Date | string; followed: boolean | null;
  }>>`
    WITH k AS MATERIALIZED (
      SELECT DISTINCT invoked_at FROM harness_shared.tool_invocations
       WHERE invoked_at >= ${startIso}::timestamptz AND invoked_at < ${endIso}::timestamptz
         AND (tool_name = ANY(${nativeTools}::text[]) OR tool_name LIKE ${gitnexusLike})
    )
    SELECT t.tool_name, t.coord_owner_id, t.role, t.status, t.error_code, t.duration_ms, t.invoked_at,
           CASE WHEN t.tool_name = ANY(${nativeTools}::text[]) AND t.status = 'ok' AND t.coord_owner_id IS NOT NULL
             THEN EXISTS (
               SELECT 1 FROM harness_shared.agent_activity a
                WHERE a.owner_id = t.coord_owner_id
                  AND a.created_at > t.invoked_at
                  AND a.created_at <= t.invoked_at + make_interval(secs => ${followIntervalMs}::int / 1000.0)
                  AND a.kind = 'tool' AND a.phase = 'post'
                  AND a.tool_name = ANY(${followTools}::text[]))
           END AS followed
      FROM harness_shared.tool_invocations t
     WHERE t.invoked_at = ANY(ARRAY(SELECT invoked_at FROM k))
       AND (t.tool_name = ANY(${nativeTools}::text[]) OR t.tool_name LIKE ${gitnexusLike})
       AND t.workspace_id = ${window.workspaceId}
  `;

  // Prefilter is a SUPERSET of classifyShellLookup (a search command plus a declaration keyword
  // or an identifier-call shape); classifyShellLookup stays the single authority.
  const shellRows = await sql<Array<{ owner_id: string | null; command: string | null; created_at: Date | string }>>`
    SELECT owner_id, left(coalesce(detail->>'command', detail->>'cmd'), ${SHELL_COMMAND_MAX_CHARS}::int) AS command, created_at
      FROM harness_shared.agent_activity
     WHERE workspace_id = ${window.workspaceId}
       AND created_at >= ${startIso}::timestamptz AND created_at < ${endIso}::timestamptz
       AND kind = 'tool' AND phase = 'post'
       AND tool_name = ANY(${shellTools}::text[])
       AND coalesce(detail->>'command', detail->>'cmd') ~ '(grep|rg|ag)\\s'
       AND coalesce(detail->>'command', detail->>'cmd') ~ '(function|class|interface|enum|def|fn|func|struct|trait|impl|const|let|type)\\s|[A-Za-z_$][A-Za-z0-9_$]{2,}\\\\*\\('
  `;

  return {
    invocations: invocationRows.map((row) => ({
      toolName: row.tool_name,
      ownerId: row.coord_owner_id,
      role: row.role,
      status: row.status,
      errorCode: row.error_code,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      invokedAt: iso(row.invoked_at),
      followedThrough: row.followed,
    })),
    shellCommands: shellRows
      .filter((row): row is typeof row & { command: string } => typeof row.command === 'string')
      .map((row) => ({ ownerId: row.owner_id, command: row.command, at: iso(row.created_at) })),
  };
}

/** Read + summarize one window (the default scorecards resolver seam). */
export async function measureNativeAdoptionWindow(
  window: NativeAdoptionWindow,
  sql?: Sql,
): Promise<NativeAdoptionMetrics> {
  const read = await readNativeAdoptionWindow(window, sql);
  return summarizeNativeAdoption({ window, ...read });
}

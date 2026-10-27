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
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
// Type-only: push-channel.ts imports this module at runtime, so a value import would cycle.
import type { PushLegId } from './push-channel';

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
 * The pattern-bearing texts of every search segment in one shell command, in order. A search
 * may sit in any segment (`cd <dir> || exit 1; grep …`, `f=…; grep … $f`, `git show … | rg …`).
 * Shared by classifyShellLookup (the P-033 instrument) and the grep push leg, so the leg's
 * trigger cannot drift narrower than what the instrument counts (WI-6554700010019006).
 */
export function shellSearchPatterns(command: string | null | undefined): string[] {
  if (!command) return [];
  const text = command.length > SHELL_COMMAND_MAX_CHARS ? command.slice(0, SHELL_COMMAND_MAX_CHARS) : command;
  const patterns: string[] = [];
  for (const raw of text.split(/\n|;|&&|\|\||\|/)) {
    const segment = raw.trim().replace(/^\(+/, '').replace(/^(?:cd\s+\S+\s*)+/, '').trim();
    if (!SEARCH_COMMAND.test(segment)) continue;
    patterns.push(...searchPatternTexts(segment));
  }
  return patterns;
}

/**
 * Classify one shell command as a raw-text definition / call-site lookup — a question the
 * native plane answers (lsp:query workspace_symbols / graph:query callers). Definition wins
 * over call-site when one command holds both. Returns null for every other command.
 */
export function classifyShellLookup(command: string | null | undefined): ShellLookupKind | null {
  let callSite = false;
  for (const pattern of shellSearchPatterns(command)) {
    if (DECLARATION.test(pattern)) return 'definition';
    if (CALL_SITE.test(pattern)) callSite = true;
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
  /** agent_activity.harness_slug — selects the registered repo root an absolute path is relativized against. */
  harness?: string | null;
}

/**
 * The activity ledger records the papercusp-su MCP server under BOTH spellings
 * (`mcp__papercusp-su__*` and `mcp__papercusp_su__*`; measured 2026-10-21: capability_read only
 * ever appears underscored). Canonicalize for the push reader only — D-011's frozen adoption
 * reader keeps its exact name lists.
 */
export function canonicalPushActivityTool(tool: string): string {
  return tool.replace(/^mcp__papercusp_su__/, 'mcp__papercusp-su__');
}

/**
 * Repo-relative form of a recorded file path, or null when it cannot be placed exactly.
 * Native Read/Edit/Write always record absolute paths, so an absolute path is accepted only
 * under the EXACT registered repo root of the activity's own harness — never by suffix or
 * basename. capability:read records `file_path`; native tools record `file`.
 */
export function pushActivityRepoPath(
  detail: Record<string, unknown>, harness: string | null | undefined,
  repoRoots: ReadonlyMap<string, string> | undefined,
): string | null {
  const raw = typeof detail.file === 'string' ? detail.file : typeof detail.file_path === 'string' ? detail.file_path : null;
  if (raw === null || raw.length === 0) return null;
  let rel = raw;
  if (raw.startsWith('/')) {
    const root = harness ? repoRoots?.get(harness) : undefined;
    if (!root || !root.startsWith('/')) return null;
    const prefix = `${root.replace(/\/+$/, '')}/`;
    if (!raw.startsWith(prefix)) return null;
    rel = raw.slice(prefix.length);
  }
  return isRepoRelativePath(rel) ? rel : null;
}

function isRepoRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').some(part => part === '..' || part === '.' || part === '');
}

/** Interpret recorded post-tool evidence only. Unsupported/truncated inputs stay unknown. */
export function nativePushFollowThrough(input: {
  leg: string; subject: string; citedPaths: readonly string[]; suggestedCall: string | null;
  activities: readonly NativePushActivity[]; executedTests: readonly string[];
  /** harness slug → absolute registered repo root; absent → absolute paths stay unknown. */
  repoRoots?: ReadonlyMap<string, string>;
  /**
   * testing:run invocations by the owner inside the window, linked to a test run or not. Absent
   * means not measured, so a push carrying a suggested test can never score as not-acted-on.
   */
  testRequests?: number;
}): Pick<NativePushOutcomeRow, 'actedOn' | 'grepAfterPush'> {
  const relativePath = isRepoRelativePath;
  const cited = new Set(input.citedPaths.filter(relativePath));
  let fileObserved = false;
  let fileUnknown = false;
  let grepObserved = false;
  let grepUnknown = false;
  let telemetry = false;
  // A shell command can run a suggested test without leaving a linked test-run record.
  let shellSeen = false;
  for (const activity of input.activities) {
    if (activity.status !== 'ok') continue;
    telemetry = true;
    const detail = activity.detail ?? {};
    const tool = canonicalPushActivityTool(activity.tool);
    if (FILE_FOLLOW_TOOLS.includes(tool)) {
      const path = pushActivityRepoPath(detail, activity.harness, input.repoRoots);
      if (path !== null) fileObserved ||= cited.has(path);
      // A spilled tool-output page is not a repository file, so it is neither a hit nor a gap.
      else if (!(typeof detail.uri === 'string' && detail.uri.startsWith('papercusp://scratch/')
        && detail.file === undefined && detail.file_path === undefined)) fileUnknown = true;
    }
    const command = detail.command ?? detail.cmd;
    const nativeGrep = /(?:^|_|:)Grep$/.test(tool);
    if (nativeGrep) {
      if (typeof detail.pattern !== 'string' || detail.pattern.length >= 500) grepUnknown = true;
      else if (detail.pattern === input.subject) grepObserved = true;
      else if (!/^[A-Za-z_$][\w$]*$/.test(detail.pattern)) grepUnknown = true;
    } else if (SHELL_ACTIVITY_TOOLS.includes(tool) || tool === 'exec_command') {
      shellSeen = true;
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
  // A suggested test rules out a negative unless the window shows it was not run: no shell
  // command, and no testing:run request at all, linked or not. Otherwise the leg's rate could
  // only ever count positives.
  const suggestionExcluded = !input.suggestedCall
    || (suggested.length > 0 && !shellSeen && input.testRequests === 0);
  return {
    actedOn: fileObserved || testObserved ? true
      : telemetry && cited.size > 0 && !fileUnknown && suggestionExcluded ? false : null,
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
/** Registered repo root per harness slug (exact checkout path from the harness registry). */
export type PushRepoRootResolver = (harnessSlugs: readonly string[], workspaceId: string) => Promise<ReadonlyMap<string, string>>;

async function registryRepoRoots(harnessSlugs: readonly string[], workspaceId: string): Promise<ReadonlyMap<string, string>> {
  const roots = new Map<string, string>();
  if (harnessSlugs.length === 0) return roots;
  try {
    const { loadHarnessRegistry, resolveHarnessContentPath } = await import('../harness-registry');
    const registry = await loadHarnessRegistry(workspaceId);
    for (const slug of harnessSlugs) {
      const root = resolveHarnessContentPath(registry, slug);
      if (root && root.startsWith('/')) roots.set(slug, root);
    }
  } catch {
    // An unreadable registry leaves absolute paths unknown (null), never negative.
    roots.clear();
  }
  return roots;
}

export async function readNativePushOutcomes(
  window: NativeAdoptionWindow, sql: Sql = getOrgPg().sql, resolveRepoRoots: PushRepoRootResolver = registryRepoRoots,
): Promise<NativePushOutcomeRow[]> {
  // Share the pure summary's exact scope/window validation, without touching the frozen D-011 reader.
  summarizeNativePushOutcomes({ window, rows: [] });
  const end = new Date(window.windowEnd).toISOString();
  const rows = await sql<Array<{
    id: string; workspace_id: string; leg: string; subject: string; pushed_at: string | Date;
    cited_paths: string[]; suggested_call: string | null; window_count: number;
    activities: NativePushActivity[]; executed_tests: string[]; test_requests: number;
  }>>`
    WITH pushes AS MATERIALIZED (
      SELECT * FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${window.workspaceId}
        AND chars > 0
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
      COALESCE((SELECT jsonb_agg(jsonb_build_object('tool', a.tool_name, 'status', a.status, 'detail', a.detail, 'harness', a.harness_slug))
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
        WHERE c.id = p.id), '{}'::text[]) AS executed_tests,
      (SELECT count(*)::int FROM candidates c JOIN harness_shared.tool_invocations t
          ON t.workspace_id = p.workspace_id AND t.coord_owner_id = p.owner_id AND t.tool_name = 'testing:run'
          AND t.invoked_at > p.pushed_at AND t.invoked_at <= c.ended_at
        WHERE c.id = p.id) AS test_requests
    FROM pushes p ORDER BY p.pushed_at, p.id
  `;
  const harnesses = new Set<string>();
  for (const row of rows) for (const a of row.activities) if (typeof a.harness === 'string' && a.harness) harnesses.add(a.harness);
  const repoRoots = await resolveRepoRoots([...harnesses].sort(), window.workspaceId);
  return rows.map(row => ({
    id: row.id, workspaceId: row.workspace_id, leg: row.leg, pushedAt: iso(row.pushed_at),
    windowComplete: row.window_count === 1,
    ...(row.window_count === 1 ? nativePushFollowThrough({
      leg: row.leg, subject: row.subject, citedPaths: row.cited_paths, suggestedCall: row.suggested_call,
      activities: row.activities, executedTests: row.executed_tests, testRequests: row.test_requests, repoRoots,
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
    'Absolute file paths count only under the exact registered repo root of the activity\'s harness (never by suffix); paths outside it, rows without a harness, and truncated/unsupported search commands stay unknown.',
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

// ── Per-leg outcome chains (code-intel-delivery-and-outcomes-2026-10-26 P-013; R-7, R-10) ──────
//
// exposure → follow-through → result, one chain per PUSH_LEG_FLAGS leg. The code map below is
// pinned to the plan's ## Design push-leg table (push-leg-design-table.md is the tree copy,
// PUSH_LEG_DESIGN_TABLE_SHA256 its hash; native-adoption.test.ts compares all three). Control
// populations are code-intel-delivery-and-outcomes-2026-10-26#D-027.

const DAY_MS = 86_400_000;
/** D-014 item 5: a result needs this many eligible triggers (and samples), else insufficient-data. */
export const LEG_OUTCOME_MIN_SAMPLE = 20;
/** D-027: the pre-exposure baseline is the 7 days before the leg's first push. */
export const LEG_BASELINE_DAYS = 7;
/** One scored window per run of the instrument. */
export const LEG_OUTCOME_WINDOW_MS = 7 * DAY_MS;
/** R-10: the re-score schedule interval may not exceed 24 h. */
export const LEG_OUTCOME_MAX_INTERVAL_MS = DAY_MS;

/** The only legs allowed to report cannot-observe. Adding a member needs a plan Decision (R-7). */
export const CANNOT_OBSERVE_LEGS: readonly PushLegId[] = Object.freeze(['notes'] as PushLegId[]);

export type LegResultKey = 'time to first correct edit' | 'gate reds avoided' | 'clones avoided' | 'interface follow-through rate';
export type LegControl = 'pre-exposure baseline' | 'none';
export interface LegOutcomeSpec {
  /** The Design table's flag cell (FLAGS member name; "(shared)" when another leg owns the flag). */
  flag: string;
  resultKey: LegResultKey | 'cannot-observe';
  control: LegControl;
  /** Follow-through and result are attributed to a trigger only inside (trigger, trigger + this]. */
  attributionWindowDays: number;
  denominator: string;
  minSample: number;
  cannotObserveReason?: string;
}

const TIME_TO_EDIT = (flag: string): LegOutcomeSpec => ({
  flag, resultKey: 'time to first correct edit', control: 'none', attributionWindowDays: 1, minSample: LEG_OUTCOME_MIN_SAMPLE,
  denominator: 'exposed pushes in the scored window; the value is the median time from push to the recipient\'s first correct edit of a cited path',
});
const AVOIDED = (flag: string, resultKey: 'gate reds avoided' | 'clones avoided'): LegOutcomeSpec => ({
  flag, resultKey, control: 'pre-exposure baseline', attributionWindowDays: 1, minSample: LEG_OUTCOME_MIN_SAMPLE,
  denominator: 'eligible triggers: exposed ones in the scored window and unexposed ones in the baseline window; the value is the baseline outcome share minus the exposed outcome share',
});

/** The R-7 code map: leg → result key, control population, window, denominator, minimum sample. */
export const LEG_OUTCOME_TABLE: Readonly<Record<PushLegId, LegOutcomeSpec>> = Object.freeze({
  grep: TIME_TO_EDIT('CODE_INTEL_PUSH_GREP'),
  'first-touch': TIME_TO_EDIT('CODE_INTEL_PUSH_FIRST_TOUCH'),
  interface: {
    flag: 'CODE_INTEL_PUSH_INTERFACE', resultKey: 'interface follow-through rate', control: 'none',
    attributionWindowDays: 1, minSample: LEG_OUTCOME_MIN_SAMPLE,
    denominator: 'exposed interface pushes that cite a consumer path; the value is the share after which the recipient read or edited a cited path',
  },
  incident: AVOIDED('CODE_INTEL_PUSH_INCIDENT', 'gate reds avoided'),
  completion: AVOIDED('CODE_INTEL_PUSH_COMPLETION', 'gate reds avoided'),
  clone: AVOIDED('CODE_INTEL_PUSH_FIRST_TOUCH (shared)', 'clones avoided'),
  antipattern: AVOIDED('CODE_INTEL_AST_GREP', 'gate reds avoided'),
  intent: TIME_TO_EDIT('CODE_INTEL_PUSH_INTENT'),
  resume: TIME_TO_EDIT('CODE_INTEL_PUSH_RESUME'),
  notes: {
    flag: 'CODE_INTEL_PUSH_NOTES', resultKey: 'cannot-observe', control: 'none', attributionWindowDays: 1, minSample: LEG_OUTCOME_MIN_SAMPLE,
    denominator: 'exposed notes pushes (exposure and follow-through only)',
    cannotObserveReason: 'a notes push restates a peer\'s prose; no ledger records whether the recipient acted on it, and its effect cannot be separated from the first-touch push in the same turn',
  },
});

/** One eligible trigger. `exposed` = a push was issued for it; false = an unexposed (baseline) trigger. */
export interface LegTrigger { id: string; leg: string; ownerId: string; at: string; exposed: boolean; paths: readonly string[] }
/**
 * One recorded action on a repo-relative path. `touch` = a read or edit; `correct-edit` = an edit
 * not reverted within 24 h whose file passed the next lint:tsc run (D-013); `gate-red` = a gate or
 * lint red on the file; `clone` = a new function that matches an existing clone.
 */
export type LegActionKind = 'touch' | 'correct-edit' | 'gate-red' | 'clone';
export interface LegAction { kind: LegActionKind; ownerId: string | null; at: string; path: string }

export type LegResult =
  | { status: 'measured'; key: LegResultKey; value: number | null; unit: 'ms' | 'share' | 'share-difference'; sample: number; detail: string }
  | { status: 'insufficient-data'; key: LegResultKey; reason: string }
  | { status: 'unmeasured'; key: LegResultKey; reason: string }
  | { status: 'cannot-observe'; key: 'cannot-observe'; reason: string };

export interface LegOutcome {
  leg: PushLegId;
  resultKey: LegOutcomeSpec['resultKey'];
  control: LegControl;
  attributionWindowDays: number;
  denominator: string;
  minSample: number;
  /** Eligible triggers in the scored window (independent source when supplied); null = unmeasured. */
  eligibleTriggers: number | null;
  exposure: number;
  followThrough: { measured: number; positive: number; rate: number | null };
  result: LegResult;
}

export interface LegOutcomeInput {
  windowStart: string;
  windowEnd: string;
  triggers: readonly LegTrigger[];
  actions: readonly LegAction[];
  /** The leg's first push ever (baseline end); default: its earliest exposed trigger, else windowStart. */
  firstExposureAt?: Partial<Record<PushLegId, string | null>>;
  /** Independent eligible-trigger counts for the scored window; default: triggers counted here. */
  eligibleTriggers?: Partial<Record<PushLegId, number | null>>;
  /** Result-side reader limits per leg; such a leg reports unmeasured, never a number. */
  unmeasured?: Partial<Record<PushLegId, string>>;
  /** Override a leg's attribution window (the D-014 boundary test widens it by one day). */
  attributionWindowDays?: Partial<Record<PushLegId, number>>;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Pure: one outcome chain per LEG_OUTCOME_TABLE leg (the same key set as PUSH_LEG_FLAGS). */
export function computeLegOutcomes(input: LegOutcomeInput): LegOutcome[] {
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('A valid [windowStart, windowEnd) is required.');
  const actionsAt = input.actions.map(a => ({ ...a, ms: Date.parse(a.at) })).filter(a => Number.isFinite(a.ms));
  return (Object.keys(LEG_OUTCOME_TABLE) as PushLegId[]).map((leg): LegOutcome => {
    const spec = LEG_OUTCOME_TABLE[leg];
    const days = input.attributionWindowDays?.[leg] ?? spec.attributionWindowDays;
    const windowMs = days * DAY_MS;
    const triggers = input.triggers.filter(t => t.leg === leg).map(t => ({ ...t, ms: Date.parse(t.at) })).filter(t => Number.isFinite(t.ms));
    const scored = (t: { ms: number }) => t.ms >= start && t.ms < end;
    const exposed = triggers.filter(t => t.exposed && scored(t));
    // Attributed only to the trigger's own paths, inside its window, and (unless noted) by its owner.
    const attributed = (t: (typeof triggers)[number], kinds: readonly LegActionKind[], sameOwner: boolean) => actionsAt.filter(a =>
      kinds.includes(a.kind) && t.paths.includes(a.path) && a.ms > t.ms && a.ms <= t.ms + windowMs && (!sameOwner || a.ownerId === t.ownerId));
    const withPaths = exposed.filter(t => t.paths.length > 0);
    const followed = withPaths.filter(t => attributed(t, ['touch', 'correct-edit'], true).length > 0).length;
    const followThrough = { measured: withPaths.length, positive: followed, rate: withPaths.length ? followed / withPaths.length : null };
    const eligibleTriggers = input.eligibleTriggers?.[leg] !== undefined ? input.eligibleTriggers[leg]! : triggers.filter(scored).length;
    const base = {
      leg, resultKey: spec.resultKey, control: spec.control, attributionWindowDays: days, denominator: spec.denominator,
      minSample: spec.minSample, eligibleTriggers, exposure: exposed.length, followThrough,
    };
    if (spec.resultKey === 'cannot-observe') {
      if (!CANNOT_OBSERVE_LEGS.includes(leg)) throw new Error(`Leg ${leg} reports cannot-observe but is not in CANNOT_OBSERVE_LEGS.`);
      return { ...base, result: { status: 'cannot-observe', key: 'cannot-observe', reason: spec.cannotObserveReason ?? '' } };
    }
    const key = spec.resultKey;
    const insufficient = (reason: string): LegOutcome => ({ ...base, result: { status: 'insufficient-data', key, reason } });
    if (exposed.length === 0) return insufficient('zero exposure in the scored window');
    if (eligibleTriggers !== null && eligibleTriggers < spec.minSample) {
      return insufficient(`${eligibleTriggers} eligible trigger(s) in the scored window; the minimum sample is ${spec.minSample}`);
    }
    const limit = input.unmeasured?.[leg];
    if (limit) return { ...base, result: { status: 'unmeasured', key, reason: limit } };
    if (key === 'time to first correct edit') {
      if (exposed.length < spec.minSample) return insufficient(`${exposed.length} exposed push(es); the minimum sample is ${spec.minSample}`);
      const deltas = exposed.flatMap(t => {
        const first = attributed(t, ['correct-edit'], true).reduce((m, a) => Math.min(m, a.ms), Infinity);
        return Number.isFinite(first) ? [first - t.ms] : [];
      });
      return { ...base, result: { status: 'measured', key, value: median(deltas), unit: 'ms', sample: exposed.length,
        detail: `${deltas.length}/${exposed.length} exposed push(es) reached a correct edit within ${days} d` } };
    }
    if (key === 'interface follow-through rate') {
      if (followThrough.measured < spec.minSample) return insufficient(`${followThrough.measured} exposed push(es) with a cited path; the minimum sample is ${spec.minSample}`);
      return { ...base, result: { status: 'measured', key, value: followThrough.rate, unit: 'share', sample: followThrough.measured,
        detail: `${followed}/${followThrough.measured} followed through within ${days} d` } };
    }
    // An 'avoided' key: baseline outcome share minus exposed outcome share (D-027).
    const firstGiven = input.firstExposureAt?.[leg];
    const earliest = triggers.filter(t => t.exposed).reduce((m, t) => Math.min(m, t.ms), Infinity);
    const baselineEnd = firstGiven ? Date.parse(firstGiven) : Number.isFinite(earliest) ? earliest : start;
    const baselineStart = baselineEnd - LEG_BASELINE_DAYS * DAY_MS;
    const baseline = triggers.filter(t => !t.exposed && t.ms >= baselineStart && t.ms < baselineEnd);
    if (baseline.length < spec.minSample) return insufficient(`${baseline.length} baseline trigger(s) in the 7 days before ${new Date(baselineEnd).toISOString()}; the minimum sample is ${spec.minSample}`);
    if (exposed.length < spec.minSample) return insufficient(`${exposed.length} exposed trigger(s); the minimum sample is ${spec.minSample}`);
    const kind: LegActionKind = key === 'clones avoided' ? 'clone' : 'gate-red';
    // A clone is the agent's own new function; a gate red belongs to the file, whoever ran the gate.
    const share = (set: typeof triggers) => set.filter(t => attributed(t, [kind], kind === 'clone').length > 0).length / set.length;
    const baselineShare = share(baseline);
    const exposedShare = share(exposed);
    return { ...base, result: { status: 'measured', key, value: baselineShare - exposedShare, unit: 'share-difference', sample: exposed.length,
      detail: `baseline ${baselineShare.toFixed(3)} over ${baseline.length} trigger(s) [${new Date(baselineStart).toISOString()}, ${new Date(baselineEnd).toISOString()}); exposed ${exposedShare.toFixed(3)} over ${exposed.length}` } };
  });
}

/**
 * R-10 rating: pass only when every observable leg has a measured result; unknown when more than
 * half of the observable legs (cannot-observe excluded from both sides, D-013) are insufficient-data,
 * or when any leg is unmeasured.
 */
export function rateLegOutcomes(outcomes: readonly LegOutcome[]): {
  verdict: 'pass' | 'unknown'; reason: string; measured: string[]; insufficient: string[]; unmeasured: string[];
} {
  const covered = new Set(outcomes.map(o => o.leg));
  const missing = (Object.keys(LEG_OUTCOME_TABLE) as PushLegId[]).filter(leg => !covered.has(leg));
  const observable = outcomes.filter(o => o.result.status !== 'cannot-observe');
  const pick = (status: LegResult['status']) => observable.filter(o => o.result.status === status).map(o => o.leg);
  const measured = pick('measured');
  const insufficient = pick('insufficient-data');
  const unmeasured = pick('unmeasured');
  const reason = `measured: ${measured.join(', ') || 'none'}; insufficient-data: ${insufficient.join(', ') || 'none'}; `
    + `unmeasured: ${unmeasured.join(', ') || 'none'}${missing.length ? `; no outcome computed: ${missing.join(', ')}` : ''}.`;
  const verdict = missing.length || unmeasured.length || insufficient.length * 2 > observable.length || measured.length === 0
    ? 'unknown' as const : 'pass' as const;
  return { verdict, reason, measured, insufficient, unmeasured };
}

// ── The re-score schedule and the score's freshness (R-10; SPEC-P-013-C / -D) ─────────────────

/** Interval of a plan schedule in ms: an interval schedule, or a daily/hourly cron; null = unknown. */
export function legOutcomeScheduleIntervalMs(schedule: unknown): number | null {
  if (!schedule || typeof schedule !== 'object') return null;
  const s = schedule as { kind?: unknown; intervalSec?: unknown; cron?: unknown };
  if (typeof s.intervalSec === 'number' && s.intervalSec > 0) return s.intervalSec * 1000;
  if (typeof s.cron !== 'string') return null;
  const f = s.cron.trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*' || f[4] !== '*' || !/^\d+$/.test(f[0]!)) return null;
  if (/^\d+$/.test(f[1]!)) return DAY_MS;
  if (f[1] === '*') return 3_600_000;
  return null;
}

export type LegScheduleStatus = 'fresh' | 'no-schedule' | 'unarmed' | 'interval-unknown' | 'interval-too-long' | 'no-score' | 'stale';
/**
 * A leg outcome check counts only with an armed schedule of at most 24 h (an unarmed schedule never
 * fires) and a latest score no older than one interval.
 */
export function legOutcomeScheduleVerdict(input: {
  schedule: unknown; active: boolean | null; latestScoreAt: string | null; now: number;
}): { status: LegScheduleStatus; armed: boolean; intervalMs: number | null; reason: string } {
  const intervalMs = legOutcomeScheduleIntervalMs(input.schedule);
  const out = (status: LegScheduleStatus, reason: string) => ({ status, armed: status !== 'no-schedule' && status !== 'unarmed', intervalMs, reason });
  if (!input.schedule) return out('no-schedule', 'The subject plan has no re-score schedule.');
  if (input.active !== true) return out('unarmed', 'The re-score schedule is set but not armed; an unarmed schedule never fires.');
  if (intervalMs === null) return out('interval-unknown', 'The schedule interval cannot be determined.');
  if (intervalMs > LEG_OUTCOME_MAX_INTERVAL_MS) return out('interval-too-long', `The schedule interval ${intervalMs} ms exceeds 24 h.`);
  const at = input.latestScoreAt ? Date.parse(input.latestScoreAt) : NaN;
  if (!Number.isFinite(at)) return out('no-score', 'No recorded score yet.');
  if (input.now - at > intervalMs) return out('stale', `The latest score (${new Date(at).toISOString()}) is older than one interval.`);
  return out('fresh', `The latest score (${new Date(at).toISOString()}) is within one interval.`);
}

// ── The Design-table pin and the check fingerprint (R-7 doc-claims; R-10) ─────────────────────

/** sha256 of the plan's ## Design push-leg table lines (trimmed, joined by \n). */
export const PUSH_LEG_DESIGN_TABLE_SHA256 = 'b56fe4555afc846eb348132dcb127a80d2012061efdbbf35330315896873752b';

/** The table lines under the first `### Push-leg table` heading, trimmed; null when absent. */
export function extractPushLegDesignTable(markdown: string): string | null {
  const lines = markdown.split('\n');
  const heading = lines.findIndex(line => line.trim().startsWith('### Push-leg table'));
  if (heading < 0) return null;
  const rows: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|')) rows.push(trimmed);
    else if (rows.length) break;
    else if (trimmed.startsWith('#')) return null;
  }
  return rows.length ? rows.join('\n') : null;
}

export function pushLegDesignTableHash(table: string): string {
  return createHash('sha256').update(table).digest('hex');
}

export interface PushLegDesignRow { leg: string; flag: string; source: string; resultKey: string; control: string }
export function parsePushLegDesignTable(table: string): PushLegDesignRow[] {
  return table.split('\n').slice(2).map(line => {
    const [leg = '', flag = '', source = '', resultKey = '', control = ''] = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    return { leg, flag, source, resultKey, control };
  });
}

/** Every disagreement between the Design table rows and LEG_OUTCOME_TABLE; empty = in agreement. */
export function pushLegDesignDivergence(rows: readonly PushLegDesignRow[]): string[] {
  const problems: string[] = [];
  const byLeg = new Map(rows.map(row => [row.leg, row]));
  if (byLeg.size !== rows.length) problems.push('The Design table lists a leg more than once.');
  for (const [leg, spec] of Object.entries(LEG_OUTCOME_TABLE) as Array<[PushLegId, LegOutcomeSpec]>) {
    const row = byLeg.get(leg);
    if (!row) { problems.push(`Leg ${leg} is missing from the Design table.`); continue; }
    if (row.flag !== spec.flag) problems.push(`Leg ${leg}: Design flag "${row.flag}" differs from the code map "${spec.flag}".`);
    const expectedKey = spec.resultKey === 'cannot-observe' ? `cannot-observe: ${spec.cannotObserveReason}` : spec.resultKey;
    if (row.resultKey !== expectedKey) problems.push(`Leg ${leg}: Design result key "${row.resultKey}" differs from the code map "${expectedKey}".`);
    if (!row.control.startsWith(`${spec.control}:`)) problems.push(`Leg ${leg}: Design control "${row.control}" does not name the code map's control "${spec.control}".`);
  }
  for (const leg of byLeg.keys()) if (!(leg in LEG_OUTCOME_TABLE)) problems.push(`Design table row ${leg} is not a push leg.`);
  return problems;
}

/** R-10 check fingerprint: the native-adoption.ts blob sha plus the Design-table hash; null if either is unknown. */
export function legOutcomeCheckFingerprint(moduleBlobSha: string | null, designTableHash: string | null): string | null {
  if (!moduleBlobSha || !/^[0-9a-f]{40,64}$/.test(moduleBlobSha) || !designTableHash || !/^[0-9a-f]{64}$/.test(designTableHash)) return null;
  return `native-adoption.ts@${moduleBlobSha}+design@${designTableHash}`;
}

// ── The scheduled instrument (R-10) ───────────────────────────────────────────────────────────

export const LEG_OUTCOMES_INSTRUMENT_KEY = 'code-intel:leg-outcomes';
export const LEG_OUTCOMES_SUBJECT_PLAN = 'code-intel-delivery-and-outcomes-2026-10-26';
export const LEG_OUTCOMES_ACTOR = 'system:code-intel-leg-outcomes';
export const LEG_OUTCOMES_ACTION = 'code-intel.leg-outcomes.score';
export const NATIVE_ADOPTION_MODULE_PATH = 'packages/operator-core/lib/code-intelligence/native-adoption.ts';

/** What the live reader cannot supply yet; each such leg reports unmeasured, never a number. */
export const LEG_OUTCOME_READER_LIMITS: Readonly<Partial<Record<PushLegId, string>>> = Object.freeze({
  grep: 'correct-edit is unread: no ledger records whether an edit was reverted within 24 h or passed the next lint:tsc run (D-013)',
  'first-touch': 'correct-edit is unread: no ledger records whether an edit was reverted within 24 h or passed the next lint:tsc run (D-013)',
  intent: 'correct-edit is unread: no ledger records whether an edit was reverted within 24 h or passed the next lint:tsc run (D-013)',
  resume: 'correct-edit is unread: no ledger records whether an edit was reverted within 24 h or passed the next lint:tsc run (D-013)',
  incident: 'the unexposed baseline triggers and the per-file gate/lint red outcome are not read yet (D-027)',
  completion: 'the unexposed baseline triggers and the per-file gate/lint red outcome are not read yet (D-027)',
  antipattern: 'the unexposed baseline triggers and the per-file gate/lint red outcome are not read yet (D-027)',
  clone: 'the unexposed baseline triggers and the per-function clone outcome are not read yet (D-027)',
});

/**
 * Live input for one scored window: exposed triggers are the push ledger rows; follow-through
 * touches are the recipient's own Read/Edit/Write rows on a cited path inside the attribution
 * window (absolute paths only under the activity harness's exact registered root, never by
 * suffix); eligible counts come from the R-1 liveness readers.
 */
export async function readLegOutcomeInput(
  window: NativeAdoptionWindow, sql: Sql = getOrgPg().sql, resolveRepoRoots: PushRepoRootResolver = registryRepoRoots,
): Promise<LegOutcomeInput> {
  const start = Date.parse(window.windowStart);
  const end = Date.parse(window.windowEnd);
  if (!window.workspaceId.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('An exact workspace and a valid [windowStart, windowEnd) are required.');
  }
  const legs = Object.keys(LEG_OUTCOME_TABLE);
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const maxDays = Math.max(...Object.values(LEG_OUTCOME_TABLE).map(s => s.attributionWindowDays));
  const pushes = await sql<Array<{ id: string; leg: string; owner_id: string; pushed_at: Date | string; cited_paths: string[] | null }>>`
    SELECT id::text, leg, owner_id, pushed_at, cited_paths FROM harness_shared.code_intel_pushes
     WHERE workspace_id = ${window.workspaceId} AND chars > 0 AND leg = ANY(${legs}::text[])
       AND pushed_at >= ${startIso}::timestamptz AND pushed_at < ${endIso}::timestamptz`;
  const first = await sql<Array<{ leg: string; first_at: Date | string }>>`
    SELECT leg, min(pushed_at) AS first_at FROM harness_shared.code_intel_pushes
     WHERE workspace_id = ${window.workspaceId} AND chars > 0 AND leg = ANY(${legs}::text[]) GROUP BY leg`;
  const followTools = [...FILE_FOLLOW_TOOLS, ...FILE_FOLLOW_TOOLS.filter(t => t.startsWith('mcp__papercusp-su__')).map(t => t.replace('mcp__papercusp-su__', 'mcp__papercusp_su__'))];
  // Suffix match is only a prefilter; pushActivityRepoPath below places each path exactly.
  const touches = await sql<Array<{ owner_id: string; created_at: Date | string; detail: Record<string, unknown>; harness: string | null }>>`
    SELECT DISTINCT a.owner_id, a.created_at, jsonb_build_object('file', a.detail->'file', 'file_path', a.detail->'file_path') AS detail, a.harness_slug AS harness
      FROM harness_shared.code_intel_pushes p
      JOIN harness_shared.agent_activity a
        ON a.workspace_id = p.workspace_id AND a.owner_id = p.owner_id
       AND a.created_at > p.pushed_at AND a.created_at <= p.pushed_at + make_interval(days => ${maxDays}::int)
       AND a.kind = 'tool' AND a.phase = 'post' AND a.status = 'ok' AND a.tool_name = ANY(${followTools}::text[])
     WHERE p.workspace_id = ${window.workspaceId} AND p.chars > 0 AND p.leg = ANY(${legs}::text[])
       AND p.pushed_at >= ${startIso}::timestamptz AND p.pushed_at < ${endIso}::timestamptz
       AND EXISTS (SELECT 1 FROM unnest(coalesce(p.cited_paths, '{}'::text[])) cp
         WHERE coalesce(a.detail->>'file', a.detail->>'file_path') = cp OR coalesce(a.detail->>'file', a.detail->>'file_path') LIKE '%/' || cp)`;
  const harnesses = [...new Set(touches.map(t => t.harness).filter((h): h is string => typeof h === 'string' && h.length > 0))].sort();
  const roots = await resolveRepoRoots(harnesses, window.workspaceId);
  const actions: LegAction[] = touches.flatMap(t => {
    const path = pushActivityRepoPath(t.detail ?? {}, t.harness, roots);
    return path === null ? [] : [{ kind: 'touch' as const, ownerId: t.owner_id, at: iso(t.created_at), path }];
  });
  const { pgLivenessReaders } = await import('./push-leg-liveness');
  const readers = pgLivenessReaders(sql as unknown as Parameters<typeof pgLivenessReaders>[0], []);
  const eligibleTriggers: Partial<Record<PushLegId, number | null>> = {};
  for (const leg of legs as PushLegId[]) {
    eligibleTriggers[leg] = (await readers.measureLeg(leg, { workspaceId: window.workspaceId, start, end })).eligible;
  }
  return {
    windowStart: startIso, windowEnd: endIso,
    triggers: pushes.map(p => ({ id: p.id, leg: p.leg, ownerId: p.owner_id, at: iso(p.pushed_at), exposed: true, paths: p.cited_paths ?? [] })),
    actions,
    firstExposureAt: Object.fromEntries(first.map(r => [r.leg, iso(r.first_at)])),
    eligibleTriggers,
    unmeasured: { ...LEG_OUTCOME_READER_LIMITS },
  };
}

/** The native-adoption.ts blob at the running build's commit, read from the registered papercusp checkout. */
async function runningModuleBlobSha(workspaceId: string, buildSha: string | null): Promise<string | null> {
  if (!buildSha || !/^[0-9a-f]{7,64}$/.test(buildSha)) return null;
  try {
    const root = (await registryRepoRoots(['papercusp'], workspaceId)).get('papercusp');
    if (!root) return null;
    const [{ execFile }, { promisify }] = await Promise.all([import('node:child_process'), import('node:util')]);
    const { stdout } = await promisify(execFile)('git', ['-C', root, 'rev-parse', `${buildSha}:${NATIVE_ADOPTION_MODULE_PATH}`], { timeout: 10_000 });
    const blob = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(blob) ? blob : null;
  } catch {
    return null;
  }
}

/** The registered instrument's scheduled measurement (run by the plan's daily rubric-rescore). */
export function codeIntelLegOutcomesRescore() {
  return {
    windowMs: LEG_OUTCOME_WINDOW_MS,
    unit: 'count' as const,
    scope: 'workspace' as const,
    resolve: async (window: { workspaceId: string; windowStart: string; windowEnd: string }) => {
      if (!window.workspaceId.trim()) return { verdict: 'unknown' as const, detail: 'Exact workspace required.' };
      const [{ getBuildInfo }] = await Promise.all([import('../build-info')]);
      const sql = getOrgPg().sql;
      const now = Date.now();
      const [plan] = await sql<Array<{ content: string | null; schedule: unknown; schedule_active: boolean | null }>>`
        SELECT content, schedule, schedule_active FROM harness_shared.harness_plans
         WHERE workspace_id = ${window.workspaceId} AND plan_slug = ${LEG_OUTCOMES_SUBJECT_PLAN}
         ORDER BY (harness_slug = 'papercusp') DESC LIMIT 1`;
      const [previous] = await sql<Array<{ ts: string | number }>>`
        SELECT ts FROM harness_shared.audit_log WHERE workspace_id = ${window.workspaceId} AND action = ${LEG_OUTCOMES_ACTION}
         ORDER BY ts DESC LIMIT 1`;
      const table = plan?.content ? extractPushLegDesignTable(plan.content) : null;
      const tableHash = table ? pushLegDesignTableHash(table) : null;
      const divergence = !table ? ['The subject plan has no ## Design push-leg table.']
        : [...pushLegDesignDivergence(parsePushLegDesignTable(table)),
          ...(tableHash === PUSH_LEG_DESIGN_TABLE_SHA256 ? [] : [`The plan's Design table hash ${tableHash} differs from the pinned ${PUSH_LEG_DESIGN_TABLE_SHA256}.`])];
      const schedule = legOutcomeScheduleVerdict({ schedule: plan?.schedule ?? null, active: plan?.schedule_active ?? null,
        latestScoreAt: previous ? new Date(Number(previous.ts)).toISOString() : null, now });
      const buildSha = getBuildInfo().sha ?? null;
      const fingerprint = legOutcomeCheckFingerprint(await runningModuleBlobSha(window.workspaceId, buildSha), tableHash);
      let outcomes: LegOutcome[] = [];
      let readError: string | null = null;
      try {
        outcomes = computeLegOutcomes(await readLegOutcomeInput(window, sql));
      } catch (err) {
        readError = err instanceof Error ? err.message : String(err);
      }
      const rating = rateLegOutcomes(outcomes);
      const scheduleBroken = schedule.status === 'no-schedule' || schedule.status === 'unarmed'
        || schedule.status === 'interval-unknown' || schedule.status === 'interval-too-long';
      const verdict = divergence.length || scheduleBroken ? 'fail' as const
        : readError || !fingerprint ? 'unknown' as const : rating.verdict;
      const legs = Object.keys(LEG_OUTCOME_TABLE);
      await sql`INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
        VALUES (${`ci-leg-outcomes-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`}, ${now}, ${LEG_OUTCOMES_ACTOR},
          ${LEG_OUTCOMES_ACTION}, ${LEG_OUTCOMES_INSTRUMENT_KEY},
          ${sql.json(JSON.parse(JSON.stringify({ verdict, fingerprint, buildSha, legs, schedule, divergence, readError, rating, outcomes, window })))},
          ${window.workspaceId})`;
      const detail = `fingerprint ${fingerprint ?? 'unknown'}; legs ${legs.join(',')}; schedule ${schedule.status}; `
        + (divergence.length ? `Design-table divergence: ${divergence.join(' ')} ` : '')
        + (readError ? `read error: ${readError}; ` : '') + rating.reason;
      return { verdict, detail, value: rating.measured.length };
    },
  };
}

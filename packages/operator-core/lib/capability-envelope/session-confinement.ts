/**
 * session-confinement — the launch-declared, PRIVILEGE-INDEPENDENT tool denial
 * (directed-pair-work-items-2026-08-25 P-003, ruling D-015).
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `ROLE_ENVELOPES`
 * -------------------------------------------------
 * The directed pair (D-001/D-003) needs a handful of tools to be genuinely
 * unreachable by the IMPLEMENTER — completion authority and self-direction belong
 * to the director. D-004 assumed a launch-time denial like NO_SUBAGENT_TOOLS_DENY
 * would do it. It does not, and neither does the role envelope. Measured, not assumed:
 *
 *   1. `--disallowedTools` is CLIENT-side. `spawn-mcp.ts` says it outright at the
 *      superuser-spawn door: "Dispatch capability is unchanged — isSuperuser still
 *      bypasses role gates; only the advertised list narrows." A denied tool stays
 *      dispatchable through `tools:invoke { name }`.
 *   2. `evaluateCapabilityEnvelope` returns `{ withinEnvelope: true, applied: false }`
 *      on `ctx.isSuperuser || ctx.isPowerUser` BEFORE it reads the role — so
 *      `ROLE_ENVELOPES` never evaluates for an su-tier member at all.
 *   3. The implementer MUST be su-tier: `coord:*` is resolveAgentIdentity-gated, and
 *      the whole call-response contract is `coord:send` evidence replies. Demoting it
 *      to a signed spawn removes the channel the design runs on.
 *   4. The envelope's grain is CAPABILITY, not tool. `work_items:complete` and
 *      `scheduler:get_next` both declare `capability:'work_items:write'` — shared by
 *      43 tools including `checkpoint`, `comment`, `claim`, `create`. Denying that
 *      capability to block `complete` would strand the implementer's own progress
 *      recording.
 *
 * D-015's reading: the superuser exemption is not wrong, it is keyed on the wrong
 * predicate for this population. `policy.ts` justifies it as "supervised human
 * sessions keep native-tool ergonomics; the policy is the safety net precisely where
 * there is no human." A directed implementer is exactly a session with NO human; it
 * is su-tier only as a side-effect of needing coord identity. So rather than punch a
 * hole in that exemption, this is a SEPARATE and differently-shaped gate:
 *
 *   ROLE ENVELOPE          = a PRIVILEGE CEILING. "How much are you trusted with?"
 *                            Correctly exempts supervised humans.
 *   SESSION CONFINEMENT    = a SELF-IMPOSED NARROWING declared by the launcher.
 *                            "What did the thing that started you promise you would
 *                            not do?" Privilege is irrelevant to that question.
 *
 * TWO STRUCTURAL GUARANTEES, BOTH BY CONSTRUCTION RATHER THAN BY DISCIPLINE
 * ------------------------------------------------------------------------
 *  A. It CANNOT be bypassed by privilege, because it never receives privilege.
 *     `evaluateSessionConfinement` takes no `ctx`, no `isSuperuser`, no `role`. There
 *     is no privilege check to get wrong, and no future edit can "just add one" without
 *     failing the guard test that pins this module's imports and identifiers.
 *  B. It CANNOT widen, because there is no allow dimension. `SessionToolConfinement`
 *     has `denyTools` and an optional additional `denyOutside` ceiling. Neither
 *     can lift an ordinary gate or a denial. The worst a malformed or hostile confinement
 *     can do is deny more. (Same invariant `dynamic-tool-confinement` holds, reached
 *     the same way: remove the widening vocabulary rather than police its use.)
 *
 * ⚠ THE WIRING INVARIANT THAT MAKES OR BREAKS THIS
 * ------------------------------------------------
 * This module is the pure DECISION. It is worth nothing until it is consulted at the
 * dispatch seat that `tools:invoke` ALSO traverses. Consulting it only at the outer
 * MCP tool-call boundary reproduces exactly the theatre it exists to replace: the
 * agent simply routes the denied verb through `tools:invoke` and the gate never runs.
 * `assertConfinementCoversIndirectDispatch` below is the executable statement of that
 * requirement; the seat wiring is a TCB edit and ships as such.
 *
 * Server-or-bundle-safe: pure, no I/O.
 */
import { CHANGE_KINDS } from '../change-kind-catalog';
import { matchesAny } from './policy';

/**
 * A denial declared by whatever launched the session, travelling WITH the session.
 *
 * Deliberately has no grant dimension: see guarantee (B). Deliberately carries `imposedBy`
 * and `reason` so a refusal can tell the agent who bound it and why — a wall with no
 * explanation gets probed, a wall with a reason gets respected and reported upward,
 * which is the behaviour the directed pair actually wants.
 */
export interface SessionToolConfinement {
  /** Tool-name globs this session may never invoke, at any privilege level. */
  readonly denyTools: readonly string[];
  /** Additional exact canonical ceiling: deny EVERY name outside this set.
   * Empty denies everything. This cannot lift denyTools or ordinary gates.
   * Aliases are resolved by the dispatcher; ambiguous mangled names never grant. */
  readonly denyOutside?: readonly string[];
  /** Suppress ambient hook, recall, cache and initialize context. The launcher
   * supplies the assignment's frozen context separately before generation. */
  readonly denyAmbientContext?: true;
  /** Additional argument boundary, supplied by the host rather than the caller.
   * Only canonical single-item read/progress/completion calls may target it. */
  readonly denyWorkItemsOutside?: { readonly id: string; readonly harness: string; readonly checkout: string };
  /** Nominated product documentation and raw per-file test history only. This
   * narrows existing read tools; it grants no plan/bound-evidence access. */
  readonly denyProductReadsOutside?: ProductReadBoundary;
  /** The session's own scratch plans only (verification-system-improvements-2026-10-10
   * D-050). This narrows the SCRATCH_PLAN_TOOLS a ceiling admits. It never admits a
   * plan verb by itself, and it never reaches the reviewed plan. */
  readonly denyPlansOutside?: ScratchPlanBoundary;
  /** Explicit recall is confined to the frozen bytes in the exact assignment
   * checkout. This does not enable automatic ambient injection. */
  readonly denyMemoryOutside?: { readonly snapshotSha256: string };
  /** Managed respawns may replay only this host-pinned initial assignment and,
   * when enabled, the caller's bounded continuation note. Never ambient carry. */
  readonly denyCarryOutside?: FrozenCarryBoundary;
  /** Why this session is confined — surfaced verbatim in the refusal. */
  readonly reason: string;
  /** Who imposed it (the launching director/fleet), for audit and for the refusal text. */
  readonly imposedBy: string;
}

export interface SessionConfinementDecision {
  /** False ⇒ refuse the call. */
  readonly allowed: boolean;
  /** Whether a confinement was actually present and evaluated (false ⇒ unconfined session). */
  readonly applied: boolean;
  /** Human-readable refusal, including the imposer and their stated reason. */
  readonly reason?: string;
  /** The specific glob that matched — so a refusal is debuggable, not just a wall. */
  readonly matchedGlob?: string;
}

export interface FrozenCarryBoundary {
  readonly initialPrompt: string;
  readonly initialPromptSha256: string;
  readonly mode: 'on' | 'off';
  /** Preregistered context-token trigger, identical across paired arms. */
  readonly compactionLimit?: number;
}

export function validFrozenCarryBoundary(value: unknown): value is FrozenCarryBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key =>
    ['initialPrompt', 'initialPromptSha256', 'mode', 'compactionLimit'].includes(key)) &&
    (row.compactionLimit === undefined || Number.isSafeInteger(row.compactionLimit) && (row.compactionLimit as number) >= 20_000) &&
    typeof row.initialPrompt === 'string' && row.initialPrompt.trim().length > 0 && row.initialPrompt.length <= 200_000 &&
    typeof row.initialPromptSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.initialPromptSha256) &&
    (row.mode === 'on' || row.mode === 'off');
}

export interface FrozenCarryTriggerReceipt {
  kind: 'matched-threshold' | 'recovery';
  source: 'self-request' | 'watchdog-soft' | 'watchdog-force' | 'context-death' | 'tool-reference-death';
  limitTokens: number;
  nativeSessionId: string;
  observedTokens: number;
  observedAtMs: number;
  usageSource: 'codex-last-token-usage' | 'live-transcript-bytes/4';
}

/** Pure host evidence shared by the carry builder, handler and watchdog.
 * Recovery never certifies a matched schedule, even above its frozen limit. */
export function frozenCarryTriggerReceipt(boundary: FrozenCarryBoundary, input: {
  source: FrozenCarryTriggerReceipt['source'];
  usage: import('../compaction-usage').CurrentContextUsage;
  runtimeLimit?: number;
}, nowMs = Date.now()): FrozenCarryTriggerReceipt {
  const reading = input.usage.reading;
  const matched = input.source === 'self-request' || input.source === 'watchdog-soft';
  if (!validFrozenCarryBoundary(boundary) || boundary.compactionLimit === undefined ||
      !['self-request', 'watchdog-soft', 'watchdog-force', 'context-death', 'tool-reference-death'].includes(input.source) ||
      !['codex-last-token-usage', 'live-transcript-bytes/4'].includes(reading?.source ?? '') ||
      input.runtimeLimit !== undefined && input.runtimeLimit !== boundary.compactionLimit ||
      !input.usage.nativeSessionId?.trim() || !reading ||
      !Number.isSafeInteger(reading.tokens) || reading.tokens < 0 ||
      !Number.isSafeInteger(reading.observedAtMs) || reading.observedAtMs > nowMs + 30_000 ||
      nowMs - reading.observedAtMs > 60_000 ||
      matched && reading.tokens < boundary.compactionLimit)
    throw new Error('Frozen compaction trigger is unmeasured, changed or below its preregistered threshold.');
  return { kind: matched ? 'matched-threshold' : 'recovery', source: input.source,
    limitTokens: boundary.compactionLimit, nativeSessionId: input.usage.nativeSessionId,
    observedTokens: reading.tokens, observedAtMs: reading.observedAtMs, usageSource: reading.source };
}

const ALLOWED: SessionConfinementDecision = { allowed: true, applied: true };
const UNCONFINED: SessionConfinementDecision = { allowed: true, applied: false };

export interface ProductReadBoundary {
  readonly harness: string;
  readonly docsHarness: string;
  readonly docsSlugs: readonly string[];
  readonly testFiles: readonly string[];
}

export function validProductReadBoundary(value: unknown): value is ProductReadBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const scope = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(s) && s !== 'all';
  const path = (s: unknown) => typeof s === 'string' && s.length <= 1000 &&
    /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(s) && s.split('/').every(p => p && p !== '.' && p !== '..');
  return Object.keys(row).every(key => ['harness', 'docsHarness', 'docsSlugs', 'testFiles'].includes(key)) &&
    scope(row.harness) && scope(row.docsHarness) &&
    Array.isArray(row.docsSlugs) && row.docsSlugs.length <= 10 && row.docsSlugs.every(path) &&
    Array.isArray(row.testFiles) && row.testFiles.length <= 20 &&
    row.testFiles.every(p => path(p) && /\.(?:test|spec)\.[mc]?[jt]sx?$/.test(p));
}

function withinProductReadBoundary(tool: string, args: unknown, boundary: ProductReadBoundary): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const row = args as Record<string, unknown>;
  const keys = tool === 'docs:get' ? ['harness', 'slugs', 'heading', 'offset'] :
    tool === 'testing:run' ? ['harness', 'files', 'timeoutMs', 'maxFailures'] :
      tool === 'testing:run-status' ? ['runId'] :
        ['harness', 'filePath', 'source', 'since', 'sinceHours', 'status', 'limit'];
  if (Object.keys(row).some(key => !keys.includes(key) && key !== 'projection' && key !== 'payloadTier')) return false;
  if (tool === 'docs:get') return row.harness === boundary.docsHarness && Array.isArray(row.slugs) &&
    row.slugs.length > 0 && row.slugs.length <= 10 && row.slugs.every(s => boundary.docsSlugs.includes(s));
  // Execute only the nominated product files. Evidence recovery, alternate roots,
  // changed-path discovery and work-item/spec bindings would reveal author context.
  if (tool === 'testing:run') return row.harness === boundary.harness && Array.isArray(row.files) &&
    row.files.length > 0 && row.files.length <= 20 && row.files.every(s => boundary.testFiles.includes(s)) &&
    Number.isInteger(row.timeoutMs) && Number(row.timeoutMs) >= 1000 && Number(row.timeoutMs) <= 120000 &&
    Number.isInteger(row.maxFailures) && Number(row.maxFailures) >= 1 && Number(row.maxFailures) <= 5;
  // A foreground testing:run timeout hands back a detached run id, and polling it is the
  // only way to read that run's verdict (WI-6554700010018202). The id names one execution
  // the reviewer was handed (its own detached run, or a run group already visible in a
  // nominated file's history); it reads test output, never the plan, rubric or bound proof.
  if (tool === 'testing:run-status') return typeof row.runId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(row.runId);
  // Exact file selectors avoid broad ledger reads and author-selected proof IDs.
  // Bound the raw history; the reviewer discovers observations independently.
  return row.harness === boundary.harness && typeof row.filePath === 'string' && boundary.testFiles.includes(row.filePath) &&
    ['local', 'admin-ui', 'mutation-probe'].includes(String(row.source)) &&
    Number.isInteger(row.limit) && Number(row.limit) >= 1 && Number(row.limit) <= 20 &&
    (typeof row.since === 'string' && Number.isFinite(Date.parse(row.since)) ||
      typeof row.sinceHours === 'number' && row.sinceHours > 0 && row.sinceHours <= 168);
}

/**
 * A blind reviewer's own scratch plans (D-050). The mint draws `scratchPrefix` fresh for
 * each reviewer, so no other session's plan can match it. `reviewedSlug` is never
 * reachable: a call whose arguments contain it anywhere is refused.
 */
export interface ScratchPlanBoundary {
  readonly scratchPrefix: string;
  readonly reviewedSlug: string;
  readonly harness: string;
}

/** The plan verbs a scratch boundary narrows. A ceiling must still name each one; a
 * ceiling without the boundary leaves them refused like every other plan tool. */
export const SCRATCH_PLAN_TOOLS: readonly string[] = Object.freeze([
  'plans:new', 'plans:add-item', 'plans:set-status', 'plans:audit', 'plans:get', 'plans:set-plan-status',
  'plan-types:list', 'plan-types:get', 'cupboard:search',
]);

/** Benchmark planning uses the same private plan boundary, with draft authoring
 * only. Auditing, activation and shipment can recruit inference outside its meter. */
export const BENCHMARK_SCRATCH_PLAN_TOOLS: readonly string[] = Object.freeze([
  'plans:new', 'plans:add-item', 'plans:get',
]);

// Exact top-level keys per verb. Left out on purpose: multi-plan selectors (slugs),
// session reads (sourceRanges, mappings), work-item references (findings, evidence,
// verification, priorAttemptRefs, operationalBrief), rubric classes (classRef), and
// workspace overrides. Creation may bypass topic dedup only inside the reviewer's
// already authenticated, isolated scratch prefix; it cannot affect another plan.
const SCRATCH_PLAN_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'plans:new': ['harness', 'slug', 'title', 'status', 'goal', 'content', 'rationale', 'verificationProfile', 'force'],
  'plans:add-item': ['harness', 'slug', 'phase', 'text', 'title', 'body', 'blockedBy', 'importance', 'deliverable', 'items', 'rationale'],
  'plans:set-status': ['harness', 'slug', 'item', 'itemIds', 'items', 'status', 'note', 'rationale', 'expectedStatus'],
  'plans:audit': ['harness', 'slug', 'phase', 'dryRun', 'items', 'summary', 'auditedSha'],
  'plans:get': ['harness', 'slug', 'items', 'itemIds', 'decisionId', 'decisions', 'decisionIds', 'mode', 'detail',
    'heading', 'include', 'includeHistory', 'shipReadiness', 'activationReadiness'],
  'plans:set-plan-status': ['harness', 'slug', 'status', 'rationale', 'expectedCurrent', 'dryRun'],
  'plan-types:list': ['harness', 'kind', 'prefix', 'includeRetired'],
  'plan-types:get': ['harness', 'kind', 'typeId', 'revision'],
  'cupboard:search': ['kind', 'q', 'project', 'limit', 'cursor'],
});
// Keys of one batch entry. An entry's own slug and harness are checked like the top level's.
const SCRATCH_PLAN_ENTRY_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'plans:add-item': ['slug', 'harness', 'phase', 'text', 'title', 'body', 'blockedBy', 'importance', 'deliverable', 'rationale'],
  'plans:set-status': ['slug', 'harness', 'item', 'status', 'note', 'rationale'],
  'plans:audit': ['itemId', 'verdict', 'citations', 'note'],
});
const ITEM_ID = /^P-\d{3,}$/;
const DECISION_ID = /^D-\d{3,}$/;

export function validScratchPlanBoundary(value: unknown): value is ScratchPlanBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ['scratchPrefix', 'reviewedSlug', 'harness'].includes(key)) &&
    typeof row.scratchPrefix === 'string' && /^(?:blind-review|benchmark)-scratch-[a-z0-9]{6,32}-$/.test(row.scratchPrefix) &&
    typeof row.reviewedSlug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(row.reviewedSlug) &&
    typeof row.harness === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(row.harness) && row.harness !== 'all';
}

export function validFrozenMemoryBoundary(value: unknown): value is NonNullable<SessionToolConfinement['denyMemoryOutside']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 1 && typeof row.snapshotSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.snapshotSha256);
}

function withinFrozenMemoryBoundary(tool: string, args: unknown, harness: string): boolean {
  if (tool !== 'memory:search' || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const row = args as Record<string, unknown>;
  return Object.keys(row).every(key => ['query', 'limit', 'harness_slug', 'harnessOnly', 'projection', 'payloadTier'].includes(key)) &&
    typeof row.query === 'string' && row.query.trim().length > 0 && row.query.length <= 500 &&
    row.harness_slug === harness && row.harnessOnly === true &&
    (row.limit === undefined || Number.isSafeInteger(row.limit) && Number(row.limit) >= 1 && Number(row.limit) <= 20);
}

function withinScratchPlanBoundary(tool: string, args: unknown, boundary: ScratchPlanBoundary): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  // The blind-review ledger probe counts any plan-family call whose arguments contain the
  // reviewed slug (D-039 (4)). Refusing every such call keeps that probe exact and keeps
  // the reviewed plan out of reach however its slug is spelled into a field.
  if (JSON.stringify(args).includes(boundary.reviewedSlug)) return false;
  const row = args as Record<string, unknown>;
  if (boundary.scratchPrefix.startsWith('benchmark-scratch-') &&
      (!BENCHMARK_SCRATCH_PLAN_TOOLS.includes(tool) || row.harness !== boundary.harness ||
       tool === 'plans:new' && (row.status !== 'draft' || row.force !== true))) return false;
  const keys = SCRATCH_PLAN_KEYS[tool];
  if (!keys || Object.keys(row).some(key => !keys.includes(key) && key !== 'projection' && key !== 'payloadTier')) return false;
  // Registry definitions and public pack listings are product surfaces, not plan
  // instances, rubrics or bound proof. The tool schemas validate their remaining
  // argument values after these exact selector and workspace restrictions.
  if (tool === 'plan-types:list' || tool === 'plan-types:get') return row.harness === boundary.harness;
  if (tool === 'cupboard:search') return row.kind === 'pack';
  const scratch = (slug: unknown) => typeof slug === 'string' && slug.length > boundary.scratchPrefix.length &&
    slug.length <= 200 && slug.startsWith(boundary.scratchPrefix);
  const id = (value: unknown, re: RegExp) => value === undefined || typeof value === 'string' && re.test(value);
  const ids = (value: unknown, re: RegExp) => value === undefined ||
    Array.isArray(value) && value.length <= 200 && value.every(v => typeof v === 'string' && re.test(v));
  if (!scratch(row.slug) || row.harness !== undefined && row.harness !== boundary.harness) return false;
  if (tool === 'plans:new' && row.force !== undefined && row.force !== true) return false;
  // A real ship call recruits an acceptance grader. The reviewer may only preview one.
  if (tool === 'plans:set-plan-status' && row.dryRun !== true) return false;
  // Item and decision selectors stay inside the named plan: bare P- and D- ids only.
  if (!id(row.item, ITEM_ID) || !ids(row.itemIds, ITEM_ID) || !ids(row.blockedBy, ITEM_ID) ||
      !id(row.decisionId, DECISION_ID) || !ids(row.decisions, DECISION_ID) || !ids(row.decisionIds, DECISION_ID)) return false;
  if (row.items === undefined) return true;
  if (tool === 'plans:get') return ids(row.items, ITEM_ID);
  const entryKeys = SCRATCH_PLAN_ENTRY_KEYS[tool];
  if (!entryKeys || !Array.isArray(row.items) || row.items.length === 0 || row.items.length > 200) return false;
  return row.items.every(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).some(key => !entryKeys.includes(key)) || e.slug !== undefined && !scratch(e.slug) ||
        e.harness !== undefined && e.harness !== boundary.harness ||
        !id(e.item, ITEM_ID) || !id(e.itemId, ITEM_ID) || !ids(e.blockedBy, ITEM_ID)) return false;
    // Audit citations: code and test paths, and a reasoned `none`. Work-item, artifact,
    // measurement, doc and external citations resolve objects outside the scratch plan.
    return e.citations === undefined || Array.isArray(e.citations) && e.citations.every(c =>
      !!c && typeof c === 'object' && !Array.isArray(c) &&
      ['code', 'test', 'none'].includes(String((c as Record<string, unknown>).kind)) &&
      Object.keys(c).every(key => ['kind', 'path', 'line', 'symbol', 'reason'].includes(key)));
  });
}

export function validWorkItemBoundary(value: unknown): value is NonNullable<SessionToolConfinement['denyWorkItemsOutside']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => key === 'id' || key === 'harness' || key === 'checkout') &&
    typeof row.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(row.id) &&
    typeof row.harness === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(row.harness) &&
    typeof row.checkout === 'string' && row.checkout.startsWith('/') && !row.checkout.includes('\\') &&
    row.checkout.split('/').every(part => part !== '..' && part !== '.');
}

function withinWorkItemBoundary(toolName: string, args: unknown,
  boundary: NonNullable<SessionToolConfinement['denyWorkItemsOutside']>): boolean {
  if (!validWorkItemBoundary(boundary) || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const row = args as Record<string, unknown>;
  if (row.id !== boundary.id || row.harness !== boundary.harness) return false;
  // Batch/alias/ref lookup and cross-object side effects are deliberately absent.
  // These are the maintained tools' ordinary single-item workflow shapes.
  const keys: Record<string, readonly string[]> = {
    'work_items:get': ['id', 'harness', 'detail', 'resume', 'checksOnly', 'operationalBrief', 'threadLimit'],
    'work_items:checkpoint': ['id', 'harness', 'checkpoint', 'append', 'unchanged', 'contentHash'],
    'work_items:complete': ['id', 'harness', 'state', 'assumptions', 'completion', 'validateOnly',
      'changeKinds', 'changeKindReason'],
  };
  const permitted = keys[toolName];
  if (!permitted || Object.keys(row).some(key => !permitted.includes(key) && key !== 'projection' && key !== 'payloadTier')) return false;
  if (toolName !== 'work_items:complete') return true;
  if (row.state !== 'done' || row.assumptions !== 'none' || !row.completion ||
      typeof row.completion !== 'object' || Array.isArray(row.completion)) return false;
  // A successful close is refused without a change-kind declaration, so the
  // declaration must pass. Both fields are inert labels on this same item. Per-kind
  // proof stays in the root completion fields: `completion.kindEvidence` is not
  // admitted below, because its ui-artifact proof is read server-side.
  if (row.changeKinds !== undefined && (!Array.isArray(row.changeKinds) || row.changeKinds.length === 0 ||
      row.changeKinds.length > CHANGE_KINDS.length ||
      !row.changeKinds.every(kind => typeof kind === 'string' && (CHANGE_KINDS as readonly string[]).includes(kind)))) return false;
  if (row.changeKindReason !== undefined && (typeof row.changeKindReason !== 'string' ||
      row.changeKindReason.trim().length === 0 || row.changeKindReason.length > 1000)) return false;
  const completion = row.completion as Record<string, unknown>;
  if (Object.keys(completion).some(key => !['summary', 'testsRun', 'testResult', 'verifiedHow', 'filesChanged', 'filesDeleted', 'verification'].includes(key))) return false;
  if (completion.verification !== undefined) {
    const verification = completion.verification;
    if (!verification || typeof verification !== 'object' || Array.isArray(verification) ||
        Object.keys(verification).some(key => key !== 'coverage')) return false;
    const coverage = (verification as Record<string, unknown>).coverage;
    if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) return false;
    const row = coverage as Record<string, unknown>;
    const keys = ['population', 'checked', 'notChecked', 'notApplicable', 'residue'];
    if (Object.keys(row).some(key => !keys.includes(key)) ||
        !Array.isArray(row.population) || !row.population.length ||
        keys.some(key => row[key] !== undefined && (!Array.isArray(row[key]) ||
          !(row[key] as unknown[]).every(value => typeof value === 'string' && value.trim().length > 0)))) return false;
    // Coverage is inert description; the completion tool validates its partition.
    // Residue references can trigger cross-item ownership reads, so a confined
    // assignment may submit only the maintained zero-residue forms.
    if (!Array.isArray(row.residue) || row.residue.length > 0 &&
        !(row.residue.length === 1 && row.residue[0] === 'none')) return false;
  }
  // The completion tool reads named files server-side. Keep those proof reads
  // inside the assignment checkout, including on platforms with backslashes.
  return ['filesChanged', 'filesDeleted'].every(key => completion[key] === undefined ||
    Array.isArray(completion[key]) && (completion[key] as unknown[]).every(path =>
      typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') &&
      !/^[A-Za-z]:/.test(path) && path.split('/').every(part => part !== '..' && part !== '.')));
}

/**
 * The key a tool name is MATCHED on: `mcp__<server>__` prefix stripped, and `:`
 * folded to `_`.
 *
 * Clients mangle `server:verb` into `mcp__<server>__server_verb`. A denial that caught
 * only one spelling would be bypassable by invoking the other — the same class of hole
 * as the client-side deny this replaces — so both must land on one key.
 *
 * ⚠ Reversing the mangling is NOT how to do that, and the attempt is a trap worth
 * recording: `server_verb` is ambiguous whenever either half contains an underscore.
 * Splitting on the first underscore turns `work_items_complete` into `work:items_complete`;
 * splitting on the last turns `scheduler_get_next` into `scheduler_get:next`. There is no
 * split that is right for both, because the information was destroyed by the mangling.
 *
 * So instead of reconstructing the colon, both sides FOLD toward the mangled form, which
 * is lossy in the safe direction: the fold can only make two distinct names collide, and
 * a collision on a DENY list can only ever deny more, never less (guarantee B). A name
 * that must stay reachable is therefore protected by the collateral tests, not by luck.
 */
export function toDenyMatchKey(toolName: string): string {
  let name = toolName.trim();
  if (name.startsWith('mcp__')) {
    const sep = name.indexOf('__', 'mcp__'.length);
    if (sep >= 0) name = name.slice(sep + 2);
  }
  return name.replaceAll(':', '_');
}

/**
 * The whole gate. Note the argument shape: there is no `ctx`, no `isSuperuser`, no
 * `role`. That absence IS guarantee (A) — it is not an oversight, and the guard test
 * fails if a later edit introduces one.
 */
export function evaluateSessionConfinement(args: {
  toolName: string;
  confinement?: SessionToolConfinement | null;
  args?: unknown;
  /** Host-only metadata listing, which executes no work-item operation.
   * Default dispatch always checks arguments, including when they are absent. */
  purpose?: 'listing';
}): SessionConfinementDecision {
  const { toolName, confinement } = args;
  if (!confinement) return UNCONFINED;
  if (confinement.denyOutside !== undefined &&
      (!Array.isArray(confinement.denyOutside) || !confinement.denyOutside.includes(toolName.trim()))) {
    return { allowed: false, applied: true, matchedGlob: 'outside-exact-ceiling',
      reason: `tool "${toolName.trim()}" is outside the launch-declared ceiling imposed by ${confinement.imposedBy}: ${confinement.reason}` };
  }
  if (confinement.denyWorkItemsOutside !== undefined &&
      (!validWorkItemBoundary(confinement.denyWorkItemsOutside) ||
       args.purpose !== 'listing' && toDenyMatchKey(toolName).startsWith('work_items_') &&
       !withinWorkItemBoundary(toolName.trim(), args.args, confinement.denyWorkItemsOutside))) {
    return { allowed: false, applied: true, matchedGlob: 'outside-exact-work-item',
      reason: `tool "${toolName.trim()}" must use the launch-declared single work-item boundary imposed by ${confinement.imposedBy}: ${confinement.reason}` };
  }
  // A frozen assignment can request the maintained deterministic boundary for
  // its own logical session. Caller-authored focus/continuation hints must not
  // replace its host-owned task or frozen context. This narrows the existing
  // tool; it neither grants it outside denyOutside nor lifts denyTools.
  if (confinement.denyWorkItemsOutside !== undefined && toolName.trim() === 'session:request-compaction' &&
      args.purpose !== 'listing' && (!args.args || typeof args.args !== 'object' ||
        Array.isArray(args.args) || Object.keys(args.args).some(key => key !== 'continueNote') ||
        Object.keys(args.args).length !== 0 &&
          (!validFrozenCarryBoundary(confinement.denyCarryOutside) || confinement.denyCarryOutside.mode !== 'on' ||
           typeof (args.args as Record<string, unknown>).continueNote !== 'string' ||
           ((args.args as Record<string, unknown>).continueNote as string).length > 1000))) {
    return { allowed: false, applied: true, matchedGlob: 'outside-exact-carry',
      reason: `managed self-compaction may only use its enabled bounded continuation note inside the assignment imposed by ${confinement.imposedBy}: ${confinement.reason}` };
  }
  if (confinement.denyCarryOutside !== undefined &&
      (!validFrozenCarryBoundary(confinement.denyCarryOutside) || !validWorkItemBoundary(confinement.denyWorkItemsOutside) ||
       confinement.denyAmbientContext !== true || confinement.denyOutside === undefined))
    return { allowed: false, applied: true, matchedGlob: 'outside-frozen-carry',
      reason: 'Managed carry requires a valid host-pinned frozen assignment and exact tool ceiling.' };
  if (confinement.denyMemoryOutside !== undefined &&
      (!validFrozenMemoryBoundary(confinement.denyMemoryOutside) || !validWorkItemBoundary(confinement.denyWorkItemsOutside) ||
       args.purpose !== 'listing' && toDenyMatchKey(toolName).startsWith('memory_') &&
       !withinFrozenMemoryBoundary(toolName.trim(), args.args, confinement.denyWorkItemsOutside.harness))) {
    return { allowed: false, applied: true, matchedGlob: 'outside-frozen-memory',
      reason: `memory recall must use the launch-declared frozen assignment imposed by ${confinement.imposedBy}: ${confinement.reason}` };
  }
  if (confinement.denyProductReadsOutside !== undefined &&
      (!validProductReadBoundary(confinement.denyProductReadsOutside) ||
       args.purpose !== 'listing' && ['docs:get', 'testing:runs', 'testing:run', 'testing:run-status'].includes(toolName.trim()) &&
       !withinProductReadBoundary(toolName.trim(), args.args, confinement.denyProductReadsOutside))) {
    return { allowed: false, applied: true, matchedGlob: 'outside-exact-product-read',
      reason: `tool "${toolName.trim()}" must use the nominated product read boundary imposed by ${confinement.imposedBy}: ${confinement.reason}` };
  }
  if (confinement.denyPlansOutside !== undefined &&
      (!validScratchPlanBoundary(confinement.denyPlansOutside) ||
       args.purpose !== 'listing' && SCRATCH_PLAN_TOOLS.includes(toolName.trim()) &&
       !withinScratchPlanBoundary(toolName.trim(), args.args, confinement.denyPlansOutside))) {
    const scope = validScratchPlanBoundary(confinement.denyPlansOutside)
      ? ` (a slug starting ${confinement.denyPlansOutside.scratchPrefix}, the verb's listed keys only, dryRun:true for plans:set-plan-status)` : '';
    return { allowed: false, applied: true, matchedGlob: 'outside-exact-scratch-plan',
      reason: `tool "${toolName.trim()}" may only touch this session's own scratch plans${scope}, under the boundary imposed by ${confinement.imposedBy}: ${confinement.reason}` };
  }
  if (confinement.denyTools.length === 0)
    return confinement.denyOutside === undefined && confinement.denyWorkItemsOutside === undefined &&
      confinement.denyProductReadsOutside === undefined && confinement.denyPlansOutside === undefined &&
      confinement.denyMemoryOutside === undefined && confinement.denyCarryOutside === undefined ? UNCONFINED : ALLOWED;

  const key = toDenyMatchKey(toolName);
  for (const glob of confinement.denyTools) {
    // Both sides folded to the same key, so either spelling the caller used matches.
    if (matchesAny(key, [toDenyMatchKey(glob)])) {
      return {
        allowed: false,
        applied: true,
        matchedGlob: glob,
        reason:
          `tool "${toolName.trim()}" is denied for this session by ${confinement.imposedBy}: ` +
          `${confinement.reason} (matched "${glob}"). This denial is declared at launch and ` +
          `is not liftable from inside the session — if this milestone genuinely requires ` +
          `this tool, that is a finding to report upward, not an obstacle to route around.`,
      };
    }
  }
  return ALLOWED;
}

/**
 * The D-004 minimum set, plus the two classes without which the denial is decorative.
 * Every entry carries the reason it is here; an unexplained denial is one nobody dares
 * remove later even when it turns out to be wrong.
 */
export const DIRECTED_IMPLEMENTER_DENY_TOOLS: readonly string[] = [
  // ── D-004 minimum set ────────────────────────────────────────────────────────
  // Completion authority is the director's; the implementer REPORTS evidence and the
  // director decides whether it closes. This is the single most important entry: it is
  // what makes "the director verifies" structural rather than aspirational (D-002).
  'work_items:complete',
  // Self-direction. The implementer executes the milestone it was handed; it never
  // picks its own next one (D-001 — the director gates milestone boundaries).
  'scheduler:get_next',
  // A wake source of its own turns call-response back into an autonomous loop, which
  // is the one structural property the whole design rests on (D-001/D-004).
  'loop:arm',

  // ── Same class as scheduler:get_next — self-acquisition by another door ──────
  'work_items:claim_next',

  // ── Self-lift / self-graduation: a denial an agent can remove is not a denial ──
  // Mirrors dynamic-tool-confinement's no-minting floor for the same reason: without
  // these, everything above is one tool call away from being undone.
  'capability_envelope:*',
  'capability:grant*',
  'capability:revoke*',
  // Tier is risk CLASSIFICATION, and papercuspTierFor consults the runtime override
  // BEFORE the baked table — so a self-re-tier is a self-lift by another door. Globbed
  // rather than exact (`capability_tier:set`): deny-widening is the safe direction for a
  // no-escalation floor, and it covers any future `capability_tier:` sibling for free.
  //
  // ⚠ EI-21475119505876554: this entry read `capability:set-tier` until 2026-08-26 — a
  // name that resolves to NO tool. It denied nothing while reading exactly like coverage.
  // Removed alongside it: `capability:set_protected`, dead for a stronger reason — there
  // is no protected-floor mutation tool in ANY spelling (`capability_envelope:set_role`
  // is the only envelope tool, and its own notWhen states the universal protected floor
  // is not mutable through it). Nothing was narrowed by dropping it.
  //
  // Both survived because a dead deny entry is SILENT by construction: denying too much
  // fails loudly the first time real work is blocked; denying too little fails never.
  // Hence the catalog PIN in session-confinement.test.ts — this list is no longer
  // trusted to be right, it is checked.
  'capability_tier:*',
  'meta:define-*',
  'tools:scaffold',
];

/** Build the confinement a directed implementer launches with. */
export function directedImplementerConfinement(args: {
  /** The coupled director's session id — named in every refusal. */
  directorSid: string;
  /**
   * What this engagement is scoped to, named verbatim in every refusal — the plan the pair
   * launched on, or a single work item when the pair was launched for exactly one.
   *
   * Deliberately NOT a work-item id (it was, until P-004): a confinement is declared at LAUNCH
   * and lasts the session, while the work items it will work arrive one at a time from the
   * director over that session's life. Naming an item here would either be a lie at launch —
   * there is no item yet — or force the confinement to be rewritten per directive, which is a
   * mutable security rail, the thing this design exists to avoid.
   */
  scope: string;
}): SessionToolConfinement {
  return {
    denyTools: DIRECTED_IMPLEMENTER_DENY_TOOLS,
    imposedBy: `pair-director ${args.directorSid}`,
    reason:
      `you are the directed implementer for ${args.scope}; completion authority and ` +
      `work selection belong to the director (D-002/D-004)`,
  };
}

/**
 * The executable statement of the wiring invariant in this module's header.
 *
 * A confinement wired only at the outer tool-call boundary is bypassed by
 * `tools:invoke { name: '<denied verb>' }`. This asserts the gate refuses the INNER
 * name, which is only true if the seat that consults it is the one indirect dispatch
 * also passes through. Called by the guard test; exported so the dispatch wiring can
 * assert it against its own seat rather than trusting a comment.
 */
export function assertConfinementCoversIndirectDispatch(
  evaluate: (toolName: string) => SessionConfinementDecision,
): void {
  const denied = evaluate('work_items:complete');
  if (denied.allowed) {
    throw new Error(
      'session confinement is not consulted at the dispatch seat: a denied tool was allowed. ' +
        'A gate that only runs at the outer tool-call boundary is bypassed by tools:invoke ' +
        'and is exactly the theatre D-015 replaced.',
    );
  }
}

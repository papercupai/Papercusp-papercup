/**
 * tool-error-classifier.ts — the SINGLE source of truth for how a failed
 * `harness_shared.tool_invocations` row is classified into a `ToolErrorClass`.
 *
 * The classification is consumed in TWO places that used to be "kept in sync"
 * by a comment and DRIFTED in practice
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-011):
 *   1. `classifyToolError` — the TS reference fn (the documented oracle).
 *   2. the SQL `CASE` that `watchdog.ts collectToolErrorSignals` runs to
 *      classify rows in-DB at scale.
 *
 * The drift was real: a `handler_error` row whose message starts
 * `"invalid_args: …"` classified `caller` in SQL (`LIKE 'invalid_args:%'`) but
 * `structural` in the TS fn (its error-code branch never checked the message
 * prefix). 100+ high-volume rows/day disagreed between the two.
 *
 * FIX: both the TS fn AND the SQL CASE are now GENERATED from one ordered
 * `TOOL_ERROR_RULES` table — they cannot drift by construction. The fixture
 * regression test (tool-error-classifier.test.ts) locks the live high-volume
 * buckets to their correct class; the integration test
 * (tool-error-classifier.integration.test.ts) runs the GENERATED SQL CASE over
 * the corpus and asserts row-by-row agreement with `classifyToolError`.
 *
 * ── Pattern dual-engine constraint (load-bearing) ─────────────────────────────
 * Every `messagePattern` below is a string that MUST be a valid regular
 * expression in BOTH:
 *   • Postgres `~*` (POSIX ERE, case-insensitive), and
 *   • JS `new RegExp(pattern, 'i')`.
 * The constructs we use — `|`, `?`, `*`, `+`, `^`, `(…)`, `[ _-]`, literal
 * chars — mean the same thing in both engines, so one string drives both. Do
 * NOT use engine-specific syntax (JS `\s`/`\d`/`\b`/lookarounds, or POSIX
 * `[[:alpha:]]` classes) — those would make the two engines disagree, which is
 * the very thing this module exists to prevent. `compileRulePatterns()` (run at
 * module load + asserted in the test) fails fast if a pattern won't compile as
 * a JS RegExp.
 */

/**
 * A failed tool call's class. Each deserves a different FIRE bar + destination:
 *   - structural — a real bug/misconfig (the tool, a missing table, a wiring
 *     gap). Fires on FEW occurrences OR a high error-rate → auto-implement.
 *   - transient  — timeout / load / shared-infra exhaustion. Volume-gated.
 *   - caller     — the caller sent bad input, lacks a role, was rejected at the MCP auth gate, or lost run authority (DX/auth/control flow). kind=change.
 *   - rate-limit — an EXTERNAL provider rate-limit / quota (OpenAI embed TPM
 *     429). Capacity, not a code bug → infra/owner, never the auto-implement lane.
 */
import { createHash } from 'node:crypto';

export type ToolErrorClass = 'structural' | 'transient' | 'caller' | 'rate-limit';

/** The default class when no rule matches. */
export const DEFAULT_TOOL_ERROR_CLASS: ToolErrorClass = 'structural';

/**
 * One classification rule. A row matches the rule when ANY of its predicate
 * kinds match: `error_code ∈ errorCodes`, `status ∈ statuses`, or the
 * `error_message` matches `messagePattern` (case-insensitive). Rules are
 * evaluated IN ORDER; the first match wins. The table is the single source for
 * both the TS fn and the SQL CASE.
 */
export interface ToolErrorRule {
  /** The class to assign on a match (never `structural` — that is the fallback). */
  readonly class: Exclude<ToolErrorClass, 'structural'>;
  /** Exact `error_code` matches (any). */
  readonly errorCodes?: readonly string[];
  /** Exact `status` matches (any). */
  readonly statuses?: readonly string[];
  /** Dual-engine POSIX-ERE / JS pattern matched against `error_message` (case-insensitive). */
  readonly messagePattern?: string;
  /** One-line human rationale (docs / test legibility). */
  readonly why: string;
}

// ── The shared message patterns (dual-engine; see the module header) ──────────

/** A timeout, including one that surfaced as `handler_error`
 *  ("exceeded timeout … handler returned but signal had aborted") or the
 *  handler's explicit whole-call-deadline diagnostic or bounded query embedding
 *  deadline. Word boundaries keep
 *  argument names such as `timeoutSec` from looking like a timeout outcome. */
export const TIMEOUT_MESSAGE_PATTERN =
  'exceeded timeout([^a-zA-Z]|$)|(^|[^a-zA-Z])timed? *out([^a-zA-Z]|$)|did not complete within [0-9]+ms of its whole-call deadline|(^|[^a-zA-Z0-9_])query embed exceeded [0-9]+ms budget([^a-zA-Z0-9_]|$)';

/** Caller-side auth/arg/scope error in the MESSAGE: a retained
 *  `missing_capability:` prefix from a nested `tools:invoke` refusal, or an `invalid_args:` prefix
 *  (regardless of the row's error_code — this is the bit the old TS fn missed),
 *  including the `invalid_input: invalid_args:` wrapper from a nested
 *  `tools:invoke` refusal,
 *  the intentional scratch-reference line-window size refusal
 *  (scratch_line_window_too_large), or the explicitly caller-side JSON reasons
 *  for absent scratch evidence and missing tenant-scope controls,
 *  the checkpoint replacement/merge safety refusals that require explicit
 *  retirement of carried safety rows, and the stale loop-carry compare-and-swap
 *  conflict that requires a fresh read before retrying,
 *  or compact MCP text tagged `format: toon|csv|tsv` incorrectly passed to
 *  `JSON.parse`,
 *  a missing / unregistered browser UI client for a CLI caller,
 *  an explicit compaction flush-gate refusal that requires a checkpoint,
 *  an explicit claim-spec selector refusal for the literal `self` sentinel,
 *  an explicit reviewer-model allowlist refusal,
 *  a missing / unregistered harness, a registered standalone harness passed
 *  to the Hive-scoped plan store, a desktop-only capability called before its
 *  sandbox lease was provisioned, or a pre-vetting / approval refusal caused
 *  by the caller-authored acceptance BAR contract. A missing WORKSPACE-scope
 *  ("requires a workspace-scoped call") is deliberately NOT here — a
 *  workspace-scoping gap is treated as `structural` (a wiring gap worth catching
 *  at the low bar), and the fingerprint separates it from anything it used to mask. */
export const CALLER_MESSAGE_PATTERN =
  '^missing_capability:|^invalid_input: *invalid_args:|^invalid_args:|^role_not_allowed:|^reviewer_model_not_allowed:|(^|[^a-zA-Z])(client_id_required|client_not_found):|scratch_line_window_too_large|"reason":"(evidence_class_not_found|tenant_scope_required|positive_control_tenant_scope_required|mixed_window_modes)"|await_id and event are mutually exclusive|checkpoint_(replace_would_drop_rows|merge_would_evict_rows)|"error":"(checkpoint_conflict|flush-required)"|(^|[^a-zA-Z0-9_])acceptance_bar_amendment_revision_conflict:|(^|[^a-zA-Z0-9_])acceptance_bar_approval_required:|(^|[^a-zA-Z0-9_])acceptance_bar_(approval_(invalid_receipt|stale_or_mismatched|unparseable|incomplete|ambiguous_preview_pointer|preview_self_reference|preview_unreadable|author_mismatch)|preview_unparseable)([^a-zA-Z0-9_]|$)|No harness specified|not registered in (any workspace|harness_shared)|resolvePlanScope:.*is not a Hive home|no sandbox desktop is leased|acceptance BAR contract is not ready for vetting|predicate_shape_mismatch:|structured_result_shape.*typed root|format: *(toon|csv|tsv).*content.*text.*JSON[.]parse|content.*text.*JSON[.]parse.*format: *(toon|csv|tsv)|^cupId must be a concrete session/owner ID, not the literal "self"';

/** `dev:pg_query` returns caller-authored SQL's undefined-column refusal with
 *  its PostgreSQL 42703 code and a known-column correction payload. When
 *  tools:invoke wraps that `isError` result, invocation-friction sees the
 *  wrapper's `handler_error`; and the canonical capture shorthand may paraphrase
 *  the payload instead of retaining its JSON envelope. Retain either form as
 *  caller input instead of filing the wrapper as a structural tool bug. Bare
 *  application missing-column errors remain structural. */
export const PG_QUERY_UNDEFINED_COLUMN_CALLER_PATTERN =
  '^(?:column "[^"]+" does not exist: .*"code":"42703".*"knownColumns"|' +
  'Read-only .* query used [^,]+, but the live relation exposes .*\\. Server returned knownColumns)';

/** An EXTERNAL provider rate-limit / quota (OpenAI embedding TPM 429,
 *  "Rate limit reached", surfaced as `openai_embed_failed_429`). CAPACITY, not a
 *  code bug — must not fall through to `structural` (P-002). */
export const RATE_LIMIT_MESSAGE_PATTERN =
  'openai_embed_failed_429|rate[ _-]?limit[ _-]?(reached|exceeded)|tokens per min|requests per min|too many requests';

/** The operator's own MCP admission bulkhead returns a retryable shed response
 *  when the event loop is critical or its in-flight capacity is full. That is
 *  backpressure from the shared admission gate, not a per-tool implementation
 *  defect. */
export const OPERATOR_ADMISSION_TRANSIENT_MESSAGE_PATTERN =
  'operator MCP admission(?: is)? saturated|reason[=: ]+(loop_pressure_critical|operator_admission_capacity)';

/** The release admission worker deliberately rejects overlapping same-process jobs. */
export const ADMISSION_OFFTHREAD_BUSY_MESSAGE_PATTERN =
  'an admission job is already running in this process; retry after it settles';

/** Shared-infra exhaustion (PG `max_connections` / DB-unavailable), an operator
 *  shutdown-window response, and a stale-pooled-connection reset against
 *  PgBouncer. These recur identically in SHAPE across tools during a wedge /
 *  shutdown / idle-reap race, but are transient LOAD/infra, not per-tool bugs —
 *  defer to the volume bar so a brief interruption stops mis-filing structural
 *  tool-bug EIs.
 *
 *  `CONNECTION_CLOSED` / `CONNECT_TIMEOUT` are postgres-js-invented codes
 *  ("write CONNECTION_CLOSED 127.0.0.1:6432") for a pooled connection PgBouncer
 *  idle-reaped server-side, or the pool's own connect() timing out — the exact
 *  codes `connect-retry.ts` already treats as provably-transient and retries
 *  (EI-9279). Matching on them here cannot mask an unrelated application error
 *  (they are postgres-js's own codes), and keeps the classifier in lockstep with
 *  the retry helper so a transient reset that slips past the retry stops being
 *  mis-filed as a structural tool bug (EI-11010). */
export const INFRA_TRANSIENT_MESSAGE_PATTERN =
  'too many clients already|remaining connection slots are reserved|too many connections|the database system is (starting up|shutting down|in recovery|not yet accepting)|server( is)? shutting down|terminating connection due to|ECONNREFUSED|ECONNRESET|CONNECTION_CLOSED|CONNECT_TIMEOUT|connection terminated|could not connect to server|current session authority could not be read|session authority reader unavailable|identity policy evaluation unavailable|could not access status of transaction [0-9]+|deadlock detected';

/** The pre-destructive backup hook fails closed when the filesystem cannot fit
 * the next dump. This is an intentional capacity gate, not a deterministic
 * backup-tool defect; keep it on the volume-gated transient path so a couple
 * of safety refusals do not enter the structural auto-implement lane. */
export const BACKUP_FREE_SPACE_REFUSAL_MESSAGE_PATTERN =
  'insufficient free space \\([0-9]+ available; [0-9]+ needed for a dump of';

/** An explicit nsenter refusal to open a process namespace is the operating
 * system enforcing the caller's namespace boundary, not a capability:bash
 * implementation failure. Keep this narrow so unrelated child permission
 * errors still use the structural fallback. */
export const PROCESS_NAMESPACE_PERMISSION_DENIED_MESSAGE_PATTERN =
  '(^|[^A-Za-z0-9_])nsenter: cannot open /proc/[0-9]+/ns/[A-Za-z_]+: (permission denied|operation not permitted)';

/** The native exec pre-tool guard deliberately rejects rm -f cleanup syntax.
 *  Preserve its proven abbreviated capture message as caller input as well;
 *  the generic shell-command-rejected code can also describe unrelated bugs. */
export const NATIVE_SHELL_CLEANUP_REFUSAL_PATTERN =
  'rm -f style (commands are not permitted|cleanup[^.]*not permitted)|rm -f cleanup (was )?disallowed by (the )?command guard before invocation|^Rejected rm -f style commands; use safer approach$';

/**
 * The ordered classification table. ORDER IS SIGNIFICANT — earlier rules win.
 * Keep the specific structured_result_shape code ahead of generic transient
 * prose, while leaving mcp_auth_failed later so a specific verifier diagnostic
 * can still refine that wrapper code. The P-011 invalid_args message rule also
 * handles generic handler_error rows.
 */
export const TOOL_ERROR_RULES: readonly ToolErrorRule[] = [
  {
    class: 'caller',
    errorCodes: ['structured_result_shape'],
    why: 'code:run diagnosed a script reading an MCP content envelope instead of the returned typed root; this specific caller code must outrank unrelated secondary error text',
  },
  {
    class: 'caller',
    errorCodes: ['self_await_deadlock'],
    why: 'events:await deliberately refuses a wait on the current assignee\'s own work-item lifecycle; the guard prevents an unsatisfiable self-deadlock, so this is caller-side control flow rather than a tool defect',
  },
  {
    class: 'transient',
    errorCodes: ['mcp_proxy_upstream_error', 'mcp_proxy_upstream_unavailable'],
    why: 'the MCP proxy returned its terminal upstream-failure envelope after its retry window; outcome_unknown describes replay safety, not a structural tool fault',
  },
  {
    class: 'transient',
    errorCodes: ['timeout', 'query_embed_deadline'],
    statuses: ['timeout'],
    messagePattern: TIMEOUT_MESSAGE_PATTERN,
    why: 'a bounded timeout is transient, including query embedding deadlines and handler_error wrappers',
  },
  {
    class: 'transient',
    errorCodes: ['superuser_native_session_verifier_unavailable'],
    messagePattern: '(^|[^A-Za-z0-9_])superuser_native_session_verifier_unavailable([^A-Za-z0-9_]|$)',
    why: 'the native-session verifier could not complete its server-side authority read before dispatch; caller input is not the cause, and detailed verifier diagnostics are retained in mcpAuthFailure metadata',
  },
  {
    class: 'caller',
    errorCodes: ['aborted'],
    why: 'the parent request/session cancelled the tool call; dispatch reports this control-flow outcome separately from a tool or handler defect',
  },
  {
    class: 'caller',
    messagePattern: '(^|[^a-zA-Z0-9_])refused-agent-busy([^a-zA-Z0-9_]|$)',
    why: 'session:end deliberately refuses a mid-turn shutdown; when tools:invoke preserves that nested refusal under handler_error, it is caller control flow rather than a structural tool defect',
  },
  {
    class: 'caller',
    errorCodes: ['stale_tool_contract'],
    messagePattern: '(^|[^a-zA-Z0-9_])stale_tool_contract([^a-zA-Z0-9_]|$)',
    why: 'tools:invoke and the MCP host intentionally reject a schema bound to an older serving generation before target dispatch; refresh tools:find/tools:list and retry against the current operator',
  },
  {
    class: 'caller',
    messagePattern: 'events:status.*evidence-only judge may inspect its own awaits only.*exact-key inspection and fleet-meter access are unavailable',
    why: 'events:status deliberately refuses exact-key and fleet-wide meter reads for an evidence-only judge; dispatch surfaces this authorization refusal through handler_error, so it must not enter the structural auto-fix lane',
  },
  {
    class: 'caller',
    messagePattern: '(^|[^A-Za-z0-9_])git_command_interrupted([^A-Za-z0-9_]|$)',
    why: 'capability:git-evidence returns this reason when its request AbortSignal cancels a Git command; this is expected request/session control flow, not a structural tool defect',
  },
  {
    class: 'caller',
    errorCodes: ['blocked_command', 'PreToolUseCommandRejected'],
    messagePattern: NATIVE_SHELL_CLEANUP_REFUSAL_PATTERN,
    why: 'the native exec pre-tool guard deliberately rejected rm -f cleanup syntax before command execution; this is an expected caller-side refusal, not a structural tool defect',
  },
  {
    class: 'caller',
    errorCodes: ['volatile_reference_requires_byte_window'],
    statuses: ['volatile_reference_requires_byte_window'],
    messagePattern: 'volatile_reference_requires_byte_window',
    why: 'capability:read deliberately refuses volatile scratch references without an exact byte window; tools:invoke preserves this caller-side paging precondition inside handler_error',
  },
  {
    class: 'caller',
    errorCodes: [
      'invalid_args', 'invalid_input', 'role_not_allowed', 'missing_capability',
      'compile_error',
      'quota_exceeded', 'harness_required', 'checkpoint_conflict', 'checkpoint_replace_would_drop_rows',
      'checkpoint_merge_would_evict_rows',
      'flush-required', 'rubric-not-found', 'reviewer_model_not_allowed',
      'dynamic_import_unsupported', 'mcp_auth_failed', 'evidence_class_not_found',
      'tenant_scope_required', 'positive_control_tenant_scope_required',
      'scratch_line_window_too_large', 'mixed_window_modes', 'client_id_required', 'client_not_found',
      'owner_not_found', 'owner_ambiguous',
      // capability:read found the one real spill a hand-retyped scratch cursor meant
      // and returned it as did_you_mean (scratch-path-recovery.ts, plan bug-inflow R-8).
      'scratch_path_mistyped',
    ],
    statuses: ['role-not-allowed', 'scratch_line_window_too_large', 'mixed_window_modes'],
    messagePattern: CALLER_MESSAGE_PATTERN,
    why: 'the caller sent bad input or stale state (including code:run JavaScript that fails to parse before dispatch), chose a reviewer outside the expert allowlist, attempted an import in the import-free code:run sandbox, lacked a role, was rejected at the MCP auth gate, named no (or an unregistered) harness, selected a missing UI client, supplied an owner handle that matches no or multiple known owners, hit an explicit flush or scratch-reference window-size precondition, supplied stale loop:checkpoint or acceptance BAR revision-bound compare-and-swap state and was refused, combined mutually exclusive capability:read window modes or events:status selectors, read code:run typed output as an MCP content envelope despite its structured_result_shape typed-root diagnostic, or passed tagged compact MCP text (format: toon/csv/tsv) to JSON.parse — not a tool bug',
  },
  {
    class: 'caller',
    messagePattern: "capability:bash cwd '[^']+' (does not exist|exists but is not a directory)",
    why: 'capability:bash preflights an explicit cwd before spawning; a missing path or file passed as cwd is caller input, not a structural tool failure',
  },
  {
    class: 'caller',
    messagePattern: PROCESS_NAMESPACE_PERMISSION_DENIED_MESSAGE_PATTERN,
    why: 'nsenter was refused while opening a process namespace; this is an OS permission boundary on the requested command, not a capability:bash defect',
  },
  {
    class: 'caller',
    errorCodes: ['native_tool_owner_unsupported_capability'],
    statuses: ['native_tool_owner_unsupported_capability'],
    messagePattern: '^native_tool_owner_unsupported_capability$',
    why: 'the native-owner transport deliberately refuses to forward host-local authenticatedPrincipal capabilities across its RPC boundary; this is an expected transport refusal, not a structural defect in the named tool. Match the direct code, retained status, or exact message when telemetry omitted the code',
  },
  {
    class: 'caller',
    errorCodes: ['resolver_owner_mismatch_or_not_executing'],
    why: 'bulk-resolve and plan-cleanup tools refuse reports, actions, and settlement after a run stops or its resolver ownership changes; this is an expected authority-state refusal, not a structural tool defect',
  },
  {
    class: 'caller',
    errorCodes: ['admission_recovery_refused'],
    why: 'coord:dispatch resumeAdmission deliberately refuses calls that lack the original authenticated recovery binding or fail current recovery gates; this is expected admission control, not a structural dispatch defect',
  },
  {
    class: 'caller',
    messagePattern: PG_QUERY_UNDEFINED_COLUMN_CALLER_PATTERN,
    why: 'dev:pg_query wraps a caller-authored SQL 42703 undefined-column refusal with knownColumns guidance; tools:invoke must not turn that target refusal into a structural wrapper bug',
  },
  {
    class: 'caller',
    messagePattern:
      'patch verification could not find the expected|patch was rejected before writing because .*abbreviated text|patch was rejected because one expected source line did not match exactly',
    why: 'the patch tool deliberately refused a hunk whose expected source context did not match; refresh the exact file context instead of filing a Papercusp structural defect',
  },
  {
    class: 'caller',
    messagePattern: 'Identity capability \\(unresolved\\): outside-ceiling|Identity capability \\(unresolved\\): stale-artifact',
    why: 'the kernel refused an identity capability check: outside-ceiling is absent from the authored grant, while stale-artifact means the caller launch record cannot prove the desired identity revision. Both are expected authorization-state refusals, not defects in the named tool',
  },
  {
    class: 'caller',
    messagePattern: 'coord:ask is owner-UI-only',
    why: 'coord:ask deliberately denies direct agent calls; this owner-UI-only permission refusal is caller-side, while generic unauthorized workspace-scope failures remain structural',
  },
  {
    // A normalized wrapper absent from the client surface was never dispatched.
    // Codex reports the same local lookup miss in several phrasings; it is not a
    // server defect because the target MCP handler never ran.
    class: 'caller',
    errorCodes: [
      'wrapper_missing',
      'client_wrapper_missing',
      'unknown_tool_wrapper',
      'wrapper-unavailable',
      'client_wrapper_unavailable',
      'client-wrapper-unavailable',
      'client-wrapper-absent',
    ],
    statuses: [
      'wrapper_missing',
      'wrapper-unavailable',
      'client_wrapper_unavailable',
      'client-wrapper-unavailable',
      'client-wrapper-absent',
    ],
    messagePattern:
      'Normalized direct wrapper mcp__papercusp_su__[A-Za-z0-9_]+ was not callable|' +
      'The normalized direct wrapper [A-Za-z0-9_.]+ was not callable(?: \\([^)]*\\))? before dispatch|' +
      'The normalized direct wrapper [A-Za-z0-9_.]+ was undefined, so attempting it raised a local TypeError before MCP dispatch|' +
      'The catalog exposed [^,]+, but the normalized functions\\.exec method [A-Za-z0-9_.]+ was undefined and raised a TypeError before dispatch|' +
      'the normalized wrapper was undefined and calling it threw TypeError before MCP dispatch|' +
      'tools\\.mcp__papercusp_su__[A-Za-z0-9_]+ is not callable .*calling it raised TypeError before dispatch|' +
      'Direct nested [^ ]+ wrapper call threw TypeError: tools\\.mcp__papercusp_su__[A-Za-z0-9_]+ is not a function before dispatch',
    why: 'the Codex client tried to call a deferred normalized wrapper before MCP dispatch; use tools:find/tools:invoke, because no target server handler ran',
  },
  {
    class: 'rate-limit',
    messagePattern: RATE_LIMIT_MESSAGE_PATTERN,
    why: 'an EXTERNAL provider rate-limit / quota (OpenAI embed TPM 429) — capacity, not a code bug',
  },
  {
    class: 'transient',
    messagePattern: OPERATOR_ADMISSION_TRANSIENT_MESSAGE_PATTERN,
    why: 'the operator MCP admission gate returned retryable backpressure under critical loop pressure or full capacity — not a per-tool defect',
  },
  {
    class: 'transient',
    errorCodes: ['ADMISSION_OFFTHREAD_BUSY'],
    messagePattern: ADMISSION_OFFTHREAD_BUSY_MESSAGE_PATTERN,
    why: 'release:repair-queue deliberately refuses an overlapping same-process admission job and asks the caller to retry after it settles; this is expected transient backpressure, not a structural tool defect',
  },
  {
    class: 'transient',
    errorCodes: ['sidecar_required_unavailable'],
    messagePattern: `${INFRA_TRANSIENT_MESSAGE_PATTERN}|${BACKUP_FREE_SPACE_REFUSAL_MESSAGE_PATTERN}`,
    why: 'shared-infra exhaustion (PG max_connections / DB unavailable / disk-full transaction-status failure / backup free-space admission / embedding sidecar unavailable) — not a per-tool bug',
  },
];

/**
 * Tool-error classes that carry an error-shape FINGERPRINT in their dedup key
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-012). Originally only
 * `structural` was fingerprinted (P-003); `caller` and `transient` are added so
 * genuinely DIFFERENT same-class modes under one tool stop collapsing onto a
 * single key and masking each other (e.g. `plans:new` rejecting `note too big`
 * vs `status invalid option` vs `paths too small` — distinct DX fixes that used
 * to share one `plans:new:caller` EI). `rate-limit` is deliberately EXCLUDED:
 * every provider-429 under a tool is the SAME capacity concern, so fingerprinting
 * it would FRAGMENT one EI into many — the opposite of dedup.
 *
 * Both the SQL fingerprint CASE (`toolErrorFingerprintSqlCase`) and the TS
 * fingerprint read this set, so they cannot drift on which classes are fingerprinted.
 *
 * bug-inflow-one-problem-one-row-2026-10-18 D-004: the fingerprint no longer
 * shapes the signal KEY (`toolErrorSignalKey` is structural). It remains the
 * per-reporter corroboration dimension and the identity of LEGACY open keys the
 * structural verifier still has to read until the key migration re-keys them.
 */
export const FINGERPRINTED_TOOL_ERROR_CLASSES: ReadonlySet<ToolErrorClass> =
  new Set<ToolErrorClass>(['structural', 'caller', 'transient']);

/**
 * Error codes emitted by a shared transport/subsystem rather than by the named
 * tool handler. Their filing identity is the subsystem plus error code, so a
 * result-door failure from `facts:list` and `work_items:get` remains one row.
 */
const TOOL_FAILURE_SUBSYSTEM_BY_ERROR_CODE: Readonly<Record<string, string>> = {
  output_spill_failed: 'result-door',
};

export function toolFailureSubsystemForCode(errorCode: string | null | undefined): string | null {
  const normalized = errorCode?.trim().toLowerCase();
  return normalized ? TOOL_FAILURE_SUBSYSTEM_BY_ERROR_CODE[normalized] ?? null : null;
}

/** Compile every rule's messagePattern as a JS RegExp once. Throws (at module
 *  load) if a pattern is not a valid JS regex — the cheap half of the
 *  dual-engine guarantee (the SQL `~*` half is proven by the integration test). */
function compileRulePatterns(): { rule: ToolErrorRule; re: RegExp | null }[] {
  return TOOL_ERROR_RULES.map((rule) => ({
    rule,
    re: rule.messagePattern ? new RegExp(rule.messagePattern, 'i') : null,
  }));
}

const COMPILED_RULES = compileRulePatterns();

/**
 * Pure: classify one tool failure by walking the shared table in order and
 * returning the first rule whose error_code / status / message matches; falls
 * back to `structural`. This is the TS half of the single source — the SQL CASE
 * (`toolErrorClassSqlCase`) is generated from the same table.
 */
export function classifyToolError(
  errorCode: string | null | undefined,
  status: string | null | undefined,
  errorMessage: string | null | undefined,
): ToolErrorClass {
  const code = errorCode ?? '';
  const st = status ?? '';
  const msg = errorMessage ?? '';
  for (const { rule, re } of COMPILED_RULES) {
    if (code && rule.errorCodes && rule.errorCodes.includes(code)) return rule.class;
    if (st && rule.statuses && rule.statuses.includes(st)) return rule.class;
    if (msg && re && re.test(msg)) return rule.class;
  }
  return DEFAULT_TOOL_ERROR_CLASS;
}

/** A postgres.js tagged-template fn. Typed structurally + generically so this
 *  module needn't import `@papercusp/db-org` (keeps it unit-testable without PG):
 *  the caller passes the real `getOrgPg().sql`, and the value-binding / fragment
 *  composition is what postgres.js already does throughout watchdog.ts.
 *
 *  The values are `any[]` (not `unknown[]`) deliberately: this one type must
 *  accept BOTH the real postgres `Sql` (whose params are the stricter
 *  `Serializable`) AND the test's debug tag — `any` is the bivariant form both
 *  satisfy; `unknown[]` would make the real `Sql` non-assignable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlTag<T> = (strings: TemplateStringsArray, ...values: any[]) => T;

/** OR together one rule's predicates into a single SQL boolean fragment. */
function ruleConditionSql<T>(sql: SqlTag<T>, rule: ToolErrorRule): T {
  const preds: T[] = [];
  if (rule.errorCodes?.length) preds.push(sql`error_code = ANY(${rule.errorCodes as string[]}::text[])`);
  if (rule.statuses?.length) preds.push(sql`status = ANY(${rule.statuses as string[]}::text[])`);
  if (rule.messagePattern) preds.push(sql`error_message ~* ${rule.messagePattern}`);
  if (preds.length === 0) return sql`FALSE`;
  return preds.reduce((a, b) => sql`${a} OR ${b}`);
}

/**
 * Generate the `CASE … END` SQL fragment that classifies a row into a
 * `ToolErrorClass`, from the SAME `TOOL_ERROR_RULES` table the TS fn walks. The
 * fragment references the bare columns `error_code`, `status`, `error_message`,
 * so embed it where those are in scope (the `fail` CTE of
 * `collectToolErrorSignals`). The result is `CASE WHEN … THEN '<class>' … ELSE
 * 'structural' END`.
 */
export function toolErrorClassSqlCase<T>(sql: SqlTag<T>): T {
  let whens = sql``;
  for (const rule of TOOL_ERROR_RULES) {
    whens = sql`${whens} WHEN ${ruleConditionSql(sql, rule)} THEN ${rule.class}`;
  }
  return sql`CASE${whens} ELSE ${DEFAULT_TOOL_ERROR_CLASS} END`;
}

/**
 * Pure: an MD5 digest of the full normalized message skeleton (lowercased,
 * digit-stripped, punctuation-collapsed). The former first-six-token key let
 * repeated boilerplate prefixes hide distinct failures whose paths or causes
 * appeared later in the message. Returns null when the message has no alpha content.
 *
 * MIRROR of `toolErrorFingerprintSqlCase`'s SQL expression — the two MUST agree
 * (proven row-by-row by the integration test). PostgreSQL's built-in md5 keeps
 * parity independent of optional extensions. This TS form lets the key-migration
 * routine recompute a fingerprint from an EI's stored sample.
 */
export function toolErrorFingerprint(message: string | null | undefined): string | null {
  const skeleton = (message ?? '')
    .toLowerCase()
    .replace(/[0-9]+/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  if (!skeleton) return null;
  return `md5-${createHash('md5').update(skeleton, 'utf8').digest('hex')}`;
}

/**
 * Generate the SQL fragment that computes the error-shape fingerprint for the
 * fingerprinted classes (and NULL otherwise). The class membership comes from
 * `FINGERPRINTED_TOOL_ERROR_CLASSES`, so SQL + TS cannot drift on which classes
 * are fingerprinted. The arithmetic mirrors `toolErrorFingerprint` exactly
 * (parity proven by the integration test). References the bare `class` /
 * `error_message` columns, so embed where they are in scope (the `tagged` CTE).
 */
export function toolErrorFingerprintSqlCase<T>(sql: SqlTag<T>): T {
  const classes = [...FINGERPRINTED_TOOL_ERROR_CLASSES];
  return sql`CASE WHEN class = ANY(${classes}::text[]) THEN
    nullif('md5-' || md5(trim(regexp_replace(
      regexp_replace(lower(coalesce(error_message, '')), '[0-9]+', '', 'g'),
      '[^a-z]+', ' ', 'g'))), 'md5-' || md5(''))
  ELSE NULL END`;
}

// ── Structural signal identity (bug-inflow-one-problem-one-row-2026-10-18 D-003/D-004) ──
//
// The watchdog's repeated-tool-error key used to embed an MD5 of the message
// skeleton, so one defect whose message carried an id, a path or a value split
// into one row per wording (R-3). The key is now STRUCTURAL: tool + class, plus
// error code + field path for structural failures (each names a fixable shape).
// Transient and rate-limit failures key by tool alone (R-1): they are a
// load/capacity reading about the tool, not distinct defects. Caller failures key
// by tool alone too (D-010): the fix for repeated misuse is ONE ease-of-use item
// per tool, and the arguments agents get wrong are a counter on that item
// (`callerArgumentCounts`), not one row per argument.
//
// Every pattern below obeys the dual-engine constraint documented at the top of
// this file: each is valid POSIX ERE for Postgres and valid JS, applied to the
// LOWERCASED message, and `toolErrorKeyPartsSql` mirrors `toolErrorKeyParts`
// exactly (row-by-row parity in tool-error-classifier.integration.test.ts).

/** Classes whose signal key names one row per TOOL (no code / field segments). */
export const TOOL_KEYED_TOOL_ERROR_CLASSES: ReadonlySet<ToolErrorClass> =
  new Set<ToolErrorClass>(['transient', 'rate-limit', 'caller']);

/**
 * Error codes that name the dispatch envelope rather than the failure. A more
 * specific code carried in the message (`invalid_input: invalid_args: …`) wins
 * over these, so a reporter quoting the inner code and the ledger's envelope
 * code still land on one key. `invalid_input` is the envelope the dispatch layer
 * puts around every schema refusal (measured 2026-10-18: ~4.4k/day).
 */
export const GENERIC_TOOL_ERROR_CODES: readonly string[] = ['handler_error', 'invalid_input', 'error', 'internal_error'];

/** Envelope prefixes stripped before reading a leading machine code. */
const TOOL_ERROR_WRAPPER_PREFIX_PATTERN = '^ *((handler_error|invalid_input) *: *)+';
/** A leading `snake_code:` (at least one underscore — prose never matches). */
const TOOL_ERROR_PREFIX_CODE_PATTERN = '^([a-z][a-z0-9]*(_[a-z0-9]+)+) *:';
/** A JSON envelope field naming a machine code; the code is group 2. */
const TOOL_ERROR_JSON_CODE_PATTERN = '"(reason|error|code)" *: *"([a-z][a-z0-9]*(_[a-z0-9]+)+)"';
/** zod `Unrecognized key(s): "x"`; the key is group 1. */
const TOOL_ERROR_UNRECOGNIZED_KEY_PATTERN = 'unrecognized keys? *: *"([^"]+)"';
/** zod path after `invalid_args:` — `invalid_args: items.0.id: …`; the path is group 1. */
const TOOL_ERROR_ARGS_PATH_PATTERN = 'invalid_args *: *([a-z_][a-z0-9_]*(\\.[a-z0-9_]+)*) *: ';
/**
 * Postgres `column "x" [of relation "y"] does not exist`; the column is group 1.
 * Two missing columns under one tool are two contracts (EI-22437036851108668: one
 * repaired, one still failing), so the column is the field that keeps them apart.
 */
const TOOL_ERROR_PG_COLUMN_PATTERN = 'column "([^"]+)" (of relation "[^"]+" )?does not exist';
/** Some PG errors render a schema-qualified reference as `column wi.foo does not exist`. */
const TOOL_ERROR_PG_UNQUOTED_COLUMN_PATTERN =
  'column ([a-z_][a-z0-9_$]*(\\.[a-z_][a-z0-9_$]*)*) does not exist';
/** A numeric path segment (array index), normalized to `.n`. Applied twice. */
const TOOL_ERROR_NUMERIC_SEGMENT_PATTERN = '\\.[0-9]+(\\.|$)';

export const ERROR_CODE_UNKNOWN = 'error-code-unknown';
export const FIELD_UNKNOWN = 'field-unknown';

function firstGroup(re: RegExp, text: string, group = 1): string | null {
  const m = re.exec(text);
  return m?.[group] ?? null;
}

const WRAPPER_PREFIX_RE = new RegExp(TOOL_ERROR_WRAPPER_PREFIX_PATTERN);
const PREFIX_CODE_RE = new RegExp(TOOL_ERROR_PREFIX_CODE_PATTERN);
const JSON_CODE_RE = new RegExp(TOOL_ERROR_JSON_CODE_PATTERN);
const UNRECOGNIZED_KEY_RE = new RegExp(TOOL_ERROR_UNRECOGNIZED_KEY_PATTERN);
const ARGS_PATH_RE = new RegExp(TOOL_ERROR_ARGS_PATH_PATTERN);
const PG_COLUMN_RE = new RegExp(TOOL_ERROR_PG_COLUMN_PATTERN);
const PG_UNQUOTED_COLUMN_RE = new RegExp(TOOL_ERROR_PG_UNQUOTED_COLUMN_PATTERN);
const NUMERIC_SEGMENT_RE = new RegExp(TOOL_ERROR_NUMERIC_SEGMENT_PATTERN, 'g');

/**
 * Pure: the structural identity of one failure — the error code and field path
 * the signal key is built from. Message wording never enters the key; only a
 * machine code or a field path read out of it does.
 *
 * errorCode precedence: a specific `error_code` column value; else a machine code
 * carried by a generic-coded message (JSON `"reason"`, then a leading
 * `snake_code:` after the `handler_error:` / `invalid_input:` wrappers); else the
 * generic column value; else `error-code-unknown`.
 * fieldPath: zod `Unrecognized key: "x"`, else the path after `invalid_args:`,
 * else a Postgres missing column; array indices normalized to `n`; else
 * `field-unknown`.
 */
export function toolErrorKeyParts(
  errorCode: string | null | undefined,
  message: string | null | undefined,
): { errorCode: string; fieldPath: string } {
  const lower = (message ?? '').toLowerCase();
  const column = (errorCode ?? '').trim().toLowerCase();
  const generic = (code: string | null): boolean => !code || GENERIC_TOOL_ERROR_CODES.includes(code);
  const jsonCode = firstGroup(JSON_CODE_RE, lower, 2);
  const prefixCode = firstGroup(PREFIX_CODE_RE, lower.replace(WRAPPER_PREFIX_RE, ''));
  const code = !generic(column)
    ? column
    : !generic(jsonCode) ? jsonCode
      : !generic(prefixCode) ? prefixCode
        : column || null;
  const rawField = firstGroup(UNRECOGNIZED_KEY_RE, lower)
    ?? firstGroup(ARGS_PATH_RE, lower)
    ?? firstGroup(PG_COLUMN_RE, lower)
    ?? firstGroup(PG_UNQUOTED_COLUMN_RE, lower)?.replace(/^([a-z_][a-z0-9_$]*\.)+/, '');
  const field = rawField == null
    ? null
    : rawField.replace(NUMERIC_SEGMENT_RE, '.n$1').replace(NUMERIC_SEGMENT_RE, '.n$1');
  return {
    errorCode: correlationSegment(code, ERROR_CODE_UNKNOWN),
    fieldPath: correlationSegment(field, FIELD_UNKNOWN),
  };
}

/** SQL mirror of `correlationSegment` over an already-lowercased expression. */
function correlationSegmentSql<T>(sql: SqlTag<T>, expr: T, fallback: string): T {
  return sql`coalesce(nullif(left(regexp_replace(regexp_replace(coalesce(${expr}, ''),
    '[^a-z0-9._:-]+', '-', 'g'), '^-+|-+$', '', 'g'), 80), ''), ${fallback})`;
}

/**
 * SQL mirror of `toolErrorKeyParts`: two select-list items, `code_key` and
 * `field_key`, computed from the bare `error_code` / `error_message` columns.
 * Embed where those are in scope. Parity with the TS fn is proven row-by-row by
 * the integration test.
 */
export function toolErrorKeyPartsSql<T>(sql: SqlTag<T>): T {
  const lowerMsg = sql`lower(coalesce(error_message, ''))`;
  const column = sql`nullif(lower(trim(coalesce(error_code, ''))), '')`;
  const generic = GENERIC_TOOL_ERROR_CODES as string[];
  const jsonCode = sql`(regexp_match(${lowerMsg}, ${TOOL_ERROR_JSON_CODE_PATTERN}))[2]`;
  const prefixCode = sql`substring(regexp_replace(${lowerMsg}, ${TOOL_ERROR_WRAPPER_PREFIX_PATTERN}, '')
    from ${TOOL_ERROR_PREFIX_CODE_PATTERN})`;
  const code = sql`CASE
      WHEN ${column} IS NOT NULL AND NOT (${column} = ANY(${generic}::text[])) THEN ${column}
      WHEN ${jsonCode} IS NOT NULL AND NOT (${jsonCode} = ANY(${generic}::text[])) THEN ${jsonCode}
      WHEN ${prefixCode} IS NOT NULL AND NOT (${prefixCode} = ANY(${generic}::text[])) THEN ${prefixCode}
      ELSE ${column} END`;
  const rawField = sql`coalesce(substring(${lowerMsg} from ${TOOL_ERROR_UNRECOGNIZED_KEY_PATTERN}),
    substring(${lowerMsg} from ${TOOL_ERROR_ARGS_PATH_PATTERN}),
    substring(${lowerMsg} from ${TOOL_ERROR_PG_COLUMN_PATTERN}),
    regexp_replace(substring(${lowerMsg} from ${TOOL_ERROR_PG_UNQUOTED_COLUMN_PATTERN}),
      '^([a-z_][a-z0-9_$]*\\.)+', '', 'g'))`;
  // The replacement is a bound value ('.n' + backreference 1), never SQL text, so
  // its backslash cannot be re-escaped by the template layer.
  const replacement = '.n\\1';
  const field = sql`regexp_replace(regexp_replace(${rawField}, ${TOOL_ERROR_NUMERIC_SEGMENT_PATTERN}, ${replacement}, 'g'),
    ${TOOL_ERROR_NUMERIC_SEGMENT_PATTERN}, ${replacement}, 'g')`;
  return sql`${correlationSegmentSql(sql, code, ERROR_CODE_UNKNOWN)} AS code_key,
    ${correlationSegmentSql(sql, field, FIELD_UNKNOWN)} AS field_key`;
}

/**
 * The dedup key for a repeated-tool-error signal. Transient, rate-limit and
 * caller: `<tool>:<class>` (one row per tool; D-010 for caller). Structural:
 * `<tool>:<class>:<errorCode>:<fieldPath>`. Single source for the live
 * collector, agent-report normalization, the structural verifier and the
 * key-migration routine, so every reader and writer agrees on one identity.
 */
export function toolErrorSignalKey(
  toolName: string,
  klass: ToolErrorClass,
  errorCode: string | null | undefined,
  fieldPath: string | null | undefined,
): string {
  if (TOOL_KEYED_TOOL_ERROR_CLASSES.has(klass)) return `${toolName}:${klass}`;
  return `${toolName}:${klass}:${correlationSegment(errorCode, ERROR_CODE_UNKNOWN)}:${correlationSegment(fieldPath, FIELD_UNKNOWN)}`;
}

/**
 * Agent-side report used by the probation intake. The invocation ledger can
 * independently corroborate the stable `signalKey`; the remaining dimensions
 * sharpen the per-reporter fingerprint so unlike client/schema generations do
 * not look like independent reproductions of one defect.
 */
export interface SuspectedToolFailure {
  toolName: string;
  /** Wire payloads may carry an explicit `null`; every consumer treats it as absent. */
  errorCode?: string | null;
  status?: string;
  message: string;
  schemaRevision?: string;
  fieldPath?: string;
  runtimeVersion?: string;
  reproduced?: boolean;
  clearServerMismatch?: boolean;
  hardInternal?: boolean;
  /**
   * Inspectable evidence that a caller-shaped refusal is actually a tool defect.
   *
   * The three legacy booleans above remain useful shorthand for non-caller
   * classes, but a caller classification is itself evidence that the tool
   * rejected its input. Overriding that classification therefore needs more
   * than another boolean: it must state the expected and observed contracts so
   * the next reader can check the claim instead of inheriting an assertion.
   */
  directEvidence?: ToolFailureDirectEvidence;
}

export const TOOL_FAILURE_DIRECT_EVIDENCE_KINDS = [
  'valid-input-reproduction',
  'server-contract-mismatch',
  'hard-internal',
] as const;

export interface ToolFailureDirectEvidence {
  kind: (typeof TOOL_FAILURE_DIRECT_EVIDENCE_KINDS)[number];
  expected: string;
  actual: string;
}

/**
 * A tool-failure class that is DOCUMENTED, EXTERNAL, and has no papercusp fix
 * surface — the report is real, but nothing in this repository can act on it.
 *
 * Why this table exists (WI-2143658). The probation intake's identity is
 * `<tool>:<class>:<first 6 words of the reporter's message>`, and for an AGENT
 * report that message is free prose. So one such class fragments across many
 * identities instead of coalescing onto a single row: measured 2026-09-03, the
 * Codex `exec_command` parallel-launch race alone had produced 272 rows
 * carrying 138 DISTINCT identities, at 5-17 claimable filings/day for three
 * weeks — every one a duplicate of an investigation already closed four times.
 *
 * A match does NOT discard the report. It only denies the direct-evidence
 * bypass (`reproduced` / `clearServerMismatch` / `hardInternal`), so the row
 * lands in ordinary non-claimable probation carrying its doc citation instead
 * of minting a claimable bug. Two properties follow, and both are deliberate:
 *   • signal is preserved — the observation lane still records every report; and
 *   • the invocation-ledger watchdog can still PROMOTE the row on genuine
 *     sustained repetition, which is exactly the escalation condition the doc
 *     itself names ("if it becomes reliably reproducible, escalate upstream").
 * So this suppresses the duplicate-filing flood WITHOUT suppressing the
 * evidence that would justify escalating.
 *
 * ⚠ Match CONSERVATIVELY and fail OPEN. A miss costs one duplicate row (todays
 * behaviour); a false match hides a real papercusp defect inside a row triage
 * has been told to ignore, which is far more expensive. Prefer a pattern that
 * under-matches. In particular `exclude` exists to keep a genuinely DIFFERENT
 * class out even when its prose looks similar.
 *
 * Patterns follow this module's dual-engine convention (see the header): plain
 * POSIX-ERE-and-JS-compatible syntax only, so a rule stays portable if it is
 * ever pushed down into the SQL CASE.
 */
export interface KnownExternalToolFailureClass {
  /** Stable id, recorded on the row so a later audit can find every match. */
  id: string;
  /** The agent-insights doc that already adjudicated this class. */
  docSlug: string;
  /** Tool names this applies to (exact, lowercased). */
  toolNames: readonly string[];
  /** Message MUST match this for the class to apply. */
  match: string;
  /** Message must NOT match this — the discriminator against nearby classes. */
  exclude?: string;
  /** One line for the triager reading the filed row. */
  note: string;
}

export const KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES: readonly KnownExternalToolFailureClass[] = [
  {
    id: 'codex-exec-command-parallel-launch-race',
    docSlug: 'agent-insights/codex-exec-command-parallel-launch-race',
    // Codex-NATIVE tools. `exec_command` bypasses the papercusp managed command
    // family entirely, so no code here implements the failing spawner.
    toolNames: ['exec_command', 'functions.exec', 'functions.exec_command'],
    // The distinctive invariant across every reported spelling of this class is
    // the "unified exec/shell/process" phrase naming Codex's own spawner. The
    // cosmetic error-code spellings (CreateProcess, CreateProcess_ENOENT,
    // CREATE_PROCESS_NO_SUCH_FILE) vary per Codex build, so they are NOT
    // required — requiring them would under-match reports that omit the code.
    match: 'unified[ _-]?(exec|shell|process)',
    // The SEPARATE mistyped-workdir class is not "already-fixed": the linked
    // insight says nonexistent-workdir behavior still reproduces and remains
    // outside Papercusp's fix surface. Its disposition is "use the correct
    // path", not "retry sequentially" — the doc is explicit that the two must
    // not be conflated. Any mention of a workdir/path problem therefore drops
    // the match back to normal handling.
    exclude: 'workdir|working directory|misspell|mistyped|typo|nonexistent (path|directory)',
    note:
      'Codex CLI client-side process-spawn race under concurrent launch. No papercusp code implements this spawner; ' +
      'independently investigated and closed 4x. Retry the SAME call sequentially instead of in a parallel batch.',
  },
];

function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    // A malformed pattern must never break a filing: fail OPEN (no match).
    return false;
  }
}

function isExpectedNativeShellCleanupRefusal(
  input: Pick<SuspectedToolFailure, 'toolName' | 'message'>,
): boolean {
  const toolName = input.toolName.trim().toLowerCase();
  if (!['exec_command', 'functions.exec', 'functions.exec_command'].includes(toolName)) return false;
  return matchesPattern(NATIVE_SHELL_CLEANUP_REFUSAL_PATTERN, input.message);
}

/**
 * Return the documented external class this report matches, or null. Null is
 * the safe default and is returned for anything uncertain.
 */
export function matchKnownExternalToolFailure(
  input: Pick<SuspectedToolFailure, 'toolName' | 'message'>,
): KnownExternalToolFailureClass | null {
  const tool = (input.toolName ?? '').trim().toLowerCase();
  const message = input.message ?? '';
  if (!tool || !message) return null;
  for (const klass of KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES) {
    if (!klass.toolNames.includes(tool)) continue;
    if (!matchesPattern(klass.match, message)) continue;
    if (klass.exclude && matchesPattern(klass.exclude, message)) continue;
    return klass;
  }
  return null;
}

export interface NormalizedToolFailure {
  class: ToolErrorClass;
  /** Exact key emitted by the repeated-tool-error watchdog. */
  watchdogKey: string;
  /** Stable lifecycle identity, deliberately independent of reporter message shape. */
  classKey: string;
  /** Schema/field contract identity used by the class lifecycle. */
  contractFingerprint: string;
  /** Deployed/runtime revision that emitted the report. */
  deployedRevision: string;
  /** Full client/schema-aware correlation identity retained in the payload. */
  correlationFingerprint: string;
  messageFingerprint: string | null;
  direct: boolean;
  /**
   * Set when the report matches a documented external class with no papercusp
   * fix surface. When set, `direct` is forced false — see the table above.
   */
  knownExternal: KnownExternalToolFailureClass | null;
}

function correlationSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

/**
 * The stable identity for one tool-failure defect class.
 *
 * `watchdogKey` remains the invocation/report identity and intentionally includes
 * the message fingerprint. This key does not include the message shape: differently-
 * worded reports for the same tool/error-code/class/contract/revision must share one
 * lifecycle item, while a different error code, schema, or deployed revision must
 * start a new class. Unknown dimensions remain explicit so missing metadata cannot
 * collapse unrelated reports together.
 */
export interface ToolFailureClassIdentity {
  classKey: string;
  contractFingerprint: string;
  deployedRevision: string;
}

export function toolFailureClassIdentity(
  input: Pick<SuspectedToolFailure, 'toolName' | 'errorCode' | 'schemaRevision' | 'fieldPath' | 'runtimeVersion'>,
  failureFamily: ToolErrorClass,
): ToolFailureClassIdentity {
  const tool = correlationSegment(input.toolName, 'unknown-tool');
  const errorCode = correlationSegment(input.errorCode, 'error-code-unknown');
  const contractFingerprint = [
    correlationSegment(input.schemaRevision, 'schema-unknown'),
    correlationSegment(input.fieldPath, 'field-unknown'),
  ].join('~');
  const deployedRevision = correlationSegment(input.runtimeVersion, 'runtime-unknown');
  return {
    classKey: `repeated-tool-error-class:${tool}:${failureFamily}:${errorCode}:${contractFingerprint}:${deployedRevision}`,
    contractFingerprint,
    deployedRevision,
  };
}

/**
 * The FILING identity for automatically captured tool failures
 * (review-system-rework-reduction-2026-09-23 D-010): one tracker row per tool,
 * failure family, error code and field path. It deliberately OMITS the contract
 * and deployed revision. Those stay in `classKey`, which remains the
 * corroboration identity and is tallied per class inside the row, so a failure on
 * build N+1 counts onto the same row without corroborating build N's report. Keyed
 * on the class, one live defect minted a new row per build (~27 a day). Unknown
 * dimensions stay explicit, exactly as in `classKey`.
 */
export function toolFailureSignatureKey(
  input: Pick<SuspectedToolFailure, 'toolName' | 'errorCode' | 'fieldPath'> & { message?: string | null },
  failureFamily: ToolErrorClass,
): string {
  const subsystem = toolFailureSubsystemForCode(input.errorCode);
  if (subsystem) {
    const errorCode = correlationSegment(input.errorCode, 'error-code-unknown');
    // `output_spill_failed` is emitted by the outer result-door, not the named
    // tool. Keep the legacy key grammar (and parser) while fixing the subject,
    // family and field segments to constants: the actual identity is subsystem
    // + error code. Per-tool/build classification remains in the class tally.
    return `tool-failure-signature:${subsystem}:structural:${errorCode}:field-unknown`;
  }
  const tool = correlationSegment(input.toolName, 'unknown-tool');
  const errorCode = correlationSegment(input.errorCode, 'error-code-unknown');
  const fieldPath = correlationSegment(input.fieldPath, 'field-unknown');
  // Authorization denials share one wire error code even when the kernel's
  // cause is materially different. Keep those causes distinct in the filing
  // identity: otherwise an outside-ceiling refusal can coalesce onto an older
  // stale-artifact row and the promoted item reports the wrong cause.
  const identityCause = input.message?.match(
    /Identity capability \(unresolved\): ([a-z0-9-]+)/i,
  )?.[1]?.toLowerCase();
  const causeSuffix = errorCode === 'authorization_denied' && identityCause
    ? `:identity-${correlationSegment(identityCause, 'unknown')}`
    : '';
  return `tool-failure-signature:${tool}:${failureFamily}:${errorCode}:${fieldPath}${causeSuffix}`;
}

const TOOL_FAILURE_SIGNATURE_PREFIX = 'tool-failure-signature:';
const TOOL_ERROR_CLASS_VALUES: readonly ToolErrorClass[] = ['structural', 'transient', 'caller', 'rate-limit'];

/**
 * Inverse of {@link toolFailureSignatureKey}. Tool names and field paths may themselves
 * contain `:` (`coord:glance`), so the key is split on its ONE enumerated segment, the
 * failure family, never by position. Returns null for anything the builder cannot emit.
 */
export function parseToolFailureSignatureKey(
  key: string | null | undefined,
): { toolName: string; failureFamily: ToolErrorClass; errorCode: string; fieldPath: string } | null {
  if (!key || !key.startsWith(TOOL_FAILURE_SIGNATURE_PREFIX)) return null;
  const rest = key.slice(TOOL_FAILURE_SIGNATURE_PREFIX.length);
  let best: { at: number; family: ToolErrorClass } | null = null;
  for (const family of TOOL_ERROR_CLASS_VALUES) {
    const at = rest.indexOf(`:${family}:`);
    if (at > 0 && (best === null || at < best.at)) best = { at, family };
  }
  if (!best) return null;
  const toolName = rest.slice(0, best.at);
  const tail = rest.slice(best.at + best.family.length + 2);
  const sep = tail.indexOf(':');
  if (sep <= 0 || sep === tail.length - 1) return null;
  return { toolName, failureFamily: best.family, errorCode: tail.slice(0, sep), fieldPath: tail.slice(sep + 1) };
}

/** Convenience key builder used by callers that already know the failure family. */
export function toolFailureClassKey(
  input: Pick<SuspectedToolFailure, 'toolName' | 'errorCode' | 'schemaRevision' | 'fieldPath' | 'runtimeVersion'>,
  failureFamily: ToolErrorClass,
): string {
  return toolFailureClassIdentity(input, failureFamily).classKey;
}

/**
 * Normalize one agent-reported tool failure for probation/corroboration.
 *
 * `watchdogKey` deliberately uses the same tool/class/message-shape identity as
 * the invocation-ledger collector. `correlationFingerprint` additionally pins
 * error code, schema revision, field path, and runtime version for the
 * independent-agent leg. A non-caller report may use the legacy direct-evidence
 * flags; a caller report must supply inspectable expected/actual evidence to
 * override the classification. An unknown one-off never becomes claimable
 * merely because the classifier's safe fallback is structural.
 *
 * WI-2143658: that bypass is denied for a DOCUMENTED EXTERNAL class. An honest
 * reporter attesting `reproduced: true` about a known Codex-side race is
 * telling the truth — it did recur — but the attestation was minting a
 * claimable duplicate of an investigation already closed four times. The report
 * still lands (non-claimable probation, doc citation attached) and the
 * invocation watchdog can still promote it on sustained repetition.
 *
 * EI-22142216567407511: a caller classification may no longer be overridden
 * by one of the legacy booleans alone. `reproduced` only proves that an input
 * rejection recurs, while `clearServerMismatch` / `hardInternal` were equally
 * uninspectable assertions. A caller-shaped server defect still has an escape:
 * structured `directEvidence` names expected versus actual behavior. The row
 * otherwise remains in probation, where independent reporters and the
 * invocation-ledger watchdog can still promote a recurring affordance defect.
 */
export function normalizeSuspectedToolFailure(input: SuspectedToolFailure): NormalizedToolFailure {
  const klass = classifyToolError(input.errorCode, input.status, input.message);
  const messageFingerprint = toolErrorFingerprint(input.message);
  // The exact watchdog identity is derived from the measured code + message the
  // invocation ledger also holds — never from the reporter's own fieldPath — so a
  // probation row and the collector's signal for the same failure share one key.
  const keyParts = toolErrorKeyParts(input.errorCode, input.message);
  const signalKey = toolErrorSignalKey(input.toolName.trim(), klass, keyParts.errorCode, keyParts.fieldPath);
  const classIdentity = toolFailureClassIdentity(input, klass);
  const correlationFingerprint = [
    correlationSegment(input.toolName, 'unknown-tool'),
    correlationSegment(input.errorCode, klass),
    correlationSegment(input.schemaRevision, 'schema-unknown'),
    correlationSegment(input.fieldPath, 'field-unknown'),
    correlationSegment(input.runtimeVersion, 'runtime-unknown'),
    correlationSegment(messageFingerprint, 'message-unknown'),
  ].join('|');
  const knownExternal = matchKnownExternalToolFailure(input);
  const legacyAttested =
    input.reproduced === true || input.clearServerMismatch === true || input.hardInternal === true;
  // code:run owns `structured_result_shape`: its tracked result Proxy emits
  // this caller diagnostic when a script reads MCP `content`/`text` from the
  // nested tool's typed root. Expected/actual prose cannot turn that concrete
  // wrong-shape read into evidence of a server mismatch. The message fallback
  // matters when a reporter omits errorCode; require the already-classified
  // caller result so secondary mentions cannot mask a different primary error.
  const structuredResultShapeCallerDiagnostic =
    input.errorCode?.trim() === 'structured_result_shape' ||
    (!input.errorCode?.trim() && (
      input.status?.trim() === 'structured_result_shape' ||
      (klass === 'caller' && /structured_result_shape.*typed root/.test(input.message))
    ));
  const processNamespacePermissionRefusal = new RegExp(
    PROCESS_NAMESPACE_PERMISSION_DENIED_MESSAGE_PATTERN,
    'i',
  ).test(input.message);
  const nativeShellCleanupRefusal = isExpectedNativeShellCleanupRefusal(input);
  const expectedAdmissionRecoveryRefusal = [input.errorCode, input.status]
    .some((value) => value?.trim().toLowerCase() === 'admission_recovery_refused');
  // A 42703 response carrying dev:pg_query's knownColumns correction is the
  // expected refusal of caller-authored SQL with a nonexistent column. The
  // capture shorthand report may paraphrase the JSON envelope, and reporter
  // supplied directEvidence cannot turn that invalid query into a tool defect.
  const pgQueryUndefinedColumnCallerRefusal =
    input.toolName.trim() === 'dev:pg_query' &&
    input.errorCode?.trim() === '42703' &&
    new RegExp(PG_QUERY_UNDEFINED_COLUMN_CALLER_PATTERN, 'i').test(input.message);
  // Keep other caller-class overrides available for genuine contract defects.
  const structuredAttested = input.directEvidence !== undefined &&
    !pgQueryUndefinedColumnCallerRefusal &&
    !structuredResultShapeCallerDiagnostic &&
    !processNamespacePermissionRefusal &&
    !nativeShellCleanupRefusal &&
    !expectedAdmissionRecoveryRefusal;
  const attested = structuredAttested || (legacyAttested && klass !== 'caller');
  const deferredWrapperUnavailable = [input.errorCode, input.status]
    .some((value) => [
      'unknown_tool_wrapper',
      'wrapper-unavailable',
      'client_wrapper_unavailable',
      'client-wrapper-unavailable',
      'client-wrapper-absent',
    ].includes(value?.trim().toLowerCase() ?? ''));
  const expectedSelfAwaitRefusal = [input.errorCode, input.status]
    .some((value) => value?.trim().toLowerCase() === 'self_await_deadlock');
  return {
    class: klass,
    watchdogKey: `repeated-tool-error:${signalKey}`,
    classKey: classIdentity.classKey,
    contractFingerprint: classIdentity.contractFingerprint,
    deployedRevision: classIdentity.deployedRevision,
    correlationFingerprint,
    messageFingerprint,
    // A documented external class never bypasses probation, however the
    // reporter attested it — the attestation is honest, the row is a duplicate.
    // A missing client wrapper is affirmative evidence that dispatch never
    // reached the named handler. Non-empty expected/actual prose cannot turn
    // that discovery report into a claimable server defect.
    direct: attested && !knownExternal && !deferredWrapperUnavailable &&
      !expectedSelfAwaitRefusal && !processNamespacePermissionRefusal &&
      !nativeShellCleanupRefusal && !expectedAdmissionRecoveryRefusal,
    knownExternal,
  };
}

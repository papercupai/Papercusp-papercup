/**
 * tool-error-corpus.fixture.ts — a committed snapshot of the LIVE high-volume
 * distinct error shapes from `harness_shared.tool_invocations`, each pinned to
 * the `ToolErrorClass` it must classify as
 * (watchdog-and-exposed-systems-improvement-2026-06-18 P-011).
 *
 * Most rows were sampled 2026-06-18 from the dev workspace over a 14-day window
 * (≈298k error/timeout rows). `n` is the bucket's occurrence count at capture —
 * it ranks "how much a misclassification would FLOOD a lane", not a live value;
 * it's here for legibility, not asserted. The shapes (error_code / status /
 * message-prefix) are the load-bearing part and rarely change.
 * The nested checkpoint-refusal row was added 2026-10-01 from a 24h sample (n=15).
 * The acceptance-BAR vetting refusal was added 2026-10-01 from the repeated
 * watchdog sample (n=3) to keep caller-authored readiness failures out of the
 * structural repair lane.
 * The acceptance-BAR reviewer-approval refusal was added 2026-10-12 from
 * EI-25736374674133206 (n=3); it is a no-write caller prerequisite. A synthetic
 * nested JSON wrapper row (n=0) also guards wrapper classification parity.
 * The reviewer-model allowlist refusal was added 2026-10-03 from EI-24950089856585512.
 * Kernel identity-ceiling refusals were added 2026-10-01 from a 24h sample
 * (n=33/16) to keep expected no-grant identities out of the structural lane.
 * The operator admission-shed row was added 2026-10-02 from the retryable
 * `loop_pressure_critical` response captured in EI-24856174754316507.
 * The claim-spec self-selector row was added 2026-10-07 from EI-25300889812728741;
 * it is an expected caller refusal and must not enter the structural bug lane.
 * The events:status judge-permission row was added 2026-10-14 from
 * EI-25889576691911568; its deliberate role refusal surfaces as handler_error.
 * The caller-authored pg_query undefined-column row was added 2026-10-08 from
 * EI-25389944836048866; tools:invoke preserves the 42703 payload for correction.
 * The explicit capability:bash cwd refusal was added 2026-10-09 from
 * EI-25541385148400614; it is a caller path error, not a structural spawn failure.
 * The capability:bash nsenter namespace refusal was added 2026-10-16 from
 * EI-26011423316141422; OS permission denial is not a capability implementation bug.
 * The missing-UI-client rows were added 2026-10-07 from EI-24710297442793828;
 * they are expected caller context refusals, not structural UI defects.
 * The native-owner transport capability refusal was added 2026-10-09 from
 * EI-25431178848604122; the owner RPC intentionally refuses host-local auth
 * capabilities that cannot cross its boundary, so this is not a tool bug.
 * The events:await self-await refusal was added 2026-10-12 from
 * EI-25327017880527713; the guard intentionally refuses an unsatisfiable wait
 * on the current assignee's own work-item lifecycle.
 * The session:end busy refusal was added 2026-10-17 from EI-26251588319744742;
 * tools:invoke preserves this intentional active-turn refusal inside handler_error.
 *
 * This fixture is the corpus for BOTH:
 *   - tool-error-classifier.test.ts (pure: classifyToolError must agree per row), and
 *   - tool-error-classifier.integration.test.ts (the GENERATED SQL CASE run over
 *     these rows in real PG must agree with classifyToolError row-by-row).
 *
 * Refresh procedure (when the live distribution shifts materially): re-run the
 * bucket query in the test header and re-pin any NEW high-volume shape to its
 * correct class. A new shape that lands in the wrong class is exactly the
 * regression this fixture exists to catch.
 */
import { homedir } from 'node:os';
import type { ToolErrorClass } from './tool-error-classifier';

const missingHomeCwdFixture = homedir() + '/__papercusp_missing_cwd_fixture__';

export interface ToolErrorCorpusRow {
  /** Bucket occurrence count at capture (ranking only — not asserted). */
  readonly n: number;
  readonly errorCode: string | null;
  readonly status: string;
  /** A representative real error_message for the bucket. */
  readonly message: string;
  /** The class this shape MUST classify as. */
  readonly expectedClass: ToolErrorClass;
  /** Why — legibility for the next maintainer; flags the borderline calls. */
  readonly note: string;
}

export const TOOL_ERROR_CORPUS: readonly ToolErrorCorpusRow[] = [
  // ── transient: terminal MCP proxy upstream failures ───────────────────────
  {
    n: 1,
    errorCode: 'mcp_proxy_upstream_error',
    status: 'outcome_unknown',
    message: 'HTTP502 outcome_unknown trace96123ed2-9d92-4b3c-9e7f-7e2bbb2c0daf on external build log locks. Dependent producer launched before lock receipt was checked; reconciling exact held state before further edit. No lock retry until authoritative read.',
    expectedClass: 'transient',
    note: 'EI-25822890637070574 captured the proxy 502 after upstream connection; outcome_unknown is replay-safety metadata',
  },
  {
    n: 0,
    errorCode: 'mcp_proxy_upstream_unavailable',
    status: 'error',
    message: 'HTTP502 mcp_proxy_upstream_unavailable: upstream target refused connections for the whole retry window',
    expectedClass: 'transient',
    note: 'synthetic companion: the same proxy producer reports an upstream refusal before forwarding',
  },
  // ── transient: timeouts (by far the highest-volume shape) ──────────────────
  {
    n: 287629, errorCode: null, status: 'timeout',
    message: 'tool "plans:list" exceeded timeout of 60s (handler returned but signal had aborted)',
    expectedClass: 'transient',
    note: 'plain timeout (status=timeout) — load, never a tool bug',
  },
  {
    n: 41, errorCode: 'timeout', status: 'timeout',
    message: 'tool "memory:remember" exceeded timeout of 60s (handler returned but signal had aborted)',
    expectedClass: 'transient',
    note: 'first-class timeout error_code',
  },
  {
    n: 59, errorCode: null, status: 'timeout',
    message: 'tool "chat:ask_choice" exceeded timeout of 60s (handler returned but signal had aborted)',
    expectedClass: 'transient',
    note: 'interactive tool timeout',
  },
  {
    n: 1,
    errorCode: 'dev:pg_query did not complete within 8000ms of its whole-call deadline (5000ms q',
    status: 'refused',
    message: '{"error":"dev:pg_query did not complete within 8000ms of its whole-call deadline (5000ms query budget plus 3000ms setup allowance). Tenant checks, SQL execution, and result advisories share this deadline.","reason":"call_timeout"}',
    expectedClass: 'transient',
    note: 'invocation 34570272: persisted call_timeout diagnostic is transient despite status=refused and a truncated deadline error_code',
  },
  {
    n: 1,
    errorCode: null,
    status: 'error',
    message: 'did not complete within 8000ms of its whole-call deadline (5000ms query budget plus 3000ms setup allowance). Tenant checks, SQL execution, and result advisories share this deadline.',
    expectedClass: 'transient',
    note: 'captured toolFailure prose retained the whole-call deadline but omitted the persisted call_timeout code/message envelope',
  },
  {
    n: 0, errorCode: 'query_embed_deadline', status: 'error',
    message: 'query embed exceeded 4000ms budget',
    expectedClass: 'transient',
    note: 'EI-25521910842775592: bounded embedding deadline is a timeout, not a structural tool defect',
  },
  {
    n: 0, errorCode: 'query_embed_deadline', status: 'error',
    message: 'embedding request exceeded its budget',
    expectedClass: 'transient',
    note: 'synthetic exact-code control: the deadline code remains transient when message wording changes',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: 'query embed failed: query embed exceeded 4000ms budget',
    expectedClass: 'transient',
    note: 'nested handler wrapper retains the maintained EmbedTimeoutError message',
  },
  {
    n: 0, errorCode: null, status: 'error',
    message: 'query embed exceeded 250ms budget',
    expectedClass: 'transient',
    note: 'message-only EmbedTimeoutError with another bounded duration',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: 'query embed failed: relation "embedding_cache" does not exist',
    expectedClass: 'structural',
    note: 'genuine embedding dependency failures remain structural',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: 'query embed exceeded expectations while validating configuration',
    expectedClass: 'structural',
    note: 'similar prose without a numeric deadline must not become transient',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: 'invalid_args: query_embed_deadline is not an accepted argument',
    expectedClass: 'caller',
    note: 'mentioning the deadline code in a caller argument refusal is not a timeout',
  },
  {
    n: 0, errorCode: 'structured_result_shape', status: 'error',
    message: 'secondary text: query embed exceeded 4000ms budget',
    expectedClass: 'caller',
    note: 'the primary caller shape code retains precedence over secondary deadline prose',
  },

  // ── transient: shared-infra exhaustion (PG-wedge collateral) ───────────────
  {
    n: 365, errorCode: 'handler_error', status: 'error',
    message: 'sorry, too many clients already',
    expectedClass: 'transient',
    note: 'PG max_connections — recurs across every tool during a wedge; NOT a per-tool bug (the EI-1331..1344 collateral)',
  },
  {
    n: 266, errorCode: 'handler_error', status: 'error',
    message: 'remaining connection slots are reserved for roles with the SUPERUSER attribute',
    expectedClass: 'transient',
    note: 'PG superuser-reserved slots — shared-infra load',
  },
  {
    n: 2, errorCode: 'handler_error', status: 'error',
    message: 'write CONNECTION_CLOSED 127.0.0.1:6432',
    expectedClass: 'transient',
    note: 'postgres-js reaped a stale pooled connection PgBouncer (:6432) idle-closed server-side — provably transient (connect-retry.ts retries this exact code); MUST NOT file as a structural tool bug (EI-11010)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'write CONNECT_TIMEOUT 127.0.0.1:6432',
    expectedClass: 'transient',
    note: "postgres-js's pool connect() timed out — the sibling connection-setup code connect-retry.ts treats identically; transient, not a tool bug",
  },
  {
    n: 6, errorCode: 'handler_error', status: 'error',
    message: 'server shutting down',
    expectedClass: 'transient',
    note: 'operator shutdown-window response — transient lifecycle state, not a structural coord:glance bug (EI-20257122293248893)',
  },
  {
    n: 6, errorCode: 'handler_error', status: 'error',
    message: 'could not access status of transaction 0',
    expectedClass: 'transient',
    note: 'six activity:report failures in EI-25561866963703669 carry PostgreSQL SQLSTATE 53100 (disk_full); shared filesystem exhaustion, not a per-tool defect',
  },
  {
    n: 2, errorCode: 'handler_error', status: 'error',
    message: 'pre-destructive backup requires a successful database dump: insufficient free space (38995595264 available; 120000000000 needed for a dump of 39600000000 bytes)',
    expectedClass: 'transient',
    note: 'EI-26151890657388960: the backup hook intentionally fails closed before pg_dump when measured free space is below its dump-sized reserve; capacity gate, not a structural backup-tool defect',
  },
  {
    n: 1, errorCode: 'sidecar_required_unavailable', status: 'degraded',
    message: 'sidecar_required_unavailable: semantic search sidecar at http://127.0.0.1:3384 aborted; lexical-only fallback returned',
    expectedClass: 'transient',
    note: 'shared embedding sidecar outage — degraded lexical fallback is infrastructure availability, not a per-tool structural bug',
  },
  {
    n: 1, errorCode: '-32000', status: 'request shed',
    message: 'operator MCP admission is saturated — request shed; reason=loop_pressure_critical',
    expectedClass: 'transient',
    note: 'the operator admission gate explicitly shed this call for critical loop pressure; retryable shared backpressure, not a per-tool bug',
  },
  {
    n: 2, errorCode: 'handler_error', status: 'error',
    message: 'an admission job is already running in this process; retry after it settles',
    expectedClass: 'transient',
    note: 'EI-26223225337009975: the release admission worker intentionally refuses overlapping same-process jobs; this retryable busy condition must not enter the structural tool-bug lane',
  },

  // ── rate-limit: external provider 429 (capacity, not a code bug) ────────────
  {
    n: 388, errorCode: 'handler_error', status: 'error',
    message: 'openai_embed_failed_429: {\n    "error": {\n        "message": "Rate limit reached for text-embedding-3-small in organization org-ow9x7tJAs2Np on tokens per min (TPM)"',
    expectedClass: 'rate-limit',
    note: 'OpenAI embed TPM 429 — must NOT fall through to structural (P-002)',
  },
  {
    n: 70, errorCode: 'handler_error', status: 'error',
    message: 'openai_embed_failed_429: {\n    "error": {\n        "message": "Request too large for text-embedding-3-small in organization org-ow9x7tJAs2Npk on tokens per min (TPM)"',
    expectedClass: 'rate-limit',
    note: 'same capacity concern, different message body — stays one rate-limit class (NOT fingerprinted)',
  },

  // ── caller: bad input / scope (DX, not a tool bug) ─────────────────────────
  {
    n: 1, errorCode: 'shell-command-rejected', status: 'error',
    message: 'Rejected rm -f style commands; use safer approach',
    expectedClass: 'caller',
    note: 'the persisted native exec capture abbreviated the intentional pre-execution refusal (EI-25990844380340083)',
  },
  {
    n: 1, errorCode: 'shell-command-rejected', status: 'error',
    message: 'The shell command validator crashed before dispatch.',
    expectedClass: 'structural',
    note: 'the generic shell-command-rejected code must not mask unrelated guard implementation errors',
  },
  {
    n: 1, errorCode: 'shell-command-rejected', status: 'error',
    message: 'Rejected rm -f style commands; use safer approach; the guard then crashed with an internal error',
    expectedClass: 'structural',
    note: 'the abbreviated native-refusal match is bounded to its proven message, not arbitrary suffixes',
  },
  {
    n: 1, errorCode: 'blocked_command', status: 'denied',
    message: 'The shell command was refused before execution by the PreToolUse guard: the command contains rm -f style cleanup, which is not permitted.',
    expectedClass: 'caller',
    note: 'the native exec guard rejected rm -f cleanup syntax before running the command; this is expected caller-side control flow (EI-26073126519701733)',
  },
  {
    n: 1, errorCode: 'PreToolUseCommandRejected', status: 'denied',
    message: 'A path-free diagnostic was rejected because the guard said rm -f style commands are not permitted.',
    expectedClass: 'caller',
    note: 'the same native exec guard refusal is also reported with its PreToolUseCommandRejected code (EI-26010063340730329)',
  },
  {
    n: 2, errorCode: 'handler_error', status: 'error',
    message: "capability:bash cwd '" + missingHomeCwdFixture + "' does not exist — the child process cannot start. (Node would report this as a misleading \"spawn /usr/bin/bash ENOENT\".) Pass an existing directory as cwd.",
    expectedClass: 'caller',
    note: 'capability:bash explicitly preflights cwd before spawning; the supplied missing path is invalid caller input, not a structural tool defect (EI-25541385148400614)',
  },
  {
    n: 2, errorCode: 'child_failed', status: 'failed',
    message: 'nsenter: cannot open /proc/1/ns/pid: Permission denied',
    expectedClass: 'caller',
    note: 'the OS refused an nsenter request to open a process namespace; this caller-side boundary is not a capability:bash defect (EI-26011423316141422)',
  },
  {
    n: 1, errorCode: 'aborted', status: 'error',
    message: 'tool "coord:declare-intent" was aborted by its parent signal after the handler returned',
    expectedClass: 'caller',
    note: 'dispatch-stack reports parent-signal cancellation as `aborted`; a completed handler plus parent cancellation is not a structural defect in the named tool (EI-25269217047946890)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'cupId must be a concrete session/owner ID, not the literal "self". To read your own claim spec, use { cupId: \'su-owner-id\' } for this session.',
    expectedClass: 'caller',
    note: 'scheduler:get_claim_spec intentionally rejects the `self` alias and tells the caller to use a concrete owner id; do not file this expected selector refusal as a structural tool bug (EI-25300889812728741)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'events:status — the evidence-only judge may inspect its own awaits only; exact-key inspection and fleet-meter access are unavailable.',
    expectedClass: 'caller',
    note: 'events:status intentionally rejects exact-key and fleet-wide meter reads for an evidence-only judge; this permission refusal must not enter the structural repair lane (EI-25889576691911568)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'client_not_found: no ui_clients row for client_id="su-cli-owner". The tab may have closed or never registered.',
    expectedClass: 'caller',
    note: 'ui:get_state was called from a CLI context without a registered browser client; this is an expected caller-context refusal (EI-24710297442793828)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'client_id_required: no client_id passed and ctx.uiClientId is unset (the agent was not spawned from a browser tab). Call ui:list_clients to pick a tab.',
    expectedClass: 'caller',
    note: 'ui:get_state requires an explicit registered client when the caller was not spawned from a browser tab',
  },
  {
    n: 1, errorCode: 'invalid_args', status: 'invalid_input',
    message: 'Nested code:run rejected timeoutSec=60 because the live maximum is 45 seconds; use 45 or less.',
    expectedClass: 'caller',
    note: '`timeoutSec` is an argument name, not an elapsed-timeout outcome; preserve the caller classification (EI-25198945153644636)',
  },
  {
    n: 3, errorCode: 'mcp_auth_failed', status: 'error',
    message: 'superuser_invalid_bearer',
    expectedClass: 'caller',
    note: 'MCP auth gate recorded an invalid-bearer refusal before dispatch; keep this credential rejection out of the structural bug lane (EI-24772367245361033)',
  },
  {
    n: 2, errorCode: 'handler_error', status: 'error',
    message: 'stale_tool_contract: schema was discovered from serving-generation-v1:old, but this operator serves serving-generation-v1:current; refresh tools:find on this operator',
    expectedClass: 'caller',
    note: 'tools:invoke intentionally rejected a stale serving-generation binding before dispatch; refresh the catalog instead of filing a structural tool bug (EI-26182697062618996)',
  },
  {
    n: 1, errorCode: 'mcp_auth_failed', status: 'error',
    message: 'superuser_native_session_verifier_unavailable',
    expectedClass: 'transient',
    note: 'The server-side native-session authority verifier could not complete; the caller did not cause this pre-dispatch failure (EI-25473774715739107)',
  },
  {
    n: 1, errorCode: 'mcp_auth_failed', status: 'request_rejected',
    message: 'A schema-valid tools:invoke call for coord:wake was rejected with superuser_native_session_verifier_unavailable while trying to wake the live fleet leader. This is direct evidence of the active EI-25492242650368024 failure class; the underlying pool holder is still unknown.',
    expectedClass: 'transient',
    note: 'A client-facing MCP auth error can wrap the server-side native verifier marker in incident prose; preserve the transient pre-dispatch classification (EI-25501729169052177)',
  },
  {
    n: 1, errorCode: 'superuser_native_session_verifier_unavailable', status: 'request_rejected',
    message: 'At 2026-10-08T13:52Z, valid exact-event events:await and bounded work_items:get were rejected with superuser_native_session_verifier_unavailable.',
    expectedClass: 'transient',
    note: 'Captured verifier failures retain an incident-context message, so classification must use the stable error code as well as the legacy exact-message form (EI-25419607893124365)',
  },
  {
    n: 1, errorCode: 'native_tool_owner_unsupported_capability', status: 'error',
    message: 'native_tool_owner_unsupported_capability',
    expectedClass: 'caller',
    note: 'native-owner RPC intentionally refuses host-local auth capabilities that cannot cross the transport boundary; expected refusal, not a structural tool bug (EI-25431178848604122)',
  },
  {
    n: 1, errorCode: '-32603', status: 'native_tool_owner_unsupported_capability',
    message: 'Direct Papercusp MCP wrappers were refused with native_tool_owner_unsupported_capability before target dispatch.',
    expectedClass: 'caller',
    note: 'The outer JSON-RPC error code masks the inner expected native-owner refusal in status (EI-25442498776362164)',
  },
  {
    n: 1, errorCode: null, status: 'error',
    message: 'native_tool_owner_unsupported_capability',
    expectedClass: 'caller',
    note: 'invocation telemetry omitted error_code but retained the exact intentional native-owner transport refusal message (EI-25427418124886749)',
  },
  {
    n: 835, errorCode: 'handler_error', status: 'error',
    message: "resolvePlanScope: harness 'shared-hive-test' is not registered in harness_shared.projects in any workspace, so its plan workspace cannot be resolved",
    expectedClass: 'caller',
    note: 'unregistered harness — caller named a harness that does not exist',
  },
  {
    n: 3, errorCode: 'handler_error', status: 'error',
    message: "resolvePlanScope: plans are Hive-scoped, but 'sidestage-mobile' is not a Hive home and does not belong to one in workspace 'papercusp-workspace'. Add it to a Hive or pass the Hive home slug explicitly; refusing to create/read a non-Hive-scoped plan.",
    expectedClass: 'caller',
    note: 'registered standalone harness — caller must pass the Hive home that owns the plan store (EI-20459566365031398)',
  },
  {
    n: 39, errorCode: 'harness_required', status: 'error',
    message: 'No harness specified. `harness` is a per-call arg — pass it on THIS call (you don\'t need a differently-scoped session): a concrete slug for a managed harness',
    expectedClass: 'caller',
    note: 'harness_required error_code',
  },
  {
    n: 150, errorCode: null, status: 'error',
    message: 'invalid_args: note: Too big: expected string to have <=400 characters',
    expectedClass: 'caller',
    note: 'invalid_args: prefix, no error_code',
  },
  {
    // THE DRIFT REGRESSION GUARD: same message as above but with a handler_error
    // error_code. The old TS fn classified this `structural` (its error_code
    // branch never checked the `invalid_args:` message prefix) while the SQL said
    // `caller` (LIKE 'invalid_args:%'). The table-driven classifier makes them agree.
    n: 118, errorCode: 'handler_error', status: 'error',
    message: 'invalid_args: note: Too big: expected string to have <=400 characters',
    expectedClass: 'caller',
    note: 'P-011 DRIFT GUARD: handler_error + invalid_args: message — was structural in TS, caller in SQL; now caller in both',
  },
  {
    n: 36, errorCode: null, status: 'error',
    message: 'invalid_args: state: Invalid input: expected string, received undefined; next: Too big: expected string to have <=800 characters',
    expectedClass: 'caller',
    note: 'distinct caller mode under the same tool as the note-too-big one — P-012 fingerprint must separate them',
  },
  {
    n: 34, errorCode: null, status: 'error',
    message: 'invalid_args: status: Invalid option: expected one of "draft"|"ready"|"shipped"|"superseded"',
    expectedClass: 'caller',
    note: 'another distinct caller mode',
  },
  {
    n: 30, errorCode: 'handler_error', status: 'error',
    message: 'invalid_args: paths: Too small: expected array to have >=1 items',
    expectedClass: 'caller',
    note: 'handler_error + invalid_args: again',
  },
  {
    n: 30, errorCode: 'handler_error', status: 'error',
    message: 'invalid_args: wait.max_sec: Too big: expected number to be <=300',
    expectedClass: 'caller',
    note: 'yet another distinct caller mode (P-012 separation)',
  },
  {
    n: 5, errorCode: 'handler_error', status: 'error',
    message: 'capability:computer — no sandbox desktop is leased to this agent. A desktop must be provisioned first',
    expectedClass: 'caller',
    note: 'desktop-only capability used before provisioning its required lease — caller precondition, not a structural tool defect',
  },
  {
    n: 15, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"error":"checkpoint_replace_would_drop_rows","errorCode":"checkpoint_replace_would_drop_rows","retryable":true}',
    expectedClass: 'caller',
    note: 'nested tools:invoke wrapper preserves a deliberate checkpoint safety refusal in JSON error_message; it is caller-directed, not structural',
  },
  {
    n: 1, errorCode: 'checkpoint_conflict', status: 'error',
    message: 'The carry-note changed after the supplied contentHash was read; no note was written. Re-read the current carry-note and retry with its contentHash, or reconcile before writing.',
    expectedClass: 'caller',
    note: 'direct loop:checkpoint optimistic-CAS refusal: the caller must refresh/reconcile its stale expectedHash, not file a structural tool bug (EI-25276774946067116)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"error":"checkpoint_conflict","retryable":false,"expectedHash":"aaaaaaaaaaaa","currentHash":"bbbbbbbbbbbb"}',
    expectedClass: 'caller',
    note: 'nested tools:invoke wrapper preserves the expected loop:checkpoint CAS refusal in JSON error_message; classify the stale-state refusal as caller-side too',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"result":"refused-agent-busy","note":"REFUSED — the agent is still emitting output (mid-turn). Reach a settled prompt and retry, or pass force:true if you are certain the turn is finished.","shutdownWakeGuardRecorded":null,"agentLaunched":true,"hostSupportsShutdown":true}',
    expectedClass: 'caller',
    note: 'session:end deliberately refused shutdown while the agent was mid-turn; tools:invoke retained the refusal inside handler_error (EI-26251588319744742)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: "acceptance_bar_amendment_revision_conflict: subject plan 'verification-system-improvements-2026-10-10' expected 118, live 119",
    expectedClass: 'caller',
    note: 'rubrics:amend refuses an approval bound to a stale subject-plan revision; refresh the preview and approval instead of filing the expected compare-and-swap as a structural bug (EI-25679727768588706)',
  },
  {
    n: 14, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"requested":false,"error":"flush-required","tripwires":[{"kind":"missing-checkpoint","subject":"WI-10004595"}]}',
    expectedClass: 'caller',
    note: 'nested tools:invoke wrapper preserves the intentional compaction flush-gate refusal; missing checkpoints are an actionable caller precondition, not a structural tool defect',
  },
  {
    n: 1, errorCode: 'rubric-not-found', status: 'error',
    message: 'rubric not found',
    expectedClass: 'caller',
    note: 'rubrics:get rejected an unsupported rubricRef@revision form; revision is supplied separately as a numeric argument',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'scratch_line_window_too_large: This scratch-reference line window is too large for one result. Use a smaller offset/limit/tail window, or byte_offset+byte_limit when a single line is too large.',
    expectedClass: 'caller',
    note: 'intentional capability:read scratch-reference size refusal nested through tools:invoke; retain the actionable paging guidance and keep it out of the structural bug lane (EI-25217974819289093)',
  },
  {
    n: 1, errorCode: 'scratch_line_window_too_large', status: 'handler_error',
    message: 'A tail:45 read of the consult result scratch spill was refused because the selected line window exceeded the response-size limit; the tool advised smaller line windows or byte paging.',
    expectedClass: 'caller',
    note: 'toolFailure reports can store this refusal code separately from the message; keep that captured shape out of the structural bug lane (EI-25280060314357525)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"reason":"evidence_class_not_found","message":"scratch reference has no work-item evidence."}',
    expectedClass: 'caller',
    note: 'intentional capability:read evidence-selection refusal nested through tools:invoke; a requested class absent from the scratch manifest is caller input, not a structural tool defect (EI-25220489889996991; invocation 32104913)',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"error":"tenant-scoped read required","reason":"tenant_scope_required"}',
    expectedClass: 'caller',
    note: 'synthetic parity fixture for a reason-coded tenant-scope refusal; the caller can supply the required scope',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"error":"tenant-scoped read required","reason":"positive_control_tenant_scope_required"}',
    expectedClass: 'caller',
    note: 'synthetic parity fixture for the reason-coded positive-control tenant-scope refusal',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"reason":"mixed_window_modes","message":"raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes."}',
    expectedClass: 'caller',
    note: 'synthetic parity fixture for the nested capability:read mixed-window refusal observed in invocation 34619865',
  },
  {
    n: 3, errorCode: 'handler_error', status: 'error',
    message: 'acceptance BAR contract is not ready for vetting — 7 of 7 BAR(s) blocking, 0 clean: R-1: bar_snapshot_role_invalid; R-2: bar_snapshot_role_invalid; R-3: bar_snapshot_role_invalid; R-4: bar_snapshot_role_invalid; R-5: bar_snapshot_role_invalid; R-6: bar_snapshot_role_invalid; R-7: bar_snapshot_role_invalid',
    expectedClass: 'caller',
    note: 'the caller-authored BAR roles fail lifecycle pre-vetting; deterministic readiness refusal is caller input, not a structural tool defect',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'reviewer_model_not_allowed: codex/gpt-6.1-sol is absent from the workspace expert allowlist',
    expectedClass: 'caller',
    note: 'explicit reviewer-model allowlist refusal for the caller-selected model; do not promote it as a structural tool bug (EI-24950089856585512)',
  },
  {
    n: 3, errorCode: 'handler_error', status: 'error',
    message: 'acceptance_bar_approval_required: use thread-post:<id> from an authenticated reviewer post containing the preview approval JSON',
    expectedClass: 'caller',
    note: 'rubrics:amend deliberately returns this no-write refusal until the required outside-lineage reviewer approval exists (EI-25736374674133206)',
  },
  {
    n: 0, errorCode: 'handler_error', status: 'error',
    message: '{"ok":false,"code":"acceptance_bar_approval_required","error":"acceptance_bar_approval_required: use thread-post:<id> from an authenticated reviewer post containing the preview approval JSON"}',
    expectedClass: 'caller',
    note: 'synthetic nested tools:invoke wrapper for the same intentional approval refusal; both classifier engines must preserve caller control flow',
  },
  {
    n: 3, errorCode: 'unauthorized', status: 'error',
    message: 'coord:ask is owner-UI-only; agents must use coord:send or coord:message-agent.',
    expectedClass: 'caller',
    note: 'agent invocation of an owner-UI-only surface is an expected permission precondition; keep the generic unauthorized workspace-scope error structural (D-007)',
  },
  {
    n: 33, errorCode: 'authorization_denied', status: 'error',
    message: 'Kernel preflight denied tool "sessions:ingest-gate-event": Identity capability (unresolved): outside-ceiling (sessions:ingest-gate-event)',
    expectedClass: 'caller',
    note: 'the caller identity has no authored grant for this tool; expected kernel refusal, not a structural tool defect',
  },
  {
    n: 16, errorCode: 'authorization_denied', status: 'error',
    message: 'Kernel preflight denied tool "journal:record-turn": Identity capability (unresolved): outside-ceiling (journal:record-turn)',
    expectedClass: 'caller',
    note: 'the caller identity has no authored grant for this tool; expected kernel refusal, not a structural tool defect',
  },
  {
    n: 13, errorCode: 'authorization_denied', status: 'error',
    message: 'Kernel preflight denied tool "tools:invoke": Identity capability (unresolved): stale-artifact (tools:invoke)',
    expectedClass: 'caller',
    note: 'the caller launch record cannot prove the desired identity revision; this is a fail-closed identity-state refusal, not a defect in tools:invoke',
  },
  {
    n: 1, errorCode: 'authorization_denied', status: 'error',
    message: 'Kernel preflight denied tool "locks:queue": current session authority could not be read; no effect authorized',
    expectedClass: 'transient',
    note: 'EI-24153500352569256: the kernel correctly failed closed when the authority read failed; classify the infrastructure condition as transient instead of promoting it as a structural locks:queue defect',
  },
  {
    n: 3, errorCode: 'handler_error', status: 'error',
    message: 'missing_capability: Principal "system:judge" lacks capability "intel:read" (tool: dev:pg_query) — This is a judge-scoped MCP session; this principal lacks intel:read for dev:pg_query. `tools:invoke` preserves the same judge principal, so do not retry it in this session: it will be denied identically. Use a separate authorized su/operator session through the papercusp-su MCP server to invoke the tool.',
    expectedClass: 'caller',
    note: 'tools:invoke preserves the judge principal and wraps this expected missing_capability refusal as handler_error; the preserved code prefix must route to caller, not the structural bug lane',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'watch:create — predicate registration failed its inline first eval (unwound): predicate_shape_mismatch: observed hex SHA is 40 characters but the operand is 10 characters; they are strict-prefix forms. Supply the same SHA width before registering this predicate.',
    expectedClass: 'caller',
    note: 'state:subscribe delegates predicate registration; a strict-prefix SHA operand is an intentional caller-input refusal that prevents a false wake, not a structural tool defect (EI-24876630811914890)',
  },
  {
    n: 1, errorCode: 'context_mismatch', status: 'rejected',
    message: 'Patch verification could not find the expected workspace-map heading and path lines in apps/operator/prompts/pot-instances/papercup-pot.su.md; no files were changed.',
    expectedClass: 'caller',
    note: 'apply_patch rejected mismatched expected hunk context before writing; refresh the current file text (EI-24740711211595015)',
  },
  {
    n: 1, errorCode: 'verification_failed', status: '',
    message: 'A three-file resource-governor repair patch was rejected before writing because I matched a long project-doc-parts disposition line with abbreviated text. Corrected patch will anchor on the unique array terminator and use short exact hunks.',
    expectedClass: 'caller',
    note: 'the report identifies abbreviated patch context as the caller error; no Papercusp tool defect is evidenced (EI-23737545927303638)',
  },
  {
    n: 1, errorCode: 'verification-failed', status: 'patch-context-mismatch',
    message: 'A one-file patch was rejected because one expected source line did not match exactly. The patch applied nothing. Re-read the exact line context and reformulate the single-file patch.',
    expectedClass: 'caller',
    note: 'the patch tool refused stale/mismatched hunk context before writing; re-read the exact source lines (EI-25197457482157766)',
  },
  {
    n: 1, errorCode: null, status: 'parse-error',
    message: 'The nested call returned text beginning `format: toon`; a script assumed content[0].text was JSON and JSON.parse threw SyntaxError, discarding the raw event-status payload. The event status was not interpreted, and the call has not been retried.',
    expectedClass: 'caller',
    note: 'events:status returned valid compact TOON; JSON.parse of its tagged content is caller misuse and must not be promoted as a structural tool bug (EI-24868283216064457)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'Code-run script treated nested activity:recent typed output as an MCP content envelope and failed with structured_result_shape; the returned activity data is in the typed root.',
    expectedClass: 'caller',
    note: 'code:run typed-root output was read as an MCP content envelope; structured_result_shape is a caller read-shape diagnostic (EI-25223020018710222)',
  },
  {
    n: 1, errorCode: 'structured_result_shape', status: 'error',
    message: 'A code:run script reading testing:runs assumed an MCP content/text envelope; testing:runs returned a typed structured root and the script failed before producing its distilled summary.',
    expectedClass: 'caller',
    note: 'the diagnostic code identifies a typed-root field-access error even when the report wording omits the token (EI-25373728404775168)',
  },
  {
    n: 1, errorCode: null, status: 'error',
    message: 'The normalized direct wrapper tools.mcp__papercusp_su__locks_list was undefined, so attempting it raised a local TypeError before MCP dispatch. tools:find activated locks:list; no server-side locks:list call was made.',
    expectedClass: 'caller',
    note: 'the client called an unseeded deferred wrapper before tools:find discovery; no MCP request reached the server (EI-25486226169848485)',
  },
  {
    n: 1, errorCode: 'client_wrapper_unavailable', status: 'not_dispatched',
    message: 'The normalized direct wrapper tools.mcp__papercusp_su__coord_read was not callable (TypeError) before dispatch. The tool is present in the registry; reading the directed message must use the sanctioned ptool route.',
    expectedClass: 'caller',
    note: 'the normalized wrapper was absent before MCP dispatch; the catalog/ptool route remained available (EI-25654124340277423)',
  },
  {
    n: 1, errorCode: 'unknown_tool_wrapper', status: 'client',
    message: 'Normalized direct wrapper mcp__papercusp_su__locks_acquire was not callable; tools:find returned locks:acquire schema, so switched to ptool CLI fallback. Reproduced: true. Direct evidence kind: valid-input-reproduction. Direct evidence expected: callable locks:acquire wrapper or equivalent lock acquisition. Direct evidence actual: TypeError: tools.mcp__papercusp_su__locks_acquire is not a function',
    expectedClass: 'caller',
    note: 'the deferred Codex wrapper was absent before MCP dispatch; unknown_tool_wrapper is a client-surface condition and must remain non-claimable (EI-25980326230643570)',
  },
  {
    n: 1, errorCode: 'compile_error', status: 'compile_error',
    message: 'compile_error: Invalid regular expression flags while compiling the submitted code:run script',
    expectedClass: 'caller',
    note: 'the compiler correctly rejected malformed caller JavaScript before dispatch; the reporter confirmed the regex was over-escaped and did not reproduce with valid input (EI-24101166314859289)',
  },
  {
    n: 1, errorCode: 'handler_error', status: 'error',
    message: 'column "passed" does not exist: ' + JSON.stringify({
      error: 'column "passed" does not exist',
      code: '42703',
      knownColumns: { 'harness_shared.test_runs': ['execution_details: jsonb'] },
      jsonbPath: '⚠ `passed` is NOT a column on harness_shared.test_runs',
    }),
    expectedClass: 'caller',
    note: 'tools:invoke wraps dev:pg_query’s caller-authored SQL undefined-column refusal; the knownColumns guidance identifies the invalid SQL field, not a broken invoke wrapper (EI-25389944836048866)',
  },
  {
    n: 1, errorCode: 'self_await_deadlock', status: 'refused',
    message: 'You are the CURRENT ASSIGNEE of WI-6554700010008741 — awaiting "work-item:done:WI-6554700010008741" would wait on YOUR OWN completion of it, which is unsatisfiable by construction. Nothing was registered.',
    expectedClass: 'caller',
    note: 'events:await correctly refused an attempt to await the current assignee’s own work-item completion; the refusal prevents self-deadlock and must not be promoted as a structural tool bug (EI-25327017880527713)',
  },
  {
    n: 1, errorCode: 'owner_not_found', status: 'handler_error',
    message: "Owner 'system:judge/su-9fc0d5e2-95e7-424b-a62f-66e00e1c1a55' matches no known ownerId; pass the full ownerId or check coord:presence.",
    expectedClass: 'caller',
    note: 'activity:tool-log correctly refused an unsupported namespaced owner label; unknown owner filters are caller input, not a structural tool failure (EI-25267413190818941)',
  },
  {
    n: 0, errorCode: 'owner_ambiguous', status: 'handler_error',
    message: "Owner 'su-peer' matches more than one live ownerId; pass the full ownerId.",
    expectedClass: 'caller',
    note: 'synthetic typed owner-resolution refusal: ambiguous owner filters are caller input, not a structural tool failure',
  },

  // ── structural: genuine bugs/misconfig (the low-bar auto-implement lane) ────
  {
    n: 2809, errorCode: 'handler_error', status: 'error',
    message: 'column "initiative" does not exist',
    expectedClass: 'structural',
    note: 'a real bug — a missing column; SHOULD reach the fix lane',
  },
  {
    n: 16, errorCode: null, status: 'error',
    message: 'new row for relation "engineer_issues" violates check constraint "engineer_issues_state_check"',
    expectedClass: 'structural',
    note: 'a real constraint-violation bug',
  },

  // ── structural by DESIGN (deliberate; D-007 / the CALLER_MESSAGE_PATTERN note) ──
  {
    n: 81, errorCode: null, status: 'error',
    message: 'built-in tool "memory:search" requires authenticated request (bearer + workspace tx)',
    expectedClass: 'structural',
    note: 'auth/scope wiring gap — deliberately structural (a wiring gap worth catching at the low bar)',
  },
  {
    n: 29, errorCode: null, status: 'error',
    message: 'built-in tool "memory:search" requires a workspace-scoped call — this session has no workspace transaction. Scope the session to a workspace',
    expectedClass: 'structural',
    note: 'workspace-scope gap — deliberately structural per D-007 (NOT folded into caller)',
  },
  {
    n: 22, errorCode: 'unauthorized', status: 'error',
    message: 'built-in tool "memory:search" requires a workspace-scoped call — this session has no workspace transaction. Scope the session to a workspace',
    expectedClass: 'structural',
    note: 'unauthorized code is not in the caller set — stays structural (design intent)',
  },
  {
    n: 28, errorCode: null, status: 'error',
    message: 'resolveAgentIdentity: superuser context is missing uiClientId — re-run install-standalone-mcp.sh to mint a ?client= id',
    expectedClass: 'structural',
    note: 'client-setup error — currently structural (a candidate caller refinement, deferred to P-006/P-007 territory)',
  },
  {
    // BORDERLINE (disclosed): a validation reject with no `invalid_args:` prefix.
    // Arguably caller, but kept structural to match current behavior — reclassifying
    // bare validation messages is a P-006/P-007 caller-DX refinement, out of P-011 scope.
    n: 141, errorCode: null, status: 'error',
    message: 'channel name too long',
    expectedClass: 'structural',
    note: 'BORDERLINE: bare validation reject (no invalid_args: prefix) — kept structural; flagged as a future caller-DX candidate',
  },
];

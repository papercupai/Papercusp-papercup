/**
 * tool-error-classifier.test.ts — the real-corpus regression guard for the
 * tool-error classifier (watchdog-and-exposed-systems-improvement-2026-06-18
 * P-011). The classifier was brittle and fixed reactively three times
 * (timeout-in-wrong-branch, external-rate-limit missing, the invalid_args drift).
 * This test pins the LIVE high-volume error shapes (tool-error-corpus.fixture.ts)
 * to their correct class so the NEXT misclassification is caught before it floods
 * a lane — and proves the table-driven generators are structurally sound.
 *
 * The SQL-CASE↔TS PARITY (the anti-drift guarantee with teeth) lives in
 * tool-error-classifier.integration.test.ts, which runs the GENERATED SQL over
 * this same corpus in real PG.
 *
 * Bucket query used to capture the fixture (re-run to refresh):
 *   WITH e AS (SELECT coalesce(error_code,'<null>') ec, status,
 *     array_to_string((string_to_array(trim(regexp_replace(regexp_replace(
 *       lower(coalesce(error_message,'')),'[0-9]+','','g'),'[^a-z]+',' ','g')),' '))[1:8],' ') norm,
 *     error_message FROM harness_shared.tool_invocations
 *     WHERE status IN ('error','timeout') AND invoked_at > now() - interval '14 days')
 *   SELECT count(*) n, ec, status, left(norm,80), left(max(error_message),140)
 *   FROM e GROUP BY ec, status, 4 ORDER BY n DESC LIMIT 45;
 */
import { homedir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  classifyToolError,
  toolErrorFingerprint,
  toolErrorSignalKey,
  toolErrorClassSqlCase,
  toolErrorFingerprintSqlCase,
  TOOL_ERROR_RULES,
  FINGERPRINTED_TOOL_ERROR_CLASSES,
  normalizeSuspectedToolFailure,
  toolFailureSignatureKey,
  parseToolFailureSignatureKey,
  matchKnownExternalToolFailure,
  KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES,
  type ToolErrorClass,
  type SuspectedToolFailure,
} from './tool-error-classifier';
import { TOOL_ERROR_CORPUS } from './tool-error-corpus.fixture';
import { metadataToolFailure } from '../../agent-tools/plans/coordination-metadata-fixtures';

const missingHomeCwd = homedir() + '/__papercusp_missing_cwd_test__';

describe('P-001 R-7 frozen friction correlation controls', () => {
  it('replays the same report with stable identities but without an authority escalation', () => {
    const first = normalizeSuspectedToolFailure(metadataToolFailure);
    const replay = normalizeSuspectedToolFailure({ ...metadataToolFailure });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      class: 'caller',
      direct: false,
      contractFingerprint: 'metadata-schema-v1~body',
      deployedRevision: 'metadata-runtime-v1',
    });
    expect(first.correlationFingerprint)
      .toContain('coord:send|invalid_args|metadata-schema-v1|body|metadata-runtime-v1|');
  });

  it.each([
    { schemaRevision: 'metadata-schema-v2' },
    { fieldPath: 'expects' },
    { runtimeVersion: 'metadata-runtime-v2' },
  ])('does not collapse a changed contract/runtime into the same lifecycle identity: %j', (change) => {
    const original = normalizeSuspectedToolFailure(metadataToolFailure);
    const changed = normalizeSuspectedToolFailure({ ...metadataToolFailure, ...change });
    expect(changed.classKey).not.toBe(original.classKey);
    expect(changed.correlationFingerprint).not.toBe(original.correlationFingerprint);
    // The watchdog's tool/class/message key intentionally has a narrower scope.
    expect(changed.watchdogKey).toBe(original.watchdogKey);
  });

  it('keeps missing dimensions explicit instead of claiming the known fixture contract', () => {
    const unknown = normalizeSuspectedToolFailure({
      toolName: metadataToolFailure.toolName,
      message: metadataToolFailure.message,
      errorCode: metadataToolFailure.errorCode,
    });
    expect(unknown.contractFingerprint).toBe('schema-unknown~field-unknown');
    expect(unknown.deployedRevision).toBe('runtime-unknown');
    expect(unknown.classKey).not.toBe(normalizeSuspectedToolFailure(metadataToolFailure).classKey);
  });

  it('classifies local MCP admission sheds as transient and keeps them distinct from structural failures', () => {
    const saturated = normalizeSuspectedToolFailure({
      toolName: 'ptool',
      errorCode: '-32000',
      status: 'request shed',
      message: 'operator MCP admission is saturated — request shed; reason=loop_pressure_critical',
    });
    const malformed = normalizeSuspectedToolFailure({
      toolName: 'ptool',
      errorCode: 'invalid_json',
      status: 'rejected',
      message: 'malformed JSON before dispatch',
    });

    // A retryable shed is shared admission backpressure; malformed JSON remains
    // structural. Their class-key identities must stay separate even without
    // schema/runtime metadata.
    expect(saturated.class).toBe('transient');
    expect(malformed.class).toBe('structural');
    expect(saturated.classKey).not.toBe(malformed.classKey);
    expect(saturated.watchdogKey).not.toBe(malformed.watchdogKey);
  });

  it.each([
    'operator MCP admission is saturated — request shed, retry shortly',
    'operator MCP admission is saturated — request shed; reason=loop_pressure_critical',
    'operator MCP admission is saturated — request shed; reason=operator_admission_capacity',
  ])('treats the operator admission response as transient: %s', (message) => {
    expect(classifyToolError('-32000', 'request shed', message)).toBe('transient');
  });

  it('treats a captured plans:attention admission refusal without "is" or "=" as transient', () => {
    expect(classifyToolError(
      '-32000',
      'request_shed',
      'plans:attention was refused at dispatch: operator MCP admission saturated, reason loop_pressure_critical',
    )).toBe('transient');
  });

  it('classifies the release admission worker busy refusal as transient, while retaining structural fallback', () => {
    const message = 'an admission job is already running in this process; retry after it settles';
    expect(classifyToolError('handler_error', 'error', message)).toBe('transient');
    expect(classifyToolError('ADMISSION_OFFTHREAD_BUSY', 'error', 'busy')).toBe('transient');
    expect(classifyToolError('handler_error', 'error', 'admission failed with an unrelated error')).toBe('structural');

    expect(normalizeSuspectedToolFailure({
      toolName: 'release:repair-queue',
      errorCode: 'handler_error',
      status: 'error',
      message,
    })).toMatchObject({ class: 'transient', direct: false });
  });

  it('D-010: the filing signature ignores schema/runtime churn but keeps tool, family, error code and field', () => {
    const original = normalizeSuspectedToolFailure(metadataToolFailure);
    const signature = toolFailureSignatureKey(metadataToolFailure, original.class);
    expect(signature).toBe('tool-failure-signature:coord:send:caller:invalid_args:body');
    for (const change of [{ schemaRevision: 'metadata-schema-v2' }, { runtimeVersion: 'metadata-runtime-v2' }]) {
      const changed = normalizeSuspectedToolFailure({ ...metadataToolFailure, ...change });
      // The class (corroboration identity) moves; the filing signature does not.
      expect(changed.classKey).not.toBe(original.classKey);
      expect(toolFailureSignatureKey({ ...metadataToolFailure, ...change }, changed.class)).toBe(signature);
    }
    for (const change of [{ errorCode: 'timeout' }, { fieldPath: 'expects' }, { toolName: 'coord:inbox' }]) {
      expect(toolFailureSignatureKey({ ...metadataToolFailure, ...change }, original.class)).not.toBe(signature);
    }
    expect(toolFailureSignatureKey(metadataToolFailure, 'structural')).not.toBe(signature);
    expect(toolFailureSignatureKey({ toolName: 'ptool' }, 'structural'))
      .toBe('tool-failure-signature:ptool:structural:error-code-unknown:field-unknown');
  });

  it('keys result-door spill failures by subsystem and code, independent of the named tool', () => {
    const first = toolFailureSignatureKey({
      toolName: 'facts:list', errorCode: 'output_spill_failed', fieldPath: 'result',
    }, 'transient');
    const second = toolFailureSignatureKey({
      toolName: 'work_items:get', errorCode: 'output_spill_failed', fieldPath: 'payload',
    }, 'structural');

    expect(first).toBe('tool-failure-signature:result-door:structural:output_spill_failed:field-unknown');
    expect(second).toBe(first);
    expect(parseToolFailureSignatureKey(first)).toEqual({
      toolName: 'result-door',
      failureFamily: 'structural',
      errorCode: 'output_spill_failed',
      fieldPath: 'field-unknown',
    });
    expect(toolFailureSignatureKey({
      toolName: 'work_items:get', errorCode: 'different_error', fieldPath: 'payload',
    }, 'structural')).not.toBe(first);
  });

  it('a repeated caller rejection does not become direct evidence through legacy booleans', () => {
    expect(normalizeSuspectedToolFailure({
      ...metadataToolFailure, reproduced: true, clearServerMismatch: true, hardInternal: true,
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it('keeps an unseeded direct wrapper miss on the caller path, even when locally reproduced', () => {
    const message =
      'The normalized direct wrapper tools.mcp__papercusp_su__locks_list was undefined, so attempting it raised a local TypeError before MCP dispatch. tools:find activated locks:list; no server-side locks:list call was made.';
    expect(classifyToolError(null, 'error', message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'locks:list',
      status: 'error',
      message,
      reproduced: true,
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it('classifies the observed Codex deferred-wrapper TypeError variants as caller-side', () => {
    const reports = [
      {
        toolName: 'logs:read',
        errorCode: 'client_wrapper_unavailable',
        status: 'not_dispatched',
        message: 'The capability is present in tools:find, but tools.mcp__papercusp_su__logs_read is not callable in this Codex session; calling it raised TypeError before dispatch. Switching to ptool logs:read via the sanctioned CLI fallback.',
      },
      {
        toolName: 'coord:read',
        errorCode: 'client_wrapper_unavailable',
        status: 'not_dispatched',
        message: 'The normalized direct wrapper tools.mcp__papercusp_su__coord_read was not callable (TypeError) before dispatch. The tool is present in the registry; reading the directed message must use the sanctioned ptool route.',
      },
      {
        toolName: 'docs:outline',
        errorCode: 'wrapper-unavailable',
        status: 'client_surface_gap',
        message: 'Direct nested docs:outline wrapper call threw TypeError: tools.mcp__papercusp_su__docs_outline is not a function before dispatch. Recover through tools:find/tools:invoke.',
      },
      {
        toolName: 'scheduler:get_claim_spec',
        errorCode: 'wrapper-unavailable',
        status: 'not_dispatched',
        message: 'This Codex session attempted tools.mcp__papercusp_su__scheduler_get_claim_spec directly; the normalized wrapper was undefined and calling it threw TypeError before MCP dispatch.',
      },
      {
        toolName: 'papercusp:list_workspaces',
        errorCode: 'client_wrapper_missing',
        status: 'dispatch_unavailable',
        message: 'The catalog exposed papercusp:list_workspaces, but the normalized functions.exec method mcp__papercusp_su__papercusp_list_workspaces was undefined and raised a TypeError before dispatch. The capability remains reachable through the documented ptool CLI fallback.',
      },
      {
        toolName: 'locks:acquire',
        errorCode: 'unknown_tool_wrapper',
        status: 'client',
        message: 'Normalized direct wrapper mcp__papercusp_su__locks_acquire was not callable; tools:find returned locks:acquire schema, so switched to ptool CLI fallback. Reproduced: true. Direct evidence kind: valid-input-reproduction. Direct evidence expected: callable locks:acquire wrapper or equivalent lock acquisition. Direct evidence actual: TypeError: tools.mcp__papercusp_su__locks_acquire is not a function',
        directEvidence: {
          kind: 'valid-input-reproduction',
          expected: 'callable locks:acquire wrapper or equivalent lock acquisition',
          actual: 'TypeError: tools.mcp__papercusp_su__locks_acquire is not a function',
        },
      },
    ];

    for (const report of reports) {
      expect(classifyToolError(report.errorCode, report.status, report.message)).toBe('caller');
      expect(normalizeSuspectedToolFailure({ ...report, reproduced: true } as SuspectedToolFailure)).toMatchObject({
        class: 'caller',
        direct: false,
      });
    }

    expect(classifyToolError('handler_error', 'error', 'The MCP handler raised TypeError before dispatch.'))
      .toBe('structural');
  });

  it('classifies the canonical wrapper_missing status and code as caller-side', () => {
    const reports = [
      {
        toolName: 'mcp__papercusp_su__state_read',
        status: 'wrapper_missing',
        message: 'In this Codex functions.exec session, tools.mcp__papercusp_su__state_read was undefined and calling it raised TypeError before dispatch. The server-side state:read capability remained reachable through the ptool fallback, which returned gate.greenCheckpoint.ownership.',
      },
      {
        toolName: 'mcp__papercusp_su__state_read',
        errorCode: 'wrapper_missing',
        status: 'not_dispatched',
        message: 'The normalized direct wrapper was unavailable before MCP dispatch.',
      },
    ];

    for (const report of reports) {
      expect(classifyToolError(report.errorCode, report.status, report.message)).toBe('caller');
      expect(normalizeSuspectedToolFailure({ ...report, reproduced: true } as SuspectedToolFailure)).toMatchObject({
        class: 'caller',
        direct: false,
      });
    }
  });

  it('keeps wrapper-unavailable discovery reports caller-side and non-claimable despite structured prose', () => {
    const report = {
      toolName: 'fleet:status',
      status: 'wrapper-unavailable',
      message: 'The normalized direct wrapper fleet_status is not callable in this Codex session.',
      directEvidence: {
        kind: 'server-contract-mismatch' as const,
        expected: 'tools:find plus tools:invoke provides a route to fleet:status.',
        actual: 'The normalized direct wrapper was unavailable; this observation did not dispatch a server call.',
      },
    };

    expect(classifyToolError(undefined, report.status, report.message)).toBe('caller');
    expect(normalizeSuspectedToolFailure(report)).toMatchObject({
      class: 'caller',
      direct: false,
      knownExternal: null,
    });
  });

  it('classifies the client-wrapper-absent capture status as caller-side and non-claimable', () => {
    const report = {
      toolName: 'scheduler:get_claim_spec',
      status: 'client-wrapper-absent',
      message: "The current Codex session's ALL_TOOLS catalog listed scheduler:get_claim_spec, but typeof tools.mcp__papercusp_su__scheduler_get_claim_spec was undefined. The documented ptool CLI tools:find path succeeded, so the server capability exists while the normalized direct wrapper is absent in this client session.",
      reproduced: true,
    };

    expect(classifyToolError(undefined, report.status, report.message)).toBe('caller');
    expect(normalizeSuspectedToolFailure(report)).toMatchObject({
      class: 'caller',
      direct: false,
      knownExternal: null,
    });
    expect(normalizeSuspectedToolFailure({
      ...report,
      directEvidence: {
        kind: 'server-contract-mismatch',
        expected: 'tools:find and tools:invoke provide the deferred-tool route.',
        actual: 'The normalized direct wrapper was absent before MCP dispatch.',
      },
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it('classifies scratch-reference size refusals from the reported error code or reason status', () => {
    expect(normalizeSuspectedToolFailure({
      toolName: 'capability:read',
      errorCode: 'scratch_line_window_too_large',
      status: 'handler_error',
      message: 'A tail:45 read of the consult result scratch spill was refused because the selected line window exceeded the response-size limit; the tool advised smaller line windows or byte paging.',
    }).class).toBe('caller');

    expect(normalizeSuspectedToolFailure({
      toolName: 'capability:read',
      status: 'scratch_line_window_too_large',
      message: 'A line-window read of a scratch spill containing a long JSON body was refused because the selected text exceeded the response-size limit. The response recommends smaller windows or byte_offset+byte_limit; an exact byte-page read succeeded.',
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'Reading the spill with a reasonable line window returns its contents.',
        actual: 'The line-window call returned scratch_line_window_too_large; the documented byte-page route returned the bytes.',
      },
    }).class).toBe('caller');
  });

  it('classifies mutually exclusive capability:read window modes as caller input', () => {
    expect(normalizeSuspectedToolFailure({
      toolName: 'capability:read',
      errorCode: 'mixed_window_modes',
      status: 'handler_error',
      message: 'raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes.',
    }).class).toBe('caller');

    expect(normalizeSuspectedToolFailure({
      toolName: 'capability:read',
      status: 'mixed_window_modes',
      message: 'raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes.',
    }).class).toBe('caller');
  });
});

describe('classifyToolError — real-corpus regression (P-011)', () => {
  it.each(TOOL_ERROR_CORPUS.map((r) => [r.message.slice(0, 60), r] as const))(
    'classifies %s',
    (_label, row) => {
      expect(classifyToolError(row.errorCode, row.status, row.message)).toBe(row.expectedClass);
    },
  );

  it('the corpus exercises every class (so a regression in any branch is visible)', () => {
    const seen = new Set(TOOL_ERROR_CORPUS.map((r) => r.expectedClass));
    for (const c of ['structural', 'transient', 'caller', 'rate-limit'] as ToolErrorClass[]) {
      expect(seen.has(c)).toBe(true);
    }
  });

  it('REGRESSION GUARD: handler_error + an invalid_args: message classifies caller in BOTH paths (the drift that motivated P-011)', () => {
    // Old TS fn: structural (its error_code branch never checked the message
    // prefix). Old SQL: caller (LIKE 'invalid_args:%'). They MUST agree now.
    expect(classifyToolError('handler_error', 'error', 'invalid_args: note: Too big: expected string to have <=400 characters')).toBe('caller');
    expect(classifyToolError(null, 'error', 'invalid_args: note: Too big')).toBe('caller');
  });

  it('classifies the events:await self-await guard as caller control flow and never promotes its attestation', () => {
    const message =
      'You are the CURRENT ASSIGNEE of WI-6554700010008741 — awaiting "work-item:done:WI-6554700010008741" would wait on YOUR OWN completion of it, which is unsatisfiable by construction. Nothing was registered.';
    expect(classifyToolError('self_await_deadlock', 'refused', message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'events:await',
      errorCode: 'self_await_deadlock',
      status: 'refused',
      message,
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'the guard refuses a wait on the current assignee’s own completion',
        actual: 'the guard returns self_await_deadlock and registers nothing',
      },
    })).toMatchObject({ class: 'caller', direct: false });
    // The specific code wins even when unrelated structural prose is also present.
    expect(classifyToolError(
      'self_await_deadlock',
      'error',
      'self_await_deadlock: current assignee; Cannot read properties of undefined',
    )).toBe('caller');
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
  });

  it('classifies stale tools:invoke serving-generation refusals as caller state', () => {
    const message =
      'stale_tool_contract: schema was discovered from serving-generation-v1:old, but this operator serves ' +
      'serving-generation-v1:current; refresh tools:find on this operator';
    expect(classifyToolError('handler_error', 'error', message)).toBe('caller');
    expect(classifyToolError('stale_tool_contract', 'error', 'generation mismatch before dispatch')).toBe('caller');
    expect(classifyToolError('handler_error', 'error', JSON.stringify({ error: message }))).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'tools:invoke',
      errorCode: 'handler_error',
      status: 'error',
      message,
      reproduced: true,
    })).toMatchObject({ class: 'caller', direct: false });
    // A generic handler failure that merely mentions an MCP generation remains structural.
    expect(classifyToolError('handler_error', 'error', 'serving generation lookup failed in the database')).toBe('structural');
  });

  it('classifies the claim-spec self-sentinel refusal as caller misuse, not a structural tool defect', () => {
    const message =
      'cupId must be a concrete session/owner ID, not the literal "self". To read your own claim spec, use { cupId: \'su-owner-id\' } for this session.';
    expect(classifyToolError('handler_error', 'error', message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'scheduler:get_claim_spec',
      errorCode: 'handler_error',
      status: 'error',
      message,
    }).class).toBe('caller');
    // Keep genuine implementation failures on the structural lane.
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
  });

  it('classifies the intentional events:status judge restriction as caller control flow', () => {
    const message =
      'events:status — the evidence-only judge may inspect its own awaits only; exact-key inspection and fleet-meter access are unavailable.';
    expect(classifyToolError('handler_error', 'error', message)).toBe('caller');
    expect(classifyToolError(null, 'error', message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'events:status',
      errorCode: 'handler_error',
      status: 'error',
      message,
    })).toMatchObject({ class: 'caller', direct: false });
    // Genuine handler failures must remain eligible for structural repair.
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
  });

  it('classifies stale acceptance BAR amendment revision conflicts as caller state, not structural failure', () => {
    const message =
      "acceptance_bar_amendment_revision_conflict: subject plan 'verification-system-improvements-2026-10-10' expected 118, live 119";
    expect(classifyToolError('handler_error', 'error', message)).toBe('caller');
    expect(classifyToolError(null, 'error', message)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', JSON.stringify({ ok: false, error: message }))).toBe('caller');
    expect(normalizeSuspectedToolFailure({ toolName: 'rubrics:amend', errorCode: 'handler_error', status: 'error', message }).class)
      .toBe('caller');
    // A real amend failure without the explicit CAS refusal remains structural.
    expect(classifyToolError('handler_error', 'error', 'amendRubric failed to persist acceptance BAR contract'))
      .toBe('structural');
  });

  it('classifies explicit missing or non-directory capability:bash cwd values as caller input only', () => {
    expect(classifyToolError(
      'handler_error',
      'error',
      "capability:bash cwd '" + missingHomeCwd + "' does not exist — the child process cannot start. Pass an existing directory as cwd.",
    )).toBe('caller');
    expect(classifyToolError(
      'handler_error',
      'error',
      "capability:bash cwd '/tmp/a-file' exists but is not a directory — the child process cannot start there. Pass an existing directory as cwd.",
    )).toBe('caller');
    // An implicit stale project root indicates harness configuration, so it stays structural.
    expect(classifyToolError(
      'handler_error',
      'error',
      "capability:bash implicit cwd '/tmp/phantom-root' (this context's project dir) does not exist, and no existing PAPERCUSP_INTEGRATION_ROOT was available to recover to — the harness registry likely points at a stale or phantom repo root.",
    )).toBe('structural');
  });

  it('keeps an nsenter process-namespace permission refusal out of the structural lane, even with direct evidence', () => {
    const message = 'nsenter: cannot open /proc/1/ns/pid: Permission denied';
    expect(classifyToolError('child_failed', 'failed', message)).toBe('caller');
    expect(classifyToolError('child_failed', 'failed', 'cat: cannot open /root/private: Permission denied'))
      .toBe('structural');

    expect(normalizeSuspectedToolFailure({
      toolName: 'capability:bash',
      errorCode: 'child_failed',
      status: 'failed',
      message,
      reproduced: true,
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'host namespace process inspection emits owner',
        actual: 'namespace transition denied before command',
      },
    })).toMatchObject({ class: 'caller', direct: false });

    expect(normalizeSuspectedToolFailure({
      toolName: 'capability:bash',
      errorCode: 'child_failed',
      status: 'failed',
      message: 'python: SyntaxError: invalid syntax',
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'the documented command executes',
        actual: 'the child reports a syntax error',
      },
    })).toMatchObject({ class: 'structural', direct: true });
  });

  it.each([
    [
      'blocked_command',
      'The shell command was refused before execution by the PreToolUse guard: the command contains rm -f style cleanup, which is not permitted.',
    ],
    [
      'PreToolUseCommandRejected',
      'A path-free diagnostic was rejected because the guard said rm -f style commands are not permitted.',
    ],
    [
      null,
      'The shell command was refused before execution: rm -f style commands are not permitted.',
    ],
  ] as const)('classifies the expected native rm cleanup refusal as caller and denies direct promotion (%s)', (errorCode, message) => {
    expect(classifyToolError(errorCode, 'denied', message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'exec_command',
      errorCode,
      status: 'denied',
      message,
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'A focused test command with bounded output handling can execute through exec_command.',
        actual: message,
      },
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it('classifies stopped or reassigned resolver-run refusals as expected caller control flow', () => {
    const errorCode = 'resolver_owner_mismatch_or_not_executing';
    const message = 'The bulk-resolve run is stopped and no report was written.';
    expect(classifyToolError(errorCode, 'refused', message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'inbox:bulk-run-report',
      errorCode,
      status: 'refused',
      message,
    }).class).toBe('caller');
  });

  it('classifies typed unknown and ambiguous owner-filter refusals as caller input', () => {
    for (const [errorCode, message] of [
      ['owner_not_found', "Owner 'system:judge/su-owner' matches no known ownerId; pass the full ownerId."],
      ['owner_ambiguous', "Owner 'su-peer' matches more than one live ownerId; pass the full ownerId."],
    ] as const) {
      expect(classifyToolError(errorCode, 'handler_error', message)).toBe('caller');
      expect(normalizeSuspectedToolFailure({
        toolName: 'activity:tool-log',
        errorCode,
        status: 'handler_error',
        message,
      })).toMatchObject({ class: 'caller', direct: false });
    }
  });

  it('keeps raw and paraphrased caller-authored pg_query 42703 refusals out of the structural lane', () => {
    const wrappedPgQueryRefusal = 'column "passed" does not exist: ' + JSON.stringify({
      error: 'column "passed" does not exist',
      code: '42703',
      knownColumns: { 'harness_shared.test_runs': ['execution_details: jsonb'] },
      jsonbPath: '⚠ `passed` is NOT a column',
    });
    expect(classifyToolError('handler_error', 'error', wrappedPgQueryRefusal)).toBe('caller');
    const capturedPgQueryReport: SuspectedToolFailure = {
      toolName: 'dev:pg_query',
      errorCode: '42703',
      status: 'error',
      fieldPath: 'ORDER BY updated_at',
      message: 'Read-only work_items query used updated_at, but the live relation exposes updated_ts ' +
        '(and many other generated columns). Server returned knownColumns and no rows; no mutation occurred. ' +
        'Corrected query should use updated_ts.',
      reproduced: true,
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'Filtered read over known work_items columns succeeds with updated_ts.',
        actual: 'PostgreSQL rejected unknown column updated_at and named updated_ts.',
      },
    };
    expect(classifyToolError(
      capturedPgQueryReport.errorCode,
      capturedPgQueryReport.status,
      capturedPgQueryReport.message,
    )).toBe('caller');
    expect(normalizeSuspectedToolFailure(capturedPgQueryReport)).toMatchObject({
      class: 'caller',
      direct: false,
    });
    // A plain missing-column handler failure has no pg_query correction envelope
    // and must continue to reach the structural repair lane.
    expect(classifyToolError('handler_error', 'error', 'column "initiative" does not exist')).toBe('structural');
    expect(classifyToolError('42703', 'error', 'column "updated_at" does not exist')).toBe('structural');
  });

  it('does not mistake the timeoutSec argument name for a runtime timeout', () => {
    expect(
      classifyToolError(
        'invalid_args',
        'invalid_input',
        'Nested code:run rejected timeoutSec=60 because the live maximum is 45 seconds; use 45 or less.',
      ),
    ).toBe('caller');
    expect(
      classifyToolError(
        'invalid_input',
        'invalid-input',
        'invalid_args: bindings.values: Invalid input: expected record, received undefined; ' +
          'bindings: Unrecognized key: "issueId" — accepted fields include timeoutSec.',
      ),
    ).toBe('caller');
    expect(classifyToolError('handler_error', 'error', 'code:run exceeded timeout after 45 seconds')).toBe('transient');
  });

  it('classifies the captured whole-call-deadline summary as transient when capture omits call_timeout metadata', () => {
    const message =
      'did not complete within 8000ms of its whole-call deadline (5000ms query budget plus 3000ms setup allowance). ' +
      'Tenant checks, SQL execution, and result advisories share this deadline.';
    expect(classifyToolError(null, 'error', message)).toBe('transient');
    expect(normalizeSuspectedToolFailure({
      toolName: 'dev:pg_query',
      status: 'error',
      message,
      directEvidence: {
        kind: 'valid-input-reproduction',
        actual: 'handler_error call_timeout after the 8000ms deadline.',
        expected: 'Describe harness_shared.tool_invocations returns relation metadata within dev:pg_query\'s whole-call deadline.',
      },
    }).class).toBe('transient');
  });

  it('classifies a parent-signal abort as caller control flow, not a structural tool defect', () => {
    const message = 'tool "coord:declare-intent" was aborted by its parent signal after the handler returned';
    expect(classifyToolError('aborted', 'error', message)).toBe('caller');
    // Preserve the code-specific boundary: unrelated handler errors still fall through.
    expect(classifyToolError('handler_error', 'error', message)).toBe('structural');
  });

  it('classifies capability:git-evidence cancellation as caller control flow, not a structural tool defect', () => {
    const interrupted =
      'git_command_interrupted: git ls-tree -z 26dba0b0757c551cd1590b6abec54a9e94ebe6da -- ' +
      'packages/operator-ui/src/onboarding/product-tutorial.test.tsx was aborted before returning a result';
    expect(classifyToolError('handler_error', 'error', interrupted)).toBe('caller');
    expect(classifyToolError(null, 'error', JSON.stringify({
      ok: false,
      reason: 'git_command_interrupted',
      message: 'Git evidence request was aborted before repository validation',
    }))).toBe('caller');
    // Real Git failures without the cancellation reason remain on the structural lane.
    expect(classifyToolError('handler_error', 'error', 'git ls-tree failed: fatal: bad object'))
      .toBe('structural');
  });

  it('classifies the code:run typed-root shape diagnostic as caller misuse, not a tool defect', () => {
    expect(classifyToolError(
      'handler_error',
      'error',
      'Code-run script treated nested activity:recent typed output as an MCP content envelope and failed with structured_result_shape; the returned activity data is in the typed root.',
    )).toBe('caller');
    const paraphrasedDiagnostic =
      'A code:run script reading testing:runs assumed an MCP content/text envelope; testing:runs returned a typed structured root and the script failed before producing its distilled summary.';
    expect(classifyToolError(
      'structured_result_shape',
      'error',
      paraphrasedDiagnostic,
    )).toBe('caller');
    expect(classifyToolError(
      'handler_error',
      'error',
      paraphrasedDiagnostic,
    )).toBe('structural');
    expect(classifyToolError(
      'handler_error',
      'error',
      'structured_result_shape: tool returned an invalid structured result',
    )).toBe('structural');
  });

  it.each(['toon', 'csv', 'tsv'])('classifies JSON.parse of tagged %s MCP text as caller misuse', (format) => {
    const message =
      `The nested call returned text beginning \`format: ${format}\`; ` +
      'a script assumed content[0].text was JSON and JSON.parse threw SyntaxError, ' +
      'discarding the raw event-status payload.';

    expect(classifyToolError(null, 'parse-error', message)).toBe('caller');
    // A JSON-tagged response parse failure may indicate malformed tool output, so it remains structural.
    expect(classifyToolError(null, 'parse-error', message.replace(`format: ${format}`, 'format: json')))
      .toBe('structural');
    expect(classifyToolError(null, 'parse-error', 'JSON.parse failed before a tool response was decoded.'))
      .toBe('structural');
  });

  it('lets the primary error code outrank unrelated secondary failure text', () => {
    const mixedMessage =
      'The extraction script treated dev:session_detail as an MCP content envelope; ' +
      'code:run returned the typed root. A separate tools:invoke attempt was refused with ' +
      'superuser_native_session_verifier_unavailable.';

    expect(classifyToolError('structured_result_shape', 'error', mixedMessage)).toBe('caller');
    expect(classifyToolError(
      'superuser_native_session_verifier_unavailable',
      'error',
      'A separate script note mentions structured_result_shape typed-root caller misuse.',
    )).toBe('transient');
    expect(normalizeSuspectedToolFailure({
      toolName: 'code:run',
      errorCode: 'structured_result_shape',
      status: 'error',
      message: mixedMessage,
      reproduced: true,
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'The code:run result is the dev:session_detail typed root.',
        actual: 'The script attempted to read an MCP content/text envelope.',
      },
    }).class).toBe('caller');
  });

  it('keeps invalid MCP credentials caller-side but classifies native verifier unavailability as transient', () => {
    expect(classifyToolError('mcp_auth_failed', 'error', 'superuser_invalid_bearer')).toBe('caller');
    expect(classifyToolError('handler_error', 'error', 'superuser_invalid_bearer')).toBe('structural');
    expect(classifyToolError('mcp_auth_failed', 'error', 'superuser_native_session_verifier_unavailable')).toBe('transient');
    expect(classifyToolError('handler_error', 'error', 'superuser_native_session_verifier_unavailable')).toBe('transient');
    expect(
      classifyToolError(
        'superuser_native_session_verifier_unavailable',
        'request_rejected',
        'At 2026-10-08T13:52Z, two valid requests were rejected with superuser_native_session_verifier_unavailable.',
      ),
    ).toBe('transient');
  });

  it('classifies the intentional native-owner transport capability refusal as caller-side', () => {
    const code = 'native_tool_owner_unsupported_capability';
    expect(classifyToolError(code, 'error', code)).toBe('caller');
    // Some invocation rows omit error_code and retain only this exact refusal message.
    expect(classifyToolError(null, 'error', code)).toBe('caller');
    expect(classifyToolError(null, 'error', `${code}: unrelated detail`)).toBe('structural');
    // The message match is exact; similar handler prose remains a real failure.
    expect(classifyToolError('handler_error', 'error', `${code}: wrapped in unrelated handler prose`)).toBe('structural');
    expect(normalizeSuspectedToolFailure({
      toolName: 'mcp__papercusp_su__tools_find',
      errorCode: code,
      status: 'error',
      message: code,
    })).toMatchObject({ class: 'caller', direct: false });

    const wrappedNativeOwnerRefusal = {
      toolName: 'mcp__papercusp_su__tools_find',
      errorCode: '-32603',
      status: code,
      message: `Direct Papercusp MCP wrapper was refused with ${code} before target dispatch.`,
    };
    expect(classifyToolError(
      wrappedNativeOwnerRefusal.errorCode,
      wrappedNativeOwnerRefusal.status,
      wrappedNativeOwnerRefusal.message,
    )).toBe('caller');
    expect(normalizeSuspectedToolFailure(wrappedNativeOwnerRefusal)).toMatchObject({ class: 'caller' });
    expect(normalizeSuspectedToolFailure({
      toolName: 'coord:inbox',
      errorCode: null,
      status: 'error',
      message: code,
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it('classifies missing UI-client context as caller input, not a structural UI defect', () => {
    const missingRow = 'client_not_found: no ui_clients row for client_id="su-cli-owner". The tab may have closed or never registered.';
    const missingId = 'client_id_required: no client_id passed and ctx.uiClientId is unset.';
    expect(classifyToolError('client_not_found', 'error', missingRow)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', missingRow)).toBe('caller');
    expect(classifyToolError('client_id_required', 'error', missingId)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', missingId)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'ui:get_state',
      errorCode: 'client_not_found',
      status: 'error',
      message: missingRow,
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it.each([
    [
      'context_mismatch',
      'rejected',
      'Patch verification could not find the expected workspace-map heading and path lines in apps/operator/prompts/pot-instances/papercup-pot.su.md; no files were changed.',
    ],
    [
      'verification_failed',
      '',
      'A three-file resource-governor repair patch was rejected before writing because I matched a long project-doc-parts disposition line with abbreviated text. Corrected patch will anchor on the unique array terminator and use short exact hunks.',
    ],
    [
      'verification-failed',
      'patch-context-mismatch',
      'A one-file patch was rejected because one expected source line did not match exactly. The patch applied nothing. Re-read the exact line context and reformulate the single-file patch.',
    ],
  ])('classifies a rejected patch hunk as caller (%s)', (errorCode, status, message) => {
    expect(classifyToolError(errorCode, status, message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'apply_patch',
      errorCode,
      status,
      message,
      reproduced: true,
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it('keeps an unrelated verification failure structural', () => {
    expect(classifyToolError('verification-failed', 'error', 'tool failed while verifying its result')).toBe('structural');
  });

  it('classifies kernel identity outside-ceiling and stale-artifact refusals, including the persisted tools:find message, as caller', () => {
    const sessionsRefusal = 'Kernel preflight denied tool "sessions:ingest-gate-event": Identity capability (unresolved): outside-ceiling (sessions:ingest-gate-event)';
    const journalRefusal = 'Kernel preflight denied tool "journal:record-turn": Identity capability (unresolved): outside-ceiling (journal:record-turn)';
    const staleArtifactRefusal = 'Kernel preflight denied tool "tools:invoke": Identity capability (unresolved): stale-artifact (tools:invoke)';
    const persistedToolsFindRefusal = 'Kernel preflight denied tool "tools:find": Identity capability (unresolved): stale-artifact (tools:find)';
    expect(classifyToolError('authorization_denied', 'error', sessionsRefusal)).toBe('caller');
    expect(classifyToolError('authorization_denied', 'error', journalRefusal)).toBe('caller');
    expect(classifyToolError('authorization_denied', 'error', staleArtifactRefusal)).toBe('caller');
    expect(classifyToolError('authorization_denied', 'error', persistedToolsFindRefusal)).toBe('caller');
    expect(classifyToolError('authorization_denied', 'error', 'database constraint failed')).toBe('structural');
    expect(classifyToolError(
      'authorization_denied', 'error',
      'Kernel preflight denied tool "tools:invoke": Identity capability (unresolved): policy-unavailable (tools:invoke)',
    )).toBe('structural');
  });

  it('classifies fail-closed kernel authority-read failures as transient infrastructure', () => {
    const unavailable = [
      'Kernel preflight denied tool "locks:queue": current session authority could not be read; no effect authorized',
      'Kernel preflight denied tool "coord:whoami": session authority reader unavailable; no effect authorized',
      'Kernel preflight denied tool "coord:glance": identity policy evaluation unavailable; no effect authorized',
    ];

    for (const message of unavailable) {
      expect(classifyToolError('authorization_denied', 'error', message)).toBe('transient');
    }
    expect(classifyToolError(
      'authorization_denied', 'error',
      'Kernel preflight denied tool "tools:invoke": Identity capability (unresolved): policy-unavailable (tools:invoke)',
    )).toBe('structural');
  });

  it('classifies a nested tools:invoke invalid_input wrapper as caller, not structural', () => {
    // tools:invoke re-throws target refusals; the wrapper adds `invalid_input:`
    // while outer telemetry can record `handler_error`, so match this exact shape.
    expect(
      classifyToolError('handler_error', 'error', 'invalid_input: invalid_args: Unrecognized key: "workspace"'),
    ).toBe('caller');
    // Keep the prefix rule narrow: unrelated invalid_input messages remain structural.
    expect(classifyToolError('handler_error', 'error', 'invalid_input: database constraint failed')).toBe('structural');
  });

  it('classifies a nested tools:invoke role denial as caller, not a structural tool defect', () => {
    // The direct target error_code is role_not_allowed, but tools:invoke telemetry
    // records handler_error and preserves the target's message prefix.
    const refusal =
      'role_not_allowed: Role "judge" cannot call tool "sessions:search" (allowed roles: operator)';
    expect(classifyToolError('handler_error', 'error', refusal)).toBe('caller');
    expect(classifyToolError('role_not_allowed', 'error', 'judge is not on the target allowlist')).toBe('caller');
    // Keep the message match narrow: similar prose without the refusal code is not enough.
    expect(classifyToolError('handler_error', 'error', 'Role "judge" cannot call tool "sessions:search"')).toBe('structural');
  });

  it('classifies a nested loop:checkpoint merge-cap refusal as caller, not a structural defect', () => {
    // The checkpoint tool intentionally persists the narrative while refusing a row
    // merge that would evict carried checks. tools:invoke preserves that refusal in
    // its handler_error text, so both the code and serialized response shape belong
    // on the caller path.
    const refusal = JSON.stringify({
      ok: false,
      error: 'checkpoint_merge_would_evict_rows',
      retryable: true,
      narrativePersisted: true,
      checksDropped: ['an existing carried check'],
    });
    expect(classifyToolError('checkpoint_merge_would_evict_rows', 'error', refusal)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', refusal)).toBe('caller');
    // Generic checkpoint handler failures remain eligible for structural diagnosis.
    expect(classifyToolError('handler_error', 'error', 'checkpoint database write failed')).toBe('structural');
  });

  it('classifies the code:run dynamic-import sandbox refusal as caller even when reproduced', () => {
    const message =
      'code:run rejects dynamic import/require of repo modules and node builtins; use the exposed tools whitelist.';
    expect(classifyToolError('dynamic_import_unsupported', 'failed', message)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'code:run',
      errorCode: 'dynamic_import_unsupported',
      status: 'failed',
      message,
      reproduced: true,
    })).toMatchObject({ class: 'caller', direct: false });
  });

  it('classifies the nested tools:invoke checkpoint replacement safety refusal as caller', () => {
    // Live rows keep the nested { ok:false, error, errorCode } refusal as JSON
    // in error_message, while the wrapper records error_code='handler_error'.
    const nestedRefusal =
      '{"ok":false,"error":"checkpoint_replace_would_drop_rows","errorCode":"checkpoint_replace_would_drop_rows","retryable":true}';
    expect(classifyToolError('handler_error', 'error', nestedRefusal)).toBe('caller');
    expect(classifyToolError('checkpoint_replace_would_drop_rows', 'error', null)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', '{"ok":false,"error":"unrelated_refusal"}')).toBe('structural');
  });

  it('classifies the nested tools:invoke compaction flush gate refusal as caller', () => {
    // Compaction intentionally refuses until held work is checkpointed. The
    // nested handler_error wrapper must not send this expected precondition to
    // the structural auto-implement lane.
    const nestedRefusal =
      '{"ok":false,"requested":false,"error":"flush-required","tripwires":[{"kind":"missing-checkpoint","subject":"WI-10004595"}]}';
    expect(classifyToolError('handler_error', 'error', nestedRefusal)).toBe('caller');
    expect(classifyToolError('flush-required', 'error', null)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', '{"ok":false,"error":"flush-required-ish"}')).toBe('structural');
  });

  it('classifies the nested tools:invoke missing scratch evidence-class refusal as caller', () => {
    // capability:read returns this expected selection refusal as a JSON `reason`;
    // tools:invoke preserves the payload but the outer invocation row is handler_error.
    const nestedRefusal =
      '{"ok":false,"reason":"evidence_class_not_found","message":"scratch reference has no work-item evidence."}';
    expect(classifyToolError('handler_error', 'error', nestedRefusal)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', '{"ok":false,"reason":"unrelated_refusal"}'))
      .toBe('structural');
  });

  it('classifies nested capability:read mixed-window refusals as caller input', () => {
    const nestedRefusal = JSON.stringify({
      ok: false,
      reason: 'mixed_window_modes',
      message: 'raw text windows cannot be combined with byte_offset/byte_limit; byte windows already return exact bytes.',
    });

    expect(classifyToolError('mixed_window_modes', 'handler_error', null)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', nestedRefusal)).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'tools:invoke',
      errorCode: 'handler_error',
      status: 'error',
      message: nestedRefusal,
    }).class).toBe('caller');
    expect(classifyToolError(
      'handler_error',
      'error',
      JSON.stringify({ ok: false, reason: 'unrelated_refusal' }),
    )).toBe('structural');
  });

  it('classifies events:status mutually exclusive selectors as caller input', () => {
    const message =
      'events:status — await_id and event are mutually exclusive; use await_id to inspect one registration or event to inspect one key.';
    expect(classifyToolError('handler_error', 'error', message)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', JSON.stringify({ error: message }))).toBe('caller');
    expect(normalizeSuspectedToolFailure({
      toolName: 'events:status',
      errorCode: 'handler_error',
      status: 'error',
      message,
    })).toMatchObject({ class: 'caller', direct: false });
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
  });

  it('classifies nested tenant-scope reader refusals as caller', () => {
    // dev:pg_query returns these deliberate scope guards as structured refusals.
    // tools:invoke wraps them in handler_error, so the serialized reason must
    // keep them out of the structural auto-implement lane too.
    for (const reason of ['tenant_scope_required', 'positive_control_tenant_scope_required']) {
      expect(classifyToolError(reason, 'error', 'tenant-scoped read required')).toBe('caller');
      expect(classifyToolError(
        'handler_error',
        'error',
        JSON.stringify({ error: 'tenant-scoped read required', reason }),
      )).toBe('caller');
    }
    expect(classifyToolError(
      'handler_error',
      'error',
      JSON.stringify({ error: 'unrelated refusal', reason: 'workspace_scope_required' }),
    )).toBe('structural');
  });

  it('classifies an expected missing rubric reference as caller input, not a tool bug', () => {
    expect(classifyToolError('rubric-not-found', 'error', 'rubric not found')).toBe('caller');
    // The classification is code-specific; an unrelated tool failure with the
    // same prose must still reach the structural lane.
    expect(classifyToolError('handler_error', 'error', 'rubric not found')).toBe('structural');
  });

  it('classifies an incomplete acceptance BAR vetting refusal as caller input', () => {
    const message =
      'acceptance BAR contract is not ready for vetting — 7 of 7 BAR(s) blocking, 0 clean: R-1: bar_snapshot_role_invalid';
    expect(classifyToolError('handler_error', 'error', message)).toBe('caller');
    // The nested tools:invoke JSON wrapper must preserve the same caller class.
    expect(classifyToolError('handler_error', 'error', JSON.stringify({ ok: false, error: message })))
      .toBe('caller');
    // Keep the rule specific to the deliberate readiness refusal.
    expect(classifyToolError('handler_error', 'error', 'acceptance BAR contract could not be loaded from the database'))
      .toBe('structural');
  });

  it('classifies a missing acceptance BAR amendment approval as caller control flow', () => {
    const message =
      'acceptance_bar_approval_required: use thread-post:<id> from an authenticated reviewer post containing the preview approval JSON';
    expect(classifyToolError('handler_error', 'error', message)).toBe('caller');
    expect(classifyToolError('handler_error', 'error', JSON.stringify({
      ok: false,
      code: 'acceptance_bar_approval_required',
      error: message,
    }))).toBe('caller');
    // A failure loading approval data remains structural.
    expect(classifyToolError('handler_error', 'error', 'acceptance BAR approval could not be loaded from the database'))
      .toBe('structural');
  });

  it('classifies a missing sandbox desktop lease as caller input, not a structural tool bug', () => {
    expect(
      classifyToolError(
        'handler_error',
        'error',
        'capability:computer — no sandbox desktop is leased to this agent. A desktop must be provisioned first',
      ),
    ).toBe('caller');
  });

  it('classifies the intentional coord:ask owner-UI-only denial as caller without broadening generic unauthorized', () => {
    expect(
      classifyToolError(
        'unauthorized',
        'error',
        'coord:ask is owner-UI-only; agents must use coord:send or coord:message-agent.',
      ),
    ).toBe('caller');
    expect(
      classifyToolError(
        'unauthorized',
        'error',
        'built-in tool "memory:search" requires a workspace-scoped call — this session has no workspace transaction. Scope the session to a workspace',
      ),
    ).toBe('structural');
  });

  it('high-volume NON-structural buckets never leak into the auto-implement (structural) lane', () => {
    // The "floods a lane" failure mode: a timeout / provider-429 / PG-exhaustion /
    // caller-arg shape mis-filed as a deterministic tool bug.
    const mustNotBeStructural = TOOL_ERROR_CORPUS.filter((r) => r.expectedClass !== 'structural');
    for (const r of mustNotBeStructural) {
      expect(classifyToolError(r.errorCode, r.status, r.message)).not.toBe('structural');
    }
  });
});

describe('classifier rule table integrity', () => {
  it('every rule.messagePattern compiles as a JS RegExp (the cheap half of the dual-engine guarantee)', () => {
    for (const rule of TOOL_ERROR_RULES) {
      if (!rule.messagePattern) continue;
      expect(() => new RegExp(rule.messagePattern as string, 'i')).not.toThrow();
    }
  });

  it('patterns use only dual-engine constructs (no JS-only \\s \\d \\b or lookarounds)', () => {
    // POSIX ERE (Postgres ~*) has none of these; using them would let the two
    // engines disagree — the very drift this module prevents.
    for (const rule of TOOL_ERROR_RULES) {
      if (!rule.messagePattern) continue;
      expect(rule.messagePattern).not.toMatch(/\\[sdwbSDWB]|\(\?[=!<]/);
    }
  });

  it('no rule targets the structural fallback (structural is ELSE, never a WHEN)', () => {
    for (const rule of TOOL_ERROR_RULES) {
      expect(rule.class).not.toBe('structural');
    }
  });
});

describe('toolErrorFingerprint (P-012) — mirrors the SQL skeleton', () => {
  it('hashes the full digit-stripped, punctuation-collapsed message skeleton', () => {
    const fingerprint = toolErrorFingerprint('invalid_args: note: Too big: expected string to have <=400 characters');
    expect(fingerprint).toMatch(/^md5-[a-f0-9]{32}$/);
    expect(toolErrorFingerprint('column "initiative" does not exist')).toMatch(/^md5-[a-f0-9]{32}$/);
    expect(toolErrorFingerprint('invalid_args: note: Too big: expected string to have <=400 characters'))
      .toBe(fingerprint);
  });

  it('returns null when the message has no alpha content', () => {
    expect(toolErrorFingerprint('')).toBeNull();
    expect(toolErrorFingerprint(null)).toBeNull();
    expect(toolErrorFingerprint('429 — 500 (#3)')).toBeNull();
  });

  it('separates two DISTINCT caller modes under one tool (the P-012 collision the structural-only fp left)', () => {
    const a = toolErrorFingerprint('invalid_args: note: Too big: expected string to have <=400 characters');
    const b = toolErrorFingerprint('invalid_args: status: Invalid option: expected one of "draft"|"ready"');
    expect(a).not.toBe(b);
    // …and the keys they produce differ, so they stop masking each other:
    expect(toolErrorSignalKey('plans:new', 'caller', a)).not.toBe(toolErrorSignalKey('plans:new', 'caller', b));
  });

  it('separates failures with a shared first-six-token boilerplate prefix (EI-25714783883986261)', () => {
    const first = 'P006 Cargo CI-binding test file lock acquire returned HTTP502 readECONNRESET/forwardingResult outcome_unknown. ' +
      'No edit attempted. Reconcile authoritative lock for crates/papercup-core/tests/android_uniffi_abi_guard.rs in mobile coordination_domain before writing or retrying.';
    const second = 'P006 Cargo CI-binding test file lock acquire returned HTTP502 readECONNRESET/forwardingResult outcome_unknown. ' +
      'No edit attempted. Reconcile authoritative lock for packages/operator-core/lib/agent-tools/improvements/capture.test.ts in papercusp coordination before writing or retrying.';
    const oldPrefix = (message: string) => message.toLowerCase()
      .replace(/[0-9]+/g, '').replace(/[^a-z]+/g, ' ').trim().split(' ').slice(0, 6).join('-');

    expect(oldPrefix(first)).toBe('p-cargo-ci-binding-test-file');
    expect(oldPrefix(second)).toBe(oldPrefix(first));
    expect(toolErrorFingerprint(first)).not.toBe(toolErrorFingerprint(second));
    expect(toolErrorSignalKey('locks:acquire', 'transient', toolErrorFingerprint(first)))
      .not.toBe(toolErrorSignalKey('locks:acquire', 'transient', toolErrorFingerprint(second)));
  });
});

describe('toolErrorSignalKey (P-012) — fingerprint by class', () => {
  it('appends the fingerprint for the fingerprinted classes', () => {
    expect(toolErrorSignalKey('memory:search', 'structural', 'cannot-read-properties-of-undefined'))
      .toBe('memory:search:structural:cannot-read-properties-of-undefined');
    expect(toolErrorSignalKey('plans:new', 'caller', 'invalid-args-note-too-big-expected'))
      .toBe('plans:new:caller:invalid-args-note-too-big-expected');
    expect(toolErrorSignalKey('slow:tool', 'transient', 'too-many-clients-already'))
      .toBe('slow:tool:transient:too-many-clients-already');
  });

  it('keeps rate-limit COARSE (one capacity concern — never fingerprinted)', () => {
    expect(FINGERPRINTED_TOOL_ERROR_CLASSES.has('rate-limit')).toBe(false);
    expect(toolErrorSignalKey('memory:search', 'rate-limit', 'openai-embed-failed-error-message-rate'))
      .toBe('memory:search:rate-limit');
  });

  it('falls back to the bare key when no fingerprint is derivable (legacy / pre-fingerprint ticks)', () => {
    expect(toolErrorSignalKey('docs:get', 'structural', null)).toBe('docs:get:structural');
    expect(toolErrorSignalKey('coord:thread', 'caller', undefined)).toBe('coord:thread:caller');
  });
});

describe('normalizeSuspectedToolFailure — correlated probation identity (P-013)', () => {
  it('shares the watchdog key while retaining schema/field/runtime dimensions in the reporter fingerprint', () => {
    const a = normalizeSuspectedToolFailure({
      toolName: 'coord:send',
      errorCode: 'invalid_args',
      status: 'error',
      message: 'invalid_args: body must be an array',
      schemaRevision: '42',
      fieldPath: 'body',
      runtimeVersion: 'codex-1.2.3',
    });
    const b = normalizeSuspectedToolFailure({
      toolName: 'coord:send',
      errorCode: 'invalid_args',
      status: 'error',
      message: 'invalid_args: body must be an array',
      schemaRevision: '43',
      fieldPath: 'body',
      runtimeVersion: 'codex-1.2.4',
    });
    expect(a.watchdogKey).toBe(b.watchdogKey);
    expect(a.watchdogKey).toMatch(/^repeated-tool-error:coord:send:caller:/);
    expect(a.correlationFingerprint).not.toBe(b.correlationFingerprint);
    expect(a.direct).toBe(false);
  });

  it.each(['reproduced', 'clearServerMismatch', 'hardInternal'] as const)(
    'bypasses probation only on explicit %s evidence',
    (field) => {
      const normalized = normalizeSuspectedToolFailure({
        toolName: 'work_items:complete',
        message: 'terminal writer rejected a valid state',
        [field]: true,
      });
      expect(normalized.direct).toBe(true);
    },
  );

  it.each(['reproduced', 'clearServerMismatch', 'hardInternal'] as const)(
    'keeps a caller-input failure in probation when only legacy %s is supplied (EI-22142216567407511)',
    (field) => {
      const normalized = normalizeSuspectedToolFailure({
        toolName: 'sessions:read',
        errorCode: 'invalid_args',
        message: 'invalid_args: tail too big — 20 over the 200 limit; use 200',
        [field]: true,
      });
      expect(normalized.class).toBe('caller');
      expect(normalized.direct).toBe(false);
    },
  );

  it('lets inspectable expected/actual evidence override a caller classification', () => {
    const normalized = normalizeSuspectedToolFailure({
      toolName: 'sessions:read',
      errorCode: 'invalid_args',
      message: 'invalid_args: documented tail=220 rejected as greater than 200',
      directEvidence: {
        kind: 'server-contract-mismatch',
        expected: 'the active schema documents tail <= 220',
        actual: 'the server rejected tail=220 against a hidden maximum of 200',
      },
    });
    expect(normalized.class).toBe('caller');
    expect(normalized.direct).toBe(true);
  });

  it('keeps code:run typed-root envelope reads in caller probation despite direct evidence', () => {
    const normalized = normalizeSuspectedToolFailure({
      toolName: 'code:run → fleet:assignments',
      errorCode: 'structured_result_shape',
      status: 'error',
      message:
        'A code:run batch failed before returning its summary: fleet:assignments returned a typed structured root, ' +
        'but the code-run path expected an MCP content/text envelope and reported `Use direct typed fields`.',
      directEvidence: {
        kind: 'server-contract-mismatch',
        expected: 'A code:run script can inspect the typed structured result returned by fleet:assignments.',
        actual: 'code:run returned structured_result_shape after a content/text envelope read.',
      },
    });

    expect(normalized.class).toBe('caller');
    expect(normalized.direct).toBe(false);
  });

  it('keeps the code:run typed-root caller diagnostic in probation when errorCode is omitted', () => {
    const message =
      'Code-run script treated nested fleet:assignments typed output as an MCP content/text envelope and failed with ' +
      'structured_result_shape; the nested result was a typed root.';
    expect(classifyToolError(null, 'error', message)).toBe('caller');

    const normalized = normalizeSuspectedToolFailure({
      toolName: 'code:run → fleet:assignments',
      status: 'error',
      message,
      directEvidence: {
        kind: 'server-contract-mismatch',
        expected: 'code:run exposes the nested fleet:assignments typed result directly',
        actual: 'the script tried to read an MCP content/text envelope from the typed root',
      },
    });

    expect(normalized.class).toBe('caller');
    expect(normalized.direct).toBe(false);
  });

  it('routes code:run compile_error to caller while retaining explicit defect evidence override', () => {
    const compileFailure = {
      toolName: 'code:run',
      errorCode: 'compile_error',
      status: 'compile_error',
      message: 'compile_error: Invalid regular expression flags while compiling the submitted script',
    };
    const callerReport = normalizeSuspectedToolFailure(compileFailure);
    expect(callerReport.class).toBe('caller');
    expect(callerReport.direct).toBe(false);

    const verifiedMismatch = normalizeSuspectedToolFailure({
      ...compileFailure,
      directEvidence: {
        kind: 'valid-input-reproduction',
        expected: 'valid JavaScript parses and reaches execution',
        actual: 'the unchanged valid script fails compilation before dispatch',
      },
    });
    expect(verifiedMismatch.class).toBe('caller');
    expect(verifiedMismatch.direct).toBe(true);
  });
});

describe('SQL generators are driven by the table (structural check; real-PG parity in the integration test)', () => {
  // A debug `sql` tag that renders the composed fragment to a string so we can
  // assert STRUCTURE without a database. Like postgres.js, a nested fragment
  // (already a rendered string) splices inline; arrays render as {a,b}; other
  // scalars splice inline too (we assert structure, not bind-param escaping).
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]): string =>
    strings.reduce((acc, s, i) => {
      if (i === 0) return s;
      const v = values[i - 1];
      const rendered = Array.isArray(v) ? `{${v.join(',')}}` : String(v);
      return acc + rendered + s;
    }, '');

  it('toolErrorClassSqlCase renders a CASE over every rule, ELSE structural', () => {
    const sqlCase = toolErrorClassSqlCase(fakeSql);
    expect(sqlCase).toMatch(/^CASE /);
    expect(sqlCase).toMatch(/ELSE structural END$/);
    // every non-structural class is a THEN target
    expect(sqlCase).toContain('THEN transient');
    expect(sqlCase).toContain('THEN caller');
    expect(sqlCase).toContain('THEN rate-limit');
    // the load-bearing patterns made it into the CASE
    expect(sqlCase).toContain('error_message ~*');
    expect(sqlCase).toContain('error_code = ANY');
    expect(sqlCase).toContain('exceeded timeout');
    expect(sqlCase).toContain('openai_embed_failed_429');
  });

  it('emits the specific structured-result code before the verifier message branch', () => {
    const sqlCase = toolErrorClassSqlCase(fakeSql);
    const structuredResultCode = sqlCase.indexOf('error_code = ANY({structured_result_shape}');
    const verifierMessage = sqlCase.indexOf(
      'error_message ~* (^|[^A-Za-z0-9_])superuser_native_session_verifier_unavailable',
    );

    expect(structuredResultCode).toBeGreaterThanOrEqual(0);
    expect(verifierMessage).toBeGreaterThan(structuredResultCode);
  });

  it('toolErrorFingerprintSqlCase fingerprints exactly the FINGERPRINTED classes', () => {
    const fpCase = toolErrorFingerprintSqlCase(fakeSql);
    expect(fpCase).toContain('class = ANY');
    expect(fpCase).toContain('structural');
    expect(fpCase).toContain('caller');
    expect(fpCase).toContain('transient');
    expect(fpCase).not.toContain('rate-limit'); // coarse — excluded
    expect(fpCase).toContain('regexp_replace'); // the skeleton arithmetic is present
  });
});

describe('known-external tool-failure classes — deny the direct bypass for an already-adjudicated class (WI-2143658)', () => {
  // Every string below is REAL reporter prose, taken from the measured
  // population of filed rows (2026-09-03). That matters: the defect being
  // guarded is that these all describe ONE failure while producing different
  // dedup identities, so hand-invented prose would not exercise it.
  const REAL_RACE_REPORTS = [
    'Failed to create unified exec process: No such file or directory (os error 2)',
    'CreateProcess rejected: Failed to create unified exec process: No such file or directory (os error 2) on a second independent loop:checkpoint invocation',
    'exec_command intermittently fails to create the unified shell',
    'unified exec could not create process',
    'unified exec process rejected with no such file',
    'CreateProcess message rejected: failed to create unified exec process',
  ];

  it.each(REAL_RACE_REPORTS)('recognises the documented Codex race: %s', (message) => {
    const matched = matchKnownExternalToolFailure({ toolName: 'exec_command', message });
    expect(matched?.id).toBe('codex-exec-command-parallel-launch-race');
  });

  it.each(REAL_RACE_REPORTS)('denies the direct bypass even when the reporter attests reproduction: %s', (message) => {
    const normalized = normalizeSuspectedToolFailure({
      toolName: 'exec_command',
      errorCode: 'CreateProcess',
      message,
      // The honest attestation that was minting claimable duplicates.
      reproduced: true,
    });
    expect(normalized.direct).toBe(false);
    expect(normalized.knownExternal?.docSlug).toBe('agent-insights/codex-exec-command-parallel-launch-race');
  });

  it.each(['clearServerMismatch', 'hardInternal'] as const)(
    'denies the bypass for the other direct-evidence flag %s too (all three routes, not just reproduced)',
    (field) => {
      const normalized = normalizeSuspectedToolFailure({
        toolName: 'exec_command',
        message: 'Failed to create unified exec process: No such file or directory (os error 2)',
        [field]: true,
      });
      expect(normalized.direct).toBe(false);
    },
  );

  // ── CONTROLS. A false match hides a real defect inside a row triage has been
  // told to ignore, so the over-match guards matter more than the matches.

  it.each([
    'CreateProcess failed because the supplied workdir does not exist',
    'caller misspelled the workspace path as papercuspai-workspace',
    'CreateProcess rejected nonexistent workdir /nonexistent/workspace/path',
    'exec_command rejected the working directory path typo before command execution',
  ])('does NOT match the separate mistyped-workdir class, which has a different fix: %s', (message) => {
    expect(matchKnownExternalToolFailure({ toolName: 'exec_command', message })).toBeNull();
    const normalized = normalizeSuspectedToolFailure({ toolName: 'exec_command', message, reproduced: true });
    // Unchanged behaviour: a real, attested, fixable report stays claimable.
    expect(normalized.direct).toBe(true);
    expect(normalized.knownExternal).toBeNull();
  });

  it('prefers a MISS when a race report also mentions a workdir — the exclude is deliberately conservative', () => {
    // Documented intent, not an accident: this falls back to today's behaviour
    // rather than risk suppressing a report that may be the workdir class.
    const message = 'Failed to create unified exec process, though the workdir was valid';
    expect(matchKnownExternalToolFailure({ toolName: 'exec_command', message })).toBeNull();
  });

  it('is gated on the tool name — identical prose about a PAPERCUSP tool is never suppressed', () => {
    const message = 'Failed to create unified exec process: No such file or directory (os error 2)';
    expect(matchKnownExternalToolFailure({ toolName: 'capability:bash', message })).toBeNull();
    const normalized = normalizeSuspectedToolFailure({ toolName: 'capability:bash', message, reproduced: true });
    expect(normalized.direct).toBe(true);
  });

  it('leaves an unrelated tool failure completely untouched', () => {
    const normalized = normalizeSuspectedToolFailure({
      toolName: 'work_items:complete',
      message: 'terminal writer rejected a valid state',
      reproduced: true,
    });
    expect(normalized.direct).toBe(true);
    expect(normalized.knownExternal).toBeNull();
  });

  it('does not disturb the dedup identity it sits beside (watchdogKey/fingerprint unchanged)', () => {
    const message = 'Failed to create unified exec process: No such file or directory (os error 2)';
    const normalized = normalizeSuspectedToolFailure({ toolName: 'exec_command', errorCode: 'CreateProcess', message });
    expect(normalized.watchdogKey).toBe(
      `repeated-tool-error:${toolErrorSignalKey('exec_command', normalized.class, normalized.messageFingerprint)}`,
    );
  });

  it('fails OPEN on empty input rather than throwing inside a filing', () => {
    expect(matchKnownExternalToolFailure({ toolName: '', message: '' })).toBeNull();
    expect(matchKnownExternalToolFailure({ toolName: 'exec_command', message: '' })).toBeNull();
  });

  it('every registered pattern compiles (this module\'s dual-engine convention)', () => {
    expect(KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES.length).toBeGreaterThan(0);
    for (const klass of KNOWN_EXTERNAL_TOOL_FAILURE_CLASSES) {
      expect(() => new RegExp(klass.match, 'i')).not.toThrow();
      if (klass.exclude) expect(() => new RegExp(klass.exclude as string, 'i')).not.toThrow();
      expect(klass.toolNames.every((name) => name === name.toLowerCase())).toBe(true);
      expect(klass.docSlug).toMatch(/^agent-insights\//);
    }
  });
});

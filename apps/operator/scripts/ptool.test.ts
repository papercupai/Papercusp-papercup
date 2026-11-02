import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  callToolWithPressureRetry,
  callToolWithReplayRecovery,
  buildCallToolParams,
  requireServingGeneration,
  refreshToolCallAfterStaleContract,
  canDispatchWithoutCatalog,
  buildMcpUrl,
  isForeignNativeSessionRejection,
  shouldRetryWithoutNativeSession,
  classifyConnectFailure,
  connectWithLocalRetry,
  connectWithOperatorCandidates,
  connectWithTokenFallback,
  isModuleResolutionFailure,
  listToolsWithTokenFallback,
  listToolsWithNativeSessionFallback,
  codeRunRequestHash,
  listToolsWithLocalRetry,
  escapeJsonStringControls,
  formatJsonInputError,
  importSdkModuleWithInstallAwareness,
  importPtoolSdkModule,
  PTOOL_SDK_MODULE_LOADERS,
  preparePtoolConnectionModules,
  parseArgs,
  parseJsonInput,
  ptoolConnectionRetryOptions,
  resolveContextTier,
  resolvePayloadHarnessScope,
  resolveHarnessScope,
  mergeConvenienceArgs,
  resolveWorkspaceScope,
  resolvePtoolOperatorBase,
  resolvePtoolOperatorCandidates,
  resolvePtoolInvocationCandidates,
  resolveLauncherManagedStagingDirectCandidate,
  catalogSupportsBuildSelector,
  hasCurrentPtoolServingGeneration,
  canDispatchOnFallbackOperator,
  resolvePtoolRecoveryTool,
  isReadOnlyPtoolRecoveryRequest,
  shouldAttemptManagedReadRecovery,
  shouldAttemptManagedCatalogRecovery,
  canDispatchPtoolOnFallback,
  shouldRediscoverOperatorUrl,
  resolveTokenPath,
  resolveTokenPaths,
  dispatchScriptedToolWithoutCatalog,
  dispatchScriptedToolWithoutCatalogWithTokenFallback,
  formatToolCallFailure,
  formatToolCatalogBypass,
  formatToolCatalogFailure,
  isSdkBootstrapInstallWait,
  buildMcpCallRecoveryInvocation,
  runMcpCallRecovery,
  isLoopPressureShed,
  isRecoverableAuthorityDenial,
  isInvalidSuperuserBearerFailure,
  isValidCodeRunReplayProof,
  isTransportFailure,
  printResult,
  stdoutDeliveryError,
  PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS,
  PTOOL_BACKUP_RESTORE_TIMEOUT_MS,
  PTOOL_CALL_TOOL_TIMEOUT_MS,
  PTOOL_CHECKPOINT_RUN_TIMEOUT_MS,
  PTOOL_CONNECT_TIMEOUT_MS,
  PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS,
  PTOOL_PINNED_LOCAL_CONNECT_MAX_ATTEMPTS,
  PTOOL_PINNED_LOCAL_CONNECT_TOTAL_TIMEOUT_MS,
  PTOOL_COORD_ORIENT_TIMEOUT_MS,
  PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS,
  PTOOL_EVENTS_AWAIT_TIMEOUT_MS,
  PTOOL_FOREGROUND_TOOL_TIMEOUT_MS,
  PTOOL_GIT_EVIDENCE_TIMEOUT_MS,
  PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS,
  PTOOL_PG_HOT_QUERIES_TIMEOUT_MS,
  PTOOL_AGENT_LAUNCH_TIMEOUT_MS,
  PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
  PTOOL_PLANS_AUDIT_TIMEOUT_MS,
  PTOOL_PLANS_EVALUATE_SPEC_TEST_ADEQUACY_TIMEOUT_MS,
  PTOOL_PLANS_GET_TIMEOUT_MS,
  PTOOL_PLANS_NEW_TIMEOUT_MS,
  PTOOL_PLANS_START_TIMEOUT_MS,
  PTOOL_PLAN_STATUS_TIMEOUT_MS,
  PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS,
  PTOOL_REPAIR_QUEUE_PREVIEW_TIMEOUT_MS,
  PTOOL_SESSION_REQUEST_COMPACTION_TIMEOUT_MS,
  PTOOL_SERVICE_HEALTH_TIMEOUT_MS,
  PTOOL_WORK_ITEMS_GET_TIMEOUT_MS,
  PTOOL_SCORECARDS_GET_TIMEOUT_MS,
  PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS,
  PTOOL_WORK_ITEMS_CLAIM_TIMEOUT_MS,
  PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS,
  PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS,
  PTOOL_POST_CONNECT_RETRIES,
  PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS,
  PTOOL_LIST_TOOLS_TIMEOUT_MS,
  PTOOL_RETRY_JITTER_MS,
  PTOOL_SCORECARD_EMIT_TIMEOUT_MS,
  PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS,
  PTOOL_TOOL_NOT_OK_EXIT,
  PTOOL_TRUNCATED_RESULT_MESSAGE,
  ptoolConnectAttemptTimeoutMs,
  resultToText,
  retryWaitMsWithJitter,
  retryCodeRunWithProof,
  sanitizeJsonText,
  scratchUriToPath,
  shouldPrintRawResult,
  timeoutForTool,
  toolNotOkReason,
  unwrapOutputEnvelope,
  withPtoolConnectionPhaseTrace,
  createPtoolHttpTraceFetch,
} from './ptool.mjs';
import {
  HANDSHAKE_UPSTREAM_TIMEOUT_MS,
  MAX_HANDSHAKE_TIMEOUT_RETRIES,
} from '../lib/mcp-proxy/proxy';
import {
  AGENT_LAUNCH_CLIENT_TIMEOUT_MS,
  AGENT_LAUNCH_HANDLER_TIMEOUT_SEC,
} from '../../../packages/operator-core/lib/agent-kickoff/launch-budgets.mjs';

describe('ptool post-connect phase diagnostics', () => {
  const trace = { traceId: 'bounded-test-trace', toolName: 'code:run', operatorConnectSequence: 1 };
  const route = { routeClass: 'local-direct', host: '127.0.0.1', port: 3271 };

  it.each(['tools-list', 'tools-call', 'result-output'])(
    'identifies a stalled %s phase before an outer caller can kill the process', async (stage) => {
      vi.useFakeTimers();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      let settle!: (value: unknown) => void;
      const result = { privatePayload: 'never emit this content' };
      const operation = vi.fn(() => new Promise(resolve => { settle = resolve; }));
      try {
        const pending = withPtoolConnectionPhaseTrace(trace, stage, route, operation);
        await vi.advanceTimersByTimeAsync(PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS);
        expect(operation).toHaveBeenCalledTimes(1);
        const event = JSON.parse(String(log.mock.calls[0][0]).replace('ptool: connection trace ', ''));
        expect(event).toMatchObject({ ...trace, event: 'phase-pending', stage, route,
          elapsedMs: PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS });
        // The diagnostic observes the unresolved call; it neither times it out
        // nor retries it. Its original result and private content stay intact.
        settle(result);
        await expect(pending).resolves.toBe(result);
        expect(log).toHaveBeenCalledTimes(2);
        expect(String(log.mock.calls[1][0])).toContain('"event":"phase-complete"');
        expect(JSON.stringify(log.mock.calls)).not.toContain(result.privatePayload);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        log.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('records a phase that exceeds the diagnostic threshold even when its timer callback was delayed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let now = 10;
    const result = { ok: true };
    try {
      await expect(withPtoolConnectionPhaseTrace(
        trace,
        'mcp-initialize',
        route,
        () => {
          now += PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS + 25;
          return Promise.resolve(result);
        },
        { now: () => now },
      )).resolves.toBe(result);

      const events = log.mock.calls.map(([line]) =>
        JSON.parse(String(line).replace('ptool: connection trace ', '')),
      );
      expect(events).toMatchObject([
        { ...trace, event: 'phase-pending', stage: 'mcp-initialize', route,
          elapsedMs: PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS + 25 },
        { ...trace, event: 'phase-complete', stage: 'mcp-initialize', route,
          elapsedMs: PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS + 25 },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('preserves the original rejection and clears its pending timer', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    const failure = new Error('private failure details');
    try {
      const pending = withPtoolConnectionPhaseTrace(trace, 'tools-call', route,
        () => new Promise((_, fail) => { reject = fail; }));
      const rejected = expect(pending).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS);
      reject(failure);
      await rejected;
      expect(String(log.mock.calls[1][0])).toContain('"event":"phase-attempt-failed"');
      expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps fast phases quiet and cancels their diagnostic timer', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(withPtoolConnectionPhaseTrace(trace, 'tools-list', route, async () => 7)).resolves.toBe(7);
      await vi.advanceTimersByTimeAsync(PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS);
      expect(log).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('reports the catalog wrapper outcome when discovery fails=%s', async (failed) => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { privateClient: 'private-client' };
    const tools = [{ name: 'private-tool' }];
    const failure = Object.assign(new Error('private-catalog-error'), { code: -32001 });
    let resolve!: (value: typeof tools) => void;
    let reject!: (error: Error) => void;
    const listing = new Promise<typeof tools>((ok, fail) => { resolve = ok; reject = fail; });
    const list = vi.fn(() => listing);
    const reconnect = vi.fn();
    try {
      const pending = withPtoolConnectionPhaseTrace(trace, 'tools-list', route, () =>
        listToolsWithNativeSessionFallback(client, {
          discoverTools: (target: unknown) => listToolsWithTokenFallback(
            target, ['private-token-path'], 'private-token-path', reconnect, list,
          ),
        }));
      await vi.advanceTimersByTimeAsync(PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS);
      if (failed) reject(failure); else resolve(tools);
      const result = await pending;
      expect(result.client).toBe(client);
      expect(result.tools).toBe(failed ? null : tools);
      expect(result.error).toBe(failed ? failure : null);
      expect(list).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line).replace('ptool: connection trace ', '')));
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ event: failed ? 'phase-attempt-failed' : 'phase-complete',
        stage: 'tools-list', elapsedMs: PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS });
      if (failed) expect(events[1].failureKind).toBe('transport');
      else expect(events[1]).not.toHaveProperty('failureKind');
      expect(JSON.stringify(events)).not.toMatch(/private-/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('ptool HTTP request correlation', () => {
  const trace = { traceId: 'connection-test', operatorConnectSequence: 2 };

  it('sends distinct server trace IDs across discovery retries while preserving the request and response', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = new Response('private-response', { status: 401 });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const send = createPtoolHttpTraceFetch(trace, { fetchImpl });
    const signal = new AbortController().signal;
    const url = 'http://127.0.0.1:3271/api/mcp?native_session=private-session';
    const init = { method: 'POST', signal, body: 'private-arguments',
      headers: { Authorization: 'Bearer private-token', 'x-papercusp-mcp-trace-id': 'old-request' } };
    try {
      await expect(send(url, init)).resolves.toBe(response);
      await expect(send(url, init)).resolves.toBe(response);
      const ids = fetchImpl.mock.calls.map(([input, options]) => {
        expect(input).toBe(url);
        expect(options).toMatchObject({ method: 'POST', signal, body: init.body });
        const headers = new Headers(options?.headers);
        expect(headers.get('authorization')).toBe(init.headers.Authorization);
        return headers.get('x-papercusp-mcp-trace-id');
      });
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line).replace('ptool: connection trace ', '')));
      const starts = events.filter(event => event.event === 'http-request-start');
      const responses = events.filter(event => event.event === 'phase-complete');
      expect(starts.map(event => event.requestTraceId)).toEqual(ids);
      expect(responses.map(event => event.requestTraceId)).toEqual(ids);
      for (const event of [...starts, ...responses]) expect(event).toMatchObject({ ...trace,
        route: { host: '127.0.0.1', port: 3271 } });
      expect(responses).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'http-response-headers', httpStatus: 401 }),
      ]));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-|old-request/);
      expect(init.headers['x-papercusp-mcp-trace-id']).toBe('old-request');
    } finally { log.mockRestore(); }
  });

  it('correlates a stalled request and preserves Request headers and the original rejection', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('private-error');
    let reject!: (error: Error) => void;
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>((_, fail) => { reject = fail; }));
    const send = createPtoolHttpTraceFetch(trace, { fetchImpl });
    try {
      const request = new Request('http://127.0.0.1:3271/api/mcp', {
        headers: { Authorization: 'Bearer private-token' },
      });
      const pending = send(request);
      const rejected = expect(pending).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(PTOOL_CONNECT_DIAGNOSTIC_PENDING_MS);
      const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
      expect(headers.get('authorization')).toBe('Bearer private-token');
      const pendingEvents = log.mock.calls.map(([line]) => JSON.parse(String(line).replace('ptool: connection trace ', '')));
      expect(pendingEvents).toHaveLength(2);
      expect(pendingEvents[1]).toMatchObject({ event: 'phase-pending', stage: 'http-response-headers',
        requestTraceId: headers.get('x-papercusp-mcp-trace-id') });
      reject(failure);
      await rejected;
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line).replace('ptool: connection trace ', '')));
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({ event: 'phase-attempt-failed', stage: 'http-response-headers',
        requestTraceId: headers.get('x-papercusp-mcp-trace-id') });
      expect(vi.getTimerCount()).toBe(0);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-/);
    } finally { log.mockRestore(); vi.useRealTimers(); }
  });

  it('records a fast transport failure class without exposing its error text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('fetch failed: private socket details');
    const send = createPtoolHttpTraceFetch(trace, { fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(failure) });
    try {
      await expect(send('http://127.0.0.1:3271/api/mcp')).rejects.toBe(failure);
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line).replace('ptool: connection trace ', '')));
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ event: 'phase-attempt-failed', stage: 'http-response-headers',
        failureKind: 'transport', requestTraceId: events[0].requestTraceId });
      expect(JSON.stringify(events)).not.toContain(failure.message);
    } finally { log.mockRestore(); }
  });
});

describe('ptool bootstrap dependencies', () => {
  it('keeps the repository ptool source directly executable (EI-22055633156739019)', () => {
    if (process.platform === 'win32') return;

    const mode = statSync(new URL('./ptool.mjs', import.meta.url)).mode;
    expect(mode & 0o111).toBe(0o111);
  });

  it('declares the MCP SDK directly in the operator workspace', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );

    expect(packageJson.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
  });

  it('keeps the standalone shim free of the install-safe reader guard', () => {
    const installer = readFileSync(
      new URL('./install-standalone-mcp.sh', import.meta.url),
      'utf8',
    );
    const shimStart = installer.indexOf('PTOOL_LAUNCHER=');
    const shimEnd = installer.indexOf('\n# 5. Verify the endpoint', shimStart);
    const ptoolInstallBlock = installer.slice(shimStart, shimEnd);

    expect(shimStart).toBeGreaterThan(-1);
    expect(shimEnd).toBeGreaterThan(shimStart);
    expect(ptoolInstallBlock).toContain('exec node "${PTOOL_LAUNCHER}" "\\$@"');
    expect(ptoolInstallBlock).not.toContain('--exec-under-lock');
    expect(ptoolInstallBlock).not.toContain('npm-install-safe.mjs');
  });

  it('atomically replaces standalone launchers to prevent ETXTBSY races (EI-21566808495780594)', () => {
    const installer = readFileSync(
      new URL('./install-standalone-mcp.sh', import.meta.url),
      'utf8',
    );
    const helperStart = installer.indexOf('install_executable_atomic()');
    const wrapperStart = installer.indexOf('# 4g. Install the `psu` command', helperStart);
    const verifyStart = installer.indexOf('\n# 5. Verify the endpoint', wrapperStart);
    const helper = installer.slice(helperStart, wrapperStart);
    const wrappers = installer.slice(wrapperStart, verifyStart);

    expect(helperStart).toBeGreaterThan(-1);
    expect(wrapperStart).toBeGreaterThan(helperStart);
    expect(verifyStart).toBeGreaterThan(wrapperStart);
    expect(helper).toContain('temporary="$(mktemp "${destination}.tmp.XXXXXX")"');
    expect(helper).toContain('if ! cat > "$temporary"; then');
    expect(helper).toContain('if ! mv -f -- "$temporary" "$destination"; then');
    expect(wrappers.match(/install_executable_atomic "\$PSU_PATH" 755/g)?.length).toBe(1);
    expect(wrappers.match(/install_executable_atomic "\$PTOOL_PATH" 755/g)?.length).toBe(1);
    expect(wrappers).not.toMatch(/cat\s*>\s*"\$(?:PSU|PTOOL)_PATH"/);
  });
});

describe('ptool JSON argument flag guidance', () => {
  it('shows valid empty-object and stdin forms when the JSON value is missing', () => {
    const jsonMessage = [
      "--json requires a value;",
      "use --json '{}' for an empty arguments object,",
      'or --json - to read JSON from stdin',
    ].join(' ');
    const argsMessage = [
      "--args requires a value;",
      "use --args '{}' for an empty arguments object,",
      'or --args - to read JSON from stdin',
    ].join(' ');

    expect(() => parseArgs(['coord:whoami', '--json'])).toThrow(jsonMessage);
    expect(() => parseArgs(['coord:whoami', '--json', '--workspace=papercusp-workspace']))
      .toThrow(jsonMessage);
    expect(() => parseArgs(['coord:whoami', '--args'])).toThrow(argsMessage);
    expect(parseArgs(['coord:whoami', '--json', '{}']).json).toBe('{}');
    expect(parseArgs(['coord:whoami', '--json', '-']).json).toBe('-');
  });
});

describe('ptool MCP identity binding', () => {
  it('accepts an explicit idempotency receipt in both CLI flag forms', () => {
    expect(parseArgs(['work_items:checkpoint', '--idempotency-key', 'receipt-1']).idempotencyKey)
      .toBe('receipt-1');
    expect(parseArgs(['events:cancel', '--idempotency-key=receipt-2']).idempotencyKey)
      .toBe('receipt-2');
  });

  it('accepts an explicit operator URL in both CLI flag forms', () => {
    const operatorUrl = 'http://127.0.0.1:3170';
    expect(parseArgs(['rubrics:get', '--url', operatorUrl]).url).toBe(operatorUrl);
    expect(parseArgs(['rubrics:get', `--url=${operatorUrl}`]).url).toBe(operatorUrl);
  });

  it('supports the explicit unscoped --all-workspaces transport escape', () => {
    expect(parseArgs(['blueprint:publish', '--all-workspaces'])).toMatchObject({
      tool: 'blueprint:publish',
      allWorkspaces: true,
      workspace: null,
    });
    expect(resolveWorkspaceScope({
      allWorkspaces: true,
      env: { PAPERCUSP_WORKSPACE: 'papercusp-workspace' },
    })).toBe('*');
    expect(buildMcpUrl('http://127.0.0.1:3170', { workspace: '*' }).searchParams.get('workspace')).toBe('*');
  });

  it('rejects combining --all-workspaces with an explicit workspace', () => {
    expect(() => parseArgs([
      'blueprint:publish',
      '--all-workspaces',
      '--workspace=papercusp-workspace',
    ])).toThrow('--all-workspaces cannot be combined with --workspace');
    expect(() => resolveWorkspaceScope({ allWorkspaces: true, workspace: 'papercusp-workspace' }))
      .toThrow('--all-workspaces cannot be combined with --workspace');
  });

  it('carries the live PAPERCUSP_SID as the MCP client query parameter', () => {
    const url = buildMcpUrl('http://127.0.0.1:3170', {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      client: 'su-live-owner-123',
    });

    expect(url.searchParams.get('client')).toBe('su-live-owner-123');
    expect(url.searchParams.get('workspace')).toBe('papercusp-workspace');
    expect(url.searchParams.get('harness')).toBe('papercusp');
    expect(url.searchParams.get('ctx_tier')).toBe('trimmed');
  });

  it('accepts an explicit MCP endpoint URL without duplicating the path', () => {
    const url = buildMcpUrl('http://127.0.0.1:3170/api/mcp?client=explicit-client', {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
    });

    expect(url.pathname).toBe('/api/mcp');
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(url.searchParams.get('client')).toBe('explicit-client');
    expect(url.searchParams.get('workspace')).toBe('papercusp-workspace');
    expect(url.searchParams.get('harness')).toBe('papercusp');
  });

  it('binds each Codex incarnation of the same owner across operator fallback routes', () => {
    const client = 'su-retained-owner';
    for (const nativeSession of ['native-predecessor', 'native-successor']) {
      for (const host of ['http://127.0.0.1:9071', 'http://127.0.0.1:3170']) {
        const url = buildMcpUrl(host, {
          client,
          env: { PAPERCUSP_SID: client, CODEX_SESSION_ID: nativeSession },
        });
        expect(url.searchParams.get('client')).toBe(client);
        expect(url.searchParams.get('native_session')).toBe(nativeSession);
      }
    }
  });

  it('prefers the launcher-bound native session over a stale Codex environment id', () => {
    const client = 'su-retained-owner';
    const url = buildMcpUrl('http://127.0.0.1:3170', {
      client,
      env: {
        PAPERCUSP_SID: client,
        PAPERCUSP_NATIVE_SESSION_ID: 'native-bound-successor',
        CODEX_SESSION_ID: 'native-stale-predecessor',
      },
    });

    expect(url.searchParams.get('native_session')).toBe('native-bound-successor');
  });

  it('retries only a foreign inherited Codex claim without changing the owner', () => {
    const client = 'su-cold-codex';
    const env = { PAPERCUSP_SID: client, CODEX_SESSION_ID: 'inherited-native-id' };
    const url = buildMcpUrl('http://127.0.0.1:3170', { client, env });
    const refusal = {
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: superuser_foreign_native_session' }],
    };

    expect(url.searchParams.get('native_session')).toBe('inherited-native-id');
    expect(isForeignNativeSessionRejection(refusal)).toBe(true);
    expect(shouldRetryWithoutNativeSession(refusal, { client, env })).toBe(true);
    expect(shouldRetryWithoutNativeSession({
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: authorization_denied' }],
    }, { client, env })).toBe(false);
    expect(shouldRetryWithoutNativeSession(refusal, {
      client,
      explicitNativeSession: false,
      env: { ...env, PAPERCUSP_NATIVE_SESSION_ID: 'launcher-bound-id' },
    })).toBe(false);
    expect(shouldRetryWithoutNativeSession(refusal, {
      client,
      explicitNativeSession: true,
      env,
    })).toBe(false);
    expect(buildMcpUrl('http://127.0.0.1:3170', {
      client, env, nativeSessionOverride: null,
    }).searchParams.has('native_session')).toBe(false);
  });

  it('preserves an explicitly selected native session and avoids binding another owner', () => {
    const env = { PAPERCUSP_SID: 'su-current', CODEX_SESSION_ID: 'native-current' };
    expect(buildMcpUrl('http://127.0.0.1:3170/api/mcp?native_session=native-explicit', {
      client: 'su-current', env,
    }).searchParams.get('native_session')).toBe('native-explicit');
    expect(buildMcpUrl('http://127.0.0.1:3170', {
      client: 'su-other', env,
    }).searchParams.has('native_session')).toBe(false);
    expect(buildMcpUrl('http://127.0.0.1:3170', {
      client: 'su-current', env: { PAPERCUSP_SID: 'su-current' },
    }).searchParams.has('native_session')).toBe(false);
  });

  it('defaults direct sessions to trimmed payloads and allows an explicit full escape hatch', () => {
    expect(resolveContextTier({ env: { NODE_ENV: 'test' } })).toBe('trimmed');
    expect(resolveContextTier({ env: { NODE_ENV: 'test', PAPERCUSP_CONTEXT_TIER: ' full ' } })).toBe('full');
    expect(buildMcpUrl('http://127.0.0.1:3170', { contextTier: 'full' }).searchParams.get('ctx_tier'))
      .toBe('full');
  });

  it('inherits the active harness from the su environment, with an explicit flag taking precedence', () => {
    expect(resolveHarnessScope({ env: { PAPERCUSP_HARNESS_SLUG: ' papercusp ' } })).toBe('papercusp');
    expect(resolveHarnessScope({
      harness: 'cli-harness',
      env: { PAPERCUSP_HARNESS_SLUG: 'papercusp' },
    })).toBe('cli-harness');
    expect(resolveHarnessScope({ env: { NODE_ENV: 'test' } })).toBeNull();
  });

  it('derives a direct payload harness before the inherited environment scope', () => {
    const payload = { harness: ' papercusp ' };
    const env = { PAPERCUSP_HARNESS_SLUG: 'sb-devboard-hive' };

    expect(resolvePayloadHarnessScope(payload, { toolName: 'coord:declare-intent' })).toBe('papercusp');
    expect(resolveHarnessScope({ payload, toolName: 'coord:declare-intent', env })).toBe('papercusp');
    expect(resolveHarnessScope({
      harness: 'cli-harness',
      payload,
      toolName: 'coord:declare-intent',
      env,
    })).toBe('cli-harness');
  });

  it('derives a tools:invoke target harness from its nested args', () => {
    const payload = {
      name: 'coord:declare-intent',
      args: { harness: 'papercusp' },
    };
    const env = { PAPERCUSP_HARNESS_SLUG: 'sb-devboard-hive' };

    expect(resolvePayloadHarnessScope(payload, { toolName: 'tools:invoke' })).toBe('papercusp');
    expect(resolveHarnessScope({ payload, toolName: 'tools:invoke', env })).toBe('papercusp');
  });

  it('injects ambient harness only on variants that accept the scope argument', () => {
    const scope = { workspace: null, harness: 'papercusp' };
    const flattenedReviewSchema = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['claim', 'claim-next', 'resubmit'] },
        id: { type: 'string' },
        harness: { type: 'string' },
      },
      required: ['mode'],
      additionalProperties: false,
    };

    expect(mergeConvenienceArgs(
      { mode: 'resubmit', id: 'WI-7' },
      scope,
      flattenedReviewSchema,
      { toolName: 'improvements:agent-review' },
    )).toEqual({ mode: 'resubmit', id: 'WI-7' });
    expect(mergeConvenienceArgs(
      { mode: 'claim', id: 'WI-8' },
      scope,
      flattenedReviewSchema,
      { toolName: 'improvements:agent-review' },
    )).toEqual({ mode: 'claim', id: 'WI-8', harness: 'papercusp' });
    expect(mergeConvenienceArgs(
      { mode: 'claim-next' },
      scope,
      flattenedReviewSchema,
      { toolName: 'improvements:agent-review' },
    )).toEqual({ mode: 'claim-next', harness: 'papercusp' });

    const flattenedRehomeSchema = {
      type: 'object',
      properties: { op: { type: 'string', enum: ['classify', 'move'] }, id: { type: 'string' }, harness: { type: 'string' } },
      required: ['op', 'id'],
      additionalProperties: false,
    };
    expect(mergeConvenienceArgs(
      { op: 'classify', id: 'WI-9' },
      scope,
      flattenedRehomeSchema,
      { toolName: 'work_items:rehome' },
    )).toEqual({ op: 'classify', id: 'WI-9' });

    const flattenedWorkScopeSchema = {
      type: 'object',
      properties: { op: { type: 'string', enum: ['get', 'check', 'set', 'clear'] }, harness: { type: 'string' } },
      required: ['op'],
      additionalProperties: false,
    };
    expect(mergeConvenienceArgs(
      { op: 'get' },
      scope,
      flattenedWorkScopeSchema,
      { toolName: 'workspace:work_scope' },
    )).toEqual({ op: 'get' });
    expect(mergeConvenienceArgs(
      { op: 'check' },
      scope,
      flattenedWorkScopeSchema,
      { toolName: 'workspace:work_scope' },
    )).toEqual({ op: 'check', harness: 'papercusp' });
  });

  it('rejects unsupported tool-specific flags instead of silently dropping them', () => {
    expect(() => parseArgs([
      'fleet:assignments',
      '--json',
      '-',
      '--workspace=papercusp-workspace',
      '--harness=papercusp',
      '--fleet=goal-drain-work-on-everything-070565',
    ])).toThrow(
      'unknown flag --fleet=goal-drain-work-on-everything-070565; tool-specific arguments must be supplied in the JSON payload via --json, --json-file, or --json -',
    );
    expect(() => parseArgs(['fleet:assignments', '--fleet', 'goal-drain-work-on-everything-070565']))
      .toThrow('unknown flag --fleet;');
  });

  it('keeps the quoting-safe JSON-body scope form supported', () => {
    expect(parseArgs([
      'fleet:assignments',
      '--json',
      '-',
      '--workspace=papercusp-workspace',
      '--harness=papercusp',
    ])).toMatchObject({
      tool: 'fleet:assignments',
      json: '-',
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
    });
  });
});

describe('ptool operator routing', () => {
  it('uses the resolved host base when no listener port is exported', () => {
    expect(resolvePtoolOperatorBase({
      // Source-root markers prove which checkout launched ptool, but do not
      // identify a port. serve.ts writes this base after the actual bind.
      PAPERCUSP_REPO_ROOT: '/workspace/papercusp',
      PAPERCUSP_INTEGRATION_ROOT: '/workspace/papercusp',
      PAPERCUSP_OPERATOR_BASE: 'http://127.0.0.1:3170/api/mcp',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
    })).toBe('http://127.0.0.1:3170');
  });

  it('routes a staging invocation to the current host instead of inherited green', () => {
    expect(resolvePtoolOperatorBase({
      PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
    })).toBe('http://127.0.0.1:3170');
  });

  it('routes local staging pins through the same-vintage proxy and falls back to the pinned operator on upstream failure', async () => {
    expect(resolvePtoolOperatorBase({
      PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
      PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
    })).toBe('http://127.0.0.1:9171');

    const pin = 'http://localhost:3170/api/mcp?superuser=1';
    const candidates = resolvePtoolOperatorCandidates(
      { PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171' },
      pin,
    );
    expect(candidates).toEqual([
      'http://127.0.0.1:9171/api/mcp?superuser=1',
      pin,
    ]);

    const upstreamFailure = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_upstream_error","forwardingResult":"outcome_unknown"}',
    ), { code: 502 });
    const client = { close: vi.fn() };
    const connectOnce = vi.fn()
      .mockRejectedValueOnce(upstreamFailure)
      .mockResolvedValueOnce(client);

    await expect(connectWithOperatorCandidates(connectOnce, candidates, {}, {
      maxAttempts: 1,
      primaryAttemptOptions: { maxAttempts: 1 },
      sleep: async () => {},
    })).resolves.toEqual({ client, operatorUrl: pin });
    expect(connectOnce.mock.calls.map(([url]) => url)).toEqual(candidates);
  });

  it('keeps direct staging pins when staging proxy routing is disabled', () => {
    expect(resolvePtoolOperatorCandidates(
      { PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171', PAPERCUSP_MCP_STAGING_PROXY: '0' },
      'http://localhost:3170',
    )).toEqual(['http://localhost:3170']);
  });

  it('keeps the resilient proxy when it fronts the current host', () => {
    expect(resolvePtoolOperatorBase({
      PAPERCUSP_HONO_PORT: '3070',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3070',
    })).toBe('http://127.0.0.1:9071');
  });

  it('uses the configured same-host proxy for a launcher-managed URL whose host-port hint was stripped', () => {
    const managed = {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9271',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3271',
    };
    expect(resolvePtoolOperatorBase(managed)).toBe('http://127.0.0.1:9271');
    expect(resolvePtoolOperatorCandidates(managed)).toEqual(['http://127.0.0.1:9271']);
  });

  it('adds the configured staging proxy as a managed named-read recovery candidate when the target hint is absent', () => {
    const managed = {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
      PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
    };
    expect(resolvePtoolOperatorCandidates(managed)).toEqual([
      'http://127.0.0.1:9071',
      'http://127.0.0.1:9171',
    ]);
    expect(resolvePtoolInvocationCandidates({ tool: 'work_items:get' }, managed)).toEqual([
      'http://127.0.0.1:9071',
      'http://127.0.0.1:9171',
    ]);
    // The fallback candidate is usable only for catalog-confirmed reads. A
    // write remains blocked when the initial catalog is legacy or the route
    // changes underneath it.
    expect(canDispatchOnFallbackOperator({ annotations: { readOnlyHint: true } }, true)).toBe(true);
    expect(canDispatchOnFallbackOperator({ annotations: { readOnlyHint: false } }, true)).toBe(false);
  });

  it('derives direct staging recovery only for an unpinned managed legacy-proxy route', () => {
    const managed = {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
      PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
    };

    expect(resolveLauncherManagedStagingDirectCandidate('http://127.0.0.1:9071', managed))
      .toBe('http://127.0.0.1:3170');
    expect(resolveLauncherManagedStagingDirectCandidate(
      'http://127.0.0.1:9071', managed, 'http://127.0.0.1:3170',
    )).toBeNull();
    expect(resolveLauncherManagedStagingDirectCandidate('http://127.0.0.1:9071', {
      ...managed,
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'caller',
    })).toBeNull();
    expect(resolveLauncherManagedStagingDirectCandidate('http://127.0.0.1:9071', {
      ...managed,
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3070',
    })).toBeNull();
  });

  it('uses psu-launcher’s default staging proxy when the child omits its port override', () => {
    expect(resolvePtoolOperatorCandidates({
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    })).toEqual([
      'http://127.0.0.1:9071',
      'http://127.0.0.1:9171',
    ]);
  });

  it('uses the nested tools:invoke target when deciding whether managed recovery may move a read', () => {
    const catalog = [
      { name: 'tools:invoke', annotations: { readOnlyHint: false } },
      { name: 'work_items:get', annotations: { readOnlyHint: true } },
      { name: 'work_items:complete', annotations: { readOnlyHint: false } },
    ];

    expect(resolvePtoolRecoveryTool('tools:invoke', {
      name: 'work_items:get',
      args: { id: 'EI-1' },
    }, catalog)?.name).toBe('work_items:get');
    expect(resolvePtoolRecoveryTool('tools:invoke', {
      name: 'work_items:complete',
      args: { id: 'EI-1' },
    }, catalog)?.annotations?.readOnlyHint).toBe(false);
    expect(resolvePtoolRecoveryTool('tools:invoke', {}, catalog)?.name).toBe('tools:invoke');
    expect(resolvePtoolRecoveryTool('work_items:get', {}, catalog)?.name).toBe('work_items:get');
    expect(isReadOnlyPtoolRecoveryRequest('tools:invoke', { name: 'work_items:get' }, catalog)).toBe(true);
    expect(isReadOnlyPtoolRecoveryRequest('tools:invoke', { name: 'work_items:complete' }, catalog)).toBe(false);
    expect(isReadOnlyPtoolRecoveryRequest('tools:invoke', {}, catalog)).toBe(false);
    expect(canDispatchPtoolOnFallback(
      'tools:invoke', { name: 'work_items:get' }, catalog[0], catalog, true,
    )).toBe(true);
    expect(canDispatchPtoolOnFallback(
      'tools:invoke', { name: 'work_items:complete' }, catalog[0], catalog, true,
    )).toBe(false);
  });

  it('requires the selected wrapper schema to accept build routing and preserves its selector and generation', () => {
    const callArgs = {
      name: 'work_items:get',
      args: { id: 'EI-1' },
      build: 'staging',
    };
    const generation = 'serving-generation-v1:staging';
    const target = {
      name: 'work_items:get',
      annotations: { readOnlyHint: true },
      _meta: { 'papercusp/servingGeneration': generation },
    };
    const legacyCatalog = [
      {
        name: 'tools:invoke',
        inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } } },
        annotations: { readOnlyHint: false },
        _meta: { 'papercusp/servingGeneration': generation },
      },
      target,
    ];

    expect(catalogSupportsBuildSelector('tools:invoke', callArgs, legacyCatalog)).toBe(false);
    expect(isReadOnlyPtoolRecoveryRequest('tools:invoke', callArgs, legacyCatalog)).toBe(false);
    expect(canDispatchPtoolOnFallback(
      'tools:invoke', callArgs, legacyCatalog[0], legacyCatalog, true,
    )).toBe(false);
    // Direct catalog validation must not bypass the outer schema contract.
    expect(canDispatchPtoolOnFallback(
      'tools:invoke', callArgs, legacyCatalog[0], legacyCatalog, true, true,
    )).toBe(false);
    expect(catalogSupportsBuildSelector('tools:invoke', { name: 'work_items:get', args: {} }, legacyCatalog)).toBe(true);

    const currentInvoke = {
      ...legacyCatalog[0],
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { type: 'object' },
          build: { type: 'string', enum: ['main', 'staging'] },
        },
      },
    };
    const currentCatalog = [currentInvoke, target];
    expect(catalogSupportsBuildSelector('tools:invoke', callArgs, currentCatalog)).toBe(true);
    expect(isReadOnlyPtoolRecoveryRequest('tools:invoke', callArgs, currentCatalog)).toBe(true);
    expect(canDispatchPtoolOnFallback(
      'tools:invoke', callArgs, currentCatalog[0], currentCatalog, true,
    )).toBe(true);
    const params = buildCallToolParams('tools:invoke', callArgs, {
      outputSchema: { type: 'object' },
      idempotencyKey: 'ptool-build-selector-test',
      servingGeneration: generation,
    });
    expect(params.arguments).toEqual({
      name: 'work_items:get',
      args: JSON.stringify({ id: 'EI-1' }),
      build: 'staging',
    });
    expect(params._meta).toMatchObject({
      structured: true,
      idempotencyKey: 'ptool-build-selector-test',
      'papercusp/servingGeneration': generation,
    });

    const mainOnlyCatalog = [{
      ...currentCatalog[0],
      inputSchema: {
        ...currentInvoke.inputSchema,
        properties: {
          ...currentInvoke.inputSchema.properties,
          build: { type: 'string', enum: ['main'] },
        },
      },
    }, target];
    expect(catalogSupportsBuildSelector('tools:invoke', callArgs, mainOnlyCatalog)).toBe(false);
  });

  it('validates the exact direct or nested target generation before managed recovery', () => {
    const generation = 'serving-generation-v1:current';
    const catalog = [
      { name: 'tools:invoke', _meta: { 'papercusp/servingGeneration': generation } },
      { name: 'coord:declare-intent', _meta: { 'papercusp/servingGeneration': generation } },
      { name: 'work_items:complete', _meta: { 'papercusp/servingGeneration': '  ' } },
    ];

    expect(hasCurrentPtoolServingGeneration('coord:declare-intent', {}, catalog)).toBe(true);
    expect(hasCurrentPtoolServingGeneration(
      'tools:invoke', { name: 'coord:declare-intent', args: {} }, catalog,
    )).toBe(true);
    expect(hasCurrentPtoolServingGeneration(
      'tools:invoke', { name: 'missing:tool', args: {} }, catalog,
    )).toBe(false);
    expect(hasCurrentPtoolServingGeneration('work_items:complete', {}, catalog)).toBe(false);
  });

  it('allows a mutating fallback only after direct managed catalog validation', () => {
    const writeTool = { name: 'coord:declare-intent', annotations: { readOnlyHint: false } };
    const catalog = [writeTool];

    expect(canDispatchPtoolOnFallback(
      'coord:declare-intent', {}, writeTool, catalog, true,
    )).toBe(false);
    expect(canDispatchPtoolOnFallback(
      'coord:declare-intent', {}, writeTool, catalog, true, true,
    )).toBe(true);
  });

  it('tries the current managed candidate when the legacy catalog mislabels a read', () => {
    expect(shouldAttemptManagedReadRecovery({
      toolName: 'loop:status',
      tool: { name: 'loop:status', annotations: { readOnlyHint: false } },
      initialGeneration: undefined,
      recoveryIndex: 1,
      operatorUrl: 'http://127.0.0.1:9071',
      operatorCandidates: ['http://127.0.0.1:9071', 'http://127.0.0.1:9171'],
    })).toBe(true);
    expect(shouldAttemptManagedReadRecovery({
      toolName: 'loop:status',
      tool: { name: 'loop:status', annotations: { readOnlyHint: false } },
      initialGeneration: 'serving-generation-v1:current',
      recoveryIndex: 1,
      operatorUrl: 'http://127.0.0.1:9071',
      operatorCandidates: ['http://127.0.0.1:9071', 'http://127.0.0.1:9171'],
    })).toBe(false);
    expect(shouldAttemptManagedReadRecovery({
      toolName: 'loop:status',
      tool: null,
      recoveryIndex: 1,
      operatorUrl: 'http://127.0.0.1:9071',
      operatorCandidates: ['http://127.0.0.1:9071', 'http://127.0.0.1:9171'],
    })).toBe(false);
  });

  it('attempts direct catalog recovery only when the initial named target lacks a generation', () => {
    const options = {
      toolName: 'coord:declare-intent',
      tool: { name: 'coord:declare-intent', annotations: { readOnlyHint: false } },
      recoveryIndex: 1,
      operatorUrl: 'http://127.0.0.1:9071',
      operatorCandidates: ['http://127.0.0.1:9071', 'http://127.0.0.1:3170'],
    };

    expect(shouldAttemptManagedCatalogRecovery(options)).toBe(true);
    expect(shouldAttemptManagedCatalogRecovery({
      ...options,
      initialGeneration: 'serving-generation-v1:current',
    })).toBe(false);
    expect(shouldAttemptManagedCatalogRecovery({ ...options, toolName: 'tools:find' })).toBe(false);
    expect(shouldAttemptManagedCatalogRecovery({ ...options, tool: null })).toBe(false);
  });

  it('does not infer a staging recovery route when the launcher supplied a target hint', () => {
    expect(resolvePtoolOperatorCandidates({
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
      PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3070',
    })).toEqual(['http://127.0.0.1:3070']);
  });

  it('routes an explicit local :3271 pin through the same-vintage :9271 proxy', () => {
    const env = {
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9271',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3271',
    };
    expect(resolvePtoolOperatorCandidates(env, 'http://127.0.0.1:3271')).toEqual(['http://127.0.0.1:9271']);
    expect(ptoolConnectionRetryOptions({ url: 'http://127.0.0.1:3271' }, env)).toEqual({
      maxAttempts: 1,
    });
  });

  it.each(['0', '65536', 'not-a-port'])('ignores an undialable managed proxy target %s', target => {
    expect(resolvePtoolOperatorBase({
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9271',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: target,
    })).toBe('http://127.0.0.1:9071');
  });

  it('keeps a bare operator URL pinned when another host proxy is configured', () => {
    expect(resolvePtoolOperatorBase({
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9271',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3271',
    })).toBe('http://127.0.0.1:9071');
  });

  it('falls back from a stale self port to the canonical operator', () => {
    expect(resolvePtoolOperatorCandidates({
      PAPERCUSP_HONO_PORT: '3271',
      PAPERCUSP_OPERATOR_URL: 'http://localhost:3271',
    })).toEqual([
      'http://127.0.0.1:3271',
      'http://127.0.0.1:3070',
    ]);
  });

  it('keeps implicit fallback candidates available for named calls, while explicit URLs stay pinned', () => {
    const env = {
      PAPERCUSP_HONO_PORT: '3271',
      PAPERCUSP_OPERATOR_URL: 'http://localhost:3271',
    };
    expect(resolvePtoolInvocationCandidates({ tool: 'plans:get-spec-evidence' }, env))
      .toEqual(['http://127.0.0.1:3271', 'http://127.0.0.1:3070']);
    expect(resolvePtoolInvocationCandidates({ list: true }, env))
      .toEqual(['http://127.0.0.1:3271', 'http://127.0.0.1:3070']);
    expect(resolvePtoolInvocationCandidates({ tool: 'plans:get-spec-evidence', url: 'http://127.0.0.1:3170' }, env))
      .toEqual(['http://127.0.0.1:3170']);
    expect(canDispatchOnFallbackOperator({ annotations: { readOnlyHint: true } }, true)).toBe(true);
    expect(canDispatchOnFallbackOperator({ annotations: { readOnlyHint: false } }, true)).toBe(false);
    expect(canDispatchOnFallbackOperator({}, true)).toBe(false);
    expect(canDispatchOnFallbackOperator({ annotations: { readOnlyHint: true } }, false)).toBe(true);
  });

  it('does not add a fallback for an explicit URL or the proxy-backed canonical host', () => {
    expect(resolvePtoolOperatorCandidates({ PAPERCUSP_HONO_PORT: '3271' }, 'http://127.0.0.1:32951'))
      .toEqual(['http://127.0.0.1:32951']);
    expect(resolvePtoolOperatorCandidates({
      PAPERCUSP_HONO_PORT: '3070',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3070',
    })).toEqual(['http://127.0.0.1:9071']);
  });

  it('rediscovers a launcher-managed inherited URL after a wake-respawn', () => {
    expect(shouldRediscoverOperatorUrl({}, {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:24689',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    }, 'http://127.0.0.1:24689')).toBe(true);
    expect(shouldRediscoverOperatorUrl({ tool: 'work_items:get' }, {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:24689',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    }, 'http://127.0.0.1:24689')).toBe(true);
  });

  it('keeps a launcher-managed proxy on its selected route instead of rebasing to another operator.json port', async () => {
    const selected = 'http://127.0.0.1:9171';
    const env = {
      PAPERCUSP_OPERATOR_URL: selected,
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    };
    const discover = vi.fn(() => 'http://127.0.0.1:16964');
    const rediscover = shouldRediscoverOperatorUrl({}, env, selected) ? discover : null;
    const client = { close: vi.fn() };
    const refused = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const connectOnce = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce(client);

    const result = await connectWithLocalRetry(connectOnce, selected, {}, {
      maxAttempts: 2,
      totalTimeoutMs: 0,
      retryDelayMs: 0,
      retryJitterMs: 0,
      rand: () => 0,
      sleep: async () => {},
      rediscover,
    });

    expect(discover).not.toHaveBeenCalled();
    expect(result).toBe(client);
    expect(connectOnce.mock.calls.map(([url]) => url)).toEqual([selected, selected]);
  });

  it('keeps a bare inherited env URL pinned when no launcher marker is present', () => {
    expect(shouldRediscoverOperatorUrl({}, {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:24689',
    }, 'http://127.0.0.1:24689')).toBe(false);
  });

  it('keeps an explicit --url pin authoritative even with a launcher marker', () => {
    expect(shouldRediscoverOperatorUrl({ url: 'http://127.0.0.1:3170' }, {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:24689',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    }, 'http://127.0.0.1:3170')).toBe(false);
  });

  it('keeps explicit and bare local URL pins in place with a bounded recovery budget', () => {
    const localPinRetryOptions = {
      maxAttempts: PTOOL_PINNED_LOCAL_CONNECT_MAX_ATTEMPTS,
      totalTimeoutMs: PTOOL_PINNED_LOCAL_CONNECT_TOTAL_TIMEOUT_MS,
    };
    expect(ptoolConnectionRetryOptions({ url: 'http://127.0.0.1:32951' }, {}))
      .toEqual(localPinRetryOptions);
    expect(ptoolConnectionRetryOptions({}, {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:32951',
    })).toEqual(localPinRetryOptions);
    expect(ptoolConnectionRetryOptions({ url: 'https://example.test' }, {}))
      .toEqual({ maxAttempts: 1 });
    expect(ptoolConnectionRetryOptions({ url: 'http://127.0.0.1:9071' }, {}))
      .toEqual({ maxAttempts: 1 });
    expect(ptoolConnectionRetryOptions({ url: 'http://127.0.0.1:3170' }, {
      PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
    })).toEqual({ maxAttempts: 1 });
    expect(ptoolConnectionRetryOptions({}, {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:24689',
      PAPERCUSP_OPERATOR_URL_PROVENANCE: 'psu-launcher',
    })).toEqual({});
  });
});

describe('ptool bearer-token resolution', () => {
  it('keeps explicit and environment token overrides authoritative', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_MCP_TOKEN_FILE: '/run/papercusp/explicit-token',
      PAPERCUSP_HOME: '/home/tester/.papercusp-workspaces/demo/.papercusp',
    };

    expect(resolveTokenPaths({
      tokenFile: '/tmp/cli-token',
      env,
      home: '/home/tester',
    })).toEqual(['/tmp/cli-token']);
    expect(resolveTokenPaths({ env, home: '/home/tester' }))
      .toEqual(['/run/papercusp/explicit-token']);
  });

  it('prefers the shared host token for a workspace-scoped PAPERCUSP_HOME', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_HOME: '/home/tester/.papercusp-workspaces/demo/.papercusp',
    };
    const paths = resolveTokenPaths({ env, home: '/home/tester' });

    expect(paths).toEqual([
      '/home/tester/.papercusp/superuser-token',
      '/home/tester/.papercusp-workspaces/demo/.papercusp/superuser-token',
    ]);
    expect(resolveTokenPath({ env, home: '/home/tester' })).toBe('/home/tester/.papercusp/superuser-token');
  });

  it('uses PAPERCUSP_OPERATOR_HOME when the session home is workspace-scoped', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_HOME: '/home/tester/.papercusp-workspaces/demo/.papercusp',
      PAPERCUSP_OPERATOR_HOME: '/tmp/operator-home',
    };

    expect(resolveTokenPaths({ env, home: '/home/tester' })).toEqual([
      '/tmp/operator-home/.papercusp/superuser-token',
      '/home/tester/.papercusp/superuser-token',
      '/home/tester/.papercusp-workspaces/demo/.papercusp/superuser-token',
    ]);
  });

  it('keeps an isolated operator PAPERCUSP_HOME ahead of the shared host token', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      PAPERCUSP_HOME: '/tmp/isolated/.papercusp',
    };

    expect(resolveTokenPaths({ env, home: '/home/tester' })).toEqual([
      '/tmp/isolated/.papercusp/superuser-token',
      '/home/tester/.papercusp/superuser-token',
    ]);
  });

  it('tries the next implicit token only after the operator rejects the first bearer', async () => {
    const authError = new Error('MCP error: mcp_auth_failed: superuser_invalid_bearer');
    const client = { close: vi.fn() };
    const connectOnce = vi.fn()
      .mockRejectedValueOnce(authError)
      .mockResolvedValueOnce(client);

    await expect(connectWithTokenFallback(connectOnce, ['workspace-token', 'shared-token']))
      .resolves.toBe(client);

    expect(isInvalidSuperuserBearerFailure(authError)).toBe(true);
    expect(connectOnce.mock.calls).toEqual([['workspace-token'], ['shared-token']]);
  });

  it('does not advance after a generic failure or beyond one explicit token', async () => {
    const authError = new Error('MCP error: mcp_auth_failed: superuser_invalid_bearer');
    const explicitConnect = vi.fn().mockRejectedValue(authError);

    await expect(connectWithTokenFallback(explicitConnect, ['explicit-token']))
      .rejects.toBe(authError);
    expect(explicitConnect).toHaveBeenCalledTimes(1);

    const transportError = new Error('ECONNREFUSED');
    const connectOnce = vi.fn().mockRejectedValue(transportError);

    await expect(connectWithTokenFallback(connectOnce, ['workspace-token', 'shared-token']))
      .rejects.toBe(transportError);
    expect(connectOnce).toHaveBeenCalledTimes(1);
    expect(isInvalidSuperuserBearerFailure(new Error('HTTP 401: unauthorized'))).toBe(false);
  });

  it('reconnects with the next implicit token when read-only tools/list rejects the first bearer', async () => {
    const authError = new Error('MCP error: mcp_auth_failed: superuser_invalid_bearer');
    const firstClient = { close: vi.fn() };
    const secondClient = { close: vi.fn() };
    const catalog = [{ name: 'work_items:get' }];
    const reconnect = vi.fn().mockResolvedValue(secondClient);
    const listTools = vi.fn()
      .mockRejectedValueOnce(authError)
      .mockResolvedValueOnce(catalog);

    const result = await listToolsWithTokenFallback(
      firstClient,
      ['/workspace/superuser-token', '/tmp/shared-superuser-token'],
      '/workspace/superuser-token',
      reconnect,
      listTools,
    );

    expect(result).toEqual({ client: secondClient, tools: catalog, error: null });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith('/tmp/shared-superuser-token');
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(listTools.mock.calls).toEqual([[firstClient], [secondClient]]);
  });

  it('retries tools/list once without an inherited foreign native-session claim', async () => {
    const client = 'su-cold-codex';
    const env = { PAPERCUSP_SID: client, CODEX_SESSION_ID: 'inherited-native-id' };
    const firstClient = { close: vi.fn() };
    const retryClient = { close: vi.fn() };
    const catalog = [{ name: 'coord:whoami' }];
    const refusal = new Error('MCP error -32603: mcp_auth_failed: superuser_foreign_native_session');
    const discoverTools = vi.fn()
      .mockResolvedValueOnce({ client: firstClient, tools: null, error: refusal })
      .mockResolvedValueOnce({ client: retryClient, tools: catalog, error: null });
    const reconnectWithoutNativeSession = vi.fn().mockResolvedValue(retryClient);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    const result = await listToolsWithNativeSessionFallback(firstClient, {
      discoverTools,
      reconnectWithoutNativeSession,
      client,
      env,
      closeClient,
    });

    expect(result).toEqual({
      client: retryClient,
      tools: catalog,
      error: null,
      nativeSessionRetried: true,
    });
    expect(discoverTools.mock.calls).toEqual([[firstClient], [retryClient]]);
    expect(reconnectWithoutNativeSession).toHaveBeenCalledOnce();
    expect(closeClient).toHaveBeenCalledWith(firstClient);
    expect(isForeignNativeSessionRejection(refusal)).toBe(true);
  });

  it('keeps launcher-bound identities and unrelated catalog failures terminal', async () => {
    const client = 'su-cold-codex';
    const firstClient = { close: vi.fn() };
    const refusal = new Error('MCP error -32603: mcp_auth_failed: superuser_foreign_native_session');
    const reconnectWithoutNativeSession = vi.fn();

    const boundResult = await listToolsWithNativeSessionFallback(firstClient, {
      discoverTools: vi.fn().mockResolvedValue({ client: firstClient, tools: null, error: refusal }),
      reconnectWithoutNativeSession,
      client,
      env: {
        PAPERCUSP_SID: client,
        PAPERCUSP_NATIVE_SESSION_ID: 'launcher-bound-id',
        CODEX_SESSION_ID: 'inherited-native-id',
      },
    });
    expect(boundResult.error).toBe(refusal);
    expect(boundResult.nativeSessionRetried).toBe(false);

    const unrelatedError = new Error('MCP error: mcp_auth_failed: superuser_invalid_bearer');
    const unrelatedResult = await listToolsWithNativeSessionFallback(firstClient, {
      discoverTools: vi.fn().mockResolvedValue({ client: firstClient, tools: null, error: unrelatedError }),
      reconnectWithoutNativeSession,
      client,
      env: { PAPERCUSP_SID: client, CODEX_SESSION_ID: 'inherited-native-id' },
    });
    expect(unrelatedResult.error).toBe(unrelatedError);
    expect(unrelatedResult.nativeSessionRetried).toBe(false);
    expect(reconnectWithoutNativeSession).not.toHaveBeenCalled();
  });

  it('keeps explicit token pins and non-bearer catalog errors terminal', async () => {
    const explicitError = new Error('MCP error: mcp_auth_failed: superuser_invalid_bearer');
    const explicitReconnect = vi.fn();
    const explicitResult = await listToolsWithTokenFallback(
      { close: vi.fn() },
      ['/explicit/superuser-token'],
      '/explicit/superuser-token',
      explicitReconnect,
      vi.fn().mockRejectedValue(explicitError),
    );
    expect(explicitResult.error).toBe(explicitError);
    expect(explicitReconnect).not.toHaveBeenCalled();

    const genericError = new Error('HTTP 401: unauthorized');
    const genericReconnect = vi.fn();
    const genericResult = await listToolsWithTokenFallback(
      { close: vi.fn() },
      ['/workspace/superuser-token', '/tmp/shared-superuser-token'],
      '/workspace/superuser-token',
      genericReconnect,
      vi.fn().mockRejectedValue(genericError),
    );
    expect(genericResult.error).toBe(genericError);
    expect(genericReconnect).not.toHaveBeenCalled();
  });
});

describe('ptool call deadlines', () => {
  it('keeps the pg_hot_queries client alive through the maximum sample on direct and deferred calls', () => {
    const args = { windowSec: 600, limit: 10 };
    const direct = timeoutForTool('dev:pg_hot_queries', args);
    const deferred = timeoutForTool('tools:invoke', { name: 'dev:pg_hot_queries', args });

    expect(PTOOL_PG_HOT_QUERIES_TIMEOUT_MS).toBe(670_000);
    expect(direct).toBe(PTOOL_PG_HOT_QUERIES_TIMEOUT_MS);
    expect(deferred).toBe(direct);
  });

  it('waits for the declared graph compiler and runtime budget on direct and deferred calls', () => {
    const args = { op: 'symbol', name: 'target', runtime: 'staging-operator' };
    const direct = timeoutForTool('graph:query', args);
    const deferred = timeoutForTool('tools:invoke', { name: 'graph:query', args });
    // The handler owns 90s and MCP adds 5s. The CLI must observe its typed
    // error as well as a successful answer, instead of cutting either off.
    expect(direct).toBeGreaterThan(95_000);
    expect(direct).toBeLessThanOrEqual(105_000);
    expect(deferred).toBe(direct);
    expect(timeoutForTool('ordinary:read')).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('lets lsp:query reach its declared handler deadline on direct and deferred calls', () => {
    const args = { op: 'diagnostics', file: 'packages/operator-core/example.ts' };
    const direct = timeoutForTool('lsp:query', args);
    const deferred = timeoutForTool('tools:invoke', { name: 'lsp:query', args });

    // The handler owns 90s and MCP adds 5s; retain 5s of client-side margin.
    expect(direct).toBe(100_000);
    expect(direct).toBeGreaterThan(95_000);
    expect(deferred).toBe(direct);
  });

  it('keeps plans:evaluate-spec-test-adequacy alive through server evaluation on direct and deferred calls', () => {
    const args = { slug: 'adequacy-plan', classRef: 'plan-class-investigation' };
    const direct = timeoutForTool('plans:evaluate-spec-test-adequacy', args);
    const deferred = timeoutForTool('tools:invoke', {
      name: 'plans:evaluate-spec-test-adequacy',
      args,
    });

    // The evaluator owns 120s and MCP adds 5s for settlement. Read the
    // declaration so a future server-budget increase cannot silently outrun
    // this client again (EI-23705430436787379).
    const evaluatorSource = readFileSync(new URL(
      '../../../packages/operator-core/lib/agent-tools/plans/evaluate-spec-test-adequacy.ts',
      import.meta.url,
    ), 'utf8');
    const declaredTimeout = evaluatorSource.match(/timeoutSec:\s*(\d+)/);
    expect(declaredTimeout).not.toBeNull();
    const serverDeadlineMs = Number(declaredTimeout![1]) * 1000 + 5_000;

    expect(PTOOL_PLANS_EVALUATE_SPEC_TEST_ADEQUACY_TIMEOUT_MS).toBe(130_000);
    expect(direct).toBe(PTOOL_PLANS_EVALUATE_SPEC_TEST_ADEQUACY_TIMEOUT_MS);
    expect(direct).toBeGreaterThan(serverDeadlineMs);
    expect(deferred).toBe(direct);
  });

  it('lets logs:read return its structured journal timeout on both call routes', () => {
    expect(timeoutForTool('logs:read')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'logs:read',
      args: { unit: 'papercusp-bg-host', since: '-8 minutes' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('logs:read')).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('lets coord:feed reach the MCP transport ceiling on direct and deferred routes', () => {
    const args = { owner: 'su-example', since: '2026-10-08T13:33:58Z', limit: 20 };
    const direct = timeoutForTool('coord:feed', args);
    const deferred = timeoutForTool('tools:invoke', { name: 'coord:feed', args });

    expect(direct).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(deferred).toBe(direct);
    expect(direct).toBeGreaterThan(55_000);
  });

  it('lets docs:get reach the MCP transport deadline on direct and deferred routes', () => {
    const args = {
      slugs: ['agent-insights/ptool-client-timeout-must-outlive-tool-server-clamp'],
      harness: 'engineering',
    };
    expect(timeoutForTool('docs:get', args)).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', { name: 'docs:get', args }))
      .toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('docs:get', args)).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps the client alive only for bounded read-only admit previews', () => {
    expect(PTOOL_REPAIR_QUEUE_PREVIEW_TIMEOUT_MS).toBe(305_000);
    expect(timeoutForTool('release:repair-queue', { op: 'admit' }))
      .toBe(PTOOL_REPAIR_QUEUE_PREVIEW_TIMEOUT_MS);
    expect(timeoutForTool('release:repair-queue', { op: 'admit', confirm: false }))
      .toBe(PTOOL_REPAIR_QUEUE_PREVIEW_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:repair-queue',
      args: { op: 'admit' },
    })).toBe(PTOOL_REPAIR_QUEUE_PREVIEW_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:repair-queue',
      args: { op: 'admit', confirm: false },
    })).toBe(PTOOL_REPAIR_QUEUE_PREVIEW_TIMEOUT_MS);
    expect(timeoutForTool('release:repair-queue', { op: 'converge', confirm: false }))
      .toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:repair-queue',
      args: { op: 'converge', confirm: false },
    })).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('release:repair-queue', { op: 'admit', confirm: true }))
      .toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('release:repair-queue', { op: 'get' }))
      .toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('preserves the foreground budget for PR-delivery audits on direct and deferred routes', () => {
    const args = { harness: 'papercusp', prDeliveryAudit: { ruleIds: ['f402c8d4-8a82-473f-be0f-73f45597e8f3'] } };
    expect(timeoutForTool('work_items:list', args)).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', { name: 'work_items:list', args }))
      .toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS).toBeGreaterThan(55_000);
    expect(timeoutForTool('work_items:list', { harness: 'papercusp' })).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', { name: 'work_items:list', args: { harness: 'papercusp' } }))
      .toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps release-cut calls alive beyond the declared handler budget on direct and deferred routes', () => {
    const source = readFileSync(new URL('../../../packages/operator-core/lib/agent-tools/release/cut.ts', import.meta.url), 'utf8');
    const timeoutSec = Number(source.match(/timeoutSec:\s*(\d+)/)?.[1]);
    expect(timeoutSec).toBeGreaterThan(0);
    for (const args of [
      { op: 'preflight', deferTag: true },
      { op: 'run', confirm: true },
      { op: 'run-leg', platform: 'windows', confirm: true },
      { op: 'status' },
      { op: 'reclaim', confirm: true },
    ]) {
      const deadline = (timeoutSec + 5) * 1000;
      expect(timeoutForTool('release:cut', args)).toBeGreaterThan(deadline);
      expect(timeoutForTool('tools:invoke', { name: 'release:cut', args }))
        .toBeGreaterThan(deadline);
    }
    expect(timeoutForTool('unrelated:tool', { op: 'preflight' })).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps storage prune calls alive beyond the maintenance handler and settlement budget', () => {
    const source = readFileSync(new URL('../../../packages/operator-core/lib/agent-tools/storage/prune.ts', import.meta.url), 'utf8');
    const timeoutSec = Number(source.match(/timeoutSec:\s*(\d+)/)?.[1]);
    expect(timeoutSec).toBeGreaterThan(0);
    const deadline = (timeoutSec + 5) * 1000;
    for (const dryRun of [true, false]) {
      const args = { category: 'agent-sessions', olderThanDays: 3, dryRun };
      expect(timeoutForTool('storage:prune', args)).toBeGreaterThan(deadline);
      expect(timeoutForTool('tools:invoke', { name: 'storage:prune', args }))
        .toBeGreaterThan(deadline);
    }
    expect(timeoutForTool('unrelated:tool')).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('preserves the existing release-cut reclaim preview allowance', () => {
    const preview = { op: 'reclaim', confirm: false };
    expect(timeoutForTool('release:cut', preview)).toBe(PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', { name: 'release:cut', args: preview }))
      .toBe(PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS);
    expect(timeoutForTool('release:cut', { op: 'reclaim' }))
      .toBe(PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS);

    expect(timeoutForTool('release:cut', { op: 'reclaim', confirm: false }))
      .toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps the normal liveness ceiling while allowing durable continuations to return', () => {
    expect(timeoutForTool('coord:send')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-26150958178632417: resumeAdmission performs durable recovery before
    // assignment/wake; both direct and deferred calls must outlive ptool's
    // ordinary 30s cutoff so a typed refusal or queued receipt is observable.
    const dispatchArgs = {
      to: 'su-resume-target',
      harness: 'papercusp',
      workItemIds: ['EI-resume-timeout-regression'],
      resumeAdmission: true,
    };
    expect(timeoutForTool('coord:dispatch', dispatchArgs)).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', { name: 'coord:dispatch', args: dispatchArgs }))
      .toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-22598752399389413: coord:wake has no explicit timeoutSec and its
    // bounded roster + target phases can legitimately approach the MCP
    // transport floor. Cover both routes so it cannot regress to ptool's
    // flat 30s outcome-unknown cutoff.
    expect(timeoutForTool('coord:wake')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:wake',
      args: { to: 'su-parked-agent', note: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // coord:thread has no shorter tool timeout than the read-only MCP deadline;
    // preserve the 60s client budget on direct and deferred calls. This is a
    // client/server contract guard, not proof of the historical report's cause.
    expect(timeoutForTool('coord:thread')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:thread',
      args: { root_msg_id: 'coord-thread-timeout-regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS).toBe(60_000);
    // EI-21863905839650704: coord:declare-intent declares no timeoutSec (bound
    // only by the flat 55s MCP_DEADLINE_MS floor), and a reporter observed the
    // flat 30s client cutoff abort the call with "mutation may have executed"
    // while the presence write had already landed. Cover both transport routes.
    expect(timeoutForTool('coord:declare-intent')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:declare-intent',
      args: { intent: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-25808449616032701: resume-recovery identity/message/spec reads have
    // no shorter server timeout than the MCP transport cap. Cover direct and
    // deferred routes so ptool cannot preempt their structured result at 30s.
    for (const [name, args] of [
      ['coord:whoami', {}],
      ['coord:read', { msg_id: 'coord-send-timeout-regression' }],
      ['scheduler:get_claim_spec', { fleet: 'timeout-regression' }],
    ] as const) {
      expect(timeoutForTool(name, args)).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
      expect(timeoutForTool('tools:invoke', { name, args }))
        .toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    }
    // EI-23173103907673402: live tools:find schema searches can cross the
    // ordinary 30s client cutoff; cover direct and deferred discovery routes.
    expect(timeoutForTool('tools:find')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'tools:find',
      args: { query: 'coord:send' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-22810897251728336: publish has three bounded network stages whose
    // combined latency can legitimately cross the flat 30s client deadline.
    // Cover both transports so ptool observes the server's typed result.
    expect(timeoutForTool('blueprint:publish')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'blueprint:publish',
      args: { blueprintId: 'papercusp-engineer' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // EI-254011: a measured storage:usage call settled server-side after the
    // ordinary 30s ptool deadline. Cover direct and deferred routes.
    expect(timeoutForTool('storage:usage')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'storage:usage',
      args: { category: 'scratch' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('fleet:launch-on-plan')).toBe(300_000);
    expect(timeoutForTool('tools:invoke', { name: 'fleet:launch-on-plan' })).toBe(300_000);
    // EI-21831468700319864: fleet:wind-down inherits the 60s dispatch default;
    // cover direct and tools:invoke-wrapped calls so the client deadline does
    // not race its durable control-state mutation.
    expect(timeoutForTool('fleet:wind-down')).toBe(PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'fleet:wind-down',
      args: { fleet: 'nonp2p-bug-drain-luna-max-50', reason: 'test timeout mapping' },
    })).toBe(PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS);
    expect(PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // EI-21388931083718076: the respawn orchestration's client deadline must outlive
    // its 660s server budget (+5s transport buffer) — a 30s client abort turned five
    // server-side-successful respawns into -32001 outcome-unknown.
    expect(timeoutForTool('fleet:respawn-member')).toBe(675_000);
    expect(timeoutForTool('tools:invoke', { name: 'fleet:respawn-member' })).toBe(675_000);
    expect(timeoutForTool('fleet:require-checkpoint')).toBe(PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'fleet:require-checkpoint',
      args: { member: 'su-member', itemId: 'WI-123', waitSec: 300 },
    })).toBe(PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS);
    expect(PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS).toBeGreaterThan(335_000);
    expect(timeoutForTool('git-sync:run')).toBe(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS);
    expect(timeoutForTool('backup:snapshot_create')).toBe(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('backup:restore')).toBe(PTOOL_BACKUP_RESTORE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'backup:restore',
      args: { kopiaSnapshotId: 'snapshot-1', mode: 'clone' },
    })).toBe(PTOOL_BACKUP_RESTORE_TIMEOUT_MS);
    expect(timeoutForTool('templates:new-app')).toBe(PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS);
    expect(timeoutForTool('scorecards:emit')).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    // EI-25378335241705149: clause certification emits passing scorecards using
    // the same 900s server budget; cover the direct and deferred paths so the
    // ordinary 30s client deadline cannot hide its durable result.
    expect(timeoutForTool('plans:certify-spec-clauses')).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:certify-spec-clauses',
      args: { planSlug: 'timeout-mapping-regression' },
    })).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    // EI-22780156976598155: headless boot/kickoff/fresh-launch verification
    // follows the shared launch budget. Keep direct and deferred routes outside
    // its handler timeout plus the 5s MCP settlement window.
    expect(timeoutForTool('capability:launch-agent')).toBe(PTOOL_AGENT_LAUNCH_TIMEOUT_MS);
    expect(PTOOL_AGENT_LAUNCH_TIMEOUT_MS).toBe(AGENT_LAUNCH_CLIENT_TIMEOUT_MS);
    expect(PTOOL_AGENT_LAUNCH_TIMEOUT_MS)
      .toBeGreaterThan((AGENT_LAUNCH_HANDLER_TIMEOUT_SEC * 1000) + 5000);
    expect(timeoutForTool('tools:invoke', {
      name: 'capability:launch-agent',
      args: { agent: 'claude', headless: false },
    })).toBe(PTOOL_AGENT_LAUNCH_TIMEOUT_MS);
    expect(timeoutForTool('computer:provision_desktop')).toBe(60_000);
    // EI-26161087677172506: git-evidence's 30s handler can be followed by
    // the result-door's 30s scratch-spill wait. Keep both transport shapes
    // beyond that combined path so a pending spill cursor is observable.
    expect(timeoutForTool('capability:git-evidence')).toBe(PTOOL_GIT_EVIDENCE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'capability:git-evidence',
      args: { op: 'readFileAtCommit', commitSha: 'a'.repeat(40), path: 'packages/example.ts' },
    })).toBe(PTOOL_GIT_EVIDENCE_TIMEOUT_MS);
    expect(PTOOL_GIT_EVIDENCE_TIMEOUT_MS).toBeGreaterThan(65_000);
    // EI-22778035061732249: events:emit can complete its durable fire after
    // the old 30s client cutoff. Cover direct and deferred routes so a fired
    // event cannot be reported as outcome-unknown before its receipt returns.
    expect(timeoutForTool('events:emit')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'events:emit',
      args: { event: 'timeout-mapping-regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('events:await')).toBe(PTOOL_EVENTS_AWAIT_TIMEOUT_MS);
    expect(timeoutForTool('plans:get')).toBe(PTOOL_PLANS_GET_TIMEOUT_MS);
    expect(PTOOL_PLANS_GET_TIMEOUT_MS).toBeGreaterThan(125_000);
    // EI-22774777434821469: completion/activation audits resolve all submitted
    // citations before persisting. Cover direct and deferred calls so a valid
    // multi-item audit cannot be cut off at ptool's ordinary 30s deadline.
    expect(timeoutForTool('plans:audit')).toBe(PTOOL_PLANS_AUDIT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:audit',
      args: { slug: 'plan-a', phase: 'completion' },
    })).toBe(PTOOL_PLANS_AUDIT_TIMEOUT_MS);
    expect(timeoutForTool('plans:new')).toBe(PTOOL_PLANS_NEW_TIMEOUT_MS);
    // EI-22701666730811258: dev:pg_query's SQL timeout does not cover proxy
    // admission/queue dwell. Keep both transport routes above the MCP floor so
    // a queued read returns its typed result instead of ptool's 30s cutoff.
    expect(timeoutForTool('dev:pg_query')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'dev:pg_query',
      args: { sql: 'SELECT 1', timeoutMs: 10_000, maxRows: 1 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-23079930157206205: service-health's fixed-endpoint/systemd fan-out
    // can outlive ptool's ordinary 30s client cutoff. Cover both transport
    // routes so a valid read is not surfaced as outcome-unknown.
    expect(timeoutForTool('dev:service_health')).toBe(PTOOL_SERVICE_HEALTH_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'dev:service_health',
      args: { target: 'staging' },
    })).toBe(PTOOL_SERVICE_HEALTH_TIMEOUT_MS);
    expect(PTOOL_SERVICE_HEALTH_TIMEOUT_MS).toBeGreaterThan(77_226);
    // EI-23098800759403082: carry-respawn's 600s server budget + 5s MCP
    // settlement buffer must also apply when wrapped by tools:invoke.
    expect(timeoutForTool('session:request-compaction')).toBe(PTOOL_SESSION_REQUEST_COMPACTION_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'session:request-compaction',
      args: { focus: 'resume the current lane' },
    })).toBe(PTOOL_SESSION_REQUEST_COMPACTION_TIMEOUT_MS);
    expect(PTOOL_SESSION_REQUEST_COMPACTION_TIMEOUT_MS).toBe(610_000);
    expect(PTOOL_SESSION_REQUEST_COMPACTION_TIMEOUT_MS).toBeGreaterThan(605_000);
    // EI-25882027630574649: a successful plans:start took 77.763s; its
    // declared 120s server timeout gives MCP a 125s deadline. Cover both routes.
    expect(timeoutForTool('plans:start')).toBe(PTOOL_PLANS_START_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:start',
      args: { slug: 'fleet-worker-lifecycle-convergence-2026-08-26', harness: 'papercusp' },
    })).toBe(PTOOL_PLANS_START_TIMEOUT_MS);
    expect(PTOOL_PLANS_START_TIMEOUT_MS).toBe(130_000);
    expect(PTOOL_PLANS_START_TIMEOUT_MS).toBeGreaterThan(125_000);
    expect(PTOOL_PLANS_NEW_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('plans:set-plan-status')).toBe(PTOOL_PLAN_STATUS_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:set-plan-status',
      args: { slug: 'plan-a', status: 'shipped', dryRun: true },
    })).toBe(PTOOL_PLAN_STATUS_TIMEOUT_MS);
    expect(PTOOL_PLAN_STATUS_TIMEOUT_MS).toBeGreaterThan(905_000);
    expect(timeoutForTool('work_items:get')).toBe(PTOOL_WORK_ITEMS_GET_TIMEOUT_MS);
    // EI-23211866726609651: scorecards:get can exceed the ordinary 30s client
    // cutoff while reading an oversized evidence index; the same budget must
    // apply when reached through tools:invoke.
    expect(timeoutForTool('scorecards:get')).toBe(PTOOL_SCORECARDS_GET_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'scorecards:get',
      args: { issueId: 'EI-23210280113714696' },
    })).toBe(PTOOL_SCORECARDS_GET_TIMEOUT_MS);
    expect(timeoutForTool('activity:recent')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('events:status')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('work_items:complete')).toBe(PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS);
    // The tool declares 120s and MCP adds a 5s handler buffer. Keep the client
    // outside that effective server deadline so the typed receipt wins the race.
    expect(PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS).toBe(130_000);
    expect(PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS).toBeGreaterThan(125_000);
    // EI-21832411975767034: cover direct and tools:invoke-wrapped create calls
    // so the client deadline cannot drift back to the flat 30s cutoff.
    expect(timeoutForTool('work_items:create')).toBe(PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:create',
      args: { kind: 'task', title: 'timeout mapping regression' },
    })).toBe(PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS);
    expect(PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // EI-22347167277704688: request_release has a minimum announced
    // deadlineSec of 30s, but its durable request/comment/notification write
    // can still outlive ptool's ordinary 30s client cutoff. Cover direct and
    // tools:invoke-wrapped calls so the MCP result is not outcome-unknown.
    expect(timeoutForTool('work_items:request_release')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:request_release',
      args: { id: 'WI-1', deadlineSec: 30, onSilence: 'reclaim', reason: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-22351729180562005: live rubric-vetting routing completed in 47.954s;
    // the client must not abandon either transport shape at the flat 30s
    // deadline and turn a successful consult write into outcome-unknown.
    expect(timeoutForTool('consult:get_feedback')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'consult:get_feedback',
      args: { question: 'timeout mapping regression', policy: 'rubric-vetting' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('activity:tool-log')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('sessions:search')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('sessions:read')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('release:deploy')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-22646214305093468: checkpoint-run detaches the ~55min suite, but its
    // admission/launch receipt still crosses the 55s MCP floor. Keep both
    // transport shapes beyond that floor instead of abandoning the receipt at
    // ptool's ordinary 30s deadline.
    expect(timeoutForTool('release:checkpoint-run')).toBe(PTOOL_CHECKPOINT_RUN_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:checkpoint-run',
      args: { reason: 'timeout mapping regression' },
    })).toBe(PTOOL_CHECKPOINT_RUN_TIMEOUT_MS);
    expect(PTOOL_CHECKPOINT_RUN_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('events:cancel')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('work_items:checkpoint')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21565982575605857: required friction filing must outlive the MCP
    // transport cap on both the direct and deferred tools:invoke routes; a
    // flat 30s deadline reports the write outcome as unknown while capture
    // is still in flight.
    expect(timeoutForTool('improvements:capture')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21863905839650704: loop:arm declares no timeoutSec and performs a
    // compound admission (claim + inbox-wake arming + reachability probe);
    // a reporter's combined "coord:declare-intent and loop:arm" call surfaced
    // the identical ambiguous-outcome failure for this tool too.
    expect(timeoutForTool('loop:arm')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'loop:arm',
      args: { intervalSec: 60, goal: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('loop:checkpoint')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('loop:end')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'loop:end',
      args: {},
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:get',
      args: { id: 'EI-21281814895308307' },
    })).toBe(PTOOL_WORK_ITEMS_GET_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'activity:recent',
      args: { harness: 'papercusp', limit: 50 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'events:status',
      args: { meter: true },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:complete',
      args: { id: 'EI-21391577717750595', state: 'done' },
    })).toBe(PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'activity:tool-log',
      args: { owner: 'su-04f38', max_lines: 20 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'sessions:search',
      args: { query: 'timeout', mode: 'verbatim', limit: 1, context: 0 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'sessions:read',
      args: { session: 'codex:timeout-mapping-regression', tail: 10, text_limit: 1000 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:deploy',
      args: { op: 'status' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'events:cancel',
      args: { delivery_id: 164257 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:checkpoint',
      args: { id: 'WI-41055', checkpoint: 'resume' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'improvements:capture',
      args: { title: 'timeout mapping regression' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('coord:orient')).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    // EI-25380603241293913: a slow directed inbox read includes its presence
    // rebootstrap; cover both dispatch paths and keep margin over the measured
    // 58.7s completion rather than falling back to 30s or the 60s foreground cap.
    expect(timeoutForTool('coord:inbox')).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:inbox',
      args: { directed: true },
    })).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    expect(timeoutForTool('release:trace')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('coord:presence')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21562940235111441: the fleet-scope reconciliation has its own 30s
    // server watchdog; ptool must leave enough time for its typed timeout
    // result to cross the MCP transport instead of racing it at 30s.
    expect(timeoutForTool('scheduler:get_next')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-25882027630574649: a successful claim took 69.467s, while its new
    // 120s server timeout gives MCP a 125s deadline. Cover direct and deferred calls.
    expect(timeoutForTool('work_items:claim')).toBe(PTOOL_WORK_ITEMS_CLAIM_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:claim',
      args: { id: 'EI-22722799928417577' },
    })).toBe(PTOOL_WORK_ITEMS_CLAIM_TIMEOUT_MS);
    expect(PTOOL_WORK_ITEMS_CLAIM_TIMEOUT_MS).toBe(130_000);
    expect(PTOOL_WORK_ITEMS_CLAIM_TIMEOUT_MS).toBeGreaterThan(125_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:get',
      args: { slug: 'nonp2p-bug-drain-fleet-2026-08-16', harness: 'papercusp' },
    })).toBe(PTOOL_PLANS_GET_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:new',
      args: { slug: 'anti-babysitting-monitor-enforcement-2026-08-25', title: 'monitor' },
    })).toBe(PTOOL_PLANS_NEW_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'release:trace',
      args: { sha: '83805ce3' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:presence',
      args: { owner: 'su-b215e3bd-66d1-42ce-8186-55df285710be' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'scheduler:get_next',
      args: { harness: 'papercusp' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-25420975795006444: set_state inherits MCP's 55s server deadline;
    // keep both transports above it so a committed write returns its receipt.
    const setStateArgs = { id: 'WI-123', state: 'open' };
    expect(timeoutForTool('work_items:set_state', setStateArgs)).toBeGreaterThan(55_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:set_state',
      args: setStateArgs,
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-25455246754148819: blocker writes include payload persistence and a
    // lifecycle transition; the ptool client must outlive the server's 55s
    // default deadline on both direct and deferred dispatch paths.
    const setBlockerArgs = { id: 'EI-25455246754148819', kind: 'runtime', ref: 'runtime:test' };
    expect(timeoutForTool('work_items:set_blocker', setBlockerArgs)).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'work_items:set_blocker',
      args: setBlockerArgs,
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    // EI-21574172453638335: locks:acquire's bounded blocking wait must not
    // fall through to the flat 30s client deadline, including via tools:invoke.
    expect(timeoutForTool('locks:acquire', {
      paths: ['packages/example.ts'],
      intent: 'test lock timeout mapping',
      wait: { max_sec: 45 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'locks:acquire',
      args: {
        paths: ['packages/example.ts'],
        intent: 'test deferred lock timeout mapping',
        wait: { max_sec: 300 },
      },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('locks:acquire')).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // EI-22593064345817096: release can share the lock store's transaction
    // contention/retry path, so cover both transport routes and keep its
    // client deadline outside the ordinary 30s cutoff.
    expect(timeoutForTool('locks:release')).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'locks:release',
      args: { lock_id: '00000000-0000-0000-0000-000000000000' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('locks:release')).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:set-plan-status',
      args: { slug: 'some-plan', status: 'shipped', expectedCurrent: 'ready' },
    })).toBe(PTOOL_PLAN_STATUS_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:orient',
      args: {},
    })).toBe(PTOOL_COORD_ORIENT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'computer:provision_desktop',
      args: { pot: 'papercusp', apps: [] },
    })).toBe(60_000);
    expect(timeoutForTool('tools:invoke', {
      name: 'backup:snapshot_create',
      args: { reason: 'pre_destructive' },
    })).toBe(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'coord:send',
      args: {},
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'templates:new-app',
      args: { template: 'papercusp-android-app', slug: 'demo' },
    })).toBe(PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'scorecards:emit',
      args: { rubricRef: 'acceptance-demo' },
    })).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'events:await',
      args: { event: 'wi-40086-qualified-current-tip' },
    })).toBe(PTOOL_EVENTS_AWAIT_TIMEOUT_MS);
    expect(PTOOL_EVENTS_AWAIT_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // WI-10003638: the git-sync:run server budget is a 45s fire + two 5s HEAD
    // reads + 5s MCP settlement = 60s. A client deadline equal to it has zero
    // margin for main-thread lag on the background-worker host.
    expect(PTOOL_GIT_SYNC_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * (45_000 + 5_000 + 5_000 + 5_000));
    expect(PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(PTOOL_BACKUP_RESTORE_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    // scorecards:emit declares 900s; the MCP transport adds a 5s buffer.
    expect(PTOOL_SCORECARD_EMIT_TIMEOUT_MS).toBeGreaterThan(905_000);
  });

  it('passes the selected deadline to both MCP timeout guards', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    await callToolWithPressureRetry(
      { callTool },
      { name: 'git-sync:run', arguments: {} },
      { timeoutMs: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS, maxAttempts: 1 },
    );

    expect(callTool).toHaveBeenCalledWith(
      { name: 'git-sync:run', arguments: {} },
      undefined,
      {
        timeout: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
        maxTotalTimeout: PTOOL_GIT_SYNC_RUN_TIMEOUT_MS,
      },
    );
  });
});

describe('ptool content-summary transport budget', () => {
  it('keeps direct and deferred summaries outside their 190-second server budget', () => {
    const args = { operation: 'summarize', summary: { timeoutMs: 180_000 } };
    const direct = timeoutForTool('documents:read', args);
    const deferred = timeoutForTool('tools:invoke', { name: 'documents:read', args });
    expect(direct).toBeGreaterThan(190_000);
    expect(deferred).toBe(direct);
    expect(timeoutForTool('ordinary:read')).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });
});

describe('ptool tools/call failure diagnostics', () => {
  it('identifies a catalog timeout as pre-dispatch and safe to retry', () => {
    const error = Object.assign(new Error('Request timed out'), { code: -32001 });
    const message = formatToolCatalogFailure('coord:read', error);

    expect(message).toContain('tool catalog discovery failed for requested tool coord:read');
    expect(message).toContain('failure_stage=tools/list');
    expect(message).toContain('no named tool was dispatched');
    expect(message).toContain('retrying this CLI invocation is safe');
    expect(message).not.toContain('may have executed');
  });

  it('preserves transport and cause details while requiring state verification before retry', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
    });

    const message = formatToolCallFailure('work_items:complete', error);

    expect(message).toContain('tools/call work_items:complete');
    expect(message).toContain('fetch failed');
    expect(message).toContain('UND_ERR_SOCKET: other side closed');
    expect(message).toContain('the tool call may have executed');
    expect(message).toContain('verify its state before retrying');
    expect(message).toContain('Do not blindly retry a mutation');
  });

  it('surfaces the idempotency receipt needed to replay an unknown outcome', () => {
    const error = Object.assign(new Error('Request timed out'), { code: -32001 });
    const message = formatToolCallFailure('work_items:checkpoint', error, {
      idempotencyKey: 'receipt-unknown-1',
    });

    expect(message).toContain('outcome=unknown');
    expect(message).toContain('idempotencyKey=receipt-unknown-1');
    expect(message).toContain('--idempotency-key receipt-unknown-1');
    expect(message).toContain('ptool transport flag');
    expect(message).toContain('MCP _meta.idempotencyKey');
    expect(message).toContain('not by adding idempotencyKey to the target tool JSON arguments');
  });

  it('treats the proxy not_forwarded result as a safe pre-dispatch refusal', () => {
    const error = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_upstream_unavailable","forwardingResult":"not_forwarded","detail":"upstream refused before forwarding"}',
    ), { code: 503 });
    const message = formatToolCallFailure('coord:inbox', error, {
      idempotencyKey: 'not-forwarded-1',
    });

    expect(message).toContain('rejected before dispatch');
    expect(message).toContain('no tool execution occurred');
    expect(message).not.toContain('may have executed');
    expect(message).not.toContain('outcome=unknown');
    expect(message).not.toContain('idempotencyKey=not-forwarded-1');
  });

  it('treats a direct pre-connect ECONNREFUSED as safe to retry', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3170' },
    });
    const message = formatToolCallFailure('coord:inbox', error, {
      idempotencyKey: 'refused-1',
    });

    expect(message).toContain('rejected before dispatch');
    expect(message).toContain('no tool execution occurred');
    expect(message).not.toContain('may have executed');
    expect(message).not.toContain('outcome=unknown');
    expect(message).not.toContain('idempotencyKey=refused-1');
  });

  it('keeps post-connect transport failures ambiguous even with a similar detail', () => {
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_SOCKET', message: 'other side closed after dispatch' },
    });
    const message = formatToolCallFailure('coord:inbox', error, {
      idempotencyKey: 'unknown-1',
    });

    expect(message).toContain('may have executed');
    expect(message).toContain('outcome=unknown');
  });

  it('does not replay an events:await after a post-connect ECONNRESET', async () => {
    const failure = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'socket hang up' },
    });
    const params = buildCallToolParams('events:await', { event: 'fleet:resume:test' }, {
      idempotencyKey: 'ptool-await-reset-1',
    });
    const client = {
      callTool: vi.fn().mockRejectedValue(failure),
      close: vi.fn(),
    };
    const reconnect = vi.fn();

    await expect(callToolWithReplayRecovery(client, params, { reconnect })).rejects.toBe(failure);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();

    const message = formatToolCallFailure('events:await', failure, {
      idempotencyKey: 'ptool-await-reset-1',
    });
    expect(message).toContain('the tool call may have executed');
    expect(message).toContain('verify its state before retrying');
    expect(message).toContain('outcome=unknown');
    expect(message).not.toContain('no tool execution occurred');
  });

  it('does not infer pre-connect safety from ECONNREFUSED inside an HTTP error response', () => {
    const error = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_upstream_error","forwardingResult":"outcome_unknown","detail":"ECONNREFUSED after the upstream connected"}',
    ), { code: 502 });
    const message = formatToolCallFailure('work_items:complete', error, {
      idempotencyKey: 'http-unknown-1',
    });

    expect(message).toContain('may have executed');
    expect(message).toContain('outcome=unknown');
  });

  it('does not mislabel a known pre-dispatch pressure shed as ambiguous', () => {
    const error = new Error('loop_pressure_critical');

    expect(isLoopPressureShed(error)).toBe(true);
    expect(formatToolCallFailure('coord:send', error)).toContain('rejected before dispatch');
    expect(formatToolCallFailure('coord:send', error)).toContain('no tool execution occurred');
    expect(formatToolCallFailure('coord:send', error)).not.toContain('may have executed');
  });

  it('classifies every typed proxy queue refusal as pre-dispatch, including coord:send dwell', () => {
    const proxySheds = [
      'mcp_proxy_overloaded',
      'mcp_proxy_handshake_overloaded',
      'mcp_proxy_handshake_queue_dwell',
      'mcp_proxy_coord_send_queue_full',
      'mcp_proxy_coord_send_queue_dwell',
      'mcp_proxy_critical_continuation_queue_full',
      'mcp_proxy_critical_continuation_queue_dwell',
    ].map((error) => Object.assign(new Error(
      `Streamable HTTP error: Error POSTing to endpoint: {"error":"${error}","retryable":true,"retryAfterSec":1}`,
    ), { code: 429 }));
    const providerLimit = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"provider_rate_limit"}',
    ), { code: 429 });
    const realProxy502 = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_upstream_error"}',
    ), { code: 502 });

    for (const proxyShed of proxySheds) {
      expect(isLoopPressureShed(proxyShed)).toBe(true);
      expect(formatToolCallFailure('coord:send', proxyShed)).toContain(
        'rejected before dispatch',
      );
      expect(formatToolCallFailure('coord:send', proxyShed)).toContain(
        'no tool execution occurred',
      );
    }
    expect(isLoopPressureShed(providerLimit)).toBe(false);
    expect(isLoopPressureShed(realProxy502)).toBe(false);
  });

  it('retries a typed proxy refusal using its Retry-After hint', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const proxyShed = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_critical_continuation_queue_full","retryable":true,"retryAfterSec":2}',
    ), { code: 429 });
    const callTool = vi.fn().mockRejectedValueOnce(proxyShed).mockResolvedValue(result);
    const sleep = vi.fn(async () => {});

    await expect(callToolWithPressureRetry(
      { callTool },
      { name: 'tools:invoke', arguments: { name: 'work_items:checkpoint', args: {} } },
      { maxAttempts: 2, sleep },
    )).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('retries a coord:send queue-dwell refusal using its Retry-After hint', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const proxyShed = Object.assign(new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_coord_send_queue_dwell","retryable":true,"forwardingResult":"not_forwarded","retryAfterSec":2}',
    ), { code: 429 });
    const callTool = vi.fn().mockRejectedValueOnce(proxyShed).mockResolvedValue(result);
    const sleep = vi.fn(async () => {});

    await expect(callToolWithPressureRetry(
      { callTool },
      { name: 'tools:invoke', arguments: { name: 'coord:send', args: {} } },
      { maxAttempts: 2, sleep },
    )).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });
});

describe('ptool catalog-independent scripted dispatch', () => {
  it('only bypasses a failed tools/list transport for a named scripted call', () => {
    const transportFailure = new Error('tools/list transport unavailable');

    expect(canDispatchWithoutCatalog('rubrics:get', 'stdin', transportFailure)).toBe(true);
    expect(canDispatchWithoutCatalog('rubrics:get', 'file', transportFailure)).toBe(true);
    expect(canDispatchWithoutCatalog('rubrics:get', null, transportFailure)).toBe(false);
    expect(canDispatchWithoutCatalog(null, 'stdin', transportFailure)).toBe(false);
    expect(canDispatchWithoutCatalog('', 'stdin', transportFailure)).toBe(false);
  });

  it('refuses direct dispatch when tools/list lacks the serving-generation marker', () => {
    const missingGeneration = Object.assign(new Error('legacy tools/list'), {
      code: 'serving_generation_missing',
    });

    expect(canDispatchWithoutCatalog('rubrics:get', 'stdin', missingGeneration)).toBe(false);
    expect(canDispatchWithoutCatalog('rubrics:get', 'file', missingGeneration)).toBe(false);
    expect(canDispatchWithoutCatalog('fleet:take-leadership', null, missingGeneration)).toBe(false);
  });

  it('dispatches supplied arguments with protocol-only validation when the catalog is bypassed', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const client = {
      listTools: vi.fn(),
      callTool: vi.fn(),
      request: vi.fn().mockResolvedValue(result),
    };

    await expect(dispatchScriptedToolWithoutCatalog(
      client,
      'rubrics:get',
      { rubricRef: 'pot-coordination-health' },
      { idempotencyKey: 'catalog-bypass-1', timeoutMs: 1 },
    )).resolves.toEqual({ client, result });

    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toEqual({
      method: 'tools/call',
      params: {
        name: 'rubrics:get',
        arguments: { rubricRef: 'pot-coordination-health' },
        _meta: { format: 'json', idempotencyKey: 'catalog-bypass-1' },
      },
    });
    expect(client.request.mock.calls[0][1]).toBeDefined();
    expect(client.request.mock.calls[0][2]).toEqual({ timeout: 1, maxTotalTimeout: 1 });
  });

  it('keeps scheduler:get_next on its foreground budget when tools/list timed out', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":false,"error":"all_matches_gated"}' }] };
    const client = {
      listTools: vi.fn(),
      callTool: vi.fn(),
      request: vi.fn().mockResolvedValue(result),
    };

    await expect(dispatchScriptedToolWithoutCatalog(
      client,
      'scheduler:get_next',
      { harness: 'papercusp' },
      { idempotencyKey: 'scheduler-catalog-bypass-timeout-1' },
    )).resolves.toEqual({ client, result });

    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.request.mock.calls[0][2]).toEqual({
      timeout: PTOOL_FOREGROUND_TOOL_TIMEOUT_MS,
      maxTotalTimeout: PTOOL_FOREGROUND_TOOL_TIMEOUT_MS,
    });
  });

  it('retries the exact pre-dispatch bearer refusal with the next implicit token and same key', async () => {
    const rejected = {
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: superuser_invalid_bearer' }],
    };
    const success = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const firstClient = { callTool: vi.fn(), request: vi.fn().mockResolvedValue(rejected), close: vi.fn() };
    const secondClient = { callTool: vi.fn(), request: vi.fn().mockResolvedValue(success), close: vi.fn() };
    const reconnectWithTokenPath = vi.fn().mockResolvedValue(secondClient);
    const tokenPaths = ['/workspace/superuser-token', '/home/tester/.papercusp/superuser-token'];

    await expect(dispatchScriptedToolWithoutCatalogWithTokenFallback(
      firstClient,
      'rubrics:get',
      { rubricRef: 'pot-coordination-health' },
      {
        idempotencyKey: 'catalog-bypass-auth-retry-1',
        tokenPaths,
        initialTokenPath: tokenPaths[0],
        reconnectWithTokenPath,
        timeoutMs: 7,
      },
    )).resolves.toEqual({ client: secondClient, result: success });

    expect(reconnectWithTokenPath).toHaveBeenCalledOnce();
    expect(reconnectWithTokenPath).toHaveBeenCalledWith(tokenPaths[1]);
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(firstClient.request.mock.calls).toEqual(secondClient.request.mock.calls);
    expect(secondClient.request.mock.calls[0][0].params._meta.idempotencyKey)
      .toBe('catalog-bypass-auth-retry-1');
  });

  it('keeps pinned-token and non-matching tool results terminal during catalog bypass', async () => {
    const authRefusal = {
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: superuser_invalid_bearer' }],
    };
    const reconnectWithTokenPath = vi.fn();
    const pinnedClient = { callTool: vi.fn(), request: vi.fn().mockResolvedValue(authRefusal), close: vi.fn() };

    await expect(dispatchScriptedToolWithoutCatalogWithTokenFallback(
      pinnedClient,
      'rubrics:get',
      {},
      {
        idempotencyKey: 'catalog-bypass-pinned-1',
        tokenPaths: ['/explicit/superuser-token'],
        initialTokenPath: '/explicit/superuser-token',
        reconnectWithTokenPath,
        timeoutMs: 7,
      },
    )).resolves.toEqual({ client: pinnedClient, result: authRefusal });
    expect(reconnectWithTokenPath).not.toHaveBeenCalled();

    const genericResult = {
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: tool_not_available' }],
    };
    const genericClient = { callTool: vi.fn(), request: vi.fn().mockResolvedValue(genericResult), close: vi.fn() };
    await expect(dispatchScriptedToolWithoutCatalogWithTokenFallback(
      genericClient,
      'rubrics:get',
      {},
      {
        idempotencyKey: 'catalog-bypass-other-error-1',
        tokenPaths: ['/workspace/superuser-token', '/home/tester/.papercusp/superuser-token'],
        initialTokenPath: '/workspace/superuser-token',
        reconnectWithTokenPath,
        timeoutMs: 7,
      },
    )).resolves.toEqual({ client: genericClient, result: genericResult });
    expect(reconnectWithTokenPath).not.toHaveBeenCalled();

    const listStyleBearerFailure = {
      isError: true,
      content: [{ type: 'text', text: 'mcp_auth_failed: superuser_invalid_bearer' }],
    };
    const listStyleClient = { callTool: vi.fn(), request: vi.fn().mockResolvedValue(listStyleBearerFailure), close: vi.fn() };
    await expect(dispatchScriptedToolWithoutCatalogWithTokenFallback(
      listStyleClient,
      'rubrics:get',
      {},
      {
        idempotencyKey: 'catalog-bypass-list-style-auth-1',
        tokenPaths: ['/workspace/superuser-token', '/home/tester/.papercusp/superuser-token'],
        initialTokenPath: '/workspace/superuser-token',
        reconnectWithTokenPath,
        timeoutMs: 7,
      },
    )).resolves.toEqual({ client: listStyleClient, result: listStyleBearerFailure });
    expect(reconnectWithTokenPath).not.toHaveBeenCalled();
  });

  it('skips an unavailable implicit token file and tries the next candidate', async () => {
    const authRefusal = {
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: superuser_invalid_bearer' }],
    };
    const success = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const firstClient = { callTool: vi.fn(), request: vi.fn().mockResolvedValue(authRefusal), close: vi.fn() };
    const finalClient = { callTool: vi.fn(), request: vi.fn().mockResolvedValue(success), close: vi.fn() };
    const tokenPaths = [
      '/workspace/superuser-token',
      '/home/tester/.papercusp/superuser-token',
      '/home/tester/.papercusp-fallback/superuser-token',
    ];
    const reconnectWithTokenPath = vi.fn()
      .mockRejectedValueOnce(new Error(
        `no superuser token at ${tokenPaths[1]} — is the operator installed?`,
      ))
      .mockResolvedValueOnce(finalClient);

    await expect(dispatchScriptedToolWithoutCatalogWithTokenFallback(
      firstClient,
      'rubrics:get',
      {},
      {
        idempotencyKey: 'catalog-bypass-missing-token-1',
        tokenPaths,
        initialTokenPath: tokenPaths[0],
        reconnectWithTokenPath,
        timeoutMs: 7,
      },
    )).resolves.toEqual({ client: finalClient, result: success });

    expect(reconnectWithTokenPath.mock.calls).toEqual([[tokenPaths[1]], [tokenPaths[2]]]);
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(firstClient.request.mock.calls).toEqual(finalClient.request.mock.calls);
  });

  it('labels the fallback as pre-dispatch while keeping scripted output on stdout', () => {
    const message = formatToolCatalogBypass(
      'rubrics:get',
      Object.assign(new Error('Request timed out'), { code: -32001 }),
    );

    expect(message).toContain('failure_stage=tools/list');
    expect(message).toContain('dispatching the supplied scripted arguments directly');
    expect(message).not.toContain('may have executed');
  });
});

describe('ptool keyed result recovery without concurrent replay', () => {
  it('authorizes replay only with a server-owned proof for the exact code:run body', () => {
    const params = buildCallToolParams('code:run', {
      timeoutSec: 10,
      script: 'return { ok: true };',
    }, { idempotencyKey: 'ptool-code-run-1' });
    const proof = {
      schemaVersion: 1,
      kind: 'settled-read',
      tool: 'code:run',
      callCount: 1,
      requestHash: codeRunRequestHash(params.arguments),
    };

    expect(isValidCodeRunReplayProof(proof, params)).toBe(true);
    expect(isValidCodeRunReplayProof(
      { ...proof, requestHash: codeRunRequestHash({ ...params.arguments, script: 'return 2;' }) },
      params,
    )).toBe(false);
    expect(isValidCodeRunReplayProof({
      schemaVersion: 1,
      kind: 'settled-read',
      tool: 'work_items:get',
      callCount: 1,
      requestHash: codeRunRequestHash(params.arguments),
    }, params)).toBe(false);
  });

  it('canonicalizes object-key order without weakening exact-body matching', () => {
    expect(codeRunRequestHash({ script: 'return 1;', timeoutSec: 10 }))
      .toBe(codeRunRequestHash({ timeoutSec: 10, script: 'return 1;' }));
    expect(codeRunRequestHash({ script: 'return 1;', timeoutSec: 10 }))
      .not.toBe(codeRunRequestHash({ script: 'return 1;', timeoutSec: 11 }));
  });

  it('puts one caller-supplied idempotency key beside the format metadata', () => {
    expect(buildCallToolParams('work_items:complete', { id: 'EI-1' }, {
      idempotencyKey: 'ptool-key-1',
    })).toEqual({
      name: 'work_items:complete',
      arguments: { id: 'EI-1' },
      _meta: { format: 'json', idempotencyKey: 'ptool-key-1' },
    });
  });

  it('echoes the serving generation advertised by tools/list in tools/call metadata', () => {
    const listedTool = {
      name: 'work_items:get',
      _meta: { 'papercusp/servingGeneration': 'serving-generation-v1:listed' },
    };
    expect(buildCallToolParams(listedTool.name, { id: 'EI-1' }, {
      outputSchema: { type: 'object' },
      idempotencyKey: 'ptool-generation-1',
      servingGeneration: listedTool._meta['papercusp/servingGeneration'],
    })).toEqual({
      name: 'work_items:get',
      arguments: { id: 'EI-1' },
      _meta: {
        structured: true,
        idempotencyKey: 'ptool-generation-1',
        'papercusp/servingGeneration': 'serving-generation-v1:listed',
      },
    });
  });

  it('refuses legacy tool listings that cannot enforce serving-generation compatibility', () => {
    expect(() => requireServingGeneration({ name: 'plans:bind-spec-evidence' }))
      .toThrow(/serving_generation_missing: plans:bind-spec-evidence .*incompatible legacy release/);
    try {
      requireServingGeneration({ name: 'plans:bind-spec-evidence' });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('serving_generation_missing');
    }
    expect(requireServingGeneration({
      name: 'plans:bind-spec-evidence',
      _meta: { 'papercusp/servingGeneration': ' serving-generation-v1:listed ' },
    })).toBe('serving-generation-v1:listed');
  });

  it('keeps tools:find reachable when a legacy catalog omits serving generation', () => {
    expect(requireServingGeneration({ name: 'tools:find' })).toBeUndefined();
    expect(buildCallToolParams('tools:find', { query: 'locks:acquire' }, {
      outputSchema: { type: 'object' },
      idempotencyKey: 'ptool-discovery-legacy-1',
      servingGeneration: requireServingGeneration({ name: 'tools:find' }),
    })).toEqual({
      name: 'tools:find',
      arguments: { query: 'locks:acquire' },
      _meta: { structured: true, idempotencyKey: 'ptool-discovery-legacy-1' },
    });
  });

  it('refreshes two consecutive stale contracts and preserves the unchanged call', async () => {
    const toolName = 'coord:inbox';
    const callArgs = { directed: true };
    const idempotencyKey = 'ptool-stale-generation-1';
    const inputSchema = { type: 'object', properties: { directed: { type: 'boolean' } } };
    const previousTool = {
      name: toolName,
      inputSchema,
      outputSchema: { type: 'object' },
      _meta: { 'papercusp/servingGeneration': 'serving-generation-v1:old' },
    };
    const firstRefreshedTool = {
      ...previousTool,
      _meta: { 'papercusp/servingGeneration': 'serving-generation-v1:middle' },
    };
    const secondRefreshedTool = {
      ...previousTool,
      _meta: { 'papercusp/servingGeneration': 'serving-generation-v1:new' },
    };
    const originalParams = buildCallToolParams(toolName, callArgs, {
      outputSchema: previousTool.outputSchema,
      servingGeneration: previousTool._meta['papercusp/servingGeneration'],
      idempotencyKey,
    });
    const firstStaleFailure = Object.assign(new Error('stale_tool_contract'), {
      code: 'stale_tool_contract',
    });
    const secondStaleFailure = Object.assign(new Error('stale_tool_contract'), {
      code: 'stale_tool_contract',
    });
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const client = {
      callTool: vi.fn()
        .mockRejectedValueOnce(firstStaleFailure)
        .mockRejectedValueOnce(secondStaleFailure)
        .mockResolvedValueOnce(result),
    };
    const listTools = vi.fn()
      .mockResolvedValueOnce([firstRefreshedTool])
      .mockResolvedValueOnce([secondRefreshedTool]);
    let currentTool = previousTool;
    const onStaleToolContract = vi.fn(async ({ client: staleClient, error }) => {
      const refreshed = await refreshToolCallAfterStaleContract({
        client: staleClient,
        toolName,
        previousTool: currentTool,
        callArgs,
        idempotencyKey,
        listTools,
        error,
      });
      currentTool = refreshed.tool;
      return refreshed.params;
    });
    const reconnect = vi.fn();

    await expect(callToolWithReplayRecovery(client, originalParams, {
      reconnect,
      onStaleToolContract,
      timeoutMs: 5,
    })).resolves.toEqual({ client, result });

    const firstRefreshedParams = buildCallToolParams(toolName, callArgs, {
      outputSchema: firstRefreshedTool.outputSchema,
      servingGeneration: firstRefreshedTool._meta['papercusp/servingGeneration'],
      idempotencyKey,
    });
    const secondRefreshedParams = buildCallToolParams(toolName, callArgs, {
      outputSchema: secondRefreshedTool.outputSchema,
      servingGeneration: secondRefreshedTool._meta['papercusp/servingGeneration'],
      idempotencyKey,
    });
    expect(client.callTool).toHaveBeenNthCalledWith(
      1,
      originalParams,
      undefined,
      { timeout: 5, maxTotalTimeout: 5 },
    );
    expect(client.callTool).toHaveBeenNthCalledWith(
      2,
      firstRefreshedParams,
      undefined,
      { timeout: 5, maxTotalTimeout: 5 },
    );
    expect(client.callTool).toHaveBeenNthCalledWith(
      3,
      secondRefreshedParams,
      undefined,
      { timeout: 5, maxTotalTimeout: 5 },
    );
    for (const refreshedParams of [firstRefreshedParams, secondRefreshedParams]) {
      expect(refreshedParams.arguments).toEqual(originalParams.arguments);
      expect(refreshedParams._meta.idempotencyKey).toBe(originalParams._meta.idempotencyKey);
    }
    expect(firstRefreshedParams._meta['papercusp/servingGeneration']).toBe('serving-generation-v1:middle');
    expect(secondRefreshedParams._meta['papercusp/servingGeneration']).toBe('serving-generation-v1:new');
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(listTools).toHaveBeenNthCalledWith(1, client);
    expect(listTools).toHaveBeenNthCalledWith(2, client);
    expect(onStaleToolContract).toHaveBeenCalledTimes(2);
    expect(onStaleToolContract).toHaveBeenNthCalledWith(1, {
      client,
      params: originalParams,
      error: firstStaleFailure,
    });
    expect(onStaleToolContract).toHaveBeenNthCalledWith(2, {
      client,
      params: firstRefreshedParams,
      error: secondStaleFailure,
    });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('does not replay a stale call when the refreshed input schema changed', async () => {
    const toolName = 'coord:inbox';
    const callArgs = { directed: true };
    const idempotencyKey = 'ptool-stale-generation-schema-change';
    const previousTool = {
      name: toolName,
      inputSchema: { type: 'object', properties: { directed: { type: 'boolean' } } },
      outputSchema: { type: 'object' },
    };
    const refreshedTool = {
      ...previousTool,
      inputSchema: { type: 'object', properties: { directed: { type: 'string' } } },
      _meta: { 'papercusp/servingGeneration': 'serving-generation-v1:new' },
    };
    const staleFailure = Object.assign(new Error('stale_tool_contract'), {
      code: 'stale_tool_contract',
    });
    const client = { callTool: vi.fn().mockRejectedValueOnce(staleFailure) };
    const listTools = vi.fn().mockResolvedValue([refreshedTool]);
    const params = buildCallToolParams(toolName, callArgs, {
      outputSchema: previousTool.outputSchema,
      servingGeneration: 'serving-generation-v1:old',
      idempotencyKey,
    });

    await expect(callToolWithReplayRecovery(client, params, {
      onStaleToolContract: ({ client: staleClient, error }) => refreshToolCallAfterStaleContract({
        client: staleClient,
        toolName,
        previousTool,
        callArgs,
        idempotencyKey,
        listTools,
        error,
      }).then((refreshed) => refreshed.params),
    })).rejects.toThrow('The input schema changed; inspect the current schema before retrying.');

    expect(client.callTool).toHaveBeenCalledExactlyOnceWith(params, undefined, {
      timeout: 30000,
      maxTotalTimeout: 30000,
    });
    expect(listTools).toHaveBeenCalledExactlyOnceWith(client);
  });

  it('stops after two stale-contract refreshes', async () => {
    const params = buildCallToolParams('coord:inbox', { directed: true }, {
      idempotencyKey: 'ptool-stale-generation-2',
      servingGeneration: 'serving-generation-v1:old',
    });
    const firstFailure = Object.assign(new Error('stale_tool_contract'), {
      code: 'stale_tool_contract',
    });
    const secondFailure = Object.assign(new Error('stale_tool_contract'), {
      code: 'stale_tool_contract',
    });
    const thirdFailure = Object.assign(new Error('stale_tool_contract'), {
      code: 'stale_tool_contract',
    });
    const client = {
      callTool: vi.fn()
        .mockRejectedValueOnce(firstFailure)
        .mockRejectedValueOnce(secondFailure)
        .mockRejectedValueOnce(thirdFailure),
    };
    const refreshedParams = buildCallToolParams('coord:inbox', { directed: true }, {
      idempotencyKey: 'ptool-stale-generation-2',
      servingGeneration: 'serving-generation-v1:new',
    });
    const onStaleToolContract = vi.fn().mockResolvedValue(refreshedParams);

    await expect(callToolWithReplayRecovery(client, params, {
      onStaleToolContract,
      timeoutMs: 5,
    })).rejects.toBe(thirdFailure);

    expect(client.callTool).toHaveBeenCalledTimes(3);
    expect(onStaleToolContract).toHaveBeenCalledTimes(2);
    expect(onStaleToolContract).toHaveBeenNthCalledWith(1, {
      client,
      params,
      error: firstFailure,
    });
    expect(onStaleToolContract).toHaveBeenNthCalledWith(2, {
      client,
      params: refreshedParams,
      error: secondFailure,
    });
  });

  it('negotiates projected object-schema calls as JSON instead of requesting the unprojected structured twin', () => {
    expect(buildCallToolParams(
      'sessions:read',
      { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      { outputSchema: { type: 'object' }, idempotencyKey: 'ptool-projected-1' },
    )).toEqual({
      name: 'sessions:read',
      arguments: { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      _meta: { format: 'json', idempotencyKey: 'ptool-projected-1' },
    });
  });

  it('uses schema-neutral MCP request validation for a projected call', async () => {
    const result = { content: [{ type: 'text', text: '{"turns":[{"turn_idx":1}]}' }] };
    const client = {
      callTool: vi.fn(),
      request: vi.fn().mockResolvedValue(result),
    };
    const params = buildCallToolParams(
      'sessions:read',
      { session: 'sess-1', projection: { pick: ['turns[].turn_idx'] } },
      { outputSchema: { type: 'object' } },
    );

    await expect(callToolWithPressureRetry(client, params, {
      maxAttempts: 1,
      timeoutMs: 1,
    })).resolves.toBe(result);

    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toEqual({ method: 'tools/call', params });
    expect(client.request.mock.calls[0][2]).toEqual({ timeout: 1, maxTotalTimeout: 1 });
  });

  it('recognizes MCP stream-close/deadline failures but not tool errors', () => {
    expect(isTransportFailure(Object.assign(new Error('Connection closed'), { code: -32000 }))).toBe(true);
    expect(isTransportFailure(Object.assign(new Error('Request timed out'), { code: -32001 }))).toBe(true);
    expect(isTransportFailure(new Error('MCP error -32602: invalid arguments'))).toBe(false);
    expect(isTransportFailure(new Error('tool failed after dispatch'))).toBe(false);
  });

  it.each([
    ['docs:search', 'docs:search'],
    ['docs:search', 'tools:invoke'],
    ['plans:evaluate-spec-quality', 'plans:evaluate-spec-quality'],
    ['plans:evaluate-spec-quality', 'tools:invoke'],
    ['scorecards:evaluate', 'scorecards:evaluate'],
    ['scorecards:evaluate', 'tools:invoke'],
    ['rubrics:get', 'rubrics:get'],
    ['rubrics:get', 'tools:invoke'],
    ['facts:list', 'facts:list'],
    ['facts:list', 'tools:invoke'],
    ['conversations:get', 'conversations:get'],
    ['conversations:get', 'tools:invoke'],
  ])('delivers a valid %s after 35 seconds through %s without replay', async (toolName, route) => {
    vi.useFakeTimers();
    try {
      const inputs: Record<string, Record<string, unknown>> = {
        'docs:search': { query: 'disk consumer census', harness: 'engineering', limit: 3, semantic: false },
        'plans:evaluate-spec-quality': { slug: 'quality-plan', harness: 'engineering' },
        'scorecards:evaluate': { rubricRef: 'papercusp-app-performance', eligibilityOnly: true },
        'rubrics:get': { rubricRef: 'papercusp-app-performance' },
        'facts:list': { scope: 'workspace' },
        'conversations:get': { id: 'conversation-1' },
      };
      const toolArgs = inputs[toolName];
      const args = route === 'tools:invoke' ? { name: toolName, args: toolArgs } : toolArgs;
      const params = buildCallToolParams(route, args, { idempotencyKey: 'bounded-read-delayed' });
      const result = { content: [{ type: 'text', text: 'retained structured result' }] };
      const delayedClient = () => ({
        callTool: vi.fn((_params: unknown, _schema: unknown, options: { timeout: number; maxTotalTimeout: number }) =>
          new Promise((resolve, reject) => {
            const deadline = setTimeout(() => {
              clearTimeout(response);
              reject(Object.assign(new Error('Request timed out'), { code: -32001 }));
            }, Math.min(options.timeout, options.maxTotalTimeout));
            const response = setTimeout(() => {
              clearTimeout(deadline);
              resolve(result);
            }, 35_123);
          })),
      });

      // Independent negative control: the old client budget loses the valid
      // response even though it arrives within the server's foreground window.
      const oldFailure = expect(callToolWithReplayRecovery(delayedClient(), params, {
        timeoutMs: PTOOL_CALL_TOOL_TIMEOUT_MS,
      })).rejects.toThrow('Request timed out');
      await vi.advanceTimersByTimeAsync(35_123);
      await oldFailure;

      const client = delayedClient();
      const reconnect = vi.fn();
      const timeoutMs = timeoutForTool(route, args);
      const delivered = expect(callToolWithReplayRecovery(client, params, { timeoutMs, reconnect }))
        .resolves.toMatchObject({ result });
      await vi.advanceTimersByTimeAsync(35_123);
      await delivered;
      expect(timeoutMs).toBeGreaterThan(55_000);
      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after a post-connect close while the original may still be running', async () => {
    const params = buildCallToolParams('work_items:complete', { id: 'EI-1' }, {
      idempotencyKey: 'ptool-key-1',
    });
    const failure = Object.assign(new Error('Connection closed'), { code: -32000 });
    const first = {
      callTool: vi.fn().mockRejectedValue(failure),
      close: vi.fn(),
    };
    const reconnect = vi.fn();
    const onStaleToolContract = vi.fn();

    await expect(callToolWithReplayRecovery(first, params, {
      reconnect,
      onStaleToolContract,
      timeoutMs: 1,
    })).rejects.toBe(failure);

    expect(PTOOL_POST_CONNECT_RETRIES).toBe(0);
    expect(reconnect).not.toHaveBeenCalled();
    expect(onStaleToolContract).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    expect(first.callTool).toHaveBeenCalledWith(params, undefined, { timeout: 1, maxTotalTimeout: 1 });
  });

  it('reconnects once after a pre-connect ECONNREFUSED proves the tool was not dispatched', async () => {
    const params = buildCallToolParams('coord:declare-intent', {
      intent: 'resume after the operator restart',
      items: [],
    }, { idempotencyKey: 'ptool-pre-connect-refused-1' });
    const refusal = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3170' },
    });
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const first = {
      callTool: vi.fn().mockRejectedValue(refusal),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const second = {
      callTool: vi.fn().mockResolvedValue(result),
      close: vi.fn(),
    };
    const reconnect = vi.fn().mockResolvedValue(second);

    await expect(callToolWithReplayRecovery(first, params, {
      reconnect,
      timeoutMs: 1,
    })).resolves.toEqual({ client: second, result });

    expect(first.callTool).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(second.callTool).toHaveBeenCalledWith(params, undefined, { timeout: 1, maxTotalTimeout: 1 });
  });

  it('bounds pre-connect refusal recovery to one reconnect attempt', async () => {
    const refusal = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3170' },
    });
    const first = {
      callTool: vi.fn().mockRejectedValue(refusal),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const second = {
      callTool: vi.fn().mockRejectedValue(refusal),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const reconnect = vi.fn().mockResolvedValue(second);

    await expect(callToolWithReplayRecovery(first, buildCallToolParams('coord:declare-intent', {}), {
      reconnect,
      timeoutMs: 1,
    })).rejects.toBe(refusal);

    expect(first.callTool).toHaveBeenCalledTimes(1);
    expect(second.callTool).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not retry ECONNREFUSED text in a proxy HTTP response with unknown forwarding outcome', async () => {
    const params = buildCallToolParams('coord:declare-intent', {});
    const upstreamError = Object.assign(new Error(
      'Streamable HTTP error: {"error":"mcp_proxy_upstream_error","forwardingResult":"outcome_unknown","detail":"ECONNREFUSED after upstream connected"}',
    ), { code: 502 });
    const client = {
      callTool: vi.fn().mockRejectedValue(upstreamError),
      close: vi.fn(),
    };
    const reconnect = vi.fn();

    await expect(callToolWithReplayRecovery(client, params, {
      reconnect,
      timeoutMs: 1,
    })).rejects.toBe(upstreamError);

    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('replays one exact code:run body only through the explicit proof helper', async () => {
    const params = buildCallToolParams('code:run', { script: 'return { ok: true };' }, {
      idempotencyKey: 'ptool-code-run-key-1',
    });
    const failure = Object.assign(new Error('fetch failed'), { code: 'UND_ERR_SOCKET' });
    const first = {
      callTool: vi.fn().mockRejectedValue(failure),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const second = {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] }),
      close: vi.fn(),
    };
    const reconnect = vi.fn().mockResolvedValue(second);
    const proof = {
      schemaVersion: 1,
      kind: 'settled-read',
      tool: 'code:run',
      callCount: 1,
      requestHash: codeRunRequestHash(params.arguments),
    };

    const recovered = await retryCodeRunWithProof(first, params, proof, {
      reconnect,
      timeoutMs: 1,
    });

    expect(recovered).toEqual({ client: second, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(second.callTool).toHaveBeenCalledWith(params, undefined, { timeout: 1, maxTotalTimeout: 1 });
  });

  it('refuses explicit replay when the proof body does not match', async () => {
    const params = buildCallToolParams('code:run', { script: 'return 1;' });
    const client = { callTool: vi.fn(), close: vi.fn() };
    const proof = {
      schemaVersion: 1,
      kind: 'settled-read',
      tool: 'code:run',
      callCount: 1,
      requestHash: codeRunRequestHash({ script: 'return 2;' }),
    };

    await expect(retryCodeRunWithProof(client, params, proof, { timeoutMs: 1 }))
      .rejects.toThrow('valid server-owned settled-read proof');
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('cannot re-enable automatic replay with a larger per-call retry budget', async () => {
    const firstError = Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' });
    const first = { callTool: vi.fn().mockRejectedValue(firstError), close: vi.fn() };
    const reconnect = vi.fn();
    const params = buildCallToolParams('coord:send', {}, { idempotencyKey: 'ptool-key-2' });

    await expect(callToolWithReplayRecovery(first, params, { reconnect, maxAttempts: 99 })).rejects.toBe(firstError);
    expect(PTOOL_POST_CONNECT_RETRIES).toBe(0);
    expect(reconnect).not.toHaveBeenCalled();
    expect(first.callTool).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
  });
});

describe('ptool result formatting', () => {
  it('prints structuredContent when the MCP response has no content blocks', async () => {
    expect(resultToText({ structuredContent: { ok: true, value: 7 } }))
      .toBe('{"ok":true,"value":7}');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ structuredContent: { ok: true } }, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('prefers complete structuredContent over lossy text content', () => {
    expect(resultToText({
      content: [{ type: 'text', text: '{"items":[\n[result-door: truncated]' }],
      structuredContent: { items: [{ id: 'P-001' }] },
    })).toBe('{"items":[{"id":"P-001"}]}');
  });

  it('fails loudly instead of emitting a result-door-truncated JSON prefix', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = {
        content: [{
          type: 'text',
          text: '{"items":[{"id":"P-001"},\n[result-door: this result exceeded the token budget and was truncated.',
        }],
      };
      expect(await printResult(result, { raw: true })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(PTOOL_TRUNCATED_RESULT_MESSAGE);
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('may have executed');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('verify its state before retrying');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).not.toContain('narrow the query');
      expect(PTOOL_TRUNCATED_RESULT_MESSAGE).not.toContain('jq');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('keeps appended advisory content off raw stdout so jq can parse the payload', async () => {
    const result = {
      content: [
        { type: 'text', text: '{"ok":true,"value":7}' },
        { type: 'text', text: 'See also: loop:arm (start a loop)' },
      ],
    };

    expect(resultToText(result, { raw: true })).toBe('{"ok":true,"value":7}');
    expect(resultToText(result, { raw: false })).toBe(
      '{"ok":true,"value":7}\nSee also: loop:arm (start a loop)',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult(result, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true,"value":7}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('emits a leading projection warning on stderr while keeping raw stdout parseable', async () => {
    const warning =
      '⚠ pick path(s) matched nothing: this.is.absent — those field(s) are ABSENT from the body below.';
    const result = {
      content: [
        { type: 'text', text: warning },
        { type: 'text', text: '{"cells":[{"cell":"agent.goal"}]}' },
      ],
      _meta: {
        resultProjection: {
          applied: true,
          notes: [warning],
        },
      },
    };

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult(result, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith('{"cells":[{"cell":"agent.goal"}]}');
      expect(error).toHaveBeenCalledWith(warning);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('fails loudly instead of exiting zero with blank stdout for an empty response', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ content: [] }, { raw: true })).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        'ptool: operator returned an empty MCP result; no content or structuredContent was received',
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  describe('an ok:false answer exits PTOOL_TOOL_NOT_OK_EXIT, not 0 (EI-24654733539966460)', () => {
    // The drill that found this: `ptool work_items:create … || fail` wrote a refusal and
    // exited 0, so the phase waited 900s for a write that never existed.
    const refusedCreate = {
      ok: false,
      results: [{ ok: false, error: 'duplicate key value violates unique constraint work_items_keyless_title_identity_uq' }],
    };

    async function run(result: unknown, raw: boolean) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const code = await printResult(result, { raw, deliveryProbe: () => null });
        return { code, stdout: log.mock.calls.map((c) => c[0]), stderr: error.mock.calls.map((c) => String(c[0])) };
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    }

    it('is a distinct non-zero status, not the generic failure code', () => {
      expect(PTOOL_TOOL_NOT_OK_EXIT).not.toBe(0);
      expect(PTOOL_TOOL_NOT_OK_EXIT).not.toBe(1);
    });

    it('a refused write exits non-zero and still prints the complete result', async () => {
      for (const raw of [true, false]) {
        const out = await run({ structuredContent: refusedCreate }, raw);
        expect(out.code).toBe(PTOOL_TOOL_NOT_OK_EXIT);
        expect(JSON.parse(String(out.stdout[0]))).toEqual(refusedCreate);
        expect(out.stderr.join('\n')).toContain('work_items_keyless_title_identity_uq');
      }
    });

    it('one failed entry in an otherwise-ok batch fails the call', async () => {
      const batch = { ok: true, results: [{ ok: true, id: 'A' }, { ok: false, id: 'B', error: 'not found' }] };
      const out = await run({ content: [{ type: 'text', text: JSON.stringify(batch) }] }, true);
      expect(out.code).toBe(PTOOL_TOOL_NOT_OK_EXIT);
      expect(out.stderr.join('\n')).toContain('1 of 2 result(s) ok:false; first: not found');
    });

    it('an ok answer, and a body with no ok field at all, still exit 0 (calibration)', async () => {
      expect((await run({ structuredContent: { ok: true, results: [{ ok: true }] } }, true)).code).toBe(0);
      // A --projection pick that dropped `ok` is not a refusal.
      expect((await run({ structuredContent: { results: [{ id: 'A' }] } }, true)).code).toBe(0);
      expect(toolNotOkReason('{"ok":null}')).toBeNull();
      expect(toolNotOkReason('prose, not JSON')).toBeNull();
    });

    it('names the top-level reason when there is no batch', () => {
      expect(toolNotOkReason(JSON.stringify({ ok: false, reason: 'loops_disabled' }))).toBe('loops_disabled');
      expect(toolNotOkReason(JSON.stringify({ ok: false }))).toBe('no reason given');
    });
  });

  it('escapes raw controls inside JSON text for jq-safe raw output', async () => {
    const nul = String.fromCharCode(0);
    const raw = `{"message":"before${nul}after\nline"}`;
    const repaired = sanitizeJsonText(raw);

    expect(JSON.parse(repaired)).toEqual({ message: `before${nul}after\nline` });
    expect(repaired).toContain('\\u0000');
    expect(repaired).toContain('\\u000a');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ content: [{ type: 'text', text: raw }] }, { raw: true })).toBe(0);
      expect(log).toHaveBeenCalledWith(repaired);
      expect(await printResult({ content: [{ type: 'text', text: raw }] }, { raw: false })).toBe(0);
      expect(log).toHaveBeenLastCalledWith(JSON.stringify(JSON.parse(repaired), null, 2));
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('leaves non-JSON text unchanged', () => {
    const text = `plain${String.fromCharCode(0)}text`;
    expect(sanitizeJsonText(text)).toBe(text);
  });

  it('repairs a truncated JSON prefix without requiring a valid whole document', () => {
    const truncated = '{"message":"first\nsecond';
    expect(sanitizeJsonText(truncated)).toBe('{"message":"first\\u000asecond');
  });
});

describe('ptool --json output-envelope unwrap (EI-22212780570913684)', () => {
  it('prints a complete durable code:run admission as a successful actionable receipt', async () => {
    const workflowId = 'orchestrate-durable:ws-code:admission-1';
    const next = 'Read status/output with orchestrate:inspect { durableRun:{workflowId} }';
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'complete',
      summaryProvenance: 'authored',
      summary: JSON.stringify({ durableRun: { workflowId, status: 'admitted' } }),
      next,
      content: [],
    };
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await printResult(
        { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
        { raw: true },
      );
      expect(code).toBe(0);
      expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0]))).toEqual({
        ok: true,
        durableRun: { workflowId, status: 'admitted' },
        next,
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      printed.mockRestore();
      errors.mockRestore();
    }
  });

  it('does not treat a failed durable admission as accepted', async () => {
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'error',
      summaryProvenance: 'authored',
      summary: JSON.stringify({ ok: false, error: 'durable admission refused' }),
      content: [],
    };
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult(
        { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
        { raw: true },
      )).toBe(1);
      expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0]))).toEqual(envelope);
      expect(errors.mock.calls.flat().join(' ')).toContain('outcome unknown');
    } finally {
      printed.mockRestore();
      errors.mockRestore();
    }
  });

  it.each(['failed', 'uncertain'])(
    'does not reinterpret a later durable workflow state of %s as admission success',
    async (status) => {
      const envelope = {
        schemaVersion: 'papercusp.output-envelope/v1',
        state: 'complete',
        summaryProvenance: 'authored',
        summary: JSON.stringify({
          durableRun: { workflowId: 'orchestrate-durable:ws-code:admission-1', status },
        }),
        content: [],
      };
      const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await printResult(
          { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
          { raw: true },
        )).toBe(1);
        expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0]))).toEqual(envelope);
        expect(errors.mock.calls.flat().join(' ')).toContain('outcome unknown');
      } finally {
        printed.mockRestore();
        errors.mockRestore();
      }
    },
  );

  it.each(['scratch-memory', 'scratch-spool'])(
    'recovers a release response from %s byte pages after the primary spill failed', async (scheme) => {
      const uri = `papercusp://${scheme}/release-result`;
      const release = { ok: true, results: [{ ok: true, released: ['tests/café.ts'] }], counts: { ok: 1, failed: 0 } };
      const prefix = '# scratch recovery body\n';
      const payload = Buffer.from(prefix + JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(release) }] }));
      const split = payload.indexOf(Buffer.from('é')) + 1;
      const readReference = vi.fn(async (args: { uri: string; byte_offset: number }) => {
        const start = args.byte_offset;
        const end = start === 0 ? split : payload.length;
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, encoding: 'base64', data: payload.subarray(start, end).toString('base64'),
          byte_offset: start, byte_length: end - start, total_bytes: payload.length,
          eof: end === payload.length, reference: { bodyOffsetInPayload: Buffer.byteLength(prefix) },
          next_cursor: end === payload.length ? null : {
            tool: 'capability:read', args: { uri, byte_offset: end, byte_limit: 3072 },
          },
        }) }] };
      });
      const envelope = {
        schemaVersion: 'papercusp.output-envelope/v1', state: 'incomplete',
        content: [{ kind: 'evidence-reference', uri, preview: '{"ok":false,"reason":"never trust preview"}' }],
        _projection: { cursor: { args: { uri, byte_offset: 0, byte_limit: 3072 } } },
      };
      const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(await printResult({ content: [{ type: 'text', text: JSON.stringify(envelope) }] }, {
          raw: true, readReference,
        })).toBe(0);
        expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0]))).toEqual(release);
        expect(readReference.mock.calls.map(([args]) => args)).toEqual([
          { uri, byte_offset: 0, byte_limit: 3072 },
          { uri, byte_offset: split, byte_limit: 3072 },
        ]);
      } finally {
        printed.mockRestore();
      }
    },
  );

  it.each(['canonical', 'changed-cursor-path', 'changed-page-path', 'wrong-offset'])(
    'recovers remote scratch file pages only with stable canonical custody: %s', async (mode) => {
      const uri = 'papercusp://scratch/workspace/sessions:digest/run/result.spill';
      const filePath = '/operator/scratch/workspace/sessions:digest/run/result.spill';
      const result = { ok: true, digests: [{ kickoff: 'café' }], count: 1 };
      const payload = Buffer.from(JSON.stringify({ content: [
        { type: 'text', text: 'See also: sessions:read' },
        { type: 'text', text: JSON.stringify(result) },
      ] }));
      const split = payload.indexOf(Buffer.from('é')) + 1;
      const readReference = vi.fn(async (args: { uri?: string; file_path?: string; byte_offset: number }) => {
        const start = args.byte_offset;
        const end = start === 0 ? split : payload.length;
        return {
          ok: true, encoding: 'base64', data: payload.subarray(start, end).toString('base64'),
          file_path: start > 0 && mode === 'changed-page-path' ? filePath + '.other' : filePath,
          byte_offset: start, byte_length: end - start, total_bytes: payload.length,
          eof: end === payload.length, reference: { bodyOffsetInPayload: 0 },
          next_cursor: end === payload.length ? null : {
            tool: 'capability:read', args: {
              file_path: mode === 'changed-cursor-path' ? filePath + '.other' : filePath,
              byte_offset: mode === 'wrong-offset' ? end + 1 : end, byte_limit: 3072,
            },
          },
        };
      });
      const envelope = {
        schemaVersion: 'papercusp.output-envelope/v1',
        content: [{ kind: 'reference', uri, preview: '{"ok":false}' }],
      };
      const decoded = await unwrapOutputEnvelope(envelope, { fileExists: () => false, readReference });
      if (mode === 'canonical') {
        expect(decoded).toEqual(result);
        expect(readReference.mock.calls.map(([args]) => args)).toEqual([
          { uri, byte_offset: 0, byte_limit: 3072 },
          { file_path: filePath, byte_offset: split, byte_limit: 3072 },
        ]);
      } else {
        expect(decoded).toBe(envelope);
        expect(readReference).toHaveBeenCalledTimes(mode === 'changed-page-path' ? 2 : 1);
      }
    },
  );

  it('keeps a recovered release refusal as a refusal', async () => {
    const uri = 'papercusp://scratch-spool/refused-release';
    const payload = Buffer.from(JSON.stringify({ content: [{ type: 'text', text: '{"ok":false,"reason":"not_owner"}' }] }));
    const readReference = vi.fn(async () => ({
      ok: true, encoding: 'base64', data: payload.toString('base64'), byte_offset: 0,
      byte_length: payload.length, total_bytes: payload.length, eof: true, next_cursor: null,
    }));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = { content: [{ type: 'text', text: JSON.stringify({
        schemaVersion: 'papercusp.output-envelope/v1', content: [{ kind: 'reference', uri }],
      }) }] };
      expect(await printResult(result, { raw: true, readReference })).toBe(PTOOL_TOOL_NOT_OK_EXIT);
      expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0]))).toEqual({ ok: false, reason: 'not_owner' });
      expect(readReference).toHaveBeenCalledTimes(1);
    } finally {
      printed.mockRestore();
      errors.mockRestore();
    }
  });

  it.each([true, false])('refuses an unavailable reference in raw=%s output without treating its preview as proof', async (raw) => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = { content: [{ type: 'text', text: JSON.stringify({
        schemaVersion: 'papercusp.output-envelope/v1',
        content: [{ kind: 'reference', uri: 'papercusp://scratch-spool/expired', preview: '{"ok":true}' }],
      }) }] };
      const readReference = vi.fn(async () => ({ ok: false, reason: 'expired' }));
      expect(await printResult(result, { raw, readReference })).toBe(1);
      expect(errors.mock.calls.flat().join(' ')).toContain('may have executed');
      expect(readReference).toHaveBeenCalledTimes(1);
    } finally {
      printed.mockRestore();
      errors.mockRestore();
    }
  });

  it('rejects recovered bytes that differ from the reference digest', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const payload = Buffer.from('{"ok":true}');
      const result = { content: [{ type: 'text', text: JSON.stringify({
        schemaVersion: 'papercusp.output-envelope/v1',
        content: [{ kind: 'reference', uri: 'papercusp://scratch-memory/corrupt', sha256: '0'.repeat(64) }],
      }) }] };
      const readReference = vi.fn(async () => ({
        ok: true, encoding: 'base64', data: payload.toString('base64'), byte_offset: 0,
        byte_length: payload.length, total_bytes: payload.length, eof: true, next_cursor: null,
      }));
      expect(await printResult(result, { raw: true, readReference })).toBe(1);
      expect(errors.mock.calls.flat().join(' ')).toContain('outcome unknown');
    } finally {
      printed.mockRestore();
      errors.mockRestore();
    }
  });

  it('reports an unavailable or inconsistent recovery as unknown outcome, never successful JSON', async () => {
    const uri = 'papercusp://scratch-memory/unavailable-release';
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const page of [
        { ok: false, reason: 'expired' },
        { ok: true, encoding: 'base64', data: 'e30=', byte_offset: 9, byte_length: 2, total_bytes: 2, eof: true },
      ]) {
        const readReference = vi.fn(async () => page);
        const result = { content: [{ type: 'text', text: JSON.stringify({
          schemaVersion: 'papercusp.output-envelope/v1', state: 'incomplete',
          content: [{ kind: 'reference', uri, preview: '{"ok":true}' }],
        }) }] };
        expect(await printResult(result, { raw: true, readReference })).not.toBe(0);
        expect(errors.mock.calls.flat().join(' ')).toContain('may have executed');
        expect(readReference).toHaveBeenCalledTimes(1);
      }
    } finally {
      printed.mockRestore();
      errors.mockRestore();
    }
  });

  it('is a no-op on a plain result (same reference)', async () => {
    const result = { ok: true, value: 7 };
    expect(await unwrapOutputEnvelope(result)).toBe(result);
  });

  it('is a no-op on a result that happens to carry its own content array + ok', async () => {
    const result = { ok: true, content: [{ type: 'text', text: 'hi' }] };
    expect(await unwrapOutputEnvelope(result)).toBe(result);
  });

  it('unwraps an INLINE envelope (no spill) to the real tool result', async () => {
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      content: [
        { type: 'text', text: '{"ok":true,"lock_id":"94ed8996-abc"}' },
        { type: 'text', text: 'See also: locks:release' },
      ],
    };
    expect(await unwrapOutputEnvelope(envelope)).toEqual({ ok: true, lock_id: '94ed8996-abc' });
  });

  it('preserves outer server metadata while unwrapping inline JSON', async () => {
    const proof = {
      schemaVersion: 1,
      kind: 'settled-read',
      tool: 'code:run',
      callCount: 1,
      requestHash: 'a'.repeat(64),
    };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      _meta: { codeRunReplayProof: proof, resultProjection: { applied: true } },
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          _meta: { codeRunReplayProof: { callerAuthored: true }, innerOnly: true },
        }),
      }],
    };

    expect(await unwrapOutputEnvelope(envelope)).toEqual({
      ok: true,
      _meta: { codeRunReplayProof: proof, innerOnly: true, resultProjection: { applied: true } },
    });
  });

  it('unwraps a SPILLED envelope by reading the referenced file, scanning for the parseable part (never trusting position)', async () => {
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      content: [{
        kind: 'reference',
        uri: 'papercusp://scratch/papercusp-workspace/locks:acquire/5084d585-0000-4000-8000-000000000000/result-door-123.spill',
        preview: '{"ok":true,"lock_id":"94ed8996-...',
      }],
    };
    // NOT index 0 — proves the unwrap scans instead of trusting position, same
    // as the "See also:" advisory text landing before the payload in practice.
    const spilledPayload = {
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: '{"ok":true,"lock_id":"94ed8996-full-id"}' },
      ],
    };
    const readSpill = vi.fn().mockResolvedValue(spilledPayload);
    const fileExists = vi.fn().mockReturnValue(true);
    expect(await unwrapOutputEnvelope(envelope, { readSpill, fileExists })).toEqual({
      ok: true,
      lock_id: '94ed8996-full-id',
    });
    expect(readSpill).toHaveBeenCalledWith(
      expect.stringContaining('locks:acquire/5084d585-0000-4000-8000-000000000000/result-door-123.spill'),
    );
  });

  it('preserves outer server metadata while unwrapping spilled JSON', async () => {
    const proof = {
      schemaVersion: 1,
      kind: 'settled-read',
      tool: 'code:run',
      callCount: 1,
      requestHash: 'b'.repeat(64),
    };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      _meta: { codeRunReplayProof: proof, outerOnly: 'kept' },
      content: [{
        kind: 'evidence-reference',
        uri: 'papercusp://scratch/ws/tool/00000000-0000-4000-8000-000000000000/result.spill',
      }],
    };
    const readSpill = vi.fn().mockResolvedValue({
      _meta: {
        codeRunReplayProof: { callerAuthored: true },
        spilledOnly: 'kept',
      },
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });

    expect(await unwrapOutputEnvelope(envelope, {
      readSpill,
      fileExists: () => true,
    })).toEqual({
      ok: true,
      _meta: { codeRunReplayProof: proof, outerOnly: 'kept', spilledOnly: 'kept' },
    });
  });

  it('reads a host operator spill when the session has a different workspace home', async () => {
    const suffix = 'ws/code:run/00000000-0000-4000-8000-000000000000/result.spill';
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{ kind: 'reference', uri: `papercusp://scratch/${suffix}` }],
    };
    const hostPath = join(homedir(), '.papercusp', 'scratch', suffix);
    const readSpill = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, summary: { report: 'preserved' } }) }],
    });
    expect(await unwrapOutputEnvelope(envelope, {
      env: { PAPERCUSP_HOME: '/tmp/workspace-home' },
      fileExists: path => path === hostPath,
      readSpill,
    })).toEqual({ ok: true, summary: { report: 'preserved' } });
    expect(readSpill).toHaveBeenCalledExactlyOnceWith(hostPath);
  });

  it('prefers the scoped file and never searches outside an explicit scratch root', async () => {
    const suffix = 'ws/code:run/00000000-0000-4000-8000-000000000000/result.spill';
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{ kind: 'reference', uri: `papercusp://scratch/${suffix}` }],
    };
    const readSpill = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }] });
    expect(await unwrapOutputEnvelope(envelope, {
      env: { PAPERCUSP_HOME: '/tmp/workspace-home' }, fileExists: () => true, readSpill,
    })).toEqual({ ok: true });
    expect(readSpill).toHaveBeenCalledExactlyOnceWith(join('/tmp/workspace-home/scratch', suffix));
    readSpill.mockClear();
    expect(await unwrapOutputEnvelope(envelope, {
      env: { PAPERCUSP_HOME: '/tmp/workspace-home', PAPERCUSP_SCRATCH_ROOT: '/tmp/explicit-root' },
      fileExists: path => path === join(homedir(), '.papercusp', 'scratch', suffix),
      readSpill,
    })).toBe(envelope);
    expect(readSpill).not.toHaveBeenCalled();
  });

  it('returns the envelope UNCHANGED — never a fabricated success — when the reference cannot be read or parsed', async () => {
    const missing = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{ kind: 'reference', uri: 'papercusp://scratch/ws/tool/00000000-0000-4000-8000-000000000000/gone.spill' }],
    };
    expect(await unwrapOutputEnvelope(missing, { fileExists: () => false })).toBe(missing);

    const unreadable = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{ kind: 'reference', uri: 'papercusp://scratch/ws/tool/00000000-0000-4000-8000-000000000000/bad.spill' }],
    };
    expect(
      await unwrapOutputEnvelope(unreadable, {
        fileExists: () => true,
        readSpill: vi.fn().mockRejectedValue(new Error('disk error')),
      }),
    ).toBe(unreadable);
  });

  it('scratchUriToPath rejects a non-matching scheme and any traversal attempt', () => {
    expect(scratchUriToPath('not-a-scratch-uri')).toBe('');
    expect(scratchUriToPath('papercusp://scratch/../../etc/passwd')).toBe('');
    expect(scratchUriToPath('papercusp://scratch/ws/tool/run/../../../etc/passwd')).toBe('');
    expect(scratchUriToPath('papercusp://scratch/')).toBe('');
  });

  it('scratchUriToPath maps a valid URI under the resolved (overridable) scratch root', () => {
    const env = { PAPERCUSP_SCRATCH_ROOT: '/tmp/fake-scratch-root' };
    expect(scratchUriToPath('papercusp://scratch/ws/tool:verb/run-id/file.spill', env)).toBe(
      '/tmp/fake-scratch-root/ws/tool:verb/run-id/file.spill',
    );
  });

  it('printResult (raw mode) prints the UNWRAPPED result, not the envelope — the exact EI-22212780570913684 shape', async () => {
    const grantedLockEnvelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      content: [{ type: 'text', text: '{"ok":true,"lock_id":"94ed8996-abc"}' }],
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await printResult(
        { content: [{ type: 'text', text: JSON.stringify(grantedLockEnvelope) }] },
        { raw: true },
      );
      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith('{"ok":true,"lock_id":"94ed8996-abc"}');
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('ptool scripted JSON output', () => {
  it('uses the raw JSON extractor for every explicit JSON input, without requiring --raw', () => {
    expect(shouldPrintRawResult('inline', false)).toBe(true);
    expect(shouldPrintRawResult('file', false)).toBe(true);
    expect(shouldPrintRawResult('stdin', false)).toBe(true);
    expect(shouldPrintRawResult(null, false)).toBe(false);
    expect(shouldPrintRawResult(null, true)).toBe(true);
  });
});

describe('stdout delivery failure (EI-21250765620092599)', () => {
  // Node swallows EPIPE on process.stdout: when the consumer of a piped/captured
  // stdout dies, later writes are dropped silently and the process exits 0 — the
  // "completed successfully but emitted no JSON or text" wake-harness shape.
  // printResult must convert a detected delivery failure into stderr + exit 1.
  it('fails loudly when stdout delivery errored after the write (swallowed EPIPE)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await printResult(
        { structuredContent: { ok: true } },
        { raw: true, deliveryProbe: () => Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) },
      );
      expect(code).toBe(1);
      expect(log).toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('stdout delivery FAILED (EPIPE)');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('reports success with no stderr on a healthy stream, and the live probe is quiet', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await printResult({ structuredContent: { ok: true } }, { raw: true })).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    expect(stdoutDeliveryError()).toBeNull();
  });
});

describe('ptool JSON input', () => {
  it('treats empty stdin as an empty args object for zero-argument tools (EI-21579932287582806)', () => {
    expect(parseJsonInput('', { emptyAsObject: true })).toEqual({});
    expect(parseJsonInput('  \n\t', { emptyAsObject: true })).toEqual({});
  });

  it('keeps empty inline and file payloads strict', () => {
    expect(() => parseJsonInput('')).toThrow();
    expect(() => parseJsonInput('  \n\t')).toThrow();
  });

  it('rejects trailing JSON data after a valid stdin args object', () => {
    const validPayload = '{"name":"work_items:checkpoint","args":{"id":"WI-10006055"}}';
    expect(parseJsonInput(validPayload)).toEqual({
      name: 'work_items:checkpoint',
      args: { id: 'WI-10006055' },
    });
    expect(() => parseJsonInput(`${validPayload}}`)).toThrow(
      'Unexpected non-whitespace character after JSON',
    );
  });

  it('rejects a double-encoded object before dispatch with a direct correction', () => {
    const payload = JSON.stringify(JSON.stringify({ did: 'finished the checkpoint' }));
    let parseError: unknown = null;
    try {
      parseJsonInput(payload);
    } catch (error) {
      parseError = error;
    }

    expect(parseError).toBeInstanceOf(TypeError);
    const message = formatJsonInputError('inline', parseError);
    expect(message).toContain('must contain an object of tool arguments');
    expect(message).toContain('remove the extra JSON.stringify/quoting layer');
  });

  it.each(['null', '[]', '1', 'true'])('rejects non-object MCP args: %s', (payload) => {
    expect(() => parseJsonInput(payload)).toThrow('tool arguments must decode to a JSON object');
  });

  it('explains how to escape literal backslashes after invalid JSON escapes', () => {
    let parseError: unknown = null;
    try {
      parseJsonInput('{"command":"find \\( -name \\)"}');
    } catch (error) {
      parseError = error;
    }

    expect(parseError).toBeInstanceOf(SyntaxError);
    expect(formatJsonInputError('stdin', parseError)).toContain('doubling each one');
    expect(formatJsonInputError('stdin', parseError)).toContain('JSON.stringify');
    expect(parseJsonInput('{"command":"find \\\\( -name \\\\)"}'))
      .toEqual({ command: 'find \\( -name \\)' });
  });

  it('does not add backslash guidance to unrelated JSON errors', () => {
    const message = formatJsonInputError('stdin', new SyntaxError('Unexpected token at position 0'));
    expect(message).not.toContain('JSON.stringify');
  });

  it('accepts literal newlines inside quoted values from a heredoc payload', () => {
    const payload = [
      '{',
      '  "slug": "validation-plan",',
      '  "body": "first line',
      'second line",',
      '  "nested": { "value": "already\\nescaped" }',
      '}',
    ].join('\n');

    expect(parseJsonInput(payload)).toEqual({
      slug: 'validation-plan',
      body: 'first line\nsecond line',
      nested: { value: 'already\nescaped' },
    });
    expect(escapeJsonStringControls(payload)).toContain('first line\\u000asecond line');
  });

  it('leaves formatting whitespace outside strings and already-escaped controls unchanged', () => {
    const payload = '{\n  "body": "first\\nsecond"\n}\n';
    expect(escapeJsonStringControls(payload)).toBe(payload);
    expect(parseJsonInput(payload)).toEqual({ body: 'first\nsecond' });
  });
});

describe('ptool local-connect retry diagnostics (EI-21504867146958629)', () => {
  const shedErr = () =>
    Object.assign(new Error('{"error":"mcp_proxy_handshake_overloaded","retryAfterSec":2}'), { code: 429 });

  it('uses a canonical fallback after a stale self-port refusal', async () => {
    const client = { close: vi.fn() };
    const primaryError = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const connectOnce = vi.fn()
      .mockRejectedValueOnce(primaryError)
      .mockResolvedValueOnce(client);
    const onFallback = vi.fn();

    await expect(connectWithOperatorCandidates(
      connectOnce,
      ['http://127.0.0.1:3271', 'http://127.0.0.1:3070'],
      {},
      {
        primaryAttemptOptions: { maxAttempts: 1 },
        onFallback,
        sleep: async () => {},
      },
    )).resolves.toEqual({ client, operatorUrl: 'http://127.0.0.1:3070' });
    expect(connectOnce.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:3271',
      'http://127.0.0.1:3070',
    ]);
    expect(onFallback).toHaveBeenCalledWith('http://127.0.0.1:3070', primaryError);
  });

  it('does not route an HTTP connect failure to a fallback candidate', async () => {
    const authError = Object.assign(new Error('unauthorized'), { code: 401 });
    const connectOnce = vi.fn().mockRejectedValue(authError);

    await expect(connectWithOperatorCandidates(
      connectOnce,
      ['http://127.0.0.1:3271', 'http://127.0.0.1:3070'],
      {},
      { primaryAttemptOptions: { maxAttempts: 1 }, sleep: async () => {} },
    )).rejects.toBe(authError);
    expect(connectOnce).toHaveBeenCalledTimes(1);
  });

  it('recovers an implicit named call from a pre-dispatch HTTP 404, leaving dispatch safety to tool metadata', async () => {
    const primaryError = Object.assign(new Error('POST /api/mcp returned 404'), { code: 404 });
    const client = { close: vi.fn() };
    const connectOnce = vi.fn().mockRejectedValueOnce(primaryError).mockResolvedValueOnce(client);
    const onFallback = vi.fn();

    await expect(connectWithOperatorCandidates(
      connectOnce,
      ['http://127.0.0.1:3880', 'http://127.0.0.1:3070'],
      {},
      { allowHttpNotFoundFallback: true, primaryAttemptOptions: { maxAttempts: 1 }, onFallback },
    )).resolves.toEqual({ client, operatorUrl: 'http://127.0.0.1:3070' });
    expect(connectOnce.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3880',
      'http://127.0.0.1:3070',
    ]);
    expect(onFallback).toHaveBeenCalledWith('http://127.0.0.1:3070', primaryError);
    expect(canDispatchOnFallbackOperator({ annotations: { readOnlyHint: true } }, true)).toBe(true);
    expect(canDispatchOnFallbackOperator({ annotations: { readOnlyHint: false } }, true)).toBe(false);
  });

  it('does not route an implicit HTTP 404 to a fallback unless the caller enabled the safe pre-dispatch recovery', async () => {
    const notFound = Object.assign(new Error('POST /api/mcp returned 404'), { code: 404 });
    const connectOnce = vi.fn().mockRejectedValue(notFound);

    await expect(connectWithOperatorCandidates(
      connectOnce,
      ['http://127.0.0.1:3880', 'http://127.0.0.1:3070'],
      {},
      { primaryAttemptOptions: { maxAttempts: 1 } },
    )).rejects.toBe(notFound);
    expect(connectOnce).toHaveBeenCalledTimes(1);
  });

  it('recognizes only the stale session-authority denial as a pre-dispatch fallback signal', () => {
    const stale = {
      isError: true,
      content: [{
        type: 'text',
        text: 'authorization_denied: Kernel preflight denied tool "coord:whoami": current session authority could not be read; no effect authorized',
      }],
    };
    expect(isRecoverableAuthorityDenial(stale)).toBe(true);
    expect(isRecoverableAuthorityDenial({
      isError: true,
      content: [{ type: 'text', text: 'authorization_denied: role is not allowed' }],
    })).toBe(false);
  });

  it('EI-22697016277102033 gives direct local pins the full bounded recovery window', async () => {
    expect(PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS).toBe(15_000);
    expect(PTOOL_PINNED_LOCAL_CONNECT_TOTAL_TIMEOUT_MS).toBe(PTOOL_CONNECT_TIMEOUT_MS);
    expect(ptoolConnectAttemptTimeoutMs('http://127.0.0.1:3170', {})).toBe(15_000);
    expect(ptoolConnectAttemptTimeoutMs('http://127.0.0.1:3070', {})).toBe(15_000);
    expect(ptoolConnectAttemptTimeoutMs('http://127.0.0.1:9071', {})).toBe(PTOOL_CONNECT_TIMEOUT_MS);
    expect(ptoolConnectAttemptTimeoutMs('http://127.0.0.1:9171', {
      PAPERCUSP_MCP_PROXY_PORT: '9171',
    })).toBe(PTOOL_CONNECT_TIMEOUT_MS);
    expect(ptoolConnectAttemptTimeoutMs('http://127.0.0.1:9171', {
      PAPERCUSP_MCP_STAGING_PROXY_PORT: '9171',
    })).toBe(PTOOL_CONNECT_TIMEOUT_MS);
    expect(ptoolConnectAttemptTimeoutMs('http://127.0.0.1:4567', {
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:4567',
    })).toBe(PTOOL_CONNECT_TIMEOUT_MS);

    vi.useFakeTimers();
    try {
      const client = { close: vi.fn() };
      const connectOnce = vi
        .fn()
        .mockImplementationOnce(() => Promise.withResolvers().promise)
        .mockResolvedValue(client);
      const pending = connectWithLocalRetry(connectOnce, 'http://127.0.0.1:3170', {}, {
        maxAttempts: 2,
        retryDelayMs: 0,
        retryJitterMs: 0,
        totalTimeoutMs: PTOOL_CONNECT_TIMEOUT_MS,
        sleep: async () => {},
      });

      await vi.advanceTimersByTimeAsync(PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS);
      await expect(pending).resolves.toBe(client);
      expect(connectOnce).toHaveBeenCalledTimes(2);
      expect(connectOnce.mock.calls[0][2]).toEqual({
        timeoutMs: PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the local network deadline after delayed SDK bootstrap and still times a stalled handshake', async () => {
    vi.useFakeTimers();
    const bootstrap = Promise.withResolvers<unknown>();
    const network = Promise.withResolvers<unknown>();
    const prepared = {
      mode: 'http',
      Client: 'client-module',
      StreamableHTTPClientTransport: 'transport-module',
    };
    const connectOnce = vi.fn(
      (_url: string, _scope: object, _options?: { timeoutMs?: number }, _context?: unknown) => network.promise,
    );
    const pending = connectWithOperatorCandidates(
      connectOnce,
      ['http://127.0.0.1:3170'],
      {},
      {
        prepareConnection: () => bootstrap.promise,
        maxAttempts: 1,
        attemptTimeoutMs: 15,
        totalTimeoutMs: 0,
        sleep: async () => {},
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(connectOnce).not.toHaveBeenCalled();

      bootstrap.resolve(prepared);
      await vi.advanceTimersByTimeAsync(0);
      expect(connectOnce).toHaveBeenCalledTimes(1);
      expect(connectOnce.mock.calls[0]?.[3]).toBe(prepared);

      const networkTimeoutAssertion = expect(pending).rejects.toThrow(
        /local operator connection attempt timed out after 15ms \[1 connect attempt\(s\).*attempt-timeout\]/,
      );
      await vi.advanceTimersByTimeAsync(15);
      await networkTimeoutAssertion;
    } finally {
      network.resolve({});
      vi.useRealTimers();
    }
  });

  it('counts synchronous connection setup against the attempt deadline and closes a late client', async () => {
    let now = 100;
    const client = { close: vi.fn() };
    const connectOnce = vi.fn<(
      url: string,
      scope: object,
      options?: { timeoutMs: number },
    ) => Promise<typeof client>>(() => {
      now += 16;
      return Promise.resolve(client);
    });

    await expect(connectWithLocalRetry(connectOnce, 'http://127.0.0.1:3170', {}, {
      now: () => now,
      maxAttempts: 1,
      attemptTimeoutMs: 15,
      totalTimeoutMs: 0,
      retryJitterMs: 0,
      sleep: async () => {},
    })).rejects.toThrow(/local operator connection attempt timed out after 15ms \[1 connect attempt\(s\).*attempt-timeout\]/);

    await Promise.resolve();
    expect(connectOnce).toHaveBeenCalledTimes(1);
    expect(connectOnce.mock.calls[0]?.[2]).toEqual({ timeoutMs: 15 });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('recovers a direct local pin by retrying the same named-call candidate', async () => {
    const pinned = 'http://127.0.0.1:3170';
    const env = { PAPERCUSP_OPERATOR_URL: pinned };
    const args = { tool: 'work_items:get' };
    const candidates = resolvePtoolInvocationCandidates(args, env);
    const retryOptions = ptoolConnectionRetryOptions(args, env);
    const client = { close: vi.fn() };
    const connectOnce = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error(`connect ECONNREFUSED ${pinned}`), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce(client);
    const sleeps: number[] = [];

    expect(candidates).toEqual([pinned]);
    expect(shouldRediscoverOperatorUrl(args, env)).toBe(false);
    await expect(connectWithOperatorCandidates(connectOnce, candidates, {}, {
      ...retryOptions,
      retryJitterMs: 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
    })).resolves.toEqual({ client, operatorUrl: pinned });
    expect(connectOnce.mock.calls.map(([url]) => url)).toEqual([pinned, pinned]);
    expect(sleeps).toEqual([1_000]);
  });

  it('bounds retries for a dead direct local URL pin to the full recovery window', async () => {
    const pinned = 'http://127.0.0.1:32951';
    const connectOnce = vi.fn().mockRejectedValue(
      Object.assign(new Error(`connect ECONNREFUSED ${pinned}`), { code: 'ECONNREFUSED' }),
    );
    await expect(
      connectWithLocalRetry(connectOnce, pinned, {}, {
        ...ptoolConnectionRetryOptions({ url: pinned }, {}),
        attemptTimeoutMs: PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS,
        sleep: vi.fn(async () => {}),
        retryJitterMs: 0,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(connectOnce).toHaveBeenCalledTimes(PTOOL_PINNED_LOCAL_CONNECT_MAX_ATTEMPTS);
  });

  it('keeps a direct staging pin alive through a 20s coordinated restart gap', async () => {
    const pinned = 'http://127.0.0.1:3170';
    const client = { close: vi.fn() };
    const refusal = () => Object.assign(new Error(`connect ECONNREFUSED ${pinned}`), { code: 'ECONNREFUSED' });
    const connectOnce = vi.fn();
    for (let i = 0; i < 20; i += 1) connectOnce.mockRejectedValueOnce(refusal());
    connectOnce.mockResolvedValue(client);

    await expect(connectWithLocalRetry(connectOnce, pinned, {}, {
      ...ptoolConnectionRetryOptions({ url: pinned }, {}),
      attemptTimeoutMs: PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS,
      sleep: vi.fn(async () => {}),
      retryJitterMs: 0,
    })).resolves.toEqual(client);
    expect(connectOnce).toHaveBeenCalledTimes(21);
    expect(PTOOL_PINNED_LOCAL_CONNECT_TOTAL_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it('does not spend the local retry budget when explicit UDS discovery has no endpoint', async () => {
    const first = 'http://127.0.0.1:3070';
    const second = 'http://127.0.0.1:3170';
    const client = { close: vi.fn() };
    const unavailable = new Error('uds_endpoint_unavailable');
    const connectOnce = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(client);
    const sleeps: number[] = [];

    await expect(connectWithOperatorCandidates(connectOnce, [first, second], {}, {
      maxAttempts: 80,
      retryDelayMs: 1_000,
      totalTimeoutMs: 120_000,
      sleep: async (ms: number) => { sleeps.push(ms); },
    })).resolves.toEqual({ client, operatorUrl: second });

    expect(connectOnce.mock.calls.map(([url]) => url)).toEqual([first, second]);
    expect(sleeps).toEqual([]);
    expect(unavailable.message).toMatch(/\[1 connect attempt\(s\).*1x uds-endpoint-unavailable\]$/);
  });

  it('honors Retry-After as a minimum and adds positive jitter', async () => {
    const sleeps: number[] = [];
    await expect(
      connectWithLocalRetry(
        async () => {
          throw shedErr();
        },
        'http://127.0.0.1:3070',
        {},
        {
          maxAttempts: 3,
          attemptTimeoutMs: 5_000,
          totalTimeoutMs: 60_000,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
          rand: () => 0,
        },
      ),
    ).rejects.toThrow(/proxy-shed-429/);
    // A zero entropy sample still produces one positive millisecond: clients
    // never retry before the server minimum and never share the exact boundary.
    expect(sleeps).toEqual([2_001, 2_001]);
  });

  it('de-synchronizes independent ptool processes given the same Retry-After hint', async () => {
    const samples = [0.1, 0.5, 0.9];
    const waits = await Promise.all(samples.map(async (sample) => {
      const sleeps: number[] = [];
      await expect(
        connectWithLocalRetry(
          async () => {
            throw shedErr();
          },
          'http://127.0.0.1:9071',
          {},
          {
            maxAttempts: 2,
            attemptTimeoutMs: 5_000,
            totalTimeoutMs: 60_000,
            rand: () => sample,
            sleep: async (ms: number) => {
              sleeps.push(ms);
            },
          },
        ),
      ).rejects.toThrow(/proxy-shed-429/);
      return sleeps[0];
    }));

    expect(waits).toEqual([2_100, 2_500, 2_900]);
    expect(new Set(waits).size).toBe(samples.length);
    expect(waits.every((wait) => wait > 2_000)).toBe(true);
  });

  it('applies the same positive jitter to tools/list discovery retries', async () => {
    const listTools = vi.fn().mockRejectedValue(shedErr());
    const sleeps: number[] = [];

    await expect(
      listToolsWithLocalRetry(
        { listTools },
        {},
        {
          maxAttempts: 2,
          timeoutMs: 5_000,
          totalTimeoutMs: 60_000,
          rand: () => 0.4,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow(/mcp_proxy_handshake_overloaded/);

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_400]);
  });

  it('lets the proxy finish its bounded tools/list handshake before ptool aborts', () => {
    const proxyHandshakeAttemptCount = MAX_HANDSHAKE_TIMEOUT_RETRIES + 1;
    expect(PTOOL_LIST_TOOLS_TIMEOUT_MS).toBeGreaterThan(
      HANDSHAKE_UPSTREAM_TIMEOUT_MS * proxyHandshakeAttemptCount,
    );
  });

  it('observes and caps repeated proxy 502s during tools/list discovery', async () => {
    const proxyError = Object.assign(new Error('mcp_proxy_upstream_error'), { code: 502 });
    const listTools = vi.fn().mockRejectedValue(proxyError);
    const sleeps: number[] = [];

    await expect(
      listToolsWithLocalRetry(
        { listTools },
        {},
        {
          totalTimeoutMs: 120_000,
          rand: () => 0,
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toBe(proxyError);

    expect(listTools).toHaveBeenCalledTimes(PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS);
    expect(listTools.mock.calls.map(([, options]) => options)).toEqual(
      Array.from({ length: PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS }, () => ({
        timeout: PTOOL_LIST_TOOLS_TIMEOUT_MS,
        maxTotalTimeout: PTOOL_LIST_TOOLS_TIMEOUT_MS,
      })),
    );
    expect(sleeps).toHaveLength(PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS - 1);
  });

  it('does not retry before a server minimum that exhausts the remaining budget', () => {
    expect(PTOOL_RETRY_JITTER_MS).toBe(1_000);
    expect(retryWaitMsWithJitter(2_000, 2_000, { rand: () => 1 })).toBeNull();
    expect(retryWaitMsWithJitter(2_000, 2_500, { rand: () => 1 })).toBe(2_500);
  });

  it('an exhausted budget escapes with the original prefix AND the classified attempt tally', async () => {
    const hang = (): Promise<never> => Promise.withResolvers<never>().promise;
    let calls = 0;
    await expect(
      connectWithLocalRetry(
        async () => {
          calls += 1;
          if (calls === 1) throw shedErr();
          return hang();
        },
        'http://127.0.0.1:3070',
        {},
        {
          maxAttempts: 3,
          attemptTimeoutMs: 20,
          totalTimeoutMs: 60_000,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow(
      /^local operator connection attempt timed out after 20ms \[3 connect attempt\(s\) over \d+s: 1x proxy-shed-429, 2x attempt-timeout\]$/,
    );
  });

  it('caps repeated proxy-upstream 502 handshakes after one ptool replay', async () => {
    const proxyError = Object.assign(new Error('mcp_proxy_upstream_error'), { code: 502 });
    const connectOnce = vi.fn().mockRejectedValue(proxyError);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:9071', {}, {
        maxAttempts: 20,
        attemptTimeoutMs: 5_000,
        totalTimeoutMs: 60_000,
        sleep,
      }),
    ).rejects.toBe(proxyError);

    expect(PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS).toBe(2);
    expect(connectOnce).toHaveBeenCalledTimes(PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(proxyError.message).toMatch(
      /\[2 connect attempt\(s\) over \d+s: 2x proxy-upstream-502\]$/,
    );
  });
});

describe('ptool module-resolution failures are terminal, not retried (WI-6554700010012487)', () => {
  // Server 0.0.26 shipped without @modelcontextprotocol/sdk; its ptool
  // classified the import failure as `other` and retried it for the whole
  // budget: "[83 connect attempt(s) over 119s: 83x other]".
  const missingSdk = () => Object.assign(
    new Error("Cannot find package '@modelcontextprotocol/sdk' imported from /usr/lib/Papercusp Server/sidecar/scripts/ptool.mjs"),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );

  it('classifies ESM, CJS and wrapped resolution failures as module-not-found', () => {
    expect(isModuleResolutionFailure(missingSdk())).toBe(true);
    expect(isModuleResolutionFailure(Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }))).toBe(true);
    expect(isModuleResolutionFailure(new Error('connect failed', { cause: missingSdk() }))).toBe(true);
    expect(classifyConnectFailure(missingSdk())).toBe('module-not-found');
    // Negative controls: a transport refusal and a plain error stay retryable/other.
    expect(isModuleResolutionFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(classifyConnectFailure(new Error('something else'))).toBe('other');
  });

  it('stops a local connect after ONE attempt when an in-attempt import cannot resolve', async () => {
    const error = missingSdk();
    const connectOnce = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:3070', {}, {
        maxAttempts: 20,
        attemptTimeoutMs: 5_000,
        totalTimeoutMs: 120_000,
        sleep,
      }),
    ).rejects.toBe(error);

    expect(connectOnce).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error.message).toMatch(/\[1 connect attempt\(s\) over \d+s: 1x module-not-found\]$/);
  });

  it('never starts a connect attempt when the SDK bootstrap cannot resolve', async () => {
    const importSdkModule = vi.fn().mockRejectedValue(missingSdk());
    const connectOnce = vi.fn();
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithOperatorCandidates(connectOnce, ['http://127.0.0.1:3070', 'http://127.0.0.1:9071'], {}, {
        prepareConnection: () => preparePtoolConnectionModules({ transport: 'http' }, { importSdkModule }),
        maxAttempts: 20,
        totalTimeoutMs: 120_000,
        sleep,
      }),
    ).rejects.toThrow(/^ptool: SDK bootstrap failed before operator connection: Cannot find package '@modelcontextprotocol\/sdk'/);

    // One import per SDK entrypoint, no retry, and no network attempt on either candidate.
    expect(importSdkModule).toHaveBeenCalledTimes(2);
    expect(connectOnce).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('ptool SDK bootstrap recovery during install:safe drains', () => {
  it('recognizes the pre-dispatch install wait without classifying missing SDK as a wait', () => {
    expect(isSdkBootstrapInstallWait(new Error(
      'ptool: SDK bootstrap timed out waiting for install:safe before operator connection',
    ))).toBe(true);
    expect(isSdkBootstrapInstallWait(new Error(
      "Cannot find package '@modelcontextprotocol/sdk'",
    ))).toBe(false);
  });

  it('keeps the same local endpoint, scope, client identity, payload and replay key', () => {
    expect(buildMcpCallRecoveryInvocation({
      helperPath: '/repo/scripts/mcp-call.mjs',
      toolName: 'work_items:get',
      callArgs: { id: 'EI-26089122200719088' },
      inputKind: 'file',
      operatorUrl: 'http://127.0.0.1:3170',
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      clientId: 'su-recovery',
      idempotencyKey: 'ptool-recovery-1',
    })).toEqual({
      command: process.execPath,
      args: [
        '/repo/scripts/mcp-call.mjs', 'work_items:get', '--json', '-', '--port', '3170',
        '--workspace', 'papercusp-workspace', '--harness', 'papercusp',
        '--client', 'su-recovery', '--idempotency-key', 'ptool-recovery-1',
      ],
      payload: { id: 'EI-26089122200719088' },
      port: '3170',
    });
    expect(buildMcpCallRecoveryInvocation({
      helperPath: '/repo/scripts/mcp-call.mjs',
      toolName: 'work_items:get',
      callArgs: {}, inputKind: 'file', operatorUrl: 'https://operator.example',
    })).toBeNull();
    expect(buildMcpCallRecoveryInvocation({
      helperPath: '/repo/scripts/mcp-call.mjs',
      toolName: 'work_items:get',
      callArgs: {}, inputKind: 'file', operatorUrl: 'http://127.0.0.1:3170',
      projection: '{}',
    })).toBeNull();
  });

  it('writes the JSON payload to the helper and propagates its exit code', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn<(payload: string) => void>() } });
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 5, null));
      return child;
    });
    const result = await runMcpCallRecovery({
      invocation: {
        command: process.execPath,
        args: ['/repo/scripts/mcp-call.mjs', 'coord:orient', '--json', '-'],
        payload: { intent: 'recover' },
        port: '3170',
      },
      spawnImpl,
    });
    expect(result).toMatchObject({ handled: true, started: true, exitCode: 5 });
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/scripts/mcp-call.mjs', 'coord:orient', '--json', '-'],
      expect.objectContaining({ stdio: ['pipe', 'inherit', 'inherit'] }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith('{"intent":"recover"}');
  });
});

describe('ptool SDK import install-race tolerance (EI-21860372620642128)', () => {
  const moduleNotFound = (specifier: string) =>
    Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });

  async function withoutOuterInstallReader<T>(run: () => Promise<T>): Promise<T> {
    const previousMutexHeld = process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
    delete process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
    try {
      return await run();
    } finally {
      if (previousMutexHeld === undefined) delete process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
      else process.env.PAPERCUSP_INSTALL_MUTEX_HELD = previousMutexHeld;
    }
  }

  it('labels an install:safe reader-lease timeout as SDK bootstrap before network connection', async () => {
    const installWaitTimeout = new Error(
      'Timed out after 600000ms waiting for fs-mutex writer ("npm-install-abc123"); holder: install:safe',
    );
    const importSdkModule = vi.fn().mockRejectedValue(installWaitTimeout);

    await expect(preparePtoolConnectionModules(
      { transport: 'http' },
      { importSdkModule },
    )).rejects.toMatchObject({
      message: expect.stringContaining(
        'ptool: SDK bootstrap timed out waiting for install:safe before operator connection',
      ),
      cause: installWaitTimeout,
    });
    expect(importSdkModule).toHaveBeenCalledTimes(2);
  });

  it('captures available bytes and free inodes when the reader marker mkdir fails with ENOSPC', async () => {
    const readerMarkerPath = '/tmp/pcv/fs-mutex-locks/npm-install-demo.readers/311.lock';
    const noSpace = Object.assign(
      new Error(`ENOSPC: no space left on device, mkdir '${readerMarkerPath}'`),
      { code: 'ENOSPC', path: readerMarkerPath, syscall: 'mkdir' },
    );
    const importSdkModule = vi.fn().mockRejectedValue(noSpace);
    const statfsImpl = vi.fn().mockResolvedValue({ bsize: 4096n, bavail: 2n, ffree: 3n });

    const failure = await preparePtoolConnectionModules(
      { transport: 'http' },
      { importSdkModule, statfsImpl },
    ).then(() => null, (error) => error);
    expect(failure).toMatchObject({ cause: noSpace });
    expect(failure.message).toContain('ENOSPC filesystem sample captured after failure: syscall=mkdir');
    expect(failure.message).toContain('availableBytes=8192, freeInodes=3');
    expect(statfsImpl).toHaveBeenCalledTimes(1);
    expect(statfsImpl).toHaveBeenCalledWith(
      '/tmp/pcv/fs-mutex-locks/npm-install-demo.readers',
      { bigint: true },
    );
  });

  it('preserves the original ENOSPC error when the best-effort statfs sample fails', async () => {
    const readerMarkerPath = '/tmp/pcv/fs-mutex-locks/npm-install-demo.readers/312.lock';
    const noSpace = Object.assign(
      new Error(`ENOSPC: no space left on device, mkdir '${readerMarkerPath}'`),
      { code: 'ENOSPC', path: readerMarkerPath, syscall: 'mkdir' },
    );
    const importSdkModule = vi.fn().mockRejectedValue(noSpace);
    const statfsImpl = vi.fn().mockRejectedValue(new Error('statfs denied'));

    await expect(preparePtoolConnectionModules(
      { transport: 'http' },
      { importSdkModule, statfsImpl },
    )).rejects.toMatchObject({
      message: expect.stringContaining('ENOSPC filesystem sample unavailable after failure: syscall=mkdir'),
      cause: noSpace,
    });
    expect(statfsImpl).toHaveBeenCalledTimes(1);
    expect(statfsImpl).toHaveBeenCalledWith(
      '/tmp/pcv/fs-mutex-locks/npm-install-demo.readers',
      { bigint: true },
    );
  });

  it('imports SDK modules under the repo install reader lease', async () => {
    const doImport = vi.fn().mockResolvedValue({ Client: 'ok' });
    const withFsMutexRead = vi.fn(async (
      _name: string,
      run: () => Promise<unknown>,
      _options: { timeoutMs: number; onWaiting: (info: { owner: string; elapsedMs: number }) => void },
    ) => run());
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { withFsMutexRead },
      { repoLockName: () => 'npm-install-abc123' },
    ]);
    const result = await withoutOuterInstallReader(() =>
      importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/index.js', {
        doImport,
        loadInstallMutex,
      }),
    );
    expect(result).toEqual({ Client: 'ok' });
    expect(doImport).toHaveBeenCalledTimes(1);
    expect(loadInstallMutex).toHaveBeenCalledTimes(1);
    expect(withFsMutexRead).toHaveBeenCalledWith(
      'npm-install-abc123',
      expect.any(Function),
      expect.objectContaining({ timeoutMs: expect.any(Number), onWaiting: expect.any(Function) }),
    );
    expect(withFsMutexRead.mock.calls[0]?.[2]?.timeoutMs).toBeGreaterThan(330_000);
  });

  it('returns to scripted recovery before an active installer releases its lease', async () => {
    let releaseInstaller!: () => void;
    const installer = new Promise<void>((resolve) => { releaseInstaller = resolve; });
    const doImport = vi.fn().mockResolvedValue({ Client: 'ok' });
    const withFsMutexRead = vi.fn(async (
      _name: string,
      run: () => Promise<unknown>,
      options: { onWaiting: (info: { owner: string; elapsedMs: number }) => void },
    ) => {
      options.onWaiting({ owner: 'active install:safe', elapsedMs: 0 });
      await installer;
      return run();
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let outcome: { status: string; error?: Error } = { status: 'pending' };
    try {
      await withoutOuterInstallReader(async () => {
        const importing = importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/index.js', {
          doImport,
          recoverOnInstallWait: true,
          loadInstallMutex: vi.fn().mockResolvedValue([
            { withFsMutexRead },
            { repoLockName: () => 'npm-install-scripted-recovery' },
          ]),
        }).then(
          () => { outcome = { status: 'imported' }; },
          (error: Error) => { outcome = { status: 'declined', error }; },
        );
        try {
          // Drain promise reactions without releasing the installer or advancing a timeout.
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(outcome.status).toBe('declined');
          expect(isSdkBootstrapInstallWait(outcome.error)).toBe(true);
          expect(doImport).not.toHaveBeenCalled();
        } finally {
          releaseInstaller();
          await importing;
        }
      });
    } finally {
      releaseInstaller();
      consoleError.mockRestore();
    }
  });

  it('preserves a non-module import error from inside the reader lease', async () => {
    const otherError = new TypeError('boom');
    const doImport = vi.fn().mockRejectedValue(otherError);
    const withFsMutexRead = vi.fn(async (
      _name: string,
      run: () => Promise<unknown>,
      _options: { timeoutMs: number; onWaiting: (info: { owner: string; elapsedMs: number }) => void },
    ) => run());
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { withFsMutexRead },
      { repoLockName: () => 'npm-install-abc123' },
    ]);
    await expect(withoutOuterInstallReader(() =>
      importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/types.js', { doImport, loadInstallMutex }),
    )).rejects.toBe(otherError);
    expect(doImport).toHaveBeenCalledTimes(1);
    expect(withFsMutexRead).toHaveBeenCalledTimes(1);
  });

  it('surfaces a genuine missing dependency without retrying', async () => {
    const notFound = moduleNotFound('@modelcontextprotocol/sdk/types.js');
    const doImport = vi.fn().mockRejectedValue(notFound);
    const withFsMutexRead = vi.fn(async (
      _name: string,
      run: () => Promise<unknown>,
      _options: { timeoutMs: number; onWaiting: (info: { owner: string; elapsedMs: number }) => void },
    ) => run());
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { withFsMutexRead },
      { repoLockName: () => 'npm-install-abc123' },
    ]);
    await expect(withoutOuterInstallReader(() =>
      importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/types.js', { doImport, loadInstallMutex }),
    )).rejects.toBe(notFound);
    expect(doImport).toHaveBeenCalledTimes(1);
    expect(withFsMutexRead).toHaveBeenCalledTimes(1);
  });

  it('falls back to a direct import when the optional mutex helper cannot load', async () => {
    const doImport = vi.fn().mockResolvedValue({ Client: 'ok' });
    const loadInstallMutex = vi.fn().mockRejectedValue(new Error('cannot resolve helper'));
    await expect(importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/index.js', {
      doImport,
      loadInstallMutex,
    })).resolves.toEqual({ Client: 'ok' });
    expect(doImport).toHaveBeenCalledTimes(1);
  });

  it('waits for install:safe before attempting the SDK import', async () => {
    const previousLockDir = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    const previousMutexHeld = process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
    const previousMutexDisabled = process.env.PAPERCUSP_DISABLE_FS_MUTEX;
    const lockDir = mkdtempSync(join(tmpdir(), 'ptool-sdk-install-lock-'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let signalWriterEntered!: () => void;
    const writerEntered = new Promise<void>((resolve) => { signalWriterEntered = resolve; });
    let releaseWriter!: () => void;
    const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let install: Promise<number> | undefined;

    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockDir;
    delete process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
    delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
    try {
      const [{ withFsMutex, peekFsMutexSync }, { repoLockName }] = await Promise.all([
        import('../../../scripts/lib/fs-mutex.mjs'),
        import('../../../scripts/npm-install-safe.mjs'),
      ]);
      const lockName = repoLockName();
      install = withFsMutex(lockName, async () => {
        signalWriterEntered();
        await writerRelease;
        return 0;
      });
      await writerEntered;

      const missingWhileWriterRuns = moduleNotFound('@modelcontextprotocol/sdk/client/index.js');
      const doImport = vi.fn(async () => {
        if (peekFsMutexSync(lockName).held) throw missingWhileWriterRuns;
        return { Client: 'ok' };
      });
      const importing = importSdkModuleWithInstallAwareness(
        '@modelcontextprotocol/sdk/client/index.js',
        { doImport },
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(doImport).not.toHaveBeenCalled();

      releaseWriter();
      await expect(importing).resolves.toEqual({ Client: 'ok' });
      await install;
    } finally {
      releaseWriter();
      await install?.catch(() => {});
      consoleError.mockRestore();
      if (previousLockDir === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockDir;
      if (previousMutexHeld === undefined) delete process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
      else process.env.PAPERCUSP_INSTALL_MUTEX_HELD = previousMutexHeld;
      if (previousMutexDisabled === undefined) delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
      else process.env.PAPERCUSP_DISABLE_FS_MUTEX = previousMutexDisabled;
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  it('does not acquire a nested reader lease when install:safe already holds one', async () => {
    const previousMutexHeld = process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
    process.env.PAPERCUSP_INSTALL_MUTEX_HELD = 'npm-install-0123456789ab';
    const doImport = vi.fn().mockResolvedValue({ Client: 'ok' });
    const withFsMutexRead = vi.fn();
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { withFsMutexRead },
      {
        repoLockName: () => 'npm-install-0123456789ab',
        installMutexIsHeld: (name: string, env: NodeJS.ProcessEnv) => env.PAPERCUSP_INSTALL_MUTEX_HELD?.split(',').includes(name),
      },
    ]);
    try {
      await expect(importSdkModuleWithInstallAwareness(
        '@modelcontextprotocol/sdk/client/index.js',
        { doImport, loadInstallMutex },
      )).resolves.toEqual({ Client: 'ok' });
      expect(doImport).toHaveBeenCalledTimes(1);
      expect(loadInstallMutex).toHaveBeenCalledTimes(1);
      expect(withFsMutexRead).not.toHaveBeenCalled();
    } finally {
      if (previousMutexHeld === undefined) delete process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
      else process.env.PAPERCUSP_INSTALL_MUTEX_HELD = previousMutexHeld;
    }
  });

  it('takes the SDK repository lease when an inherited marker belongs to another repo', async () => {
    const previousMutexHeld = process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
    process.env.PAPERCUSP_INSTALL_MUTEX_HELD = 'npm-install-fedcba987654';
    const order: string[] = [];
    const withFsMutexRead = vi.fn(async (_name: string, fn: () => Promise<unknown>) => {
      order.push('lease');
      return fn();
    });
    const loadInstallMutex = vi.fn().mockResolvedValue([
      { withFsMutexRead },
      {
        repoLockName: () => 'npm-install-0123456789ab',
        installMutexIsHeld: (name: string, env: NodeJS.ProcessEnv) => env.PAPERCUSP_INSTALL_MUTEX_HELD?.split(',').includes(name),
      },
    ]);
    try {
      await importSdkModuleWithInstallAwareness('fixture-sdk', {
        loadInstallMutex,
        doImport: async () => { order.push('import'); return {}; },
      });
      expect(order).toEqual(['lease', 'import']);
    } finally {
      if (previousMutexHeld === undefined) delete process.env.PAPERCUSP_INSTALL_MUTEX_HELD;
      else process.env.PAPERCUSP_INSTALL_MUTEX_HELD = previousMutexHeld;
    }
  });
});

// WI-6554700010012487: the packaged Server esbuild-bundles ptool.mjs and ships no
// @modelcontextprotocol tree, so every SDK import must be a literal import() that
// esbuild can inline. A computed import(specifier) shipped as a runtime lookup and
// failed on every packaged install.
describe('ptool SDK imports are bundle-traceable (WI-6554700010012487)', () => {
  const source = readFileSync(new URL('./ptool.mjs', import.meta.url), 'utf8');

  it('gives every SDK specifier ptool references a literal loader', () => {
    const referenced = new Set(source.match(/@modelcontextprotocol\/sdk\/[A-Za-z0-9_./-]+\.js/g) ?? []);
    expect(referenced.size).toBeGreaterThan(0);
    for (const specifier of referenced) {
      expect(Object.keys(PTOOL_SDK_MODULE_LOADERS)).toContain(specifier);
      expect(source).toContain(`import('${specifier}')`);
    }
  });

  it('defaults the install-aware importer to the literal loader table, not a computed import()', () => {
    expect(source).not.toMatch(/doImport\s*=\s*\(\s*spec\s*\)\s*=>\s*import\(\s*spec\s*\)/);
    expect(source).toMatch(/doImport\s*=\s*importPtoolSdkModule/);
  });

  it('resolves each loader to the real SDK module', async () => {
    const client = await importPtoolSdkModule('@modelcontextprotocol/sdk/client/index.js');
    const transport = await importPtoolSdkModule('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const types = await importPtoolSdkModule('@modelcontextprotocol/sdk/types.js');
    expect(typeof client.Client).toBe('function');
    expect(typeof transport.StreamableHTTPClientTransport).toBe('function');
    expect(types.CallToolResultSchema).toBeDefined();
  });

  it('refuses a specifier that has no loader instead of importing it dynamically', async () => {
    await expect(importPtoolSdkModule('@modelcontextprotocol/sdk/server/index.js')).rejects.toThrow(
      /no bundle-traceable loader/,
    );
  });
});

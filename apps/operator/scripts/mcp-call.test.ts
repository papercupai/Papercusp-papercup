import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  admissionRetryDelayMs,
  MCP_CALL_TOOL_NOT_OK_EXIT,
  MCP_CALL_PROJECTED_RESULT_EXIT,
  isRetryableAdmissionShed,
  projectedResultReason,
  toolResultNotOkReason,
  buildMcpCallParams,
  buildMcpSessionQuery,
  isForeignNativeSessionRejection,
  shouldRetryWithoutNativeSession,
  isInvokedDirectly,
  parseSse,
  parseArgs,
  jsonSourceKind,
  readJsonArgs,
  resolveMcpClientId,
  resolveMcpCallOrigin,
  resolveMcpRole,
  resolveMcpWorkspace,
  resolveCandidatePorts,
  resolveRepairQueueExpectedInstallSlug,
  isRepairQueueRead,
  repairQueueTargetScopeMismatch,
  resolveMcpProxyPort,
  superuserTokenPaths,
  superuserTokenPath,
  resolveOperatorUrlPort,
  isRecoverableAuthorityDenial,
  buildFallbackWarning,
  buildSuperuserBearerDiagnostic,
  isInvalidSuperuserBearerResult,
  buildUnreachableDiagnostic,
  buildConnectionRetryDiagnostic,
  fetchWithConnectionRecovery,
  MCP_CALL_TRANSPORTS,
  resolveMcpTransport,
  shouldTryUdsFallback,
  buildUdsFallbackNotice,
  buildUdsUnavailableDiagnostic,
  resolveAgentMcpDiscoveryHome,
  callToolViaAgentMcpUds,
} from '../../../scripts/mcp-call.mjs';

describe('mcp-call argument parsing', () => {
  it('preserves the existing space-separated value flag form', () => {
    expect(parseArgs([
      'coord:whoami',
      '{}',
      '--client',
      'su-space',
      '--workspace',
      'papercusp-workspace',
      '--harness',
      'papercusp',
      '--port',
      '3170',
      '--raw',
    ])).toEqual({
      tool: 'coord:whoami',
      jsonArgs: '{}',
      flags: {
        client: 'su-space',
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        port: '3170',
        raw: true,
      },
    });
  });

  it('accepts equals-form value flags without consuming the next argument', () => {
    expect(parseArgs([
      'coord:whoami',
      '{}',
      '--client=su-equals',
      '--workspace=papercusp-workspace',
      '--harness=papercusp',
      '--port=3170',
      '--raw',
      'trailing-positional',
    ])).toEqual({
      tool: 'coord:whoami',
      jsonArgs: '{}',
      flags: {
        client: 'su-equals',
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        port: '3170',
        raw: true,
      },
    });
  });

  it('rejects an accidental value on the boolean raw flag', () => {
    expect(() => parseArgs(['coord:whoami', '--raw=true'])).toThrow('--raw does not take a value');
  });

  it('accepts the help flags without treating them as unknown options', () => {
    expect(parseArgs(['--help'])).toEqual({
      tool: undefined,
      jsonArgs: undefined,
      flags: { help: true },
    });
    expect(parseArgs(['-h'])).toEqual({
      tool: undefined,
      jsonArgs: undefined,
      flags: { help: true },
    });
  });

  // WI-41249. The reader-only tests below pass `flags: { jsonFile }` by hand, so
  // they proved readJsonArgs worked while the parser was emitting `flags['json-file']`
  // and `--json-file` silently sent EMPTY args. Only an end-to-end assertion over the
  // parser/reader SEAM can catch that, so these drive the real CLI spelling.
  it('routes the kebab-cased --json-file through to the reader (space form)', () => {
    const parsed = parseArgs(['work_items:get', '--json-file', 'payload.json']);
    expect(parsed.flags.jsonFile).toBe('payload.json');
    expect(jsonSourceKind(parsed)).toBe('file');

    const seen: Array<[unknown, unknown]> = [];
    const readFile = (path: unknown, encoding: unknown) => {
      seen.push([path, encoding]);
      return '{"id":"EI-1750"}';
    };
    expect(readJsonArgs(parsed, { readFile })).toEqual({ id: 'EI-1750' });
    expect(seen).toEqual([['payload.json', 'utf8']]);
  });

  it('routes the kebab-cased --json-file through to the reader (equals form)', () => {
    const parsed = parseArgs(['work_items:get', '--json-file=payload.json']);
    expect(parsed.flags.jsonFile).toBe('payload.json');
    expect(jsonSourceKind(parsed)).toBe('file');
  });

  it('never degrades an explicit flag into empty args: unknown flags throw', () => {
    expect(() => parseArgs(['coord:whoami', '--jsonfile', 'payload.json']))
      .toThrow('unknown flag --jsonfile');
    expect(() => parseArgs(['coord:whoami', '--nope=1'])).toThrow(/accepted flags/);
  });

  it('rejects a value flag with no value instead of storing undefined', () => {
    expect(() => parseArgs(['work_items:get', '--json-file'])).toThrow('--json-file requires a value');
  });

  it('accepts the documented idempotency-key transport flag in both forms', () => {
    expect(parseArgs(['work_items:checkpoint', '--idempotency-key', 'receipt-space'])
      .flags.idempotencyKey).toBe('receipt-space');
    expect(parseArgs(['events:cancel', '--idempotency-key=receipt-equals'])
      .flags.idempotencyKey).toBe('receipt-equals');
  });

  it('places idempotency keys in MCP metadata instead of target tool arguments', () => {
    expect(buildMcpCallParams(
      'work_items:checkpoint',
      { id: 'EI-1750' },
      { idempotencyKey: 'receipt-1' },
    )).toEqual({
      name: 'work_items:checkpoint',
      arguments: { id: 'EI-1750' },
      _meta: { idempotencyKey: 'receipt-1' },
    });
  });

  it('gives independent CLI requests independent result-door cohorts without changing tool arguments', () => {
    const first = buildMcpCallParams('scorecards:get', { id: 'card-1' }, { outputGroupId: 'request-1' });
    const second = buildMcpCallParams('scorecards:get', { id: 'card-1' }, { outputGroupId: 'request-2' });
    expect(first).toEqual({
      name: 'scorecards:get',
      arguments: { id: 'card-1' },
      _meta: { outputGroupId: 'request-1' },
    });
    expect(second._meta).toEqual({ outputGroupId: 'request-2' });
  });

  it('accepts --all-workspaces as the explicit unscoped transport flag', () => {
    const parsed = parseArgs(['knowledge_packs:list', '--all-workspaces']);
    expect(parsed.flags.allWorkspaces).toBe(true);
    expect(resolveMcpWorkspace(parsed.flags, { PAPERCUSP_WORKSPACE: 'papercusp-workspace' }))
      .toBe('*');
  });

  it('rejects contradictory scoped and unscoped workspace flags', () => {
    expect(() => resolveMcpWorkspace(
      { allWorkspaces: true, workspace: 'papercusp-workspace' },
      {},
    )).toThrow('--all-workspaces cannot be combined with --workspace');
  });

  it('uses the canonical operator and resilient proxy when the inherited port hint is stale', () => {
    expect(resolveCandidatePorts({}, { PAPERCUSP_HONO_PORT: '3271' })).toEqual({
      configuredPort: '3271',
      candidatePorts: ['3271', '3070', '9071'],
      pinned: false,
    });
  });

  it('uses the resilient MCP proxy after the canonical operator by default', () => {
    expect(resolveCandidatePorts({}, {})).toEqual({
      configuredPort: '3070',
      candidatePorts: ['3070', '9071'],
      pinned: false,
    });
    expect(resolveMcpProxyPort({})).toBe('9071');
  });

  it('honors a configured MCP proxy port without changing operator precedence', () => {
    expect(resolveCandidatePorts({}, {
      PAPERCUSP_HONO_PORT: '3271',
      PAPERCUSP_MCP_PROXY_PORT: '9171',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9172',
    })).toEqual({
      configuredPort: '3271',
      candidatePorts: ['3271', '3070', '9171'],
      pinned: false,
    });
    expect(resolveMcpProxyPort({ PAPERCUSP_MCP_PROXY_PORT: '9171' })).toBe('9171');
  });

  it('resolves an explicit repair-queue install scope before the operator-home fallback', () => {
    expect(resolveRepairQueueExpectedInstallSlug(
      { harness: 'papercusp-pr-drill-20261014' },
      { PAPERCUSP_POT_HOME_SLUG: 'papercusp' },
    )).toBe('papercusp-pr-drill-20261014');
    expect(resolveRepairQueueExpectedInstallSlug({}, { PAPERCUSP_POT_HOME_SLUG: ' papercusp ' }))
      .toBe('papercusp');
    expect(resolveRepairQueueExpectedInstallSlug({}, {})).toBeNull();
  });

  it('treats only repair-queue reads as safe target probes and rejects missing or different targets', () => {
    expect(isRepairQueueRead({ op: 'get' })).toBe(true);
    expect(isRepairQueueRead({ op: 'status' })).toBe(true);
    expect(isRepairQueueRead({ op: 'admit', paths: ['src/fix.ts'] })).toBe(false);
    expect(repairQueueTargetScopeMismatch('papercusp', { target: { installSlug: 'papercusp' } }))
      .toBeNull();
    expect(repairQueueTargetScopeMismatch('papercusp-pr-drill-20261014', {
      target: { installSlug: 'papercusp' },
    })).toEqual({ expected: 'papercusp-pr-drill-20261014', actual: 'papercusp' });
    expect(repairQueueTargetScopeMismatch('papercusp-pr-drill-20261014', { ok: true }))
      .toEqual({ expected: 'papercusp-pr-drill-20261014', actual: null });
  });

  it('uses the configured local operator URL instead of silently defaulting to :3070', () => {
    expect(resolveOperatorUrlPort({ PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071/api/mcp' }))
      .toBe('9071');
    expect(resolveCandidatePorts({}, { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071/api/mcp' }))
      .toEqual({ configuredPort: '9071', candidatePorts: ['9071', '3070'], pinned: false });
    expect(() => resolveOperatorUrlPort({ PAPERCUSP_OPERATOR_URL: 'https://operator.example' }))
      .toThrow('loopback HTTP operator');
  });

  // WI-10006600: an isolated verify-tauri-headless sidecar mints its own bearer
  // under PAPERCUSP_HOME; workspace-scoped su sessions instead use the shared
  // operator bearer, while PAPERCUSP_OPERATOR_HOME selects an isolated operator.
  it('uses shared credentials for workspace-scoped homes and isolated credentials for operator homes', () => {
    expect(superuserTokenPath({ PAPERCUSP_HOME: '/tmp/iso/papercusp-home' }, '/home/u'))
      .toBe('/tmp/iso/papercusp-home/superuser-token');
    expect(superuserTokenPath({
      PAPERCUSP_HOME: '/home/u/.papercusp-workspaces/demo/.papercusp',
    }, '/home/u')).toBe('/home/u/.papercusp/superuser-token');
    expect(superuserTokenPath({
      PAPERCUSP_HOME: '/home/u/.papercusp-workspaces/demo/.papercusp',
      PAPERCUSP_OPERATOR_HOME: '/operator/home',
    }, '/home/u')).toBe('/operator/home/.papercusp/superuser-token');
    expect(superuserTokenPath({}, '/home/u')).toBe('/home/u/.papercusp/superuser-token');
    expect(superuserTokenPath({ PAPERCUSP_HOME: '' }, '/home/u')).toBe('/home/u/.papercusp/superuser-token');
  });

  it('matches ptool token precedence and only recognizes the exact pre-dispatch bearer refusal', () => {
    expect(superuserTokenPaths({
      PAPERCUSP_MCP_TOKEN_FILE: '  /tmp/explicit-token  ',
      PAPERCUSP_HOME: '/tmp/isolated',
    }, '/home/u')).toEqual(['/tmp/explicit-token']);
    expect(superuserTokenPaths({ PAPERCUSP_HOME: ' /tmp/isolated ' }, '/home/u')).toEqual([
      '/tmp/isolated/superuser-token',
      '/home/u/.papercusp/superuser-token',
    ]);
    expect(superuserTokenPaths({
      PAPERCUSP_HOME: '/home/u/.papercusp-workspaces/demo/.papercusp',
    }, '/home/u')).toEqual([
      '/home/u/.papercusp/superuser-token',
      '/home/u/.papercusp-workspaces/demo/.papercusp/superuser-token',
    ]);
    expect(superuserTokenPaths({ PAPERCUSP_HOME: '/home/u/.papercusp' }, '/home/u')).toEqual([
      '/home/u/.papercusp/superuser-token',
    ]);

    expect(isInvalidSuperuserBearerResult({
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: superuser_invalid_bearer' }],
    })).toBe(true);
    expect(isInvalidSuperuserBearerResult({
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: authorization_denied' }],
    })).toBe(false);
    expect(isInvalidSuperuserBearerResult({
      isError: true,
      content: [{ type: 'text', text: 'mcp_auth_failed: superuser_invalid_bearer' }],
    })).toBe(false);
  });

  it('keeps an explicitly pinned operator port fail-closed', () => {
    expect(resolveCandidatePorts(
      { port: '3170' },
      { PAPERCUSP_HONO_PORT: '3271', PAPERCUSP_MCP_PROXY_PORT: '9171' },
    )).toEqual({
      configuredPort: '3170',
      candidatePorts: ['3170'],
      pinned: true,
    });
  });

  it('recognizes only the stale session-authority denial as a canonical fallback signal', () => {
    const stale = [
      'authorization_denied: Kernel preflight denied tool "coord:whoami":',
      'current session authority could not be read; no effect authorized',
    ].join(' ');
    expect(isRecoverableAuthorityDenial(stale)).toBe(true);
    expect(isRecoverableAuthorityDenial('authorization_denied: role is not allowed')).toBe(false);
    expect(isRecoverableAuthorityDenial('current session authority could not be read')).toBe(false);
  });

  it('explains which local bearer path and port an invalid-bearer refusal used', () => {
    const diagnostic = buildSuperuserBearerDiagnostic({
      tokenPath: '/tmp/scoped-home/superuser-token',
      port: '3070',
    });
    expect(diagnostic).toContain('port 3070');
    expect(diagnostic).toContain('/tmp/scoped-home/superuser-token');
    expect(diagnostic).toContain('superuser_invalid_bearer');
    expect(diagnostic).toContain('did not substitute another token');
  });
});

describe('mcp-call fallback diagnostics', () => {
  const fetchError = (code: string) => new TypeError('fetch failed', {
    cause: Object.assign(new Error('socket failure'), { code }),
  });

  it('does not mistake a reset or timeout for a missing listener or stale port', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT']) {
      const warning = buildFallbackWarning({
        configuredPort: '3070',
        port: '9071',
        proxyPort: '9071',
        configuredPortError: fetchError(code),
      });

      expect(warning).toContain('did not complete');
      expect(warning).toContain('does not establish that the port is stale');
      expect(warning).not.toMatch(/nothing was listening|no listener accepted|port is STALE/);
    }
  });

  it('retains a no-listener diagnosis for ECONNREFUSED on a noncanonical port', () => {
    const warning = buildFallbackWarning({
      configuredPort: '3271',
      port: '3070',
      proxyPort: '9071',
      configuredPortError: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
    });

    expect(warning).toContain('no listener accepted a connection on PAPERCUSP_HONO_PORT=3271');
    expect(warning).toContain('may be stale or restarting');
    expect(warning).toContain('the canonical operator on port 3070');
  });

  it('does not call canonical :3070 stale after a connection refusal', () => {
    const warning = buildFallbackWarning({
      configuredPort: '3070',
      port: '9071',
      proxyPort: '9071',
      configuredPortError: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
    });

    expect(warning).toContain('The environment setting is canonical');
    expect(warning).not.toMatch(/port is STALE|may be stale/);
  });
});

describe('mcp-call connection refusal diagnostics', () => {
  const refused = () => new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
  });

  it('keeps retries scoped to this mcp-call process instead of inferring an operator restart', async () => {
    let nowMs = 1_000;
    let fetchCalls = 0;
    const retryMessages: string[] = [];
    const success = new Response('ok');

    const result = await fetchWithConnectionRecovery('http://localhost:3170', {}, {
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) throw refused();
        return success;
      },
      retryWindowMs: 25,
      retryDelayMs: 10,
      sleepImpl: async (ms: number) => { nowMs += ms; },
      now: () => nowMs,
      onRetry: ({ attempt, delayMs, remainingMs }: { attempt: number; delayMs: number; remainingMs: number }) => {
        retryMessages.push(buildConnectionRetryDiagnostic({
          port: '3170', attempt, delayMs, remainingMs,
        }));
      },
    });

    expect(result).toBe(success);
    expect(fetchCalls).toBe(2);
    expect(retryMessages).toHaveLength(1);
    expect(retryMessages[0]).toContain('connection to port 3170 was refused from this mcp-call process');
    expect(retryMessages[0]).toContain('does not identify the cause');
    expect(retryMessages[0]).not.toMatch(/operator may be restarting|operator is restarting/);
  });

  it('limits an exhausted refusal diagnosis to this caller and the exact endpoints tried', () => {
    const diagnostic = buildUnreachableDiagnostic({
      attempts: [{ port: '3170', error: refused() }],
      configuredPort: '3170',
      pinned: true,
    });

    expect(diagnostic).toContain('Every connection attempt was refused before an MCP request could be sent');
    expect(diagnostic).toContain("this mcp-call process's attempts to the listed ports");
    expect(diagnostic).toContain('same execution environment that ran mcp-call');
    expect(diagnostic).toContain('does not identify why a connection was refused');
    expect(diagnostic).not.toMatch(/operator may be restarting|operator is restarting/);
  });
});

describe('mcp-call call-origin declaration', () => {
  it('marks managed session identities as agent-origin and leaves system clients unmarked', () => {
    const client = 'su-6ab684ac-35e9-4fd1-a992-169c86dfdda5';
    const env = { PAPERCUSP_SID: client };
    const origin = resolveMcpCallOrigin(client, env);
    const query = buildMcpSessionQuery({ client, workspace: 'papercusp-workspace', origin });

    expect(origin).toBe('agent');
    expect(query.get('origin')).toBe('agent');
    expect(resolveMcpCallOrigin('system-staging-sync-review-alarm', env)).toBeUndefined();
    expect(resolveMcpCallOrigin('vm-rig-probe', {})).toBeUndefined();
  });

  it('uses the stable spawn identity when no session id is available', () => {
    const client = 's-76543210-1234-5678-9abc-def012345678';
    expect(resolveMcpCallOrigin(client, { PAPERCUSP_SPAWN_ID: client })).toBe('agent');
  });
});

describe('mcp-call result-format contract', () => {
  it('keeps the retained JSON body when a projection warning leads content', () => {
    const warning =
      '⚠ pick path(s) matched nothing: terminal — those field(s) are ABSENT from the body below.';
    const body = { rows: [{ id: 'WI-1' }], retained: true };
    const raw = `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'text', text: warning },
          { type: 'text', text: JSON.stringify(body) },
        ],
      },
    })}\n\n`;

    expect(parseSse(raw)).toEqual({ result: body });
  });

  it('falls back to the first plain-text block when no JSON body exists', () => {
    const text = 'invalid_input: bad request';
    const raw = `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text }, { type: 'text', text: 'See also: help' }] },
    })}\n\n`;

    expect(parseSse(raw)).toEqual({ result: text });
  });

  it('fails closed when the MCP tool returns a result.isError envelope', () => {
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'invalid_input: Unrecognized key: "harness"' }],
        isError: true,
      },
    };

    expect(parseSse(`data: ${JSON.stringify(response)}\n\n`)).toEqual({
      error: response.result,
    });
  });

  it('preserves a JSON admission shed instead of reporting a missing SSE frame', () => {
    const error = {
      code: -32000,
      message: 'operator MCP admission is saturated — request shed, retry shortly',
      data: { retryable: true, reason: 'loop_pressure_critical' },
    };
    expect(parseSse(JSON.stringify({ jsonrpc: '2.0', id: 1, error }))).toEqual({ error });
  });

  it('carries the launched judge role into the admission routing query', () => {
    const role = resolveMcpRole({ PAPERCUSP_ROLE: 'judge', PAPERCUSP_AGENT_ROLE: 'worker' });
    const query = buildMcpSessionQuery({ client: 'judge-session', workspace: 'papercusp-workspace', role });
    expect(query.get('role')).toBe('judge');
    expect(resolveMcpRole({ PAPERCUSP_AGENT_ROLE: 'judge' })).toBe('judge');
    expect(resolveMcpRole({})).toBeUndefined();
  });

  it('pins JSON so the maintained vmcall driver can validate successful output', () => {
    const query = buildMcpSessionQuery({
      client: 'vm-rig-probe',
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
    });

    expect(Object.fromEntries(query)).toEqual({
      superuser: '1',
      client: 'vm-rig-probe',
      workspace: 'papercusp-workspace',
      format: 'json',
      harness: 'papercusp',
    });
  });

  it('preserves the current Codex incarnation when the fallback reuses an owner id', () => {
    const client = 'su-retained-owner';
    for (const nativeSession of ['native-predecessor', 'native-successor']) {
      const query = buildMcpSessionQuery({
        client, workspace: 'papercusp-workspace',
        env: { PAPERCUSP_SID: client, CODEX_SESSION_ID: nativeSession },
      });
      expect(query.get('client')).toBe(client);
      expect(query.get('native_session')).toBe(nativeSession);
    }
  });

  it('sends the Claude session id, not an inherited Codex id, from a Claude session (WI-10006008)', () => {
    const client = 'su-claude';
    const query = buildMcpSessionQuery({
      client, workspace: 'papercusp-workspace',
      env: {
        PAPERCUSP_SID: client,
        PAPERCUSP_AGENT: 'claude',
        CLAUDE_CODE_SESSION_ID: 'claude-native',
        CODEX_SESSION_ID: 'stale-codex-from-parent-shell',
      },
    });
    expect(query.get('native_session')).toBe('claude-native');
    // A Claude session with no Claude id sends none rather than the Codex one.
    expect(buildMcpSessionQuery({
      client, workspace: 'papercusp-workspace',
      env: { PAPERCUSP_SID: client, PAPERCUSP_AGENT: 'claude', CODEX_SESSION_ID: 'stale-codex' },
    }).has('native_session')).toBe(false);
    // Codex keeps its current behaviour.
    expect(buildMcpSessionQuery({
      client, workspace: 'papercusp-workspace',
      env: { PAPERCUSP_SID: client, PAPERCUSP_AGENT: 'codex', CODEX_SESSION_ID: 'codex-native', CLAUDE_CODE_SESSION_ID: 'claude-x' },
    }).get('native_session')).toBe('codex-native');
  });

  it('prefers the launcher-bound Claude id when /clear rotates the current session id', () => {
    const client = 'su-claude';
    const query = buildMcpSessionQuery({
      client, workspace: 'papercusp-workspace',
      env: {
        PAPERCUSP_SID: client,
        PAPERCUSP_AGENT: 'claude',
        PAPERCUSP_NATIVE_SESSION_ID: 'bound-at-launch',
        CLAUDE_CODE_SESSION_ID: 'rotated-after-clear',
        CODEX_SESSION_ID: 'stale-codex-from-parent-shell',
      },
    });

    expect(query.get('native_session')).toBe('bound-at-launch');
  });

  it('retries only the exact foreign-session pre-dispatch refusal for an inherited Codex id', () => {
    const client = 'su-cold-codex';
    const env = { PAPERCUSP_SID: client, CODEX_SESSION_ID: 'inherited-native-id' };
    const query = buildMcpSessionQuery({ client, workspace: 'papercusp-workspace', env });
    const refusal = {
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: superuser_foreign_native_session' }],
    };

    expect(isForeignNativeSessionRejection(refusal)).toBe(true);
    expect(shouldRetryWithoutNativeSession(refusal, { client, query, env })).toBe(true);
    expect(shouldRetryWithoutNativeSession({
      isError: true,
      content: [{ type: 'text', text: 'request_rejected: authorization_denied' }],
    }, { client, query, env })).toBe(false);
    expect(shouldRetryWithoutNativeSession(refusal, {
      client,
      query,
      env: { ...env, PAPERCUSP_NATIVE_SESSION_ID: 'launcher-bound-id' },
    })).toBe(false);
    expect(buildMcpSessionQuery({
      client, workspace: 'papercusp-workspace', env, nativeSessionOverride: null,
    }).has('native_session')).toBe(false);
  });

  it('does not attach the current native session to another or legacy client', () => {
    expect(buildMcpSessionQuery({
      client: 'su-other', workspace: 'papercusp-workspace',
      env: { PAPERCUSP_SID: 'su-current', CODEX_SESSION_ID: 'native-current' },
    }).has('native_session')).toBe(false);
    expect(buildMcpSessionQuery({
      client: 'su-current', workspace: 'papercusp-workspace',
      env: { PAPERCUSP_SID: 'su-current' },
    }).has('native_session')).toBe(false);
  });

  it('maps --all-workspaces to the unscoped workspace wildcard', () => {
    const query = buildMcpSessionQuery({
      client: 'vm-rig-probe',
      workspace: 'papercusp-workspace',
      allWorkspaces: true,
    });

    expect(query.get('workspace')).toBe('*');
  });

  it('runs when macOS canonicalizes /tmp to /private/tmp', () => {
    const canonical = '/private/tmp/mcp-call.mjs';
    const realpath = (path: string) =>
      path === '/tmp/mcp-call.mjs' ? canonical : path;

    expect(
      isInvokedDirectly(
        '/tmp/mcp-call.mjs',
        'file:///private/tmp/mcp-call.mjs',
        realpath,
      ),
    ).toBe(true);
  });

  it('does not run main when imported by a different script', () => {
    expect(
      isInvokedDirectly(
        '/workspace/vitest.mjs',
        'file:///workspace/scripts/mcp-call.mjs',
        (path: string) => path,
      ),
    ).toBe(false);
  });
});

describe('mcp-call client identity', () => {
  it('keeps the same launch identity across helper processes', () => {
    const env = { PAPERCUSP_SPAWN_ID: 'content-fixer-spawn-42' };

    expect(resolveMcpClientId({}, env, 101)).toBe('content-fixer-spawn-42');
    expect(resolveMcpClientId({}, env, 202)).toBe('content-fixer-spawn-42');
  });

  it('preserves explicit and full-session identities ahead of the spawn fallback', () => {
    const env = {
      PAPERCUSP_SID: 'su-session',
      PAPERCUSP_SPAWN_ID: 'content-fixer-spawn-42',
    };

    expect(resolveMcpClientId({ client: 'explicit-client' }, env, 101)).toBe('explicit-client');
    expect(resolveMcpClientId({ client: '   ' }, env, 101)).toBe('su-session');
  });

  it('retains the per-process fallback for an ordinary terminal', () => {
    expect(resolveMcpClientId({}, {}, 303)).toBe('mcp-call-303');
  });
});

describe('mcp-call shell-safe JSON input', () => {
  it('keeps the legacy positional JSON source', () => {
    expect(jsonSourceKind({ jsonArgs: '{}', flags: {} })).toBe('inline');
    expect(readJsonArgs({ jsonArgs: '{"message":"it\'s safe"}', flags: {} })).toEqual({
      message: "it's safe",
    });
  });

  it('reads JSON from stdin when --json - is used', () => {
    expect(jsonSourceKind({ jsonArgs: undefined, flags: { json: '-' } })).toBe('stdin');
    const readFile = (path: number | string) => {
      expect(path).toBe(0);
      return '{"message":"it\'s safe"}';
    };
    expect(readJsonArgs({ jsonArgs: undefined, flags: { json: '-' } }, { readFile })).toEqual({
      message: "it's safe",
    });
  });

  it('reads JSON from a file and gives the file source precedence', () => {
    expect(jsonSourceKind({ jsonArgs: '{}', flags: { jsonFile: 'payload.json', json: '{}' } })).toBe('file');
    const readFile = (path: number | string) => {
      expect(path).toBe('payload.json');
      return '{"message":"it\'s safe"}';
    };
    expect(readJsonArgs({ jsonArgs: '{}', flags: { jsonFile: 'payload.json', json: '{}' } }, { readFile })).toEqual({
      message: "it's safe",
    });
  });

  it('reports malformed safe-source JSON instead of dispatching it', () => {
    expect(() => readJsonArgs(
      { jsonArgs: undefined, flags: { json: '-' } },
      { readFile: () => '{not-json' },
    )).toThrow('stdin is not valid JSON');
  });
});

const MCP_CALL_SCRIPT = fileURLToPath(new URL('../../../scripts/mcp-call.mjs', import.meta.url));

describe('mcp-call standalone deployment', () => {
  it('runs when deployed as the only file in /tmp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-call-standalone-'));
    const standaloneScript = join(root, 'mcp-call.mjs');
    try {
      await writeFile(standaloneScript, await readFile(MCP_CALL_SCRIPT, 'utf8'));
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
        const child = spawn(process.execPath, [standaloneScript, '--help'], {
          env: { ...process.env, PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170/api/mcp' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', fail);
        child.on('close', (code) => done({ code, stdout, stderr }));
      });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('usage: node scripts/mcp-call.mjs');
      expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type McpCallFetchFixture = {
  home: string;
  isolatedHome: string;
  logPath: string;
  preloadPath: string;
};

async function withMcpCallFetchFixture<T>(run: (fixture: McpCallFetchFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-call-fetch-fixture-'));
  const home = join(root, 'home');
  const isolatedHome = join(root, 'isolated');
  const logPath = join(root, 'fetch-log.jsonl');
  const preloadPath = join(root, 'fetch-stub.mjs');
  await mkdir(join(home, '.papercusp'), { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  const preloadSource = [
    "import { appendFileSync } from 'node:fs';",
    'let fetchCount = 0;',
    'globalThis.fetch = async (input, init = {}) => {',
    '  fetchCount += 1;',
    '  const request = {',
    '    url: String(input),',
    "    authorization: new Headers(init.headers).get('authorization'),",
    "    body: JSON.parse(String(init.body ?? '{}'))," ,
    '  };',
    "  appendFileSync(process.env.MCP_CALL_FETCH_LOG, JSON.stringify(request) + '\\n');",
    '  const mode = process.env.MCP_CALL_FETCH_MODE;',
    "  if (mode === 'repair-queue-fallback' && new URL(request.url).port === '41001') {",
    "    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });",
    '  }',
    "  if (mode === 'transport-reset') {",
    "    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) });",
    '  }',
    '  let result;',
    "  if (mode === 'always-invalid' || (mode === 'token-fallback' && request.authorization === 'Bearer isolated-invalid')) {",
    "    result = { isError: true, content: [{ type: 'text', text: 'request_rejected: superuser_invalid_bearer' }] };",
    "  } else if (mode === 'generic-auth') {",
    "    result = { isError: true, content: [{ type: 'text', text: 'request_rejected: authorization_denied' }] };",
    "  } else if (mode === 'foreign-native' && new URL(request.url).searchParams.has('native_session')) {",
    "    result = { isError: true, content: [{ type: 'text', text: 'request_rejected: superuser_foreign_native_session' }] };",
    "  } else if (mode === 'admission-shed' && fetchCount < 3) {",
    "    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.body.id, error: { code: -32000, message: 'operator MCP admission is saturated — request shed, retry shortly', data: { retryable: true, reason: 'loop_pressure_critical' } } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } });",
    "  } else if (mode === 'repair-queue-fallback' && request.body.params?.name === 'release:repair-queue' && request.body.params?.arguments?.op === 'get') {",
    "    result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, target: { workspaceId: 'test-ws', installSlug: process.env.MCP_CALL_TARGET_INSTALL_SLUG } }) }] };",
    '  } else {',
    "    result = { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };",
    '  }',
    "  const raw = 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: request.body.id, result }) + '\\n\\n';",
    "  return new Response(raw, { status: 200, headers: { 'content-type': 'text/event-stream' } });",
    '};',
  ].join('\n');
  await writeFile(preloadPath, preloadSource);
  try {
    return await run({ home, isolatedHome, logPath, preloadPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runMcpCallWithArgs(args: string[], envOverrides: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const env = { ...process.env };
    for (const key of [
      'PAPERCUSP_HOME',
      'PAPERCUSP_MCP_TOKEN_FILE',
      'PAPERCUSP_HONO_PORT',
      'PAPERCUSP_OPERATOR_URL',
      'PAPERCUSP_MCP_PROXY_PORT',
      'MCP_CALL_TARGET_INSTALL_SLUG',
    ]) delete env[key];
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const child = spawn(process.execPath, [MCP_CALL_SCRIPT, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

function runMcpCallWithFetchFixture(
  fixture: McpCallFetchFixture,
  args: string[] = [],
  envOverrides: NodeJS.ProcessEnv = {},
  tool = 'work_items:create',
  jsonArgs = '{}',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runMcpCallWithArgs([
    tool,
    jsonArgs,
    '--client',
    'mcp-call-fetch-fixture',
    '--workspace',
    'test-ws',
    ...args,
  ], {
    HOME: fixture.home,
    PAPERCUSP_HOME: fixture.isolatedHome,
    MCP_CALL_FETCH_LOG: fixture.logPath,
    NODE_OPTIONS: '--import=' + fixture.preloadPath,
    ...envOverrides,
  });
}

async function readMcpCallFetchLog(path: string): Promise<Array<{ url: string; authorization: string | null; body: { params: unknown } }>> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('mcp-call release repair-queue install scope', () => {
  it('does not send a repair operation to a fallback endpoint with a different install target', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'isolated-valid\n');
      const run = await runMcpCallWithFetchFixture(
        fixture,
        ['--harness', 'papercusp-pr-drill-20261014', '--transport', 'http'],
        {
          PAPERCUSP_HONO_PORT: '41001',
          MCP_CALL_FETCH_MODE: 'repair-queue-fallback',
          MCP_CALL_TARGET_INSTALL_SLUG: 'papercusp',
        },
        'release:repair-queue',
        '{"op":"admit","paths":["src/fix.ts"]}',
      );
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code).toBe(MCP_CALL_TOOL_NOT_OK_EXIT);
      expect(run.stderr).toContain('expected install scope "papercusp-pr-drill-20261014"');
      expect(run.stderr).toContain('port 3070=papercusp');
      // A mismatched candidate gets only a read-only probe; search continues through the proxy.
      expect(requests).toHaveLength(3);
      expect(requests.map((request) => new URL(request.url).port)).toEqual(['41001', '3070', '9071']);
      expect(requests.every((request) =>
        (request.body.params as { name: string }).name === 'release:repair-queue' &&
        (request.body.params as { arguments: { op: string } }).arguments.op === 'get',
      )).toBe(true);
      expect(requests.every((request) => new URL(request.url).searchParams.get('harness') === 'papercusp-pr-drill-20261014'))
        .toBe(true);
    });
  });

  it('allows fallback only after the read-only target probe matches the requested install', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'isolated-valid\n');
      const run = await runMcpCallWithFetchFixture(
        fixture,
        ['--harness', 'papercusp-pr-drill-20261014', '--transport', 'http'],
        {
          PAPERCUSP_HONO_PORT: '41001',
          MCP_CALL_FETCH_MODE: 'repair-queue-fallback',
          MCP_CALL_TARGET_INSTALL_SLUG: 'papercusp-pr-drill-20261014',
        },
        'release:repair-queue',
        '{"op":"admit","paths":["src/fix.ts"]}',
      );
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });
      expect(requests).toHaveLength(3);
      expect(requests.map((request) => new URL(request.url).port)).toEqual(['41001', '3070', '3070']);
      expect(requests.map((request) => (request.body.params as { arguments: { op: string } }).arguments.op))
        .toEqual(['get', 'get', 'admit']);
      expect(requests.every((request) => new URL(request.url).searchParams.get('harness') === 'papercusp-pr-drill-20261014'))
        .toBe(true);
    });
  });
});

/** Run `run` against a local MCP endpoint that answers every tools/call with `toolResult`. */
async function withFakeMcpEndpoint<T>(
  toolResult: unknown,
  run: (port: number, home: string) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'mcp-call-exit-'));
  await mkdir(join(home, '.papercusp'), { recursive: true });
  await writeFile(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { id } = JSON.parse(body) as { id: number };
      const frame = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(toolResult) }] } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(frame)}\n\n`);
    });
  });
  await new Promise<void>((ready) => server.listen(0, ready));
  try {
    return await run((server.address() as AddressInfo).port, home);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
    await rm(home, { recursive: true, force: true });
  }
}

/** Spawn the real script with stdout on a pipe, the way a shell `$(...)` reads it. */
function runMcpCall(port: number, home: string, extraArgs: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runMcpCallWithArgs([
    'work_items:create',
    '{}',
    '--port',
    String(port),
    '--client',
    'mcp-call-exit-test',
    '--workspace',
    'test-ws',
    ...extraArgs,
  ], { HOME: home });
}

describe('mcp-call actual CLI token and endpoint recovery', () => {
  it('retries a pre-dispatch admission shed and preserves the original request', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'isolated-valid\n');
      const run = await runMcpCallWithFetchFixture(fixture, ['--port', '3170'], {
        MCP_CALL_FETCH_MODE: 'admission-shed',
      });
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });
      expect(requests).toHaveLength(3);
      expect(requests[0].body).toEqual(requests[1].body);
      expect(requests[1].body).toEqual(requests[2].body);
      expect(run.stderr).toContain('rejected the request before dispatch');
    });
  });

  it('retries an inherited foreign Codex session without changing the client or call', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'test-token\n');
      const run = await runMcpCallWithFetchFixture(fixture, [
        '--port',
        '3170',
        '--idempotency-key',
        'native-session-fallback-1',
      ], {
        MCP_CALL_FETCH_MODE: 'foreign-native',
        PAPERCUSP_SID: 'mcp-call-fetch-fixture',
        PAPERCUSP_NATIVE_SESSION_ID: undefined,
        CODEX_SESSION_ID: 'inherited-foreign-session',
      });
      const requests = await readMcpCallFetchLog(fixture.logPath);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });
      expect(requests).toHaveLength(2);
      const firstUrl = new URL(requests[0].url);
      const secondUrl = new URL(requests[1].url);

      expect(firstUrl.searchParams.get('client')).toBe('mcp-call-fetch-fixture');
      expect(firstUrl.searchParams.get('native_session')).toBe('inherited-foreign-session');
      expect(secondUrl.searchParams.get('client')).toBe('mcp-call-fetch-fixture');
      expect(secondUrl.searchParams.has('native_session')).toBe(false);
      expect(requests[0].body.params).toEqual(requests[1].body.params);
      expect((requests[1].body.params as { _meta: { idempotencyKey: string } })._meta.idempotencyKey)
        .toBe('native-session-fallback-1');
      expect(run.stderr).toContain('retrying once with the same client identity');
    });
  });

  it('retries the same request with the shared token only after exact bearer refusal', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'isolated-invalid\n');
      await writeFile(join(fixture.home, '.papercusp', 'superuser-token'), 'shared-valid\n');
      const run = await runMcpCallWithFetchFixture(fixture, [
        '--port',
        '3170',
        '--idempotency-key',
        'dummy-token-fallback-1',
      ], { MCP_CALL_FETCH_MODE: 'token-fallback' });
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });
      expect(requests.map((request) => request.authorization)).toEqual([
        'Bearer isolated-invalid',
        'Bearer shared-valid',
      ]);
      expect(requests[0].url).toBe(requests[1].url);
      expect(requests[0].body.params).toEqual(requests[1].body.params);
      expect((requests[0].body.params as { _meta: { idempotencyKey: string } })._meta.idempotencyKey)
        .toBe('dummy-token-fallback-1');
    });
  });

  it.each(['missing', 'empty'])('skips a %s isolated token before sending and uses the shared token', async (isolatedState) => {
    await withMcpCallFetchFixture(async (fixture) => {
      if (isolatedState === 'empty') await writeFile(join(fixture.isolatedHome, 'superuser-token'), '');
      await writeFile(join(fixture.home, '.papercusp', 'superuser-token'), 'shared-valid\n');
      const run = await runMcpCallWithFetchFixture(fixture, ['--port', '3170']);
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code, run.stderr).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0].authorization).toBe('Bearer shared-valid');
    });
  });

  it('keeps PAPERCUSP_MCP_TOKEN_FILE authoritative after an invalid-bearer refusal', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      const explicitPath = join(fixture.home, 'explicit-token');
      await writeFile(explicitPath, 'explicit-invalid\n');
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'isolated-valid\n');
      await writeFile(join(fixture.home, '.papercusp', 'superuser-token'), 'shared-valid\n');
      const run = await runMcpCallWithFetchFixture(fixture, ['--port', '3170'], {
        PAPERCUSP_MCP_TOKEN_FILE: explicitPath,
        MCP_CALL_FETCH_MODE: 'always-invalid',
      });
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code, run.stderr).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].authorization).toBe('Bearer explicit-invalid');
    });
  });

  it('does not substitute a token for a generic tool authorization error', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'isolated-valid\n');
      await writeFile(join(fixture.home, '.papercusp', 'superuser-token'), 'shared-valid\n');
      const run = await runMcpCallWithFetchFixture(fixture, ['--port', '3170'], {
        MCP_CALL_FETCH_MODE: 'generic-auth',
      });
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code, run.stderr).toBe(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].authorization).toBe('Bearer isolated-valid');
    });
  });

  it('stops on an unknown transport outcome instead of trying more endpoints or tokens', async () => {
    await withMcpCallFetchFixture(async (fixture) => {
      await writeFile(join(fixture.isolatedHome, 'superuser-token'), 'isolated-valid\n');
      await writeFile(join(fixture.home, '.papercusp', 'superuser-token'), 'shared-valid\n');
      const run = await runMcpCallWithFetchFixture(fixture, [], {
        PAPERCUSP_HONO_PORT: '41001',
        PAPERCUSP_MCP_PROXY_PORT: '41002',
        MCP_CALL_FETCH_MODE: 'transport-reset',
      });
      const requests = await readMcpCallFetchLog(fixture.logPath);

      expect(run.code, run.stderr).toBe(4);
      expect(run.stderr).toContain('check a write outcome before retrying it');
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0].url).port).toBe('41001');
      expect(requests[0].authorization).toBe('Bearer isolated-valid');
    });
  });
});

describe('mcp-call ok:false exit status (EI-24654733539966460)', () => {
  it('reports a top-level or batch-entry refusal, and nothing else', () => {
    expect(toolResultNotOkReason({ ok: false, error: 'not found' })).toBe('not found');
    expect(toolResultNotOkReason({ ok: false })).toBe('no reason given');
    expect(toolResultNotOkReason({ ok: true, results: [{ ok: true }, { ok: false, error: 'duplicate key' }] }))
      .toBe('1 of 2 result(s) ok:false; first: duplicate key');
    // Projections, prose and arrays do not imply a refusal.
    for (const answer of [{ ok: true }, { results: [{ ok: true }] }, { state: 'open' }, [{ ok: false }], 'ok:false', null, undefined]) {
      expect(toolResultNotOkReason(answer)).toBeNull();
    }
  });

  it('uses the same exit code as ptool, so shell callers need one rule', async () => {
    const { PTOOL_TOOL_NOT_OK_EXIT } = await import('./ptool.mjs');
    expect(MCP_CALL_TOOL_NOT_OK_EXIT).toBe(PTOOL_TOOL_NOT_OK_EXIT);
  });

  it('exits 5 with the complete result on stdout when the tool answers ok:false', async () => {
    // Large enough that exiting before stdout drains would truncate it.
    const refusal = { ok: false, results: [{ ok: false, error: 'duplicate key' }], padding: 'x'.repeat(256 * 1024) };
    const run = await withFakeMcpEndpoint(refusal, runMcpCall);
    expect(run.code, run.stderr).toBe(MCP_CALL_TOOL_NOT_OK_EXIT);
    expect(JSON.parse(run.stdout)).toEqual(refusal);
    expect(run.stderr).toContain('the tool reported failure (1 of 1 result(s) ok:false; first: duplicate key)');
  });

  it('still exits 0 when the answer does not report failure', async () => {
    const run = await withFakeMcpEndpoint({ ok: true, id: 'EI-1' }, runMcpCall);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ ok: true, id: 'EI-1' });
  });
});

describe('mcp-call output error envelopes (EI-26807000988480218)', () => {
  const failedOutput = {
    schemaVersion: 'papercusp.output-envelope/v1',
    summary: '',
    content: [],
    state: 'error',
    error: {
      code: 'output_spill_failed',
      message: 'Output exceeded its hard budget and the spill write failed.',
      retryable: true,
    },
  };

  it('reports a canonical output error even without an ok field', () => {
    expect(toolResultNotOkReason(failedOutput))
      .toBe('output envelope error: output_spill_failed: Output exceeded its hard budget and the spill write failed.');
    expect(toolResultNotOkReason({ ...failedOutput, error: undefined }))
      .toBe('output envelope error: no reason given');
  });

  it('keeps ordinary state fields and non-error envelopes successful', () => {
    for (const answer of [
      { state: 'error', error: 'an application state, not a transport envelope' },
      { ...failedOutput, state: 'complete', error: undefined },
      { ...failedOutput, state: 'incomplete', error: undefined },
    ]) expect(toolResultNotOkReason(answer)).toBeNull();
  });

  it.each([false, true])('exits 5 for an output error with allow-partial=%s', async (allowPartial) => {
    const run = await withFakeMcpEndpoint(failedOutput, (port, home) =>
      runMcpCall(port, home, allowPartial ? ['--allow-partial'] : []));
    expect(run.code, run.stderr).toBe(MCP_CALL_TOOL_NOT_OK_EXIT);
    expect(JSON.parse(run.stdout)).toEqual(failedOutput);
    expect(run.stderr).toContain('the tool reported failure (output envelope error: output_spill_failed:');
  });
});

describe('mcp-call admission-shed retry classification', () => {
  it('retries only the operator pre-dispatch reasons', () => {
    for (const reason of ['loop_pressure_critical', 'operator_admission_capacity']) {
      expect(isRetryableAdmissionShed({ code: -32000, data: { retryable: true, reason } }, 429)).toBe(true);
    }
    expect(isRetryableAdmissionShed({ code: -32000, data: { retryable: true, reason: 'provider_rate_limit' } }, 429)).toBe(false);
    expect(isRetryableAdmissionShed({ code: -32000, data: { retryable: false, reason: 'loop_pressure_critical' } }, 429)).toBe(false);
    expect(isRetryableAdmissionShed({ code: -32000, data: { retryable: true, reason: 'loop_pressure_critical' } }, 200)).toBe(true);
  });

  it('honors a bounded Retry-After hint', () => {
    const response = new Response('', { headers: { 'retry-after': '2' } });
    expect(admissionRetryDelayMs(response, { data: { retryAfterSec: 9 } })).toBe(2_000);
    expect(admissionRetryDelayMs(new Response(''), {})).toBe(1_000);
    expect(admissionRetryDelayMs(new Response('', { headers: { 'retry-after': '999' } }), {})).toBe(10_000);
  });
});

// EI-24678010189721217: a door-projected rubrics:amend dry-run turned preview.approval.bars
// into placeholder strings, and two agents posted them as an approval (posts 1151113, 1153517).
describe('mcp-call door-projected partial result (EI-24678010189721217)', () => {
  const PLACEHOLDER = '[omitted: depth limit — recover: see _projection.cursor]';
  const projected = {
    ok: true,
    preview: { approval: { kind: 'acceptance-bar-amendment-approval', bars: [PLACEHOLDER, PLACEHOLDER] } },
    _partial: true,
    _projection: { kind: 'bounded-payload', truncated: true, next: `see ${PLACEHOLDER}` },
  };

  it('names the placeholder paths, and passes a clean body and prose that only quotes a placeholder', () => {
    expect(projectedResultReason(projected))
      .toBe('door-projected partial result: placeholder value(s) at $.preview.approval.bars[0], $.preview.approval.bars[1]');
    expect(projectedResultReason({ ok: true, summary: `long text…[TRUNCATED +5001 chars — see _projection.cursor]` }))
      .toBe('door-projected partial result: placeholder value(s) at $.summary');
    expect(projectedResultReason({ ok: true, _partial: true, rows: [] })).toBe('door-projected partial result: root _partial marker');
    for (const clean of [
      { ok: true, preview: { approval: { bars: [{ barKey: 'r-01', hash: 'abc' }] } } },
      { ok: true, summary: `bars became '${PLACEHOLDER}' strings (EI-24678010189721217)` },
      [PLACEHOLDER, 'x'].join(' '), null, undefined,
    ]) {
      expect(projectedResultReason(clean)).toBeNull();
    }
  });

  it('exits 6 with the partial body still on stdout, and --allow-partial keeps exit 0', async () => {
    const run = await withFakeMcpEndpoint(projected, runMcpCall);
    expect(run.code, run.stderr).toBe(MCP_CALL_PROJECTED_RESULT_EXIT);
    expect(JSON.parse(run.stdout)).toEqual(projected);
    expect(run.stderr).toContain('the result above is INCOMPLETE (door-projected partial result: placeholder value(s) at $.preview.approval.bars[0]');

    const allowed = await withFakeMcpEndpoint(projected, (port: number, home: string) => runMcpCall(port, home, ['--allow-partial']));
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(allowed.stderr).toContain('--allow-partial given');
  });
});

// WI-6554700010019317: a psu native Bash runs with --unshare-net, so every
// loopback TCP port refuses while the operator is healthy. The toolless
// recovery ladder's last rung (this script) must then reach the operator's
// agent-MCP unix socket instead of dead-ending on ECONNREFUSED.
describe('mcp-call unix-socket fallback (WI-6554700010019317)', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3070'), { code: 'ECONNREFUSED' });
  const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

  it('defaults to auto and rejects an unknown transport', () => {
    expect(MCP_CALL_TRANSPORTS).toEqual(['auto', 'http', 'uds']);
    expect(resolveMcpTransport({})).toBe('auto');
    expect(resolveMcpTransport({ transport: 'uds' })).toBe('uds');
    expect(() => resolveMcpTransport({ transport: 'tcp' })).toThrow(/--transport must be one of auto, http, uds/);
    expect(parseArgs(['coord:whoami', '{}', '--transport', 'uds']).flags.transport).toBe('uds');
  });

  it('falls back only when every HTTP attempt was refused before a request was sent', () => {
    const allRefused = [{ port: '9071', error: refused() }, { port: '3070', error: refused() }];
    expect(shouldTryUdsFallback({ transport: 'auto', attempts: allRefused })).toBe(true);
    // A non-refusal can mean the request reached a handler: never send it twice.
    expect(shouldTryUdsFallback({ transport: 'auto', attempts: [...allRefused, { port: '3170', error: reset() }] })).toBe(false);
    expect(shouldTryUdsFallback({ transport: 'auto', attempts: [] })).toBe(false);
    expect(shouldTryUdsFallback({ transport: 'http', attempts: allRefused })).toBe(false);
    expect(shouldTryUdsFallback({ transport: 'uds', attempts: [] })).toBe(true);
    expect(buildUdsFallbackNotice(allRefused)).toContain('port(s) 9071, 3070');
  });

  it('reads the discovery descriptor from the operator home, never the session PAPERCUSP_HOME', () => {
    expect(resolveAgentMcpDiscoveryHome({ PAPERCUSP_HOME: '/ws/papercusp' }, () => '/home/u')).toBe('/home/u');
    expect(resolveAgentMcpDiscoveryHome({ PAPERCUSP_OPERATOR_HOME: ' /real/home ' }, () => '/home/u')).toBe('/real/home');
  });

  type ConnectOptions = { url: string; headers: Record<string, string>; mode: 'uds'; name: string; home?: string };

  function fakeConnect(plan: Record<string, Array<'unavailable' | 'failed' | { callTool: (params: object) => Promise<unknown> }>>) {
    const connects: ConnectOptions[] = [];
    const calls: Array<{ port: string; params: object }> = [];
    let closed = 0;
    const connect = async (options: ConnectOptions) => {
      connects.push(options);
      const port = new URL(options.url).port;
      const step = plan[port]?.shift();
      if (step === undefined || step === 'unavailable') throw new Error('uds_endpoint_unavailable');
      if (step === 'failed') throw new Error('uds_connection_failed');
      return {
        client: {
          callTool: async (params: object) => { calls.push({ port, params }); return step.callTool(params); },
          close: async () => { closed += 1; },
        },
      };
    };
    return { connect, connects, calls, closed: () => closed };
  }

  it('skips a port with no socket, sends the call once on the next, and closes the client', async () => {
    const fake = fakeConnect({ '9071': ['unavailable'], '3070': [{ callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }] });
    const params = buildMcpCallParams('coord:whoami', {}, { outputGroupId: 'g1' });
    const outcome = await callToolViaAgentMcpUds({
      ports: ['9071', '3070'], tokens: ['tok-a', 'tok-b'], query: 'superuser=1&client=su-x', params, connect: fake.connect, home: '/home/u',
    });
    expect(outcome).toEqual({ kind: 'result', port: '3070', result: { content: [{ type: 'text', text: 'ok' }] } });
    expect(fake.calls).toEqual([{ port: '3070', params }]);
    // An unadvertised socket is not retried with the second bearer.
    expect(fake.connects.map((c) => new URL(c.url).port)).toEqual(['9071', '3070']);
    expect(fake.connects[1]).toMatchObject({
      url: 'http://localhost:3070/api/mcp?superuser=1&client=su-x',
      headers: { Authorization: 'Bearer tok-a' },
      mode: 'uds',
      home: '/home/u',
    });
    expect(fake.closed()).toBe(1);
  });

  it('retries the handshake with the next bearer, which cannot run the call twice', async () => {
    const fake = fakeConnect({ '3070': ['failed', { callTool: async () => ({ content: [] }) }] });
    const outcome = await callToolViaAgentMcpUds({
      ports: ['3070'], tokens: ['stale', 'fresh'], query: 'q=1', params: {}, connect: fake.connect,
    });
    expect(outcome.kind).toBe('result');
    expect(fake.connects.map((c) => c.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(fake.calls).toHaveLength(1);
  });

  it('returns a JSON-RPC error as the answer and does not try another port', async () => {
    const rpcError = Object.assign(new Error('MCP error -32602: bad args'), { code: -32602, data: { field: 'id' } });
    const fake = fakeConnect({
      '9071': [{ callTool: async () => { throw rpcError; } }],
      '3070': [{ callTool: async () => ({ content: [] }) }],
    });
    const outcome = await callToolViaAgentMcpUds({ ports: ['9071', '3070'], tokens: ['t'], query: '', params: {}, connect: fake.connect });
    expect(outcome).toEqual({ kind: 'error', port: '9071', error: { code: -32602, message: 'MCP error -32602: bad args', data: { field: 'id' } } });
    expect(fake.calls).toHaveLength(1);
  });

  it('reports a lost response as outcome-unknown and never re-sends the call', async () => {
    const lost = Object.assign(new Error('uds_outcome_unknown: connection lost'), { code: 'uds_outcome_unknown' });
    const fake = fakeConnect({
      '9071': [{ callTool: async () => { throw lost; } }],
      '3070': [{ callTool: async () => ({ content: [] }) }],
    });
    const outcome = await callToolViaAgentMcpUds({ ports: ['9071', '3070'], tokens: ['t'], query: '', params: {}, connect: fake.connect });
    expect(outcome.kind).toBe('outcome-unknown');
    expect(outcome).toMatchObject({ port: '9071' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.closed()).toBe(1);
  });

  it('names every unreachable socket when none accepts the connection', async () => {
    const fake = fakeConnect({ '9071': ['unavailable'], '3170': ['failed', 'failed'] });
    const outcome = await callToolViaAgentMcpUds({ ports: ['9071', '3170'], tokens: ['a', 'b'], query: '', params: {}, connect: fake.connect });
    expect(outcome).toEqual({
      kind: 'unavailable',
      unavailable: [
        { port: '9071', reason: 'uds_endpoint_unavailable' },
        { port: '3170', reason: 'uds_connection_failed' },
        { port: '3170', reason: 'uds_connection_failed' },
      ],
    });
    expect(fake.calls).toHaveLength(0);
    expect(buildUdsUnavailableDiagnostic(outcome.kind === 'unavailable' ? outcome.unavailable : [])).toContain('port 3170: uds_connection_failed');
  });

  it('--transport uds skips HTTP entirely and reports a missing socket descriptor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-call-uds-'));
    try {
      const tokenFile = join(root, 'superuser-token');
      await writeFile(tokenFile, 'fixture-token\n', { mode: 0o600 });
      const result = await runMcpCallWithArgs(
        ['coord:whoami', '{}', '--transport', 'uds', '--port', '1', '--client', 'su-uds-fixture'],
        { PAPERCUSP_MCP_TOKEN_FILE: tokenFile, PAPERCUSP_OPERATOR_HOME: root, HOME: root },
      );
      expect(result.code, result.stderr).toBe(4);
      expect(result.stderr).toContain('no operator agent-MCP unix socket accepted the connection');
      expect(result.stderr).toContain('port 1: uds_endpoint_unavailable');
      // The HTTP pass never ran: no ECONNREFUSED diagnostic for port 1.
      expect(result.stderr).not.toContain('ECONNREFUSED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

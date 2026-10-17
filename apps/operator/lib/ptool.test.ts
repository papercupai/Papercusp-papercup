import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { MCP_PROXY_RETRY_WINDOW_MS } from '../lib/mcp-proxy/budgets.mjs';
import { HEADLESS_BOOT_RECEIPT_MS, KICKOFF_PROOF_WINDOW_MS } from '@papercusp/operator-core/lib/console-spawn';
import { AGENT_LAUNCH_HANDLER_TIMEOUT_SEC } from '@papercusp/operator-core/lib/agent-kickoff/launch-budgets.mjs';
import { createMcpProxy } from './mcp-proxy/proxy';
import {
  MCP_TRANSPORT_CAP_MS,
} from '@papercusp/operator-core/lib/agent-tools/capability/foreground-transport-cap';
import {
  parseArgs,
  serviceOf,
  groupTools,
  firstLine,
  normalizeType,
  promptSpecsFromSchema,
  coerceArg,
  mergeConvenienceArgs,
  mergeDispatchProjection,
  prettyText,
  resultToText,
  buildMcpUrl,
  buildCallToolParams,
  listAllTools,
  listToolsWithLocalRetry,
  PTOOL_LIST_TOOLS_TIMEOUT_MS,
  PTOOL_CALL_TOOL_TIMEOUT_MS,
  PTOOL_FOREGROUND_TOOL_TIMEOUT_MS,
  PTOOL_DB_MIGRATE_TIMEOUT_MS,
  PTOOL_AGENT_LAUNCH_TIMEOUT_MS,
  PTOOL_DEV_RESTART_TIMEOUT_MS,
  PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS,
  PTOOL_SCORECARD_EMIT_TIMEOUT_MS,
  PTOOL_SCORECARD_REPAIR_TIMEOUT_MS,
  PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS,
  PTOOL_LOCKS_LIST_TIMEOUT_MS,
  timeoutForTool,
  isLoopPressureShed,
  callToolWithPressureRetry,
  connectWithLocalRetry,
  shouldRediscoverOperatorUrl,
  formatOperatorConnectFailure,
  isExplicitHttpConnectFailure,
  isRetryableLocalHttpConnectFailure,
  PTOOL_CONNECT_TIMEOUT_MS,
  PTOOL_CONNECT_MAX_ATTEMPTS,
  resolveWorkspaceScope,
  jsonSourceKind,
  parseJsonInput,
  scriptSourceKind,
  shouldPrintInvocationLine,
  shouldPrintRawResult,
  resolveTokenPath,
  PTOOL_TRUNCATED_RESULT_MESSAGE,
  PTOOL_USAGE,
} from '../scripts/ptool.mjs';

describe('ptool parseArgs', () => {
  it('defaults omitted argv to the interactive picker', () => {
    expect(parseArgs()).toEqual(parseArgs([]));
  });

  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      tool: null,
      json: null,
      jsonFile: null,
      script: null,
      scriptFile: null,
      list: false,
      listFilter: null,
      workspace: null,
      allWorkspaces: false,
      harness: null,
      projection: null,
      idempotencyKey: null,
      raw: false,
      url: null,
      tokenFile: null,
      transport: null,
      help: false,
    });
  });

  it('takes the first positional as the tool name', () => {
    expect(parseArgs(['harness:list']).tool).toBe('harness:list');
  });

  it('parses --json / --args as the args payload (= form)', () => {
    expect(parseArgs(['x:y', '--json={"a":1}']).json).toBe('{"a":1}');
    expect(parseArgs(['x:y', '--args={"a":1}']).json).toBe('{"a":1}');
  });

  it('parses value flags in the space-separated form', () => {
    expect(parseArgs(['x:y', '--json', '{"a":1}']).json).toBe('{"a":1}');
    const a = parseArgs(['x:y', '--workspace', 'ws1', '--harness', 'h', '--url', 'http://h:9', '--token-file', '/tmp/candidate-token']);
    expect(a).toMatchObject({ tool: 'x:y', workspace: 'ws1', harness: 'h', url: 'http://h:9', tokenFile: '/tmp/candidate-token' });
  });

  it('does not mistake a value-flag argument for the tool name', () => {
    // `{}` here is --json's value, not a positional tool name.
    expect(parseArgs(['--json', '{}', 'x:y']).tool).toBe('x:y');
    expect(parseArgs(['x:y', '--workspace', 'ws']).tool).toBe('x:y');
  });

  it('parses convenience + control flags', () => {
    const a = parseArgs(['x:y', '--workspace=ws1', '--harness=papercup', '--raw', '--url=http://h:9', '--token-file=/tmp/candidate-token', '--idempotency-key=receipt-1']);
    expect(a).toMatchObject({
      tool: 'x:y',
      workspace: 'ws1',
      harness: 'papercup',
      raw: true,
      url: 'http://h:9',
      tokenFile: '/tmp/candidate-token',
      idempotencyKey: 'receipt-1',
    });
  });

  it('treats a positional after --list as the catalog filter, not the tool', () => {
    const a = parseArgs(['--list', 'coord']);
    expect(a.list).toBe(true);
    expect(a.listFilter).toBe('coord');
    expect(a.tool).toBeNull();
  });

  it('recognizes help flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('parses --json-file (EI-14958: quoting-free JSON source)', () => {
    expect(parseArgs(['x:y', '--json-file=payload.json']).jsonFile).toBe('payload.json');
    expect(parseArgs(['x:y', '--json-file', 'payload.json']).jsonFile).toBe('payload.json');
  });

  it('parses --json - as the stdin sentinel, not a positional', () => {
    const a = parseArgs(['x:y', '--json', '-']);
    expect(a.json).toBe('-');
    expect(a.tool).toBe('x:y');
  });

  it('keeps a later stdin sentinel when convenience flags are interleaved', () => {
    expect(parseArgs(['x:y', '--json', '--workspace=ws1', '--harness=h', '-'])).toMatchObject({
      tool: 'x:y',
      json: '-',
      workspace: 'ws1',
      harness: 'h',
    });
    expect(parseArgs(['x:y', '--args', '--workspace', 'ws1', '--harness', 'h', '-'])).toMatchObject({
      tool: 'x:y',
      json: '-',
      workspace: 'ws1',
      harness: 'h',
    });
  });

  it('keeps an inline JSON value when transport flags are interleaved before it', () => {
    expect(parseArgs([
      'coord:presence',
      '--json',
      '--workspace=ws1',
      '--harness=h',
      '--projection={"pick":["[].ownerId"]}',
      '{"scope":"workspace"}',
    ])).toMatchObject({
      tool: 'coord:presence',
      json: '{"scope":"workspace"}',
      workspace: 'ws1',
      harness: 'h',
      projection: '{"pick":["[].ownerId"]}',
    });
  });

  it('applies the same interleaved-scope rule to code:run stdin scripts', () => {
    expect(parseArgs(['code:run', '--script', '--workspace=ws1', '-'])).toMatchObject({
      tool: 'code:run',
      script: '-',
      workspace: 'ws1',
    });
  });

  it('parses --projection in both value-flag forms', () => {
    expect(parseArgs(['x:y', '--projection={"pick":["results[].id"]}']).projection)
      .toBe('{"pick":["results[].id"]}');
    expect(parseArgs(['x:y', '--projection', '{"pick":["results[].state"]}']).projection)
      .toBe('{"pick":["results[].state"]}');
  });

  it('parses the quoting-safe code:run script sources', () => {
    expect(parseArgs(['code:run', '--script-file=batch.js'])).toMatchObject({
      tool: 'code:run',
      scriptFile: 'batch.js',
    });
    expect(parseArgs(['code:run', '--script', '-'])).toMatchObject({
      tool: 'code:run',
      script: '-',
    });
  });
});

describe('ptool usage guidance', () => {
  it('makes quoting-safe JSON the primary scripting path', () => {
    expect(PTOOL_USAGE).toContain('ptool <group:verb> --json - <<\'EOF\'');
    expect(PTOOL_USAGE).toContain('ptool <group:verb> --json-file payload.json');
    expect(PTOOL_USAGE).toContain('especially loop:checkpoint checks/walls');
    expect(PTOOL_USAGE).toContain('cannot safely carry an apostrophe');
  });
});

describe('ptool token path', () => {
  it('prefers an explicit token file over the environment', () => {
    expect(resolveTokenPath({
      tokenFile: '/tmp/explicit-token',
      env: { PAPERCUSP_MCP_TOKEN_FILE: '/tmp/env-token' },
      home: '/tmp/home',
    })).toBe('/tmp/explicit-token');
  });

  it('uses PAPERCUSP_MCP_TOKEN_FILE when no CLI path is supplied', () => {
    expect(resolveTokenPath({
      env: { PAPERCUSP_MCP_TOKEN_FILE: '  /tmp/env-token  ' },
      home: '/tmp/home',
    })).toBe('/tmp/env-token');
  });

  it('uses the isolated PAPERCUSP_HOME token for packaged operators', () => {
    expect(resolveTokenPath({
      env: { PAPERCUSP_HOME: '  /tmp/isolated/.papercusp  ' },
      home: '/tmp/home',
    })).toBe('/tmp/isolated/.papercusp/superuser-token');
  });

  it('falls back to the standard per-home token path', () => {
    expect(resolveTokenPath({ env: {}, home: '/tmp/home' })).toBe('/tmp/home/.papercusp/superuser-token');
  });

  it('ignores blank overrides', () => {
    expect(resolveTokenPath({ tokenFile: '  ', env: { PAPERCUSP_MCP_TOKEN_FILE: '  ' }, home: '/tmp/home' })).toBe(
      '/tmp/home/.papercusp/superuser-token',
    );
  });
});

describe('ptool workspace scope', () => {
  it('prefers an explicit workspace flag over session-derived scope', () => {
    expect(
      resolveWorkspaceScope({
        workspace: '  explicit-workspace  ',
        env: { PAPERCUSP_WORKSPACE: 'env-workspace' },
        cwd: '/tmp/.papercusp-workspaces/cwd-workspace/.papercusp',
      }),
    ).toBe('explicit-workspace');
  });

  it('uses PAPERCUSP_WORKSPACE when the CLI flag is absent', () => {
    expect(resolveWorkspaceScope({ env: { PAPERCUSP_WORKSPACE: '  env-workspace ' }, cwd: '/tmp' })).toBe('env-workspace');
  });

  it('recovers the workspace from PAPERCUSP_HOME after a warm wake drops PAPERCUSP_WORKSPACE', () => {
    expect(
      resolveWorkspaceScope({
        env: { PAPERCUSP_HOME: '/home/agent/.papercusp-workspaces/papercusp-workspace/.papercusp' },
        cwd: '/tmp/repo',
      }),
    ).toBe('papercusp-workspace');
  });

  it('also recovers from a workspace-scoped cwd', () => {
    expect(
      resolveWorkspaceScope({ env: {}, cwd: '/home/agent/.papercusp-workspaces/ws-9/.papercusp' }),
    ).toBe('ws-9');
  });

  it('does not guess a workspace outside a tracked workspace path', () => {
    expect(resolveWorkspaceScope({ env: {}, cwd: '/tmp/repo' })).toBeNull();
  });
});

describe('ptool jsonSourceKind (EI-14958)', () => {
  const base = { tool: 'x:y', json: null, jsonFile: null };

  it('returns null when no JSON source was given (prompt interactively)', () => {
    expect(jsonSourceKind(base)).toBeNull();
  });

  it('returns "inline" for a normal --json value', () => {
    expect(jsonSourceKind({ ...base, json: '{"a":1}' })).toBe('inline');
  });

  it('returns "inline" even for a payload containing an apostrophe — the caller decided how to carry it, ptool itself is fine either way', () => {
    expect(jsonSourceKind({ ...base, json: '{"copy":"it\'s fine"}' })).toBe('inline');
  });

  it('returns "stdin" for the --json - sentinel', () => {
    expect(jsonSourceKind({ ...base, json: '-' })).toBe('stdin');
  });

  it('returns "file" when --json-file is set', () => {
    expect(jsonSourceKind({ ...base, jsonFile: 'payload.json' })).toBe('file');
  });

  it('prefers --json-file over --json when (incorrectly) both are given', () => {
    expect(jsonSourceKind({ ...base, json: '{"a":1}', jsonFile: 'payload.json' })).toBe('file');
  });
});

describe('ptool parseJsonInput', () => {
  it('treats an empty stdin stream as an empty args object', () => {
    expect(parseJsonInput('', { emptyAsObject: true })).toEqual({});
    expect(parseJsonInput(' \n\t', { emptyAsObject: true })).toEqual({});
  });

  it('keeps inline and file-style empty payloads strict', () => {
    expect(() => parseJsonInput('')).toThrow();
  });

  it('still rejects malformed non-empty stdin JSON', () => {
    expect(() => parseJsonInput('{not-json', { emptyAsObject: true })).toThrow();
  });
});

describe('ptool scriptSourceKind (EI-20235746813390458)', () => {
  const base = { tool: 'code:run', script: null, scriptFile: null };

  it('returns null when no direct script source was given', () => {
    expect(scriptSourceKind(base)).toBeNull();
  });

  it('returns file for --script-file and prefers it over --script', () => {
    expect(scriptSourceKind({ ...base, scriptFile: 'batch.js' })).toBe('file');
    expect(scriptSourceKind({ ...base, script: 'inline', scriptFile: 'batch.js' })).toBe('file');
  });

  it('returns stdin for the --script - sentinel', () => {
    expect(scriptSourceKind({ ...base, script: '-' })).toBe('stdin');
  });

  it('keeps an explicitly supplied inline script as a distinct source', () => {
    expect(scriptSourceKind({ ...base, script: "return \'it\\'s safe\';" })).toBe('inline');
  });
});

describe('ptool invocation output mode (EI-20202581520430575)', () => {
  it('keeps the invocation line for interactive calls', () => {
    expect(shouldPrintInvocationLine(null)).toBe(true);
  });

  it('suppresses the invocation line for every scripted JSON source', () => {
    expect(shouldPrintInvocationLine('inline')).toBe(false);
    expect(shouldPrintInvocationLine('file')).toBe(false);
    expect(shouldPrintInvocationLine('stdin')).toBe(false);
  });

  it('routes every scripted JSON source through the raw extractor even without --raw', () => {
    expect(shouldPrintRawResult('inline', false)).toBe(true);
    expect(shouldPrintRawResult('file', false)).toBe(true);
    expect(shouldPrintRawResult('stdin', false)).toBe(true);
    expect(shouldPrintRawResult(null, false)).toBe(false);
    expect(shouldPrintRawResult(null, true)).toBe(true);
  });
});

describe('ptool truncation recovery guidance (EI-20242487440417233, EI-21115345376541249)', () => {
  it('exposes the bounded-read projection path instead of only saying to retry', () => {
    expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('dispatch-level `projection`');
    expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('items[].item.id');
    expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('items[].item.status');
    expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('items[].item.workItemId');
    expect(PTOOL_TRUNCATED_RESULT_MESSAGE).not.toContain('results[].id');
    expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('payloadTier:"full"');
    expect(PTOOL_TRUNCATED_RESULT_MESSAGE).toContain('verify its state before retrying');
  });
});

describe('ptool loop-pressure admission retry (EI-20209060351693879)', () => {
  it('bounds every tools/call request so a saturated operator cannot hang the CLI indefinitely', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const params = { name: 'coord:send', arguments: {} };
    const callTool = vi.fn().mockResolvedValue(result);

    await expect(callToolWithPressureRetry({ callTool }, params)).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledWith(
      params,
      undefined,
      { timeout: PTOOL_CALL_TOOL_TIMEOUT_MS, maxTotalTimeout: PTOOL_CALL_TOOL_TIMEOUT_MS },
    );
  });

  it('allows an explicitly unbounded tools/call request for a caller-owned long-running operation', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const callTool = vi.fn().mockResolvedValue(result);

    await expect(
      callToolWithPressureRetry({ callTool }, { name: 'testing:run', arguments: {} }, { timeoutMs: 0 }),
    ).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledWith({ name: 'testing:run', arguments: {} }, undefined, undefined);
  });

  it('recognizes only the pre-dispatch critical-pressure shed signal', () => {
    expect(isLoopPressureShed(new Error('retryable: loop_pressure_critical'))).toBe(true);
    expect(isLoopPressureShed(new Error('operator event loop critically saturated — request shed'))).toBe(true);
    expect(isLoopPressureShed(new Error('tool failed after dispatch'))).toBe(false);
  });

  it('absorbs bounded pre-dispatch sheds and returns the eventual result', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('loop_pressure_critical'))
      .mockRejectedValueOnce(new Error('operator event loop critically saturated'))
      .mockResolvedValue(result);
    const sleep = vi.fn(async () => {});

    await expect(
      callToolWithPressureRetry({ callTool }, { name: 'git-sync:run', arguments: {} }, { maxAttempts: 3, sleep }),
    ).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries an ambiguous error that may follow dispatch', async () => {
    const error = new Error('transport closed after tools/call');
    const callTool = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});

    await expect(callToolWithPressureRetry({ callTool }, { name: 'x:y' }, { sleep })).rejects.toBe(error);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('ptool local operator connect retry (EI-20207246136942518)', () => {
  it('absorbs a bounded localhost restart window before any tool dispatch', async () => {
    const client = { close: vi.fn() };
    const connectOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(client);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:3170', { harness: 'papercusp' }, { maxAttempts: 3, sleep }),
    ).resolves.toBe(client);
    expect(connectOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rediscovers a moved local operator port before retrying', async () => {
    const client = { close: vi.fn() };
    const connectOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(client);
    const rediscover = vi.fn(() => 'http://127.0.0.1:2222');
    const onRebase = vi.fn();
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:1111', {}, {
        maxAttempts: 2,
        sleep,
        rediscover,
        onRebase,
      }),
    ).resolves.toBe(client);
    expect(connectOnce.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:1111',
      'http://127.0.0.1:2222',
    ]);
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(onRebase).toHaveBeenCalledWith('http://127.0.0.1:2222');
  });

  it('keeps explicit --url and environment pins out of rediscovery', () => {
    expect(shouldRediscoverOperatorUrl({ url: 'http://127.0.0.1:1111' }, {})).toBe(false);
    expect(shouldRediscoverOperatorUrl({}, { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1111' })).toBe(false);
    expect(shouldRediscoverOperatorUrl({}, {})).toBe(true);
  });

  it('does not retry a remote operator connection failure', async () => {
    const error = new Error('fetch failed');
    const connectOnce = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'https://operator.example.test', {}, { sleep }),
    ).rejects.toBe(error);
    expect(connectOnce).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('bounds a hung local handshake before retrying', async () => {
    const client = { close: vi.fn() };
    const connectOnce = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(client);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:3170', {}, {
        maxAttempts: 2,
        attemptTimeoutMs: 1,
        sleep,
      }),
    ).resolves.toBe(client);
    expect(connectOnce).toHaveBeenCalledTimes(2);
    expect(connectOnce.mock.calls[0][2]).toEqual({ timeoutMs: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('waits long enough for the resilient proxy to return its bounded result', async () => {
    expect(PTOOL_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
    expect(PTOOL_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(MCP_PROXY_RETRY_WINDOW_MS);
  });

  it('surfaces a proxy 503 once instead of starting another local retry loop', async () => {
    const proxyError = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_upstream_unavailable","windowMs":90000}'),
      { code: 503 },
    );
    const wrapped = new Error(formatOperatorConnectFailure('http://127.0.0.1:9071', proxyError), {
      cause: proxyError,
    });
    const connectOnce = vi.fn().mockRejectedValue(wrapped);
    const sleep = vi.fn(async () => {});

    expect(isExplicitHttpConnectFailure(wrapped)).toBe(true);
    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:9071', {}, { sleep }),
    ).rejects.toBe(wrapped);
    expect(connectOnce).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(wrapped.message).toContain('HTTP 503');
    expect(wrapped.message).toContain('mcp_proxy_upstream_unavailable');
  });

  it('retries a proxy-generated 502 for the idempotent handshake, then succeeds', async () => {
    const proxyError = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_upstream_error","detail":"upstream silent for 8000ms (no response headers)"}'),
      { code: 502 },
    );
    const wrapped = new Error(formatOperatorConnectFailure('http://127.0.0.1:9071', proxyError), {
      cause: proxyError,
    });
    const client = { close: vi.fn() };
    const connectOnce = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValue(client);
    const sleep = vi.fn(async () => {});

    expect(isExplicitHttpConnectFailure(wrapped)).toBe(true);
    expect(isRetryableLocalHttpConnectFailure(wrapped)).toBe(true);
    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:9071', {}, { maxAttempts: 2, sleep }),
    ).resolves.toBe(client);
    expect(connectOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a proxy-generated handshake-bulkhead 429, then succeeds', async () => {
    const proxyError = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_handshake_overloaded","retryAfterSec":2}'),
      { code: 429 },
    );
    const wrapped = new Error(formatOperatorConnectFailure('http://127.0.0.1:9071', proxyError), {
      cause: proxyError,
    });
    const client = { close: vi.fn() };
    const connectOnce = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValue(client);
    const sleep = vi.fn(async () => {});

    expect(isExplicitHttpConnectFailure(wrapped)).toBe(true);
    expect(isRetryableLocalHttpConnectFailure(wrapped)).toBe(true);
    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:9071', {}, { maxAttempts: 2, sleep }),
    ).resolves.toBe(client);
    expect(connectOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying handshake-bulkhead 429s through the full recovery budget', async () => {
    const proxyError = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_handshake_overloaded","retryAfterSec":2}'),
      { code: 429 },
    );
    const wrapped = new Error(formatOperatorConnectFailure('http://127.0.0.1:9071', proxyError), {
      cause: proxyError,
    });
    const client = { close: vi.fn() };
    let attempts = 0;
    const connectOnce = vi.fn(() => {
      attempts += 1;
      return attempts <= 30 ? Promise.reject(wrapped) : Promise.resolve(client);
    });
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:9071', {}, { sleep }),
    ).resolves.toBe(client);

    expect(PTOOL_CONNECT_MAX_ATTEMPTS).toBeGreaterThan(30);
    expect(connectOnce).toHaveBeenCalledTimes(31);
    expect(sleep).toHaveBeenCalledTimes(30);
  });

  it('does not classify arbitrary local 502s or the proxy unavailable 503 as retryable', async () => {
    const generic502 = Object.assign(new Error('bad gateway'), { code: 502 });
    const proxy503 = Object.assign(new Error('{"error":"mcp_proxy_upstream_unavailable"}'), { code: 503 });
    expect(isRetryableLocalHttpConnectFailure(generic502)).toBe(false);
    expect(isRetryableLocalHttpConnectFailure(proxy503)).toBe(false);
  });

  it('returns the real proxy unavailable-upstream 503 as a bounded typed CLI error', async () => {
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const unavailablePort = (portProbe.address() as { port: number }).port;
    await new Promise<void>((resolveClose) => portProbe.close(() => resolveClose()));

    const proxy = createMcpProxy({
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: unavailablePort,
      retryWindowMs: 80,
      retryBackoffMs: 10,
      log: () => {},
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyPort = (proxy.address() as { port: number }).port;
    const temp = await mkdtemp(join(tmpdir(), 'ptool-proxy-503-'));
    const tokenFile = join(temp, 'superuser-token');
    await writeFile(tokenFile, 'test-token\n');

    const startedAt = Date.now();
    let failure: any = null;
    try {
      await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/ptool.mjs', import.meta.url)),
          '--list',
          `--url=http://127.0.0.1:${proxyPort}`,
          `--token-file=${tokenFile}`,
        ],
        {
          env: { ...process.env, PAPERCUSP_PSU_TIMEOUT_MS: '1000' },
          // Generous outer kill: this budget covers cold-booting node and
          // parsing ptool.mjs, which under gate-suite load alone exceeded the
          // former 2s cap and SIGKILLed the child before it could print
          // (WI-10005207). Boundedness is asserted on WHICH path ptool took,
          // not on host wall-clock, below.
          timeout: 20_000,
        },
      );
    } catch (error) {
      failure = error;
    } finally {
      await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
      await rm(temp, { recursive: true, force: true });
    }

    expect(failure).toBeTruthy();
    expect(failure.killed).not.toBe(true);
    expect(failure.stderr).toContain('HTTP 503');
    expect(failure.stderr).toContain('mcp_proxy_upstream_unavailable');
    // The bounded contract: the 503 is surfaced directly, never by retrying
    // until the connection-attempt budget expires.
    expect(failure.stderr).not.toContain('connection attempt timed out');
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });
});

describe('ptool tool catalog request budget (EI-20224721374462856)', () => {
  it('passes a bounded request and total timeout to every tools/list page', async () => {
    const client = {
      listTools: vi
        .fn()
        .mockResolvedValueOnce({ tools: [{ name: 'first' }], nextCursor: 'next-page' })
        .mockResolvedValueOnce({ tools: [{ name: 'second' }] }),
    };

    await expect(listAllTools(client)).resolves.toEqual([{ name: 'first' }, { name: 'second' }]);
    expect(client.listTools).toHaveBeenNthCalledWith(
      1,
      {},
      { timeout: PTOOL_LIST_TOOLS_TIMEOUT_MS, maxTotalTimeout: PTOOL_LIST_TOOLS_TIMEOUT_MS },
    );
    expect(client.listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: 'next-page' },
      { timeout: PTOOL_LIST_TOOLS_TIMEOUT_MS, maxTotalTimeout: PTOOL_LIST_TOOLS_TIMEOUT_MS },
    );
  });

  it('allows a caller-owned budget when explicitly set to zero', async () => {
    const client = { listTools: vi.fn().mockResolvedValue({ tools: [] }) };

    await expect(listAllTools(client, { timeoutMs: 0 })).resolves.toEqual([]);
    expect(client.listTools).toHaveBeenCalledWith({}, undefined);
  });

  it('retries a proxy handshake-bulkhead 429 during local tools/list discovery', async () => {
    const proxyError = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_handshake_overloaded","retryAfterSec":2}'),
      { code: 429 },
    );
    const client = {
      listTools: vi.fn()
        .mockRejectedValueOnce(proxyError)
        .mockResolvedValueOnce({ tools: [{ name: 'coord:orient' }] }),
    };
    const sleep = vi.fn(async () => {});

    await expect(listAllTools(client, {
      retryLocalErrors: true,
      timeoutMs: 0,
      totalTimeoutMs: 0,
      maxAttempts: 2,
      retryDelayMs: 1_000,
      // Pin the retry pacing so the assertion below stays EXACT: the retry wait is
      // `retryWaitMsWithJitter`, which adds bounded positive jitter on top of the
      // minimum (ptool.mjs:1245 — deliberate, so a shed does not resynchronize into
      // another retry wave). This case is asserting that the server's retryAfterSec
      // is honoured as the FLOOR, not what the jitter drew, and jitterMs <= 0 returns
      // the base exactly. Without it the assert reads 2105 and looks like a flake.
      retryJitterMs: 0,
      sleep,
    })).resolves.toEqual([{ name: 'coord:orient' }]);
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.listTools).toHaveBeenNthCalledWith(1, {}, undefined);
    expect(client.listTools).toHaveBeenNthCalledWith(2, {}, undefined);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('retries a bounded MCP tools/list timeout during local catalog discovery', async () => {
    const timeout = Object.assign(new Error('Request timed out'), { code: -32001 });
    const client = {
      listTools: vi.fn()
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({ tools: [{ name: 'state:read' }] }),
    };
    const sleep = vi.fn(async () => {});

    await expect(listAllTools(client, {
      retryLocalErrors: true,
      timeoutMs: 10_000,
      totalTimeoutMs: 120_000,
      maxAttempts: 2,
      retryDelayMs: 1_000,
      // Same reason as above: assert the retryDelayMs FLOOR, not the jittered draw.
      retryJitterMs: 0,
      sleep,
    })).resolves.toEqual([{ name: 'state:read' }]);
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.listTools).toHaveBeenNthCalledWith(
      1,
      {},
      { timeout: 10_000, maxTotalTimeout: 10_000 },
    );
    expect(client.listTools).toHaveBeenNthCalledWith(
      2,
      {},
      { timeout: 10_000, maxTotalTimeout: 10_000 },
    );
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('does not retry typed handshake refusals when local retry is disabled', async () => {
    const proxyError = Object.assign(
      new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"mcp_proxy_handshake_overloaded"}'),
      { code: 429 },
    );
    const client = { listTools: vi.fn().mockRejectedValue(proxyError) };

    await expect(listAllTools(client)).rejects.toBe(proxyError);
    expect(client.listTools).toHaveBeenCalledTimes(1);
  });
});

// EI-21106949380687332 — a FOREGROUND-capable tool (testing:run, build:typecheck,
// capability:bash, capability:inspect, code:run) self-clamps its own server-side command
// timeout to FOREGROUND_TIMEOUT_CEILING_MS (50s, below the MCP transport's ~55s hard cap)
// precisely so it can return an actionable "re-run detached" hint — with the run's own id —
// instead of being killed by the transport outright. ptool's CLIENT-side request deadline
// used to be the flat PTOOL_CALL_TOOL_TIMEOUT_MS (30s) for every tool regardless of that
// design, so a caller-supplied `timeoutMs` argument (which only bounds the SERVER handler)
// had no effect: ptool gave up and discarded the response before the handler could ever
// return it. These pin the fix — the whole class of foreground-capable tools, not just
// testing:run — and the CLASS INVARIANT that would have caught the original miss.
describe('ptool timeoutForTool — foreground-capable tools outlive the MCP transport cap (EI-21106949380687332)', () => {
  const FOREGROUND_CAPABLE_TOOLS = [
    'testing:run',
    'build:typecheck',
    'capability:bash',
    'capability:inspect',
    'code:run',
    'recipes:run',
  ];

  it.each(FOREGROUND_CAPABLE_TOOLS)('%s gets a client deadline beyond the transport cap, not the flat 30s default', (name) => {
    const timeout = timeoutForTool(name, {});
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('honours the same override when reached via tools:invoke (the sanctioned deferred-tool fallback)', () => {
    expect(timeoutForTool('tools:invoke', { name: 'testing:run' })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });

  it('keeps the saved-recipe foreground budget through tools:invoke', () => {
    expect(timeoutForTool('tools:invoke', { name: 'recipes:run' })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });

  it('a caller-supplied `timeoutMs` tool ARGUMENT does not, by itself, widen the client deadline', () => {
    // The argument only ever bounded the SERVER handler; the whole point of this fix is that
    // the CLIENT deadline must already be wide enough on its own, independent of what the
    // caller asked the server to do.
    expect(timeoutForTool('testing:run', { timeoutMs: 240_000 })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });

  it('an ordinary tool not on the long-running list keeps the flat 30s ceiling', () => {
    expect(timeoutForTool('work_items:list', {})).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('the override genuinely covers the transport cap with real margin (not a bare inequality)', () => {
    expect(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS - MCP_TRANSPORT_CAP_MS).toBeGreaterThanOrEqual(3_000);
  });
});

describe('ptool timeoutForTool — release:cut reclaim budget (EI-26107428212758754)', () => {
  it('keeps dry-run reclaim beyond the declared 120s handler deadline', () => {
    expect(timeoutForTool('release:cut', { op: 'reclaim' })).toBe(PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', { name: 'release:cut', args: { op: 'reclaim' } }))
      .toBe(PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS);
    expect(PTOOL_RELEASE_CUT_RECLAIM_TIMEOUT_MS).toBeGreaterThan(125_000);
  });

  it('does not widen confirmed reclaim writes', () => {
    expect(timeoutForTool('release:cut', { op: 'reclaim', confirm: true })).toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — locks:list compound inventory read (EI-25384303042233581)', () => {
  it('keeps the client deadline beyond the measured slow success path', () => {
    expect(timeoutForTool('locks:list', { resource: 'git-sync:papercusp' }))
      .toBe(PTOOL_LOCKS_LIST_TIMEOUT_MS);
    expect(PTOOL_LOCKS_LIST_TIMEOUT_MS).toBeGreaterThan(72_441);
    expect(PTOOL_LOCKS_LIST_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('applies the same budget through the sanctioned tools:invoke fallback', () => {
    expect(timeoutForTool('tools:invoke', {
      name: 'locks:list',
      args: { resource: 'git-sync:papercusp' },
    })).toBe(PTOOL_LOCKS_LIST_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — code:tools signature reads outlive the MCP cap (EI-25679450978085524)', () => {
  it.each([
    ['direct', 'code:tools', {}],
    ['tools:invoke', 'tools:invoke', { name: 'code:tools' }],
  ] as const)('%s calls use the foreground budget', (_route, toolName, args) => {
    const timeout = timeoutForTool(toolName, args);
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — rubrics:amend delivers its foreground receipt (EI-24943513849393693)', () => {
  it.each([
    ['direct', 'rubrics:amend', {}],
    ['tools:invoke', 'tools:invoke', { name: 'rubrics:amend' }],
  ] as const)('%s call outlives the 40s handler budget and MCP transport cap', (_route, toolName, args) => {
    const timeout = timeoutForTool(toolName, args);
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(40_000);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — dev:pg_query outlives proxy admission and SQL bounds (EI-22701666730811258)', () => {
  it('uses the long-read client deadline for direct calls instead of the flat 30s cutoff', () => {
    const timeout = timeoutForTool('dev:pg_query', { sql: 'SELECT 1', timeoutMs: 10_000 });
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps the same deadline through the deferred tools:invoke route', () => {
    expect(timeoutForTool('tools:invoke', {
      name: 'dev:pg_query',
      args: { sql: 'SELECT 1', timeoutMs: 10_000 },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — dev:pipeline_position outlives the flat client deadline (EI-22707343179859326)', () => {
  it('keeps the direct pipeline-position read on the long-call budget', () => {
    const timeout = timeoutForTool('dev:pipeline_position', { path: 'apps/operator/scripts/ptool.mjs' });
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps the same budget through the deferred tools:invoke route', () => {
    expect(timeoutForTool('tools:invoke', {
      name: 'dev:pipeline_position',
      args: { path: 'apps/operator/scripts/ptool.mjs' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — capability:launch-agent resumes outlive the default client deadline (EI-21314560074357302)', () => {
  it('outlives the current boot, kickoff-proof and resume-verification windows', () => {
    expect(PTOOL_AGENT_LAUNCH_TIMEOUT_MS).toBeGreaterThan(
      HEADLESS_BOOT_RECEIPT_MS + KICKOFF_PROOF_WINDOW_MS + 30_000 + 5_000,
    );
  });
  it('gives exact launch-agent resumes a client deadline beyond the MCP transport cap', () => {
    const timeout = timeoutForTool('capability:launch-agent', {
      resume: { agentId: 'su-example' },
      headless: true,
    });
    expect(timeout).toBe(PTOOL_AGENT_LAUNCH_TIMEOUT_MS);
    // The client's deadline must outlive the declared handler plus settlement.
    expect(timeout).toBeGreaterThan((AGENT_LAUNCH_HANDLER_TIMEOUT_SEC + 5) * 1000);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('applies the same budget when launch-agent is reached through tools:invoke', () => {
    expect(timeoutForTool('tools:invoke', {
      name: 'capability:launch-agent',
      args: { resume: { agentId: 'su-example' }, headless: true },
    })).toBe(PTOOL_AGENT_LAUNCH_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — dev:restart outlives the coordinated drain budget (EI-22063784282522464)', () => {
  it('gives direct dev:restart calls a client deadline beyond the 330s server budget', () => {
    const timeout = timeoutForTool('dev:restart', {
      confirm: true,
      target: 'bg-host',
      git_sync_drain_sec: 45,
    });
    expect(timeout).toBe(PTOOL_DEV_RESTART_TIMEOUT_MS);
    // dev:restart declares MAX_DRAIN_SEC + 30 = 330s; ptool adds settlement margin.
    expect(timeout).toBeGreaterThan(335_000);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('applies the same budget through the deferred tools:invoke path', () => {
    expect(timeoutForTool('tools:invoke', {
      name: 'dev:restart',
      args: { confirm: true, target: 'bg-host', git_sync_drain_sec: 45 },
    })).toBe(PTOOL_DEV_RESTART_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — plan lifecycle CAS outlives the flat client deadline (EI-21360596114670049)', () => {
  it('keeps a direct plans:set-plan-status call alive beyond the MCP transport cap', () => {
    const timeout = timeoutForTool('plans:set-plan-status', {
      slug: 'some-plan',
      status: 'shipped',
      expectedCurrent: 'ready',
    });
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps the same lifecycle budget through tools:invoke', () => {
    expect(timeoutForTool('tools:invoke', {
      name: 'plans:set-plan-status',
      args: { slug: 'some-plan', status: 'shipped', expectedCurrent: 'ready' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — scorecards:emit outlives its 900s tool budget (EI-21402752040470797)', () => {
  it('keeps the direct client request alive through criterion checks and ledger persistence', () => {
    expect(timeoutForTool('scorecards:emit', {})).toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
    // scorecards:emit declares 900s; the MCP transport adds a 5s buffer.
    expect(PTOOL_SCORECARD_EMIT_TIMEOUT_MS).toBeGreaterThan(905_000);
    expect(PTOOL_SCORECARD_EMIT_TIMEOUT_MS).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('honours the same override through the deferred tools:invoke transport', () => {
    expect(timeoutForTool('tools:invoke', { name: 'scorecards:emit' }))
      .toBe(PTOOL_SCORECARD_EMIT_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — scorecards:repair outlives its 900s dispatch budget (EI-24230006371870177)', () => {
  it('keeps direct and deferred calls alive beyond the MCP settlement deadline', () => {
    expect(timeoutForTool('scorecards:repair', { targetIds: ['EI-target'] }))
      .toBe(PTOOL_SCORECARD_REPAIR_TIMEOUT_MS);
    expect(timeoutForTool('tools:invoke', {
      name: 'scorecards:repair',
      args: { targetIds: ['EI-target'] },
    })).toBe(PTOOL_SCORECARD_REPAIR_TIMEOUT_MS);
    expect(PTOOL_SCORECARD_REPAIR_TIMEOUT_MS).toBeGreaterThan(905_000);
    expect(PTOOL_SCORECARD_REPAIR_TIMEOUT_MS).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — locks:heartbeat_resource outlives serialized multi-lock renewal (EI-21212666377233442)', () => {
  it('gives a multi-lock heartbeat more than the flat 30s client deadline', () => {
    expect(timeoutForTool('locks:heartbeat_resource', {
      lock_ids: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    })).toBe(PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS);
    expect(PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps the same budget through the deferred tools:invoke transport', () => {
    expect(timeoutForTool('tools:invoke', { name: 'locks:heartbeat_resource' }))
      .toBe(PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — fleet:assignments outlives BYOC live-recheck fan-out (EI-21310243062797569)', () => {
  it('gives the placement read a long-read client deadline, not the flat 30s ceiling', () => {
    expect(timeoutForTool('fleet:assignments', {})).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('fleet:assignments', {})).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('fleet:assignments', {})).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
  });

  it('keeps the same long-read budget through the deferred tools:invoke transport', () => {
    expect(timeoutForTool('tools:invoke', { name: 'fleet:assignments' }))
      .toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — fleet:leader-brief outlives projection and MCP settlement (EI-26141314393026733)', () => {
  it('keeps direct leader briefs beyond the flat client and transport deadlines', () => {
    const timeout = timeoutForTool('fleet:leader-brief', {
      fleet: 'nonp2p-bug-drain-luna-max-0930',
      harness: 'papercusp',
      workspace: 'papercusp-workspace',
    });
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('applies the same leader-brief budget through tools:invoke', () => {
    expect(timeoutForTool('tools:invoke', {
      name: 'fleet:leader-brief',
      args: { fleet: 'nonp2p-bug-drain-luna-max-0930' },
    })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — db:migrate outlives the MCP request deadline (EI-22613070628418671)', () => {
  it('gives the migration call a client deadline beyond the transport cap, not the flat 30s ceiling', () => {
    expect(timeoutForTool('db:migrate', {})).toBe(PTOOL_DB_MIGRATE_TIMEOUT_MS);
    expect(timeoutForTool('db:migrate', {})).toBeGreaterThan(PTOOL_CALL_TOOL_TIMEOUT_MS);
    expect(timeoutForTool('db:migrate', {})).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    // db:migrate declares 1020s and MCP adds a 5s settlement buffer; keep a
    // further 5s delivery margin so a legitimate long drain is observable.
    expect(PTOOL_DB_MIGRATE_TIMEOUT_MS).toBe(1_030_000);
    expect(PTOOL_DB_MIGRATE_TIMEOUT_MS).toBeGreaterThan(1_025_000);
  });

  it('keeps the same migration budget through the deferred tools:invoke transport', () => {
    expect(timeoutForTool('tools:invoke', { name: 'db:migrate' }))
      .toBe(PTOOL_DB_MIGRATE_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — continuity/control-plane calls outlive the flat deadline (EI-21269176538636068)', () => {
  const CONTINUITY_TOOLS = [
    'loop:checkpoint',
    'loop:status',
    'improvements:capture',
    'coord:send',
  ];

  it.each(CONTINUITY_TOOLS)('%s gets a long-call deadline beyond the MCP transport cap', (name) => {
    const timeout = timeoutForTool(name, {});
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it.each(CONTINUITY_TOOLS)('%s keeps the long-call deadline through tools:invoke', (name) => {
    expect(timeoutForTool('tools:invoke', { name })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool evidence-binding receipt deadline (EI-25634460854216048)', () => {
  it.each(['plans:bind-spec-evidence', 'tools:invoke'])('%s observes a committed receipt beyond the ordinary client wall without replay', async name => {
    vi.useFakeTimers();
    try {
      const args = name === 'tools:invoke'
        ? { name: 'plans:bind-spec-evidence', args: { binding: { fromTestRun: 123 } } }
        : { binding: { fromTestRun: 123 } };
      const receipt = { content: [{ type: 'text', text: '{"ok":true,"id":35416}' }] };
      const callTool = vi.fn((_params: unknown, _schema: unknown, options: { timeout: number }) =>
        new Promise((resolve, reject) => {
          const clientWall = setTimeout(() => reject(new Error('MCP request timed out; mutation outcome unknown')), options.timeout);
          setTimeout(() => {
            clearTimeout(clientWall);
            resolve(receipt);
          }, PTOOL_CALL_TOOL_TIMEOUT_MS + 227);
        }));
      const result = callToolWithPressureRetry({ callTool }, { name, arguments: args }, {
        timeoutMs: timeoutForTool(name, args),
      }).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(PTOOL_CALL_TOOL_TIMEOUT_MS + 227);
      expect(await result).toEqual({ value: receipt });
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(timeoutForTool(name, args)).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ptool timeoutForTool — coord:declare-intent and loop:arm outlive the flat client deadline (EI-21863905839650704)', () => {
  // Both tools declare no timeoutSec, so the server bounds them only at the
  // flat 55s MCP_DEADLINE_MS floor. A reporter observed ptool's flat 30s
  // client cutoff abort a "coord:declare-intent and loop:arm" call with
  // "MCP -32001 timed out after 30s; mutation may have executed and requires
  // state reconciliation before replay" while the mutation had already (or
  // was still about to) land server-side.
  const OUTCOME_UNKNOWN_MUTATIONS = ['coord:declare-intent', 'loop:arm'];

  it.each(OUTCOME_UNKNOWN_MUTATIONS)('%s gets a long-call deadline beyond the MCP transport cap', (name) => {
    const timeout = timeoutForTool(name, {});
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it.each(OUTCOME_UNKNOWN_MUTATIONS)('%s keeps the long-call deadline through tools:invoke', (name) => {
    expect(timeoutForTool('tools:invoke', { name })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — sessions:list census outlives the flat client deadline (EI-24857804837312348)', () => {
  it('uses a client deadline beyond the MCP cap for direct calls', () => {
    const timeout = timeoutForTool('sessions:list', { mode: 'historical' });
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it('keeps the same deadline through tools:invoke', () => {
    expect(timeoutForTool('tools:invoke', { name: 'sessions:list', args: { mode: 'historical' } }))
      .toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool timeoutForTool — bulk resolver live-action reads outlive the flat client deadline (EI-25227543877278075)', () => {
  const LIVE_ACTION_TOOLS = [
    'inbox:bulk-run-manifest',
    'inbox:bulk-run-act',
    'inbox:bulk-run-report',
  ];

  it.each(LIVE_ACTION_TOOLS)('%s gets a deadline beyond the MCP transport cap for direct calls', (name) => {
    const timeout = timeoutForTool(name, {});
    expect(timeout).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
    expect(timeout).toBeGreaterThan(MCP_TRANSPORT_CAP_MS);
    expect(timeout).not.toBe(PTOOL_CALL_TOOL_TIMEOUT_MS);
  });

  it.each(LIVE_ACTION_TOOLS)('%s keeps the long-call deadline through tools:invoke', (name) => {
    expect(timeoutForTool('tools:invoke', { name })).toBe(PTOOL_FOREGROUND_TOOL_TIMEOUT_MS);
  });
});

describe('ptool serviceOf / groupTools', () => {
  it('splits the service off the colon', () => {
    expect(serviceOf('work_items:list')).toBe('work_items');
    expect(serviceOf('papercusp:list_workspaces')).toBe('papercusp');
  });

  it('groups colon-less names under (misc)', () => {
    expect(serviceOf('weird')).toBe('(misc)');
  });

  it('groups + sorts services and tools', () => {
    const tools = [
      { name: 'harness:status', description: '' },
      { name: 'coord:send', description: '' },
      { name: 'harness:list', description: '' },
    ];
    const g = groupTools(tools);
    expect([...g.keys()]).toEqual(['coord', 'harness']);
    expect(g.get('harness')?.map((t) => t.name)).toEqual(['harness:list', 'harness:status']);
  });
});

describe('ptool firstLine', () => {
  it('returns the first non-empty line, truncated', () => {
    expect(firstLine('\n\nWhen to use: foo\nmore')).toBe('When to use: foo');
    expect(firstLine('a'.repeat(200), 10)).toBe('aaaaaaaaa…');
    expect(firstLine('')).toBe('');
    expect(firstLine(undefined)).toBe('');
  });
});

describe('ptool normalizeType', () => {
  it('passes through a plain type', () => {
    expect(normalizeType('string')).toBe('string');
  });
  it('drops null from a type union array', () => {
    expect(normalizeType(['string', 'null'])).toBe('string');
    expect(normalizeType(['null'])).toBeNull();
  });
  it('returns null for an absent type', () => {
    expect(normalizeType(undefined)).toBeNull();
  });
});

describe('ptool promptSpecsFromSchema', () => {
  it('classifies scalar kinds and marks required', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'the name' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        on: { type: 'boolean', default: true },
        mode: { enum: ['a', 'b'] },
      },
    };
    const specs = promptSpecsFromSchema(schema);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect(byName.name).toMatchObject({ kind: 'string', required: true, description: 'the name' });
    expect(byName.count.kind).toBe('integer');
    expect(byName.ratio.kind).toBe('number');
    expect(byName.on).toMatchObject({ kind: 'boolean', default: true });
    expect(byName.mode).toMatchObject({ kind: 'enum', enumValues: ['a', 'b'] });
  });

  it('falls back to json for arrays, objects, and unions', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    const kinds = Object.fromEntries(promptSpecsFromSchema(schema).map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({ tags: 'json', meta: 'json', either: 'json' });
  });

  it('orders required props before optional ones', () => {
    const schema = {
      type: 'object',
      required: ['b'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
    };
    expect(promptSpecsFromSchema(schema).map((s) => s.name)).toEqual(['b', 'a', 'c']);
  });

  it('handles an empty / missing schema', () => {
    expect(promptSpecsFromSchema(undefined)).toEqual([]);
    expect(promptSpecsFromSchema({ type: 'object' })).toEqual([]);
  });
});

describe('ptool coerceArg', () => {
  it('coerces numbers and integers', () => {
    expect(coerceArg('number', '3.5')).toBe(3.5);
    expect(coerceArg('integer', '7')).toBe(7);
  });
  it('throws on malformed numbers', () => {
    expect(() => coerceArg('number', 'x')).toThrow(/not a number/);
    expect(() => coerceArg('integer', '3.5')).toThrow(/not an integer/);
  });
  it('parses json', () => {
    expect(coerceArg('json', '{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(() => coerceArg('json', '{bad')).toThrow(/not valid JSON/);
  });
  it('passes strings, booleans, enums through', () => {
    expect(coerceArg('string', 'hi')).toBe('hi');
    expect(coerceArg('boolean', true)).toBe(true);
    expect(coerceArg('enum', 'a')).toBe('a');
  });
});

describe('ptool mergeConvenienceArgs', () => {
  const schema = { properties: { workspace: { type: 'string' }, harness: { type: 'string' }, x: { type: 'string' } } };
  const rehomeSchema = { properties: { op: { type: 'string' }, id: { type: 'string' }, harness: { type: 'string' } } };

  it('injects workspace/harness only when the schema declares them', () => {
    expect(mergeConvenienceArgs({}, { workspace: 'ws', harness: 'h' }, schema)).toEqual({
      workspace: 'ws',
      harness: 'h',
    });
  });

  it('does not inject a flag the schema lacks', () => {
    const noHarness = { properties: { workspace: { type: 'string' } } };
    expect(mergeConvenienceArgs({}, { workspace: 'ws', harness: 'h' }, noHarness)).toEqual({ workspace: 'ws' });
  });

  it('existing args win over the convenience flags', () => {
    expect(mergeConvenienceArgs({ workspace: 'explicit' }, { workspace: 'flag' }, schema)).toEqual({
      workspace: 'explicit',
    });
  });

  it('ignores null flags', () => {
    expect(mergeConvenienceArgs({ x: 1 }, { workspace: null, harness: null }, schema)).toEqual({ x: 1 });
  });

  it('does not inject ambient tenant scope into testing:runs, but preserves explicit filters', () => {
    expect(mergeConvenienceArgs({}, { workspace: 'ambient-ws', harness: 'ambient-harness' }, schema, {
      toolName: 'testing:runs',
    })).toEqual({});
    expect(mergeConvenienceArgs(
      { workspace: 'explicit-ws', harness: 'explicit-harness' },
      { workspace: 'ambient-ws', harness: 'ambient-harness' },
      schema,
      { toolName: 'testing:runs' },
    )).toEqual({ workspace: 'explicit-ws', harness: 'explicit-harness' });
  });

  it('continues injecting declared scope filters for other tools', () => {
    expect(mergeConvenienceArgs({}, { workspace: 'ambient-ws', harness: 'ambient-harness' }, schema, {
      toolName: 'work_items:list',
    })).toEqual({ workspace: 'ambient-ws', harness: 'ambient-harness' });
  });

  it('does not inject ambient harness into the classify variant of work_items:rehome', () => {
    expect(mergeConvenienceArgs(
      { op: 'classify', id: 'EI-1' },
      { workspace: 'ambient-ws', harness: 'ambient-harness' },
      rehomeSchema,
      { toolName: 'work_items:rehome' },
    )).toEqual({ op: 'classify', id: 'EI-1' });
  });

  it('continues injecting ambient harness into the move variant of work_items:rehome', () => {
    expect(mergeConvenienceArgs(
      { op: 'move', id: 'EI-1' },
      { workspace: 'ambient-ws', harness: 'ambient-harness' },
      rehomeSchema,
      { toolName: 'work_items:rehome' },
    )).toEqual({ op: 'move', id: 'EI-1', harness: 'ambient-harness' });
  });

  it('preserves an explicit harness even for the classify variant', () => {
    const args = { op: 'classify', id: 'EI-1', harness: 'explicit-harness' };
    expect(mergeConvenienceArgs(
      args,
      { workspace: 'ambient-ws', harness: 'ambient-harness' },
      rehomeSchema,
      { toolName: 'work_items:rehome' },
    )).toEqual(args);
  });

  it('injects ambient harness only into the check variant of workspace:work_scope', () => {
    const workScopeSchema = {
      properties: {
        op: { type: 'string' },
        harness: { type: 'string' },
        mode: { type: 'string' },
      },
    };

    expect(mergeConvenienceArgs(
      { op: 'check' },
      { workspace: 'ambient-ws', harness: 'ambient-harness' },
      workScopeSchema,
      { toolName: 'workspace:work_scope' },
    )).toEqual({ op: 'check', harness: 'ambient-harness' });

    for (const op of ['get', 'set', 'clear']) {
      expect(mergeConvenienceArgs(
        { op },
        { workspace: 'ambient-ws', harness: 'ambient-harness' },
        workScopeSchema,
        { toolName: 'workspace:work_scope' },
      )).toEqual({ op });
    }
  });

  it('preserves an explicit harness on workspace:work_scope non-check variants', () => {
    const args = { op: 'get', harness: 'explicit-harness' };
    expect(mergeConvenienceArgs(
      args,
      { workspace: 'ambient-ws', harness: 'ambient-harness' },
      { properties: { op: { type: 'string' }, harness: { type: 'string' } } },
      { toolName: 'workspace:work_scope' },
    )).toEqual(args);
  });
});

describe('ptool mergeDispatchProjection', () => {
  it('adds a CLI projection to the target tool arguments', () => {
    expect(mergeDispatchProjection({ id: 'EI-1' }, { pick: ['results[].id'] })).toEqual({
      id: 'EI-1',
      projection: { pick: ['results[].id'] },
    });
  });

  it('preserves an explicit JSON projection over the CLI convenience flag', () => {
    const args = { projection: { pick: ['results[].state'] } };
    expect(mergeDispatchProjection(args, { pick: ['results[].id'] })).toBe(args);
  });

  it('leaves arguments unchanged when no CLI projection was supplied', () => {
    const args = { id: 'EI-1' };
    expect(mergeDispatchProjection(args, undefined)).toBe(args);
  });
});

describe('ptool buildMcpUrl', () => {
  it('carries the tracked psu session identity into the MCP client query', () => {
    const url = buildMcpUrl('http://127.0.0.1:9071', {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      client: 'su-session-123',
    });
    expect(url.pathname).toBe('/api/mcp');
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(url.searchParams.get('workspace')).toBe('papercusp-workspace');
    expect(url.searchParams.get('harness')).toBe('papercusp');
    expect(url.searchParams.get('client')).toBe('su-session-123');
  });

  it('omits client for an ordinary untracked terminal invocation', () => {
    expect(buildMcpUrl('http://127.0.0.1:9071').searchParams.has('client')).toBe(false);
  });
});

describe('ptool buildCallToolParams', () => {
  // EI-13245: the MCP SDK's Client.callTool throws "has an output schema but
  // did not return structured content" for any tool that advertises an
  // outputSchema unless the caller opts in via `_meta.structured` — the host
  // only fills structuredContent when explicitly asked. Array-rooted tools are
  // the opposite case: MCP's structuredContent validator rejects an array, so
  // ptool asks for lossless JSON text instead.
  it('requests structuredContent for an object-rooted output schema', () => {
    const params = buildCallToolParams(
      'work_items:burn_down',
      { harness: 'papercusp', ids: ['WI-1'] },
      { outputSchema: { type: 'object' } },
    );
    expect(params).toEqual({
      name: 'work_items:burn_down',
      arguments: { harness: 'papercusp', ids: ['WI-1'] },
      _meta: { structured: true },
    });
  });

  it('requests JSON text for an array-rooted list result', () => {
    expect(buildCallToolParams('work_items:list', { harness: 'papercusp' }, { outputSchema: { type: 'array' } })).toEqual({
      name: 'work_items:list',
      arguments: { harness: 'papercusp' },
      _meta: { format: 'json' },
    });
  });

  it('requests JSON text when a tool has no output schema', () => {
    expect(buildCallToolParams('harness:list', {})).toEqual({
      name: 'harness:list',
      arguments: {},
      _meta: { format: 'json' },
    });
  });

  it('serializes nested tools:invoke args once so shell quoting survives', () => {
    const nestedArgs = {
      script: `return await tools.dev.pg_query({ query: "select 'it''s safe'" });`,
    };
    const params = buildCallToolParams('tools:invoke', {
      name: 'code:run',
      args: nestedArgs,
    });

    expect(params.arguments).toEqual({
      name: 'code:run',
      args: JSON.stringify(nestedArgs),
    });
    expect(JSON.parse(params.arguments.args)).toEqual(nestedArgs);
  });

  it('does not double-encode an already serialized nested tools:invoke args', () => {
    const encodedArgs = JSON.stringify({ script: 'return "already encoded";' });
    const params = buildCallToolParams('tools:invoke', {
      name: 'code:run',
      args: encodedArgs,
    });

    expect(params.arguments.args).toBe(encodedArgs);
  });

  it('keeps direct tool arguments as objects', () => {
    const directArgs = { script: `return "it's a direct call";` };
    const params = buildCallToolParams('code:run', directArgs);

    expect(params.arguments).toBe(directArgs);
  });
});

describe('ptool prettyText / resultToText', () => {
  it('pretty-prints JSON payloads, leaves plain text alone', () => {
    expect(prettyText('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyText('hello')).toBe('hello');
    expect(prettyText('{not json')).toBe('{not json');
    expect(prettyText('')).toBe('');
  });

  it('flattens an MCP content[] into text', () => {
    const result = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(resultToText(result)).toBe('a\nb');
  });

  it('renders non-text content parts as JSON', () => {
    const result = { content: [{ type: 'image', data: 'x' }] };
    expect(resultToText(result)).toBe('{"type":"image","data":"x"}');
  });

  it('raw extraction drops MCP guidance appended after a complete JSON content item', () => {
    const result = {
      content: [
        { type: 'text', text: '{"ok":true,"state":"done"}' },
        { type: 'text', text: 'See also: work_items:get' },
      ],
    };
    expect(resultToText(result, { raw: true })).toBe('{"ok":true,"state":"done"}');
  });

  it('raw extraction keeps a complete JSON prefix when result-door guidance shares its text item', () => {
    const result = {
      content: [{
        type: 'text',
        text: '{"ok":true,"session_id":"sess-1","results":[{"text":"brace } and [ bracket"}]}\n' +
          '[result-door: this result exceeded the ~1500-token per-result budget; the remainder was truncated]',
      }],
    };
    expect(resultToText(result, { raw: true })).toBe(
      '{"ok":true,"session_id":"sess-1","results":[{"text":"brace } and [ bracket"}]}',
    );
  });

  it('does not recover an actually truncated JSON prefix', () => {
    const result = {
      content: [{
        type: 'text',
        text: '{"ok":true,"results":[{"session_id":"sess-1"}\n' +
          '[result-door: this result exceeded the ~1500-token per-result budget; the remainder was truncated]',
      }],
    };
    expect(resultToText(result, { raw: true })).toContain('[result-door:');
  });
});

describe('ptool shed classification stays in parity with the mcp-proxy 429 vocabulary', () => {
  const proxySource = readFileSync(
    fileURLToPath(new URL('./mcp-proxy/proxy.ts', import.meta.url)),
    'utf8',
  );

  /**
   * DERIVED, never hand-listed. ptool cannot import the proxy (it is a plain
   * .mjs script that talks to :3170 directly), so its two shed predicates each
   * carry a regex copy of the proxy's error vocabulary — and a copy drifts.
   * EI-22085013885475039 is that drift: the proxy shed coord:send with a typed
   * pre-forward 429 the caller did not recognise, so an honest, retryable
   * backpressure refusal surfaced as an unclassified failure.
   *
   * Rather than add a third hand-maintained list, recover the live vocabulary
   * from the proxy itself: every `res.writeHead(429` is followed within a few
   * lines by the `error: "mcp_proxy_…"` it emits. A newly added shed code then
   * fails this guard instead of silently stranding a ptool caller.
   */
  function derive429ShedCodes(source: string): string[] {
    const codes = new Set<string>();
    let last429 = Number.NEGATIVE_INFINITY;
    source.split('\n').forEach((line, index) => {
      if (/res\.writeHead\(429/.test(line)) last429 = index;
      const match = /error: "(mcp_proxy_[a-z_]+)"/.exec(line);
      if (match && index - last429 <= 12) codes.add(match[1]);
    });
    return [...codes].sort();
  }

  const shedCodes = derive429ShedCodes(proxySource);

  const asProxyError = (code: string, status = 429) => Object.assign(
    new Error(
      `Streamable HTTP error: Error POSTing to endpoint: {"error":"${code}","retryAfterSec":2}`,
    ),
    { code: status },
  );

  it('recovers the proxy vocabulary from source instead of trusting a written list', () => {
    // Calibration: without this, an extraction that silently matched nothing
    // would make every assertion below pass vacuously.
    expect(shedCodes.length).toBeGreaterThanOrEqual(7);
    expect(shedCodes).toContain('mcp_proxy_coord_send_queue_dwell');
    expect(shedCodes).toContain('mcp_proxy_handshake_queue_dwell');
  });

  it('treats every typed proxy 429 as a pre-dispatch tool-call refusal', () => {
    for (const code of shedCodes) {
      expect(
        isLoopPressureShed(asProxyError(code)),
        `${code} is shed before forwarding, so the tool never ran`,
      ).toBe(true);
    }
  });

  it('treats every handshake-path 429 as a retryable connect failure', () => {
    // A first connect only reaches the handshake bulkhead and the global
    // admission ceiling; the per-tool class FIFOs cannot refuse it.
    const connectPath = shedCodes.filter(
      (code) => code.includes('handshake') || code === 'mcp_proxy_overloaded',
    );
    expect(connectPath.length).toBeGreaterThanOrEqual(3);
    for (const code of connectPath) {
      expect(
        isRetryableLocalHttpConnectFailure(asProxyError(code)),
        `${code} sheds the handshake before forwarding, so the connect must retry`,
      ).toBe(true);
    }
  });

  it('does not widen either predicate to untyped or non-429 refusals', () => {
    const providerLimit = asProxyError('provider_rate_limit');
    expect(isLoopPressureShed(providerLimit)).toBe(false);
    expect(isRetryableLocalHttpConnectFailure(providerLimit)).toBe(false);

    const wrongStatus = asProxyError('mcp_proxy_handshake_queue_dwell', 500);
    expect(isLoopPressureShed(wrongStatus)).toBe(false);
    expect(isRetryableLocalHttpConnectFailure(wrongStatus)).toBe(false);
  });
});

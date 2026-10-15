import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_DIR = join(HERE, '..');
const HELPER = join(HOOK_DIR, 'mcp_response.py');
const TARGET_HOOKS = [
  'pretooluse-locks-acquire.sh',
  'pretooluse-plans-read-guard.sh',
  'posttooluse-activity-report.sh',
  'userpromptsubmit-provenance.sh',
];
const ACTIVITY_REPORT_HOOKS = [
  'lifecycle-report.sh',
  'pretooluse-activity-report.sh',
  'posttooluse-activity-report.sh',
  'pretooluse-bash-resource-gate.sh',
  'workitem-verify-nudge.sh',
];

function parse(raw: string, env: Record<string, string> = {}): { inner: unknown; error: unknown; phase: string } {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from mcp_response import parse_mcp_response',
    'inner, error, phase = parse_mcp_response(sys.stdin.read())',
    'print(json.dumps({"inner": inner, "error": error, "phase": phase}, sort_keys=True))',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-c', script, HOOK_DIR], {
      input: raw,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }),
  ) as { inner: unknown; error: unknown; phase: string };
}

function withNativeSession(url: string, sessionId: string): string {
  const script = [
    'import sys',
    'sys.path.insert(0, sys.argv[1])',
    'from mcp_response import with_native_session',
    'print(with_native_session(sys.argv[2], sys.argv[3]))',
  ].join('\n');
  return execFileSync('python3', ['-c', script, HOOK_DIR, url, sessionId], { encoding: 'utf8' }).trim();
}

describe('shared CC MCP response parser', () => {
  it('rejects the measured HTTP-200 result.isError envelope instead of exposing its text as a decision', () => {
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input' }) }],
        isError: true,
      },
    };
    expect(parse(JSON.stringify(response))).toEqual({
      inner: null,
      error: response.result,
      phase: 'is-error',
    });
  });

  it('parses a successful JSON response and an SSE-framed response', () => {
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, value: 7 }) }] },
    };
    expect(parse(JSON.stringify(response))).toEqual({
      inner: { ok: true, value: 7 },
      error: null,
      phase: 'ok',
    });
    expect(parse(`event: message\ndata: ${JSON.stringify(response)}\n\n`)).toEqual({
      inner: { ok: true, value: 7 },
      error: null,
      phase: 'ok',
    });
  });

  it('unwraps inline result-door envelopes before returning the tool result', () => {
    const grant = { ok: true, lock_id: 'inline-lock' };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: JSON.stringify(grant) },
      ],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    expect(parse(JSON.stringify(response))).toEqual({ inner: grant, error: null, phase: 'ok' });
  });

  it('unwraps a spilled result-door grant from its validated scratch reference, not its preview', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'mcp-response-spill-'));
    const relative = ['workspace', 'locks:acquire', 'run-id', 'result.spill'];
    const spillPath = join(scratchRoot, ...relative);
    const grant = { ok: true, lock_id: 'spilled-lock' };
    const spilledPayload = {
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: JSON.stringify(grant) },
      ],
    };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{
        kind: 'reference',
        uri: `papercusp://scratch/${relative.join('/')}`,
        preview: '{"ok":false,"reason":"preview is not authoritative"}',
      }],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    try {
      mkdirSync(dirname(spillPath), { recursive: true });
      writeFileSync(spillPath, `result-door magic\nmanifest\n${JSON.stringify(spilledPayload)}\n`);
      expect(parse(JSON.stringify(response), { PAPERCUSP_SCRATCH_ROOT: scratchRoot })).toEqual({
        inner: grant,
        error: null,
        phase: 'ok',
      });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('does not trust a missing spill or its preview as a tool result', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'mcp-response-missing-spill-'));
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{
        kind: 'reference',
        uri: 'papercusp://scratch/workspace/locks:acquire/run-id/result.spill',
        preview: '{"ok":true,"lock_id":"preview-only"}',
      }],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    try {
      expect(parse(JSON.stringify(response), { PAPERCUSP_SCRATCH_ROOT: scratchRoot })).toEqual({
        inner: null,
        error: null,
        phase: 'no-text',
      });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('preserves JSON-RPC errors and classifies missing content', () => {
    const rpcError = { code: -32602, message: 'invalid args' };
    expect(parse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: rpcError }))).toEqual({
      inner: null,
      error: rpcError,
      phase: 'rpc-error',
    });
    expect(parse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }))).toEqual({
      inner: null,
      error: null,
      phase: 'no-text',
    });
  });

  it('makes all four sibling hooks import the shared parser', () => {
    for (const hook of TARGET_HOOKS) {
      expect(readFileSync(join(HOOK_DIR, hook), 'utf8'), hook).toContain(
        'from mcp_response import parse_mcp_response',
      );
    }
    expect(readFileSync(join(HOOK_DIR, 'pretooluse-locks-acquire.sh'), 'utf8')).not.toContain(
      'def _parse_mcp_response',
    );
  });
});

describe('shared CC native-session MCP URL context', () => {
  it('preserves existing query values, safely encodes the native id, and replaces stale duplicates', () => {
    const url = withNativeSession(
      'http://operator.test/api/mcp?superuser=1&origin=hook&client=su-1&native_session=stale&native_session=older',
      'native session/+1',
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('superuser')).toBe('1');
    expect(parsed.searchParams.get('origin')).toBe('hook');
    expect(parsed.searchParams.get('client')).toBe('su-1');
    expect(parsed.searchParams.getAll('native_session')).toEqual(['native session/+1']);
  });

  it('leaves the request unchanged when no native id is available', () => {
    const url = 'http://operator.test/api/mcp?superuser=1&client=su-1';
    expect(withNativeSession(url, '')).toBe(url);
  });

  it.each(ACTIVITY_REPORT_HOOKS)('%s uses the shared URL helper for activity:report', (file) => {
    const source = readFileSync(join(HOOK_DIR, file), 'utf8');
    expect(source).toContain('with_native_session');
    expect(source).toContain("'activity:report'");
    expect(source).toMatch(/native_session_id\s*=|session_id\s+or\s+os\.environ/);
  });
});

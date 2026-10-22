/**
 * stop-failure-record (client-native-features-adoption-2026-10-21 P-002, R-2).
 *
 * A StopFailure payload must produce exactly one durable activity:report record
 * naming the session, the error kind and the time; anything that is not a psu
 * StopFailure must produce none. The payload shape is the one Claude Code 2.1.293
 * builds (`hook_event_name`, `error`, `error_details`, `last_assistant_message` on
 * top of the common `session_id` / `transcript_path` / `cwd` fields).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStopFailureReport,
  postStopFailureReport,
  STOP_FAILURE_SUMMARY_PREFIX,
} from '../stop-failure-record.mjs';
import { SESSION_END_MARKER, SESSION_START_MARKER } from '../../../../../../packages/operator-core/lib/agent-tools/activity/lifecycle-markers';

const env = {
  PAPERCUSP_SID: 'su-abc',
  PAPERCUSP_WORKSPACE: 'papercusp-workspace',
  PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/',
} as NodeJS.ProcessEnv;

const payload = {
  session_id: '78d46e16-17a1-4369-9437-a0c97985ed61',
  transcript_path: '/home/u/.claude/projects/x/78d46e16.jsonl',
  cwd: '/home/u/repo',
  hook_event_name: 'StopFailure',
  error: 'rate_limit',
  error_details: '429 Too Many Requests',
  last_assistant_message: 'Working on it',
};

beforeEach(() => { env.PAPERCUSP_HOME = mkdtempSync(join(tmpdir(), 'stop-failure-test-')); });
afterEach(() => { rmSync(env.PAPERCUSP_HOME!, { recursive: true, force: true }); });

describe('buildStopFailureReport', () => {
  it('records the session, the error kind and the details as one lifecycle error row', () => {
    const args = buildStopFailureReport(payload, env);
    expect(args).toEqual({
      owner: 'su-abc',
      agent: 'claude',
      session_id: payload.session_id,
      kind: 'lifecycle',
      status: 'error',
      summary: `${STOP_FAILURE_SUMMARY_PREFIX}: rate_limit — 429 Too Many Requests`,
      tool_input: { hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests' },
      cwd: '/home/u/repo',
    });
  });

  it('names the error kind "unknown" when Claude sent none, and serializes structured details', () => {
    const args = buildStopFailureReport(
      { session_id: 's1', hook_event_name: 'StopFailure', error_details: { status: 529, type: 'overloaded_error' } },
      env,
    );
    expect(args?.tool_input).toEqual({
      hook_event_name: 'StopFailure',
      error: 'unknown',
      error_details: '{"status":529,"type":"overloaded_error"}',
    });
    expect(args?.summary.startsWith(`${STOP_FAILURE_SUMMARY_PREFIX}: unknown`)).toBe(true);
  });

  it('keeps the summary inside the activity:report cap', () => {
    const args = buildStopFailureReport({ ...payload, error_details: 'x'.repeat(5000) }, env);
    expect(args!.summary.length).toBeLessThanOrEqual(512);
    expect(String(args!.tool_input.error_details).length).toBeLessThanOrEqual(400);
  });

  it('never fires a lifecycle side effect: the summary matches neither session marker', () => {
    const { summary } = buildStopFailureReport(payload, env)!;
    expect(summary).not.toBe(SESSION_START_MARKER);
    expect(summary).not.toBe(SESSION_END_MARKER);
  });

  it('records nothing outside a psu session, for another event, or without a session id', () => {
    expect(buildStopFailureReport(payload, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(buildStopFailureReport({ ...payload, hook_event_name: 'Stop' }, env)).toBeNull();
    expect(buildStopFailureReport({ ...payload, session_id: '' }, env)).toBeNull();
    expect(buildStopFailureReport(null, env)).toBeNull();
  });
});

describe('postStopFailureReport', () => {
  it('POSTs activity:report to the operator MCP endpoint as the session owner', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true,"id":123}' }] } }), { status: 200 }));
    const args = buildStopFailureReport(payload, env);
    await expect(postStopFailureReport(args, { env, token: 'tok', fetchImpl })).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://127.0.0.1:3070/api/mcp?superuser=1&origin=hook&client=su-abc&format=json&workspace=papercusp-workspace',
    );
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(init?.body));
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'activity:report', arguments: args });
  });

  it('fails open: no record, no token, an error status or a throw all answer false without throwing', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await postStopFailureReport(null, { env, token: 'tok', fetchImpl: ok })).toBe(false);
    expect(await postStopFailureReport(buildStopFailureReport(payload, env), { env, token: '', fetchImpl: ok })).toBe(false);
    expect(ok).not.toHaveBeenCalled();
    const bad = vi.fn(async () => new Response('no', { status: 500 }));
    expect(await postStopFailureReport(buildStopFailureReport(payload, env), { env, token: 'tok', fetchImpl: bad })).toBe(false);
    const boom = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await postStopFailureReport(buildStopFailureReport(payload, env), { env, token: 'tok', fetchImpl: boom })).toBe(false);
  });
});

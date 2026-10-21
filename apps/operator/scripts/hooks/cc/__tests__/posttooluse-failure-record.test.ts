/**
 * posttooluse-failure-record (client-native-features-adoption-2026-10-21 P-003, R-3).
 *
 * A PostToolUseFailure payload must produce exactly one durable activity:report
 * record carrying the tool name, the session and the failure; anything that is not
 * a psu PostToolUseFailure must produce none. The payload shape is the one Claude
 * Code 2.1.293 builds (`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`,
 * `error`, `is_interrupt`, `duration_ms` on top of the common `session_id` /
 * `transcript_path` / `cwd` fields).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildToolFailureReport,
  reduceToolInput,
  TOOL_FAILURE_SUMMARY_PREFIX,
  TOOL_INTERRUPT_SUMMARY_PREFIX,
} from '../posttooluse-failure-record.mjs';
import { postActivityReport } from '../pc_activity_report.mjs';

const env = {
  PAPERCUSP_SID: 'su-abc',
  PAPERCUSP_WORKSPACE: 'papercusp-workspace',
  PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/',
} as NodeJS.ProcessEnv;

const payload = {
  session_id: '78d46e16-17a1-4369-9437-a0c97985ed61',
  transcript_path: '/home/u/.claude/projects/x/78d46e16.jsonl',
  cwd: '/home/u/repo',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Edit',
  tool_input: { file_path: '/home/u/repo/a.ts', old_string: 'x', new_string: 'y', replace_all: false },
  tool_use_id: 'toolu_01ABC',
  error: 'String to replace not found in file.',
  is_interrupt: false,
  duration_ms: 12,
};

describe('buildToolFailureReport', () => {
  it('records the tool name, the session and the failure as one post-phase tool row', () => {
    const args = buildToolFailureReport(payload, env);
    expect(args).toEqual({
      owner: 'su-abc',
      agent: 'claude',
      session_id: payload.session_id,
      kind: 'tool',
      phase: 'post',
      status: 'error',
      tool_name: 'Edit',
      tool_use_id: 'toolu_01ABC',
      tool_input: { file_path: '/home/u/repo/a.ts', old_string: 'x', new_string: 'y', replace_all: false },
      summary: `${TOOL_FAILURE_SUMMARY_PREFIX}: Edit — String to replace not found in file.`,
      cwd: '/home/u/repo',
    });
  });

  it('marks a user interrupt as interrupted rather than as an error', () => {
    const args = buildToolFailureReport({ ...payload, is_interrupt: true, error: 'Interrupted by user' }, env);
    expect(args?.status).toBe('interrupted');
    expect(args?.summary).toBe(`${TOOL_INTERRUPT_SUMMARY_PREFIX}: Edit — Interrupted by user`);
  });

  it('names an unknown error when Claude sent none, and serializes a structured one', () => {
    expect(buildToolFailureReport({ ...payload, error: undefined }, env)?.summary).toBe(
      `${TOOL_FAILURE_SUMMARY_PREFIX}: Edit — unknown error`,
    );
    expect(buildToolFailureReport({ ...payload, error: { code: 'ENOENT' } }, env)?.summary).toBe(
      `${TOOL_FAILURE_SUMMARY_PREFIX}: Edit — {"code":"ENOENT"}`,
    );
  });

  it('keeps the summary inside the activity:report cap and bounds the tool input', () => {
    const args = buildToolFailureReport(
      { ...payload, tool_name: 'Write', error: 'e'.repeat(5000), tool_input: { file_path: '/a', content: 'c'.repeat(100_000) } },
      env,
    );
    expect(args!.summary.length).toBeLessThanOrEqual(512);
    expect(String(args!.tool_input.content).length).toBeLessThanOrEqual(512);
    expect(args!.tool_input.file_path).toBe('/a');
  });

  it('records nothing outside a psu session, for another event, or without a session id or tool name', () => {
    expect(buildToolFailureReport(payload, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(buildToolFailureReport({ ...payload, hook_event_name: 'PostToolUse' }, env)).toBeNull();
    expect(buildToolFailureReport({ ...payload, session_id: '' }, env)).toBeNull();
    expect(buildToolFailureReport({ ...payload, tool_name: '' }, env)).toBeNull();
    expect(buildToolFailureReport(null, env)).toBeNull();
  });
});

describe('reduceToolInput', () => {
  it('keeps scalar fields, clips strings, drops structured values and caps the field count', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(reduceToolInput(many))).toHaveLength(20);
    expect(reduceToolInput({ edits: [{ a: 1 }], nested: { b: 2 }, n: 3, ok: true, s: 's' })).toEqual({ n: 3, ok: true, s: 's' });
    expect(reduceToolInput(null)).toEqual({});
    expect(reduceToolInput(['a'])).toEqual({});
  });
});

describe('postActivityReport', () => {
  it('POSTs activity:report to the operator MCP endpoint as the session owner', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }));
    const args = buildToolFailureReport(payload, env);
    await expect(postActivityReport(args, { env, token: 'tok', fetchImpl })).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://127.0.0.1:3070/api/mcp?superuser=1&origin=hook&client=su-abc&workspace=papercusp-workspace',
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(init?.body));
    expect(body.params).toEqual({ name: 'activity:report', arguments: args });
  });

  it('fails open: no record, no token, an error status or a throw all answer false without throwing', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await postActivityReport(null, { env, token: 'tok', fetchImpl: ok })).toBe(false);
    expect(await postActivityReport(buildToolFailureReport(payload, env), { env, token: '', fetchImpl: ok })).toBe(false);
    expect(ok).not.toHaveBeenCalled();
    const bad = vi.fn(async () => new Response('no', { status: 500 }));
    expect(await postActivityReport(buildToolFailureReport(payload, env), { env, token: 'tok', fetchImpl: bad })).toBe(false);
    const boom = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await postActivityReport(buildToolFailureReport(payload, env), { env, token: 'tok', fetchImpl: boom })).toBe(false);
  });
});

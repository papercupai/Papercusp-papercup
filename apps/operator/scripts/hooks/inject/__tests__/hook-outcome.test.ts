/**
 * The hook outcome channel (WI-6554700010042393). Every "emit nothing" exit of the
 * injection hook prints the same empty stdout, so an abort during local collection
 * on the mid-turn port looked exactly like an empty server answer. postInjection
 * now reports which branch produced its answer (onHookOutcome), and runInjection
 * writes one JSONL record per invocation when PAPERCUSP_HOOK_OUTCOME_FILE is set.
 *
 * Lives beside core.mjs on purpose: test selection is by workspace.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { postInjection, runInjection, hookOutcomeTracer } = await import(path.join(HERE, '..', 'core.mjs'));
const { PORTS } = (await import(path.join(HERE, '..', 'ports.mjs'))) as {
  PORTS: Record<string, { timeoutMs: number }>;
};

const answer = (text: string) => (async () => ({ ok: true, status: 200, json: async () => ({ text }) })) as unknown as typeof fetch;

const outcomeOf = async (port: string, fetchImpl: unknown, body: Record<string, unknown> = { owner: 'su-test' }) => {
  const seen: Array<Record<string, unknown>> = [];
  await postInjection(port, body, { env: {}, fetchImpl, now: () => 1_000, onHookOutcome: (o: Record<string, unknown>) => seen.push(o) });
  return seen;
};

afterEach(() => { vi.useRealTimers(); });

describe('postInjection reports which branch produced its answer', () => {
  it('a server answer is response-received with its text length', async () => {
    const seen = await outcomeOf('stop', answer('hello'));
    expect(seen).toEqual([expect.objectContaining({ port: 'stop', stage: 'response-received', textChars: 5, timeoutMs: PORTS.stop!.timeoutMs })]);
  });

  it('an HTTP failure carries its status', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await outcomeOf('stop', fetchImpl)).toEqual([expect.objectContaining({ stage: 'http-error', status: 503 })]);
  });

  it('a refused connection is unreachable, distinct from a wall abort', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await outcomeOf('stop', fetchImpl)).toEqual([expect.objectContaining({ stage: 'unreachable' })]);
  });

  it('mid-turn: a wall that fires during local collection is wall-before-fetch, and no request leaves', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(answer('late'));
    const seen: Array<Record<string, unknown>> = [];
    const pending = postInjection('mid-turn', { owner: 'su-test', toolCalls: [] }, {
      env: {}, fetchImpl, now: () => 1_000, onHookOutcome: (o: Record<string, unknown>) => seen.push(o),
    });
    // Synchronously, before collection's microtasks settle: the hook's own wall fires.
    vi.advanceTimersByTime(PORTS['mid-turn']!.timeoutMs + 1);
    await pending;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(seen).toEqual([expect.objectContaining({ port: 'mid-turn', stage: 'wall-before-fetch', collectMs: 0 })]);
  });

  it('mid-turn: collection time is reported beside a normal answer', async () => {
    const seen = await outcomeOf('mid-turn', answer('ctx'), { owner: 'su-test', toolCalls: [] });
    expect(seen).toEqual([expect.objectContaining({ stage: 'response-received', collectMs: 0, textChars: 3 })]);
  });

  it('a throwing callback never changes delivery', async () => {
    const result = await postInjection('stop', { owner: 'su-test' }, {
      env: {}, fetchImpl: answer('kept'), onHookOutcome: () => { throw new Error('boom'); },
    });
    expect(result).toMatchObject({ text: 'kept' });
  });
});

describe('runInjection writes one outcome record per invocation when opted in', () => {
  const adapter = { client: 'test', portForEvent: () => 'stop', parse: () => ({}), render: (_port: string, text: string) => text };

  const run = async (env: Record<string, string>, fetchImpl: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-outcome-'));
    const file = path.join(dir, 'outcome.jsonl');
    try {
      const out = await runInjection({ adapter, nativeEvent: 'Stop', event: {}, env: { ...env, PAPERCUSP_HOOK_OUTCOME_FILE: file }, fetchImpl });
      const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      return { out, records };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('an empty server answer is no-text, carrying the post-level outcome', async () => {
    const { out, records } = await run({ PAPERCUSP_SID: 'su-test' }, answer(''));
    expect(out).toBeNull();
    expect(records).toEqual([expect.objectContaining({
      client: 'test', nativeEvent: 'Stop', stage: 'no-text', port: 'stop',
      post: expect.objectContaining({ stage: 'response-received', textChars: 0 }),
    })]);
  });

  it('a delivered answer is emitted', async () => {
    const { out, records } = await run({ PAPERCUSP_SID: 'su-test' }, answer('hello'));
    expect(out).toBe('hello');
    expect(records).toEqual([expect.objectContaining({ stage: 'emitted', payloadChars: 5 })]);
  });

  it('a missing session id is no-owner and sends nothing', async () => {
    const fetchImpl = vi.fn(answer('x'));
    const { out, records } = await run({}, fetchImpl);
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records).toEqual([expect.objectContaining({ stage: 'no-owner' })]);
  });

  it('is off unless an absolute path is named (no I/O by default)', () => {
    expect(hookOutcomeTracer({}, {})).toBeNull();
    expect(hookOutcomeTracer({ PAPERCUSP_HOOK_OUTCOME_FILE: 'relative.jsonl' }, {})).toBeNull();
    expect(typeof hookOutcomeTracer({ PAPERCUSP_HOOK_OUTCOME_FILE: '/tmp/x.jsonl' }, {})).toBe('function');
  });
});

describe('unavailable mutation authority reports its transport branch', () => {
  const adapter = { client: 'test', portForEvent: () => 'pre-tool',
    parse: () => ({ tool: 'exec_command', input: { cmd: 'read-only probe' } }),
    render: (_port: string, text: string) => text };
  const run = (fetchImpl: typeof fetch) => runInjection({
    adapter, nativeEvent: 'PreToolUse', event: {}, env: { PAPERCUSP_SID: 'su-test' }, fetchImpl,
  });

  it('names HTTP status without exposing response bodies', async () => {
    const out = await run((async () => ({ ok: false, status: 503,
      json: async () => ({ secret: 'must-not-appear' }) })) as unknown as typeof fetch);
    expect(out).toContain('execution-authority lookup failed');
    expect(out).toContain('no server verdict was received');
    expect(out).toContain('stage=http-error');
    expect(out).toContain('httpStatus=503');
    expect(out).not.toContain('must-not-appear');
  });

  it('distinguishes an unreachable operator from a timeout', async () => {
    const out = await run((async () => { throw new Error('sensitive-route'); }) as unknown as typeof fetch);
    expect(out).toContain('stage=unreachable');
    expect(out).not.toContain('sensitive-route');
  });

  it('names a wall abort while retaining the hard deadline', async () => {
    vi.useFakeTimers();
    const pending = run(((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PORTS['pre-tool']!.timeoutMs);
    expect(await pending).toContain('stage=wall-during-fetch');
    expect(await pending).toContain(`timeoutMs=${PORTS['pre-tool']!.timeoutMs}`);
  });

  it('reports the attempted origin without leaking URL credentials or request details', async () => {
    const out = await runInjection({ adapter, nativeEvent: 'PreToolUse', event: {},
      env: { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://user:secret@remote.example:3123/private?token=hidden' },
      fetchImpl: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    });
    expect(out).toContain('operatorOrigin=http://remote.example:3123');
    for (const secret of ['user', 'secret', '/private', 'token', 'hidden']) expect(out).not.toContain(secret);
  });

  it('names the fallback origin when the pinned operator cannot be reached', async () => {
    let attempts = 0;
    const out = await runInjection({ adapter, nativeEvent: 'PreToolUse', event: {},
      env: { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170', PAPERCUSP_MCP_PROXY_PORT: '9079' },
      fetchImpl: (async () => {
        if (++attempts === 1) throw new Error('unreachable');
        return { ok: false, status: 503 };
      }) as unknown as typeof fetch,
    });
    expect(attempts).toBe(2);
    expect(out).toContain('operatorOrigin=http://127.0.0.1:9079');
    expect(out).not.toContain('operatorOrigin=http://127.0.0.1:3170');
  });

  it('keeps a successful empty verdict distinct from unavailable authority', async () => {
    expect(await run(answer(''))).toBeNull();
    expect(await run(answer('named-rule refusal'))).toBe('named-rule refusal');
  });
});

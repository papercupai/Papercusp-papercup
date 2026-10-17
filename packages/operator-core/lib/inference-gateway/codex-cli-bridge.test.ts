/**
 * Codex-CLI bridge (ChatGPT-subscription → /v1/responses) — the pure pieces +
 * the runner against a fake spawn. Event shapes mirror the live capture on
 * codex 0.142.2 (2026-07-01); see codex-cli-bridge.ts header.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import {
  CODEX_CLI_REF_PREFIX,
  codexCliFailureDetail,
  isCodexAuthFailure,
  isCodexRateLimitFailure,
  codexCliResponsesCompletionSse,
  codexCliResponsesBody,
  extractResponsesInputText,
  parseBridgeModel,
  parseCodexCliEvents,
  parseCodexCliRef,
  runCodexCliCompletion,
} from './codex-cli-bridge';
import { resolveAgentBinarySync } from '../agent-bin-detect';
import { CODEX_SAFE_DEFAULT_MODEL } from '../model-context-budget.mjs';
/** Managed Codex default id (the model-less fallback), derived so a deliberate default bump cannot strand these assertions. */
const DEFAULT_CODEX_ID = CODEX_SAFE_DEFAULT_MODEL.split(':')[0];

// Spy-wrapped, NOT stubbed: the real resolver still runs by default, so this
// file keeps testing the production path. Only the fallback case below pins a
// return value, and it does so to assert the seam is CONSULTED — the whole
// point of WI-39538, where spawning the bare name 'codex' meant the operator
// could not find an installed codex under its own systemd PATH.
vi.mock('../agent-bin-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-bin-detect')>();
  return { ...actual, resolveAgentBinarySync: vi.fn(actual.resolveAgentBinarySync) };
});

describe('parseCodexCliRef', () => {
  it('parses the codex-cli scheme and expands ~', () => {
    expect(parseCodexCliRef('codex-cli:/home/u/.codex')).toBe('/home/u/.codex');
    expect(parseCodexCliRef('codex-cli:~/.codex')).toBe(`${os.homedir()}/.codex`);
    expect(parseCodexCliRef('codex-cli:~')).toBe(os.homedir());
  });
  it('returns null for bearer refs and empty paths (they stay on the HTTP path)', () => {
    expect(parseCodexCliRef('token:/path/to/key')).toBeNull();
    expect(parseCodexCliRef('env:OPENAI_API_KEY')).toBeNull();
    expect(parseCodexCliRef(CODEX_CLI_REF_PREFIX)).toBeNull();
    expect(parseCodexCliRef('codex-cli:   ')).toBeNull();
  });
});

describe('parseBridgeModel', () => {
  it('bare id → medium effort (codex default)', () => {
    expect(parseBridgeModel('gpt-5.4')).toEqual({ id: 'gpt-5.4', effort: 'medium' });
  });
  it('strips a recognised :effort suffix', () => {
    expect(parseBridgeModel('gpt-5.4:high')).toEqual({ id: 'gpt-5.4', effort: 'high' });
    expect(parseBridgeModel('gpt-5.4:xhigh')).toEqual({ id: 'gpt-5.4', effort: 'xhigh' });
    expect(parseBridgeModel('gpt-5.6-sol:xhigh')).toEqual({ id: 'gpt-5.6-sol', effort: 'xhigh' });
  });
  it('preserves the owner-requested Codex max effort', () => {
    expect(parseBridgeModel('gpt-5.4:max')).toEqual({ id: 'gpt-5.4', effort: 'max' });
  });
  it('maps the chatgpt:<n> alias (with and without effort)', () => {
    expect(parseBridgeModel('chatgpt:5.4')).toEqual({ id: 'gpt-5.4', effort: 'medium' });
    expect(parseBridgeModel('chatgpt:5.4:high')).toEqual({ id: 'gpt-5.4', effort: 'high' });
  });
  it('normalizes bare Papercusp Codex family aliases before the backend sees them', () => {
    expect(parseBridgeModel('sol:xhigh')).toEqual({ id: 'gpt-5.6-sol', effort: 'xhigh' });
    expect(parseBridgeModel('terra')).toEqual({ id: 'gpt-5.6-terra', effort: 'medium' });
    expect(parseBridgeModel('luna:max')).toEqual({ id: 'gpt-5.6-luna', effort: 'max' });
  });
  it('strips a provider prefix (openai-codex/…)', () => {
    expect(parseBridgeModel('openai-codex/gpt-5.4:low')).toEqual({ id: 'gpt-5.4', effort: 'low' });
  });
  it('an unrecognised suffix stays in the id (never silently dropped)', () => {
    expect(parseBridgeModel('gpt-5.4:turbo')).toEqual({ id: 'gpt-5.4:turbo', effort: 'medium' });
  });
  it('empty/undefined falls back to Sol at xhigh', () => {
    expect(parseBridgeModel(undefined)).toEqual({ id: DEFAULT_CODEX_ID, effort: 'xhigh' });
    expect(parseBridgeModel('  ')).toEqual({ id: DEFAULT_CODEX_ID, effort: 'xhigh' });
  });

  it('rejects the retired Spark model before a bridge process is spawned', () => {
    expect(() => parseBridgeModel('openai-codex/gpt-5.3-codex-spark:high')).toThrow(/denied/i);
  });
});

describe('parseCodexCliEvents (live-captured JSONL contract)', () => {
  const LIVE = [
    '{"type":"thread.started","thread_id":"019f1f87-d892-7140-bf4e-61cdb12bb17a"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":14714,"cached_input_tokens":4480,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join('\n');
  it('extracts the agent_message text + turn usage', () => {
    expect(parseCodexCliEvents(LIVE)).toEqual({ text: 'OK', inputTokens: 14714, outputTokens: 5 });
  });
  it('concatenates multiple agent_message items and skips noise lines', () => {
    const s = [
      'some non-json banner',
      '{"type":"item.completed","item":{"type":"agent_message","text":"part1 "}}',
      '{"type":"item.completed","item":{"type":"reasoning"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"part2"}}',
    ].join('\n');
    expect(parseCodexCliEvents(s).text).toBe('part1 part2');
  });
  it('empty stream → empty text + zero usage', () => {
    expect(parseCodexCliEvents('')).toEqual({ text: '', inputTokens: 0, outputTokens: 0 });
  });
});

describe('codexCliResponsesBody', () => {
  it('emits the /v1/responses shapes extractResponsesText walks', () => {
    const b = codexCliResponsesBody({ model: 'gpt-5.4', text: 'hi', inputTokens: 3, outputTokens: 1 }) as unknown as {
      object: string;
      status: string;
      output_text: string;
      output: Array<{
        id: string;
        type: string;
        status: string;
        content: Array<{ type: string; text: string; annotations: unknown[]; logprobs: unknown[] }>;
      }>;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      gateway_codex_cli: boolean;
    };
    expect(b.object).toBe('response');
    expect(b.status).toBe('completed');
    expect(b.output_text).toBe('hi');
    expect(b.output[0]).toMatchObject({ id: expect.stringMatching(/^msg_codexcli_/), status: 'completed' });
    expect(b.output[0].content[0]).toMatchObject({ type: 'output_text', text: 'hi', annotations: [] });
    expect(b.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
    expect(b.gateway_codex_cli).toBe(true);
  });

  it('emits the output-item/content event progression a Codex client uses to materialize text', () => {
    const body = codexCliResponsesBody({
      model: 'gpt-5.6-sol',
      text: 'GATEWAY_AUTO_OK',
      inputTokens: 8,
      outputTokens: 2,
    });
    const wire = codexCliResponsesCompletionSse(body);
    const events = wire
      .split('\n\n')
      .map((frame) =>
        frame
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6),
      )
      .filter((data): data is string => Boolean(data && data !== '[DONE]'))
      .map(
        (data) =>
          JSON.parse(data) as { type: string; item?: { id?: string }; response?: { id?: string }; delta?: string },
      );
    expect(events.map((event) => event.type)).toEqual([
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.find((event) => event.type === 'response.output_text.delta')?.delta).toBe('GATEWAY_AUTO_OK');
    expect(events.find((event) => event.type === 'response.output_item.done')?.item?.id).toBe(body.output[0].id);
    expect(events.at(-1)?.response?.id).toBe(body.id);
    expect(wire).toMatch(/data: \[DONE\]\n\n$/);
  });
});

describe('extractResponsesInputText', () => {
  it('passes a string input through', () => {
    expect(extractResponsesInputText('hello')).toBe('hello');
  });
  it('flattens structured Responses-API input items', () => {
    expect(
      extractResponsesInputText([
        { role: 'user', content: [{ type: 'input_text', text: 'a' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
        { text: 'c' },
      ]),
    ).toBe('a\nb\nc');
  });
  it('junk → empty string', () => {
    expect(extractResponsesInputText(undefined)).toBe('');
    expect(extractResponsesInputText(42)).toBe('');
  });
});

/** A spawn() fake for the runner: scripted stdout/stderr + exit code. */
type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: (s?: string) => void };
  pid: number | undefined;
};
function fakeSpawn(script: {
  stdout?: string;
  stdoutChunks?: Buffer[];
  stderr?: string;
  code?: number | null;
  neverClose?: boolean;
}) {
  const calls: { bin: string; argv: string[]; opts: Record<string, unknown>; stdinBody?: string }[] = [];
  const spawnFn = ((bin: string, argv: string[], opts: Record<string, unknown>) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined; // killGroup no-ops on a pid-less fake
    const call: (typeof calls)[number] = { bin, argv, opts };
    child.stdin = {
      end: (s?: string) => {
        call.stdinBody = s;
      },
    };
    calls.push(call);
    if (!script.neverClose) {
      process.nextTick(() => {
        if (script.stdoutChunks) {
          for (const chunk of script.stdoutChunks) child.stdout.emit('data', chunk);
        } else if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
        if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
        child.emit('close', script.code ?? 0);
      });
    }
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, calls };
}

describe('runCodexCliCompletion', () => {
  const OK_STDOUT = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"BRIDGED"}}',
    '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}',
  ].join('\n');

  it('spawns codex exec with the proven flag set, prompt on stdin, CODEX_HOME set', async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: OK_STDOUT, code: 0 });
    const r = await runCodexCliCompletion({
      home: '/tmp/sub-home',
      model: 'gpt-5.4',
      effort: 'medium',
      prompt: 'say hi',
      timeoutMs: 5_000,
      spawnFn,
      // Pinned explicitly so this case asserts the ARGV contract, not whatever
      // codex happens to be installed on the host running the suite. Without
      // it the resolver returns a real absolute path here (e.g.
      // /home/<user>/.local/node25/bin/codex) and the assertion below fails on
      // a developer box while passing in a container — a host-dependent test.
      codexBin: 'codex',
    });
    expect(r).toEqual({ text: 'BRIDGED', inputTokens: 9, outputTokens: 2 });
    const c = calls[0];
    expect(c.bin).toBe('codex');
    expect(c.argv).toContain('exec');
    expect(c.argv).toContain('--json');
    expect(c.argv).toContain('--ephemeral');
    expect(c.argv.join(' ')).toContain('-s read-only'); // LLM call needs no writes
    expect(c.argv.join(' ')).toContain('-m gpt-5.4');
    expect(c.argv.join(' ')).toContain('model_reasoning_effort="medium"');
    expect(c.argv[c.argv.length - 1]).toBe('-'); // prompt via stdin
    expect(c.stdinBody).toBe('say hi');
    expect((c.opts.env as Record<string, string>).CODEX_HOME).toBe('/tmp/sub-home');
  });

  it('preserves UTF-8 when stdout splits a JSONL message across chunks', async () => {
    const line = Buffer.from(
      '{"type":"item.completed","item":{"type":"agent_message","text":"☃"}}\n',
    );
    const split = line.indexOf(Buffer.from('☃')) + 1;
    const { spawnFn } = fakeSpawn({
      stdoutChunks: [line.subarray(0, split), line.subarray(split)],
      code: 0,
    });
    const result = await runCodexCliCompletion({
      home: '/tmp/sub-home',
      model: 'gpt-5.4',
      effort: 'medium',
      prompt: 'say hi',
      timeoutMs: 5_000,
      spawnFn,
      codexBin: 'codex',
    });
    expect(result.text).toBe('☃');
  });

  it('resolves the binary through the shared resolver when no codexBin is passed (WI-39538)', async () => {
    // THE REGRESSION THIS PINS: the bridge used to spawn the bare name 'codex'.
    // The operator runs under systemd with a PATH that does not carry the
    // user's npm/local bin dirs, so the bare name ENOENT'd even with codex
    // installed — the same root cause as settings reporting "✗ not found".
    // Asserting a RESOLVED path (not the bare name) is what makes a revert to
    // `spawn('codex')` fail here instead of only in production.
    vi.mocked(resolveAgentBinarySync).mockReturnValueOnce('/opt/pinned/bin/codex');
    const { spawnFn, calls } = fakeSpawn({ stdout: OK_STDOUT, code: 0 });
    await runCodexCliCompletion({
      home: '/tmp/sub-home',
      model: 'gpt-5.4',
      effort: 'medium',
      prompt: 'say hi',
      timeoutMs: 5_000,
      spawnFn,
    });
    expect(vi.mocked(resolveAgentBinarySync)).toHaveBeenCalledWith('codex');
    expect(calls[0].bin).toBe('/opt/pinned/bin/codex');
  });

  it('rejects on a non-zero exit with stderr context', async () => {
    const { spawnFn } = fakeSpawn({ stderr: 'stream error: auth expired', code: 1 });
    await expect(
      runCodexCliCompletion({ home: '/x', model: 'gpt-5.4', effort: 'low', prompt: 'p', timeoutMs: 5_000, spawnFn }),
    ).rejects.toThrow(/exited 1.*auth expired/s);
  });

  it('rejects when the stream carries no agent_message', async () => {
    const { spawnFn } = fakeSpawn({ stdout: '{"type":"turn.started"}', code: 0 });
    await expect(
      runCodexCliCompletion({ home: '/x', model: 'gpt-5.4', effort: 'low', prompt: 'p', timeoutMs: 5_000, spawnFn }),
    ).rejects.toThrow(/no agent_message/);
  });

  it('rejects on timeout when codex never exits', async () => {
    const { spawnFn } = fakeSpawn({ neverClose: true });
    await expect(
      runCodexCliCompletion({ home: '/x', model: 'gpt-5.4', effort: 'low', prompt: 'p', timeoutMs: 60, spawnFn }),
    ).rejects.toThrow(/timed out after 60ms/);
  });

  it('rejects on abort (downstream hung up)', async () => {
    const { spawnFn } = fakeSpawn({ neverClose: true });
    const ac = new AbortController();
    const p = runCodexCliCompletion({
      home: '/x',
      model: 'gpt-5.4',
      effort: 'low',
      prompt: 'p',
      timeoutMs: 10_000,
      signal: ac.signal,
      spawnFn,
    });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

/**
 * EI-21618978789879488 — a failure detail must never be blank.
 *
 * A clobbered ~/.codex/auth.json made every bridged call exit 1 while codex
 * wrote the actual cause to its --json STDOUT stream. The bridge reported
 * stderr only, so the error read `codex exited 1: ` with an empty tail. That
 * blank tail got diagnosed fleet-wide as a quota wall for hours, and the
 * proposed remedy was to move ~20 model-bearing learning paths onto a more
 * exhausted provider. The real message was sitting unread in stdout.
 *
 * The incident's own stdout is the fixture, with the bearer value replaced by a
 * non-credential placeholder.
 */
const AUTH_HEADER_ERROR_STDOUT = [
  '{"type":"thread.started","thread_id":"01a04414-e33b-7cc3-bc02-6bf0fe3c3ac9"}',
  '{"type":"turn.started"}',
  '2026-08-27T16:36:54.864240Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: UTF-8 encoding error: failed to convert header to a str for header name \'authorization\' with value: "Bearer PLACEHOLDER-NOT-A-REAL-TOKEN"',
].join('\n');

describe('codexCliFailureDetail (EI-21618978789879488)', () => {
  it('surfaces the tracing ERROR codex wrote to STDOUT when stderr is empty', () => {
    const detail = codexCliFailureDetail(AUTH_HEADER_ERROR_STDOUT, '');
    expect(detail).not.toBe('');
    expect(detail).toMatch(/authorization/);
    expect(detail).toMatch(/failed to convert header/);
    expect(detail).toContain('[REDACTED]');
    expect(detail).not.toContain('PLACEHOLDER-NOT-A-REAL-TOKEN');
  });

  it('redacts bearer values from stderr fallbacks too', () => {
    const detail = codexCliFailureDetail('', 'HTTP 401 Authorization: Bearer sk-not-a-real-secret');
    expect(detail).toContain('HTTP 401');
    expect(detail).toContain('Bearer [REDACTED]');
    expect(detail).not.toContain('sk-not-a-real-secret');
  });

  it('never returns empty while either stream holds content — the whole contract', () => {
    // Benign JSONL only: no error line, no stderr. Must still say something.
    expect(codexCliFailureDetail('{"type":"turn.started"}', '')).not.toBe('');
    expect(codexCliFailureDetail('', 'boom from stderr')).toContain('boom from stderr');
    expect(codexCliFailureDetail('some banner text', '')).toContain('some banner text');
  });

  it('prefers an explicit error over incidental noise, and honours the tail limit', () => {
    const detail = codexCliFailureDetail(AUTH_HEADER_ERROR_STDOUT, '');
    expect(detail).not.toMatch(/thread\.started/);
    expect(codexCliFailureDetail(AUTH_HEADER_ERROR_STDOUT, '', 40).length).toBeLessThanOrEqual(40);
  });

  it('reads a structured error field out of a JSONL event', () => {
    const detail = codexCliFailureDetail('{"type":"turn.failed","error":"usage limit reached"}', '');
    expect(detail).toContain('usage limit reached');
  });
});

describe('runCodexCliCompletion — a non-zero exit is always diagnosable', () => {
  it('names the stdout auth error instead of rejecting with a blank tail', async () => {
    const { spawnFn } = fakeSpawn({ stdout: AUTH_HEADER_ERROR_STDOUT, stderr: '', code: 1 });
    let err: Error | undefined;
    try {
      await runCodexCliCompletion({
        home: '/tmp/clobbered-home',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        prompt: 'anything',
        timeoutMs: 5_000,
        spawnFn,
        codexBin: '/usr/bin/codex',
      });
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeInstanceOf(Error);
    // The pre-fix message was EXACTLY `codex-cli bridge: codex exited 1: `.
    // Assert both that the blank shape is gone and that the cause is named.
    expect(err?.message).not.toMatch(/exited 1:\s*$/);
    expect(err?.message).toMatch(/authorization/);
  });
});

describe('isCodexAuthFailure (EI-21618978789879488)', () => {
  it('classifies the real 2026-08-27 clobber — the failure that read as a quota wall for hours', () => {
    expect(isCodexAuthFailure(codexCliFailureDetail(AUTH_HEADER_ERROR_STDOUT, ''))).toBe(true);
  });

  it('classifies the other ways a codex credential is unusable', () => {
    for (const detail of [
      'codex-oauth-proxy: no usable auth.json at /home/x/.codex/auth.json',
      'codex-oauth-proxy: no refresh_token in auth.json — re-login with `codex`',
      'HTTP 401 Unauthorized',
      'invalid_api_key: Incorrect API key provided',
      'authentication failed',
      'refresh_token_reused',
    ]) {
      expect(isCodexAuthFailure(detail), detail).toBe(true);
    }
  });

  // CONTROL — the classifier is only worth anything if it does NOT fire here. A quota wall is an
  // exhausted-but-HEALTHY account with its own failover path; relabelling it as credential death
  // would quarantine a good account for 15 minutes and thin the pool under exactly the load that
  // produced the 429. The incident was this mistake in the other direction (a credential fault read
  // as "the provider is out of usage"); neither direction may be possible.
  it('does NOT classify quota/rate walls as credential death', () => {
    for (const detail of [
      "You've hit your usage limit.",
      'rate limited, retry after 30s',
      'rate_limit_error',
      'HTTP 429 Too Many Requests',
      'quota exceeded for this account',
    ]) {
      expect(isCodexAuthFailure(detail), detail).toBe(false);
    }
  });

  it('does NOT classify unrelated failures, or an empty detail, as credential death', () => {
    for (const detail of ['', '   ', 'request aborted', 'spawn failed: ENOENT', 'context window exceeded']) {
      expect(isCodexAuthFailure(detail), JSON.stringify(detail)).toBe(false);
    }
  });

  // A 429 that merely MENTIONS authorization must stay a quota wall — quota wording wins.
  it('lets quota wording win when a message carries both', () => {
    expect(isCodexAuthFailure('429 too many requests on the authorization endpoint')).toBe(false);
  });
});

describe('isCodexRateLimitFailure (codex recovery P-009)', () => {
  it('recognizes the terminal quota/rate text emitted by codex exec', () => {
    for (const detail of [
      "You've hit your usage limit · resets 3am",
      'rate limited, retry after 30s',
      'rate_limit_error: exceeded retry limit, last status: 429',
      'HTTP 429 Too Many Requests',
      'quota exceeded for this account',
    ]) {
      expect(isCodexRateLimitFailure(detail), detail).toBe(true);
    }
  });

  it('does not relabel credential death or unrelated subprocess failures as throttles', () => {
    for (const detail of ['401 unauthorized', 'invalid_api_key', 'spawn failed: ENOENT', 'request aborted', '']) {
      expect(isCodexRateLimitFailure(detail), JSON.stringify(detail)).toBe(false);
    }
  });
});

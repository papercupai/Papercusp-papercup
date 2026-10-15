import { describe, expect, it } from 'vitest';

// scripts/mcp-call.mjs is the sanctioned recovery path when the Claude Code
// papercusp-su MCP client drops (EI-1740 / EI-1750). Root scripts/** route into
// this workspace for test selection (EI-19346163916263067).
import {
  buildUnreachableDiagnostic,
  fetchWithConnectionRecovery,
  isConnectionRefusedError,
  parseSse,
  resolveCandidatePorts,
} from '../../../scripts/mcp-call.mjs';

type RetryEvent = { attempt: number; delayMs: number; remainingMs: number };

const RESULT_FRAME = (payload: unknown, id: number | string = 1) =>
  `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  })}\n`;

const NOTIFICATION_FRAME = `event: message\ndata: ${JSON.stringify({
  method: 'notifications/tools/list_changed',
  params: {},
  jsonrpc: '2.0',
})}\n`;

describe('mcp-call parseSse', () => {
  // THE REGRESSION: the server emits notifications/tools/list_changed BEFORE the
  // response to tools/call. Returning the first data: frame handed callers the
  // notification — and the old `d.result ?? d` fallback returned it as a SUCCESS,
  // so `coord:orient` answered {"method":"notifications/tools/list_changed"}.
  // A well-formed, confidently wrong result on the exact path used when tools are gone.
  it('skips a leading notification frame and returns the tool result', () => {
    const raw = `:stream-open\n\n${NOTIFICATION_FRAME}\n${RESULT_FRAME({ ok: true, loop: { active: true } })}`;
    expect(parseSse(raw)).toEqual({ result: { ok: true, loop: { active: true } } });
  });

  it('tolerates several notification frames before the response', () => {
    const raw = `:stream-open\n\n${NOTIFICATION_FRAME}\n${NOTIFICATION_FRAME}\n${RESULT_FRAME({ ok: true })}`;
    expect(parseSse(raw)).toEqual({ result: { ok: true } });
  });

  // CALIBRATION CONTROL: the plain no-notification stream must still work, or the
  // guard above would also pass against a parser that is simply broken differently.
  it('still parses a stream whose only frame is the response', () => {
    expect(parseSse(RESULT_FRAME({ ok: true, n: 7 }))).toEqual({ result: { ok: true, n: 7 } });
  });

  it('surfaces a JSON-RPC error frame as an error', () => {
    const raw = `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'bad args' },
    })}\n`;
    expect(parseSse(raw)).toEqual({ error: { code: -32602, message: 'bad args' } });
  });

  // A stream carrying ONLY notifications must ERROR, never report a bogus success —
  // that is the shape that made the original bug look like a working call.
  it('errors when no frame answers the request id', () => {
    const out = parseSse(`:stream-open\n\n${NOTIFICATION_FRAME}`);
    expect(out.error).toBeDefined();
    expect(out.result).toBeUndefined();
    expect(String(out.error.message)).toContain('no JSON-RPC response frame');
  });

  it('ignores a response to a different request id', () => {
    const raw = `${RESULT_FRAME({ ok: 'other' }, 99)}\n${RESULT_FRAME({ ok: 'mine' }, 1)}`;
    expect(parseSse(raw, 1)).toEqual({ result: { ok: 'mine' } });
  });

  // FALSIFIABILITY CONTROL — the original parser, kept here deliberately wrong so the
  // guard above is proven to discriminate. Mutating the real script to prove this would
  // race git-sync's whole-tree sweep and can commit the mutant (see CLAUDE.md), so the
  // wrong implementation lives permanently in the test instead.
  const firstFrameWins = (raw: string) => {
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      let d: any;
      try { d = JSON.parse(s.slice(5).trim()); } catch { continue; }
      if (d.error) return { error: d.error };
      const text = d?.result?.content?.[0]?.text;
      if (text !== undefined) { try { return { result: JSON.parse(text) }; } catch { return { result: text }; } }
      return { result: d.result ?? d };
    }
    return { error: { message: 'no data: line in SSE response' } };
  };

  it('CONTROL: the old first-frame-wins parser IS fooled by the same input', () => {
    const raw = `:stream-open\n\n${NOTIFICATION_FRAME}\n${RESULT_FRAME({ ok: true })}`;
    // The bug, reproduced: it reports SUCCESS carrying the notification.
    expect(firstFrameWins(raw)).toEqual({
      result: { method: 'notifications/tools/list_changed', params: {}, jsonrpc: '2.0' },
    });
    // ...while the real parser returns the tool result. If these ever agree,
    // the fixture stopped exercising the regression.
    expect(parseSse(raw)).toEqual({ result: { ok: true } });
  });

  it('returns non-content results verbatim', () => {
    const raw = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { plain: true } })}\n`;
    expect(parseSse(raw)).toEqual({ result: { plain: true } });
  });
});

describe('mcp-call operator port selection', () => {
  it('EI-20227417720625568: an explicit --port is a fail-closed single-port pin', () => {
    expect(resolveCandidatePorts({ port: '3170' }, { PAPERCUSP_HONO_PORT: '3999' })).toEqual({
      configuredPort: '3170',
      candidatePorts: ['3170'],
      pinned: true,
    });
  });

  it('retains canonical and proxy recovery fallbacks for a stale inherited port hint', () => {
    expect(resolveCandidatePorts({}, { PAPERCUSP_HONO_PORT: '3170' })).toEqual({
      configuredPort: '3170',
      candidatePorts: ['3170', '3070', '9071'],
      pinned: false,
    });
  });

  it('refuses malformed explicit pins instead of silently selecting another operator', () => {
    expect(() => resolveCandidatePorts({ port: 'nope' }, {})).toThrow(/--port must be an integer/);
  });
});

describe('mcp-call connection recovery', () => {
  it('recognizes a nested undici ECONNREFUSED cause but not other failures', () => {
    expect(
      isConnectionRefusedError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    ).toBe(true);
    expect(
      isConnectionRefusedError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })),
    ).toBe(false);
  });

  it('keeps UND_ERR_SOCKET diagnostics uncertain instead of claiming no listener', () => {
    const diagnostic = buildUnreachableDiagnostic({
      attempts: [{
        port: '3271',
        error: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
      }],
      configuredPort: '3271',
      pinned: true,
    });

    expect(diagnostic).toContain('does not establish that no listener was present');
    expect(diagnostic).toContain('whether the MCP tool ran');
    expect(diagnostic).not.toContain('Nothing is listening there');
  });

  it('says the tool was not invoked only when every connection attempt was refused', () => {
    const diagnostic = buildUnreachableDiagnostic({
      attempts: [{
        port: '3271',
        error: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
      }],
      configuredPort: '3271',
      pinned: true,
    });

    expect(diagnostic).toContain('this request did not invoke the tool');
    expect(diagnostic).not.toContain('whether the MCP tool ran');
  });

  it('retries a refused explicit-port connection and returns the eventual response', async () => {
    let calls = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const response = Response.json({ ok: true });

    const result = await fetchWithConnectionRecovery(
      'http://localhost:3170/api/mcp',
      {},
      {
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
          }
          return response;
        },
        retryWindowMs: 50,
        retryDelayMs: 1,
        sleepImpl: async () => {},
        onRetry: ({ attempt, delayMs }: RetryEvent) => retries.push({ attempt, delayMs }),
      },
    );

    expect(result).toBe(response);
    expect(calls).toBe(2);
    expect(retries).toEqual([{ attempt: 1, delayMs: 1 }]);
  });

  it('does not retry non-refused failures that may follow a sent request', async () => {
    let calls = 0;
    const error = Object.assign(new Error('connection reset'), { cause: { code: 'ECONNRESET' } });

    await expect(
      fetchWithConnectionRecovery(
        'http://localhost:3170/api/mcp',
        {},
        {
          fetchImpl: async () => {
            calls += 1;
            throw error;
          },
          retryWindowMs: 50,
          sleepImpl: async () => {},
        },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('stops retrying once the bounded restart window expires', async () => {
    let now = 0;
    let calls = 0;
    const retryDelays: number[] = [];
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

    await expect(
      fetchWithConnectionRecovery(
        'http://localhost:3170/api/mcp',
        {},
        {
          fetchImpl: async () => {
            calls += 1;
            throw error;
          },
          retryWindowMs: 5,
          retryDelayMs: 2,
          sleepImpl: async (ms: number) => {
            now += ms;
          },
          now: () => now,
          onRetry: ({ delayMs }: RetryEvent) => retryDelays.push(delayMs),
        },
      ),
    ).rejects.toBe(error);

    expect(calls).toBe(4);
    expect(retryDelays).toEqual([2, 2, 1]);
  });
});

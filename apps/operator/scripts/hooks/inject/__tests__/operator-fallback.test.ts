/**
 * WI-10005007 — the injection transport falls back from a dead LOOPBACK pin to the
 * local MCP proxy, and from nothing else.
 *
 * Measured cause: a staging-pinned psu session (PAPERCUSP_OPERATOR_URL=:3170) got no
 * turn-start delivery whenever staging was down, so its in-place identity
 * activation could not be proven delivered and sat at 'prepared' for hours. The
 * fallback must stay narrow: an operator that ANSWERED (any status) or a request
 * the wall already aborted must never be re-sent to a second host, because the
 * turn-start endpoint acknowledges the previous delivery as a side effect.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { operatorBases, postInjection } = await import(path.join(HERE, '..', 'core.mjs'));

type FetchInit = { body: string; signal: AbortSignal };

function refused(): Error {
  // undici's shape for a refused connect: TypeError('fetch failed') with a cause.
  return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}

function json(text: string): Response {
  return new Response(JSON.stringify({ text }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('operatorBases — which operators a hook may try', () => {
  it('a loopback pin is followed by the default proxy', () => {
    expect(operatorBases({ PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170' })).toEqual([
      'http://127.0.0.1:3170',
      'http://127.0.0.1:9071',
    ]);
    expect(operatorBases({ PAPERCUSP_OPERATOR_URL: 'http://localhost:3170/' })).toEqual([
      'http://localhost:3170',
      'http://127.0.0.1:9071',
    ]);
  });

  it('the unset default (:3070) also gets the proxy, which bridges its restarts', () => {
    expect(operatorBases({})).toEqual(['http://localhost:3070', 'http://127.0.0.1:9071']);
  });

  it('PAPERCUSP_MCP_PROXY_PORT moves the proxy; an invalid value keeps the default', () => {
    expect(operatorBases({ PAPERCUSP_OPERATOR_URL: 'http://[::1]:3170', PAPERCUSP_MCP_PROXY_PORT: '9171' })).toEqual([
      'http://[::1]:3170',
      'http://127.0.0.1:9171',
    ]);
    expect(operatorBases({ PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170', PAPERCUSP_MCP_PROXY_PORT: '70000' })[1]).toBe(
      'http://127.0.0.1:9071',
    );
  });

  it('a pin that already IS the proxy is not tried twice', () => {
    expect(operatorBases({ PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071' })).toEqual(['http://127.0.0.1:9071']);
  });

  it('a non-loopback or unparseable pin gets no fallback', () => {
    expect(operatorBases({ PAPERCUSP_OPERATOR_URL: 'http://10.0.0.5:3070' })).toEqual(['http://10.0.0.5:3070']);
    expect(operatorBases({ PAPERCUSP_OPERATOR_URL: 'not a url' })).toEqual(['not a url']);
  });
});

describe('postInjection — falls back only when the pin could not be reached', () => {
  const env = { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170' };
  const body = { owner: 'su-test', prompt: 'hello' };

  it('refused pin -> the proxy serves the turn, through the same endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('http://127.0.0.1:3170')) throw refused();
      return json('FROM-PROXY');
    }) as unknown as typeof fetch;
    const out = await postInjection('turn-start', body, { env, fetchImpl });
    expect(out?.text).toBe('FROM-PROXY');
    expect(calls).toEqual([
      'http://127.0.0.1:3170/api/agent-mcp/turn-start-memory',
      'http://127.0.0.1:9071/api/agent-mcp/turn-start-memory',
    ]);
  });

  it('a pin that ANSWERED with an error status is not retried elsewhere', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response('nope', { status: 503 });
    }) as unknown as typeof fetch;
    expect(await postInjection('turn-start', body, { env, fetchImpl })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a pin that hit the WALL is not retried elsewhere (the time is spent)', async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string, init: FetchInit) => {
      calls.push(url);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    // mid-turn has the shortest wall (1.5s), so this case costs the least time.
    expect(await postInjection('mid-turn', { ...body, toolCalls: [] }, { env, fetchImpl })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a refused NON-loopback pin is not redirected to the local operator', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      throw refused();
    }) as unknown as typeof fetch;
    const remote = { PAPERCUSP_OPERATOR_URL: 'http://10.0.0.5:3070' };
    expect(await postInjection('turn-start', body, { env: remote, fetchImpl })).toBeNull();
    expect(calls).toEqual(['http://10.0.0.5:3070/api/agent-mcp/turn-start-memory']);
  });

  it('both refused -> silence (the fail-silent contract still holds)', async () => {
    const fetchImpl = (async () => {
      throw refused();
    }) as unknown as typeof fetch;
    expect(await postInjection('turn-start', body, { env, fetchImpl })).toBeNull();
  });
});

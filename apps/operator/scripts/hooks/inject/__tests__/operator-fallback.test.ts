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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { operatorBases, postInjection, collectInterfaceEdits } = await import(path.join(HERE, '..', 'core.mjs'));

type FetchInit = { body: string; signal: AbortSignal };

describe('interface collector request cwd', () => {
  it('resolves relative paths at the session cwd, deduplicates aliases and keeps the two-file bound', async () => {
    const paths: string[] = [];
    const call = { editedPaths: ['lib/target.ts', '/session/repo/lib/target.ts', 'lib/other.ts', 'lib/third.ts'], interfaceEdits: [] as unknown[] };
    await collectInterfaceEdits({ cwd: '/session/repo', toolCalls: [call] }, async (p: string) => {
      paths.push(p); return { path: p };
    });
    expect(paths).toEqual(['/session/repo/lib/target.ts', '/session/repo/lib/other.ts']);
    expect(call.interfaceEdits).toHaveLength(2);
  });
  it('contains a failed local read and still examines the other bounded edit', async () => {
    const paths: string[] = [];
    await collectInterfaceEdits({ cwd: '/session/repo', toolCalls: [{ editedPaths: ['gone.ts', 'present.ts'] }] }, async (p: string) => {
      paths.push(p); if (p.endsWith('gone.ts')) throw new Error('missing'); return null;
    });
    expect(paths).toEqual(['/session/repo/gone.ts', '/session/repo/present.ts']);
  });
});

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
  const env = { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170', PAPERCUSP_HOME: '' };
  beforeEach(() => { env.PAPERCUSP_HOME = mkdtempSync(path.join(tmpdir(), 'inject-fallback-')); });
  afterEach(() => { rmSync(env.PAPERCUSP_HOME, { recursive: true, force: true }); });
  const body = { owner: 'su-test', prompt: 'hello' };
  const edit = { path: 'lib/target.ts', base: 'a'.repeat(40), changes: ['signature target'],
    checks: ['node scripts/check-required-field-strands.mjs --typecheck --base ' + 'a'.repeat(40) + ' --files=lib/target.ts'] };
  it.each(['unreachable', 'empty', 'disabled-leg', 'missing-snapshot', 'no-fetch'])('preserves one merged local strand note when %s', async failure => {
    const fetchImpl = (async () => {
      if (failure === 'unreachable') throw refused();
      return json(failure === 'disabled-leg' ? 'Other context' : '');
    }) as typeof fetch;
    const out = await postInjection('mid-turn', { owner: 'su-test', toolCalls: [{ tool: 'Edit', interfaceEdits: [edit, edit] }] },
      { env, fetchImpl: failure === 'no-fetch' ? null as any : fetchImpl });
    expect(out?.text).toContain('signature target');
    expect(out?.text.match(/lib\/target.ts: signature/g)).toHaveLength(1);
    expect(out?.text.length).toBeLessThanOrEqual(1500);
  });
  it('does not repeat a delivered interface note or exceed the code intelligence budget', async () => {
    const b = { owner: 'su-test', toolCalls: [{ tool: 'Edit', interfaceEdits: [edit] }] };
    const text = '## Code intelligence (interface)\nlib/target.ts: signature target';
    expect((await postInjection('mid-turn', b, { env, fetchImpl: (async () => json(text)) as typeof fetch }))?.text).toBe(text);
    const full = '## Code intelligence (grep)\n' + 'x'.repeat(1450);
    expect((await postInjection('mid-turn', b, { env, fetchImpl: (async () => json(full)) as typeof fetch }))?.text.length ?? 0).toBeLessThanOrEqual(1500 - text.length);
  });

  it('persists dedupe across fresh processes; turn-start resets spend and compaction resets subjects', async () => {
    const request = { owner: 'su-test', toolCalls: [{ tool: 'Edit', interfaceEdits: [edit] }] };
    const run = () => execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { postInjection } from ${JSON.stringify(path.join(HERE, '..', 'core.mjs'))};
       const out = await postInjection('mid-turn', ${JSON.stringify(request)}, { env: ${JSON.stringify(env)}, fetchImpl: null });
       process.stdout.write(out?.text || '');`], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(run()).toContain('signature target');
    expect(run()).toBe('');
    await postInjection('turn-start', body, { env, fetchImpl: (async () => json('')) as typeof fetch });
    expect(run()).toBe('');
    await postInjection('compaction', body, { env, fetchImpl: (async () => json('')) as typeof fetch });
    expect(run()).toContain('signature target');
  });

  it('shares the turn budget with previous remote advice and keeps full qualifiers and checks', async () => {
    const remote = '## Code intelligence (grep)\n' + 'x'.repeat(1250);
    const first = await postInjection('mid-turn', body, { env, fetchImpl: (async () => json(remote)) as typeof fetch });
    const next = await postInjection('mid-turn', { owner: body.owner, toolCalls: [{ interfaceEdits: [edit] }] }, { env, fetchImpl: null as any });
    expect(first?.text).toBe(remote);
    expect(next).toBeNull();
    const more = await postInjection('mid-turn', { owner: body.owner, toolCalls: [] }, { env, fetchImpl: (async () => json('memory survives\n' + remote)) as typeof fetch });
    expect(more?.text).toBe('memory survives');
    await postInjection('turn-start', body, { env, fetchImpl: (async () => json('')) as typeof fetch });
    const fresh = await postInjection('mid-turn', { owner: body.owner, toolCalls: [{ interfaceEdits: [edit] }] }, { env, fetchImpl: null as any });
    expect(fresh?.text).toContain(edit.checks[0]);
    expect(fresh?.text).toContain('consumer and test reach unknown.');
  });

  it.each(['corrupt', 'contended'])('preserves ordinary memory when the optional ledger is %s', async failure => {
    const dir = path.join(env.PAPERCUSP_HOME, 'state', 'turn-start-delivery');
    mkdirSync(dir, { recursive: true });
    if (failure === 'corrupt') writeFileSync(path.join(dir, 'su-test.code-intel.json'), '{broken');
    else mkdirSync(path.join(dir, 'su-test.code-intel.json.initial.lock'));
    const out = await postInjection('mid-turn', { owner: body.owner, toolCalls: [{ interfaceEdits: [edit] }] },
      { env, fetchImpl: (async () => json('ordinary memory\n## Code intelligence (grep)\noptional')) as typeof fetch });
    expect(out?.text).toBe('ordinary memory');
  });

  it('contains malformed optional edit metadata without dropping ordinary memory', async () => {
    const out = await postInjection('mid-turn', { owner: body.owner, toolCalls: [{ interfaceEdits: [{ path: edit.path }] }] },
      { env, fetchImpl: (async () => json('ordinary memory\n## Code intelligence (interface)\nlib/target.ts: remote')) as typeof fetch });
    expect(out?.text).toContain('ordinary memory');
    expect(out?.text).toContain('remote');
  });

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

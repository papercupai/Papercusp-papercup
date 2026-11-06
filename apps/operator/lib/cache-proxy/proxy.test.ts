/**
 * proxy.test.ts — the transparent Anthropic cache proxy (P-006).
 *
 * The load-bearing properties: credentials pass through VERBATIM (this is not an account
 * substitution), the body rewrite applies only to cacheable paths, streaming is preserved,
 * and a rewrite never costs a request.
 *
 * Run: npm run test:file -- apps/operator/lib/cache-proxy/proxy.test.ts
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCacheProxy, isCacheableAnthropicPath } from './proxy';
import { CACHE_POLICY_VERSION } from '@papercusp/operator-core/lib/inference-gateway/cache-policy';

const servers: http.Server[] = [];
it('publishes the shared policy version and effective options through the existing local health endpoint', async () => {
  const proxy = track(createCacheProxy({ listenPort: 0, log: () => {} }));
  await listen(proxy);
  const response = await request(port(proxy), { path: '/__cache_proxy_health' });
  const health = JSON.parse(response.body);
  expect(health.cachePolicy).toMatchObject({
    policyVersion: CACHE_POLICY_VERSION,
    enabled: process.env.PAPERCUSP_CACHE_POLICY !== '0',
    toolsBreakpoint: process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT === '1',
    splitBoundary: process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY !== '0',
  });
  expect(proxy.stats.requests).toBe(0);
});
function track<T extends http.Server>(s: T): T {
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(s: http.Server): Promise<void> {
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r()));
}
function port(s: http.Server): number {
  return (s.address() as AddressInfo).port;
}

function request(
  p: number,
  opts: { path?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ?? '';
    const r = http.request(
      { host: '127.0.0.1', port: p, path: opts.path ?? '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

/** An upstream stub that records exactly what the proxy forwarded. */
function upstreamEcho(): { server: http.Server; seen: { headers: http.IncomingHttpHeaders; body: string; path: string }[] } {
  const seen: { headers: http.IncomingHttpHeaders; body: string; path: string }[] = [];
  const server = track(
    http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: b, path: req.url ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    }),
  );
  return { server, seen };
}

describe('cache-proxy — per-tool deferral fires AT THE PROXY BOUNDARY (P-002)', () => {
  // WHY THIS EXISTS, and why the pure-function tests in cache-policy.test.ts are not enough.
  // A live arm-B probe on 2026-09-18 ran a headless psu session through a flag-on proxy and came
  // back 163,508 launch tokens — a number that LOOKS like a large win. But the client transcript
  // records what the CLIENT sent, and the rewrite happens AFTER that, so the transcript showed
  // zero `defer_loading` and zero `tool_search_tool` either way. There was no evidence the
  // mechanism had fired at all, and a token delta with no mechanism proof is a coincidence
  // wearing a result's clothes. These tests are that missing proof, at the real proxy boundary:
  // they assert on the bytes the proxy actually FORWARDED to an upstream stub.
  const bigTool = (name: string) => ({
    name,
    description: 'x'.repeat(12_000),
    input_schema: { type: 'object', properties: {} },
  });
  const smallTool = (name: string) => ({
    name,
    description: 'small',
    input_schema: { type: 'object', properties: {} },
  });

  async function forward(body: unknown, env: Record<string, string | undefined>) {
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      const up = upstreamEcho();
      await listen(up.server);
      const proxy = track(
        createCacheProxy({
          listenPort: 0,
          upstreamHost: '127.0.0.1',
          upstreamPort: port(up.server),
          upstreamInsecure: true,
          log: () => {},
        }),
      );
      await listen(proxy);
      await request(port(proxy), {
        body: JSON.stringify(body),
        headers: { authorization: 'Bearer sk-ant-oat-TEST', 'anthropic-version': '2023-06-01' },
      });
      return JSON.parse(up.seen[0]!.body) as { tools?: Record<string, unknown>[] };
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const realisticBody = () => ({
    model: 'claude-opus-5',
    tools: [
      smallTool('Read'),
      ...Array.from({ length: 6 }, (_, i) => bigTool(`mcp__papercusp-su__tool_${i}`)),
    ],
    system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
    messages: [],
  });

  // D-016 (2026-09-18): the default INVERTED. It was opt-in pending the P-003 live A/B; that A/B
  // ran (D-002: control 169,167 vs 115,273 at the measured 1200 B threshold, −31.9%), so leaving
  // it off was what this repo's flag policy calls unfinished work. `unset` is now the TREATMENT
  // arm and `'0'` is the kill switch — the two assertions below deliberately swapped meaning, so
  // a future silent revert to `=== '1'` turns BOTH of them red rather than quietly re-inerting
  // the fix the way it stayed inert for three epochs.
  it('DEFERS by default when the flag is unset — the arm every session now runs (D-015)', async () => {
    const fwd = await forward(realisticBody(), { PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS: undefined });
    expect(fwd.tools!.filter((t) => t.defer_loading)).toHaveLength(6);
    expect(fwd.tools!.at(-1)).toEqual({
      type: 'tool_search_tool_bm25_20251119',
      name: 'tool_search_tool_bm25',
    });
  });

  it('forwards tools UNTOUCHED only when explicitly killed with =0 (the kill switch)', async () => {
    const fwd = await forward(realisticBody(), { PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS: '0' });
    expect(fwd.tools).toHaveLength(7);
    expect(fwd.tools!.some((t) => t.defer_loading)).toBe(false);
    expect(fwd.tools!.some((t) => String(t.type ?? '').startsWith('tool_search_tool_'))).toBe(false);
  });

  it('DOES defer and inject once the flag is set — the A/B arm, proven on forwarded bytes', async () => {
    const fwd = await forward(realisticBody(), { PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS: '1' });

    const deferred = fwd.tools!.filter((t) => t.defer_loading);
    expect(deferred).toHaveLength(6);
    expect(fwd.tools!.at(-1)).toEqual({
      type: 'tool_search_tool_bm25_20251119',
      name: 'tool_search_tool_bm25',
    });
    // Same three invariants, asserted on what actually went out on the wire.
    for (const t of fwd.tools!) {
      expect(Boolean(t.defer_loading) && Boolean(t.cache_control), `illegal pair on ${t.name}`).toBe(false);
    }
    expect(fwd.tools!.some((t) => !t.defer_loading)).toBe(true);
    expect(fwd.tools!.find((t) => String(t.type ?? '').startsWith('tool_search_tool_'))!.defer_loading).toBeUndefined();
  });

  it('P-009(d): the proxy DELEGATES the flag read to cache-policy rather than re-implementing it', async () => {
    // D-017. gateway.ts and this file are SEPARATE PROCESSES reading the SAME env var; while each
    // re-implemented the read inline, editing one polarity split the fleet into fixed and unfixed
    // halves with nothing to catch it. Both now call `deferLargeToolsEnabled` from cache-policy,
    // so they cannot disagree by construction. The cross-plane guard lives in cache-policy.test.ts
    // ('neither forward point re-implements the env read inline'); this is the proxy-side half —
    // it fails here, in the proxy's OWN suite, if this file reintroduces an inline read.
    const src = readFileSync(new URL('./proxy.ts', import.meta.url), 'utf8');

    // POSITIVE CONTROL first: prove the instrument can see the file, so an absence claim below
    // cannot come from an empty/moved read — the false-negative shape this repo keeps hitting.
    expect(src.length, 'proxy.ts unreadable/empty — broken instrument, not a clean result').toBeGreaterThan(1_000);
    expect(src).toContain('deferLargeToolsEnabled');

    // Comments may NAME the flag (the kill-switch docs do); only a process.env READ is drift.
    const inlineReads = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /process\.env\.PAPERCUSP_GATEWAY_DEFER_/.test(l) && !l.startsWith('//') && !l.startsWith('*'));
    expect(inlineReads, `proxy.ts re-implemented the flag read inline:\n${inlineReads.join('\n')}`).toEqual([]);
  });

  it('the flag is the ONLY difference — same input, two arms, measurably different bytes', async () => {
    // The calibration this whole file's arm-B lesson turned on: show that the control arm and
    // the treatment arm differ, and differ ONLY because of the flag.
    // D-015: the control arm is now '0' (the kill switch). Using `undefined` here would compare
    // ON against ON and pass vacuously — which is exactly the arm-B near-miss D-002 Ruling 5
    // records, a coincidence in a result's clothing.
    const off = await forward(realisticBody(), { PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS: '0' });
    const on = await forward(realisticBody(), { PAPERCUSP_GATEWAY_DEFER_LARGE_TOOLS: '1' });
    expect(JSON.stringify(off)).not.toBe(JSON.stringify(on));
    expect(on.tools!.filter((t) => t.defer_loading).length).toBeGreaterThan(
      off.tools!.filter((t) => t.defer_loading).length,
    );
  });
});

describe('cache-proxy — TSX service entrypoint', () => {
  it('starts the real service entry across the CommonJS/ESM boundary', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PAPERCUSP_CACHE_PROXY_PORT: '0',
      PAPERCUSP_CACHE_PROXY_HOST: '127.0.0.1',
    };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--import', 'tsx', 'bin/cache-proxy.ts'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = createTextCollector(child.stdout);
    output.attach(child.stderr);
    const closed = once(child, 'close');
    try {
      await vi.waitFor(() => {
        expect(child.exitCode, output.peek()).toBeNull();
        expect(output.peek()).toContain('[cache-proxy] listening on http://127.0.0.1:0');
      }, { timeout: 10_000 });
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  }, 15_000);
});

describe('cache-proxy — credential passthrough (D-005: NOT an account substitution)', () => {
  it('forwards Authorization, anthropic-version and anthropic-beta VERBATIM', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);

    await request(port(proxy), {
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
      headers: {
        authorization: 'Bearer sk-ant-oat-ORIGINAL',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    expect(up.seen[0].headers.authorization).toBe('Bearer sk-ant-oat-ORIGINAL');
    expect(up.seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(up.seen[0].headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('rewrites the host header to the upstream (TLS/vhost correctness)', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    await request(port(proxy), { body: '{}' });
    expect(up.seen[0].headers.host).toBe('127.0.0.1');
  });
});

describe('cache-proxy — body policy', () => {
  it('applies the ttl rewrite on /v1/messages, and by DEFAULT leaves tools alone', async () => {
    // Default posture after the 2026-07-19 A/B: ttl upgrade yes, tools breakpoint no
    // (measured no-op; see cache-policy.ts header).
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);

    await request(port(proxy), {
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        tools: [{ name: 'a' }, { name: 'b' }],
        system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
        messages: [],
      }),
    });

    const fwd = JSON.parse(up.seen[0].body);
    expect(fwd.system[0].cache_control.ttl).toBe('1h');
    expect(fwd.tools[1].cache_control).toBeUndefined();
    expect(Number(up.seen[0].headers['content-length'])).toBe(Buffer.byteLength(up.seen[0].body));
  });

  it('splits the system block at the boundary sentinel and never forwards the sentinel (P-004)', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);

    const SENT = '<!--PSU_CACHE_BOUNDARY-->';
    await request(port(proxy), {
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        system: [{ type: 'text', text: `${'stable playbook '.repeat(30)}${SENT}per-session launch context` }],
        messages: [],
      }),
    });

    const fwd = JSON.parse(up.seen[0].body);
    expect(up.seen[0].body).not.toContain(SENT); // sentinel dropped — never reaches Anthropic
    expect(fwd.system).toHaveLength(2);
    expect(fwd.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' }); // stable half cached
    expect(fwd.system[1].text).toBe('per-session launch context');
    // content preserved: halves concat to the original minus the sentinel
    expect(fwd.system.map((b: any) => b.text).join('')).toBe(`${'stable playbook '.repeat(30)}per-session launch context`);
  });

  it('kill-switch (PAPERCUSP_CACHE_SPLIT_BOUNDARY=0) forwards an unsplit body (sentinel stays as inert comment)', async () => {
    const prev = process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY;
    process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY = '0';
    try {
      const up = upstreamEcho();
      await listen(up.server);
      const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
      await listen(proxy);
      await request(port(proxy), {
        body: JSON.stringify({ model: 'claude-opus-4-8', system: [{ type: 'text', text: `body<!--PSU_CACHE_BOUNDARY-->tail` }], messages: [] }),
      });
      expect(JSON.parse(up.seen[0].body).system).toHaveLength(1); // not split
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY;
      else process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY = prev;
    }
  });

  it('injects the tools breakpoint when explicitly opted in', async () => {
    const prev = process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT;
    process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT = '1';
    try {
      const up = upstreamEcho();
      await listen(up.server);
      const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
      await listen(proxy);
      await request(port(proxy), {
        body: JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 'a' }, { name: 'b' }], messages: [] }),
      });
      expect(JSON.parse(up.seen[0].body).tools[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT;
      else process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT = prev;
    }
  });

  it('NEVER forwards defer_loading + cache_control on one tool (live 400 regression)', async () => {
    // The exact fleet shape that broke a session on 2026-07-19: ENABLE_TOOL_SEARCH=true makes
    // Claude Code defer the whole MCP catalog, and the API rejects any tool carrying both
    // defer_loading and cache_control. Asserted at the PROXY boundary (not just the pure
    // module) because this is the surface that actually reaches Anthropic.
    // Exercised with the injection FORCED ON — the default is off, but the guarantee that
    // matters is: even when someone opts in, the illegal pair can never reach Anthropic.
    const prev = process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT;
    process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT = '1';
    try {
      const up = upstreamEcho();
      await listen(up.server);
      const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
      await listen(proxy);

      await request(port(proxy), {
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          tools: [
            { name: 'tool_search_tool_bm25' },
            { name: 'mcp__papercusp-su__work_items_get', defer_loading: true },
            { name: 'mcp__papercusp-su__coord_orient', defer_loading: true },
          ],
          messages: [],
        }),
      });

      const fwd = JSON.parse(up.seen[0].body);
      for (const t of fwd.tools) {
        expect(Boolean(t.defer_loading) && Boolean(t.cache_control), `illegal pair on ${t.name}`).toBe(false);
      }
      expect(fwd.tools[0].cache_control).toBeDefined(); // anchored on the only legal tool
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT;
      else process.env.PAPERCUSP_CACHE_TOOLS_BREAKPOINT = prev;
    }
  });

  it('leaves non-cacheable paths untouched (count_tokens, batches, models)', async () => {
    expect(isCacheableAnthropicPath('/v1/messages')).toBe(true);
    expect(isCacheableAnthropicPath('/v1/messages?beta=true')).toBe(true);
    expect(isCacheableAnthropicPath('/v1/messages/count_tokens')).toBe(false);
    expect(isCacheableAnthropicPath('/v1/messages/batches')).toBe(false);
    expect(isCacheableAnthropicPath('/v1/models')).toBe(false);

    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const original = JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 'a' }] });
    await request(port(proxy), { path: '/v1/messages/count_tokens', body: original });
    expect(up.seen[0].body).toBe(original); // byte-identical
  });

  it('kill-switch (PAPERCUSP_CACHE_POLICY=0) forwards the body byte-identically', async () => {
    const prev = process.env.PAPERCUSP_CACHE_POLICY;
    process.env.PAPERCUSP_CACHE_POLICY = '0';
    try {
      const up = upstreamEcho();
      await listen(up.server);
      const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
      await listen(proxy);
      const original = JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 'a' }] });
      await request(port(proxy), { body: original });
      expect(up.seen[0].body).toBe(original);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CACHE_POLICY;
      else process.env.PAPERCUSP_CACHE_POLICY = prev;
    }
  });

  it('a malformed body still forwards (a rewrite never costs a request)', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { body: '{not-json' });
    expect(r.status).toBe(200);
    expect(up.seen[0].body).toBe('{not-json');
  });
});

describe('cache-proxy — transport behavior', () => {
  it('streams an SSE response through chunk-for-chunk', async () => {
    const up = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"a":1}\n\n');
        setTimeout(() => {
          res.write('event: message_stop\ndata: {}\n\n');
          res.end();
        }, 10);
      }),
    );
    await listen(up);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { body: JSON.stringify({ model: 'claude-opus-4-8', stream: true }) });
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.body).toContain('message_start');
    expect(r.body).toContain('message_stop');
  });

  it('surfaces an unreachable upstream as 502 (client retries own it)', async () => {
    const dead = track(http.createServer(() => {}));
    await listen(dead);
    const deadPort = port(dead);
    await new Promise<void>((r) => dead.close(() => r()));

    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: deadPort, upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { body: '{}' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error.type).toBe('api_error');
  });

  it('answers the health endpoint locally without touching upstream', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { path: '/__cache_proxy_health' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
    expect(up.seen.length).toBe(0);
  });
});

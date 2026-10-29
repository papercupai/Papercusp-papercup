import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverOperatorUrl, resolveOperatorBase, fetchResilient, rebaseUrl } from '../scripts/operator-discovery.mjs';

/** A deterministic fake clock: sleep() advances virtual time so budget/backoff
 *  logic is exercised without real timers. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
const connErr = () => Object.assign(new TypeError('fetch failed'), { name: 'TypeError' });
const timeoutErr = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const okResp = (): Response => ({ ok: true, status: 200 }) as Response;

// The sidecar CLIs (onboard, tutorial-runner, ptool) must reach the PACKAGED
// desktop operator, which listens on a per-boot dynamic port recorded in
// ~/.papercusp/operator.json — a bare :3070 default only works on the dev box.
// Owner hit the regression live on the seeded mac install (WI-2903 thread):
// "can't reach papercusp server at 127.0.0.1:3070".

const tmpHomes: string[] = [];
function homeWithOperatorJson(content: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'opdisc-'));
  tmpHomes.push(home);
  if (content !== null) {
    mkdirSync(join(home, '.papercusp'), { recursive: true });
    writeFileSync(join(home, '.papercusp', 'operator.json'), content);
  }
  return home;
}

afterEach(() => {
  for (const h of tmpHomes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('discoverOperatorUrl', () => {
  it('returns httpUrl from operator.json (the packaged-desktop path)', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114', port: 20114 }));
    expect(discoverOperatorUrl({ home, env: {} })).toBe('http://127.0.0.1:20114');
  });

  it('falls back to port when httpUrl is absent', () => {
    const home = homeWithOperatorJson(JSON.stringify({ port: 20114 }));
    expect(discoverOperatorUrl({ home, env: {} })).toBe('http://127.0.0.1:20114');
  });

  it('returns null when operator.json is missing (the dev box)', () => {
    const home = homeWithOperatorJson(null);
    expect(discoverOperatorUrl({ home, env: {} })).toBeNull();
  });

  it('returns null on unparseable operator.json', () => {
    const home = homeWithOperatorJson('not json');
    expect(discoverOperatorUrl({ home, env: {} })).toBeNull();
  });

  it('uses the same explicit state root as the Server and follows its advertised port', () => {
    const home = homeWithOperatorJson(JSON.stringify({ port: 20114 }));
    const stateRoot = join(home, 'isolated-server');
    mkdirSync(stateRoot);
    const env = { PAPERCUSP_HOME: stateRoot };
    writeFileSync(join(stateRoot, 'operator.json'), JSON.stringify({ port: 29141 }));
    expect(discoverOperatorUrl({ home, env })).toBe('http://127.0.0.1:29141');
    expect(resolveOperatorBase({}, env, { home })).toBe('http://127.0.0.1:29141');

    writeFileSync(join(stateRoot, 'operator.json'), JSON.stringify({ httpUrl: 'http://127.0.0.1:29142', port: 29142 }));
    expect(discoverOperatorUrl({ home, env })).toBe('http://127.0.0.1:29142');
    expect(resolveOperatorBase({}, env, { home })).toBe('http://127.0.0.1:29142');
  });

  it.each([null, 'not json'])('never adopts another instance when explicit-root discovery is %s', (content) => {
    const home = homeWithOperatorJson(JSON.stringify({ port: 20114 }));
    const stateRoot = join(home, 'isolated-server');
    mkdirSync(stateRoot);
    if (content !== null) writeFileSync(join(stateRoot, 'operator.json'), content);
    const env = { PAPERCUSP_HOME: stateRoot };
    expect(discoverOperatorUrl({ home, env })).toBeNull();
    expect(() => resolveOperatorBase({}, env, { home })).toThrow(/configured Papercusp home/i);
    expect(resolveOperatorBase({ operatorUrl: 'https://chosen.example.com' }, env, { home }))
      .toBe('https://chosen.example.com');
    expect(resolveOperatorBase({}, { ...env, PAPERCUSP_OPERATOR_URL: 'https://pinned.example.com' }, { home }))
      .toBe('https://pinned.example.com');
    expect(resolveOperatorBase({}, { ...env, PAPERCUSP_HONO_PORT: '29143' }, { home, preferSelfPort: true }))
      .toBe('http://127.0.0.1:29143');
  });

  it('uses the existing default-home rule for an empty isolation pin', () => {
    const home = homeWithOperatorJson(JSON.stringify({ port: 20114 }));
    expect(discoverOperatorUrl({ home, env: { PAPERCUSP_HOME: '  ' } })).toBe('http://127.0.0.1:20114');
  });
});

describe('resolveOperatorBase precedence', () => {
  it('explicit --operator-url arg wins over everything', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(
      resolveOperatorBase({ operatorUrl: 'http://x:1/' }, { PAPERCUSP_OPERATOR_URL: 'http://y:2' }, { home }),
    ).toBe('http://x:1');
  });

  it('env override beats operator.json discovery', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(resolveOperatorBase({}, { PAPERCUSP_OPERATOR_URL: 'http://y:2/' }, { home })).toBe('http://y:2');
  });

  it('operator.json discovery beats the :3070 dev fallback', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114' }));
    expect(resolveOperatorBase({}, {}, { home })).toBe('http://127.0.0.1:20114');
  });

  it('lands on :3070 only when nothing else resolves (dev box)', () => {
    const home = homeWithOperatorJson(null);
    expect(resolveOperatorBase({}, {}, { home })).toBe('http://127.0.0.1:3070');
  });
});

describe('resolveOperatorBase self-host precedence', () => {
  it('keeps a staging host on its own port instead of an inherited green URL', () => {
    const home = homeWithOperatorJson(null);
    expect(resolveOperatorBase({}, {
      PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
    }, { home, preferSelfPort: true })).toBe('http://127.0.0.1:3170');
  });

  it('uses the proxy when it explicitly fronts the self host', () => {
    const home = homeWithOperatorJson(null);
    expect(resolveOperatorBase({}, {
      PAPERCUSP_HONO_PORT: '3070',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
      PAPERCUSP_MCP_PROXY_BASE: 'http://127.0.0.1:9071',
      PAPERCUSP_MCP_PROXY_TARGET_PORT: '3070',
    }, { home, preferSelfPort: true })).toBe('http://127.0.0.1:9071');
  });

  it('ignores an invalid self port and falls back to the normal env route', () => {
    const home = homeWithOperatorJson(null);
    expect(resolveOperatorBase({}, {
      PAPERCUSP_HONO_PORT: '0',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070/api/mcp',
    }, { home, preferSelfPort: true })).toBe('http://127.0.0.1:3070');
  });
});

// The caller appends its own `/api/mcp`, but `PAPERCUSP_OPERATOR_URL` is OVERLOADED:
// `apps/operator/.env.local` exports it WITH the endpoint path for MCP-config
// consumers, and every process sourcing that file inherits the suffixed form. Without
// stripping, ptool posted to `/api/mcp/api/mcp` and the host answered
// `404 {"error":"not_found"}` — surfacing as "could not reach the operator" against a
// perfectly healthy host. That silently no-op'd the bg-host project-history-refresh
// routine on every fire (EI-20475585438015488); same overloaded-variable bug class as
// WI-6154 in operator-core.
describe('resolveOperatorBase strips an /api/mcp endpoint suffix (EI-20475585438015488)', () => {
  it('strips the suffix from the env override — the bg-host inherited form', () => {
    const home = homeWithOperatorJson(null);
    expect(
      resolveOperatorBase({}, { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070/api/mcp' }, { home }),
    ).toBe('http://localhost:3070');
  });

  it('strips a trailing-slash variant of the suffix', () => {
    const home = homeWithOperatorJson(null);
    expect(
      resolveOperatorBase({}, { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070/api/mcp/' }, { home }),
    ).toBe('http://localhost:3070');
  });

  it('strips the suffix from an explicit arg and from operator.json discovery', () => {
    const home = homeWithOperatorJson(JSON.stringify({ httpUrl: 'http://127.0.0.1:20114/api/mcp' }));
    expect(resolveOperatorBase({ operatorUrl: 'http://x:1/api/mcp' }, {}, { home })).toBe('http://x:1');
    expect(resolveOperatorBase({}, {}, { home })).toBe('http://127.0.0.1:20114');
  });

  it('leaves a plain base origin untouched, and does not strip a mid-path /api/mcp', () => {
    const home = homeWithOperatorJson(null);
    expect(resolveOperatorBase({}, { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070' }, { home })).toBe(
      'http://localhost:3070',
    );
    // Only a TRAILING endpoint suffix is an overloaded-variable artifact; a proxy
    // mounted under that path is a real base and must survive.
    expect(
      resolveOperatorBase({}, { PAPERCUSP_OPERATOR_URL: 'http://localhost:9071/api/mcp/proxy' }, { home }),
    ).toBe('http://localhost:9071/api/mcp/proxy');
  });
});

// WI-3141: the onboarding/tutorial launchers must ride THROUGH the operator's
// first-boot / recycle window (owner 2026-07-05: "3 attempts before the tutorial
// showed up") instead of hard-failing on the first connection-refused.
describe('fetchResilient', () => {
  it('returns immediately on success (no retry, no sleep)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    let slept = 0;
    const r = await fetchResilient('http://x', {}, {
      fetchImpl: async () => { calls++; return okResp(); },
      now,
      sleep: async (ms: number) => { slept++; await sleep(ms); },
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });

  it('rides through N connection failures then succeeds (the cold-start case)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    const onRetry = vi.fn();
    const r = await fetchResilient('http://x', {}, {
      fetchImpl: async () => { calls++; if (calls <= 3) throw connErr(); return okResp(); },
      now,
      sleep,
      onRetry,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(4); // 3 refused + 1 success
    expect(onRetry).toHaveBeenCalledTimes(1); // announced exactly once
  });

  it('throws once the connect budget is exhausted (genuine outage)', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    await expect(
      fetchResilient('http://x', {}, {
        fetchImpl: async () => { calls++; throw connErr(); },
        now,
        sleep,
        connectBudgetMs: 5_000, // 2s backoff each → ~3 attempts then budget spent
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBeGreaterThan(1); // it retried before giving up
  });

  it('retries a timeout only timeoutRetries times, then throws', async () => {
    const { now, sleep } = fakeClock();
    let calls = 0;
    await expect(
      fetchResilient('http://x', {}, {
        fetchImpl: async () => { calls++; throw timeoutErr(); },
        now,
        sleep,
        timeoutRetries: 2,
      }),
    ).rejects.toThrow(/timed out/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('does NOT retry when the caller-supplied signal aborted (owns the lifetime)', async () => {
    const { now, sleep } = fakeClock();
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(
      fetchResilient('http://x', { signal: ac.signal }, {
        fetchImpl: async () => { calls++; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
        now,
        sleep,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1); // no retry — the caller's abort is final
  });
});

describe('rebaseUrl (WI-3283)', () => {
  it('swaps the origin and keeps path + query', () => {
    expect(rebaseUrl('http://127.0.0.1:1111/api/x?a=1', 'http://127.0.0.1:2222')).toBe(
      'http://127.0.0.1:2222/api/x?a=1',
    );
  });

  it('returns null when the origin is unchanged (same-port mid-boot window)', () => {
    expect(rebaseUrl('http://127.0.0.1:1111/api/x', 'http://127.0.0.1:1111')).toBeNull();
    expect(rebaseUrl('http://127.0.0.1:1111/api/x', 'http://127.0.0.1:1111/')).toBeNull();
  });

  it('returns null on an unparseable base instead of throwing', () => {
    expect(rebaseUrl('http://127.0.0.1:1111/api/x', 'not a url')).toBeNull();
    expect(rebaseUrl('not a url', 'http://127.0.0.1:2222')).toBeNull();
  });
});

describe('fetchResilient rediscovery (WI-3283: the operator moved ports mid-run)', () => {
  it('follows the move: a refused pinned port + fresh discovery → retries the NEW base', async () => {
    const { now, sleep } = fakeClock();
    const urls: string[] = [];
    const onRebase = vi.fn();
    const r = await fetchResilient('http://127.0.0.1:1111/api/x?a=1', {}, {
      fetchImpl: async (url: string) => {
        urls.push(String(url));
        if (String(url).includes(':1111')) throw connErr(); // the stale spawn-time pin
        return okResp(); // the restarted operator's new port
      },
      now,
      sleep,
      rediscover: () => 'http://127.0.0.1:2222',
      onRebase,
    });
    expect(r.ok).toBe(true);
    expect(urls).toEqual(['http://127.0.0.1:1111/api/x?a=1', 'http://127.0.0.1:2222/api/x?a=1']);
    expect(onRebase).toHaveBeenCalledWith('http://127.0.0.1:2222');
  });

  it('same-origin discovery = plain retry (the sticky-port mid-boot window)', async () => {
    const { now, sleep } = fakeClock();
    const urls: string[] = [];
    const onRebase = vi.fn();
    let calls = 0;
    const r = await fetchResilient('http://127.0.0.1:1111/api/x', {}, {
      fetchImpl: async (url: string) => {
        urls.push(String(url));
        calls++;
        if (calls <= 2) throw connErr();
        return okResp();
      },
      now,
      sleep,
      rediscover: () => 'http://127.0.0.1:1111',
      onRebase,
    });
    expect(r.ok).toBe(true);
    expect(new Set(urls).size).toBe(1); // never rebased
    expect(onRebase).not.toHaveBeenCalled();
  });

  it('null discovery (no operator.json — dev box) and a THROWING rediscover both stay plain retries', async () => {
    const { now, sleep } = fakeClock();
    for (const rediscover of [() => null, () => { throw new Error('unreadable'); }]) {
      let calls = 0;
      const r = await fetchResilient('http://127.0.0.1:1111/api/x', {}, {
        fetchImpl: async () => {
          calls++;
          if (calls <= 1) throw connErr();
          return okResp();
        },
        now,
        sleep,
        rediscover,
      });
      expect(r.ok).toBe(true);
      expect(calls).toBe(2);
    }
  });

  it('a TIMEOUT never rediscovers (reachable-but-slow is not a moved port)', async () => {
    const { now, sleep } = fakeClock();
    const rediscover = vi.fn(() => 'http://127.0.0.1:2222');
    await expect(
      fetchResilient('http://127.0.0.1:1111/api/x', {}, {
        fetchImpl: async () => { throw timeoutErr(); },
        now,
        sleep,
        timeoutRetries: 1,
        rediscover,
      }),
    ).rejects.toThrow(/timed out/);
    expect(rediscover).not.toHaveBeenCalled();
  });

  it('keeps following across a SECOND move (restart during the retry window)', async () => {
    const { now, sleep } = fakeClock();
    const urls: string[] = [];
    let discovered = 'http://127.0.0.1:2222';
    const r = await fetchResilient('http://127.0.0.1:1111/api/x', {}, {
      fetchImpl: async (url: string) => {
        urls.push(String(url));
        if (String(url).includes(':3333')) return okResp();
        discovered = 'http://127.0.0.1:3333'; // it moved again while we retried
        throw connErr();
      },
      now,
      sleep,
      rediscover: () => discovered,
    });
    expect(r.ok).toBe(true);
    expect(urls.at(-1)).toBe('http://127.0.0.1:3333/api/x');
  });
});

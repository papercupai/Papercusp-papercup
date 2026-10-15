/**
 * Included-first account selection; metered accounts as overflow (anthropic-credits-gateway-2026-09-30
 * P-008, D-003). Drives the REAL gateway (createInferenceGateway over a failover pool) against a mock
 * upstream that answers per credential, and reads which account actually served each request from the
 * `x-papercusp-routed-account` response header — no real spend.
 *
 *   R-24  an included-allowance account is picked over an idle api-key account;
 *   R-25  an api-key account serves once every included-allowance account is parked;
 *   R-26  an account in usage-credits overage ranks behind an included account, yet still serves
 *         (from usage credits) once the included account is walled;
 *   R-27  an account with metered policy `never` is unselectable while in usage credits;
 *   R-28  a request pinned to an api-key account is served by it while included accounts are free;
 *   R-35  a metered:never account parked on usage-credit overage rejoins once its named reset passes,
 *         and with no named reset both the park and the overage reading end at the bounded default
 *         (D-007, D-008 E1) — never held indefinitely;
 *   R-36  a credit-walled account shows its wall cause in /stats and is not auto-selected while the
 *         wall holds (D-004, D-008 E4).
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import {
  createInferenceGateway,
  ACCOUNT_HEADER,
  ACCOUNT_PIN_HEADER,
  ROUTED_ACCOUNT_HEADER,
  type GatewayStats,
} from './gateway';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { createFailoverPool, FIVE_HOURS_MS } from './account-failover';
import { CREDIT_WALL_DEFAULT_PAUSE_MS } from './anthropic-billing';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

interface Reply {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

interface Upstream {
  base: string;
  /** Credentials in the order upstream saw them (Bearer token or x-api-key value). */
  seen: string[];
  close: () => Promise<void>;
}

const resetIn1h = (): string => String(Math.floor(Date.now() / 1000) + 3600);

/** Inside the subscription allowance. */
const INCLUDED = (): Reply => ({
  status: 200,
  headers: { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-reset': resetIn1h() },
});
/** A served response carrying no billing headers at all (degraded upstream, or a hop that stripped them). */
const NO_BILLING_HEADERS = (): Reply => ({ status: 200, headers: {} });
/** Past the allowance, served from usage credits (status rejected, overage allowed + in use). */
const OVERAGE = (): Reply => ({
  status: 200,
  headers: {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-overage-status': 'allowed',
    'anthropic-ratelimit-unified-overage-in-use': 'true',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': resetIn1h(),
  },
});
/** Allowance exhausted and no overage — the account cannot serve until its reset. */
const WALLED = (): Reply => ({
  status: 429,
  headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': resetIn1h() },
  body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }),
});
/** An API-key account: no unified-limiter headers at all. */
const API = (): Reply => ({ status: 200, headers: {} });
/** Usage-credits overage whose response names the allowance reset at `resetSec` (epoch seconds). */
const overageUntil = (resetSec: number): Reply => ({
  status: 200,
  headers: { ...OVERAGE().headers, 'anthropic-ratelimit-unified-reset': String(resetSec) },
});
/** Usage-credits overage whose response names NO reset at all. */
const OVERAGE_NO_RESET = (): Reply => {
  const { 'anthropic-ratelimit-unified-reset': _named, ...headers } = OVERAGE().headers;
  return { status: 200, headers };
};
/** An empty Console balance: 402 billing_error, a credit wall (D-004). */
const NO_CREDIT = (): Reply => ({
  status: 402,
  headers: {},
  body: JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low.' } }),
});

function credentialOf(req: http.IncomingMessage): string {
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key) return key;
  return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}

async function startUpstream(replyFor: (cred: string) => Reply): Promise<Upstream> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const cred = credentialOf(req);
      seen.push(cred);
      const r = replyFor(cred);
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(r.body ?? '{"id":"msg_1","type":"message","content":[]}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

const oauth = (id: string, tok: string, extra: Partial<ActiveAccount> = {}): ActiveAccount => ({
  accountId: id,
  token: async () => tok,
  invalidateToken: () => {},
  ...extra,
});
const apiKey = (id: string, key: string, extra: Partial<ActiveAccount> = {}): ActiveAccount => ({
  accountId: id,
  token: async () => key,
  invalidateToken: () => {},
  authMode: 'api-key',
  ...extra,
});

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: Upstream | undefined;
let pool: AccountPool | undefined;

afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  gw = undefined;
  upstream = undefined;
  pool = undefined;
});

type GatewayLog = NonNullable<Parameters<typeof createInferenceGateway>[0]['log']>;

async function boot(
  accounts: ActiveAccount[],
  replyFor: (cred: string) => Reply,
  log?: GatewayLog,
): Promise<number> {
  upstream = await startUpstream(replyFor);
  // Per-account governors live in a PROCESS-GLOBAL registry (governorForBackend), so a wall
  // recorded on 'incA' in one test would otherwise pause 'incA' in the next. Start clean.
  resetGovernorRegistry();
  pool = createFailoverPool(accounts);
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 200, ...(log ? { log } : {}) });
  return gw.listen(0);
}

async function billing(port: number): Promise<NonNullable<GatewayStats['billing']>> {
  const stats = (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as GatewayStats;
  expect(stats.billing, '/stats carries the billing block').toBeDefined();
  return stats.billing!;
}

const hitsOf = (cred: string): number => upstream!.seen.filter((c) => c === cred).length;

async function fire(port: number, headers: Record<string, string> = {}): Promise<{ status: number; routed: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-opus-4-99', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  return { status: res.status, routed: res.headers.get(ROUTED_ACCOUNT_HEADER) };
}

/** Fire until a 200 (a walled first attempt may surface as a 429 before the park takes effect). */
async function fireUntilServed(port: number, max = 3): Promise<{ status: number; routed: string | null }> {
  let last = await fire(port);
  for (let i = 1; i < max && last.status !== 200; i++) last = await fire(port);
  return last;
}

describe('P-005 R-5 — an API key never leaves the gateway in a log line or an error body', () => {
  // Built at runtime, low-entropy, so no key-shaped literal sits in the tree. scrubSecrets keeps the
  // 12-char `sk-ant-api03` prefix for identification; everything after it is the part that must not leak.
  const KEY_TAIL = 'fixture'.repeat(4);
  const KEY = ['sk', 'ant', 'api03', KEY_TAIL].join('-');

  for (const upstreamFailure of [
    { name: '401 authentication_error', status: 401, type: 'authentication_error' },
    { name: '500 api_error', status: 500, type: 'api_error' },
  ]) {
    it(`R-5: an upstream ${upstreamFailure.name} that echoes the key reaches neither the caller nor the logs`, async () => {
      const lines: string[] = [];
      const port = await boot(
        [apiKey('console', KEY)],
        () => ({
          status: upstreamFailure.status,
          headers: {},
          body: JSON.stringify({ type: 'error', error: { type: upstreamFailure.type, message: `rejected credential ${KEY}` } }),
        }),
        (level, msg) => lines.push(`${level} ${msg}`),
      );
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-99', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = await res.text();
      expect(res.status, 'the failure reaches the caller as an error').toBeGreaterThanOrEqual(400);
      expect(upstream!.seen, 'the request really went upstream on the api-key account').toContain(KEY);
      expect(body).not.toContain(KEY_TAIL);
      for (const line of lines) expect(line).not.toContain(KEY_TAIL);
    });
  }
});

describe('metered selection — included allowance first, metered as overflow (P-008)', () => {
  it('R-24: auto selection picks an included-allowance account over an idle api-key account', async () => {
    // The api-key account is FIRST in pool order, so pool order or a tie-break round-robin would pick it.
    const port = await boot([apiKey('keyB', 'sk-keyB'), oauth('incA', 'tokA')], (c) => (c === 'tokA' ? INCLUDED() : API()));
    const routed: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      const r = await fire(port);
      expect(r.status).toBe(200);
      routed.push(r.routed);
    }
    expect(routed).toEqual(['incA', 'incA', 'incA', 'incA']);
    expect(upstream!.seen).not.toContain('sk-keyB');
  });

  it('R-25: auto selection serves from an api-key account when every included-allowance account is parked', async () => {
    const port = await boot([oauth('incA', 'tokA'), apiKey('keyB', 'sk-keyB')], (c) => (c === 'tokA' ? WALLED() : API()));
    const first = await fireUntilServed(port);
    expect(first).toEqual({ status: 200, routed: 'keyB' });
    // incA is parked now: the next request goes straight to the api-key account.
    const next = await fire(port);
    expect(next).toEqual({ status: 200, routed: 'keyB' });
    expect(upstream!.seen).toContain('tokA');
  });

  it('R-26: an account in usage-credits overage ranks behind an included account, and serves once it is walled', async () => {
    let incAWalled = false;
    const port = await boot([oauth('incB', 'tokB'), oauth('incA', 'tokA')], (c) =>
      c === 'tokB' ? OVERAGE() : incAWalled ? WALLED() : INCLUDED(),
    );
    // Observe incB serving from usage credits (a pinned request lands on it).
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    // Ranked behind the included account: unpinned traffic goes to incA.
    for (let i = 0; i < 3; i++) expect(await fire(port)).toEqual({ status: 200, routed: 'incA' });
    // Overflow: with incA walled, incB keeps serving from usage credits instead of being parked.
    incAWalled = true;
    expect(await fireUntilServed(port)).toEqual({ status: 200, routed: 'incB' });
  });

  it('R-15 (selection): a response with no billing headers never ranks an overage account ahead of an included one', async () => {
    let incBHeaderless = false;
    const port = await boot([oauth('incB', 'tokB'), oauth('incA', 'tokA')], (c) =>
      c === 'tokB' ? (incBHeaderless ? NO_BILLING_HEADERS() : OVERAGE()) : INCLUDED(),
    );
    // Observe incB serving from usage credits.
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    // incB then answers with no billing headers at all: that reading is unknown, never included,
    // so it must not wipe the overage state and promote incB into the included tier (vetting E5).
    incBHeaderless = true;
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    // incB is first in pool order, so a promotion would route unpinned traffic to it.
    for (let i = 0; i < 3; i++) expect(await fire(port)).toEqual({ status: 200, routed: 'incA' });
  });

  it('R-27: an account with metered policy never is unselectable while its billing state is usage-credits', async () => {
    let incAWalled = false;
    const port = await boot([oauth('incA', 'tokA'), oauth('incB', 'tokB', { meteredPolicy: 'never' })], (c) =>
      c === 'tokB' ? OVERAGE() : incAWalled ? WALLED() : INCLUDED(),
    );
    // Observe incB's billing state: its response says usage credits are serving.
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    const incBHits = upstream!.seen.filter((c) => c === 'tokB').length;
    // Every other account walled: incB is still NOT selected — the request is refused instead.
    incAWalled = true;
    for (let i = 0; i < 3; i++) {
      const r = await fire(port);
      expect(r.routed).not.toBe('incB');
      expect(r.status).not.toBe(200);
    }
    expect(upstream!.seen.filter((c) => c === 'tokB').length).toBe(incBHits);
    // Even a HARD pin (which bypasses the pool's parking) is refused before admission, not billed.
    const hard = await fire(port, { [ACCOUNT_HEADER]: 'incB', [ACCOUNT_PIN_HEADER]: 'hard' });
    expect(hard.status).toBe(429);
    expect(upstream!.seen.filter((c) => c === 'tokB').length).toBe(incBHits);
  });

  it('R-28: a request pinned to an api-key account is served by that account while included accounts are free', async () => {
    const port = await boot([oauth('incA', 'tokA'), apiKey('keyB', 'sk-keyB')], (c) => (c === 'tokA' ? INCLUDED() : API()));
    for (let i = 0; i < 3; i++) expect(await fire(port, { [ACCOUNT_HEADER]: 'keyB' })).toEqual({ status: 200, routed: 'keyB' });
    expect(upstream!.seen).toEqual(['sk-keyB', 'sk-keyB', 'sk-keyB']);
    // The included account is free: an unpinned request still prefers it.
    expect(await fire(port)).toEqual({ status: 200, routed: 'incA' });
  });

  it('R-35: a metered:never account parked on usage-credit overage is selectable again once its named reset passes', async () => {
    // The overage response names an allowance reset ~1-2s out; incA is walled throughout, so the
    // only way unpinned traffic is served is incB rejoining rotation.
    const resetSec = Math.floor(Date.now() / 1000) + 2;
    const port = await boot([oauth('incA', 'tokA'), oauth('incB', 'tokB', { meteredPolicy: 'never' })], (c) =>
      c === 'tokB' ? overageUntil(resetSec) : WALLED(),
    );
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    // Parked exactly until the reset the response named — not the bounded default, not forever.
    expect(pool!.parkState?.('incB')?.until).toBe(resetSec * 1000);
    const parkedHits = hitsOf('tokB');
    // Before the reset: unpinned traffic is refused and never billed to incB.
    for (let i = 0; i < 2; i++) {
      const r = await fire(port);
      expect(r.routed).not.toBe('incB');
      expect(r.status).not.toBe(200);
    }
    expect(hitsOf('tokB')).toBe(parkedHits);
    // After the named reset passes, incB is back in rotation and serves.
    await new Promise((r) => setTimeout(r, Math.max(0, resetSec * 1000 + 250 - Date.now())));
    expect(await fireUntilServed(port)).toEqual({ status: 200, routed: 'incB' });
    expect(hitsOf('tokB')).toBeGreaterThan(parkedHits);
  }, 15_000);

  it('R-35: with no named reset, the park and the overage reading both end at the bounded default, never indefinitely', async () => {
    const port = await boot([oauth('incA', 'tokA'), oauth('incB', 'tokB', { meteredPolicy: 'never' })], (c) =>
      c === 'tokB' ? OVERAGE_NO_RESET() : INCLUDED(),
    );
    const t0 = Date.now();
    expect(await fire(port, { [ACCOUNT_HEADER]: 'incB' })).toEqual({ status: 200, routed: 'incB' });
    const t1 = Date.now();
    // The pool park is bounded by the default horizon...
    const park = pool!.parkState?.('incB');
    expect(park, 'incB is parked after reporting overage under metered:never').toBeDefined();
    expect(park!.until).toBeGreaterThanOrEqual(t0 + FIVE_HOURS_MS);
    expect(park!.until).toBeLessThanOrEqual(t1 + FIVE_HOURS_MS);
    // ...and so is the usage-credits reading that would otherwise keep refusing incB after the park
    // ends (selection scores it Infinity and admission refuses it while it reads as metered).
    const b = (await billing(port)).byAccount.incB;
    expect(b.state).toBe('usage-credits');
    expect(b.stateUntil, 'a reset-less overage reading must carry a finite end').toBeDefined();
    expect(b.stateUntil!).toBeGreaterThanOrEqual(t0 + FIVE_HOURS_MS);
    expect(b.stateUntil!).toBeLessThanOrEqual(t1 + FIVE_HOURS_MS);
  });

  it('operator readmit clears the named credit-wall governor across model buckets without releasing another account', async () => {
    let recovered = false;
    const port = await boot([apiKey('keyA', 'sk-keyA'), apiKey('keyB', 'sk-keyB')], (c) =>
      recovered && c === 'sk-keyA' ? API() : NO_CREDIT(),
    );
    const pinA = { [ACCOUNT_HEADER]: 'keyA', [ACCOUNT_PIN_HEADER]: 'hard' };
    const pinB = { [ACCOUNT_HEADER]: 'keyB', [ACCOUNT_PIN_HEADER]: 'hard' };
    // Actual upstream billing failures populate both the governor and the failover pool.
    expect((await fire(port, pinA)).status).not.toBe(200);
    const sonnet = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...pinA },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await sonnet.text();
    expect(sonnet.status).not.toBe(200);
    expect((await fire(port, pinB)).status).not.toBe(200);
    const before = await billing(port);
    expect(before.byAccount.keyA.wall?.cause).toBe('billing-error');
    expect(before.byAccount.keyB.wall?.cause).toBe('billing-error');
    const bHits = hitsOf('sk-keyB');
    recovered = true;
    const readmit = await fetch(`http://127.0.0.1:${port}/admin/readmit?account=keyA`, { method: 'POST' });
    expect(await readmit.json()).toMatchObject({ ok: true, readmitted: ['keyA'], healthyAccounts: 1 });
    expect(await fire(port, pinA)).toEqual({ status: 200, routed: 'keyA' });
    const servedSonnet = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...pinA },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await servedSonnet.text();
    expect(servedSonnet.status).toBe(200);
    expect((await fire(port, pinB)).status).toBe(429);
    expect(hitsOf('sk-keyB')).toBe(bHits);
    const after = await billing(port);
    expect(after.byAccount.keyA.wall).toBeUndefined();
    expect(after.byAccount.keyB.wall).toEqual(before.byAccount.keyB.wall);
  });

  it('R-36: a credit-walled account shows its wall cause in stats and is not auto-selected while the wall holds', async () => {
    const port = await boot([apiKey('keyA', 'sk-keyA'), apiKey('keyB', 'sk-keyB')], (c) =>
      c === 'sk-keyA' ? NO_CREDIT() : API(),
    );
    // Drive traffic until keyA has been tried once (pool order puts it first); its 402 is a wall,
    // so the request fails over and is served by keyB.
    let served = await fireUntilServed(port);
    for (let i = 0; i < 3 && hitsOf('sk-keyA') === 0; i++) served = await fireUntilServed(port);
    expect(hitsOf('sk-keyA'), 'keyA was tried').toBe(1);
    expect(served).toEqual({ status: 200, routed: 'keyB' });
    const at = Date.now();
    const b = await billing(port);
    // The walled account's stats row says WHY it is out of rotation and until when.
    expect(b.byAccount.keyA.wall?.cause).toBe('billing-error');
    expect(b.byAccount.keyA.wall!.until).toBeGreaterThan(at);
    expect(b.byAccount.keyA.wall!.until).toBeLessThanOrEqual(at + CREDIT_WALL_DEFAULT_PAUSE_MS);
    // An account that never walled carries no wall.
    expect(b.byAccount.keyB.wall).toBeUndefined();
    // While the wall holds, auto selection never sends keyA another request.
    for (let i = 0; i < 4; i++) expect(await fire(port)).toEqual({ status: 200, routed: 'keyB' });
    expect(hitsOf('sk-keyA')).toBe(1);
  });
});

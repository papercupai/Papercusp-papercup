/**
 * Tests for the inference-gateway PRIORITY-TIER admission layer (gateway-priority-tiers-2026-06-22).
 *
 * Exercises, through the REAL HTTP gateway, the un-starving guarantees the tier layer adds on top of the
 * flat priority+aging queue:
 *  - a tier-1 (interactive/Queen) request jumps ahead of a saturated tier-3 (bee) backlog,
 *  - the reserved tier-1 floor holds a slot open even under a tier-3 flood,
 *  - tier-aware shedding shrinks the bottom bands first (AIMD storm) and holds tier 1,
 *  - /stats reports per-tier {cap,inFlight,queued} + the pool-wide healthyAccounts,
 *  - flag-OFF (no `priorityTiers` dep) is byte-identical: the priority header is ignored, no /stats field.
 *
 * The tier config is normally resolved + flag-gated in launch.ts; here we pass `priorityTiers` directly
 * (the same shape launch builds) so the gateway behavior is tested hermetically without PostHog.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createInferenceGateway, PRIORITY_HEADER } from './gateway';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';
import { DEFAULT_GATEWAY_PRIORITY_MAP } from '@papercusp/papercusp-shared/agent';

interface Up {
  server: http.Server;
  base: string;
  close: () => Promise<void>;
}
async function startUpstream(reply: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Up> {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => reply(req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}

let up: Up | undefined;
let gw: ReturnType<typeof createInferenceGateway> | undefined;
let port = 0;

afterEach(async () => {
  await gw?.close();
  await up?.close();
  gw = undefined;
  up = undefined;
});

async function boot(
  reply: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  opts: Partial<Parameters<typeof createInferenceGateway>[0]> = {},
) {
  up = await startUpstream(reply);
  const governor = new RateLimitGovernor({ maxConcurrent: 50 });
  gw = createInferenceGateway({
    accountId: 'acct-a',
    upstreamBase: up.base,
    token: async () => 'tok',
    governorFor: () => governor,
    maxQueueWaitMs: 2000,
    ...opts,
    openaiUpstreamBase: opts.openaiUpstreamBase ?? up.base,
  });
  port = await gw.listen(0);
}

const ask = (priority: string | undefined, content: string) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(priority ? { [PRIORITY_HEADER]: priority } : {}),
    },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content }] }),
  });

const askCodex = (priority: string | undefined, input: string) =>
  fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(priority ? { [PRIORITY_HEADER]: priority } : {}),
    },
    body: JSON.stringify({ model: 'gpt-5.5', input, stream: false }),
  });

const tiersDep = (config: { caps?: Record<number, number>; tier1Reserve?: number }) => ({
  map: DEFAULT_GATEWAY_PRIORITY_MAP,
  config,
});

async function getStats(): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}/stats`);
  return r.json();
}

test('tier 1 (queen) is served AHEAD of a saturated tier-3 (bee) backlog', async () => {
  // concurrency 1, tier-3 capped at 1 in-flight. A held tier-3 request saturates the cap + the only slot.
  // While it holds, a flood of tier-3 + one tier-1 enqueue. When the slot frees, the queued tier-3 is
  // blocked by its own cap → the tier-1 request runs FIRST even though the tier-3 backlog arrived earlier.
  const served: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let firstSeen = false;
  await boot(
    (req, res) => {
      const tag = (req.headers[PRIORITY_HEADER] as string) ?? '?';
      const finish = () => {
        served.push(tag);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      };
      // hold the FIRST tier-3 (the cap saturator) until we release it; serve everything else immediately
      if (tag === 'cup' && !firstSeen) {
        firstSeen = true;
        releaseFirst = finish;
        return;
      }
      finish();
    },
    { concurrency: 1, priorityTiers: tiersDep({ caps: { 3: 1 }, tier1Reserve: 0 }) },
  );

  const first = ask('cup', 'hold'); // saturates tier-3 cap + the single slot
  // wait until the upstream is actually holding the first request
  for (let i = 0; i < 50 && !releaseFirst; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(releaseFirst, 'first tier-3 is holding the slot');

  const beeA = ask('cup', 'bee-a'); // queued (tier-3 cap full)
  const beeB = ask('cup', 'bee-b'); // queued
  await new Promise((r) => setTimeout(r, 30));
  const queen = ask('mug', 'mug'); // queued LAST but tier 1
  await new Promise((r) => setTimeout(r, 30));

  releaseFirst!(); // free the slot → queen must win over the capped tier-3 backlog
  await Promise.all([first, beeA, beeB, queen]);

  // the first served-after-release request is the queen (tier 1), NOT an earlier-arriving bee.
  const afterHold = served.slice(1); // drop the held-first bee
  assert.equal(afterHold[0], 'mug', `tier 1 served first after the hold; got order ${served.join(',')}`);
});

test('reserved tier-1 FLOOR holds a slot open under a tier-3 flood', async () => {
  // concurrency 2, reserve 1 for tier 1. Two tier-3 requests held at the upstream would fill both slots —
  // but the reserve refuses tier 3 admission once running == maxConcurrent - reserve == 1. So only ONE
  // tier-3 runs; the held-open slot admits a tier-1 immediately.
  const released: Array<() => void> = [];
  let holdBees = true;
  let queenServed = false;
  await boot(
    (req, res) => {
      const tag = (req.headers[PRIORITY_HEADER] as string) ?? '?';
      const finish = () => {
        if (tag === 'mug') queenServed = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      };
      // queen always serves immediately. A bee is HELD while holdBees is set (so it squats its slot),
      // else served immediately (so a queued bee that admits after we stop holding can complete).
      if (tag === 'cup' && holdBees) {
        released.push(finish);
        return;
      }
      finish();
    },
    { concurrency: 2, priorityTiers: tiersDep({ caps: {}, tier1Reserve: 1 }) },
  );

  const beeA = ask('cup', 'bee-a');
  const beeB = ask('cup', 'bee-b');
  // let admission settle: only one bee can run (reserve holds the 2nd slot for tier 1)
  for (let i = 0; i < 50 && released.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  const s = await getStats();
  assert.equal(s.priorityTiers.tier1Reserve, 1, '/stats reports the reserved floor');
  const t3 = s.priorityTiers.tiers.find((t: any) => t.tier === 3);
  assert.equal(t3.inFlight, 1, 'only one bee runs — the reserved slot is held for tier 1');

  const queen = ask('mug', 'mug'); // must run into the reserved slot, NOT block behind the held bee
  for (let i = 0; i < 50 && !queenServed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(queenServed, true, 'tier 1 admitted into the reserved floor while a tier-3 is held');

  // stop holding + release the running bee → the queued bee admits and is served immediately.
  holdBees = false;
  released.forEach((r) => r());
  await Promise.all([beeA, beeB, queen]);
});

test('Codex /v1/responses keeps two tier-3 slots plus a reserved Scout slot', async () => {
  const released: Array<() => void> = [];
  let holdBees = true;
  let scoutServed = false;
  const codexPool: AccountPool = createFailoverPool([{ accountId: 'codex-a', token: async () => 'codex-token' }]);
  await boot(
    (req, res) => {
      const tag = (req.headers[PRIORITY_HEADER] as string) ?? '?';
      const finish = () => {
        if (tag === 'scout') scoutServed = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output_text: '{"ok":true}', usage: { input_tokens: 1, output_tokens: 1 } }));
      };
      if (tag === 'cup' && holdBees) {
        released.push(finish);
        return;
      }
      finish();
    },
    {
      codexPool,
      // P-010: one shared admission seed for both lanes — Codex has no separate size.
      concurrency: 3,
      // Give Claude a deliberately different reserve so inheriting its layer would leave only one
      // Codex tier-3 slot. The Codex-specific layer must preserve two bee slots plus Scout's reserve.
      priorityTiers: tiersDep({ caps: {}, tier1Reserve: 2 }),
      codexPriorityTiers: tiersDep({ caps: {}, tier1Reserve: 1 }),
    },
  );

  const beeA = askCodex('cup', 'bee-a');
  const beeB = askCodex('cup', 'bee-b');
  for (let i = 0; i < 50 && released.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(released.length, 2, 'both non-tier-1 Codex slots admit before the reserved Scout slot');
  await new Promise((r) => setTimeout(r, 50));

  const s = await getStats();
  assert.equal(s.codexAdmission.tier1Reserve, 1, 'Codex queue reports the reserved Scout slot');
  const t3 = s.codexAdmission.byTier.find((t: any) => t.tier === 3);
  assert.equal(t3.inFlight, 2, 'two bees use the three-slot Codex gate while one slot remains reserved');

  const scout = askCodex('scout', 'scout');
  for (let i = 0; i < 50 && !scoutServed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(scoutServed, true, 'Scout admitted into the Codex reserve while a bee is held');

  holdBees = false;
  released.forEach((r) => r());
  await Promise.all([beeA, beeB, scout]);
});

test('/stats — per-tier {cap,inFlight,queued} + pool healthyAccounts; ABSENT under flag-OFF', async () => {
  // flag-ON (priorityTiers present): /stats carries the tier block sourced from a multi-account pool.
  const entries: ActiveAccount[] = [
    { accountId: 'a1', token: async () => 't1' },
    { accountId: 'a2', token: async () => 't2' },
    { accountId: 'a3', token: async () => 't3' },
  ];
  const pool: AccountPool = createFailoverPool(entries);
  await boot(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    { pool, accountId: undefined, token: undefined, concurrency: 8, priorityTiers: tiersDep({ caps: { 1: 8, 2: 6, 3: 6, 4: 6 }, tier1Reserve: 2 }) },
  );
  const s = await getStats();
  assert.ok(s.priorityTiers, 'priorityTiers present with the flag/dep ON');
  assert.equal(s.priorityTiers.healthyAccounts, 3, 'all 3 pool accounts healthy');
  assert.equal(s.priorityTiers.tier1Reserve, 2);
  const t1 = s.priorityTiers.tiers.find((t: any) => t.tier === 1);
  assert.deepEqual({ tier: t1.tier, minShare: t1.minShare }, { tier: 1, minShare: 8 });
  // admission.byTier is the same data on the generic snapshot
  assert.ok(Array.isArray(s.admission.byTier), 'admission.byTier present');
});

test('flag-OFF (no priorityTiers dep): priority header is IGNORED + /stats has no priorityTiers', async () => {
  await boot(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    { concurrency: 4 }, // NO priorityTiers
  );
  // a request carrying a priority header still succeeds (header is inert without the tier layer)
  const r = await ask('mug', 'x');
  assert.equal(r.status, 200);
  const s = await getStats();
  assert.equal(s.priorityTiers, undefined, 'no priorityTiers stats field under flag-OFF');
  assert.equal(s.admission.byTier, undefined, 'no byTier on the admission snapshot under flag-OFF');
  assert.equal(s.admission.tier1Reserve, undefined);
});

test('tier-aware shedding: an AIMD storm shrinks the bottom band first, holds tier 1', async () => {
  // Drive a sustained 429 storm so AIMD shrinks effective concurrency; the tier caps must shed 4→3→2 first
  // and NEVER reduce tier 1. We read the shed via /stats per-tier caps after the storm.
  let calls = 0;
  await boot(
    (_req, res) => {
      calls++;
      // throttle the first burst to drive AIMD decreases; a 429 with a near reset so the gateway forwards it.
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    },
    {
      concurrency: 16,
      // aggressive AIMD so a handful of 429s trips multiple decreases quickly
      aimd: { floor: 1, decreaseThreshold: 2, decreaseFactor: 0.5, increaseEvery: 100 },
      internalRetryDeadlineMs: 50, // shed fast so the storm requests resolve quickly
      // Absorb is default-on and a retry-budget-exhausted shed now enters it too: with a 50ms slot
      // budget under the upstream's 1s retry-after, each re-acquire cannot dispatch and the caller is
      // held until the 60s absorb deadline. Pin absorb OFF so this case measures tier shedding only.
      requestAbsorbMs: 0,
      priorityTiers: tiersDep({ caps: { 1: 16, 2: 13, 3: 13, 4: 13 }, tier1Reserve: 3 }),
    },
  );

  // fire a storm of bee (tier-3) requests; each upstream 429 feeds aimd.recordThrottle()
  await Promise.allSettled(Array.from({ length: 12 }, (_, i) => ask('cup', `storm-${i}`)));
  await new Promise((r) => setTimeout(r, 50));

  const s = await getStats();
  assert.ok(calls > 0, 'upstream saw the storm');
  assert.ok(s.aimd.decreases > 0, 'AIMD shrank effective concurrency under the storm');
  const share = (tier: number) => s.priorityTiers.tiers.find((t: any) => t.tier === tier)?.minShare ?? null;
  // tier 1's share is never reduced; the bottom band (4) is shed first → its share is ≤ the higher
  // non-tier-1 bands (2,3 give up headroom only after 4 hits its floor).
  assert.equal(share(1), 16, 'tier 1 share held at the full pool under the storm');
  assert.ok(share(4)! <= share(3)!, 'tier 4 shed at least as much as tier 3 (bottom-up)');
  assert.ok(share(3)! <= share(2)!, 'tier 3 shed at least as much as tier 2 (bottom-up)');
  assert.ok(share(4)! < 13, 'the most-sheddable band actually shrank');
}, 20_000); // storm-driven — needs headroom on a loaded box (flaked at the 5s default under fleet load, 2026-07-01)

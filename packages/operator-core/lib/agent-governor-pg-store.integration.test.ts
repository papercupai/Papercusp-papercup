/**
 * agent-governor-pg-store.integration.test.ts — RB-007.
 *
 * Proves the PG-backed cross-process GovernorStore against a REAL Postgres (testcontainer):
 * two RateLimitGovernor instances (standing in for two operator processes) that share ONE
 * `agent_rate_budget` row genuinely share the budget — a 429 on one pauses the other, and the
 * shared RPM window is enforced across both even under PARALLEL contention (the `SELECT … FOR
 * UPDATE` serializes the read-modify-write, so the counter can't be double-spent). That last one
 * is the property a pure-in-memory test can't show; it's the whole point of going to PG.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/agent-governor-pg-store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { RateLimitGovernor, effectiveRpm } from '@papercusp/papercusp-shared/agent';
import { PgGovernorStore } from './agent-governor-pg-store';

let sql: postgres.Sql;
let store: PgGovernorStore;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `gov_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 8, onnotice: () => {} });

  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  // Apply the real migration DDL so we test the shipped schema, not a hand-rolled copy.
  const ddl = readFileSync(
    join(__dirname, '../../../libs/papercusp/libs/db/sql/111-agent-rate-budget.sql'),
    'utf8',
  );
  await sql.unsafe(ddl);
  // C1 (2026-06-23): apply the rpm_factor/rpm_factor_at columns the store now persists.
  await sql.unsafe(
    readFileSync(join(__dirname, '../../../libs/papercusp/libs/db/sql/384-agent-rate-budget-rpm-factor.sql'), 'utf8'),
  );

  store = new PgGovernorStore(sql);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** A pair of governors with an injected clock, both bound to the SAME shared store + key. */
function sharedPair(key: string, limits: { maxConcurrent: number; rpm?: number }) {
  const clock = { t: 1_000_000 };
  const deps = {
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    store,
    storeKey: key,
  };
  return {
    clock,
    a: new RateLimitGovernor(limits, deps),
    b: new RateLimitGovernor(limits, deps),
  };
}

describe('PgGovernorStore (RB-007)', () => {
  it('serializes concurrent feedback on a bucket that has never existed', async () => {
    const key = 'openai:default@first-use-feedback';
    const limits = { maxConcurrent: 32, rpm: 45 };
    await Promise.all(Array.from({ length: 16 }, () => store.transact(key, limits, s => {
      s.rpmFactor = (s.rpmFactor ?? 1) + 1;
    })));
    const state = await store.transact(key, limits, () => {});
    expect(state.rpmFactor).toBe(17);
  });

  it.each(['openai', 'anthropic'])('persists %s growth above the seed and provider-limit evidence across instances', async provider => {
    const key = `${provider}:default@adaptive-rpm`;
    const { a, b, clock } = sharedPair(key, { maxConcurrent: 10, rpm: 45 });
    a.state.smoothRpm = true;
    a.recordResponse({}, 200);
    await expect.poll(async () => {
      const rows = await sql`SELECT rpm_factor FROM harness_shared.agent_rate_budget WHERE bucket_key = ${key}`;
      return Number(rows[0]?.rpm_factor ?? 1);
    }).toBeGreaterThan(1);
    b.state.smoothRpm = true;
    const release = await b.acquire();
    release?.();
    expect(effectiveRpm(b.state, clock.t)).toBeGreaterThan(45);

    a.recordResponse({ 'x-ratelimit-limit-requests': '120' }, 200);
    await expect.poll(async () => {
      const state = await store.transact(key, { maxConcurrent: 10 }, () => {});
      return state.limits.rpmFromHeaders;
    }).toBe(true);
    const c = new RateLimitGovernor({ maxConcurrent: 10, rpm: 45 }, {
      now: () => clock.t, sleep: async ms => { clock.t += ms; }, store, storeKey: key,
    });
    c.state.smoothRpm = true;
    const inherited = await c.acquire({}, { maxWaitMs: 2_000 });
    expect(inherited).not.toBeNull();
    inherited?.();
    c.recordResponse({}, 200);
    expect(effectiveRpm(c.state, clock.t)).toBe(120);
    expect(c.state.limits.rpmFromHeaders).toBe(true);
  });

  it('a 429 penalty on one governor pauses the OTHER via the shared row', async () => {
    const { a, b, clock } = sharedPair('anthropic:opus', { maxConcurrent: 5 });
    a.penalize({ retryAfterMs: 30_000 });
    // let the fire-and-forget shared write land
    await new Promise((r) => setTimeout(r, 50));
    const blocked = await b.acquire({}, { maxWaitMs: 1000 });
    expect(blocked).toBeNull(); // B inherited A's account-wide pause
    clock.t += 30_001;
    const ok = await b.acquire({}, { maxWaitMs: 1000 });
    expect(ok).not.toBeNull();
    ok?.();
    const row = await sql`SELECT paused_until FROM harness_shared.agent_rate_budget WHERE bucket_key = 'anthropic:opus'`;
    expect(Number(row[0].paused_until)).toBe(1_030_000);
  });

  it('the adaptive rpmFactor persists + reloads across the shared row (C1, 2026-06-23)', async () => {
    const key = 'anthropic:opus@aviynw-rpm';
    const a = new RateLimitGovernor({ maxConcurrent: 100, rpm: 40 }, { store, storeKey: key });
    // A rate-429 on A decreases the learned factor AND must persist it to the shared row (before C1 the decrease
    // hit only A's in-memory state → a peer reloading the row saw factor 1 and re-walked into the same 429).
    a.penalize({ retryAfterMs: 1, rateLimited: true });
    await new Promise((r) => setTimeout(r, 80)); // let the fire-and-forget shared write land
    const row = await sql`SELECT rpm_factor FROM harness_shared.agent_rate_budget WHERE bucket_key = ${key}`;
    expect(Number(row[0].rpm_factor)).toBeCloseTo(0.5, 5); // the learned factor IS in the shared row now
    // A PEER process (B) loading the row on its next acquire must inherit the learned-down factor (rowToState
    // reads rpm_factor → syncSharedInto carries it into B's snapshot).
    const b = new RateLimitGovernor({ maxConcurrent: 100, rpm: 40 }, { store, storeKey: key });
    const rel = await b.acquire({}, { maxWaitMs: 200 });
    rel?.();
    expect(b.state.rpmFactor).toBeCloseTo(0.5, 5);
  });

  it('the shared RPM window is enforced across both governors (no double-spend under FOR UPDATE)', async () => {
    const key = 'anthropic:sonnet';
    const RPM = 5;
    // Many parallel acquires across BOTH governors; with real now/sleep they truly race the PG row.
    const a = new RateLimitGovernor({ maxConcurrent: 10, rpm: RPM }, { store, storeKey: key });
    const b = new RateLimitGovernor({ maxConcurrent: 10, rpm: RPM }, { store, storeKey: key });

    // Fire RPM+? acquires concurrently with a tight maxWait so the over-cap ones bail rather than
    // block for a whole minute. Exactly RPM should win the window; the rest get null.
    const attempts = [a, b, a, b, a, b, a, b].map((g) => g.acquire({}, { maxWaitMs: 200 }));
    const releases = await Promise.all(attempts);
    const granted = releases.filter((r) => r !== null);
    expect(granted.length).toBe(RPM); // the shared window admitted EXACTLY rpm, not 2×rpm
    for (const rel of granted) rel?.();

    const row = await sql`SELECT req_in_window FROM harness_shared.agent_rate_budget WHERE bucket_key = ${key}`;
    expect(Number(row[0].req_in_window)).toBe(RPM); // the shared counter is exactly at the cap
  });

  it('auto-tuned limits persist + reload across transacts (the shared row carries rpm)', async () => {
    const key = 'openai:default';
    // One transact learns rpm (as recordHeaders would from an x-ratelimit-limit-requests header)…
    await store.transact(key, { maxConcurrent: 5 }, (s) => {
      s.limits.rpm = 120;
    });
    // …a SECOND transact must LOAD it back from PG, not reset to the floor.
    let loadedRpm: number | undefined;
    await store.transact(key, { maxConcurrent: 5 }, (s) => {
      loadedRpm = s.limits.rpm;
    });
    expect(loadedRpm).toBe(120);
    // NOTE: we deliberately do NOT assert the raw jsonb shape of `limits` here.
    // The store binds it as `${JSON.stringify(x)}::jsonb` (required by the
    // production getOrgPg client, where sql.json THROWS). This testcontainer
    // client double-encodes that form, so a direct `row.limits.rpm` read would
    // see a string — the inverse of production. The client-agnostic guarantee
    // (rpm survives a transact→PG→transact round-trip, via the store's own
    // shape-tolerant read) is the `loadedRpm` assertion above. jsonb shape is
    // verified against the live host. See agent-insights/postgres-js-jsonb-binding.
  });
});

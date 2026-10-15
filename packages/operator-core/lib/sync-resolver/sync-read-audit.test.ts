// Sync-read audit recurrence guard (precompute-sync-reads-phase2 P-008).
//
// HERMETIC — enumerate the registry, auto-detect arg-requiring queries via their
// argsSchema, and FAIL when a fixture is missing or the allowlist rots. NO
// resolver invocation (an older invoke-every-entry breadth test repeatedly blew
// the green gate under load — getRegistryEntryV2 note in index.ts); the live
// payload/latency budget runs on demand via measureSyncReadPayloadsViaRest
// against a running operator, not here.

import { describe, it, expect } from 'vitest';
import { knownQueryNamesV2, getRegistryEntryV2, isRegisteredV2 } from './index';
import {
  SYNC_QUERY_FIXTURES,
  SYNC_READ_ALLOWLIST,
  PAYLOAD_BUDGET_BYTES,
  LATENCY_BUDGET_MS,
  queryRequiresArgs,
  resolveFixture,
  buildLiveFixtureMap,
  evaluateBudget,
  measureSyncReadPayloadsViaRest,
} from './sync-read-audit';

describe('sync-read audit — registry coverage guard (P-008)', () => {
  const names = knownQueryNamesV2();

  it('the registry is non-trivial (sanity: many queries registered)', () => {
    expect(names.length).toBeGreaterThan(100);
  });

  it('EVERY arg-requiring query resolves to a fixture (default args OR an explicit entry)', () => {
    const missing: string[] = [];
    for (const name of names) {
      const entry = getRegistryEntryV2(name) as
        | { argsSchema?: { safeParse?: (v: unknown) => { success: boolean } } }
        | undefined;
      if (!queryRequiresArgs(entry)) continue; // resolves with {} → no fixture needed
      const r = resolveFixture(name, entry);
      if ('needsExplicit' in r) missing.push(name);
    }
    expect(
      missing,
      `These arg-REQUIRING sync queries have no usable fixture (DEFAULT_HARNESS_ARGS does not satisfy\n` +
        `their argsSchema). Add a representative-args (or null) entry to SYNC_QUERY_FIXTURES in\n` +
        `sync-read-audit.ts — do not work around the guard:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every EXPLICIT non-null fixture actually satisfies its query argsSchema', () => {
    const bad: string[] = [];
    for (const [name, fixture] of Object.entries(SYNC_QUERY_FIXTURES)) {
      if (fixture === null) continue;
      const entry = getRegistryEntryV2(name) as
        | { argsSchema?: { safeParse?: (v: unknown) => { success: boolean } } }
        | undefined;
      const schema = entry?.argsSchema;
      // A query with no argsSchema accepts anything; only validate when one exists.
      if (schema?.safeParse && schema.safeParse(fixture).success === false) bad.push(name);
    }
    expect(bad, `explicit fixtures that do NOT parse against their argsSchema: ${bad.join(', ')}`).toEqual([]);
  });

  it('no fixture entry names an UNREGISTERED query (fixtures cannot drift ahead of the registry)', () => {
    const stale = Object.keys(SYNC_QUERY_FIXTURES).filter((n) => !isRegisteredV2(n));
    expect(stale, `SYNC_QUERY_FIXTURES names queries no longer in the registry: ${stale.join(', ')}`).toEqual([]);
  });

  it('does not let the periodic audit become the only consumer of demand-driven plans.lint (WI-7230)', () => {
    expect(SYNC_QUERY_FIXTURES['plans.lint']).toBeNull();
    const map = buildLiveFixtureMap(['plans.lint'], (name) => getRegistryEntryV2(name) as never);
    expect(map).toEqual({ 'plans.lint': null });
  });

  it('skips identity-specific reads instead of measuring fabricated empty fixtures', async () => {
    const queries = ['cupboard.identityOutcomeCosts', 'integrations.tickets', 'reports.lineage'];
    const fixtures = buildLiveFixtureMap(queries, (name) => getRegistryEntryV2(name) as never);
    expect(fixtures).toEqual(Object.fromEntries(queries.map((name) => [name, null])));
    let fetches = 0;
    const result = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://unused.invalid',
      token: 'fixture-only',
      fixtures,
      fetchImpl: async () => {
        fetches++;
        throw new Error('identity-specific reads must not be probed');
      },
    });
    expect(fetches).toBe(0);
    expect(result.skipped).toEqual(queries);
    expect(result.measured).toEqual([]);
  });
});

describe('sync-read audit — allowlist hygiene (P-008)', () => {
  it('every allowlist entry names a REAL registered query, with a reason + reviewBy', () => {
    for (const [name, entry] of Object.entries(SYNC_READ_ALLOWLIST)) {
      expect(isRegisteredV2(name), `allowlisted query ${name} is not registered`).toBe(true);
      expect(entry.reason.length, `allowlist ${name} needs a non-empty reason`).toBeGreaterThan(20);
      expect(entry.reviewBy, `allowlist ${name} needs a reviewBy date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.maxBytes ?? entry.maxMs, `allowlist ${name} must raise at least one ceiling`).toBeDefined();
    }
  });

  it('an allowlist ceiling is always ABOVE the default budget (else it is pointless)', () => {
    for (const [name, entry] of Object.entries(SYNC_READ_ALLOWLIST)) {
      if (entry.maxBytes != null) expect(entry.maxBytes, name).toBeGreaterThan(PAYLOAD_BUDGET_BYTES);
      if (entry.maxMs != null) expect(entry.maxMs, name).toBeGreaterThan(LATENCY_BUDGET_MS);
    }
  });
});

describe('sync-read audit — budget evaluation', () => {
  it('flags a non-allowlisted query over either ceiling, and says WHICH axis', () => {
    expect(evaluateBudget('some.unknownQuery', PAYLOAD_BUDGET_BYTES + 1, 10)).toEqual({
      overBudget: true,
      allowlisted: false,
      overBytes: true,
      overMs: false,
      byteCeil: PAYLOAD_BUDGET_BYTES,
      msCeil: LATENCY_BUDGET_MS,
    });
    expect(evaluateBudget('some.unknownQuery', 10, LATENCY_BUDGET_MS + 1)).toEqual({
      overBudget: true,
      allowlisted: false,
      overBytes: false,
      overMs: true,
      byteCeil: PAYLOAD_BUDGET_BYTES,
      msCeil: LATENCY_BUDGET_MS,
    });
    expect(evaluateBudget('some.unknownQuery', 10, 10)).toEqual({
      overBudget: false,
      allowlisted: false,
      overBytes: false,
      overMs: false,
      byteCeil: PAYLOAD_BUDGET_BYTES,
      msCeil: LATENCY_BUDGET_MS,
    });
  });

  it('a bytes-only allowlist entry does NOT buy latency headroom (WI-7084)', () => {
    // Being allowed to be BIG is not being allowed to be SLOW. Every current entry
    // sets maxBytes alone, so each is still held to the DEFAULT latency ceiling —
    // pinned because silently widening it would hide the regressions the
    // ratchetRegressions bucket exists to surface.
    const name = 'codeRecipes';
    expect(SYNC_READ_ALLOWLIST[name].maxMs).toBeUndefined();
    const r = evaluateBudget(name, 10, LATENCY_BUDGET_MS + 1);
    expect(r.msCeil).toBe(LATENCY_BUDGET_MS);
    expect(r.overMs).toBe(true);
    expect(r.overBytes).toBe(false);
  });

  it('an allowlisted query is judged against its RAISED ceiling', () => {
    // Derived from the registry, NOT hard-coded: these budgets are deliberately
    // RATCHETED DOWN as each query is slimmed,
    // and a literal here turns every ratchet into an unrelated red.
    const ceiling = SYNC_READ_ALLOWLIST.codeRecipes.maxBytes!;
    expect(ceiling).toBeGreaterThan(PAYLOAD_BUDGET_BYTES); // it IS a raised ceiling
    expect(evaluateBudget('codeRecipes', ceiling - 1, 10).overBudget).toBe(false);
    expect(evaluateBudget('codeRecipes', ceiling + 1, 10).overBudget).toBe(true);
    expect(evaluateBudget('codeRecipes', ceiling - 1, 10).allowlisted).toBe(true);
  });
});

describe('sync-read audit — measureSyncReadPayloadsViaRest (harness logic, fake fetch)', () => {
  it('measures UTF-8 response bytes and catches a multibyte-only budget violation', async () => {
    const rows = [{ title: '界'.repeat(PAYLOAD_BUDGET_BYTES / 2) }];
    const body = JSON.stringify({ rows, version: String(Date.now()) });
    const expectedBytes = (await new Response(body).arrayBuffer()).byteLength;
    expect(body.length).toBeLessThan(PAYLOAD_BUDGET_BYTES);
    expect(expectedBytes).toBeGreaterThan(PAYLOAD_BUDGET_BYTES);
    const fixtures = { 'workItems.stats': { harnessSlug: 'papercusp' } };
    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x', token: 't', fixtures,
      fetchImpl: (async () => new Response(body)) as typeof fetch,
    });
    expect(report.measured[0]).toMatchObject({ bytes: expectedBytes, overBytes: true });
    expect(report.violations.map((row) => row.name)).toEqual(['workItems.stats']);
  });

  it('also records UTF-8 bytes for unsuccessful HTTP bodies', async () => {
    const body = 'échec 🚫';
    const expectedBytes = (await new Response(body).arrayBuffer()).byteLength;
    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x', token: 't', fixtures: { 'workItems.stats': {} },
      fetchImpl: (async () => new Response(body, { status: 500 })) as typeof fetch,
    });
    expect(report.measured[0]).toMatchObject({ bytes: expectedBytes, error: 'HTTP 500', overBytes: false });
  });

  it('ranks by bytes desc, flags non-allowlisted violations, skips null fixtures', async () => {
    // Fake operator: featuresConsolidated.bySlug small (ok), a synthetic fat query
    // over budget (violation), codeRecipes fat-but-allowlisted.
    const bodies: Record<string, string> = {
      'featuresConsolidated.bySlug': JSON.stringify({ rows: [{ a: 1 }, { a: 2 }] }),
      // Fat enough to clear the DEFAULT budget but under this query's raised
      // ceiling — sized from the registry so a budget ratchet doesn't red this.
      codeRecipes: JSON.stringify({
        rows: Array.from({ length: 10 }, () => ({
          x: 'y'.repeat(Math.floor((PAYLOAD_BUDGET_BYTES + SYNC_READ_ALLOWLIST.codeRecipes.maxBytes!) / 2 / 10)),
        })),
      }),
      'workItems.stats': 'X'.repeat(PAYLOAD_BUDGET_BYTES + 5000), // over budget, NOT allowlisted → violation
    };
    const fakeFetch = (async (url: string) => {
      const name = new URL(url).searchParams.get('name')!;
      const body = bodies[name] ?? '{"rows":[]}';
      return { ok: true, status: 200, text: async () => body } as Response;
    }) as unknown as typeof fetch;

    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x',
      token: 't',
      fixtures: {
        'featuresConsolidated.bySlug': { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
        codeRecipes: {},
        'workItems.stats': { harnessSlug: 'papercusp' },
        'workItems.detail': null, // skipped, never fetched
      },
      fetchImpl: fakeFetch,
    });

    // workItems.detail has a null fixture → skipped, never fetched.
    expect(report.skipped).toContain('workItems.detail');
    // sorted by bytes desc → the fat allowlisted run list first.
    expect(report.measured[0].name).toBe('codeRecipes');
    // the only non-allowlisted over-budget read is workItems.stats.
    expect(report.violations.map((v) => v.name)).toEqual(['workItems.stats']);
    // the allowlisted fat query is measured but NOT a violation.
    const runs = report.measured.find((m) => m.name === 'codeRecipes')!;
    expect(runs.allowlisted).toBe(true);
    expect(runs.overBudget).toBe(false);
    expect(runs.rows).toBe(10);
    // …and, being under its own ceiling, it is not a ratchet regression either.
    expect(report.ratchetRegressions).toEqual([]);
  });

  /**
   * WI-7084 — the regression this whole split exists for.
   *
   * An ALLOWLISTED read that busts its OWN ratcheted ceiling used to land in NO
   * bucket: `violations` filtered `overBudget && !allowlisted`, so being on the
   * allowlist made it invisible precisely when its recorded ceiling had rotted.
   * Live proof at the time of filing: featuresConsolidated.bySlug measured
   * 633,664 B against a ratcheted 500,000 and appeared nowhere.
   */
  it('an allowlisted read OVER ITS OWN ceiling is a ratchetRegression, not silence', async () => {
    const name = 'codeRecipes';
    const ceiling = SYNC_READ_ALLOWLIST[name].maxBytes!;
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        // Deliberately PAST its raised ceiling — the rotted-ratchet case.
        text: async () => 'X'.repeat(ceiling + 1),
      }) as Response) as unknown as typeof fetch;

    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x',
      token: 't',
      fixtures: { [name]: {} },
      fetchImpl: fakeFetch,
    });

    const row = report.measured[0];
    expect(row.overBudget).toBe(true);
    expect(row.overBytes).toBe(true);
    expect(row.byteCeil).toBe(ceiling); // judged against the RAISED ceiling, not the default
    // It is NOT a plain violation — it has an entry — but it must not vanish.
    expect(report.violations).toEqual([]);
    expect(report.ratchetRegressions.map((m) => m.name)).toEqual([name]);
  });

  it('the two buckets are disjoint and together hold every over-budget row', async () => {
    const fat = 'X'.repeat(PAYLOAD_BUDGET_BYTES + 5000);
    const fakeFetch = (async (url: string) => {
      const name = new URL(url).searchParams.get('name')!;
      // workItems.stats: unallowlisted + fat → violation.
      // codeRecipes: allowlisted, and fat ENOUGH to clear its own
      // raised ceiling → ratchetRegression.
      const body = name === 'workItems.stats' ? fat : 'X'.repeat(SYNC_READ_ALLOWLIST.codeRecipes.maxBytes! + 1);
      return { ok: true, status: 200, text: async () => body } as Response;
    }) as unknown as typeof fetch;

    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x',
      token: 't',
      fixtures: {
        'workItems.stats': { harnessSlug: 'papercusp' },
        codeRecipes: {},
      },
      fetchImpl: fakeFetch,
    });

    const over = report.measured
      .filter((m) => m.overBudget)
      .map((m) => m.name)
      .sort();
    const bucketed = [...report.violations, ...report.ratchetRegressions].map((m) => m.name).sort();
    expect(bucketed).toEqual(over); // nothing over-budget falls through the gap
    expect(over).toHaveLength(2);
    // disjoint
    const vNames = new Set(report.violations.map((m) => m.name));
    expect(report.ratchetRegressions.some((m) => vNames.has(m.name))).toBe(false);
  });

  it('records a non-OK HTTP response as an error, not a false pass', async () => {
    const fakeFetch = (async () =>
      ({ ok: false, status: 500, text: async () => 'boom' }) as Response) as unknown as typeof fetch;
    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x',
      token: 't',
      fixtures: { 'workItems.stats': { harnessSlug: 'papercusp' } },
      fetchImpl: fakeFetch,
    });
    expect(report.measured[0].error).toBe('HTTP 500');
    expect(report.violations).toEqual([]);
    expect(report.ratchetRegressions).toEqual([]);
  });

  /**
   * The `ms` column is uninterpretable without the conditions it was taken under,
   * and silently so. Measured 2026-08-02 at load 129 on 16 cores:
   * plans.attentionCounts returned 103 BYTES in 442ms, reproducibly. A 103-byte
   * response cannot be slow for payload reasons — and on that same run three of
   * the four ratchetRegressions were flagged on latency ALONE.
   *
   * bytes is load-independent; ms is not. Recording the load is what lets a
   * reader discount the ms axis instead of chasing a ghost.
   */
  it('reports the host load the ms column was measured under', async () => {
    const fakeFetch = (async () =>
      ({ ok: true, status: 200, text: async () => '{"rows":[]}' }) as Response) as unknown as typeof fetch;
    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x',
      token: 't',
      fixtures: { 'workItems.stats': { harnessSlug: 'papercusp' } },
      fetchImpl: fakeFetch,
    });
    expect(report.host.cores).toBeGreaterThan(0);
    expect(report.host.loadAvg1Start).toBeGreaterThanOrEqual(0);
    expect(report.host.loadAvg1End).toBeGreaterThanOrEqual(0);
    expect(report.host.loadPerCore).toBeCloseTo(report.host.loadAvg1End / report.host.cores);
  });

  it('buildLiveFixtureMap resolves the whole registry with no unresolved arg-requiring query', () => {
    const names = knownQueryNamesV2();
    const map = buildLiveFixtureMap(names, (n) => getRegistryEntryV2(n) as never);
    // Every arg-requiring query is either present (default/explicit) or an
    // explicit null — never silently absent.
    for (const name of names) {
      const entry = getRegistryEntryV2(name) as
        | { argsSchema?: { safeParse?: (v: unknown) => { success: boolean } } }
        | undefined;
      if (!queryRequiresArgs(entry)) continue;
      expect(Object.prototype.hasOwnProperty.call(map, name), `${name} unresolved in the live map`).toBe(true);
    }
    // A no-arg query resolves to {}; a null-fixtured one stays null.
    expect(map['workItems.detail']).toBeNull();
  });
});

/**
 * orient-recall-quality-2026-07-12 P-004(a) — cross-port warm-session dedup
 * against REAL Postgres (the runtime half of the session-identity contract;
 * the source-text pins live in session-identity-contract.test.ts).
 *
 * Drives the ONE admission pipeline (buildMemoryContextBlock) twice for the
 * same sessionId on DIFFERENT ports and asserts the second delivery is
 * suppressed by the session-epoch ledger (memory_session_surfaced) — the
 * "orient-then-claim never double-injects" D-006 property, end-to-end through
 * the real table + the real UUID/epoch filters, not a mocked ledger. Also pins
 * the epoch-bump reset: after bumpSessionEpoch, the SAME memories deliver again
 * (the post-compaction re-prime property).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { MemoryEntry } from './backend';

const h = vi.hoisted(() => ({ sql: null as unknown, entries: [] as MemoryEntry[] }));

// Real PG via the org-fixture; only getOrgPg is stubbed to point at it.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./backend', () => ({
  getMemoryBackend: () => ({
    available: async () => ({ ok: true }),
    search: async () => h.entries,
  }),
}));
// The workspace-scope read is flag-server-backed (not best-effort-wrapped);
// pin it OFF so the test exercises the dedup path, not flag plumbing.
vi.mock('./workspace-scope-recall', () => ({
  isMemoryWorkspaceScopedRecallOn: async () => false,
  keepUserPoolHitForWorkspace: () => true,
}));

const { buildMemoryContextBlock } = await import('./injection');
const { bumpSessionEpoch } = await import('./session-epoch-ledger');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const SID = `sid-cross-port-${Date.now()}`;

/**
 * The stamp is fire-and-forget — poll the real table until it lands.
 *
 * WI-5255 (de-quarantine, flipRate 0.375): the original 40*50ms=2s budget was
 * far too tight against the SHARED dev PG under fleet load — the quarantine
 * history shows this class of failure is consistently a hook/poll-timeout
 * racing concurrent writes from other agents, never a wrong assertion (see
 * WI-5189's note on the sibling flake). The test-level budget here is the
 * 90s integration testTimeout (vitest-config.ts); poll for up to 20s (200 *
 * 100ms), leaving ample headroom under that ceiling instead of a tight 2s
 * window that a load spike blows through routinely.
 */
async function waitForStamps(sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>, n: number): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 100;
  for (let i = 0; i < maxAttempts; i++) {
    const rows = (await (sql as never as (
      s: TemplateStringsArray, ...v: unknown[]
    ) => Promise<Array<{ n: number }>>)`
      SELECT count(*)::int AS n FROM harness_shared.memory_session_surfaced
      WHERE session_id = ${SID}
    `) as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`stamps for ${SID} never reached ${n} after ${(maxAttempts * intervalMs) / 1000}s`);
}

describe('cross-port session-epoch dedup (real PG — P-004a)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    h.entries = [
      { id: randomUUID(), text: 'always pass argShape Z to the fixture step', scope: 'u-test', score: 0.9 },
      { id: randomUUID(), text: 'the promotion pipeline FFs main from staging', scope: 'u-test', score: 0.8 },
    ];
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it("port A delivers + stamps; port B for the SAME session is suppressed; an epoch bump re-primes", async () => {
    // Port 'initialize' delivers both memories…
    const first = await buildMemoryContextBlock({
      userId: 'u-test',
      workspaceId: 'ws-test',
      queryContext: 'fixture conventions',
      session: { sessionId: SID, port: 'initialize' },
    });
    expect(first).toBeTruthy();
    expect(first).toContain('argShape Z');
    // …and stamps them (fire-and-forget → poll the real table).
    await waitForStamps(db.adminSql as never, 2);

    // A DIFFERENT port, same session + epoch: fully suppressed (null, not a
    // thinner block) — the D-006 "orient-then-claim never double-injects" pin.
    const second = await buildMemoryContextBlock({
      userId: 'u-test',
      workspaceId: 'ws-test',
      queryContext: 'fixture conventions',
      session: { sessionId: SID, port: 'turn-start' },
    });
    expect(second).toBeNull();

    // Compaction boundary: the epoch bump makes the WHOLE pool eligible again.
    await bumpSessionEpoch(db.adminSql as never, SID);
    const reprimed = await buildMemoryContextBlock({
      userId: 'u-test',
      workspaceId: 'ws-test',
      queryContext: 'fixture conventions',
      session: { sessionId: SID, port: 'compact' },
    });
    expect(reprimed).toBeTruthy();
    expect(reprimed).toContain('argShape Z');
    // Observe every eligible port's telemetry before closing its SQL handle.
    // The writer is asynchronous: ledger uniqueness alone says nothing about a
    // missing recall row, and early teardown can manufacture CONNECTION_ENDED.
    const expectedSurfaces = ['initialize', 'turn-start', 'compact'];
    let observedSurfaces: string[] = [];
    for (let i = 0; i < 200; i++) {
      const rows = await db.adminSql<{ surface: string }[]>`
        SELECT DISTINCT surface FROM harness_shared.memory_recall_stats
        WHERE session_id = ${SID}
      `;
      observedSurfaces = rows.map((row) => row.surface);
      if (expectedSurfaces.every((surface) => observedSurfaces.includes(surface))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(observedSurfaces).toEqual(expect.arrayContaining(expectedSurfaces));
    await waitForStamps(db.adminSql as never, 4);
  });
});

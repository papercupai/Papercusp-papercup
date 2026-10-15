/**
 * Reconciliation on Postgres (P-043, R-31; migration 1291). Real migrations,
 * the real engine, and in-memory stand-ins for the work-item filer and the
 * operator-public gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import {
  runReconciliation,
  type BreakFiler,
  type GatePublisher,
  type ReconciliationDeps,
  type ReconciliationSources,
  type TransferGate,
} from './reconciliation';
import { pgReconciliationStore, readReconciliationStatus } from './reconciliation-store';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);
const HOUR = 3_600_000;

const MICROS_PER_CENT = 10_000;

/**
 * Every mandated invariant evaluable; the matching sources not configured. The
 * journal is empty, so its credit reserve is 0 and any outstanding credit breaks
 * credit-reserve-covers-outstanding-credits.
 */
function sources(opts: { outstandingCreditCents: number }): ReconciliationSources {
  return {
    credits: { status: 'ok', value: { outstandingMicros: opts.outstandingCreditCents * MICROS_PER_CENT } },
    dao: { status: 'ok', value: { transferredCents: 0, chainAccruedCents: 0 } },
    safe: { status: 'ok', value: { balanceMicros: 0, receiptsMicros: 0, approvedSpendsMicros: 0 } },
    stripe: { status: 'not-configured' },
    bank: { status: 'not-configured' },
    chain: { status: 'not-configured' },
  };
}

function harness(workspaceId: string) {
  const filed: string[] = [];
  const resolvedNotes: string[] = [];
  const gates: TransferGate[] = [];
  let runSeq = 0;
  let clock = T0;
  const filer: BreakFiler = {
    async fileBreak({ verdict }) {
      const id = `WI-test-${filed.length + 1}`;
      filed.push(`${id}:${verdict.invariant}`);
      return id;
    },
    async noteResolved({ workItemId }) {
      resolvedNotes.push(workItemId);
    },
  };
  const gate: GatePublisher = {
    async publish({ gate: g }) {
      gates.push(g);
      return { published: true };
    },
  };
  const deps = (): ReconciliationDeps => ({
    store: pgReconciliationStore(db.adminSql),
    filer,
    gate,
    now: () => clock,
    newRunId: () => `${workspaceId}-run-${++runSeq}`,
  });
  return {
    filed,
    resolvedNotes,
    gates,
    deps,
    advance(ms: number) {
      clock += ms;
    },
    get clock() {
      return clock;
    },
  };
}

describe('pgReconciliationStore', () => {
  it('opens one break across hourly runs, then resolves it and reopens a new episode', async () => {
    const ws = `recon-ws-${Date.now()}`;
    const h = harness(ws);
    // The journal holds no credit reserve, so any outstanding credit breaks the reserve invariant.
    const run1 = await runReconciliation(
      { workspaceId: ws, mode: 'provisional', entries: [], sources: sources({ outstandingCreditCents:500 }), startedAtMs: h.clock },
      h.deps(),
    );
    expect(run1.opened).toEqual(['credit-reserve-covers-outstanding-credits']);
    expect(run1.gate.open).toBe(false);
    expect(h.filed).toEqual(['WI-test-1:credit-reserve-covers-outstanding-credits']);

    h.advance(HOUR);
    const run2 = await runReconciliation(
      { workspaceId: ws, mode: 'provisional', entries: [], sources: sources({ outstandingCreditCents:700 }), startedAtMs: h.clock },
      h.deps(),
    );
    expect(run2.opened).toEqual([]);
    expect(h.filed).toHaveLength(1);

    const mid = await readReconciliationStatus(ws, { sql: db.adminSql });
    expect(mid.openBreaks).toHaveLength(1);
    expect(mid.openBreaks[0]).toMatchObject({
      invariant: 'credit-reserve-covers-outstanding-credits',
      workItemId: 'WI-test-1',
      openedByRunId: run1.runId,
      lastRunId: run2.runId,
    });
    // The open row carries the LATEST run's detail, not the opening run's.
    const run2Detail = run2.verdicts.find((v) => v.invariant === 'credit-reserve-covers-outstanding-credits')?.detail;
    const run1Detail = run1.verdicts.find((v) => v.invariant === 'credit-reserve-covers-outstanding-credits')?.detail;
    expect(run2Detail).toBeTruthy();
    expect(run2Detail).not.toBe(run1Detail);
    expect(mid.openBreaks[0]!.detail).toBe(run2Detail);
    expect(mid.latest?.runId).toBe(run2.runId);
    expect(mid.latest?.gateOpen).toBe(false);

    h.advance(HOUR);
    const run3 = await runReconciliation(
      { workspaceId: ws, mode: 'provisional', entries: [], sources: sources({ outstandingCreditCents:0 }), startedAtMs: h.clock },
      h.deps(),
    );
    expect(run3.resolved).toEqual(['credit-reserve-covers-outstanding-credits']);
    expect(run3.gate.open).toBe(true);
    expect(h.resolvedNotes).toEqual(['WI-test-1']);
    expect((await readReconciliationStatus(ws, { sql: db.adminSql })).openBreaks).toEqual([]);

    h.advance(HOUR);
    const run4 = await runReconciliation(
      { workspaceId: ws, mode: 'provisional', entries: [], sources: sources({ outstandingCreditCents:50 }), startedAtMs: h.clock },
      h.deps(),
    );
    expect(run4.opened).toEqual(['credit-reserve-covers-outstanding-credits']);
    expect(h.filed).toEqual([
      'WI-test-1:credit-reserve-covers-outstanding-credits',
      'WI-test-2:credit-reserve-covers-outstanding-credits',
    ]);

    const episodes = (await db.adminSql.unsafe(
      `SELECT work_item_id, resolved_by_run FROM harness_shared.reconciliation_breaks
        WHERE workspace_id = $1 ORDER BY id`,
      [ws],
    )) as unknown as Array<{ work_item_id: string; resolved_by_run: string | null }>;
    expect(episodes).toEqual([
      { work_item_id: 'WI-test-1', resolved_by_run: run3.runId },
      { work_item_id: 'WI-test-2', resolved_by_run: null },
    ]);
    expect(h.gates.map((g) => g.open)).toEqual([false, false, true, false]);
  });

  it('lets exactly one of two concurrent openers win, so one break files one item', async () => {
    const ws = `recon-race-${Date.now()}`;
    const store = pgReconciliationStore(db.adminSql);
    const row = (runId: string) => ({
      invariant: 'journal-matches-stripe' as const,
      workItemId: null,
      openedAtMs: T0,
      openedByRunId: runId,
    });
    const results = await Promise.all([
      store.openBreak(ws, row('run-a'), 'a'),
      store.openBreak(ws, row('run-b'), 'b'),
      store.openBreak(ws, row('run-c'), 'c'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.listOpenBreaks(ws)).toHaveLength(1);
  });

  it('records a run once, even when the workflow step is retried', async () => {
    const ws = `recon-retry-${Date.now()}`;
    const h = harness(ws);
    const record = await runReconciliation(
      { workspaceId: ws, mode: 'final', entries: [], sources: sources({ outstandingCreditCents:0 }), startedAtMs: T0 },
      h.deps(),
    );
    await pgReconciliationStore(db.adminSql).recordRun(record);
    const status = await readReconciliationStatus(ws, { sql: db.adminSql });
    expect(status.recent).toHaveLength(1);
    expect(status.latestFinal?.runId).toBe(record.runId);
    expect(status.latestFinal?.month).toBe('2026-09');
    expect(status.latest?.gateOpen).toBe(true);
    expect(status.latest?.gatePublished).toBe(true);
  });
});

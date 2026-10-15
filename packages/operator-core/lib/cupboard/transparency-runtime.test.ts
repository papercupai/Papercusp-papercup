/**
 * P-044 (D-028 §3–5): the operator's transparency pass. Each tick pushes the
 * open month's provisional report with the latest anchored root, and says where
 * the closed month's statement stands. A statement is published once, signed by
 * the anchor key, pinned to the anchored root that covers the month end; a later
 * journal change is reported as drift and never overwrites what was published.
 */
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { StoredAnchor } from './ledger-anchor';
import { journalEntryForMovement, type JournalEntry, type MovementEntryInput } from './money-journal';
import type { InvariantVerdict } from './reconciliation';
import type { ReconciliationRunSummary, ReconciliationStatus } from './reconciliation-store';
import { monthPeriod } from './transparency-report';
import type { StatementAttestationPush } from './statement-attestation-push';
import { anchorCovering, latestAnchor, type StatementDrift, type StatementPublish, type TransparencyWorker } from './transparency-publish';
import { runTransparencyPass } from './transparency-runtime';
import { verifySignedStatement, type LiveTransparencyPush, type SignedStatement } from './transparency-statement';

const WS = 'ws-transparency';
// 2026-10-01 10:00Z: October is open, September is the closed month.
const NOW = Date.UTC(2026, 9, 1, 10);
const SEPT_END_S = Date.UTC(2026, 9, 1) / 1000;

function entry(input: Omit<MovementEntryInput, 'currency'>): JournalEntry {
  const r = journalEntryForMovement({ currency: 'USD', ...input });
  if (!r.ok) throw new Error(`fixture entry rejected: ${JSON.stringify(r)}`);
  return r.entry;
}
const payment = (id: string, occurredAtMs: number, grossCents: number) =>
  entry({
    entryId: id,
    occurredAtMs,
    externalRef: { kind: 'stripe-balance-transaction', id: `txn_${id}` },
    movement: { kind: 'customer-payment', grossCents, feeCents: 300, taxCents: 0, daoCents: grossCents / 10, refundReserveCents: 0 },
  });

const SEPT_PAY = payment('sept', Date.UTC(2026, 8, 3), 10_000);
const OCT_PAY = payment('oct', Date.UTC(2026, 9, 1, 2), 4_000);

function anchor(seq: number, windowEnd: number): StoredAnchor {
  return {
    anchorSeq: seq,
    logId: `ledger-anchor:${WS}`,
    logRoot: seq.toString(16).padStart(64, '0'),
    treeSize: seq * 3,
    windowStart: windowEnd - 3600,
    windowEnd,
    backend: 'eas',
    chainId: 84532,
    ref: `0x${seq.toString(16).padStart(64, 'a')}`,
    txHash: `0x${seq.toString(16).padStart(64, 'b')}`,
    attester: '0x' + 'c'.repeat(40),
    consistencyFrom: (seq - 1) * 3,
    consistencyProof: [],
  };
}
// Hours ending 23:00 Sept 30, 00:00 Oct 1 (covers month end), 09:00 Oct 1 (latest).
const ANCHORS = [anchor(1, SEPT_END_S - 3600), anchor(2, SEPT_END_S), anchor(3, SEPT_END_S + 9 * 3600)];

const ok = (invariant: InvariantVerdict['invariant']): InvariantVerdict => ({ invariant, status: 'ok', detail: 'holds' });
function finalRun(verdicts: InvariantVerdict[], month = '2026-09'): ReconciliationRunSummary {
  return {
    runId: `final-${month}`,
    mode: 'final',
    month,
    startedAt: '2026-10-01T00:30:00.000Z',
    finishedAt: '2026-10-01T00:31:00.000Z',
    gateOpen: true,
    gateReasons: [],
    gatePublished: true,
    gatePublishDetail: null,
    verdicts,
    opened: [],
    resolved: [],
  };
}
const CLEAN = finalRun([
  ok('credit-reserve-covers-outstanding-credits'),
  ok('dao-payable-equals-accrued-minus-transferred'),
  { invariant: 'safe-balance-equals-receipts-minus-approved-spends', status: 'not-configured', detail: 'no Safe deployed' },
  ok('journal-matches-stripe'),
]);
const status = (latestFinal: ReconciliationRunSummary | null, openBreaks: ReconciliationStatus['openBreaks'] = []): ReconciliationStatus => ({
  workspaceId: WS,
  latest: latestFinal,
  latestFinal,
  recent: latestFinal ? [latestFinal] : [],
  openBreaks,
});

/** An in-memory Worker with the real first-publication-wins rule. */
function memoryWorker() {
  const live: LiveTransparencyPush[] = [];
  const statements = new Map<string, SignedStatement>();
  const attestations: StatementAttestationPush[] = [];
  const worker: TransparencyWorker = {
    async pushLive(push) {
      live.push(push);
      return { ok: true, stored: 'stored' };
    },
    async readStatement(ws, month) {
      return statements.get(`${ws}/${month}`) ?? null;
    },
    async publishStatement(signed): Promise<StatementPublish> {
      const k = `${signed.statement.report.workspaceId}/${signed.statement.report.month}`;
      const existing = statements.get(k);
      if (existing) return existing.digest === signed.digest ? 'unchanged' : { conflict: existing.digest };
      statements.set(k, signed);
      return 'created';
    },
    async publishAttestation(push) {
      attestations.push(push);
      return 'created';
    },
  };
  return { worker, live, statements, attestations };
}

function pass(input: {
  worker: TransparencyWorker | null;
  entries?: JournalEntry[];
  st?: ReconciliationStatus;
  anchors?: readonly StoredAnchor[];
  key?: `0x${string}` | null;
  drifts?: StatementDrift[];
  attestations?: StatementAttestationPush[];
}) {
  const drifts = input.drifts ?? [];
  return runTransparencyPass({
    workspaces: [WS],
    worker: input.worker,
    attestations: async () => input.attestations ?? [],
    now: () => NOW,
    readEntries: async () => input.entries ?? [SEPT_PAY, OCT_PAY],
    readReconciliation: async () => input.st ?? status(CLEAN),
    anchors: async () => input.anchors ?? ANCHORS,
    signingKey: () =>
      input.key ? { ok: true, privateKey: input.key } : { ok: false, reason: 'key-missing', detail: 'no anchor key in this test' },
    drift: async (d) => {
      drifts.push(d);
    },
  });
}

describe('anchor selection', () => {
  it('the live report points at the newest root; the statement at the FIRST root covering the month end', () => {
    expect(latestAnchor(ANCHORS)?.anchorSeq).toBe(3);
    expect(anchorCovering(ANCHORS, monthPeriod('2026-09').untilMs)?.anchorSeq).toBe(2);
    expect(anchorCovering(ANCHORS.slice(0, 1), monthPeriod('2026-09').untilMs)).toBeNull();
    expect(latestAnchor([])).toBeNull();
  });
});

describe('runTransparencyPass (P-044)', () => {
  it('publishes a completed folded pair while keeping the next one-payment hour out of all live figures', async () => {
    const second = payment('octsecond', OCT_PAY.occurredAtMs + 3_600_000, 6_000);
    const third = payment('octthird', OCT_PAY.occurredAtMs + 2 * 3_600_000, 8_000);
    const w = memoryWorker();
    await pass({ worker: w.worker, entries: [SEPT_PAY, OCT_PAY, second, third] });
    expect(w.live[0]!.report).toMatchObject({ entryCount: 2, revenueCents: 9_000, daoShareCents: 1_000, disclosure: { status: 'folded' } });
    expect(w.live[0]!.report.accounts.find((a) => a.account === 'operating')?.debitCents).toBe(9_400);
  });

  it('pushes the open month, provisional, with the latest anchored root, and publishes the clean closed month once', async () => {
    const key = generatePrivateKey();
    const w = memoryWorker();
    const r = await pass({ worker: w.worker, key });

    expect(r.workerUnavailable).toBeNull();
    const ws = r.workspaces[0]!;
    expect(ws).toMatchObject({ workspaceId: WS, month: '2026-10', live: { pushed: true, stored: 'stored' }, drift: null, error: null });

    const live = w.live[0]!;
    // October only: the September payment is the statement's, not the live layer's.
    expect(live.report).toMatchObject({ kind: 'live', month: '2026-10', provisional: true, entryCount: 0, revenueCents: 0, disclosure: { status: 'folded' } });
    expect(live.report.latestAnchor).toMatchObject({ logRoot: ANCHORS[2]!.logRoot, txHash: ANCHORS[2]!.txHash });
    expect(live.report.treasury).toEqual({ status: 'not-measured', reason: expect.stringContaining('WI-10004708') });

    // The statement covers September only, pins the root covering Sept 30 24:00, and verifies to the key.
    const signed = w.statements.get(`${WS}/2026-09`)!;
    expect(signed.statement.report).toMatchObject({ kind: 'monthly-statement', month: '2026-09', provisional: false, entryCount: 1 });
    expect(signed.statement.report.latestAnchor?.logRoot).toBe(ANCHORS[1]!.logRoot);
    expect(signed.statement.reconciliation.runId).toBe('final-2026-09');
    expect(signed.signer).toBe(privateKeyToAccount(key).address);
    expect(await verifySignedStatement(signed)).toEqual({ ok: true });
    expect(live.statementStatus).toEqual({ status: 'published', month: '2026-09', digest: signed.digest, withheldBy: [], detail: 'published (created)' });

    // The next tick re-derives the same digest: nothing new is signed or published.
    const again = await pass({ worker: w.worker, key });
    expect(again.workspaces[0]!.statement).toMatchObject({ status: 'published', digest: signed.digest, detail: 'published' });
    expect(w.statements.size).toBe(1);
  });

  it('a journal change after publication is reported as drift, filed once per tick, and never overwrites the published statement', async () => {
    const key = generatePrivateKey();
    const w = memoryWorker();
    await pass({ worker: w.worker, key });
    const published = w.statements.get(`${WS}/2026-09`)!;

    const drifts: StatementDrift[] = [];
    const late = payment('late', Date.UTC(2026, 8, 29), 700);
    const r = await pass({ worker: w.worker, key, entries: [SEPT_PAY, late, OCT_PAY], drifts });
    const ws = r.workspaces[0]!;
    expect(ws.statement).toMatchObject({ status: 'published', digest: published.digest });
    expect(ws.statement.detail).toContain('the published statement stands');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ workspaceId: WS, month: '2026-09', publishedDigest: published.digest });
    expect(drifts[0]!.recomputedDigest).not.toBe(published.digest);
    expect(w.statements.get(`${WS}/2026-09`)).toBe(published);
  });

  it('withholds the statement when the final run broke an invariant or could not evaluate a mandated one, naming them and the open breaks', async () => {
    const w = memoryWorker();
    const broken = finalRun([
      { invariant: 'dao-payable-equals-accrued-minus-transferred', status: 'broken', detail: 'off by 100' },
      { invariant: 'credit-reserve-covers-outstanding-credits', status: 'unknown', detail: 'Worker unreadable' },
      ok('journal-matches-stripe'),
    ]);
    const openBreaks = [
      { invariant: 'dao-payable-equals-accrued-minus-transferred' as const, workItemId: 'EI-1', openedAt: '', openedByRunId: 'final-2026-09', lastRunId: 'final-2026-09', detail: 'off by 100' },
    ];
    const r = await pass({ worker: w.worker, key: generatePrivateKey(), st: status(broken, openBreaks) });
    const s = r.workspaces[0]!.statement;
    expect(s.status).toBe('withheld');
    expect(s.withheldBy).toEqual(['dao-payable-equals-accrued-minus-transferred:broken', 'credit-reserve-covers-outstanding-credits:unknown']);
    expect(s.detail).toContain('open breaks: dao-payable-equals-accrued-minus-transferred');
    expect(w.statements.size).toBe(0);
    // The live layer still goes out, carrying the withheld status.
    expect(w.live[0]!.statementStatus.status).toBe('withheld');
  });

  it('keeps the statement pending without a final run, without a covering anchor, or without a signing key', async () => {
    const noFinal = await pass({ worker: memoryWorker().worker, key: generatePrivateKey(), st: status(null) });
    expect(noFinal.workspaces[0]!.statement).toMatchObject({ status: 'pending', month: '2026-09' });
    expect(noFinal.workspaces[0]!.statement.detail).toContain('final) reconciliation run for 2026-09');

    const staleFinal = await pass({ worker: memoryWorker().worker, key: generatePrivateKey(), st: status(finalRun([ok('journal-matches-stripe')], '2026-08')) });
    expect(staleFinal.workspaces[0]!.statement).toMatchObject({ status: 'pending', month: '2026-09' });

    const noAnchor = await pass({ worker: memoryWorker().worker, key: generatePrivateKey(), anchors: ANCHORS.slice(0, 1) });
    expect(noAnchor.workspaces[0]!.statement).toMatchObject({ status: 'pending', month: '2026-09' });
    expect(noAnchor.workspaces[0]!.statement.detail).toContain('anchored root whose window ends at or after 2026-10-01T00:00:00.000Z');

    const w = memoryWorker();
    const noKey = await pass({ worker: w.worker, key: null });
    expect(noKey.workspaces[0]!.statement).toMatchObject({ status: 'pending', detail: expect.stringContaining('no signing key') });
    expect(w.statements.size).toBe(0);
  });

  it('reports none when no month has closed with journal activity', async () => {
    const r = await pass({ worker: memoryWorker().worker, key: generatePrivateKey(), entries: [OCT_PAY], st: status(null) });
    expect(r.workspaces[0]!.statement).toMatchObject({ status: 'none', month: null });
  });

  it('pushes nothing without a Worker and says why', async () => {
    const r = await runTransparencyPass({
      workspaces: [WS],
      config: {
        stripeSecretKeyRef: null,
        stripeJournalWorkspace: null,
        treasuryWorkspace: null,
        policy: null,
        policyError: null,
        gateSecretRef: null,
        cupboardUrl: 'http://cupboard.invalid',
        chainRpcUrl: null,
        safe: { status: 'not-configured' },
      },
      now: () => NOW,
      readEntries: async () => [SEPT_PAY],
      readReconciliation: async () => status(CLEAN),
      anchors: async () => ANCHORS,
      signingKey: () => ({ ok: true, privateKey: generatePrivateKey() }),
      drift: async () => undefined,
    });
    expect(r.workerUnavailable).toBe('PAPERCUSP_RECONCILIATION_GATE_SECRET_REF is not configured');
    expect(r.workspaces[0]!.live).toEqual({ pushed: false, detail: 'PAPERCUSP_RECONCILIATION_GATE_SECRET_REF is not configured' });
    expect(r.workspaces[0]!.statement.status).toBe('pending');
  });

  it('a workspace whose sources fail is reported, and the other workspaces still push', async () => {
    const w = memoryWorker();
    const r = await runTransparencyPass({
      workspaces: ['broken-ws', WS],
      worker: w.worker,
      now: () => NOW,
      readEntries: async (ws) => {
        if (ws === 'broken-ws') throw new Error('journal unreadable');
        return [SEPT_PAY];
      },
      readReconciliation: async () => status(CLEAN),
      anchors: async () => ANCHORS,
      signingKey: () => ({ ok: true, privateKey: generatePrivateKey() }),
      drift: async () => undefined,
    });
    expect(r.workspaces[0]).toMatchObject({ workspaceId: 'broken-ws', error: 'journal unreadable', live: { pushed: false } });
    expect(r.workspaces[1]).toMatchObject({ workspaceId: WS, error: null, live: { pushed: true } });
  });
});

/**
 * agent-economy-flywheel-2026-08-30 P-046 (D-029), integration layer: payment
 * receipts on real Postgres (migration 1297) chained into ledger_chain_links.
 *
 * Real: Postgres with every migration applied, the receipt store, the
 * append-only trigger, the stripe.payment-receipts chain stream. Substituted:
 * the anchor store and chain backend (in memory) — anchoring on Postgres is
 * covered by ledger-anchor.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { HOUR_SECONDS, memoryLedgerAnchorStore, runAnchorTick, type AnchorLinkFeed, type AnchoredRoot } from './ledger-anchor';
import { pgLedgerChainLinkStore, verifyLedger } from './ledger-chain';
import type { StripeBalanceTransaction } from './money-journal-producers';
import { PAYMENT_RECEIPT_STREAM_ID, verifyPaymentReceipt } from './payment-receipt';
import {
  customerPaymentReceipts,
  issuePaymentReceipt,
  paymentReceiptsLedgerSource,
  pgPaymentReceiptStore,
  recordPaymentReceipts,
} from './payment-receipt-store';

const WS = 'ws-p046-receipts';
const OTHER_WS = 'ws-p046-receipts-other';
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);
const ATTESTER = '0x00000000000000000000000000000000000a11ce';
let db: OrgTestDb;

function bt(id: string, amount: number, customer: string | null): StripeBalanceTransaction {
  return { id, type: 'charge', amount, fee: 30, currency: 'usd', created: T0 + 120, source: { id: `ch_${id}`, object: 'charge', customer } };
}

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 6 });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('payment receipts on Postgres (P-046, D-029)', () => {
  it('records each balance transaction once, keeps its first salt, and chains only the commitment', async () => {
    const store = pgPaymentReceiptStore(db.adminSql);
    const chain = pgLedgerChainLinkStore(db.adminSql);
    const first = await recordPaymentReceipts(WS, [bt('txn_a', 1000, 'cus_1'), bt('txn_b', 2500, 'cus_2')], { store, chain });
    expect(first).toMatchObject({ recorded: 2, existing: 0, rejected: [], chained: 2 });
    const saltA = (await store.get(WS, 'txn_a'))!.salt;

    const again = await recordPaymentReceipts(WS, [bt('txn_a', 1000, 'cus_1'), bt('txn_c', 700, 'cus_1')], { store, chain });
    expect(again).toMatchObject({ recorded: 1, existing: 1, chained: 1 });
    expect((await store.get(WS, 'txn_a'))!.salt).toBe(saltA);

    const rows = await store.list(WS);
    expect(rows.map((r) => r.transaction.id)).toEqual(['txn_a', 'txn_b', 'txn_c']);
    expect(rows[0]).toMatchObject({ sourceId: 'ch_txn_a', sourceCustomer: 'cus_1', transaction: { amount: 1000, fee: 30, currency: 'usd' } });

    // The chain holds commitments only, and it verifies against the receipts table.
    const links = await chain.links(WS, PAYMENT_RECEIPT_STREAM_ID);
    expect(links).toHaveLength(3);
    const linkText = JSON.stringify(links);
    expect(linkText).not.toContain('2500');
    expect(await verifyLedger(WS, paymentReceiptsLedgerSource(WS, store), chain)).toMatchObject({ ok: true });

    // Workspace isolation: another workspace sees none of it.
    expect(await store.list(OTHER_WS)).toEqual([]);
  });

  it('the database refuses an edit or a delete of a recorded receipt, and a malformed salt', async () => {
    await expect(db.adminSql`UPDATE harness_shared.payment_receipts SET amount = 1 WHERE workspace_id = ${WS} AND balance_transaction_id = 'txn_a'`).rejects.toThrow();
    await expect(db.adminSql`DELETE FROM harness_shared.payment_receipts WHERE workspace_id = ${WS} AND balance_transaction_id = 'txn_a'`).rejects.toThrow();
    await expect(
      db.adminSql`INSERT INTO harness_shared.payment_receipts (workspace_id, balance_transaction_id, salt, commitment, amount, fee, currency, stripe_created)
                  VALUES (${WS}, 'txn_bad', 'not-hex', ${'0'.repeat(64)}, 1, 0, 'usd', 1)`,
    ).rejects.toThrow();
    const [{ amount }] = await db.adminSql<{ amount: string }[]>`
      SELECT amount::text AS amount FROM harness_shared.payment_receipts WHERE workspace_id = ${WS} AND balance_transaction_id = 'txn_a'`;
    expect(amount).toBe('1000');
  });

  it("issues a receipt from Postgres rows that verifies, and lists one customer's receipts newest first", async () => {
    const store = pgPaymentReceiptStore(db.adminSql);
    const chain = pgLedgerChainLinkStore(db.adminSql);
    const anchors = memoryLedgerAnchorStore();
    const records = new Map<string, AnchoredRoot>();
    const feed: AnchorLinkFeed = {
      links: async (ws) =>
        (await chain.links(ws, PAYMENT_RECEIPT_STREAM_ID)).map((s) => ({ streamId: s.link.streamId, seq: s.link.seq, entryHash: s.link.entryHash })),
    };
    // Chained but no anchor pass has taken the link into the log yet.
    expect(await issuePaymentReceipt(WS, 'txn_b', { store, chain, anchors })).toEqual({ ok: false, error: 'not-in-log' });
    const tick = await runAnchorTick({
      workspaceId: WS,
      logId: `papercusp:${WS}`,
      nowSeconds: T0 + HOUR_SECONDS + 5,
      store: anchors,
      feed,
      backend: {
        kind: 'fake-chain',
        async publish(p) {
          const ref = `0x${'1'.repeat(64)}`;
          records.set(ref, { ...p, attester: ATTESTER, revoked: false });
          return { backend: 'fake-chain', chainId: 84532, ref, txHash: `0x${'ab'.repeat(32)}`, attester: ATTESTER };
        },
      },
    });
    expect(tick.status).toBe('anchored');

    const issued = await issuePaymentReceipt(WS, 'txn_b', { store, chain, anchors });
    if (!issued.ok) throw new Error(`issue failed: ${issued.error}`);
    const reader = { read: async (ref: string) => records.get(ref) ?? null };
    await expect(verifyPaymentReceipt(issued.receipt, reader, { expectedAttester: ATTESTER })).resolves.toMatchObject({ ok: true, transaction: { id: 'txn_b', amount: 2500 } });
    expect(await issuePaymentReceipt(WS, 'txn_missing', { store, chain, anchors })).toEqual({ ok: false, error: 'unknown-transaction' });

    const mine = await customerPaymentReceipts(WS, 'cus_1', { store, chain, anchors });
    expect(mine.map((e) => e.balanceTransactionId)).toEqual(['txn_c', 'txn_a']);
    expect(mine.every((e) => e.result.ok)).toBe(true);
  });
});

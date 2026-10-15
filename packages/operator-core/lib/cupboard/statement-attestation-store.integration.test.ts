/**
 * agent-economy-flywheel-2026-08-30 P-047 (D-031), integration layer: statement
 * attestations on real Postgres (migration 1299) chained into ledger_chain_links.
 *
 * Real: Postgres with every migration applied, the attestation store, the
 * append-only trigger, the transparency.statement-attestations chain stream.
 * Substituted: the Worker (a published signed statement in memory), the anchor
 * store and chain backend (in memory); anchoring on Postgres is covered by
 * ledger-anchor.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { HOUR_SECONDS, memoryLedgerAnchorStore, runAnchorTick, type AnchorLinkFeed, type AnchoredRoot } from './ledger-anchor';
import { pgLedgerChainLinkStore, verifyLedger } from './ledger-chain';
import { STATEMENT_ATTESTATION_STREAM_ID, attestationDocumentSha256, verifyStatementAttestation } from './statement-attestation';
import {
  listStatementAttestations,
  pgStatementAttestationStore,
  recordStatementAttestation,
  statementAttestationProof,
  statementAttestationsLedgerSource,
} from './statement-attestation-store';
import type { MonthlyStatement } from './transparency-report';
import { signStatement } from './transparency-statement';

const WS = 'ws-p047-attest';
const OTHER_WS = 'ws-p047-attest-other';
const LOG_ID = `papercusp:${WS}`;
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);
const ATTESTER = '0x00000000000000000000000000000000000a11ce';
const DOC_SHA = attestationDocumentSha256(new TextEncoder().encode('signed attestation, September 2026'));
let db: OrgTestDb;

const statement = {
  report: {
    kind: 'statement',
    workspaceId: WS,
    month: '2026-09',
    latestAnchor: { logId: LOG_ID, logRoot: 'cd'.repeat(32), treeSize: 1, windowEnd: T0, backend: 'fake-chain', chainId: 84532, ref: '0xmonthroot', txHash: null },
  },
  reconciliation: { runId: 'run-1', finishedAt: '2026-10-01T00:30:00.000Z', verdicts: [] },
} as unknown as MonthlyStatement;

const INPUT = {
  month: '2026-09',
  documentSha256: DOC_SHA,
  attestorName: 'A. Accountant',
  attestedOn: '2026-10-05',
  scope: ['stripe-balance-transactions', 'stripe-payouts'],
  recordedBy: 'su-test',
};

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 6 });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('statement attestations on Postgres (P-047, D-031)', () => {
  it('stores the record once, chains it, refuses mutation, and proves it once anchored', async () => {
    const signed = await signStatement(statement, `0x${'11'.repeat(32)}`);
    const worker = { readStatement: async (_ws: string, month: string) => (month === '2026-09' ? signed : null) };
    const store = pgStatementAttestationStore(db.adminSql);
    const chain = pgLedgerChainLinkStore(db.adminSql);

    const first = await recordStatementAttestation(WS, INPUT, { store, chain, worker });
    expect(first).toMatchObject({ ok: true, created: true, chained: 1 });
    const again = await recordStatementAttestation(WS, INPUT, { store, chain, worker });
    expect(again).toMatchObject({ ok: true, created: false, chained: 0 });

    const rows = await db.adminSql<{ month: string; scope: string[]; recorded_by: string }[]>`
      SELECT month, scope, recorded_by FROM harness_shared.statement_attestations WHERE workspace_id = ${WS}`;
    expect(rows).toEqual([{ month: '2026-09', scope: ['stripe-balance-transactions', 'stripe-payouts'], recorded_by: 'su-test' }]);
    expect(await listStatementAttestations(OTHER_WS, undefined, { store })).toHaveLength(0);

    // Append-only: the trigger refuses an edit to an attestation.
    await expect(db.adminSql`UPDATE harness_shared.statement_attestations SET attestor_name = 'Someone Else' WHERE workspace_id = ${WS}`).rejects.toThrow();

    // The chain verifies against the stored records.
    const report = await verifyLedger(WS, statementAttestationsLedgerSource(WS, store), chain);
    expect(report.ok).toBe(true);

    // Anchor the stream, then prove and verify the attestation.
    const anchors = memoryLedgerAnchorStore();
    const roots = new Map<string, AnchoredRoot>();
    const feed: AnchorLinkFeed = {
      links: async (ws) =>
        (await chain.links(ws, STATEMENT_ATTESTATION_STREAM_ID)).map((s) => ({ streamId: s.link.streamId, seq: s.link.seq, entryHash: s.link.entryHash })),
    };
    const tick = await runAnchorTick({
      workspaceId: WS,
      logId: LOG_ID,
      nowSeconds: T0 + HOUR_SECONDS + 5,
      store: anchors,
      feed,
      backend: {
        kind: 'fake-chain',
        async publish(p) {
          roots.set('0xroot', { ...p, attester: ATTESTER, revoked: false });
          return { backend: 'fake-chain', chainId: 84532, ref: '0xroot', txHash: null, attester: ATTESTER };
        },
      },
    });
    expect(tick.status).toBe('anchored');
    const proof = await statementAttestationProof(WS, '2026-09', DOC_SHA, { store, chain, anchors });
    if (!proof.ok) throw new Error(`proof: ${proof.error}`);
    const verdict = await verifyStatementAttestation(proof.proof, { read: async (ref) => roots.get(ref) ?? null }, { documentSha256: DOC_SHA });
    expect(verdict).toMatchObject({ ok: true, documentMatches: true, scopeMissing: ['bank-feed'] });
  });
});

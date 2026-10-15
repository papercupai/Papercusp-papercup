import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HOUR_SECONDS,
  memoryLedgerAnchorStore,
  runAnchorTick,
  type AnchorBackend,
  type AnchorLinkFeed,
  type AnchorPublication,
  type AnchorReader,
  type AnchoredRoot,
} from './ledger-anchor';
import { memoryLedgerChainLinkStore } from './ledger-chain';
import {
  STATEMENT_ATTESTATION_STREAM_ID,
  attestationDocumentSha256,
  attestationInputProblem,
  verifyStatementAttestation,
  type StatementAttestationInput,
  type StatementAttestationProof,
} from './statement-attestation';
import {
  memoryStatementAttestationStore,
  recordStatementAttestation,
  statementAttestationProof,
} from './statement-attestation-store';
import type { MonthlyStatement } from './transparency-report';
import { signStatement, statementDigest, type SignedStatement } from './transparency-statement';

const WS = 'ws-attest';
const LOG_ID = `papercusp:${WS}`;
const KEY = `0x${'11'.repeat(32)}` as const;
const ATTESTER = '0x00000000000000000000000000000000000a11ce';
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);
const DOCUMENT = new TextEncoder().encode('I attest the September statement matches Stripe and the bank feed. — A. Accountant');
const DOC_SHA = attestationDocumentSha256(DOCUMENT);

const MONTH_ROOT = {
  logId: LOG_ID,
  logRoot: 'cd'.repeat(32),
  treeSize: 1,
  windowEnd: T0,
  backend: 'fake-chain',
  chainId: 84532,
  ref: '0xmonthroot',
  txHash: null,
};

/** A minimal statement: signing and the attestation read only `report.latestAnchor`. */
function statement(latestAnchor: typeof MONTH_ROOT | null = MONTH_ROOT): MonthlyStatement {
  return {
    report: { kind: 'statement', workspaceId: WS, month: '2026-09', latestAnchor },
    reconciliation: { runId: 'run-1', finishedAt: '2026-10-01T00:30:00.000Z', verdicts: [] },
  } as unknown as MonthlyStatement;
}

const INPUT: StatementAttestationInput = {
  month: '2026-09',
  documentSha256: DOC_SHA,
  attestorName: '  A. Accountant ',
  attestorFirm: 'Example CPA LLP',
  attestedOn: '2026-10-05',
  scope: ['bank-feed', 'stripe-balance-transactions', 'stripe-payouts'],
};

function workerWith(signed: SignedStatement | null) {
  return { readStatement: async (_ws: string, month: string) => (signed && month === '2026-09' ? signed : null) };
}

function fakeChain(): { backend: AnchorBackend; reader: AnchorReader } {
  const records = new Map<string, AnchoredRoot>();
  let n = 0;
  return {
    backend: {
      kind: 'fake-chain',
      async publish(p: AnchorPublication) {
        n += 1;
        const ref = '0x' + createHash('sha256').update(`uid-${n}`).digest('hex');
        records.set(ref, { ...p, attester: ATTESTER, revoked: false });
        return { backend: 'fake-chain', chainId: 84532, ref, txHash: `0x${'ab'.repeat(32)}`, attester: ATTESTER };
      },
    },
    reader: { read: async (ref) => records.get(ref) ?? null },
  };
}

async function world(signed: SignedStatement | null) {
  const store = memoryStatementAttestationStore();
  const chain = memoryLedgerChainLinkStore();
  const anchors = memoryLedgerAnchorStore();
  const worker = workerWith(signed);
  const feed: AnchorLinkFeed = {
    links: async (ws) =>
      (await chain.links(ws, STATEMENT_ATTESTATION_STREAM_ID)).map((s) => ({ streamId: s.link.streamId, seq: s.link.seq, entryHash: s.link.entryHash })),
  };
  const fake = fakeChain();
  const anchor = () => runAnchorTick({ workspaceId: WS, logId: LOG_ID, nowSeconds: T0 + HOUR_SECONDS + 5, store: anchors, feed, backend: fake.backend });
  return { store, chain, anchors, worker, anchor, reader: fake.reader, deps: { store, chain, anchors } };
}

describe('attestationInputProblem', () => {
  it('accepts a complete input', () => {
    expect(attestationInputProblem(INPUT)).toBeNull();
  });

  it('names each malformed field', () => {
    expect(attestationInputProblem({ ...INPUT, month: '2026-13' })).toMatch(/month/);
    expect(attestationInputProblem({ ...INPUT, documentSha256: 'ABC' })).toMatch(/documentSha256/);
    expect(attestationInputProblem({ ...INPUT, attestorName: '   ' })).toMatch(/attestorName/);
    expect(attestationInputProblem({ ...INPUT, attestedOn: '2026-08-31' })).toMatch(/before the attested month/);
    expect(attestationInputProblem({ ...INPUT, scope: [] })).toMatch(/scope/);
    expect(attestationInputProblem({ ...INPUT, scope: ['stripe-payouts', 'vibes'] })).toMatch(/unknown scope vibes/);
  });
});

describe('recordStatementAttestation', () => {
  it('refuses a month with no published statement', async () => {
    const w = await world(null);
    const r = await recordStatementAttestation(WS, INPUT, { ...w.deps, worker: w.worker });
    expect(r).toMatchObject({ ok: false, error: 'statement-not-published' });
    expect(await w.store.list(WS)).toHaveLength(0);
  });

  it('refuses a statement whose signature does not verify', async () => {
    const signed = await signStatement(statement(), KEY);
    const tampered = { ...signed, statement: statement({ ...MONTH_ROOT, treeSize: 2 }) };
    const w = await world(tampered);
    const r = await recordStatementAttestation(WS, INPUT, { ...w.deps, worker: w.worker });
    expect(r).toMatchObject({ ok: false, error: 'statement-signature-invalid' });
  });

  it('refuses when the document names a different statement digest', async () => {
    const w = await world(await signStatement(statement(), KEY));
    const r = await recordStatementAttestation(WS, { ...INPUT, expectedStatementDigest: 'ee'.repeat(32) }, { ...w.deps, worker: w.worker });
    expect(r).toMatchObject({ ok: false, error: 'statement-digest-mismatch' });
  });

  it('refuses a statement that names no month root', async () => {
    const w = await world(await signStatement(statement(null), KEY));
    const r = await recordStatementAttestation(WS, INPUT, { ...w.deps, worker: w.worker });
    expect(r).toMatchObject({ ok: false, error: 'statement-has-no-month-root' });
  });

  it('records the public record bound to the published statement and chains it once', async () => {
    const signed = await signStatement(statement(), KEY);
    const w = await world(signed);
    const first = await recordStatementAttestation(WS, { ...INPUT, expectedStatementDigest: statementDigest(signed.statement) }, { ...w.deps, worker: w.worker });
    expect(first).toMatchObject({ ok: true, created: true, chained: 1 });
    if (!first.ok) throw new Error('unreachable');
    expect(first.attestation).toMatchObject({
      month: '2026-09',
      statementDigest: statementDigest(signed.statement),
      monthRoot: { logId: LOG_ID, treeSize: 1, logRoot: MONTH_ROOT.logRoot, ref: MONTH_ROOT.ref },
      documentSha256: DOC_SHA,
      attestor: { name: 'A. Accountant', firm: 'Example CPA LLP' },
      scope: ['stripe-balance-transactions', 'stripe-payouts', 'bank-feed'],
    });
    const again = await recordStatementAttestation(WS, INPUT, { ...w.deps, worker: w.worker });
    expect(again).toMatchObject({ ok: true, created: false, chained: 0 });
    expect(await w.chain.links(WS, STATEMENT_ATTESTATION_STREAM_ID)).toHaveLength(1);
  });
});

describe('statementAttestationProof + verifyStatementAttestation', () => {
  async function anchoredProof(scope: readonly string[] = INPUT.scope) {
    const w = await world(await signStatement(statement(), KEY));
    const recorded = await recordStatementAttestation(WS, { ...INPUT, scope }, { ...w.deps, worker: w.worker });
    expect(recorded.ok).toBe(true);
    const before = await statementAttestationProof(WS, '2026-09', DOC_SHA, w.deps);
    expect(before.ok).toBe(false);
    expect(['not-in-log', 'not-yet-anchored']).toContain(before.ok ? null : before.error);
    expect((await w.anchor()).status).toBe('anchored');
    const proof = await statementAttestationProof(WS, '2026-09', undefined, w.deps);
    if (!proof.ok) throw new Error(`proof: ${proof.error}`);
    return { proof: proof.proof, reader: w.reader };
  }

  it('verifies an anchored attestation against the document in hand', async () => {
    const { proof, reader } = await anchoredProof();
    const v = await verifyStatementAttestation(proof, reader, { documentSha256: attestationDocumentSha256(DOCUMENT), expectedAttester: ATTESTER });
    expect(v).toMatchObject({ ok: true, documentMatches: true, attester: ATTESTER, scopeMissing: [] });
  });

  it('reports the scopes an accountant did not attest', async () => {
    const { proof, reader } = await anchoredProof(['stripe-payouts', 'stripe-balance-transactions']);
    const v = await verifyStatementAttestation(proof, reader);
    expect(v).toMatchObject({ ok: true, documentMatches: null, scopeMissing: ['bank-feed'] });
  });

  it('rejects a different document', async () => {
    const { proof, reader } = await anchoredProof();
    const other = attestationDocumentSha256(new TextEncoder().encode('a different letter'));
    expect(await verifyStatementAttestation(proof, reader, { documentSha256: other })).toEqual({ ok: false, reason: 'document-mismatch' });
  });

  it('rejects a record that is not the entry the bundle proves', async () => {
    const { proof, reader } = await anchoredProof();
    const forged: StatementAttestationProof = { ...proof, attestation: { ...proof.attestation, attestor: { name: 'Someone Else', firm: null } } };
    expect(await verifyStatementAttestation(forged, reader)).toEqual({ ok: false, reason: 'entry-mismatch' });
  });

  it('rejects a record rewritten consistently in both places (the link no longer matches)', async () => {
    const { proof, reader } = await anchoredProof();
    const attestation = { ...proof.attestation, attestor: { name: 'Someone Else', firm: null } };
    const forged: StatementAttestationProof = { ...proof, attestation, bundle: { ...proof.bundle, entry: attestation } };
    const v = await verifyStatementAttestation(forged, reader);
    expect(v.ok).toBe(false);
    expect(v.ok ? null : v.reason).toBe('entry-mismatch');
  });

  it('rejects an attestation anchored in another log or before the month root', async () => {
    const { proof, reader } = await anchoredProof();
    const otherLog: StatementAttestationProof = { ...proof, bundle: { ...proof.bundle, logId: 'papercusp:elsewhere' } };
    expect(await verifyStatementAttestation(otherLog, reader)).toEqual({ ok: false, reason: 'not-the-month-log' });
    const attestation = { ...proof.attestation, monthRoot: { ...proof.attestation.monthRoot, treeSize: proof.bundle.treeSize + 1 } };
    const early: StatementAttestationProof = { ...proof, attestation, bundle: { ...proof.bundle, entry: attestation } };
    expect(await verifyStatementAttestation(early, reader)).toEqual({ ok: false, reason: 'anchored-before-month-root' });
  });

  it('rejects a malformed proof', async () => {
    const { proof, reader } = await anchoredProof();
    expect(await verifyStatementAttestation({ ...proof, format: 'nope' } as never, reader)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyStatementAttestation({ ...proof, attestation: { ...proof.attestation, scope: ['bank-feed', 'stripe-payouts'] } } as never, reader)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

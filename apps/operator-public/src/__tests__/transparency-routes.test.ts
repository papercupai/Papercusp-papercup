/**
 * P-044 (D-028 §3–4): the Worker stores the operator's signed pushes and serves
 * them publicly. A live report only moves forward; a monthly statement must verify
 * against its signer and is immutable once published. Real SQLite, real migrations.
 */
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
// The PG-free core of the operator's pass (the runtime adds only its Postgres / key-file defaults).
import { cupboardTransparencyWorker, publishTransparency } from '@papercusp/operator-core/lib/cupboard/transparency-publish.ts';
import {
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSPARENCY_LIVE_PATH,
  TRANSPARENCY_STATEMENT_PATH,
  signReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import { journalEntryForMovement, type JournalEntry } from '@papercusp/operator-core/lib/cupboard/money-journal.ts';
import { buildMonthlyStatement, buildTransparencyReport, monthPeriod, treasuryFigure } from '@papercusp/operator-core/lib/cupboard/transparency-report.ts';
import {
  signStatement,
  verifySignedStatement,
  type LiveTransparencyPush,
  type SignedStatement,
  type StatementStatus,
} from '@papercusp/operator-core/lib/cupboard/transparency-statement.ts';
import { appendLink, entryDigest } from '@papercusp/hash-chain';
import { ANCHOR_PROOF_FORMAT, anchorLeafHash } from '@papercusp/operator-core/lib/cupboard/ledger-anchor.ts';
import {
  STATEMENT_ATTESTATION_STREAM_ID,
  buildStatementAttestation,
  type StatementAttestation,
  type StatementAttestationProof,
} from '@papercusp/operator-core/lib/cupboard/statement-attestation.ts';
import { TRANSPARENCY_ATTESTATION_PATH } from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import { attestationProofPath } from '@papercusp/operator-core/lib/cupboard/statement-attestation-push.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';
import { readLiveReport, recordLiveReport } from '../transparency-store.ts';

// A low-entropy test key, not a credential.
const KEY = 't'.repeat(32);
const WS = 'ws-transparency';

function harness() {
  const { db } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  env.RECONCILIATION_GATE_SECRET = KEY;
  return { api: buildApi(), env };
}
type H = ReturnType<typeof harness>;

async function put(h: H, path: string, payload: unknown, key = KEY) {
  const body = JSON.stringify(payload);
  const signature = await signReconciliationRequest({ secret: key, method: 'PUT', pathname: path, body, nowMs: Date.now() });
  return h.api.request(path, { method: 'PUT', headers: { 'content-type': 'application/json', [RECONCILIATION_SIGNATURE_HEADER]: signature }, body }, h.env);
}
const get = (h: H, path: string) => h.api.request(path, { method: 'GET' }, h.env);

function journal(extraCents = 0): JournalEntry[] {
  const r = journalEntryForMovement({
    entryId: 'pay-1',
    occurredAtMs: Date.UTC(2026, 8, 3),
    currency: 'USD',
    externalRef: { kind: 'stripe-balance-transaction', id: 'txn_1' },
    movement: { kind: 'customer-payment', grossCents: 10_000 + extraCents, feeCents: 300, taxCents: 0, daoCents: 1_000, refundReserveCents: 0 },
  });
  if (!r.ok) throw new Error('fixture rejected');
  return [r.entry];
}

const treasury = treasuryFigure(null, 'not measured in this test');

const PENDING: StatementStatus = { status: 'pending', month: '2026-08', digest: null, withheldBy: [], detail: 'awaiting the month-close run' };

function liveReport(generatedAtMs: number, extraCents = 0): LiveTransparencyPush {
  const first = journal(extraCents)[0]!;
  const entries = [first, { ...first, entryId: 'pay-2', externalRef: { kind: 'stripe-balance-transaction' as const, id: 'txn_2' } }];
  const report = buildTransparencyReport({ workspaceId: WS, kind: 'live', entries, period: monthPeriod('2026-09'), provisional: true, treasury, latestAnchor: null });
  return { workspaceId: WS, month: '2026-09', generatedAtMs, report, statementStatus: PENDING };
}

function populationPush(generatedAtMs: number, count: number, suffix = ''): LiveTransparencyPush {
  const first = journal()[0]!;
  const entries = Array.from({ length: count }, (_,i) => ({ ...first, entryId: `pay-${i}${i < 2 ? '' : suffix}`, externalRef: { kind: 'stripe-balance-transaction' as const, id: `txn_${i}${i < 2 ? '' : suffix}` } }));
  return { workspaceId: WS, month: '2026-09', generatedAtMs, report: buildTransparencyReport({ workspaceId: WS, kind: 'live', entries, period: monthPeriod('2026-09'), provisional: true, treasury, latestAnchor: null }), statementStatus: PENDING };
}

async function statement(key: `0x${string}`, extraCents = 0): Promise<SignedStatement> {
  const b = buildMonthlyStatement({
    workspaceId: WS,
    entries: journal(extraCents),
    run: { runId: 'run-final', mode: 'final', month: '2026-09', finishedAt: '2026-10-01T00:30:00.000Z', verdicts: [{ invariant: 'journal-matches-stripe', status: 'ok' }] },
    treasury,
    latestAnchor: null,
  });
  if (!b.ok) throw new Error('expected a statement');
  return signStatement(b.statement, key);
}

describe('transparency routes (P-044)', () => {
  it('serves a folded one-payment window without any private payment figures', async () => {
    const h = harness();
    const sparse = populationPush(Date.now() - 1_000, 1);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, sparse)).status).toBe(200);
    const body = await (await get(h, `/transparency/${WS}`)).json() as { live: { report: LiveTransparencyPush['report'] } };
    expect(body.live.report).toMatchObject({ entryCount: 0, revenueCents: 0, daoShareCents: 0, revenueByStream: {}, disclosure: { status: 'folded', streams: {} } });
    expect(body.live.report.accounts.every((a) => a.debitCents === 0 && a.creditCents === 0 && a.netCents === 0)).toBe(true);
  });

  it('refuses one new payment and same-count corrections by differencing; a new pair is published', async () => {
    const h = harness();
    const t = Date.now() - 10_000;
    const pair = populationPush(t, 2);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, pair)).status).toBe(200);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, populationPush(t + 1, 3))).status).toBe(409);
    const unchanged = populationPush(t + 2, 2);
    const corrected = { ...unchanged, report: { ...unchanged.report, disclosure: { ...unchanged.report.disclosure!, streams: { ...unchanged.report.disclosure!.streams, 'customer-payment': { ...unchanged.report.disclosure!.streams['customer-payment']!, root: 'ab'.repeat(32) } } } } };
    expect((await put(h, TRANSPARENCY_LIVE_PATH, corrected)).status).toBe(409);
    expect((await readLiveReport(h.env.DB, WS))!.report.revenueCents).toBe(pair.report.revenueCents);
    const four = populationPush(t + 3, 4);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, four)).status).toBe(200);
    expect((await readLiveReport(h.env.DB, WS))!.report.revenueCents).toBe(four.report.revenueCents);
  });

  it('refuses legacy pushes and does not expose legacy stored live totals', async () => {
    const h = harness();
    const push = liveReport(Date.now() - 1_000);
    const { disclosure: _policy, ...legacy } = push.report;
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...push, report: legacy })).status).toBe(400);
    await h.env.DB.prepare('INSERT INTO transparency_live (workspace_id, month, report_json, statement_status_json, generated_at_ms, received_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(WS, push.month, JSON.stringify(legacy), JSON.stringify(PENDING), push.generatedAtMs, push.generatedAtMs).run();
    expect((await (await get(h, `/transparency/${WS}`)).json() as { live: unknown }).live).toBeNull();
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...push, generatedAtMs: push.generatedAtMs + 1 })).status).toBe(200);
    expect((await (await get(h, `/transparency/${WS}`)).json() as { live: unknown }).live).not.toBeNull();
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...push, month: '2026-99', report: { ...push.report, month: '2026-99' } })).status).toBe(400);
  });

  it('atomically checks the snapshot used by disclosure admission even for same-time racing publishers', async () => {
    const h = harness();
    const t = Date.now() - 1_000;
    const old = populationPush(t - 1, 2);
    expect(await recordLiveReport(h.env.DB, old, t, null)).toBe('stored');
    const previous = await readLiveReport(h.env.DB, WS);
    const a = populationPush(t, 4, 'a');
    const b = populationPush(t, 4, 'b');
    expect(await recordLiveReport(h.env.DB, a, t, previous)).toBe('stored');
    expect(await recordLiveReport(h.env.DB, b, t, previous)).toBe('stale');
    expect((await readLiveReport(h.env.DB, WS))!.report.entriesRoot).toBe(a.report.entriesRoot);
  });

  it('stores the live report and serves it publicly; a delayed older push never rolls it back', async () => {
    const h = harness();
    const t = Date.now() - 60_000;
    expect(await (await put(h, TRANSPARENCY_LIVE_PATH, liveReport(t, 500))).json()).toEqual({ ok: true, stored: 'stored' });
    expect(await (await put(h, TRANSPARENCY_LIVE_PATH, liveReport(t - 3_600_000))).json()).toEqual({ ok: true, stored: 'stale' });

    const res = await get(h, `/transparency/${WS}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { live: { month: string; generatedAtMs: number; report: { revenueCents: number; provisional: boolean }; statementStatus: StatementStatus }; statements: unknown[] };
    expect(body.live).toMatchObject({ month: '2026-09', generatedAtMs: t, report: { provisional: true }, statementStatus: PENDING });
    expect(body.live.report.revenueCents).toBe(liveReport(t, 500).report.revenueCents);
    expect(body.statements).toEqual([]);
  });

  it('refuses unsigned or mis-signed pushes and malformed live bodies', async () => {
    const h = harness();
    expect((await put(h, TRANSPARENCY_LIVE_PATH, liveReport(Date.now()), 'x'.repeat(32))).status).toBe(401);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...liveReport(Date.now()), month: 'Sept' })).status).toBe(400);
    const otherWs = liveReport(Date.now());
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...otherWs, workspaceId: 'someone-else' })).status).toBe(400);
    const { statementStatus: _omitted, ...noStatus } = liveReport(Date.now());
    expect((await put(h, TRANSPARENCY_LIVE_PATH, noStatus)).status).toBe(400);
    expect((await put(h, TRANSPARENCY_LIVE_PATH, { ...otherWs, statementStatus: { ...PENDING, status: 'final' } })).status).toBe(400);
    expect((await get(h, `/transparency/${WS}`)).status).toBe(404);
  });

  it('publishes a signed statement once; it verifies from the public read; a different digest is refused 409', async () => {
    const h = harness();
    const key = generatePrivateKey();
    const signed = await statement(key);
    expect(await (await put(h, TRANSPARENCY_STATEMENT_PATH, signed)).json()).toEqual({ ok: true, published: 'created', digest: signed.digest });
    expect(await (await put(h, TRANSPARENCY_STATEMENT_PATH, signed)).json()).toEqual({ ok: true, published: 'unchanged', digest: signed.digest });

    const drift = await statement(key, 1);
    const refused = await put(h, TRANSPARENCY_STATEMENT_PATH, drift);
    expect(refused.status).toBe(409);

    const pub = await get(h, `/transparency/${WS}/statements/2026-09`);
    expect(pub.status).toBe(200);
    const served = (await pub.json()) as SignedStatement;
    expect(served.digest).toBe(signed.digest);
    // A reader with nothing but the public JSON can verify it.
    expect(await verifySignedStatement(served)).toEqual({ ok: true });
    const index = (await (await get(h, `/transparency/${WS}`)).json()) as { statements: { month: string; digest: string; signer: string }[] };
    expect(index.statements).toEqual([
      { month: '2026-09', digest: signed.digest, signer: signed.signer, publishedAtMs: expect.any(Number), attestation: { status: 'not-attested' } },
    ]);
  });

  it('end to end: the operator pass publishes through the signed routes and a public reader verifies the statement to the anchor key', async () => {
    const h = harness();
    const key = generatePrivateKey();
    const nowMs = Date.UTC(2026, 9, 1, 10);
    const sept = journal();
    const septEnd = Date.UTC(2026, 9, 1) / 1000;
    const anchor = {
      anchorSeq: 1, logId: `ledger-anchor:${WS}`, logRoot: 'cd'.repeat(32), treeSize: 4, windowStart: septEnd - 3600, windowEnd: septEnd,
      backend: 'eas', chainId: 84532, ref: `0x${'e'.repeat(64)}`, txHash: `0x${'f'.repeat(64)}`, attester: null, consistencyFrom: 0, consistencyProof: [],
    };
    const finalRun = {
      runId: 'final-2026-09', mode: 'final' as const, month: '2026-09', startedAt: '2026-10-01T00:30:00.000Z', finishedAt: '2026-10-01T00:31:00.000Z',
      gateOpen: true, gateReasons: [], gatePublished: true, gatePublishDetail: null, opened: [], resolved: [],
      verdicts: [{ invariant: 'journal-matches-stripe' as const, status: 'ok' as const, detail: 'matches' }],
    };
    const worker = cupboardTransparencyWorker({
      baseUrl: 'https://cupboard.test',
      secret: KEY,
      // The signed PUTs carry real HMACs; the Worker checks them at its own clock.
      now: Date.now,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
        return h.api.request(`${u.pathname}${u.search}`, init ?? {}, h.env);
      }) as typeof fetch,
    });
    const run = () =>
      publishTransparency({
        workspaces: [WS],
        worker,
        workerUnavailable: null,
        now: () => nowMs,
        readEntries: async () => sept,
        readReconciliation: async () => ({ latestFinal: finalRun, openBreaks: [] }),
        anchors: async () => [anchor],
        treasury: async () => treasury,
        attestations: async () => [],
        signingKey: () => ({ ok: true, privateKey: key }),
        drift: async () => undefined,
      });

    const first = await run();
    expect(first.workspaces[0]).toMatchObject({ live: { pushed: true, stored: 'stored' }, statement: { status: 'published', month: '2026-09' }, error: null });
    const second = await run();
    expect(second.workspaces[0]!.statement).toMatchObject({ status: 'published', detail: 'published' });

    const page = (await (await get(h, `/transparency/${WS}`)).json()) as {
      live: { month: string; report: { kind: string; latestAnchor: { logRoot: string } | null }; statementStatus: StatementStatus };
      statements: { month: string; signer: string }[];
    };
    expect(page.live.month).toBe('2026-10');
    expect(page.live.report.latestAnchor?.logRoot).toBe(anchor.logRoot);
    expect(page.live.statementStatus).toMatchObject({ status: 'published', month: '2026-09' });
    expect(page.statements).toEqual([expect.objectContaining({ month: '2026-09', signer: privateKeyToAccount(key).address })]);

    const served = (await (await get(h, `/transparency/${WS}/statements/2026-09`)).json()) as SignedStatement;
    expect(await verifySignedStatement(served)).toEqual({ ok: true });
    expect(served.signer).toBe(privateKeyToAccount(key).address);
    expect(served.statement.report.latestAnchor?.txHash).toBe(anchor.txHash);
  });

  it('shows an attested month beside its statement: attestor, scopes, and a proof link once anchored (P-047, D-031)', async () => {
    const h = harness();
    const key = generatePrivateKey();
    const logId = `ledger-anchor:${WS}`;
    const monthRoot = { logId, logRoot: 'cd'.repeat(32), treeSize: 1, windowEnd: Date.UTC(2026, 9, 1) / 1000, backend: 'eas', chainId: 84532, ref: `0x${'e'.repeat(64)}`, txHash: null };
    const b = buildMonthlyStatement({
      workspaceId: WS,
      entries: journal(),
      run: { runId: 'run-final', mode: 'final', month: '2026-09', finishedAt: '2026-10-01T00:30:00.000Z', verdicts: [{ invariant: 'journal-matches-stripe', status: 'ok' }] },
      treasury,
      latestAnchor: monthRoot,
    });
    if (!b.ok) throw new Error('expected a statement');
    const signed = await signStatement(b.statement, key);
    const record = buildStatementAttestation({
      workspaceId: WS,
      statement: signed.statement,
      statementDigest: signed.digest,
      attestation: { month: '2026-09', documentSha256: 'ab'.repeat(32), attestorName: 'A. Accountant', attestorFirm: 'Example CPA LLP', attestedOn: '2026-10-05', scope: ['stripe-payouts', 'stripe-balance-transactions'] },
    });
    // A one-leaf anchor log: the record's chain link is leaf 0 and the root is its leaf hash.
    const link = appendLink(STATEMENT_ATTESTATION_STREAM_ID, null, entryDigest(record));
    const proofFor = (attestation: StatementAttestation, logRoot = anchorLeafHash(link)): StatementAttestationProof => ({
      format: 'papercusp.statement-attestation-proof',
      version: 1,
      attestation,
      bundle: {
        format: ANCHOR_PROOF_FORMAT, version: 1, logId, link, entry: attestation, leafIndex: 0, treeSize: 1, logRoot, proof: [],
        anchor: { backend: 'eas', chainId: 84532, ref: `0x${'a'.repeat(64)}`, txHash: null, attester: null, windowStart: 0, windowEnd: 3600 },
      },
    });
    const worker = cupboardTransparencyWorker({
      baseUrl: 'https://cupboard.test',
      secret: KEY,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => h.api.request(new URL(String(url)).pathname, init ?? {}, h.env)) as typeof fetch,
    });

    // No published statement yet: refused, and retrying cannot help.
    expect(await worker.publishAttestation({ workspaceId: WS, attestation: record, proof: null })).toMatchObject({ refused: expect.stringContaining('statement_not_published') });
    expect((await put(h, TRANSPARENCY_STATEMENT_PATH, signed)).status).toBe(200);

    // Recorded before the anchor run covers it: attested, proof awaiting the anchor.
    expect(await worker.publishAttestation({ workspaceId: WS, attestation: record, proof: null })).toBe('created');
    const page = async () => ((await (await get(h, `/transparency/${WS}`)).json()) as { statements: { month: string; attestation: Record<string, unknown> }[] }).statements[0]!.attestation;
    expect(await page()).toEqual({
      status: 'attested',
      attestations: [
        {
          attestor: { name: 'A. Accountant', firm: 'Example CPA LLP' },
          attestedOn: '2026-10-05',
          scope: ['stripe-balance-transactions', 'stripe-payouts'],
          scopeMissing: ['bank-feed'],
          documentSha256: 'ab'.repeat(32),
          statementDigest: signed.digest,
          proof: { status: 'awaiting-anchor' },
        },
      ],
    });

    // A proof whose root does not contain the leaf is refused; a real one is added once and linked.
    expect(await worker.publishAttestation({ workspaceId: WS, attestation: record, proof: proofFor(record, 'ef'.repeat(32)) })).toMatchObject({ refused: expect.stringContaining('not-included') });
    expect(await worker.publishAttestation({ workspaceId: WS, attestation: record, proof: proofFor(record) })).toBe('proof-added');
    expect(await worker.publishAttestation({ workspaceId: WS, attestation: record, proof: proofFor(record) })).toBe('unchanged');
    const url = attestationProofPath(WS, '2026-09', 'ab'.repeat(32));
    expect(await page()).toMatchObject({ status: 'attested', attestations: [{ proof: { status: 'anchored', url } }] });
    expect(await (await get(h, url)).json()).toEqual(JSON.parse(JSON.stringify(proofFor(record))));

    // The record is immutable, and must attest the statement readers see.
    const altered = { ...record, attestor: { name: 'Someone Else', firm: null } };
    expect(await worker.publishAttestation({ workspaceId: WS, attestation: altered, proof: null })).toMatchObject({ refused: expect.stringContaining('attestation_exists') });
    const otherStatement = { ...record, documentSha256: 'cd'.repeat(32), statementDigest: 'ee'.repeat(32) };
    expect(await worker.publishAttestation({ workspaceId: WS, attestation: otherStatement, proof: null })).toMatchObject({ refused: expect.stringContaining('statement_digest_mismatch') });
    expect((await put(h, TRANSPARENCY_ATTESTATION_PATH, { workspaceId: WS, attestation: { ...record, scope: ['vibes'] }, proof: null })).status).toBe(400);
    expect((await get(h, attestationProofPath(WS, '2026-09', 'cd'.repeat(32)))).status).toBe(404);
  });

  it('refuses a statement whose figures were altered after signing', async () => {
    const h = harness();
    const signed = await statement(generatePrivateKey());
    const tampered = { ...signed, statement: { ...signed.statement, report: { ...signed.statement.report, revenueCents: 1 } } };
    const res = await put(h, TRANSPARENCY_STATEMENT_PATH, tampered);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_statement', detail: 'digest does not match the statement' });
    expect((await get(h, `/transparency/${WS}/statements/2026-09`)).status).toBe(404);
  });
});

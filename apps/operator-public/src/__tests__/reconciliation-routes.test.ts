/**
 * P-043 (agent-economy-flywheel-2026-08-30, D-025 §4): the two HMAC-signed
 * routes the operator's reconciliation run uses, against REAL SQLite with the
 * shipped migrations applied.
 *
 * The signing helper is the same module the operator imports, so a drift in
 * the signed input (method, path, body, timestamp) fails here as well as there.
 */
import { describe, expect, it } from 'vitest';
import {
  LEDGER_CHAIN_LINKS_PATH,
  RECONCILIATION_INPUTS_PATH,
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSFER_GATE_PATH,
  parseReconciliationInputs,
  signReconciliationRequest,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import {
  HOUR_SECONDS, buildInclusionBundle, memoryLedgerAnchorStore, runAnchorTick, unionAnchorLinkFeed, verifyInclusionBundle,
  type AnchoredRoot, type AnchorInclusionBundle,
} from '@papercusp/operator-core/lib/cupboard/ledger-anchor.ts';
import { cupboardAnchorLinkFeed } from '@papercusp/operator-core/lib/cupboard/ledger-anchor-cupboard-feed.ts';
import { exportLedgerStream, witnessLedgerStream } from '../ledger-chain-store.ts';
import { parseChainExport } from '@papercusp/hash-chain';
import { buildApi } from '../routes/index.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

// A low-entropy test key, not a credential.
const KEY = 'k'.repeat(32);
const WS = 'ws-recon';

function harness(overrides: Record<string, string | undefined> = { RECONCILIATION_GATE_SECRET: KEY }) {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  env.RECONCILIATION_GATE_WORKSPACE = WS;
  Object.assign(env, overrides);
  return { api: buildApi(), raw, env };
}

type H = ReturnType<typeof harness>;

function gatePush(overrides: Record<string, unknown> = {}) {
  return { workspaceId: WS, open: true, reasons: [], runId: 'run-1', atMs: Date.now(), treasuryReconciled: true, ...overrides };
}

async function putGate(h: H, push: unknown, options: { key?: string; signedPath?: string; signedMethod?: string; nowMs?: number } = {}) {
  const body = JSON.stringify(push);
  const signature = await signReconciliationRequest({
    secret: options.key ?? KEY,
    method: options.signedMethod ?? 'PUT',
    pathname: options.signedPath ?? TRANSFER_GATE_PATH,
    body,
    nowMs: options.nowMs ?? Date.now(),
  });
  return h.api.request(
    TRANSFER_GATE_PATH,
    { method: 'PUT', headers: { 'content-type': 'application/json', [RECONCILIATION_SIGNATURE_HEADER]: signature }, body },
    h.env,
  );
}

async function getInputs(h: H, options: { signedPath?: string } = {}) {
  const signature = await signReconciliationRequest({
    secret: KEY,
    method: 'GET',
    pathname: options.signedPath ?? RECONCILIATION_INPUTS_PATH,
    body: '',
    nowMs: Date.now(),
  });
  return h.api.request(RECONCILIATION_INPUTS_PATH, { headers: { [RECONCILIATION_SIGNATURE_HEADER]: signature } }, h.env);
}

function gateRow(h: H) {
  return h.raw
    .prepare(`SELECT open, treasury_reconciled, reasons_json, run_id, at_ms FROM treasury_transfer_gate WHERE workspace_id = ?`)
    .get(WS) as { open: number; treasury_reconciled: number; reasons_json: string; run_id: string; at_ms: number } | undefined;
}

function insertTransfer(h: H, row: { id: string; share: string; amount: number; createdAtMs: number; tx: string }) {
  h.raw
    .prepare(
      `INSERT INTO treasury_transfers
         (transfer_id, batch_id, channel_id, principal_id, settlement_id, receipt_hash, split_manifest_hash,
          share, role, chain_id, safe_address, roles_module_address, token, recipient, amount_micros,
          safe_tx_hash, transaction_hash, block_number, proof_event_id, created_at_ms)
       VALUES (?, 'batch-1', 'chan-1', 'gh:7', 'settle-1', ?, 'sha256:split', ?, 'settlement', 84532,
               ?, ?, ?, ?, ?, ?, ?, '300', NULL, ?)`,
    )
    .run(
      row.id,
      `receipt-${row.id}`,
      row.share,
      `0x${'6'.repeat(40)}`,
      `0x${'7'.repeat(40)}`,
      `0x${'3'.repeat(40)}`,
      `0x${'5'.repeat(40)}`,
      row.amount,
      `0x${'9'.repeat(64)}`,
      row.tx,
      row.createdAtMs,
    );
}

describe('PUT /commerce/treasury/transfer-gate', () => {
  it('records a signed push and reports what the treasury door now decides', async () => {
    const h = harness();
    const response = await putGate(h, gatePush());
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      applied: true,
      transfers: 'open',
      gate: { workspaceId: WS, open: true, treasuryReconciled: true, runId: 'run-1' },
    });
    expect(gateRow(h)).toMatchObject({ open: 1, treasury_reconciled: 1, reasons_json: '[]', run_id: 'run-1' });

    const closed = await putGate(h, gatePush({ open: false, reasons: ['credit-reserve broke'], runId: 'run-2', atMs: Date.now() + 1 }));
    expect((await closed.json()) as Record<string, unknown>).toMatchObject({ applied: true, transfers: 'paused' });
    expect(gateRow(h)).toMatchObject({ open: 0, reasons_json: '["credit-reserve broke"]', run_id: 'run-2' });
  });

  it('ignores a delayed push from an earlier run, so it cannot reopen a closed gate', async () => {
    const h = harness();
    const now = Date.now();
    await putGate(h, gatePush({ open: false, reasons: ['dao-payable broke'], runId: 'run-late', atMs: now }));
    const stale = await putGate(h, gatePush({ open: true, runId: 'run-early', atMs: now - 60_000 }));
    expect(stale.status).toBe(200);
    expect((await stale.json()) as Record<string, unknown>).toMatchObject({ applied: false, transfers: 'paused' });
    expect(gateRow(h)).toMatchObject({ open: 0, run_id: 'run-late' });
  });

  it('refuses unsigned, mis-signed, replayed and stale requests, and fails closed without a secret', async () => {
    const h = harness();
    const missing = await h.api.request(TRANSFER_GATE_PATH, { method: 'PUT', body: JSON.stringify(gatePush()) }, h.env);
    expect(missing.status).toBe(401);
    expect((await missing.json()) as Record<string, unknown>).toMatchObject({ reason: 'missing' });

    const wrongKey = await putGate(h, gatePush(), { key: 'j'.repeat(32) });
    expect(wrongKey.status).toBe(401);
    expect((await wrongKey.json()) as Record<string, unknown>).toMatchObject({ reason: 'mismatch' });

    // A signature minted for the inputs read cannot be replayed as a gate push.
    const replayed = await putGate(h, gatePush(), { signedMethod: 'GET', signedPath: RECONCILIATION_INPUTS_PATH });
    expect(replayed.status).toBe(401);

    const old = await putGate(h, gatePush(), { nowMs: Date.now() - 10 * 60_000 });
    expect((await old.json()) as Record<string, unknown>).toMatchObject({ reason: 'stale' });
    expect(gateRow(h)).toBeUndefined();

    const unconfigured = harness({ RECONCILIATION_GATE_SECRET: undefined });
    const refused = await putGate(unconfigured, gatePush());
    expect(refused.status).toBe(503);
    expect(gateRow(unconfigured)).toBeUndefined();
  });

  it('refuses a malformed push, a contradictory open-with-reasons push, and a gate dated in the future', async () => {
    const h = harness();
    expect((await putGate(h, { workspaceId: WS })).status).toBe(400);
    expect((await putGate(h, gatePush({ open: true, reasons: ['x'] }))).status).toBe(400);
    const future = await putGate(h, gatePush({ atMs: Date.now() + 60 * 60_000 }));
    expect(future.status).toBe(400);
    expect((await future.json()) as Record<string, unknown>).toMatchObject({ detail: expect.stringContaining('future') });
    expect(gateRow(h)).toBeUndefined();
  });
});

describe('GET /commerce/treasury/reconciliation-inputs', () => {
  it('returns outstanding credits and every DAO-share transfer, oldest first, in the shape the operator parses', async () => {
    const h = harness();
    const insertBalance = h.raw.prepare(
      `INSERT INTO prepaid_credit_balances (principal_id, available_micros, reserved_micros, spent_micros, updated_at_ms)
       VALUES (?, ?, ?, ?, 1)`,
    );
    insertBalance.run('gh:7', 4_000_000, 1_000_000, 9_000_000);
    insertBalance.run('gh:8', 2_500_000, 0, 0);
    insertTransfer(h, { id: 't-2', share: 'dao', amount: 2_000, createdAtMs: 2_000, tx: `0x${'b'.repeat(64)}` });
    insertTransfer(h, { id: 't-1', share: 'dao', amount: 1_000, createdAtMs: 1_000, tx: `0x${'a'.repeat(64)}` });
    insertTransfer(h, { id: 't-r', share: 'reserve', amount: 500, createdAtMs: 1_500, tx: `0x${'c'.repeat(64)}` });

    const response = await getInputs(h);
    expect(response.status).toBe(200);
    const inputs = parseReconciliationInputs(await response.json());
    // available + reserved is still owed; spent is money already consumed.
    expect(inputs.outstandingCreditsMicros).toBe(7_500_000);
    expect(inputs.daoTransfers.map((t) => t.transferId)).toEqual(['t-1', 't-2']);
    expect(inputs.daoTransfers[0]).toMatchObject({
      chainId: 84532,
      amountMicros: 1_000,
      createdAtMs: 1_000,
      transactionHash: `0x${'a'.repeat(64)}`,
    });
  });

  it('answers zero credits and no transfers on an empty treasury', async () => {
    const inputs = parseReconciliationInputs(await (await getInputs(harness())).json());
    expect(inputs).toMatchObject({ outstandingCreditsMicros: 0, daoTransfers: [], finalSettlementBatches: [] });
  });

  // D-032 (WI-10004709): the DAO's allocation of every FINAL batch is the operator's independent accrual.
  function insertBatch(h: H, row: { id: string; state: string; claim: number; dao: string; finalizedAtMs: number | null; tx: string }) {
    h.raw
      .prepare(
        `INSERT INTO settlement_batches
           (batch_id, channel_id, principal_id, request_hash, chain_id, settlement_contract_address, stablecoin_address,
            claim_micros, prior_cumulative_micros, cumulative_claim_micros, voucher_digests, settlement_id, split_manifest_hash,
            allocations_micros, provider_cost_micros, distributable_micros, dao_treasury, receipt_hash, state,
            required_confirmations, confirmations, claim_tx_hash, claim_block_number, claim_block_hash,
            created_at_ms, updated_at_ms, finalized_at_ms)
         VALUES (?, 'chan-1', 'gh:7', ?, 84532, ?, ?, ?, 0, ?, '[]', ?, 'sha256:split', ?, 0, ?, ?, ?, ?, 3, 3, ?, '100', ?, 1, 1, ?)`,
      )
      .run(
        row.id,
        `req-${row.id}`,
        `0x${'1'.repeat(40)}`,
        `0x${'2'.repeat(40)}`,
        row.claim,
        row.claim,
        `settle-${row.id}`,
        JSON.stringify({ creator: '0', dao: row.dao }),
        row.claim,
        `0x${'4'.repeat(40)}`,
        `receipt-${row.id}`,
        row.state,
        row.tx,
        `0x${'8'.repeat(64)}`,
        row.finalizedAtMs,
      );
  }

  it('lists only FINAL settlement batches, oldest finality first, with the DAO allocation in micros', async () => {
    const h = harness();
    insertBatch(h, { id: 'b-late', state: 'final', claim: 3_000_000, dao: '300000', finalizedAtMs: 9_000, tx: `0x${'e'.repeat(64)}` });
    insertBatch(h, { id: 'b-early', state: 'final', claim: 2_000_000, dao: '200000', finalizedAtMs: 5_000, tx: `0x${'d'.repeat(64)}` });
    // A claim the chain can still reorg is not money received, and a reorged one is void.
    insertBatch(h, { id: 'b-claimed', state: 'claimed', claim: 1_000_000, dao: '100000', finalizedAtMs: null, tx: `0x${'f'.repeat(64)}` });
    insertBatch(h, { id: 'b-reorged', state: 'reorged', claim: 1_000_000, dao: '100000', finalizedAtMs: null, tx: `0x${'a'.repeat(64)}` });

    const inputs = parseReconciliationInputs(await (await getInputs(h)).json());
    expect(inputs.finalSettlementBatches).toEqual([
      { batchId: 'b-early', chainId: 84532, claimTransactionHash: `0x${'d'.repeat(64)}`, claimMicros: 2_000_000, daoMicros: 200_000, finalizedAtMs: 5_000 },
      { batchId: 'b-late', chainId: 84532, claimTransactionHash: `0x${'e'.repeat(64)}`, claimMicros: 3_000_000, daoMicros: 300_000, finalizedAtMs: 9_000 },
    ]);
  });

  it('a final batch with an unreadable DAO allocation makes the operator refuse the read rather than accrue zero', async () => {
    const h = harness();
    insertBatch(h, { id: 'b-bad', state: 'final', claim: 2_000_000, dao: 'not-a-number', finalizedAtMs: 5_000, tx: `0x${'d'.repeat(64)}` });
    const response = await getInputs(h);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(() => parseReconciliationInputs(body)).toThrow(/finalSettlementBatches\[0\]/);
  });

  it('refuses an unsigned read, a gate-push signature replayed as a read, and fails closed without a secret', async () => {
    const h = harness();
    expect((await h.api.request(RECONCILIATION_INPUTS_PATH, {}, h.env)).status).toBe(401);
    expect((await getInputs(h, { signedPath: TRANSFER_GATE_PATH })).status).toBe(401);
    expect((await getInputs(harness({ RECONCILIATION_GATE_SECRET: undefined }))).status).toBe(503);
  });
});

// D-027: the anchor log reads the Worker's chain links through this signed route.
describe('GET /commerce/ledger-chain/links', () => {
  const hex = (n: number) => n.toString(16).padStart(64, '0');

  function insertLink(h: H, streamId: string, seq: number) {
    h.raw
      .prepare(
        `INSERT INTO ledger_chain_links (stream_id, seq, source_id, entry_digest, prev_hash, entry_hash, recorded_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(streamId, seq, `${streamId}-${seq}`, hex(1), hex(2), hex(1000 + seq), 1);
  }

  async function getLinks(h: H, query: string, options: { signedQuery?: string } = {}) {
    const path = `${LEDGER_CHAIN_LINKS_PATH}${query}`;
    const signature = await signReconciliationRequest({
      secret: KEY,
      method: 'GET',
      pathname: `${LEDGER_CHAIN_LINKS_PATH}${options.signedQuery ?? query}`,
      body: '',
      nowMs: Date.now(),
    });
    return h.api.request(path, { headers: { [RECONCILIATION_SIGNATURE_HEADER]: signature } }, h.env);
  }

  type Page = { workspaceId: string | null; links: { streamId: string; seq: number; entryHash: string }[]; nextCursor: string | null };

  it('pages every link in (stream, seq) order under the governing workspace', async () => {
    const h = harness();
    insertLink(h, 'treasury.transfers', 0);
    insertLink(h, 'commerce.ledger', 1);
    insertLink(h, 'commerce.ledger', 0);
    const first = (await (await getLinks(h, '?limit=2')).json()) as Page;
    expect(first.workspaceId).toBe(WS);
    expect(first.links.map((l) => `${l.streamId}:${l.seq}`)).toEqual(['commerce.ledger:0', 'commerce.ledger:1']);
    expect(first.links[1]!.entryHash).toBe(hex(1001));
    expect(first.nextCursor).toBe('commerce.ledger:1');
    const query = `?after=${encodeURIComponent(first.nextCursor!)}&limit=2`;
    const second = (await (await getLinks(h, query)).json()) as Page;
    expect(second.links.map((l) => `${l.streamId}:${l.seq}`)).toEqual(['treasury.transfers:0']);
    expect(second.nextCursor).toBeNull();
  });

  it('binds the signature to the query, so a page signature cannot read another page', async () => {
    const h = harness();
    insertLink(h, 'commerce.ledger', 0);
    const replayed = await getLinks(h, '?after=commerce.ledger%3A0&limit=1', { signedQuery: '?limit=1' });
    expect(replayed.status).toBe(401);
    expect((await h.api.request(`${LEDGER_CHAIN_LINKS_PATH}?limit=1`, {}, h.env)).status).toBe(401);
  });

  it('hands out no links without a governing workspace, and fails closed without a secret', async () => {
    const unbound = harness({ RECONCILIATION_GATE_SECRET: KEY, RECONCILIATION_GATE_WORKSPACE: '' });
    insertLink(unbound, 'commerce.ledger', 0);
    expect(await (await getLinks(unbound, '')).json()).toEqual({ workspaceId: null, links: [], nextCursor: null });
    expect((await getLinks(harness({ RECONCILIATION_GATE_SECRET: undefined }), '')).status).toBe(503);
  });

  it('refuses a malformed cursor or limit', async () => {
    const h = harness();
    expect((await getLinks(h, '?after=not-a-stream%3A0')).status).toBe(400);
    expect((await getLinks(h, '?limit=0')).status).toBe(400);
  });

  // The operator's feed client against this real route: signing, paging and the
  // workspace binding agree end to end, and the union adds the links to PG's.
  function operatorFeed(h: H, treasuryWorkspace: string) {
    return cupboardAnchorLinkFeed({
      baseUrl: 'https://cupboard.test',
      secret: KEY,
      treasuryWorkspace,
      pageSize: 2,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        return h.api.request(`${u.pathname}${u.search}`, init ?? {}, h.env);
      }) as typeof fetch,
    });
  }

  it('the operator feed reads every page and the union appends the Worker links to the PG links', async () => {
    const h = harness();
    for (let seq = 0; seq < 3; seq += 1) insertLink(h, 'commerce.ledger', seq);
    insertLink(h, 'treasury.transfers', 0);
    const pg = { links: async () => [{ streamId: 'governance.plan-admission:pot-1', seq: 0, entryHash: hex(7) }] };
    const errors: string[] = [];
    const union = unionAnchorLinkFeed(pg, [{ name: 'cupboard', feed: operatorFeed(h, WS) }], (_ws, name, e) => errors.push(`${name}:${String(e)}`));
    const links = await union.links(WS);
    expect(links.map((l) => `${l.streamId}:${l.seq}`)).toEqual([
      'governance.plan-admission:pot-1:0',
      'commerce.ledger:0',
      'commerce.ledger:1',
      'commerce.ledger:2',
      'treasury.transfers:0',
    ]);
    expect(errors).toEqual([]);
    // Another workspace's log never receives the Worker's links.
    expect(await operatorFeed(h, WS).links('ws-other')).toEqual([]);
  });

  it('a workspace mismatch or an outage is reported by the union, and the PG links still flow', async () => {
    const h = harness();
    insertLink(h, 'commerce.ledger', 0);
    const pg = { links: async () => [{ streamId: 'governance.plan-admission:pot-1', seq: 0, entryHash: hex(7) }] };
    const errors: string[] = [];
    const onError = (_ws: string, name: string, e: unknown) => errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    const mismatched = unionAnchorLinkFeed(pg, [{ name: 'cupboard', feed: operatorFeed(h, 'ws-wrong') }], onError);
    expect((await mismatched.links('ws-wrong')).map((l) => l.streamId)).toEqual(['governance.plan-admission:pot-1']);
    expect(errors[0]).toContain('Worker governs workspace "ws-recon"');
    const down = harness({ RECONCILIATION_GATE_SECRET: undefined });
    const outage = unionAnchorLinkFeed(pg, [{ name: 'cupboard', feed: operatorFeed(down, WS) }], onError);
    expect(await outage.links(WS)).toHaveLength(1);
    expect(errors[1]).toContain('status 503');
  });

  it('two sources claiming one stream fail the tick instead of colliding on leaf identity', async () => {
    const h = harness();
    insertLink(h, 'commerce.ledger', 0);
    const pg = { links: async () => [{ streamId: 'commerce.ledger', seq: 0, entryHash: hex(7) }] };
    const union = unionAnchorLinkFeed(pg, [{ name: 'cupboard', feed: operatorFeed(h, WS) }], () => {});
    await expect(union.links(WS)).rejects.toThrow(/claimed by both primary and cupboard/);
  });

  it('verifies an entry-free real D1 bundle through public root data and rejects tampered link and root identities', async () => {
    const h = harness();
    h.raw.prepare(`INSERT INTO commerce_ledger_events
      (ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json)
      VALUES ('le-entry-free', 'order.paid', 1000, 'stripe', 'evt-entry-free', '{"amountMinor":1000,"currency":"USD"}')`).run();
    const witnessed = await witnessLedgerStream(h.env.DB, 'commerce.ledger', 2000);
    expect(witnessed.appended).toBe(1);
    const link = parseChainExport(await exportLedgerStream(h.env.DB, 'commerce.ledger')).records[0]!.link;
    const store = memoryLedgerAnchorStore();
    const attester = '0x00000000000000000000000000000000000a11ce';
    let publicRoot: AnchoredRoot | null = null;
    const t0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);
    await runAnchorTick({
      workspaceId: WS, logId: `papercusp:${WS}`, nowSeconds: t0 + 60, store, feed: operatorFeed(h, WS),
      backend: { kind: 'public-test-chain', publish: async publication => {
        publicRoot = { ...publication, attester, revoked: false };
        return { backend: 'public-test-chain', chainId: 84532, ref: '0x-public-root', txHash: null, attester };
      } },
    });
    const built = await buildInclusionBundle({ workspaceId: WS, link, store });
    expect(built).not.toHaveProperty('entry');
    if ('error' in built) throw new Error(built.error);
    const portable = JSON.parse(JSON.stringify(built)) as AnchorInclusionBundle;
    expect(portable.link.streamId).toBe('commerce.ledger');
    // No credential, Worker route or ledger reader is supplied to this verifier.
    const reader = { read: async (ref: string) => ref === portable.anchor.ref ? publicRoot : null };
    const verify = (bundle: AnchorInclusionBundle) => verifyInclusionBundle(bundle, reader, { expectedAttester: attester, expectedLogId: `papercusp:${WS}` });
    await expect(verify(portable)).resolves.toEqual({ ok: true, anchoredWindowEnd: t0, attester });
    await expect(verify({ ...portable, link: { ...portable.link, entryDigest: 'f'.repeat(64) } })).resolves.toMatchObject({ ok: false, reason: 'link-mismatch' });
    await expect(verify({ ...portable, anchor: { ...portable.anchor, ref: '0x-absent' } })).resolves.toMatchObject({ ok: false, reason: 'anchor-not-found' });
    publicRoot = { ...publicRoot!, treeSize: portable.treeSize + 1 };
    await expect(verify(portable)).resolves.toMatchObject({ ok: false, reason: 'anchor-mismatch' });
  });
});

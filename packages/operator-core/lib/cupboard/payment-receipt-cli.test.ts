/**
 * The open-source receipt verifier (P-046, D-029) end to end: receipts are
 * recorded, chained, anchored through the REAL EAS backend against a local
 * JSON-RPC chain, issued, and then checked by the CLI logic with nothing but the
 * receipt file and the RPC URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { http } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { mockEasChain } from './eas-chain-test-support';
import { HOUR_SECONDS, memoryLedgerAnchorStore, runAnchorTick, type AnchorLinkFeed } from './ledger-anchor';
import { easAnchorBackend } from './ledger-anchor-eas';
import { memoryLedgerChainLinkStore } from './ledger-chain';
import type { StripeBalanceTransaction } from './money-journal-producers';
import { PAYMENT_RECEIPT_STREAM_ID, type PaymentReceipt } from './payment-receipt';
import { PAYMENT_RECEIPT_VERIFIER_USAGE, runPaymentReceiptVerifier } from './payment-receipt-cli';
import { issuePaymentReceipt, memoryPaymentReceiptStore, recordPaymentReceipts } from './payment-receipt-store';

const WS = 'ws-receipt-cli';
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);

function bt(id: string, amount: number): StripeBalanceTransaction {
  return { id, type: 'charge', amount, fee: 30, currency: 'usd', created: T0 + 120, source: { id: `ch_${id}`, object: 'charge', customer: 'cus_1' } };
}

function io(files: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      readFile: (file: string) => {
        if (!(file in files)) throw new Error(`ENOENT: ${file}`);
        return files[file]!;
      },
      stdout: (t: string) => void out.push(t),
      stderr: (t: string) => void err.push(t),
    },
  };
}

describe('verify-payment-receipt CLI', () => {
  let chain: ReturnType<typeof mockEasChain>;
  let url: string;
  let attester: string;
  let receipt: PaymentReceipt;

  beforeEach(async () => {
    chain = mockEasChain();
    url = await chain.listen();
    const backend = easAnchorBackend({ chain: baseSepolia, transport: http(url), pollingIntervalMs: 10, privateKey: generatePrivateKey() });
    attester = backend.attester;
    const store = memoryPaymentReceiptStore();
    const links = memoryLedgerChainLinkStore();
    const anchors = memoryLedgerAnchorStore();
    await recordPaymentReceipts(WS, [bt('txn_a', 1000), bt('txn_b', 2500)], { store, chain: links });
    const feed: AnchorLinkFeed = {
      links: async (ws) =>
        (await links.links(ws, PAYMENT_RECEIPT_STREAM_ID)).map((s) => ({ streamId: s.link.streamId, seq: s.link.seq, entryHash: s.link.entryHash })),
    };
    const tick = await runAnchorTick({ workspaceId: WS, logId: `papercusp:${WS}`, nowSeconds: T0 + HOUR_SECONDS + 5, store: anchors, feed, backend });
    expect(tick.status).toBe('anchored');
    const issued = await issuePaymentReceipt(WS, 'txn_b', { store, chain: links, anchors });
    if (!issued.ok) throw new Error(`issue failed: ${issued.error}`);
    // Exactly what a customer would save to disk.
    receipt = JSON.parse(JSON.stringify(issued.receipt)) as PaymentReceipt;
  });
  afterEach(async () => {
    await chain.close();
    vi.restoreAllMocks();
  });

  it('verifies a saved receipt using only the file and the given RPC, and says when the payment existed by', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const t = io({ 'receipt.json': JSON.stringify(receipt) });
    const code = await runPaymentReceiptVerifier(['receipt.json', '--rpc', url, '--attester', attester], t.io);
    expect(t.err).toEqual([]);
    expect(code).toBe(0);
    const report = JSON.parse(t.out.join(''));
    expect(report).toMatchObject({
      ok: true,
      transaction: { id: 'txn_b', amount: 2500, currency: 'usd', fee: 30 },
      attester: attester.toLowerCase(),
      chainId: baseSepolia.id,
      rpcUrl: url,
      existedBy: new Date((T0 + HOUR_SECONDS) * 1000).toISOString(),
    });
    const urls = fetchSpy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set([url]));
  });

  it('reads the receipt from stdin when the file is -', async () => {
    const t = io({ '-': JSON.stringify(receipt) });
    await expect(runPaymentReceiptVerifier(['-', '--rpc', url], t.io)).resolves.toBe(0);
  });

  it('the actual script retains CLI output and exit codes while recording verification evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'payment-receipt-cli-'));
    const script = fileURLToPath(new URL('../../../../scripts/verify-payment-receipt.mts', import.meta.url));
    const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, ['--import', 'tsx', script, ...args], {
        env: { ...process.env, VH_EVIDENCE_ROOT_BASE: root, VH_GUARD_RAIL_SOURCE: '' },
        timeout: 30_000,
      }, (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== 'number') return reject(error);
        // pruneForHarness reports a busy GLOBAL disk-retention mutex (another fleet process is
        // pruning) as a VH_RETENTION_DEFERRED stderr line by design (runner.test.ts pins it).
        // That is host contention, not this CLI's output, so it is outside the stderr contract.
        resolve({ code, stdout, stderr: stderr.replace(/^VH_RETENTION_DEFERRED .*\n/gm, '') });
      });
    });
    const evidence = async () => JSON.parse(await readFile(path.join(root, 'payment-receipt/latest/result.json'), 'utf8'));
    try {
      const file = path.join(root, 'receipt.json');
      await writeFile(file, JSON.stringify(receipt));
      const positive = await run([file, '--rpc', url]);
      expect(positive.code).toBe(0);
      expect(positive.stderr).toBe('');
      expect(JSON.parse(positive.stdout)).toMatchObject({ ok: true, transaction: { id: 'txn_b' } });
      expect((await evidence()).phases).toEqual([expect.objectContaining({ phase: 'verify', status: 'passed' })]);

      await writeFile(file, JSON.stringify({ ...receipt, transaction: { ...receipt.transaction, amount: 25 } }));
      const negative = await run([file, '--rpc', url]);
      expect(negative.code).toBe(1);
      expect(JSON.parse(negative.stdout)).toMatchObject({ ok: false, reason: 'commitment-mismatch' });
      expect((await evidence()).firstFailure).toMatchObject({ phase: 'verify', reasonCode: 'receipt-not-verified' });

      const unreadable = await run([path.join(root, 'missing.json')]);
      expect(unreadable.code).toBe(2);
      expect(unreadable.stdout).toBe('');
      expect(unreadable.stderr).toContain('ENOENT');
      expect((await evidence()).firstFailure).toMatchObject({ phase: 'verify', reasonCode: 'usage-or-input-error' });

      const help = await run(['--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(PAYMENT_RECEIPT_VERIFIER_USAGE);
      expect(help.stderr).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('exits 1 with the reason for an altered amount, and for a receipt anchored by someone else', async () => {
    const altered = { ...receipt, transaction: { ...receipt.transaction, amount: 25 } };
    const a = io({ r: JSON.stringify(altered) });
    await expect(runPaymentReceiptVerifier(['r', '--rpc', url], a.io)).resolves.toBe(1);
    expect(JSON.parse(a.out.join(''))).toMatchObject({ ok: false, reason: 'commitment-mismatch' });

    const b = io({ r: JSON.stringify(receipt) });
    const stranger = '0x00000000000000000000000000000000000b0b00';
    await expect(runPaymentReceiptVerifier(['r', '--rpc', url, '--attester', stranger], b.io)).resolves.toBe(1);
    expect(JSON.parse(b.out.join(''))).toMatchObject({ ok: false });
  });

  it('exits 1 when the anchor attestation was revoked on-chain', async () => {
    for (const a of chain.attestations.values()) a.revocationTime = 1n;
    const t = io({ r: JSON.stringify(receipt) });
    await expect(runPaymentReceiptVerifier(['r', '--rpc', url], t.io)).resolves.toBe(1);
    expect(JSON.parse(t.out.join(''))).toMatchObject({ ok: false });
  });

  it.each([
    [[], 'missing receipt file'],
    [['r', '--attester', 'not-an-address'], '--attester must be'],
    [['r', '--rpc'], '--rpc needs a value'],
    [['r', '--bogus'], 'unknown option'],
    [['r', 's'], 'unexpected argument'],
    [['missing.json'], 'cannot read receipt'],
  ] as const)('exits 2 on misuse: %j', async (argv, message) => {
    const t = io({ r: JSON.stringify(receipt), s: '{}' });
    await expect(runPaymentReceiptVerifier(argv, t.io)).resolves.toBe(2);
    expect(t.err.join('')).toContain(message);
    expect(t.out).toEqual([]);
  });

  it('exits 2 for an anchor on a chain it cannot read, and 0 with usage for --help', async () => {
    const t = io({ r: JSON.stringify({ ...receipt, bundle: { ...receipt.bundle, anchor: { ...receipt.bundle.anchor, chainId: 1 } } }) });
    await expect(runPaymentReceiptVerifier(['r'], t.io)).resolves.toBe(2);
    expect(t.err.join('')).toContain('unsupported anchor');
    const h = io({});
    await expect(runPaymentReceiptVerifier(['--help'], h.io)).resolves.toBe(0);
    expect(h.out.join('')).toContain(PAYMENT_RECEIPT_VERIFIER_USAGE);
  });
});

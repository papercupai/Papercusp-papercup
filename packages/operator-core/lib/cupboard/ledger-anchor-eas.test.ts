/**
 * EAS anchor backend (P-041, R-29). Runs the real viem clients against a local
 * JSON-RPC chain stand-in, so the encoding, schema registration, Attested-event
 * parsing and the public read-back are exercised end to end with no network.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, concatHex, http, keccak256, stringToHex, zeroAddress, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { appendLinks, entryDigest } from '@papercusp/hash-chain';
import { mockEasChain as mockChain } from './eas-chain-test-support';
import {
  ANCHOR_SCHEMA,
  ANCHOR_SCHEMA_UID,
  DEFAULT_ANCHOR_RPC_URL,
  decodeAnchorData,
  easAnchorBackend,
  easAnchorReader,
  encodeAnchorData,
  resolveAnchorBackend,
} from './ledger-anchor-eas';
import {
  HOUR_SECONDS,
  buildInclusionBundle,
  memoryLedgerAnchorStore,
  runAnchorTick,
  verifyInclusionBundle,
  type AnchorInclusionBundle,
  type AnchorPublication,
} from './ledger-anchor';

const PUB: AnchorPublication = {
  logId: 'papercusp:ws-eas',
  logRoot: 'ab'.repeat(32),
  treeSize: 7,
  windowStart: 1_789_996_400,
  windowEnd: 1_790_000_000,
};

describe('ledger anchor EAS encoding', () => {
  it('derives the schema UID exactly as SchemaRegistry does (abi.encodePacked(schema, resolver, revocable))', () => {
    const packed = concatHex([stringToHex(ANCHOR_SCHEMA), zeroAddress, '0x00']);
    expect(ANCHOR_SCHEMA_UID).toBe(keccak256(packed));
  });

  it('round-trips a publication through the attestation data', () => {
    expect(decodeAnchorData(encodeAnchorData(PUB))).toEqual(PUB);
    expect(() => encodeAnchorData({ ...PUB, logRoot: 'AB'.repeat(32) })).toThrow(/lowercase hex/);
  });
});

describe('ledger anchor EAS backend against a chain', () => {
  let chain: ReturnType<typeof mockChain>;
  let url: string;
  beforeEach(async () => {
    chain = mockChain();
    url = await chain.listen();
  });
  afterEach(async () => {
    await chain.close();
  });

  it('registers the schema once, attests, and the public reader recovers the anchored root', async () => {
    const cfg = { chain: baseSepolia, transport: http(url), pollingIntervalMs: 10 };
    const backend = easAnchorBackend({ ...cfg, privateKey: generatePrivateKey() });
    const r1 = await backend.publish(PUB);
    const r2 = await backend.publish({ ...PUB, treeSize: 9, windowStart: PUB.windowEnd, windowEnd: PUB.windowEnd + HOUR_SECONDS });
    expect(chain.calls.filter((c) => c.fn === 'register')).toHaveLength(1);
    expect(chain.calls.filter((c) => c.fn === 'attest')).toHaveLength(2);
    expect(r1).toMatchObject({ backend: 'eas', chainId: baseSepolia.id, attester: backend.attester.toLowerCase() });
    expect(r1.ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r1.ref).not.toBe(r2.ref);

    const reader = easAnchorReader(cfg);
    await expect(reader.read(r1.ref)).resolves.toEqual({ ...PUB, attester: backend.attester.toLowerCase(), revoked: false });
    await expect(reader.read(bytesToHex(new Uint8Array(32).fill(7)))).resolves.toBeNull();
    await expect(reader.read('not-a-uid')).resolves.toBeNull();
  });

  it('reads an attestation under another schema as absent, and flags a revoked one', async () => {
    const cfg = { chain: baseSepolia, transport: http(url), pollingIntervalMs: 10 };
    const backend = easAnchorBackend({ ...cfg, privateKey: generatePrivateKey() });
    const { ref } = await backend.publish(PUB);
    const stored = chain.attestations.get(ref as Hex)!;
    stored.revocationTime = 1n;
    await expect(easAnchorReader(cfg).read(ref)).resolves.toMatchObject({ revoked: true });
    stored.schema = keccak256(stringToHex('some other schema'));
    await expect(easAnchorReader(cfg).read(ref)).resolves.toBeNull();
  });

  it('attests each completed quiet hour once even when the root and tree size are unchanged', async () => {
    const cfg = { chain: baseSepolia, transport: http(url), pollingIntervalMs: 10 };
    const backend = easAnchorBackend({ ...cfg, privateKey: generatePrivateKey() });
    const store = memoryLedgerAnchorStore();
    const links = appendLinks('money-journal', null, [entryDigest({ cents: 100 })]);
    const feed = { links: async () => links };
    const t0 = 1_790_000_000 - (1_790_000_000 % HOUR_SECONDS);
    const tick = (nowSeconds: number) => runAnchorTick({ workspaceId: 'ws-quiet', logId: 'self:ws-quiet', nowSeconds, store, feed, backend });
    const first = await tick(t0 + 60);
    const quiet = await tick(t0 + HOUR_SECONDS + 60);
    expect(quiet).toMatchObject({ status: 'anchored', newLeaves: 0 });
    if (first.status !== 'anchored' || quiet.status !== 'anchored') throw new Error('expected both completed hours to be anchored');
    expect(quiet.anchor).toMatchObject({ logRoot: first.anchor.logRoot, treeSize: first.anchor.treeSize, windowStart: t0, windowEnd: t0 + HOUR_SECONDS });
    expect(quiet.anchor.ref).not.toBe(first.anchor.ref);
    expect((await tick(t0 + HOUR_SECONDS + 900)).status).toBe('already-anchored');
    expect(chain.calls.filter(c => c.fn === 'attest')).toHaveLength(2);
    expect(chain.calls.filter(c => c.fn === 'register')).toHaveLength(1);
    await expect(easAnchorReader(cfg).read(quiet.anchor.ref)).resolves.toMatchObject({
      logRoot: first.anchor.logRoot, treeSize: 1, windowEnd: t0 + HOUR_SECONDS, revoked: false, attester: backend.attester.toLowerCase(),
    });
  });

  it('self-hosted: a configured RPC and key are the only endpoint and identity used, end to end', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'anchor-key-'));
    try {
      const keyFile = path.join(dir, 'key');
      writeFileSync(keyFile, `${generatePrivateKey()}\n`);
      chmodSync(keyFile, 0o600);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const resolved = resolveAnchorBackend(
        { PAPERCUSP_LEDGER_ANCHOR_RPC_URL: url, PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: keyFile },
        { pollingIntervalMs: 10 },
      );
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const store = memoryLedgerAnchorStore();
      const links = appendLinks('money-journal', null, [entryDigest({ amountCents: 500 }), entryDigest({ amountCents: -20 })]);
      const feed = { links: async () => links.map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash })) };
      const tick = await runAnchorTick({
        workspaceId: 'ws-self',
        logId: 'self:ws-self',
        nowSeconds: 1_790_000_000 + 60,
        store,
        feed,
        backend: resolved.backend,
      });
      expect(tick.status).toBe('anchored');
      const bundle = await buildInclusionBundle({ workspaceId: 'ws-self', link: links[1]!, entry: { amountCents: -20 }, store });
      const portable = JSON.parse(JSON.stringify(bundle)) as AnchorInclusionBundle;
      await expect(
        verifyInclusionBundle(portable, resolved.reader, { expectedAttester: resolved.backend.attester }),
      ).resolves.toMatchObject({ ok: true });

      const urls = fetchSpy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
      expect(urls.length).toBeGreaterThan(0);
      expect(new Set(urls)).toEqual(new Set([url]));
      expect(urls.some((u) => u.startsWith(DEFAULT_ANCHOR_RPC_URL))).toBe(false);
      fetchSpy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveAnchorBackend refusals', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'anchor-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const key = (body: string, mode = 0o600): string => {
    const f = path.join(dir, `k-${Math.random().toString(36).slice(2)}`);
    writeFileSync(f, body);
    chmodSync(f, mode);
    return f;
  };

  it('defaults to Base Sepolia and the public RPC', () => {
    const r = resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: path.join(dir, 'absent') });
    expect(r.config).toMatchObject({ backend: 'eas', rpcUrl: DEFAULT_ANCHOR_RPC_URL, chainId: baseSepolia.id });
    expect(r).toMatchObject({ ok: false, reason: 'key-missing' });
    // Reading needs no key: a verifier can still check bundles.
    expect(r.reader).not.toBeNull();
  });

  it.each([
    ['disabled', { PAPERCUSP_LEDGER_ANCHOR_BACKEND: 'none' }],
    ['unsupported-chain', { PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID: '1' }],
    ['mainnet-not-enabled', { PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID: '8453' }],
  ] as const)('%s', (reason, env) => {
    expect(resolveAnchorBackend({ ...env, PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(generatePrivateKey()) })).toMatchObject({ ok: false, reason });
  });

  it('refuses a group/other-readable key and a malformed key', () => {
    expect(resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(generatePrivateKey(), 0o644) })).toMatchObject({
      ok: false,
      reason: 'key-permissions',
    });
    expect(resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key('not a key') })).toMatchObject({ ok: false, reason: 'key-invalid' });
  });

  it('accepts a 0x-less key, and mainnet only with the explicit opt-in', () => {
    const bare = generatePrivateKey().slice(2);
    expect(resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(bare) }).ok).toBe(true);
    expect(
      resolveAnchorBackend({
        PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(bare),
        PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID: '8453',
        PAPERCUSP_LEDGER_ANCHOR_ALLOW_MAINNET: '1',
      }).ok,
    ).toBe(true);
  });
});

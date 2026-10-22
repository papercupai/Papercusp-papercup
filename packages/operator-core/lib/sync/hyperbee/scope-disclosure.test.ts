/**
 * scope-disclosure unit tests — pack/parse fail-closed round-trip, sender-side
 * disclosure gating, receive-side admission refusals (loud, counted), the
 * D-017 n1 live-redisclosure diff, and the announce.ts sig-coverage invariants
 * (absent/empty scoped_logs = pre-P-006 byte-identical; present = tamper-proof).
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import type { ScopeId } from '../pot-git/scope-repo';
import {
  admitScopedAnnounce,
  computeRedisclosure,
  discloseScopedLogsForPeer,
  packScopedLog,
  parseScopedLog,
  type ScopedLogDisclosure,
} from './scope-disclosure';
import { announceSigningBytes, buildAnnounce, verifyAnnounceDetailed, type AnnounceBody } from './announce';

const SCOPE_A: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'alpha' };
const SCOPE_B: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'beta' };
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const D_A: ScopedLogDisclosure = { scope: SCOPE_A, logCoreKeyHex: KEY_A, scopeEpoch: 3 };
const D_B: ScopedLogDisclosure = { scope: SCOPE_B, logCoreKeyHex: KEY_B, scopeEpoch: 0 };

/** Membership fixture: user 1 ∈ A only; user 2 ∈ A+B; user 3 ∈ nothing. */
const isMember = (scope: ScopeId, uid: number): boolean =>
  (uid === 1 && scope.slug === 'alpha') || uid === 2;

describe('packScopedLog / parseScopedLog', () => {
  it('round-trips authenticated writer lengths while retaining legacy three-field entries', () => {
    const current = { ...D_A, logLength: 123 };
    expect(parseScopedLog(packScopedLog(current))).toEqual(current);
    expect(parseScopedLog(packScopedLog(D_A))).toEqual(D_A);
    for (const length of ['-1', '01', 'NaN', '9007199254740992', '1|2']) {
      expect(parseScopedLog(`fleet:42/alpha|${KEY_A}|3|${length}`)).toBeNull();
    }
    expect(() => packScopedLog({ ...D_A, logLength: -1 })).toThrow(/length/);
  });
  it('round-trips', () => {
    const wire = packScopedLog(D_A);
    expect(wire).toBe(`fleet:42/alpha|${KEY_A}|3`);
    expect(parseScopedLog(wire)).toEqual(D_A);
  });

  it('pack throws on trusted-side programming errors', () => {
    expect(() => packScopedLog({ ...D_A, logCoreKeyHex: 'nothex' })).toThrow(/64-hex/);
    expect(() => packScopedLog({ ...D_A, scopeEpoch: -1 })).toThrow(/epoch/);
  });

  it.each([
    ['missing fields', 'fleet:42/alpha|aa'],
    ['bad scope id', `fleet:login/alpha|${KEY_A}|1`],
    ['bad core key', 'fleet:42/alpha|zz|1'],
    ['bad epoch', `fleet:42/alpha|${KEY_A}|01`],
    ['epoch not a number', `fleet:42/alpha|${KEY_A}|x`],
    ['empty', ''],
  ])('parse fails closed on %s', (_n, wire) => {
    expect(parseScopedLog(wire)).toBeNull();
  });
});

describe('discloseScopedLogsForPeer (sender gate, §5.2)', () => {
  it('discloses only the scopes the peer is a member of', async () => {
    expect(await discloseScopedLogsForPeer([D_A, D_B], 1, isMember)).toEqual([packScopedLog(D_A)]);
    expect(await discloseScopedLogsForPeer([D_A, D_B], 2, isMember)).toEqual([
      packScopedLog(D_A),
      packScopedLog(D_B),
    ]);
    expect(await discloseScopedLogsForPeer([D_A, D_B], 3, isMember)).toEqual([]);
  });
});

describe('admitScopedAnnounce (receive belt)', () => {
  it('admits member scopes, refuses non-member + malformed entries loudly', async () => {
    const res = await admitScopedAnnounce(
      [packScopedLog(D_A), packScopedLog(D_B), 'garbage|x'],
      1, // self ∈ A only
      isMember,
    );
    expect(res.admitted).toEqual([D_A]);
    expect(res.refused).toEqual([
      { entry: packScopedLog(D_B), reason: 'not-a-member', scopeId: 'fleet:42/beta' },
      { entry: 'garbage|x', reason: 'malformed' },
    ]);
  });

  it('handles an absent field as empty (no refusals, no admissions)', async () => {
    const res = await admitScopedAnnounce(undefined, 1, isMember);
    expect(res.admitted).toEqual([]);
    expect(res.refused).toEqual([]);
  });
});

describe('computeRedisclosure (D-017 n1 — live connections, not reconnect)', () => {
  it('orders a re-announce exactly for connections whose set changed', async () => {
    const disclosedA = packScopedLog(D_A);
    const conns = [
      { peerGithubUserId: 1, lastDisclosed: [disclosedA] }, // unchanged
      { peerGithubUserId: 2, lastDisclosed: [disclosedA] }, // gains B
      { peerGithubUserId: 3, lastDisclosed: [disclosedA] }, // revoked → loses A
    ];
    const orders = await computeRedisclosure(conns, [D_A, D_B], isMember);
    expect(orders).toHaveLength(2);
    const forPeer2 = orders.find((o) => o.peerGithubUserId === 2)!;
    expect(forPeer2.added).toEqual([packScopedLog(D_B)]);
    expect(forPeer2.removed).toEqual([]);
    const forPeer3 = orders.find((o) => o.peerGithubUserId === 3)!;
    expect(forPeer3.next).toEqual([]);
    expect(forPeer3.removed).toEqual([disclosedA]);
  });

  it('an epoch advance (rekey, 5.4) changes the packed entry → re-discloses', async () => {
    const before = packScopedLog(D_A);
    const after: ScopedLogDisclosure = { ...D_A, scopeEpoch: 4 };
    const orders = await computeRedisclosure(
      [{ peerGithubUserId: 1, lastDisclosed: [before] }],
      [after],
      isMember,
    );
    expect(orders).toHaveLength(1);
    expect(orders[0].added).toEqual([packScopedLog(after)]);
    expect(orders[0].removed).toEqual([before]);
  });
});

describe('announce.ts sig coverage of scoped_logs (P-006 §5.2)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const signer = (bytes: Buffer): Promise<Buffer> =>
    Promise.resolve(nodeSign(null, bytes, privateKey) as Buffer);
  const base: Omit<AnnounceBody, 'ts'> = {
    device_pubkey: devicePubkey,
    github_user_id: 42,
    github_login: 'display-only',
    attestation_gist_id: 'gist123',
    log_core_key: 'c'.repeat(64),
  };
  const NOW = 1_751_500_000_000;

  it('absent and empty scoped_logs sign byte-identical (pre-P-006 compat)', () => {
    const a: AnnounceBody = { ...base, ts: NOW };
    const b: AnnounceBody = { ...base, ts: NOW, scoped_logs: [] };
    expect(announceSigningBytes(a).equals(announceSigningBytes(b))).toBe(true);
  });

  it('a signed frame with scoped_logs verifies; grafting/stripping breaks the sig', async () => {
    const entries = [packScopedLog(D_A)];
    const frame = await buildAnnounce({ ...base, scoped_logs: entries }, signer, { nowMs: NOW });
    expect(verifyAnnounceDetailed(frame, { nowMs: NOW }).ok).toBe(true);

    const stripped = { ...frame, scoped_logs: undefined };
    expect(verifyAnnounceDetailed(stripped, { nowMs: NOW })).toEqual({ ok: false, reason: 'bad_sig' });

    const grafted = { ...frame, scoped_logs: [...entries, packScopedLog(D_B)] };
    expect(verifyAnnounceDetailed(grafted, { nowMs: NOW })).toEqual({ ok: false, reason: 'bad_sig' });

    const reordered = await buildAnnounce(
      { ...base, scoped_logs: [packScopedLog(D_B), packScopedLog(D_A)] },
      signer,
      { nowMs: NOW },
    );
    expect(verifyAnnounceDetailed({ ...reordered, scoped_logs: [packScopedLog(D_A), packScopedLog(D_B)] }, { nowMs: NOW }))
      .toEqual({ ok: false, reason: 'bad_sig' });
  });

  it('a structurally alien scoped_logs field is malformed', async () => {
    const frame = await buildAnnounce({ ...base }, signer, { nowMs: NOW });
    const alien = { ...frame, scoped_logs: [1, 2] as unknown as string[] };
    expect(verifyAnnounceDetailed(alien, { nowMs: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a pre-P-006 frame (no scoped_logs) still verifies unchanged', async () => {
    const frame = await buildAnnounce({ ...base }, signer, { nowMs: NOW });
    expect(verifyAnnounceDetailed(frame, { nowMs: NOW }).ok).toBe(true);
  });
});

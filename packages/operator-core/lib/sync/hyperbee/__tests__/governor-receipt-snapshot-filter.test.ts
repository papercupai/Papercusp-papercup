import { describe, expect, it, vi } from 'vitest';
import {
  governorReceiptEnvelopeOpener,
  isLegacyGovernorReceiptSnapshotValue,
  shouldDropGovernorReceiptSnapshotRow,
  type GovernorReceiptSnapshotFilter,
} from '../governor-receipt-snapshot-filter';
import { createHiveEpochCrypto } from '../hive-epoch-crypto-impl';
import type { EpochKey } from '../hive-epoch-crypto';
import { buildOpAAD } from '../hive-epoch-serving';
import { loadSodium, openOpCiphertext } from '../hive-epoch-aead';

const receipt = (state = 'completed') => ({
  payload: { resource_governor: { schemaVersion: 1, state } },
});
const scopedReceipt = (issueId: string, scope: string, storageHarnessSlug?: string) => ({
  ...receipt(),
  issue_id: issueId,
  scope,
  ...(storageHarnessSlug === undefined ? {} : { storage_harness_slug: storageHarnessSlug }),
});
const filter: GovernorReceiptSnapshotFilter = {
  maxSourceIndexExclusive: 100,
  liveQualifiedKeys: ['papercusp/WI-LIVE'],
};

describe('P-530 governor receipt snapshot filter', () => {
  it('drops only an absent qualified pre-census receipt', () => {
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        receipt(),
        { table: 'engineer-issues', hbKey: 'papercusp/WI-DEAD', sourceIndex: 99 },
        filter,
      ),
    ).toBe(true);
  });

  it('never drops a current live row or a post-census append', () => {
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        receipt(),
        { table: 'engineer-issues', hbKey: 'papercusp/WI-LIVE', sourceIndex: 20 },
        filter,
      ),
    ).toBe(false);
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        receipt(),
        { table: 'engineer-issues', hbKey: 'papercusp/WI-NEW', sourceIndex: 100 },
        filter,
      ),
    ).toBe(false);
  });

  it('fails safe for ordinary issues, bare legacy keys, tombstones, and unknown indices', () => {
    const cases = [
      [{ payload: { normal: true } }, { table: 'engineer-issues', hbKey: 'papercusp/WI-NORMAL', sourceIndex: 1 }],
      [receipt(), { table: 'engineer-issues', hbKey: 'WI-BARE', sourceIndex: 1 }],
      [null, { table: 'engineer-issues', hbKey: 'papercusp/WI-TOMBSTONE', sourceIndex: 1 }],
      [receipt(), { table: 'engineer-issues', hbKey: 'papercusp/WI-UNKNOWN' }],
      [receipt(), { table: 'features-by-id', hbKey: 'papercusp/WI-WRONG-TABLE', sourceIndex: 1 }],
    ] as const;
    for (const [value, context] of cases) {
      expect(shouldDropGovernorReceiptSnapshotRow(value, context, filter)).toBe(false);
    }
  });

  it('recognizes only the object-shaped resource_governor payload', () => {
    expect(isLegacyGovernorReceiptSnapshotValue(receipt())).toBe(true);
    expect(isLegacyGovernorReceiptSnapshotValue({ payload: { resource_governor: null } })).toBe(false);
    expect(isLegacyGovernorReceiptSnapshotValue({ payload: { resource_governor: 'x' } })).toBe(false);
  });

  it('resolves bare identities by exact issue id and physical scope', () => {
    const ctx = { table: 'engineer-issues', hbKey: 'WI-CROSS', sourceIndex: 1 };
    const liveOtherHarness = { ...filter, liveQualifiedKeys: ['other/WI-CROSS'] };
    expect(
      shouldDropGovernorReceiptSnapshotRow(scopedReceipt('WI-CROSS', 'harness:papercusp'), ctx, liveOtherHarness),
    ).toBe(true);
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        scopedReceipt('WI-CROSS', 'harness:other', 'other'),
        ctx,
        liveOtherHarness,
      ),
    ).toBe(false);
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        scopedReceipt('WI-CROSS', 'harness:papercusp', 'papercusp'),
        ctx,
        { ...filter, liveQualifiedKeys: ['papercusp/WI-CROSS'] },
      ),
    ).toBe(false);
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        scopedReceipt('WI-OTHER', 'harness:papercusp'),
        ctx,
        { ...filter, liveQualifiedKeys: [] },
      ),
    ).toBe(false);
    expect(
      shouldDropGovernorReceiptSnapshotRow(
        scopedReceipt('WI-CROSS', 'operator'),
        ctx,
        { ...filter, liveQualifiedKeys: [] },
      ),
    ).toBe(false);
  });
});

describe('D-024 encrypted own-log rows', () => {
  const KEY = new Uint8Array(32).fill(3) as EpochKey;
  const keys = { potId: 'papercusp', keys: [{ epoch: 1, key: KEY }] };
  const seal = async (hbKey: string, value: unknown, authorPubkey = '') => {
    const ct = await createHiveEpochCrypto().encryptOp(
      new TextEncoder().encode(JSON.stringify(value)),
      KEY,
      buildOpAAD('papercusp', 1, { tableTag: 'engineer-issues', rowKey: hbKey, authorPubkey }),
    );
    return { __rekey: Buffer.from(ct).toString('base64') };
  };
  const context = (hbKey: string) => ({ table: 'engineer-issues', hbKey, sourceIndex: 10, epoch: 1, authorPubkey: '' });

  it('judges the plaintext, and never opens a row the live census already keeps', async () => {
    const sodium = await loadSodium();
    const open = vi.fn((ct: Uint8Array, key: Uint8Array, ad: Parameters<typeof openOpCiphertext>[3]) =>
      openOpCiphertext(sodium, ct, key, ad),
    );
    const opener = governorReceiptEnvelopeOpener(keys, open);
    const dead = await seal('papercusp/WI-DEAD', receipt());
    const live = await seal('papercusp/WI-LIVE', receipt());
    const normal = await seal('papercusp/WI-NORMAL', { payload: { real_work: true } });

    expect(shouldDropGovernorReceiptSnapshotRow(dead, context('papercusp/WI-DEAD'), filter, undefined, opener)).toBe(true);
    expect(shouldDropGovernorReceiptSnapshotRow(normal, context('papercusp/WI-NORMAL'), filter, undefined, opener)).toBe(false);
    open.mockClear();
    expect(shouldDropGovernorReceiptSnapshotRow(live, context('papercusp/WI-LIVE'), filter, undefined, opener)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps and counts an envelope whose AAD does not match (wrong author) or that has no opener', async () => {
    const sodium = await loadSodium();
    let unopened = 0;
    const opener = governorReceiptEnvelopeOpener(
      keys,
      (ct, key, ad) => openOpCiphertext(sodium, ct, key, ad),
      () => (unopened += 1),
    );
    const otherAuthor = await seal('papercusp/WI-DEAD', receipt(), 'someone-else');
    expect(shouldDropGovernorReceiptSnapshotRow(otherAuthor, context('papercusp/WI-DEAD'), filter, undefined, opener)).toBe(false);
    expect(unopened).toBe(1);

    let keyless = 0;
    const noKeys = governorReceiptEnvelopeOpener(undefined, undefined, () => (keyless += 1));
    const dead = await seal('papercusp/WI-DEAD', receipt());
    expect(shouldDropGovernorReceiptSnapshotRow(dead, context('papercusp/WI-DEAD'), filter, undefined, noKeys)).toBe(false);
    expect(keyless).toBe(1);
  });

  it('authenticates a bare-key envelope with its original key before reading physical scope', async () => {
    const sodium = await loadSodium();
    const opener = governorReceiptEnvelopeOpener(keys, (ct, key, ad) => openOpCiphertext(sodium, ct, key, ad));
    const value = scopedReceipt('WI-BARE', 'harness:papercup');
    const correct = await seal('WI-BARE', value);
    const wrongAuthor = await seal('WI-BARE', value, 'another-author');
    const noneLive = { ...filter, liveQualifiedKeys: [] };
    expect(shouldDropGovernorReceiptSnapshotRow(correct, context('WI-BARE'), noneLive, undefined, opener)).toBe(true);
    expect(shouldDropGovernorReceiptSnapshotRow(wrongAuthor, context('WI-BARE'), noneLive, undefined, opener)).toBe(false);
  });
});

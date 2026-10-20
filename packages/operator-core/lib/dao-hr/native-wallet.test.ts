/** Real hosted route + SQLite constraints + signatures for the native fixture. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { startDaoHrWalletBindingFixture } from './wallet-binding-fixture';
import { identityFixtureHive, installIdentityFixture, prepareIdentityFixture } from '../../../../scripts/fixtures/dao-workbench-identity.mjs';
import { readWalletBinding, requestWalletBindingChallenge, submitWalletBinding } from '../cupboard/wallet-binding-io';

afterEach(() => vi.unstubAllEnvs());
describe('native DAO HR hosted wallet fixture', () => {
  it('loads the isolated hive epoch zero through real crypto while refusing other scopes and keychain writes', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
    vi.stubEnv('PAPERCUSP_IDENTITY_MODE', 'load-only');
    const directory = mkdtempSync(join(tmpdir(), 'dao-hr-epoch-'));
    vi.stubEnv('PAPERCUSP_IDENTITY_DIR', directory);
    const identity = JSON.parse(readFileSync(prepareIdentityFixture(directory), 'utf8'));
    const restore = installIdentityFixture(identity);
    try {
      const { createHiveEpochCrypto } = await import('../sync/hyperbee/hive-epoch-crypto-impl');
      const { keychainStore } = await import('../identity/keychain');
      const crypto = createHiveEpochCrypto();
      const key = await crypto.deriveEpochKey('workbench-native', 0);
      expect(key).toHaveLength(32);
      expect(Buffer.from(key).toString('base64')).toBe(identity.hiveEpoch0);
      expect(await crypto.deriveEpochKey('workbench-native', 0)).toEqual(key);
      const lookup = (account: string) => promisify(execFile)('secret-tool',
        ['lookup', 'service', 'papercusp-hive-epoch-key', 'account', account]);
      const publicKeys = new Set([identity.hive.publicKey]);
      const epochKeys = new Set([identity.hiveEpoch0]);
      for (const phase of ['baseline', 'copy-baseline', 'mutant']) {
        const slug = 'workbench-native-' + phase;
        const expected = identityFixtureHive(identity, slug);
        const epoch = Buffer.from(await crypto.deriveEpochKey(slug, 0)).toString('base64');
        expect(epoch).toBe(expected.epoch0);
        expect(epochKeys.has(epoch)).toBe(false); epochKeys.add(epoch);
        const hive = await promisify(execFile)('secret-tool', ['lookup', 'service', 'papercusp-hive-keypair',
          'account', 'hive:verify-tauri-isolated-123:' + slug]);
        const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(hive.stdout, 'base64'),
          format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
        expect(publicKey).toBe(expected.publicKey);
        expect(publicKeys.has(publicKey)).toBe(false); publicKeys.add(publicKey);
      }
      expect(() => identityFixtureHive(identity, 'workbench-native-foreign')).toThrow('unknown hive scope');
      expect(() => identityFixtureHive({ ...identity, hives: {} }, 'workbench-native-copy-baseline')).toThrow('no hive identity');
      await expect(lookup('workbench-native-foreign:0')).rejects.toThrow('unknown keychain identity');
      await expect(promisify(execFile)('secret-tool', ['lookup', 'service', 'papercusp-hive-keypair',
        'account', 'hive:live-workspace:workbench-native-mutant'])).rejects.toThrow('unknown keychain identity');
      await expect(lookup('workbench-native:1')).rejects.toThrow('unknown keychain identity');
      await expect(lookup('foreign-' + identity.keychainId + ':0')).rejects.toThrow('unknown keychain identity');
      await expect(keychainStore('workbench-native:0', Buffer.alloc(32), 'papercusp-hive-epoch-key'))
        .rejects.toThrow('load-only');
      await expect(promisify(execFile)('secret-tool', ['store', 'service', 'papercusp-hive-epoch-key',
        'account', 'workbench-native:0'])).rejects.toThrow('refuses OS keychain writes');
      expect(readdirSync(directory).sort()).toEqual(['announce.json', 'identity.json']);
    } finally {
      restore(); rmSync(directory, { recursive: true, force: true });
    }
  });
  it('refuses allocation outside explicitly isolated verification', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '0');
    await expect(startDaoHrWalletBindingFixture()).rejects.toThrow('requires explicit isolated verification');
  });
  it('authenticates distinct actors and verifies server challenges, replay and wallet exclusivity through production HTTP', async () => {
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED', '1');
    const directory = mkdtempSync(join(tmpdir(), 'dao-hr-wallet-'));
    const identity = JSON.parse(readFileSync(prepareIdentityFixture(directory), 'utf8'));
    const restore = installIdentityFixture(identity);
    let fixture: Awaited<ReturnType<typeof startDaoHrWalletBindingFixture>> | undefined;
    try {
      fixture = await startDaoHrWalletBindingFixture();
      expect(new URL(fixture.url).hostname).toBe('127.0.0.1');
      const candidate = { baseUrl: fixture.url, authToken: identity.actors.candidate.token };
      const admin = { baseUrl: fixture.url, authToken: identity.actors.admin.token };
      const account = privateKeyToAccount(('0x' + '2'.padStart(64, '0')) as `0x${string}`);
      const wrong = privateKeyToAccount(('0x' + '3'.padStart(64, '0')) as `0x${string}`);
      const issued = await requestWalletBindingChallenge({ walletAddress: account.address, chainId: 1 }, candidate);
      expect(issued.ok).toBe(true);
      if (!issued.ok) throw new Error('Wallet challenge failed');
      const challengeId = String(issued.value.challengeId), message = String(issued.value.message);
      expect(message).toContain('urn:papercusp:principal:gh:' + identity.actors.candidate.githubUserId);
      const foreign = await submitWalletBinding({ challengeId, signature: await account.signMessage({ message }) }, admin);
      expect(foreign).toMatchObject({ ok: false, status: 404, error: 'challenge_not_found' });
      const bad = await submitWalletBinding({ challengeId, signature: await wrong.signMessage({ message }) }, candidate);
      expect(bad.ok).toBe(false);
      const signature = await account.signMessage({ message });
      expect(await submitWalletBinding({ challengeId, signature }, candidate)).toMatchObject({ ok: true });
      expect(await readWalletBinding(candidate)).toMatchObject({ ok: true, value: { bound: true,
        binding: { walletAddress: account.address.toLowerCase(), chainId: 1, challengeId, verifiedAtMs: expect.any(Number) } } });
      expect(await readWalletBinding(admin)).toMatchObject({ ok: true, value: { bound: false } });
      expect(await submitWalletBinding({ challengeId, signature }, candidate)).toMatchObject({ ok: false, status: 409 });
      const other = await requestWalletBindingChallenge({ walletAddress: account.address, chainId: 1 }, admin);
      if (!other.ok) throw new Error('Admin wallet challenge failed');
      expect(await submitWalletBinding({ challengeId: String(other.value.challengeId),
        signature: await account.signMessage({ message: String(other.value.message) }) }, admin)).toMatchObject({ ok: false, status: 409 });
      expect(await readWalletBinding({ baseUrl: fixture.url, authToken: 'real-credential' })).toMatchObject({ ok: false, status: 401 });
    } finally {
      await fixture?.stop(); restore(); rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** Real hosted route + SQLite constraints + signatures for the native fixture. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { startDaoHrWalletBindingFixture } from './wallet-binding-fixture';
import { installIdentityFixture, prepareIdentityFixture } from '../../../../scripts/fixtures/dao-workbench-identity.mjs';
import { readWalletBinding, requestWalletBindingChallenge, submitWalletBinding } from '../cupboard/wallet-binding-io';

afterEach(() => vi.unstubAllEnvs());
describe('native DAO HR hosted wallet fixture', () => {
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

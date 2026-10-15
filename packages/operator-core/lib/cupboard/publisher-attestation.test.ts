/**
 * Channel-2 publisher attestation (relocated with the module from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 * Best-effort contract: success returns gist id + pubkey; ANY failure → null.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolvePublisherAttestation, type AttestationDeps } from './publisher-attestation';

describe('resolvePublisherAttestation (item 1)', () => {
  function deps(over: Partial<AttestationDeps> = {}): Partial<AttestationDeps> {
    return {
      resolveIdentity: async () => ({ kind: 'ok', githubUserId: 1, githubLogin: 'alice', token: 'tok' }),
      keychainIdFor: () => 'kc-1',
      loadKeypair: async () => ({ pubkeyBase64: 'PK' }),
      ensureGist: async () => 'gist123',
      ...over,
    };
  }

  it('returns gist id + pubkey on success', async () => {
    const r = await resolvePublisherAttestation(deps());
    expect(r).toEqual({ attestation_gist_id: 'gist123', publisher_device_pubkey: 'PK' });
  });

  it('returns null when gh auth is required (best-effort skip)', async () => {
    const r = await resolvePublisherAttestation(deps({ resolveIdentity: async () => ({ kind: 'gh_auth_required' }) }));
    expect(r).toBeNull();
  });

  it('returns null when the identity lacks a token', async () => {
    const r = await resolvePublisherAttestation(
      deps({ resolveIdentity: async () => ({ kind: 'ok', githubUserId: 1, githubLogin: 'alice' }) }),
    );
    expect(r).toBeNull();
  });

  it('never throws — returns null when gist resolution fails', async () => {
    const r = await resolvePublisherAttestation(
      deps({ ensureGist: async () => { throw new Error('gist api down'); } }),
    );
    expect(r).toBeNull();
  });

  // WI-10006733: without a hint ensureGist walks every gist on the account.
  it('passes the device cached gist to ensureGist as a verify-first hint', async () => {
    const ensureGist = vi.fn(async () => 'gist-known');
    const knownGistIdFor = vi.fn(async () => 'gist-known');
    const r = await resolvePublisherAttestation(deps({ ensureGist, knownGistIdFor }));
    expect(knownGistIdFor).toHaveBeenCalledWith({
      keychainId: 'kc-1',
      pubkeyBase64: 'PK',
      githubUserId: 1,
    });
    expect(ensureGist).toHaveBeenCalledWith(expect.objectContaining({ knownGistId: 'gist-known' }));
    expect(r).toEqual({ attestation_gist_id: 'gist-known', publisher_device_pubkey: 'PK' });
  });

  it('sends no hint when none is known, and a failing hint lookup is not fatal', async () => {
    for (const knownGistIdFor of [
      async () => undefined,
      async () => {
        throw new Error('cache unreadable');
      },
    ]) {
      const ensureGist = vi.fn(async (_input: Parameters<AttestationDeps['ensureGist']>[0]) => 'gist123');
      const r = await resolvePublisherAttestation(deps({ ensureGist, knownGistIdFor }));
      expect(ensureGist.mock.calls[0]?.[0]).not.toHaveProperty('knownGistId');
      expect(r).toEqual({ attestation_gist_id: 'gist123', publisher_device_pubkey: 'PK' });
    }
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Accounts tab (accounts-pool-tab-2026-06-15 P-001) reads the `accounts.pool`
 * named query. The resolver is thin glue over the separately-tested accountStatus
 * read (accounts:list ∪ accounts:status), so here we assert (1) it's registered in
 * the v2 resolver — a missing registration silently 404s the tab — and (2) it
 * returns the status rows for the resolved workspace (explicit arg wins; otherwise
 * the active workspace).
 */

const accountStatus = vi.fn();
vi.mock('../deployment/account-pool-store', () => ({
  accountStatus: (...a: unknown[]) => accountStatus(...a),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

beforeEach(() => {
  accountStatus.mockReset();
});

describe('accounts.pool resolver registration', () => {
  it('registers accounts.pool in the v2 named-query resolver', () => {
    expect(knownQueryNamesV2()).toContain('accounts.pool');
  });
});

describe('accounts.pool — read model', () => {
  const rows = [
    {
      id: 'a1',
      provider: 'claude',
      label: 'A1',
      credentialRef: 'token:/home/x/.papercusp/deploy-credentials/a1',
      boundTo: [],
      available: true,
      sustainedlyLimited: false,
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
      liveBuckets: [],
    },
    {
      id: 'codex-main',
      provider: 'codex',
      label: 'Codex',
      credentialRef: 'env:OPENAI_API_KEY',
      boundTo: [],
      available: true,
      sustainedlyLimited: false,
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
      liveBuckets: [],
    },
  ];

  it('returns the accountStatus rows for the active workspace when no workspace arg', async () => {
    accountStatus.mockResolvedValue(rows);
    const out = await resolveNamedQueryV2('accounts.pool', {});
    expect(out).toEqual(rows);
    expect(out).toContainEqual(expect.objectContaining({ id: 'codex-main', provider: 'codex' }));
    expect(accountStatus).toHaveBeenCalledWith('ws-test');
  });

  it('passes an explicit workspace arg through to accountStatus', async () => {
    accountStatus.mockResolvedValue([]);
    await resolveNamedQueryV2('accounts.pool', { workspace: 'ws-other' });
    expect(accountStatus).toHaveBeenCalledWith('ws-other');
  });

  it('preserves numeric balance, unit, timestamp, and wallet identity through the existing query', async () => {
    const creditRows = [{ ...rows[1], creditWalletId: 'wallet', rate: { ...rows[1].rate,
      creditBalance: { amount: 0, unit: 'credits', source: 'codex', observedAt: 1234 } } }];
    accountStatus.mockResolvedValue(creditRows);
    expect(await resolveNamedQueryV2('accounts.pool', {})).toEqual(creditRows);
  });
});

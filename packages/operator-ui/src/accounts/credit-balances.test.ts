import { describe, expect, it } from 'vitest';
import { CREDIT_BALANCE_STALE_MS, creditView, poolCreditSummary, type CreditAccount } from './credit-balances';

const now = 1_800_000_000_000;
const codex = (id: string, amount = 100, wallet = id): CreditAccount => ({
  id, provider: 'codex', credentialRef: `codex-cli:/private/${id}`, creditWalletId: wallet,
  rate: { creditBalance: { amount, unit: 'credits', source: 'codex', observedAt: now } },
});

describe('account pool credit display', () => {
  it('deduplicates aliases by wallet and uses the most recent reading', () => {
    const older = codex('local', 110, 'shared');
    older.rate.creditBalance!.observedAt = now - 100;
    expect(poolCreditSummary([older, codex('alias', 90, 'shared'), codex('other', 50)], 'codex', now))
      .toBe('Codex: 140.00 credits');
  });

  it('keeps a measured zero distinct from missing, stale, and failed readings', () => {
    expect(creditView(codex('zero', 0), now)?.state).toBe('fresh');
    const stale = codex('stale');
    stale.rate.creditBalance!.observedAt = now - CREDIT_BALANCE_STALE_MS - 1;
    const failed = codex('failed');
    failed.rate.lastProbeFailedAt = now + 1;
    const missing = { ...codex('missing'), rate: {} };
    expect(creditView(stale, now)?.state).toBe('stale');
    expect(creditView(failed, now)?.state).toBe('unavailable');
    expect(poolCreditSummary([codex('zero', 0), stale, failed, missing], 'codex', now))
      .toBe('Codex: 0.00 credits (partial; 3 unavailable)');
  });

  it('keeps Claude API dollars separate and omits subscription allowances', () => {
    const api: CreditAccount = { id: 'api', provider: 'claude', credentialRef: 'apikey:env:TEST',
      rate: { creditBalance: { amount: 25.42, unit: 'USD', source: 'claude-console', observedAt: now } } };
    const subscription = { ...api, id: 'max', credentialRef: 'token:/private/claude' };
    expect(creditView(subscription, now)).toBeNull();
    expect(poolCreditSummary([api, subscription, codex('codex')], 'claude', now)).toBe('Claude API: $25.42');
  });

  it('does not report an unknown or wrong-unit balance as zero', () => {
    const row = codex('unknown');
    row.rate.creditBalance!.unit = 'USD';
    expect(poolCreditSummary([row], 'codex', now)).toBe('Codex: balance unavailable');
  });

  it('does not show a prior login wallet balance after an account switches identity', () => {
    const row = codex('changed');
    row.rate.creditBalance!.walletId = 'old-wallet';
    row.creditWalletId = 'new-wallet';
    expect(creditView(row, now)?.state).toBe('unavailable');
    expect(poolCreditSummary([row], 'codex', now)).toBe('Codex: balance unavailable');
  });

  it('does not add an unlimited wallet as a zero-value numeric total', () => {
    const row = codex('unlimited');
    row.rate.creditBalance = { amount: null, unit: 'credits', source: 'codex', unlimited: true, observedAt: now };
    expect(poolCreditSummary([row], 'codex', now)).toBe('Codex: Unlimited credits');
  });
});

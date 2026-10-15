/** Account-pool wallet presentation; neither usage percentages nor spend caps are balances. */
export interface CreditBalance {
  amount: number | null;
  unit: 'credits' | 'USD';
  source: 'codex' | 'claude-console';
  unlimited?: boolean;
  walletId?: string;
  observedAt?: number;
}

export interface CreditAccount {
  id: string;
  provider?: 'claude' | 'codex';
  credentialRef: string;
  creditWalletId?: string;
  rate: { creditBalance?: CreditBalance; lastProbeFailedAt?: number };
}

export const CREDIT_BALANCE_STALE_MS = 15 * 60_000;
export const isClaudeApiAccount = (a: CreditAccount): boolean =>
  a.provider !== 'codex' && a.credentialRef.startsWith('apikey:');

export function creditView(a: CreditAccount, now: number) {
  if (a.provider !== 'codex' && !isClaudeApiAccount(a)) return null;
  const unit = a.provider === 'codex' ? 'credits' : 'USD';
  const balance = a.rate.creditBalance;
  const valid = balance?.unit === unit &&
    (!a.creditWalletId || !balance.walletId || a.creditWalletId === balance.walletId) &&
    (balance.unlimited === true || (typeof balance.amount === 'number' && Number.isFinite(balance.amount) && balance.amount >= 0));
  if (!valid || !balance?.observedAt) return { state: 'unavailable' as const, balance: undefined, unit };
  const failed = (a.rate.lastProbeFailedAt ?? 0) > balance.observedAt;
  const stale = now - balance.observedAt > CREDIT_BALANCE_STALE_MS;
  return { state: failed ? 'unavailable' as const : stale ? 'stale' as const : 'fresh' as const, balance, unit };
}

export function formatCreditBalance(balance: CreditBalance): string {
  if (balance.unlimited) return 'Unlimited credits';
  const amount = balance.amount!.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return balance.unit === 'USD' ? `$${amount}` : `${amount} credits`;
}

export function poolCreditSummary(rows: CreditAccount[], provider: 'codex' | 'claude', now: number): string | null {
  const wallets = new Map<string, CreditAccount>();
  for (const row of rows) {
    if (provider === 'codex' ? row.provider !== 'codex' : !isClaudeApiAccount(row)) continue;
    const key = row.creditWalletId ?? row.rate.creditBalance?.walletId ?? row.credentialRef;
    const previous = wallets.get(key);
    if (!previous || (row.rate.creditBalance?.observedAt ?? 0) > (previous.rate.creditBalance?.observedAt ?? 0)) wallets.set(key, row);
  }
  if (!wallets.size) return null;
  let amount = 0, known = 0, missing = 0, unlimited = false;
  for (const row of wallets.values()) {
    const view = creditView(row, now);
    if (view?.state !== 'fresh' || !view.balance) { missing++; continue; }
    known++;
    unlimited ||= view.balance.unlimited === true;
    amount += view.balance.amount ?? 0;
  }
  const label = provider === 'codex' ? 'Codex' : 'Claude API';
  if (!known) return `${label}: balance unavailable`;
  const value = formatCreditBalance({ amount, unit: provider === 'codex' ? 'credits' : 'USD', source: provider === 'codex' ? 'codex' : 'claude-console', unlimited });
  return `${label}: ${value}${missing ? ` (partial; ${missing} unavailable)` : ''}`;
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DaoFinance from './DaoFinance';
const view = { directoryId: 'dao', localHomeSlug: 'local-home', status: 'connected' as const };
const account = { ok: true, policyVersion: 7, bindings: {}, wallet: { ok: true, value: { binding: { walletAddress: '0x' + '4'.repeat(40), chainId: 1 } } },
  equity: { status: 'ready', value: { issuedShares: '42', reservedShares: '5', blockNumber: '123', governanceBound: true, supplyInvariant: true } }, treasury: { status: 'not-bound' }, commerce: { status: 'not-bound' },
  actions: [{ contract: 'PapercuspEquity', name: 'requestRecovery', inputs: [{ name: 'memberId', type: 'uint256' }, { name: 'replacement', type: 'address' }] }] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('DAO finance actions', () => {
  it('uses the reviewed policy version for unsigned preparation and never sends a wallet transaction', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return { ok: true, json: async () => path.endsWith('/policy?editor=true') ? { ok: true, canEdit: false, policy: null } : body.op === 'prepare-equity' ? { ok: true, unsignedTransaction: { to: 'bound-contract', data: '0x1234', requiresWalletSignature: true } } : account };
    });
    vi.stubGlobal('fetch', fetcher); render(<DaoFinance view={view} section="ownership" />);
    await screen.findByText('42');
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Equity action' }));
    await user.click(screen.getByRole('option', { name: 'PapercuspEquity · requestRecovery' }));
    fireEvent.change(screen.getByLabelText('Action arguments (JSON array)'), { target: { value: '["1","0x' + '5'.repeat(40) + '"]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare unsigned wallet transaction' }));
    await screen.findByRole('heading', { name: 'Review unsigned transaction' });
    const calls = fetcher.mock.calls.map(call => call[1]?.body ? JSON.parse(String(call[1].body)) : {});
    expect(calls.find(call => call.op === 'prepare-equity')).toMatchObject({ expectedPolicyVersion: 7, contract: 'PapercuspEquity', functionName: 'requestRecovery' });
    expect(calls.every(call => ['inspect', 'prepare-equity', undefined].includes(call.op))).toBe(true);
  });
  it('disables preparation on a deployment integrity failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => ({ ok: true, json: async () => path.includes('/policy') ? { ok: true, canEdit: false, policy: null } : { ...account, equity: { ...account.equity, value: { ...account.equity.value, governanceBound: false } } } })));
    render(<DaoFinance view={view} section="returns" />); await screen.findByText('Integrity check failed');
    expect((screen.getByRole('button', { name: 'Prepare unsigned wallet transaction' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

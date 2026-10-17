// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DaoFinance from './DaoFinance';
import { captureWorkbenchResponses, workbenchVerifiedWallet } from '../../../../../scripts/lib/dao-workbench-controls.mts';
import { normalizeEvmAddress } from '@papercusp/operator-core/lib/cupboard/wallet-binding';
const view = { directoryId: 'dao', localHomeSlug: 'local-home', status: 'connected' as const };
const account = { ok: true, policyVersion: 7, bindings: {}, wallet: { ok: true, value: { binding: { walletAddress: '0x' + '4'.repeat(40), chainId: 1 } } },
  equity: { status: 'ready', value: { issuedShares: '42', reservedShares: '5', blockNumber: '123', governanceBound: true, supplyInvariant: true } }, treasury: { status: 'not-bound' }, commerce: { status: 'not-bound' },
  actions: [{ contract: 'PapercuspEquity', name: 'requestRecovery', inputs: [{ name: 'memberId', type: 'uint256' }, { name: 'replacement', type: 'address' }] }] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as any).__DAO_HR_CAPTURE__; delete (window as any).__DAO_HR_RESPONSE__; });
describe('DAO finance actions', () => {
  it('matches a checksum wallet against the canonical verified record and rejects another address or chain', async () => {
    const checksum = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
    const canonical = normalizeEvmAddress(checksum)!;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/policy')
      ? { ok: true, canEdit: false, policy: null }
      : { ...account, wallet: { ok: true, value: { binding: { walletAddress: canonical, chainId: 1 } } } })));
    render(<DaoFinance view={view} section="ownership" />);
    await screen.findByText('Your verified wallet: ' + canonical + ' · chain 1');
    // The former native predicate fails despite a correctly rendered binding.
    expect(document.body.textContent!.includes(checksum)).toBe(false);
    const matches = (address: string, chain: number) => new Function('document', 'return ' + workbenchVerifiedWallet(address, chain))(document);
    expect(matches(checksum, 1)).toBe(true);
    expect(matches('0x' + '1'.repeat(40), 1)).toBe(false);
    expect(matches(checksum, 10)).toBe(false);
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async (path: string) => Response.json(path.includes('/policy')
      ? { ok: true, canEdit: false, policy: null } : { ...account, wallet: { ok: true, value: {} } })));
    render(<DaoFinance view={view} section="ownership" />); await screen.findByText('Your verified wallet: No verified wallet bound.');
    fireEvent.change(screen.getByLabelText('Wallet address'), { target: { value: checksum } });
    expect(matches(checksum, 1)).toBe(false);
  });
  it('retains wallet verification evidence after the automatic account refresh overwrites the last response', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return Response.json(path.includes('/policy') ? { ok: true, canEdit: false, policy: null }
        : body.op === 'wallet-challenge' ? { ok: true, value: { challengeId: 'challenge', message: 'Sign this exact challenge' } }
        : body.op === 'wallet-verify' ? { ok: true, value: { bound: true } } : account);
    });
    // Reproduce the native observer's former single-slot behavior on the same requests.
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      const result = await fetcher(path, init);
      if (init?.method === 'POST') (window as any).__DAO_HR_RESPONSE__ = {
        op: JSON.parse(String(init.body)).op, status: result.status, body: await result.clone().json(),
      };
      return result;
    });
    const install = () => new Function('window', 'return ' + captureWorkbenchResponses())(window);
    install(); const observer = window.fetch; install(); expect(window.fetch).toBe(observer);
    render(<DaoFinance view={view} section="ownership" />); await screen.findByText('42');
    fireEvent.change(screen.getByLabelText('Wallet address'), { target: { value: '0x' + '5'.repeat(40) } });
    fireEvent.click(screen.getByRole('button', { name: 'Request wallet signing challenge' }));
    await screen.findByText('Sign this exact challenge');
    fireEvent.change(screen.getByLabelText('Wallet signature'), { target: { value: '0x' + '1'.repeat(130) } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify wallet signature' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).op === 'inspect')).toHaveLength(2));
    await screen.findByText('42');
    expect((window as any).__DAO_HR_RESPONSE__.op).toBe('inspect');
    expect((window as any).__DAO_HR_CAPTURE__.responses['wallet-verify']).toMatchObject({
      op: 'wallet-verify', status: 200, body: { ok: true, value: { bound: true } },
    });
    expect(fetcher.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).op === 'wallet-verify')).toHaveLength(1);
    install(); expect((window as any).__DAO_HR_CAPTURE__.responses).toEqual({});
  });
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

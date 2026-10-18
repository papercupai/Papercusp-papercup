// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { captureWorkbenchResponses, workbenchTextField, workbenchTextFieldReady, workbenchButtonReady, workbenchControlDiagnostics, clickWorkbenchButton } from '../../../../../../scripts/lib/dao-workbench-controls.mts';
import OnboardingViews from './OnboardingViews';

const fetcher = vi.fn(), wallet = vi.fn(), hash = '0x' + '11'.repeat(32), address = '0x' + '22'.repeat(20);
const steps = ['contract','identity','wallet','proposal','acceptance','membership'];
const view = (complete: string[] = []) => ({ offerId:'offer',state:'signed',bindingEligible:false,isAdmin:false,isCandidate:true,chainError:null,proposalId:'123',
  plan:{chainId:1,shares:'1000',wallet:address},checklist:steps.map(key=>({key,label:key,complete:complete.includes(key)})) });
beforeEach(() => { fetcher.mockReset(); wallet.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as any).ethereum; delete (window as any).__DAO_HR_CAPTURE__; });
describe('Candidate onboarding journey', () => {
  it('can capture the challenge before its form renders and retains it after the parent refresh', async () => {
    let release!: () => void, releaseRefresh!: () => void;
    const received = new Promise<void>(resolve => { release = resolve; });
    const refreshed = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const result = { ok: true, result: { challengeId: 'challenge', message: 'exact message' } };
    let reads = 0;
    fetcher.mockImplementation(async (_url, init) => init ? {
      ok: true, status: 200, clone: () => Response.json(result),
      json: async () => { await received; return result; },
    } : { ok: true, json: async () => { if (++reads > 1) await refreshed; return { ok: true, onboarding: view(['contract']) }; } });
    const changed = vi.fn(() => root.rerender(<section data-testid="dao-workspace"><OnboardingViews daoSlug="dao" offerId="offer" onChanged={changed} /></section>));
    const root = render(<section data-testid="dao-workspace"><OnboardingViews daoSlug="dao" offerId="offer" onChanged={changed} /></section>);
    const form = await screen.findByRole('form', { name: 'Bind onboarding wallet' });
    window.eval(captureWorkbenchResponses());
    fireEvent.change(within(form).getByLabelText('Wallet address'), { target: { value: address } });
    fireEvent.submit(form);
    await waitFor(() => expect((window as any).__DAO_HR_CAPTURE__.responses['wallet-challenge']?.status).toBe(200));
    expect(screen.queryByLabelText('Wallet signature')).toBeNull();
    const ready = () => window.eval(workbenchTextFieldReady('Wallet signature', '[data-testid=dao-workspace]'));
    const buttonReady = () => window.eval(workbenchButtonReady('Verify wallet signature'));
    expect(ready()).toBe(false);
    expect(buttonReady()).toBe(false);
    expect(() => window.eval(workbenchTextField('Wallet signature', '0x' + '33'.repeat(65), '[data-testid=dao-workspace]'))).toThrow('Missing text field Wallet signature');
    await act(async () => { release(); });
    await screen.findByLabelText('Wallet signature');
    expect(ready()).toBe(true);
    expect(buttonReady()).toBe(false);
    expect(() => window.eval(clickWorkbenchButton('Verify wallet signature'))).toThrow('Unavailable control');
    const pending = window.eval(workbenchControlDiagnostics('[data-testid=dao-workspace]'));
    expect(pending.fields).toContainEqual(expect.objectContaining({ label: 'Wallet signature', tag: 'INPUT' }));
    expect(pending.buttons).toContainEqual({ text: 'Verify wallet signature', disabled: true });
    await act(async () => { releaseRefresh(); });
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(ready()).toBe(true);
    expect(buttonReady()).toBe(true);
    const signature = screen.getByLabelText('Wallet signature') as HTMLInputElement;
    act(() => { window.eval(workbenchTextField('Wallet signature', '0x' + '33'.repeat(65), '[data-testid=dao-workspace]')); });
    expect(signature.value).toBe('0x' + '33'.repeat(65));
    expect(JSON.stringify(window.eval(workbenchControlDiagnostics('[data-testid=dao-workspace]')))).not.toContain(signature.value);
    expect(screen.getByLabelText('Wallet signature')).toBe(signature);
    expect((screen.getByRole('button', { name: 'Verify wallet signature' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows incomplete steps and offers acceptance only after execution', async () => {
    fetcher.mockResolvedValue(Response.json({ok:true,onboarding:view(['contract','identity','wallet'])}));
    render(<OnboardingViews daoSlug="dao" offerId="offer" />);
    expect(await screen.findByText(/Non-binding sample/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Prepare my terms acceptance'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Prepare hire vote'})).toBeNull();
    expect(screen.getAllByRole('row', {name:/Not complete$/})).toHaveLength(3);
  });
  it('clears stale completion when a refreshed read fails and offers recovery', async () => {
    fetcher.mockImplementationOnce(async()=>Response.json({ok:true,onboarding:view(steps)})).mockImplementation(async()=>Response.json({ok:false,message:'Chain unavailable'},{status:503}));
    render(<OnboardingViews daoSlug="dao" offerId="offer" />);
    await screen.findByRole('button',{name:'Refresh onboarding'});
    fireEvent.click(screen.getByRole('button',{name:'Refresh onboarding'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('Chain unavailable'));
    expect(screen.queryByText('Complete')).toBeNull();expect(screen.getByRole('button',{name:'Retry onboarding'})).toBeTruthy();
  });
  it('keeps a wallet signature refusal incomplete and never sends a person identity', async () => {
    fetcher.mockImplementation(async(_url,init)=>{const action=init?JSON.parse(init.body):null;
      return Response.json(action?.action==='wallet-challenge'?{ok:true,result:{challengeId:'challenge',message:'exact message'}}:action?.action==='wallet-verify'?{ok:false,message:'Foreign wallet signature'}:{ok:true,onboarding:view(['contract'])},{status:action?.action==='wallet-verify'?409:200});});
    render(<OnboardingViews daoSlug="dao" offerId="offer" />);
    const form=await screen.findByRole('form',{name:'Bind onboarding wallet'});
    fireEvent.change(within(form).getByLabelText('Wallet address'),{target:{value:address}});fireEvent.submit(form);
    const signing=await screen.findByRole('form',{name:'Verify onboarding wallet signature'});
    fireEvent.change(within(signing).getByLabelText('Wallet signature'),{target:{value:'0x'+'33'.repeat(65)}});fireEvent.submit(signing);
    expect(await screen.findByText('Foreign wallet signature')).toBeTruthy();
    const bodies=fetcher.mock.calls.filter(([,init])=>init).map(([,init])=>JSON.parse(init.body));
    expect(bodies).toEqual([{action:'wallet-challenge',walletAddress:address,chainId:1},{action:'wallet-verify',challengeId:'challenge',signature:'0x'+'33'.repeat(65)}]);
    expect(screen.getAllByRole('row', {name:/Not complete$/})).toHaveLength(5);
  });
  it('reviews and signs acceptance with the bound wallet, then verifies only its hash for admission', async () => {
    fetcher.mockImplementation(async(_url,init)=>{const action=init?JSON.parse(init.body):null;
      return Response.json(action?.action==='prepare-acceptance'?{ok:true,result:{chainId:1,from:address,to:address,data:'0x1234',value:'0',requiresWalletSignature:true}}:{ok:true,onboarding:view(['contract','identity','wallet','proposal'])});});
    wallet.mockImplementation(async({method})=>method==='eth_requestAccounts'?[address]:method==='eth_chainId'?'0x1':hash);
    (window as any).ethereum={request:wallet};
    render(<OnboardingViews daoSlug="dao" offerId="offer" />);
    fireEvent.click(await screen.findByRole('button',{name:'Prepare my terms acceptance'}));
    fireEvent.click(await screen.findByRole('button',{name:'Review and sign in my wallet'}));
    await waitFor(()=>expect((screen.getByLabelText('Transaction hash') as HTMLInputElement).value).toBe(hash));
    expect(wallet).toHaveBeenLastCalledWith({method:'eth_sendTransaction',params:[{from:address,to:address,data:'0x1234',value:'0x0',chainId:'0x1'}]});
    fireEvent.click(screen.getByRole('button',{name:'Verify acceptance and admit me'}));
    await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init&&JSON.parse(init.body).action==='admit')).toBe(true));
    const admission=fetcher.mock.calls.find(([,init])=>init&&JSON.parse(init.body).action==='admit')!;
    expect(JSON.parse(admission[1].body)).toEqual({action:'admit',transactionHash:hash});
  });
});

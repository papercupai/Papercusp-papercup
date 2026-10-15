// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OnboardingViews from './OnboardingViews';

const fetcher = vi.fn(), wallet = vi.fn(), hash = '0x' + '11'.repeat(32), address = '0x' + '22'.repeat(20);
const steps = ['contract','identity','wallet','proposal','acceptance','membership'];
const view = (complete: string[] = []) => ({ offerId:'offer',state:'signed',bindingEligible:false,isAdmin:false,isCandidate:true,chainError:null,proposalId:'123',
  plan:{chainId:1,shares:'1000',wallet:address},checklist:steps.map(key=>({key,label:key,complete:complete.includes(key)})) });
beforeEach(() => { fetcher.mockReset(); wallet.mockReset(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as any).ethereum; });
describe('Candidate onboarding journey', () => {
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

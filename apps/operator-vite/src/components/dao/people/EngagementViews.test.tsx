// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import EngagementViews from './EngagementViews';
import DaoWorkspaceDetails from '../DaoWorkspaceDetails';

vi.mock('./OnboardingViews',()=>({default:()=> <section aria-label="Signer onboarding" /> }));
const fetcher=vi.fn(),wallet=vi.fn(),hash='0x'+'11'.repeat(32),address='0x'+'22'.repeat(20);
const transaction={chainId:1,from:address,to:address,data:'0x1234',value:'0',contract:'PapercuspEquityV2',functionName:'resignGrant',args:[]};
const view=(extra:Record<string,unknown>={})=>({offerId:'offer',isAdmin:false,isCandidate:true,bindingEligible:false,admitted:true,amendsOfferId:null,signed:true,fireProposalId:null,offboarding:null,amendment:null,...extra});
beforeEach(()=>{fetcher.mockReset();wallet.mockReset();vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();delete (window as any).ethereum;});
const show=()=>render(<EngagementViews daoSlug="dao" offerId="offer" />);
describe('Signed engagement actions',()=>{
  it('offers only own resignation to the signer and verifies its lookup hash after wallet signing',async()=>{
    fetcher.mockImplementation(async(_url,init)=>init?Response.json({ok:true,result:JSON.parse(init.body).action==='prepare-resignation'?transaction:{}}):Response.json({ok:true,engagement:view()}));
    wallet.mockImplementation(async({method})=>method==='eth_requestAccounts'?[address]:method==='eth_chainId'?'0x1':hash);
    (window as any).ethereum={request:wallet};show();
    fireEvent.click(await screen.findByRole('button',{name:'Prepare my resignation'}));
    expect(screen.queryByRole('button',{name:'Prepare fire vote'})).toBeNull();
    fireEvent.click(await screen.findByRole('button',{name:'Review and sign in my wallet'}));
    await waitFor(()=>expect((screen.getByLabelText('Transaction hash') as HTMLInputElement).value).toBe(hash));
    expect(wallet).toHaveBeenLastCalledWith({method:'eth_sendTransaction',params:[{from:address,to:address,data:'0x1234',value:'0x0',chainId:'0x1'}]});
    fireEvent.click(screen.getByRole('button',{name:'Verify confirmed transaction'}));
    await waitFor(()=>expect(fetcher.mock.calls.some(([,init])=>init&&JSON.parse(init.body).action==='complete-resignation')).toBe(true));
    const sent=fetcher.mock.calls.filter(([,init])=>init).map(([,init])=>JSON.parse(init.body));
    expect(sent).toEqual([{action:'prepare-resignation'},{action:'complete-resignation',transactionHash:hash}]);
  });
  it('keeps the member fire vote pending until its execution receipt is verified',async()=>{
    fetcher.mockImplementation(async(_url,init)=>init?Response.json({ok:true,result:{plan:{proposalId:'123'},unsignedTransaction:transaction}}):Response.json({ok:true,engagement:view({isAdmin:true,isCandidate:false,fireProposalId:'123'})}));
    show();fireEvent.click(await screen.findByRole('button',{name:'Prepare fire vote'}));
    await screen.findByRole('button',{name:'Review and sign in my wallet'});
    expect(screen.getByText(/Use the executed fire proposal/)).toBeTruthy();
    expect((screen.getByRole('button',{name:'Verify confirmed transaction'}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button',{name:'Prepare my resignation'})).toBeNull();
    expect(fetcher.mock.calls.filter(([,init])=>init).map(([,init])=>JSON.parse(init.body))).toEqual([{action:'prepare-fire'}]);
  });
  it('executes newly signed pay-only amendments with no wallet transaction or governance action',async()=>{
    fetcher.mockImplementation(async(_url,init)=>init?Response.json({ok:true,result:{plan:{amount:'1000'},unsignedTransaction:null}}):Response.json({ok:true,engagement:view({isAdmin:true,isCandidate:false,amendsOfferId:'parent',admitted:false})}));
    show();fireEvent.click(await screen.findByRole('button',{name:'Prepare signed amendment'}));
    fireEvent.click(await screen.findByRole('button',{name:'Execute signed pay amendment'}));
    await waitFor(()=>expect(fetcher.mock.calls.filter(([,init])=>init)).toHaveLength(2));
    expect(fetcher.mock.calls.filter(([,init])=>init).map(([,init])=>JSON.parse(init.body))).toEqual([{action:'prepare-amendment'},{action:'complete-amendment',transactionHash:null}]);
    expect(screen.queryByLabelText('Transaction hash')).toBeNull();expect(wallet).not.toHaveBeenCalled();
  });
  it('disables unsigned amendments and removes write actions from retained offboarding records',async()=>{
    fetcher.mockResolvedValue(Response.json({ok:true,engagement:view({isAdmin:true,amendsOfferId:'parent',signed:false})}));
    const rendered=show();expect((await screen.findByRole('button',{name:'Prepare signed amendment'}) as HTMLButtonElement).disabled).toBe(true);
    fetcher.mockResolvedValue(Response.json({ok:true,engagement:view({offboarding:{kind:'fired',retainedEarned:'700'}})}));
    fireEvent.click(screen.getByRole('button',{name:'Refresh engagement'}));await screen.findByText(/Retained earned shares: 700/);
    expect(screen.queryByRole('button',{name:'Prepare my resignation'})).toBeNull();expect(screen.queryByRole('button',{name:'Prepare fire vote'})).toBeNull();rendered.unmount();
  });
  it('clears stale records after an authorization refusal and supports retry',async()=>{
    fetcher.mockResolvedValueOnce(Response.json({ok:true,engagement:view()}));show();await screen.findByRole('button',{name:'Prepare my resignation'});
    fetcher.mockResolvedValueOnce(Response.json({ok:false,message:'Foreign signer'},{status:403}));
    fireEvent.click(screen.getByRole('button',{name:'Refresh engagement'}));await screen.findByText('Foreign signer');
    expect(screen.queryByRole('button',{name:'Prepare my resignation'})).toBeNull();expect(screen.getByRole('button',{name:'Retry engagement'})).toBeTruthy();
  });
  it('discards a delayed action response when the offer changes',async()=>{
    let resolve:(value:Response)=>void=()=>{};
    fetcher.mockImplementation(async(_url,init)=>init?new Promise<Response>(done=>{resolve=done;}):Response.json({ok:true,engagement:view()}));
    const rendered=show();fireEvent.click(await screen.findByRole('button',{name:'Prepare my resignation'}));
    rendered.rerender(<EngagementViews daoSlug="dao" offerId="other" />);await screen.findByRole('button',{name:'Prepare my resignation'});
    await act(async()=>{resolve(Response.json({ok:true,result:transaction}));});
    expect(screen.queryByRole('button',{name:'Review and sign in my wallet'})).toBeNull();
  });
  it('keeps signer onboarding and retained records reachable without contributor work access',async()=>{
    fetcher.mockResolvedValue(Response.json({ok:true,engagement:view({offboarding:{kind:'resigned',retainedEarned:'500'}})}));
    render(<DaoWorkspaceDetails section="members" view={{directoryId:'dao',localHomeSlug:null,contractHomeSlug:'local-dao',status:'not-joined'}} loading={false} error="" />);
    const form=screen.getByRole('form',{name:'Open signed engagement'});
    fireEvent.change(within(form).getByLabelText('Signed offer reference'),{target:{value:'offer'}});fireEvent.submit(form);
    expect(screen.getByRole('region',{name:'Signer onboarding'})).toBeTruthy();await screen.findByText(/Retained earned shares: 500/);
    expect(screen.queryByRole('link',{name:'Open contributor work'})).toBeNull();
    expect(fetcher).toHaveBeenCalledWith('/api/pot/local-dao/contracts/offer/engagement');
  });
});

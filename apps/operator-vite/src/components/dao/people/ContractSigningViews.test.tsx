// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HiringView } from '@papercusp/operator-core/lib/dao-hr/hiring';
import ContractSigningViews from './ContractSigningViews';
// Radix Select portals are noise here — a native stand-in with the same contract keeps options + onChange routing assertable.
vi.mock('@/app/harness/Select',()=>({Select:({value,onChange,options,ariaLabel,placeholder}:{value:string;onChange:(v:string)=>void;options:Array<{value:string;label:string}>;ariaLabel?:string;placeholder?:string})=>(
  <select aria-label={ariaLabel} value={value} onChange={e=>onChange(e.target.value)}>{placeholder?<option value="">{placeholder}</option>:null}{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>)}));
const offer:HiringView['offers'][number]={workspaceId:'ws',daoSlug:'dao',offerId:'offer',roleId:'role',personId:'PER-candidate',authoredBy:'PER-author',approvalsRequired:1,approvedBy:['PER-reviewer'],state:'approved',preview:null,
  terms:{engagementType:'employee',jurisdiction:'US-DE',employmentLike:false,pay:{amount:'5000',currency:'USD',cadence:'monthly'},equity:{shares:1000,vestingDays:1460,cliffDays:365,startRule:'hire_passed',policyVersion:2}}};
const templates=[{templateKey:'employment',documentKind:'employment-agreement',engagementType:'employee',jurisdiction:'US-DE',title:'Employment agreement',latestVersion:3},{templateKey:'equity',documentKind:'equity-grant-agreement',engagementType:'employee',jurisdiction:'US-DE',title:'Equity agreement',latestVersion:2},
  {templateKey:'wrong',documentKind:'employment-agreement',engagementType:'contractor',jurisdiction:'UK',title:'Unrelated agreement',latestVersion:1}];
const fetcher=vi.fn(),changed=vi.fn();
const people:HiringView['people']=[{personId:'PER-candidate',displayName:'Candidate',isHrAdmin:false},{personId:'PER-company',displayName:'Company signer',isHrAdmin:true}];
const show=(rows=people)=>render(<ContractSigningViews daoSlug="dao" offer={offer} people={rows} onChanged={changed}/>);
describe('Contract signing Workbench',()=>{
  beforeEach(()=>{fetcher.mockReset().mockImplementation(async()=>Response.json({ok:true,templates,execution:null}));changed.mockReset();vi.stubGlobal('fetch',fetcher);});
  afterEach(()=>{cleanup();vi.unstubAllGlobals();});
  it('uses only matching registry versions and sends references, company person and date without editable offer terms',async()=>{
    show();const form=await screen.findByRole('form',{name:'Generate contract'});
    expect(screen.queryByText('Unrelated agreement · v1')).toBeNull();
    expect((screen.getByRole('button',{name:'Generate contract'})as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('option',{name:'Candidate'})).toBeNull();
    fireEvent.change(screen.getByLabelText('Company countersigner'),{target:{value:'PER-company'}});
    expect((screen.getByRole('button',{name:'Generate contract'})as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Start date'),{target:{value:'2026-11-01'}});fireEvent.submit(form);
    await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
    const call=fetcher.mock.calls.find(c=>c[1]?.method==='POST')!;
    expect(JSON.parse(call[1].body)).toEqual({action:'prepare',offerId:'offer',companyPersonId:'PER-company',startDate:'2026-11-01',templates:[{templateKey:'employment',version:3},{templateKey:'equity',version:2}]});
  });
  it('keeps signed samples non-binding and links both executed artifacts',async()=>{
    fetcher.mockResolvedValue(Response.json({ok:true,templates,execution:{contractId:'contract',state:'signed',bindingEligible:false,documentHash:'0x'+ '11'.repeat(32),completedAt:'2026-10-11',signingLinks:null}}));
    show();await screen.findByText('Contract stage: signed');
    expect(screen.getByText(/Non-binding sample/)).toBeTruthy();expect(screen.queryByText('Binding contract; hire proposal executed.')).toBeNull();
    expect((screen.getByRole('link',{name:'Download sealed contract'})as HTMLAnchorElement).getAttribute('href')).toBe('/api/pot/dao/contracts/offer/document?kind=sealed');
    expect(screen.getByRole('link',{name:'Download signing audit certificate'})).toBeTruthy();
  });
  it('offers only current DAO HR admins and invalidates a selected signer removed by a refresh',async()=>{
    const rows=[...people,{personId:'PER-foreign',displayName:'Other DAO admin',isHrAdmin:false},
      {personId:'PER-unknown',displayName:'Unverified eligibility'} as HiringView['people'][number]];
    const view=show(rows);
    const form=await screen.findByRole('form',{name:'Generate contract'});
    expect(screen.queryByRole('option',{name:'Other DAO admin'})).toBeNull();
    expect(screen.queryByRole('option',{name:'Unverified eligibility'})).toBeNull();
    fireEvent.change(screen.getByLabelText('Company countersigner'),{target:{value:'PER-company'}});
    expect((screen.getByRole('button',{name:'Generate contract'})as HTMLButtonElement).disabled).toBe(false);
    view.rerender(<ContractSigningViews daoSlug="dao" offer={offer} people={rows.map(p=>({...p,isHrAdmin:false}))} onChanged={changed}/>);
    expect((screen.getByRole('button',{name:'Generate contract'})as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form);
    expect(fetcher.mock.calls.filter(c=>c[1]?.method==='POST')).toEqual([]);
  });
  it('describes an eligible signed contract as conditional until execution',async()=>{
    fetcher.mockResolvedValue(Response.json({ok:true,templates,execution:{contractId:'contract',state:'signed',bindingEligible:true,documentHash:null,completedAt:null,signingLinks:null}}));
    show();await screen.findByText(/Conditional contract/);expect(screen.queryByText('Binding contract; hire proposal executed.')).toBeNull();
  });
  it('a malformed read reports an error instead of crashing or inventing an empty registry',async()=>{
    fetcher.mockResolvedValue(Response.json({ok:true}));show();
    const alert=await screen.findByRole('alert');expect(alert.textContent).toContain('Contract records could not be read.');
    expect(screen.getByRole('button',{name:'Retry contract read'})).toBeTruthy();
  });
  it('recovers a lost dispatch through its existing envelope and refreshes the signing state',async()=>{
    let recovered=false;
    fetcher.mockImplementation(async(_url:string,init?:RequestInit)=>{
      if(init?.method==='POST'){recovered=true;return Response.json({ok:true,state:'signing'});}
      return Response.json({ok:true,templates,execution:{contractId:'contract-reference',state:recovered?'signing':'dispatching',bindingEligible:false,documentHash:null,completedAt:null,signingLinks:null}});
    });
    show();const form=await screen.findByRole('form',{name:'Recover signing dispatch'});
    fireEvent.change(screen.getByLabelText('Documenso envelope ID'),{target:{value:'existing-envelope'}});fireEvent.submit(form);
    await screen.findByText('Contract stage: signing');
    expect(changed).toHaveBeenCalledOnce();
    const call=fetcher.mock.calls.find(c=>c[1]?.method==='POST')!;
    expect(JSON.parse(call[1].body)).toEqual({action:'reconcile',offerId:'offer',envelopeId:'existing-envelope'});
    expect(screen.queryByRole('button',{name:'Start signatures'})).toBeNull();
  });
});

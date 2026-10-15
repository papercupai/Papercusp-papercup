import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeFunctionData } from 'viem';
import { buildHirePlan, onboardingChecklist, type OnboardingContract } from './onboarding';
import type { HiringOffer } from './hiring';
import type { WorkProfile } from './work-profile';
import { equityArtifacts } from '../equity/runtime';

const address = ('0x'+'11'.repeat(20)) as `0x${string}`,hash=('0x'+'22'.repeat(32)) as `0x${string}`;
function fixture(startRule:'hire_passed'|'start_date'|'contract_signed'='hire_passed') {
  const sealed_pdf=Buffer.from('exact sealed signed contract');
  const contract={state:'signed',contract_id:'contract-1',document_hash:'0x'+createHash('sha256').update(sealed_pdf).digest('hex'),sealed_pdf,
    audit_certificate:Buffer.from('certificate'),completed_at:'2026-10-12T00:00:00Z',merge_values:{start_date:'2026-11-01'},candidate_github_id:42,
    hire_plan:null,hire_execution_proof:null,terms_acceptance_proof:null,admitted_at:null} as unknown as OnboardingContract;
  const offer={workspaceId:'ws-unit',daoSlug:'dao',personId:'PER-42',terms:{equity:{shares:1000,startRule,vestingDays:365,cliffDays:30}}} as HiringOffer;
  const profile={personId:'PER-42',status:'onboarding',memberGithubUserId:42,wallet:{address,chainId:1}} as WorkProfile;
  const binding={chainId:1,equity:address,governor:address,timelock:address};
  return {contract,offer,profile,binding};
}
describe('P007 immutable hire transaction and visible checklist',()=>{
  it.each(['hire_passed','start_date','contract_signed'] as const)('encodes %s from signed terms with one atomic register+grant proposal',startRule=>{
    const f=fixture(startRule),p=buildHirePlan(f.offer,f.contract,f.profile,f.binding,hash);
    const decoded=decodeFunctionData({abi:equityArtifacts.contracts.PapercuspEquityV2.abi,data:p.calldatas[1]!});
    expect(p.calldatas).toHaveLength(2);expect(decoded.functionName).toBe('commitGrant');
    expect(decoded.args?.[0]).toBe(f.contract.document_hash);expect(decoded.args?.[2]).toBe(1000n);
    const start=startRule==='hire_passed'?0n:BigInt(Date.parse(startRule==='start_date'?'2026-11-01':f.contract.completed_at!)/1000);
    expect(decoded.args?.slice(3).map(v=>BigInt(String(v)))).toEqual([start,start+30n*86400n,start+365n*86400n]);
    expect(buildHirePlan(f.offer,f.contract,f.profile,f.binding,hash).proposalId).toBe(p.proposalId);
    expect(p.description).toContain(f.contract.document_hash!);
  });
  it('refuses a changed document, missing signature evidence, wrong identity or wrong-chain wallet',()=>{
    const f=fixture(),build=(c=f.contract,p=f.profile)=>buildHirePlan(f.offer,c,p,f.binding,hash);
    expect(()=>build({...f.contract,sealed_pdf:Buffer.from('tampered')})).toThrow('sealed contract');
    expect(()=>build({...f.contract,audit_certificate:null})).toThrow('sealed contract');
    expect(()=>build({...f.contract,state:'signing'})).toThrow('sealed contract');
    expect(()=>build(f.contract,{...f.profile,memberGithubUserId:43})).toThrow('wallet');
    expect(()=>build(f.contract,{...f.profile,wallet:{...f.profile.wallet!,chainId:2}})).toThrow('wallet');
  });
  it('failed chain reads, missing proofs and lapsed offers never display complete admission',()=>{
    const f=fixture(),proof={transactionHash:hash,blockNumber:'1',blockHash:hash};
    expect(onboardingChecklist(f.contract,f.profile).slice(3).every(s=>!s.complete)).toBe(true);
    const complete={...f.contract,hire_execution_proof:proof,terms_acceptance_proof:proof,admitted_at:'2026-10-12'};
    const active={...f.profile,status:'active' as const};
    expect(onboardingChecklist(complete,active).every(s=>s.complete)).toBe(true);
    expect(onboardingChecklist(complete,active,'RPC unavailable').slice(3).every(s=>!s.complete)).toBe(true);
    expect(onboardingChecklist({...complete,state:'lapsed'},active).slice(3).every(s=>!s.complete)).toBe(true);
    expect(onboardingChecklist(complete,{...active,status:'onboarding'}).at(-1)?.complete).toBe(false);
  });
});

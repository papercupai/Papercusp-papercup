/** Real Postgres + signed V2 EVM transactions. Provider completion is a fixture,
 * so this suite is tree evidence and never claims live Documenso acceptance. */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import type { Hex, Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { installIdentityFixture, prepareIdentityFixture } from '../../../../scripts/fixtures/dao-workbench-identity.mjs';
import { startDaoHrWalletBindingFixture } from './wallet-binding-fixture';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { equityV2Evm } from '../equity/evm-test-helpers';
import { unsafeFederatedPotScope } from '../federated-pot-scope';
import { listHiveMembers, upsertHiveMember } from '../hive-membership-store';
import { createContractTemplate, generateContract, grantDaoHrAdmin, installSampleTemplates, isDaoHrAdmin } from './contract-templates';
import { completeEngagementAmendment, completeEngagementEnd, prepareEngagementAmendment, prepareEngagementFire, prepareEngagementResignation } from './engagement-changes';
import { addHiringCandidate, approveHiringOffer, createHiringOffer, createHiringRole, getHiringOffer, HiringError, listHiringHistory } from './hiring';
import { completeContractSigning, prepareContractExecution, startContractSigning } from './contracts-esign';
import { DocumensoAdapter } from './documenso';
import { getWorkProfile } from './work-profile';
import { DEFAULT_EQUITY_POLICY, resolveOfferTermsFrom, updateEquityPolicy } from './equity-policy';
import { admitHire, onboardingChecklist, prepareHireAcceptance, prepareHireProposal, readOnboarding, recordHireExecution, recordHireProposal, reconcileFailedHire, runOnboardingWalletAction, verifyOnboardingIdentity,
  type CandidateIdentity, type OnboardingChain, type OnboardingContract, type OnboardingDeps } from './onboarding';
import type { HivePolicy } from '../hive-policy-schema';
import { buildDaoWorkspaceView } from '../dao-workspace-view';
import type { HiveDirectoryBrowseRow } from '../discovery-hive-rows';

const key={workspaceId:'ws-onboarding',daoSlug:'onboarding-dao'},secret='test-only-fixture-secret-longer-than-24-characters';
let db:OrgTestDb,e:Awaited<ReturnType<typeof equityV2Evm>>,roleId:string,policy:HivePolicy,chain:OnboardingChain;
const scope=unsafeFederatedPotScope(key.daoSlug,'Test writes and reads the same synthetic owner scope');
const candidate:CandidateIdentity={githubUserId:42,githubLogin:'new-member',verifiedEmails:['candidate@example.test']};
const wallet=(index=1)=>async()=>({ok:true as const,status:200,value:{bound:true,binding:{walletAddress:e.accounts[index],chainId:1,challengeId:'signed-server-challenge',verifiedAtMs:Date.now()}}});
const deps=():OnboardingDeps=>({sql:db.adminSql,chain,identity:async()=>candidate,wallet:wallet(),adminPerson:async()=> 'PER-author',scope:async()=>scope});
const confirm=()=>{e.advance(1);e.advance(1);};
const row=async(offerId:string)=>(await db.adminSql<OnboardingContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE offer_id=${offerId}`)[0]!;
async function contributorWorkspace(viewer: number) {
  const directory = {potId:key.daoSlug,title:'DAO',hivePubkey:'fixture-pubkey'} as HiveDirectoryBrowseRow;
  return buildDaoWorkspaceView(key.workspaceId, directory, {
    viewerGithubId: async () => viewer,
    projects: async () => [{slug:key.daoSlug,harness_kind:'hive',path:'/fixture/onboarding-dao'}],
    hive: async () => ({pubkeyBase64:'fixture-pubkey'}) as never,
    members: async () => listHiveMembers(key.workspaceId, scope, db.adminSql),
    policyScope: async () => scope, policy: async () => null,
    governance: async () => ({events:[],integrityErrors:[],conflictedRoundIds:new Set()}) as never,
    plans: async () => [],
  });
}
async function signedOffer(personId='PER-candidate') {
  await addHiringCandidate({...key,roleId,personId,actorPersonId:'PER-author'},{sql:db.adminSql});
  const offer=await createHiringOffer({...key,roleId,personId,actorPersonId:'PER-author',engagementType:'employee',jurisdiction:'US-DE',pay:{amount:'5000',currency:'USD',cadence:'monthly'},overrides:{shares:1000}},{sql:db.adminSql});
  await approveHiringOffer({...key,offerId:offer.offerId,actorPersonId:'PER-reviewer'},{sql:db.adminSql});
  return signExistingOffer(offer.offerId);
}
async function signExistingOffer(offerId:string,templates=[{templateKey:'sample-employment-agreement-employee-us-de',version:1},{templateKey:'sample-equity-grant-agreement-employee-us-de',version:1}]) {
  let contract=await prepareContractExecution({...key,offerId,actorPersonId:'PER-author',companyPersonId:'PER-reviewer',startDate:'2026-11-01',templates},{sql:db.adminSql});
  const envelope='envelope-'+contract.contract_id;
  const provider=new DocumensoAdapter({baseUrl:'https://provider.example.test',apiKey:'fixture',webhookSecret:secret},async(url)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/create'))return Response.json({id:envelope});
    if(path.endsWith('/distribute'))return Response.json({id:envelope,recipients:contract.signers.map((s,i)=>({email:s.email,signingUrl:'https://provider.example.test/sign/'+i}))});
    if(path.endsWith('/download'))return new Response(new Uint8Array(contract.source_pdf),{headers:{'Content-Type':'application/pdf'}});
    return Response.json({id:envelope,externalId:contract.contract_id,status:'COMPLETED',completedAt:'2026-10-11T20:00:00Z',recipients:contract.signers.map(s=>({...s,role:'SIGNER',signingStatus:'SIGNED',signedAt:'2026-10-11T19:00:00Z',authOptions:{accessAuth:['ACCOUNT']}})),envelopeItems:[{id:'item'}]});
  });
  contract=await startContractSigning({...key,offerId,actorPersonId:'PER-author'},{sql:db.adminSql,adapter:provider});
  await completeContractSigning(secret,{event:'DOCUMENT_COMPLETED',createdAt:'2026-10-11T20:00:00Z',payload:{envelopeId:envelope,externalId:contract.contract_id,status:'COMPLETED'}},{sql:db.adminSql,adapter:provider});
  return {...key,offerId};
}
beforeAll(async()=>{
  // Cheap automatic fixture preflight runs before any DB/EVM allocation.
  expect(resolveOfferTermsFrom({...DEFAULT_EQUITY_POLICY,startRule:'hire_passed'},1,{role:'Engineer',level:'L3',overrides:{shares:1000}}).startRule).toBe('hire_passed');
  db=await createOrgTestDb();e=await equityV2Evm();
  await db.adminSql`INSERT INTO harness_shared.pots (workspace_id,pot_home_slug,public_key,keychain_id,created_at)
    VALUES (${key.workspaceId},${key.daoSlug},${Buffer.alloc(32,7)},${'onboarding-fixture-keychain'},${Date.now()})`;
  expect(await db.adminSql`SELECT pot_home_slug FROM harness_shared.pots WHERE workspace_id=${key.workspaceId} AND pot_home_slug=${key.daoSlug}`).toHaveLength(1);
  for(const file of ['1462-dao-hr-hiring.sql','1463-dao-hr-contracts-esign.sql','1464-dao-hr-onboarding-proof.sql','1465-dao-hr-engagement-changes.sql']){
    const path=new URL('../../../../libs/papercusp/libs/db/sql/'+file,import.meta.url);
    await db.adminSql.unsafe(readFileSync(existsSync(path)?path:new URL(path.href+'.DRAFT'),'utf8'));
  }
  for(const [id,title,email] of [['PER-author','Author','author@example.test'],['PER-reviewer','Reviewer','reviewer@example.test'],['PER-candidate','Candidate','candidate@example.test'],['PER-second','Other candidate','second@example.test'],['PER-race','Concurrent candidate','race@example.test'],['PER-resigner','Resigning member','resigner@example.test'],['PER-expired','Expired proposal candidate','expired@example.test']])
    await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload) VALUES (${key.workspaceId},'papercusp',${id!},'person',${title!},${db.adminSql.json({email})})`;
  await grantDaoHrAdmin({...key,personId:'PER-author',bootstrapOperator:'fixture'},{sql:db.adminSql});
  await grantDaoHrAdmin({...key,personId:'PER-reviewer',grantedBy:'PER-author'},{sql:db.adminSql});
  await installSampleTemplates({...key,actorPersonId:'PER-author'},{sql:db.adminSql});
  await updateEquityPolicy({...key,actorPersonId:'PER-author',changes:{startRule:'hire_passed'}},{sql:db.adminSql});
  roleId=(await createHiringRole({...key,actorPersonId:'PER-author',title:'Engineer',level:'L3'},{sql:db.adminSql})).roleId;
  policy={finance:{equity:{chainId:1,equity:e.equity.address,governor:e.governor.address,timelock:e.timelock.address}}} as HivePolicy;
  chain={getChainId:async()=>1,getBlockNumber:async()=>e.blockNumber(),getCode:async({address})=>bytesToHex(await e.vm.stateManager.getCode(createAddressFromString(address))),
    readContract:async({address,abi,functionName,args})=>e.read({address:address as Address,abi},functionName,args),getTransaction:e.getTransaction,getTransactionReceipt:e.getTransactionReceipt,getBlock:e.getBlock};
},180_000);
afterAll(async()=>{await db?.cleanup();});
describe('P007 — identity, one hire vote, acceptance and membership',()=>{
  it('persists a wallet link only after the candidate signs the production hosted challenge',async()=>{
    vi.stubEnv('PAPERCUSP_VERIFY_TAURI_ISOLATED','1');
    const directory=mkdtempSync(join(tmpdir(),'dao-hr-onboarding-wallet-'));
    const identity=JSON.parse(readFileSync(prepareIdentityFixture(directory),'utf8'));
    const restore=installIdentityFixture(identity);
    let hosted:Awaited<ReturnType<typeof startDaoHrWalletBindingFixture>>|undefined;
    try {
      hosted=await startDaoHrWalletBindingFixture();
      vi.stubEnv('PAPERCUSP_CUPBOARD_URL',hosted.url);
      const actor=identity.actors.candidate;
      await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload)
        VALUES (${key.workspaceId},'papercusp','PER-wallet-proof','person','Signed-wallet candidate',${db.adminSql.json({email:actor.email})})`;
      const k=await signedOffer('PER-wallet-proof');
      // Only the external GitHub identity transport is a fixture. The hosted
      // challenge, signature recovery, SQLite uniqueness and HR PG writes run.
      const d:OnboardingDeps={sql:db.adminSql,identity:async()=>({githubUserId:actor.githubUserId,
        githubLogin:actor.githubLogin,verifiedEmails:[actor.email],authToken:actor.token})};
      const account=privateKeyToAccount(bytesToHex(randomBytes(32)));
      const wrong=privateKeyToAccount(bytesToHex(randomBytes(32)));
      await expect(verifyOnboardingIdentity(k,d)).rejects.toMatchObject({code:'wallet_unverified'});
      expect(await getWorkProfile({...key,personId:'PER-wallet-proof'},{sql:db.adminSql})).toBeNull();
      expect((await row(k.offerId)).candidate_github_id).toBeNull();
      const issued=await runOnboardingWalletAction(k,{action:'wallet-challenge',walletAddress:account.address,chainId:1},d);
      expect(issued.ok).toBe(true);
      if(!issued.ok) throw new Error('Hosted wallet challenge failed');
      const challengeId=String(issued.value.challengeId),message=String(issued.value.message);
      expect(message).toContain('urn:papercusp:principal:gh:'+actor.githubUserId);
      // SPEC-P-007-A: an issued challenge cannot bind without a signature.
      expect(await runOnboardingWalletAction(k,{action:'wallet-verify',challengeId,signature:''},d)).toMatchObject({ok:false,status:422});
      await expect(verifyOnboardingIdentity(k,d)).rejects.toMatchObject({code:'wallet_unverified'});
      expect(await getWorkProfile({...key,personId:'PER-wallet-proof'},{sql:db.adminSql})).toBeNull();
      const bad=await runOnboardingWalletAction(k,{action:'wallet-verify',challengeId,signature:await wrong.signMessage({message})},d);
      // The cryptographic boundary must reject a signature recovered to a
      // different wallet before the hosted challenge is consumed. Checking
      // only ok:false would also pass if a later persistence layer rejected
      // an already-consumed or mismatched challenge.
      expect(bad).toMatchObject({ok:false,status:422,error:'address_mismatch'});
      await expect(verifyOnboardingIdentity(k,d)).rejects.toMatchObject({code:'wallet_unverified'});
      expect(await getWorkProfile({...key,personId:'PER-wallet-proof'},{sql:db.adminSql})).toBeNull();
      const signature=await account.signMessage({message});
      expect(await runOnboardingWalletAction(k,{action:'wallet-verify',challengeId,signature},d)).toMatchObject({ok:true});
      const linked=await verifyOnboardingIdentity(k,d);
      expect(linked).toMatchObject({personId:'PER-wallet-proof',memberGithubUserId:actor.githubUserId,
        wallet:{address:account.address.toLowerCase(),chainId:1,bindingRef:challengeId}});
      expect(Number((await row(k.offerId)).candidate_github_id)).toBe(actor.githubUserId);
      expect(await runOnboardingWalletAction(k,{action:'wallet-verify',challengeId,signature},d)).toMatchObject({ok:false,status:409});
      expect((await getWorkProfile({...key,personId:'PER-wallet-proof'},{sql:db.adminSql}))?.wallet?.address).toBe(account.address.toLowerCase());
    } finally {
      await hosted?.stop();restore();vi.unstubAllEnvs();rmSync(directory,{recursive:true,force:true});
    }
  },120_000);
  it('rejects a foreign signer identity, unverified hosted binding and duplicate wallet before saving any link',async()=>{
    const k=await signedOffer();
    await expect(verifyOnboardingIdentity(k,{...deps(),identity:async()=>({...candidate,verifiedEmails:['stranger@example.test']})})).rejects.toMatchObject({code:'identity_mismatch'});
    await expect(verifyOnboardingIdentity(k,{...deps(),wallet:async()=>({ok:true,status:200,value:{binding:{walletAddress:e.accounts[1],chainId:1}}})})).rejects.toMatchObject({code:'wallet_unverified'});
    expect((await row(k.offerId)).candidate_github_id).toBeNull();
    expect(await getWorkProfile({...key,personId:'PER-candidate'},{sql:db.adminSql})).toBeNull();
    await verifyOnboardingIdentity(k,deps());
    const signer={...deps(),adminPerson:async()=>{throw new HiringError('not_admin','Candidate is not an admin');}};
    const beforeAdmission=await readOnboarding(k,policy,signer);
    expect(beforeAdmission.isCandidate).toBe(true);expect(beforeAdmission.isAdmin).toBe(false);
    expect(beforeAdmission.checklist.find(step=>step.key==='membership')?.complete).toBe(false);
    await expect(readOnboarding(k,policy,{...signer,identity:async()=>({...candidate,verifiedEmails:['foreign@example.test']})})).rejects.toMatchObject({code:'identity_mismatch'});
    // Simulate the database arbitrating a race after application preflight.
    const begin=vi.spyOn(db.adminSql,'begin').mockRejectedValueOnce({code:'23505',constraint_name:'dao_hr_work_profiles_verified_wallet_uniq'});
    try { await expect(verifyOnboardingIdentity(k,deps())).rejects.toMatchObject({code:'wallet_required'}); }
    finally { begin.mockRestore(); }
    const second=await signedOffer('PER-second');
    await expect(verifyOnboardingIdentity(second,{...deps(),identity:async()=>({githubUserId:43,githubLogin:'second',verifiedEmails:['second@example.test']})})).rejects.toThrow();
    expect(await getWorkProfile({...key,personId:'PER-second'},{sql:db.adminSql})).toBeNull();
    // A writer bypassing onboarding must hit the same invariant. The entire
    // attempted profile insert is rejected, not merely the application check.
    await expect(db.adminSql`INSERT INTO harness_shared.dao_hr_work_profiles
      (workspace_id,dao_slug,person_id,title,engagement_type,jurisdiction,member_github_user_id,wallet_address,wallet_chain_id,wallet_binding_ref,wallet_verified_at)
      VALUES (${key.workspaceId},${key.daoSlug},'PER-second','Engineer','employee','US-DE',43,${e.accounts[1].toLowerCase()},1,'other-challenge',now())`)
      .rejects.toMatchObject({code:'23505',constraint_name:'dao_hr_work_profiles_verified_wallet_uniq'});
    expect(await getWorkProfile({...key,personId:'PER-second'},{sql:db.adminSql})).toBeNull();
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET candidate_github_id=99 WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
  });
  it('rechecks a hire frozen during identity authentication before changing its wallet',async()=>{
    const k=await signedOffer('PER-race'),who={githubUserId:99,githubLogin:'race',verifiedEmails:['race@example.test']};
    const d={...deps(),identity:async()=>who,wallet:wallet(3)};
    await verifyOnboardingIdentity(k,d);
    // Real interleaving: the identity call completes after the admin froze the
    // original wallet, but before the candidate transaction acquires its lock.
    await expect(verifyOnboardingIdentity(k,{...d,wallet:wallet(4),identity:async()=>{
      await prepareHireProposal(k,policy,{...d,wallet:wallet(0)});return who;
    }})).rejects.toMatchObject({code:'wallet_required'});
    expect((await getWorkProfile({...key,personId:'PER-race'},{sql:db.adminSql}))?.wallet?.address).toBe(e.accounts[3].toLowerCase());
  });
  it('uses product unsigned calldata on the EVM; pending, unrelated and unaccepted hires never admit; replay admits once without a second proposal',async()=>{
    const [existing]=await db.adminSql<Array<{offer_id:string}>>`SELECT offer_id FROM harness_shared.dao_hr_contracts WHERE candidate_github_id=42`;
    const k={...key,offerId:existing!.offer_id},d=deps(),admin={...d,wallet:wallet(0)};
    const prepared=await prepareHireProposal(k,policy,admin);
    const signed=await row(k.offerId),sealedHash=('0x'+createHash('sha256').update(signed.sealed_pdf!).digest('hex')) as Hex;
    expect(prepared.plan.grantId).toBe(sealedHash);
    // jsonb reorders keys: replay must return the identical frozen plan.
    expect((await prepareHireProposal(k,policy,admin)).plan.proposalId).toBe(prepared.plan.proposalId);
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET hire_plan='{}'::jsonb WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
    await expect(prepareHireAcceptance(k,policy,d)).rejects.toMatchObject({code:'invalid_stage'});
    await expect(admitHire(k,policy,('0x'+'00'.repeat(32)) as Hex,d)).rejects.toMatchObject({code:'invalid_stage'});
    expect(await listHiveMembers(key.workspaceId,scope,db.adminSql)).toHaveLength(0);
    const creation=await e.raw(prepared.unsignedTransaction.data,prepared.unsignedTransaction.to,0,e.governor.abi);confirm();
    await recordHireProposal(k,policy,creation.transactionHash,admin);
    await expect(reconcileFailedHire(k,policy,admin)).rejects.toMatchObject({code:'invalid_stage'});
    const p=prepared.plan;
    await e.finish({targets:p.targets,values:p.values.map(BigInt),calldatas:p.calldatas,descriptionHash:p.descriptionHash,id:BigInt(p.proposalId)});
    const execution=e.lastTransactionHash()!;confirm();
    await expect(recordHireExecution(k,policy,creation.transactionHash,d)).rejects.toMatchObject({code:'invalid_proof'});
    await recordHireExecution(k,policy,execution,d);
    expect((await row(k.offerId)).state).toBe('signed'); // sample cannot become legally binding
    expect((await row(k.offerId)).grant_id).toBe(sealedHash);
    const stored=await e.read(e.equity,'grants',[sealedHash]) as unknown[];
    expect(String(stored[1])).toBe('1000');
    expect(String(stored[3])).toBe(String((await e.getBlock({blockNumber:BigInt((await row(k.offerId)).hire_execution_proof!.blockNumber)})).timestamp));
    const acceptance=await prepareHireAcceptance(k,policy,d);
    await expect(admitHire(k,policy,execution,d)).rejects.toMatchObject({code:'invalid_proof'});
    expect(await listHiveMembers(key.workspaceId,scope,db.adminSql)).toHaveLength(0);
    const accepted=await e.raw(acceptance.data,acceptance.to,1,e.equity.abi);confirm();
    const proposalsBefore=await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()});
    const admit=vi.fn(upsertHiveMember);
    await admitHire(k,policy,accepted.transactionHash,{...d,admit});
    await admitHire(k,policy,accepted.transactionHash,{...d,admit});
    expect(admit).toHaveBeenCalledTimes(1);
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).toEqual([42]);
    const profile=await getWorkProfile({...key,personId:p.personId},{sql:db.adminSql});
    expect(profile?.status).toBe('active');expect(onboardingChecklist(await row(k.offerId),profile).every(s=>s.complete)).toBe(true);
    expect((await readOnboarding(k,policy,d)).checklist.every(step=>step.complete)).toBe(true);
    const unavailable=await readOnboarding(k,policy,{...d,chain:{...chain,getBlock:async()=>{throw new Error('RPC unavailable');}}});
    expect(unavailable.chainError).toBeTruthy();expect(unavailable.checklist.slice(3).every(step=>!step.complete)).toBe(true);
    const reorg=await readOnboarding(k,policy,{...d,chain:{...chain,getBlock:async input=>({...await chain.getBlock(input),hash:('0x'+'00'.repeat(32)) as Hex})}});
    expect(reorg.chainError).toBeTruthy();expect(reorg.checklist.slice(3).every(step=>!step.complete)).toBe(true);
    expect((await getHiringOffer(k,{sql:db.adminSql})).state).toBe('hired');
    expect((await listHiringHistory({...k,subjectKind:'offer',subjectId:k.offerId},{sql:db.adminSql})).filter(h=>h.state==='hired')).toHaveLength(1);
    const proposalsAfter=await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()});
    expect(proposalsAfter).toEqual(proposalsBefore);
  },120_000);
  it('proposal-rejected: an against vote lapses the conditional contract and refuses acceptance or admission',async()=>{
    const k=await signedOffer('PER-second');
    const d={...deps(),identity:async()=>({githubUserId:43,githubLogin:'second',verifiedEmails:['second@example.test']}),wallet:wallet(2)};
    await verifyOnboardingIdentity(k,d);
    const admin={...d,wallet:wallet(0)},prepared=await prepareHireProposal(k,policy,admin);
    const created=await e.raw(prepared.unsignedTransaction.data,prepared.unsignedTransaction.to,0,e.governor.abi);confirm();
    await recordHireProposal(k,policy,created.transactionHash,admin);
    e.advance(61);
    await e.send(e.governor,'castVote',[BigInt(prepared.plan.proposalId),0],0);
    e.advance(Number(await e.read(e.governor,'votingPeriod'))+1);
    expect(Number(await e.read(e.governor,'state',[BigInt(prepared.plan.proposalId)]))).toBe(3);
    await expect(reconcileFailedHire(k,policy,admin)).resolves.toEqual({state:'lapsed'});
    expect((await row(k.offerId)).state).toBe('lapsed');
    await expect(prepareHireAcceptance(k,policy,d)).rejects.toMatchObject({code:'invalid_stage'});
    await expect(admitHire(k,policy,created.transactionHash,d)).rejects.toMatchObject({code:'invalid_stage'});
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).toEqual([42]);
    expect(onboardingChecklist(await row(k.offerId),await getWorkProfile({...key,personId:'PER-second'},{sql:db.adminSql})).slice(3).every(s=>!s.complete)).toBe(true);
  },120_000);
  it('proposal-expired: an unapproved voting window lapses without a grant, acceptance or membership',async()=>{
    const k=await signedOffer('PER-expired'),who={githubUserId:46,githubLogin:'expired',verifiedEmails:['expired@example.test']};
    const d={...deps(),identity:async()=>who,wallet:wallet(6)},admin={...d,wallet:wallet(0)};
    await verifyOnboardingIdentity(k,d);
    const prepared=await prepareHireProposal(k,policy,admin),p=prepared.plan;
    const created=await e.raw(prepared.unsignedTransaction.data,prepared.unsignedTransaction.to,0,e.governor.abi);confirm();
    await recordHireProposal(k,policy,created.transactionHash,admin);
    const deadline=BigInt(String(await e.read(e.governor,'proposalDeadline',[BigInt(p.proposalId)])));
    e.advance(deadline-e.now()+1n);
    // GovernorTimelockControl reports a no-quorum expired voting window as
    // Defeated (3); it has no queued-operation expiry. Exercise the real state.
    expect(Number(await e.read(e.governor,'state',[BigInt(p.proposalId)]))).toBe(3);
    await expect(e.raw(prepared.plan.calldatas[1]!,p.equity,0,e.equity.abi)).rejects.toThrow();
    await expect(reconcileFailedHire(k,policy,admin)).resolves.toEqual({state:'lapsed'});
    await expect(reconcileFailedHire(k,policy,admin)).resolves.toEqual({state:'lapsed'});
    const lapsed=await row(k.offerId);
    expect(lapsed.state).toBe('lapsed');expect(lapsed.grant_id).toBeNull();expect(lapsed.hire_execution_proof).toBeNull();
    expect(lapsed.terms_acceptance_proof).toBeNull();expect(lapsed.admitted_at).toBeNull();
    expect(String((await e.read(e.equity,'grants',[p.grantId]) as unknown[])[0])).toBe('0');
    await expect(prepareHireAcceptance(k,policy,d)).rejects.toMatchObject({code:'invalid_stage'});
    await expect(admitHire(k,policy,created.transactionHash,d)).rejects.toMatchObject({code:'invalid_stage'});
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).toEqual([42]);
    expect((await getHiringOffer(k,{sql:db.adminSql})).state).toBe('lapsed');
    expect((await listHiringHistory({...k,subjectKind:'offer',subjectId:k.offerId},{sql:db.adminSql})).filter(h=>h.state==='lapsed')).toHaveLength(1);
  },120_000);
  it('refuses duplicate historical verified wallets before migration DDL and rolls back the fixture',async()=>{
    await expect(db.adminSql.begin(async tx=>{
      await tx.unsafe('DROP INDEX harness_shared.dao_hr_work_profiles_verified_wallet_uniq');
      await tx`UPDATE harness_shared.dao_hr_work_profiles SET wallet_address=${e.accounts[1].toLowerCase()} WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND person_id='PER-second'`;
      await tx.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1464-dao-hr-onboarding-proof.sql',import.meta.url),'utf8'));
    })).rejects.toThrow('duplicate verified wallets must be resolved');
    expect((await getWorkProfile({...key,personId:'PER-second'},{sql:db.adminSql}))?.wallet?.address).toBe(e.accounts[2].toLowerCase());
    expect(await db.adminSql`SELECT indexname FROM pg_indexes WHERE schemaname='harness_shared' AND indexname='dao_hr_work_profiles_verified_wallet_uniq'`).toHaveLength(1);
  });
});
describe('P008 — proved engagement end retains records and earned equity',()=>{
  it('requires a newly signed referenced amendment, raises within the admin limit without a vote, and applies pay-only amendments',async()=>{
    const [existing]=await db.adminSql<Array<{offer_id:string}>>`SELECT offer_id FROM harness_shared.dao_hr_contracts WHERE candidate_github_id=42`;
    const parent=existing!.offer_id,templates=[{templateKey:'amendment-employment',version:1},{templateKey:'amendment-equity',version:1}];
    const originalEquity=(await getHiringOffer({...key,offerId:parent},{sql:db.adminSql})).terms.equity;
    await updateEquityPolicy({...key,actorPersonId:'PER-author',changes:{vestingDays:730,cliffDays:30,startRule:'contract_signed',
      defaultGrants:[{role:'Engineer',level:'L3',shares:3333}]}},{sql:db.adminSql});
    for(const [i,documentKind] of ['employment-agreement','equity-grant-agreement'].entries())
      await createContractTemplate({...key,templateKey:templates[i]!.templateKey,documentKind,engagementType:'employee',jurisdiction:'US-DE',title:'Engagement amendment',actorPersonId:'PER-author',
        body:'Amendment to {{amends_contract_ref}}. Pay {{pay_amount}}; total grant {{share_amount}}. Effective upon admin execution; original vesting remains.',mergeFields:['amends_contract_ref','pay_amount','share_amount']},{sql:db.adminSql});
    const make=async(shares:number,pay:string)=>{
      const offer=await createHiringOffer({...key,roleId,personId:'PER-candidate',actorPersonId:'PER-author',engagementType:'employee',jurisdiction:'US-DE',pay:{amount:pay,currency:'USD',cadence:'monthly'},overrides:{shares},amendsOfferId:parent},{sql:db.adminSql});
      await approveHiringOffer({...key,offerId:offer.offerId,actorPersonId:'PER-reviewer'},{sql:db.adminSql});return offer;
    };
    const offer=await make(1500,'6000'),k={...key,offerId:offer.offerId},d={...deps(),wallet:wallet(7)};
    expect(offer.terms.equity).toMatchObject({vestingDays:originalEquity.vestingDays,cliffDays:originalEquity.cliffDays,startRule:originalEquity.startRule});
    await expect(createHiringOffer({...key,roleId,personId:'PER-candidate',actorPersonId:'PER-author',engagementType:'employee',jurisdiction:'US-DE',
      pay:{amount:'6000',currency:'USD',cadence:'monthly'},overrides:{vestingDays:730},amendsOfferId:parent},{sql:db.adminSql})).rejects.toThrow('signed vesting schedule');
    await expect(prepareContractExecution({...k,actorPersonId:'PER-author',companyPersonId:'PER-reviewer',startDate:'2026-11-01',templates:[{templateKey:'sample-employment-agreement-employee-us-de',version:1},{templateKey:'sample-equity-grant-agreement-employee-us-de',version:1}]},{sql:db.adminSql})).rejects.toThrow('original contract');
    await prepareContractExecution({...k,actorPersonId:'PER-author',companyPersonId:'PER-reviewer',startDate:'2026-11-01',templates},{sql:db.adminSql});
    await expect(completeEngagementAmendment(k,policy,null,d)).rejects.toMatchObject({code:'invalid_stage'});
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET amendment_execution_proof='{}'::jsonb WHERE offer_id=${k.offerId}`).rejects.toThrow('signed document');
    await signExistingOffer(k.offerId,templates);
    const signed=await row(k.offerId);expect(signed.can_bind).toBe(false);
    const stamped=await generateContract({...key,...templates[0]!,values:{amends_contract_ref:signed.merge_values.amends_contract_ref!,pay_amount:'6000',share_amount:'1500'}},{sql:db.adminSql});
    expect(stamped.document).toContain('Non-binding sample');
    expect(signed.merge_values.amends_contract_ref).toBe((await row(parent)).contract_id);
    await expect(prepareHireProposal(k,policy,{...d,wallet:wallet(0)})).rejects.toMatchObject({code:'invalid_stage'});
    const before=await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()});
    const prepared=await prepareEngagementAmendment(k,policy,d);expect(prepared.unsignedTransaction?.to?.toLowerCase()).toBe(e.equity.address.toLowerCase());
    await expect(completeEngagementAmendment(k,policy,null,d)).rejects.toMatchObject({code:'invalid_proof'});
    await expect(e.raw(prepared.unsignedTransaction!.data,prepared.unsignedTransaction!.to,0,e.equity.abi)).rejects.toThrow('Forbidden');
    const raised=await e.raw(prepared.unsignedTransaction!.data,prepared.unsignedTransaction!.to,7,e.equity.abi);confirm();
    const proof=await completeEngagementAmendment(k,policy,raised.transactionHash,d);
    expect(await completeEngagementAmendment(k,policy,raised.transactionHash,d)).toEqual(proof);
    expect((await getWorkProfile({...key,personId:'PER-candidate'},{sql:db.adminSql}))?.pay?.amount).toBe('6000.00');
    expect((await listHiringHistory({...k,subjectKind:'offer',subjectId:k.offerId},{sql:db.adminSql})).filter(h=>h.state==='amendment-executed')).toHaveLength(1);
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET amendment_plan='{}'::jsonb WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_offers SET amends_offer_id=NULL WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
    const payOnly=await createHiringOffer({...key,roleId,personId:'PER-candidate',actorPersonId:'PER-author',engagementType:'employee',jurisdiction:'US-DE',
      pay:{amount:'7000',currency:'USD',cadence:'monthly'},amendsOfferId:parent},{sql:db.adminSql});
    expect(payOnly.terms.equity.shares).toBe(1500);
    await approveHiringOffer({...key,offerId:payOnly.offerId,actorPersonId:'PER-reviewer'},{sql:db.adminSql});
    const payKey=await signExistingOffer(payOnly.offerId,templates);
    // The prospective limit cannot retroactively forbid a pay-only amendment.
    await e.send(e.equity,'setGrantLimit',[1000],7);
    expect((await prepareEngagementAmendment(payKey,policy,d)).unsignedTransaction).toBeNull();
    await completeEngagementAmendment(payKey,policy,null,d);
    await e.send(e.equity,'setGrantLimit',[100000],7);
    expect((await getWorkProfile({...key,personId:'PER-candidate'},{sql:db.adminSql}))?.pay?.amount).toBe('7000.00');
    const lower=await make(1400,'7000'),lowerKey=await signExistingOffer(lower.offerId,templates);
    await expect(prepareEngagementAmendment(lowerKey,policy,d)).rejects.toMatchObject({code:'invalid_stage'});
    const above=await make(2000,'7000'),aboveKey=await signExistingOffer(above.offerId,templates);
    await e.send(e.equity,'setGrantLimit',[1800],7);
    await expect(prepareEngagementAmendment(aboveKey,policy,d)).rejects.toMatchObject({code:'invalid_stage'});
    await e.send(e.equity,'setGrantLimit',[100000],7);
    expect(await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()})).toEqual(before);
    expect((await row(parent)).document_hash).not.toBe(signed.document_hash);
  },120_000);
  it('rejects no-vote/pending/unrelated proofs, then offboards once after the exact fire proposal executes',async()=>{
    const [existing]=await db.adminSql<Array<{offer_id:string}>>`SELECT offer_id FROM harness_shared.dao_hr_contracts WHERE candidate_github_id=42`;
    const k={...key,offerId:existing!.offer_id},d=deps(),admin={...d,wallet:wallet(0)},original=await row(k.offerId),p=original.hire_plan!;
    await expect(completeEngagementEnd(k,policy,'fired',original.terms_acceptance_proof!.transactionHash,admin)).rejects.toMatchObject({code:'invalid_stage'});
    await grantDaoHrAdmin({...key,personId:p.personId,grantedBy:'PER-author'},{sql:db.adminSql});
    const prepared=await prepareEngagementFire(k,policy,admin);
    expect((await contributorWorkspace(42)).status).toBe('connected');
    expect((await prepareEngagementFire(k,policy,admin)).plan).toEqual(prepared.plan);
    await expect(completeEngagementEnd(k,policy,'fired',original.terms_acceptance_proof!.transactionHash,admin)).rejects.toMatchObject({code:'invalid_proof'});
    // Vest before opening the vote: advancing an open proposal by400days
    // expires it. Both existing members vote under V2's member majority rule.
    e.advance(400*86400);
    await e.send(e.equity,'claimGrant',[p.grantId],1);
    const owned=BigInt(String(await e.read(e.equity,'balanceOf',[p.wallet])));expect(owned).toBeGreaterThan(0n);
    const created=await e.raw(prepared.unsignedTransaction.data,prepared.unsignedTransaction.to,0,e.governor.abi);confirm();
    await expect(completeEngagementEnd(k,policy,'fired',created.transactionHash,admin)).rejects.toMatchObject({code:'invalid_proof'});
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).toContain(42);
    expect(await isDaoHrAdmin({...key,personId:p.personId},{sql:db.adminSql})).toBe(true);
    const f=prepared.plan;
    expect(BigInt(String(await e.read(e.governor,'proposalDeadline',[BigInt(f.proposalId)])))).toBeGreaterThan(e.now()+61n);
    expect(String(await e.read(e.equity,'getPastMemberCount',[e.now()-1n]))).toBe('2');
    await e.finish({targets:f.targets,values:f.values.map(BigInt),calldatas:f.calldatas,descriptionHash:f.descriptionHash,id:BigInt(f.proposalId)},[0,1]);
    const execution=e.lastTransactionHash()!;confirm();
    const proof=await completeEngagementEnd(k,policy,'fired',execution,admin);
    expect(await completeEngagementEnd(k,policy,'fired',execution,admin)).toEqual(proof);
    expect(BigInt(proof.retainedEarned)).toBeGreaterThanOrEqual(owned);
    expect(String(await e.read(e.equity,'balanceOf',[p.wallet]))).toBe(String(owned));
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).not.toContain(42);
    expect(await isDaoHrAdmin({...key,personId:p.personId},{sql:db.adminSql})).toBe(false);
    expect(await contributorWorkspace(42)).toMatchObject({status:'not-joined',localHomeSlug:null});
    expect((await contributorWorkspace(42)).projects).toBeUndefined();
    expect((await getWorkProfile({...key,personId:p.personId},{sql:db.adminSql}))?.status).toBe('offboarded');
    const retained=await row(k.offerId);expect(retained.sealed_pdf).toEqual(original.sealed_pdf);expect(retained.document_hash).toBe(original.document_hash);
    expect((await getHiringOffer(k,{sql:db.adminSql})).state).toBe('hired');
    expect((await listHiringHistory({...k,subjectKind:'offer',subjectId:k.offerId},{sql:db.adminSql})).filter(h=>h.state==='fired')).toHaveLength(1);
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET offboarding_proof='{}'::jsonb WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET fire_plan='{}'::jsonb WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
    e.advance(100*86400);expect(String(await e.read(e.equity,'earnedGrant',[p.grantId]))).toBe(proof.retainedEarned);
  },120_000);
  it('resigns through holder-only calldata, opens no vote, revokes roles and retains earned equity',async()=>{
    const k=await signedOffer('PER-resigner'),who={githubUserId:44,githubLogin:'resigner',verifiedEmails:['resigner@example.test']};
    const d={...deps(),identity:async()=>who,wallet:wallet(5)},admin={...d,wallet:wallet(0)};
    await verifyOnboardingIdentity(k,d);
    const hire=await prepareHireProposal(k,policy,admin),p=hire.plan;
    const creation=await e.raw(hire.unsignedTransaction.data,hire.unsignedTransaction.to,0,e.governor.abi);confirm();
    await recordHireProposal(k,policy,creation.transactionHash,admin);
    expect(BigInt(String(await e.read(e.governor,'proposalDeadline',[BigInt(p.proposalId)])))).toBeGreaterThan(e.now()+61n);
    expect(String(await e.read(e.equity,'getPastMemberCount',[e.now()-1n]))).toBe('2');
    await e.finish({targets:p.targets,values:p.values.map(BigInt),calldatas:p.calldatas,descriptionHash:p.descriptionHash,id:BigInt(p.proposalId)},[0,1]);
    const hireExecution=e.lastTransactionHash()!;confirm();await recordHireExecution(k,policy,hireExecution,d);
    const acceptance=await prepareHireAcceptance(k,policy,d),accepted=await e.raw(acceptance.data,acceptance.to,5,e.equity.abi);confirm();
    await admitHire(k,policy,accepted.transactionHash,d);
    await grantDaoHrAdmin({...key,personId:p.personId,grantedBy:'PER-author'},{sql:db.adminSql});
    const before=await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()});
    const resignation=await prepareEngagementResignation(k,policy,d);
    expect((await contributorWorkspace(44)).status).toBe('connected');
    await expect(e.raw(resignation.data,resignation.to,0,e.equity.abi)).rejects.toThrow('Forbidden');
    await expect(prepareEngagementResignation(k,policy,{...d,identity:async()=>candidate})).rejects.toMatchObject({code:'identity_mismatch'});
    await expect(completeEngagementEnd(k,policy,'resigned',accepted.transactionHash,d)).rejects.toMatchObject({code:'invalid_proof'});
    e.advance(400*86400);
    const stopped=await e.raw(resignation.data,resignation.to,5,e.equity.abi);confirm();
    const proof=await completeEngagementEnd(k,policy,'resigned',stopped.transactionHash,d);
    expect(BigInt(proof.retainedEarned)).toBeGreaterThan(0n);
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).not.toContain(44);
    expect(await isDaoHrAdmin({...key,personId:p.personId},{sql:db.adminSql})).toBe(false);
    expect(await contributorWorkspace(44)).toMatchObject({status:'not-joined',localHomeSlug:null});
    expect((await contributorWorkspace(44)).projects).toBeUndefined();
    expect((await getWorkProfile({...key,personId:p.personId},{sql:db.adminSql}))?.status).toBe('offboarded');
    expect((await row(k.offerId)).sealed_pdf).toBeTruthy();
    expect(await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()})).toEqual(before);
    e.advance(100*86400);expect(String(await e.read(e.equity,'earnedGrant',[p.grantId]))).toBe(proof.retainedEarned);
  },120_000);
});

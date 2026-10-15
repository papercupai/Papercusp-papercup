/** P007: one hire vote, then candidate acceptance and admission. Reuses the signed
 * contract, canonical PER profile, hosted wallet binding and pot membership. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
import type { HivePolicy } from '../hive-policy-schema';
import { equityArtifacts, inspectEquity, prepareEquityTransaction, type EquityChainReader } from '../equity/runtime';
import { readWalletBinding, requestWalletBindingChallenge, submitWalletBinding, type WalletBindingHostedResult } from '../cupboard/wallet-binding-io';
import { resolveLocalGithubIdentity } from '../identity/resolve-local-github-identity';
import { resolveFederatedPotScope } from '../federated-pot-scope';
import { upsertHiveMember, type UpsertHiveMemberInput } from '../hive-membership-store';
import { getContractExecution, type ContractExecution } from './contracts-esign';
import { getHiringOffer, HiringError, resolveHiringActor, type HiringOffer } from './hiring';
import { completeOnboarding, getWorkProfile, linkMemberIdentity, linkVerifiedWallet, saveWorkProfile, setWorkProfileStatus, type WorkProfile } from './work-profile';

type Key = { workspaceId: string; daoSlug: string; offerId: string };
type Binding = NonNullable<NonNullable<HivePolicy['finance']>['equity']>;
export interface CandidateIdentity { githubUserId: number; githubLogin: string; verifiedEmails: string[]; /** Server-only, never persisted or returned. */ authToken?: string }
export interface ChainLog { address: Address; data: Hex; topics: readonly Hex[] }
export interface OnboardingChain extends EquityChainReader {
  getTransaction(input: { hash: Hex }): Promise<{ from: Address; to: Address | null; input: Hex; value: bigint; chainId: number }>;
  getTransactionReceipt(input: { hash: Hex }): Promise<{ status: string; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; logs: readonly ChainLog[] }>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
}
export interface OnboardingDeps {
  sql?: Sql; chain?: OnboardingChain;
  identity?: () => Promise<CandidateIdentity>;
  wallet?: () => Promise<WalletBindingHostedResult>;
  /** Substitutes resolveHiringActor(key, …), so it receives the same hive/offer key. */
  adminPerson?: (key: Key) => Promise<string>;
  admit?: typeof upsertHiveMember;
  scope?: typeof resolveFederatedPotScope;
}
interface Proof { transactionHash: Hex; blockNumber: string; blockHash: Hex }
export interface HirePlan {
  chainId: number; equity: Address; governor: Address; timelock: Address;
  personId: string; wallet: Address; identityCommitment: Hex; issuerCommitment: Hex;
  grantId: Hex; shares: string; start: string; cliff: string; end: string;
  targets: Address[]; values: string[]; calldatas: Hex[]; description: string; descriptionHash: Hex; proposalId: string;
}
export interface OnboardingContract extends ContractExecution {
  candidate_github_id: number | string | null; candidate_github_login: string | null;
  hire_plan: HirePlan | null; hire_proposal_ref: string | null; grant_id: string | null;
  hire_execution_proof: Proof | null; terms_acceptance_proof: Proof | null; admitted_at: string | null;
}
export class OnboardingError extends Error {
  constructor(readonly code: 'identity_required' | 'identity_mismatch' | 'wallet_required' | 'invalid_stage' | 'invalid_proof' | 'policy_changed', message: string) { super(message); this.name = 'OnboardingError'; }
}
function fail(code: OnboardingError['code'], message: string): never { throw new OnboardingError(code, message); }
const db = (d: OnboardingDeps) => d.sql ?? getOrgPg().sql;
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const digest = (v: string) => keccak256(stringToHex(v));
// jsonb sorts object keys. Compare canonical values, preserving array order;
// uint48 decodes as number and uint256 as bigint, so both normalize to decimals.
const encoded = (v: unknown): string => {
  const canonical = (x: unknown): unknown => typeof x === 'bigint' || typeof x === 'number' ? String(x) :
    Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,canonical(value)])) : x;
  return JSON.stringify(canonical(v)).toLowerCase();
};
async function row(key: Key, deps: OnboardingDeps) { return await getContractExecution(key, deps) as OnboardingContract; }
async function identity(deps: OnboardingDeps): Promise<CandidateIdentity> {
  if (deps.identity) return deps.identity();
  const who = await resolveLocalGithubIdentity();
  if (who.kind !== 'ok') fail('identity_required', 'Sign in with your GitHub account.');
  // Use the SAME token for /user identity and its verified-email read. Emails stay
  // in the person/signing system; HR persists only the identity link.
  const response = await fetch('https://api.github.com/user/emails', { headers: { Authorization: 'Bearer ' + who.token, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) fail('identity_required', 'GitHub must allow verification of the contract signer email.');
  const emails = await response.json() as Array<{ email: string; verified: boolean }>;
  return { githubUserId: who.githubUserId, githubLogin: who.githubLogin, verifiedEmails: emails.filter(e => e.verified).map(e => e.email.toLowerCase()), authToken: who.token };
}
async function candidate(contract: OnboardingContract, deps: OnboardingDeps) {
  const who = await identity(deps);
  if (!Number.isSafeInteger(who.githubUserId) || who.githubUserId < 1 || !who.githubLogin ||
    !who.verifiedEmails.some(email => same(email, contract.signers[0].email)) ||
    (contract.candidate_github_id !== null && Number(contract.candidate_github_id) !== who.githubUserId))
    fail('identity_mismatch', 'The authenticated account must match the candidate who signed this contract.');
  return who;
}
async function chain(deps: OnboardingDeps): Promise<OnboardingChain> {
  if (deps.chain) return deps.chain;
  const rpc = process.env.PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL?.trim();
  if (!rpc) fail('invalid_proof', 'The organization chain RPC is not configured.');
  const { createPublicClient, http } = await import('viem');
  return createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 0 }) }) as unknown as OnboardingChain;
}
function binding(policy: HivePolicy): Binding {
  if (!policy.finance?.equity) fail('invalid_proof', 'No signed equity deployment is bound.');
  return policy.finance.equity;
}
function unchanged(plan: HirePlan, policy: HivePolicy) {
  const current = binding(policy);
  if (plan.chainId !== current.chainId || !same(plan.equity,current.equity) || !same(plan.governor,current.governor) || !same(plan.timelock,current.timelock))
    fail('policy_changed', 'The signed deployment changed after this hire was prepared.');
}
const read = (c: OnboardingChain, p: HirePlan, name: string, args: unknown[], blockNumber: bigint, governor = false) =>
  c.readContract({ address: governor ? p.governor : p.equity, abi: equityArtifacts.contracts[governor ? 'EquityGovernorV2' : 'PapercuspEquityV2'].abi, functionName: name, args, blockNumber });
async function history(sql: Sql, key: Key, state: string, actor: string) {
  await sql`INSERT INTO harness_shared.dao_hr_hiring_history (workspace_id,dao_slug,subject_kind,subject_id,state,actor_person_id)
    VALUES (${key.workspaceId},${key.daoSlug},'offer',${key.offerId},${state},${actor})`;
}

/** Frozen signed document hash is also the on-chain grant key. start=0 is the
 * D015 execution-time schedule; other rules use signed absolute timestamps. */
export function buildHirePlan(offer: HiringOffer, contract: OnboardingContract, profile: WorkProfile, bound: Binding, issuerCommitment: Hex): HirePlan {
  if (offer.amendsOfferId) fail('invalid_stage','An amendment is admin-executed; it cannot open another hire vote.');
  if (!['signed','binding'].includes(contract.state) || !contract.document_hash || !contract.sealed_pdf || !contract.audit_certificate || !contract.completed_at ||
    '0x' + createHash('sha256').update(contract.sealed_pdf).digest('hex') !== contract.document_hash)
    fail('invalid_stage', 'Both signatures and the exact sealed contract are required.');
  if (!profile.wallet || profile.wallet.chainId !== bound.chainId || profile.memberGithubUserId !== Number(contract.candidate_github_id))
    fail('wallet_required', 'Verify the candidate identity and wallet on the equity chain.');
  const terms = offer.terms.equity;
  const days = 86_400n;
  const start = terms.startRule === 'hire_passed' ? 0n : BigInt(Math.floor(Date.parse(terms.startRule === 'contract_signed' ? contract.completed_at : contract.merge_values.start_date!) / 1000));
  const cliff = start + BigInt(terms.cliffDays) * days, end = start + BigInt(terms.vestingDays) * days;
  if (start < 0n || terms.vestingDays < 1 || terms.vestingDays > 3650 || terms.cliffDays > terms.vestingDays) fail('invalid_stage','The signed vesting schedule is invalid.');
  const identityCommitment = digest(encoded([offer.workspaceId,offer.daoSlug,profile.personId,profile.memberGithubUserId]));
  const data = (functionName: string, args: unknown[]) => prepareEquityTransaction({ chainId: bound.chainId, from: profile.wallet!.address,
    to: bound.equity, contract: 'PapercuspEquityV2', functionName, args }).data;
  const targets = [bound.equity,bound.equity] as Address[], values = ['0','0'];
  const calldatas = [data('registerHolder',[profile.wallet.address,identityCommitment]),data('commitGrant',[contract.document_hash,profile.wallet.address,terms.shares,start,cliff,end])];
  const description = 'Hire ' + profile.personId + '\n' + encoded({ contractId:contract.contract_id,documentHash:contract.document_hash,issuerCommitment,chainId:bound.chainId,equity:bound.equity });
  const descriptionHash = digest(description);
  const proposalId = String(BigInt(keccak256(encodeAbiParameters([{type:'address[]'},{type:'uint256[]'},{type:'bytes[]'},{type:'bytes32'}],[targets,[0n,0n],calldatas,descriptionHash]))));
  return { chainId:bound.chainId,equity:bound.equity as Address,governor:bound.governor as Address,timelock:bound.timelock as Address,
    personId:profile.personId,wallet:profile.wallet.address as Address,identityCommitment,issuerCommitment,grantId:contract.document_hash as Hex,
    shares:String(terms.shares),start:String(start),cliff:String(cliff),end:String(end),targets,values,calldatas,description,descriptionHash,proposalId };
}

export async function verifyOnboardingIdentity(key: Key, deps: OnboardingDeps = {}) {
  const sql = db(deps), contract = await row(key,deps), who = await candidate(contract,deps);
  if (contract.state !== 'signed') fail('invalid_stage','Sign the approved offer before onboarding.');
  const wallet = deps.wallet ? await deps.wallet() : await readWalletBinding({authToken:who.authToken});
  return sql.begin(async tx => {
    const conn = tx as unknown as Sql;
    const [locked] = await tx<OnboardingContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id} FOR UPDATE`;
    if (!locked || locked.state !== 'signed') fail('invalid_stage', 'Sign the approved offer before onboarding.');
    if (locked.candidate_github_id !== null && Number(locked.candidate_github_id) !== who.githubUserId)
      fail('identity_mismatch', 'The candidate identity changed while authentication was in progress.');
    const offer = await getHiringOffer(key,{sql:conn});
    const [role] = await tx<Array<{title:string;level:string;manager_person_id:string|null}>>`SELECT title,level,manager_person_id FROM harness_shared.dao_hr_roles WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND role_id=${offer.roleId}`;
    const profileKey = {...key,personId:offer.personId};
    const previous = await getWorkProfile(profileKey,{sql:conn});
    if (previous?.memberGithubUserId !== null && previous?.memberGithubUserId !== undefined && previous.memberGithubUserId !== who.githubUserId) fail('identity_mismatch','This person is linked to another identity.');
    await saveWorkProfile({...profileKey,title:role!.title,level:role!.level,managerPersonId:role!.manager_person_id,startDate:contract.merge_values.start_date,
      engagementType:offer.terms.engagementType,jurisdiction:offer.terms.jurisdiction,pay:offer.terms.pay},{sql:conn});
    await linkMemberIdentity({...profileKey,member:{githubUserId:who.githubUserId}},{sql:conn});
    const hosted=wallet.ok?wallet.value.binding as {walletAddress?:string;chainId?:number}:null;
    if(hosted?.walletAddress&&hosted.chainId){
      const [other]=await tx`SELECT person_id FROM harness_shared.dao_hr_work_profiles WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug}
        AND wallet_address=${hosted.walletAddress.toLowerCase()} AND wallet_chain_id=${hosted.chainId} AND wallet_verified_at IS NOT NULL AND person_id<>${offer.personId}`;
      if(other) fail('wallet_required','This verified wallet already belongs to another person in this DAO.');
    }
    const profile = await linkVerifiedWallet({...profileKey,principalGithubUserId:who.githubUserId,binding:wallet},{sql:conn});
    if (locked.hire_plan && !same(profile.wallet?.address,locked.hire_plan.wallet)) fail('wallet_required','The prepared hire wallet cannot change.');
    await tx`UPDATE harness_shared.dao_hr_contracts SET candidate_github_id=${who.githubUserId},candidate_github_login=${who.githubLogin} WHERE contract_id=${contract.contract_id}`;
    if (profile.status === 'candidate') await setWorkProfileStatus({...profileKey,status:'offered'},{sql:conn});
    const current = await getWorkProfile(profileKey,{sql:conn});
    if(current?.status === 'offered') await setWorkProfileStatus({...profileKey,status:'onboarding'},{sql:conn});
    if(locked.candidate_github_id === null) await history(conn,key,'identity-and-wallet-verified',profile.personId);
    return getWorkProfile(profileKey,{sql:conn});
  }).catch((error: unknown) => {
    // The preflight gives a useful error, but concurrent requests can both pass
    // it. The database arbitrates that race and rolls back every identity link.
    const conflict = error as { code?: string; constraint_name?: string };
    if (conflict.code === '23505' && conflict.constraint_name === 'dao_hr_work_profiles_verified_wallet_uniq')
      fail('wallet_required', 'This verified wallet already belongs to another person in this DAO.');
    if (conflict.code === '23505' && conflict.constraint_name === 'dao_hr_work_profiles_member_uniq')
      fail('identity_mismatch', 'This identity already belongs to another person in this DAO.');
    throw error;
  });
}
export async function prepareHireProposal(key: Key, policy: HivePolicy, deps: OnboardingDeps = {}) {
  const sql=db(deps),actor=await (deps.adminPerson?.(key) ?? resolveHiringActor(key,{sql}));
  const contract=await row(key,deps),offer=await getHiringOffer(key,deps),profile=await getWorkProfile({...key,personId:offer.personId},deps);
  if(!profile) fail('wallet_required','Verify the candidate wallet first.');
  const c=await chain(deps),bound=binding(policy),inspection=await inspectEquity(c,bound);
  if(inspection.version!=='2'||!inspection.governanceBound||!inspection.supplyInvariant||!inspection.issuer.issuerAttested) fail('invalid_proof','An active V2 equity deployment with bound governance is required.');
  const plan=buildHirePlan(offer,contract,profile,bound,inspection.issuer.commitment as Hex);
  const stored=await sql.begin(async tx=>{
    const [locked]=await tx<OnboardingContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id} FOR UPDATE`;
    if(locked!.hire_plan){ unchanged(locked!.hire_plan,policy);if(encoded(locked!.hire_plan)!==encoded(plan)) fail('invalid_stage','The hire plan is already frozen.');return locked!.hire_plan; }
    await tx`UPDATE harness_shared.dao_hr_contracts SET hire_plan=${(tx as unknown as Sql).json(plan as unknown as Record<string,never>)} WHERE contract_id=${contract.contract_id}`;
    await history(tx as unknown as Sql,key,'hire-prepared',actor);return plan;
  });
  const proposer = await (deps.wallet ?? readWalletBinding)();
  const boundWallet=proposer.ok ? proposer.value.binding as {walletAddress?:string;chainId?:number;challengeId?:string;verifiedAtMs?:number} : null;
  if(!boundWallet?.walletAddress || boundWallet.chainId!==stored.chainId || !boundWallet.challengeId || !boundWallet.verifiedAtMs) fail('wallet_required','The proposer needs a verified wallet on this chain.');
  return {plan:stored,unsignedTransaction:prepareEquityTransaction({chainId:stored.chainId,from:boundWallet.walletAddress,to:stored.governor,contract:'EquityGovernorV2',functionName:'propose',args:[stored.targets,stored.values,stored.calldatas,stored.description]})};
}

/** Receipt, calldata and canonical block are fetched from the configured chain.
 * A hash from the caller is a lookup key; no caller-supplied proof is accepted. */
async function confirmedCall(c: OnboardingChain,p: HirePlan,hash: Hex,governor:boolean,name:string,args:unknown[],sender?:Address) {
  if(!/^0x[0-9a-fA-F]{64}$/.test(hash)) fail('invalid_proof','A transaction hash is required.');
  const [receipt,tx,latest]=await Promise.all([c.getTransactionReceipt({hash}),c.getTransaction({hash}),c.getBlockNumber()]);
  const block=await c.getBlock({blockNumber:receipt.blockNumber});
  if(await c.getChainId()!==p.chainId||tx.chainId!==p.chainId||receipt.status!=='success'||!same(receipt.transactionHash,hash)||!same(block.hash,receipt.blockHash)||latest<receipt.blockNumber+2n||tx.value!==0n||
    !same(tx.to,governor?p.governor:p.equity)||(sender&&!same(tx.from,sender))) fail('invalid_proof','The transaction must succeed on the bound chain with two confirmations.');
  const decoded=decodeFunctionData({abi:equityArtifacts.contracts[governor?'EquityGovernorV2':'PapercuspEquityV2'].abi,data:tx.input});
  if(decoded.functionName!==name||encoded(decoded.args)!==encoded(args)) fail('invalid_proof','Transaction calldata differs from the frozen hire.');
  return {receipt,block,proof:{transactionHash:hash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash} satisfies Proof};
}
function event(logs: readonly ChainLog[],p:HirePlan,governor:boolean,name:string,expected:Record<string,unknown>) {
  return logs.some(log=>{
    if(!same(log.address,governor?p.governor:p.equity)) return false;
    let decoded;try{decoded=decodeEventLog({abi:equityArtifacts.contracts[governor?'EquityGovernorV2':'PapercuspEquityV2'].abi,data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});}catch{return false;}
    return decoded.eventName===name&&Object.entries(expected).every(([k,v])=>same((decoded.args as unknown as Record<string,unknown>)[k],v));
  });
}
// Engagement changes share the authenticated identity and canonical receipt
// boundary. Client transaction hashes remain lookup keys only.
export { chain as onboardingChain, candidate as authenticateContractCandidate,
  unchanged as assertHireDeployment, confirmedCall as confirmedEquityCall, event as equityReceiptEvent };
async function requirePlan(key:Key,policy:HivePolicy,deps:OnboardingDeps) {
  const contract=await row(key,deps);if(!contract.hire_plan) fail('invalid_stage','Prepare the signed hire first.');
  unchanged(contract.hire_plan,policy);return {contract,p:contract.hire_plan,c:await chain(deps)};
}
export async function recordHireProposal(key:Key,policy:HivePolicy,hash:Hex,deps:OnboardingDeps={}) {
  const actor=await (deps.adminPerson?.(key)??resolveHiringActor(key,{sql:db(deps)}));
  const {contract,p,c}=await requirePlan(key,policy,deps);
  const {receipt}=await confirmedCall(c,p,hash,true,'propose',[p.targets,p.values,p.calldatas,p.description]);
  if(!event(receipt.logs,p,true,'ProposalCreated',{proposalId:p.proposalId})) fail('invalid_proof','The frozen hire proposal was not created.');
  await db(deps).begin(async tx=>{
    const changed=await tx`UPDATE harness_shared.dao_hr_contracts SET hire_proposal_ref=${p.proposalId} WHERE contract_id=${contract.contract_id} AND hire_proposal_ref IS NULL RETURNING contract_id`;
    if(changed.length){await tx`UPDATE harness_shared.dao_hr_offers SET state='hire-proposed' WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${key.offerId} AND state='signed'`;await history(tx as unknown as Sql,key,'hire-proposed',actor);}
  });return p.proposalId;
}
export async function recordHireExecution(key:Key,policy:HivePolicy,hash:Hex,deps:OnboardingDeps={}) {
  const {contract,p,c}=await requirePlan(key,policy,deps);
  if(contract.hire_proposal_ref!==p.proposalId||contract.state==='lapsed') fail('invalid_stage','The signed hire proposal must be recorded.');
  const {receipt,block,proof}=await confirmedCall(c,p,hash,true,'execute',[p.targets,p.values,p.calldatas,p.descriptionHash]);
  if(!event(receipt.logs,p,true,'ProposalExecuted',{proposalId:p.proposalId})||Number(await read(c,p,'state',[BigInt(p.proposalId)],receipt.blockNumber,true))!==7) fail('invalid_proof','This hire proposal has not executed.');
  await verifyGrant(c,p,receipt.blockNumber,block.timestamp);
  await db(deps).begin(async tx=>{
    const changed=await tx`UPDATE harness_shared.dao_hr_contracts SET hire_execution_proof=${(tx as unknown as Sql).json(proof)},grant_id=${p.grantId},hire_transaction_hash=${hash},state=CASE WHEN can_bind THEN 'binding' ELSE state END
      WHERE contract_id=${contract.contract_id} AND hire_execution_proof IS NULL AND state='signed' RETURNING contract_id`;
    if(changed.length) await history(tx as unknown as Sql,key,'hire-executed',p.personId);
  });return proof;
}
async function verifyGrant(c:OnboardingChain,p:HirePlan,blockNumber:bigint,executionTime?:bigint) {
  const [id,grant,issuer]=await Promise.all([read(c,p,'memberId',[p.wallet],blockNumber),read(c,p,'grants',[p.grantId],blockNumber),read(c,p,'issuerCommitment',[],blockNumber)]);
  const holder=await read(c,p,'holders',[id],blockNumber) as readonly unknown[],g=grant as readonly unknown[];
  if(BigInt(String(id))===0n||!same(holder[0],p.wallet)||!same(holder[1],p.identityCommitment)||holder[2]!==true||!same(issuer,p.issuerCommitment)||
    !same(g[0],id)||String(g[1])!==p.shares||BigInt(String(g[6]))!==0n) fail('invalid_proof','The current holder or reserved grant differs from the signed hire.');
  if(executionTime!==undefined){const anchor=BigInt(p.start)===0n?executionTime:0n;if(String(g[3])!==String(BigInt(p.start)+anchor)||String(g[4])!==String(BigInt(p.cliff)+anchor)||String(g[5])!==String(BigInt(p.end)+anchor)) fail('invalid_proof','The execution stored a different vesting schedule.');}
  return {id,holder};
}
export async function prepareHireAcceptance(key:Key,policy:HivePolicy,deps:OnboardingDeps={}) {
  const {contract,p}=await requirePlan(key,policy,deps);await candidate(contract,deps);
  if(!contract.hire_execution_proof||contract.state==='lapsed') fail('invalid_stage','Wait for the hire proposal to execute.');
  return prepareEquityTransaction({chainId:p.chainId,from:p.wallet,to:p.equity,contract:'PapercuspEquityV2',functionName:'acceptTerms',args:[p.issuerCommitment]});
}
export async function admitHire(key:Key,policy:HivePolicy,hash:Hex,deps:OnboardingDeps={}) {
  const {contract,p,c}=await requirePlan(key,policy,deps),who=await candidate(contract,deps);
  if(!contract.hire_execution_proof||contract.state==='lapsed') fail('invalid_stage','The hire proposal must execute before admission.');
  const {receipt,proof}=await confirmedCall(c,p,hash,false,'acceptTerms',[p.issuerCommitment],p.wallet);
  if(receipt.blockNumber<=BigInt(contract.hire_execution_proof.blockNumber)) fail('invalid_proof','Candidate acceptance must follow the hire execution.');
  const current=await c.getBlockNumber(),{id,holder}=await verifyGrant(c,p,current);
  if(holder[3]!==true||!event(receipt.logs,p,false,'TermsAccepted',{holderId:id,wallet:p.wallet,commitment:p.issuerCommitment})) fail('invalid_proof','The candidate has not accepted the issuer terms.');
  const executedBlock=await c.getBlock({blockNumber:BigInt(contract.hire_execution_proof.blockNumber)});
  if(!same(executedBlock.hash,contract.hire_execution_proof.blockHash)||Number(await read(c,p,'state',[BigInt(p.proposalId)],current,true))!==7) fail('invalid_proof','The hire execution is no longer canonical.');
  const profile=await getWorkProfile({...key,personId:p.personId},deps);
  if(!profile?.wallet||!same(profile.wallet.address,p.wallet)||profile.memberGithubUserId!==who.githubUserId) fail('wallet_required','The candidate profile differs from the verified hire.');
  const scope=await (deps.scope??resolveFederatedPotScope)(key.workspaceId,key.daoSlug,{sql:db(deps)});
  await db(deps).begin(async tx=>{
    const conn=tx as unknown as Sql;
    const [locked]=await tx<OnboardingContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id} FOR UPDATE`;
    if(locked!.admitted_at) return;
    if(locked!.terms_acceptance_proof&&locked!.terms_acceptance_proof.transactionHash!==hash) fail('invalid_proof','Acceptance proof is already frozen.');
    await tx`UPDATE harness_shared.dao_hr_contracts SET terms_acceptance_proof=${conn.json(proof)} WHERE contract_id=${contract.contract_id}`;
    const member:UpsertHiveMemberInput={workspaceId:key.workspaceId,potHomeSlug:scope,githubUserId:who.githubUserId,githubUsername:who.githubLogin,bindingStatus:'bound'};
    await (deps.admit??upsertHiveMember)(member,conn);
    await completeOnboarding({...key,personId:p.personId},{sql:conn});
    await tx`UPDATE harness_shared.dao_hr_contracts SET admitted_at=now() WHERE contract_id=${contract.contract_id}`;
    await tx`UPDATE harness_shared.dao_hr_offers SET state='hired' WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${key.offerId}`;
    await history(conn,key,'hired',p.personId);
  });return proof;
}
export async function reconcileFailedHire(key:Key,policy:HivePolicy,deps:OnboardingDeps={}) {
  const actor=await (deps.adminPerson?.(key)??resolveHiringActor(key,{sql:db(deps)})),{contract,p,c}=await requirePlan(key,policy,deps);
  if(contract.hire_proposal_ref!==p.proposalId||contract.hire_execution_proof) fail('invalid_stage','Only a recorded unexecuted proposal can lapse.');
  const state=Number(await read(c,p,'state',[BigInt(p.proposalId)],await c.getBlockNumber(),true));
  if(![2,3,6].includes(state)) fail('invalid_stage','The hire proposal is still pending, active, passed or queued.');
  await db(deps).begin(async tx=>{
    const changed=await tx`UPDATE harness_shared.dao_hr_contracts SET state='lapsed' WHERE contract_id=${contract.contract_id} AND state='signed' AND hire_execution_proof IS NULL RETURNING contract_id`;
    if(changed.length){await tx`UPDATE harness_shared.dao_hr_offers SET state='lapsed' WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${key.offerId}`;await history(tx as unknown as Sql,key,'lapsed',actor);}
  });return {state:'lapsed' as const};
}
export function onboardingChecklist(contract:OnboardingContract,profile:WorkProfile|null,chainError:string|null=null) {
  const done=!chainError&&contract.state!=='lapsed';
  return [
    {key:'contract',label:'Both parties signed',complete:!!contract.document_hash&&!!contract.audit_certificate},
    {key:'identity',label:'Identity verified',complete:contract.candidate_github_id!==null&&profile?.memberGithubUserId===Number(contract.candidate_github_id)},
    {key:'wallet',label:'Wallet verified',complete:!!profile?.wallet&&(!contract.hire_plan||same(profile.wallet.address,contract.hire_plan.wallet))},
    {key:'proposal',label:'Hire proposal executed',complete:done&&!!contract.hire_execution_proof},
    {key:'acceptance',label:'Issuer terms accepted',complete:done&&!!contract.terms_acceptance_proof},
    {key:'membership',label:'DAO membership admitted',complete:done&&!!contract.admitted_at&&profile?.status==='active'},
  ];
}

/** Signer access exists before membership. The HR roster grants the admin view;
 * everyone else must prove the exact contract signer through GitHub. */
export async function readOnboarding(key: Key, policy: HivePolicy, deps: OnboardingDeps = {}) {
  const contract = await row(key, deps);
  let isAdmin = false, isCandidate = false;
  try { await (deps.adminPerson?.(key) ?? resolveHiringActor(key, { sql: db(deps) })); isAdmin = true; }
  catch (error) { if (!(error instanceof HiringError && error.code === 'not_admin')) throw error; }
  try { await candidate(contract, deps); isCandidate = true; }
  catch (error) { if (!isAdmin || !(error instanceof OnboardingError)) throw error; }
  const offer = await getHiringOffer(key, deps), profile = await getWorkProfile({ ...key, personId: offer.personId }, deps);
  let chainError: string | null = null;
  if (contract.hire_plan && contract.state !== 'lapsed') {
    try {
      const p = contract.hire_plan, c = await chain(deps); unchanged(p, policy);
      if (contract.hire_execution_proof) {
        const executed = await confirmedCall(c, p, contract.hire_execution_proof.transactionHash, true, 'execute', [p.targets, p.values, p.calldatas, p.descriptionHash]);
        if (!same(executed.proof.blockHash, contract.hire_execution_proof.blockHash) ||
          Number(await read(c, p, 'state', [BigInt(p.proposalId)], await c.getBlockNumber(), true)) !== 7) fail('invalid_proof', 'The hire execution is no longer canonical.');
        const current = await verifyGrant(c, p, await c.getBlockNumber(), executed.block.timestamp);
        if (contract.terms_acceptance_proof) {
          await confirmedCall(c, p, contract.terms_acceptance_proof.transactionHash, false, 'acceptTerms', [p.issuerCommitment], p.wallet);
          if (current.holder[3] !== true) fail('invalid_proof', 'Issuer terms are no longer accepted.');
        }
      }
    } catch (error) { chainError = error instanceof OnboardingError ? error.message : 'Chain proof could not be verified. Retry the chain read.'; }
  }
  return { offerId: key.offerId, state: contract.state, bindingEligible: contract.can_bind, isAdmin, isCandidate,
    checklist: onboardingChecklist(contract, profile, chainError), chainError,
    plan: contract.hire_plan, proposalId: contract.hire_proposal_ref, documentHash: contract.document_hash };
}

/** Reuse the hosted signed-challenge door with the same authenticated signer
 * token. No caller-supplied member id or naked wallet address becomes a link. */
export async function runOnboardingWalletAction(key: Key, action: { action: 'wallet-challenge'; walletAddress: string; chainId: number } | { action: 'wallet-verify'; challengeId: string; signature: string }, deps: OnboardingDeps = {}) {
  const who = await candidate(await row(key, deps), deps);
  return action.action === 'wallet-challenge' ? requestWalletBindingChallenge({ walletAddress: action.walletAddress, chainId: action.chainId }, { authToken: who.authToken }) :
    submitWalletBinding({ challengeId: action.challengeId, signature: action.signature }, { authToken: who.authToken });
}

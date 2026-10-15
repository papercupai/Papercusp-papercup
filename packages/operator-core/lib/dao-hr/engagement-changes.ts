/** P008: the chain ends vesting before access is revoked. Existing person,
 * offer, signed document and earned-equity records are retained. */
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
import type { HivePolicy } from '../hive-policy-schema';
import { equityArtifacts, prepareEquityTransaction } from '../equity/runtime';
import { readWalletBinding } from '../cupboard/wallet-binding-io';
import { resolveFederatedPotScope } from '../federated-pot-scope';
import { removeHiveMember } from '../hive-membership-store';
import { getHiringOffer, HiringError, resolveHiringActor } from './hiring';
import { getContractExecution } from './contracts-esign';
import { getWorkProfile, saveWorkProfile } from './work-profile';
import { assertHireDeployment, authenticateContractCandidate, confirmedEquityCall, equityReceiptEvent,
  onboardingChain, OnboardingError, type HirePlan, type OnboardingContract, type OnboardingDeps } from './onboarding';

type Key = { workspaceId: string; daoSlug: string; offerId: string };
type HostedWallet = {walletAddress?:string;chainId?:number;challengeId?:string;verifiedAtMs?:number};
export interface FirePlan { targets: Address[]; values: string[]; calldatas: Hex[]; description: string; descriptionHash: Hex; proposalId: string }
export interface OffboardingProof { kind: 'fired' | 'resigned'; transactionHash: Hex; blockNumber: string; blockHash: Hex; stoppedAt: string; retainedEarned: string }
interface AmendmentPlan { documentHash: string; amount: string; previousShares: string; blockNumber: string }
export interface EngagementContract extends OnboardingContract { fire_plan: FirePlan | null; offboarding_proof: OffboardingProof | null; amendment_plan: AmendmentPlan | null; amendment_execution_proof: unknown | null }
export class EngagementError extends Error {
  constructor(readonly code: 'invalid_stage' | 'invalid_proof' | 'wallet_required', message: string) { super(message); this.name = 'EngagementError'; }
}
function fail(code: EngagementError['code'], message: string): never { throw new EngagementError(code, message); }
const db = (deps: OnboardingDeps) => deps.sql ?? getOrgPg().sql;
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const abi = equityArtifacts.contracts.PapercuspEquityV2.abi;
export function buildFirePlan(plan: HirePlan, contractId: string): FirePlan {
  const targets = [plan.equity], values = ['0'];
  const calldatas = [prepareEquityTransaction({chainId: plan.chainId, from: plan.wallet, to: plan.equity,
    contract: 'PapercuspEquityV2', functionName: 'stopGrant', args: [plan.grantId]}).data];
  const description = 'End engagement ' + plan.personId + '\n' + JSON.stringify({contractId, grantId: plan.grantId});
  const descriptionHash = keccak256(stringToHex(description));
  const proposalId = String(BigInt(keccak256(encodeAbiParameters([{type:'address[]'},{type:'uint256[]'},{type:'bytes[]'},{type:'bytes32'}],
    [targets,[0n],calldatas,descriptionHash]))));
  return {targets, values, calldatas, description, descriptionHash, proposalId};
}
async function admitted(key: Key, policy: HivePolicy, deps: OnboardingDeps) {
  const contract = await getContractExecution(key,deps) as EngagementContract;
  if (!contract.admitted_at || !contract.hire_plan || !contract.hire_execution_proof || !contract.terms_acceptance_proof)
    fail('invalid_stage','An admitted hire is required.');
  assertHireDeployment(contract.hire_plan,policy);
  return {contract,plan:contract.hire_plan,chain:await onboardingChain(deps)};
}
async function admin(key: Key, deps: OnboardingDeps) { return deps.adminPerson ? deps.adminPerson(key) : resolveHiringActor(key,{sql:db(deps)}); }
/** Retained signer records remain readable after membership revocation. Never
 * return source documents, email snapshots or generic writable lifecycle flags. */
export async function readEngagement(key: Key, deps: OnboardingDeps = {}) {
  const contract = await getContractExecution(key, deps) as EngagementContract;
  let isAdmin = false, isCandidate = false;
  try { await admin(key, deps); isAdmin = true; }
  catch (error) { if (!(error instanceof HiringError && error.code === 'not_admin')) throw error; }
  if (!isAdmin) { await authenticateContractCandidate(contract, deps); isCandidate = true; }
  else {
    try { await authenticateContractCandidate(contract, deps); isCandidate = true; }
    catch (error) { if (!(error instanceof OnboardingError)) throw error; }
  }
  const offer = await getHiringOffer(key, deps);
  return { offerId: key.offerId, isAdmin, isCandidate, bindingEligible: contract.can_bind,
    admitted: !!contract.admitted_at, amendsOfferId: offer.amendsOfferId ?? null,
    signed: !!contract.completed_at && !!contract.sealed_pdf && !!contract.audit_certificate,
    fireProposalId: contract.fire_plan?.proposalId ?? null,
    offboarding: contract.offboarding_proof, amendment: contract.amendment_execution_proof };
}
export async function prepareEngagementFire(key: Key, policy: HivePolicy, deps: OnboardingDeps = {}) {
  await admin(key,deps);
  const {contract,plan} = await admitted(key,policy,deps);
  if (contract.offboarding_proof) fail('invalid_stage','The engagement has already ended.');
  const proposed = buildFirePlan(plan,contract.contract_id);
  const fire = await db(deps).begin(async tx => {
    const [locked] = await tx<EngagementContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id} FOR UPDATE`;
    if (locked!.offboarding_proof) fail('invalid_stage','The engagement has already ended.');
    if (locked!.fire_plan) return locked!.fire_plan;
    await tx`UPDATE harness_shared.dao_hr_contracts SET fire_plan=${(tx as unknown as Sql).json(proposed as unknown as Record<string,never>)} WHERE contract_id=${contract.contract_id}`;
    return proposed;
  });
  const result = await (deps.wallet ?? readWalletBinding)(), wallet = result.ok ? result.value.binding as HostedWallet | undefined : null;
  if (!wallet || wallet.chainId !== plan.chainId || !wallet.walletAddress || !wallet.challengeId || !wallet.verifiedAtMs)
    fail('wallet_required','Verify the proposer wallet on the equity chain.');
  return {plan:fire,unsignedTransaction:prepareEquityTransaction({chainId:plan.chainId,from:wallet.walletAddress,to:plan.governor,
    contract:'EquityGovernorV2',functionName:'propose',args:[fire.targets,fire.values,fire.calldatas,fire.description]})};
}
export async function prepareEngagementResignation(key: Key, policy: HivePolicy, deps: OnboardingDeps = {}) {
  const {contract,plan} = await admitted(key,policy,deps);
  await authenticateContractCandidate(contract,deps);
  if (contract.offboarding_proof) fail('invalid_stage','The engagement has already ended.');
  return prepareEquityTransaction({chainId:plan.chainId,from:plan.wallet,to:plan.equity,
    contract:'PapercuspEquityV2',functionName:'resignGrant',args:[plan.grantId]});
}
/** An exact signed transaction, canonical confirmed receipt, event and grant
 * storage must agree; the caller cannot write a passed-vote or stopped flag. */
export async function completeEngagementEnd(key: Key, policy: HivePolicy, kind: 'fired' | 'resigned', hash: Hex, deps: OnboardingDeps = {}) {
  const {contract,plan,chain} = await admitted(key,policy,deps);
  const actor = kind === 'fired' ? await admin(key,deps) : (await authenticateContractCandidate(contract,deps),plan.personId);
  if (contract.offboarding_proof) {
    if (contract.offboarding_proof.kind !== kind || !same(contract.offboarding_proof.transactionHash,hash)) fail('invalid_proof','The recorded end is immutable.');
    return contract.offboarding_proof;
  }
  const fire = contract.fire_plan;
  if (kind === 'fired' && !fire) fail('invalid_stage','Prepare the member fire proposal first.');
  const call = kind === 'fired'
    ? await confirmedEquityCall(chain,plan,hash,true,'execute',[fire!.targets,fire!.values,fire!.calldatas,fire!.descriptionHash])
    : await confirmedEquityCall(chain,plan,hash,false,'resignGrant',[plan.grantId],plan.wallet);
  if (kind === 'fired' && (!equityReceiptEvent(call.receipt.logs,plan,true,'ProposalExecuted',{proposalId:fire!.proposalId}) ||
    Number(await chain.readContract({address:plan.governor,abi:equityArtifacts.contracts.EquityGovernorV2.abi,functionName:'state',args:[BigInt(fire!.proposalId)],blockNumber:call.receipt.blockNumber})) !== 7))
    fail('invalid_proof','The exact member fire proposal must execute.');
  const blockNumber = call.receipt.blockNumber;
  const [grant,holderId,earned] = await Promise.all([
    chain.readContract({address:plan.equity,abi,functionName:'grants',args:[plan.grantId],blockNumber}),
    chain.readContract({address:plan.equity,abi,functionName:'memberId',args:[plan.wallet],blockNumber}),
    chain.readContract({address:plan.equity,abi,functionName:'earnedGrant',args:[plan.grantId],blockNumber}),
  ]);
  const g = grant as readonly unknown[], stoppedAt = String(g[6]), retainedEarned = String(earned);
  if (BigInt(String(holderId)) === 0n || !same(g[0],holderId) || stoppedAt !== String(call.block.timestamp) ||
    !equityReceiptEvent(call.receipt.logs,plan,false,kind === 'fired' ? 'GrantStopped' : 'GrantResigned',
      {grantId:plan.grantId,at:stoppedAt,retainedEarned})) fail('invalid_proof','The grant stop and retained earned equity must match.');
  const proof: OffboardingProof = {...call.proof,kind,stoppedAt,retainedEarned};
  const scope = await (deps.scope ?? resolveFederatedPotScope)(key.workspaceId,key.daoSlug,{sql:db(deps)});
  return db(deps).begin(async tx => {
    const sql = tx as unknown as Sql;
    const [locked] = await tx<EngagementContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id} FOR UPDATE`;
    if (locked!.offboarding_proof) {
      if (!same(locked!.offboarding_proof.transactionHash,hash) || locked!.offboarding_proof.kind !== kind) fail('invalid_proof','The recorded end is immutable.');
      return locked!.offboarding_proof;
    }
    const profile = await getWorkProfile({...key,personId:plan.personId},{sql});
    if (!profile || profile.memberGithubUserId !== Number(contract.candidate_github_id)) fail('invalid_stage','The admitted profile identity must match.');
    // P002 deliberately exposes no generic active->offboarded setter. Only
    // verified stop proof reaches this guarded update; rollback covers access.
    const changed = await tx`UPDATE harness_shared.dao_hr_work_profiles SET status='offboarded',updated_at=now()
      WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND person_id=${profile.personId} AND status='active' RETURNING person_id`;
    if (!changed.length) fail('invalid_stage','The work profile must still be active.');
    await removeHiveMember(key.workspaceId,scope,Number(contract.candidate_github_id),sql);
    // Workbench membership and its HR-admin role use these existing rosters.
    await tx`DELETE FROM harness_shared.dao_hr_admins WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND person_id IN (${profile.personId},${plan.personId})`;
    await tx`UPDATE harness_shared.dao_hr_contracts SET offboarding_proof=${sql.json(proof as unknown as Record<string,never>)} WHERE contract_id=${contract.contract_id}`;
    await tx`INSERT INTO harness_shared.dao_hr_hiring_history (workspace_id,dao_slug,subject_kind,subject_id,state,actor_person_id)
      VALUES (${key.workspaceId},${key.daoSlug},'offer',${key.offerId},${kind},${actor})`;
    return proof;
  });
}

async function signedAmendment(key: Key, policy: HivePolicy, deps: OnboardingDeps) {
  const offer = await getHiringOffer(key,deps), amendment = await getContractExecution(key,deps) as EngagementContract;
  if (!offer.amendsOfferId || !['signed','binding'].includes(amendment.state) || !amendment.completed_at || !amendment.sealed_pdf ||
    !amendment.audit_certificate || amendment.document_hash !== '0x'+createHash('sha256').update(amendment.sealed_pdf).digest('hex'))
    fail('invalid_stage','Both signatures on an immutable amendment are required.');
  const original = await admitted({...key,offerId:offer.amendsOfferId},policy,deps);
  const originalOffer = await getHiringOffer({...key,offerId:offer.amendsOfferId},deps);
  if (['vestingDays','cliffDays','startRule'].some(field =>
    originalOffer.terms.equity[field as keyof typeof originalOffer.terms.equity] !== offer.terms.equity[field as keyof typeof offer.terms.equity]))
    fail('invalid_stage','The V2 amendment raises shares; it preserves the signed vesting schedule.');
  if (original.contract.offboarding_proof || amendment.merge_values.amends_contract_ref !== original.contract.contract_id ||
    amendment.signers[0].personId !== original.contract.signers[0].personId)
    fail('invalid_stage','The signed amendment must match the active original engagement.');
  return {...original,offer,amendment};
}
/** Pay changes need only the newly signed document. An equity increase is the
 * existing V2 bounded-admin raiseGrant call, never a governor proposal. */
export async function prepareEngagementAmendment(key: Key, policy: HivePolicy, deps: OnboardingDeps = {}) {
  await admin(key,deps);
  const {contract,plan,chain,offer,amendment} = await signedAmendment(key,policy,deps), blockNumber = await chain.getBlockNumber();
  const [grant,limit] = await Promise.all([
    chain.readContract({address:plan.equity,abi,functionName:'grants',args:[plan.grantId],blockNumber}),
    chain.readContract({address:plan.equity,abi,functionName:'grantLimit',args:[],blockNumber}),
  ]);
  const g = grant as readonly unknown[], amount = BigInt(offer.terms.equity.shares);
  const previousShares = BigInt(String(g[1]));
  if (BigInt(String(g[6])) !== 0n || amount < previousShares || (amount > previousShares && amount > BigInt(String(limit))))
    fail('invalid_stage','An amendment cannot reduce equity, exceed the per-grant limit or raise a stopped grant.');
  const proposed: AmendmentPlan = {documentHash:amendment.document_hash!,amount:String(amount),previousShares:String(g[1]),blockNumber:String(blockNumber)};
  const frozen = await db(deps).begin(async tx => {
    const [original] = await tx<EngagementContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id} FOR UPDATE`;
    const [locked] = await tx<EngagementContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${amendment.contract_id} FOR UPDATE`;
    if (original!.offboarding_proof) fail('invalid_stage','The original engagement ended.');
    if (locked!.amendment_plan) return locked!.amendment_plan;
    await tx`UPDATE harness_shared.dao_hr_contracts SET amendment_plan=${(tx as unknown as Sql).json({...proposed})} WHERE contract_id=${amendment.contract_id}`;
    return proposed;
  });
  if (frozen.amount === frozen.previousShares) return {plan:frozen,unsignedTransaction:null};
  const wallet = await (deps.wallet ?? readWalletBinding)(), link = wallet.ok ? wallet.value.binding as HostedWallet | undefined : null;
  if (!link?.walletAddress || link.chainId !== plan.chainId || !link.challengeId || !link.verifiedAtMs)
    fail('wallet_required','Verify the bounded admin wallet on this chain.');
  return {plan:frozen,unsignedTransaction:prepareEquityTransaction({chainId:plan.chainId,from:link.walletAddress,to:plan.equity,
    contract:'PapercuspEquityV2',functionName:'raiseGrant',args:[plan.grantId,BigInt(frozen.amount)]})};
}
export async function completeEngagementAmendment(key: Key, policy: HivePolicy, hash: Hex | null, deps: OnboardingDeps = {}) {
  const actor = await admin(key,deps), {contract,plan,chain,offer,amendment} = await signedAmendment(key,policy,deps);
  if (amendment.amendment_execution_proof) return amendment.amendment_execution_proof;
  const frozen = amendment.amendment_plan;
  if (!frozen || frozen.documentHash !== amendment.document_hash) fail('invalid_stage','Prepare the exact signed amendment first.');
  const amount = BigInt(offer.terms.equity.shares), blockNumber = await chain.getBlockNumber();
  const grant = await chain.readContract({address:plan.equity,abi,functionName:'grants',args:[plan.grantId],blockNumber}) as readonly unknown[];
  if (BigInt(String(grant[6])) !== 0n || BigInt(String(grant[1])) !== amount) fail('invalid_proof','The active grant must match the signed amendment.');
  let transaction: {transactionHash:Hex;blockNumber:string;blockHash:Hex} | null = null;
  if (frozen.amount !== frozen.previousShares) {
    if (!hash) fail('invalid_proof','The equity amendment needs its exact confirmed admin transaction.');
    const call = await confirmedEquityCall(chain,plan,hash,false,'raiseGrant',[plan.grantId,amount]);
    if (call.receipt.blockNumber <= BigInt(frozen.blockNumber) || !equityReceiptEvent(call.receipt.logs,plan,false,'GrantRaised',
      {grantId:plan.grantId,previousShares:frozen.previousShares,shares:amount}))
      fail('invalid_proof','The admin raise must match the signed amendment.');
    transaction = call.proof;
  } else if (hash) fail('invalid_proof','This pay-only amendment requires no equity transaction.');
  const proof = {documentHash:amendment.document_hash,transaction,executedAt:new Date().toISOString()};
  return db(deps).begin(async tx => {
    const sql = tx as unknown as Sql;
    // Lock the original first, as offboarding does, to serialize access revocation.
    const [original] = await tx<EngagementContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${contract.contract_id} FOR UPDATE`;
    const [locked] = await tx<EngagementContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE contract_id=${amendment.contract_id} FOR UPDATE`;
    if (original!.offboarding_proof) fail('invalid_stage','The engagement ended before the amendment could execute.');
    if (locked!.amendment_execution_proof) return locked!.amendment_execution_proof;
    const profile = await getWorkProfile({...key,personId:plan.personId},{sql});
    if (!profile || profile.status !== 'active') fail('invalid_stage','The work profile must be active.');
    await saveWorkProfile({...profile,engagementType:offer.terms.engagementType,jurisdiction:offer.terms.jurisdiction,pay:offer.terms.pay},{sql});
    await tx`UPDATE harness_shared.dao_hr_contracts SET amendment_execution_proof=${sql.json(proof)} WHERE contract_id=${amendment.contract_id}`;
    await tx`INSERT INTO harness_shared.dao_hr_hiring_history (workspace_id,dao_slug,subject_kind,subject_id,state,actor_person_id)
      VALUES (${key.workspaceId},${key.daoSlug},'offer',${key.offerId},'amendment-executed',${actor})`;
    return proof;
  });
}

import { defineTool } from '@papercusp/agent-mcp';
import { z, ZodError } from 'zod';
import { activeWorkspaceId } from '../../../workspace-registry';
import { ContractTemplateError, listContractTemplates } from '../../../dao-hr/contract-templates';
import { HiringError, resolveHiringActor } from '../../../dao-hr/hiring';
import { completeContractSigning, ContractSigningError, getContractExecution, prepareContractExecution, reconcileContractSigning, startContractSigning } from '../../../dao-hr/contracts-esign';
import { DocumensoError } from '../../../dao-hr/documenso';
import { requireAllowedOriginOr403 } from '../../cors';
import { resolveFederatedPotScope } from '../../../federated-pot-scope';
import { getHivePolicy } from '../../../hive-policy-store';
import { admitHire, OnboardingError, prepareHireAcceptance, prepareHireProposal, readOnboarding, reconcileFailedHire, recordHireExecution, recordHireProposal, runOnboardingWalletAction, verifyOnboardingIdentity } from '../../../dao-hr/onboarding';
import { WorkProfileError } from '../../../dao-hr/work-profile';
import { completeEngagementAmendment, completeEngagementEnd, EngagementError, prepareEngagementAmendment, prepareEngagementFire, prepareEngagementResignation, readEngagement } from '../../../dao-hr/engagement-changes';

const actions=z.discriminatedUnion('action',[
  z.object({action:z.literal('prepare'),offerId:z.string().min(1),companyPersonId:z.string().min(1),startDate:z.string(),templates:z.array(z.object({templateKey:z.string().min(1),version:z.number().int().positive()}).strict()).min(2).max(4)}).strict(),
  z.object({action:z.literal('start'),offerId:z.string().min(1)}).strict(),
  z.object({action:z.literal('reconcile'),offerId:z.string().min(1),envelopeId:z.string().trim().min(1).max(200)}).strict(),
]);
function failure(error:unknown){
  if(error instanceof ZodError)return Response.json({ok:false,error:'invalid_input',message:'Contract fields are missing or invalid.'},{status:400});
  if(error instanceof ContractTemplateError||error instanceof ContractSigningError||error instanceof HiringError||error instanceof DocumensoError||error instanceof OnboardingError||error instanceof WorkProfileError||error instanceof EngagementError)
    return Response.json({ok:false,error:error.code,message:error.message,...(error instanceof DocumensoError && error.completion ? {completion:error.completion} : {})},{status:['not_admin','invalid_webhook','identity_required','identity_mismatch'].includes(error.code)?403:error.code==='invalid_input'?400:409});
  throw error;
}
const get=defineTool({method:'GET',path:'/pot/:id/contracts',auth:'loopback',async handler(req,ctx){
  const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!};
  try{
    await resolveHiringActor(key);
    const templates=await listContractTemplates(key),offerId=new URL(req.url).searchParams.get('offer');
    let execution=null;
    if(offerId){
      try{
        const row=await getContractExecution({...key,offerId});
        execution={contractId:row.contract_id,state:row.state,bindingEligible:row.can_bind,documentHash:row.document_hash,completedAt:row.completed_at,signingLinks:row.signing_links,templates:row.templates};
      }catch(error){if(!(error instanceof ContractSigningError&&error.code==='contract_missing'))throw error;}
    }
    return Response.json({ok:true,templates,execution});
  }catch(error){return failure(error);}
}});
const post=defineTool({method:'POST',path:'/pot/:id/contracts',auth:'loopback',async handler(req,ctx){
  const refusal=requireAllowedOriginOr403(req);if(refusal)return refusal;
  try{
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!},actorPersonId=await resolveHiringActor(key),action=actions.parse(await req.json().catch(()=>null));
    const row=action.action==='prepare'?await prepareContractExecution({...key,...action,actorPersonId}):action.action==='reconcile'?await reconcileContractSigning({...key,...action,actorPersonId}):await startContractSigning({...key,...action,actorPersonId});
    return Response.json({ok:true,contractId:row.contract_id,state:row.state});
  }catch(error){return failure(error);}
}});
const document=defineTool({method:'GET',path:'/pot/:id/contracts/:offerId/document',auth:'loopback',async handler(req,ctx){
  try{
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!};await resolveHiringActor(key);
    const row=await getContractExecution({...key,offerId:ctx.params.offerId!}),kind=new URL(req.url).searchParams.get('kind')??'sealed';
    if(!['source','sealed','certificate'].includes(kind))throw new ContractSigningError('invalid_input','Choose a contract PDF or audit certificate.');
    const bytes=kind==='source'?row.source_pdf:kind==='sealed'?row.sealed_pdf:row.audit_certificate;
    if(!bytes)throw new ContractSigningError('invalid_transition','The executed artifact is unavailable until both signers finish.');
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="contract-'+kind+'.pdf"','Cache-Control':'private, no-store'}});
  }catch(error){return failure(error);}
}});
const webhook=defineTool({method:'POST',path:'/dao-hr/documenso/webhook',auth:'public',async handler(req){
  try{
    const row=await completeContractSigning(req.headers.get('X-Documenso-Secret'),await req.json().catch(()=>null));
    return Response.json({ok:true,contractId:row.contract_id,state:row.state});
  }catch(error){return failure(error);}
}});
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value as `0x${string}`);
const onboardingActions = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['verify-identity', 'prepare-hire', 'prepare-acceptance', 'reconcile-failed-hire']) }).strict(),
  z.object({ action: z.enum(['record-proposal', 'record-execution', 'admit']), transactionHash: hash }).strict(),
  z.object({ action: z.literal('wallet-challenge'), walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chainId: z.number().int().positive().safe() }).strict(),
  z.object({ action: z.literal('wallet-verify'), challengeId: z.string().min(1).max(100), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
]);
async function onboardingPolicy(key: { workspaceId: string; daoSlug: string }) {
  return (await getHivePolicy(key.workspaceId, await resolveFederatedPotScope(key.workspaceId, key.daoSlug)))?.policy ?? {};
}
const onboardingGet = defineTool({ method:'GET', path:'/pot/:id/contracts/:offerId/onboarding', auth:'loopback', async handler(_req,ctx) {
  try {
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!,offerId:ctx.params.offerId!};
    return Response.json({ok:true,onboarding:await readOnboarding(key,await onboardingPolicy(key))},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) { return failure(error); }
}});
const onboardingPost = defineTool({ method:'POST', path:'/pot/:id/contracts/:offerId/onboarding', auth:'loopback', async handler(req,ctx) {
  const refusal=requireAllowedOriginOr403(req);if(refusal)return refusal;
  try {
    const action=onboardingActions.parse(await req.json().catch(()=>null));
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!,offerId:ctx.params.offerId!},policy=await onboardingPolicy(key);
    await readOnboarding(key,policy);
    let result:unknown;
    switch(action.action) {
      case 'verify-identity': await verifyOnboardingIdentity(key); result={verified:true}; break;
      case 'prepare-hire': result=await prepareHireProposal(key,policy); break;
      case 'prepare-acceptance': result=await prepareHireAcceptance(key,policy); break;
      case 'reconcile-failed-hire': result=await reconcileFailedHire(key,policy); break;
      case 'record-proposal': result=await recordHireProposal(key,policy,action.transactionHash); break;
      case 'record-execution': result=await recordHireExecution(key,policy,action.transactionHash); break;
      case 'admit': result=await admitHire(key,policy,action.transactionHash); break;
      case 'wallet-challenge': case 'wallet-verify': {
        const wallet=await runOnboardingWalletAction(key,action);
        if(!wallet.ok)return Response.json(wallet,{status:wallet.status});
        result=wallet.value;break;
      }
    }
    return Response.json({ok:true,result},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) { return failure(error); }
}});
const engagementActions = z.discriminatedUnion('action', [
  z.object({action:z.enum(['prepare-fire','prepare-resignation','prepare-amendment'])}).strict(),
  z.object({action:z.enum(['complete-fire','complete-resignation']),transactionHash:hash}).strict(),
  z.object({action:z.literal('complete-amendment'),transactionHash:hash.nullable()}).strict(),
]);
const engagementGet = defineTool({method:'GET',path:'/pot/:id/contracts/:offerId/engagement',auth:'loopback',async handler(_req,ctx){
  try {
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!,offerId:ctx.params.offerId!};
    return Response.json({ok:true,engagement:await readEngagement(key)},{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) {return failure(error);}
}});
const engagementPost = defineTool({method:'POST',path:'/pot/:id/contracts/:offerId/engagement',auth:'loopback',async handler(req,ctx){
  const refusal=requireAllowedOriginOr403(req);if(refusal)return refusal;
  try {
    const action=engagementActions.parse(await req.json().catch(()=>null));
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!,offerId:ctx.params.offerId!},policy=await onboardingPolicy(key);
    let result:unknown;
    switch(action.action){
      case 'prepare-fire':result=await prepareEngagementFire(key,policy);break;
      case 'prepare-resignation':result=await prepareEngagementResignation(key,policy);break;
      case 'prepare-amendment':result=await prepareEngagementAmendment(key,policy);break;
      case 'complete-fire':result=await completeEngagementEnd(key,policy,'fired',action.transactionHash);break;
      case 'complete-resignation':result=await completeEngagementEnd(key,policy,'resigned',action.transactionHash);break;
      case 'complete-amendment':result=await completeEngagementAmendment(key,policy,action.transactionHash);break;
    }
    return Response.json({ok:true,result},{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return failure(error);}
}});
export default [get,post,document,webhook,onboardingGet,onboardingPost,engagementGet,engagementPost];

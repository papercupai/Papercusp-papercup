/** P006: extend the registry and offer lifecycle with immutable signing proof.
 * A signed contract is conditional; only verified hire execution can bind it. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { z } from 'zod';
import { PERSON_DATATYPE, getCanonicalEntity } from '../relationship-graph/resolver';
import { generateContract, getIssuingEntity, getTemplateVersionStatus, isDaoHrAdmin, type DaoKey } from './contract-templates';
import { requireHiringStage, type HiringOffer } from './hiring';
import { DocumensoAdapter, type SigningPerson } from './documenso';

export class ContractSigningError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_admin' | 'contract_missing' | 'invalid_transition' | 'dispatch_unknown' | 'document_mismatch', message: string) { super(message); this.name = 'ContractSigningError'; }
}
interface Deps { sql?: Sql; adapter?: DocumensoAdapter }
export interface ContractExecution {
  workspace_id: string; dao_slug: string; offer_id: string; contract_id: string;
  state: 'prepared' | 'dispatching' | 'signing' | 'signed' | 'binding' | 'lapsed';
  templates: Array<{ templateKey: string; version: number; contentHash: string }>;
  merge_values: Record<string,string>; signers: [SigningPerson,SigningPerson];
  can_bind: boolean; source_pdf: Uint8Array; envelope_id: string | null;
  signing_links: Array<{ email: string; signingUrl: string }> | null;
  sealed_pdf: Uint8Array | null; audit_certificate: Uint8Array | null; document_hash: string | null;
  completed_at: string | null; completion_proof: unknown; created_by: string;
}
const db = (deps: Deps) => deps.sql ?? getOrgPg().sql;
const sha256 = (bytes: Uint8Array) => '0x' + createHash('sha256').update(bytes).digest('hex');
const connection = (tx: unknown) => tx as Sql;
// Lazy on purpose: pdf-lib + @pdf-lib/fontkit (~2.4 MB) are external to the host bundle
// (apps/operator/bin/bundle-host.sh). A static import would hoist them into every host
// process at boot; a dynamic one loads them only when a contract PDF is built or read.
const loadPdfLib = () => import('pdf-lib');
const loadFontkit = async () => (await import('@pdf-lib/fontkit')).default;
// Resolve from the package export so host bundling cannot move the asset path.
const require=createRequire(import.meta.url);
let contractFont:Buffer|undefined;
function contractFontBytes(){
  return contractFont??=readFileSync(join(dirname(require.resolve('@papercusp/operator-core/package.json')),'lib/dao-hr/fonts/NotoSans-Regular.ttf'));
}
async function admin(sql: Sql, key: DaoKey, id: string) {
  const person = await getCanonicalEntity(sql, key.workspaceId, PERSON_DATATYPE, id);
  if (!person || !await isDaoHrAdmin({ ...key, personId: person.id }, { sql })) throw new ContractSigningError('not_admin', 'A DAO HR admin must manage contracts.');
  return person.id;
}
async function signer(sql: Sql, key: DaoKey, personId: string): Promise<SigningPerson> {
  const person = await getCanonicalEntity(sql, key.workspaceId, PERSON_DATATYPE, personId);
  const email = z.string().email().safeParse(person?.payload.email);
  if (!person || !person.title.trim() || !email.success) throw new ContractSigningError('invalid_input', 'The signer needs a name and email in their shared person record.');
  return { personId: person.id, name: person.title, email: email.data.toLowerCase() };
}
export function offerMergeValues(offer: HiringOffer, extra: { issuerTitle: string; roleTitle: string; startDate: string; contractId: string }): Record<string,string> {
  return { issuer_title: extra.issuerTitle, person_ref: offer.personId, role_title: extra.roleTitle, start_date: extra.startDate,
    engagement_type: offer.terms.engagementType, pay_amount: offer.terms.pay.amount, pay_currency: offer.terms.pay.currency, pay_cadence: offer.terms.pay.cadence,
    share_amount: String(offer.terms.equity.shares), vesting_days: String(offer.terms.equity.vestingDays), cliff_days: String(offer.terms.equity.cliffDays),
    vesting_months: String(offer.terms.equity.vestingDays/30), cliff_months: String(offer.terms.equity.cliffDays/30),
    start_rule: offer.terms.equity.startRule, hire_proposal_ref: extra.contractId, tax_jurisdiction: offer.terms.jurisdiction };
}
/** Noto Sans is bundled under OFL; no host-installed font or network is needed.
 * Missing glyphs are refused instead of silently changing names or legal text. */
export async function contractPdf(documents: string[]) {
  const [{ PDFDocument }, fontkit] = await Promise.all([loadPdfLib(), loadFontkit()]);
  const pdf = await PDFDocument.create();pdf.registerFontkit(fontkit);
  const font=await pdf.embedFont(contractFontBytes(),{subset:true}),glyphs=new Set(font.getCharacterSet());
  for(const document of documents)for(const character of document){
    if(!/\s/u.test(character)&&!glyphs.has(character.codePointAt(0)!))
      throw new ContractSigningError('invalid_input','The contract font does not support character U+'+character.codePointAt(0)!.toString(16).toUpperCase()+'. Select a template using supported text.');
  }
  for (const document of documents) {
    let page = pdf.addPage([595,842]), y = 790;
    for (const paragraph of document.replace(/\r\n?/g,'\n').split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        if (font.widthOfTextAtSize(word,11) > 495) throw new ContractSigningError('invalid_input', 'A template word is too long for the contract page.');
        if (line && font.widthOfTextAtSize(line + ' ' + word,11) > 495) {
          if (y < 70) { page = pdf.addPage([595,842]); y = 790; }
          page.drawText(line,{ x:50,y,size:11,font }); y -= 16; line = word;
        } else line = line ? line + ' ' + word : word;
      }
      if (y < 70) { page = pdf.addPage([595,842]); y = 790; }
      page.drawText(line,{ x:50,y,size:11,font }); y -= 18;
    }
  }
  // Signature fields are placed on a dedicated final page, never over clauses.
  const signaturePage = pdf.addPage([595,842]);
  signaturePage.drawText('Candidate signature and company countersignature',{ x:50,y:790,size:12,font });
  return { pdf: new Uint8Array(await pdf.save()), lastPage: pdf.getPageCount() };
}
async function history(sql: Sql, key: DaoKey, offerId: string, state: string, actor: string) {
  await sql`INSERT INTO harness_shared.dao_hr_hiring_history (workspace_id,dao_slug,subject_kind,subject_id,state,actor_person_id)
    VALUES (${key.workspaceId},${key.daoSlug},'offer',${offerId},${state},${actor})`;
}
export async function getContractExecution(key: DaoKey & { offerId: string }, deps: Deps = {}): Promise<ContractExecution> {
  const [row] = await db(deps)<ContractExecution[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${key.offerId}`;
  if (!row) throw new ContractSigningError('contract_missing', 'Generate the approved offer contract first.');
  return row;
}
export async function prepareContractExecution(input: DaoKey & { offerId: string; actorPersonId: string; companyPersonId: string; startDate: string; templates: Array<{ templateKey: string; version: number }> }, deps: Deps = {}) {
  const sql = db(deps), actor = await admin(sql,input,input.actorPersonId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !Number.isFinite(Date.parse(input.startDate)) || new Date(input.startDate).toISOString().slice(0,10) !== input.startDate || input.templates.length < 2 || input.templates.length > 4) throw new ContractSigningError('invalid_input', 'A start date and registered engagement and equity templates are required.');
  return sql.begin(async tx => {
    const conn = connection(tx);
    await tx`SELECT offer_id FROM harness_shared.dao_hr_offers WHERE workspace_id=${input.workspaceId} AND dao_slug=${input.daoSlug} AND offer_id=${input.offerId} FOR UPDATE`;
    const [existing] = await tx<ContractExecution[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE workspace_id=${input.workspaceId} AND dao_slug=${input.daoSlug} AND offer_id=${input.offerId}`;
    if (existing) return existing;
    const offer = await requireHiringStage({ ...input,stage:'contract' },{ sql:conn });
    const company = await admin(conn,input,input.companyPersonId);
    const signers: [SigningPerson,SigningPerson] = [await signer(conn,input,offer.personId),await signer(conn,input,company)];
    if (signers[0].personId === signers[1].personId || signers[0].email === signers[1].email) throw new ContractSigningError('invalid_input','The candidate and company must be separate signers.');
    const entity = await getIssuingEntity(input,{ sql:conn });
    const [role] = await tx<Array<{ title:string }>>`SELECT title FROM harness_shared.dao_hr_roles WHERE workspace_id=${input.workspaceId} AND dao_slug=${input.daoSlug} AND role_id=${offer.roleId}`;
    const contractId = randomUUID(), values = offerMergeValues(offer,{ issuerTitle:entity?.registeredTitle ?? 'Non-binding sample issuer',roleTitle:role!.title,startDate:input.startDate,contractId });
    if (offer.amendsOfferId) {
      const parent = await getContractExecution({...input,offerId:offer.amendsOfferId},{sql:conn}) as ContractExecution & {admitted_at:string|null;offboarding_proof:unknown;hire_proposal_ref:string|null};
      if (!parent.admitted_at || parent.offboarding_proof) throw new ContractSigningError('invalid_transition','Amend only an active admitted engagement.');
      values.amends_contract_ref = parent.contract_id;
      values.hire_proposal_ref = parent.hire_proposal_ref!;
    }
    const generated = [], refs = [], kinds = new Set<string>();
    for (const ref of input.templates) {
      const status = await getTemplateVersionStatus({ ...input,...ref },{ sql:conn });
      if (offer.amendsOfferId && !status.version.mergeFields.includes('amends_contract_ref'))
        throw new ContractSigningError('invalid_input','An amendment template must identify the original contract.');
      if (status.template.engagementType !== offer.terms.engagementType || status.template.jurisdiction !== offer.terms.jurisdiction || kinds.has(status.template.documentKind)) throw new ContractSigningError('invalid_input','Template engagement, jurisdiction and document kinds must match the approved offer.');
      kinds.add(status.template.documentKind);
      const selected = Object.fromEntries(status.version.mergeFields.map(field => [field,values[field]]));
      const doc = await generateContract({ ...input,...ref,values:selected },{ sql:conn });
      generated.push(doc); refs.push({ ...ref,contentHash:doc.contentHash });
    }
    if (!kinds.has(offer.terms.engagementType === 'employee' ? 'employment-agreement' : 'contractor-agreement') || !kinds.has('equity-grant-agreement')) throw new ContractSigningError('invalid_input','Both the engagement agreement and equity grant agreement are required.');
    const pdf = await contractPdf(generated.map(doc => doc.document));
    const [saved] = await tx<ContractExecution[]>`INSERT INTO harness_shared.dao_hr_contracts (workspace_id,dao_slug,offer_id,contract_id,templates,merge_values,signers,can_bind,source_pdf,created_by)
      VALUES (${input.workspaceId},${input.daoSlug},${input.offerId},${contractId},${conn.json(refs)},${conn.json(values)},${conn.json(signers.map(s=>({...s})))},${generated.every(d=>d.bindingEligible)},${Buffer.from(pdf.pdf)},${actor}) RETURNING *`;
    await tx`UPDATE harness_shared.dao_hr_offers SET state='contract-generated' WHERE workspace_id=${input.workspaceId} AND dao_slug=${input.daoSlug} AND offer_id=${input.offerId}`;
    await history(conn,input,input.offerId,'contract-generated',actor);
    return saved!;
  }) as Promise<ContractExecution>;
}
/** A durable CAS precedes the external create. An ambiguous create cannot be
 * blindly retried; its recorded externalId must be reconciled with Documenso. */
export async function startContractSigning(input: DaoKey & { offerId:string;actorPersonId:string },deps:Deps={}) {
  const sql=db(deps),actor=await admin(sql,input,input.actorPersonId),adapter=deps.adapter??DocumensoAdapter.configured();
  let row=await getContractExecution(input,deps);
  if (row.state==='prepared') {
    const changed=await sql`UPDATE harness_shared.dao_hr_contracts SET state='dispatching' WHERE workspace_id=${input.workspaceId} AND dao_slug=${input.daoSlug} AND offer_id=${input.offerId} AND state='prepared' RETURNING contract_id`;
    if (!changed.length) throw new ContractSigningError('invalid_transition','Another signing dispatch is in progress.');
    const pdf=await (await loadPdfLib()).PDFDocument.load(row.source_pdf);
    const id=await adapter.create({ contractId:row.contract_id,pdf:row.source_pdf,lastPage:pdf.getPageCount(),signers:row.signers });
    await sql`UPDATE harness_shared.dao_hr_contracts SET envelope_id=${id} WHERE workspace_id=${input.workspaceId} AND dao_slug=${input.daoSlug} AND offer_id=${input.offerId} AND state='dispatching'`;
    row=await getContractExecution(input,deps);
  }
  if (row.state==='signing'||row.state==='signed'||row.state==='binding') return row;
  if (row.state!=='dispatching'||!row.envelope_id) throw new ContractSigningError('dispatch_unknown','Signing dispatch requires reconciliation with Documenso using contract reference '+row.contract_id+'.');
  const links=await adapter.distribute(row.envelope_id);
  if (row.signers.some(s=>!links.some(l=>l.email.toLowerCase()===s.email))) throw new ContractSigningError('invalid_transition','Signing links differ from the recorded signers.');
  await sql.begin(async tx=>{
    const changed=await tx`UPDATE harness_shared.dao_hr_contracts SET state='signing',signing_links=${connection(tx).json(links.map(l=>({...l})))} WHERE workspace_id=${input.workspaceId} AND dao_slug=${input.daoSlug} AND offer_id=${input.offerId} AND state='dispatching' RETURNING contract_id`;
    if(changed.length) await history(connection(tx),input,input.offerId,'signing-started',actor);
  });
  return getContractExecution(input,deps);
}
/** An HR admin supplies the envelope found by its immutable contract reference.
 * Provider identity/document checks precede the compare-and-set; no new envelope
 * is created, and a competing recovery cannot replace the selected envelope. */
export async function reconcileContractSigning(input:DaoKey&{offerId:string;actorPersonId:string;envelopeId:string},deps:Deps={}) {
  const sql=db(deps);await admin(sql,input,input.actorPersonId);
  if(!input.envelopeId.trim()||input.envelopeId.length>200)throw new ContractSigningError('invalid_input','A Documenso envelope ID is required.');
  const row=await getContractExecution(input,deps);
  if(row.envelope_id===input.envelopeId&&['signing','signed','binding'].includes(row.state))return row;
  if(row.state!=='dispatching'||(row.envelope_id&&row.envelope_id!==input.envelopeId))throw new ContractSigningError('invalid_transition','Only an unresolved signing dispatch can be reconciled.');
  const adapter=deps.adapter??DocumensoAdapter.configured();
  const status=await adapter.reconcile({contractId:row.contract_id,envelopeId:input.envelopeId,signers:row.signers,pdf:row.source_pdf});
  const changed=await sql`UPDATE harness_shared.dao_hr_contracts SET envelope_id=${input.envelopeId}
    WHERE contract_id=${row.contract_id} AND state='dispatching' AND (envelope_id IS NULL OR envelope_id=${input.envelopeId}) RETURNING contract_id`;
  if(!changed.length)throw new ContractSigningError('invalid_transition','Another signing reconciliation completed first.');
  if(status==='COMPLETED') {
    // Authenticated provider reads recover even when its webhook arrived before
    // the lost create response was reconciled. No client-supplied signed state.
    const event={event:'DOCUMENT_COMPLETED' as const,createdAt:new Date().toISOString(),payload:{envelopeId:input.envelopeId,externalId:row.contract_id,status:'COMPLETED' as const}};
    const proof=await adapter.completed(event,{contractId:row.contract_id,envelopeId:input.envelopeId,signers:row.signers});
    return persistContractCompletion(sql,{...row,envelope_id:input.envelopeId},proof,'provider-read');
  }
  return startContractSigning(input,{...deps,adapter});
}
/** Authenticated provider events share the same completion verifier as recovery. */
export async function completeContractSigning(secret:string|null,raw:unknown,deps:Deps={}) {
  const adapter=deps.adapter??DocumensoAdapter.configured(),event=adapter.verifyWebhook(secret,raw),sql=db(deps);
  const [row]=await sql<ContractExecution[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE envelope_id=${event.payload.envelopeId} AND contract_id=${event.payload.externalId}`;
  if(!row) throw new ContractSigningError('contract_missing','The signing event has no contract.');
  if(['signed','binding','lapsed'].includes(row.state)) return row;
  const proof=await adapter.completed(event,{contractId:row.contract_id,envelopeId:row.envelope_id!,signers:row.signers});
  return persistContractCompletion(sql,row,proof,'webhook');
}
async function persistContractCompletion(sql:Sql,row:ContractExecution,proof:Awaited<ReturnType<DocumensoAdapter['completed']>>,source:'webhook'|'provider-read') {
  await sql.begin(async tx=>{
    const changed=await tx`UPDATE harness_shared.dao_hr_contracts SET state='signed',sealed_pdf=${Buffer.from(proof.document)},audit_certificate=${Buffer.from(proof.certificate)},document_hash=${sha256(proof.document)},completion_proof=${connection(tx).json({event:proof.event,signers:proof.signers,source})},completed_at=${proof.completedAt}
      WHERE contract_id=${row.contract_id} AND state IN ('dispatching','signing') RETURNING contract_id`;
    if(changed.length){
      const key={workspaceId:row.workspace_id,daoSlug:row.dao_slug};
      await tx`UPDATE harness_shared.dao_hr_offers SET state='signed' WHERE workspace_id=${key.workspaceId} AND dao_slug=${key.daoSlug} AND offer_id=${row.offer_id} AND state='contract-generated'`;
      await history(connection(tx),key,row.offer_id,'signed',row.signers[1].personId);
    }
  });
  return getContractExecution({workspaceId:row.workspace_id,daoSlug:row.dao_slug,offerId:row.offer_id},{sql});
}

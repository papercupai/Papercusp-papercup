import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { contractPdf, offerMergeValues } from './contracts-esign';
import { DocumensoAdapter, type SigningPerson } from './documenso';
import type { HiringOffer } from './hiring';

const secret = 'test-fixture-webhook-secret-at-least-24';
const signers: [SigningPerson,SigningPerson] = [{ personId:'PER-candidate',name:'Candidate',email:'candidate@example.test' },{ personId:'PER-company',name:'Company signer',email:'company@example.test' }];
const event = { event:'DOCUMENT_COMPLETED',createdAt:'2026-10-11T20:00:00.000Z',payload:{ envelopeId:'envelope',externalId:'contract',status:'COMPLETED' } };
const envelope = () => ({ id:'envelope',externalId:'contract',status:'COMPLETED',completedAt:'2026-10-11T20:00:00.000Z',
  recipients:signers.map(s=>({ ...s,role:'SIGNER',signingStatus:'SIGNED',signedAt:'2026-10-11T19:00:00.000Z',authOptions:{accessAuth:['ACCOUNT']} })),envelopeItems:[{id:'item'}] });
const configured = (fetcher:typeof fetch) => new DocumensoAdapter({ baseUrl:'https://signing.example.test',apiKey:'fixture-api-key',webhookSecret:secret },fetcher);
describe('SPEC-P-006 — Documenso Envelope API contract',()=>{
  it('uploads a registry PDF with distinct authenticated signers in sequential order and no email distribution',async()=>{
    const fetcher=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>Response.json({id:'envelope'}));
    const adapter=configured(fetcher), pdf=await contractPdf(['Non-binding sample. Registered clause.']);
    expect(await adapter.create({contractId:'contract',...pdf,signers})).toBe('envelope');
    expect(fetcher.mock.calls[0]![0]).toBe('https://signing.example.test/api/v2/envelope/create');
    const init=fetcher.mock.calls[0]![1] as RequestInit, form=init.body as FormData;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-api-key');
    expect(JSON.parse(String(form.get('payload')))).toMatchObject({externalId:'contract',type:'DOCUMENT',recipients:[{signingOrder:0,accessAuth:['ACCOUNT']},{signingOrder:1,accessAuth:['ACCOUNT']}],meta:{signingOrder:'SEQUENTIAL',distributionMethod:'NONE'}});
    expect((form.get('files') as Blob).type).toBe('application/pdf');
  });
  it('rejects forged/non-completion webhooks before provider IO',()=>{
    const fetcher=vi.fn(),adapter=configured(fetcher);
    expect(()=>adapter.verifyWebhook('wrong',event)).toThrow('authentication failed');
    expect(()=>adapter.verifyWebhook(secret,{...event,event:'DOCUMENT_SIGNED'})).toThrow('completion event');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reconciles a known envelope only when its reference, signers and original PDF match',async()=>{
    const pdf=await contractPdf(['The immutable uploaded contract.']);
    const record={...envelope(),status:'PENDING'};
    const fetcher=vi.fn(async(url:string|URL|Request)=>String(url).includes('/download')?new Response(new Uint8Array(pdf.pdf)):Response.json(record));
    const adapter=configured(fetcher);
    await expect(adapter.reconcile({contractId:'contract',envelopeId:'envelope',signers,pdf:pdf.pdf})).resolves.toBe('PENDING');
    expect(fetcher.mock.calls.map(c=>String(c[0]))).toContain('https://signing.example.test/api/v2/envelope/item/item/download?version=original');
    expect(fetcher.mock.calls.every(c=>!String(c[0]).endsWith('/create'))).toBe(true);
  });
  it.each(['reference','signer','document'] as const)('refuses reconciliation with a different %s',async mismatch=>{
    const pdf=await contractPdf(['Original immutable document.']);
    const record={...envelope(),status:'PENDING'};
    if(mismatch==='reference')record.externalId='another-contract';
    if(mismatch==='signer')record.recipients[1]!.email='another@example.test';
    const fetcher=vi.fn(async(url:string|URL|Request)=>String(url).includes('/download')?new Response(mismatch==='document'?'%PDF-another-document':new Uint8Array(pdf.pdf)):Response.json(record));
    await expect(configured(fetcher).reconcile({contractId:'contract',envelopeId:'envelope',signers,pdf:pdf.pdf})).rejects.toMatchObject({code:'invalid_completion'});
  });
  it.each(['unsigned-company','wrong-signer','unauthenticated'] as const)('refuses %s and downloads no final artifacts',async scenario=>{
    const record=envelope();
    if(scenario==='unsigned-company')record.recipients[1]!.signingStatus='NOT_SIGNED';
    if(scenario==='wrong-signer')record.recipients[1]!.email='other@example.test';
    if(scenario==='unauthenticated')record.recipients[1]!.authOptions.accessAuth=[];
    const fetcher=vi.fn(async()=>Response.json(record)),adapter=configured(fetcher);
    await expect(adapter.completed(adapter.verifyWebhook(secret,event),{contractId:'contract',envelopeId:'envelope',signers})).rejects.toMatchObject({code:'invalid_completion'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('obtains sealed PDF and audit certificate only after verified countersignature',async()=>{
    const pdf=await contractPdf(['Final sealed fixture']);
    const fetcher=vi.fn(async(url: string | URL | Request)=>String(url).includes('download')?new Response(new Uint8Array(pdf.pdf),{headers:{'Content-Type':'application/pdf'}}):Response.json(envelope()));
    const adapter=configured(fetcher),result=await adapter.completed(adapter.verifyWebhook(secret,event),{contractId:'contract',envelopeId:'envelope',signers});
    expect(result.document).toEqual(pdf.pdf);expect(result.certificate).toEqual(pdf.pdf);
    expect(fetcher.mock.calls.map(c=>String(c[0]))).toContain('https://signing.example.test/api/v2/envelope/item/item/download?version=signed');
  });
});
describe('SPEC-P-006-A — frozen offer merge values',()=>{
  it('takes engagement, pay and exact equity days from the approved offer',()=>{
    const offer={personId:'PER-candidate',terms:{engagementType:'contractor',jurisdiction:'US-DE',pay:{amount:'5000.25',currency:'USD',cadence:'monthly'},equity:{shares:1250,vestingDays:1460,cliffDays:365,startRule:'hire_passed'}}} as HiringOffer;
    expect(offerMergeValues(offer,{issuerTitle:'Company',roleTitle:'Engineer',startDate:'2026-11-01',contractId:'contract'})).toMatchObject({engagement_type:'contractor',pay_amount:'5000.25',pay_currency:'USD',pay_cadence:'monthly',share_amount:'1250',vesting_days:'1460',cliff_days:'365',start_rule:'hire_passed',hire_proposal_ref:'contract'});
  });
  it('paginates long documents and keeps signature fields on a separate last page',async()=>{
    const result=await contractPdf([Array(500).fill('Registered clause.').join('\n')]);
    const pdf=await PDFDocument.load(result.pdf);
    expect(pdf.getPageCount()).toBe(result.lastPage);expect(result.lastPage).toBeGreaterThan(3);
  });
  it('preserves Latin accents, Greek and Cyrillic names and clauses in the actual PDF text',async()=>{
    const clause='Élodie Šimůnek — Σύμβαση συνεργασίας — Договор найма';
    const result=await contractPdf([Array(75).fill(clause).join('\n')]);
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading=getDocument({data:new Uint8Array(result.pdf),useSystemFonts:false,disableFontFace:true});
    const reader=await loading.promise;
    const pages=[];
    for(let n=1;n<=reader.numPages;n++){
      const page=await reader.getPage(n),content=await page.getTextContent();
      pages.push(content.items.map(item=>'str' in item?item.str:'').join(' '));
    }
    const text=pages.join(' ');
    expect(text.split(clause)).toHaveLength(76);
    expect(pages.at(-1)).toBe('Candidate signature and company countersignature');
    await loading.destroy();
  });
  it('refuses unsupported glyphs instead of silently replacing them in the legal document',async()=>{
    await expect(contractPdf(['Signer name: 😀'])).rejects.toMatchObject({code:'invalid_input',message:expect.stringContaining('U+1F600')});
  });
});

/** Single Documenso boundary. Uses the maintained Envelope API v2.
 * Credentials are injected outside the repo; links stay in private HR reads. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const completionField = z.enum(['id', 'externalId', 'status', 'completedAt', 'recipients', 'recipients.email',
  'recipients.name', 'recipients.role', 'recipients.signingStatus', 'recipients.signedAt',
  'recipients.authOptions', 'recipients.authOptions.accessAuth', 'envelopeItems', 'envelopeItems.id']);
/** Fixed categories only: provider values, validation messages and URLs are private. */
export const documensoCompletionDiagnostic = z.object({
  check: z.enum(['event_reference', 'envelope_schema', 'signer_identity', 'sealed_pdf', 'certificate_pdf']),
  providerStatus: z.enum(['DRAFT', 'PENDING', 'COMPLETED']).optional(),
  invalidFields: z.array(completionField).max(14).optional(),
});
export class DocumensoError extends Error {
  readonly completion?: z.infer<typeof documensoCompletionDiagnostic>;
  constructor(readonly code: 'not_configured' | 'provider_refused' | 'invalid_completion' | 'invalid_webhook', message: string,
    completion?: z.infer<typeof documensoCompletionDiagnostic>) {
    super(message); this.name = 'DocumensoError';
    if (completion) this.completion = documensoCompletionDiagnostic.parse(completion);
  }
}
export interface SigningPerson { personId: string; name: string; email: string }
const recipient = z.object({ email: z.string().email(), name: z.string(), role: z.literal('SIGNER'), signingStatus: z.literal('SIGNED'), signedAt: z.string().datetime(),
  authOptions: z.object({ accessAuth: z.array(z.string()).refine(v => v.includes('ACCOUNT')) }) });
const completedEnvelope = z.object({ id: z.string().min(1), externalId: z.string(), status: z.literal('COMPLETED'), completedAt: z.string().datetime(),
  recipients: z.array(recipient).length(2), envelopeItems: z.array(z.object({ id: z.string().min(1) })).length(1) });
const webhook = z.object({ event: z.literal('DOCUMENT_COMPLETED'), createdAt: z.string().datetime(), payload: z.object({ envelopeId: z.string().min(1), externalId: z.string(), status: z.literal('COMPLETED') }) });
function pdfBytes(bytes: Uint8Array, check?: 'sealed_pdf' | 'certificate_pdf') {
  if (bytes.length < 8 || bytes.length > 25_000_000 || Buffer.from(bytes.subarray(0,5)).toString() !== '%PDF-') throw new DocumensoError('invalid_completion', 'Documenso did not return a valid PDF artifact.', check ? { check } : undefined);
  return bytes;
}
export class DocumensoAdapter {
  private readonly base: string;
  constructor(private readonly config: { baseUrl: string; apiKey: string; webhookSecret: string }, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(config.baseUrl);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !config.apiKey || config.webhookSecret.length < 24) throw new DocumensoError('not_configured', 'Configure the self-hosted Documenso URL, API key and webhook secret.');
    this.base = url.href.replace(/\/$/, '') + '/api/v2';
  }
  static configured() {
    const { DOCUMENSO_URL, DOCUMENSO_API_KEY, DOCUMENSO_WEBHOOK_SECRET } = process.env;
    if (!DOCUMENSO_URL || !DOCUMENSO_API_KEY || !DOCUMENSO_WEBHOOK_SECRET) throw new DocumensoError('not_configured', 'Documenso signing is not configured.');
    return new DocumensoAdapter({ baseUrl: DOCUMENSO_URL, apiKey: DOCUMENSO_API_KEY, webhookSecret: DOCUMENSO_WEBHOOK_SECRET });
  }
  private async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Authorization', 'Bearer ' + this.config.apiKey);
    const response = await this.fetcher(this.base + path, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new DocumensoError('provider_refused', 'Documenso refused the signing request (HTTP ' + response.status + ').');
    return response;
  }
  async create(input: { contractId: string; pdf: Uint8Array; lastPage: number; signers: [SigningPerson, SigningPerson] }) {
    if (input.signers[0].email.toLowerCase() === input.signers[1].email.toLowerCase()) throw new DocumensoError('provider_refused', 'The candidate and company must be separate signers.');
    const form = new FormData();
    form.set('payload', JSON.stringify({ title: 'DAO hiring contract ' + input.contractId, type: 'DOCUMENT', externalId: input.contractId,
      recipients: input.signers.map((s,i) => ({ name: s.name, email: s.email, role: 'SIGNER', signingOrder: i, accessAuth: ['ACCOUNT'],
        fields: [{ type: 'SIGNATURE', page: input.lastPage, positionX: 10, positionY: 78 + i*10, width: 40, height: 7 }] })),
      meta: { signingOrder: 'SEQUENTIAL', distributionMethod: 'NONE' } }));
    form.append('files', new Blob([new Uint8Array(pdfBytes(input.pdf))], { type: 'application/pdf' }), 'contract.pdf');
    return z.object({ id: z.string().min(1) }).parse(await (await this.request('/envelope/create', { method: 'POST', body: form })).json()).id;
  }
  async distribute(envelopeId: string) {
    const result = z.object({ id: z.string(), recipients: z.array(z.object({ email: z.string(), signingUrl: z.string().url() })) }).parse(
      await (await this.request('/envelope/distribute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelopeId, meta: { distributionMethod: 'NONE' } }) })).json());
    if (result.id !== envelopeId || result.recipients.length !== 2 || result.recipients.some(r => new URL(r.signingUrl).origin !== new URL(this.config.baseUrl).origin)) throw new DocumensoError('provider_refused', 'Documenso returned another envelope or signing host.');
    return result.recipients;
  }
  /** Recover an ambiguous create by reading the provider, never by creating again.
   * An externalId alone is not proof: verify the frozen signers and uploaded bytes. */
  async reconcile(input: { contractId:string;envelopeId:string;signers:[SigningPerson,SigningPerson];pdf:Uint8Array }) {
    const parsed=z.object({id:z.string(),externalId:z.string(),status:z.enum(['DRAFT','PENDING','COMPLETED']),
      recipients:z.array(z.object({email:z.string().email(),name:z.string(),role:z.literal('SIGNER'),authOptions:z.object({accessAuth:z.array(z.string()).refine(v=>v.includes('ACCOUNT'))})})).length(2),
      envelopeItems:z.array(z.object({id:z.string().min(1)})).length(1)}).safeParse(
        await(await this.request('/envelope/'+encodeURIComponent(input.envelopeId))).json());
    if(!parsed.success)throw new DocumensoError('invalid_completion','The envelope cannot be reconciled with this contract.');
    const record=parsed.data;
    if(record.id!==input.envelopeId||record.externalId!==input.contractId||new Set(record.recipients.map(r=>r.email.toLowerCase())).size!==2||
      input.signers.some(s=>!record.recipients.some(r=>r.email.toLowerCase()===s.email.toLowerCase()&&r.name===s.name)))
      throw new DocumensoError('invalid_completion','The envelope reference or signers differ from the contract.');
    const response=await this.request('/envelope/item/'+encodeURIComponent(record.envelopeItems[0]!.id)+'/download?version=original');
    const original=pdfBytes(new Uint8Array(await response.arrayBuffer()));
    const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest();
    if(!timingSafeEqual(digest(original),digest(input.pdf)))throw new DocumensoError('invalid_completion','The uploaded document differs from the frozen contract.');
    return record.status;
  }
  verifyWebhook(secret: string | null, raw: unknown) {
    const expected = Buffer.from(this.config.webhookSecret), supplied = Buffer.from(secret ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new DocumensoError('invalid_webhook', 'Documenso webhook authentication failed.');
    const parsed = webhook.safeParse(raw);
    if (!parsed.success) throw new DocumensoError('invalid_webhook', 'A Documenso document completion event is required.');
    return parsed.data;
  }
  async completed(event: ReturnType<DocumensoAdapter['verifyWebhook']>, input: { contractId: string; envelopeId: string; signers: [SigningPerson, SigningPerson] }) {
    if (event.payload.envelopeId !== input.envelopeId || event.payload.externalId !== input.contractId) throw new DocumensoError('invalid_completion', 'Completion belongs to another contract.', { check: 'event_reference' });
    const raw = await (await this.request('/envelope/' + encodeURIComponent(input.envelopeId))).json();
    const parsed = completedEnvelope.safeParse(raw);
    if (!parsed.success) {
      const status = documensoCompletionDiagnostic.shape.providerStatus.safeParse(raw?.status);
      const invalidFields = [...new Set(parsed.error.issues.map(issue => issue.path.filter(part => typeof part === 'string').join('.')))]
        .filter((field): field is z.infer<typeof completionField> => completionField.safeParse(field).success);
      throw new DocumensoError('invalid_completion', 'Both authenticated signers must complete and countersign the envelope.',
        { check: 'envelope_schema', ...(status.success && status.data ? { providerStatus: status.data } : {}), invalidFields });
    }
    const record = parsed.data;
    if (record.id !== input.envelopeId || record.externalId !== input.contractId || new Set(record.recipients.map(r => r.email.toLowerCase())).size !== 2 ||
      input.signers.some(s => !record.recipients.some(r => r.email.toLowerCase() === s.email.toLowerCase() && r.name === s.name))) throw new DocumensoError('invalid_completion', 'Documenso signer identities differ from the contract.', { check: 'signer_identity' });
    const [document, certificate] = await Promise.all([
      this.request('/envelope/item/' + encodeURIComponent(record.envelopeItems[0]!.id) + '/download?version=signed'),
      this.request('/envelope/' + encodeURIComponent(input.envelopeId) + '/certificate/download'),
    ]);
    return { document: pdfBytes(new Uint8Array(await document.arrayBuffer()), 'sealed_pdf'), certificate: pdfBytes(new Uint8Array(await certificate.arrayBuffer()), 'certificate_pdf'),
      completedAt: record.completedAt, signers: record.recipients.map(r => ({ email: r.email, name: r.name, signedAt: r.signedAt })), event };
  }
}

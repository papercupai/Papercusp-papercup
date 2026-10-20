/** Real provider proof, separate from the schema-derived simulations.
 * Run through scripts/with-documenso-sandbox.mjs; all accounts, email and
 * signatures belong to that disposable NON-BINDING fixture.
 * This verifies the provider boundary, not the full P012 desktop journey.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { contractPdf } from './contracts-esign';
import { DocumensoAdapter, DocumensoError, documensoCompletionDiagnostic, type SigningPerson } from './documenso';
import { register, authenticatedAccount, accountToken, sign } from '../../../../scripts/fixtures/dao-hr-documenso-ui';

const enabled = Boolean(process.env.DOCUMENSO_TEST_RUNTIME);
const baseUrl = process.env.DOCUMENSO_URL ?? '';
const mailUrl = process.env.DOCUMENSO_TEST_MAIL_URL ?? '';

describe.skipIf(!enabled)('P006 real Documenso sandbox — authenticated sequential signing', () => {
  it('requires both accounts to sign before retrieving the sealed contract and audit certificate', async () => {
    const runtime = JSON.parse(process.env.DOCUMENSO_TEST_RUNTIME!);
    expect(runtime).toMatchObject({ kind: 'documenso-sandbox', isolatedDatabase: true, externalMail: false, testCertificate: true });
    expect(new URL(baseUrl).hostname).toBe('127.0.0.1');
    expect(new URL(mailUrl).hostname).toBe('127.0.0.1');
    expect(runtime.appUrl).toBe(baseUrl);
    const suffix = randomUUID();
    // Exercise the same provider identity labels as the combined native boot.
    const signers: [SigningPerson, SigningPerson] = [
      { personId: 'PER-test-candidate', name: 'Native candidate', email: 'candidate-' + suffix + '@daohr.example.test' },
      { personId: 'PER-test-company', name: 'Native countersigner', email: 'company-' + suffix + '@daohr.example.test' },
    ];
    const browser = await chromium.launch({ headless: true });
    const contexts: BrowserContext[] = [];
    try {
      const candidate = await register(browser, signers[0]); contexts.push(candidate.context);
      const company = await register(browser, signers[1]); contexts.push(company.context);
      await authenticatedAccount(company.page, signers[1].email);
      const secret = randomBytes(32).toString('hex');
      const adapter = new DocumensoAdapter({ baseUrl, apiKey: await accountToken(company.page), webhookSecret: secret });
      const contractId = 'daohr-nonbinding-' + suffix;
      // Native contracts combine several documents. Keep the final signature
      // page beyond the provider virtualizer's five-page overscan for BOTH
      // sequential signers. Five total pages can mount without scrolling and
      // conceal a Next Field click lost before the PDF viewer is ready.
      const pdf = await contractPdf(Array.from({ length: 12 }, (_, index) =>
        'NON-BINDING SANDBOX TEST document ' + (index + 1) + '. No employment, membership, shares or legal obligations are created.'));
      expect(pdf.lastPage).toBe(13);
      const envelopeId = await adapter.create({ contractId, ...pdf, signers });
      const links = await adapter.distribute(envelopeId);
      expect(await adapter.reconcile({ contractId, envelopeId, signers, pdf: pdf.pdf })).toBe('PENDING');
      const event = adapter.verifyWebhook(secret, { event: 'DOCUMENT_COMPLETED', createdAt: new Date().toISOString(),
        payload: { envelopeId, externalId: contractId, status: 'COMPLETED' } });
      await expect(adapter.completed(event, { contractId, envelopeId, signers })).rejects.toMatchObject({ code: 'invalid_completion' });
      await authenticatedAccount(candidate.page, signers[0].email);
      // Native bootstrap saves the provider sessions before the desktop boots.
      // Exercise the same fresh-context boundary instead of reusing signup tabs
      // with an already populated document-viewer cache.
      const candidateSigning = await browser.newContext({ storageState: await candidate.context.storageState() });
      const companySigning = await browser.newContext({ storageState: await company.context.storageState() });
      contexts.push(candidateSigning, companySigning);
      await candidate.context.close();
      await company.context.close();
      await sign(await candidateSigning.newPage(), links.find(link => link.email === signers[0].email)!.signingUrl);
      await expect(adapter.completed(event, { contractId, envelopeId, signers })).rejects.toMatchObject({ code: 'invalid_completion' });
      await sign(await companySigning.newPage(), links.find(link => link.email === signers[1].email)!.signingUrl);
      const completed = async (stage: 'after_second_sign' | 'after_finalization') => {
        try {
          const result = await adapter.completed(event, { contractId, envelopeId, signers });
          console.info('[documenso-completion] ' + JSON.stringify({ stage, ok: true }));
          return result;
        } catch (error) {
          const completion = documensoCompletionDiagnostic.safeParse(error instanceof DocumensoError ? error.completion : undefined);
          // Fixed categories only; never log provider bodies, signer identities, tokens or signing URLs.
          console.info('[documenso-completion] ' + JSON.stringify({ stage, ok: false,
            error: error instanceof DocumensoError ? error.code : 'unexpected_error',
            ...(completion.success ? { completion: completion.data } : {}) }));
          throw error;
        }
      };
      // The signing UI can finish before provider finalization. Observe this boundary,
      // then retain the existing finalization poll and strict artifact assertions.
      await completed('after_second_sign').catch(error => {
        expect(error).toMatchObject({ code: 'invalid_completion' });
      });
      await expect.poll(() => adapter.reconcile({ contractId, envelopeId, signers, pdf: pdf.pdf }), { timeout: 30_000 }).toBe('COMPLETED');
      const result = await completed('after_finalization');
      expect(result.signers.map(signer => signer.email).sort()).toEqual(signers.map(signer => signer.email).sort());
      expect(Buffer.from(result.document.subarray(0, 5)).toString()).toBe('%PDF-');
      expect(Buffer.from(result.certificate.subarray(0, 5)).toString()).toBe('%PDF-');
      expect(Buffer.from(result.document).equals(Buffer.from(pdf.pdf))).toBe(false);
      expect(result.document.length).toBeGreaterThan(pdf.pdf.length);
    } finally {
      for (const context of contexts) await context.close();
      await browser.close();
    }
  }, 240_000);
});

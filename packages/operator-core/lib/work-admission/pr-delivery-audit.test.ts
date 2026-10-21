import { describe, expect, it } from 'vitest';
import { auditPrDelivery, inspectPrDeliveryRow, prDeliveryAuditScopeSchema } from './pr-delivery-audit';

const rule = '57f548d3-f246-41b0-8888-24992ba725ef';
const row = { id: 'EI-1', harness: 'subject', ruleId: rule, state: 'wip', authority: null, payload: {} };

describe('PR-delivery cohort evidence', () => {
  const projects = async () => [];
  it('does not pass an empty or missing-rule population', async () => {
    for (const missingRuleIds of [[], [rule]]) {
      const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
        population: async () => ({ rows: [], total: 0, missingRuleIds }) });
      expect(result.verdict).toBe('unknown');
    }
  });
  it('does not infer a complete cohort from a bounded page', async () => {
    const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
      population: async () => ({ rows: [row], total: 101, missingRuleIds: [] }) });
    expect(result).toMatchObject({ verdict: 'unknown', complete: false, population: 101, pending: 1 });
  });
  it('marks unresolved work-item identities unknown rather than pending', async () => {
    const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
      population: async () => ({ rows: [{ ...row, state: null as unknown as string }], total: 1, missingRuleIds: [] }) });
    expect(result.verdict).toBe('unknown');
  });
  it('distinguishes pending work from an uncommitted terminal completion', async () => {
    expect(await inspectPrDeliveryRow(row, undefined, { host: null })).toMatchObject({ verdict: 'pending' });
    expect(await inspectPrDeliveryRow({ ...row, state: 'done' }, undefined, { host: null }))
      .toMatchObject({ verdict: 'unknown', reason: 'The fix completion is not committed.' });
  });
  it('requires explicit canonical rule identities', () => {
    expect(prDeliveryAuditScopeSchema.safeParse({ ruleIds: [] }).success).toBe(false);
    expect(prDeliveryAuditScopeSchema.safeParse({ ruleIds: ['guess'] }).success).toBe(false);
  });
  it('judges a superproject-closed receipt inside its submodule-hosted pot repository (WI-6554700010018378)', async () => {
    const blob = 'b'.repeat(40);
    const settlementManifest = { version: 1, generation: 1, evidenceHash: 'e'.repeat(64),
      repositoryRoot: '/w/canonical', headSha: 'a'.repeat(40), normalizedPaths: ['apps/drill/src/quote.ts'],
      contentIdentity: [{ path: 'apps/drill/src/quote.ts', workingTreeBlobSha: blob, headBlobSha: blob }] };
    const done = { ...row, state: 'done', authority: 'committed', payload: { _completionEvidence: { settlementManifest } } };
    const project = { slug: 'subject', path: '/w/canonical/apps/drill', github_remote: 'https://github.com/o/drill.git' };
    const calls: string[][] = [];
    const git = async (_root: string, args: string[]) => {
      calls.push(args);
      if (args.includes('--show-toplevel')) return { code: 0, stdout: '/w/canonical/apps/drill' };
      if (args.includes('--show-superproject-working-tree')) return { code: 0, stdout: '/w/canonical' };
      return { code: 2, stdout: '' };
    };
    const verdict = await inspectPrDeliveryRow(done, project as never, { git, host: null });
    // Past the receipt gate: the next question is the upstream heads, read in the pot repo.
    expect(verdict).toMatchObject({ verdict: 'unknown', reason: 'Fresh upstream heads are unavailable.' });
    expect(calls.some(a => a[0] === 'ls-remote')).toBe(true);
    // A plain subdirectory of the superproject is still a cross-repository receipt.
    const plain = async (_root: string, args: string[]) => ({ code: 0,
      stdout: args.includes('--show-toplevel') ? '/w/canonical' : '' });
    expect(await inspectPrDeliveryRow(done, project as never, { git: plain, host: null }))
      .toMatchObject({ verdict: 'unknown', reason: 'Incomplete or cross-repository completion content receipt.' });
  });
  it('does not accept a terminal assertion without a content receipt', async () => {
    const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
      population: async () => ({ rows: [{ ...row, state: 'done', authority: 'committed' }], total: 1, missingRuleIds: [] }) });
    expect(result.verdict).toBe('unknown');
    expect(result.rows[0]?.reason).toBe('No valid completion content receipt.');
  });
});

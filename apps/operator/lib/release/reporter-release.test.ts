import { describe, expect, it } from 'vitest';
import { sealImplementationAcceptance, createImplementationReadiness } from '@papercusp/operator-core/lib/harness/improvements/agent-review-policy';
import { publishReporterRelease, type ReporterReleaseDeps } from './reporter-release';
import type { ReleaseRow } from './release-registry';

const source = { kind: 'bug', title: 'Parser loses tokens', summary: 'Bounded parser drops its trailing token.' };
const accepted = sealImplementationAcceptance({ source,
  proposal: { problem: source.summary, evidence: ['fixture fails'], outcome: 'All tokens survive', scope: 'Parser only', completionCheck: 'Fixture passes' },
  authority: { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-filer', round: 1 }, reason: 'reproduced', acceptedAt: '2026-10-07T00:00:00Z',
  reproduction: { kind: 'failing-test', ref: 'parser.test.ts', buildSha: 'abcdef1' },
});
if (!accepted.ok) throw new Error(JSON.stringify(accepted));
const fixBlob = 'b'.repeat(40);
const item = { ...source, id: 'EI-REPORT', harness: 'papercusp', status: 'done', completionRef: 'close1', authority: 'committed', payload: {
  reporter: { kind: 'end-user' },
  implementationReadiness: createImplementationReadiness({ status: 'ready', source: 'agent-review', reason: 'reviewed', updatedAt: '2026-10-07T00:00:00Z', evidence: { acceptance: accepted.contract } }),
  _completionEvidence: { settlementManifest: { repositoryRoot: '/repo', contentIdentity: [{ path: 'src/parser.ts', headBlobSha: fixBlob, workingTreeBlobSha: fixBlob }] } },
} };
const release: ReleaseRow = { version: '0.0.25', channel: 'alpha', cutAt: new Date(), publishedAt: new Date('2026-10-07T04:00:00Z'),
  changelogMd: null, workItemIds: [item.id], planSlugs: [], artifacts: [], gitSha: 'a'.repeat(40), cutBy: null, notes: null };
function fixture(overrides: Partial<ReporterReleaseDeps> = {}) {
  const stamps: unknown[] = [];
  const deps: ReporterReleaseDeps = { repositoryRoot: '/repo', readItems: async () => [item],
    readBlobs: async () => new Map([['src/parser.ts', { status: 'resolved', sha: fixBlob }]]),
    stamp: async (_item, receipt) => { stamps.push(receipt); return true; }, ...overrides };
  return { deps, stamps };
}
describe('SPEC-P-016 release notification requires published exact fix bytes', () => {
  it('stamps the reporter version only after publication and exact content proof', async () => {
    const { deps, stamps } = fixture();
    expect(await publishReporterRelease(release, deps)).toEqual({ notified: [item.id], unconfirmed: [] });
    expect(stamps).toMatchObject([{ version: '0.0.25', artifactCommit: release.gitSha, completionRef: 'close1', contentIdentity: [{ path: 'src/parser.ts', blobSha: fixBlob }] }]);
  });
  it('an unpublished cut or a changelog inclusion alone sends no fixed notification', async () => {
    const { deps, stamps } = fixture();
    expect(await publishReporterRelease({ ...release, publishedAt: null }, deps)).toEqual({ notified: [], unconfirmed: [] });
    expect(await publishReporterRelease({ ...release, gitSha: null }, deps)).toEqual({ notified: [], unconfirmed: [] });
    expect(stamps).toEqual([]);
  });
  it('a reverted artifact, failed lookup, or a different checkout never claims the fix shipped', async () => {
    for (const readBlobs of [async () => new Map([['src/parser.ts', { status: 'resolved', sha: 'c'.repeat(40) }]]), async () => undefined]) {
      const { deps, stamps } = fixture({ readBlobs });
      expect(await publishReporterRelease(release, deps)).toEqual({ notified: [], unconfirmed: [item.id] });
      expect(stamps).toEqual([]);
    }
    const wrongRoot = fixture({ repositoryRoot: '/other-repo' });
    expect(await publishReporterRelease(release, wrongRoot.deps)).toEqual({ notified: [], unconfirmed: [item.id] });
  });
  it('a retry does not duplicate the version receipt; a reopened report cannot inherit it', async () => {
    const { deps, stamps } = fixture();
    await publishReporterRelease(release, deps);
    const receipt = stamps[0];
    const retry = fixture({ readItems: async () => [{ ...item, payload: { ...item.payload, reporterRelease: receipt } }] });
    expect(await publishReporterRelease(release, retry.deps)).toEqual({ notified: [], unconfirmed: [] });
    expect(retry.stamps).toEqual([]);
    const reopened = fixture({ readItems: async () => [{ ...item, status: 'open' }] });
    expect(await publishReporterRelease(release, reopened.deps)).toEqual({ notified: [], unconfirmed: [] });
    expect(reopened.stamps).toEqual([]);
  });
});

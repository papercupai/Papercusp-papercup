import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { frontmatterDocuments, parseDocumentsField } from './subject-ref';
import { createPublicManualSource, getPublicManual } from '../../agent-tools/docs/_public-manual';

const fixture = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  repoRoot: '',
  manualRoot: '',
  changed: 'packages/operator-core/lib/auth/hosted/self-signup.ts',
  stewardEnabled: true,
  launch: vi.fn(async () => undefined),
  notify: vi.fn(async () => undefined),
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => fixture.stewardEnabled }));
// Keep dispatch observable without spawning an agent or spending model tokens.
vi.mock('../../blueprint/launch-blueprint', () => ({ fireLaunchBlueprintForEvent: fixture.launch }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: fixture.notify }));
vi.mock('../workspace-for-harness', () => ({
  resolveWorkspaceForHarness: async (_slug: string, workspaceId: string) => workspaceId,
}));
vi.mock('./harness-repo', () => ({
  resolveHarnessDocPaths: async () => ({
    repoRoot: fixture.repoRoot,
    docsRoot: join(fixture.repoRoot, 'docs'),
    sources: { manual: fixture.manualRoot },
  }),
}));
// Git supplies a controlled source-change signal; the sweep, Postgres writes,
// dispatch policy, canonical-file handoff and public reader are real code.
vi.mock('./git-runner', async (original) => ({
  ...(await original<typeof import('./git-runner')>()),
  listSubmodulePaths: async () => [],
  repoChangedPathPairs: async () => [{ path: fixture.changed }],
  runGit: async (args: string[]) => ({
    code: 0,
    stdout: args.includes(fixture.changed) ? `${'b'.repeat(40)}\n${fixture.changed}\n` : '',
    stderr: '',
  }),
}));

const records = await import('./doc-record');
const { runDocFreshnessSweepAfterSync } = await import('./sweep-after-sync');
const WORKSPACE = 'ws-public-manual-freshness';
const HARNESS = 'public-manual-freshness';
const BASELINE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const pages = ['faq', 'quickstart', 'harness-templates'];
const REVIEW_HEADING = 'Review fixture revision';
// Public reads return rendered Markdown; plain text survives renderer escaping.
const REVIEW_CANARY = 'Revised public manual review canary';
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
  fixture.repoRoot = await mkdtemp(join(tmpdir(), 'public-manual-freshness-'));
  fixture.manualRoot = join(fixture.repoRoot, 'apps/papercusp-docs/src/content/docs');
  await mkdir(fixture.manualRoot, { recursive: true });
}, 60_000);

afterAll(async () => {
  try { await db?.cleanup(); }
  finally { if (fixture.repoRoot) await rm(fixture.repoRoot, { recursive: true, force: true }); }
});

beforeEach(async () => {
  fixture.launch.mockClear();
  fixture.notify.mockClear();
  fixture.stewardEnabled = true;
  await db.adminSql`DELETE FROM harness_shared.harness_docs`;
  for (const page of pages) {
    const canonical = resolve(import.meta.dirname, '../../../../../apps/papercusp-docs/src/content/docs', `${page}.mdx`);
    const body = await readFile(canonical, 'utf8');
    await writeFile(join(fixture.manualRoot, `${page}.mdx`), body);
    const subjects = parseDocumentsField(frontmatterDocuments(body));
    const anchors = subjects.flatMap((subject) => subject.kind === 'path' ? subject.globs : []);
    await records.upsertDocRecord({
      harnessSlug: HARNESS, workspaceId: WORKSPACE, docId: `manual/${page}.mdx`,
      source: 'manual', subjectRef: subjects, anchorPaths: anchors,
      lastVerifiedSha: BASELINE, status: 'fresh',
    });
  }
});

async function sweep() {
  return runDocFreshnessSweepAfterSync({
    harnessSlug: HARNESS, workspaceId: WORKSPACE, repoRoot: fixture.repoRoot,
    prevSha: BASELINE, headSha: HEAD,
  });
}

describe('canonical public manual post-sync review lifecycle', () => {
  it('dispatches FAQ and guide canonical files and keeps refreshed content unapproved', async () => {
    const source = createPublicManualSource(fixture.manualRoot);
    const before = await getPublicManual({ slugs: ['faq'], heading: REVIEW_HEADING }, source);
    expect(before).toHaveProperty('revision');
    expect(before).toMatchObject({ results: [{ slug: 'faq', found: false, error: 'heading_not_found' }] });

    expect(await sweep()).toMatchObject({
      flippedReview: 2, flippedStale: 0,
      reverifyFlagged: expect.arrayContaining(['manual/faq.mdx', 'manual/quickstart.mdx']),
      regenEnqueued: [],
    });
    expect(fixture.launch).toHaveBeenCalledTimes(1);
    const [event, request] = fixture.launch.mock.calls[0] as unknown as [string, { extra: string[] }];
    expect(event).toBe('docs:drift');
    const dispatched = JSON.parse(request.extra[1]).docs;
    expect(dispatched.map((doc: { docId: string }) => doc.docId).sort())
      .toEqual(['manual/faq.mdx', 'manual/quickstart.mdx']);
    for (const doc of dispatched) {
      expect(doc.source).toBe('manual');
      expect(doc.sourceFile).toBe(`apps/papercusp-docs/src/content/docs/${doc.docId.slice('manual/'.length)}`);
      const persisted = await records.getDocRecord(HARNESS, doc.docId, WORKSPACE);
      expect(persisted).toMatchObject({ status: 'review', lastVerifiedSha: BASELINE, reverifyAttempts: 1 });
    }
    expect(await records.getDocRecord(HARNESS, 'manual/harness-templates.mdx', WORKSPACE))
      .toMatchObject({ status: 'fresh', lastVerifiedSha: BASELINE, reverifyAttempts: 0 });

    const faqPath = join(fixture.manualRoot, 'faq.mdx');
    await writeFile(faqPath, `${await readFile(faqPath, 'utf8')}\n## ${REVIEW_HEADING}\n\n${REVIEW_CANARY}\n`);
    const after = await getPublicManual({ slugs: ['faq'], heading: REVIEW_HEADING }, source);
    expect(after).toHaveProperty('revision');
    expect((after as { revision: string }).revision).not.toBe((before as { revision: string }).revision);
    expect(after).toMatchObject({
      results: [{ slug: 'faq', found: true, sliced: true, content: expect.stringContaining(REVIEW_CANARY) }],
    });
    expect(await records.getDocRecord(HARNESS, 'manual/faq.mdx', WORKSPACE))
      .toMatchObject({ status: 'review', lastVerifiedSha: BASELINE });
    await sweep();
    expect(fixture.launch).toHaveBeenCalledTimes(1);
    expect(fixture.notify).toHaveBeenCalledTimes(1);
  });

  it('retains accountable review without spending a dispatch attempt when the steward is disabled', async () => {
    fixture.stewardEnabled = false;
    expect(await sweep()).toMatchObject({ flippedReview: 2, regenEnqueued: [] });
    expect(fixture.launch).not.toHaveBeenCalled();
    for (const page of ['faq', 'quickstart']) {
      expect(await records.getDocRecord(HARNESS, `manual/${page}.mdx`, WORKSPACE))
        .toMatchObject({ status: 'review', lastVerifiedSha: BASELINE, reverifyAttempts: 0 });
    }
  });
});

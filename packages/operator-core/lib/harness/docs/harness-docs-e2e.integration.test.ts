/**
 * harness-docs-e2e.integration.test.ts — the whole server-side harness-docs flow
 * end-to-end against REAL Postgres (migs 172 + 386 + 781) + a REAL fixture git repo, per
 * harness-docs-integration-2026-06-05 (P-011 server half; validates P-004/5/6/7).
 *
 * generated provenance → merged read → git-sync drift sweep (stale/review +
 * enqueue/flag) → augmented overlay surviving regeneration → manual anchor/verify
 * → regenerate enqueue → unanchored "not drift-tracked".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql, repo: '',
  stewardDocs: [] as Array<{ docId: string; sourceFile?: string }>,
}));

// Keep this fixture independent of db-org's generated-schema barrel. The docs flow only
// needs getOrgPg; the bootstrap imported by operator-core also touches generated tables,
// so provide inert table handles without materializing the unrelated schema namespace.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  const generated = new Proxy({}, { get: () => ({}) });
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    generated,
    schemaOf: () => ({ select: {} }),
  };
});
vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: async () => ({ projects: [{ slug: 'demo', path: h.repo }] }),
    // resolveHarnessRepoRoot (harness-repo.ts) resolves the content path through this since the
    // repo-less-hive change (2026-06-19); a normal repo harness ⇒ its own path.
    resolveHarnessContentPath: (
      reg: { projects: Array<{ slug: string; path: string }> },
      slug: string,
    ) => reg.projects.find((p) => p.slug === slug)?.path,
  };
});
// The docs helpers now DERIVE the workspace from the harness (P-002/D-003); this fixture PG
// has no projects/registry table to resolve 'demo'), and the test asserts on harness 'demo'
// regardless of workspace — pin the derive to one constant workspace so every
// (workspace_id, harness_slug) read/write stays self-consistent.
vi.mock('../workspace-for-harness', () => ({
  resolveWorkspaceForHarness: async (_h: string, ws?: string) => ws ?? 'default',
}));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: async () => ({}) }));
vi.mock('./doc-steward-dispatch', () => ({
  dispatchDocStewardForDrift: async (_h: string, _w: string, docs: typeof h.stewardDocs) => {
    h.stewardDocs = docs;
    return [];
  },
}));

const { recordGeneratedDoc } = await import('./provenance');
const { buildMergedDocs } = await import('./merged-read');
const { sweepHarnessDocs } = await import('./freshness-sweep');
const { anchorManualDoc, verifyManualDoc } = await import('./manual-anchor');
const { requestRegeneration } = await import('./regenerate');
const { setDocOverlay, getDocRecord, deleteDocRecord } = await import('./doc-record');
const { ingestHarnessDocs } = await import('./migrate-fs-docs');
const { reconcileAllDocAnchors, runDocFreshnessSweepAfterSync } = await import('./sweep-after-sync');
const { runGit } = await import('./git-runner');

let db: FreshPgDb;
let repo: string;
const shas: Record<string, string> = {};
function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeAll(async () => {
  db = await createFreshPgDb('harness-docs-e2e');
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  // The real harness git runner routes through the spawner sidecar, whose managed
  // child registration needs the task ledger even though this fixture only asserts
  // harness-docs tables.
  await db.sql.unsafe(readMigration('696-task-ledger.sql')).simple();
  await db.sql.unsafe(readMigration('172-harness-docs.sql')).simple();
  // 386 adds the doc-steward retry counters (regen_attempts/reverify_attempts) the
  // sweep's mark/verify/setStatus helpers now write.
  await db.sql.unsafe(readMigration('386-harness-docs-steward-retry-attempts.sql')).simple();
  // The throwaway fixture does not run the framework bootstrap that installs pgvector,
  // while migration 781 declares harness_docs.embedding as vector(768).
  await db.sql`CREATE EXTENSION IF NOT EXISTS vector`;
  // 781 adds the canonical content/frontmatter columns that upsertDocRecord now writes
  // (the metadata-only fixture previously failed with "column content does not exist").
  await db.sql.unsafe(readMigration('781-doc-content-canonical.sql')).simple();
  h.sql = db.sql;

  repo = mkdtempSync(join(tmpdir(), 'docs-e2e-'));
  h.repo = repo;
  git(['init', '-q']);
  git(['config', 'user.email', 't@p.dev']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'docs/features'), { recursive: true });
  mkdirSync(join(repo, 'docs/guides'), { recursive: true });
  writeFileSync(join(repo, 'src/feature1.ts'), 'export function f1() { return 1; }\n');
  writeFileSync(join(repo, 'src/setup.ts'), 'export const setup = 1;\n');
  writeFileSync(join(repo, 'docs/features/F-1.md'), '---\ntitle: Feature 1\n---\n# Feature 1\nGenerated body.\n');
  writeFileSync(join(repo, 'docs/guides/setup.md'), '---\ntitle: Setup\ndocuments: src/setup.ts\n---\n# Setup guide\n');
  writeFileSync(join(repo, 'docs/orphan.md'), '# Orphan\nUnanchored manual doc.\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'c0']);
  shas.c0 = git(['rev-parse', 'HEAD']);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

const deps = () => ({ runGit, repoRoot: repo });

describe('harness-docs full flow', () => {
  it('records generated provenance from HEAD', async () => {
    const res = await recordGeneratedDoc({
      harnessSlug: 'demo',
      docId: 'features/F-1.md',
      documents: ['src/feature1.ts'],
      title: 'Feature 1',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.generatedFromSha).toBe(shas.c0);
    expect(res.record.source).toBe('generated');
    expect(res.record.status).toBe('fresh');
    expect(res.record.anchorPaths).toContain('src/feature1.ts');
  });

  it('normalizes bare .mdx ids and refuses unknown docs before creating a phantom row', async () => {
    const docId = 'guides/generated.mdx';
    const barePath = join(repo, 'docs', docId);
    writeFileSync(barePath, '# Generated\n');

    try {
      const recorded = await recordGeneratedDoc({
        harnessSlug: 'demo',
        docId: './guides/generated',
        documents: ['src/setup.ts'],
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      expect(recorded.record.docId).toBe(docId);
      expect(await getDocRecord('demo', docId)).not.toBeNull();
      expect(await getDocRecord('demo', 'guides/generated')).toBeNull();

      const missing = await recordGeneratedDoc({
        harnessSlug: 'demo',
        docId: 'guides/does-not-exist',
        documents: ['src/setup.ts'],
      });
      expect(missing).toEqual({ ok: false, error: 'unknown_doc' });
      expect(await getDocRecord('demo', 'guides/does-not-exist.mdx')).toBeNull();
      expect(await getDocRecord('demo', 'guides/does-not-exist')).toBeNull();
    } finally {
      await deleteDocRecord('demo', docId);
      rmSync(barePath, { force: true });
    }
  });

  it('merged read shows generated + untracked manual + unanchored', async () => {
    const merged = await buildMergedDocs('demo', { activePath: 'features/F-1.md' });
    expect(merged.ok).toBe(true);
    expect(merged.files).toEqual(['features/F-1.md', 'guides/setup.md', 'orphan.md']);
    const f1 = merged.entries.find((e) => e.docId === 'features/F-1.md')!;
    expect(f1.source).toBe('generated');
    expect(f1.status).toBe('fresh');
    expect(f1.tracked).toBe(true);
    const orphan = merged.entries.find((e) => e.docId === 'orphan.md')!;
    expect(orphan.source).toBe('manual');
    expect(orphan.status).toBe('untracked');
    expect(orphan.tracked).toBe(false);
    expect(merged.content).toContain('Generated body');
  });

  it('anchors + verifies a manual doc from its documents: frontmatter', async () => {
    const res = await anchorManualDoc({ harnessSlug: 'demo', docId: 'guides/setup.md', verify: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.anchored).toBe(true);
    expect(res.subjectRef).toEqual([{ kind: 'path', globs: ['src/setup.ts'] }]);
    expect(res.record.status).toBe('fresh');
    expect(res.record.lastVerifiedSha).toBe(shas.c0);
  });

  it('git-sync sweep flips stale (generated) + review (manual) and enqueues/flags', async () => {
    // Change BOTH anchored sources, commit → c1.
    writeFileSync(join(repo, 'src/feature1.ts'), 'export function f1() { return 2; }\n');
    writeFileSync(join(repo, 'src/setup.ts'), 'export const setup = 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'c1']);
    shas.c1 = git(['rev-parse', 'HEAD']);

    const regen: string[] = [];
    const reverify: string[] = [];
    const r = await sweepHarnessDocs({
      harnessSlug: 'demo',
      ...deps(),
      changedPaths: ['src/feature1.ts', 'src/setup.ts'],
      onRegenNeeded: (d) => { regen.push(d.docId); },
      onReverifyNeeded: (d) => { reverify.push(d.docId); },
    });
    expect(r.regenEnqueued).toContain('features/F-1.md');
    expect(r.reverifyFlagged).toContain('guides/setup.md');
    expect(regen).toContain('features/F-1.md');
    expect(reverify).toContain('guides/setup.md');

    const merged = await buildMergedDocs('demo');
    expect(merged.entries.find((e) => e.docId === 'features/F-1.md')!.status).toBe('stale');
    expect(merged.entries.find((e) => e.docId === 'guides/setup.md')!.status).toBe('review');
  });

  it('augmented overlay survives regeneration', async () => {
    await setDocOverlay('demo', 'features/F-1.md', 'Why: ships the login fast-path.');
    expect((await getDocRecord('demo', 'features/F-1.md'))!.source).toBe('augmented');

    // Documenter regenerates from the NEW head (c1), omitting overlay.
    const res = await recordGeneratedDoc({ harnessSlug: 'demo', docId: 'features/F-1.md', documents: ['src/feature1.ts'] });
    expect(res.ok).toBe(true);
    const merged = await buildMergedDocs('demo', { activePath: 'features/F-1.md' });
    expect(merged.activeEntry!.source).toBe('augmented');
    expect(merged.activeEntry!.overlay).toBe('Why: ships the login fast-path.');
    expect(merged.activeEntry!.generatedFromSha).toBe(shas.c1);
    expect(merged.activeEntry!.status).toBe('fresh'); // regenerated at c1 → fresh again
  });

  it('regenerate enqueues for a generated/augmented doc', async () => {
    // Make it stale again then request regeneration.
    writeFileSync(join(repo, 'src/feature1.ts'), 'export function f1() { return 3; }\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'c2']);
    const res = await requestRegeneration('demo', 'features/F-1.md');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.enqueued).toBe(true);
  });

  it('verify a manual doc re-baselines it to HEAD', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const res = await verifyManualDoc('demo', 'guides/setup.md');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verifiedSha).toBe(head);
    expect((await getDocRecord('demo', 'guides/setup.md'))!.status).toBe('fresh');
  });

  it('ingest (P-010) anchors docs with a declarable subject, leaves the rest record-less', async () => {
    // Drop existing records so ingest starts clean; orphan.md stays unanchored.
    await deleteDocRecord('demo', 'features/F-1.md');
    await deleteDocRecord('demo', 'guides/setup.md');
    const res = await ingestHarnessDocs('demo');
    expect(res.ok).toBe(true);
    // guides/setup.md declares `documents: src/setup.ts` → anchored.
    expect(res.anchored).toContain('guides/setup.md');
    // orphan.md has no subject → left record-less (skipped), still visible as untracked.
    expect(res.skipped).toContain('orphan.md');
    expect(await getDocRecord('demo', 'orphan.md')).toBeNull();
    const merged = await buildMergedDocs('demo');
    expect(merged.entries.find((e) => e.docId === 'guides/setup.md')!.tracked).toBe(true);
    expect(merged.entries.find((e) => e.docId === 'orphan.md')!.status).toBe('untracked');
  });

  it("anchorManualDoc: body-inference EXCLUDES the doc's own path as a self-anchor (EI-6592 self-widening loop)", async () => {
    // No `documents:` frontmatter — falls through to body-inference. The body quotes
    // its OWN path (as a doc legitimately might, e.g. a changelog entry naming the
    // tracking item about itself) alongside a real, DIFFERENT repo file.
    writeFileSync(
      join(repo, 'docs/guides/selfref.md'),
      '# Selfref\nSee `docs/guides/selfref.md` (this doc) and `src/feature1.ts` for details.\n',
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'selfref']);

    const res = await anchorManualDoc({ harnessSlug: 'demo', docId: 'guides/selfref.md' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.anchored).toBe(true);
    const globs = res.subjectRef[0]?.kind === 'path' ? res.subjectRef[0].globs : [];
    // The real OTHER path is inferred...
    expect(globs).toContain('src/feature1.ts');
    // ...but the doc never anchors on ITSELF — the exact mechanism that turned every
    // doc-steward re-verification note quoting the doc's own path into a permanent,
    // monotonically-widening anchor (EI-6592, oddsmith signal-fusion-activation-A-D.md).
    expect(globs).not.toContain('docs/guides/selfref.md');
  });

  // #5 PART B: the periodic FULL reconcile catches a STALE anchor cache that slipped past the git-sync
  // re-anchor-on-change path — it re-derives anchors from CURRENT frontmatter for every anchor-derived doc.
  it('reconcileAllDocAnchors re-derives a STALE anchor cache from current frontmatter (re-anchor-on-change safety net)', async () => {
    // guides/setup.md is anchored to src/setup.ts (its `documents:` frontmatter). Corrupt the STORED
    // anchor cache directly — simulating a cache that drifted from the frontmatter without the doc's FILE
    // changing in a sync tick (so re-anchor-on-change never re-derived it).
    await h.sql`
      UPDATE harness_shared.harness_docs
         SET anchor_paths = ${['src/WRONG-stale-anchor.ts']}::text[]
       WHERE harness_slug = 'demo' AND doc_id = 'guides/setup.md'`;
    const stale = await getDocRecord('demo', 'guides/setup.md');
    expect(stale!.anchorPaths).toEqual(['src/WRONG-stale-anchor.ts']);

    const r = await reconcileAllDocAnchors('demo');
    // Only anchor-derived (manual) docs are scanned; the stale one is reconciled.
    expect(r.scanned).toBeGreaterThanOrEqual(1);
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBe(0);

    // The cache is re-derived back to the CURRENT frontmatter subject (src/setup.ts).
    const fixed = await getDocRecord('demo', 'guides/setup.md');
    expect(fixed!.anchorPaths).toEqual(['src/setup.ts']);
    expect(fixed!.subjectRef).toEqual([{ kind: 'path', globs: ['src/setup.ts'] }]);

    // A second reconcile over the now-clean cache is a no-op (idempotent — safe on a periodic routine).
    const r2 = await reconcileAllDocAnchors('demo');
    expect(r2.reconciled).toBe(0);
    expect(r2.failed).toBe(0);
  });

  it('retires the old tracking row when a doc is moved into an archive directory', async () => {
    mkdirSync(join(repo, 'docs/archive'), { recursive: true });
    writeFileSync(
      join(repo, 'docs/guides/movable.md'),
      '---\ntitle: Movable\ndocuments: src/setup.ts\n---\n# Movable\n',
    );
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add movable doc']);
    await anchorManualDoc({ harnessSlug: 'demo', docId: 'guides/movable.md', verify: true });
    const before = git(['rev-parse', 'HEAD']);

    renameSync(join(repo, 'docs/guides/movable.md'), join(repo, 'docs/archive/movable.md'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'archive movable doc']);
    const after = git(['rev-parse', 'HEAD']);

    const sweep = await runDocFreshnessSweepAfterSync({
      harnessSlug: 'demo',
      workspaceId: 'default',
      repoRoot: repo,
      prevSha: before,
      headSha: after,
    });
    expect(sweep).not.toBeNull();
    expect(await getDocRecord('demo', 'guides/movable.md')).toBeNull();
    expect((await getDocRecord('demo', 'archive/movable.md'))?.status).toBe('fresh');
  });

  it('tracks a public file-authoritative source through actual PG, git-sync review and steward routing without a second body', async () => {
    mkdirSync(join(repo, '.papercusp'), { recursive: true });
    mkdirSync(join(repo, 'manual'), { recursive: true });
    writeFileSync(join(repo, '.papercusp/docs.json'), JSON.stringify({
      root: 'docs', sources: { 'public-manual': 'manual' },
    }));
    const body = '---\ntitle: Public quickstart\ndocuments: src/setup.ts\n---\n# Start a task\n';
    writeFileSync(join(repo, 'manual/quickstart.mdx'), body);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add namespaced public manual']);
    const docId = 'public-manual/quickstart.mdx';
    const anchored = await anchorManualDoc({ harnessSlug: 'demo', docId, verify: true });
    expect(anchored.ok).toBe(true);
    // upsertDocRecord stores COALESCE(content, '') for metadata-only FS rows.
    // HarnessDocRecord itself intentionally does not expose the prose column.
    const storedBody = async () => (await h.sql<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_docs
       WHERE workspace_id = 'default' AND harness_slug = 'demo' AND doc_id = ${docId}
    `)[0]?.content;
    expect(await storedBody()).toBe('');
    expect((await buildMergedDocs('demo', { activePath: docId })).content).toBe(body);
    expect(await anchorManualDoc({ harnessSlug: 'demo', docId, content: '# Duplicate' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('file_authoritative_source') });
    expect(await recordGeneratedDoc({ harnessSlug: 'demo', docId }))
      .toMatchObject({ ok: false, error: expect.stringContaining('file_authoritative_source') });
    const before = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'src/setup.ts'), 'export const setup = 99;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'setup workflow changed']);
    await runDocFreshnessSweepAfterSync({
      harnessSlug: 'demo', workspaceId: 'default', repoRoot: repo,
      prevSha: before, headSha: git(['rev-parse', 'HEAD']),
    });
    expect((await getDocRecord('demo', docId))?.status).toBe('review');
    expect(h.stewardDocs.find((doc) => doc.docId === docId)?.sourceFile).toBe('manual/quickstart.mdx');
    expect(readFileSync(join(repo, 'manual/quickstart.mdx'), 'utf8')).toBe(body);
    expect(await storedBody()).toBe('');
    await verifyManualDoc('demo', docId);
    expect((await getDocRecord('demo', docId))?.status).toBe('fresh');
  });
});

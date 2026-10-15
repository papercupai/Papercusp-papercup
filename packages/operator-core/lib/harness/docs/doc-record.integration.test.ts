/**
 * doc-record.integration.test.ts — the harness_docs record helpers against REAL
 * Postgres (current migrated schema in a throwaway DB), per
 * harness-docs-integration-2026-06-05 (P-002).
 *
 * Proves: upsert insert+conflict; subject_ref jsonb + anchor_paths text[] round-trip;
 * the overlay-survives-regeneration invariant (D-003/P-005) incl. source staying
 * 'augmented'; verifyDoc baseline; setDocStatus; list; regen/reverify flags; delete.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const rec = await import('./doc-record');
const WS = 'ws-docs';
const HARNESS = 'demo';
let db: OrgTestDb;

beforeAll(async () => {
  // EI-25192006009017108: the historical two-migration list omitted canonical
  // content fields required even by metadata-only upserts. The shared template
  // follows the current migration set instead of maintaining another stale list.
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.harness_docs`;
});

describe('upsert + read round-trip', () => {
  it('inserts a manual doc; subject_ref + anchor_paths round-trip', async () => {
    await rec.upsertDocRecord({
      harnessSlug: HARNESS,
      docId: 'guides/intro.md',
      workspaceId: WS,
      source: 'manual',
      subjectRef: [{ kind: 'path', globs: ['src/**'] }, { kind: 'symbol', file: 'src/a.ts', name: 'fn' }],
      anchorPaths: ['src/**', 'src/a.ts'],
      lastVerifiedSha: 'a'.repeat(40),
      status: 'fresh',
      title: 'Intro',
    });
    const got = await rec.getDocRecord(HARNESS, 'guides/intro.md', WS);
    expect(got).not.toBeNull();
    expect(got!.source).toBe('manual');
    expect(got!.subjectRef).toEqual([
      { kind: 'path', globs: ['src/**'] },
      { kind: 'symbol', file: 'src/a.ts', name: 'fn' },
    ]);
    expect(got!.anchorPaths).toEqual(['src/**', 'src/a.ts']);
    expect(got!.lastVerifiedSha).toBe('a'.repeat(40));
    expect(got!.status).toBe('fresh');
    expect(got!.title).toBe('Intro');
  });

  it('upsert insert sets source=generated when given a generated baseline', async () => {
    await rec.upsertDocRecord({
      harnessSlug: HARNESS, docId: 'features/F-1.md', workspaceId: WS,
      source: 'generated', subjectRef: [{ kind: 'feature', ref: 'F-1' }], anchorPaths: ['src/f1.ts'],
      generatedFromSha: 'b'.repeat(40), status: 'fresh',
    });
    const got = await rec.getDocRecord(HARNESS, 'features/F-1.md', WS);
    expect(got!.source).toBe('generated');
    expect(got!.generatedFromSha).toBe('b'.repeat(40));
  });

  it('canonical authored content survives a metadata-only upsert', async () => {
    const docId = 'guides/canonical.md';
    const content = '---\ntitle: Canonical prose\n---\n\n# Durable body\n';
    await rec.upsertDocRecord({
      harnessSlug: HARNESS, docId, workspaceId: WS, source: 'manual',
      subjectRef: [], anchorPaths: [], status: 'fresh', title: 'Original title', content,
    });
    expect(await rec.getAuthoredDocContent(HARNESS, docId, WS)).toBe(content);

    await rec.upsertDocRecord({
      harnessSlug: HARNESS, docId, workspaceId: WS, source: 'manual',
      subjectRef: [{ kind: 'path', globs: ['src/**'] }], anchorPaths: ['src/**'],
      status: 'review', title: 'Reviewed title',
    });
    const updated = await rec.getDocRecord(HARNESS, docId, WS);
    expect(updated!.title).toBe('Reviewed title');
    expect(updated!.status).toBe('review');
    expect(updated!.anchorPaths).toEqual(['src/**']);
    expect(await rec.getAuthoredDocContent(HARNESS, docId, WS)).toBe(content);
  });
});

describe('overlay survives regeneration (D-003/P-005)', () => {
  it('keeps overlay + augmented source across a generated re-upsert, refreshes baseline', async () => {
    // Generated doc.
    await rec.upsertDocRecord({
      harnessSlug: HARNESS, docId: 'features/F-2.md', workspaceId: WS,
      source: 'generated', subjectRef: [{ kind: 'feature', ref: 'F-2' }], anchorPaths: ['src/f2.ts'],
      generatedFromSha: '1'.repeat(40), status: 'fresh',
    });
    // Human adds an overlay → augmented.
    await rec.setDocOverlay(HARNESS, 'features/F-2.md', 'Why: this exists because X.', WS);
    let got = await rec.getDocRecord(HARNESS, 'features/F-2.md', WS);
    expect(got!.source).toBe('augmented');
    expect(got!.overlay).toBe('Why: this exists because X.');

    // Documenter REGENERATES (new sha, omits overlay) — overlay must survive,
    // source must stay augmented, baseline must advance.
    await rec.upsertDocRecord({
      harnessSlug: HARNESS, docId: 'features/F-2.md', workspaceId: WS,
      source: 'generated', subjectRef: [{ kind: 'feature', ref: 'F-2' }], anchorPaths: ['src/f2.ts'],
      generatedFromSha: '2'.repeat(40), status: 'fresh',
    });
    got = await rec.getDocRecord(HARNESS, 'features/F-2.md', WS);
    expect(got!.overlay).toBe('Why: this exists because X.');
    expect(got!.source).toBe('augmented');
    expect(got!.generatedFromSha).toBe('2'.repeat(40));

    // Clearing the overlay reverts source to generated (it has a generated baseline).
    await rec.setDocOverlay(HARNESS, 'features/F-2.md', null, WS);
    got = await rec.getDocRecord(HARNESS, 'features/F-2.md', WS);
    expect(got!.overlay).toBeNull();
    expect(got!.source).toBe('generated');
  });
});

describe('verify + status + flags', () => {
  it('verifyDoc stamps baseline + flips to fresh', async () => {
    await rec.upsertDocRecord({
      harnessSlug: HARNESS, docId: 'm.md', workspaceId: WS, source: 'manual',
      subjectRef: [{ kind: 'path', globs: ['x'] }], anchorPaths: ['x'], status: 'review',
    });
    await rec.verifyDoc(HARNESS, 'm.md', 'c'.repeat(40), WS);
    const got = await rec.getDocRecord(HARNESS, 'm.md', WS);
    expect(got!.status).toBe('fresh');
    expect(got!.lastVerifiedSha).toBe('c'.repeat(40));
    expect(got!.lastVerifiedAt).not.toBeNull();
  });

  it('setDocStatus + regen/reverify flags persist', async () => {
    await rec.upsertDocRecord({
      harnessSlug: HARNESS, docId: 'g.md', workspaceId: WS, source: 'generated',
      subjectRef: [{ kind: 'path', globs: ['y'] }], anchorPaths: ['y'],
      generatedFromSha: 'd'.repeat(40), status: 'fresh',
    });
    await rec.setDocStatus(HARNESS, 'g.md', 'stale', 'src/y.ts changed', WS);
    await rec.markRegenEnqueued(HARNESS, 'g.md', WS);
    const got = await rec.getDocRecord(HARNESS, 'g.md', WS);
    expect(got!.status).toBe('stale');
    expect(got!.statusDetail).toBe('src/y.ts changed');
    expect(got!.regenEnqueuedAt).not.toBeNull();

    await rec.markReverifyFlagged(HARNESS, 'g.md', WS);
    expect((await rec.getDocRecord(HARNESS, 'g.md', WS))!.reverifyFlaggedAt).not.toBeNull();
  });
});

describe('list + delete', () => {
  it('lists all docs for a harness keyed by doc_id', async () => {
    await rec.upsertDocRecord({ harnessSlug: HARNESS, docId: 'a.md', workspaceId: WS, source: 'manual', subjectRef: [], anchorPaths: [], status: 'untracked' });
    await rec.upsertDocRecord({ harnessSlug: HARNESS, docId: 'b.md', workspaceId: WS, source: 'manual', subjectRef: [], anchorPaths: [], status: 'untracked' });
    const map = await rec.listDocRecords(HARNESS, WS);
    expect([...map.keys()].sort()).toEqual(['a.md', 'b.md']);
  });

  it('deletes a doc record', async () => {
    await rec.upsertDocRecord({ harnessSlug: HARNESS, docId: 'z.md', workspaceId: WS, source: 'manual', subjectRef: [], anchorPaths: [], status: 'untracked' });
    await rec.deleteDocRecord(HARNESS, 'z.md', WS);
    expect(await rec.getDocRecord(HARNESS, 'z.md', WS)).toBeNull();
  });
});

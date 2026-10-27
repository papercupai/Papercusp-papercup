/** P001 contributing evidence through the real report publisher, indexer and readers.
 * Deterministic embeddings and server-viewer fixtures do not prove production
 * authentication, scheduling, full candidate coverage or index-version freshness.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { assertSearchFieldFreshness } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { getReport, publishReport, retireReport, type ReportViewer } from '../../report-library';
import { indexReport } from '../../search/report-index';
import { PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';
import { createReportSearchSource } from './report-source';

vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => true }));
const query = 'zephyrreportwitness';
const vector = [1, ...Array(767).fill(0)];
const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const embedder = { embed: async () => vector, profileId, mode: 'gemma' };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const population = ['report/lexical', 'report/embedding'];
const completed: string[] = [];
const receipts: unknown[] = [];
let db: OrgTestDb;

beforeAll(async () => { db = await createOrgTestDb({ adminPoolMax: 3 }); }, 180_000);

describe('P001 — report stored fields, index lag and changing visible editions', () => {
  for (const leg of ['lexical', 'embedding'] as const) it(`${leg}: canonical fields, lineage, candidates and visibility`, async () => {
    const workspace = `p001-report-${leg}`;
    const harness = `${workspace}-harness`;
    const author = `${workspace}-author`;
    const peer: ReportViewer = { ownerId: `${workspace}-reader`, potSlug: harness };
    const publish = async (label: string, options: {
      workspaceId?: string; harnessSlug?: string; visibility?: 'owner' | 'pot' | 'workspace'; supersedes?: string;
    } = {}) => {
      const report = await publishReport(db.adminSql, {
        workspaceId: options.workspaceId ?? workspace, title: `${label} report`, summary: 'Canonical summary',
        bodyMd: `${query} ${label} canonical instructions.`, visibility: options.visibility ?? 'workspace',
        supersedes: options.supersedes,
      }, { authorOwnerId: author, harnessSlug: options.harnessSlug ?? harness });
      expect((await indexReport(db.adminSql, report, embedder)).embedded).toBeGreaterThan(0);
      return report;
    };
    let target = await publish('Original');
    const foreign = await publish('Foreign', { workspaceId: `${workspace}-foreign` });
    const otherHarness = await publish('Other harness', { harnessSlug: `${harness}-other` });
    const privateDecoy = await publish('Private decoy', { visibility: 'owner' });
    const run = (viewer = peer, ws = workspace, h = harness, excluded = false) => {
      const source = createReportSearchSource(viewer, { automatic: true, harnessSlugs: [h],
        excludedRefs: excluded ? new Set([`report:${target.reportId}`]) : undefined });
      const params = { sql: db.adminSql, workspaceId: ws, scopeFilter: h, query, limit: 20,
        qVec: JSON.stringify(vector), embeddingProfile: { profileId, legacyMode: 'gemma' } };
      return leg === 'lexical' ? source.lexical(params) : source.embedding!(params);
    };
    // Positive controls show matching decoys are present and searchable with their own authority.
    expect((await run(peer, `${workspace}-foreign`)).map(r => r.row.source_id)).toEqual([foreign.reportId]);
    expect((await run(peer, workspace, `${harness}-other`)).map(r => r.row.source_id)).toEqual([otherHarness.reportId]);
    expect((await run({ ownerId: author }, workspace)).map(r => r.row.source_id)).toContain(privateDecoy.reportId);

    const canonical = async (viewer: ReportViewer, excluded: boolean) => {
      // Read base rows, not the adapter result or its latest-edition subquery.
      const [raw] = await db.adminSql`SELECT *, xmin::text AS revision FROM harness_shared.report_library
        WHERE workspace_id = ${workspace} AND report_id = ${target.reportId}`;
      expect(raw).toBeDefined();
      const lineage = await db.adminSql`SELECT report_id, published_at, retired_at, visibility,
        origin_harness_slug, author_owner_id, xmin::text AS revision FROM harness_shared.report_library
        WHERE workspace_id = ${workspace} AND lineage_id = ${raw.lineage_id} ORDER BY report_id`;
      const chunks = await db.adminSql`SELECT chunk_idx, content, parent_sha, chunk_sha,
        embedding_profile, embedding_mode, xmin::text AS revision FROM harness_shared.text_chunks
        WHERE surface = 'report' AND parent_key = ${[workspace, target.reportId]}::text[] ORDER BY chunk_idx`;
      const fullText = [raw.title, raw.summary || null, raw.body_md].filter(v => v !== null).join('\n');
      return { raw, lineage, chunks, readAtMs: Date.now(),
        epoch: fingerprint({ workspace, harness, viewer, excluded, lineage }),
        values: { excerpt: `${raw.title}\n${leg === 'embedding' ? fullText : raw.body_md}`,
          // PostgreSQL's short ts_headline fragment omits this fixture's final period;
          // excerpt/body equality above still checks the complete canonical punctuation.
          highlight: leg === 'embedding' ? fullText
            : raw.body_md.replace(query, `<mark>${query}</mark>`).replace(/\.$/, ''),
          ts: raw.published_at } };
    };
    async function capture(phase: string, expectedIds: string[], options: {
      viewer?: ReportViewer; excluded?: boolean; staleText?: boolean;
    } = {}) {
      const viewer = options.viewer ?? peer;
      const excluded = options.excluded ?? false;
      const requestStartedAtMs = Date.now();
      const before = await canonical(viewer, excluded);
      const rows = await run(viewer, workspace, harness, excluded);
      const responseAtMs = Date.now();
      const after = await canonical(viewer, excluded);
      expect(after.raw.revision).toBe(before.raw.revision);
      expect(after.epoch).toBe(before.epoch);
      expect(after.chunks).toEqual(before.chunks);
      expect(rows.map(r => r.row.source_id).sort()).toEqual([...expectedIds].sort());
      const returned = rows.find(r => r.row.source_id === target.reportId)?.row;
      const observations = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(b => b.source === 'report').map(boundary => {
        const field = boundary.policy.fieldPath as keyof typeof after.values;
        const value = returned?.[field];
        const input = { returned: { entityRef: `report:${target.reportId}`, fieldPath: field,
          valueFingerprint: fingerprint(value ?? null) }, indexed: null,
          canonical: { entityRef: `report:${target.reportId}`, fieldPath: field,
            valueFingerprint: fingerprint(after.values[field]), authority: boundary.policy.authority,
            authorityEpoch: after.epoch, sourceRevision: String(after.raw.revision), readAtMs: after.readAtMs },
          requestStartedAtMs, responseAtMs };
        const oracle = returned ? assertSearchFieldFreshness(boundary.policy, input) : null;
        if (oracle) {
          const stale = options.staleText && field !== 'ts';
          if (!stale) expect(value, `${leg}/${phase}/${field}`).toEqual(after.values[field]);
          expect(oracle.status).toBe(stale ? 'stale' : 'unknown');
          expect(oracle.action).toBe('degrade');
          expect(oracle.reasons).toContain('index witness unavailable');
          if (stale) expect(oracle.reasons).toContain('canonical: returned value differs');
        }
        return { field, input, oracle };
      });
      receipts.push({ caseId: `report/${leg}`, phase, before, after, rows, expectedIds, observations });
      return after;
    }

    const initial = await capture('published-and-indexed', [target.reportId]);
    // Controlled canonical mutation exposes vector index lag independently of the returned chunk.
    await db.adminSql`UPDATE harness_shared.report_library SET body_md = ${`${query} Revised canonical instructions.`}
      WHERE workspace_id = ${workspace} AND report_id = ${target.reportId}`;
    const changed = await capture('canonical-content-changed-before-reindex', [target.reportId], { staleText: leg === 'embedding' });
    expect(changed.raw.revision).not.toBe(initial.raw.revision);
    expect(changed.chunks).toEqual(initial.chunks);
    const revised = await getReport(db.adminSql, workspace, target.reportId);
    expect(revised).not.toBeNull();
    await indexReport(db.adminSql, revised!, embedder);
    await capture('canonical-content-reindexed', [target.reportId]);
    const added = await publish('Added');
    await capture('candidate-added', [target.reportId, added.reportId]);
    await retireReport(db.adminSql, workspace, added.reportId);
    await capture('candidate-retired', [target.reportId]);
    await capture('audience-excluded', [], { excluded: true });
    await db.adminSql`UPDATE harness_shared.report_library SET visibility = 'owner'
      WHERE workspace_id = ${workspace} AND report_id = ${target.reportId}`;
    expect((await capture('visibility-revoked', [])).epoch).not.toBe(initial.epoch);
    await capture('author-positive-control', [target.reportId, privateDecoy.reportId], { viewer: { ownerId: author } });
    await db.adminSql`UPDATE harness_shared.report_library SET visibility = 'pot'
      WHERE workspace_id = ${workspace} AND report_id = ${target.reportId}`;
    await capture('pot-visibility-restored', [target.reportId]);
    await capture('wrong-pot-refused', [], { viewer: { ownerId: 'unrelated-reader', potSlug: `${harness}-wrong` } });
    const predecessor = target.reportId;
    target = await publish('Private correction', { visibility: 'owner', supersedes: predecessor });
    // A hidden newer edition must never resurrect its older visible predecessor.
    await capture('hidden-newer-edition-no-visible-predecessor', []);
    await capture('newer-edition-author-positive-control', [target.reportId, privateDecoy.reportId], { viewer: { ownerId: author } });
    target = await publish('Public correction', { supersedes: target.reportId });
    await capture('newer-public-edition', [target.reportId]);
    await retireReport(db.adminSql, workspace, target.reportId);
    await capture('latest-retired-hidden-predecessor-still-refused', []);
    completed.push(`report/${leg}`);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_REPORT_SOURCE_WITNESS_FILE) {
      const paths = ['packages/operator-core/lib/agent-tools/search/report-source-freshness.integration.test.ts',
        'packages/operator-core/lib/agent-tools/search/report-source.ts',
        'packages/operator-core/lib/agent-tools/search/knowledge-sources.ts',
        'packages/operator-core/lib/report-library.ts', 'packages/operator-core/lib/search/report-index.ts',
        'packages/operator-core/lib/search/surface-registry.ts'];
      const pins = paths.map(path => ({ path, sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../../${path}`, import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_REPORT_SOURCE_WITNESS_FILE, JSON.stringify({ schemaVersion: 1,
        population, completed, pins, receipts, limits: [
          'Migrated private PostgreSQL and actual publisher/indexer/readers; embeddings and server viewer are controlled fixtures.',
          'Canonical mutation is a fixture control, not a product report-edit API or production ingest measurement.',
          'No trusted index/authorization epoch witness is returned: field currentness remains unknown or explicitly stale.',
          'Production authentication, scheduling, full candidate completeness, other adapters, budgets and acceptance remain open.',
        ] }, null, 2));
      expect([...completed].sort()).toEqual([...population].sort());
    }
  } finally { await db?.cleanup(); }
});

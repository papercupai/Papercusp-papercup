import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocSource } from '@papercusp/docs-engine';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { boundedSource, createDocSearchSource, createPlanSearchSource } from './knowledge-sources';
import { runFullTextSearch } from '@papercusp/search';
import { applyMigrationForTest } from '../../../test/_pg-helpers';
import { existsSync } from 'node:fs';
import { splitDocSections,syncDocSourceSections } from '../../search/doc-embed-sync';
import { runChunkSyncTick } from '../../search/chunks/tick';
import { PLANS_CHUNK_SURFACE } from '../../search/chunks/registry';

const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const vec = (match: boolean) => JSON.stringify([1, match ? 10 : 0, ...Array(766).fill(0)]);

describe('complete knowledge sections against canonical PostgreSQL', () => {
  let db: OrgTestDb;
  const workspaceId = `knowledge-${process.pid}-${Date.now()}`;
  const otherWorkspace = `${workspaceId}-other`;
  const params = () => ({ sql: db.adminSql, workspaceId, query: 'zephyrquartz', scopeFilter: null,
    limit: 1, qVec: vec(true), embeddingProfile: { profileId, legacyMode: 'gemma' } });
  beforeAll(async () => {
    db = await createOrgTestDb({ adminPoolMax: 3 });
    const armed = new URL('../../../../../libs/papercusp/libs/db/sql/1431-doc-section-order.sql',import.meta.url);
    const draft = new URL(`${armed.href}.DRAFT`);
    const lexicalIndex = new URL('../../../../../libs/papercusp/libs/db/sql/1531-doc-sections-lexical-index.sql',import.meta.url);
    const lexicalIndexDraft = new URL(`${lexicalIndex.href}.DRAFT`);
    await applyMigrationForTest(db.adminSql,existsSync(armed) ? armed.pathname : draft.pathname);
    await applyMigrationForTest(db.adminSql,existsSync(lexicalIndex) ? lexicalIndex.pathname : lexicalIndexDraft.pathname);
    await db.adminSql`INSERT INTO harness_shared.harness_registry (workspace_id,payload)
      VALUES (${workspaceId},${db.adminSql.json({ projects: [{ slug: 'pot-a' }, { slug: 'pot-b' }] })}),
        (${otherWorkspace},${db.adminSql.json({ projects: [{ slug: 'foreign-pot' }, { slug: 'foreign-pot-b' }] })})`;
    for (const [ws,harness,slug,content] of [
      [workspaceId,'pot-a','late-plan', 'ordinary filler '.repeat(5_000) + '\n## Late repair\nPrerequisite: retain the snapshot.\nApply zephyrquartz recovery.'],
      [workspaceId,'pot-b','crowding-plan','zephyrquartz '.repeat(20)],
      [otherWorkspace,'pot-a','foreign-plan','zephyrquartz '.repeat(30)],
    ]) {
      await db.adminSql`INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,title,content,status,embedding,embedding_profile,embedding_mode)
        VALUES (${ws},${harness},${slug},'Knowledge plan',${content},'active',${vec(false)}::vector,${profileId},'gemma')`;
    }
    const synced = await runChunkSyncTick({ sql: db.adminSql, surfaces: [{ ...PLANS_CHUNK_SURFACE,
      eligibleSql: `p.workspace_id = '${workspaceId}' AND p.harness_slug = 'pot-a'` }] });
    expect(synced).toHaveProperty('surfaces');
    await db.adminSql`UPDATE harness_shared.text_chunks SET embedding =
      CASE WHEN content LIKE '%zephyrquartz%' THEN ${vec(true)}::vector ELSE ${vec(false)}::vector END,
      embedding_profile = ${profileId}, embedding_mode = 'gemma'
      WHERE surface = 'plans' AND parent_key[1] = ${workspaceId}`;
    const body = Array.from({ length: 300 },(_,i) => `## Procedure ${i}\n${i === 298
      ? 'Prerequisite: retain the snapshot.' : i === 299 ? 'Apply zephyrquartz recovery.' : 'Ordinary guidance.'}`).join('\n');
    for (const [sourceKey,slug,text] of [
      ['harness:pot-a','late-doc',body],
      ['harness:pot-b','crowding-doc','## Wrong scope\nzephyrquartz '.repeat(20)],
      ['harness:foreign-pot','foreign-doc','## Foreign scope\nzephyrquartz '.repeat(30)],
    ]) {
      for (const [idx,section] of splitDocSections('Recovery procedure',text).entries()) {
        await db.adminSql`INSERT INTO harness_shared.doc_sections
          (source_key,slug,anchor,title,url,content,page_sha,section_idx,embedding,embedding_profile,embedding_mode)
          VALUES (${sourceKey},${slug},${section.anchor},${section.title},${`/docs/${slug}`},
            ${section.content},'fixture',${idx},${vec(section.content.includes('zephyrquartz'))}::vector,${profileId},'gemma')`;
      }
    }
  },180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('retrieves a plan body beyond the old 32-window cap with its heading and prerequisite', async () => {
    const source = createPlanSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    for (const [leg,query] of [[source.lexical!,'zephyrquartz'],[source.embedding!,'restore diagnostic state']] as const) {
      const rows = await leg({ ...params(),query });
      expect(rows.map(r=>r.row.source_id)).toEqual(['pot-a:late-plan']);
      expect(rows[0].row.excerpt).toContain('retain the snapshot');
      expect(rows[0].row.excerpt).toContain('zephyrquartz');
      expect(rows[0].row.meta?.section).toBe('Late repair');
    }
  });

  it('searches a plan title through the public handler and isolates its harness', async () => {
    const token = 'fulltexttitle' + process.pid + 'x' + Date.now();
    for (const [harness,slug] of [['foreign-pot','public-title-a'],['foreign-pot-b','public-title-b']] as const) {
      await db.adminSql`INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,title,content,status,embedding,embedding_profile,embedding_mode)
        VALUES (${otherWorkspace},${harness},${slug},${token + '-' + harness},
          'unrelated body','active',${vec(false)}::vector,${profileId},'gemma')`;
    }
    vi.doMock('./rerank', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./rerank')>();
      return {
        ...actual,
        rerankPageHead: async (
          _query: Parameters<typeof actual.rerankPageHead>[0],
          rows: Parameters<typeof actual.rerankPageHead>[1],
          limit: Parameters<typeof actual.rerankPageHead>[2],
        ) => rows.slice(0, limit),
      };
    });
    try {
      const { default: fulltext } = await import('./fulltext');
      const context = () => ({
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        signal: new AbortController().signal,
        progress: vi.fn(),
        workspaceId: otherWorkspace,
        harnessSlug: 'foreign-pot',
        role: 'operator' as const,
        tx: db.adminSql,
        principal: { slug: 'integration-test' },
        metadata: vi.fn(),
      } as never);
      const response: any = await fulltext.handler(
        { query: token, scope: ['plan'], harness_slug: 'foreign-pot', limit: 5 },
        context(),
      );
      const result = JSON.parse(response.content[0].text);
      expect(result.results.map((row: { source_id: string }) => row.source_id))
        .toEqual(['foreign-pot:public-title-a']);
    } finally {
      vi.doUnmock('./rerank');
    }
  });

  it('returns healthy source results when a sibling SQL leg exceeds its deadline', async () => {
    const stalled = boundedSource({ name: 'stalled',lexical: async p => {
      await p.sql`SELECT pg_sleep(10)`;
      return [];
    } });
    const result = await runFullTextSearch([stalled,createDocSearchSource({ harnessSlugs: ['pot-a'] })],params());
    expect(result.results.map(r=>r.source_id)).toContain('harness:pot-a:late-doc');
    expect(result.legs.lexical.callsFailed).toBe(1);
    expect(result.legs.degraded).toBe(true);
  });

  it('retrieves a deep doc section and excludes foreign/crowding harnesses before the limit', async () => {
    const source = createDocSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    for (const leg of [source.lexical!,source.embedding!]) {
      const rows = await leg(params());
      expect(rows.map(r=>r.row.source_id)).toEqual(['harness:pot-a:late-doc']);
      expect(rows[0].row.excerpt).toContain('retain the snapshot');
      expect(rows[0].row.meta?.section).toBe('procedure-299');
      expect(rows[0].row.meta?.path).toBe('/docs/late-doc#procedure-299');
    }
  });

  it('keeps semantic doc ranking on a bounded nearest-section candidate set', async () => {
    const source = createDocSearchSource({ harnessSlugs: ['pot-a'] });
    const rows = await source.embedding!({ ...params(), limit: 2 });
    expect(rows).toHaveLength(1);
    expect(rows[0].row.source_id).toBe('harness:pot-a:late-doc');
  });

  it('keeps the doc lexical predicate backed by its GIN expression index', async () => {
    const rows = await db.adminSql`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'doc_sections'
         AND indexname = 'doc_sections_lexical_search_idx'`;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].indexdef)).toContain("to_tsvector('english'::regconfig");
    expect(String(rows[0].indexdef)).toContain('USING gin');
  });

  it('recuts a formerly capped plan index and recovers its known tail section', async () => {
    const surface = { ...PLANS_CHUNK_SURFACE,eligibleSql: `p.workspace_id = '${workspaceId}' AND p.harness_slug = 'pot-a'` };
    const embedChunks = () => db.adminSql`UPDATE harness_shared.text_chunks SET embedding =
      CASE WHEN content LIKE '%zephyrquartz%' THEN ${vec(true)}::vector ELSE ${vec(false)}::vector END,
      embedding_profile = ${profileId},embedding_mode = 'gemma'
      WHERE surface = 'plans' AND parent_key[1] = ${workspaceId}`;
    const source = createPlanSearchSource({ harnessSlugs: ['pot-a'] });
    const warn = vi.fn(),error = vi.fn();
    await runChunkSyncTick({ sql: db.adminSql,surfaces: [{ ...surface,completeBody: false }],logger: { warn,error } });
    expect(warn.mock.calls.some(call=>String(call[0]).includes('truncated by maxChunks'))).toBe(true);
    expect(error).not.toHaveBeenCalled();
    await embedChunks();
    const capped = await source.embedding!({ ...params(),query: 'restore diagnostic state' });
    expect(capped[0].row.excerpt).not.toContain('zephyrquartz');
    await runChunkSyncTick({ sql: db.adminSql,surfaces: [surface] });
    await embedChunks();
    const recovered = await source.embedding!({ ...params(),query: 'restore diagnostic state' });
    expect(recovered[0].row.excerpt).toContain('zephyrquartz');
    expect(recovered[0].row.meta?.section).toBe('Late repair');
  });

  it('writes complete ordered doc batches atomically and retains valid rows after a failed refresh', async () => {
    let body = Array.from({ length: 1_300 },(_,i)=>`## Step ${i}\nInstruction ${i}.`).join('\n');
    const page = { slug: 'atomic',slugs: ['atomic'],title: 'Atomic procedure',url: '/docs/atomic',toc: [] };
    const source: DocSource = { name: 'harness:pot-a',listPages: async()=>[page],getPage: async()=>page,
      getContent: async()=>body };
    expect(await syncDocSourceSections(db.adminSql,source,{ prune: false })).toMatchObject({ sections: 1_300,errors: 0 });
    const count = async()=> (await db.adminSql`SELECT count(*)::int AS n,max(section_idx) AS last
      FROM harness_shared.doc_sections WHERE source_key = 'harness:pot-a' AND slug = 'atomic'`)[0];
    expect(await count()).toMatchObject({ n: 1_300,last: 1_299 });
    await db.adminSql`ALTER TABLE harness_shared.doc_sections ADD CONSTRAINT reject_atomic_fixture
      CHECK (content <> 'forbidden_atomic_text') NOT VALID`;
    body = '## Failure\nforbidden_atomic_text';
    const warning = vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      expect(await syncDocSourceSections(db.adminSql,source,{ prune: false })).toMatchObject({ errors: 1,changed: 0 });
      expect(warning).toHaveBeenCalled();
      expect(await count()).toMatchObject({ n: 1_300,last: 1_299 });
    } finally { warning.mockRestore(); }
    body = '## Repaired\nValid procedure.';
    expect(await syncDocSourceSections(db.adminSql,source,{ prune: false })).toMatchObject({ sections: 1,errors: 0,changed: 1 });
    expect(await count()).toMatchObject({ n: 1,last: 0 });
  });

  it('applies ambient fences and canonical retirement before either ranker', async () => {
    for (const [source,ref] of [
      [createPlanSearchSource,'plan:pot-a:late-plan'],
      [createDocSearchSource,'doc:harness:pot-a:late-doc'],
    ] as const) {
      const fenced = source({ harnessSlugs: ['pot-a'], automatic: true, excludedRefs: new Set([ref]) });
      expect(await fenced.lexical!(params())).toEqual([]);
      expect(await fenced.embedding!(params())).toEqual([]);
    }
    await db.adminSql`UPDATE harness_shared.harness_plans SET superseded_by = 'replacement'
      WHERE workspace_id = ${workspaceId} AND plan_slug = 'late-plan'`;
    const plans = createPlanSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    expect(await plans.lexical!(params())).toEqual([]);
    expect(await plans.embedding!(params())).toEqual([]);
    const historical = createPlanSearchSource({ harnessSlugs: ['pot-a'] });
    for (const leg of [historical.lexical!,historical.embedding!]) {
      const rows = await leg(params());
      expect(rows.map(r=>r.row.source_id)).toEqual(['pot-a:late-plan']);
      expect(rows[0].row.meta?.currentness).toBe('historical');
      expect(rows[0].row.excerpt).toContain('retain the snapshot');
    }
    await db.adminSql`UPDATE harness_shared.harness_plans SET superseded_by = NULL,archived = true
      WHERE workspace_id = ${workspaceId} AND plan_slug = 'late-plan'`;
    expect(await plans.lexical!(params())).toEqual([]);
    expect(await plans.embedding!(params())).toEqual([]);
    expect((await historical.lexical!(params()))[0].row.meta?.currentness).toBe('historical');
    await db.adminSql`INSERT INTO harness_shared.harness_docs
      (workspace_id,harness_slug,doc_id,retired_at) VALUES (${workspaceId},'pot-a','late-doc.mdx',now())`;
    const docs = createDocSearchSource({ harnessSlugs: ['pot-a'], automatic: true });
    expect(await docs.lexical!(params())).toEqual([]);
    expect(await docs.embedding!(params())).toEqual([]);
  });
});

/** P001 contributing evidence through the registered plan SQL readers.
 * Canonical rows and a deliberately lagging chunk index are controlled fixtures.
 * This does not measure the plan authoring path, production sync or authentication.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { assertSearchFieldFreshness } from '@papercusp/search-core';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { createPlanSearchSource, type KnowledgeAudience } from './knowledge-sources';
import { PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';

const query = 'zephyrplanwitness';
const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const qVec = JSON.stringify([1, ...Array(767).fill(0)]);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const population = ['plan/lexical', 'plan/embedding'];
const completed: string[] = [];
const receipts: unknown[] = [];
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('plan-source-freshness');
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      title text NOT NULL, content text NOT NULL, status text NOT NULL DEFAULT 'ready',
      archived boolean NOT NULL DEFAULT false, superseded_by text, template_slug text,
      items jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      embedding vector(768), embedding_mode text, embedding_profile text,
      _search tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || content)) STORED,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.text_chunks (
      surface text NOT NULL, parent_key text[] NOT NULL, chunk_idx integer NOT NULL,
      anchor text, header text, content text NOT NULL, parent_sha text NOT NULL, chunk_sha text NOT NULL,
      splitter_version text NOT NULL, embedding vector(768), embedding_mode text, embedding_profile text,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (surface,parent_key,chunk_idx)
    );
  `);
}, 60_000);

describe('P001 — plan stored fields, chunk lag and changing reader scope', () => {
  for (const leg of ['lexical', 'embedding'] as const) it(`${leg}: canonical values, candidates and lifecycle fences`, async () => {
    const workspace = `p001-plan-${leg}`;
    const harness = `${workspace}-harness`;
    const slug = 'target';
    const id = `${harness}:${slug}`;
    const entityRef = `plan:${id}`;
    const seed = async (key: string, ws = workspace, h = harness) => {
      await db.sql`INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,title,content,items)
        VALUES (${ws},${h},${key},'Canonical plan',${`${query} original canonical tasks`},
          ${db.sql.json([{ id: 'P-001', text: `${query} original item`, status: 'todo' }])})`;
      await reindex(key, ws, h);
    };
    // Explicit fixture backfill: no production sync or embedding claim.
    async function reindex(key: string, ws = workspace, h = harness) {
      const [raw] = await db.sql`SELECT title,content FROM harness_shared.harness_plans
        WHERE workspace_id=${ws} AND harness_slug=${h} AND plan_slug=${key}`;
      await db.sql`INSERT INTO harness_shared.text_chunks
        (surface,parent_key,chunk_idx,header,content,parent_sha,chunk_sha,splitter_version,
         embedding,embedding_mode,embedding_profile)
        VALUES ('plans',${[ws,h,key]}::text[],0,${raw.title},${raw.content},
          ${fingerprint(raw)},${fingerprint(raw.content)},'controlled-p001',${qVec}::vector,'gemma',${profileId})
        ON CONFLICT (surface,parent_key,chunk_idx) DO UPDATE SET content=EXCLUDED.content,
          parent_sha=EXCLUDED.parent_sha,chunk_sha=EXCLUDED.chunk_sha,updated_at=clock_timestamp()`;
    }
    const run = (audience: KnowledgeAudience = { automatic: true }, ws = workspace, h = harness) => {
      const source = createPlanSearchSource(audience);
      const p = { sql: db.sql, workspaceId: ws, scopeFilter: h, query, limit: 20,
        qVec, embeddingProfile: { profileId, legacyMode: 'gemma' } };
      return leg === 'lexical' ? source.lexical(p) : source.embedding!(p);
    };
    await seed(slug);
    await seed('foreign', `${workspace}-foreign`);
    await seed('other-harness', workspace, `${harness}-other`);
    expect((await run({ automatic: true }, `${workspace}-foreign`)).map(r => r.row.source_id))
      .toEqual([`${harness}:foreign`]);
    expect((await run({ automatic: true }, workspace, `${harness}-other`)).map(r => r.row.source_id))
      .toEqual([`${harness}-other:other-harness`]);

    const canonical = async (audience: KnowledgeAudience) => {
      const [raw] = await db.sql`SELECT *,xmin::text AS revision FROM harness_shared.harness_plans
        WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug=${slug}`;
      const chunks = await db.sql`SELECT content,parent_sha,chunk_sha,xmin::text AS revision
        FROM harness_shared.text_chunks WHERE surface='plans' AND parent_key=${[workspace,harness,slug]}::text[]
        ORDER BY chunk_idx`;
      return { raw, chunks, readAtMs: Date.now(), epoch: fingerprint({ workspace,harness,
        audience: { ...audience, excludedRefs: [...(audience.excludedRefs ?? [])] },
        status: raw.status, archived: raw.archived, supersededBy: raw.superseded_by, template: raw.template_slug }) };
    };
    async function capture(phase: string, expectedIds: string[], staleText = false,
      audience: KnowledgeAudience = { automatic: true }) {
      const requestStartedAtMs = Date.now();
      const before = await canonical(audience);
      const rows = await run(audience);
      const responseAtMs = Date.now();
      const after = await canonical(audience);
      expect(after.raw.revision).toBe(before.raw.revision);
      expect(after.epoch).toBe(before.epoch);
      expect(after.chunks).toEqual(before.chunks);
      expect(rows.map(r => r.row.source_id).sort()).toEqual([...expectedIds].sort());
      const returned = rows.find(r => r.row.source_id === id)?.row;
      const values = { excerpt: `${after.raw.title}\n${after.raw.content}`,
        highlight: leg === 'embedding' ? after.raw.content : after.raw.content.replace(query, `<mark>${query}</mark>`),
        ts: after.raw.updated_at };
      const observations = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(b => b.source === 'plan').map(boundary => {
        const field = boundary.policy.fieldPath as keyof typeof values;
        const value = returned?.[field];
        const input = { returned: { entityRef,fieldPath: field,valueFingerprint: fingerprint(value ?? null) },
          indexed: null, canonical: { entityRef,fieldPath: field,valueFingerprint: fingerprint(values[field]),
            authority: boundary.policy.authority,authorityEpoch: after.epoch,
            sourceRevision: String(after.raw.revision),readAtMs: after.readAtMs },requestStartedAtMs,responseAtMs };
        const oracle = returned ? assertSearchFieldFreshness(boundary.policy,input) : null;
        if (oracle) {
          const stale = staleText && field !== 'ts';
          if (!stale) expect(value,`${leg}/${phase}/${field}`).toEqual(values[field]);
          expect(oracle.status).toBe(stale ? 'stale' : 'unknown');
          expect(oracle.action).toBe('degrade');
          expect(oracle.reasons).toContain('index witness unavailable');
          if (stale) expect(oracle.reasons).toContain('canonical: returned value differs');
        }
        return { field,input,oracle };
      });
      receipts.push({ caseId: `plan/${leg}`,phase,before,after,rows,expectedIds,observations });
      return after;
    }
    const initial = await capture('stored-and-indexed',[id]);
    await db.sql`UPDATE harness_shared.harness_plans SET content=${`${query} replacement canonical tasks`},
      updated_at=clock_timestamp() WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug=${slug}`;
    const changed = await capture('canonical-content-changed-before-reindex',[id],leg === 'embedding');
    expect(changed.raw.revision).not.toBe(initial.raw.revision);
    expect(changed.chunks).toEqual(initial.chunks);
    await reindex(slug);
    await capture('canonical-content-reindexed',[id]);
    await seed('added');
    await capture('candidate-added',[id,`${harness}:added`]);
    await db.sql`DELETE FROM harness_shared.harness_plans
      WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug='added'`;
    await capture('candidate-deleted-despite-retained-chunk',[id]);
    await capture('audience-excluded',[],false,{ automatic: true,excludedRefs: new Set([entityRef]) });
    await capture('server-harness-fence',[],false,{ automatic: true,harnessSlugs: [`${harness}-other`] });
    for (const state of ['archived','superseded','template'] as const) {
      await db.sql`UPDATE harness_shared.harness_plans SET archived=${state === 'archived'},
        superseded_by=${state === 'superseded' ? 'successor' : null},template_slug=${state === 'template' ? 'rubric' : null}
        WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug=${slug}`;
      expect((await capture(`${state}-automatic-refusal`,[])).epoch).not.toBe(initial.epoch);
      if (state !== 'template') await capture(`${state}-explicit-historical`,[id],false,{ automatic: false });
    }
    await db.sql`UPDATE harness_shared.harness_plans SET archived=false,superseded_by=NULL,template_slug=NULL,status='draft'
      WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug=${slug}`;
    const draft = await run({ automatic: true,draftItems: true });
    expect(draft.map(r => [r.row.source_id,r.row.excerpt,r.row.highlight]))
      .toEqual([[`${id}#P-001`,`${query} original item`,`${query} original item`]]);
    await db.sql`UPDATE harness_shared.harness_plans SET items=${db.sql.json([
      { id: 'P-002',text: `${query} replacement item`,status: 'todo' }])}
      WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug=${slug}`;
    const revisedDraft = await run({ automatic: true,draftItems: true });
    expect(revisedDraft.map(r => [r.row.source_id,r.row.excerpt])).toEqual([[`${id}#P-002`,`${query} replacement item`]]);
    receipts.push({ caseId: `plan/${leg}`,phase: 'draft-items-replaced',draft,revisedDraft });
    await db.sql`UPDATE harness_shared.harness_plans SET status='ready'
      WHERE workspace_id=${workspace} AND harness_slug=${harness} AND plan_slug=${slug}`;
    expect(await run({ automatic: true,draftItems: true })).toEqual([]);
    completed.push(`plan/${leg}`);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_PLAN_SOURCE_WITNESS_FILE) {
      const paths = ['packages/operator-core/lib/agent-tools/search/plan-source-freshness.integration.test.ts',
        'packages/operator-core/lib/agent-tools/search/knowledge-sources.ts',
        'packages/operator-core/lib/search/chunks/registry.ts','packages/operator-core/lib/search/surface-registry.ts'];
      const pins = paths.map(path => ({ path,sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../../${path}`,import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_PLAN_SOURCE_WITNESS_FILE,JSON.stringify({ schemaVersion: 1,
        population,completed,pins,receipts,limits: [
          'Minimal private PostgreSQL schema and controlled row/chunk mutations; actual registered lexical and vector SQL readers.',
          'No production plan authoring, authentication, sync, embedder, candidate completeness or index-version witness.',
          'Canonical mismatches are stale; matching values remain unknown without an index witness.',
          'Draft item replacement is checked separately; no timestamp or field-currentness claim for draft-item output.',
          'Other adapters, budgets, quality, runtime acceptance and shipment remain open.',
        ] },null,2));
    }
    expect([...completed].sort()).toEqual([...population].sort());
  } finally { await db?.cleanup(); }
});

/** P001 contributing evidence through the registered work-item SQL readers.
 * A minimal base table/view and controlled vectors do not establish production
 * authoring, authorization, BM25, embedding generation or index synchronization.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { assertSearchFieldFreshness } from '@papercusp/search-core';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SEARCH_SOURCES } from './sources';
import { PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';

const query = 'zephyrworkitemwitness';
const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const qVec = JSON.stringify([1, ...Array(767).fill(0)]);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modes = ['lexical-and', 'lexical-coverage', 'embedding'] as const;
const population = modes.map(mode => `work_item/${mode}`);
const completed: string[] = [];
const receipts: unknown[] = [];
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-source-freshness');
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
      title text NOT NULL, summary text, item_kind text NOT NULL DEFAULT 'task',
      status text NOT NULL DEFAULT 'open', payload jsonb NOT NULL DEFAULT '{}',
      lane text GENERATED ALWAYS AS (payload->>'lane') STORED,
      created_ts bigint NOT NULL DEFAULT 1768478400000, updated_ts bigint,
      embedding vector(768), embedding_mode text, embedding_profile text,
      _search tsvector GENERATED ALWAYS AS
        (to_tsvector('english', title || ' ' || coalesce(summary,''))) STORED,
      PRIMARY KEY (harness_slug,feature_id)
    );
    -- Reader-relevant projection from migrations 776/721. The base-table oracle
    -- below independently checks these expressions; this is not a full migration.
    CREATE VIEW harness_shared.engineer_issues AS
      SELECT workspace_id, feature_id AS issue_id, harness_slug AS base_harness_slug,
        CASE WHEN harness_slug LIKE 'operator:%' OR harness_slug='' THEN 'operator'
             ELSE 'harness:' || harness_slug END AS scope,
        title, coalesce(summary,'') AS body, item_kind AS kind, status AS state,
        coalesce(payload->'_ei'->>'severity','minor') AS severity, lane,
        to_timestamp(created_ts/1000.0) AS created_at,
        to_timestamp(updated_ts/1000.0) AS updated_at,
        _search, embedding, embedding_mode, embedding_profile
      FROM harness_shared.work_items WHERE item_kind IN ('bug','change','task');
    CREATE TABLE harness_shared.text_chunks (
      surface text NOT NULL, parent_key text[] NOT NULL, chunk_idx integer NOT NULL,
      anchor text, header text, content text NOT NULL, parent_sha text NOT NULL, chunk_sha text NOT NULL,
      splitter_version text NOT NULL, embedding vector(768), embedding_mode text, embedding_profile text,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (surface,parent_key,chunk_idx)
    );
  `);
}, 60_000);

describe('P001 — work-item base fields, chunk candidates and reader scope', () => {
  for (const mode of modes) it(`${mode}: canonical fields and independent candidate controls`, async () => {
    const workspace = `p001-work-item-${mode}`;
    const harness = `${workspace}-harness`;
    const source = SEARCH_SOURCES.find(row => row.name === 'work_item')!;
    expect(source).toBeDefined();
    const entityRef = 'work_item:target';
    const run = (scope: string | null = harness, ws = workspace) => {
      const params = { sql: db.sql, workspaceId: ws, scopeFilter: scope, query, limit: 20,
        qVec, embeddingProfile: { profileId, legacyMode: 'gemma' },
        lexicalMode: mode === 'lexical-coverage' ? 'coverage-graded' as const : 'and' as const };
      return mode === 'embedding' ? source.embedding!(params) : source.lexical(params);
    };
    const seed = async (id: string, ws = workspace, h = harness, indexed = true) => {
      await db.sql`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,title,summary,payload)
        VALUES (${ws},${h},${id},'Canonical work item',${`${query} original summary`},
          ${db.sql.json({ lane: 'observation', _ei: { severity: 'minor' } })})`;
      if (indexed) await reindex(id,h);
    };
    // Explicit fixture index write: deliberately separate from canonical changes.
    async function reindex(id: string, h = harness) {
      const [raw] = await db.sql`SELECT title,summary FROM harness_shared.work_items
        WHERE harness_slug=${h} AND feature_id=${id}`;
      await db.sql`INSERT INTO harness_shared.text_chunks
        (surface,parent_key,chunk_idx,header,content,parent_sha,chunk_sha,splitter_version,
         embedding,embedding_mode,embedding_profile)
        VALUES ('work_items',${[h,id]}::text[],0,${raw.title},${raw.summary},
          ${fingerprint(raw)},${fingerprint(raw.summary)},'controlled-p001',${qVec}::vector,'gemma',${profileId})
        ON CONFLICT (surface,parent_key,chunk_idx) DO UPDATE SET content=EXCLUDED.content,
          parent_sha=EXCLUDED.parent_sha,chunk_sha=EXCLUDED.chunk_sha,updated_at=clock_timestamp()`;
    }
    await seed('target');
    await seed('foreign-workspace',`${workspace}-foreign`);
    await seed('other-harness',workspace,`${harness}-other`);
    await seed('operator-scope',workspace,`operator:${harness}`);
    await seed('non-issue');
    await db.sql`UPDATE harness_shared.work_items SET item_kind='feature'
      WHERE harness_slug=${harness} AND feature_id='non-issue'`;
    const canonical = async (scope: string | null, ws: string) => {
      const [raw] = await db.sql`SELECT *,xmin::text AS revision FROM harness_shared.work_items
        WHERE harness_slug=${harness} AND feature_id='target'`;
      const corpus = await db.sql`SELECT workspace_id,harness_slug,feature_id,item_kind,status,
        title,summary,payload,created_ts,updated_ts,xmin::text AS revision
        FROM harness_shared.work_items ORDER BY harness_slug,feature_id`;
      const chunks = await db.sql`SELECT parent_key,content,parent_sha,chunk_sha,xmin::text AS revision
        FROM harness_shared.text_chunks WHERE surface='work_items' ORDER BY parent_key,chunk_idx`;
      return { raw,corpus,chunks,readAtMs: Date.now(),epoch: fingerprint({ workspace: ws,scope }) };
    };
    async function capture(phase: string, expectedIds: string[], scope: string | null = harness, ws = workspace) {
      const requestStartedAtMs = Date.now();
      const before = await canonical(scope,ws);
      const rows = await run(scope,ws);
      const responseAtMs = Date.now();
      const after = await canonical(scope,ws);
      expect(after.corpus).toEqual(before.corpus);
      expect(after.chunks).toEqual(before.chunks);
      expect(after.epoch).toBe(before.epoch);
      expect(rows.map(row => row.row.source_id).sort()).toEqual([...expectedIds].sort());
      const raw = after.raw;
      const body = `${raw.title}\n${raw.summary ?? ''}`.trim();
      const values = { excerpt: `[${raw.item_kind}/${raw.status}/${raw.payload._ei?.severity ?? 'minor'}] ${body}`,
        highlight: body.replace(query,`<mark>${query}</mark>`),
        ts: new Date(Number(raw.updated_ts ?? raw.created_ts)), 'meta.lane': raw.payload.lane ?? null };
      const returned = rows.find(row => row.row.source_id === 'target')?.row;
      const observations = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(row => row.source === 'work_item')
        .map(boundary => {
          const field = boundary.policy.fieldPath as keyof typeof values;
          const returnedValue = field === 'meta.lane' ? returned?.meta?.lane : returned?.[field];
          const input = { returned: { entityRef,fieldPath: field,valueFingerprint: fingerprint(returnedValue ?? null) },
            indexed: null,canonical: { entityRef,fieldPath: field,valueFingerprint: fingerprint(values[field]),
              authority: boundary.policy.authority,authorityEpoch: after.epoch,
              sourceRevision: String(raw.revision),readAtMs: after.readAtMs },requestStartedAtMs,responseAtMs };
          const oracle = returned ? assertSearchFieldFreshness(boundary.policy,input) : null;
          if (oracle) {
            expect(returnedValue,`${mode}/${phase}/${field}`).toEqual(values[field]);
            expect(oracle.status).toBe('unknown');
            expect(oracle.action).toBe('degrade');
            expect(oracle.reasons).toContain('index witness unavailable');
          }
          return { field,input,oracle };
        });
      expect(observations.map(row => row.field).sort()).toEqual(['excerpt','highlight','meta.lane','ts']);
      receipts.push({ caseId: `work_item/${mode}`,phase,before,after,rows,expectedIds,observations });
      return { after,rows,observations };
    }
    const initial = await capture('base-fields-created-time-fallback',['target']);
    const oldChunk = initial.after.chunks;
    await db.sql`UPDATE harness_shared.work_items SET title='Replacement work item',
      summary=${`${query} replacement summary`},item_kind='bug',status='wip',
      payload=${db.sql.json({ lane: 'implementation',_ei: { severity: 'major' } })}
      WHERE harness_slug=${harness} AND feature_id='target'`;
    const changed = await capture('mutable-fields-changed-timestamp-and-index-unchanged',['target']);
    expect(changed.after.raw.revision).not.toBe(initial.after.raw.revision);
    expect(changed.after.raw.updated_ts).toBe(initial.after.raw.updated_ts);
    expect(changed.after.chunks).toEqual(oldChunk);
    for (const observation of changed.observations.filter(row => row.field !== 'ts')) {
      const previous = initial.observations.find(row => row.field === observation.field)!;
      const input = { ...observation.input,returned: previous.input.returned };
      const policy = PROSE_FIELD_FRESHNESS_BOUNDARIES.find(row => row.source === 'work_item'
        && row.policy.fieldPath === observation.field)!.policy;
      const oracle = assertSearchFieldFreshness(policy,input);
      expect(oracle.status).toBe('stale');
      expect(oracle.reasons).toContain('canonical: returned value differs');
      receipts.push({ caseId: `work_item/${mode}`,phase: 'old-field-fresh-envelope-refused',field: observation.field,input,oracle });
    }
    await db.sql`UPDATE harness_shared.work_items SET updated_ts=1768564800000,
      payload=${db.sql.json({ _ei: { severity: 'major' } })}
      WHERE harness_slug=${harness} AND feature_id='target'`;
    const timestamp = await capture('updated-time-and-null-lane',['target']);
    const tsObservation = timestamp.observations.find(row => row.field === 'ts')!;
    const tsPolicy = PROSE_FIELD_FRESHNESS_BOUNDARIES.find(row => row.source === 'work_item'
      && row.policy.fieldPath === 'ts')!.policy;
    const tsInput = { ...tsObservation.input,returned: initial.observations.find(row => row.field === 'ts')!.input.returned };
    const tsOracle = assertSearchFieldFreshness(tsPolicy,tsInput);
    expect(tsOracle.status).toBe('stale');
    receipts.push({ caseId: `work_item/${mode}`,phase: 'old-timestamp-refused',input: tsInput,oracle: tsOracle });
    await seed('added',workspace,harness,false);
    await capture('canonical-candidate-added-before-index',mode === 'embedding' ? ['target'] : ['target','added']);
    await reindex('added');
    await capture('candidate-after-controlled-backfill',['target','added']);
    await db.sql`DELETE FROM harness_shared.work_items WHERE harness_slug=${harness} AND feature_id='added'`;
    await capture('deleted-parent-orphan-chunk',['target']);
    await db.sql`DELETE FROM harness_shared.text_chunks
      WHERE surface='work_items' AND parent_key=${[harness,'target']}::text[]`;
    await capture('canonical-present-index-candidate-missing',mode === 'embedding' ? [] : ['target']);
    await reindex('target');
    await capture('candidate-restored-by-controlled-backfill',['target']);
    await capture('scope-filter-absent',['target','other-harness','operator-scope'],null);
    await capture('other-harness',['other-harness'],`${harness}-other`);
    await capture('foreign-workspace-positive',['foreign-workspace'],harness,`${workspace}-foreign`);
    await db.sql`UPDATE harness_shared.work_items SET workspace_id=${`${workspace}-moved`}
      WHERE harness_slug=${harness} AND feature_id='target'`;
    await capture('canonical-workspace-changed-old-reader',[]);
    const moved = await capture('canonical-workspace-changed-new-reader',['target'],harness,`${workspace}-moved`);
    expect(moved.after.epoch).not.toBe(initial.after.epoch);
    completed.push(`work_item/${mode}`);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_WORK_ITEM_SOURCE_WITNESS_FILE) {
      const paths = ['packages/operator-core/lib/agent-tools/search/work-item-source-freshness.integration.test.ts',
        'packages/operator-core/lib/agent-tools/search/sources.ts','packages/operator-core/lib/search/surface-registry.ts',
        'packages/operator-core/lib/search/chunks/registry.ts'];
      const pins = paths.map(path => ({ path,sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../../${path}`,import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_WORK_ITEM_SOURCE_WITNESS_FILE,JSON.stringify({ schemaVersion: 1,
        population,completed,pins,query,profileId,queryVectorFingerprint: fingerprint(qVec),receipts,limits: [
          'Minimal private PostgreSQL base/view projection; actual registered work-item lexical and vector SQL readers.',
          'Lexical legacy AND and coverage paths only; no BM25 index or BM25-path qualification.',
          'Fixture vector and explicit chunk backfill; no production authoring, sync, embedder or authorization witness.',
          'Reader epoch is controlled fixture input; production trusted authority and index-version proof remain unmeasured.',
          'Matching values remain unknown without index witness; copied old fields are stale; omitted candidates are separate.',
          'Other adapters, quality, budgets, runtime acceptance and shipment remain open.',
        ] },null,2)+'\n');
    }
  } finally { await db?.cleanup(); }
});

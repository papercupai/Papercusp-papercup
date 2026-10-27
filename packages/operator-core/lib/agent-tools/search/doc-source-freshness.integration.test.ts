/** P001 contributing evidence: real DocSource sync and registered SQL readers.
 * The authority is a controlled DocSource, not the derived doc_sections cache.
 * Production authentication, scheduling and index-version proof remain unmeasured.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocSource } from '@papercusp/docs-engine';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { assertSearchFieldFreshness } from '@papercusp/search-core';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { createDocSearchSource } from './knowledge-sources';
import { syncDocSourceSections } from '../../search/doc-embed-sync';
import { PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';

const query = 'zephyrdocwitness';
const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const qVec = JSON.stringify([1, ...Array(767).fill(0)]);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const population = ['doc/lexical', 'doc/embedding'];
const completed: string[] = [];
const receipts: unknown[] = [];
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('doc-source-freshness');
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.harness_registry (workspace_id text PRIMARY KEY, payload jsonb NOT NULL);
    CREATE TABLE harness_shared.harness_docs (
      workspace_id text NOT NULL, harness_slug text NOT NULL, doc_id text NOT NULL, retired_at timestamptz,
      PRIMARY KEY (workspace_id, harness_slug, doc_id)
    );
    CREATE TABLE harness_shared.doc_sections (
      source_key text NOT NULL, slug text NOT NULL, anchor text NOT NULL, title text NOT NULL,
      url text NOT NULL, content text NOT NULL, page_sha text NOT NULL, section_idx integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), embedding vector(768), embedding_mode text,
      embedding_profile text, PRIMARY KEY (source_key, slug, anchor)
    );
  `);
}, 60_000);

describe('P001 — docs authority, section sync and changing reader scope', () => {
  for (const leg of ['lexical', 'embedding'] as const) it(`${leg}: source changes, sync, candidates and retirement`, async () => {
    const key = `p001-doc-${leg}`;
    const workspace = `${key}-workspace`;
    const harness = `${key}-harness`;
    const sourceKey = `harness:${harness}`;
    const entityRef = `doc:${sourceKey}:${key}`;
    const pages = new Map([[key, { title: 'Original procedure', body: `${query} original canonical instructions.`, revision: 1 }]]);
    const page = (slug: string) => ({ slug, slugs: [slug], title: pages.get(slug)!.title,
      url: `/docs/${slug}`, toc: [] });
    const authority: DocSource = { name: sourceKey,
      listPages: async () => [...pages.keys()].map(page),
      getPage: async slug => pages.has(slug) ? page(slug) : null,
      getContent: async p => pages.get(p.slug)!.body,
    };
    const canonical = async () => {
      const p = await authority.getPage(key);
      expect(p).toBeDefined();
      return { title: p!.title, body: await authority.getContent(p!), revision: pages.get(key)!.revision,
        readAtMs: Date.now() };
    };
    const sync = async () => {
      const result = await syncDocSourceSections(db.sql, authority);
      expect(result.errors).toBe(0);
      // Deterministic fixture backfill only; no production embedder or scheduling claim.
      await db.sql`UPDATE harness_shared.doc_sections SET embedding = ${qVec}::vector,
        embedding_mode = 'gemma', embedding_profile = ${profileId} WHERE source_key = ${sourceKey}`;
      return result;
    };
    await db.sql`INSERT INTO harness_shared.harness_registry VALUES
      (${workspace}, ${db.sql.json({ projects: [{ slug: harness }] })}),
      (${`${workspace}-foreign`}, ${db.sql.json({ projects: [{ slug: `${harness}-foreign` }] })})`;
    await sync();
    // A high-rank, matching foreign source really exists and is searchable by its own workspace.
    await db.sql`INSERT INTO harness_shared.doc_sections
      (source_key,slug,anchor,title,url,content,page_sha,section_idx,embedding,embedding_mode,embedding_profile)
      VALUES (${`harness:${harness}-foreign`}, ${key}, '', 'Foreign procedure', '/foreign',
        ${`${query} foreign canonical instructions.`}, 'foreign', 0, ${qVec}::vector, 'gemma', ${profileId})`;
    const run = (ws = workspace, excluded = false) => {
      const source = createDocSearchSource({ automatic: true,
        excludedRefs: excluded ? new Set([entityRef]) : undefined });
      const params = { sql: db.sql, workspaceId: ws, query, scopeFilter: null, limit: 20,
        qVec, embeddingProfile: { profileId, legacyMode: 'gemma' } };
      return leg === 'lexical' ? source.lexical(params) : source.embedding!(params);
    };
    expect((await run(`${workspace}-foreign`)).map(r => r.row.source_id))
      .toEqual([`harness:${harness}-foreign:${key}`]);

    async function capture(phase: string, expectedIds: string[], expectedStatus: 'unknown' | 'stale' = 'unknown', excluded = false) {
      const requestStartedAtMs = Date.now();
      const before = await canonical();
      const rows = await run(workspace, excluded);
      const responseAtMs = Date.now();
      const after = await canonical();
      expect({ ...after, readAtMs: 0 }).toEqual({ ...before, readAtMs: 0 });
      expect(rows.map(r => r.row.source_id).sort()).toEqual([...expectedIds].sort());
      const [membership] = await db.sql`SELECT payload FROM harness_shared.harness_registry WHERE workspace_id = ${workspace}`;
      const retirement = await db.sql`SELECT retired_at FROM harness_shared.harness_docs
        WHERE workspace_id = ${workspace} AND harness_slug = ${harness} AND doc_id = ${`${key}.md`}`;
      const epoch = fingerprint({ membership, retirement });
      const returned = rows.find(r => r.row.source_id === `${sourceKey}:${key}`)?.row;
      const observations = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(b => b.source === 'doc').map(boundary => {
        const field = boundary.policy.fieldPath;
        const value = field === 'ts' ? returned?.ts : field === 'excerpt' ? returned?.excerpt : returned?.highlight;
        const canonicalValue = field === 'excerpt' ? `${after.title}\n${after.body}` : after.body;
        const input = { returned: { entityRef, fieldPath: field, valueFingerprint: fingerprint(value ?? null) },
          indexed: null,
          // The controlled provider has no authoritative timestamp; cache updated_at cannot supply it.
          canonical: field === 'ts' ? null : { entityRef, fieldPath: field,
            valueFingerprint: fingerprint(canonicalValue), authority: boundary.policy.authority,
            authorityEpoch: epoch, sourceRevision: String(after.revision), readAtMs: after.readAtMs },
          requestStartedAtMs, responseAtMs };
        const oracle = returned ? assertSearchFieldFreshness(boundary.policy, input) : null;
        if (oracle) {
          expect(oracle.status).toBe(field === 'ts' ? 'unknown' : expectedStatus);
          expect(oracle.action).toBe('degrade');
          expect(oracle.reasons).toContain('index witness unavailable');
          if (expectedStatus === 'unknown' && field !== 'ts') expect(value).toEqual(canonicalValue);
          if (expectedStatus === 'stale' && field !== 'ts') expect(oracle.reasons).toContain('canonical: returned value differs');
        }
        return { field, input, oracle };
      });
      receipts.push({ caseId: `doc/${leg}`, phase, before, after, rows, epoch, observations });
      return epoch;
    }

    const id = `${sourceKey}:${key}`;
    const initialEpoch = await capture('stored-source-synced', [id]);
    pages.set(key, { title: 'Revised procedure', body: `${query} replacement canonical instructions.`, revision: 2 });
    await capture('source-changed-cache-still-old', [id], 'stale');
    expect((await sync()).changed).toBe(1);
    await capture('source-change-synced', [id]);
    pages.set(`${key}-added`, { title: 'Added procedure', body: `${query} added canonical instructions.`, revision: 1 });
    await sync();
    await capture('candidate-added', [id, `${sourceKey}:${key}-added`]);
    pages.delete(`${key}-added`);
    expect((await sync()).pruned).toBe(1);
    await capture('candidate-pruned', [id]);
    await capture('audience-excluded', [], 'unknown', true);
    await db.sql`UPDATE harness_shared.harness_registry SET payload = ${db.sql.json({ projects: [] })}
      WHERE workspace_id = ${workspace}`;
    expect(await capture('membership-revoked', [])).not.toBe(initialEpoch);
    await db.sql`UPDATE harness_shared.harness_registry SET payload = ${db.sql.json({ projects: [{ slug: harness }] })}
      WHERE workspace_id = ${workspace}`;
    await capture('membership-restored', [id]);
    await db.sql`INSERT INTO harness_shared.harness_docs VALUES (${workspace}, ${harness}, ${`${key}.md`}, '2026-01-01')`;
    await capture('canonical-retirement', []);
    await db.sql`UPDATE harness_shared.harness_docs SET retired_at = NULL WHERE workspace_id = ${workspace}`;
    await capture('canonical-retirement-restored', [id]);
    completed.push(`doc/${leg}`);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_DOC_SOURCE_WITNESS_FILE) {
      expect([...completed].sort()).toEqual([...population].sort());
      const paths = ['packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts',
        'packages/operator-core/lib/agent-tools/search/knowledge-sources.ts',
        'packages/operator-core/lib/search/doc-embed-sync.ts', 'packages/operator-core/lib/search/surface-registry.ts'];
      const pins = paths.map(path => ({ path, sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../../${path}`, import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_DOC_SOURCE_WITNESS_FILE, JSON.stringify({ schemaVersion: 1,
        population, completed, pins, receipts, limits: [
          'Controlled DocSource authority and minimal SQL schema; no production authentication or scheduling claim.',
          'Manual deterministic vector backfill; real sync text writer and real lexical/vector reader SQL.',
          'Current values remain unknown without index-version proof; deliberately unsynced values are stale.',
          'Report/plan, memory/Restart, runtime, quality/cost/budgets and full acceptance remain open.',
        ] }, null, 2));
    }
  } finally { await db?.cleanup(); }
});

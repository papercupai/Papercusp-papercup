/**
 * SPEC-P-011-DUPE-GUARD-GIST (generic-rag-chunking-2026-09-29, D-010 / R-39):
 * the work-item duplicate guard compares GISTS. It ranks existing OPEN items by
 * their parent vector (title + the first 2,000 characters of the summary), so a
 * new item whose only overlap with an existing item lies past that item's first
 * 2,000 characters is NOT flagged — even though P-011 stores a chunk for that
 * tail and work-item SEARCH now retrieves the item through it.
 *
 * Runs the REAL `queryCandidatesReal` SQL (through `findSemanticDupes`, with only
 * the embedder and the coverage read injected) against a fresh Postgres with
 * pgvector + pg_trgm. Vectors are unit vectors on one angle, v(θ) = [cos θ,
 * sin θ, 0, …], so cosine similarity to the query v(0) is exactly cos θ.
 *
 *   TAIL-OVERLAP  harness 'sheets': parent vector far (θ = 1.2, cos 0.36);
 *                 its window chunk past the 2,000-character cut sits exactly on
 *                 the query (θ = 0) — the only thing it shares with the new item.
 *   NEAR          harness 'docs': parent vector θ = 0.1 (cos 0.995 ≥ hard 0.93)
 *                 — the positive control proving this fixture CAN be flagged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { PROSE_VECTOR_DIMS, resolveProseProfileSelection } from '../../search/prose-vector-dims';
import { issuesScopeWorkspace } from '../../issues-engineer';
import { activeWorkspaceId } from '../../workspace-registry';

const holder = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

import * as realGuard from './semantic-dupe-guard';
import type { SemanticDupeDeps } from './semantic-dupe-guard';

// Mutation-probe seam: scripts/mutation-probe.sh copy-out mode sets this to the mutated
// copy inside its repo mirror, so proving this guard falsifiable never dirties the shared
// tree or needs a git-sync hold. Unset (every normal run), the real module is used.
const subjectPath = process.env.PAPERCUSP_SEMANTIC_DUPE_GUARD_SUBJECT;
const guard: typeof realGuard = subjectPath
  ? ((await import(subjectPath)) as typeof realGuard)
  : realGuard;
const { findSemanticDupes, queryCandidatesReal } = guard;

const CUT = 2000;
const SHARED_TAIL = 'The reconciler double-books the quarterly ledger when the fiscal calendar crosses a leap day.';

function dirVec(theta: number): number[] {
  const v = new Array(PROSE_VECTOR_DIMS).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
}
const vecLit = (theta: number): string => `[${dirVec(theta).join(',')}]`;

const SELECTION = resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma)!;

let db: FreshPgDb;
let sql: postgres.Sql;
let workspace: string;

/** The texts the guard asked the embedder to embed, in call order. */
const embedded: string[] = [];

const deps: SemanticDupeDeps = {
  resolveEmbedder: async () => ({
    mode: 'gemma',
    dims: PROSE_VECTOR_DIMS,
    profile: EMBEDDER_DIM_SPECS.gemma,
    embed: async (text: string) => {
      embedded.push(text);
      // The new item is ABOUT the shared tail sentence, so it embeds onto v(0),
      // where the existing item's tail chunk lies.
      return dirVec(0);
    },
  }),
  queryCandidates: queryCandidatesReal,
  loadCoverage: async () => new Map(),
};

async function setupSchema(s: postgres.Sql): Promise<void> {
  await s.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await s.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  // The columns queryCandidatesReal reads, typed as production defines them.
  await s.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id      TEXT NOT NULL,
      harness_slug      TEXT NOT NULL,
      feature_id        TEXT NOT NULL,
      title             TEXT,
      summary           TEXT,
      status            TEXT,
      lane              TEXT,
      embedding         public.vector(${PROSE_VECTOR_DIMS}),
      embedding_mode    TEXT,
      embedding_profile TEXT,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.text_chunks (
      surface           TEXT    NOT NULL,
      parent_key        TEXT[]  NOT NULL,
      chunk_idx         INTEGER NOT NULL,
      anchor            TEXT,
      header            TEXT,
      content           TEXT    NOT NULL,
      parent_sha        TEXT    NOT NULL,
      chunk_sha         TEXT    NOT NULL,
      splitter_version  TEXT    NOT NULL,
      embedding         public.vector(${PROSE_VECTOR_DIMS}),
      embedding_mode    TEXT,
      embedding_profile TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (surface, parent_key, chunk_idx)
    );
  `);
}

async function seedItem(
  harness: string,
  id: string,
  title: string,
  summary: string,
  theta: number,
  lane: string | null = null,
): Promise<void> {
  await sql`INSERT INTO harness_shared.work_items
              (workspace_id, harness_slug, feature_id, title, summary, status, lane, embedding, embedding_mode, embedding_profile)
            VALUES (${workspace}, ${harness}, ${id}, ${title}, ${summary}, 'open', ${lane},
                    ${vecLit(theta)}::vector, 'gemma', ${SELECTION.profileId})`;
}

async function seedChunk(harness: string, id: string, idx: number, content: string, theta: number): Promise<void> {
  await sql`INSERT INTO harness_shared.text_chunks
              (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version,
               embedding, embedding_mode, embedding_profile)
            VALUES ('work_items', ${[harness, id]}::text[], ${idx}, ${content}, 'sha', ${`${id}-${idx}`}, 'window-1500-250@v1',
                    ${vecLit(theta)}::vector, 'gemma', ${SELECTION.profileId})`;
}

// A long summary whose first 2,000 characters are about something else entirely;
// the shared sentence starts past the cut.
const LONG_HEAD = 'Sheet export pagination drops the header row on page breaks. '.repeat(40).slice(0, CUT);
const LONG_SUMMARY = `${LONG_HEAD}\n${SHARED_TAIL}`;

beforeAll(async () => {
  db = await createFreshPgDb('dupe-guard-gist');
  sql = db.sql;
  holder.sql = sql;
  // The guard admits rows from the issues workspace and the active one; seed the
  // one the query will actually read, and assert both resolve to something.
  workspace = activeWorkspaceId();
  expect(issuesScopeWorkspace()).toBeTruthy();
  await setupSchema(sql);

  await seedItem('sheets', 'EI-TAIL-OVERLAP', 'Sheet export drops header rows', LONG_SUMMARY, 1.2);
  await seedChunk('sheets', 'EI-TAIL-OVERLAP', 0, LONG_HEAD.slice(0, 1500), 1.25);
  await seedChunk('sheets', 'EI-TAIL-OVERLAP', 1, LONG_SUMMARY.slice(1250), 0);

  await seedItem('docs', 'EI-NEAR', 'Reconciler double-books the quarterly ledger', SHARED_TAIL, 0.1);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

const NEW_ITEM = { title: 'Quarterly ledger double-booked across a leap day', summary: SHARED_TAIL };

describe('SPEC-P-011-DUPE-GUARD-GIST — the duplicate guard ranks by the parent vector only', () => {
  it('the fixture is valid: the existing item\'s shared text lies past the cut and its tail chunk sits on the new item\'s vector', async () => {
    expect(LONG_SUMMARY.indexOf(SHARED_TAIL)).toBeGreaterThan(CUT);
    const [row] = await sql<Array<{ sim: number }>>`
      SELECT 1 - (embedding <=> ${vecLit(0)}::vector) AS sim
        FROM harness_shared.text_chunks
       WHERE surface = 'work_items' AND parent_key = ${['sheets', 'EI-TAIL-OVERLAP']}::text[] AND chunk_idx = 1`;
    expect(Number(row!.sim)).toBeCloseTo(1, 5);
    expect(LONG_SUMMARY.slice(1250)).toContain(SHARED_TAIL);
  });

  it('does not flag a new item whose only overlap lies past the existing item\'s first 2,000 characters', async () => {
    embedded.length = 0;
    const result = await findSemanticDupes({ ...NEW_ITEM, harness: 'sheets' }, deps);
    expect(result).not.toBeNull();
    expect(result!.hard.map((c) => c.id)).not.toContain('EI-TAIL-OVERLAP');
    expect(result!.soft.map((c) => c.id)).not.toContain('EI-TAIL-OVERLAP');
    expect(result!.hard).toEqual([]);
    expect(result!.soft).toEqual([]);
    // The guard embedded the NEW item's gist, not something else.
    expect(embedded).toEqual([`${NEW_ITEM.title}\n${NEW_ITEM.summary}`]);
  });

  it('scores the existing item by its parent vector, never by its on-query tail chunk', async () => {
    const candidates = await queryCandidatesReal(dirVec(0), 'gemma', 'sheets', NEW_ITEM.title, SELECTION);
    const hit = candidates.find((c) => c.id === 'EI-TAIL-OVERLAP');
    expect(hit).toBeDefined();
    expect(hit!.similarity).toBeCloseTo(Math.cos(1.2), 5);
    expect(hit!.similarity).toBeLessThan(0.5);
  });

  it('excludes observation-lane rows before limiting the candidate pool', async () => {
    const harness = 'observation-filter';
    for (let i = 0; i < 6; i++) {
      await seedItem(
        harness,
        'EI-OBS-' + i,
        'Turn-end reflection ' + i,
        'agent observation',
        0,
        'observation',
      );
    }
    await seedItem(harness, 'WI-REAL', 'Real work item', 'candidate after observation rows', 0.2);

    const candidates = await queryCandidatesReal(dirVec(0), 'gemma', harness, NEW_ITEM.title, SELECTION);
    expect(candidates.map((candidate) => candidate.id)).toEqual(['WI-REAL']);
  });

  it('detector control: a guard that ranked by chunks WOULD flag the tail-overlap item', async () => {
    // A deliberately wrong candidates seam — the retrieve-mode shape (best of the
    // parent vector and every chunk vector). The same assertions as the negative
    // test above must fail against it, or they could not catch that regression.
    const chunkReading: SemanticDupeDeps = {
      ...deps,
      queryCandidates: async (vec, _mode, harness) => {
        const q = `[${vec.join(',')}]`;
        const rows = await sql<Array<{ id: string; title: string; similarity: number }>>`
          SELECT w.feature_id AS id, w.title,
                 GREATEST(1 - (w.embedding <=> ${q}::vector),
                          COALESCE(MAX(1 - (c.embedding <=> ${q}::vector)), -1)) AS similarity
            FROM harness_shared.work_items w
            LEFT JOIN harness_shared.text_chunks c
              ON c.surface = 'work_items' AND c.parent_key = ARRAY[w.harness_slug, w.feature_id]
           WHERE w.harness_slug = ${harness ?? ''}
           GROUP BY w.feature_id, w.title, w.embedding`;
        return rows.map((r) => ({ id: r.id, title: r.title, state: 'open', harness: harness ?? null, similarity: Number(r.similarity) }));
      },
    };
    const result = await findSemanticDupes({ ...NEW_ITEM, harness: 'sheets' }, chunkReading);
    expect(result!.hard.map((c) => c.id)).toContain('EI-TAIL-OVERLAP');
  });

  it('control: an item whose GIST matches the new item is flagged, so the negative above is not vacuous', async () => {
    const result = await findSemanticDupes({ ...NEW_ITEM, harness: 'docs' }, deps);
    expect(result).not.toBeNull();
    expect(result!.hard.map((c) => c.id)).toEqual(['EI-NEAR']);
    expect(result!.hard[0]!.similarity).toBeCloseTo(Math.cos(0.1), 5);
  });
});

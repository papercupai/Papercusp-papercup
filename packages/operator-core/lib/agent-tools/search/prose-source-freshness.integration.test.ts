/**
 * P001 contributing evidence for the remaining structured prose readers.
 * Runs the registered SQL against controlled stored rows. Canonical values come
 * from base relations, independently of adapter results; this does not measure
 * production ingestion, server authentication or an index revision witness.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchSourceParams } from '@papercusp/search';
import { assertSearchFieldFreshness } from '@papercusp/search-core';
import { applyDisclosureLedgerForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SEARCH_SOURCES } from './sources';
import { PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';

const query = 'zephyrstructured';
const profile = 'gemma-embeddinggemma-300m-768@v1';
const qVec = `[1,${Array(383).fill(0).join(',')}]`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Name = 'work_item' | 'session_turn' | 'coord_message';
const cases = [
  ['work_item', 'lexical'], ['work_item', 'embedding'],
  ['session_turn', 'lexical'], ['session_turn', 'embedding'],
  ['coord_message', 'lexical'],
] as const;
const receipts: unknown[] = [];
const completed: string[] = [];
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('structured-prose-freshness');
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
      title text NOT NULL, summary text NOT NULL, kind text NOT NULL DEFAULT 'bug',
      state text NOT NULL DEFAULT 'open', severity text NOT NULL DEFAULT 'minor', lane text,
      updated_at timestamptz, created_at timestamptz,
      embedding vector(384), embedding_mode text, embedding_profile text,
      _search tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', summary), 'B')) STORED,
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE VIEW harness_shared.engineer_issues AS
      SELECT workspace_id, harness_slug AS base_harness_slug, feature_id AS issue_id,
        'harness:' || harness_slug AS scope, title, summary AS body, kind, state, severity,
        lane, updated_at, created_at, embedding, embedding_mode, embedding_profile, _search
      FROM harness_shared.work_items;
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL, turn_idx integer NOT NULL,
      ts timestamptz, owner text, harness_slug text, cwd text, speaker text NOT NULL, text text NOT NULL,
      text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
      ingested_at timestamptz NOT NULL DEFAULT now(), text_embedding vector(384),
      text_embedding_mode text, text_embedding_profile text,
      turn_origin text, turn_origin_verdict text, turn_origin_classifier_version integer, chunked_at timestamptz,
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
    );
    CREATE TABLE harness_shared.session_turn_chunks (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL,
      turn_idx integer NOT NULL, chunk_idx integer NOT NULL, content text NOT NULL, turn_sha text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), embedding vector(384), embedding_mode text,
      embedding_profile text, PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx, chunk_idx)
    );
    CREATE TABLE harness_shared.text_chunks (
      surface text NOT NULL, parent_key text[] NOT NULL, chunk_idx integer NOT NULL,
      anchor text, header text, content text NOT NULL, parent_sha text NOT NULL, chunk_sha text NOT NULL,
      splitter_version text NOT NULL, embedding vector(384), embedding_mode text, embedding_profile text,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (surface, parent_key, chunk_idx)
    );
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, surface text NOT NULL,
      writer_key text, msg_id text NOT NULL, body jsonb NOT NULL, ts timestamptz NOT NULL, harness_slug text
    );
  `);
  await applyDisclosureLedgerForTest(db.sql);
}, 60_000);

async function seed(name: Name, key: string, workspace: string, harness: string, version: string) {
  const s = db.sql;
  const body = `${version} canonical body`;
  if (name === 'work_item') await s`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, title, summary, created_at, updated_at,
     embedding, embedding_mode, embedding_profile)
    VALUES (${workspace}, ${harness}, ${key}, ${query}, ${body}, '2026-01-01', '2026-01-01',
      ${qVec}::vector, 'gemma', ${profile})`;
  if (name === 'session_turn') await s`INSERT INTO harness_shared.session_turns
    (workspace_id, source_kind, session_id, turn_idx, ts, owner, harness_slug, speaker, text,
     text_embedding, text_embedding_mode, text_embedding_profile)
    VALUES (${workspace}, 'codex', ${key}, 0, '2026-01-01', ${key}, ${harness}, 'user',
      ${`${query} ${body}`}, ${qVec}::vector, 'gemma', ${profile})`;
  if (name === 'coord_message') await s`INSERT INTO harness_shared.coord_event_log
    (workspace_id, surface, msg_id, body, ts, harness_slug)
    VALUES (${workspace}, 'messages', ${key}, ${s.json({ from: key, kind: 'message', summary: query, body })},
      '2026-01-01', ${harness})`;
}

async function canonical(name: Name, key: string) {
  const s = db.sql;
  // The work-item oracle reads the base row, not the adapter's view/mapped hit.
  const rows = name === 'work_item'
    ? await s`SELECT *, xmin::text AS revision FROM harness_shared.work_items WHERE feature_id = ${key}`
    : name === 'session_turn'
      ? await s`SELECT *, xmin::text AS revision FROM harness_shared.session_turns WHERE session_id = ${key}`
      : await s`SELECT *, xmin::text AS revision FROM harness_shared.coord_event_log WHERE msg_id = ${key}`;
  expect(rows).toHaveLength(1);
  const raw = rows[0];
  const ledger = name === 'session_turn'
    ? await s`SELECT id, xmin::text AS revision, delivered_at, released_at FROM harness_shared.personal_disclosures
        WHERE agent_owner_id = ${raw.owner} ORDER BY id`
    : [];
  const text = name === 'work_item' ? `${raw.title}\n${raw.summary}`
    : name === 'session_turn' ? raw.text : `${raw.body.summary} ${raw.body.body}`;
  const excerpt = name === 'work_item' ? `[${raw.kind}/${raw.state}/${raw.severity}] ${text}`
    : name === 'session_turn' ? `[${raw.speaker} ${raw.owner} ${raw.ts}] ${text}`
      : `[${raw.body.kind} from ${raw.body.from} ${raw.ts}] ${text}`;
  return {
    raw, ledger, readAtMs: Date.now(), revision: String(raw.revision),
    id: name === 'session_turn' ? `codex:${key}:0` : key,
    values: { excerpt, highlight: text.replace(query, `<mark>${query}</mark>`),
      ts: name === 'work_item' ? raw.updated_at ?? raw.created_at : raw.ts, 'meta.lane': raw.lane },
    // Controlled fixture epoch only; a trusted production reader epoch is unmeasured.
    epoch: digest({ workspace: raw.workspace_id, harness: raw.harness_slug, owner: raw.owner, ledger }),
  };
}

async function update(name: Name, key: string) {
  const s = db.sql;
  if (name === 'work_item') await s`UPDATE harness_shared.work_items SET summary = 'newwitness canonical body',
    kind = 'change', state = 'resolved', severity = 'major', lane = 'observation', updated_at = '2026-01-02'
    WHERE feature_id = ${key}`;
  if (name === 'session_turn') await s`UPDATE harness_shared.session_turns
    SET text = ${`${query} newwitness canonical body`}, chunked_at = NULL, speaker = 'assistant', owner = ${`${key}-new`}, ts = '2026-01-02'
    WHERE session_id = ${key}`;
  if (name === 'coord_message') await s`UPDATE harness_shared.coord_event_log
    SET body = ${s.json({ from: `${key}-new`, kind: 'finding', summary: query, body: 'newwitness canonical body' })},
      ts = '2026-01-02' WHERE msg_id = ${key}`;
}

async function remove(name: Name, key: string) {
  if (name === 'work_item') await db.sql`DELETE FROM harness_shared.work_items WHERE feature_id = ${key}`;
  if (name === 'session_turn') await db.sql`DELETE FROM harness_shared.session_turns WHERE session_id = ${key}`;
  if (name === 'coord_message') await db.sql`DELETE FROM harness_shared.coord_event_log WHERE msg_id = ${key}`;
}

async function scope(name: Name, key: string, workspace: string, harness: string) {
  if (name === 'work_item') await db.sql`UPDATE harness_shared.work_items
    SET workspace_id = ${workspace}, harness_slug = ${harness} WHERE feature_id = ${key}`;
  if (name === 'session_turn') await db.sql`UPDATE harness_shared.session_turns
    SET workspace_id = ${workspace}, harness_slug = ${harness} WHERE session_id = ${key}`;
  if (name === 'coord_message') await db.sql`UPDATE harness_shared.coord_event_log
    SET workspace_id = ${workspace}, harness_slug = ${harness} WHERE msg_id = ${key}`;
}

describe('P001 — structured prose canonical fields and changing scope', () => {
  for (const [name, leg] of cases) it(`${name}.${leg}: stored fields, candidates, scope and disclosure`, async () => {
    const caseId = `${name}/${leg}`;
    const key = `p001-${name}-${leg}`;
    const workspace = `${key}-workspace`;
    const harness = `${key}-harness`;
    const source = SEARCH_SOURCES.find(s => s.name === name)!;
    const boundaries = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(b => b.source === name);
    expect(boundaries.length).toBeGreaterThan(1);
    await seed(name, key, workspace, harness, 'oldwitness');
    await seed(name, `${key}-foreign`, `${workspace}-foreign`, harness, 'foreignwitness');
    await seed(name, `${key}-other-harness`, workspace, `${harness}-other`, 'harnessdecoy');
    const run = (ws = workspace, h = harness) => {
      const p: SearchSourceParams = { sql: db.sql, query, workspaceId: ws, scopeFilter: h, limit: 20,
        embeddingProfile: { profileId: profile, legacyMode: 'gemma' } };
      return leg === 'embedding' ? source.embedding!({ ...p, qVec }) : source.lexical(p);
    };
    const targetId = (await canonical(name, key)).id;
    // Positive controls establish both decoys exist and are searchable in their own scopes.
    expect((await run(`${workspace}-foreign`)).map(r => r.row.source_id)).toEqual([(await canonical(name, `${key}-foreign`)).id]);
    expect((await run(workspace, `${harness}-other`)).map(r => r.row.source_id)).toEqual([(await canonical(name, `${key}-other-harness`)).id]);

    async function capture(phase: string, expectedIds: string[], ws = workspace, h = harness) {
      const requestStartedAtMs = Date.now();
      const before = await canonical(name, key);
      const results = await run(ws, h);
      const responseAtMs = Date.now();
      const after = await canonical(name, key);
      expect(after.revision).toBe(before.revision);
      expect(after.epoch).toBe(before.epoch);
      expect(results.map(r => r.row.source_id).sort()).toEqual([...expectedIds].sort());
      const returned = results.find(r => r.row.source_id === targetId)?.row;
      const observations = boundaries.map(boundary => {
        const fieldPath = boundary.policy.fieldPath as keyof typeof after.values;
        const value = fieldPath === 'meta.lane' ? returned?.meta?.lane : returned?.[fieldPath];
        if (returned) expect(value, `${caseId}/${phase}/${fieldPath}`).toEqual(after.values[fieldPath]);
        const input = { returned: { entityRef: `${name}:${targetId}`, fieldPath, valueFingerprint: digest(value ?? null) },
          indexed: null, canonical: { entityRef: `${name}:${targetId}`, fieldPath,
            valueFingerprint: digest(after.values[fieldPath] ?? null), authority: boundary.policy.authority,
            authorityEpoch: after.epoch, sourceRevision: after.revision, readAtMs: after.readAtMs },
          requestStartedAtMs, responseAtMs };
        const oracle = returned ? assertSearchFieldFreshness(boundary.policy, input) : null;
        if (oracle) {
          expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
          expect(oracle.reasons).toContain('index witness unavailable');
        }
        return { fieldPath, input, oracle };
      });
      receipts.push({ caseId, phase, before, after, results, observations, expectedIds });
      return after;
    }

    const initial = await capture('stored-fields', [targetId]);
    await update(name, key);
    const updated = await capture('content-update', [targetId]);
    expect(updated.revision).not.toBe(initial.revision);
    expect(updated.values.excerpt).toContain('newwitness');
    expect(updated.values.excerpt).not.toContain('oldwitness');
    await seed(name, `${key}-added`, workspace, harness, 'addedwitness');
    await capture('candidate-added', [targetId, (await canonical(name, `${key}-added`)).id]);
    await remove(name, `${key}-added`);
    await capture('candidate-removed', [targetId]);
    await scope(name, key, workspace, `${harness}-revoked`);
    const movedHarness = await capture('harness-revoked', []);
    expect(movedHarness.epoch).not.toBe(updated.epoch);
    expect((await run(workspace, `${harness}-revoked`)).map(r => r.row.source_id)).toEqual([targetId]);
    await scope(name, key, workspace, harness);
    await capture('harness-restored', [targetId]);
    await scope(name, key, `${workspace}-moved`, harness);
    const movedWorkspace = await capture('workspace-revoked', []);
    await capture('new-workspace-positive-control', [targetId], `${workspace}-moved`);

    if (name === 'session_turn') {
      const [user] = await db.sql`INSERT INTO harness_shared.users DEFAULT VALUES RETURNING id`;
      await db.sql`INSERT INTO harness_shared.personal_disclosures
        (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via, delivered_at)
        VALUES (${workspace}, ${user.id}, ${`${key}-new`}, gen_random_uuid(), 'fixture', 'sender-only',
          ARRAY['participant@example.test'], 'fixture', '2026-01-01')`;
      const withheld = await capture('disclosure-active', [], `${workspace}-moved`);
      expect(withheld.revision).toBe(movedWorkspace.revision);
      expect(withheld.epoch).not.toBe(movedWorkspace.epoch);
      await db.sql`UPDATE harness_shared.personal_disclosures
        SET released_at = '2026-01-03', released_by = 'fixture', release_ref = 'fixture-release'
        WHERE agent_owner_id = ${`${key}-new`}`;
      // Releasing later does not untaint a transcript turn inside the historical window.
      await capture('disclosure-released-historical-denial', [], `${workspace}-moved`);
    }
    completed.push(caseId);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_STRUCTURED_PROSE_WITNESS_FILE) {
      const population = cases.map(([name, leg]) => `${name}/${leg}`);
      expect([...completed].sort()).toEqual([...population].sort());
      const paths = ['packages/operator-core/lib/agent-tools/search/prose-source-freshness.integration.test.ts',
        'packages/operator-core/lib/agent-tools/search/sources.ts', 'packages/operator-core/lib/search/surface-registry.ts',
        'packages/operator-core/lib/personal-vault/transcript-exclusion.ts'];
      const pins = paths.map(path => ({ path, sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../../${path}`, import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_STRUCTURED_PROSE_WITNESS_FILE, JSON.stringify({ schemaVersion: 1,
        population, completed, pins, receipts, limits: [
          'Controlled base-row/view fixture; production schema/ingestion, authenticated readers and live authority are unmeasured.',
          'No BM25 extension or populated chunk corpus in this fixture; vector cases use parent rows.',
          'No candidate/index revision witness: field currentness remains unknown.',
          'Other prose sources, memory, Restart, runtime, quality/cost/budgets and acceptance are not discharged.',
        ] }, null, 2));
    }
  } finally {
    await db?.cleanup();
  }
});

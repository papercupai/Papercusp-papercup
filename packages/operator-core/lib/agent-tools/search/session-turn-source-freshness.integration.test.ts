/** P001 contributing evidence from actual session-turn SQL readers.
 * Controlled base rows, chunks and disclosure windows do not establish live
 * ingestion, authentication, embedding generation or an index revision witness.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchFilters, SearchSourceParams } from '@papercusp/search';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { assertSearchFieldFreshness } from '@papercusp/search-core';
import { applyDisclosureLedgerForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SEARCH_SOURCES } from './sources';
import { PROSE_FIELD_FRESHNESS_BOUNDARIES } from '../../search/surface-registry';

const query = 'zephyrsessionwitness';
const profileId = EMBEDDER_DIM_SPECS.gemma.profileId;
const qVec = JSON.stringify([1, ...Array(767).fill(0)]);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modes = ['lexical-and', 'lexical-coverage', 'embedding'] as const;
const population = modes.map(mode => `session_turn/${mode}`);
const completed: string[] = [];
const receipts: unknown[] = [];
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('session-turn-source-freshness');
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL, turn_idx integer NOT NULL,
      ts timestamptz, owner text, harness_slug text, speaker text NOT NULL, text text NOT NULL,
      text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english',left(text,20000))) STORED,
      ingested_at timestamptz NOT NULL DEFAULT '2026-01-15', text_embedding vector(768),
      text_embedding_mode text, text_embedding_profile text, turn_origin_verdict text, chunked_at timestamptz,
      PRIMARY KEY (workspace_id,source_kind,session_id,turn_idx)
    );
    CREATE TABLE harness_shared.session_turn_chunks (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL,
      turn_idx integer NOT NULL, chunk_idx integer NOT NULL, content text NOT NULL, turn_sha text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), embedding vector(768), embedding_mode text,
      embedding_profile text, PRIMARY KEY (workspace_id,source_kind,session_id,turn_idx,chunk_idx)
    );
  `);
  await applyDisclosureLedgerForTest(db.sql);
}, 60_000);

describe('P001 — session-turn fields, chunk candidates and disclosure boundaries', () => {
  for (const mode of modes) it(`${mode}: independent canonical fields and candidate controls`, async () => {
    const workspace = `p001-session-${mode}`;
    const harness = `${workspace}-harness`;
    const target = `${mode}-target`;
    const entityRef = `session_turn:codex:${target}:0`;
    const source = SEARCH_SOURCES.find(row => row.name === 'session_turn')!;
    const sourceId = (id: string) => `codex:${id}:0`;
    const run = (filters: SearchFilters = {}, ws = workspace, h: string | null = harness) => {
      const p: SearchSourceParams = { sql: db.sql, query, workspaceId: ws, scopeFilter: h, limit: 20,
        lexicalMode: mode === 'lexical-coverage' ? 'coverage-graded' : 'and', filters,
        embeddingProfile: { profileId,legacyMode: 'gemma' } };
      return mode === 'embedding' ? source.embedding!({ ...p,qVec }) : source.lexical(p);
    };
    async function reindex(id: string) {
      const [raw] = await db.sql`SELECT * FROM harness_shared.session_turns WHERE session_id=${id}`;
      await db.sql`INSERT INTO harness_shared.session_turn_chunks
        (workspace_id,source_kind,session_id,turn_idx,chunk_idx,content,turn_sha,embedding,embedding_mode,embedding_profile)
        VALUES (${raw.workspace_id},'codex',${id},0,0,${raw.text},${fingerprint(raw.text)},
          ${qVec}::vector,'gemma',${profileId})
        ON CONFLICT (workspace_id,source_kind,session_id,turn_idx,chunk_idx) DO UPDATE
          SET content=EXCLUDED.content,turn_sha=EXCLUDED.turn_sha,updated_at=clock_timestamp()`;
    }
    async function seed(id: string, ws = workspace, h: string | null = harness, chunk = true) {
      await db.sql`INSERT INTO harness_shared.session_turns
        (workspace_id,source_kind,session_id,turn_idx,ts,owner,harness_slug,speaker,text,
         text_embedding_mode,text_embedding_profile,turn_origin_verdict)
        VALUES (${ws},'codex',${id},0,'2026-01-15',${`${id}-owner`},${h},'user',
          ${`${query} original body`},'gemma',${profileId},'owner-typed')`;
      if (chunk) await reindex(id);
    }
    async function canonical(filters: SearchFilters, ws: string, h: string | null) {
      const [raw] = await db.sql`SELECT *,xmin::text AS revision FROM harness_shared.session_turns
        WHERE session_id=${target}`;
      const corpus = await db.sql`SELECT workspace_id,source_kind,session_id,turn_idx,ts,owner,harness_slug,
        speaker,text,ingested_at,turn_origin_verdict,xmin::text AS revision
        FROM harness_shared.session_turns ORDER BY workspace_id,source_kind,session_id,turn_idx`;
      const chunks = await db.sql`SELECT workspace_id,session_id,chunk_idx,content,turn_sha,xmin::text AS revision
        FROM harness_shared.session_turn_chunks ORDER BY workspace_id,session_id,chunk_idx`;
      const ledger = await db.sql`SELECT id,agent_owner_id,delivered_at,released_at,xmin::text AS revision
        FROM harness_shared.personal_disclosures ORDER BY id`;
      return { raw,corpus,chunks,ledger,readAtMs: Date.now(),epoch: fingerprint({ ws,h,filters,ledger }) };
    }
    async function capture(phase: string, expected: string[], filters: SearchFilters = {}, ws = workspace,
      h: string | null = harness) {
      const requestStartedAtMs = Date.now();
      const before = await canonical(filters,ws,h);
      const rows = await run(filters,ws,h);
      const responseAtMs = Date.now();
      const after = await canonical(filters,ws,h);
      expect(after.corpus).toEqual(before.corpus);
      expect(after.chunks).toEqual(before.chunks);
      expect(after.ledger).toEqual(before.ledger);
      expect(rows.map(row => row.row.source_id).sort()).toEqual(expected.map(sourceId).sort());
      const raw = after.raw;
      const values = { excerpt: `[${raw.speaker}${raw.owner ? ` ${raw.owner}` : ''}${raw.ts ? ` ${raw.ts}` : ''}] ${raw.text}`,
        highlight: raw.text.replace(query,`<mark>${query}</mark>`),ts: raw.ts };
      const returned = rows.find(row => row.row.source_id === sourceId(target))?.row;
      const observations = PROSE_FIELD_FRESHNESS_BOUNDARIES.filter(row => row.source === 'session_turn')
        .map(boundary => {
          const field = boundary.policy.fieldPath as keyof typeof values;
          const input = { returned: { entityRef,fieldPath: field,valueFingerprint: fingerprint(returned?.[field] ?? null) },
            indexed: null,canonical: { entityRef,fieldPath: field,valueFingerprint: fingerprint(values[field]),
              authority: boundary.policy.authority,authorityEpoch: after.epoch,
              sourceRevision: String(raw.revision),readAtMs: after.readAtMs },requestStartedAtMs,responseAtMs };
          const oracle = returned ? assertSearchFieldFreshness(boundary.policy,input) : null;
          if (oracle) {
            expect(returned![field],`${mode}/${phase}/${field}`).toEqual(values[field]);
            expect(oracle.status).toBe('unknown');
            expect(oracle.action).toBe('degrade');
            expect(oracle.reasons).toContain('index witness unavailable');
          }
          return { field,input,oracle };
        });
      expect(observations.map(row => row.field).sort()).toEqual(['excerpt','highlight','ts']);
      receipts.push({ caseId: `session_turn/${mode}`,phase,before,after,rows,expected,observations });
      return { after,observations };
    }
    await seed(target);
    await seed(`${mode}-foreign`,`${workspace}-foreign`);
    await seed(`${mode}-other-harness`,workspace,`${harness}-other`);
    await seed(`${mode}-no-harness`,workspace,null);
    const initial = await capture('stored-fields-chunk-only-vector',[target]);
    // chunked_at=NULL in the same statement: session_turns.text is insert-only
    // unless the writer re-arms chunking (search/session-turns-text-immutable.test.ts).
    await db.sql`UPDATE harness_shared.session_turns SET text=${`${query} replacement body`},
      owner=${`${target}-new-owner`},speaker='assistant',chunked_at=NULL WHERE session_id=${target}`;
    const changed = await capture('content-changed-timestamp-and-index-unchanged',[target]);
    expect(changed.after.raw.revision).not.toBe(initial.after.raw.revision);
    expect(changed.after.raw.ts).toEqual(initial.after.raw.ts);
    expect(changed.after.chunks).toEqual(initial.after.chunks);
    for (const observation of changed.observations.filter(row => row.field !== 'ts')) {
      const previous = initial.observations.find(row => row.field === observation.field)!;
      const input = { ...observation.input,returned: previous.input.returned };
      const policy = PROSE_FIELD_FRESHNESS_BOUNDARIES.find(row => row.source === 'session_turn'
        && row.policy.fieldPath === observation.field)!.policy;
      const oracle = assertSearchFieldFreshness(policy,input);
      expect(oracle.status).toBe('stale');
      expect(oracle.reasons).toContain('canonical: returned value differs');
      receipts.push({ caseId: `session_turn/${mode}`,phase: 'old-field-fresh-envelope-refused',input,oracle });
    }
    await db.sql`UPDATE harness_shared.session_turns SET ts=NULL WHERE session_id=${target}`;
    await capture('null-returned-timestamp-ingested-time-filter',[target],{ since: '2026-01-15',until: '2026-01-16' });
    await capture('ingested-time-exclusive-until',[],{ until: '2026-01-15' });
    await db.sql`UPDATE harness_shared.session_turns SET ts='2026-01-16' WHERE session_id=${target}`;
    await capture('timestamp-update',[target]);
    await seed(`${mode}-added`,workspace,harness,false);
    await capture('canonical-candidate-before-index',mode === 'embedding' ? [target] : [target,`${mode}-added`]);
    await reindex(`${mode}-added`);
    await capture('candidate-after-controlled-backfill',[target,`${mode}-added`]);
    await db.sql`DELETE FROM harness_shared.session_turns WHERE session_id=${`${mode}-added`}`;
    await capture('deleted-parent-orphan-chunk',[target]);
    await db.sql`DELETE FROM harness_shared.session_turn_chunks WHERE session_id=${target}`;
    await capture('canonical-present-no-vector-candidate',mode === 'embedding' ? [] : [target]);
    await db.sql`UPDATE harness_shared.session_turns SET text_embedding=${qVec}::vector WHERE session_id=${target}`;
    await capture('parent-vector-without-chunks',[target]);
    await db.sql`UPDATE harness_shared.session_turns SET text_embedding=NULL WHERE session_id=${target}`;
    await reindex(target);
    await capture('restored-chunk-candidate',[target]);
    await capture('speaker-filter-refusal',[],{ speaker: 'user' });
    await capture('owner-filter-refusal',[],{ owners: [`${target}-owner`] });
    await capture('source-kind-filter-refusal',[],{ sourceKind: 'claude' });
    await capture('session-filter-refusal',[],{ sessionId: 'absent-session' });
    await capture('provenance-filter-positive',[target],{ ownerOnly: true,turnOrigin: 'owner-typed' });
    await db.sql`UPDATE harness_shared.session_turns SET turn_origin_verdict='agent-injected' WHERE session_id=${target}`;
    await capture('provenance-owner-only-refusal',[],{ ownerOnly: true });
    await capture('provenance-candidate-refusal',[],{ ownerCandidates: true });
    await capture('provenance-exact-positive',[target],{ turnOrigin: 'agent-injected' });
    await seed(`${mode}-host-global`,'default');
    await capture('default-workspace-is-host-global',[target,`${mode}-host-global`]);
    await capture('foreign-workspace-positive',[`${mode}-foreign`,`${mode}-host-global`],{},`${workspace}-foreign`);
    await db.sql`DELETE FROM harness_shared.session_turns WHERE session_id=${`${mode}-host-global`}`;
    await capture('other-harness-positive',[`${mode}-other-harness`],{},workspace,`${harness}-other`);
    const [user] = await db.sql`INSERT INTO harness_shared.users DEFAULT VALUES RETURNING id`;
    await db.sql`INSERT INTO harness_shared.personal_disclosures
      (workspace_id,user_id,agent_owner_id,document_id,source,level,reader_set,delivered_via,delivered_at)
      VALUES (${workspace},${user.id},${`${target}-new-owner`},gen_random_uuid(),'fixture','sender-only',
        ARRAY['participant@example.test'],'fixture','2026-01-01')`;
    const restricted = await capture('disclosure-active-fail-closed',[]);
    expect(restricted.after.epoch).not.toBe(changed.after.epoch);
    await capture('recording-owner-reader-positive',[target],{ readerIds: [`${target}-new-owner`] });
    await db.sql`UPDATE harness_shared.personal_disclosures SET released_at='2026-01-17',
      released_by='fixture',release_ref='fixture-release' WHERE agent_owner_id=${`${target}-new-owner`}`;
    await capture('released-window-still-withholds-historical-turn',[]);
    await db.sql`UPDATE harness_shared.session_turns SET ts='2026-01-18' WHERE session_id=${target}`;
    await capture('turn-outside-released-window-positive',[target]);
    completed.push(`session_turn/${mode}`);
  });
});

afterAll(async () => {
  try {
    if (process.env.PAPERCUSP_SESSION_TURN_SOURCE_WITNESS_FILE) {
      const paths = ['packages/operator-core/lib/agent-tools/search/session-turn-source-freshness.integration.test.ts',
        'packages/operator-core/lib/agent-tools/search/sources.ts','packages/operator-core/lib/search/surface-registry.ts',
        'packages/operator-core/lib/search/turn-chunk-sync.ts','packages/operator-core/lib/personal-vault/transcript-exclusion.ts'];
      const pins = paths.map(path => ({ path,sha256: createHash('sha256')
        .update(readFileSync(new URL(`../../../../../${path}`,import.meta.url))).digest('hex') }));
      writeFileSync(process.env.PAPERCUSP_SESSION_TURN_SOURCE_WITNESS_FILE,JSON.stringify({ schemaVersion: 1,
        population,completed,pins,query,profileId,queryVectorFingerprint: fingerprint(qVec),receipts,limits: [
          'Minimal private PostgreSQL schema; actual registered legacy AND, coverage and chunk-aware vector readers.',
          'No BM25, production ingestion/sync, embedder, authenticated principal or trusted authority/index epoch proof.',
          'Explicit chunk backfill and disclosure rows are controlled fixture inputs; host-global default policy is preserved.',
          'Matching values remain unknown without index witness; stale copied fields and omitted candidates are separate.',
          'Memory, Restart, quality, budgets, runtime acceptance and shipment remain open.',
        ] },null,2)+'\n');
    }
  } finally { await db?.cleanup(); }
});

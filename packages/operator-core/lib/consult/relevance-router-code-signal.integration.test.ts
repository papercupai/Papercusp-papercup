/**
 * relevance-router-code-signal.integration.test.ts — routeConsult's code
 * signal against a real Postgres (pgvector), plan
 * code-intel-relevance-routing-2026-10-21 P-003 (BARs R-3, R-4).
 *
 * Same analytic vector geometry as relevance-router.integration.test.ts: every
 * turn sits at angle θ in one plane and the query at 0, so a candidate's
 * similarity is exactly cos(θ). The code signal comes from the two ledgers the
 * router now reads — edit_attribution_ledger (edits) and tool_invocations
 * (code reads) — for the files the question names or whose identifiers
 * resolve, through an injected deterministic symbol resolver.
 *
 *  - R-3: an identifier-only question (no path) gives the agent who EDITED the
 *    defining file authorship > 0 with the evidence persisted in the routing
 *    snapshot, while a below-similarity-floor agent stays unqualified however
 *    many edits it has (the CONTROL case proves the edits are what lift its
 *    relevance, so the hard similarity gate is what excludes it).
 *  - R-4: a non-code question runs no ledger query and scores exactly as the
 *    path-only (pre-change) router does, with every authorship still 0.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { DISCLOSURE_LEDGER_FIXTURE_DDL } from '../../test/_disclosure-ledger-fixture';
import { resolveProseProfileSelection } from '../search/prose-vector-dims';
import { WORKING_SET_TOOLS } from '../code-intelligence/working-set';
import {
  routeConsult,
  DEFAULT_SIM_FLOOR,
  DEFAULT_RELEVANCE_FLOOR,
  snapshotCandidateQualifies,
  type ConsultRouteDeps,
  type RouteResult,
} from './relevance-router';
import type { SymbolResolver } from './code-subject-resolution';

const WS = 'ws-code-signal';
const NOW = new Date('2026-10-21T00:00:00Z');
const DAY = 86_400_000;
const FILE = 'packages/operator-core/lib/consult/code-fixture-subject.ts';
const OTHER_FILE = 'packages/operator-core/lib/unrelated/elsewhere.ts';
const IDENT = 'scoreFixtureSubject';
const CODE_QUESTION = `how does \`${IDENT}\` weigh its inputs?`;
const NON_CODE_QUESTION = 'how should reviewers weigh evidence when the answer is uncertain?';

const vecAt = (theta: number): number[] => {
  const v = new Array<number>(768).fill(0);
  v[0] = Math.cos(theta);
  v[1] = Math.sin(theta);
  return v;
};

let rootSql: Sql;
let fixtureDb: MigratedTestDb;
let recording = false;
const ledgerQueries: string[] = [];

/** Resolves only IDENT, to FILE — and records every call. */
const fixtureResolver = () => vi.fn<SymbolResolver>(async (ids) =>
  new Map(ids.filter((id) => id === IDENT).map((id) => [id, [FILE]] as const)));

const deps = (over: Partial<ConsultRouteDeps> = {}): ConsultRouteDeps => ({
  getSql: () => rootSql,
  embed: async () => vecAt(0),
  embeddingProfile: resolveProseProfileSelection('gemma', EMBEDDER_DIM_SPECS.gemma),
  embeddingMode: 'gemma',
  now: () => NOW,
  scoreSubjectEvidence: async (_subject, texts) => texts.map(() => 1),
  ...over,
});

let turnSeq = 0;
async function insertTurn(owner: string, theta: number, tsMsAgo: number) {
  turnSeq += 1;
  await rootSql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text,
       text_embedding, text_embedding_mode, text_embedding_profile)
    VALUES ('default', 'claude', ${'sess-' + owner}, ${turnSeq},
            ${new Date(NOW.getTime() - tsMsAgo).toISOString()}::timestamptz,
            ${owner}, 'assistant', ${`turn ${turnSeq} of ${owner}`},
            ${JSON.stringify(vecAt(theta))}::vector,
            'gemma', ${EMBEDDER_DIM_SPECS.gemma.profileId})`;
}
const edit = (agent: string, file: string, daysAgo: number) => rootSql`
  INSERT INTO harness_shared.edit_attribution_ledger (workspace_id, agent_id, file, ts)
  VALUES (${WS}, ${agent}, ${file}, ${new Date(NOW.getTime() - daysAgo * DAY).toISOString()}::timestamptz)`;
const read = (owner: string, tool: string, args: object) => rootSql`
  INSERT INTO harness_shared.tool_invocations (workspace_id, coord_owner_id, tool_name, args_json)
  VALUES (${WS}, ${owner}, ${tool}, ${rootSql.json(args as never)})`;

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'consultcode' });
  rootSql = postgres(fixtureDb.url, {
    max: 1,
    onnotice: () => {},
    debug: (_connection, query) => {
      if (recording && /edit_attribution_ledger|tool_invocations/.test(query)) ledgerQueries.push(query);
    },
  });
  await rootSql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  const ledgerMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/archive/077-route-invocations.sql', import.meta.url));
  await rootSql.unsafe(readFileSync(ledgerMigration, 'utf8').replace(/^\\.*$/gm, ''));
  const metadataMigration = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1429-route-invocation-metadata.sql', import.meta.url));
  await rootSql.unsafe(readFileSync(existsSync(metadataMigration) ? metadataMigration : metadataMigration + '.DRAFT', 'utf8'));
  await rootSql.unsafe(DISCLOSURE_LEDGER_FIXTURE_DDL);
  // Column names copied from relevance-router.integration.test.ts (verified
  // there against the migration-owned schema) and, for the two code ledgers,
  // from code-familiarity.integration.test.ts.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL DEFAULT 'default', source_kind text NOT NULL, session_id text NOT NULL,
      turn_idx integer NOT NULL, ts timestamptz, owner text, speaker text NOT NULL, text text NOT NULL,
      chunked_at timestamptz, ingested_at timestamptz NOT NULL DEFAULT now(),
      text_embedding vector(768), text_embedding_mode text, text_embedding_profile text,
      text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
      turn_origin_verdict text,
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx));
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY, admission text, admitted_at timestamptz, admitted_by text,
      terminal_owner text, authority text, closed_ts bigint, payload jsonb NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      agent text, role text, session_id text, omp_thread_id text, ended_at timestamptz);
    CREATE TABLE harness_shared.plan_item_claims (
      workspace_id text NOT NULL, owner text NOT NULL, expires_ts timestamptz NOT NULL);
    CREATE TABLE harness_shared.edit_attribution_ledger (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, harness_slug text, repo text, file text NOT NULL,
      agent_id text NOT NULL, session_id text, contributor text, work_item_id text, plan_slug text, intent text,
      ts timestamptz NOT NULL DEFAULT now(), repo_root text, acquired_via text, dispatch_call_id text);
    CREATE TABLE harness_shared.tool_invocations (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, harness_slug text, tool_name text NOT NULL,
      coord_owner_id text, args_json jsonb, status text NOT NULL DEFAULT 'ok',
      invoked_at timestamptz NOT NULL DEFAULT now());
  `);

  // ── The corpus ───────────────────────────────────────────────────────────
  // bystander: the MOST similar candidate, no code activity at all.
  await insertTurn('code-bystander', 0.18, 1 * DAY);
  // editor: slightly less similar; ONE edit of the defining file (a year ago:
  // all-time, no recency term) plus edits of an unrelated file that must not count.
  await insertTurn('code-editor', 0.2, 1 * DAY);
  await edit('code-editor', FILE, 365);
  await edit('code-editor', OTHER_FILE, 1);
  await edit('code-editor', OTHER_FILE, 2);
  // reader: four code reads of the defining file, one non-code tool call naming it.
  await insertTurn('code-reader', 0.21, 1 * DAY);
  for (let i = 0; i < 4; i++) await read('code-reader', 'capability:read', { file_path: `/repo/${FILE}`, offset: i * 50 });
  await read('code-reader', 'coord:send', { body: `see ${FILE}` });
  // subfloor: similarity cos(1.2) ≈ 0.362 < DEFAULT_SIM_FLOOR, forty edits.
  await insertTurn('code-subfloor', 1.2, 1 * DAY);
  for (let i = 0; i < 40; i++) await edit('code-subfloor', FILE, i);
  // the requester's own perfect-similarity turn is excluded from routing.
  await insertTurn('agent-self', 0, 1 * DAY);
  // an edit in ANOTHER workspace must not count.
  await rootSql`INSERT INTO harness_shared.edit_attribution_ledger (workspace_id, agent_id, file) VALUES ('ws-other', 'code-bystander', ${FILE})`;
}, 120_000);

afterAll(async () => {
  try { await rootSql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

const params = (question: string, over: Record<string, unknown> = {}) =>
  ({ workspaceId: WS, requesterId: 'agent-self', question, ...over });

function candidate(r: RouteResult, ownerId: string) {
  const c = r.snapshot.candidates.find((x) => x.ownerId === ownerId);
  expect(c, `${ownerId} in snapshot.candidates`).toBeDefined();
  return c!;
}

describe('R-3 — an identifier-only code question credits the agents who worked on the defining file', () => {
  it('gives the editor and the reader authorship > 0, persists the evidence, and leaves the bystander at 0', async () => {
    const resolver = fixtureResolver();
    const r = await routeConsult(params(CODE_QUESTION), deps({ resolveCodeSymbols: resolver }));

    expect(WORKING_SET_TOOLS).toContain('capability:read');
    expect(resolver).toHaveBeenCalledWith([IDENT]);
    expect(r.snapshot.codeSubjects).toEqual({
      paths: [], identifiers: [IDENT], resolved: { [IDENT]: [FILE] }, files: [FILE],
      resolver: 'ok', edits: 'measured', reads: 'measured',
    });

    // authorship = max(workItemPaths/2, edits/2 + reads/8), clamped to 1.
    const editor = candidate(r, 'code-editor');
    expect(editor.authorshipEvidence).toEqual({ workItemPaths: 0, edits: 1, reads: 0 });
    expect(editor.signals.authorship).toBeCloseTo(0.5, 9);
    const reader = candidate(r, 'code-reader');
    expect(reader.authorshipEvidence).toEqual({ workItemPaths: 0, edits: 0, reads: 4 });
    expect(reader.signals.authorship).toBeCloseTo(0.5, 9);
    const bystander = candidate(r, 'code-bystander');
    expect(bystander.authorshipEvidence).toEqual({ workItemPaths: 0, edits: 0, reads: 0 });
    expect(bystander.signals.authorship).toBe(0);

    // The code signal changes the ranking: the editor is less similar but more relevant.
    expect(editor.signals.similarity).toBeLessThan(bystander.signals.similarity);
    expect(editor.relevance).toBeGreaterThan(bystander.relevance);
    expect(r.qualified.map((c) => c.ownerId)).toContain('code-editor');
  });

  it('keeps a below-similarity-floor agent unqualified however many edits it has', async () => {
    // Weights tilted toward authorship so the forty edits carry the subfloor
    // agent's RELEVANCE over the floor: (.362×.3 + 1×.6) / 1.0 ≈ 0.71.
    const weights = { similarity: 0.3, verification: 0.1, authorship: 0.6 };
    const r = await routeConsult(params(CODE_QUESTION, { weights }), deps({ resolveCodeSymbols: fixtureResolver() }));
    const sub = candidate(r, 'code-subfloor');
    expect(sub.authorshipEvidence?.edits).toBe(40);
    expect(sub.signals.authorship).toBe(1);
    expect(sub.relevance).toBeGreaterThanOrEqual(DEFAULT_RELEVANCE_FLOOR); // relevance alone would pass…
    expect(sub.signals.similarity).toBeLessThan(DEFAULT_SIM_FLOOR); // …but similarity is below the floor…
    expect(r.qualified.map((c) => c.ownerId)).not.toContain('code-subfloor'); // …so it does not qualify,
    expect(snapshotCandidateQualifies(r.snapshot, sub)).toBe(false); // and the persisted snapshot agrees.
  });

  it('CONTROL: with the similarity floor at 0 the same edits do qualify the subfloor agent', async () => {
    const weights = { similarity: 0.3, verification: 0.1, authorship: 0.6 };
    const r = await routeConsult(params(CODE_QUESTION, { weights, simFloor: 0 }), deps({ resolveCodeSymbols: fixtureResolver() }));
    expect(r.qualified.map((c) => c.ownerId)).toContain('code-subfloor');
  });

  it('records an unavailable resolver honestly and credits no code authorship', async () => {
    const failing = vi.fn<SymbolResolver>(async () => { throw new Error('symbol resolver unavailable: timeout'); });
    const r = await routeConsult(params(CODE_QUESTION), deps({ resolveCodeSymbols: failing }));
    expect(r.snapshot.codeSubjects).toBeUndefined();
    expect(candidate(r, 'code-editor').signals.authorship).toBe(0);
  });
});

describe('R-4 — a non-code question scores exactly as the path-only router does', () => {
  const shape = (r: RouteResult) => ({
    verdict: r.verdict,
    qualified: r.qualified.map((c) => c.ownerId),
    candidates: r.snapshot.candidates.map((c) => ({ ownerId: c.ownerId, relevance: c.relevance, score: c.score, signals: c.signals })),
  });

  it('runs no ledger query, persists no code evidence, and equals the resolver-less baseline', async () => {
    ledgerQueries.length = 0;
    recording = true;
    let withResolver: RouteResult;
    let baseline: RouteResult;
    const resolver = vi.fn<SymbolResolver>(async (ids) => new Map(ids.map((id) => [id, [FILE]] as const)));
    try {
      withResolver = await routeConsult(params(NON_CODE_QUESTION), deps({ resolveCodeSymbols: resolver }));
      baseline = await routeConsult(params(NON_CODE_QUESTION), deps({ resolveCodeSymbols: null }));
    } finally {
      recording = false;
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(ledgerQueries).toEqual([]);
    expect(withResolver.snapshot.codeSubjects).toBeUndefined();
    expect(withResolver.snapshot.candidates.length).toBeGreaterThan(0);
    for (const c of withResolver.snapshot.candidates) {
      expect(c.authorshipEvidence).toBeUndefined();
      // No path and no identifier: authorship is 0 for everyone, editors included.
      expect(c.signals.authorship).toBe(0);
    }
    expect(shape(withResolver)).toEqual(shape(baseline));
  });

  it('CONTROL: the same recorder does see the ledger queries for a code question', async () => {
    ledgerQueries.length = 0;
    recording = true;
    try {
      await routeConsult(params(CODE_QUESTION), deps({ resolveCodeSymbols: fixtureResolver() }));
    } finally {
      recording = false;
    }
    expect(ledgerQueries.some((q) => q.includes('edit_attribution_ledger'))).toBe(true);
    expect(ledgerQueries.some((q) => q.includes('tool_invocations'))).toBe(true);
  });
});

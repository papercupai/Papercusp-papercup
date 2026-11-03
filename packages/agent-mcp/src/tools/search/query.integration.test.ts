/**
 * search:query and features:search against a real pg_textsearch server (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10 P-005, D-006).
 *
 * Runs in the dedicated BM25 container (operator-core's lexical/test-pg image: PG 18 +
 * pg_textsearch 1.5.1, preloaded) and applies migration 1447 as armed. It pins what the
 * unit tests cannot: tasks rank through the `harness_features_consolidated` VIEW with the
 * work_items BM25 index (the view's item_kind filter still applies), goals and audit rank
 * on their own BM25 indexes, projects stays on ts_rank, and the kinds merge by position.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bm25LegIfAvailable, lexicalEngine, resetBm25Availability } from '@papercusp/operator-core/lib/search/lexical/rank';
import featuresSearch from '../features/search';
import tool from './query';

const LEXICAL_DIR = path.resolve(__dirname, '../../../../operator-core/lib/search/lexical');
const SQL_DIR = path.resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const IMAGE = 'papercusp-pgts-test:1.5.1';

function migration1447(): string {
  const file = readdirSync(SQL_DIR).find(f => /^1447-.*\.sql$/.test(f));
  if (!file) throw new Error('migration 1447 is not armed');
  return readFileSync(path.join(SQL_DIR, file), 'utf8');
}

let container: StartedTestContainer;
let sql: Sql;

type Hit = { kind: string; id: string; score: number; kindScore: number; kindRank: number };

async function search(args: { query: string; kinds?: string[]; limit?: number }) {
  return sql.begin(async tx =>
    tool.handler(
      { limit: 25, ...args } as never,
      { principal: { slug: 'op', workspaceId: 'default' }, tx, log: vi.fn() } as never,
    ),
  ) as Promise<{ data: Hit[]; engines: Record<string, string>; degraded?: boolean }>;
}

beforeAll(async () => {
  const built = await GenericContainer.fromDockerfile(path.join(LEXICAL_DIR, 'test-pg')).build(IMAGE, { deleteOnExit: false });
  container = await built
    .withEnvironment({ POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  sql = postgres({
    host: container.getHost(), port: container.getMappedPort(5432),
    user: 'postgres', database: 'postgres', max: 2, onnotice: () => {},
  });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      id serial PRIMARY KEY, harness_slug text, feature_id text, item_kind text,
      title text, summary text, notes text, status text DEFAULT 'open', tags jsonb, updated_ts bigint,
      _search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))) STORED);
    CREATE VIEW harness_shared.harness_features_consolidated AS
      SELECT harness_slug, feature_id, title, summary, notes, status, tags, updated_ts, _search
        FROM harness_shared.work_items
       WHERE item_kind <> ALL (ARRAY['bug', 'change', 'task']);
    CREATE TABLE harness_shared.goals (
      id text PRIMARY KEY, title text, body text,
      _search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED);
    CREATE TABLE harness_shared.projects (
      id text PRIMARY KEY, slug text, name text,
      _search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(slug, ''))) STORED);
    CREATE TABLE harness_shared.audit_log (
      id text PRIMARY KEY, subject text, action text, actor text,
      _search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(action, ''))) STORED);
  `);
  const features = Array.from({ length: 200 }, (_, i) => ({
    harness_slug: 'h', feature_id: `F-${i + 1}`, item_kind: 'feature',
    title: `feature ${i + 1}${i === 0 ? ' about the quokka' : ''}`, summary: 'routine summary', notes: null,
  }));
  // A bug row holding the same rare term: the view must still exclude it.
  features.push({ harness_slug: 'h', feature_id: 'EI-1', item_kind: 'bug', title: 'quokka bug', summary: 'routine summary', notes: null });
  await sql`INSERT INTO harness_shared.work_items ${sql(features)}`;
  const goals = Array.from({ length: 50 }, (_, i) => ({ id: `g${i + 1}`, title: `goal ${i + 1} quokka habitat`, body: 'routine' }));
  goals.push(
    {
      id: 'g-fragment-target',
      title: 'A working, browsable field-guide website to common North American owls — running and viewable, not a design document',
      body: 'A browsable field guide to common North American owls — species index + a detail page per species — actually running and viewable. Content accuracy outranks visual polish; no invented bird facts.',
    },
    {
      id: 'g-fragment-exact-decoy',
      title: 'Ship a runnable, browsable field guide website to common North American owls (species index + per-species detail pages)',
      body: 'A real, running website for a person to open and browse. An index page lists common North American owl species. A detail view per species. It actually runs and is viewable. Content accuracy is required.',
    },
    {
      id: 'g-fragment-bm25-decoy',
      title: 'Ship a runnable, browsable field-guide website to common North American owls (species index + per-species detail), hosted outside the repo',
      body: 'Species index and detail page per species; actually running and viewable. Species index detail page per species actually running and viewable. A species index has a detail page per species, running and viewable.',
    },
  );
  await sql`INSERT INTO harness_shared.goals ${sql(goals)}`;
  await sql`INSERT INTO harness_shared.projects ${sql([{ id: 'p1', slug: 'quokka-park', name: 'quokka park' }])}`;
  await sql`INSERT INTO harness_shared.audit_log ${sql([
    { id: 'a1', subject: 'quokka', action: 'created', actor: 'op' },
    { id: 'a2', subject: 'wombat', action: 'created', actor: 'op' },
  ])}`;
  await sql.unsafe(migration1447());
  resetBm25Availability();
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop();
});

describe('search:query on BM25', () => {
  it('ranks tasks, goals and audit with BM25 and projects with ts_rank', async () => {
    const res = await search({ query: 'quokka' });
    expect(res.engines).toEqual({ tasks: 'bm25', goals: 'bm25', projects: 'fts', audit: 'bm25' });
    expect(res.degraded).toBeUndefined();
  });

  it('ranks tasks through the view and keeps its item_kind filter', async () => {
    const res = await search({ query: 'quokka', kinds: ['tasks'] });
    expect(res.data.map(h => h.id)).toEqual(['h/F-1']);
    expect(res.data[0]!.kindScore).toBeGreaterThan(0);
  });

  it('interleaves the exact goals list before a small per-kind limit drops a fragment match', async () => {
    const query = 'species index detail page per species actually running and viewable content accuracy';
    expect(await lexicalEngine(sql, 'goals')).toBe('bm25');
    const leg = await bm25LegIfAvailable(sql, 'goals', query);
    expect(leg).not.toBeNull();
    const bm25Only = await sql<Array<{ id: string }>>`
      SELECT id FROM harness_shared.goals
       WHERE ${leg!.match}
       ORDER BY ${leg!.order}
       LIMIT 2
    `;
    expect(bm25Only.map((row) => row.id)).not.toContain('g-fragment-target');

    const res = await search({ query, kinds: ['goals'], limit: 2 });
    expect(res.engines.goals).toBe('bm25');
    expect(res.data.map((hit) => hit.id)).toContain('g-fragment-target');
  });

  it("gives each kind's best hit a top slot, whatever its engine's score scale", async () => {
    const res = await search({ query: 'quokka', limit: 6 });
    // Each kind's best hit takes one of the first four slots, in kind order.
    expect(res.data.slice(0, 4).map(h => h.kind)).toEqual(['tasks', 'goals', 'projects', 'audit']);
    expect(res.data.slice(0, 4).every(h => h.kindRank === 1)).toBe(true);
    const project = res.data.find(h => h.kind === 'projects')!;
    const bestGoal = res.data.find(h => h.kind === 'goals')!;
    // Measured: "quokka" is in all fifty goals, so its BM25 IDF is near zero and the best
    // goal scores ~0.01 against the project's ts_rank ~0.2; a rare term flips that. The
    // kind scores live on unrelated scales; the fused scores of equal positions are equal.
    expect(bestGoal.kindScore).not.toBe(project.kindScore);
    expect(project.score).toBe(bestGoal.score);
  });

  it('accepts operator characters in the query', async () => {
    const res = await search({ query: "quokka & (habitat | 'x" });
    expect(res.engines.goals).toBe('bm25');
    expect(res.data.some(h => h.kind === 'goals')).toBe(true);
  });
});

describe('features:search on BM25', () => {
  it('ranks the harness features through the view with the work_items BM25 index', async () => {
    expect(await lexicalEngine(sql, 'work_items')).toBe('bm25');
    const res = await sql.begin(async tx =>
      featuresSearch.handler(
        { slug: 'h', query: 'quokka', limit: 25 } as never,
        { principal: { slug: 'op', workspaceId: 'default' }, tx, log: vi.fn() } as never,
      ),
    ) as { data: Array<{ feature_id: string; rank: number }>; degraded?: boolean };
    expect(res.degraded).toBeUndefined();
    // F-1 holds the rare term; the bug row with the same term stays outside the view.
    expect(res.data.map(r => r.feature_id)).toEqual(['F-1']);
    expect(Number(res.data[0]!.rank)).toBeGreaterThan(0);
  });
});

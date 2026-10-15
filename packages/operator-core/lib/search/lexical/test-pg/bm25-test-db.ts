/**
 * Shared bootstrap for the BM25 integration suites (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10). Each suite file is named by the
 * requirement it verifies (bm25-health, bm25-ranking, bm25-latency, bm25-maintenance,
 * bm25-hybrid-fusion, bm25-write-load) and calls `startBm25TestDb` in its own beforeAll.
 *
 * The server is a long-lived container built from ./Dockerfile (PG 18 + pgvector +
 * pg_textsearch 1.5.1), reused across runs like the shared test PG: a fresh container per
 * run failed four times on 2026-10-11 with zero tests run, because under host IO pressure
 * dockerd took more than the 120s Docker client deadline to answer the create request
 * (measured 05:58:20 -> 06:00:20, EI-25658543783887821), while reused containers were ready in
 * under two seconds. The port wait plus a real SELECT 1 replaces a log-message wait, which a
 * container that is already running never prints again.
 *
 * `preload: false` runs the SAME image with a plain `postgres` command, so pg_textsearch is
 * installed but not in shared_preload_libraries: the configuration the R-4 health check must
 * catch. It is a separate reused container (the reuse hash includes the command).
 *
 * Every run works in its own database and role prefix; the name encodes the creation time
 * so a later run drops what a killed run left behind.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { GenericContainer, Wait } from 'testcontainers';
import { probePgReachable } from '@papercusp/test-config';
import { lexicalLeg } from '../rank';

const SQL_DIR = path.resolve(__dirname, '../../../../../../libs/papercusp/libs/db/sql');
const IMAGE = 'papercusp-pgts-test:1.5.1';
const STALE_RUN_MS = 2 * 60 * 60 * 1000;
// The trailing suffix is optional so databases from the earlier single-file suite age out too.
const RUN_TAG_RE = /^bm25_([0-9a-z]+)_\d+(?:_[0-9a-z]+)?$/;

/** Topic words appear in exactly one seeded work item each; "routine" appears in every item. */
export const TOPICS = ['quokka', 'marmoset', 'axolotl', 'pangolin', 'narwhal', 'okapi', 'tapir', 'wombat'] as const;

export function migration1447(): string {
  const file = readdirSync(SQL_DIR).find(f => /^1447-.*\.sql$/.test(f));
  if (!file) throw new Error('migration 1447 is not armed');
  return readFileSync(path.join(SQL_DIR, file), 'utf8');
}

/** The text of migration `number`: the armed `.sql` file, or its `.sql.DRAFT` while it is still a draft. */
export function migrationSql(number: number): string {
  const re = new RegExp(`^${number}-.*\\.sql(?:\\.DRAFT)?$`);
  const file = readdirSync(SQL_DIR).filter(f => re.test(f)).sort((a, b) => a.length - b.length)[0];
  if (!file) throw new Error(`migration ${number} is neither armed nor drafted`);
  return readFileSync(path.join(SQL_DIR, file), 'utf8');
}

export interface Bm25TestDb {
  sql: Sql;
  /** Database name; also the prefix for any role a suite creates (`${runTag}_...`). */
  runTag: string;
  connection: { host: string; port: number };
  close(): Promise<void>;
}

export interface StartBm25TestDbOptions {
  /** Preload pg_textsearch (the production configuration). Default true. */
  preload?: boolean;
  /** Connections in the returned pool. Default 2. */
  max?: number;
}

export async function startBm25TestDb(opts: StartBm25TestDbOptions = {}): Promise<Bm25TestDb> {
  const preload = opts.preload ?? true;
  const built = await GenericContainer.fromDockerfile(__dirname).build(IMAGE, { deleteOnExit: false });
  let spec = built
    .withEnvironment({ POSTGRES_HOST_AUTH_METHOD: 'trust' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(300_000)
    .withReuse();
  if (!preload) spec = spec.withCommand(['postgres']);
  const container = await spec.start();
  const connection = { host: container.getHost(), port: container.getMappedPort(5432) };
  const ready = await probePgReachable(`postgres://postgres@${connection.host}:${connection.port}/postgres`, 120_000);
  if (!ready.ok) {
    throw new Error(`pg_textsearch test container never answered SELECT 1 within ${ready.elapsedMs}ms: ${ready.lastError}`);
  }
  const base = { ...connection, user: 'postgres', onnotice: () => {} };
  const admin = postgres({ ...base, database: 'postgres', max: 1 });
  const leftovers = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE 'bm25\\_%'`;
  for (const { datname } of leftovers) {
    const m = RUN_TAG_RE.exec(datname);
    const created = m ? parseInt(m[1]!, 36) : NaN;
    if (!Number.isFinite(created) || Date.now() - created < STALE_RUN_MS) continue;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    await dropRoles(admin, datname);
  }
  // Suites run in parallel threads of one process, so pid alone does not separate them.
  const runTag = `bm25_${Date.now().toString(36)}_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
  await admin.unsafe(`CREATE DATABASE "${runTag}"`);
  const sql = postgres({ ...base, database: runTag, max: opts.max ?? 2 });
  return {
    sql,
    runTag,
    connection,
    async close() {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${runTag}" WITH (FORCE)`);
      await dropRoles(admin, runTag);
      await admin.end({ timeout: 5 });
    },
  };
}

async function dropRoles(admin: Sql, prefix: string): Promise<void> {
  const roles = await admin<{ rolname: string }[]>`
    SELECT rolname FROM pg_roles WHERE starts_with(rolname, ${`${prefix}_`})`;
  for (const { rolname } of roles) await admin.unsafe(`DROP ROLE IF EXISTS "${rolname}"`);
}

/**
 * The corpus every suite ranks: 400 work items (topic items 1..8, the rest share
 * "routine"), an empty code_recipes table, five plans, then migration 1447 exactly as armed.
 */
export async function seedBm25Corpus(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (id int PRIMARY KEY, ws text, title text, summary text, notes text);
    CREATE TABLE harness_shared.code_recipes (id int PRIMARY KEY, title text, description text);
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      template_slug text, title text, content text, status text DEFAULT 'active',
      archived boolean NOT NULL DEFAULT false, superseded_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      _search tsvector GENERATED ALWAYS AS
        (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug));
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, template_slug, title, content) VALUES
      ('ws1', 'h', 'kangaroo-plan', NULL, 'Kangaroo relocation', 'Move the kangaroo enclosure before the quarterly review.'),
      ('ws1', 'h', 'quarterly-plan', NULL, 'Budget', 'Prepare the quarterly figures for the board.'),
      ('ws1', 'h', 'other-plan', NULL, 'Unrelated', 'Nothing about marsupials here.'),
      ('ws2', 'h', 'foreign-plan', NULL, 'Kangaroo elsewhere', 'A kangaroo plan in another workspace.'),
      ('ws1', 'h', 'template-plan', 'tpl', 'Kangaroo template', 'A kangaroo template, not a plan.');
  `);
  const rows = Array.from({ length: 400 }, (_, i) => {
    const id = i + 1;
    const topic = id <= TOPICS.length ? ` about the ${TOPICS[id - 1]}` : '';
    return { id, ws: `w${id % 2}`, title: `item ${id}${topic}`, summary: `routine summary for item ${id}`, notes: null };
  });
  await sql`INSERT INTO harness_shared.work_items ${sql(rows)}`;
  await sql.unsafe(migration1447());
}

/** Work-item ids in seam order (BM25 when available), optionally within one workspace. */
export async function rankWorkItemIds(sql: Sql, query: string, ws?: string, limit = 10): Promise<number[]> {
  const leg = await lexicalLeg(sql, {
    table: 'work_items', query, alias: 'w',
    legacy: { score: sql`0::float8`, match: sql`false` },
  });
  const rows = await sql<{ id: number }[]>`
    SELECT w.id FROM harness_shared.work_items w
     WHERE ${ws ? sql`w.ws = ${ws} AND` : sql``} ${leg.match}
     ORDER BY ${leg.order}, w.id LIMIT ${limit}`;
  return rows.map(r => r.id);
}

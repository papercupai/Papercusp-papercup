/**
 * text-artifacts.integration.test.ts — the PG-canonical text-artifact store
 * (migration 035, drizzle), against a real Postgres. The disk mirror + sync are
 * seams (mocked); the SQL is real.
 *
 * Behaviors a fake-db unit test can't prove:
 *  - save→load round-trip + the `.papercusp/` rel_path normalization (a prefixed
 *    and a bare path hit the SAME row);
 *  - the (harness_slug, rel_path) upsert;
 *  - appendTextArtifact's ATOMIC PG-side `content || EXCLUDED.content` concat;
 *  - the EI-280 `adoptBlankWorkspace` guard: a save adopts the active workspace
 *    onto a BLANK-stamped legacy row, but never RE-HOMES a properly-stamped one;
 *  - delete.
 *
 * Reuses the drizzle harness from toast-log-data: `generated` stays real, a
 * drizzle(rootSql) db is injected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactPreparationStore, openBoundPreparationLedger } from '../../../scripts/lib/source-path-census.mjs';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-art';
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ db: h.db }) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
});
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { loadTextArtifact, saveTextArtifact, compareAndSwapTextArtifact, appendTextArtifact, deleteTextArtifact } = await import('./text-artifacts');
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `art_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline: updated_at bigint, workspace_id NOT NULL default '', PK (harness_slug, rel_path).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_text_artifacts (
      harness_slug text NOT NULL,
      rel_path text NOT NULL,
      content text DEFAULT '' NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      workspace_id text DEFAULT '' NOT NULL,
      CONSTRAINT harness_text_artifacts_pkey PRIMARY KEY (harness_slug, rel_path)
    )`);
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_text_artifacts`;
});

const wsOf = async (slug: string, key: string) =>
  (await rootSql<{ workspace_id: string }[]>`SELECT workspace_id FROM harness_shared.harness_text_artifacts WHERE harness_slug=${slug} AND rel_path=${key}`)[0]?.workspace_id;

describe('text-artifacts (drizzle, PG)', () => {
  it('save → load round-trips, null when absent', async () => {
    expect(await loadTextArtifact('web', 'notes.md')).toBeNull();
    await saveTextArtifact('web', 'notes.md', 'hello');
    expect(await loadTextArtifact('web', 'notes.md')).toBe('hello');
  });

  it('normalizes the `.papercusp/` prefix — a prefixed write and a bare read hit the same row', async () => {
    await saveTextArtifact('web', '.papercusp/memory/a.md', 'X');
    expect(await loadTextArtifact('web', 'memory/a.md')).toBe('X'); // bare read
    expect(await loadTextArtifact('web', '.papercusp/memory/a.md')).toBe('X'); // prefixed read, same row
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web'`).toHaveLength(1);
  });

  it('save upserts on (harness_slug, rel_path) — second write overwrites, one row', async () => {
    await saveTextArtifact('web', 'f.md', 'v1');
    await saveTextArtifact('web', 'f.md', 'v2');
    expect(await loadTextArtifact('web', 'f.md')).toBe('v2');
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web' AND rel_path='f.md'`).toHaveLength(1);
  });
  it('CAS has exactly one winner for concurrent create and stale-content update', async () => {
    const created = await Promise.all(['A', 'B'].map(value => compareAndSwapTextArtifact('web', 'cas.json', null, value)));
    expect(created.filter(Boolean)).toHaveLength(1);
    const old = await loadTextArtifact('web', 'cas.json');
    const updated = await Promise.all(['C', 'D'].map(value => compareAndSwapTextArtifact('web', '.papercusp/cas.json', old, value)));
    expect(updated.filter(Boolean)).toHaveLength(1);
    expect(await compareAndSwapTextArtifact('web', 'missing.json', 'absent', 'X')).toBe(false);
    expect(await loadTextArtifact('web', 'missing.json')).toBeNull();
  });
  it('CAS refuses a foreign workspace row and preserves its content', async () => {
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, workspace_id) VALUES ('web','foreign.json','old','other-ws')`;
    expect(await compareAndSwapTextArtifact('web', 'foreign.json', 'old', 'new')).toBe(false);
    expect(await loadTextArtifact('web', 'foreign.json')).toBe('old');
  });

  it('append ATOMICALLY concatenates via PG `content || EXCLUDED.content`', async () => {
    await appendTextArtifact('web', 'log.md', 'A'); // insert
    await appendTextArtifact('web', 'log.md', 'B'); // concat
    await appendTextArtifact('web', 'log.md', 'C');
    expect(await loadTextArtifact('web', 'log.md')).toBe('ABC');
  });

  it('delete removes the row', async () => {
    await saveTextArtifact('web', 'gone.md', 'x');
    await deleteTextArtifact('web', 'gone.md');
    expect(await loadTextArtifact('web', 'gone.md')).toBeNull();
  });

  it('EI-280: a save ADOPTS the active workspace onto a blank-stamped row, but does NOT re-home a stamped one', async () => {
    // blank legacy row → adopted
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','blank.md','old',1,'')`;
    await saveTextArtifact('web', 'blank.md', 'new');
    expect(await wsOf('web', 'blank.md')).toBe(WS); // adopted the operator workspace

    // properly-stamped row → left alone
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','owned.md','old',1,'other-ws')`;
    await saveTextArtifact('web', 'owned.md', 'new');
    expect(await wsOf('web', 'owned.md')).toBe('other-ws'); // NOT re-homed to WS
  });
});

describe('preparation ledger with canonical PG artifacts and real fixture descriptors', () => {
  let root: string;
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const options = { attemptId: 'fixture-attempt', candidate: 'fixture-candidate', clockId: 'fixture-boot', baseline: ['known.ts'] };
  const store = () => createArtifactPreparationStore({ slug: 'web', relPath: 'method/fixture-ledger.json',
    loadTextArtifact, compareAndSwapTextArtifact });
  const manifest = (text = 'abc') => ({ candidate: options.candidate, inputs: { 'known.ts': digest(text) } });
  beforeEach(async () => {
    root = await actualFs.realpath(await actualFs.mkdtemp(join(tmpdir(), 'preparation-fixture-')));
    await actualFs.writeFile(join(root, 'known.ts'), 'abc');
  });
  afterEach(async () => { await actualFs.rm(root, { recursive: true, force: true }); });
  it('restarts from PG and debits actual repeated file reads across adapter instances', async () => {
    const config = { ...options, maxBytes: 6 };
    const first = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    expect((await first.read('known.ts')).data.toString()).toBe('abc');
    const resumed = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await resumed.read('known.ts');
    await expect(resumed.read('known.ts')).rejects.toThrow('byte-limit');
    const stopped = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    expect(stopped.report()).toMatchObject({ status: 'STOPPED', bytesRead: 6, executionAdmitted: false });
    await expect(stopped.read('known.ts')).rejects.toThrow('byte-limit');
  });
  it('blocks stale real-store openers before filesystem access', async () => {
    const first = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    const stale = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await first.read('known.ts');
    await actualFs.rm(root, { recursive: true });
    await expect(stale.read('known.ts')).rejects.toThrow('attempt-state-conflict');
  });
  it('persists input61 refusal and never reaches a removed fixture root, even after restart', async () => {
    const config = { ...options, priorAdditions: Array.from({ length: 60 }, (_, i) => `prefix/${i}`) };
    const first = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await actualFs.rm(root, { recursive: true });
    await expect(first.read('input61.ts')).rejects.toThrow('input-limit');
    const resumed = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await expect(resumed.read('known.ts')).rejects.toThrow('input-limit');
    expect(resumed.snapshot().bytesRead).toBe(0);
  });
  it('rejects candidate, root and input-manifest changes instead of resetting a persisted attempt', async () => {
    await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await expect(openBoundPreparationLedger(options, { store: store(), root, manifest: { ...manifest(), candidate: 'other' } })).rejects.toThrow('candidate-source-binding');
    await expect(openBoundPreparationLedger(options, { store: store(), root: root + '-other', manifest: manifest() })).rejects.toThrow('snapshot/configuration');
    await expect(openBoundPreparationLedger(options, { store: store(), root, manifest: manifest('xyz') })).rejects.toThrow('snapshot/configuration');
    await expect(openBoundPreparationLedger({ ...options, attemptId: 'fresh-counter' }, { store: store(), root, manifest: manifest() })).rejects.toThrow('attempt-artifact-binding');
  });
  it('refuses missing input pins and records a terminal stop before reading the file', async () => {
    const ledger = await openBoundPreparationLedger(options, { store: store(), root, manifest: { ...manifest(), inputs: {} } });
    await expect(ledger.read('known.ts')).rejects.toThrow('candidate-input-unbound');
    expect(ledger.snapshot().bytesRead).toBe(0);
    expect((await store().load(options.attemptId))?.snapshot.status).toBe('STOPPED');
  });
  it('refuses a symlink alias to bytes with the correct digest before any payload read', async () => {
    await actualFs.symlink('known.ts', join(root, 'alias.ts'));
    const ledger = await openBoundPreparationLedger(options, { store: store(), root,
      manifest: { ...manifest(), inputs: { 'alias.ts': digest('abc') } } });
    await expect(ledger.read('alias.ts')).rejects.toThrow('input-path-alias');
    expect(ledger.snapshot().bytesRead).toBe(0);
  });
  it('charges real bytes and retains terminal failure when candidate content drifts', async () => {
    const ledger = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await actualFs.writeFile(join(root, 'known.ts'), 'xyz');
    await expect(ledger.read('known.ts')).rejects.toThrow('input-digest-drift');
    expect(ledger.snapshot()).toMatchObject({ bytesRead: 3, status: 'STOPPED' });
  });
});

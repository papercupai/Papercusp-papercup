/** Real PG + production adapter; the language connection is the only protocol test double. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshTestDb } from '@papercusp/test-config/pg';
import { pinModuleState } from '@papercusp/module-singleton';

const holder = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!holder.sql) throw new Error('capability PG unavailable'); return { sql: holder.sql }; },
}));
import {
  initializeCapabilityObservations, PgLspCapabilityStore, requestWithLspCapability,
  type LspCapabilityKey,
} from './lsp-capability-matrix';
import {
  lspDiagnostics, lspQuery, lspRenamePreview, lspRenameWorkspaceEdit,
  lspWorkspaceSymbols, type LspReadinessIntent, type prepareIntentReadiness,
} from './lsp-adapter';
import { isTrustworthyEmpty } from './contracts';

type Client = Parameters<typeof prepareIntentReadiness>[0];
const state = pinModuleState<{ clients: Map<string, Client> }>(
  '@papercusp/operator-core.code-intelligence.lsp-adapter', () => ({ clients: new Map() }),
);
const identity = 'a'.repeat(64);
let sql: postgres.Sql;
let drop: (() => Promise<unknown>) | undefined;
let root: string, file: string, client: Client;
let store: PgLspCapabilityStore;
const key = (intent: LspReadinessIntent, serverIdentity = identity): LspCapabilityKey => ({ language: 'typescript', intent, serverIdentity });
const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');

beforeAll(async () => {
  const db = await createFreshTestDb({ prefix: 'lsp_caps' });
  drop = db.drop;
  sql = postgres(db.url, { max: 4, prepare: false, onnotice: () => {} });
  holder.sql = sql;
  await sql.unsafe('CREATE SCHEMA harness_shared');
  const migration = join(SQL_DIR, '1361-lsp-capability-matrix.sql');
  const body = readFileSync(migration, 'utf8');
  await sql.unsafe(body);
  // Real re-apply is the migration's idempotence check.
  await sql.unsafe(body);
  store = new PgLspCapabilityStore(() => sql);
}, 120_000);

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.lsp_capabilities`;
  root = mkdtempSync(join(tmpdir(), 'lsp-caps-adapter-'));
  file = join(root, 'example.ts');
  writeFileSync(file, 'export const thing = 1;\n');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  const stamp = statSync(file);
  client = {
    language: 'typescript', rootPath: root, rootUri: pathToFileURL(root).href,
    capabilityServerIdentity: identity, health: 'healthy', lastError: null, startedAt: Date.now(),
    coldStartMs: 0, taskId: 'test-only', child: { pid: undefined, exitCode: null, killed: false },
    connection: { sendRequest: vi.fn(async () => [{ uri: pathToFileURL(file).href, range: { start: { line: 0 } } }]), sendNotification: vi.fn() },
    openDocs: new Map([[pathToFileURL(file).href, { mtimeMs: stamp.mtimeMs, size: stamp.size }]]),
    diagnostics: new Map(), pendingProgress: new Set(), idleSince: Date.now() - 10_000,
    everSettled: true, quiescent: true, progressGeneration: 0, canaryReadiness: new Map(),
    certifiedReadiness: new Set(['definition', 'references', 'implementations', 'rename-preview', 'diagnostics', 'symbol-search']),
    unprovenReadiness: new Set(),
  } as unknown as Client;
  state.clients.set(`typescript::${root}`, client);
});
afterEach(() => {
  state.clients.delete(`typescript::${root}`);
  if (root) rmSync(root, { recursive: true, force: true });
  holder.sql = sql;
});
afterAll(async () => { holder.sql = undefined; await sql?.end({ timeout: 5 }); await drop?.(); });

describe('fleet-wide capability persistence', () => {
  it('retains observed MethodNotFound across a new store/client and refuses without another request', async () => {
    vi.mocked(client.connection.sendRequest).mockRejectedValueOnce({ code: -32601, message: 'unsupported' });
    const args = { file, rootPath: root, line1: 1, character: 13 };
    const first = await lspQuery('references', args);
    expect(first.error).toMatch(/does not support.*references/);
    expect(first.freshness.health).not.toBe('healthy');
    expect(isTrustworthyEmpty(first)).toBe(true); // Loud refusal, never a clean absence.
    expect(await new PgLspCapabilityStore(() => sql).get(key('references'))).toMatchObject({ supported: false, source: 'method-not-found' });
    client.connection.sendRequest = vi.fn(async () => []);
    const second = await lspQuery('references', args);
    expect(second.error).toMatch(/does not support/);
    expect(client.connection.sendRequest).not.toHaveBeenCalled();
  });

  it('does not let concurrent initialize declarations or successful in-flight calls erase a learned refusal', async () => {
    await store.observe({ ...key('references'), supported: false, source: 'method-not-found', evidence: '-32601' });
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.observe({ ...key('references'), supported: true,
      source: i % 2 ? 'initialize' : 'request-success', evidence: 'referencesProvider' })));
    expect(await store.get(key('references'))).toMatchObject({ supported: false, source: 'method-not-found' });
    const upgraded = key('references', 'b'.repeat(64));
    const request = vi.fn(async () => []);
    await expect(requestWithLspCapability(new PgLspCapabilityStore(() => sql), upgraded, 'textDocument/references', request)).resolves.toEqual([]);
    expect(await store.get(upgraded)).toMatchObject({ supported: true });
    expect(request).toHaveBeenCalledOnce();
  });

  it('preserves unknown support on a timeout and permits the next valid response', async () => {
    vi.mocked(client.connection.sendRequest).mockRejectedValueOnce(new Error('request timed out'));
    const args = { file, rootPath: root, line1: 1, character: 13 };
    expect((await lspQuery('references', args)).error).toBe('request timed out');
    expect(await store.get(key('references'))).toBeNull();
    const answer = await lspQuery('references', args);
    expect(answer.error).toBeNull(); expect(answer.sites).toHaveLength(1);
    expect(await store.get(key('references'))).toMatchObject({ supported: true, source: 'request-success' });
  });

  it('declares request support independently per intent and keeps readiness responsible for completeness', async () => {
    await Promise.all(initializeCapabilityObservations('typescript', identity, { definitionProvider: true })
      .map(o => store.observe(o)));
    const args = { file, rootPath: root, line1: 1, character: 13 };
    expect((await lspQuery('references', args)).error).toMatch(/does not support/);
    client.certifiedReadiness.clear();
    client.quiescent = null;
    vi.mocked(client.connection.sendRequest).mockResolvedValueOnce([]);
    const empty = await lspQuery('definition', args);
    expect(empty.error).toMatch(/readiness.*not certified/);
    expect(empty.freshness.health).toBe('degraded');
    expect(await store.get(key('definition'))).toMatchObject({ supported: true, source: 'request-success' });
  });

  it('guards symbols and both rename paths, and learns diagnostics only from an actual push', async () => {
    for (const intent of ['symbol-search', 'rename-preview'] as const)
      await store.observe({ ...key(intent), supported: false, source: 'method-not-found', evidence: '-32601' });
    const args = { file, rootPath: root, line1: 1, character: 13, newName: 'other' };
    expect((await lspWorkspaceSymbols({ name: 'thing', rootPath: root, language: 'typescript', anchor: file })).error).toMatch(/does not support/);
    expect((await lspRenamePreview(args)).error).toMatch(/does not support/);
    expect(await lspRenameWorkspaceEdit(args)).toMatchObject({ ok: false, error: expect.stringMatching(/does not support/) });
    expect(client.connection.sendRequest).not.toHaveBeenCalled();
    client.diagnostics.set(pathToFileURL(file).href, { receivedAt: Date.now(), diags: [] });
    expect((await lspDiagnostics({ file, rootPath: root })).error).toBeNull();
    expect(await store.get(key('diagnostics'))).toMatchObject({ supported: true, source: 'publish' });
  });

  it('returns an explicit unhealthy answer when capability persistence is unavailable', async () => {
    holder.sql = undefined;
    const answer = await lspQuery('definition', { file, rootPath: root, line1: 1, character: 13 });
    expect(answer.error).toBe('capability PG unavailable');
    expect(answer.freshness.health).toBe('unhealthy');
    expect(client.connection.sendRequest).not.toHaveBeenCalled();
  });
});

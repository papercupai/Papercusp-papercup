import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Sql } from 'postgres';
import { configureBackup } from './config';
import { startKopiaServer, stopKopiaServer } from './server';

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'readonly-test-password' }));

const binary = process.env.KOPIA_BIN ?? 'kopia';
const installed = spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0;
let root: string;
let env: NodeJS.ProcessEnv;

function kopia(args: string[]): string {
  const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`kopia ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

describe.skipIf(!installed)('embedded Kopia explorer retention boundary', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kopia-readonly-'));
    const backups = join(root, 'ws', 'backups');
    await mkdir(backups, { recursive: true });
    env = { ...process.env, KOPIA_PASSWORD: 'readonly-test-password',
      KOPIA_CONFIG_PATH: join(backups, 'repository.config'),
      KOPIA_LOG_DIR: join(backups, 'logs'), KOPIA_CACHE_DIRECTORY: join(backups, 'cache') };
    configureBackup({ getSql: () => (() => Promise.resolve([])) as unknown as Sql,
      workspacesRoot: () => root, ensureSchema: async () => {},
      getHarnessAdminUrl: () => ({ url: 'postgres://test', source: 'test' }) });
    kopia(['repository', 'create', 'filesystem', '--path', join(backups, 'repo')]);
  }, 60_000);

  afterEach(async () => {
    stopKopiaServer('ws');
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('allows browsing but refuses snapshot deletion without losing the historical bytes', async () => {
    const data = join(root, 'data');
    await mkdir(data);
    await writeFile(join(data, 'held.txt'), 'historical held bytes');
    const snapshot = JSON.parse(kopia(['snapshot', 'create', data, '--json']));
    const server = await startKopiaServer('ws');
    const filter = new URLSearchParams(snapshot.source);
    const list = await fetch(`${server.url}api/v1/snapshots?${filter}`);
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(snapshot.id);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const deletion = await fetch(`${server.url}api/v1/snapshots/delete`, {
        method, headers: { 'content-type': 'application/json', 'x-http-method-override': 'GET' },
        body: JSON.stringify({ source: snapshot.source, snapshotManifestIds: [snapshot.id] }),
      });
      expect(deletion.status).toBe(403);
    }
    const getDeletion = await fetch(`${server.url}api/v1/snapshots/delete`);
    expect(getDeletion.ok).toBe(false);
    // Kopia registers this API as GET-only; HEAD is forwarded and returns its
    // ordinary 404, rather than the proxy's 403 for mutation methods.
    expect((await fetch(`${server.url}api/v1/snapshots?${filter}`, { method: 'HEAD' })).status).toBe(404);
    expect(JSON.parse(kopia(['snapshot', 'list', '--all', '--json'])).map((s: { id: string }) => s.id))
      .toContain(snapshot.id);
    const restored = join(root, 'restored');
    kopia(['snapshot', 'restore', snapshot.rootEntry.obj, restored]);
    expect(await readFile(join(restored, 'held.txt'), 'utf8')).toBe('historical held bytes');
  }, 60_000);
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ operatorEnvFile: '', create: vi.fn() }));
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOSClient: { create: fixture.create } }));
vi.mock('@papercusp/module-singleton', () => ({
  pinModuleState: (_key: string, factory: () => unknown) => factory(),
}));
vi.mock('./bootstrap', () => ({ withDbosIdleTxGrace: (url: string) => url }));
vi.mock('@papercusp/db-org/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org/connection')>();
  return {
    ...actual,
    adminUrl: () => actual.adminUrl({
      operatorEnvironmentFile: fixture.operatorEnvFile,
      isPortServed: () => true,
    }),
  };
});

let home = '';
beforeEach(() => {
  vi.resetModules();
  fixture.create.mockReset().mockResolvedValue({});
  home = mkdtempSync(join(tmpdir(), 'primary-dbos-target-'));
  vi.stubEnv('PAPERCUSP_HOME', home);
  for (const key of ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL',
    'PAPERCUSP_PG_URL', 'PAPERCUSP_PG_PORT', 'PAPERCUSP_SKIP_PG_DISCOVERY']) {
    vi.stubEnv(key, undefined);
  }
  mkdirSync(join(home, 'operator'));
  fixture.operatorEnvFile = join(home, 'operator', '.env.local');
  writeFileSync(fixture.operatorEnvFile,
    'DATABASE_URL=postgresql://harness_admin:operator-secret@127.0.0.1:5432/papercusp\n');
  writeFileSync(join(home, 'embedded-pg.json'), JSON.stringify({
    url: 'postgresql://harness_admin:desktop-secret@127.0.0.1:55101/papercusp',
    port: 55101, pid: process.pid, startedAt: 'controlled-test-fixture',
  }));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('primary DBOS database target', () => {
  it('enqueues on the operator database even when a different live desktop database is advertised', async () => {
    const { getPrimaryDbosClient } = await import('./primary-dbos-client');
    await getPrimaryDbosClient();
    expect(fixture.create).toHaveBeenCalledWith({
      systemDatabaseUrl: 'postgresql://harness_admin:operator-secret@127.0.0.1:5432/papercusp',
      systemDatabaseSchemaName: 'dbos',
    });
  });
});

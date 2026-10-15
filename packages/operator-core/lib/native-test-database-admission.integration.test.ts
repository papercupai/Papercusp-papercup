import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startEmbeddedPostgresServer } from '../../../libs/papercusp/packages/embedded-postgres-server/src/index.js';
import { SHARED_TEST_PG_DURABILITY_OFF } from '@papercusp/test-config/pg';
import { nativeTestDatabaseEnvironment } from '../../../scripts/tauri-surface-verify-reports.mts';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

describe('native test PG admission against the actual private postmaster', () => {
  it('reproduces the protected-target refusal, admits the owned server and still refuses another captured target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-tauri-headless.'));
    const privateHome = join(root, 'papercusp-home');
    mkdirSync(privateHome);
    const dataDir = join(root, 'isolated-pgdata');
    let pg: Awaited<ReturnType<typeof startEmbeddedPostgresServer>> | undefined;
    try {
      const port = await freePort();
      pg = await startEmbeddedPostgresServer({ dataDir, port,
        // The shared constant is `-c key=value` argv; this server takes a settings record.
        extraPostgresSettings: Object.fromEntries(SHARED_TEST_PG_DURABILITY_OFF
          .filter((arg) => arg !== '-c')
          .map((arg) => arg.split('=') as [string, string])) });
      const foreign = 'postgresql://unused@localhost:1/papercusp';
      const env = { ...process.env, PAPERCUSP_HOME: privateHome,
        PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', VERIFY_TAURI_PID: String(process.pid),
        PAPERCUSP_SKIP_PG_DISCOVERY: '1', PAPERCUSP_PG_PORT: String(port),
        HARNESS_ADMIN_DATABASE_URL: pg.urls.admin, DATABASE_URL: foreign };
      const profile = { tauriPID: process.pid, nativeTmpDir: root, workspaceId: 'verify-tauri-isolated-90' };
      const admitted = nativeTestDatabaseEnvironment(profile, env);
      expect(new URL(admitted.PAPERCUSP_TEST_PG_ADMIN_URL!).port).toBe(String(port));
      for (const [key, value] of Object.entries(env)) if (value !== undefined) vi.stubEnv(key, value);
      vi.stubEnv('PAPERCUSP_PGBOUNCER', '0');

      const initialize = async (testUrl: string) => {
        vi.stubEnv('PAPERCUSP_TEST_PG_ADMIN_URL', testUrl);
        vi.stubEnv('PAPERCUSP_LIVE_PG_GUARD_INITIALIZED', '0');
        vi.resetModules();
        await import('../../../libs/test-config/src/setup-no-live-pg');
        return import('../../../libs/papercusp/libs/db/src/connection');
      };
      const refused = await initialize('');
      expect(() => refused.createDedicatedOrgPg('native-admission-repro')).toThrow(/protected live Postgres target/);
      const allowed = await initialize(admitted.PAPERCUSP_TEST_PG_ADMIN_URL!);
      expect(process.env.PAPERCUSP_FORBID_LIVE_PG).toBe('1');
      const { sql } = allowed.createDedicatedOrgPg('native-admission-proof', { max: 1 });
      try {
        const [row] = await sql.unsafe("SELECT inet_server_port() AS port, current_database() AS database, current_setting('data_directory') AS data_dir");
        expect(row).toEqual({ port, database: 'papercusp', data_dir: dataDir });
      } finally { await sql.end({ timeout: 5 }); }
      vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', foreign);
      vi.resetModules();
      const stillProtected = await import('../../../libs/papercusp/libs/db/src/connection');
      expect(() => stillProtected.createDedicatedOrgPg('native-admission-foreign')).toThrow(/protected live Postgres target/);
      expect(JSON.parse(process.env.PAPERCUSP_SAFE_TEST_PG_ENDPOINTS!)).toEqual([
        { host: 'localhost', port: String(port) },
      ]);
    } finally {
      if (pg) await pg.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});

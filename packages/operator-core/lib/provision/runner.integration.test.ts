/**
 * runner.integration.test.ts
 *
 * Proves runPhase end-to-end against a real Postgres testcontainer
 * (state + audit are PG-backed since migration 026; only the per-run
 * scratch dir touches the filesystem):
 *   - script-found / not-found + path-traversal guard
 *   - consent gating (with the consent-rejected audit row)
 *   - hash decision flow (fresh vs unchanged)
 *   - success/failure state updates persisted to provision_state
 *   - record_resource FIFO writes folded into createdResources
 *   - the setup-started/-succeeded/-failed audit trail
 *
 * Mirrors operator-conversation-compaction.integration.test.ts's setup
 * (getOrgPg → drizzle over a per-test database). Sandbox is disabled
 * (PAPERCUSP_DISABLE_SANDBOX) — sandbox argv construction has its own
 * unit suite in sandbox.test.ts.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-provision-runner-test';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  db: undefined as unknown,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: h.db }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { runPhase } = await import('./runner');
const { readState } = await import('./state-store');
const { readAudit } = await import('./audit-log');

let rootSql: postgres.Sql;
let TMP_HOME: string;
let TMP_PLUGIN: string;

beforeAll(async () => {
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  const adminUri = await getTestPg();
  const dbName = `pr_${randomBytes(5).toString('hex')}`;
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
  // Baseline shapes (000-baseline.sql ~:2317 / ~:2337) — verbatim.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.provision_state (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plugin_slug text NOT NULL,
      payload jsonb NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      CONSTRAINT provision_state_pkey PRIMARY KEY (workspace_id, harness_slug, plugin_slug)
    );
    CREATE TABLE harness_shared.provision_audit_log (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plugin_slug text NOT NULL,
      ts timestamp with time zone DEFAULT now() NOT NULL,
      kind text NOT NULL,
      run_id text,
      data jsonb
    );
  `);
  h.sql = rootSql;
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  delete process.env.PAPERCUSP_DISABLE_SANDBOX;
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-runner-'));
  TMP_PLUGIN = await fs.mkdtemp(join(tmpdir(), 'paperplug-'));
  process.env.PAPERCUSP_HOME = TMP_HOME; // scratch dir lives under provisionDir
  await rootSql`DELETE FROM harness_shared.provision_state`;
  await rootSql`DELETE FROM harness_shared.provision_audit_log`;
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
  await fs.rm(TMP_PLUGIN, { recursive: true, force: true });
});

async function writeScript(rel: string, contents: string): Promise<string> {
  const full = join(TMP_PLUGIN, rel);
  await fs.mkdir(join(full, '..'), { recursive: true });
  await fs.writeFile(full, contents, { mode: 0o755 });
  return rel;
}

describe('runPhase (PG-backed)', () => {
  it.runIf(process.platform === 'linux')('enforces the real provision command egress allowlist without losing filesystem isolation', async () => {
    // Real endpoints and raw controls distinguish confinement from an absent
    // service. No sandbox/SRT mocks and no network dependency outside this host.
    const calls = [0, 0];
    const servers = calls.map((_, i) => createServer((_req, res) => {
      calls[i]++;
      res.end(`fixture-${i}`);
    }));
    const listen = (server: Server) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const project = join(TMP_PLUGIN, 'project');
    const hidden = join(TMP_HOME, 'host-only.txt');
    await fs.mkdir(project);
    await fs.writeFile(hidden, 'host-only-sentinel');
    try {
      const [allowed, denied] = await Promise.all(servers.map(listen));
      const url = (port: number) => `http://127.0.0.1:${port}`;
      const curl = '/usr/bin/curl --silent --show-error --fail --max-time 3';
      for (const port of [allowed, denied]) {
        expect((await promisify(execFile)('/usr/bin/curl', ['--noproxy', '*', '--fail', '--max-time', '3', url(port)])).stdout)
          .toBe(port === allowed ? 'fixture-0' : 'fixture-1');
      }
      await writeScript('setup.sh', `#!/bin/bash
set -eu
${curl} ${quote(url(allowed))} > "$PAPERCUSP_SCRATCH_DIR/allowed.txt"
if ${curl} ${quote(url(denied))}; then echo DENIED_ENDPOINT_REACHED; exit 42; fi
if ${curl} --noproxy '*' ${quote(url(allowed))}; then echo RAW_SOCKET_REACHED; exit 43; fi
if printf bad > "$PAPERCUSP_PLUGIN_DIR/forbidden-write"; then exit 44; fi
if /bin/cat ${quote(hidden)}; then exit 45; fi
printf project-writable > "$PAPERCUSP_PROJECT_DIR/output.txt"
`);
      delete process.env.PAPERCUSP_DISABLE_SANDBOX;
      delete process.env.PAPERCUSP_ALLOW_NO_SANDBOX;
      const result = await runPhase('setup', {
        harness: 'h', plugin: 'p', publisher: 'fixture', pluginVersion: '1.0.0',
        pluginDir: TMP_PLUGIN, projectDir: project, config: {}, consentConfirmed: true,
        provision: { setup: { path: 'setup.sh', timeoutSec: 20 }, allowedHosts: [`127.0.0.1:${allowed}`] },
      });
      const audit = await readAudit('h', 'p');
      expect(result.ok, JSON.stringify({ result, audit })).toBe(true);
      expect(calls).toEqual([2, 1]); // only controls + the allowed sandbox request
      expect(await fs.readFile(join(project, 'output.txt'), 'utf8')).toBe('project-writable');
      expect(audit.some(e => e.kind === 'sandbox-bypass')).toBe(false);
    } finally {
      process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
      await Promise.all(servers.map(server => server.listening
        ? new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
        : Promise.resolve()));
    }
  }, 45_000);

  it('reports missing script gracefully', async () => {
    const r = await runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'does/not/exist.sh' } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('rejects when consent not confirmed, and audits the rejection', async () => {
    await writeScript('setup.sh', '#!/bin/bash\nexit 0\n');
    const r = await runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'setup.sh' } },
      consentConfirmed: false,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('consent');
    const audit = await readAudit('h', 'p');
    expect(audit.map((e) => e.kind)).toContain('consent-rejected');
  });

  it('runs setup, persists state to PG, and writes the audit trail', async () => {
    await writeScript(
      'setup.sh',
      `#!/usr/bin/env bash
echo "setting up"
exit 0
`,
    );
    const r = await runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: { region: 'us-east-1' },
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.state?.hashes).toBeTruthy();
    expect(r.state?.lastSetupAt).not.toBeNull();

    // The state row is in PG, not a file — a fresh read sees it.
    const persisted = await readState('h', 'p');
    expect(persisted.hashes).toEqual(r.state?.hashes);
    expect(persisted.lastSetupAt).toBe(r.state?.lastSetupAt);

    const kinds = (await readAudit('h', 'p')).map((e) => e.kind);
    expect(kinds).toContain('setup-started');
    expect(kinds).toContain('setup-succeeded');
    expect(kinds).toContain('script-output'); // "setting up" captured
  }, 30_000);

  it('returns unchanged on second run with same hashes', async () => {
    await writeScript('setup.sh', '#!/usr/bin/env bash\nexit 0\n');
    const inputs = {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: { region: 'us-east-1' },
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    };
    await runPhase('setup', inputs);
    const r = await runPhase('setup', inputs);
    expect(r.decision).toBe('unchanged');
    expect(r.ok).toBe(true);
  }, 30_000);

  it('captures script failure exit code and persists setupFailed', async () => {
    await writeScript('setup.sh', '#!/usr/bin/env bash\nexit 7\n');
    const r = await runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.state?.setupFailed).toBe(true);
    expect((await readState('h', 'p')).setupFailed).toBe(true);
    expect((await readAudit('h', 'p')).map((e) => e.kind)).toContain('setup-failed');
  }, 30_000);

  it('rejects path-traversal in the script declaration', async () => {
    const r = await runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: '../../etc/passwd' } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('folds record_resource FIFO writes into createdResources + audit', async () => {
    await writeScript(
      'setup.sh',
      `#!/usr/bin/env bash
. "$PAPERCUSP_RUNTIME_LIB"
papercusp_record_resource "test.kind" "id-1"
exit 0
`,
    );
    const r = await runPhase('setup', {
      harness: 'h',
      plugin: 'p',
      publisher: 'X',
      pluginVersion: '1.0.0',
      pluginDir: TMP_PLUGIN,
      config: {},
      provision: { setup: { path: 'setup.sh', timeoutSec: 10 } },
      consentConfirmed: true,
    });
    expect(r.ok).toBe(true);
    const ids = (r.state?.createdResources ?? []).map((x) => x.externalId);
    expect(ids).toContain('id-1');
    // And the resource survived into the PG row + audit log.
    const persisted = await readState('h', 'p');
    expect(persisted.createdResources.map((x) => x.externalId)).toContain('id-1');
    expect((await readAudit('h', 'p')).map((e) => e.kind)).toContain('resource-recorded');
  }, 30_000);
});

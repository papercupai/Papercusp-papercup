/**
 * render-templates.integration.test.ts
 *
 * End-to-end proof of the template-render primitive against a real
 * Postgres testcontainer (state + audit are PG-backed since migration
 * 026): synthesize a plugin whose setup.sh exercises USER_VAR_*
 * flattening, OUTPUT_* exports, papercusp_record_resource,
 * papercusp_state_set and papercusp_render_templates, run it through
 * runPhase with a real bash, and verify:
 *   - *.tmpl files in projectDir get rendered with substituted values
 *   - .tmpl files are removed after render
 *   - skip-dirs (.git, node_modules) are honoured
 *   - recorded resources + outputs land in the PG-backed state
 *   - zero-template and missing-projectDir runs exit cleanly
 *
 * Mirrors runner.integration.test.ts's setup (getOrgPg → drizzle over a
 * per-test database; sandbox disabled — argv construction has its own
 * unit suite in sandbox.test.ts). Skips on non-Linux (the runner uses
 * bash; the helpers assume GNU envsubst).
 */
import { promises as fs } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const isLinux = platform() === 'linux';

const WS = 'ws-provision-render-test';

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

let rootSql: postgres.Sql;
let TMP_HOME: string;
let TMP_PLUGIN: string;
let TMP_PROJECT: string;

beforeAll(async () => {
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  const adminUri = await getTestPg();
  const dbName = `rt_${randomBytes(5).toString('hex')}`;
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
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-render-'));
  TMP_PLUGIN = await fs.mkdtemp(join(tmpdir(), 'paperplug-render-'));
  TMP_PROJECT = await fs.mkdtemp(join(tmpdir(), 'paperproj-render-'));
  process.env.PAPERCUSP_HOME = TMP_HOME; // scratch dir lives under provisionDir
  await rootSql`DELETE FROM harness_shared.provision_state`;
  await rootSql`DELETE FROM harness_shared.provision_audit_log`;
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
  await fs.rm(TMP_PLUGIN, { recursive: true, force: true });
  await fs.rm(TMP_PROJECT, { recursive: true, force: true });
});

async function writeSetupScript(contents: string): Promise<void> {
  await fs.mkdir(join(TMP_PLUGIN, 'provision'), { recursive: true });
  const scriptPath = join(TMP_PLUGIN, 'provision', 'setup.sh');
  await fs.writeFile(scriptPath, contents, { mode: 0o755 });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch { return false; }
}

const SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"

# Read flattened user vars
papercusp_progress "step:read" "got USER_VAR_PROJECT_NAME=$USER_VAR_PROJECT_NAME"
papercusp_progress "step:read" "got USER_VAR_REGION=$USER_VAR_REGION"

# Record fake resources
papercusp_record_resource "synthetic.thing" "thing-123"
papercusp_record_resource "synthetic.other" "other-456"

# Set outputs that .tmpl files reference
papercusp_state_set "computedId" "\\"$USER_VAR_PROJECT_NAME-final\\""
papercusp_state_set "computedRegion" "\\"$USER_VAR_REGION\\""

# Export the same values to the script's env so envsubst can see them
export OUTPUT_computedId="$USER_VAR_PROJECT_NAME-final"
export OUTPUT_computedRegion="$USER_VAR_REGION"

# Render templates
papercusp_render_templates

# Brief delay so the runner's FIFO tail catches up before the script
# exits — matches the pattern in runner.integration.test.ts.
sleep 0.4
`;

describe('render-templates end-to-end (PG-backed runPhase)', () => {
  it.skipIf(!isLinux)('flattens USER_VAR_*, runs setup.sh, renders .tmpl files', async () => {
    await writeSetupScript(SCRIPT);

    // Set up project dir with templates + skip-dirs
    await fs.writeFile(
      join(TMP_PROJECT, 'wrangler.toml.tmpl'),
      `name = "\${OUTPUT_computedId}"\nregion = "\${OUTPUT_computedRegion}"\nproject = "\${USER_VAR_PROJECT_NAME}"\n`,
    );
    await fs.writeFile(
      join(TMP_PROJECT, '.env.production.tmpl'),
      `PUBLIC_NAME=\${USER_VAR_PROJECT_NAME}\n`,
    );
    // Should be skipped:
    await fs.mkdir(join(TMP_PROJECT, 'node_modules'), { recursive: true });
    await fs.writeFile(join(TMP_PROJECT, 'node_modules', 'fake.tmpl'), 'should not be rendered');
    await fs.mkdir(join(TMP_PROJECT, '.git'), { recursive: true });
    await fs.writeFile(join(TMP_PROJECT, '.git', 'config.tmpl'), 'should not be rendered');

    const result = await runPhase('setup', {
      harness: 'test-harness',
      plugin: 'synthetic-plugin',
      publisher: '@test',
      pluginVersion: '0.1.0',
      pluginDir: TMP_PLUGIN,
      projectDir: TMP_PROJECT,
      config: {
        projectName: 'demo',
        region: 'us-east-1',
      },
      provision: {
        setup: { path: 'provision/setup.sh', timeoutSec: 30 },
      },
      consentConfirmed: true,
    });

    if (!result.ok) {
      // Surface the runner's diagnostics to make debugging easier
      throw new Error(`runPhase failed: ${result.error ?? 'unknown'}; exit=${result.exitCode}`);
    }
    expect(result.exitCode).toBe(0);

    // 1. Templates rendered
    const wrangler = await fs.readFile(join(TMP_PROJECT, 'wrangler.toml'), 'utf8');
    expect(wrangler).toContain('name = "demo-final"');
    expect(wrangler).toContain('region = "us-east-1"');
    expect(wrangler).toContain('project = "demo"');
    const env = await fs.readFile(join(TMP_PROJECT, '.env.production'), 'utf8');
    expect(env).toContain('PUBLIC_NAME=demo');

    // 2. .tmpl files removed after render
    expect(await fileExists(join(TMP_PROJECT, 'wrangler.toml.tmpl'))).toBe(false);
    expect(await fileExists(join(TMP_PROJECT, '.env.production.tmpl'))).toBe(false);

    // 3. Skip-dirs honoured
    expect(await fileExists(join(TMP_PROJECT, 'node_modules', 'fake.tmpl'))).toBe(true);
    expect(await fileExists(join(TMP_PROJECT, '.git', 'config.tmpl'))).toBe(true);

    // 4. PG state captures resources + outputs
    const kinds = (result.state?.createdResources ?? []).map((r) => r.kind);
    expect(kinds).toContain('synthetic.thing');
    expect(kinds).toContain('synthetic.other');
    expect(result.state?.outputs?.computedId).toBe('demo-final');
    expect(result.state?.outputs?.computedRegion).toBe('us-east-1');
  }, 30_000);

  it.skipIf(!isLinux)('renders zero templates without error when project dir has none', async () => {
    await writeSetupScript(`#!/usr/bin/env bash
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"
papercusp_render_templates
`);

    const result = await runPhase('setup', {
      harness: 'no-tmpl',
      plugin: 'synthetic-plugin',
      publisher: '@test',
      pluginVersion: '0.1.0',
      pluginDir: TMP_PLUGIN,
      projectDir: TMP_PROJECT,
      config: {},
      provision: { setup: { path: 'provision/setup.sh', timeoutSec: 30 } },
      consentConfirmed: true,
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  it.skipIf(!isLinux)('warns and exits cleanly when projectDir is undefined', async () => {
    await writeSetupScript(`#!/usr/bin/env bash
set -euo pipefail
. "$PAPERCUSP_RUNTIME_LIB"
papercusp_render_templates
echo "still ran"
`);

    const result = await runPhase('setup', {
      harness: 'no-projectdir',
      plugin: 'synthetic-plugin',
      publisher: '@test',
      pluginVersion: '0.1.0',
      pluginDir: TMP_PLUGIN,
      // projectDir intentionally omitted
      config: {},
      provision: { setup: { path: 'provision/setup.sh', timeoutSec: 30 } },
      consentConfirmed: true,
    });
    // The helper warns but doesn't fail the script.
    expect(result.ok).toBe(true);
  }, 30_000);
});

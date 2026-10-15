/**
 * R-8 (generalized-integrations-google-migration-cupboard-workflows-2026-10-05
 * P-012, D-013): installing and configuring a trigger-pack package materializes
 * its targets and binding graph as DISARMED trigger bindings bound to
 * installer-local sources and inputs, and returns the installed resource ids.
 *
 * Drives the real install core (`installPluginFromCupboardCore`) with a fake
 * clone, against a migrated throwaway Postgres.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { acceptanceBarSourceContractProblems, validateAcceptanceBarSource } from '../acceptance-bar-seed';
import {
  fakeRegistry,
  FOLLOW_SLUG,
  PACK_GITHUB_URL as GITHUB,
  PLUGIN,
  portablePackManifest,
  REPLY_SLUG,
  seedPackWorkspace,
  writePackDir,
} from '../../test/_trigger-pack-fixtures';
import { createExternalTriggerSource } from '../external-triggers/admin';
import { installPluginFromCupboardCore, type InstallPluginCoreDeps, InstallPluginError } from './install-plugin-core';
import { armTriggerPack } from './trigger-pack-lifecycle';
import {
  materializeTriggerPack,
  TRIGGER_PACK_EDGE_EVENT_KEY,
  triggerPackExecutionAgentName,
} from './trigger-pack-materialize';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const BASE_WS = 'trigger-pack-materialize-e2e';
// Plan slugs are a workspace-level identity, so each test installs into a fresh workspace.
let WS = BASE_WS;
let workspaceSeq = 0;
const HARNESS = 'pack-home';

let org: OrgTestDb;
let sql: Sql;
let scratch: string;
let packDir: string;

function installDeps(dir: string): InstallPluginCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(dir, dest, { recursive: true });
    },
    globalPluginsDir: () => join(scratch, 'global-plugins'),
    tmpDir: () => join(scratch, 'tmp'),
    grant: async () => undefined,
    invalidateHost: async () => undefined,
    materializeTriggerPack: (args) => materializeTriggerPack(sql, WS, args, { registry: fakeRegistry }),
  };
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  // Seeded plans carry RESTRICT-referenced BAR clauses and a workspace-scoped
  // acceptance identity, so each test gets a fresh workspace instead of deletes.
  WS = `${BASE_WS}-${++workspaceSeq}`;
  await seedPackWorkspace(sql, WS, HARNESS);
  scratch = await fs.mkdtemp(join(tmpdir(), 'trigger-pack-materialize-'));
  await fs.mkdir(join(scratch, 'tmp'), { recursive: true });
  packDir = join(scratch, 'pack');
  await writePackDir(packDir, portablePackManifest());
});

describe('trigger-pack materialization (R-8)', () => {
  it('gives every first-party trigger-pack plan a seedable acceptance BAR source', async () => {
    const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/plugins');
    const entries = await fs.readdir(pluginRoot, { withFileTypes: true });
    const templates: Array<{ name: string; path: string; content: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(pluginRoot, entry.name);
      let manifest: { name?: string; triggerPack?: { targets?: Array<{ kind?: string; path?: string }> } };
      try {
        manifest = JSON.parse(await fs.readFile(join(pluginDir, 'papercusp.json'), 'utf8')) as typeof manifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!manifest.name?.startsWith('@papercupai/')) continue;
      for (const target of manifest.triggerPack?.targets ?? []) {
        if (target.kind !== 'plan') continue;
        if (!target.path) throw new Error(`${manifest.name} has a plan target without a path`);
        templates.push({ name: manifest.name, path: target.path, content: await fs.readFile(join(pluginDir, target.path), 'utf8') });
      }
    }
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      const label = `${template.name}/${template.path}`;
      const parsed = validateAcceptanceBarSource(template.content);
      if (!parsed.ok) throw new Error(`${label}: ${parsed.problems.map(problem => problem.code).join(', ')}`);
      expect(acceptanceBarSourceContractProblems(parsed.bars, parsed.mappings), label).toEqual([]);
    }
  });

  it('materializes plans and disarmed bindings bound to installer-local sources and inputs', async () => {
    const outlook = await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });

    const result = await installPluginFromCupboardCore(
      { githubUrl: GITHUB, harness: HARNESS, triggerPackConfig: { inputs: { tone: 'warm' } } },
      installDeps(packDir),
    );
    const installation = result.triggerPackInstallation!;
    expect(installation).toMatchObject({
      harnessSlug: HARNESS,
      pluginName: PLUGIN,
      status: 'configured',
      unmet: [],
      armed: false,
      inputs: { tone: 'warm' },
    });
    // D-016: each materialized plan records the sha256 of the template it came from, so
    // the pack review can tell a template change from an unchanged update.
    expect(installation.resources.plans).toEqual({
      reply: { planSlug: REPLY_SLUG, templateSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      'follow-up': { planSlug: FOLLOW_SLUG, templateSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(installation.resources.entryPoints).toEqual([
      { bindingId: 'manual-follow-up', targetId: 'follow-up', planSlug: FOLLOW_SLUG },
    ]);

    // The plans exist in the INSTALLER's harness.
    const plans = await sql<Array<{ slug: string }>>`
      SELECT plan_slug AS slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} ORDER BY plan_slug`;
    expect(plans.map((plan) => plan.slug)).toEqual(expect.arrayContaining([FOLLOW_SLUG, REPLY_SLUG]));

    const rows = await sql<
      Array<{
        id: string;
        sourceId: string;
        sourceKind: string;
        armed: boolean;
        eventPattern: string;
        eventFilter: Record<string, unknown>;
        datatypeId: string | null;
        action: Record<string, unknown>;
        planHarnessSlug: string;
        planSlug: string;
        packInstallationId: string;
        stormPolicy: Record<string, unknown>;
      }>
    >`
      SELECT b.id::text AS id, b.source_id::text AS "sourceId", s.kind AS "sourceKind", b.armed,
             b.event_pattern AS "eventPattern", b.event_filter AS "eventFilter", b.datatype_id AS "datatypeId",
             b.action, b.plan_harness_slug AS "planHarnessSlug", b.plan_slug AS "planSlug",
             b.pack_installation_id::text AS "packInstallationId", b.storm_policy AS "stormPolicy"
        FROM harness_shared.trigger_bindings b
        JOIN harness_shared.data_sources s ON s.id = b.source_id
       WHERE b.workspace_id = ${WS} AND b.detached_at IS NULL`;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.armed === false)).toBe(true);
    expect(rows.every((row) => row.packInstallationId === installation.id)).toBe(true);
    // WI-6554700010008920: every plan binding names its executor. Without one a run
    // only mints an unassigned work-item that nothing consumes, and the orphan sweep
    // fails it; with one the run assigns + wakes the session that adopted the name.
    const packExecution = { appHarnessSlug: HARNESS, agentName: triggerPackExecutionAgentName(PLUGIN) };
    expect(packExecution.agentName).toMatch(/^[a-z0-9][a-z0-9-]*$/);

    const external = rows.find((row) => row.id === installation.resources.bindings['inbound-mail']!.triggerBindingId)!;
    // The portable `ext:*:` pattern binds to the installer's local source and kind.
    expect(external).toMatchObject({
      sourceId: outlook.id,
      eventPattern: 'ext:outlook-fixture:message.received',
      eventFilter: { direction: 'inbound' },
      datatypeId: 'email-message',
      planHarnessSlug: HARNESS,
      planSlug: REPLY_SLUG,
      action: { type: 'launch-plan', input: { tone: 'warm' }, execution: packExecution },
      stormPolicy: expect.objectContaining({ maxRuns: 2, windowSeconds: 3600 }),
    });

    const edge = rows.find((row) => row.id === installation.resources.bindings['after-reply']!.triggerBindingId)!;
    expect(edge).toMatchObject({
      sourceKind: 'trigger-pack-edge',
      sourceId: installation.resources.edgeSourceId,
      eventPattern: TRIGGER_PACK_EDGE_EVENT_KEY,
      eventFilter: { upstreamBindingId: external.id },
      datatypeId: 'trigger-run-completion',
      planSlug: FOLLOW_SLUG,
      action: { type: 'launch-plan', input: { tone: 'warm' }, execution: packExecution },
    });

    // Nothing publisher-specific: no installer-foreign source, account or run id.
    const stored = JSON.stringify(rows);
    const manifestText = JSON.stringify(portablePackManifest());
    expect(manifestText).not.toContain(outlook.id);
    expect(stored).not.toContain('pack-publisher');

    // The installation row records what it owns.
    const [row] = await sql<Array<{ status: string; resources: Record<string, unknown> }>>`
      SELECT status, resources FROM harness_shared.trigger_pack_installations
       WHERE workspace_id = ${WS} AND id = ${installation.id}::uuid`;
    expect(row).toMatchObject({ status: 'configured', resources: installation.resources });
  });

  it('leaves an ambiguous portable source unmet, then binds it once the installer maps it', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const gmail = await createExternalTriggerSource(sql, WS, { kind: 'gmail', status: 'connected' });
    // An unrelated provider-less source is never a candidate.
    await createExternalTriggerSource(sql, WS, { kind: 'webhook', status: 'connected' });

    const first = await materializeTriggerPack(
      sql,
      WS,
      { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: HARNESS, inputs: { tone: 'warm' } },
      { registry: fakeRegistry },
    );
    expect(first.status).toBe('needs-configuration');
    expect(first.unmet).toEqual([
      expect.objectContaining({
        bindingId: 'inbound-mail',
        reason: 'ambiguous',
        requirement: { kind: 'source', datatype: 'email-message', capabilities: ['mail.read'] },
      }),
      expect.objectContaining({ bindingId: 'after-reply', reason: 'upstream-unmet' }),
    ]);
    expect(first.unmet[0]!.candidates).toHaveLength(2);
    expect(first.resources.bindings).toEqual({});

    const configured = await materializeTriggerPack(
      sql,
      WS,
      {
        manifest: portablePackManifest() as never,
        pluginDir: packDir,
        harnessSlug: HARNESS,
        inputs: { tone: 'warm' },
        sourceMappings: { 'inbound-mail': gmail.id },
      },
      { registry: fakeRegistry },
    );
    expect(configured).toMatchObject({ id: first.id, status: 'configured', unmet: [] });
    expect(configured.resources.bindings['inbound-mail']).toMatchObject({ sourceId: gmail.id, kind: 'external' });
    const [external] = await sql<Array<{ eventPattern: string }>>`
      SELECT event_pattern AS "eventPattern" FROM harness_shared.trigger_bindings
       WHERE id = ${configured.resources.bindings['inbound-mail']!.triggerBindingId}::uuid`;
    expect(external!.eventPattern).toBe('ext:gmail:message.received');

    // Re-configuring with the same choices is idempotent and preserves the armed
    // state of a REVIEWED pack (P-013, D-016: arming goes through the pack review).
    expect(
      await armTriggerPack(sql, WS, { installationId: configured.id, fingerprint: configured.review.fingerprint }),
    ).toMatchObject({ ok: true });
    const again = await materializeTriggerPack(
      sql,
      WS,
      {
        manifest: portablePackManifest() as never,
        pluginDir: packDir,
        harnessSlug: HARNESS,
        inputs: { tone: 'warm' },
        sourceMappings: { 'inbound-mail': gmail.id },
      },
      { registry: fakeRegistry },
    );
    expect(again.resources.bindings).toEqual(configured.resources.bindings);
    const armed = await sql<Array<{ armed: boolean }>>`
      SELECT armed FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND detached_at IS NULL`;
    expect(armed.map((row) => row.armed)).toEqual([true, true]);

    // A changed input replaces the bindings: the old ones detach, the new ones start disarmed.
    const changed = await materializeTriggerPack(
      sql,
      WS,
      {
        manifest: portablePackManifest() as never,
        pluginDir: packDir,
        harnessSlug: HARNESS,
        inputs: { tone: 'formal' },
        sourceMappings: { 'inbound-mail': gmail.id },
      },
      { registry: fakeRegistry },
    );
    expect(changed.resources.bindings['inbound-mail']!.triggerBindingId).not.toBe(
      configured.resources.bindings['inbound-mail']!.triggerBindingId,
    );
    const live = await sql<Array<{ armed: boolean; input: Record<string, unknown> }>>`
      SELECT armed, action -> 'input' AS input FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS} AND detached_at IS NULL`;
    expect(live).toEqual([
      { armed: false, input: { tone: 'formal' } },
      { armed: false, input: { tone: 'formal' } },
    ]);
  });

  it('records invalid pack inputs as an unmet requirement', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const installation = await materializeTriggerPack(
      sql,
      WS,
      { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: HARNESS, inputs: {} },
      { registry: fakeRegistry },
    );
    expect(installation.status).toBe('needs-configuration');
    expect(installation.unmet).toEqual([expect.objectContaining({ bindingId: 'inputs', reason: 'inputs-invalid' })]);
  });

  it('refuses an unstartable template before writing anything', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const bare = join(scratch, 'bare-pack');
    await writePackDir(bare, portablePackManifest(), false);

    const refusal = await installPluginFromCupboardCore(
      { githubUrl: GITHUB, harness: HARNESS, triggerPackConfig: { inputs: { tone: 'warm' } } },
      installDeps(bare),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(InstallPluginError);
    expect(refusal).toMatchObject({ status: 422, code: 'trigger_pack_plan_template_unstartable:reply' });

    const [counts] = await sql<Array<{ installations: number; plans: number; bindings: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}) AS installations,
             (SELECT count(*)::int FROM harness_shared.harness_plans
               WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}) AS plans,
             (SELECT count(*)::int FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}) AS bindings`;
    expect(counts).toEqual({ installations: 0, plans: 0, bindings: 0 });
    await expect(fs.stat(join(scratch, 'global-plugins', PLUGIN))).rejects.toThrow();
  });

  it('refuses unsupported targets, edges and a foreign plan slug', async () => {
    const base = portablePackManifest();
    const pack = base.triggerPack;
    const recipe = {
      ...base,
      triggerPack: {
        ...pack,
        targets: [...pack.targets, { id: 'tool-call', kind: 'recipe', ref: 'recipe:demo', argsSchema: { type: 'object' } }],
        bindings: [
          ...pack.bindings,
          {
            id: 'mail-to-tool',
            source: { kind: 'external', datatype: 'email-message' },
            target: 'tool-call',
            eventPattern: 'ext:*:message.received',
            mapping: { mode: 'type-match' },
            retry: { maxAttempts: 1, onExhausted: 'dead-letter' },
          },
        ],
      },
    };
    await expect(
      materializeTriggerPack(sql, WS, { manifest: recipe as never, pluginDir: packDir, harnessSlug: HARNESS }, { registry: fakeRegistry }),
    ).rejects.toMatchObject({ code: 'trigger_pack_unsupported_target:recipe' });

    const planCompleted = {
      ...base,
      triggerPack: {
        ...pack,
        bindings: [
          pack.bindings[0],
          { id: 'after-reply', source: { kind: 'internal', event: 'plan-completed' }, target: 'follow-up' },
        ],
        edges: [{ from: 'inbound-mail', to: 'after-reply', event: 'plan-completed', correlation: 'inherit' }],
      },
    };
    await expect(
      materializeTriggerPack(sql, WS, { manifest: planCompleted as never, pluginDir: packDir, harnessSlug: HARNESS }, { registry: fakeRegistry }),
    ).rejects.toMatchObject({ code: 'trigger_pack_unsupported_edge:plan-completed' });

    await sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, content)
      VALUES (${WS}, ${HARNESS}, ${REPLY_SLUG}, 'Owner plan', 'draft', 'owner-authored')`;
    await expect(
      materializeTriggerPack(sql, WS, { manifest: base as never, pluginDir: packDir, harnessSlug: HARNESS }, { registry: fakeRegistry }),
    ).rejects.toMatchObject({ code: 'trigger_pack_plan_slug_conflict' });
    const [owner] = await sql<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${REPLY_SLUG}`;
    expect(owner!.content).toBe('owner-authored');
    const [installations] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}`;
    expect(installations!.n).toBe(0);
  });

  it('refuses a second harness in the same workspace, because plan slugs are workspace-scoped', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const first = await materializeTriggerPack(
      sql,
      WS,
      { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: HARNESS, inputs: { tone: 'warm' } },
      { registry: fakeRegistry },
    );
    expect(first.status).toBe('configured');

    await expect(
      materializeTriggerPack(
        sql,
        WS,
        { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: `${HARNESS}-other`, inputs: { tone: 'warm' } },
        { registry: fakeRegistry },
      ),
    ).rejects.toMatchObject({ code: 'trigger_pack_plan_slug_conflict' });
    const [counts] = await sql<Array<{ installations: number; plans: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}) AS installations,
             (SELECT count(*)::int FROM harness_shared.harness_plans
               WHERE workspace_id = ${WS} AND harness_slug = ${`${HARNESS}-other`}) AS plans`;
    expect(counts).toEqual({ installations: 1, plans: 0 });
  });
});

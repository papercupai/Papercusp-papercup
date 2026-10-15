/**
 * Trigger-pack lifecycle (generalized-integrations-google-migration-cupboard-workflows-2026-10-05
 * P-013, D-016) against a migrated throwaway Postgres:
 *
 *   - ITEM-P-013-contract: updating an armed pack returns every binding to review
 *     until it is re-armed; nothing (triggers:arm's chokepoint included) arms a
 *     pack binding without a current review
 *   - R-8: uninstall removes exactly what the installation created, keeps what it
 *     did not, and reports dependents
 *   - R-10: install, reconnect and update preserve source ids, grants, provenance
 *     keys and the disarmed state
 *   - export writes a portable package that re-installs in a second workspace
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
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
import {
  createExternalTriggerBinding,
  createExternalTriggerSource,
  setExternalTriggerBindingArmed,
  TriggerPackReviewRequiredError,
} from '../external-triggers/admin';
import { grantCapabilities } from '../plugin-grants';
import { installPluginFromCupboardCore, type InstallPluginCoreDeps } from './install-plugin-core';
import {
  armTriggerPack,
  buildTriggerPackReview,
  configureTriggerPack,
  exportTriggerPack,
  listAvailableTriggerPacks,
  listTriggerPackInstallations,
  listTriggerPackSettings,
  setUpTriggerPack,
  TriggerPackLifecycleError,
  uninstallTriggerPack,
} from './trigger-pack-lifecycle';
import { materializeTriggerPack } from './trigger-pack-materialize';

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

const BASE_WS = 'trigger-pack-lifecycle-e2e';
let WS = BASE_WS;
let workspaceSeq = 0;
const HARNESS = 'pack-home';
const CAPABILITY = 'events:emit';

let org: OrgTestDb;
let sql: Sql;
let scratch: string;
let packDir: string;

function manifest(version = '1.0.0') {
  return portablePackManifest({ version, capabilities: [CAPABILITY] });
}

async function materialize(version = '1.0.0', inputs: Record<string, unknown> = { tone: 'warm' }, mappings = {}) {
  return materializeTriggerPack(
    sql,
    WS,
    { manifest: manifest(version) as never, pluginDir: packDir, harnessSlug: HARNESS, inputs, sourceMappings: mappings },
    { registry: fakeRegistry },
  );
}

function installDeps(dir: string, ws: string): InstallPluginCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(dir, dest, { recursive: true });
    },
    globalPluginsDir: () => join(scratch, `global-plugins-${ws}`),
    tmpDir: () => join(scratch, 'tmp'),
    grant: (input) => grantCapabilities(input, { sql }),
    invalidateHost: async () => undefined,
    materializeTriggerPack: (args) => materializeTriggerPack(sql, ws, args, { registry: fakeRegistry }),
  };
}

async function live(ws = WS) {
  return sql<Array<{ id: string; armed: boolean; sourceId: string; eventPattern: string }>>`
    SELECT id::text AS id, armed, source_id::text AS "sourceId", event_pattern AS "eventPattern"
      FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${ws} AND detached_at IS NULL
     ORDER BY id`;
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
  WS = `${BASE_WS}-${++workspaceSeq}`;
  // Grants are keyed by (plugin, version, harness), not workspace, so a fresh workspace
  // alone does not isolate them: clear this suite's harness slugs between cases.
  await sql`
    DELETE FROM harness_shared.plugin_capability_grants
     WHERE plugin_name = ${PLUGIN} AND harness_slug IN (${HARNESS}, ${`${HARNESS}-other`})`;
  await seedPackWorkspace(sql, WS, HARNESS);
  scratch = await fs.mkdtemp(join(tmpdir(), 'trigger-pack-lifecycle-'));
  await fs.mkdir(join(scratch, 'tmp'), { recursive: true });
  packDir = join(scratch, 'pack');
  await writePackDir(packDir, manifest());
});

describe('trigger-pack lifecycle (P-013)', () => {
  it('update of an armed pack returns every binding to review until it is re-armed', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const installed = await materialize();
    expect(installed).toMatchObject({ status: 'configured', armed: false, review: { reviewed: false } });
    const [first] = await live();

    // No review yet: the single-binding chokepoint refuses to arm a pack binding.
    await expect(setExternalTriggerBindingArmed(sql, WS, first!.id, true)).rejects.toBeInstanceOf(
      TriggerPackReviewRequiredError,
    );
    expect((await live()).every((binding) => !binding.armed)).toBe(true);

    const review = (await buildTriggerPackReview(sql, WS, installed.id))!;
    expect(review.fingerprint).toBe(installed.review.fingerprint);
    expect(review.review).toMatchObject({ pluginName: PLUGIN, pluginVersion: '1.0.0', capabilities: [CAPABILITY] });
    expect(review.review.bindings.map((binding) => binding.packBindingId)).toEqual(['after-reply', 'inbound-mail']);
    expect(review.review.plans.every((plan) => /^[0-9a-f]{64}$/.test(plan.templateSha256 ?? ''))).toBe(true);
    expect(JSON.stringify(review.review)).not.toContain('"armed"');

    // A fingerprint the installer did not see is refused with the current review.
    const stale = await armTriggerPack(sql, WS, { installationId: installed.id, fingerprint: 'a'.repeat(64) });
    expect(stale).toMatchObject({ ok: false, error: 'trigger_pack_review_stale', review: { fingerprint: review.fingerprint } });
    expect((await live()).every((binding) => !binding.armed)).toBe(true);

    const armed = await armTriggerPack(sql, WS, { installationId: installed.id, fingerprint: review.fingerprint, reviewedBy: 'tester' });
    expect(armed).toMatchObject({ ok: true });
    expect((await live()).every((binding) => binding.armed)).toBe(true);

    // Pausing one binding and re-arming it is allowed while the review is current.
    expect(await setExternalTriggerBindingArmed(sql, WS, first!.id, false)).toMatchObject({ armed: false });
    expect(await setExternalTriggerBindingArmed(sql, WS, first!.id, true)).toMatchObject({ armed: true });

    // An identical re-configure keeps the reviewed pack armed.
    const same = await materialize();
    expect(same).toMatchObject({ armed: true, review: { reviewed: true, fingerprint: review.fingerprint } });
    expect((await live()).every((binding) => binding.armed)).toBe(true);

    // A version update changes the review: every binding is disarmed and the review cleared.
    const before = await live();
    const updated = await materialize('1.1.0');
    expect(updated).toMatchObject({ id: installed.id, pluginVersion: '1.1.0', armed: false, review: { reviewed: false } });
    expect(updated.review.fingerprint).not.toBe(review.fingerprint);
    const after = await live();
    expect(after.map((binding) => binding.id)).toEqual(before.map((binding) => binding.id));
    expect(after.every((binding) => !binding.armed)).toBe(true);
    const [row] = await sql<Array<{ reviewed: string | null }>>`
      SELECT reviewed_fingerprint AS reviewed FROM harness_shared.trigger_pack_installations
       WHERE workspace_id = ${WS} AND id = ${installed.id}::uuid`;
    expect(row!.reviewed).toBeNull();

    // Neither the toggle nor the old fingerprint re-arms it; only a fresh review does.
    await expect(setExternalTriggerBindingArmed(sql, WS, first!.id, true)).rejects.toMatchObject({
      code: 'trigger_pack_review_required',
      installationId: installed.id,
    });
    expect(await armTriggerPack(sql, WS, { installationId: installed.id, fingerprint: review.fingerprint })).toMatchObject({
      ok: false,
      error: 'trigger_pack_review_stale',
    });
    const rearmed = await armTriggerPack(sql, WS, { installationId: installed.id, fingerprint: updated.review.fingerprint });
    expect(rearmed).toMatchObject({ ok: true });
    expect((await live()).every((binding) => binding.armed)).toBe(true);

    // A changed input is a changed review too.
    const reconfigured = await materialize('1.1.0', { tone: 'formal' });
    expect(reconfigured).toMatchObject({ armed: false, review: { reviewed: false } });
    expect((await live()).every((binding) => !binding.armed)).toBe(true);
  });

  it('configureTriggerPack stores new settings, a picked value included, and Settings reads them back (P-005)', async () => {
    // The Settings → Integrations Save path: PUT …/inputs → configureTriggerPack, fed from the
    // stored manifest and the installed plugin directory. The schema mirrors the P-005 fixture
    // pack: a provider picker (`x-options`) and a field with a default, under additionalProperties:false.
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const base = manifest();
    const pickerManifest = {
      ...base,
      triggerPack: {
        ...base.triggerPack,
        inputs: {
          type: 'object',
          additionalProperties: false,
          required: ['tone'],
          properties: {
            tone: { type: 'string' },
            channel: { type: 'string', title: 'Channel to watch', 'x-options': { capability: 'chat.channels' } },
            note: { type: 'string', default: 'Fixture run.', maxLength: 200 },
          },
        },
      },
    };
    const pluginsDir = join(scratch, 'global-plugins');
    const pluginDir = join(pluginsDir, PLUGIN);
    await writePackDir(pluginDir, pickerManifest);
    const installed = await materializeTriggerPack(
      sql,
      WS,
      { manifest: pickerManifest as never, pluginDir, harnessSlug: HARNESS, inputs: { tone: 'warm' }, sourceMappings: {} },
      { registry: fakeRegistry },
    );
    const [before] = (await listTriggerPackSettings(sql, WS)).filter((pack) => pack.installationId === installed.id);
    expect(before!.inputs).toEqual({ tone: 'warm' });

    const saved = await configureTriggerPack(
      sql,
      WS,
      { installationId: installed.id, inputs: { tone: 'warm', channel: 'C-bugs' }, configuredBy: 'owner-1' },
      { pluginsDir, materialize: (s, ws, input) => materializeTriggerPack(s, ws, input, { registry: fakeRegistry }) },
    );
    expect(saved.id).toBe(installed.id);
    expect(saved.review.fingerprint).not.toBe(installed.review.fingerprint);

    const [after] = (await listTriggerPackSettings(sql, WS)).filter((pack) => pack.installationId === installed.id);
    expect(after!.inputs).toEqual({ tone: 'warm', channel: 'C-bugs' });
    expect(after!.state.fingerprint).toBe(saved.review.fingerprint);
  });

  it('a pack the Cupboard installed without a project is listed, set up in the picked project, then read as installed (D-017)', async () => {
    // The Cupboard page installs with no harness (WI-6554700010008548): the package lands in the
    // plugins directory and nothing is materialized. Settings must still list it, and setting it
    // up there must produce the normal disarmed installation.
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const deps = installDeps(packDir, WS);
    const pluginsDir = deps.globalPluginsDir();
    const installedPkg = await installPluginFromCupboardCore({ githubUrl: GITHUB, acceptCapabilities: true }, deps);
    expect(installedPkg.triggerPackInstallation).toBeUndefined();
    expect(await listTriggerPackSettings(sql, WS)).toEqual([]);

    const available = await listAvailableTriggerPacks(sql, WS, { pluginsDir });
    expect(available).toEqual([
      expect.objectContaining({ pluginName: PLUGIN, pluginVersion: '1.0.0', inputsSchema: manifest().triggerPack.inputs }),
    ]);

    const materializeFake = (s: Sql, ws: string, input: Parameters<typeof materializeTriggerPack>[2]) =>
      materializeTriggerPack(s, ws, input, { registry: fakeRegistry });
    const harnessExists = async (slug: string) => slug === HARNESS;
    await expect(
      setUpTriggerPack(sql, WS, { pluginName: PLUGIN, harnessSlug: 'no-such-project', inputs: {} }, { pluginsDir, harnessExists, materialize: materializeFake }),
    ).rejects.toMatchObject({ code: 'harness_not_found' });
    await expect(
      setUpTriggerPack(sql, WS, { pluginName: '@nobody/missing', harnessSlug: HARNESS }, { pluginsDir, harnessExists, materialize: materializeFake }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await listTriggerPackSettings(sql, WS)).toEqual([]);

    const setUp = await setUpTriggerPack(
      sql,
      WS,
      { pluginName: PLUGIN, harnessSlug: HARNESS, inputs: { tone: 'warm' }, configuredBy: 'owner-1' },
      { pluginsDir, harnessExists, materialize: materializeFake },
    );
    expect(setUp.armed).toBe(false);
    const [settings] = await listTriggerPackSettings(sql, WS);
    expect(settings).toMatchObject({ installationId: setUp.id, harnessSlug: HARNESS, pluginName: PLUGIN, inputs: { tone: 'warm' } });
    expect(settings!.state.armedBindingCount).toBe(0);
    expect(await listAvailableTriggerPacks(sql, WS, { pluginsDir })).toEqual([]);

    await expect(
      setUpTriggerPack(sql, WS, { pluginName: PLUGIN, harnessSlug: HARNESS }, { pluginsDir, harnessExists, materialize: materializeFake }),
    ).rejects.toMatchObject({ code: 'already_set_up' });
  });

  it('refuses to arm a pack that still needs configuration', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    await createExternalTriggerSource(sql, WS, { kind: 'gmail', status: 'connected' });
    const ambiguous = await materialize();
    expect(ambiguous.status).toBe('needs-configuration');
    expect(
      await armTriggerPack(sql, WS, { installationId: ambiguous.id, fingerprint: ambiguous.review.fingerprint }),
    ).toMatchObject({ ok: false, error: 'trigger_pack_needs_configuration' });
  });

  it('install, reconnect and update preserve source ids, grants, provenance keys and the disarmed state (R-10)', async () => {
    const outlook = await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const gmail = await createExternalTriggerSource(sql, WS, { kind: 'gmail', status: 'connected' });
    const mappings = { 'inbound-mail': outlook.id };
    const first = await installPluginFromCupboardCore(
      { githubUrl: GITHUB, harness: HARNESS, acceptCapabilities: true, triggerPackConfig: { inputs: { tone: 'warm' }, sourceMappings: mappings } },
      installDeps(packDir, WS),
    );
    expect(first.granted).toEqual([CAPABILITY]);
    const sourcesBefore = await sql`SELECT * FROM harness_shared.data_sources WHERE workspace_id = ${WS} ORDER BY id`;
    const bindingsBefore = await live();
    expect(bindingsBefore.map((binding) => binding.eventPattern).sort()).toEqual([
      'ext:outlook-fixture:message.received',
      'ext:trigger-pack-edge:binding-run-completed',
    ]);

    // Reconnect: the source flips status and back; a re-configure keeps every id.
    await sql`UPDATE harness_shared.data_sources SET status = 'error' WHERE id = ${outlook.id}::uuid`;
    await sql`UPDATE harness_shared.data_sources SET status = 'connected' WHERE id = ${outlook.id}::uuid`;
    await materialize('1.0.0', { tone: 'warm' }, mappings);
    expect(await live()).toEqual(bindingsBefore);

    // Update to 1.1.0 through the same door.
    await writePackDir(packDir, manifest('1.1.0'));
    const updated = await installPluginFromCupboardCore(
      { githubUrl: GITHUB, harness: HARNESS, acceptCapabilities: true, triggerPackConfig: { inputs: { tone: 'warm' }, sourceMappings: mappings } },
      installDeps(packDir, WS),
    );
    expect(updated.triggerPackInstallation).toMatchObject({ id: first.triggerPackInstallation!.id, armed: false });
    expect(await live()).toEqual(bindingsBefore);
    expect(await sql`SELECT * FROM harness_shared.data_sources WHERE workspace_id = ${WS} ORDER BY id`).toEqual(sourcesBefore);
    const grants = await sql<Array<{ version: string }>>`
      SELECT plugin_version AS version FROM harness_shared.plugin_capability_grants
       WHERE plugin_name = ${PLUGIN} AND harness_slug = ${HARNESS} ORDER BY plugin_version`;
    expect(grants.map((grant) => grant.version)).toEqual(['1.0.0', '1.1.0']);
    // Nothing binds to, or arms, the Gmail source the installer did not choose.
    expect((await live()).some((binding) => binding.sourceId === gmail.id)).toBe(false);
    expect((await live()).every((binding) => !binding.armed)).toBe(true);
  });

  it('uninstall removes what the installation created, keeps what it did not, and reports dependents (R-8)', async () => {
    const outlook = await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const installed = await materialize();
    await grantCapabilities({ pluginName: PLUGIN, pluginVersion: '1.0.0', harnessSlug: HARNESS, capabilities: [CAPABILITY] }, { sql });
    await grantCapabilities(
      { pluginName: PLUGIN, pluginVersion: '1.0.0', harnessSlug: `${HARNESS}-other`, capabilities: [CAPABILITY] },
      { sql },
    );
    const handBound = await createExternalTriggerBinding(sql, WS, {
      sourceId: outlook.id,
      planHarnessSlug: HARNESS,
      planSlug: REPLY_SLUG,
      eventPattern: 'ext:outlook-fixture:message.received',
      eventFilter: {},
    });
    expect(await armTriggerPack(sql, WS, { installationId: installed.id, fingerprint: installed.review.fingerprint })).toMatchObject({ ok: true });
    const owned = Object.values(installed.resources.bindings).map((binding) => binding.triggerBindingId).sort();

    const result = (await uninstallTriggerPack(sql, WS, installed.id))!;
    expect(result.detachedBindingIds).toEqual(owned);
    expect(result.archivedPlanSlugs).toEqual([FOLLOW_SLUG, REPLY_SLUG].sort());
    expect(result.revokedGrants).toEqual([{ pluginVersion: '1.0.0', capability: CAPABILITY }]);
    expect(result.dependents.bindings).toEqual([
      expect.objectContaining({ id: handBound.id, planSlug: REPLY_SLUG, packInstallationId: null }),
    ]);
    expect(result.kept).toEqual({ sourceIds: [outlook.id], edgeSourceId: installed.resources.edgeSourceId });

    const bindings = await sql<Array<{ id: string; armed: boolean; detached: boolean; pack: string | null }>>`
      SELECT id::text AS id, armed, detached_at IS NOT NULL AS detached, pack_installation_id::text AS pack
        FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} ORDER BY id`;
    expect(bindings.filter((binding) => owned.includes(binding.id)).every((binding) => binding.detached && !binding.armed)).toBe(true);
    expect(bindings.find((binding) => binding.id === handBound.id)).toMatchObject({ detached: false });
    const plans = await sql<Array<{ archived: boolean }>>`
      SELECT archived FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND plan_slug IN (${REPLY_SLUG}, ${FOLLOW_SLUG})`;
    expect(plans.map((plan) => plan.archived)).toEqual([true, true]);
    const sources = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM harness_shared.data_sources WHERE workspace_id = ${WS} ORDER BY id`;
    expect(sources.map((source) => source.id).sort()).toEqual([outlook.id, installed.resources.edgeSourceId!].sort());
    const otherGrants = await sql`
      SELECT 1 FROM harness_shared.plugin_capability_grants
       WHERE plugin_name = ${PLUGIN} AND harness_slug = ${`${HARNESS}-other`}`;
    expect(otherGrants).toHaveLength(1);
    expect(await listTriggerPackInstallations(sql, WS)).toEqual([]);
    expect(await uninstallTriggerPack(sql, WS, installed.id)).toBeNull();
  });

  it('exports a portable package that re-installs in a second workspace, and refuses secrets', async () => {
    const outlook = await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const installed = await materialize();
    await armTriggerPack(sql, WS, { installationId: installed.id, fingerprint: installed.review.fingerprint });

    const outDir = join(scratch, 'export');
    const exported = await exportTriggerPack(sql, WS, { installationId: installed.id, outDir });
    expect(exported.files).toEqual(['papercusp.json', 'plan-follow-up.md', 'plan-reply.md']);
    const text = (await Promise.all(exported.files.map((file) => fs.readFile(join(outDir, file), 'utf8')))).join('\n');
    for (const id of [installed.id, outlook.id, installed.resources.edgeSourceId!, ...Object.values(installed.resources.bindings).map((b) => b.triggerBindingId)]) {
      expect(text).not.toContain(id);
    }
    expect(text).not.toContain('"tone": "warm"');
    expect(JSON.parse(await fs.readFile(join(outDir, 'papercusp.json'), 'utf8'))).toEqual(manifest());

    const otherWs = `${WS}-import`;
    await seedPackWorkspace(sql, otherWs, HARNESS);
    await createExternalTriggerSource(sql, otherWs, { kind: 'outlook-fixture', status: 'connected' });
    const imported = await installPluginFromCupboardCore(
      { githubUrl: GITHUB, harness: HARNESS, triggerPackConfig: { inputs: { tone: 'formal' } } },
      installDeps(outDir, otherWs),
    );
    expect(imported.triggerPackInstallation).toMatchObject({ status: 'configured', armed: false, unmet: [] });
    const importedBindings = await live(otherWs);
    expect(importedBindings).toHaveLength(2);
    expect(importedBindings.every((binding) => !binding.armed)).toBe(true);

    // A credential-shaped string in an owned plan refuses the export before anything is written.
    await sql`
      UPDATE harness_shared.harness_plans
         SET content = content || ${'\nToken: ghp_' + 'A'.repeat(36) + '\n'}
       WHERE workspace_id = ${WS} AND plan_slug = ${REPLY_SLUG}`;
    const secretDir = join(scratch, 'export-secret');
    const refusal = await exportTriggerPack(sql, WS, { installationId: installed.id, outDir: secretDir }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TriggerPackLifecycleError);
    expect(refusal).toMatchObject({ code: 'trigger_pack_export_secret' });
    await expect(fs.readdir(secretDir)).rejects.toThrow();
  });
});

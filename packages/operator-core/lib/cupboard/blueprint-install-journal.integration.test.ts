/**
 * P-014 / D-034 — pot provider bindings are journaled resources of a per-pot
 * blueprint install, driven by the real release lifecycle under its fs lock.
 *
 * Real: Postgres (registry, conformance, pot bindings, P-006 journal), the
 * immutable file-tier release store and the production journal. Substituted:
 * nothing but the crash, which is simulated by stopping a lifecycle between
 * its steps exactly where a process death would.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinPackageInput } from '@papercusp/orchestrator/blueprint';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import {
  bindCapabilityProviderToPot,
  defineCapabilityClass,
  deletePotCapabilityProviderBinding,
  recordProviderConformance,
  validateProviderInterface,
  type CapabilityClassRow,
} from '../capability-class-registry-store';
import {
  buildBlueprintReleaseArchive,
  commitBlueprintRelease,
  readBlueprintLifecycle,
  rollbackBlueprintRelease,
  uninstallBlueprintRelease,
} from './blueprint-release';
import { blueprintInstallJournal, type BlueprintJournalPlan, type InstallProviderBinding } from './blueprint-install-journal';

const WS = 'ws-p014-journal';
const CLASS = { id: 'crm.email', version: '1.0.0' };
const ACME = { pkg: 'acme-crm', version: '2.0.0', tool: 'acme:send-email' } as const;
const BLUEWAVE = { pkg: 'bluewave-mail', version: '3.1.0', tool: 'bluewave:dispatch-message' } as const;
const sendSchema = { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] };
const binding = (provider: { pkg: string; version: string }): InstallProviderBinding => ({
  classRef: `${CLASS.id}@${CLASS.version}`, providerPackage: provider.pkg, providerVersion: provider.version, providerKind: 'tool',
});

let db: OrgTestDb;
let root = '';
let installedDir = '';

beforeAll(async () => {
  db = await createOrgTestDb();
  root = await fs.mkdtemp(join(tmpdir(), 'p014-journal-'));
  const defined = await defineCapabilityClass(db.adminSql, {
    workspaceId: WS, ...CLASS, title: 'CRM email', description: 'Send customer email.',
    interfaceVerbs: { send: { inputSchema: sendSchema } }, createdBy: 'p014-test',
  });
  const capabilityClass: CapabilityClassRow = defined.capabilityClass;
  for (const provider of [ACME, BLUEWAVE]) {
    const verbBindings = { send: provider.tool };
    const report = validateProviderInterface({
      capabilityClass, providerPackage: provider.pkg, providerVersion: provider.version, registryRevision: 'r1', verbBindings,
      lookup: (name) => name === provider.tool
        ? { name, pluginName: provider.pkg, providerVersion: provider.version, inputSchema: sendSchema, outputSchema: null } : null,
    });
    await recordProviderConformance(db.adminSql, {
      workspaceId: WS, classId: CLASS.id, classVersion: CLASS.version,
      providerPackage: provider.pkg, providerVersion: provider.version, verbBindings, report,
    });
  }
}, 120_000);

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  await db?.cleanup();
}, 30_000);

beforeEach(async () => {
  installedDir = await fs.mkdtemp(join(root, 'installed-'));
});

async function source(id: string, version: string) {
  const dir = join(root, `${id}-${version}-${Math.random().toString(36).slice(2)}`);
  const yaml = `id: ${id}\nversion: ${version}\n`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'blueprint.yaml'), yaml);
  const pin = pinPackageInput({
    packageKind: 'blueprint', ref: id, revision: version,
    files: [{ path: 'blueprint.yaml', bytes: yaml }], value: { id, version },
  });
  return { dir, pin, contentHash: buildBlueprintReleaseArchive([pin], id).root.contentHash };
}

const journal = (id: string, plan: BlueprintJournalPlan) =>
  blueprintInstallJournal({ sql: db.adminSql, workspaceId: WS, blueprintId: id }, plan);

async function install(id: string, version: string, potSlug: string, bindings: InstallProviderBinding[]) {
  const release = await source(id, version);
  return commitBlueprintRelease({
    installedDir, sourceDir: release.dir, id, version, source: 'repo', pins: [release.pin],
    journal: journal(id, { operation: 'install', potSlug, bindings }),
  });
}

async function potBinding(potSlug: string) {
  const [row] = await db.adminSql<Array<{ provider_package: string; bound_by: string | null }>>`
    SELECT provider_package, bound_by FROM harness_shared.pot_capability_class_bindings
     WHERE workspace_id = ${WS} AND pot_slug = ${potSlug} AND class_id = ${CLASS.id} AND class_version = ${CLASS.version}`;
  return row ?? null;
}

async function installPhases(id: string, potSlug: string) {
  return (await db.adminSql<Array<{ phase: string }>>`
    SELECT phase FROM harness_shared.blueprint_package_installations
     WHERE workspace_id = ${WS} AND owner_id = ${'pot:' + potSlug} AND state_revision = ${'blueprint:' + id}
     ORDER BY updated_at, dependent_id`).map((row) => row.phase);
}

const adminBind = (potSlug: string, provider: { pkg: string; version: string }) => bindCapabilityProviderToPot(db.adminSql, {
  workspaceId: WS, potSlug, classId: CLASS.id, classVersion: CLASS.version,
  providerPackage: provider.pkg, providerVersion: provider.version, boundBy: 'admin',
});

describe('P-014 pot binding journal (real PG + real release lifecycle)', () => {
  it('writes the binding with the install and removes exactly its own write on uninstall', async () => {
    const installed = await install('ident-basic', '1.0.0', 'pot-basic', [binding(ACME)]);
    expect(installed.journal).toMatchObject({ recovered: [], residue: [],
      pots: [{ potSlug: 'pot-basic', applied: true, bindings: ['crm.email@1.0.0 → acme-crm@2.0.0'], superseded: [] }] });
    expect(await potBinding('pot-basic')).toMatchObject({ provider_package: 'acme-crm', bound_by: expect.stringMatching(/^cupboard:install-blueprint#/) });
    expect(await installPhases('ident-basic', 'pot-basic')).toEqual(['applied']);

    const removed = await uninstallBlueprintRelease({ installedDir, id: 'ident-basic', journal: journal('ident-basic', { operation: 'uninstall' }) });
    expect(removed.journal).toMatchObject({ residue: [], pots: [{ potSlug: 'pot-basic' }] });
    expect(await potBinding('pot-basic')).toBeNull();
    expect(await installPhases('ident-basic', 'pot-basic')).toEqual(['released']);
  });

  it('compensates an attempt that died before its release switched, at the next lifecycle call', async () => {
    const first = await source('ident-crash', '1.0.0');
    // Crash after the binding write, before the file-tier switch.
    await journal('ident-crash', { operation: 'install', potSlug: 'pot-crash', bindings: [binding(ACME)] }).prepare(first.contentHash);
    expect(await potBinding('pot-crash')).toMatchObject({ provider_package: 'acme-crm' });
    expect(await installPhases('ident-crash', 'pot-crash')).toEqual(['preparing']);

    // The next call for this blueprint installs a release that needs no binding.
    const next = await install('ident-crash', '1.1.0', 'pot-crash', []);
    expect(next.journal?.recovered).toMatchObject([{ potSlug: 'pot-crash', outcome: 'compensated' }]);
    expect(await potBinding('pot-crash')).toBeNull();
    expect(await installPhases('ident-crash', 'pot-crash')).toEqual(['released', 'applied']);
  });

  it('rolls forward an attempt whose release switched before it applied', async () => {
    const first = await source('ident-forward', '1.0.0');
    await journal('ident-forward', { operation: 'install', potSlug: 'pot-forward', bindings: [binding(ACME)] }).prepare(first.contentHash);
    // Crash after the file-tier switch, before the apply.
    await commitBlueprintRelease({ installedDir, sourceDir: first.dir, id: 'ident-forward', version: '1.0.0', source: 'repo', pins: [first.pin] });

    const replay = await install('ident-forward', '1.0.0', 'pot-forward', [binding(ACME)]);
    expect(replay.operation).toBe('no-op');
    expect(replay.journal?.recovered).toMatchObject([{ potSlug: 'pot-forward', outcome: 'rolled-forward' }]);
    // The replay re-used the rolled-forward attempt: one applied install, one binding.
    expect(await installPhases('ident-forward', 'pot-forward')).toEqual(['applied']);
    expect(await potBinding('pot-forward')).toMatchObject({ provider_package: 'acme-crm' });
  });

  it('converges an uninstall that died after its file tier was removed, when it is retried', async () => {
    await install('ident-unfinished', '1.0.0', 'pot-unfinished', [binding(ACME)]);
    // Crash after the file tier went, before the journal cleaned the pot.
    await uninstallBlueprintRelease({ installedDir, id: 'ident-unfinished' });
    expect(await installPhases('ident-unfinished', 'pot-unfinished')).toEqual(['applied']);
    expect(await potBinding('pot-unfinished')).toMatchObject({ provider_package: 'acme-crm' });

    await expect(uninstallBlueprintRelease({ installedDir, id: 'ident-unfinished',
      journal: journal('ident-unfinished', { operation: 'uninstall' }) }))
      .rejects.toMatchObject({ status: 404, message: expect.stringContaining('converged 1 interrupted pot install') });
    expect(await potBinding('pot-unfinished')).toBeNull();
    expect(await installPhases('ident-unfinished', 'pot-unfinished')).toEqual(['released']);
  });

  it('reports a cleanup that failed as durable residue and converges it at the next lifecycle call', async () => {
    await install('ident-residue', '1.0.0', 'pot-residue', [binding(ACME)]);
    await db.adminSql.unsafe(`
      CREATE FUNCTION harness_shared.p014_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'p014 cleanup refused'; END $$;
      CREATE TRIGGER p014_refuse_delete BEFORE DELETE ON harness_shared.pot_capability_class_bindings
        FOR EACH ROW WHEN (OLD.pot_slug = 'pot-residue') EXECUTE FUNCTION harness_shared.p014_refuse_delete();`);
    try {
      const removed = await uninstallBlueprintRelease({ installedDir, id: 'ident-residue',
        journal: journal('ident-residue', { operation: 'uninstall' }) });
      expect(removed.journal?.residue).toEqual([{ dependentId: expect.any(String), error: expect.stringContaining('p014 cleanup refused') }]);
      expect(await installPhases('ident-residue', 'pot-residue')).not.toContain('released');
      expect(await potBinding('pot-residue')).toMatchObject({ provider_package: 'acme-crm' });
    } finally {
      await db.adminSql.unsafe(`DROP TRIGGER p014_refuse_delete ON harness_shared.pot_capability_class_bindings;
        DROP FUNCTION harness_shared.p014_refuse_delete();`);
    }

    // The next call for this blueprint cleans the residue before it installs.
    const again = await install('ident-residue', '1.0.0', 'pot-residue', [binding(ACME)]);
    expect(again.journal?.recovered).toMatchObject([{ potSlug: 'pot-residue', outcome: 'cleaned' }]);
    expect(again.journal?.recovered[0]?.error).toBeUndefined();
    expect(await installPhases('ident-residue', 'pot-residue')).toEqual(['released', 'applied']);
    expect(await potBinding('pot-residue')).toMatchObject({ provider_package: 'acme-crm', bound_by: expect.stringMatching(/^cupboard:/) });
  });

  it('keeps a binding another identity still holds, and removes it with the last one', async () => {
    await install('ident-share-a', '1.0.0', 'pot-share', [binding(ACME)]);
    await install('ident-share-b', '1.0.0', 'pot-share', [binding(ACME)]);
    await uninstallBlueprintRelease({ installedDir, id: 'ident-share-a', journal: journal('ident-share-a', { operation: 'uninstall' }) });
    expect(await potBinding('pot-share')).toMatchObject({ provider_package: 'acme-crm' });
    await uninstallBlueprintRelease({ installedDir, id: 'ident-share-b', journal: journal('ident-share-b', { operation: 'uninstall' }) });
    expect(await potBinding('pot-share')).toBeNull();
  });

  it('never deletes an administrator binding it reused or one re-pointed after install, and can re-bind later', async () => {
    // Reused: an equal administrator binding is depended on, never owned.
    await adminBind('pot-admin', ACME);
    await install('ident-reuse', '1.0.0', 'pot-admin', [binding(ACME)]);
    await uninstallBlueprintRelease({ installedDir, id: 'ident-reuse', journal: journal('ident-reuse', { operation: 'uninstall' }) });
    expect(await potBinding('pot-admin')).toEqual({ provider_package: 'acme-crm', bound_by: 'admin' });
    // ...and the identity installs again over the same administrator choice.
    await install('ident-reuse', '1.0.0', 'pot-admin', [binding(ACME)]);
    expect(await installPhases('ident-reuse', 'pot-admin')).toEqual(['released', 'applied']);

    // Re-pointed: the install's own write, changed by an administrator, is kept.
    await install('ident-repoint', '1.0.0', 'pot-repoint', [binding(ACME)]);
    await adminBind('pot-repoint', BLUEWAVE);
    const removed = await uninstallBlueprintRelease({ installedDir, id: 'ident-repoint', journal: journal('ident-repoint', { operation: 'uninstall' }) });
    expect(removed.journal?.residue).toEqual([]);
    expect(await potBinding('pot-repoint')).toEqual({ provider_package: 'bluewave-mail', bound_by: 'admin' });
    // While that choice stands, re-installing refuses instead of re-pointing it back...
    await expect(install('ident-repoint', '1.0.0', 'pot-repoint', [binding(ACME)]))
      .rejects.toMatchObject({ status: 409, code: 'capability_provider_binding_failed' });
    // ...and once the administrator removes it, the same binding is written afresh.
    await deletePotCapabilityProviderBinding(db.adminSql, { workspaceId: WS, potSlug: 'pot-repoint', classId: CLASS.id,
      classVersion: CLASS.version, expectedProviderPackage: BLUEWAVE.pkg, expectedProviderVersion: BLUEWAVE.version });
    await install('ident-repoint', '1.0.0', 'pot-repoint', [binding(ACME)]);
    expect(await potBinding('pot-repoint')).toMatchObject({ provider_package: 'acme-crm', bound_by: expect.stringMatching(/^cupboard:/) });
  });

  it('replaces a foreign binding whose provider has retired, which the resolver read as absent', async () => {
    await adminBind('pot-retired', BLUEWAVE);
    await db.adminSql`UPDATE harness_shared.capability_class_provider_bindings SET status = 'retired'
      WHERE workspace_id = ${WS} AND provider_package = ${BLUEWAVE.pkg}`;
    try {
      await install('ident-retired', '1.0.0', 'pot-retired', [binding(ACME)]);
      expect(await potBinding('pot-retired')).toMatchObject({ provider_package: 'acme-crm', bound_by: expect.stringMatching(/^cupboard:/) });
    } finally {
      await db.adminSql`UPDATE harness_shared.capability_class_provider_bindings SET status = 'active'
        WHERE workspace_id = ${WS} AND provider_package = ${BLUEWAVE.pkg}`;
    }
  });

  it('rolls back to the exact bindings the target recorded, and refuses to restore over a later owner', async () => {
    await install('ident-roll', '1.0.0', 'pot-roll', [binding(ACME)]);
    // v2 no longer needs the binding: the v1 install is fenced and its write removed.
    const update = await install('ident-roll', '2.0.0', 'pot-roll', []);
    expect(update.journal?.pots[0]?.superseded).toHaveLength(1);
    expect(await potBinding('pot-roll')).toBeNull();

    const rolled = await rollbackBlueprintRelease({ installedDir, id: 'ident-roll', target: '1.0.0',
      journal: journal('ident-roll', { operation: 'rollback' }) });
    expect(rolled.journal?.pots).toMatchObject([{ potSlug: 'pot-roll', applied: true, bindings: ['crm.email@1.0.0 → acme-crm@2.0.0'] }]);
    expect(await potBinding('pot-roll')).toMatchObject({ provider_package: 'acme-crm' });
    expect((await readBlueprintLifecycle(installedDir, 'ident-roll')).active?.version).toBe('1.0.0');

    // Forward to v2 again, then an administrator claims the class for another provider.
    await rollbackBlueprintRelease({ installedDir, id: 'ident-roll', target: '2.0.0', journal: journal('ident-roll', { operation: 'rollback' }) });
    expect(await potBinding('pot-roll')).toBeNull();
    await adminBind('pot-roll', BLUEWAVE);
    await expect(rollbackBlueprintRelease({ installedDir, id: 'ident-roll', target: '1.0.0',
      journal: journal('ident-roll', { operation: 'rollback' }) })).rejects.toMatchObject({ status: 409, code: 'rollback_binding_conflict' });
    expect((await readBlueprintLifecycle(installedDir, 'ident-roll')).active?.version).toBe('2.0.0');
    expect(await potBinding('pot-roll')).toEqual({ provider_package: 'bluewave-mail', bound_by: 'admin' });
  });
});

/** Real-PG upgrade and relational guards for portable identities P-004.
 * Synthetic runs exercise the storage boundary, not recipe/operation admission. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  bindCapabilityProviderToPot,
  defineCapabilityClass,
  getPotCapabilityProviderBinding,
  listActiveCapabilityProviderCandidates,
  listProviderBindings,
  recordProviderConformance,
  validateOperationProviderInterface,
  validateProviderInterface,
} from './capability-class-registry-store';
import { resolveIdentityClassProvider } from './agent-identities/class-provider';
import { resolveClassFireTarget } from './events/class-fire-target';
import { IDENTITY_REACTION_PROVIDER_KINDS } from './events/identity-reaction';

const migration = (name: string) => fileURLToPath(
  new URL(`../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url),
);
const executionMigration = migration('1233-capability-provider-execution-kind.sql');

describe('capability provider execution attestation (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('provider_execution');
    await db.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await applyMigrationForTest(db.sql, migration('1140-capability-class-registry.sql'));
    await applyMigrationForTest(db.sql, migration('1141-enforce-capability-class-passing-bindings.sql'));
    await applyMigrationForTest(db.sql, migration('1161-capability-class-embedding-profile.sql'));
    await db.sql`
      INSERT INTO harness_shared.capability_class_registry
        (workspace_id, id, version, title, description, interface_verbs)
      VALUES ('ws-execution', 'context.notes', '1.0.0', 'Notes', 'Context notes',
        '{"read":{"inputSchema":{"type":"object"},"outputSchema":{"type":"string"}}}'::jsonb)`;
    // The exact pre-upgrade writer shape: none of these statements knows a kind.
    await db.sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version,
         registry_revision, verb_bindings, structural_passed, report)
      VALUES ('legacy-run', 'ws-execution', 'context.notes', '1.0.0', 'legacy-notes', '1.0.0',
        'registry-1', '{"read":"notes:read"}'::jsonb, true, '{}'::jsonb)`;
    await db.sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id)
      VALUES ('ws-execution', 'context.notes', '1.0.0', 'legacy-notes', '1.0.0', 'legacy-run')`;
    await db.sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version)
      VALUES ('ws-execution', 'legacy-pot', 'context.notes', '1.0.0', 'legacy-notes', '1.0.0')`;
    await applyMigrationForTest(db.sql, existsSync(executionMigration)
      ? executionMigration : `${executionMigration}.DRAFT`);
  }, 120_000);

  afterAll(async () => { await db?.cleanup(); });

  async function insertRun(id: string, kind: string, latency: string, passed = true, report: object = {}) {
    await db.sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version,
         registry_revision, verb_bindings, structural_passed, report, provider_kind, latency_class)
      VALUES (${id}, 'ws-execution', 'context.notes', '1.0.0', ${id}, '1.0.0',
        'registry-1', '{"read":"notes:read"}'::jsonb, ${passed}, ${db.sql.json(report as never)}, ${kind}, ${latency})`;
  }

  async function insertProvider(id: string, kind: string, latency: string) {
    await db.sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version,
         conformance_run_id, provider_kind, latency_class)
      VALUES ('ws-execution', 'context.notes', '1.0.0', ${id}, '1.0.0', ${id}, ${kind}, ${latency})`;
  }

  async function insertPot(id: string, kind: string, latency: string) {
    await db.sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version,
         provider_kind, latency_class)
      VALUES ('ws-execution', ${id}, 'context.notes', '1.0.0', ${id}, '1.0.0', ${kind}, ${latency})`;
  }

  it('preserves pre-upgrade tool bindings and old writer defaults', async () => {
    for (const table of ['capability_class_conformance_runs', 'capability_class_provider_bindings', 'pot_capability_class_bindings']) {
      const rows = await db.sql<{ provider_kind: string; latency_class: string }[]>`
        SELECT provider_kind, latency_class FROM ${db.sql(`harness_shared.${table}`)}
        WHERE workspace_id = 'ws-execution' AND provider_package = 'legacy-notes'`;
      expect(rows).toEqual([{ provider_kind: 'tool', latency_class: 'sync' }]);
    }
    await db.sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version)
      VALUES ('ws-execution', 'old-binary-pot', 'context.notes', '1.0.0', 'legacy-notes', '1.0.0')`;
    const [row] = await db.sql`
      SELECT provider_kind, latency_class FROM harness_shared.pot_capability_class_bindings
      WHERE workspace_id = 'ws-execution' AND pot_slug = 'old-binary-pot'`;
    expect(row).toEqual({ provider_kind: 'tool', latency_class: 'sync' });
  });

  it.each([['recipe', 'sync'], ['operation', 'async']] as const)(
    'carries attested %s/%s through the selected pot binding', async (kind, latency) => {
      const id = `good-${kind}`;
      await insertRun(id, kind, latency);
      await insertProvider(id, kind, latency);
      await insertPot(id, kind, latency);
      const [row] = await db.sql`
        SELECT p.provider_kind, p.latency_class, b.conformance_run_id
        FROM harness_shared.pot_capability_class_bindings p
        JOIN harness_shared.capability_class_provider_bindings b
          USING (workspace_id, class_id, class_version, provider_package, provider_version)
        WHERE p.workspace_id = 'ws-execution' AND p.pot_slug = ${id}`;
      expect(row).toEqual({ provider_kind: kind, latency_class: latency, conformance_run_id: id });
    },
  );

  it.each([['tool', 'async'], ['recipe', 'async'], ['operation', 'sync'], ['unknown', 'sync']])(
    'refuses unsupported %s/%s at the attestation boundary', async (kind, latency) => {
      await expect(insertRun(`bad-${kind}`, kind, latency))
        .rejects.toThrow(/capability_class_conformance_execution_ck/);
    },
  );

  it('refuses a provider kind or latency that differs from its passing run', async () => {
    await insertRun('kind-spoof', 'tool', 'sync');
    await expect(insertProvider('kind-spoof', 'recipe', 'sync'))
      .rejects.toThrow(/capability_class_provider_run_fk/);
    await expect(insertProvider('kind-spoof', 'tool', 'async'))
      .rejects.toThrow(/capability_class_provider_run_fk/);
    await insertRun('failed-recipe', 'recipe', 'sync', false);
    await expect(insertProvider('failed-recipe', 'recipe', 'sync'))
      .rejects.toThrow(/capability_class_provider_run_fk/);
  });

  it('refuses a pot claiming a different execution contract or relying on old defaults', async () => {
    await insertRun('pot-spoof', 'recipe', 'sync');
    await insertProvider('pot-spoof', 'recipe', 'sync');
    await expect(insertPot('pot-spoof', 'tool', 'sync'))
      .rejects.toThrow(/pot_capability_class_provider_fk/);
    await expect(db.sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version)
      VALUES ('ws-execution', 'old-writer-recipe', 'context.notes', '1.0.0', 'pot-spoof', '1.0.0')`)
      .rejects.toThrow(/pot_capability_class_provider_fk/);
  });

  it('prevents a provider revalidation from changing an adopted execution kind silently', async () => {
    await insertRun('adopted', 'tool', 'sync');
    await insertProvider('adopted', 'tool', 'sync');
    await insertPot('adopted', 'tool', 'sync');
    await db.sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version,
         registry_revision, verb_bindings, structural_passed, report, provider_kind, latency_class)
      VALUES ('adopted-recipe-run', 'ws-execution', 'context.notes', '1.0.0', 'adopted', '1.0.0',
        'registry-2', '{"read":"recipe-1"}'::jsonb, true, '{}'::jsonb, 'recipe', 'sync')`;
    await expect(db.sql`
      UPDATE harness_shared.capability_class_provider_bindings
      SET provider_kind = 'recipe', conformance_run_id = 'adopted-recipe-run'
      WHERE workspace_id = 'ws-execution' AND provider_package = 'adopted'`)
      .rejects.toThrow(/pot_capability_class_provider_fk/);
  });

  it('keeps legacy consumers tool-only and requires explicit typed recipe selection', async () => {
    const id = 'typed-recipe';
    await insertRun(id, 'recipe', 'sync');
    await insertProvider(id, 'recipe', 'sync');
    const input = {
      workspaceId: 'ws-execution', potSlug: id, classId: 'context.notes', classVersion: '1.0.0',
      providerPackage: id, providerVersion: '1.0.0',
    };
    await expect(bindCapabilityProviderToPot(db.sql, input)).rejects.toThrow(/different execution kind/);
    await bindCapabilityProviderToPot(db.sql, { ...input, providerKind: 'recipe' });
    expect(await getPotCapabilityProviderBinding(db.sql, input)).toBeNull();
    expect(await getPotCapabilityProviderBinding(db.sql, { ...input, providerKinds: [] })).toBeNull();
    expect(await getPotCapabilityProviderBinding(db.sql, { ...input, providerKinds: ['recipe'] }))
      .toMatchObject({ providerKind: 'recipe', latencyClass: 'sync', conformanceRunId: id });
    const discovered = await listProviderBindings(db.sql, 'ws-execution', 'context.notes', '1.0.0');
    expect(discovered.find((row) => row.providerPackage === id)?.providerKind).toBe('recipe');
    const legacyCandidates = await listActiveCapabilityProviderCandidates(
      db.sql, 'ws-execution', 'context.notes', '1.0.0',
    );
    expect(legacyCandidates.every((row) => row.providerKind === 'tool')).toBe(true);
    expect(legacyCandidates.some((row) => row.providerPackage === 'legacy-notes')).toBe(true);
    await db.sql`
      UPDATE harness_shared.capability_class_provider_bindings SET status = 'retired'
      WHERE workspace_id = 'ws-execution' AND provider_package = ${id}`;
    expect(await getPotCapabilityProviderBinding(db.sql, { ...input, providerKinds: ['recipe'] })).toBeNull();
    await expect(bindCapabilityProviderToPot(db.sql, { ...input, providerKind: 'recipe' }))
      .rejects.toThrow(/inactive/);
  });

  async function installToolVersion(workspaceId: string, version: string, bind = true) {
    const outputSchema = { type: 'string', maxLength: 128 };
    const inputSchema = { type: 'object', additionalProperties: false };
    const { capabilityClass } = await defineCapabilityClass(db.sql, {
      workspaceId, id: 'context.notes', version, title: 'Notes', description: 'Read local notes',
      interfaceVerbs: { read: { inputSchema, outputSchema }, unchecked: { inputSchema } },
    });
    const verbBindings = { read: 'notes:read', unchecked: 'notes:unchecked' };
    const report = validateProviderInterface({
      capabilityClass, providerPackage: 'notes-tool', providerVersion: '1.0.0',
      registryRevision: 'registry-1', verbBindings,
      lookup: (name) => ({ name, pluginName: 'notes-tool', providerVersion: '1.0.0', inputSchema, outputSchema }),
    });
    await recordProviderConformance(db.sql, {
      workspaceId, classId: capabilityClass.id, classVersion: version,
      providerPackage: 'notes-tool', providerVersion: '1.0.0', verbBindings, report,
    });
    if (bind) await bindCapabilityProviderToPot(db.sql, {
      workspaceId, potSlug: 'context-pot', classId: capabilityClass.id, classVersion: version,
      providerPackage: 'notes-tool', providerVersion: '1.0.0',
    });
    return { workspaceId, potSlug: 'context-pot', classRef: 'context.notes@1', verb: 'read' };
  }

  it('pins a major to the newest stable pot-selected contract in numeric version order', async () => {
    const request = await installToolVersion('ws-major', '1.10.0');
    // Insert later to catch both lexicographic and created-at ordering mistakes.
    await installToolVersion('ws-major', '1.9.0');
    await installToolVersion('ws-major', '1.11.0-beta');
    await installToolVersion('ws-major', '2.0.0');
    await installToolVersion('ws-major', '1.12x0');
    await installToolVersion('ws-major', '1.99.0', false);
    expect(await resolveIdentityClassProvider(db.sql, request)).toMatchObject({
      ok: true, requestedClassRef: 'context.notes@1', classRef: 'context.notes@1.10.0', verb: 'read',
      contract: { outputSchema: { type: 'string', maxLength: 128 } },
      provider: { providerKind: 'tool', latencyClass: 'sync', classRef: 'context.notes@1.10.0' },
    });
    expect(await resolveIdentityClassProvider(db.sql, { ...request, workspaceId: 'another-workspace' }))
      .toMatchObject({ ok: false, code: 'class-unknown' });
    expect(await resolveIdentityClassProvider(db.sql, { ...request, potSlug: 'another-pot' }))
      .toMatchObject({ ok: false, code: 'class-unbound' });
    for (const classRef of ['context.notes', 'context.notes@1.0.0', 'context.notes@01', 'context.notes@1.*']) {
      expect(await resolveIdentityClassProvider(db.sql, { ...request, classRef }))
        .toMatchObject({ ok: false, code: 'invalid-class-major' });
    }
    expect(await resolveIdentityClassProvider(db.sql, { ...request, verb: 'missing' }))
      .toMatchObject({ ok: false, code: 'verb-unknown' });
    expect(await resolveIdentityClassProvider(db.sql, { ...request, verb: '__proto__' }))
      .toMatchObject({ ok: false, code: 'verb-unknown' });
    expect(await resolveIdentityClassProvider(db.sql, { ...request, verb: 'unchecked' }))
      .toMatchObject({ ok: false, code: 'output-schema-missing' });
  });

  it('does not fall back to an older provider when the selected version is retired', async () => {
    const request = await installToolVersion('ws-retired-major', '1.0.0');
    await installToolVersion('ws-retired-major', '1.1.0');
    await db.sql`
      UPDATE harness_shared.capability_class_provider_bindings SET status = 'retired'
      WHERE workspace_id = 'ws-retired-major' AND class_version = '1.1.0'`;
    expect(await resolveIdentityClassProvider(db.sql, request))
      .toMatchObject({ ok: false, code: 'provider-unavailable' });
  });

  it.each([['operation', 'async', 'operation-unavailable'], ['recipe', 'sync', 'recipe-unavailable']])(
    'does not turn a stored %s kind into inline execution authority', async (kind, latency, code) => {
      const id = `unavailable-${kind}`;
      await insertRun(id, kind, latency);
      await insertProvider(id, kind, latency);
      await insertPot(id, kind, latency);
      expect(await resolveIdentityClassProvider(db.sql, {
        workspaceId: 'ws-execution', potSlug: id, classRef: 'context.notes@1', verb: 'read',
      })).toMatchObject({ ok: false, code });
    },
  );

  it('admits a recipe provider only with inspected evidence for the requested verb (P-013)', async () => {
    const id = 'inspected-recipe';
    const evidence = { ok: true, recipe: { id: 'notes:read', revision: 'a'.repeat(64) },
      inspectionPin: { sourceSha256: 'b'.repeat(64), bindingsSha256: 'c'.repeat(64), recipeRevision: 'a'.repeat(64) },
      toolNames: ['notes:read'], requiredCapabilities: ['notes:read'], outputSchema: { type: 'string' } };
    await insertRun(id, 'recipe', 'sync', true, { schemaVersion: 'capability-class-recipe-v1', recipes: { read: evidence } });
    await insertProvider(id, 'recipe', 'sync');
    await insertPot(id, 'recipe', 'sync');
    const request = { workspaceId: 'ws-execution', potSlug: id, classRef: 'context.notes@1', verb: 'read' };
    const resolved = await resolveIdentityClassProvider(db.sql, request);
    expect(resolved).toMatchObject({ ok: true, verb: 'read',
      provider: { providerKind: 'recipe', recipeInspections: { read: evidence } } });
    // Evidence for another verb does not admit this one.
    expect(await resolveIdentityClassProvider(db.sql, { ...request, verb: 'summary' }))
      .toMatchObject({ ok: false, code: 'recipe-unavailable' });
  });

  describe('operation providers (portable-identity-packages D-030)', () => {
    const SPEC = 'e'.repeat(64);
    const inputSchema = { type: 'object', properties: { title: { type: 'string' } } };
    const resultSchema = { type: 'object', properties: { id: { type: 'string' } } };

    async function recordOperationProvider(workspaceId: string, over: { providerPackage?: string } = {}) {
      const { capabilityClass } = await defineCapabilityClass(db.sql, {
        workspaceId, id: 'ops.tasks', version: '1.0.0', title: 'Tasks', description: 'File a task',
        interfaceVerbs: { create: { inputSchema, outputSchema: resultSchema } },
      });
      const verbBindings = { create: 'file-task' };
      const report = validateOperationProviderInterface({
        capabilityClass, harnessSlug: 'ops-harness', providerVersion: '1.0.0', specificationRevision: SPEC,
        verbBindings, lookup: (id) => (id === 'file-task' ? { inputSchema, resultSchema } : null),
      });
      return recordProviderConformance(db.sql, {
        workspaceId, classId: 'ops.tasks', classVersion: '1.0.0',
        providerPackage: over.providerPackage ?? report.providerPackage, providerVersion: '1.0.0', verbBindings,
        report: over.providerPackage ? { ...report, providerPackage: over.providerPackage } : report,
      });
    }

    it('records an operation run as operation/async, pinned to its blueprint harness and revision', async () => {
      const { runId, binding } = await recordOperationProvider('ws-operation');
      expect(binding).toMatchObject({
        providerPackage: 'blueprint:ops-harness', providerKind: 'operation', latencyClass: 'async',
        operationHarnessSlug: 'ops-harness', registryRevision: SPEC, verbBindings: { create: 'file-task' },
      });
      const [run] = await db.sql`
        SELECT provider_kind, latency_class, registry_revision FROM harness_shared.capability_class_conformance_runs
         WHERE id = ${runId}`;
      expect(run).toEqual({ provider_kind: 'operation', latency_class: 'async', registry_revision: SPEC });
    });

    it('refuses an operation provider whose package is not its blueprint harness', async () => {
      await expect(recordOperationProvider('ws-operation-spoof', { providerPackage: 'someone-else' }))
        .rejects.toThrow(/blueprint:<the harness/);
    });

    it('resolves to the bound operation only for a caller that admits operation providers', async () => {
      await recordOperationProvider('ws-operation-fire');
      const pot = {
        workspaceId: 'ws-operation-fire', potSlug: 'ops-pot', classId: 'ops.tasks', classVersion: '1.0.0',
        providerPackage: 'blueprint:ops-harness', providerVersion: '1.0.0',
      };
      await expect(bindCapabilityProviderToPot(db.sql, pot)).rejects.toThrow(/different execution kind/);
      await bindCapabilityProviderToPot(db.sql, { ...pot, providerKind: 'operation' });
      const fire = { workspaceId: 'ws-operation-fire', potSlug: 'ops-pot', fire: 'class:ops.tasks@1.0.0#create' };
      // The in-process reaction path stays tool-only: an operation provider is unbound for it.
      expect(await resolveClassFireTarget(db.sql, fire)).toMatchObject({ status: 'unbound' });
      expect(await resolveClassFireTarget(db.sql, { ...fire, providerKinds: IDENTITY_REACTION_PROVIDER_KINDS }))
        .toMatchObject({
          status: 'resolved', tool: 'file-task', providerKind: 'operation', operationHarnessSlug: 'ops-harness',
          providerPackage: 'blueprint:ops-harness',
        });
      // A sync identity sink never executes it inline.
      expect(await resolveIdentityClassProvider(db.sql, {
        workspaceId: 'ws-operation-fire', potSlug: 'ops-pot', classRef: 'ops.tasks@1', verb: 'create',
      })).toMatchObject({ ok: false, code: 'operation-unavailable' });
    });
  });
});

/** Real-PG recurrence guard for migration 1140 and the P-016 registry/binding store. */
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrationForTest,
  createFreshPgDb,
  type FreshPgDb,
} from '../test/_pg-helpers';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import { PROSE_VECTOR_DIMS } from './search/prose-vector-dims';
import {
  bindCapabilityProviderToPot,
  deletePotCapabilityProviderBinding,
  defineCapabilityClass,
  getCapabilityClass,
  getPotCapabilityProviderBinding,
  listActiveCapabilityProviderCandidates,
  listCapabilityClasses,
  listCapabilityProviderDependents,
  listProviderBindings,
  recordProviderConformance,
  validateProviderInterface,
  type CapabilityClassRow,
  type ProviderConformanceReport,
  type ProviderToolContract,
} from './capability-class-registry-store';

const MIGRATION_1140 = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/1140-capability-class-registry.sql', import.meta.url),
);
const MIGRATION_1141_BASE = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/1141-enforce-capability-class-passing-bindings.sql', import.meta.url),
);
const MIGRATION_1161_PROFILE = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/1161-capability-class-embedding-profile.sql', import.meta.url),
);
const MIGRATION_1233_EXECUTION = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/1233-capability-provider-execution-kind.sql', import.meta.url),
);
const embedding = (): number[] => Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.2);
const verbs = {
  send: {
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body'],
    },
  },
};

function report(ok: boolean): ProviderConformanceReport {
  return {
    schemaVersion: 'capability-class-structural-v1',
    ok,
    classRef: 'crm.email@1.0.0',
    providerPackage: 'acme-crm',
    providerVersion: '2.0.0',
    registryRevision: 'registry-r1',
    checks: [{ verb: 'send', tool: 'acme:send-email', ok, problems: ok ? [] : ['input schema differs'] }],
    behavioral: { status: 'not-required', suiteRef: null },
  };
}

/**
 * P-043 (D-031) fixtures: ONE capability contract, TWO independent providers.
 *
 * Independence is the whole point, so it is structural rather than nominal:
 * each provider owns a different tool, under a different package, on a
 * different version. Nothing below hand-writes a conformance verdict — every
 * report comes from the real validateProviderInterface against the real class
 * row, so a negative is the validator's judgement and not the test's opinion.
 */
const ACME = { pkg: 'acme-crm', version: '2.0.0', tool: 'acme:send-email' } as const;
const BLUEWAVE = { pkg: 'bluewave-mail', version: '3.1.0', tool: 'bluewave:dispatch-message' } as const;

type Schema = ProviderToolContract['inputSchema'];
const sendSchema = (): Schema => ({
  type: 'object',
  properties: { body: { type: 'string' } },
  required: ['body'],
}) as Schema;

/** The live projected-tool registry seam: only these tools exist, each owned by its package. */
function toolLookup(...tools: ProviderToolContract[]): (name: string) => ProviderToolContract | null {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return (name) => byName.get(name) ?? null;
}

const providerTool = (
  provider: { pkg: string; tool: string; version: string },
  inputSchema: Schema = sendSchema(),
): ProviderToolContract => ({
  name: provider.tool,
  pluginName: provider.pkg,
  providerVersion: provider.version,
  inputSchema,
  outputSchema: null,
});

/**
 * Conform one provider against one class and persist the run. Returns the run id
 * plus the binding, which is null exactly when the validator refused — the
 * caller never states the verdict itself.
 */
async function conform(
  db: FreshPgDb,
  input: {
    workspaceId: string;
    capabilityClass: CapabilityClassRow;
    provider: { pkg: string; version: string };
    verbBindings: Record<string, string>;
    lookup: (toolName: string) => ProviderToolContract | null;
  },
) {
  const report = validateProviderInterface({
    capabilityClass: input.capabilityClass,
    providerPackage: input.provider.pkg,
    providerVersion: input.provider.version,
    registryRevision: 'registry-r1',
    verbBindings: input.verbBindings,
    lookup: input.lookup,
  });
  const recorded = await recordProviderConformance(db.sql, {
    workspaceId: input.workspaceId,
    classId: input.capabilityClass.id,
    classVersion: input.capabilityClass.version,
    providerPackage: input.provider.pkg,
    providerVersion: input.provider.version,
    verbBindings: input.verbBindings,
    report,
    performedBy: 'su-p043',
  });
  return { report, ...recorded };
}

describe('capability class registry (real PG)', () => {
  let db: FreshPgDb;

  /** Defines crm.email@1.0.0 and conforms BOTH providers against it independently. */
  async function twoProviderWorkspace(workspaceId: string) {
    const defined = await defineCapabilityClass(db.sql, {
      workspaceId,
      id: 'crm.email',
      version: '1.0.0',
      title: 'CRM email',
      description: 'Send customer email.',
      interfaceVerbs: verbs,
      createdBy: 'operator-1',
    });
    const capabilityClass = defined.capabilityClass;
    const lookup = toolLookup(providerTool(ACME), providerTool(BLUEWAVE));
    const acme = await conform(db, {
      workspaceId,
      capabilityClass,
      provider: ACME,
      verbBindings: { send: ACME.tool },
      lookup,
    });
    const bluewave = await conform(db, {
      workspaceId,
      capabilityClass,
      provider: BLUEWAVE,
      verbBindings: { send: BLUEWAVE.tool },
      lookup,
    });
    return { capabilityClass, lookup, acme, bluewave };
  }

  beforeAll(async () => {
    db = await createFreshPgDb('capclass');
    await db.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await applyMigrationForTest(db.sql, MIGRATION_1140);
    await applyMigrationForTest(db.sql, MIGRATION_1141_BASE);
    await applyMigrationForTest(db.sql, MIGRATION_1161_PROFILE);
    await applyMigrationForTest(db.sql, existsSync(MIGRATION_1233_EXECUTION)
      ? MIGRATION_1233_EXECUTION : `${MIGRATION_1233_EXECUTION}.DRAFT`);
  }, 120_000);

  // Explicit budget, matching beforeAll: cleanup drops a testcontainers database and
  // must not inherit whichever hookTimeout the invoking config happens to set (a
  // default-config run gives hooks only 10s, which a loaded host can exceed).
  afterAll(async () => {
    await db?.cleanup();
  }, 120_000);

  it('keeps class@version immutable and discovers it through tsv/embedding fields', async () => {
    const base = {
      workspaceId: 'ws-classes',
      id: 'crm.email',
      version: '1.0.0',
      title: 'CRM email delivery',
      description: 'Send customer email from a CRM contact record.',
      interfaceVerbs: verbs,
      embedding: embedding(),
      embeddingProfile: EMBEDDER_DIM_SPECS.gemma,
      tags: ['crm', 'email'],
      createdBy: 'operator-1',
    };
    const first = await defineCapabilityClass(db.sql, base);
    expect(first.created).toBe(true);
    expect(first.conflict).toBe(false);
    expect(first.capabilityClass.hasEmbedding).toBe(true);
    expect(first.capabilityClass.embeddingProfile).toBe(EMBEDDER_DIM_SPECS.gemma.profileId);

    const replay = await defineCapabilityClass(db.sql, base);
    expect(replay).toMatchObject({ created: false, conflict: false });
    const conflict = await defineCapabilityClass(db.sql, { ...base, description: 'changed without a new version' });
    expect(conflict).toMatchObject({ created: false, conflict: true });

    const got = await getCapabilityClass(db.sql, 'ws-classes', 'crm.email', '1.0.0');
    expect(got?.ref).toBe('crm.email@1.0.0');
    const found = await listCapabilityClasses(db.sql, 'ws-classes', { query: 'customer email' });
    expect(found.map((row) => row.ref)).toContain('crm.email@1.0.0');

    const exactSemantic = await listCapabilityClasses(db.sql, 'ws-classes', {
      query: 'orthogonal discovery phrase',
      embedding: embedding(),
      embeddingProfile: EMBEDDER_DIM_SPECS.gemma,
    });
    expect(exactSemantic.map((row) => row.ref)).toContain('crm.email@1.0.0');

    // Same dimensions and the same closed physical metric are insufficient:
    // a vector stored under Gemma may not be compared with an OpenAI query.
    const equalWidthForeign = await listCapabilityClasses(db.sql, 'ws-classes', {
      query: 'orthogonal discovery phrase',
      embedding: embedding(),
      embeddingProfile: EMBEDDER_DIM_SPECS.openai,
    });
    expect(equalWidthForeign).toEqual([]);

    await db.sql`
      UPDATE harness_shared.capability_class_registry
         SET embedding_profile = NULL
       WHERE workspace_id = 'ws-classes' AND id = 'crm.email' AND version = '1.0.0'`;
    const legacySemantic = await listCapabilityClasses(db.sql, 'ws-classes', {
      query: 'orthogonal discovery phrase',
      embedding: embedding(),
      embeddingProfile: EMBEDDER_DIM_SPECS.gemma,
    });
    expect(legacySemantic).toEqual([]);
    const legacyLexical = await listCapabilityClasses(db.sql, 'ws-classes', {
      query: 'customer email',
      embedding: embedding(),
      embeddingProfile: EMBEDDER_DIM_SPECS.gemma,
    });
    expect(legacyLexical.map((row) => row.ref)).toContain('crm.email@1.0.0');
    expect(await getCapabilityClass(db.sql, 'other-workspace', 'crm.email', '1.0.0')).toBeNull();
  });

  it('records every run but derives a provider binding only from a passing run', async () => {
    const workspaceId = 'ws-binding';
    await defineCapabilityClass(db.sql, {
      workspaceId,
      id: 'crm.email',
      version: '1.0.0',
      title: 'CRM email',
      description: 'Send customer email.',
      interfaceVerbs: verbs,
      createdBy: 'operator-1',
    });
    const common = {
      workspaceId,
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      verbBindings: { send: 'acme:send-email' },
      performedBy: 'su-test',
    };
    const failed = await recordProviderConformance(db.sql, { ...common, report: report(false) });
    expect(failed.binding).toBeNull();
    expect(await listProviderBindings(db.sql, workspaceId, 'crm.email', '1.0.0')).toEqual([]);

    await expect(db.sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id)
      VALUES (${workspaceId}, 'crm.email', '1.0.0', 'acme-crm', '2.0.0', ${failed.runId})
    `).rejects.toThrow(/capability_class_provider_run_fk/);

    await expect(recordProviderConformance(db.sql, {
      ...common,
      report: { ...report(true), providerPackage: 'spoofed-provider' },
    })).rejects.toThrow(/report identity does not match/);

    const passed = await recordProviderConformance(db.sql, { ...common, report: report(true) });
    expect(passed.binding).toMatchObject({
      classRef: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      conformanceRunId: passed.runId,
      conformanceStatus: 'passed',
      providerKind: 'tool',
      latencyClass: 'sync',
    });
    const providers = await listProviderBindings(db.sql, workspaceId, 'crm.email', '1.0.0');
    expect(providers).toHaveLength(1);
    expect(providers[0]?.conformanceRunId).toBe(passed.runId);

    await expect(db.sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id)
      VALUES (${workspaceId}, 'crm.email', '1.0.0', 'acme-crm', '2.0.1', ${passed.runId})
    `).rejects.toThrow(/capability_class_provider_run_fk/);

    await bindCapabilityProviderToPot(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      boundBy: 'operator-1',
    });
    const rows = await db.sql<{ provider_package: string; provider_version: string }[]>`
      SELECT provider_package, provider_version
        FROM harness_shared.pot_capability_class_bindings
       WHERE workspace_id = ${workspaceId} AND pot_slug = 'sales-ops'`;
    expect(rows).toEqual([{ provider_package: 'acme-crm', provider_version: '2.0.0' }]);

    const current = await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
    });
    expect(current).toMatchObject({
      potSlug: 'sales-ops',
      classRef: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      conformanceRunId: passed.runId,
    });
    expect(current?.providerKind).toBe('tool');
    expect(current?.latencyClass).toBe('sync');
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'other-pot',
      classId: 'crm.email',
      classVersion: '1.0.0',
    })).toBeNull();
    const candidates = await listActiveCapabilityProviderCandidates(
      db.sql,
      workspaceId,
      'crm.email',
      '1.0.0',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        providerPackage: 'acme-crm',
        passingStructuralRuns: 1,
        totalStructuralRuns: 2,
        activePotBindings: 1,
      }),
    ]);

    await db.sql.unsafe(
      "UPDATE harness_shared.capability_class_provider_bindings SET status = 'retired' " +
      "WHERE workspace_id = 'ws-binding' AND provider_package = 'acme-crm'",
    );
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
    })).toBeNull();
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      includeInactiveProvider: true,
    })).toMatchObject({
      providerPackage: 'acme-crm',
      status: 'retired',
    });
    expect(await listActiveCapabilityProviderCandidates(
      db.sql,
      workspaceId,
      'crm.email',
      '1.0.0',
    )).toEqual([]);

    const dependents = await listCapabilityProviderDependents(db.sql, {
      workspaceId,
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
    });
    expect(dependents).toEqual([
      expect.objectContaining({
        potSlug: 'sales-ops',
        classRef: 'crm.email@1.0.0',
        providerPackage: 'acme-crm',
        providerVersion: '2.0.0',
      }),
    ]);
    expect(await listCapabilityProviderDependents(db.sql, {
      workspaceId,
      providerPackage: 'acme-crm',
      providerVersion: '9.9.9',
    })).toEqual([]);
    expect(await deletePotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      expectedProviderPackage: 'acme-crm',
      expectedProviderVersion: '2.0.0',
    })).toBe(true);
    expect(await listCapabilityProviderDependents(db.sql, {
      workspaceId,
      providerPackage: 'acme-crm',
    })).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // P-043 (D-031): ONE capability contract, TWO independent providers.
  // Thresholds T1-T6 were declared in D-035 before any of this was measured.
  // ---------------------------------------------------------------------------

  it('T1/T2: carries two independent providers for one class, each on its own evidence', async () => {
    const workspaceId = 'ws-p043-two';
    const { acme, bluewave } = await twoProviderWorkspace(workspaceId);

    // Both passed on the REAL validator, not a hand-written verdict.
    expect(acme.report.ok).toBe(true);
    expect(bluewave.report.ok).toBe(true);

    const candidates = await listActiveCapabilityProviderCandidates(
      db.sql,
      workspaceId,
      'crm.email',
      '1.0.0',
    );
    // T1: EXACTLY two, not "at least one".
    expect(candidates).toHaveLength(2);
    expect(candidates.map((row) => row.providerPackage)).toEqual([ACME.pkg, BLUEWAVE.pkg]);
    expect(new Set(candidates.map((row) => row.providerPackage)).size).toBe(2);
    for (const candidate of candidates) {
      expect(candidate.passingStructuralRuns).toBeGreaterThanOrEqual(1);
      expect(candidate.conformanceStatus).toBe('passed');
    }

    // T2: independence is structural — disjoint tools, disjoint evidence.
    const toolsNamed = candidates.flatMap((row) => Object.values(row.verbBindings));
    expect(toolsNamed).toEqual([ACME.tool, BLUEWAVE.tool]);
    expect(new Set(toolsNamed).size).toBe(2);
    expect(acme.runId).not.toBe(bluewave.runId);
    expect(new Set(candidates.map((row) => row.conformanceRunId)).size).toBe(2);
    // Neither provider may carry the other's package identity.
    expect(acme.report.providerPackage).not.toBe(bluewave.report.providerPackage);
  });

  it('T5: rebinding moves the compiled pin — package and conformance run together', async () => {
    const workspaceId = 'ws-p043-rebind';
    const { acme, bluewave } = await twoProviderWorkspace(workspaceId);
    const potSlug = 'sales-ops';
    const resolve = () => getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
    });

    await bindCapabilityProviderToPot(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: ACME.pkg,
      providerVersion: ACME.version,
      boundBy: 'operator-1',
    });
    expect(await resolve()).toMatchObject({
      providerPackage: ACME.pkg,
      providerVersion: ACME.version,
      conformanceRunId: acme.runId,
      verbBindings: { send: ACME.tool },
    });

    // Actual rebinding to the OTHER provider.
    await bindCapabilityProviderToPot(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: BLUEWAVE.pkg,
      providerVersion: BLUEWAVE.version,
      boundBy: 'operator-2',
    });
    const rebound = await resolve();
    // T5: both halves of the pin move together. A changed package still carrying
    // acme's run id would mean the pin is nominal rather than compiled.
    expect(rebound).toMatchObject({
      providerPackage: BLUEWAVE.pkg,
      providerVersion: BLUEWAVE.version,
      conformanceRunId: bluewave.runId,
      verbBindings: { send: BLUEWAVE.tool },
    });
    expect(rebound?.conformanceRunId).not.toBe(acme.runId);

    // A newer package version of the SAME provider does not silently migrate the
    // pot: it is a separate binding, and the pot stays pinned where it was.
    const bumped = await conform(db, {
      workspaceId,
      capabilityClass: (await getCapabilityClass(db.sql, workspaceId, 'crm.email', '1.0.0'))!,
      provider: { pkg: BLUEWAVE.pkg, version: '3.2.0' },
      verbBindings: { send: BLUEWAVE.tool },
      lookup: toolLookup(providerTool({ ...BLUEWAVE, version: '3.2.0' })),
    });
    expect(bumped.binding).not.toBeNull();
    expect((await resolve())?.providerVersion).toBe(BLUEWAVE.version);

    // Compensation is guarded by the expected tuple: a stale expectation is refused.
    expect(await deletePotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
      expectedProviderPackage: ACME.pkg,
      expectedProviderVersion: ACME.version,
    })).toBe(false);
    expect(await resolve()).not.toBeNull();
  });

  it('T4: separates publisher authenticity, conformance evidence and administrator authorization', async () => {
    const workspaceId = 'ws-p043-authority';
    const { capabilityClass, bluewave } = await twoProviderWorkspace(workspaceId);

    // LEG 1 — publisher authenticity. One provider may not launder the other's
    // passing evidence by recording it under its own tuple.
    const bluewaveReport = validateProviderInterface({
      capabilityClass,
      providerPackage: BLUEWAVE.pkg,
      providerVersion: BLUEWAVE.version,
      registryRevision: 'registry-r1',
      verbBindings: { send: BLUEWAVE.tool },
      lookup: toolLookup(providerTool(BLUEWAVE)),
    });
    expect(bluewaveReport.ok).toBe(true);
    await expect(recordProviderConformance(db.sql, {
      workspaceId,
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: ACME.pkg,
      providerVersion: ACME.version,
      verbBindings: { send: BLUEWAVE.tool },
      report: bluewaveReport,
    })).rejects.toThrow(/report identity does not match/);

    // LEG 2 — conformance evidence. An authentic publisher whose tool is absent
    // from the live registry produces no binding at all.
    const rogue = await conform(db, {
      workspaceId,
      capabilityClass,
      provider: { pkg: 'rogue-mail', version: '1.0.0' },
      verbBindings: { send: 'rogue:send' },
      lookup: toolLookup(providerTool(ACME), providerTool(BLUEWAVE)),
    });
    expect(rogue.report.ok).toBe(false);
    expect(rogue.report.checks[0]?.problems).toContain(
      'tool is not present in the live projected-tool registry',
    );
    expect(rogue.binding).toBeNull();

    // LEG 3 — administrator authorization. This is the decisive case: bluewave is
    // authentic AND conformant AND listed as a candidate, yet no pot resolves to
    // it until an administrator binds it. Conformance is not adoption.
    const candidates = await listActiveCapabilityProviderCandidates(
      db.sql,
      workspaceId,
      'crm.email',
      '1.0.0',
    );
    expect(candidates.map((row) => row.providerPackage)).toEqual([ACME.pkg, BLUEWAVE.pkg]);
    expect(candidates.every((row) => row.activePotBindings === 0)).toBe(true);
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'never-authorized',
      classId: 'crm.email',
      classVersion: '1.0.0',
    })).toBeNull();

    // Authorizing ONE provider leaves the other conformant but unadopted.
    await bindCapabilityProviderToPot(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: BLUEWAVE.pkg,
      providerVersion: BLUEWAVE.version,
      boundBy: 'operator-1',
    });
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
    })).toMatchObject({ providerPackage: BLUEWAVE.pkg, conformanceRunId: bluewave.runId });
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'support',
      classId: 'crm.email',
      classVersion: '1.0.0',
    })).toBeNull();
  });

  it('T3: refuses an authority ceiling breach, a missing provider and an incompatible interface version', async () => {
    const workspaceId = 'ws-p043-refusals';
    const { capabilityClass, lookup } = await twoProviderWorkspace(workspaceId);
    const baseline = await listActiveCapabilityProviderCandidates(
      db.sql, workspaceId, 'crm.email', '1.0.0',
    );
    expect(baseline).toHaveLength(2);

    // NEGATIVE — authority ceiling. The class contract is the ceiling: a provider
    // offering a verb the class never declared cannot widen it into a binding.
    const overreaching = await conform(db, {
      workspaceId,
      capabilityClass,
      provider: { pkg: ACME.pkg, version: '2.5.0' },
      verbBindings: { send: ACME.tool, purge: ACME.tool },
      lookup,
    });
    expect(overreaching.report.ok).toBe(false);
    expect(overreaching.report.checks.find((check) => check.verb === 'purge')?.problems)
      .toContain('binding names a verb the class does not declare');
    expect(overreaching.binding).toBeNull();

    // NEGATIVE — missing/optional provider. A class verb left unbound fails closed;
    // there is no optional-verb escape that yields a partial provider.
    const incomplete = await conform(db, {
      workspaceId,
      capabilityClass,
      provider: { pkg: ACME.pkg, version: '2.6.0' },
      verbBindings: {},
      lookup,
    });
    expect(incomplete.report.ok).toBe(false);
    expect(incomplete.report.checks[0]?.problems).toContain('missing provider tool binding');
    expect(incomplete.binding).toBeNull();

    // Neither refusal contaminated the resolvable set.
    expect(await listActiveCapabilityProviderCandidates(
      db.sql, workspaceId, 'crm.email', '1.0.0',
    )).toHaveLength(2);

    // NEGATIVE — incompatible INTERFACE version. A new class version is a new
    // contract; conformance to 1.0.0 never carries forward to 1.1.0.
    const v11 = await defineCapabilityClass(db.sql, {
      workspaceId,
      id: 'crm.email',
      version: '1.1.0',
      title: 'CRM email',
      description: 'Send customer email with a subject line.',
      interfaceVerbs: {
        send: {
          inputSchema: {
            type: 'object',
            properties: { body: { type: 'string' }, subject: { type: 'string' } },
            required: ['body', 'subject'],
          },
        },
      },
      createdBy: 'operator-1',
    });
    expect(await listProviderBindings(db.sql, workspaceId, 'crm.email', '1.1.0')).toEqual([]);
    expect(await listActiveCapabilityProviderCandidates(
      db.sql, workspaceId, 'crm.email', '1.1.0',
    )).toEqual([]);
    const staleAgainstNewContract = validateProviderInterface({
      capabilityClass: v11.capabilityClass,
      providerPackage: ACME.pkg,
      providerVersion: ACME.version,
      registryRevision: 'registry-r1',
      verbBindings: { send: ACME.tool },
      lookup,
    });
    expect(staleAgainstNewContract.ok).toBe(false);
    expect(staleAgainstNewContract.checks[0]?.problems)
      .toContain('input schema differs from the class contract');

    // NEGATIVE — a class with no conformant provider at all resolves to nothing.
    await defineCapabilityClass(db.sql, {
      workspaceId,
      id: 'crm.fax',
      version: '1.0.0',
      title: 'CRM fax',
      description: 'Send a fax.',
      interfaceVerbs: verbs,
      createdBy: 'operator-1',
    });
    expect(await listActiveCapabilityProviderCandidates(
      db.sql, workspaceId, 'crm.fax', '1.0.0',
    )).toEqual([]);
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.fax',
      classVersion: '1.0.0',
    })).toBeNull();
  });

  it('T3: survives mid-session provider failure by revoking one provider and failing over to the other', async () => {
    const workspaceId = 'ws-p043-failover';
    const { capabilityClass, acme, bluewave } = await twoProviderWorkspace(workspaceId);
    const potSlug = 'sales-ops';
    const resolve = () => getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
    });

    await bindCapabilityProviderToPot(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: ACME.pkg,
      providerVersion: ACME.version,
      boundBy: 'operator-1',
    });
    expect((await resolve())?.conformanceRunId).toBe(acme.runId);

    // MID-SESSION FAILURE: acme's tool disappears from the live registry under a
    // running session. The failing run is recorded as evidence; it does NOT
    // silently rewrite the binding, because revocation is an administrator act.
    const failed = await conform(db, {
      workspaceId,
      capabilityClass,
      provider: ACME,
      verbBindings: { send: ACME.tool },
      lookup: toolLookup(providerTool(BLUEWAVE)),
    });
    expect(failed.report.ok).toBe(false);
    expect(failed.binding).toBeNull();
    const afterFailure = await listActiveCapabilityProviderCandidates(
      db.sql, workspaceId, 'crm.email', '1.0.0',
    );
    const acmeCandidate = afterFailure.find((row) => row.providerPackage === ACME.pkg);
    expect(acmeCandidate).toMatchObject({ passingStructuralRuns: 1, totalStructuralRuns: 2 });
    expect(acmeCandidate?.conformanceRunId).toBe(acme.runId);

    // IMMEDIATE REVOCATION: the administrator retires acme. Resolution fails closed
    // on the very next read even though the pot row still names acme.
    await db.sql`
      UPDATE harness_shared.capability_class_provider_bindings
         SET status = 'retired'
       WHERE workspace_id = ${workspaceId} AND provider_package = ${ACME.pkg}`;
    expect(await resolve()).toBeNull();
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
      includeInactiveProvider: true,
    })).toMatchObject({ providerPackage: ACME.pkg, status: 'retired' });

    // ISOLATION: revoking one provider must not disturb the other.
    const survivors = await listActiveCapabilityProviderCandidates(
      db.sql, workspaceId, 'crm.email', '1.0.0',
    );
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({
      providerPackage: BLUEWAVE.pkg,
      conformanceRunId: bluewave.runId,
    });

    // FAILOVER — the payoff of carrying two providers for one contract.
    await bindCapabilityProviderToPot(db.sql, {
      workspaceId,
      potSlug,
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: BLUEWAVE.pkg,
      providerVersion: BLUEWAVE.version,
      boundBy: 'operator-2',
    });
    expect(await resolve()).toMatchObject({
      providerPackage: BLUEWAVE.pkg,
      conformanceRunId: bluewave.runId,
      verbBindings: { send: BLUEWAVE.tool },
    });
  });
});

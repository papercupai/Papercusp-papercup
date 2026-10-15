import type { Sql } from 'postgres';
import type { OrderedSelectionPolicy } from '../../../packages/operator-core/lib/typed-properties';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** Record an original journey inside the test's measured lifetime, never at import time. */
export async function recordNativeCollectionJourney(input: {
  sourceRoot: string;
  sourceReceipt: { schemaVersion: string; sourceCommit: string; testedInputs: Array<{ path: string; sha256: string }> };
  verifierRunId: string;
  testPath: string;
  evidenceRoot?: string;
  run: () => Promise<void>;
}) {
  const { defaultEvidenceRoot, runHarness } = await import('@papercusp/verification-harness');
  const receipt = input.sourceReceipt;
  if (receipt.schemaVersion !== 'verifier-source-v1' || !/^[a-f0-9]{40,64}$/.test(receipt.sourceCommit)
    || !/^\d{8}T\d{6}Z-\d+(?:\.\d+)?$/.test(input.verifierRunId)
    || !Array.isArray(receipt.testedInputs) || !receipt.testedInputs.some(file => file.path === input.testPath))
    throw new Error('Native journey requires the original verifier source and test custody');
  const sourceRoot = resolve(input.sourceRoot);
  const measure = async () => Promise.all(receipt.testedInputs.map(async file => {
    const path = resolve(sourceRoot, file.path);
    if (!path.startsWith(sourceRoot + sep) || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('Invalid native journey source input');
    const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
    if (sha256 !== file.sha256) throw new Error(`Native journey source changed: ${file.path}`);
    return { path: file.path, sha256 };
  }));
  let failure: unknown;
  const result = await runHarness({
    contract: { name: 'native-journey', phases: [{ id: 'native' }] },
    evidenceRoot: input.evidenceRoot ?? defaultEvidenceRoot('native-journey'),
    runPhase: async ({ evidenceDir }) => {
      try {
        const before = await measure();
        await input.run();
        const after = await measure();
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native journey source drift');
        await writeFile(join(evidenceDir, 'manifest.json'), JSON.stringify({ result: 'pass',
          sourceCommit: receipt.sourceCommit, sourceFingerprints: after, testPath: input.testPath,
          verifierRunId: input.verifierRunId }));
        return { ok: true };
      } catch (error) { failure = error; throw error; }
    },
  });
  if (result.verdict !== 'pass') throw failure ?? new Error('Native journey did not pass');
  return { kind: 'verification-harness' as const, verifierRunId: input.verifierRunId,
    journeyHarness: 'native-journey', journeyRunId: result.runId };
}

/** The generic fixture must not use the reserved unpackaged legacy WOE signature. */
export function nativeCollectionDeclaration(kind: 'plans' | 'tea', ids: string[], policy: OrderedSelectionPolicy) {
  const property = kind === 'plans' ? 'worklist' : 'tea_choices';
  const policyName = kind === 'plans' ? 'native_worklist_policy' : 'tea_policy';
  return { property, policyName, schema: {
    [property]: { datatype: kind === 'plans' ? 'plan-ref-list' : 'string-list', editable_by: 'both', default: ids,
      collection: { source: kind === 'plans' ? 'active-workspace-plans' : 'manual', policy: policyName,
        order: kind === 'plans' ? 'priority' : 'display', selectable: true, defaultSelected: true } },
    [policyName]: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: policy },
  } };
}

/** Exercise archival disappearance/rediscovery without requesting shipment. */
export async function setNativeCollectionPlanArchived(sql: Sql, input: {
  workspaceId: string;
  harness: string;
  slug: string;
  archived: boolean;
}) {
  // Archiving is independent of lifecycle status. `done` is an item alias,
  // while `shipped` requires an acceptance receipt; neither belongs in this fixture.
  await sql`UPDATE harness_shared.harness_plans
    SET archived=${input.archived}
    WHERE workspace_id=${input.workspaceId} AND harness_slug=${input.harness} AND plan_slug=${input.slug}`;
}

/** Seed through the same SQL path in the cheap PG guard and owned native run. */
export async function insertNativeCollectionGoal(sql: Sql, input: {
  workspaceId: string;
  goalId: string;
  title: string;
  schema: Record<string, unknown>;
}) {
  // An explicit text parameter avoids default postgres-js JSONB serialization
  // double-encoding this already-stringified declaration.
  await sql`INSERT INTO harness_shared.goals (workspace_id,id,install_slug,title,status,property_schema)
    VALUES (${input.workspaceId},${input.goalId},${input.goalId},${input.title},'active',
            ${JSON.stringify(input.schema)}::text::jsonb)`;
}

/** Seed the normalized item source that the real portfolio admission reader uses. */
export async function insertNativeCollectionPlan(sql: Sql, input: {
  workspaceId: string;
  harness: string;
  slug: string;
  title: string;
  status: 'active' | 'draft';
}) {
  const item = { id: 'P-001', status: 'todo', text: `Native ${input.slug} work`, blockedBy: [] };
  await sql.begin(async tx => {
    await tx`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,title,status,op_status,items)
      VALUES (${input.workspaceId},${input.harness},${input.slug},${input.title},${input.status},NULL,
              ${JSON.stringify([item])}::text::jsonb)`;
    await tx`INSERT INTO harness_shared.plan_items
      (workspace_id,harness_slug,plan_slug,item_id,seq,item_text,status,blocked_by)
      VALUES (${input.workspaceId},${input.harness},${input.slug},${item.id},1,${item.text},'todo',ARRAY[]::text[])`;
  });
}

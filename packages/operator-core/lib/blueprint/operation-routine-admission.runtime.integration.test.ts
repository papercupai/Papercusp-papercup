/** Current-build background admission proof, using the maintained private runtime
 * launcher. This does not certify provider spend or the deployed bg-host. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const paths = [
  'packages/operator-core/lib/blueprint/operation-routine-admission.ts',
  'packages/operator-core/lib/harness/routines/blueprint-operation-action.ts',
];
const fingerprint = () => Object.fromEntries(paths.map(path => [path,
  createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
]));

it('runs the admission and native pause controls in an isolated current-build background environment', { timeout: 180_000 }, () => {
  const before = fingerprint();
  const probe = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { readFile } from 'node:fs/promises';
    import postgres from 'postgres';
    import { assertRoutineOperationAdmission } from './packages/operator-core/lib/blueprint/operation-routine-admission.ts';
    import { runBlueprintOperationAction } from './packages/operator-core/lib/harness/routines/blueprint-operation-action.ts';
    const home = process.env.HOME;
    console.log('AI_BACKGROUND_HOME ' + home);
    assert.equal(process.env.PAPERCUSP_HOME, home + '/.papercusp');
    assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
    assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
    assert.ok(process.env.DBOS__VMID.startsWith('test-runtime-'));
    assert.ok(!Object.keys(process.env).some(k => /^(OPENAI_|ANTHROPIC_|CODEX_HOME$)/.test(k)));
    const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
    assert.ok(workspaceId.startsWith('test-runtime-'));
    const url = new URL(process.env.HARNESS_ADMIN_DATABASE_URL);
    assert.notEqual(url.port, '5432');
    const sql = postgres(url.href, { max: 2, prepare: false });
    const routineId = 'ai-background-governance';
    const harnessSlug = 'ai-background-private';
    const templateSlug = 'daily-ai-background';
    const payloadTemplate = { harnessSlug, templateSlug, operationHarnessSlug: harnessSlug, operationId: 'daily-ai-brief', input: {} };
    const check = requestKey => sql.begin(tx => assertRoutineOperationAdmission(tx, {
      workspaceId, routineId, callerId: 'routine:' + routineId, requestKey,
    }));
    try {
      await sql\`INSERT INTO harness_shared.routines
        (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template, concurrency, active)
        VALUES (\${routineId}, \${workspaceId}, \${harnessSlug}, \${templateSlug}, 'cron',
          \${sql.json({costCapCents:200})}, 'system:blueprint-operation', \${sql.json(payloadTemplate)}, 'skip', true)\`;
      await sql\`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, content, content_hash, status, schedule_active)
        VALUES (\${workspaceId}, \${harnessSlug}, \${templateSlug}, 'Private AI', '# Private AI', 'fixture', 'active', true)\`;
      await check('first-fire');
      await sql\`INSERT INTO harness_shared.work_items (workspace_id, feature_id, harness_slug, status, payload)
        VALUES (\${workspaceId}, 'WI-80000001', \${harnessSlug}, 'open',
          \${sql.json({ blueprintOperation: { callerId: 'routine:' + routineId, requestKey: 'first-fire' } })})\`;
      await assert.rejects(check('next-fire'), e => e.reason === 'overlap');
      // Exact-occurrence replay is not treated as another worker by the guard.
      await check('first-fire');
      await sql\`UPDATE harness_shared.work_items SET status = 'done'
        WHERE workspace_id = \${workspaceId} AND feature_id = 'WI-80000001'\`;
      let afterGuard = false;
      const result = await runBlueprintOperationAction({ workspaceId, installSlug: harnessSlug,
        routineId, workflowId: 'next-fire', triggerConfig: { costCapCents: 200 }, payloadTemplate }, {
        sql,
        submit: async (_db, _input, internal) => {
          await sql.begin(tx => internal.beforeNewAdmission(tx));
          afterGuard = true;
          throw new Error('unknown-cost worker must not reach admission');
        },
      });
      assert.equal(afterGuard, false);
      assert.deepEqual(result.diagnostics.blueprintOperationAdmission,
        { admitted: false, reason: 'cost-unknown', paused: true, costCents: null });
      const [controls] = await sql\`SELECT r.active, p.schedule_active,
          r.metadata->'pause'->>'reason' AS reason FROM harness_shared.routines r
        JOIN harness_shared.harness_plans p ON p.workspace_id = r.workspace_id
          AND p.harness_slug = \${harnessSlug} AND p.plan_slug = \${templateSlug}
        WHERE r.workspace_id = \${workspaceId} AND r.id = \${routineId}\`;
      assert.deepEqual(controls, { active: false, schedule_active: false,
        reason: 'blueprint_operation_routine_cost-unknown' });
      const hashes = Object.fromEntries(await Promise.all(${JSON.stringify(paths)}.map(async path => [path,
        createHash('sha256').update(await readFile(path)).digest('hex')])));
      console.log('AI_BACKGROUND_PROOF ' + JSON.stringify({ hashes, controls, overlapRefused: true,
        exactReplayAllowed: true, unknownCostAdmissionRefused: !afterGuard, privateBackground: true }));
    } finally { await sql.end({ timeout: 5 }); }
  `;
  const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe,
  ], { cwd: root, encoding: 'utf8', timeout: 150_000, maxBuffer: 1024 * 1024 });
  const detail = result.stderr.slice(-4000) + result.stdout.slice(-2500);
  const childHome = result.stdout.match(/^AI_BACKGROUND_HOME (.+)$/m)?.[1];
  expect(result.status, detail).toBe(0);
  expect(childHome, detail).toBeTruthy();
  expect(existsSync(childHome!), 'the maintained launcher must remove the private HOME').toBe(false);
  const dataDir = result.stdout.match(/\(datadir ([^)]+)\)/)?.[1];
  expect(dataDir, detail).toBeTruthy();
  expect(existsSync(dataDir!), 'the maintained launcher must remove the private PG directory').toBe(false);
  const proof = result.stdout.match(/^AI_BACKGROUND_PROOF (.+)$/m)?.[1];
  expect(proof, detail).toBeTruthy();
  expect(JSON.parse(proof!)).toMatchObject({ hashes: before, overlapRefused: true,
    exactReplayAllowed: true, unknownCostAdmissionRefused: true, privateBackground: true,
    controls: { active: false, schedule_active: false } });
  expect(fingerprint(), 'source must remain identical while the child verifies it').toEqual(before);
});

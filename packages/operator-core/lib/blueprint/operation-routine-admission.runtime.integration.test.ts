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
  'packages/operator-core/lib/harness/routines/arm-plan-schedule.ts',
  'packages/operator-core/lib/report-library.ts',
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
    import { createServer } from 'node:http';
    import postgres from 'postgres';
    import { assertRoutineOperationAdmission } from './packages/operator-core/lib/blueprint/operation-routine-admission.ts';
    import { runBlueprintOperationAction } from './packages/operator-core/lib/harness/routines/blueprint-operation-action.ts';
    import { disarmPlanSchedule } from './packages/operator-core/lib/harness/routines/arm-plan-schedule.ts';
    import { planScheduleRoutineName } from './packages/operator-core/lib/harness/routines/materialize-plan-schedule.ts';
    import { publishReport, getReport, listReports } from './packages/operator-core/lib/report-library.ts';
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
    const routineName = planScheduleRoutineName(templateSlug);
    const payloadTemplate = { harnessSlug, templateSlug, operationHarnessSlug: harnessSlug, operationId: 'daily-ai-brief', input: {} };
    const check = requestKey => sql.begin(tx => assertRoutineOperationAdmission(tx, {
      workspaceId, routineId, callerId: 'routine:' + routineId, requestKey,
    }));
    try {
      await sql\`INSERT INTO harness_shared.routines
        (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template, concurrency, active)
        VALUES (\${routineId}, \${workspaceId}, \${harnessSlug}, \${routineName}, 'cron',
          \${sql.json({costCapCents:200})}, 'system:blueprint-operation', \${sql.json(payloadTemplate)}, 'skip', true)\`;
      await sql\`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, content, content_hash, status, schedule_active)
        VALUES (\${workspaceId}, \${harnessSlug}, \${templateSlug}, 'Private AI', '# Private AI', 'fixture', 'active', true)\`;
      await check('first-fire');
      await sql\`INSERT INTO harness_shared.work_items (workspace_id, feature_id, harness_slug, status, payload)
        VALUES (\${workspaceId}, 'WI-80000001', \${harnessSlug}, 'open',
          \${sql.json({ blueprintOperation: { callerId: 'routine:' + routineId, requestKey: 'first-fire' } })})\`;
      await assert.rejects(check('next-fire'), e => e.reason === 'overlap');
      let duplicateAdmitted = false;
      const duplicate = await runBlueprintOperationAction({ workspaceId, installSlug: harnessSlug,
        routineId, workflowId: 'duplicate-fire', triggerConfig: {}, payloadTemplate }, {
        sql, submit: async (_db, _input, internal) => {
          await sql.begin(tx => internal.beforeNewAdmission(tx));
          duplicateAdmitted = true;
          throw new Error('overlapping worker must not reach admission');
        },
      });
      assert.equal(duplicateAdmitted, false);
      assert.deepEqual(duplicate.diagnostics.blueprintOperationAdmission,
        { admitted: false, reason: 'overlap', paused: false, costCents: null });
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
      // D-004's uncapped control uses a real persisted expensive usage sample.
      // The existing admission guard must leave both native controls armed.
      await sql\`UPDATE harness_shared.routines SET active = true, trigger_config = '{}'::jsonb
        WHERE workspace_id = \${workspaceId} AND id = \${routineId}\`;
      await sql\`UPDATE harness_shared.harness_plans SET schedule_active = true
        WHERE workspace_id = \${workspaceId} AND harness_slug = \${harnessSlug} AND plan_slug = \${templateSlug}\`;
      await sql\`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, harness_slug, run_id, ts, bucket_key, provider, model_class, source, cost_usd)
        VALUES (\${workspaceId}, \${harnessSlug}, 'private-expensive-run', 1000,
          'private-expensive-sample', 'openai', 'codex', 'interactive', 999)\`;
      await check('uncapped-next-fire');
      const [uncapped] = await sql\`SELECT r.active, p.schedule_active,
          r.trigger_config ? 'costCapCents' AS capped,
          (SELECT sum(cost_usd) * 100 FROM harness_shared.agent_usage_samples
            WHERE workspace_id = \${workspaceId} AND harness_slug = \${harnessSlug})::float8 AS recorded_cost_cents
        FROM harness_shared.routines r JOIN harness_shared.harness_plans p
          ON p.workspace_id = r.workspace_id AND p.harness_slug = \${harnessSlug} AND p.plan_slug = \${templateSlug}
        WHERE r.workspace_id = \${workspaceId} AND r.id = \${routineId}\`;
      assert.deepEqual(uncapped, { active: true, schedule_active: true, capped: false, recorded_cost_cents: 99900 });
      // Inject an actual local HTTP failure; this fixture makes no news-quality claim.
      const feed = createServer((_request, response) => { response.writeHead(502); response.end('fixture source outage'); });
      await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve));
      let feedStatus;
      try {
        const response = await fetch('http://127.0.0.1:' + feed.address().port + '/feed');
        feedStatus = response.status;
        assert.equal(response.ok, false);
        await response.text();
      } finally { await new Promise((resolve, reject) => feed.close(error => error ? reject(error) : resolve())); }
      assert.equal(feedStatus, 502);
      const reportInput = { workspaceId, title: 'Papercusp AI Brief — private source-failure fixture',
        bodyMd: '# Partial coverage\\n\\nFixture feed failed with HTTP ' + feedStatus
          + '. No material-updates conclusion is possible.\\n\\n## Papercusp opportunities\\n\\n'
          + 'No actionable idea: source coverage is inadequate. Confidence: unavailable. Next action: retry source collection.',
        kind: 'status-digest', visibility: 'workspace', requestKey: 'private-failed-feed',
        subject: { kind: 'external', ref: 'private-ai-source-failure' } };
      const origin = { authorOwnerId: 'private-ai-fixture', authorSessionRef: 'fixture:source-outage',
        harnessSlug, requestScope: 'blueprint-operation:private-ai-fixture' };
      const published = await publishReport(sql, reportInput, origin);
      assert.equal((await publishReport(sql, reportInput, origin)).reportId, published.reportId);
      const readback = await getReport(sql, workspaceId, published.reportId, { isOwner: true });
      assert.equal(readback.bodyMd, reportInput.bodyMd);
      assert.equal((await listReports(sql, { workspaceId, viewer: { isOwner: true }, subject: reportInput.subject })).length, 1);
      const disarmed = await disarmPlanSchedule({ sql, workspaceId, harnessSlug, templateSlug });
      assert.deepEqual(disarmed, { ok: true });
      await assert.rejects(check('after-native-disarm'), error => error.reason === 'inactive');
      const [paused] = await sql\`SELECT r.active, p.schedule_active FROM harness_shared.routines r
        JOIN harness_shared.harness_plans p ON p.workspace_id = r.workspace_id
          AND p.harness_slug = \${harnessSlug} AND p.plan_slug = \${templateSlug}
        WHERE r.workspace_id = \${workspaceId} AND r.id = \${routineId}\`;
      assert.deepEqual(paused, { active: false, schedule_active: false });
      const hashes = Object.fromEntries(await Promise.all(${JSON.stringify(paths)}.map(async path => [path,
        createHash('sha256').update(await readFile(path)).digest('hex')])));
      console.log('AI_BACKGROUND_PROOF ' + JSON.stringify({ hashes, controls, overlapRefused: true,
        exactReplayAllowed: true, unknownCostAdmissionRefused: !afterGuard, privateBackground: true,
        duplicate: duplicate.diagnostics.blueprintOperationAdmission, uncapped, disarmed, paused,
        sourceFailure: { status: feedStatus, reportId: published.reportId, body: readback.bodyMd, reports: 1 } }));
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
  expect(JSON.parse(proof!)).toMatchObject({
    duplicate: { admitted: false, reason: 'overlap', paused: false },
    uncapped: { active: true, schedule_active: true, capped: false, recorded_cost_cents: 99900 },
    disarmed: { ok: true }, paused: { active: false, schedule_active: false },
    sourceFailure: { status: 502, reports: 1, body: expect.stringContaining('# Partial coverage') },
  });
  console.info('AI_BACKGROUND_ACCEPTANCE_RECEIPT ' + proof);
  expect(fingerprint(), 'source must remain identical while the child verifies it').toEqual(before);
});

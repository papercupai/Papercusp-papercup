/** P-009: drive the loaded staging park resolver with private, owned fixtures. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { executeOperationalRun, parseOperationalEvidenceArtifact, type OperationalEvidenceArtifact } from '../agent-tools/testing/record-run';
import { updateExternalBlockerHistory } from '../external-blockers';
import { DECISION_REVIEW_CASCADE_FLAVOR } from './decision-review';

const root = resolve(import.meta.dirname, '../../../..');
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
const workspace = 'papercusp-workspace';
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const flowAssertion = (flow: string, evidence: string): OperationalEvidenceArtifact['assertions'][number] => ({
  id: `loaded-staging-${flow}-clears-blocker-and-records-wake`, passed: true, evidence,
});

function call(name: string, args: Record<string, unknown>, origin: string) {
  const env = { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' };
  delete env.PAPERCUSP_SCRATCH_ROOT;
  const result = spawnSync(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
    'tools:invoke', `--url=${origin}`, '--json', '-'], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    input: JSON.stringify({ name, args: { ...args, payloadTier: 'full' } }),
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value.ok, JSON.stringify(value)).not.toBe(false);
  expect(value.error, JSON.stringify(value)).toBeUndefined();
  return value;
}

function rows(sql: string, origin: string) {
  return call('dev:pg_query', { sql, maxRows: 10, timeoutMs: 15_000,
    allowUnscoped: false, allowUnboundedJsonSearch: false }, origin).rows as Array<Record<string, any>>;
}

function mutate(sql: string, origin: string, expectedRows: number) {
  const value = call('dev:pg_mutate', { sql, expectedRows, maxAffectedRows: 2,
    reason: 'P-009 live acceptance: private fixture owned by the executing session; no routed consult or peer dispatch',
    timeoutMs: 15_000 }, origin);
  expect(value.committed).toBe(true);
  return value;
}

describe.skipIf(!profilePath)('consult-backed parking on the loaded staging operator', () => {
  it('adopts an alternative and proceeds at a silent deadline, clearing blockers and recording verdict wakes', async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.runtimeUnits).toContain('hono-host:3170');
    const origin = profile.origin as string;
    const recordContext = { workspaceId: workspace, harnessSlug: 'papercusp', projectDir: root };
    expect(resolveAgentWorkspaceRoot(recordContext), 'Recorder must measure this committed test tree').toBe(root);
    // Validate the recorder contract before creating any live fixture. The same
    // typed builder produces the final evidence, so a malformed success result
    // fails here rather than after the two production flows have executed.
    const preflightAt = new Date().toISOString();
    parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify({
      schemaVersion: 1, kind: 'operational-test-evidence', name: 'P-009 recorder contract preflight',
      framework: 'operational', command: ['npm', 'run', 'test:file'], exitCode: 0,
      startedAt: preflightAt, finishedAt: preflightAt, summary: 'Validate before live fixture writes',
      assertions: ['adopted', 'proceed'].map(flow => flowAssertion(flow, 'recorder contract preflight')),
    })));
    const owner = call('coord:whoami', {}, origin).ownerId as string;
    expect(owner).toBe(process.env.PAPERCUSP_SID);
    for (const path of ['packages/operator-core/lib/consult/park-adapters.ts',
      'packages/operator-core/lib/consult/park-prod.ts']) {
      const route = call('dev:pipeline_position', { path, testClass: 'operator-api',
        expectedSourceSha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
        projection: { pick: ['acceptedSource', 'currentBuildTestRoute'] } }, origin);
      expect(route.currentBuildTestRoute.readiness).toBe('ready');
      expect(route.acceptedSource.matches).toBe(true);
      expect(route.acceptedSource.runtimeContainment['staging-operator']).toBe(true);
    }

    const measured = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/consult/park.live.e2e.test.ts',
      name: 'Adopt-alternative and silent-proceed through the loaded staging park resolver',
      framework: 'operational',
      command: ['npm', 'run', 'test:file', '--', 'packages/operator-core/lib/consult/park.live.e2e.test.ts'],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        const observations: Array<Record<string, unknown>> = [];
        for (const flow of ['adopted', 'proceed'] as const) {
          const workItemId = `WI-P009-LIVE-${randomUUID()}`;
          const opened = call('coord:message-agent', { harness: 'papercusp',
            title: `Private P-009 ${flow} fixture ${workItemId}`,
            body: 'Owned live acceptance fixture. No direct addressee and no expert routing.' }, origin);
          const consultId = opened.conversation_id as string;
          expect(consultId).toBeTruthy();
          const blockerRef = `consult:${consultId}`;
          const eventKey = `consult:park-verdict:${consultId}`;
          const deadlineAt = new Date(Date.now() + (flow === 'proceed' ? -1000 : 3_600_000)).toISOString();
          const { blockers } = updateExternalBlockerHistory({}, { kind: 'human', capability: 'product-decision',
            ref: blockerRef, summary: 'Private live park acceptance', defaultIfUnanswered: 'Keep the existing name',
            decideBy: deadlineAt }, owner);
          const routing = { selection: { selected: [{ ownerId: owner }, { ownerId: `${owner}-fixture` }] },
            cascade: { flavor: DECISION_REVIEW_CASCADE_FLAVOR, workItemId, setterId: owner,
              defaultAction: 'Keep the existing name', deadlineAt, ownerAuthorityTopic: null } };
          const postId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
          try {
            mutate(`INSERT INTO harness_shared.work_items
              (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, payload, nature)
              VALUES (${literal(workspace)}, 'papercusp', ${literal(workItemId)}, 'task',
                'Private P-009 acceptance fixture', 'open', ${Date.now()},
                ${literal(JSON.stringify({ externalBlockers: blockers }))}::jsonb, 'work')`, origin, 1);
            mutate(`INSERT INTO harness_shared.consult_state
              (workspace_id, conversation_id, requester_id, responder_id, state, question, latency_contract, routing, cascade_cursor)
              VALUES (${literal(workspace)}, ${literal(consultId)}, ${literal(owner)}, NULL, 'active',
                'Private P-009 park', 'proceed', ${literal(JSON.stringify(routing))}::jsonb, 0)`, origin, 1);
            call('events:await', { event: eventKey, timeout_sec: 300, on_timeout: 'wake' }, origin);
            if (flow === 'adopted') {
              mutate(`INSERT INTO harness_shared.consult_post_meta
                (workspace_id, post_id, conversation_id, author_id, kind, stance)
                VALUES (${literal(workspace)}, ${postId}, ${literal(consultId)}, ${literal(`${owner}-fixture`)},
                  'new_fact', '{"position":"object","basis":"alternative","reason":"The old name collides","alternative":"Use the reviewed name"}'::jsonb)`, origin, 1);
            }
            // Requester maintenance triggers the same production resolver as a
            // reply/expiry. The proceed fixture has no reviewer replies at all;
            // the isolated integration suite separately exercises the sweep.
            call('consult:reply', { conversation_id: consultId, kind: 'new_fact',
              body: 'Private live acceptance checkpoint', ...(flow === 'adopted'
                ? { parkResponse: { kind: 'adopt', text: 'Use the reviewed name', objectionId: String(postId) } } : {}) }, origin);
            const [state] = rows(`SELECT park_state FROM harness_shared.consult_state
              WHERE workspace_id = ${literal(workspace)} AND conversation_id = ${literal(consultId)}`, origin);
            expect(state.park_state.outcomes.at(-1).verdict).toBe(flow);
            const [item] = rows(`SELECT payload FROM harness_shared.work_items
              WHERE workspace_id = ${literal(workspace)} AND harness_slug = 'papercusp' AND feature_id = ${literal(workItemId)}`, origin);
            expect(item.payload.externalBlockers.find((b: { ref: string }) => b.ref === blockerRef).status).toBe('cleared');
            const [wake] = rows(`SELECT fired_at, fired_payload FROM harness_shared.event_awaits
              WHERE workspace_id = 'default' AND subscriber_id = ${literal(owner)}
                AND event_key = ${literal(eventKey)} ORDER BY id DESC LIMIT 1`, origin);
            expect(wake, `Verdict await ${eventKey} in the event corpus`).toBeDefined();
            expect(wake.fired_at).toBeTruthy();
            expect(wake.fired_payload).toMatchObject({ verdict: flow, workItemId, recordedAs: 'peer-review' });
            observations.push({ flow, consultId, workItemId, outcome: state.park_state.outcomes.at(-1), wake: wake.fired_payload });
          } finally {
            call('consult:close', { conversation_id: consultId, outcome: 'cant_help',
              reason: 'Private P-009 acceptance fixture finished; observations retained in the native test log' }, origin);
            const owned = rows(`SELECT feature_id FROM harness_shared.work_items
              WHERE workspace_id = ${literal(workspace)} AND harness_slug = 'papercusp'
                AND feature_id = ${literal(workItemId)} AND title = 'Private P-009 acceptance fixture'`, origin);
            if (owned.length === 1) mutate(`DELETE FROM harness_shared.work_items
              WHERE workspace_id = ${literal(workspace)} AND harness_slug = 'papercusp'
                AND feature_id = ${literal(workItemId)} AND title = 'Private P-009 acceptance fixture'`, origin, 1);
          }
        }
        console.info('CBP_LIVE_PARK_PROOF', JSON.stringify(observations));
        return { exitCode: 0, summary: 'Both private park flows resolved through staging and fired the executing session verdict await',
          assertions: observations.map(o => flowAssertion(String(o.flow), JSON.stringify(o).slice(0, 2000))) };
      },
    }, recordContext);
    console.info('CBP_LIVE_PARK_RUN', JSON.stringify(measured));
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
  }, 900_000);
});

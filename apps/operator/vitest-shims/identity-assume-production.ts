/** Private-data composition for native takeover tests. Only the administrative
 * grant is fixture-owned; preparation readers, custody, pause/recovery, host
 * inspection and coordination storage are production implementations. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { setupBaselineCoordFixture } from '../../../packages/operator-core/lib/_baseline-coord-fixture';
import { prepareAssume, validateAssume, commitAssume, assumeTransitionKey, type AssumePreparation,
  verifyAssumeExecution, type AssumeExecutionObservation,
  type AssumeTransitionReceipt, type AssumeRequest } from '../../../packages/operator-core/lib/session-assume';
import { readAssumeCaller, readAssumeTarget } from '../../../packages/operator-core/lib/session-assume-preparation';
import { createAssumeAuthorizer, createAssumeTransitionDeps, inspectManagedAssumeRequest } from '../../../packages/operator-core/lib/session-assume-runtime';
import { createManagedAssumeHost } from '../../../packages/operator-core/lib/session-assume-host';
import { findLiveHostAsync, injectIntoHostWithConfirmation } from
  '../../../packages/operator-core/lib/events/await/psu-pty-discovery';
import { createAssumeReceiptStore } from '../../../packages/operator-core/lib/session-assume-store';
import { readAssumeCallerPause } from '../../../packages/operator-core/lib/session-assume-pause';
import { readAssumeCallerCheckpoint } from '../../../packages/operator-core/lib/session-assume-caller';
import { loopScope, setCarryNote } from '../../../packages/operator-core/lib/carry-note';
import { runWithWorkspace } from '../../../packages/operator-core/lib/workspace-als';
import { getWorkItem } from '../../../packages/operator-core/lib/work-items';
import { setWorkItemCheckpoint } from '../../../packages/operator-core/lib/work-item-checkpoint';
import { sendMessage, readInbox, appendAck, readAckedMsgIds } from
  '../../../packages/operator-core/lib/agent-tools/coordination/messages';
import { resolveAgentIdentity } from '../../../packages/operator-core/lib/agent-tools/coordination/identity';
import { getAdvSession, finalizeAdvSessionResume, reanchorAdvSessionNativeId } from '../../../packages/operator-core/lib/adv-sessions';
import { cleanupScopedNativeFixtureDatabase } from './scoped-native-fixture-cleanup';
import { acquireClaim, getClaim } from '../../../packages/operator-core/lib/plan-items/claims';
import { registerAwait, listActiveAwaits } from '../../../packages/operator-core/lib/events/await/store';
import { recordOwnerDirective, listOwnerDirectives } from '../../../packages/operator-core/lib/owner-directives';
import { createFleetIfAbsent, getFleet } from '../../../packages/operator-core/lib/agent-fleets-store';
import { createTopic, subscribeTopic, listMyTopicSubscriptions } from
  '../../../packages/operator-core/lib/agent-tools/coordination/topics';

export async function productionAssumeFixture(workspaceId: string,
  onDatabase: (sql: OrgTestDb['adminSql']) => void,
  withDatabase: <T>(sql: OrgTestDb['adminSql'], run: () => Promise<T>) => Promise<T>) {
  const database = await createOrgTestDb();
  onDatabase(database.adminSql);
  const fixture = await setupBaselineCoordFixture({ dsn: database.adminDsn });
  const secret = randomBytes(32);
  const sql = fixture.admin;
  const identity = (ownerId: string) => resolveAgentIdentity({ uiClientId: ownerId,
    workspaceId, isSuperuser: true });
  const scoped = <T>(fn: () => Promise<T>) => runWithWorkspace(workspaceId, fn);
  const records = new Map<string, number>();
  const trace: Array<{ stage: string; error?: string }> = [];
  const preparationDeps = { now: Date.now, secret, authorize: async () => 'fixture:administrative-launch-grant',
    caller: readAssumeCaller, target: (request: AssumeRequest) => readAssumeTarget(request, workspaceId) };
  const preview = (owner: string, targetOwnerId: string, contextMode: AssumeRequest['contextMode']) =>
    scoped(() => prepareAssume({ ownerId: owner, workspaceId },
      { requestId: randomUUID(), targetOwnerId, contextMode }, preparationDeps));
  const responsibilitySeeds = new Map<string, { workId: string; planSlug: string; routineIds: string[];
    awaitId: number; directiveId: number; fleetSlug: string; historicalId: string }>();
  const responsibilitySnapshot = (owner: string) => scoped(async () => {
    const seed = responsibilitySeeds.get(owner);
    if (!seed) return null;
    const who = identity(owner);
    const work = await getWorkItem(seed.workId, 'papercusp');
    const claim = await getClaim(workspaceId, 'papercusp', seed.planSlug, 'P-001');
    const directives = await listOwnerDirectives({ workspaceId, recordedBy: owner, open: true }, sql);
    const routines = await sql`SELECT id, active, target_owner_id FROM harness_shared.routines
      WHERE id IN (${seed.routineIds[0]}, ${seed.routineIds[1]}) ORDER BY active DESC`;
    const awaited = (await listActiveAwaits(owner)).find(row => row.id === seed.awaitId);
    const fleet = await getFleet(workspaceId, seed.fleetSlug, sql);
    const historical = (await readInbox('test-assume-router')).find(row => row.msg_id === seed.historicalId);
    return { ownerId: who.ownerId, work: { id: work?.id, assignee: work?.assignee },
      planClaim: { planSlug: seed.planSlug, owner: claim?.owner },
      directives: directives.filter(row => row.id === seed.directiveId).map(row => ({ id: row.id,
        recordedBy: row.recordedBy, text: row.verbatimText, disposition: row.dispositionStatus })),
      routines: routines.map(row => ({ id: row.id, active: row.active, ownerId: row.target_owner_id })),
      awaited: awaited ? { id: awaited.id, subscriberId: awaited.subscriberId, eventKey: awaited.eventKey } : null,
      fleet: { slug: seed.fleetSlug, leaderOwnerId: fleet?.leaderOwnerId },
      subscriptions: (await listMyTopicSubscriptions(who)).map(row => ({ target: row.target_ref,
        subscriber: row.subscriber_id })).sort((a, b) => a.target.localeCompare(b.target)),
      historical: historical ? { id: historical.msg_id, from: historical.from, to: historical.to,
        summary: historical.summary } : null };
  });
  return {
    sql, records, trace, responsibilitySnapshot,
    async authorizationRefusals(owner: string, targetOwnerId: string,
      contextMode: AssumeRequest['contextMode'], token: string, expiresAt: number) {
      return scoped(async () => {
        const actor = { ownerId: owner, workspaceId };
        const request = { requestId: randomUUID(), targetOwnerId, contextMode };
        let readerCalls = 0;
        const deps = { ...preparationDeps,
          caller: async (...args: Parameters<typeof readAssumeCaller>) => {
            readerCalls++; return readAssumeCaller(...args);
          },
          target: async (value: AssumeRequest) => {
            readerCalls++; return preparationDeps.target(value);
          } };
        const denied = [];
        for (const isSuperuser of [true, false]) {
          // Separate a missing principal from a valid principal without
          // administrative authority. Exercise the production authorizer.
          const authorize = createAssumeAuthorizer({ uiClientId: owner, workspaceId, isSuperuser,
            log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
            principal: isSuperuser ? undefined : { kind: 'system', slug: 'system:superuser',
              authMethod: 'process-internal', trust: 'trusted', workspaceId, capabilities: new Set<string>() },
            gateBypass: { role: true, capability: true } }, request);
          denied.push(await prepareAssume(actor, request, { ...deps, authorize }));
          denied.push(await validateAssume(actor, token, { ...deps, authorize }));
        }
        const corrupt = Buffer.from(token, 'base64url');
        corrupt[corrupt.length - 1] ^= 1;
        return { denied, readerCalls,
          otherCaller: await validateAssume({ ...actor, ownerId: randomUUID() }, token, deps),
          otherWorkspace: await validateAssume({ ...actor, workspaceId: randomUUID() }, token, deps),
          tampered: await validateAssume(actor, corrupt.toString('base64url'), deps),
          expired: await validateAssume(actor, token, { ...deps, now: () => expiresAt }) };
      });
    },
    async seedResponsibilities(owner: string, workId: string) {
      return scoped(async () => {
        const who = identity(owner), planSlug = 'native-plan-' + randomUUID();
        const claim = await acquireClaim({ workspaceId, harnessSlug: 'papercusp', planSlug,
          itemId: 'P-001', owner, ttlSec: 1200 });
        if (!claim.ok) throw new Error('Native responsibility plan claim refused');
        const routineIds = [randomUUID(), randomUUID()];
        for (const [index, id] of routineIds.entries()) await sql`INSERT INTO harness_shared.routines
          (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
          VALUES (${id}, 'papercusp', ${'native-duty-' + id}, ${workspaceId}, ${owner},
            ${index === 0}, 'cron', '{}'::jsonb, 'su')`;
        const awaited = await registerAwait({ subscriberId: owner, eventKey: 'native-duty:' + randomUUID(), once: false });
        const directive = await recordOwnerDirective({ workspaceId, recordedBy: owner,
          sourceTurnRef: randomUUID(), verbatimText: 'Retain native responsibilities for ' + owner }, sql);
        const fleetSlug = 'native-fleet-' + randomUUID(), topic = 'native-topic-' + randomUUID();
        await createFleetIfAbsent({ workspaceId, fleetSlug, leaderOwnerId: owner, owner }, sql);
        await createTopic(who, { slug: topic, description: 'Native responsibility continuity' });
        await subscribeTopic(who, topic);
        const historical = await sendMessage(who, { to: ['test-assume-router'], summary: 'Authored before native handoff by ' + owner });
        responsibilitySeeds.set(owner, { workId, planSlug, routineIds, awaitId: awaited.id,
          directiveId: directive.id, fleetSlug, historicalId: historical.msg_id });
        return responsibilitySnapshot(owner);
      });
    },
    async readOnlyPreview(owner: string, targetOwnerId: string, contextMode: AssumeRequest['contextMode']) {
      // Scope the read-only handle to this async chain. Swapping a global handle
      // also captures already scheduled telemetry flushes and aborts the preview
      // transaction when those independent writers run.
      return database.adminSql.begin('read only', tx =>
        withDatabase(tx as unknown as OrgTestDb['adminSql'], () => preview(owner, targetOwnerId, contextMode)));
    },
    async register(owner: string, native: string, home: string, ended: boolean) {
      const [row] = await sql`INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, role, coord_owner_id, session_id, cwd, launch_argv, started_at, ended_at, ended_by)
        VALUES (${workspaceId}, 'codex', 'console', 'su', ${owner}, ${native}, ${home},
          '["--harness=papercusp"]'::jsonb, now(), ${ended ? new Date() : null}, ${ended ? 'self' : null}) RETURNING id`;
      records.set(owner, Number(row.id));
      return Number(row.id);
    },
    async checkpoint(owner: string, body: string) {
      await setCarryNote({ scope: loopScope('papercusp', owner), workspaceId }, body);
    },
    async prepare(owner: string, targetOwnerId: string, contextMode: 'native-resume' | 'checkpoint') {
      const actor = { ownerId: owner, workspaceId };
      const result = await preview(owner, targetOwnerId, contextMode);
      if (!result.ok) throw new Error('Production preparation refused: ' + result.code);
      const validated = await scoped(() => validateAssume(actor, result.token, preparationDeps));
      if (!validated.ok) throw new Error('Production validation refused: ' + validated.code);
      return validated.preparation;
    },
    commit: (plan: AssumePreparation) => scoped(() => commitAssume(plan,
      new Proxy(createAssumeTransitionDeps(plan, createManagedAssumeHost(plan, {
        async findHost(owner) {
          const found = await findLiveHostAsync(owner);
          trace.push({ stage: 'host-discovery', error: JSON.stringify({ native: found?.nativeSessionId,
            expected: plan.caller.nativeSessionId, pid: found?.ptyPid, expectedPid: plan.caller.nativePid }) });
          return found;
        },
        async send(sock, message, timeoutMs) {
          const result = await injectIntoHostWithConfirmation(sock, message, timeoutMs);
          trace.push({ stage: 'host-send', error: JSON.stringify(result) });
          return result;
        },
      })), {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== 'function' || key === 'now') return value;
          return async (...args: unknown[]) => {
            try { const result = await value.apply(target, args); trace.push({ stage: String(key) }); return result; }
            catch (error) { trace.push({ stage: String(key), error: String(error) }); throw error; }
          };
        },
      }))),
    inspect: (request: unknown, afterExit = false, action = 'observe', startup?: unknown) =>
      scoped(() => inspectManagedAssumeRequest(request, afterExit, action, startup)),
    custodySnapshot: (plan: AssumePreparation) => scoped(async () => {
      const current = await readAssumeTarget({ requestId: plan.requestId,
        targetOwnerId: plan.target.ownerId, contextMode: plan.target.context.mode }, plan.target.workspaceId);
      const [reservation] = await sql`SELECT resume_claim_key,
        resume_claim_key = ${assumeTransitionKey(plan)} AS owned,
        resume_claimed_at + interval '120 seconds' > now() AS unexpired,
        ended_at IS NOT NULL AS ended, retired_at IS NOT NULL AS retired
        FROM harness_shared.adv_sessions WHERE id = ${plan.target.advSessionId}`;
      return { expected: plan.target, current, reservation,
        changedFields: Object.keys(plan.target).filter(key =>
          JSON.stringify(current?.[key as keyof typeof plan.target]) !==
          JSON.stringify(plan.target[key as keyof typeof plan.target])) };
    }),
    load: (plan: AssumePreparation) => scoped(() => createAssumeReceiptStore(plan).load()),
    recovery: (receipt: AssumeTransitionReceipt) => scoped(() => {
      if (!receipt.recovery) throw new Error('Native handoff has no caller recovery');
      return readAssumeCallerCheckpoint(receipt.preparation, receipt.recovery);
    }),
    save: (receipt: AssumeTransitionReceipt) => scoped(() => createAssumeReceiptStore(receipt.preparation).save(receipt)),
    verify: (receipt: AssumeTransitionReceipt, observation: AssumeExecutionObservation) => scoped(async () => {
      const store = createAssumeReceiptStore(receipt.preparation);
      const current = await store.load(); // preserve durable startup generations through verification
      if (!current) throw new Error('Native verification receipt unavailable');
      return verifyAssumeExecution(current, observation, async value => {
        try { await store.save(value); }
        catch (error) { trace.push({ stage: 'verify-save', error: String(error) }); throw error; }
      });
    }),
    pause: (owner: string) => scoped(() => readAssumeCallerPause(owner)),
    resolve: (id: number) => scoped(() => getAdvSession(id)),
    async finalize(plan: AssumePreparation, transitionKey: string, native: string) {
      return scoped(async () => {
        if (!await finalizeAdvSessionResume(plan.target.advSessionId, transitionKey))
          throw new Error('Native fixture resume finalization refused');
        if (native !== plan.target.nativeSessionId) {
          const result = await reanchorAdvSessionNativeId(plan.target.advSessionId, native);
          if (!result.reanchored || result.owner !== plan.target.ownerId)
            throw new Error('Native fixture checkpoint reanchor refused');
        }
        return getAdvSession(plan.target.advSessionId);
      });
    },
    async depart(owner: string) {
      await sql`UPDATE harness_shared.adv_sessions SET ended_at = now(), ended_by = 'self', pid = NULL
        WHERE id = ${records.get(owner)!}`;
    },
    async send(owner: string, text: string) {
      return scoped(() => sendMessage(identity('test-assume-router'), { to: [owner], summary: text }));
    },
    async assign(owner: string) {
      const id = 'WI-native-assume-' + randomUUID();
      await sql`INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, admission, taken_by, taken_at, updated_ts)
        VALUES (${workspaceId}, 'papercusp', ${id}, 'native target assignment', 'open', 'feature', 'local',
          NULL, ${owner}, now(), ${Date.now()})`;
      await setWorkItemCheckpoint({ workspaceId, harness: 'papercusp', workItemId: id },
        'Native fixture work remains recoverable under ' + owner);
      return id;
    },
    async probe(owner: string, workId: string) {
      return scoped(async () => {
        const who = identity(owner);
        const inbox = await readInbox(who.ownerId);
        const prior = await readAckedMsgIds(who.ownerId);
        const unread = inbox.filter(row => !prior.has(row.msg_id));
        for (const row of unread) await appendAck(who, row.msg_id, row.from);
        const work = await getWorkItem(workId, 'papercusp');
        return { ownerId: who.ownerId, messages: unread.map(row => ({ id: row.msg_id, to: row.to, from: row.from })),
          assignment: { id: work?.id, assignee: work?.assignee, observedBy: who.ownerId },
          responsibilities: await responsibilitySnapshot(owner) };
      });
    },
    pending: (owner: string) => scoped(async () => {
      const acked = await readAckedMsgIds(owner);
      return (await readInbox(owner)).filter(row => !acked.has(row.msg_id));
    }),
    async dispose() {
      await cleanupScopedNativeFixtureDatabase({ adminSql: database.adminSql, cleanup: async () => {
        try { await fixture.dispose(); } finally { await database.cleanup(); }
      } });
    },
  };
}

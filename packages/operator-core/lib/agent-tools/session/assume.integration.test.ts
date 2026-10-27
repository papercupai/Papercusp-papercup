/** Real PostgreSQL custody coverage. Managed PTY/routing journeys are separate
 * acceptance coverage; a database lease alone does not prove a takeover. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { acquireAdvSessionResume, finalizeAdvSessionResume, releaseAdvSessionResume, type AdvSessionResumePin } from '../../adv-sessions';
import { claimAgentLaunch } from '../../agent-launch-core';
import { createAssumeReceiptStore } from '../../session-assume-store';
import { createAssumeCustodyAdapters } from '../../session-assume-custody';
import { readAssumeCheckpoint, readAssumeCheckpointBody, readAssumeTarget } from '../../session-assume-preparation';
import { loopScope, setCarryNote } from '../../carry-note';
import { checkpointAssumeCaller, completeAssumeCallerReturn, createAssumeCallerAdapters,
  readAssumeCallerCheckpoint, readAssumeCallerReturnSource } from '../../session-assume-caller';
import { readProcessIdentity } from '../../process-identity';
import { clearAssumeCallerPause, installAssumeCallerPause, readAssumeCallerPause } from '../../session-assume-pause';
import { getSessionBriefLifecycle } from '../../session-brief';
import { loopRoutineName } from '../../harness/routines/loop';
import { registerAwait, listActiveAwaits } from '../../events/await/store';
import { acquireClaim, getClaim } from '../../plan-items/claims';
import { getWorkItem, releaseWorkItem } from '../../work-items';
import { setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { sendMessage, readInbox, readAckedMsgIds, appendAck } from '../coordination/messages';
import { resolveAgentIdentity } from '../coordination/identity';
import { recordOwnerDirective, listOwnerDirectives, dispositionOwnerDirective } from '../../owner-directives';
import { createFleetIfAbsent, getFleet } from '../../agent-fleets-store';
import { createTopic, subscribeTopic, listMyTopicSubscriptions } from '../coordination/topics';
import { runWithWorkspace } from '../../workspace-als';
import { persistControlAnchor, type ControlAnchorState } from '../coordination/control-anchor';
import {
  assumePreparationFingerprint, assumePreparationSchema, assumeTransitionKey, prepareAssume, validateAssume,
  commitAssume, reconcileAssumeTransition,
  qualifiesAssumeExecution, verifyAssumeExecution,
  type AssumePreparation, type AssumeTransitionReceipt, type AssumeExecutionObservation, type AssumeTransitionDeps,
} from '../../session-assume';

const contextHomes = vi.hoisted(() => new Map<string, string>());
vi.mock('@papercusp/orchestrator/session-launch-dirs', async original => {
  const actual = await original<typeof import('@papercusp/orchestrator/session-launch-dirs')>();
  return { ...actual, codexHomeForSessionKey: (key: string | number) =>
    contextHomes.get(String(key)) ?? actual.codexHomeForSessionKey(key) };
});

let database: OrgTestDb;
let fixture: BaselineCoordFixture;
const workspaceId = 'assume-isolated-custody';

beforeAll(async () => {
  database = await createOrgTestDb();
  fixture = await setupBaselineCoordFixture({ dsn: database.adminDsn });
});

afterAll(async () => {
  try { await fixture?.dispose(); }
  finally { await database?.cleanup(); }
});

async function target() {
  const ownerId = `su-assume-fixture-${randomUUID()}`;
  const nativeId = randomUUID();
  const [row] = await fixture.admin<{ id: string; started: string }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at, ended_by)
    VALUES (${workspaceId}, 'codex', 'console', ${ownerId}, ${nativeId}, now(), now(), 'self')
    RETURNING id, started_at::text AS started
  `;
  const id = Number(row.id);
  const pin: AdvSessionResumePin = { workspaceId, requireTerminal: true,
    binding: { coordOwnerId: ownerId, sessionId: nativeId, startedAt: row.started } };
  return { id, pin };
}

function receiptFixture(): { plan: AssumePreparation; receipt: AssumeTransitionReceipt } {
  const now = Date.now();
  const plan: AssumePreparation = {
    version: 1, requestId: randomUUID(), authorizationRef: 'fixture:admin-envelope',
    preparedAt: now, expiresAt: now + 120_000,
    caller: { ownerId: `su-${randomUUID()}`, workspaceId, nativeSessionId: randomUUID(),
      incarnation: 'fixture-start', hostId: 'fixture-host', attachmentId: 'fixture-pty', nativePid: 101, backend: 'codex' },
    target: { ownerId: `su-${randomUUID()}`, workspaceId, harnessSlug: 'fixture-harness',
      advSessionId: 42, role: 'su', nativeSessionId: 'fixture-native', executionNativeSessionId: 'fixture-native',
      backend: 'codex', binding: { coordOwnerId: 'fixture-target', sessionId: 'fixture-native', startedAt: 'fixture-start' },
      writerGeneration: 'fixture-free', writer: 'free', ended: true, liveHost: false,
      context: { mode: 'native-resume', ref: 'fixture-native', sha256: 'a'.repeat(64), revision: 'fixture-revision' } },
  };
  plan.target.binding.coordOwnerId = plan.target.ownerId;
  return { plan, receipt: { transitionKey: assumeTransitionKey(plan), preparationFingerprint: assumePreparationFingerprint(plan),
    preparation: plan, state: 'prepared', updatedAt: now, durable: true } };
}

function observationFixture(receipt: AssumeTransitionReceipt): AssumeExecutionObservation {
  const { caller, target } = receipt.preparation;
  return { transitionKey: receipt.transitionKey, observedAt: receipt.updatedAt + 1,
    hostId: caller.hostId, attachmentId: caller.attachmentId, callerNativePid: caller.nativePid,
    callerExited: true, targetOwnerId: target.ownerId, targetNativeSessionId: target.nativeSessionId,
    backend: target.backend, contextSha256: target.context.sha256,
    nativePid: 102, nativeProcessStart: 'fixture-native-start', nativeWriterPids: [102],
    directedMessage: { id: 'fixture-directed-probe', recipient: target.ownerId,
      consumedBy: target.ownerId, consumptions: 1 },
    assignment: { id: 'fixture-routed-work', assignee: target.ownerId, observedBy: target.ownerId } };
}

async function nativeContextFixture() {
  const registered = await target();
  const ownerId = registered.pin.binding.coordOwnerId!, nativeId = registered.pin.binding.sessionId!;
  const home = mkdtempSync('/tmp/assume-pg-context-');
  const sessions = join(home, 'sessions', '2026', '10', '25');
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `rollout-fixture-${nativeId}.jsonl`);
  const transcript = JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Exact target history' } }) + '\n';
  writeFileSync(file, transcript);
  contextHomes.set(String(registered.id), home);
  await fixture.admin`UPDATE harness_shared.adv_sessions
    SET role = 'su', cwd = ${home}, launch_argv = '["--harness=fixture-harness"]'::jsonb
    WHERE id = ${registered.id}`;
  const { plan } = receiptFixture();
  const actor = { ownerId: plan.caller.ownerId, workspaceId };
  const request = { requestId: randomUUID(), targetOwnerId: ownerId, contextMode: 'native-resume' as const };
  const deps = { now: Date.now, secret: Buffer.alloc(32, 7),
    authorize: async () => 'fixture:administrative-launch-grant', caller: async () => plan.caller,
    target: (value: Parameters<typeof readAssumeTarget>[0]) =>
      runWithWorkspace(workspaceId, () => readAssumeTarget(value, workspaceId)) };
  const snapshot = async () => ({
    registration: await fixture.admin`SELECT * FROM harness_shared.adv_sessions WHERE id = ${registered.id}`,
    paused: await readAssumeCallerPause(actor.ownerId),
    transcript: readFileSync(file, 'utf8'),
  });
  return { ...registered, ownerId, nativeId, home, file, transcript, actor, request, deps, snapshot,
    dispose() { contextHomes.delete(String(registered.id)); rmSync(home, { recursive: true, force: true }); } };
}

/** Real durable adapters; the host port is injected here. Native process and
 * channel claims belong to psu-identity-assume-native.integration.test.ts. */
async function durableTransitionFixture() {
  const f = await nativeContextFixture();
  const prepared = await prepareAssume(f.actor, f.request, f.deps);
  if (!prepared.ok) { f.dispose(); throw new Error('Transition preparation refused: ' + prepared.code); }
  const plan = prepared.preparation;
  const store = createAssumeReceiptStore(plan);
  const caller = createAssumeCallerAdapters({
    readCaller: f.deps.caller, freeze: async () => true, thaw: async () => true,
  });
  const custody = createAssumeCustodyAdapters(plan, { readTarget: f.deps.target });
  const handoff = vi.fn<AssumeTransitionDeps['handoff']>(async () => 'accepted');
  const deps: AssumeTransitionDeps = { now: Date.now, ...store, ...caller, ...custody,
    save: vi.fn(store.save), restoreCaller: vi.fn(caller.restoreCaller),
    releaseTarget: vi.fn(custody.releaseTarget), handoff };
  return { ...f, plan, store, handoff, transition: deps };
}

async function exactReturnFixture() {
  const a = await target(), b = await target();
  const { plan: original, receipt } = receiptFixture();
  original.caller = { ...original.caller, ownerId: a.pin.binding.coordOwnerId!,
    nativeSessionId: a.pin.binding.sessionId!, incarnation: a.pin.binding.startedAt };
  original.target = { ...original.target, ownerId: b.pin.binding.coordOwnerId!, advSessionId: b.id,
    nativeSessionId: b.pin.binding.sessionId!, executionNativeSessionId: b.pin.binding.sessionId!,
    binding: b.pin.binding, context: { ...original.target.context, ref: b.pin.binding.sessionId! } };
  const loopId = randomUUID();
  await fixture.admin`INSERT INTO harness_shared.routines
    (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
    VALUES (${loopId}, 'fixture-harness', ${loopRoutineName(original.caller.ownerId)}, ${workspaceId},
      ${original.caller.ownerId}, true, 'cron', '{}'::jsonb, 'su')`;
  const claim = await acquireClaim({ workspaceId, harnessSlug: 'fixture-harness', planSlug: randomUUID(),
    itemId: 'P-001', owner: original.caller.ownerId, ttlSec: 600 });
  expect(claim.ok).toBe(true);
  if (!claim.ok) throw new Error('fixture plan claim refused');
  const rollback = createAssumeCallerAdapters({ freeze: async () => true, thaw: async () => true,
    readCaller: async () => original.caller });
  const recovery = await rollback.checkpointCaller(original);
  await rollback.quiesceCaller(original, recovery);
  const originStore = createAssumeReceiptStore(original);
  const sourceReceipt = { ...receipt, preparation: original, transitionKey: assumeTransitionKey(original),
    preparationFingerprint: assumePreparationFingerprint(original) };
  await originStore.claim(sourceReceipt);
  await originStore.save({ ...sourceReceipt, state: 'target-verified', recovery, observation: {
    transitionKey: sourceReceipt.transitionKey, observedAt: Date.now(), hostId: original.caller.hostId,
    attachmentId: original.caller.attachmentId, callerNativePid: original.caller.nativePid, callerExited: true,
    targetOwnerId: original.target.ownerId, targetNativeSessionId: original.target.nativeSessionId,
    backend: 'codex', contextSha256: original.target.context.sha256, nativePid: 102,
    nativeProcessStart: 'fixture:B-process', nativeWriterPids: [102],
    directedMessage: { id: 'fixture-message', recipient: original.target.ownerId, consumedBy: original.target.ownerId, consumptions: 1 },
    assignment: { id: 'fixture-work', assignee: original.target.ownerId, observedBy: original.target.ownerId },
  } });
  const returning: AssumePreparation = { ...original, requestId: randomUUID(), caller: {
    ...original.caller, ownerId: original.target.ownerId, nativeSessionId: original.target.nativeSessionId,
    incarnation: original.target.binding.startedAt, nativePid: 102, nativeProcessStart: 'fixture:B-process',
  }, target: { ...original.target, ownerId: original.caller.ownerId, advSessionId: a.id,
    nativeSessionId: original.caller.nativeSessionId, executionNativeSessionId: original.caller.nativeSessionId,
    binding: a.pin.binding, context: { ...original.target.context, ref: original.caller.nativeSessionId },
    returnFrom: { transitionKey: sourceReceipt.transitionKey, checkpointRef: recovery.checkpointRef,
      checkpointSha256: recovery.checkpointSha256 } } };
  const key = assumeTransitionKey(returning);
  const returnStore = createAssumeReceiptStore(returning);
  const returnReceipt: AssumeTransitionReceipt = { ...receipt, preparation: returning, transitionKey: key,
    preparationFingerprint: assumePreparationFingerprint(returning) };
  await returnStore.claim(returnReceipt);
  await returnStore.save({ ...returnReceipt, state: 'handoff-accepted' });
  expect((await acquireAdvSessionResume(a.id, key, 120, 300, undefined, false, a.pin)).acquired).toBe(true);
  expect(await finalizeAdvSessionResume(a.id, key)).toBe(true);
  const [row] = await fixture.admin`SELECT started_at::text AS incarnation FROM harness_shared.adv_sessions WHERE id = ${a.id}`;
  const caller = { ...original.caller, incarnation: row.incarnation as string,
    nativePid: process.pid, nativeProcessStart: readProcessIdentity(process.pid)! };
  return { original, returning, recovery, originStore, caller, loopId, claim, a, key };
}

describe('session:assume production receipt adapter (real PG)', () => {
  it('retains durable startup provenance when verification advances the receipt', async () => {
    const { plan, receipt } = receiptFixture();
    const store = createAssumeReceiptStore(plan); await store.claim(receipt);
    const started: AssumeTransitionReceipt = { ...receipt, state: 'handoff-accepted', startup: {
      attemptId: randomUUID(), generation: 1, authorizedAt: Date.now(), launcherPid: 100,
      launcherProcessStart: 'launcher-start', ptyPid: 101, ptyProcessStart: 'pty-start' } };
    await store.save(started);
    const current = (await store.load())!;
    expect(current.startup).toEqual(started.startup);
    await expect(store.save({ ...receipt, state: 'target-verified' })).rejects.toThrow('startup-not-owned');
    await store.save({ ...current, state: 'target-verified', observation: observationFixture(current) });
    expect((await store.load())?.startup).toEqual(started.startup);
  });

  it('R-1 same managed attachment replaces caller execution', async () => {
    const { plan, receipt } = receiptFixture(), store = createAssumeReceiptStore(plan);
    await store.claim(receipt);
    const accepted = { ...receipt, state: 'handoff-accepted' as const };
    await store.save(accepted);
    const observed = observationFixture(accepted);
    expect((await verifyAssumeExecution(accepted, observed, value => store.save(value))).state).toBe('target-verified');
    const persisted = await createAssumeReceiptStore(plan).load();
    expect(persisted?.observation).toEqual(observed);
    expect(persisted?.observation?.attachmentId).toBe(plan.caller.attachmentId);
    expect(persisted?.observation?.callerExited).toBe(true);
    expect(persisted?.observation?.nativePid).not.toBe(plan.caller.nativePid);
  });

  it('R-1 reject unrelated-window and env-only fake takeover', async () => {
    const { plan, receipt } = receiptFixture(), store = createAssumeReceiptStore(plan);
    await store.claim(receipt);
    const accepted = { ...receipt, state: 'handoff-accepted' as const };
    await store.save(accepted);
    for (const changed of [{ hostId: 'other-host' }, { attachmentId: 'other-pane' },
      { callerExited: false }, { nativePid: plan.caller.nativePid }, { nativeWriterPids: [] }]) {
      const result = await verifyAssumeExecution(accepted, { ...observationFixture(accepted), ...changed }, value => store.save(value));
      expect(result.state).toBe('handoff-accepted');
      expect((await createAssumeReceiptStore(plan).load())?.state).toBe('handoff-accepted');
      expect((await createAssumeReceiptStore(plan).load())?.observation).toBeUndefined();
    }
  });

  it('R-2 target inbox and task routing spans before during and after cutover', async () => {
    await runWithWorkspace(workspaceId, async () => {
      const { plan, receipt } = receiptFixture();
      const who = (ownerId: string) => resolveAgentIdentity({ uiClientId: ownerId, workspaceId, isSuperuser: true });
      const source = who('test-assume-routing-source'), target = who(plan.target.ownerId), caller = who(plan.caller.ownerId);
      const workId = 'WI-assume-routing-' + randomUUID(), planSlug = 'assume-routing-' + randomUUID();
      await fixture.admin`INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, taken_by, taken_at, updated_ts)
        VALUES (${workspaceId}, 'fixture-harness', ${workId}, 'target routing work', 'open', 'feature', 'local',
          ${target.ownerId}, now(), ${Date.now()})`;
      expect((await acquireClaim({ workspaceId, harnessSlug: 'fixture-harness', planSlug,
        itemId: 'P-001', owner: target.ownerId, ttlSec: 1200 })).ok).toBe(true);
      const loops = [randomUUID(), randomUUID()];
      for (const [index, id] of loops.entries()) await fixture.admin`INSERT INTO harness_shared.routines
        (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
        VALUES (${id}, 'fixture-harness', ${'target-route-' + id}, ${workspaceId}, ${target.ownerId},
          ${index === 0}, 'cron', '{}'::jsonb, 'su')`;
      const awaited = await registerAwait({ subscriberId: target.ownerId, eventKey: 'target-route:' + randomUUID(), once: false });
      const directive = await recordOwnerDirective({ workspaceId, recordedBy: target.ownerId,
        sourceTurnRef: randomUUID(), verbatimText: 'Complete target routing work.' }, fixture.admin);
      const callerDirective = await recordOwnerDirective({ workspaceId, recordedBy: caller.ownerId,
        sourceTurnRef: randomUUID(), verbatimText: 'Retain caller work for return.' }, fixture.admin);
      const before = await sendMessage(source, { to: [target.ownerId], summary: 'before preparation' });
      const callerMessage = await sendMessage(source, { to: [caller.ownerId], summary: 'caller recovery message' });
      const store = createAssumeReceiptStore(plan);
      await store.claim(receipt);
      const adapters = createAssumeCallerAdapters({ freeze: async () => true, thaw: async () => true, readCaller: async () => plan.caller });
      const recovery = await adapters.checkpointCaller(plan);
      await adapters.quiesceCaller(plan, recovery);
      const during = await sendMessage(source, { to: [target.ownerId], summary: 'during handoff' });
      const accepted = { ...receipt, state: 'handoff-accepted' as const, recovery };
      await store.save(accepted);
      const consume = async () => {
        const acked = await readAckedMsgIds(target.ownerId);
        const unread = (await readInbox(target.ownerId)).filter(row => !acked.has(row.msg_id));
        for (const message of unread) await appendAck(target, message.msg_id, message.from);
        return unread;
      };
      const first = await consume();
      expect(first.map(row => row.msg_id).sort()).toEqual([before.msg_id, during.msg_id].sort());
      const observation = observationFixture(accepted);
      observation.directedMessage = { id: before.msg_id, recipient: before.to[0], consumedBy: target.ownerId, consumptions: 1 };
      observation.assignment = { id: workId, assignee: (await getWorkItem(workId, 'fixture-harness'))!.assignee!, observedBy: target.ownerId };
      expect(qualifiesAssumeExecution(accepted, observation)).toBe(true);
      await store.save({ ...accepted, state: 'target-verified', observation });
      const after = await sendMessage(source, { to: [target.ownerId], summary: 'after verification' });
      expect((await consume()).map(row => row.msg_id)).toEqual([after.msg_id]);
      expect(await consume()).toEqual([]);
      expect((await readInbox(caller.ownerId)).map(row => row.msg_id)).toEqual([callerMessage.msg_id]);
      expect((await getClaim(workspaceId, 'fixture-harness', planSlug, 'P-001'))?.owner).toBe(target.ownerId);
      expect((await getWorkItem(workId, 'fixture-harness'))?.assignee).toBe(target.ownerId);
      expect((await listActiveAwaits(target.ownerId)).map(row => row.id)).toContain(awaited.id);
      const routines = await fixture.admin`SELECT id, active FROM harness_shared.routines WHERE id IN (${loops[0]}, ${loops[1]})`;
      expect(loops.map(id => routines.find(row => row.id === id)?.active)).toEqual([true, false]);
      expect((await listOwnerDirectives({ workspaceId, recordedBy: target.ownerId, open: true }, fixture.admin)).map(row => row.id)).toEqual([directive.id]);
      const close = { id: directive.id, status: 'done' as const, note: 'Target consumed its retained directive.', dispositionedBy: target.ownerId };
      expect((await dispositionOwnerDirective(close, fixture.admin)).ok).toBe(true);
      expect((await dispositionOwnerDirective(close, fixture.admin)).ok).toBe(false);
      expect((await listOwnerDirectives({ workspaceId, recordedBy: caller.ownerId, open: true }, fixture.admin)).map(row => row.id)).toEqual([callerDirective.id]);
      expect(await adapters.restoreCaller(plan, recovery)).toBe(true);
    });
  });

  it('R-2 preserve target fleet subscriptions and historical authorship', async () => {
    await runWithWorkspace(workspaceId, async () => {
      const { plan, receipt } = receiptFixture();
      const who = (ownerId: string) => resolveAgentIdentity({ uiClientId: ownerId, workspaceId, isSuperuser: true });
      const target = who(plan.target.ownerId), caller = who(plan.caller.ownerId);
      const fleetSlug = 'assume-fleet-' + randomUUID(), topic = 'assume-topic-' + randomUUID();
      await createFleetIfAbsent({ workspaceId, fleetSlug, leaderOwnerId: target.ownerId, owner: target.ownerId }, fixture.admin);
      await createTopic(target, { slug: topic, description: 'Target continuity fixture' });
      await subscribeTopic(target, topic);
      const historical = await sendMessage(target, { to: [caller.ownerId], summary: 'authored before handoff' });
      const originalFleet = await getFleet(workspaceId, fleetSlug, fixture.admin);
      const originalSubscriptions = await listMyTopicSubscriptions(target);
      const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw: async () => true, readCaller: async () => plan.caller });
      const recovery = await adapter.checkpointCaller(plan);
      await adapter.quiesceCaller(plan, recovery);
      const store = createAssumeReceiptStore(plan);
      await store.claim(receipt);
      await store.save({ ...receipt, state: 'handoff-accepted', recovery });
      for (const stage of ['during handoff', 'after verification']) {
        if (stage === 'after verification') await store.save({ ...receipt, state: 'target-verified', recovery,
          observation: observationFixture(receipt) });
        expect(await getFleet(workspaceId, fleetSlug, fixture.admin)).toEqual(originalFleet);
        expect((await getFleet(workspaceId, fleetSlug, fixture.admin))?.leaderOwnerId).toBe(target.ownerId);
        expect(await listMyTopicSubscriptions(target)).toEqual(originalSubscriptions);
        expect(await listMyTopicSubscriptions(caller)).toEqual([]);
        const message = await sendMessage(caller, { to: [target.ownerId], summary: stage });
        const read = (await readInbox(target.ownerId)).find(row => row.msg_id === message.msg_id)!;
        expect(read.from).toBe(caller.ownerId); expect(read.to).toContain(target.ownerId);
        await appendAck(target, read.msg_id, read.from);
      }
      const retained = (await readInbox(caller.ownerId)).find(row => row.msg_id === historical.msg_id)!;
      expect(retained.from).toBe(target.ownerId); expect(retained.to).toEqual([caller.ownerId]);
      expect(retained.summary).toBe('authored before handoff');
      expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
    });
  });

  it('R-5 caller return reference resumes exactly once and rejects stale replay', async () => {
    const f = await exactReturnFixture();
    const deps = { readCaller: async () => f.caller };
    expect(await completeAssumeCallerReturn(f.returning, deps)).toBe(true);
    expect(await readAssumeCallerPause(f.caller.ownerId)).toBeNull();
    expect((await f.originStore.load())?.callerReturn).toMatchObject({ transitionKey: f.key,
      caller: f.caller, nativeProcessStart: f.caller.nativeProcessStart });
    const [loop] = await fixture.admin`SELECT active, updated_at::text AS revision FROM harness_shared.routines WHERE id = ${f.loopId}`;
    expect(loop.active).toBe(true);
    expect((await getClaim(workspaceId, 'fixture-harness', f.claim.claim!.planSlug, 'P-001'))?.owner).toBe(f.caller.ownerId);
    expect(await completeAssumeCallerReturn(f.returning, deps)).toBe(false);
    const [again] = await fixture.admin`SELECT updated_at::text AS revision FROM harness_shared.routines WHERE id = ${f.loopId}`;
    expect(again.revision).toBe(loop.revision);
    expect(await completeAssumeCallerReturn(f.returning, { readCaller: async () => ({ ...f.caller, incarnation: 'later' }) })).toBe(false);
  });

  it.each(['source-process', 'return-pin', 'finalize-binding', 'registration', 'new-loop', 'process-start'] as const)
    ('keeps caller fenced when exact return has a changed %s', async fault => {
      const f = await exactReturnFixture();
      if (fault === 'source-process') f.returning.caller.nativeProcessStart = 'reused-pid';
      if (fault === 'return-pin') f.returning.target.returnFrom!.checkpointSha256 = 'f'.repeat(64);
      if (fault === 'finalize-binding') await fixture.admin`UPDATE harness_shared.agent_launch_idempotency
        SET summary = summary - 'binding' WHERE workspace_id = ${workspaceId}
          AND idempotency_key = ${'psu-resume-finalize:' + f.a.id + ':' + f.key}`;
      if (fault === 'registration') await fixture.admin`UPDATE harness_shared.adv_sessions SET started_at = now() WHERE id = ${f.a.id}`;
      if (fault === 'new-loop') await fixture.admin`UPDATE harness_shared.routines SET trigger_config = '{"changed":true}'::jsonb,
        updated_at = now() WHERE id = ${f.loopId}`;
      if (fault === 'process-start') f.caller.nativeProcessStart = 'wrong-kernel-start';
      expect(await completeAssumeCallerReturn(f.returning, { readCaller: async () => f.caller })).toBe(false);
      expect(await readAssumeCallerPause(f.original.caller.ownerId)).not.toBeNull();
      expect((await f.originStore.load())?.callerReturn).toBeUndefined();
    });

  it('retains strict original-process rollback equality when a returning registration is live', async () => {
    const f = await exactReturnFixture();
    const thaw = vi.fn(async () => true);
    const rollback = createAssumeCallerAdapters({ freeze: async () => true, thaw, readCaller: async () => f.caller });
    expect(await rollback.restoreCaller(f.original, f.recovery)).toBe(false);
    expect(thaw).not.toHaveBeenCalled();
    await expect(readAssumeCallerReturnSource({ ...f.returning,
      caller: { ...f.returning.caller, nativeProcessStart: 'wrong-source' } })).rejects.toThrow('assume-return-source-mismatch');
  });

  it('fences only the caller generation, preserves sibling controls and rejects conflicting or stale unpause', async () => {
    const { plan } = receiptFixture();
    const recovery = await checkpointAssumeCaller(plan, { readCaller: async () => plan.caller });
    await fixture.admin`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state)
      VALUES (${plan.caller.ownerId}, ${workspaceId}, '{"unrelated":1,"lifecycle":{"shutdown":{"at":"2026-01-01T00:00:00Z","by":"fixture"}}}'::jsonb)`;
    await installAssumeCallerPause(plan, recovery);
    const staleAnchor: ControlAnchorState = { modes: [], loop: { active: false, intervalSec: null }, carry: 'warm',
      route: { kind: 'self' }, scope: { workspace: workspaceId, harness: null, plan: null, items: [] } };
    await persistControlAnchor({ ownerId: plan.caller.ownerId, workspaceId, state: staleAnchor });
    await installAssumeCallerPause(assumePreparationSchema.parse(plan), recovery);
    expect(await getSessionBriefLifecycle(plan.caller.ownerId, { failClosed: true }))
      .toMatchObject({ assumeCaller: { transitionKey: assumeTransitionKey(plan) }, shutdown: { by: 'fixture' } });
    expect(await readAssumeCallerPause(plan.target.ownerId)).toBeNull();
    await expect(installAssumeCallerPause({ ...plan, requestId: randomUUID() }, recovery)).rejects.toThrow('pause-conflict');
    expect(await clearAssumeCallerPause(plan, { ...recovery, checkpointSha256: 'f'.repeat(64) })).toBe(false);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    expect(await clearAssumeCallerPause(plan, recovery)).toBe(true);
    await persistControlAnchor({ ownerId: plan.caller.ownerId, workspaceId,
      state: { ...staleAnchor, lifecycle: { assumeCaller: { transitionKey: 'stale' } } } });
    expect(await clearAssumeCallerPause(plan, recovery)).toBe(false);
    const [brief] = await fixture.admin`SELECT control_state FROM harness_shared.session_briefs WHERE owner_id = ${plan.caller.ownerId}`;
    expect(brief.control_state.lifecycle).toEqual({ shutdown: { at: '2026-01-01T00:00:00Z', by: 'fixture' } });
  });

  it('R-5 caller wakes quiesce while target wakes remain live', async () => {
    const { plan } = receiptFixture();
    const loopId = randomUUID(), targetLoopId = randomUUID();
    for (const [id, owner] of [[loopId, plan.caller.ownerId], [targetLoopId, plan.target.ownerId]]) {
      await fixture.admin`INSERT INTO harness_shared.routines
        (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
        VALUES (${id}, 'fixture-harness', ${loopRoutineName(owner)}, ${workspaceId}, ${owner}, true, 'cron', '{}'::jsonb, 'su')`;
    }
    const claim = await acquireClaim({ workspaceId, harnessSlug: 'fixture-harness', planSlug: 'caller-plan',
      itemId: 'P-001', owner: plan.caller.ownerId, intent: 'caller fixture', ttlSec: 1200 });
    expect(claim.ok).toBe(true);
    const awaited = await registerAwait({ subscriberId: plan.caller.ownerId, eventKey: `fixture:${randomUUID()}`, once: false });
    const host = { freeze: vi.fn(async () => true), thaw: vi.fn(async () => true), readCaller: async () => plan.caller };
    const adapter = createAssumeCallerAdapters(host);
    const recovery = await adapter.checkpointCaller(plan);
    const disposition = await adapter.quiesceCaller(plan, recovery);
    expect(disposition).toMatchObject({ pausedAwaitIds: [awaited.id], releasedPlanClaims: [{ plan: 'caller-plan', item: 'P-001' }],
      inbox: 'retained', directives: 'retained' });
    expect(await getClaim(workspaceId, 'fixture-harness', 'caller-plan', 'P-001')).toBeNull();
    expect((await listActiveAwaits(plan.caller.ownerId)).map(row => row.id)).toContain(awaited.id);
    const paused = await fixture.admin`SELECT id, active FROM harness_shared.routines WHERE id IN (${loopId}, ${targetLoopId})`;
    expect(paused.find(row => row.id === loopId)?.active).toBe(false);
    expect(paused.find(row => row.id === targetLoopId)?.active).toBe(true);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
    expect((await getClaim(workspaceId, 'fixture-harness', 'caller-plan', 'P-001'))?.owner).toBe(plan.caller.ownerId);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).toBeNull();
    const [loop] = await fixture.admin`SELECT active FROM harness_shared.routines WHERE id = ${loopId}`;
    expect(loop.active).toBe(true);
    expect(host.thaw).toHaveBeenCalledOnce();
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
  });

  it('retains the fence after failed host acknowledgement or changed recovery custody', async () => {
    const { plan } = receiptFixture();
    let caller = plan.caller;
    const host = { freeze: vi.fn(async () => false), thaw: vi.fn(async () => true), readCaller: async () => caller };
    const adapter = createAssumeCallerAdapters(host);
    const recovery = await adapter.checkpointCaller(plan);
    await expect(adapter.quiesceCaller(plan, recovery)).rejects.toThrow('host-not-fenced');
    caller = { ...caller, nativePid: caller.nativePid + 1 };
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    expect(host.thaw).not.toHaveBeenCalled();
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    caller = plan.caller;
    expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
  });

  it('refuses rollback over a newer loop configuration', async () => {
    const { plan } = receiptFixture();
    const loopId = randomUUID();
    await fixture.admin`INSERT INTO harness_shared.routines
      (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
      VALUES (${loopId}, 'fixture-harness', ${loopRoutineName(plan.caller.ownerId)}, ${workspaceId}, ${plan.caller.ownerId}, true, 'cron', '{}'::jsonb, 'su')`;
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw: async () => true, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    await adapter.quiesceCaller(plan, recovery);
    await fixture.admin`UPDATE harness_shared.routines SET trigger_config = '{"newerOwnerChoice":true}'::jsonb, updated_at = now() WHERE id = ${loopId}`;
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    const [loop] = await fixture.admin`SELECT active, trigger_config FROM harness_shared.routines WHERE id = ${loopId}`;
    expect(loop).toMatchObject({ active: false, trigger_config: { newerOwnerChoice: true } });
  });

  it.each(['refused', 'lost'] as const)('retries exact loop restoration after a %s host thaw acknowledgement', async failure => {
    const { plan } = receiptFixture();
    const loopId = randomUUID();
    await fixture.admin`INSERT INTO harness_shared.routines
      (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
      VALUES (${loopId}, 'fixture-harness', ${loopRoutineName(plan.caller.ownerId)}, ${workspaceId}, ${plan.caller.ownerId}, true, 'cron', '{}'::jsonb, 'su')`;
    const thaw = vi.fn(async () => true);
    if (failure === 'lost') thaw.mockRejectedValueOnce(new Error('lost thaw ACK'));
    else thaw.mockResolvedValueOnce(false);
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    await adapter.quiesceCaller(plan, recovery);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    const pause = await readAssumeCallerPause(plan.caller.ownerId);
    const [restored] = await fixture.admin`SELECT active, updated_at::text AS revision FROM harness_shared.routines WHERE id = ${loopId}`;
    expect(restored.active).toBe(true);
    expect(pause?.restoredLoops).toEqual([{ id: loopId, revision: restored.revision }]);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
    expect(thaw).toHaveBeenCalledTimes(2);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).toBeNull();
    const [unchanged] = await fixture.admin`SELECT updated_at::text AS revision FROM harness_shared.routines WHERE id = ${loopId}`;
    expect(unchanged.revision).toBe(restored.revision);
  });

  it('refuses a retry if an already restored loop changed before the thaw acknowledgement', async () => {
    const { plan } = receiptFixture();
    const loopId = randomUUID();
    await fixture.admin`INSERT INTO harness_shared.routines
      (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
      VALUES (${loopId}, 'fixture-harness', ${loopRoutineName(plan.caller.ownerId)}, ${workspaceId}, ${plan.caller.ownerId}, true, 'cron', '{}'::jsonb, 'su')`;
    const thaw = vi.fn(async () => false);
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    await adapter.quiesceCaller(plan, recovery);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    await fixture.admin`UPDATE harness_shared.routines SET trigger_config = '{"newerOwnerChoice":true}'::jsonb, updated_at = now() WHERE id = ${loopId}`;
    thaw.mockResolvedValue(true);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    expect(thaw).toHaveBeenCalledOnce();
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    const [loop] = await fixture.admin`SELECT active, trigger_config FROM harness_shared.routines WHERE id = ${loopId}`;
    expect(loop).toMatchObject({ active: true, trigger_config: { newerOwnerChoice: true } });
  });

  it('restores nonempty caller work without cancelling its bound awaits or moving work to the target', async () => {
    const { plan } = receiptFixture();
    const id = `WI-assume-${randomUUID()}`;
    await fixture.admin`INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, admission, taken_by, taken_at, updated_ts)
      VALUES (${workspaceId}, 'fixture-harness', ${id}, 'caller work fixture', 'open', 'feature', 'local', NULL,
        ${plan.caller.ownerId}, now(), ${Date.now()})`;
    await setWorkItemCheckpoint({ workspaceId, harness: 'fixture-harness', workItemId: id }, 'caller work must remain recoverable');
    const awaited = await registerAwait({ subscriberId: plan.caller.ownerId, eventKey: `work-item:done:${id}`,
      once: false, boundTo: { kind: 'work-item', ref: id } });
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw: async () => true, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    expect((await adapter.quiesceCaller(plan, recovery)).releasedWorkClaims).toEqual([{ id, checkpointRef: recovery.checkpointRef }]);
    expect((await runWithWorkspace(workspaceId, () => getWorkItem(id, 'fixture-harness')))?.assignee).toBeNull();
    expect((await listActiveAwaits(plan.caller.ownerId)).map(row => row.id)).toContain(awaited.id);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(true);
    expect((await runWithWorkspace(workspaceId, () => getWorkItem(id, 'fixture-harness')))?.assignee).toBe(plan.caller.ownerId);
    expect((await listActiveAwaits(plan.caller.ownerId)).map(row => row.id)).toContain(awaited.id);
    await expect(runWithWorkspace(workspaceId, () => releaseWorkItem(id, { harness: 'fixture-harness',
      expectedAssignee: plan.caller.ownerId, retainPausedCallerBindings: {
        ownerId: plan.caller.ownerId, transitionKey: assumeTransitionKey(plan) } }))).rejects.toThrow('pause-required');
  });

  it('keeps recovery paused instead of taking a peer plan claim', async () => {
    const { plan } = receiptFixture();
    const key = { workspaceId, harnessSlug: 'fixture-harness', planSlug: randomUUID(), itemId: 'P-001' };
    expect((await acquireClaim({ ...key, owner: plan.caller.ownerId })).ok).toBe(true);
    const thaw = vi.fn(async () => true);
    const adapter = createAssumeCallerAdapters({ freeze: async () => true, thaw, readCaller: async () => plan.caller });
    const recovery = await adapter.checkpointCaller(plan);
    await adapter.quiesceCaller(plan, recovery);
    expect((await acquireClaim({ ...key, owner: plan.target.ownerId })).ok).toBe(true);
    expect(await adapter.restoreCaller(plan, recovery)).toBe(false);
    expect((await getClaim(workspaceId, key.harnessSlug, key.planSlug, key.itemId))?.owner).toBe(plan.target.ownerId);
    expect(await readAssumeCallerPause(plan.caller.ownerId)).not.toBeNull();
    expect(thaw).not.toHaveBeenCalled();
  });

  it('writes an immutable caller-only recovery snapshot and exact return reference', async () => {
    const { plan } = receiptFixture();
    const callerScope = loopScope('caller-harness', plan.caller.ownerId);
    await setCarryNote({ workspaceId, scope: callerScope }, 'caller-only recovery context');
    await setCarryNote({ workspaceId, scope: loopScope('target-harness', plan.target.ownerId) }, 'target-only context');
    const deps = { readCaller: async () => ({ ...plan.caller }) };
    const recovery = await checkpointAssumeCaller(plan, deps);
    expect(recovery.returnRef).toMatchObject({ ownerId: plan.caller.ownerId, nativeSessionId: plan.caller.nativeSessionId });
    const saved = await readAssumeCallerCheckpoint(plan, recovery);
    expect(await readAssumeCallerCheckpoint(assumePreparationSchema.parse(plan), recovery)).toEqual(saved);
    expect(saved.carryNotes.map(note => note.scope)).toEqual([callerScope]);
    expect(saved.carryNotes[0].note).toBe('caller-only recovery context');
    expect(JSON.stringify(saved)).not.toContain(plan.target.ownerId);
    expect(saved).toMatchObject({ inbox: 'retained', directives: 'retained' });
    await setCarryNote({ workspaceId, scope: callerScope }, 'newer caller note');
    expect(await checkpointAssumeCaller(plan, deps)).toEqual(recovery);
    expect((await readAssumeCallerCheckpoint(plan, recovery)).carryNotes[0].note).toBe('caller-only recovery context');
  });

  it('refuses changed caller custody before creating its recovery snapshot and rejects later tampering', async () => {
    const { plan } = receiptFixture();
    await expect(checkpointAssumeCaller(plan, { readCaller: async () => ({ ...plan.caller, nativePid: 102 }) }))
      .rejects.toThrow('assume-caller-changed');
    const scope = `${assumeTransitionKey(plan)}:caller`;
    const before = await fixture.admin`SELECT note FROM harness_shared.carry_notes WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    expect(before).toHaveLength(0);
    const recovery = await checkpointAssumeCaller(plan, { readCaller: async () => plan.caller });
    await fixture.admin`UPDATE harness_shared.carry_notes SET note = 'tampered'
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    await expect(readAssumeCallerCheckpoint(plan, recovery)).rejects.toThrow('assume-caller-recovery-changed');
  });

  it('R-5 nonempty caller work and return reference survive handoff failure', async () => {
    const f = await durableTransitionFixture();
    try {
      const { plan } = f;
      const id = 'WI-assume-failed-handoff-' + randomUUID();
      await fixture.admin`INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, admission, taken_by, taken_at, updated_ts)
        VALUES (${workspaceId}, 'fixture-harness', ${id}, 'caller failed handoff', 'open', 'feature', 'local', NULL,
          ${plan.caller.ownerId}, now(), ${Date.now()})`;
      await setWorkItemCheckpoint({ workspaceId, harness: 'fixture-harness', workItemId: id }, 'Original caller work.');
      const awaited = await registerAwait({ subscriberId: plan.caller.ownerId, eventKey: `work-item:done:${id}`,
        once: false, boundTo: { kind: 'work-item', ref: id } });
      f.handoff.mockResolvedValue('refused');
      const result = await commitAssume(plan, f.transition);
      expect(result).toMatchObject({ state: 'rolled-back', durable: true, recovery: { returnRef: {
        ownerId: plan.caller.ownerId, nativeSessionId: plan.caller.nativeSessionId,
      } }, disposition: { releasedWorkClaims: [{ id }], inbox: 'retained', directives: 'retained' } });
      const saved = await readAssumeCallerCheckpoint(plan, result.recovery!);
      expect(saved.work).toEqual([expect.objectContaining({ id, checkpoint: 'Original caller work.' })]);
      expect((await runWithWorkspace(workspaceId, () => getWorkItem(id, 'fixture-harness')))?.assignee)
        .toBe(plan.caller.ownerId);
      expect((await listActiveAwaits(plan.caller.ownerId)).map(row => row.id)).toContain(awaited.id);
      expect(await readAssumeCallerPause(plan.caller.ownerId)).toBeNull();
      expect((await f.snapshot()).registration[0].resume_claim_key).toBeNull();
      expect(await commitAssume(plan, f.transition)).toMatchObject({ state: 'rolled-back', replayed: true });
      expect(f.handoff).toHaveBeenCalledOnce();
      expect(await f.store.load()).toEqual(result);
    } finally { f.dispose(); }
  });

  it('R-6 accepted requires later process and routed probe verification', async () => {
    const f = await durableTransitionFixture();
    try {
      const accepted = await commitAssume(f.plan, f.transition);
      expect(accepted.state).toBe('handoff-accepted');
      expect(await f.store.load()).toEqual(accepted);
      const witness = observationFixture(accepted);
      for (const invalid of [
        { ...witness, callerExited: false },
        { ...witness, nativeWriterPids: [102, 103] },
        { ...witness, directedMessage: { ...witness.directedMessage, consumedBy: f.plan.caller.ownerId } },
        { ...witness, assignment: { ...witness.assignment, observedBy: f.plan.caller.ownerId } },
      ]) {
        expect(await verifyAssumeExecution(accepted, invalid, f.transition.save)).toBe(accepted);
        expect(await f.store.load()).toEqual(accepted);
      }
      // This proves durable observation validation; the witness is deliberately
      // synthetic, with actual native probes supplied by the separate suite.
      expect(await verifyAssumeExecution(accepted, witness, f.transition.save))
        .toMatchObject({ state: 'target-verified', durable: true, observation: witness });
      expect((await f.store.load())?.state).toBe('target-verified');
      expect(f.handoff).toHaveBeenCalledOnce();
    } finally { f.dispose(); }
  });

  it.each(['timeout', 'host death'] as const)(
    'R-6 timeout and host death remain recoverable indeterminate: %s', async failure => {
      const f = await durableTransitionFixture();
      try {
        f.handoff.mockRejectedValue(new Error(failure + ': private adapter details'));
        const uncertain = await commitAssume(f.plan, f.transition);
        expect(uncertain).toMatchObject({ state: 'indeterminate', durable: true, reason: 'transition-failed' });
        expect(JSON.stringify(uncertain)).not.toContain('private adapter details');
        expect(await f.store.load()).toEqual(uncertain);
        expect(await readAssumeCallerPause(f.plan.caller.ownerId)).not.toBeNull();
        expect((await f.snapshot()).registration[0].resume_claim_key).toBe(uncertain.transitionKey);
        expect(await readAssumeCallerCheckpoint(f.plan, uncertain.recovery!)).toMatchObject({ caller: f.plan.caller });
        expect(await commitAssume(f.plan, f.transition)).toMatchObject({ state: 'indeterminate', replayed: true });
        expect(f.transition.restoreCaller).not.toHaveBeenCalled();
        expect(f.transition.releaseTarget).not.toHaveBeenCalled();
        expect(f.handoff).toHaveBeenCalledOnce();
      } finally { f.dispose(); }
    });

  it.each(['caller-checkpointed', 'caller-quiesced', 'target-custody-acquired', 'handoff-requested'] as const)(
    'R-8 fault injection at every transition boundary preserves custody and recovery: %s', async state => {
      const f = await durableTransitionFixture();
      try {
        vi.mocked(f.transition.save).mockImplementation(async receipt => {
          if (receipt.state === state) throw new Error('Injected persistence failure');
          await f.store.save(receipt);
        });
        const result = await commitAssume(f.plan, f.transition);
        expect(result).toMatchObject({ state: 'rolled-back', durable: true });
        expect(await f.store.load()).toEqual(result);
        expect(await readAssumeCallerCheckpoint(f.plan, result.recovery!)).toMatchObject({ caller: f.plan.caller });
        expect(await readAssumeCallerPause(f.plan.caller.ownerId)).toBeNull();
        expect((await f.snapshot()).registration[0].resume_claim_key).toBeNull();
        expect(f.handoff).not.toHaveBeenCalled();
        expect(await commitAssume(f.plan, f.transition)).toMatchObject({ state: 'rolled-back', replayed: true });
        expect(f.transition.releaseTarget).toHaveBeenCalledOnce();
      } finally { f.dispose(); }
    });

  it('R-8 crash after target custody before exec or verification converges on retry', async () => {
    const f = await durableTransitionFixture();
    try {
      f.handoff.mockRejectedValue(new Error('Unknown host outcome'));
      const uncertain = await commitAssume(f.plan, f.transition);
      expect(uncertain.state).toBe('indeterminate');
      expect(await reconcileAssumeTransition(uncertain, { kind: 'unknown' }, f.transition)).toBe(uncertain);
      const cancellation = { kind: 'cancelled' as const, transitionKey: uncertain.transitionKey,
        preparationFingerprint: uncertain.preparationFingerprint,
        queuedHandoffCancelled: true as const, nativeWriter: 'free' as const };
      expect(await reconcileAssumeTransition(uncertain, { ...cancellation, transitionKey: 'foreign' }, f.transition))
        .toBe(uncertain);
      expect(f.transition.releaseTarget).not.toHaveBeenCalled();
      const settled = await reconcileAssumeTransition(uncertain, cancellation, f.transition);
      expect(settled).toMatchObject({ state: 'rolled-back', durable: true });
      expect(await f.store.load()).toEqual(settled);
      expect(await readAssumeCallerPause(f.plan.caller.ownerId)).toBeNull();
      expect((await f.snapshot()).registration[0].resume_claim_key).toBeNull();
      expect(await commitAssume(f.plan, f.transition)).toMatchObject({ state: 'rolled-back', replayed: true });
      expect(f.handoff).toHaveBeenCalledOnce();
      expect(f.transition.restoreCaller).toHaveBeenCalledOnce();
      expect(f.transition.releaseTarget).toHaveBeenCalledOnce();
    } finally { f.dispose(); }
  });

  it('R-9 unauthorized takeover refuses without disclosure or mutation', async () => {
    const f = await nativeContextFixture();
    try {
      expect(await f.deps.target(f.request)).not.toBeNull();
      const before = await f.snapshot();
      const caller = vi.fn(f.deps.caller), target = vi.fn(f.deps.target);
      const deps = { ...f.deps, caller, target, authorize: async () => null };
      expect(await prepareAssume(f.actor, f.request, deps)).toEqual({ ok: false, code: 'unauthorized' });
      expect(await validateAssume(f.actor, 'untrusted-token', deps)).toEqual({ ok: false, code: 'unauthorized' });
      expect(caller).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
      expect(await f.snapshot()).toEqual(before);
    } finally { f.dispose(); }
  });

  it('R-9 exact caller target incarnation context and expiry bind admission', async () => {
    const f = await nativeContextFixture();
    try {
      const prepared = await prepareAssume(f.actor, f.request, f.deps);
      if (!prepared.ok) throw new Error('Admission preparation refused: ' + prepared.code);
      const before = await f.snapshot();
      expect(await validateAssume({ ...f.actor, ownerId: 'su-other-caller' }, prepared.token, f.deps))
        .toEqual({ ok: false, code: 'caller-changed' });
      expect(await validateAssume({ ...f.actor, workspaceId: 'foreign-workspace' }, prepared.token, f.deps))
        .toEqual({ ok: false, code: 'caller-changed' });
      expect(await validateAssume(f.actor, prepared.token, { ...f.deps,
        caller: async () => ({ ...prepared.preparation.caller, incarnation: 'replacement-caller' }) }))
        .toEqual({ ok: false, code: 'caller-changed' });
      const corrupt = Buffer.from(prepared.token, 'base64url');
      corrupt[corrupt.length - 1] ^= 1;
      expect(await validateAssume(f.actor, corrupt.toString('base64url'), f.deps))
        .toEqual({ ok: false, code: 'invalid-token' });
      expect(await validateAssume(f.actor, prepared.token, { ...f.deps, secret: Buffer.alloc(32, 9) }))
        .toEqual({ ok: false, code: 'invalid-token' });
      expect(await validateAssume(f.actor, prepared.token, { ...f.deps, now: () => prepared.preparation.expiresAt }))
        .toEqual({ ok: false, code: 'expired-token' });
      expect(await f.snapshot()).toEqual(before);
      expect(await createAssumeReceiptStore(prepared.preparation).load()).toBeNull();
      // R3 and R4 exercise real context, registration and writer changes after
      // this same admission; no synthetic target replaces their SQL readers.
    } finally { f.dispose(); }
  });

  it('R-9 commit rechecks administrative authority and reviewer restrictions', async () => {
    const f = await nativeContextFixture();
    try {
      const prepared = await prepareAssume(f.actor, f.request, f.deps);
      if (!prepared.ok) throw new Error('Administrative preparation refused: ' + prepared.code);
      const before = await f.snapshot();
      const target = vi.fn(f.deps.target), caller = vi.fn(f.deps.caller);
      for (const authorize of [
        async () => null,
        async () => 'different-administrative-grant',
        async (_actor: typeof f.actor, role?: string) => role ? null : f.deps.authorize(),
      ]) {
        expect(await validateAssume(f.actor, prepared.token, { ...f.deps, authorize, caller, target }))
          .toEqual({ ok: false, code: 'unauthorized' });
        expect(caller).not.toHaveBeenCalled();
        expect(target).not.toHaveBeenCalled();
        expect(await f.snapshot()).toEqual(before);
        expect(await createAssumeReceiptStore(prepared.preparation).load()).toBeNull();
      }
    } finally { f.dispose(); }
  });

  it('R-12 preview preserves caller and target runtime and durable snapshots', async () => {
    const f = await durableTransitionFixture();
    try {
      // Fixture setup already prepared once; a first-preview write must not
      // become the baseline that later idempotent previews appear to preserve.
      expect(await f.store.load()).toBeNull();
      const scope = loopScope('fixture-harness', f.actor.ownerId);
      await setCarryNote({ scope, workspaceId }, 'Caller context retained by preview.');
      for (const owner of [f.actor.ownerId, f.ownerId]) {
        await fixture.admin`INSERT INTO harness_shared.routines
          (id, install_slug, name, workspace_id, target_owner_id, active, trigger_kind, trigger_config, target_role)
          VALUES (${randomUUID()}, 'fixture-harness', ${loopRoutineName(owner)}, ${workspaceId},
            ${owner}, true, 'cron', '{}'::jsonb, 'su')`;
      }
      const snapshot = async () => ({ ...await f.snapshot(), receipt: await f.store.load(),
        loops: await fixture.admin`SELECT * FROM harness_shared.routines WHERE workspace_id = ${workspaceId}
          AND target_owner_id IN (${f.actor.ownerId}, ${f.ownerId}) ORDER BY id`,
        callerContext: await fixture.admin`SELECT * FROM harness_shared.carry_notes
          WHERE workspace_id = ${workspaceId} AND scope = ${scope}`,
      });
      const before = await snapshot();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await prepareAssume(f.actor, f.request, f.deps)).toMatchObject({ ok: true, state: 'prepared' });
        expect(await snapshot()).toEqual(before);
      }
      expect(f.handoff).not.toHaveBeenCalled();
      expect(f.transition.save).not.toHaveBeenCalled();
      expect(f.transition.restoreCaller).not.toHaveBeenCalled();
      expect(f.transition.releaseTarget).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });

  it('R-3 native resume preserves exact conversation and backend', async () => {
    const f = await nativeContextFixture();
    try {
      const before = await f.snapshot();
      const prepared = await prepareAssume(f.actor, f.request, f.deps);
      if (!prepared.ok) throw new Error('Native context preparation refused: ' + prepared.code);
      expect(prepared).toMatchObject({ ok: true, preparation: { target: {
        ownerId: f.ownerId, advSessionId: f.id, backend: 'codex', nativeSessionId: f.nativeId,
        executionNativeSessionId: f.nativeId, binding: f.pin.binding,
        context: { mode: 'native-resume', ref: f.nativeId,
          sha256: createHash('sha256').update(f.transcript).digest('hex') },
      } } });
      expect(await validateAssume(f.actor, prepared.token, f.deps)).toMatchObject({ ok: true });
      expect(await f.snapshot()).toEqual(before);
      // Same identity, different native bytes: a saved admission cannot reopen
      // a changed conversation even when its registration remains untouched.
      writeFileSync(f.file, f.transcript + JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message',
        message: 'New target history after preparation' } }) + '\n');
      expect(await validateAssume(f.actor, prepared.token, f.deps))
        .toEqual({ ok: false, code: 'target-changed' });
      expect((await f.snapshot()).registration).toEqual(before.registration);
      expect(await readAssumeCallerPause(f.actor.ownerId)).toBeNull();
    } finally { f.dispose(); }
  });

  it('R-3 unavailable corrupt stale and incompatible context refuses without fallback', async () => {
    const f = await nativeContextFixture();
    try {
      const scope = loopScope('fixture-harness', f.ownerId);
      await setCarryNote({ scope, workspaceId }, 'A valid checkpoint must not silently replace native mode.');
      for (const invalid of ['', '{broken-json\n',
        JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n']) {
        writeFileSync(f.file, invalid);
        const before = await f.snapshot();
        expect(await prepareAssume(f.actor, f.request, f.deps))
          .toEqual({ ok: false, code: 'context-unavailable' });
        expect(await f.snapshot()).toEqual(before);
        expect(await readAssumeCheckpoint({ ownerId: f.ownerId, workspaceId,
          harnessSlug: 'fixture-harness', binding: f.pin.binding })).not.toBeNull();
      }
      writeFileSync(f.file, f.transcript);
      // Conversely, an intact native transcript cannot rescue a stale explicit
      // checkpoint. Both choices must refuse before a custody reservation.
      await fixture.admin`UPDATE harness_shared.carry_notes
        SET body_ts = ${Date.now() - 120_000} WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
      const before = await f.snapshot();
      expect(await prepareAssume(f.actor, { ...f.request, contextMode: 'checkpoint' }, f.deps))
        .toEqual({ ok: false, code: 'context-unavailable' });
      expect(await f.snapshot()).toEqual(before);
      await fixture.admin`UPDATE harness_shared.adv_sessions SET agent = 'unsupported-fixture' WHERE id = ${f.id}`;
      const unsupported = await f.snapshot();
      expect(await prepareAssume(f.actor, f.request, f.deps))
        .toEqual({ ok: false, code: 'context-unavailable' });
      expect(await f.snapshot()).toEqual(unsupported);
    } finally { f.dispose(); }
  });

  it('R-4 stale target incarnation and writer generation refuses unchanged', async () => {
    for (const change of ['incarnation', 'writer generation'] as const) {
      const f = await nativeContextFixture();
      try {
        const callerScope = loopScope('fixture-harness', f.actor.ownerId);
        await setCarryNote({ scope: callerScope, workspaceId }, 'Caller work must survive a stale target.');
        const callerBefore = await fixture.admin`SELECT * FROM harness_shared.carry_notes
          WHERE workspace_id = ${workspaceId} AND scope = ${callerScope}`;
        const prepared = await prepareAssume(f.actor, f.request, f.deps);
        if (!prepared.ok) throw new Error('R4 preparation refused: ' + prepared.code);
        const store = createAssumeReceiptStore(prepared.preparation);
        expect(await store.load()).toBeNull();
        if (change === 'incarnation') {
          // A one-microsecond change must survive the SQL-to-JS boundary.
          await fixture.admin`UPDATE harness_shared.adv_sessions
            SET started_at = started_at + interval '1 microsecond' WHERE id = ${f.id}`;
        } else {
          // Both states are free; this changes the production writer-generation
          // witness without changing the registration or transcript.
          const locks = join(f.home, 'thread-writer-locks');
          mkdirSync(locks, { recursive: true });
          writeFileSync(join(locks, `${f.nativeId}.lock`), '');
        }
        const changed = await f.deps.target(f.request);
        expect(changed).toMatchObject({ writer: 'free', context: prepared.preparation.target.context });
        expect(changed?.writerGeneration).not.toBe(prepared.preparation.target.writerGeneration);
        if (change === 'incarnation') {
          expect(changed?.binding.startedAt).not.toBe(prepared.preparation.target.binding.startedAt);
        } else {
          expect(changed?.binding).toEqual(prepared.preparation.target.binding);
        }
        const before = await f.snapshot();
        expect(await validateAssume(f.actor, prepared.token, f.deps))
          .toEqual({ ok: false, code: 'target-changed' });
        expect(await f.snapshot()).toEqual(before);
        expect(await store.load()).toBeNull();
        expect(await fixture.admin`SELECT * FROM harness_shared.carry_notes
          WHERE workspace_id = ${workspaceId} AND scope = ${callerScope}`).toEqual(callerBefore);
      } finally { f.dispose(); }
    }
  });

  it('R-4 same textual target in foreign workspace refuses', async () => {
    const f = await nativeContextFixture();
    try {
      const prepared = await prepareAssume(f.actor, f.request, f.deps);
      if (!prepared.ok) throw new Error('R4 preparation refused: ' + prepared.code);
      const foreignWorkspace = 'assume-foreign-' + randomUUID();
      await fixture.admin`UPDATE harness_shared.adv_sessions SET workspace_id = ${foreignWorkspace}
        WHERE id = ${f.id}`;
      // Positive control: the same complete native identity really exists in
      // the other workspace, rather than being an absent/unreadable target.
      expect(await runWithWorkspace(foreignWorkspace, () => readAssumeTarget(f.request, foreignWorkspace)))
        .toMatchObject({ ownerId: f.ownerId, workspaceId: foreignWorkspace, nativeSessionId: f.nativeId,
          context: prepared.preparation.target.context });
      const before = await f.snapshot();
      expect(await f.deps.target(f.request)).toBeNull();
      expect(await prepareAssume(f.actor, f.request, f.deps))
        .toEqual({ ok: false, code: 'context-unavailable' });
      expect(await validateAssume(f.actor, prepared.token, f.deps))
        .toEqual({ ok: false, code: 'target-changed' });
      expect(await f.snapshot()).toEqual(before);
      expect(await createAssumeReceiptStore(prepared.preparation).load()).toBeNull();
    } finally { f.dispose(); }
  });

  it('R-3 checkpoint selection pins revision hash and fresh context', async () => {
    const ownerId = `su-checkpoint-${randomUUID()}`;
    const scope = loopScope('fixture-harness', ownerId);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const target = { ownerId, workspaceId, harnessSlug: 'fixture-harness',
      binding: { coordOwnerId: ownerId, sessionId: 'native', startedAt } };
    await setCarryNote({ scope, workspaceId }, 'target-owned checkpoint');
    const pin = await readAssumeCheckpoint(target);
    expect(pin).toMatchObject({ mode: 'checkpoint', ref: `carry-note:${scope}` });
    expect(await readAssumeCheckpoint({ ...target, workspaceId: 'foreign-workspace' })).toBeNull();
    await fixture.admin`UPDATE harness_shared.carry_notes SET updated_ts = ${Date.now() + 5_000}
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    expect(await readAssumeCheckpoint(target)).toEqual(pin);
    // The deliberately future attestation above must be restored before a real
    // body write: the carry writer correctly rejects an older write watermark.
    await fixture.admin`UPDATE harness_shared.carry_notes SET updated_ts = ${Date.now() - 1}
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    expect(await setCarryNote({ scope, workspaceId }, 'a different target-owned checkpoint'))
      .toBe('a different target-owned checkpoint');
    const changed = await readAssumeCheckpoint(target);
    expect(changed?.sha256).not.toBe(pin?.sha256);
    expect(changed?.revision).not.toBe(pin?.revision);
    await fixture.admin`UPDATE harness_shared.carry_notes SET body_ts = ${Date.now() - 120_000}
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    expect(await readAssumeCheckpoint(target)).toBeNull();
  });

  it('R-10 tampered mismatched or non-target checkpoint refuses before custody', async () => {
    const { plan } = receiptFixture();
    const scope = loopScope(plan.target.harnessSlug, plan.target.ownerId);
    const body = 'Private target checkpoint; never return it in a refusal.';
    plan.target.binding.startedAt = new Date(Date.now() - 60_000).toISOString();
    await setCarryNote({ scope, workspaceId }, body);
    const pin = await readAssumeCheckpoint(plan.target);
    expect(pin).not.toBeNull();
    plan.target.context = pin!;
    plan.target.executionNativeSessionId = null;
    expect(await readAssumeCheckpointBody(plan)).toBe(body);
    const before = await fixture.admin`SELECT * FROM harness_shared.carry_notes
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    const mutations: Array<(candidate: AssumePreparation) => void> = [
      candidate => { candidate.target.context.sha256 = 'f'.repeat(64); },
      candidate => { candidate.target.context.revision = '0'; },
      candidate => { candidate.target.context.ref = 'carry-note:another-owner'; },
      candidate => { candidate.target.ownerId = `su-${randomUUID()}`; },
      candidate => { candidate.target.workspaceId = 'foreign-workspace'; },
      candidate => { candidate.target.binding.startedAt = new Date(Date.now() + 60_000).toISOString(); },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(plan);
      mutate(candidate);
      await expect(readAssumeCheckpointBody(candidate)).rejects.toThrow(/^assume-checkpoint-(changed|unavailable)$/);
    }
    expect(await fixture.admin`SELECT * FROM harness_shared.carry_notes
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`).toEqual(before);
    // A body change with the same revision must still fail the pinned hash.
    await fixture.admin`UPDATE harness_shared.carry_notes SET note = 'tampered body'
      WHERE workspace_id = ${workspaceId} AND scope = ${scope}`;
    await expect(readAssumeCheckpointBody(plan)).rejects.toThrow('assume-checkpoint-changed');
    expect(await createAssumeReceiptStore(plan).load()).toBeNull();
  });

  it('R-10 caller history credentials and unapproved environment do not cross context boundary', async () => {
    const { plan, receipt } = receiptFixture();
    const callerBody = JSON.stringify({ transcript: 'caller-private-transcript', toolHistory: 'caller-private-tool-history',
      credentials: { OPENAI_API_KEY: 'caller-private-credential' }, environment: { PRIVATE_CONTEXT: 'caller-private-env' } });
    await setCarryNote({ scope: loopScope(plan.target.harnessSlug, plan.caller.ownerId), workspaceId }, callerBody);
    const targetBody = 'Only the selected target checkpoint is launch input.';
    await setCarryNote({ scope: loopScope(plan.target.harnessSlug, plan.target.ownerId), workspaceId }, targetBody);
    plan.target.binding.startedAt = new Date(Date.now() - 60_000).toISOString();
    plan.target.context = (await readAssumeCheckpoint(plan.target))!;
    expect(plan.target.context).not.toBeNull();
    plan.target.executionNativeSessionId = null;
    const recovery = await checkpointAssumeCaller(plan, { readCaller: async () => plan.caller });
    const callerCheckpoint = await readAssumeCallerCheckpoint(plan, recovery);
    expect(callerCheckpoint.carryNotes.some(note => note.note === callerBody)).toBe(true);
    const input = await readAssumeCheckpointBody(plan);
    expect(input).toBe(targetBody);
    const store = createAssumeReceiptStore(plan);
    const preparedReceipt = { ...receipt, preparation: plan,
      preparationFingerprint: assumePreparationFingerprint(plan), recovery };
    expect((await store.claim(preparedReceipt)).won).toBe(true);
    const stored = await store.load();
    expect(stored?.recovery).toEqual(recovery);
    for (const secret of ['caller-private-transcript', 'caller-private-tool-history',
      'caller-private-credential', 'caller-private-env']) {
      expect(input).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain(secret);
    }
    expect(await readAssumeCheckpointBody(plan)).toBe(targetBody);
  });

  it('R-11 takeover audit retains caller target authorization and terminal provenance', async () => {
    const { plan, receipt } = receiptFixture();
    const stores = [createAssumeReceiptStore(plan), createAssumeReceiptStore(plan)];
    const claims = await Promise.all(stores.map(store => store.claim(receipt)));
    expect(claims.filter(claim => claim.won)).toHaveLength(1);
    const winner = stores[claims.findIndex(claim => claim.won)];
    const loser = stores[claims.findIndex(claim => !claim.won)];
    const accepted = { ...receipt, state: 'handoff-accepted' as const, updatedAt: receipt.updatedAt + 1 };
    await winner.save(accepted);
    await expect(loser.save({ ...receipt, state: 'rolled-back', updatedAt: receipt.updatedAt + 2 }))
      .rejects.toThrow('assume-receipt-changed');
    expect(await createAssumeReceiptStore(plan).load()).toEqual(accepted);
    const events = await fixture.admin<{ body: { sessionAssume: AssumeTransitionReceipt } }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND body #>> '{sessionAssume,transitionKey}' = ${receipt.transitionKey}
    `;
    expect(events.map(row => row.body.sessionAssume.state)).toEqual(['handoff-accepted']);
    expect(events[0].body.sessionAssume.preparation.authorizationRef).toBe(plan.authorizationRef);
    // Repeating an acknowledged state is idempotent, including its audit append.
    await winner.save(accepted);
    const [{ count }] = await fixture.admin<{ count: string }[]>`
      SELECT count(*) FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND body #>> '{sessionAssume,transitionKey}' = ${receipt.transitionKey}
    `;
    expect(Number(count)).toBe(1);
    const terminal = { ...accepted, state: 'target-verified' as const,
      observation: observationFixture(accepted), updatedAt: accepted.updatedAt + 1 };
    await winner.save(terminal);
    const history = await fixture.admin<{ body: Record<string, any> }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND body #>> '{sessionAssume,transitionKey}' = ${receipt.transitionKey}
       ORDER BY body ->> 'ts', body ->> 'msg_id'
    `;
    expect(history).toHaveLength(2);
    expect(history[0].body.sessionAssume).toEqual(accepted);
    expect(history[1].body).toMatchObject({ from: plan.caller.ownerId, category: 'session-assume-audit',
      sessionAssume: { ...terminal, preparation: { caller: plan.caller,
        target: plan.target, authorizationRef: plan.authorizationRef } } });
  });

  it.each(['refused', 'target-verified', 'rolled-back'] as const)(
    'R-11 refused verified and rolled-back outcomes remain append-only: %s', async state => {
      const { plan, receipt } = receiptFixture();
      const store = createAssumeReceiptStore(plan);
      await store.claim(receipt);
      const prior = { ...receipt, state: 'handoff-requested' as const, updatedAt: receipt.updatedAt + 1 };
      await store.save(prior);
      const terminal = { ...receipt, state, updatedAt: receipt.updatedAt + 2,
        ...(state === 'target-verified' ? { observation: observationFixture(prior) } : {}) };
      await store.save(terminal);
      await store.save(terminal); // acknowledgement replay must not duplicate history
      const history = await fixture.admin<{ body: { sessionAssume: AssumeTransitionReceipt } }[]>`
        SELECT body FROM harness_shared.coord_event_log
         WHERE workspace_id = ${workspaceId} AND body #>> '{sessionAssume,transitionKey}' = ${receipt.transitionKey}
         ORDER BY body ->> 'ts', body ->> 'msg_id'
      `;
      expect(history.map(row => row.body.sessionAssume)).toEqual([prior, terminal]);
      expect(await createAssumeReceiptStore(plan).load()).toEqual(terminal);
      // A stale writer must neither overwrite the terminal receipt nor append a
      // conflicting audit. This checks the database CAS, not an in-memory log.
      const stale = createAssumeReceiptStore(plan);
      await stale.load();
      const newer = { ...terminal, updatedAt: terminal.updatedAt + 1 };
      await store.save(newer);
      await expect(stale.save({ ...terminal, state: 'indeterminate' }))
        .rejects.toThrow('assume-receipt-changed');
      const after = await fixture.admin<{ body: { sessionAssume: AssumeTransitionReceipt } }[]>`
        SELECT body FROM harness_shared.coord_event_log
         WHERE workspace_id = ${workspaceId} AND body #>> '{sessionAssume,transitionKey}' = ${receipt.transitionKey}
         ORDER BY body ->> 'ts', body ->> 'msg_id'
      `;
      expect(after.map(row => row.body.sessionAssume)).toEqual([prior, terminal, newer]);
    },
  );

  it('rolls back the mutable receipt when its append-only audit cannot commit', async () => {
    const { plan, receipt } = receiptFixture();
    const store = createAssumeReceiptStore(plan);
    await store.claim(receipt);
    await fixture.admin.unsafe(`CREATE FUNCTION harness_shared.assume_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.body #>> '{sessionAssume,reason}' = 'audit-failure-fixture' THEN
          RAISE EXCEPTION 'fixture-audit-refused';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER assume_audit_failure BEFORE INSERT ON harness_shared.coord_event_log
        FOR EACH ROW EXECUTE FUNCTION harness_shared.assume_audit_failure();`);
    try {
      await expect(store.save({ ...receipt, state: 'indeterminate', reason: 'audit-failure-fixture' }))
        .rejects.toThrow('fixture-audit-refused');
      expect(await createAssumeReceiptStore(plan).load()).toEqual(receipt);
    } finally {
      await fixture.admin.unsafe(`DROP TRIGGER assume_audit_failure ON harness_shared.coord_event_log;
        DROP FUNCTION harness_shared.assume_audit_failure();`);
    }
    await store.save({ ...receipt, state: 'indeterminate' });
    expect(await createAssumeReceiptStore(plan).load()).toMatchObject({ state: 'indeterminate' });
  });

  it('retains an uncertain execution fence beyond ordinary launch cleanup and refuses corrupt stored receipts', async () => {
    const { plan, receipt } = receiptFixture();
    const store = createAssumeReceiptStore(plan);
    await store.claim(receipt);
    await store.save({ ...receipt, state: 'indeterminate' });
    await fixture.admin`UPDATE harness_shared.agent_launch_idempotency
      SET launched_at = ${Date.now() - 30 * 24 * 60 * 60 * 1_000}
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${receipt.transitionKey}`;
    await claimAgentLaunch({ workspaceId, idempotencyKey: `unrelated-${randomUUID()}`, failClosed: true });
    expect(await createAssumeReceiptStore(plan).claim(receipt)).toMatchObject({ won: false, prior: { state: 'indeterminate' } });
    await fixture.admin`UPDATE harness_shared.agent_launch_idempotency
      SET summary = '{"sessionAssume":{"state":"target-verified"}}'::jsonb
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${receipt.transitionKey}`;
    await expect(createAssumeReceiptStore(plan).load()).rejects.toThrow();
    await expect(createAssumeReceiptStore(plan).claim(receipt)).rejects.toThrow();
  });
});

describe('session:assume existing resume reservation (real PG)', () => {
  it('R-8 preserves original native history across an authorized startup append and retains lease fences', async () => {
    const f = await nativeContextFixture();
    try {
      const prepared = await prepareAssume(f.actor, f.request, f.deps);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('Native prefix preparation refused');
      const plan = prepared.preparation;
      const readTarget: typeof readAssumeTarget = (...args) =>
        runWithWorkspace(workspaceId, () => readAssumeTarget(...args));
      const strict = createAssumeCustodyAdapters(plan, { readTarget });
      const retry = createAssumeCustodyAdapters(plan, { readTarget, authorizedStartup: true });
      expect(await strict.reserve(plan)).toMatchObject({ acquired: true });
      appendFileSync(f.file, '{"type":"event_msg","payload":{"message":"own native startup"}}\n');
      expect(await strict.checkCustody(plan)).toBe(false);
      expect(await retry.checkCustody(plan)).toBe(true);
      writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('Exact target history', 'Other target history'));
      expect(await retry.checkCustody(plan)).toBe(false);
      writeFileSync(f.file, f.transcript + '{"type":"event_msg","payload":{"message":"own native startup"}}\n');
      expect(await retry.checkCustody(plan)).toBe(true);
      await fixture.admin`UPDATE harness_shared.adv_sessions SET resume_claim_key = 'foreign-attempt' WHERE id = ${f.id}`;
      expect(await retry.checkCustody(plan)).toBe(false);
      expect(await retry.releaseTarget(plan)).toBe(false);
    } finally { f.dispose(); }
  });

  async function custodyFixture() {
    const { id, pin } = await target();
    const { plan } = receiptFixture();
    plan.target = { ...plan.target, advSessionId: id, ownerId: pin.binding.coordOwnerId,
      nativeSessionId: pin.binding.sessionId!, executionNativeSessionId: pin.binding.sessionId!,
      binding: pin.binding, context: { ...plan.target.context, ref: pin.binding.sessionId! } };
    const readTarget = vi.fn(async () => structuredClone(plan.target));
    return { id, plan, readTarget, adapter: createAssumeCustodyAdapters(plan, { readTarget }) };
  }

  it('rechecks the exact live reservation and native context before allowing handoff', async () => {
    const { plan, adapter, readTarget } = await custodyFixture();
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.reserve(plan)).toMatchObject({ acquired: true });
    expect(await adapter.checkCustody(plan)).toBe(true);
    readTarget.mockResolvedValue({ ...plan.target, writer: 'held' });
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.releaseTarget(plan)).toBe(false);
    readTarget.mockResolvedValue(structuredClone(plan.target));
    expect(await adapter.releaseTarget(plan)).toBe(true);
    expect(await adapter.releaseTarget(plan)).toBe(true);
    expect(await adapter.checkCustody(plan)).toBe(false);
  });

  it('refuses changed context and an expired or replaced reservation', async () => {
    const { id, plan, adapter, readTarget } = await custodyFixture();
    await adapter.reserve(plan);
    readTarget.mockResolvedValue({ ...plan.target, context: { ...plan.target.context, revision: 'changed' } });
    expect(await adapter.checkCustody(plan)).toBe(false);
    readTarget.mockResolvedValue(structuredClone(plan.target));
    await fixture.admin`UPDATE harness_shared.adv_sessions SET resume_claimed_at = now() - interval '121 seconds' WHERE id = ${id}`;
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await acquireAdvSessionResume(id, 'competing-caller', 120, undefined, undefined, false,
      { workspaceId, binding: plan.target.binding, requireTerminal: true })).toMatchObject({ acquired: true });
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.releaseTarget(plan)).toBe(false);
  });

  it('does not renew custody or release another incarnation after target binding changes', async () => {
    const { id, plan, adapter } = await custodyFixture();
    await adapter.reserve(plan);
    await fixture.admin`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${id}`;
    expect(await adapter.checkCustody(plan)).toBe(false);
    expect(await adapter.reserve(plan)).toEqual({ acquired: false, status: 'binding-changed' });
    await expect(adapter.reserve({ ...plan, requestId: 'different' })).rejects.toThrow('preparation-changed');
  });

  it('checks lease ownership again when a slow native probe outlives its reservation', async () => {
    const { id, plan, adapter, readTarget } = await custodyFixture();
    await adapter.reserve(plan);
    readTarget.mockImplementation(async () => {
      await fixture.admin`UPDATE harness_shared.adv_sessions SET resume_claimed_at = now() - interval '121 seconds' WHERE id = ${id}`;
      return structuredClone(plan.target);
    });
    expect(await adapter.checkCustody(plan)).toBe(false);
  });

  it('R-4 two callers race one target with one unchanged loser', async () => {
    const { id, pin } = await target();
    const keys = ['caller-a', 'caller-b'];
    const results = await Promise.all(keys.map(key =>
      acquireAdvSessionResume(id, key, 120, undefined, undefined, false, pin)));
    expect(results.filter(result => result.acquired)).toHaveLength(1);
    expect(results.filter(result => result.status === 'reserved')).toHaveLength(1);
    const [stored] = await fixture.admin<{ key: string; ended: boolean }[]>`
      SELECT resume_claim_key AS key, ended_at IS NOT NULL AS ended
        FROM harness_shared.adv_sessions WHERE id = ${id}
    `;
    expect(stored.ended).toBe(true);
    const winner = keys[results.findIndex(result => result.acquired)];
    expect(stored.key).toBe(winner);
    expect(await acquireAdvSessionResume(id, winner, 120, undefined, undefined, false, pin))
      .toMatchObject({ acquired: true, replayed: true });
    expect(await releaseAdvSessionResume(id, 'not-the-owner')).toBe(false);
    expect(await releaseAdvSessionResume(id, winner)).toBe(true);
  });

  it('refuses stale incarnation and foreign workspace without writing a lease', async () => {
    const { id, pin } = await target();
    await fixture.admin`UPDATE harness_shared.adv_sessions SET started_at = started_at + interval '1 second' WHERE id = ${id}`;
    expect(await acquireAdvSessionResume(id, 'stale', 120, undefined, undefined, false, pin))
      .toEqual({ status: 'binding-changed', acquired: false });
    const other = await target();
    expect(await acquireAdvSessionResume(other.id, 'foreign', 120, undefined, undefined, false,
      { ...other.pin, workspaceId: 'foreign-workspace' }))
      .toEqual({ status: 'binding-changed', acquired: false });
    const rows = await fixture.admin<{ key: string | null }[]>`
      SELECT resume_claim_key AS key FROM harness_shared.adv_sessions WHERE id IN (${id}, ${other.id})
    `;
    expect(rows.map(row => row.key)).toEqual([null, null]);
  });

  it('refuses ended-to-live changes despite a stale or replayed claim', async () => {
    const { id, pin } = await target();
    await acquireAdvSessionResume(id, 'caller', 120, undefined, undefined, false, pin);
    await fixture.admin`UPDATE harness_shared.adv_sessions SET ended_at = NULL, ended_by = NULL WHERE id = ${id}`;
    expect(await acquireAdvSessionResume(id, 'caller', 120, undefined, undefined, false, pin))
      .toEqual({ status: 'live', acquired: false });
  });
});

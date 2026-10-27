/** Trusted composition over the existing launch policy, receipt ledger,
 * caller recovery and resume reservation. No public argument can supply these
 * ports, an authorization reference, an environment or a runtime witness. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity, isTransportOnlyIdentity } from './agent-tools/coordination/identity';
import { resolveResumeTarget } from './agent-launch-core';
import { inspectBlindReviewResumeTarget } from './blind-review-session-bindings';
import { readSessionConfinement } from './capability-envelope/session-confinement-store';
import { decodeOperatorSecretKey } from './operator-secret-key';
import { completeAssumeCallerReturn, createAssumeCallerAdapters, readAssumeCallerCheckpoint,
  readAssumeCallerReturnSource, type AssumeCallerHostFence } from './session-assume-caller';
import { createAssumeCustodyAdapters } from './session-assume-custody';
import { createManagedAssumeHost } from './session-assume-host';
import { readAssumeCaller, readAssumeTarget, readAssumeCheckpointBody } from './session-assume-preparation';
import { createAssumeReceiptStore } from './session-assume-store';
import { ownsAssumeCallerPause, readAssumeCallerPause } from './session-assume-pause';
import { findLiveHostAsync } from './events/await/psu-pty-discovery';
import { assumePreparationSchema, assumePreparationFingerprint } from './session-assume';
import { readProcessIdentity } from './process-identity';
import type { AssumeActor, AssumePreparation, AssumePreparationDeps, AssumeRequest, AssumeTransitionDeps } from './session-assume';

interface AssumeAuthorizationPorts {
  confinement: typeof readSessionConfinement;
  resolve: typeof resolveResumeTarget;
  inspect: typeof inspectBlindReviewResumeTarget;
  envelope(ctx: UnifiedToolContext, request: AssumeRequest): Promise<boolean>;
}

const authorizationPorts: AssumeAuthorizationPorts = {
  confinement: readSessionConfinement, resolve: resolveResumeTarget, inspect: inspectBlindReviewResumeTarget,
  async envelope(ctx, request) {
    const { PROJECTED_DEPS } = await import('./projected-tool-deps');
    if (!PROJECTED_DEPS.checkCapabilityEnvelope) return false;
    for (const toolName of ['session:assume', 'capability:launch-agent']) {
      const verdict = await PROJECTED_DEPS.checkCapabilityEnvelope({ toolName,
        capabilities: ['capability:terminal'], ctx, args: request });
      if (verdict && verdict.decision !== 'allow') return false;
    }
    return true;
  },
};

/** The ctx is transport-owned. Administrative host metadata alone is not a
 * grant: require the authenticated principal and the same bypass/capability
 * policy that admits the administrative launch door, then reread confinement
 * on every preparation/commit. Restricted reviewers remain recruiter-owned. */
export function createAssumeAuthorizer(
  ctx: UnifiedToolContext, request: AssumeRequest, ports: AssumeAuthorizationPorts = authorizationPorts,
): AssumePreparationDeps['authorize'] {
  return async (actor: AssumeActor, targetRole?: string) => {
    try {
      const identity = resolveAgentIdentity(ctx);
      const principal = ctx.principal;
      if (!ctx.isSuperuser || ctx.gateBypass?.role !== true || ctx.gateBypass?.capability !== true ||
          !principal || principal.kind !== 'system' || principal.trust !== 'trusted' ||
          !principal.authMethod || !['bearer-token', 'spawn-url', 'process-internal'].includes(principal.authMethod) ||
          principal.workspaceId !== actor.workspaceId || identity.workspaceId !== actor.workspaceId ||
          identity.ownerId !== actor.ownerId || isTransportOnlyIdentity(identity.ownerId) ||
          principal.allowedTools && (!principal.allowedTools.has('session:assume') ||
            !principal.allowedTools.has('capability:launch-agent'))) return null;
      // Read restrictions before target context: preparation must not become a
      // way to inspect a reviewer's hidden conversation or frozen assignment.
      const [callerPolicy, targetPolicy, target] = await Promise.all([
        ports.confinement(actor.ownerId, actor.workspaceId),
        ports.confinement(request.targetOwnerId, actor.workspaceId),
        ports.resolve({ agentId: request.targetOwnerId }),
      ]);
      if (callerPolicy || targetPolicy || !target.ok || target.ownerId !== request.targetOwnerId ||
          target.workspaceId !== actor.workspaceId || targetRole !== undefined && (target.role ?? 'su') !== targetRole) return null;
      const reviewer = await ports.inspect({ workspaceId: actor.workspaceId,
        reviewerOwnerId: request.targetOwnerId, advSessionId: target.advSessionId });
      if (reviewer.binding || reviewer.recruiterLaunch || !await ports.envelope(ctx, request)) return null;
      // synthesizeTransportPrincipal deliberately gives superusers an empty
      // capability set; the host's explicit capability bypass is their grant.
      const proof = { actor, principal: { slug: principal.slug, kind: principal.kind,
        authMethod: principal.authMethod, trust: principal.trust,
        capabilities: [...principal.capabilities].sort(), allowedTools: principal.allowedTools ? [...principal.allowedTools].sort() : null },
        targetOwnerId: target.ownerId, targetRole: target.role ?? 'su', binding: target.binding };
      return `launch-envelope:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}`;
    } catch { return null; }
  };
}

/** Read the existing signing secret without creating it: preview has no writes.
 * Missing/corrupt configuration is unavailable, never a new random token key. */
export async function createAssumePreparationDeps(
  ctx: UnifiedToolContext, request: AssumeRequest,
): Promise<AssumePreparationDeps> {
  const { sql } = getOrgPg();
  const [row] = await sql<Array<{ value_b64: string }>>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key' LIMIT 1
  `;
  if (!row) throw new Error('assume-signing-key-unavailable');
  return { now: Date.now, secret: decodeOperatorSecretKey(row.value_b64, 'spawn-signing-key'),
    authorize: createAssumeAuthorizer(ctx, request), caller: readAssumeCaller,
    target: value => readAssumeTarget(value, ctx.workspaceId ?? '') };
}

/** P-002 supplies the exact managed host port. This factory cannot fall back
 * to another window, an unguarded CLI or an environment-only identity change. */
export function createAssumeTransitionDeps(plan: AssumePreparation,
  host: AssumeCallerHostFence & Pick<AssumeTransitionDeps, 'handoff'> = createManagedAssumeHost(plan)): AssumeTransitionDeps {
  const caller = createAssumeCallerAdapters(host);
  return { now: Date.now, ...createAssumeReceiptStore(plan), ...createAssumeCustodyAdapters(plan),
    ...caller, checkpointCaller: async value => {
      if (value.target.returnFrom) await readAssumeCallerReturnSource(value);
      return caller.checkpointCaller(value);
    }, handoff: (value, recovery) => host.handoff(value, recovery) };
}

/** Internal launcher inspection over existing receipts, pause and keyed lease.
 * The HTTP boundary requires the local superuser principal. No public argument
 * can create a preparation, authorize a transition or manufacture a lease. */
export async function inspectManagedAssumeRequest(value: unknown, afterExit = false, action = 'observe', startupValue?: unknown) {
  const startupAction = ['begin-startup', 'startup-started'].includes(action);
  if (!['freeze', 'queue', 'thaw', 'observe', 'complete-return', 'begin-startup', 'startup-started'].includes(action) ||
      afterExit && action === 'thaw' || (action === 'complete-return' || startupAction) && !afterExit)
    throw new Error('assume-host-invalid-action');
  const startup = startupAction ? z.object({ attemptId: z.string().uuid(),
    launcherPid: z.number().int().positive().optional(), ptyPid: z.number().int().positive().optional(),
  }).strict().parse(startupValue) : null;
  const text = z.string().min(1).max(4096);
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  const request = z.object({ transitionKey: z.string().regex(/^session-assume:[a-f0-9]{64}$/),
    preparationHash: hash, recoveryRef: text, recoveryHash: hash, expiresAt: z.number().int().positive(),
    caller: z.object({ ownerId: text, workspaceId: text, nativeSessionId: text,
      nativePid: z.number().int().positive(), hostId: text, attachmentId: text,
      childGeneration: z.number().int().positive() }).strict() }).strict().parse(value);
  const { sql } = getOrgPg();
  const [row] = await sql<Array<{ summary: { sessionAssume?: { preparation?: unknown } } }>>`
    SELECT summary FROM harness_shared.agent_launch_idempotency
     WHERE workspace_id = ${request.caller.workspaceId} AND idempotency_key = ${request.transitionKey}
  `;
  const plan = assumePreparationSchema.parse(row?.summary?.sessionAssume?.preparation);
  const store = createAssumeReceiptStore(plan);
  const receipt = await store.load();
  if (!receipt?.recovery || !receipt.durable ||
      !['caller-checkpointed', 'caller-quiesced', 'target-custody-acquired', 'handoff-requested', 'handoff-accepted',
        ...(action === 'complete-return' ? ['target-verified'] : [])].includes(receipt.state) ||
      (afterExit && receipt.state !== 'handoff-accepted' && !(action === 'complete-return' && receipt.state === 'target-verified')) ||
      receipt.transitionKey !== request.transitionKey || assumePreparationFingerprint(plan) !== request.preparationHash ||
      request.expiresAt !== plan.expiresAt || (!['thaw', 'complete-return'].includes(action) && Date.now() >= plan.expiresAt) ||
      !['ownerId', 'workspaceId', 'nativeSessionId', 'nativePid', 'hostId', 'attachmentId'].every(
        key => plan.caller[key as keyof typeof plan.caller] === request.caller[key as keyof typeof request.caller]) ||
      receipt.recovery.checkpointRef !== request.recoveryRef || receipt.recovery.checkpointSha256 !== request.recoveryHash)
    throw new Error('assume-host-receipt-mismatch');
  // notify-classification: {"classification":"durable","reason":"Completing caller return must preserve its restored responsibilities and mandatory audit acknowledgement across interruption.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
  if (action === 'complete-return') return { ok: await completeAssumeCallerReturn(plan) };
  const requireCallerRegistration = async () => {
    // A discovery record and a durable pause can outlive their adv registration.
    // Resolve again at the effect boundary, refusing successor-following and
    // native-id/incarnation changes even when the old host is still discoverable.
    const caller = await resolveResumeTarget({ agentId: plan.caller.ownerId });
    if (!caller.ok || caller.ownerId !== plan.caller.ownerId ||
        caller.workspaceId !== plan.caller.workspaceId || caller.agent !== plan.caller.backend ||
        caller.binding?.coordOwnerId !== plan.caller.ownerId ||
        caller.binding.startedAt !== plan.caller.incarnation ||
        (plan.caller.backend === 'omp' ? caller.ompThreadId : caller.sessionId) !== plan.caller.nativeSessionId)
      throw new Error('assume-host-caller-changed');
  };
  await requireCallerRegistration();
  const [pause, host, callerPolicy, targetPolicy] = await Promise.all([
    readAssumeCallerPause(plan.caller.ownerId), findLiveHostAsync(plan.caller.ownerId),
    // notify-classification: {"classification":"durable","reason":"Caller confinement inspection is conservatively connected to notification wrappers; mandatory custody consequences must retain delivery custody.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    readSessionConfinement(plan.caller.ownerId, plan.caller.workspaceId),
    // notify-classification: {"classification":"durable","reason":"Target confinement inspection is conservatively connected to notification wrappers; mandatory custody consequences must retain delivery custody.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
    readSessionConfinement(plan.target.ownerId, plan.target.workspaceId),
  ]);
  const managed = host as (typeof host & { childGeneration?: number;
    identityAssume?: { hostId: string; attachmentId: string } });
  if (callerPolicy || targetPolicy || !ownsAssumeCallerPause(pause, plan, receipt.recovery) ||
      (afterExit ? !!host : !managed || managed.ptyPid !== request.caller.nativePid ||
        managed.childGeneration !== request.caller.childGeneration ||
        managed.identityAssume?.hostId !== request.caller.hostId || managed.identityAssume?.attachmentId !== request.caller.attachmentId))
    throw new Error('assume-host-custody-changed');
  await readAssumeCallerCheckpoint(plan, receipt.recovery);
  const processExited = (pid: number, identity: string) => {
    const current = readProcessIdentity(pid);
    if (current) return current !== identity;
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  if (action === 'startup-started') {
    const prior = receipt.startup;
    const identity = startup?.ptyPid ? readProcessIdentity(startup.ptyPid) : null;
    if (!prior || prior.attemptId !== startup?.attemptId || !identity ||
        readProcessIdentity(prior.launcherPid) !== prior.launcherProcessStart ||
        prior.ptyPid !== undefined && (prior.ptyPid !== startup.ptyPid || prior.ptyProcessStart !== identity))
      throw new Error('assume-startup-changed');
    await requireCallerRegistration();
    await store.save({ ...receipt, startup: { ...prior, ptyPid: startup.ptyPid!, ptyProcessStart: identity },
      updatedAt: Date.now() });
    return { ok: true as const, attemptId: prior.attemptId };
  }
  const prior = receipt.startup;
  const priorExited = prior?.ptyPid !== undefined && prior.ptyProcessStart !== undefined &&
    processExited(prior.ptyPid, prior.ptyProcessStart);
  // A write-ahead launcher record is not proof that a native child ran. Only
  // the recorded child's exited incarnation permits post-startup append.
  // Unacknowledged spawns keep strict context pins and fail closed on growth.
  const authorizedStartup = afterExit && !!prior && priorExited;
  // Admission remains an exact whole-target comparison. Only a durable startup
  // attempt may authenticate the original immutable prefix after native append.
  const custody = createAssumeCustodyAdapters(plan, { authorizedStartup });
  // Thaw is rollback of the still-running exact caller; it must remain possible
  // after the target lease expired. The host refuses thaw once replacement began.
  if (action !== 'thaw' && !await custody.checkCustody(plan))
    throw new Error('assume-target-custody-changed');
  const checkpointBody = afterExit && plan.target.context.mode === 'checkpoint'
    ? await readAssumeCheckpointBody(plan) : undefined;
  // Neither checkpoint I/O nor target writer inspection extends caller custody.
  await requireCallerRegistration();
  if (action === 'begin-startup') {
    const identity = startup?.launcherPid ? readProcessIdentity(startup.launcherPid) : null;
    const replay = prior?.attemptId === startup?.attemptId && prior?.ptyPid === undefined;
    const unstartedExited = prior?.ptyPid === undefined && !!prior &&
      processExited(prior.launcherPid, prior.launcherProcessStart);
    if (!identity || prior && !replay && !priorExited && !unstartedExited || replay &&
        (prior!.launcherPid !== startup!.launcherPid || prior!.launcherProcessStart !== identity))
      throw new Error('assume-startup-not-exited');
    if (!replay) await store.save({ ...receipt, startup: { attemptId: startup!.attemptId,
      generation: (prior?.generation ?? 0) + 1, authorizedAt: Date.now(),
      launcherPid: startup!.launcherPid!, launcherProcessStart: identity }, updatedAt: Date.now() });
    return { ok: true as const, attemptId: startup!.attemptId };
  }
  return { ok: true as const, transitionKey: receipt.transitionKey, preparationHash: receipt.preparationFingerprint,
    state: receipt.state, preparation: plan, recovery: receipt.recovery,
    ...(checkpointBody === undefined ? {} : { checkpointBody }) };
}

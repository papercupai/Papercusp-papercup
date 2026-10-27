/** Ended-only managed identity takeover preparation.
 *
 * Preview is stateless: the opaque, authenticated token carries the exact pins
 * instead of creating a lease/checkpoint. Execution reuses adv_sessions' keyed
 * resume reservation and the launch receipt ledger; it never rebinds coord ids.
 * Host replacement and runtime observation live at the managed PTY boundary.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AdvSessionResumePin, AdvSessionResumeReservation } from './adv-sessions';

export const ASSUME_TOKEN_TTL_MS = 120_000;
const TOKEN_AAD = Buffer.from('papercusp:session-assume:v1');
const nonempty = z.string().min(1).max(4096);

export const assumeContextSchema = z.object({
  mode: z.enum(['native-resume', 'checkpoint']),
  ref: nonempty,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  revision: nonempty,
}).strict();

const callerSchema = z.object({
  ownerId: nonempty, workspaceId: nonempty, nativeSessionId: nonempty,
  incarnation: nonempty, hostId: nonempty, attachmentId: nonempty,
  nativePid: z.number().int().positive(),
  nativeProcessStart: nonempty.optional(),
  backend: z.enum(['claude', 'codex', 'omp']),
}).strict();

const targetSchema = z.object({
  ownerId: nonempty, workspaceId: nonempty, harnessSlug: nonempty,
  advSessionId: z.number().int().positive(), role: nonempty,
  nativeSessionId: nonempty, backend: z.enum(['claude', 'codex', 'omp']),
  // Codex chooses a fresh checkpoint thread id at startup. Null is deliberate
  // late binding, never a guessed UUID or permission to resume old history.
  executionNativeSessionId: nonempty.nullable(),
  binding: z.object({
    coordOwnerId: nonempty, sessionId: nonempty.nullable(), startedAt: nonempty,
    ompThreadId: nonempty.nullable().optional(),
  }).strict(),
  writerGeneration: nonempty,
  /** An exact return to a paused caller, pinned before the second departure. */
  returnFrom: z.object({ transitionKey: nonempty, checkpointRef: nonempty,
    checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  writer: z.enum(['free', 'held', 'unknown']),
  ended: z.boolean(), liveHost: z.boolean(),
  context: assumeContextSchema,
}).strict();

export const assumePreparationSchema = z.object({
  version: z.literal(1), requestId: z.string().min(1).max(120),
  authorizationRef: nonempty, preparedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(), caller: callerSchema, target: targetSchema,
}).strict();
const preparationSchema = assumePreparationSchema;

export type AssumeContext = z.infer<typeof assumeContextSchema>;
export type AssumeCaller = z.infer<typeof callerSchema>;
export type AssumeTarget = z.infer<typeof targetSchema>;
export type AssumePreparation = z.infer<typeof preparationSchema>;
export interface AssumeActor { ownerId: string; workspaceId: string }
export interface AssumeRequest {
  requestId: string;
  /** Exact canonical identity, never a prefix. */
  targetOwnerId: string;
  contextMode: AssumeContext['mode'];
}

export type AssumeRefusalCode = 'unauthorized' | 'unsupported-host' | 'invalid-target'
  | 'self-target' | 'foreign-workspace' | 'target-live' | 'writer-unknown'
  | 'context-unavailable' | 'invalid-token' | 'expired-token' | 'caller-changed'
  | 'target-changed' | 'custody-unavailable';
export type AssumeRefusal = { ok: false; code: AssumeRefusalCode };
const refuse = (code: AssumeRefusalCode): AssumeRefusal => ({ ok: false, code });

export interface AssumePreparationDeps {
  now(): number;
  /** Existing operator signing secret, loaded by the trusted tool adapter. */
  secret: Uint8Array;
  /** The existing administrative launch envelope, also checked at commit.
   * Return a durable authorization reference, or null. No caller-supplied grant. */
  authorize(actor: AssumeActor, targetRole?: string): Promise<string | null>;
  caller(actor: AssumeActor): Promise<AssumeCaller | null>;
  /** Read/validate context provenance without disclosing its contents. */
  target(request: AssumeRequest): Promise<AssumeTarget | null>;
}

function tokenKey(secret: Uint8Array): Buffer {
  if (secret.byteLength !== 32) throw new Error('session:assume requires a valid 32-byte operator secret');
  // Domain separation: never use the operator signing key directly as an AES key.
  return createHash('sha256').update(TOKEN_AAD).update(secret).digest();
}

function seal(plan: AssumePreparation, secret: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(secret), nonce);
  cipher.setAAD(TOKEN_AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(plan), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
}

function open(token: string, secret: Uint8Array): AssumePreparation | null {
  if (!/^[A-Za-z0-9_-]{40,24000}$/.test(token)) return null;
  try {
    const bytes = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(secret), bytes.subarray(0, 12));
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    return preparationSchema.parse(JSON.parse(data.toString('utf8')));
  } catch { return null; }
}

function targetRefusal(actor: AssumeActor, request: AssumeRequest, target: AssumeTarget): AssumeRefusal | null {
  if (target.ownerId === actor.ownerId) return refuse('self-target');
  if (target.workspaceId !== actor.workspaceId) return refuse('foreign-workspace');
  if (target.ownerId !== request.targetOwnerId || target.binding.coordOwnerId !== target.ownerId ||
      (target.backend === 'omp' ? target.binding.ompThreadId !== target.nativeSessionId
        : target.binding.sessionId !== target.nativeSessionId)) return refuse('invalid-target');
  if (!target.ended || target.liveHost || target.writer === 'held') return refuse('target-live');
  if (target.writer !== 'free') return refuse('writer-unknown');
  if (target.context.mode !== request.contextMode ||
      (request.contextMode === 'native-resume' && (target.context.ref !== target.nativeSessionId ||
        target.executionNativeSessionId !== target.nativeSessionId)) ||
      (request.contextMode === 'checkpoint' && (target.backend === 'omp' ||
        (target.backend === 'codex' ? target.executionNativeSessionId !== null
          : !target.executionNativeSessionId || target.executionNativeSessionId === target.nativeSessionId)))) {
    return refuse('context-unavailable');
  }
  return null;
}

/** No writes, custody acquisition, wake/inbox consumption or process creation. */
export async function prepareAssume(
  actor: AssumeActor, request: AssumeRequest, deps: AssumePreparationDeps,
): Promise<AssumeRefusal | { ok: true; state: 'prepared'; token: string; preparation: AssumePreparation }> {
  if (!await deps.authorize(actor)) return refuse('unauthorized');
  const callerValue = await deps.caller(actor);
  if (!callerValue) return refuse('unsupported-host');
  const caller = callerSchema.safeParse(callerValue);
  if (!caller.success || caller.data.ownerId !== actor.ownerId || caller.data.workspaceId !== actor.workspaceId) {
    return refuse('caller-changed');
  }
  const targetValue = await deps.target(request);
  if (!targetValue) return refuse('context-unavailable');
  const target = targetSchema.safeParse(targetValue);
  if (!target.success) return refuse('invalid-target');
  const authorizationRef = await deps.authorize(actor, target.data.role);
  if (!authorizationRef) return refuse('unauthorized');
  const rejection = targetRefusal(actor, request, target.data);
  if (rejection) return rejection;
  const now = deps.now();
  const preparation = preparationSchema.parse({
    version: 1, requestId: request.requestId, authorizationRef,
    preparedAt: now, expiresAt: now + ASSUME_TOKEN_TTL_MS, caller: caller.data, target: target.data,
  });
  return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };
}

/** Re-resolve all pins and administrative authority before any caller mutation.
 * The adapter must additionally acquire the keyed SQL reservation and native
 * writer guard at the effect boundary; this validation is not custody proof. */
export async function validateAssume(
  actor: AssumeActor, token: string, deps: AssumePreparationDeps,
): Promise<AssumeRefusal | { ok: true; preparation: AssumePreparation }> {
  if (!await deps.authorize(actor)) return refuse('unauthorized');
  const plan = open(token, deps.secret);
  if (!plan) return refuse('invalid-token');
  if (plan.caller.ownerId !== actor.ownerId || plan.caller.workspaceId !== actor.workspaceId) {
    return refuse('caller-changed');
  }
  const now = deps.now();
  if (now < plan.preparedAt || now >= plan.expiresAt ||
      plan.expiresAt - plan.preparedAt !== ASSUME_TOKEN_TTL_MS) return refuse('expired-token');
  if (await deps.authorize(actor, plan.target.role) !== plan.authorizationRef) return refuse('unauthorized');
  const caller = await deps.caller(actor);
  if (JSON.stringify(callerSchema.safeParse(caller).data) !== JSON.stringify(plan.caller)) {
    return refuse('caller-changed');
  }
  const request: AssumeRequest = { requestId: plan.requestId,
    targetOwnerId: plan.target.ownerId, contextMode: plan.target.context.mode };
  const target = targetSchema.safeParse(await deps.target(request));
  if (!target.success) return refuse('target-changed');
  const rejection = targetRefusal(actor, request, target.data);
  if (rejection) return rejection;
  if (JSON.stringify(target.data) !== JSON.stringify(plan.target)) return refuse('target-changed');
  return { ok: true, preparation: plan };
}

/** The existing resume lease is the durable single-owner reservation. Pass the
 * full-precision registration binding into the same SELECT FOR UPDATE that
 * decides lease ownership, closing the resolve/claim incarnation race. */
export function assumeResumePin(plan: AssumePreparation): AdvSessionResumePin {
  return { workspaceId: plan.target.workspaceId, binding: plan.target.binding, requireTerminal: true };
}

export async function reserveAssumeTarget(
  plan: AssumePreparation,
  acquire?: (id: number, key: string, pin: AdvSessionResumePin) => Promise<AdvSessionResumeReservation>,
): Promise<AdvSessionResumeReservation> {
  const key = assumeTransitionKey(plan);
  const reserve = acquire ?? (async (id, claimKey, pin) => {
    const { acquireAdvSessionResume } = await import('./adv-sessions');
    return acquireAdvSessionResume(id, claimKey, 120, undefined, undefined, false, pin);
  });
  return reserve(plan.target.advSessionId, key, assumeResumePin(plan));
}

/** Stable across repeated previews for one request, scoped to the caller.
 * Persist the full preparation fingerprint with the existing launch receipt so
 * reusing a request id with changed context cannot adopt an old outcome. */
export function assumeTransitionKey(plan: AssumePreparation): string {
  const digest = createHash('sha256').update(JSON.stringify([
    plan.caller.workspaceId, plan.caller.ownerId, plan.caller.incarnation,
    plan.requestId,
  ])).digest('hex');
  return `session-assume:${digest}`;
}

export function assumePreparationFingerprint(plan: AssumePreparation): string {
  // PostgreSQL jsonb changes object-key order. Normalize through the typed
  // schema so reloading the same durable preparation keeps its fingerprint.
  const canonical = preparationSchema.parse(plan);
  return createHash('sha256').update(JSON.stringify({
    version: canonical.version, requestId: canonical.requestId, authorizationRef: canonical.authorizationRef,
    caller: canonical.caller, target: canonical.target,
  })).digest('hex');
}

export interface AssumeCallerRecovery {
  /** Durable target-free checkpoint and exact native return reference. */
  checkpointRef: string;
  checkpointSha256: string;
  returnRef: { ownerId: string; workspaceId: string; nativeSessionId: string; incarnation: string };
}

export interface AssumeCallerDisposition {
  releasedWorkClaims: Array<{ id: string; checkpointRef: string }>;
  releasedPlanClaims: Array<{ plan: string; item: string; checkpointRef: string }>;
  pausedLoopRef: string | null;
  pausedAwaitIds: number[];
  inbox: 'retained';
  directives: 'retained';
}

export type AssumeTransitionState = 'prepared' | 'caller-checkpointed' | 'caller-quiesced'
  | 'target-custody-acquired' | 'handoff-requested' | 'handoff-accepted' | 'target-verified'
  | 'refused' | 'rolled-back' | 'indeterminate';

export interface AssumeTransitionReceipt {
  transitionKey: string;
  preparationFingerprint: string;
  preparation: AssumePreparation;
  state: AssumeTransitionState;
  updatedAt: number;
  recovery?: AssumeCallerRecovery;
  disposition?: AssumeCallerDisposition;
  reason?: string;
  /** False is explicit: a transport result cannot assert that a failed write landed. */
  durable: boolean;
  observation?: AssumeExecutionObservation;
  /** Write-ahead native launch attempt, distinct from immutable preparation.
   * A successor requires the recorded process to have exited, never a timer. */
  startup?: { attemptId: string; generation: number; authorizedAt: number;
    launcherPid: number; launcherProcessStart: string;
    ptyPid?: number; ptyProcessStart?: string };
  callerReturn?: { transitionKey: string; caller: AssumeCaller; nativeProcessStart: string; restoredAt: number };
}

/** Narrow adapters over existing launch receipts, carry checkpoints, keyed
 * resume custody and managed host handoff. This protocol itself starts no CLI
 * and never copies either conversation or environment into the other identity. */
export interface AssumeTransitionDeps {
  now(): number;
  /** Use claimAgentLaunch(failClosed:true, initialSummary:receipt). A prior
   * receipt is an ownership fence, including after a process crash. */
  claim(receipt: AssumeTransitionReceipt): Promise<{
    won: boolean; prior: AssumeTransitionReceipt | null;
  }>;
  /** Store in the existing launch ledger and append existing audit provenance.
   * Throw unless the durable write was acknowledged. */
  save(receipt: AssumeTransitionReceipt): Promise<void>;
  reserve(plan: AssumePreparation): Promise<AdvSessionResumeReservation>;
  checkpointCaller(plan: AssumePreparation): Promise<AssumeCallerRecovery>;
  quiesceCaller(plan: AssumePreparation, recovery: AssumeCallerRecovery): Promise<AssumeCallerDisposition>;
  /** Recheck reserved incarnation AND native writer immediately before handoff. */
  checkCustody(plan: AssumePreparation): Promise<boolean>;
  /** Restore only the original caller's exact valid custody. Must also handle
   * a partially completed quiesce using its durable checkpoint. */
  restoreCaller(plan: AssumePreparation, recovery: AssumeCallerRecovery): Promise<boolean>;
  releaseTarget(plan: AssumePreparation): Promise<boolean>;
  /** Acceptance only. Defer replacement until the tool response is delivered. */
  handoff(plan: AssumePreparation, recovery: AssumeCallerRecovery): Promise<'accepted' | 'refused'>;
}

/** Execute only a preparation returned by validateAssume at the tool boundary.
 * A lease contender loses BEFORE touching the caller. A lost host acknowledgement
 * is indeterminate, never permission to release custody or launch twice. */
export async function commitAssume(
  plan: AssumePreparation, deps: AssumeTransitionDeps,
): Promise<AssumeTransitionReceipt & { replayed?: boolean }> {
  let receipt: AssumeTransitionReceipt = {
    transitionKey: assumeTransitionKey(plan), preparationFingerprint: assumePreparationFingerprint(plan),
    preparation: structuredClone(plan), state: 'prepared', updatedAt: deps.now(), durable: true,
  };
  const claim = await deps.claim(structuredClone(receipt));
  if (!claim.won) {
    if (!claim.prior || claim.prior.preparationFingerprint !== receipt.preparationFingerprint) {
      return { ...receipt, state: 'refused', reason: 'request-conflict', replayed: true, durable: !!claim.prior };
    }
    // Reconciliation is a separate runtime observation. Replaying an uncertain
    // handoff must never repeat checkpoint/release, handoff or native execution.
    return { ...claim.prior, replayed: true };
  }
  let reserved = false;
  let reservationUncertain = false;
  let quiesceStarted = false;
  let handoffAttempted = false;
  const record = async (state: AssumeTransitionState) => {
    receipt = { ...receipt, state, updatedAt: deps.now(), durable: true };
    await deps.save(structuredClone(receipt));
  };
  try {
    reservationUncertain = true;
    const reservation = await deps.reserve(plan);
    reservationUncertain = false;
    if (!reservation.acquired) {
      receipt.reason = `custody-${reservation.status}`;
      await record('refused');
      return receipt;
    }
    reserved = true;
    receipt.recovery = await deps.checkpointCaller(plan);
    const recovery = receipt.recovery;
    if (!recovery.checkpointRef || !/^[a-f0-9]{64}$/.test(recovery.checkpointSha256) ||
        recovery.returnRef.ownerId !== plan.caller.ownerId ||
        recovery.returnRef.workspaceId !== plan.caller.workspaceId ||
        recovery.returnRef.nativeSessionId !== plan.caller.nativeSessionId ||
        recovery.returnRef.incarnation !== plan.caller.incarnation) {
      throw new Error('caller-recovery-invalid');
    }
    await record('caller-checkpointed');
    quiesceStarted = true;
    receipt.disposition = await deps.quiesceCaller(plan, recovery);
    await record('caller-quiesced');
    if (!await deps.checkCustody(plan)) throw new Error('custody-changed');
    await record('target-custody-acquired');
    // Persist the uncertainty barrier BEFORE sending. Even if the host accepts
    // and the process dies before storing its ack, retry finds this fence.
    await record('handoff-requested');
    handoffAttempted = true;
    if (await deps.handoff(plan, recovery) === 'refused') {
      handoffAttempted = false; // a definite negative ack permits rollback
      throw new Error('host-refused');
    }
    await record('handoff-accepted');
    return receipt;
  } catch (error) {
    // Keep adapter errors private: command lines, credentials and context text
    // must not leak through an arbitrary exception message in the receipt.
    receipt.reason = error instanceof Error && error.message === 'host-refused' ? 'host-refused' : 'transition-failed';
    let restored = !quiesceStarted;
    let released = !reserved;
    if (!handoffAttempted) {
      if (quiesceStarted && receipt.recovery) {
        restored = await deps.restoreCaller(plan, receipt.recovery).catch(() => false);
      }
      if (reserved) released = await deps.releaseTarget(plan).catch(() => false);
    }
    receipt = { ...receipt, state: !reservationUncertain && !handoffAttempted && restored && released ? 'rolled-back' : 'indeterminate',
      updatedAt: deps.now(), durable: true };
    try { await deps.save(structuredClone(receipt)); }
    catch { receipt.durable = false; }
    return receipt;
  }
}

/** Measurements supplied by the managed host/router adapter, never by public
 * tool arguments. A process witness AND independently routed message/work
 * witnesses are required; environment variables or an accepted flag do not
 * satisfy this contract. */
export interface AssumeExecutionObservation {
  transitionKey: string;
  observedAt: number;
  hostId: string;
  attachmentId: string;
  callerNativePid: number;
  callerExited: boolean;
  targetOwnerId: string;
  targetNativeSessionId: string;
  /** Observed authoritative reanchor for a backend-minted checkpoint id. */
  nativeBinding?: { advSessionId: number; ownerId: string; sourceNativeSessionId: string;
    nativeSessionId: string; transitionKey: string };
  backend: AssumeTarget['backend'];
  contextSha256: string;
  nativePid: number;
  nativeProcessStart: string;
  /** Managed PTY root when a launcher shim parents the native writer. Runtime
   * observers must prove the writer belongs to this exact PTY before settling. */
  ptyPid?: number;
  ptyProcessStart?: string;
  nativeWriterPids: number[];
  directedMessage: { id: string; recipient: string; consumedBy: string; consumptions: number };
  assignment: { id: string; assignee: string; observedBy: string };
}

export function qualifiesAssumeExecution(
  receipt: AssumeTransitionReceipt, observation: AssumeExecutionObservation,
): boolean {
  const { caller, target } = receipt.preparation;
  const ptyPid = observation.ptyPid ?? observation.nativePid;
  const ptyStart = observation.ptyProcessStart ??
    (observation.ptyPid === undefined ? observation.nativeProcessStart : undefined);
  return ['handoff-requested', 'handoff-accepted', 'indeterminate'].includes(receipt.state) &&
    observation.transitionKey === receipt.transitionKey &&
    Number.isFinite(observation.observedAt) && observation.observedAt >= receipt.updatedAt &&
    observation.hostId === caller.hostId && observation.attachmentId === caller.attachmentId &&
    observation.callerNativePid === caller.nativePid && observation.callerExited === true &&
    observation.targetOwnerId === target.ownerId &&
    (target.executionNativeSessionId !== null
      ? observation.targetNativeSessionId === target.executionNativeSessionId
      : target.context.mode === 'checkpoint' && target.backend === 'codex' &&
        !!observation.targetNativeSessionId && observation.targetNativeSessionId !== target.nativeSessionId &&
        observation.nativeBinding?.advSessionId === target.advSessionId &&
        observation.nativeBinding.ownerId === target.ownerId &&
        observation.nativeBinding.sourceNativeSessionId === target.nativeSessionId &&
        observation.nativeBinding.nativeSessionId === observation.targetNativeSessionId &&
        observation.nativeBinding.transitionKey === receipt.transitionKey) && observation.backend === target.backend &&
    observation.contextSha256 === target.context.sha256 &&
    Number.isSafeInteger(observation.nativePid) && observation.nativePid > 0 &&
    observation.nativePid !== caller.nativePid && !!observation.nativeProcessStart &&
    Number.isSafeInteger(ptyPid) && ptyPid > 0 && ptyPid !== caller.nativePid && !!ptyStart &&
    observation.nativeWriterPids.length === 1 && observation.nativeWriterPids[0] === observation.nativePid &&
    !!observation.directedMessage.id && observation.directedMessage.recipient === target.ownerId &&
    observation.directedMessage.consumedBy === target.ownerId && observation.directedMessage.consumptions === 1 &&
    !!observation.assignment.id && observation.assignment.assignee === target.ownerId &&
    observation.assignment.observedBy === target.ownerId;
}

/** Settling an accepted/uncertain receipt never launches a process. An invalid
 * or incomplete witness leaves the prior receipt untouched and unverified. */
export async function verifyAssumeExecution(
  receipt: AssumeTransitionReceipt, observation: AssumeExecutionObservation,
  save: AssumeTransitionDeps['save'],
): Promise<AssumeTransitionReceipt> {
  if (!qualifiesAssumeExecution(receipt, observation)) return receipt;
  const verified: AssumeTransitionReceipt = { ...receipt, state: 'target-verified',
    observation: structuredClone(observation), updatedAt: observation.observedAt, durable: true };
  try { await save(verified); return verified; }
  catch { return { ...receipt, state: 'indeterminate', durable: false, reason: 'verification-write-failed' }; }
}

export type AssumeReconciliationObservation =
  | { kind: 'execution'; observation: AssumeExecutionObservation }
  | { kind: 'unknown' }
  | {
    kind: 'cancelled'; transitionKey: string; preparationFingerprint: string;
    /** The runtime adapter must fence the exact queued handoff generation, not
     * infer cancellation from a timeout or a missing discovery record. */
    queuedHandoffCancelled: true;
    nativeWriter: 'free';
  };

/** Reconcile a crash without repeating execution. Only a measured execution
 * can verify; only exact queue cancellation plus no writer can roll back. An
 * expired lease or absent host on its own is insufficient in either direction. */
export async function reconcileAssumeTransition(
  receipt: AssumeTransitionReceipt, observation: AssumeReconciliationObservation,
  deps: Pick<AssumeTransitionDeps, 'now' | 'save' | 'restoreCaller' | 'releaseTarget'>,
): Promise<AssumeTransitionReceipt> {
  if (['target-verified', 'rolled-back', 'refused'].includes(receipt.state)) return receipt;
  if (observation.kind === 'execution') return verifyAssumeExecution(receipt, observation.observation, deps.save);
  const cancelled = observation.kind === 'cancelled' && observation.queuedHandoffCancelled === true &&
    observation.nativeWriter === 'free' && observation.transitionKey === receipt.transitionKey &&
    observation.preparationFingerprint === receipt.preparationFingerprint;
  if (!cancelled) return receipt;
  const restored = !receipt.recovery || await deps.restoreCaller(receipt.preparation, receipt.recovery).catch(() => false);
  const released = await deps.releaseTarget(receipt.preparation).catch(() => false);
  const settled: AssumeTransitionReceipt = { ...receipt, updatedAt: deps.now(), durable: true,
    state: restored && released ? 'rolled-back' : 'indeterminate',
    reason: restored && released ? 'cancelled-with-no-native-writer' : 'recovery-incomplete' };
  try { await deps.save(settled); return settled; }
  catch { return { ...settled, state: 'indeterminate', durable: false }; }
}

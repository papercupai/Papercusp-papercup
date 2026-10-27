import { createHash, randomUUID } from 'node:crypto';

/** Managed identity changes reuse the parent-bound host handoff. Orders contain
 * only custody references: the successor rebuilds the target using launchResume,
 * never the caller's command, configuration, credentials or conversation. */
export function identityAssumeBaseEnv(source) {
  const result = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'TERM', 'COLORTERM',
    'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_OPERATOR_URL_PROVENANCE',
    'PAPERCUSP_PSU_REEXEC', 'PAPERCUSP_PSU_REEXEC_PPID']) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  return result;
}

/** Ordinary host adoption continues the same registration. Identity takeover
 * leaves it: use the existing durable end witness before the shim can reexec.
 * A failed acknowledgement retains recovery and must never start the target. */
export async function completeIdentityAssumeDeparture(orders, { advSessionId, reportEnd, exit }) {
  if (orders.mode === 'identity-assume') {
    if (!advSessionId) throw new Error('assume-caller-registration-unavailable');
    const outcome = await reportEnd(advSessionId, 0, { killedBySignal: 'SIGKILL' });
    if (outcome?.reported !== true) throw new Error('assume-caller-end-unacknowledged');
  }
  return exit(orders.code);
}

function matchesInspection(request, result, accepted = false) {
  const plan = result?.preparation;
  const recovery = result?.recovery;
  return result?.ok === true && ['native-resume', 'checkpoint'].includes(plan?.target?.context?.mode) &&
    (!accepted || result.state === 'handoff-accepted') &&
    result.transitionKey === request.transitionKey && result.preparationHash === request.preparationHash &&
    plan.expiresAt === request.expiresAt &&
    ['ownerId', 'workspaceId', 'nativeSessionId', 'nativePid', 'hostId', 'attachmentId']
      .every(key => plan.caller?.[key] === request.caller?.[key]) &&
    recovery?.checkpointRef === request.recoveryRef && recovery?.checkpointSha256 === request.recoveryHash;
}

/** Reuse managed carry argv and its native bootstrap, with target-only input.
 * The supplied mint is the existing mintCarryRespawnArgs implementation. */
export function prepareIdentityAssumeCheckpoint(session, checkpoint, args, { mint, codexHome, personaFile, home }) {
  const { context, body, executionNativeSessionId } = checkpoint ?? {};
  if (!['claude', 'codex'].includes(session.agent) || context?.mode !== 'checkpoint' ||
      typeof body !== 'string' || !body.trim() ||
      createHash('sha256').update(body).digest('hex') !== context.sha256 ||
      (session.agent === 'codex' ? executionNativeSessionId !== null
        : !executionNativeSessionId || executionNativeSessionId === session.sessionId))
    throw new Error('assume-checkpoint-changed');
  const carry = mint(args, { agent: session.agent, ownerId: session.coordOwnerId,
    codexHome, personaFile, home,
    ...(executionNativeSessionId ? { mintId: () => executionNativeSessionId } : {}),
    systemPromptAddendum: body });
  if (!carry || !Array.isArray(carry.args) || !carry.launchContextPath ||
      (session.agent === 'codex' ? carry.nativeId !== null : carry.nativeId !== executionNativeSessionId))
    throw new Error('assume-checkpoint-bootstrap-unavailable');
  return carry;
}

/** @param {{ownerId:string, inspect:(request:any,afterExit:boolean,action?:string)=>Promise<any>, writeHandoff:(ownerId:string,record:any)=>string|null, reexecCode:number|null, attachmentId?:string|null, hostId?:string|null, headless?:boolean}} options */
export function makeIdentityAssumeHostPort({ ownerId, inspect, writeHandoff, reexecCode, attachmentId = null, hostId = null, headless = false }) {
  if (!Number.isInteger(reexecCode) || reexecCode < 1) return null;
  const read = async (request, accepted = false, action = 'observe') => {
    if (request?.caller?.ownerId !== ownerId) return null;
    const result = await inspect(request, false, action);
    return matchesInspection(request, result, accepted) ? result : null;
  };
  return {
    ...(attachmentId ? { attachmentId } : {}),
    ...(hostId ? { hostId } : {}),
    async verify(request, action = 'observe') { try { return !!await read(request, false, action); } catch { return false; } },
    async prepare(request) {
      if (!await read(request, true)) return null;
      const handoffPath = writeHandoff(ownerId, { mode: 'identity-assume',
        args: ['identity-assume'], headless, assume: { version: 1, request: structuredClone(request) } });
      return handoffPath ? { code: reexecCode, handoffPath } : null;
    },
  };
}

/** Call only after readHostHandoffForParentPid consumed/validated the orders.
 * Each awaited step is followed by fresh custody and caller-exit validation.
 * `resume` is the existing guarded target launcher, not a second spawn door. */
export async function launchIdentityAssumeHandoff(handoff, { inspect, resolveSession, accountFor, resume,
  isAlive, baseEnv, now = Date.now }) {
  const request = handoff?.assume?.request;
  if (handoff?.mode !== 'identity-assume' || handoff.assume?.version !== 1 ||
      !request || handoff.ownerId !== request.caller?.ownerId ||
      ['childEnv', 'command', 'codexHome', 'firstTurnText'].some(key => Object.hasOwn(handoff, key)))
    throw new Error('assume-invalid-orders');
  const check = async () => {
    if (isAlive(handoff.fromPid) !== false || isAlive(request.caller.nativePid) !== false ||
        !Number.isFinite(request.expiresAt) || request.expiresAt <= now()) throw new Error('assume-caller-not-exited');
    const result = await inspect(request, true);
    if (!matchesInspection(request, result, true)) throw new Error('assume-custody-unverified');
    // An asynchronous operator read cannot bless PID reuse or lease expiry.
    if (isAlive(handoff.fromPid) !== false || isAlive(request.caller.nativePid) !== false || request.expiresAt <= now())
      throw new Error('assume-caller-not-exited');
    return result;
  };
  const result = await check();
  const target = result.preparation.target;
  const session = await resolveSession(target.advSessionId);
  if (!session || session.id !== target.advSessionId || session.coordOwnerId !== target.ownerId ||
      session.workspaceId !== target.workspaceId || session.agent !== target.backend ||
      (session.role ?? 'su') !== target.role ||
      (target.backend === 'omp' ? session.ompThreadId : session.sessionId) !== target.nativeSessionId)
    throw new Error('assume-target-changed');
  const accountEnv = await accountFor(session);
  await check();
  const attemptId = randomUUID();
  const startup = async (action, details) => {
    const result = await inspect(request, true, action, { attemptId, ...details });
    if (result?.ok !== true || result.attemptId !== attemptId) throw new Error('assume-startup-unacknowledged');
  };
  return resume(session, { accountEnv, headless: handoff.headless === true,
    kickoff: `Managed identity transition ${request.transitionKey}. Verify coord:whoami, then resume your own inbox and assigned work. ` +
      `Caller recovery reference: ${request.recoveryRef}; exact return identity: ${result.recovery.returnRef.ownerId}.`,
    managedAssume: { inheritedEnv: identityAssumeBaseEnv(baseEnv), attachmentId: request.caller.attachmentId,
      hostId: request.caller.hostId,
      beginStartup: () => startup('begin-startup', { launcherPid: process.pid }),
      started: ({ ptyPid }) => startup('startup-started', { ptyPid }),
      reservation: { advSessionId: target.advSessionId, ownerId: target.ownerId,
        claimKey: request.transitionKey, expiresAtMs: request.expiresAt },
      ...(target.returnFrom ? { restoreReturn: async () => {
        const restored = await inspect(request, true, 'complete-return');
        if (restored?.ok !== true) throw new Error('assume-return-unacknowledged');
      } } : {}),
      ...(target.context.mode === 'checkpoint' ? { checkpoint: { context: target.context,
        body: result.checkpointBody, executionNativeSessionId: target.executionNativeSessionId } } : {}),
      verify: check } });
}

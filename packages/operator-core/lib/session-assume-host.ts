/** Server side of the existing managed PTY control socket. A confirmed socket
 * response accepts a handoff; native result/completion and exit still gate
 * replacement in the host and launcher. No command or environment rides here. */
import { findLiveHostAsync, injectIntoHostWithConfirmation } from './events/await/psu-pty-discovery';
import type { AssumeCallerHostFence } from './session-assume-caller';
import { assumePreparationFingerprint, assumePreparationSchema, assumeTransitionKey,
  type AssumePreparation, type AssumeCallerRecovery, type AssumeTransitionDeps } from './session-assume';

const defaultPorts = { findHost: findLiveHostAsync, send: injectIntoHostWithConfirmation };

export function createManagedAssumeHost(planValue: AssumePreparation, ports = defaultPorts):
  AssumeCallerHostFence & Pick<AssumeTransitionDeps, 'handoff'> {
  const plan = assumePreparationSchema.parse(planValue);
  const fingerprint = assumePreparationFingerprint(plan);
  let generation: number | null = null;
  let recoveryPin: string | null = null;
  const send = async (value: AssumePreparation, recovery: AssumeCallerRecovery, action: 'freeze' | 'queue' | 'thaw') => {
    if (assumePreparationFingerprint(value) !== fingerprint ||
        recovery.returnRef.ownerId !== plan.caller.ownerId ||
        recovery.returnRef.workspaceId !== plan.caller.workspaceId ||
        recovery.returnRef.nativeSessionId !== plan.caller.nativeSessionId ||
        recovery.returnRef.incarnation !== plan.caller.incarnation ||
        !recovery.checkpointRef || !/^[a-f0-9]{64}$/.test(recovery.checkpointSha256))
      throw new Error('assume-host-preparation-changed');
    const pin = JSON.stringify([recovery.checkpointRef, recovery.checkpointSha256]);
    if (recoveryPin !== null && recoveryPin !== pin) throw new Error('assume-host-recovery-changed');
    const host = await ports.findHost(plan.caller.ownerId);
    const capability = host as (typeof host & { identityAssume?: { version: number; hostId: string; attachmentId: string } });
    if (!host || host.ownerId !== plan.caller.ownerId || host.ptyPid !== plan.caller.nativePid ||
        host.nativeSessionId !== plan.caller.nativeSessionId || capability?.identityAssume?.version !== 1 ||
        capability.identityAssume.hostId !== plan.caller.hostId ||
        capability.identityAssume.attachmentId !== plan.caller.attachmentId ||
        !Number.isSafeInteger(host.childGeneration) || host.childGeneration! < 1 ||
        generation !== null && generation !== host.childGeneration)
      throw new Error('assume-host-caller-changed');
    generation = host.childGeneration!; recoveryPin = pin;
    return ports.send(host.sock, { mode: 'identity-assume', data: '', ownerId: plan.caller.ownerId, action,
      request: { transitionKey: assumeTransitionKey(plan), preparationHash: fingerprint,
        recoveryRef: recovery.checkpointRef, recoveryHash: recovery.checkpointSha256, expiresAt: plan.expiresAt,
        caller: { ownerId: plan.caller.ownerId, workspaceId: plan.caller.workspaceId,
          nativeSessionId: plan.caller.nativeSessionId, nativePid: plan.caller.nativePid,
          hostId: plan.caller.hostId, attachmentId: plan.caller.attachmentId, childGeneration: generation } } }, 10_000);
  };
  return {
    async freeze(value, recovery) {
      try { const result = await send(value, recovery, 'freeze'); return result.ok && result.confirmation === 'acked'; }
      catch { return false; }
    },
    async thaw(value, recovery) {
      try { const result = await send(value, recovery, 'thaw'); return result.ok && result.confirmation === 'acked'; }
      catch { return false; }
    },
    async handoff(value, recovery) {
      const result = await send(value, recovery, 'queue');
      if (result.confirmation !== 'acked') throw new Error('assume-host-ack-unknown');
      return result.ok ? 'accepted' : 'refused';
    },
  };
}

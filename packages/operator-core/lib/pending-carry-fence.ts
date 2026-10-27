/** Exact pending-carry cancellation over the existing host socket + brief slot.
 * This is control custody only. It establishes no source/budget/acceptance verdict
 * and does not authorize repair, shutdown, reset or an original-host operation. */
import {
  findLiveHostAsync, injectIntoHostWithConfirmation, qualifyCarryFenceAck,
  type InjectHostResult, type PsuPtyHost,
} from './events/await/psu-pty-discovery';
import { fencePendingCarryRespawnSlot, readPendingCarryFenceTarget } from './session-brief';

export interface PendingCarryFenceRequest extends Record<string, unknown> {
  ownerId: string;
  workspaceId: string;
  nonce: string;
  fenceId: string;
  expectedAdvSessionId: string;
  expectedNativeSessionId: string;
  expectedHostStartedAt: number;
  expectedChildGeneration: number;
  expectedHostCodeVersion: string;
  expiresAtMs: number;
}

type FenceHost = Pick<PsuPtyHost, 'sock' | 'ownerId' | 'advSessionId' | 'nativeSessionId' |
  'startedAt' | 'childGeneration' | 'hostCodeVersion' | 'caps'>;
export interface PendingCarryFencePorts {
  now(): number;
  read(ownerId: string, workspaceId: string): Promise<{ nonce: string; fenceId: string | null } | null>;
  find(ownerId: string, workspaceId: string): Promise<FenceHost | null>;
  send(sock: string, request: PendingCarryFenceRequest): Promise<InjectHostResult>;
  persist(ownerId: string, workspaceId: string, nonce: string, fenceId: string): Promise<boolean>;
}
const productionPorts: PendingCarryFencePorts = {
  now: Date.now,
  read: readPendingCarryFenceTarget,
  find: (ownerId, workspaceId) => findLiveHostAsync(ownerId, undefined, { workspaceId }),
  send: (sock, request) => injectIntoHostWithConfirmation(sock, {
    mode: 'carry-fence', data: '', ownerId: request.ownerId, request,
  }, 5000),
  persist: fencePendingCarryRespawnSlot,
};

/** Refuses before send on stale metadata/pins. Lost ACK => no database mutation.
 * A CAS loss/database failure after ACK leaves the host tombstone in place and
 * reports partial custody; never thaw or replay automatically. Retries must use
 * the same fenceId and identity, with a fresh short expiry. */
export async function fencePendingCarry(
  request: PendingCarryFenceRequest, ports: PendingCarryFencePorts = productionPorts,
): Promise<{ ok: boolean; reason: string; hostFenced: boolean | null; slotFenced: boolean;
  receipt?: Record<string, unknown> }> {
  const refuse = (reason: string) => ({ ok: false, reason, hostFenced: false, slotFenced: false });
  const strings = ['ownerId', 'workspaceId', 'nonce', 'fenceId', 'expectedAdvSessionId',
    'expectedNativeSessionId', 'expectedHostCodeVersion'] as const;
  if (!strings.every(key => typeof request[key] === 'string' && request[key].trim() === request[key] &&
      request[key].length > 0 && request[key].length <= 200) ||
    !Number.isSafeInteger(request.expectedHostStartedAt) || request.expectedHostStartedAt <= 0 ||
    !Number.isSafeInteger(request.expectedChildGeneration) || request.expectedChildGeneration <= 0 ||
    !Number.isSafeInteger(request.expiresAtMs) || request.expiresAtMs <= ports.now() ||
    request.expiresAtMs > ports.now() + 30_000) return refuse('carry-fence-invalid');
  let result: InjectHostResult;
  let sent = false;
  try {
    const target = await ports.read(request.ownerId, request.workspaceId);
    if (!target || target.nonce !== request.nonce) return refuse('carry-fence-slot-mismatch');
    if (target.fenceId && target.fenceId !== request.fenceId) return refuse('carry-fence-conflict');
    const host = await ports.find(request.ownerId, request.workspaceId);
    if (!host || !host.caps?.includes('pending-carry-fence-v1') || host.ownerId !== request.ownerId ||
      String(host.advSessionId) !== request.expectedAdvSessionId || host.nativeSessionId !== request.expectedNativeSessionId ||
      host.startedAt !== request.expectedHostStartedAt || host.childGeneration !== request.expectedChildGeneration ||
      host.hostCodeVersion !== request.expectedHostCodeVersion) return refuse('stale-carry-fence-target');
    sent = true;
    result = await ports.send(host.sock, request);
  } catch {
    return { ...refuse('carry-fence-preparation-or-transport-failed'), hostFenced: sent ? null : false };
  }
  if (!result.ok || result.confirmation !== 'acked' || !result.carryFence ||
    !qualifyCarryFenceAck(request, result.carryFence)) return {
      ...refuse(result.reason ?? 'carry-fence-unconfirmed'),
      // A lost/unqualified receipt does not prove absence of a host effect.
      hostFenced: !result.ok && result.confirmation === 'acked' ? false : null,
    };
  const receipt = result.carryFence;
  try {
    const slotFenced = await ports.persist(request.ownerId, request.workspaceId, request.nonce, request.fenceId);
    return { ok: slotFenced, reason: slotFenced ? 'carry-fenced' : 'carry-fence-slot-changed',
      hostFenced: true, slotFenced, receipt };
  } catch {
    return { ok: false, reason: 'carry-fence-slot-persist-failed', hostFenced: true, slotFenced: false, receipt };
  }
}

/** EI-267764: exact-request cancellation, distinct from inbox delivery ACKs.
 * Tombstones last for this host's lifetime. Bound carry messages cannot cross a
 * host/child replacement, so a delayed socket write cannot revive a tombstone
 * after restart. Legacy unbound pending carries make fencing unavailable. */
const fields = ['ownerId', 'workspaceId', 'advSessionId', 'nativeSessionId',
  'hostStartedAt', 'childGeneration', 'hostCodeVersion'];
const expected = ['ownerId', 'workspaceId', 'expectedAdvSessionId', 'expectedNativeSessionId',
  'expectedHostStartedAt', 'expectedChildGeneration', 'expectedHostCodeVersion'];

export function carryFenceIdentityMatches(request, current) {
  return !!request && !!current && fields.every((key, i) => {
    const value = current[key];
    return (typeof value === 'string' ? value.length > 0 : Number.isSafeInteger(value) && value > 0) &&
      request[expected[i]] === value;
  });
}

/** Pure state machine; the host owns the synchronous effect boundary. */
export function createPendingCarryFence({ identity, canFence = () => true, now = Date.now }) {
  const pending = new WeakSet();
  let pendingLegacyCount = 0;
  const fenced = new Map();
  const committed = new Set();
  const begun = new WeakMap();
  const isWeakKey = value => value !== null &&
    (typeof value === 'object' || typeof value === 'function');
  const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;
  const refusal = reason => ({ ok: false, reason });
  const deliveryRefusal = message => {
    if (message?.mode !== 'carry-respawn') return null;
    // Once a fence is acknowledged, an old unbound sender could be the very
    // request fenced before its socket write arrived. It cannot be admitted.
    if (message.carryNonce === undefined) return fenced.size ? 'carry-nonce-required-after-fence' : null;
    if (!text(message.carryNonce) || !carryFenceIdentityMatches(message, identity())) return 'stale-carry-target';
    if (fenced.has(message.carryNonce)) return 'carry-fenced';
    if (committed.has(message.carryNonce)) return 'carry-already-committed';
    return null;
  };
  return {
    admit(message) {
      const reason = deliveryRefusal(message);
      if (!reason && message?.mode === 'carry-respawn' && message?.carryNonce === undefined &&
          isWeakKey(message) && !pending.has(message)) {
        pending.add(message);
        pendingLegacyCount += 1;
      }
      return reason;
    },
    end(message) {
      if (isWeakKey(message) && pending.delete(message)) pendingLegacyCount -= 1;
      if (isWeakKey(message)) begun.delete(message);
    },
    isFenced(message) { return fenced.has(message?.carryNonce); },
    deliveryRefusal,
    begin(message) {
      const reason = deliveryRefusal(message);
      // Only the admitted in-process request may retry preparation. A replayed
      // envelope still fails, and target identity/fence checks run on every try.
      if (reason === 'carry-already-committed' && begun.get(message) === message.carryNonce) return null;
      if (!reason && message?.carryNonce !== undefined) {
        committed.add(message.carryNonce);
        begun.set(message, message.carryNonce);
      }
      return reason;
    },
    fence(request) {
      if (!text(request?.nonce) || !text(request?.fenceId) ||
          !Number.isSafeInteger(request?.expiresAtMs) || request.expiresAtMs <= now() ||
          request.expiresAtMs > now() + 30_000) return refusal('carry-fence-invalid');
      const current = identity();
      if (!carryFenceIdentityMatches(request, current)) return refusal('stale-carry-fence-target');
      if (committed.has(request.nonce)) return refusal('carry-already-committed');
      if (!canFence()) return refusal('carry-fence-effect-in-flight');
      if (pendingLegacyCount > 0) return refusal('carry-nonce-unavailable');
      const prior = fenced.get(request.nonce);
      if (prior && prior !== request.fenceId) return refusal('carry-fence-conflict');
      fenced.set(request.nonce, request.fenceId);
      return { ok: true, reason: 'carry-fenced', nonce: request.nonce, fenceId: request.fenceId,
        identity: { ...current } };
    },
  };
}

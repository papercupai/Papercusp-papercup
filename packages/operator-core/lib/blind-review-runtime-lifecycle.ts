/**
 * Host-only wiring between admitted source, durable resource custody and the
 * managed namespace backend. No reviewer-selected paths, commands or receipts.
 * The backend is mandatory: this module cannot manufacture ready/absent proof.
 */
import { RuntimeCustodyRefusal, type createRuntimeCustodyStore, type RuntimeLease,
  type RuntimeResourceIntent, type RuntimeResourceKind, type RuntimeReviewerIdentity } from './blind-review-runtime-custody';
import { runtimeSourceImageOrigin, type RuntimeSourceImage } from './blind-review-source-image';
import { createRuntimeSeed, type RuntimeSeed } from './blind-review-runtime-seed';

type Store = ReturnType<typeof createRuntimeCustodyStore>;
type Absence = { scopeAbsent: boolean; absentIntentIds: string[]; checkedKinds: RuntimeResourceKind[] };
export type RuntimeNamespaceBackend = {
  /**
   * Create only from this complete, committed plan, inside one finite managed
   * namespace scope. Use the same sealed image handle. Call beforeCreate before
   * each OS creation and record immediately afterwards. All descendants, guest
   * DB/display/profile/channel/credentials belong to these deterministic tags.
   * A rejection does not imply absence; cleanup/discovery still run below.
   */
  provision(input: {
    lease: RuntimeLease; resources: readonly RuntimeResourceIntent[]; image: RuntimeSourceImage; seed: RuntimeSeed;
    signal: AbortSignal; beforeCreate(): Promise<void>;
    record(intentId: string, identity: Record<string, string>): Promise<void>;
  }): Promise<void>;
  /** Fence the creator and stop the whole scope, including create-before-append. */
  teardown(lease: RuntimeLease, signal: AbortSignal): Promise<void>;
  /** Independent discovery, not a projection of successful teardown calls. */
  inspect(lease: RuntimeLease, resources: readonly RuntimeResourceIntent[], signal: AbortSignal): Promise<
    Absence & { creatorStopped: boolean }
  >;
};

/** Cutoff always commits before OS teardown; unknown cleanup stays releasing. */
async function releaseUnderLock(options: {
  store: Store; identity: RuntimeReviewerIdentity; leaseId: string; backend: RuntimeNamespaceBackend; reason: string;
}): Promise<boolean> {
  const { store, identity, leaseId, backend } = options;
  const lease = await store.revoke(identity, leaseId, options.reason);
  if (lease.state === 'released') return true;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      backend.teardown(lease, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('runtime_teardown_timeout')); }, 24_000);
        timer.unref?.();
      }),
    ]);
    return await store.confirmReleased(identity, leaseId, async (resources, signal) => {
      const proof = await backend.inspect(lease, resources, signal);
      // No absence claim can race a creator that is still able to materialize
      // its prior intent. An unknown/missing creator fence is not released.
      if (proof.creatorStopped !== true) throw new Error('runtime_creator_not_fenced');
      return proof;
    });
  } catch { return false; }
  finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

/** Used by post/end/expiry/replacement/restart reconciliation after cutoff. */
export async function releaseRuntimeNamespace(options: Parameters<typeof releaseUnderLock>[0]) {
  // Do not wait for a busy creator before committing revocation.
  await options.store.revoke(options.identity, options.leaseId, options.reason);
  const result = await options.store.withLifecycle(options.identity, options.leaseId,
    () => releaseUnderLock(options));
  return result.acquired && result.value;
}

/**
 * Called only AFTER consumeRuntimeSourceImage. A duplicate returns the existing
 * pending/ready disposition and never creates a second runtime. An interrupted
 * plan is reaped, never adopted or replayed. Returning ready still confers no
 * per-action authority: dispatch and success must each call store.authorize.
 */
export async function provisionRuntimeNamespace(options: {
  store: Store; identity: RuntimeReviewerIdentity; leaseId: string; image: RuntimeSourceImage;
  backend: RuntimeNamespaceBackend; signal?: AbortSignal;
}): Promise<{ state: 'pending' } | { state: 'ready'; lease: RuntimeLease }> {
  const { store, identity, leaseId, image, backend } = options;
  options.signal?.throwIfAborted();
  runtimeSourceImageOrigin(image);
  const result = await store.withLifecycle(identity, leaseId, async () => {
    const plan = await store.beginProvisioning(identity, leaseId);
    const { lease, resources } = plan;
    if (!plan.claimed) {
      if (lease.state === 'ready') {
        return { state: 'ready' as const, lease: await store.authorize(identity, leaseId, {
          leaseEpoch: String(lease.lease_epoch), runtimeNonce: lease.runtime_nonce,
        }) };
      }
      await releaseUnderLock({ store, identity, leaseId, backend, reason: 'interrupted-provisioning' });
      throw new RuntimeCustodyRefusal('runtime_provisioning_interrupted');
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let rejectOnAbort: (() => void) | undefined;
    try {
      // A producer object alone is insufficient: it must be the image bound
      // to this consumed receipt. No mismatched source may reach the backend.
      if (!lease.admission || ['sourceImageNonce', 'sourceCommit', 'sourceTreeHash', 'sourceInputsHash']
        .some(key => lease.admission![key] !== image[key as keyof RuntimeSourceImage]))
        throw new RuntimeCustodyRefusal('runtime_source_identity_mismatch');
      const expires = lease.expires_at && new Date(lease.expires_at).getTime();
      if (!expires || !Number.isFinite(expires)) throw new RuntimeCustodyRefusal('lease_expired_or_revoked');
      const remaining = expires - Date.now();
      if (remaining <= 0) throw new RuntimeCustodyRefusal('lease_expired_or_revoked');
      // The managed scope supplies the independent crash fuse. This bounds the
      // host wait too: a backend that ignores AbortSignal cannot pin lifecycle
      // custody forever or prevent teardown when its caller is canceled.
      deadline = setTimeout(() => controller.abort(new RuntimeCustodyRefusal('lease_expired_or_revoked')),
        Math.min(remaining, 15 * 60_000));
      deadline.unref?.();
      signal.throwIfAborted();
      const planned = new Set(resources.map(resource => resource.id));
      const stopped = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(signal.reason);
        signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
      // Schedule invocation after Promise.race installs both handlers. A
      // backend may throw synchronously before returning its Promise; that
      // must not orphan the abort rejection during failure cleanup.
      const seed = createRuntimeSeed(lease);
      await Promise.race([Promise.resolve().then(() => backend.provision({ lease, resources, image, seed, signal,
        beforeCreate: async () => { signal.throwIfAborted(); await store.checkProvisioning(identity, leaseId); },
        record: async (intentId, observed) => {
          signal.throwIfAborted();
          if (!planned.has(intentId)) throw new RuntimeCustodyRefusal('resource_intent_missing');
          await store.recordResource(identity, leaseId, intentId, observed);
        },
      })), stopped]);
      signal.throwIfAborted();
      return { state: 'ready' as const, lease: await store.markReady(identity, leaseId) };
    } catch (error) {
      controller.abort();
      await releaseUnderLock({ store, identity, leaseId, backend, reason: 'runtime-provisioning-failed' });
      throw error;
    } finally {
      if (deadline) clearTimeout(deadline);
      if (rejectOnAbort) signal.removeEventListener('abort', rejectOnAbort);
      controller.abort();
    }
  });
  return result.acquired ? result.value : { state: 'pending' };
}

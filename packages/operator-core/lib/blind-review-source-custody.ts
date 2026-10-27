/** Host adapter: the runtime launcher receives exactly the image that was admitted. */
import { admitRuntimeSourceImage } from './blind-review-source-admission';
import type { RuntimeSourceImage } from './blind-review-source-image';
import type { createRuntimeCustodyStore, RuntimeReviewerIdentity } from './blind-review-runtime-custody';

export async function consumeRuntimeSourceImage(options: {
  store: ReturnType<typeof createRuntimeCustodyStore>; identity: RuntimeReviewerIdentity;
  leaseId: string; image: RuntimeSourceImage; repositoryId: string; signal?: AbortSignal;
}) {
  const { store, identity, leaseId, image, signal } = options;
  const admission = await admitRuntimeSourceImage(image, { repositoryId: options.repositoryId, signal });
  signal?.throwIfAborted();
  const receiptId = await store.recordAdmission(identity, leaseId, admission);
  signal?.throwIfAborted();
  const lease = await store.consumeAdmission(identity, leaseId, receiptId);
  // This is allocation authority, not readiness. No OS creation belongs above
  // consumption; subsequent resource intents and ready checks remain mandatory.
  return Object.freeze({ lease, receiptId, image });
}

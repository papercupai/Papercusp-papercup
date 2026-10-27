/** Minimal host-generated product input; never import live workspace state. */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeLease } from './blind-review-runtime-custody';

// Reuse verify-tauri-headless's maintained ready fixture. It provisions the
// product principal and onboarding state; v1 does not import actor records.
export const runtimeSeedSchema = z.object({
  version: z.literal(1),
  workspace: z.object({ id: z.string().uuid(), slug: z.string().regex(/^review-[a-f0-9]{24}$/),
    name: z.literal('Disposable review') }).strict(),
  actors: z.array(z.never()).max(4),
  fixtures: z.tuple([z.literal('ready')]),
}).strict();
export type RuntimeSeed = Readonly<{
  version: 1; workspace: Readonly<{ id: string; slug: string; name: 'Disposable review' }>;
  actors: readonly never[]; fixtures: readonly ['ready'];
}>;
type LeaseKey = Pick<RuntimeLease, 'id' | 'lease_epoch' | 'runtime_nonce'>;
const origins = new WeakMap<object, string>();
function key(lease: LeaseKey) {
  if (!z.string().uuid().safeParse(lease.id).success ||
      !z.string().uuid().safeParse(lease.runtime_nonce).success ||
      !/^[1-9][0-9]*$/.test(String(lease.lease_epoch))) throw new Error('broker_seed_lease_invalid');
  return JSON.stringify([lease.id, String(lease.lease_epoch), lease.runtime_nonce]);
}

/** No requester choices, raw text, URLs, credentials or live identifiers. */
export function createRuntimeSeed(lease: LeaseKey): RuntimeSeed {
  const binding = key(lease);
  const seed = Object.freeze({ version: 1 as const,
    workspace: Object.freeze({ id: randomUUID(), slug: 'review-' + randomBytes(12).toString('hex'),
      name: 'Disposable review' as const }),
    actors: Object.freeze([]) as readonly never[], fixtures: Object.freeze(['ready'] as const) });
  runtimeSeedSchema.parse(seed);
  origins.set(seed, binding);
  return seed;
}

/** A JSON-shaped copy or a seed from another lease has no host custody. */
export function assertRuntimeSeed(seed: RuntimeSeed, lease: LeaseKey): void {
  if (origins.get(seed) !== key(lease)) throw new Error('broker_seed_origin_invalid');
  runtimeSeedSchema.parse(seed);
}

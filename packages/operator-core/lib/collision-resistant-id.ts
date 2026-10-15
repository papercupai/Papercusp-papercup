/**
 * Collision-resistant numeric id tails — time + random, no shared state.
 *
 * EI-13285 introduced this generator for EI- ids: an id computed as
 * `MAX(existing) + 1` is unique only inside one database, so two federated nodes
 * (or two harnesses that each scan only their own rows) can mint the same id.
 * Deriving the id from wall-clock time plus a wide random tail needs no scan of
 * replicated, possibly-stale state, so it is safe across devices by construction.
 *
 * scope-unique-identifiers-2026-07-26 P-005 moved the generator here so the
 * feature-family minters (F-FIX in promote-issue.ts, F-IDEA in the brainstorm
 * route) can share it: both used to number per harness, which minted the same
 * F-FIX-001 under two harnesses of one workspace. This module has no imports
 * from issues-engineer.ts, so promote-issue.ts can use it without the import
 * cycle (issues-engineer.ts imports promote-issue.ts).
 */
import { randomInt } from 'node:crypto';

// A fixed epoch (arbitrary — keeps the millis component shorter) so the numeric
// tail stays inside a signed 64-bit (Postgres bigint) range for ~278 years. It is
// NOT a JS-safe integer (it exceeds 2^53 already), so never parse it with Number().
const ID_EPOCH_MS = Date.UTC(2026, 0, 1);
// 20 random bits (~1M values) appended per millisecond of entropy — same-millisecond
// collision odds are ~1-in-a-million even with ZERO cross-writer coordination.
const ID_RAND_BITS = 20n;
const ID_RAND_SPACE = 2 ** 20;

/** Mint a fresh collision-resistant decimal id tail (digits only). */
export function newCollisionResistantIdTail(nowMs: number = Date.now()): string {
  const ms = BigInt(Math.max(0, nowMs - ID_EPOCH_MS));
  const rand = BigInt(randomInt(0, ID_RAND_SPACE));
  return ((ms << ID_RAND_BITS) + rand).toString();
}

/**
 * Mint a feature-family id `F-<KIND>-<tail>` for a server-allocated feature row.
 * `kind` is an uppercase tag (`FIX`, `IDEA`); the result matches the feature-id
 * validators (`^F-[A-Z0-9-]+$`), so every reader that recognises a feature by its
 * `F-` prefix keeps working.
 */
export function newFeatureId(kind: string): string {
  if (!/^[A-Z][A-Z0-9]*$/.test(kind)) throw new Error(`newFeatureId: kind must be an uppercase tag, got ${kind}`);
  return `F-${kind}-${newCollisionResistantIdTail()}`;
}

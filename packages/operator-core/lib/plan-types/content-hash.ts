/**
 * Content hashes for item-type and plan-type definitions
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, D-006).
 *
 * A plan pins each type it resolves by id, revision AND content hash. The hash is what makes
 * a pin mean "exactly this definition": a stored revision whose content no longer matches its
 * pin (a tampered row, or a first-party definition edited without a revision bump) fails safe
 * to the strictest module set instead of silently grading the plan by different rules.
 *
 * The hash is SHA-256 over canonical JSON (keys sorted recursively, arrays in order, undefined
 * members dropped), so it does not depend on jsonb key order or whitespace. It is taken over the
 * definition AS STORED: the author's JSON for a registry row, the catalog object for a built-in.
 *
 * content-hash.test.ts fixes the eight first-party hashes as literals, and migration 1545
 * backfills pins with the same literals. Editing a first-party definition therefore fails that
 * test until the definition gets a new revision.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../external-bench/reproducibility/canonical-json';

/** SHA-256 hex of the definition's canonical JSON. */
export function definitionContentHash(definition: unknown): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

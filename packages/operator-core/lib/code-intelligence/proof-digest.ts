/**
 * Which bytes a dependency-snapshot proof source pins (plan-item-code-anchors-2026-10-20#P-001).
 *
 * A source file is pinned by the sha256 of its full content. A workspace `package.json` is
 * pinned only by the one field the snapshot's resolver reads from it: `name`
 * (`workspacePackagesFrom` in scripts/gen-graph-dependency-snapshot.mjs maps name -> dir, and a
 * bare specifier resolves through that dir alone, never through main/exports/types). Pinning
 * the whole manifest suppressed every push and snapshot answer for a package whenever any
 * other field changed (a script, a dependency, a version) — measured: an uncommitted rewrite
 * of packages/operator-core/package.json was the only mismatch for all 6 operator-core push
 * subjects, and the grep leg pushed 0 chars until the file returned to HEAD.
 *
 * One definition shared by the producer (scripts/lib/code-intel-symbol-snapshot.mjs) and the
 * consumer (corroboratePushSources), so the two can never compute different digests.
 */
import { createHash } from 'node:crypto';

/** Marks a proof source pinned by `packageNameProofSha256`, not by its full content. */
export const PACKAGE_NAME_PROOF_DIGEST = 'package-name-v1';
export type ProofDigest = typeof PACKAGE_NAME_PROOF_DIGEST;

/** sha256 of a manifest's `name` (null when absent or not a string), or null for non-object JSON. */
export function packageNameProofSha256(text: string): string | null {
  let manifest: unknown;
  try { manifest = JSON.parse(text); } catch { return null; }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const name = (manifest as { name?: unknown }).name;
  return createHash('sha256').update(JSON.stringify({ name: typeof name === 'string' ? name : null })).digest('hex');
}

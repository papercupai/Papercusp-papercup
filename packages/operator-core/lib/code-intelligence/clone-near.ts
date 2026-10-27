/** D-015's selected Type-3 engine. Kept independent of the frozen benchmark
 * implementation so its retained source remains a conformance oracle.
 * Scores describe ordered AST shape similarity, never semantic equivalence.
 */
import * as ts from 'typescript';

export const CLONE_NEAR_POLICY = Object.freeze({
  version: 'minhash-ordered-subtree-v1', seeds: 32, rowsPerBand: 4, shingleWidth: 3, threshold: 0.8,
});
interface Shape { readonly kind: number; readonly children: readonly Shape[]; readonly mass: number }
export interface CloneNearFingerprint { readonly tree: Shape; readonly bands: readonly string[] }

/** Use the already parsed function body in the index; SourceFiles are also
 * accepted for exact conformance replay against the frozen pair benchmark.
 */
export function fingerprintCloneNear(node: ts.Node): CloneNearFingerprint {
  const stream: number[] = [];
  const build = (current: ts.Node): Shape => {
    stream.push(current.kind);
    const children: Shape[] = [];
    ts.forEachChild(current, child => { children.push(build(child)); });
    return { kind: current.kind, children, mass: 1 + children.reduce((sum, child) => sum + child.mass, 0) };
  };
  const tree = build(node), shingles = new Set<string>();
  for (let i = 0; i <= stream.length - CLONE_NEAR_POLICY.shingleWidth; i++)
    shingles.add(stream.slice(i, i + CLONE_NEAR_POLICY.shingleWidth).join(','));
  const signature = Array.from({ length: CLONE_NEAR_POLICY.seeds }, (_, seed) => {
    let minimum = 0xffffffff;
    for (const shingle of shingles) {
      let hash = (2166136261 ^ Math.imul(seed + 1, 2654435761)) >>> 0;
      for (let i = 0; i < shingle.length; i++) hash = Math.imul(hash ^ shingle.charCodeAt(i), 16777619) >>> 0;
      minimum = Math.min(minimum, hash);
    }
    return minimum;
  });
  const bands: string[] = [];
  for (let i = 0; i < signature.length; i += CLONE_NEAR_POLICY.rowsPerBand)
    bands.push(`${i / CLONE_NEAR_POLICY.rowsPerBand}:${signature.slice(i, i + CLONE_NEAR_POLICY.rowsPerBand).join(',')}`);
  return { tree, bands };
}

/** Insertion/deletion costs the whole subtree mass; children are not promoted. */
function distance(a: Shape, b: Shape): number {
  let previous = [0];
  for (const child of b.children) previous.push(previous[previous.length - 1]! + child.mass);
  for (const ac of a.children) {
    const next = [previous[0]! + ac.mass];
    for (let j = 0; j < b.children.length; j++) {
      const bc = b.children[j]!;
      next.push(Math.min(previous[j + 1]! + ac.mass, next[j]! + bc.mass, previous[j]! + distance(ac, bc)));
    }
    previous = next;
  }
  return previous[b.children.length]! + Number(a.kind !== b.kind);
}

export function compareCloneNear(a: CloneNearFingerprint, b: CloneNearFingerprint): { candidate: boolean; similarity: number | null } {
  const candidate = a.bands.some((band, i) => band === b.bands[i]);
  return { candidate, similarity: candidate ? Math.max(0, 1 - distance(a.tree, b.tree) / Math.max(a.tree.mass, b.tree.mass)) : null };
}

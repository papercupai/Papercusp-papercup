import { createHash } from 'node:crypto';

/** Bump when token encoding or traversal semantics change; persisted families pin it. */
export const AST_FINGERPRINT_VERSION = 'ast-v1';

export interface TreeAdapter<N> {
  kind(node: N): string | number;
  /** An atomic leaf has separately tagged exact and normalized representations. */
  atom(node: N): { exact: string; normalized: string } | null;
  forEachChild(node: N, visit: (child: N) => void): void;
}

export interface TreeFingerprint {
  mass: number;
  exact: string;
  normalized: string;
}

/** Ordered tree shape plus tagged atoms; comments/formatting belong to the adapter.
 * Explicit frames avoid a recursive walk overflowing on deeply nested host trees.
 * JSON encoding keeps literal commas/brackets distinct from structural separators.
 */
export function fingerprintTree<N>(root: N, adapter: TreeAdapter<N>): TreeFingerprint {
  const exact: (string | number)[] = [];
  const normalized: (string | number)[] = [];
  const stack: ({ node: N } | { end: true })[] = [{ node: root }];
  let mass = 0;
  while (stack.length) {
    const frame = stack.pop()!;
    if ('end' in frame) { exact.push(')'); normalized.push(')'); continue; }
    mass++;
    const atom = adapter.atom(frame.node);
    if (atom) { exact.push(atom.exact); normalized.push(atom.normalized); continue; }
    const kind = adapter.kind(frame.node);
    exact.push(kind, '('); normalized.push(kind, '(');
    const children: N[] = [];
    adapter.forEachChild(frame.node, child => { children.push(child); });
    stack.push({ end: true });
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i] });
  }
  const hash = (tokens: (string | number)[]) => createHash('sha256').update(JSON.stringify(tokens)).digest('hex');
  return { mass, exact: hash(exact), normalized: hash(normalized) };
}

import { describe, expect, it } from 'vitest';
import { fingerprintTree, type TreeAdapter } from './index';

type Node = { kind: string; text?: string; children?: Node[] };
const adapter: TreeAdapter<Node> = {
  kind: node => node.kind,
  atom: node => node.text === undefined ? null : { exact: `I:${node.text}`, normalized: 'I' },
  forEachChild: (node, visit) => { node.children?.forEach(visit); },
};
describe('adapter-driven AST fingerprints', () => {
  it('normalizes leaves while preserving order, shape and mass', () => {
    const tree = (text: string): Node => ({ kind: 'block', children: [{ kind: 'name', text }] });
    const a = fingerprintTree(tree('a'), adapter), b = fingerprintTree(tree('b'), adapter);
    expect(a.mass).toBe(2);
    expect(a.exact).not.toBe(b.exact);
    expect(a.normalized).toBe(b.normalized);
    expect(a.normalized).not.toBe(fingerprintTree({ kind: 'other', children: tree('a').children }, adapter).normalized);
  });
  it('encodes atom delimiters unambiguously and handles deep input without recursion', () => {
    const one = fingerprintTree({ kind: 'block', children: [{ kind: 'id', text: 'a,I:b' }] }, adapter);
    const two = fingerprintTree({ kind: 'block', children: [{ kind: 'id', text: 'a' }, { kind: 'id', text: 'b' }] }, adapter);
    expect(one.exact).not.toBe(two.exact);
    let root: Node = { kind: 'leaf', text: 'x' };
    for (let i = 0; i < 12000; i++) root = { kind: 'branch', children: [root] };
    expect(fingerprintTree(root, adapter).mass).toBe(12001);
  });
});

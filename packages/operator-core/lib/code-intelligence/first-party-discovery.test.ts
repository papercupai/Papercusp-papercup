import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { firstPartyCallers } from './first-party-callers';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-discovery-')); roots.push(root);
  writeFileSync(join(root, 'main.ts'), `
    export function invoicePayment() { return "invoice payment validated"; }
    export function checkout() { return invoicePayment(); }
    export function unrelated() { return "garden watering"; }
    export function cycleA() { return cycleB(); }
    export function cycleB() { return cycleA(); }
  `);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const query = (root: string, op: 'communities' | 'flows' | 'concept-search', extra = {}) =>
  firstPartyCallers({ ts, root, op, name: '', paths: ['main.ts'], ...extra });

describe('P020 source-correlated discovery', () => {
  it('groups connected compiler calls while preserving disconnected and cyclic code separately', () => {
    const root = fixture(), result = query(root, 'communities');
    expect(result.error).toBeNull();
    const groups = result.discovery!.groups.map(group => group.members.map(member => member.site.name).sort());
    expect(groups).toEqual(expect.arrayContaining([['checkout', 'invoicePayment'], ['unrelated'], ['cycleA', 'cycleB']]));
    expect(result.discovery).toMatchObject({ knowledge: 'inferred', semanticSimilarity: 'unmeasured', outcome: 'suggestions' });
    for (const site of result.evidence!.sourceScope.supportingFiles) expect(site.contentHash)
      .toBe(createHash('sha256').update(readFileSync(join(root, site.path))).digest('hex'));
    expect(result.evidence!.relationships.every(edge => edge.origin === 'compiler' && edge.runtimeExecution === 'unknown')).toBe(true);
  });
  it('returns possible zero-incoming entry flows with each directed hop, without inventing a cycle entry', () => {
    const result = query(fixture(), 'flows');
    expect(result.error).toBeNull();
    expect(result.discovery!.flows.map(flow => flow.nodes.map(node => node.site.name)))
      .toEqual(expect.arrayContaining([['checkout', 'invoicePayment'], ['unrelated']]));
    expect(result.discovery!.flows.some(flow => flow.entry.site.name === 'cycleA')).toBe(false);
    expect(result.discovery!.flows.every(flow => flow.runtimeExecution === 'unknown')).toBe(true);
  });
  it('retrieves independently relevant source with RRF evidence, never relevance from a neighbouring component alone', () => {
    const result = query(fixture(), 'concept-search', { name: 'invoice payment' });
    expect(result.error).toBeNull();
    expect(result.discovery!.matches[0]!.symbol.site.name).toBe('invoicePayment');
    expect(result.discovery!.matches.every(match => match.evidence === 'retrieval')).toBe(true);
    expect(result.discovery!.matches.map(match => match.symbol.site.name)).not.toContain('unrelated');
    expect(result.discovery!.matches[0]!.rankers).toContain('symbol-path');
    expect(result.discovery!.matches[0]!.rankers).toContain('source-text');
  });
  it('returns explicit scoped absence for nonsense instead of a confident capability', () => {
    const result = query(fixture(), 'concept-search', { name: 'zyxquantum unicornflux' });
    expect(result.error).toBeNull(); expect(result.sites).toEqual([]);
    expect(result.discovery).toMatchObject({ outcome: 'not-found-in-scope', matches: [] });
    expect(result.evidence!.sourceScope.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects partial-term matches across disconnected source instead of combining unrelated capabilities', () => {
    const root = fixture();
    // Each term has a real positive control; no callable supplies the combined query.
    expect(query(root, 'concept-search', { name: 'invoice' }).sites.length).toBeGreaterThan(0);
    expect(query(root, 'concept-search', { name: 'garden' }).sites.map(site => site.name)).toContain('unrelated');
    const mixed = query(root, 'concept-search', { name: 'invoice garden' });
    expect(mixed.error).toBeNull(); expect(mixed.sites).toEqual([]);
    expect(mixed.discovery).toMatchObject({ outcome: 'not-found-in-scope', matches: [] });
  });
  it('changes result and group identities after source edits, rather than retaining old relevance', () => {
    const root = fixture(), before = query(root, 'concept-search', { name: 'invoice payment' });
    writeFileSync(join(root, 'main.ts'), 'export function garden() { return "garden watering"; }\n');
    const after = query(root, 'concept-search', { name: 'invoice payment' });
    expect(after.discovery!.outcome).toBe('not-found-in-scope');
    expect(after.evidence!.sourceScope.sourceFingerprint).not.toBe(before.evidence!.sourceScope.sourceFingerprint);
    expect(query(root, 'communities').discovery!.groups[0]!.id).not.toBe(before.discovery!.groups[0]!.id);
  });
  it('reports bounded results and depth, and refuses unbounded repository discovery', () => {
    const root = fixture(), limited = query(root, 'communities', { limit: 1 });
    expect(limited.sites).toHaveLength(1); expect(limited.truncation.truncated).toBe(true);
    expect(limited.discovery!.outcome).toBe('incomplete');
    const flow = query(root, 'flows', { maxDepth: 0 });
    expect(flow.discovery!.truncationReasons).toContain('depth');
    expect(flow.discovery!.flows.every(row => row.nodes.length === 1)).toBe(true);
    expect(query(root, 'communities', { paths: ['.'] }).error).toContain('bounded source paths');
  });
});

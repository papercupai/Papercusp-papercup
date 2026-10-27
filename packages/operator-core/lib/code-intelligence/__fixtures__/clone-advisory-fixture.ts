import { buildCloneIndex } from '../clone-index';
import { prepareCloneAdvisories } from '../clone-advisory';
import { parsePushSnapshot } from '../push-snapshot';

const source = 'export function original(values: number[]) { let total = 0; for (const value of values) { if (value > 0) { total += value; } else { total -= value; } } return total; }';
export function cloneAdvisoryFixture() {
  const index = buildCloneIndex([{ path: 'a.ts', source }, { path: 'b.ts', source: source.replace('original', 'copy') },
    { path: 'none.ts', source: 'export function different() { throw new Error("no match"); }' }], { minMass: 1 });
  const files = prepareCloneAdvisories(index);
  const raw = { schema: 'graph-dependency-snapshot-v1', generatedAt: new Date().toISOString(),
    index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
    edges: [{ importer: 'a.ts', imported: 'b.ts', importerSha256: files[0]!.sha256 }],
    clones: { schema: 'clone-advisory-v1', files } };
  return { files, raw, sources: { 'a.ts': source, 'b.ts': source.replace('original', 'copy'),
    'none.ts': 'export function different() { throw new Error("no match"); }' },
    snapshot: parsePushSnapshot(JSON.stringify(raw))! };
}

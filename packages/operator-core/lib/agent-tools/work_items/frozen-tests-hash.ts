/** R-9: the existing evidence measurement owns path validation and byte hashing. */
import { measureRepoFilesEvidenceDetailedAtRoot } from '../plans/spec-evidence-store';

export interface FrozenTestFile { path: string; sha256: string }

export function changedFrozenTests(expected: readonly FrozenTestFile[], actual: readonly FrozenTestFile[]): string[] {
  const observed = new Map(actual.map(file => [file.path, file.sha256]));
  return expected.filter(file => observed.get(file.path) !== file.sha256).map(file => file.path);
}

export async function readFrozenTestFiles(root: string, paths: string[]): Promise<FrozenTestFile[]> {
  const measured = await measureRepoFilesEvidenceDetailedAtRoot(root, {
    kind: 'repo-files', schemaVersion: 1, sourcePaths: paths, testPaths: paths,
  });
  return measured.files.filter(file => file.dimension === 'test').map(({ path, sha256 }) => ({ path, sha256 }));
}

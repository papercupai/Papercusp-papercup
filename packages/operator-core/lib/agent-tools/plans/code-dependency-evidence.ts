/** Capture compiler dependencies into the existing measured evidence file set. */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { firstPartyCallersOffthread } from '../../code-intelligence/first-party-callers-offthread';
import { LSP_VENDOR_DIR } from '../../code-intelligence/lsp-adapter';
import type { CodeIntelAnswer, CodeIntelSourceFile } from '../../code-intelligence/contracts';
import type { MeasurementPin, RepoFilesEvidenceMeasurement } from './spec-evidence-store';

const relativePath = z.string().trim().min(1).max(400).refine(path =>
  !path.startsWith('/') && !path.includes('\\') &&
  !path.split('/').some(part => !part || part === '..' || part === '.'),
  'dependency paths must be normalized repository-relative paths');
export const dependencyQueriesSchema = z.array(z.object({
  name: z.string().trim().min(1).max(200),
  file: relativePath,
  paths: z.array(z.union([relativePath, z.literal('.')])).min(1).max(8),
}).strict()).min(1).max(4);

type Queries = z.infer<typeof dependencyQueriesSchema>;
type Query = (root: string, selector: Queries[number]) => Promise<CodeIntelAnswer>;

export async function captureCodeDependencies(repoRoot: string, measurement: RepoFilesEvidenceMeasurement,
  queries: Queries, query: Query = (root, selector) => firstPartyCallersOffthread({
    vendorDir: LSP_VENDOR_DIR, root, name: selector.name, filePath: selector.file,
    paths: selector.paths, op: 'impact', direction: 'upstream', maxDepth: 4, maxPaths: 32, limit: 32,
  }, { budgetMs: 20_000 })) {
  const root = await realpath(repoRoot);
  const repositoryId = `local-root:${createHash('sha256').update(root).digest('hex')}`;
  const sources = new Map<string, CodeIntelSourceFile>();
  const snapshots = [];
  for (const selector of dependencyQueriesSchema.parse(queries)) {
    const answer = await query(root, selector);
    const scope = answer.evidence?.sourceScope;
    if (answer.error || answer.backend !== 'typescript-service' || answer.truncation.truncated ||
      answer.traversal?.truncationReasons.length || scope?.repositoryId !== repositoryId ||
      !answer.sites.some(site => site.path === selector.file) || !scope.supportingFiles.length) {
      throw new Error('code_dependency_query_unmeasured_or_truncated');
    }
    if (answer.evidence!.relationships.some(edge => edge.origin !== 'compiler' || edge.knowledge !== 'observed')) {
      throw new Error('code_dependency_relationship_unmeasured');
    }
    for (const source of scope.supportingFiles) {
      relativePath.parse(source.path);
      if (source.representation !== 'full-source' || !/^[a-f0-9]{64}$/.test(source.contentHash)) {
        throw new Error('code_dependency_source_unmeasured');
      }
      const previous = sources.get(source.path);
      if (previous && previous.contentHash !== source.contentHash) throw new Error('code_dependency_source_changed_during_capture');
      sources.set(source.path, source);
    }
    snapshots.push({ query: selector, sourceFingerprint: scope.sourceFingerprint,
      relationships: answer.evidence!.relationships, limitations: answer.evidence!.graphScope.limitations });
  }
  const sourcePaths = [...new Set([...measurement.sourcePaths, ...sources.keys()])].sort();
  if (sourcePaths.length > 32) throw new Error('code_dependency_source_limit_exceeded');
  return { measurement: { ...measurement, sourcePaths }, evidence: {
    schemaVersion: 1, repositoryId, sources: [...sources.values()], snapshots,
    limitations: ['Captured compiler dependencies expand the existing file measurement; they do not revalidate a requirement or prove runtime execution.'],
  } };
}

/** Refuse a graph/file race or a graph newer than the committed execution. */
export function assertCodeDependencyVersions(sources: readonly CodeIntelSourceFile[], pin?: MeasurementPin | null): void {
  if (!pin || sources.some(source => !pin.files.some(file => file.dimension === 'source' &&
    file.path === source.path && file.sha256 === source.contentHash))) {
    throw new Error('code_dependency_snapshot_does_not_match_measured_source');
  }
}

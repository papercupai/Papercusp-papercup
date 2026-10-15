/** Source-cited architecture prose for the existing canonical docs author. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { versionedSymbolIdentity, type CodeIntelAnswer, type SymbolSite } from '../../code-intelligence/contracts';

export interface NativeArchitectureRequest {
  name: string;
  file: string;
  paths: string[];
  limit?: number;
}

const code = (text: string): string => {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map(run => run.length)) + 1);
  return `${fence} ${text} ${fence}`;
};

/** Query through the native handler, then recheck the captured bytes before writing.
 * Only compiler-observed, versioned relationships become prose; this is static
 * evidence, never proof of runtime execution or repository completeness.
 */
export async function generateNativeArchitecture(
  root: string,
  request: NativeArchitectureRequest,
  query: (request: NativeArchitectureRequest) => Promise<CodeIntelAnswer>,
): Promise<{ body: string; documents: string[]; sourceFingerprint: string; statements: number }> {
  const answer = await query(request);
  const evidence = answer.evidence;
  if (answer.error || !evidence?.sourceScope.repositoryId || !evidence.sourceScope.sourceFingerprint ||
      answer.freshness.health !== 'healthy' || answer.freshness.staleVsDisk !== false) {
    throw new Error(`native_architecture_unavailable: ${answer.error ?? 'current source evidence is required'}`);
  }
  const sources = new Map(evidence.sourceScope.supportingFiles.map(file => [file.path, file]));
  const documents = new Set<string>();
  const lines: string[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  const citation = (site: SymbolSite, hash: string | null | undefined, identity: string | null | undefined): string => {
    const source = sources.get(site.path);
    if (!source || source.representation !== 'full-source' || !/^[a-f0-9]{64}$/.test(hash ?? '') ||
        hash !== source.contentHash || !identity ||
        identity !== versionedSymbolIdentity(evidence.sourceScope.repositoryId, site, source)) {
      throw new Error('native_architecture_uncited_relationship: endpoint lacks captured source identity');
    }
    documents.add(site.path);
    return `${code(`${site.path}:${site.line1}`)} (SHA-256 ${code(source.contentHash)})`;
  };
  for (const relation of evidence.relationships) {
    if (relation.kind === 'definition') continue;
    if (relation.origin !== 'compiler' || relation.knowledge !== 'observed' ||
        relation.binding === 'dynamic' || relation.binding === 'indirect' || relation.binding === 'unresolved') {
      omitted += 1;
      continue;
    }
    const site = answer.sites[relation.siteIndex];
    const identity = evidence.siteIdentities.find(row => row.siteIndex === relation.siteIndex);
    if (!site || !identity || !relation.target) {
      throw new Error('native_architecture_uncited_relationship: resolved relationship lacks source or target');
    }
    const from = citation(site, identity.contentHash, identity.versionedSymbolId);
    const to = citation(relation.target.site, relation.target.contentHash, relation.target.versionedSymbolId);
    const line = `- The compiler reports ${code(relation.kind)} at ${from}, targeting ${to}.`;
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  }
  if (!lines.length) throw new Error('native_architecture_no_cited_relationships: no supported relationships in this scope');
  // Resolve symlinks too: a lexical in-root path can still point outside the repo.
  const realRoot = await fs.realpath(root);
  for (const path of documents) {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('native_architecture_source_outside_scope');
    }
    const absolute = await fs.realpath(resolve(realRoot, path));
    const rel = relative(realRoot, absolute);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('native_architecture_source_outside_scope');
    const currentHash = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
    if (currentHash !== sources.get(path)!.contentHash) throw new Error(`native_architecture_stale_source: ${path}`);
  }
  return {
    body: ['## Source-backed architecture', '',
      `Captured compiler source fingerprint: ${code(evidence.sourceScope.sourceFingerprint)}.`, '',
      ...lines, '',
      `These statements describe static source relationships within the requested scope. Runtime execution and source completeness remain unverified. ${omitted} unresolved relationships were omitted.`,
      ...(answer.truncation.truncated ? ['The graph result was truncated; this section is a partial view.'] : []),
      ...evidence.graphScope.limitations.map(text => `- ${text}`),
    ].join('\n'),
    documents: [...documents].sort(),
    sourceFingerprint: evidence.sourceScope.sourceFingerprint,
    statements: lines.length,
  };
}

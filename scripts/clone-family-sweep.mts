#!/usr/bin/env -S tsx
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { CloneIndex, classifyClonePath } from '../packages/operator-core/lib/code-intelligence/clone-index';
import { cloneSweepInputSchema, fileCloneSweep, nativeCloneFilingSignals, rankCloneSweep, rankSemanticSweep } from '../packages/operator-core/lib/code-intelligence/clone-sweep';
import { openSemanticCodeIndex, collectSemanticSweepCandidates } from '../packages/operator-core/lib/code-intelligence/semantic-code-runtime';
import { listFilesIncludingUntracked } from './lib/tracked-files.mjs';

// Only this managed child enumerates/parses the repository. An incomplete scan
// refuses filing rather than describing the unchecked population as healthy.
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const input = cloneSweepInputSchema.parse(request.input);
if (!isAbsolute(input.root)) throw new Error('Clone sweep root must be absolute');
const root = realpathSync(input.root);
const coverage = listFilesIncludingUntracked(root);
if (coverage.unscanned.length) throw new Error(`Clone sweep corpus incomplete: ${coverage.unscanned.join(', ')}`);
const index = new CloneIndex(), digest = createHash('sha256');
const excluded: string[] = [], incomplete: string[] = [];
for (const path of [...new Set<string>(coverage.files)].sort()) {
  if (!/\.tsx?$/.test(path) || /\.d\.ts$|\.gen\.tsx?$/.test(path)) continue;
  const classification = classifyClonePath(path);
  if (classification.test || classification.retired) { excluded.push(path); continue; }
  const absolute = resolve(root, path);
  try {
    if (!lstatSync(absolute).isFile() || relative(root, realpathSync(absolute)).startsWith('..')) {
      incomplete.push(path); continue;
    }
    const source = readFileSync(absolute, 'utf8');
    const file = index.update({ path, source }).file;
    digest.update(path).update('\0').update(file.sha256!).update('\0');
    if (file.status === 'syntax-error' || file.status === 'unavailable') incomplete.push(path);
    if (file.status === 'excluded') excluded.push(path);
  } catch (error) { throw new Error(`Clone sweep could not read ${path}`, { cause: error }); }
}
if (!index.size || incomplete.length) throw new Error(`Clone sweep corpus incomplete: ${incomplete.join(', ') || 'empty source census'}`);
let semantic: Awaited<ReturnType<typeof collectSemanticSweepCandidates>> | undefined;
if (input.semantic) {
  try {
    const store = await openSemanticCodeIndex(root, request.workspaceId, undefined,
      { background: true, summaryModel: input.semantic.model });
    semantic = await collectSemanticSweepCandidates(root, index, store,
      { ...input.semantic, harness: request.harness });
  } catch (error) {
    semantic = { status: 'unknown', candidates: [], examinedPairs: 0, bounded: true,
      reason: error instanceof Error ? error.message : String(error) };
  }
}
const families = [...rankCloneSweep(index, input), ...rankSemanticSweep(index, semantic?.candidates ?? [], input)];
const outcome = await fileCloneSweep(families, {
  workspaceId: request.workspaceId, harness: request.harness, fireId: request.fireId, root,
}, { signals: nativeCloneFilingSignals({ root, workspaceId: request.workspaceId, harness: request.harness }),
  closeResolved: { unscanned: incomplete } });
console.log(JSON.stringify({ schemaVersion: 1, fireId: request.fireId,
  sourceDigest: digest.digest('hex'), indexed: index.size, excluded, incomplete, semantic, ...outcome }));
// The ordinary host retains its DB pool; this single-use CLI must release it.
const { getOrgPg } = await import('@papercusp/db-org');
await getOrgPg().sql.end({ timeout: 5 });

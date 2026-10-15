/** Join captured compiler inputs to the existing runtime/pipeline evidence plane. */
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJsonResult } from '@papercusp/agent-mcp';
import type { ServingRuntimeId } from '../serving-runtimes';
import type { CodeIntelAnswer } from './contracts';

export interface SourceRuntimeFile {
  path: string;
  capturedSourceSha256: string | null;
  editedSourceSha256: string | null;
  artifact: { buildSha: string | null; codeSource: string | null; method: string | null };
  containsCapturedSource: boolean | null;
  reason: string | null;
}

export interface SourceRuntimeProvenance {
  runtime: ServingRuntimeId;
  repositoryId: string | null;
  sourceFingerprint: string | null;
  files: SourceRuntimeFile[];
  omittedFiles: number;
  limitations: string[];
}

type Dispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function payload(result: unknown): Record<string, unknown> | null {
  const root = record(result);
  if (!root || root.isError === true || root.ok === false) return null;
  const decoded = record(readJsonResult(result as Parameters<typeof readJsonResult>[0])) ?? record(root.structuredContent) ?? root;
  return record(decoded.data) ?? decoded;
}

export async function sourceRuntimeProvenance(answer: CodeIntelAnswer, runtime: ServingRuntimeId,
  rootPath: string, dispatch?: Dispatch, limit = 4, budgetMs = 20_000): Promise<SourceRuntimeProvenance> {
  const scope = answer.evidence?.sourceScope;
  const sources = scope?.supportingFiles ?? [];
  const selected = sources.slice(0, Math.min(8, Math.max(1, limit)));
  const root = await realpath(rootPath).catch(() => resolve(rootPath));
  const files = await Promise.all(selected.map(async (source): Promise<SourceRuntimeFile> => {
    const row: SourceRuntimeFile = { path: source.path, capturedSourceSha256: source.contentHash,
      editedSourceSha256: null, artifact: { buildSha: null, codeSource: null, method: null },
      containsCapturedSource: null, reason: null };
    if (!dispatch || !hash(source.contentHash)) {
      return { ...row, reason: !dispatch ? 'Runtime probe is unavailable on this transport.' : 'Compiler input version is unmeasured.' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        dispatch('dev:pipeline_position', { path: source.path, expectedSourceSha256: source.contentHash, sourceRuntimeOnly: true,
          projection: { pick: ['repoRoot', 'submodule', 'acceptedSource', 'servingRuntimes'] } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime probe budget elapsed.')), budgetMs); }),
      ]);
      const pipeline = payload(result);
      if (!pipeline || typeof pipeline.repoRoot !== 'string') return { ...row, reason: 'Pipeline repository identity is unmeasured.' };
      const pipelineRoot = resolve(pipeline.repoRoot, typeof pipeline.submodule === 'string' ? pipeline.submodule : '.');
      if (await realpath(pipelineRoot).catch(() => pipelineRoot) !== root) {
        return { ...row, reason: 'Pipeline evidence describes another repository.' };
      }
      const accepted = record(pipeline.acceptedSource);
      if (!accepted || accepted.expectedSha256 !== source.contentHash) return { ...row, reason: 'Pipeline evidence is not bound to the captured compiler input.' };
      row.editedSourceSha256 = hash(accepted.observedSha256) ? accepted.observedSha256 : null;
      const runtimes = Array.isArray(pipeline.servingRuntimes) ? pipeline.servingRuntimes : record(pipeline.servingRuntimes)?.entries;
      const selectedRuntime = Array.isArray(runtimes) ? record(runtimes.find(value => record(value)?.runtime === runtime)) : null;
      if (!selectedRuntime) return { ...row, reason: 'Selected runtime is absent from the measured runtime scope.' };
      row.artifact = {
        buildSha: typeof selectedRuntime.buildSha === 'string' && /^[a-f0-9]{4,64}$/.test(selectedRuntime.buildSha) ? selectedRuntime.buildSha : null,
        codeSource: typeof selectedRuntime.codeSource === 'string' ? selectedRuntime.codeSource : null,
        method: typeof selectedRuntime.method === 'string' ? selectedRuntime.method : null,
      };
      if (accepted.matches !== true || row.editedSourceSha256 !== source.contentHash) {
        return { ...row, reason: 'Edited source differs from the captured compiler input or could not be measured.' };
      }
      const contains = record(accepted.runtimeContainment)?.[runtime];
      if (!row.artifact.buildSha || typeof contains !== 'boolean' || contains !== selectedRuntime.containsChange) {
        return { ...row, reason: 'Loaded artifact identity or source containment is unmeasured or inconsistent.' };
      }
      return { ...row, containsCapturedSource: contains,
        reason: contains ? null : 'Selected runtime does not contain the captured source version.' };
    } catch (error) {
      return { ...row, reason: error instanceof Error ? error.message : 'Runtime probe failed.' };
    } finally { if (timer) clearTimeout(timer); }
  }));
  return { runtime, repositoryId: scope?.repositoryId ?? null, sourceFingerprint: scope?.sourceFingerprint ?? null,
    files, omittedFiles: sources.length - selected.length,
    limitations: ['Artifact build identity and captured compiler source identity are distinct; neither establishes runtime execution.',
      ...(sources.length ? [] : ['No measured supporting source files are available for a runtime join.']),
      ...(sources.length > selected.length ? ['Runtime source comparison is bounded; omitted files remain unmeasured.'] : [])] };
}

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import graphQuery from '../agent-tools/gitnexus/query';
import { evaluateServingRuntime } from '../serving-runtimes';
import { evaluateAcceptedSourceContainment } from '../git-pipeline-position';
import type { CodeIntelAnswer } from './contracts';
import type { SourceRuntimeProvenance } from './source-runtime-provenance';

describe('native P017 registered graph compiler and runtime evidence integration', () => {
  it('binds the compiler version to a pinned artifact and preserves the mismatch after an edit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-runtime-integration-'));
    const file = join(root, 'target.ts');
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      writeFileSync(file, 'export function target() { return 1; }\n');
      git(['init', '-q']); git(['config', 'user.name', 'native runtime private fixture']);
      git(['config', 'user.email', 'fixture@example.invalid']); git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'pinned artifact']);
      const buildSha = git(['rev-parse', 'HEAD']);
      const loadedHash = createHash('sha256').update(git(['show', `${buildSha}:target.ts`]) + '\n').digest('hex');
      const dispatchTool = async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe('dev:pipeline_position');
        expect(args.path).toBe('target.ts');
        const observed = readFileSync(file);
        const runtime = evaluateServingRuntime({ runtime: 'staging-operator', role: 'owner', pid: 42,
          startedAtMs: Date.now(), buildSha, buildShaSource: 'health', blobContains: args.expectedSourceSha256 === loadedHash,
          blobUnknown: null, fileMtimeMs: null, instances: null });
        return { content: [{ type: 'text', text: JSON.stringify({ repoRoot: root, submodule: null,
          acceptedSource: evaluateAcceptedSourceContainment(args.expectedSourceSha256 as string, observed, null, [runtime]),
          servingRuntimes: [runtime] }) }] };
      };
      const query = async () => {
        const result = await graphQuery.handler(graphQuery.args.parse({ op: 'symbol', name: 'target', file_path: 'target.ts',
          paths: ['.'], runtime: 'staging-operator' }), { projectDir: root, dispatchTool } as never);
        return (result as { data: CodeIntelAnswer & { runtimeProvenance: SourceRuntimeProvenance } }).data;
      };
      const before = await query();
      expect(before.error).toBeNull();
      expect(before.sites).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'target.ts', line1: 1 })]));
      expect(before.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: loadedHash,
        artifact: expect.objectContaining({ buildSha }), containsCapturedSource: true })]);
      writeFileSync(file, 'export function target() { return 2; }\n');
      const after = await query();
      const editedHash = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(after.error).toBeNull();
      expect(after.runtimeProvenance.sourceFingerprint).not.toBe(before.runtimeProvenance.sourceFingerprint);
      expect(after.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: editedHash,
        editedSourceSha256: editedHash, artifact: expect.objectContaining({ buildSha }), containsCapturedSource: false })]);
      expect(after.evidence!.siteIdentities[0]!.contentHash).toBe(editedHash);
      expect(after.runtimeProvenance.limitations.join(' ')).toMatch(/neither establishes runtime execution/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});

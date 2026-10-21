/** P010: native CLI → serving current operator → compiler worker → change report.
 * Set OPERATOR_BASE_URL after the maintained operator-api containment check.
 * This private source fixture performs only read-side MCP calls.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const baseUrl = process.env.OPERATOR_BASE_URL;
const repoRoot = resolve(import.meta.dirname, '../../../..');
const cli = join(repoRoot, 'apps/operator/scripts/ptool.mjs');

function call(name: string, args: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [cli, 'tools:invoke', `--url=${baseUrl}`, '--json', '-'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 120_000,
    input: JSON.stringify({ name, args }), env: { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' },
  });
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).not.toBe(false);
  return parsed.data ?? parsed;
}

describe.runIf(Boolean(baseUrl))('native P010 registered current-operator change report', () => {
  it('delivers the reference consumer and refreshes the pre-review brief after source edits', async () => {
    // sourceRuntimeOnly: the full pipeline read carries unrelated gate detail that the result
    // door can truncate, which intermittently hid currentBuildTestRoute (EI-26299755199884239,
    // 2026-10-21 09:59Z). The narrow form returns only the route and runtime containment.
    const route = call('dev:pipeline_position', { path: 'packages/operator-core/lib/agent-tools/lsp/pack.ts',
      testClass: 'operator-api', marker: 'previousFingerprint', sourceRuntimeOnly: true,
      projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute?.id, JSON.stringify(route).slice(0, 2000)).toBe('operator-api');
    expect(route.servingRuntimes.some((runtime: { runtime: string; containsChange: boolean | null }) =>
      runtime.runtime === 'staging-operator' && runtime.containsChange === true)).toBe(true);
    const health = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(10_000) });
    expect(health.ok).toBe(true);
    const build = await health.json() as { sha: string };
    const project = mkdtempSync(join(tmpdir(), 'native-report-e2e-'));
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 1; }\n');
      writeFileSync(join(project, 'consumer.ts'), 'import { changedTarget } from "./target";\nexport function useTarget() { return changedTarget(); }\n');
      git(['init', '-q']);
      git(['config', 'user.name', 'native report private fixture']);
      git(['config', 'user.email', 'fixture@example.invalid']);
      git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'reference fixture']);
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 2; }\n');
      const args = { op: 'diff', include: ['*.ts'], rootPath: project, baseRef: 'HEAD',
        explain: { symbol: 'changedTarget', file: 'target.ts', paths: ['.'], phase: 'pre-review' },
        projection: { pick: ['answer.error', 'answer.backend', 'report.changed', 'report.consumers',
          'report.sourceFingerprint', 'report.freshness', 'report.provenance.runtime', 'report.limitations', 'ownership.status'] } };
      const first = call('code:pack', args);
      expect(first.answer.error).toBeNull();
      expect(first.answer.backend).toBe('typescript-service');
      expect(first.report.consumers).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'consumer.ts', line1: 2 })]));
      expect(first.report.changed).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'target.ts' })]));
      expect(first.report.provenance.runtime.sha).toBe(build.sha);
      const repeat = call('code:pack', { ...args, explain: { ...args.explain, previousFingerprint: first.report.sourceFingerprint } });
      expect(repeat.report.freshness).toBe('unchanged');
      writeFileSync(join(project, 'consumer.ts'), 'export function useTarget() { return 2; }\n');
      const edited = call('code:pack', { ...args, explain: { ...args.explain, previousFingerprint: first.report.sourceFingerprint } });
      expect(edited.report.freshness).toBe('changed');
      expect(edited.report.consumers).toEqual([]);
      expect(edited.report.limitations.some((line: string) => line.includes('runtime execution'))).toBe(true);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 360_000);
});

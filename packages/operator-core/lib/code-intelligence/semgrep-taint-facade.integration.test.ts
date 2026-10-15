import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import structural from '../agent-tools/lsp/astgrep';
import { SEMGREP_CORE_SHA256, semgrepIdentity, type TaintAnswer } from './semgrep-taint-facade';

const fixtures = JSON.parse(readFileSync(new URL('../../../../docs/evidence/native-code-intelligence-p031-analyzer-admission-2026-10-14.json', import.meta.url), 'utf8')).referenceFixtures.cases as Array<{ language: string; file: string; source: string; positiveSinkLine: number }>;
const aliases: Record<string, string> = { typescript: 'ts', javascript: 'js', python: 'python', go: 'go', rust: 'rust' };
const patterns = { sources: ['untrusted()'], sinks: ['sink($VALUE)'], sanitizers: ['sanitize(...)'] };
async function analyze(root: string, language: string, paths: string[], taint = patterns): Promise<TaintAnswer> {
  return (await structural.handler(structural.args.parse({ op: 'taint', language, rootPath: root, paths, taint }),
    { projectDir: root } as never) as { data: TaintAnswer }).data;
}

describe('native P031 maintained local-taint reference evaluation', () => {
  it('requires the exact admitted runtime and complete packaged library closure', async () => {
    const identity = await semgrepIdentity();
    expect(identity.version).toBe('1.180.0');
    expect(identity.binarySha256).toBe(SEMGREP_CORE_SHA256);
    expect(identity.license).toBe('LGPL-2.1-or-later');
  });
  it.each(fixtures)('distinguishes local data dependence from literal, sanitizer and overwritten negatives ($language)', async fixture => {
    const root = mkdtempSync(join(tmpdir(), 'native-taint-reference-'));
    try {
      const file = join(root, fixture.file);
      writeFileSync(file, fixture.source);
      const result = await analyze(root, aliases[fixture.language], [fixture.file]);
      expect(result.error, JSON.stringify(result)).toBeNull();
      expect(result.freshness).toEqual({ health: 'healthy', staleVsDisk: false });
      expect(result.scanCoverage).toEqual({ requested: 1, scanned: 1, complete: true });
      expect(result.findings.map(finding => finding.line1)).toEqual([fixture.positiveSinkLine]);
      expect(result.sources).toEqual([{ path: fixture.file, language: aliases[fixture.language],
        contentHash: createHash('sha256').update(fixture.source).digest('hex') }]);
      expect(result.ruleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.findings[0]).toMatchObject({ knowledge: 'inferred', runtimeExecution: 'unknown' });
      expect(result.dynamicBoundary).toBe('unknown');
      expect(result.limitations.join(' ')).toContain('callback targets');
      expect(readFileSync(file, 'utf8')).toBe(fixture.source);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
  it('accounts for every selected source before returning a healthy empty finding set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-taint-complete-negatives-'));
    try {
      for (const file of ['first.ts', 'second.ts']) writeFileSync(join(root, file), 'function literal_negative() { sink("safe"); }\n');
      const result = await analyze(root, 'ts', ['first.ts', 'second.ts']);
      expect(result.error, JSON.stringify(result)).toBeNull();
      expect(result.findings).toEqual([]);
      expect(result.scanCoverage).toEqual({ requested: 2, scanned: 2, complete: true });
      expect(result.sources.map(source => source.path)).toEqual(['first.ts', 'second.ts']);
      expect(result.sourceCompleteness).toBe('unverified');
      expect(result.dynamicBoundary).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
  it('refuses an out-of-scope symlink before interpreting analyzer output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-taint-scope-'));
    const outside = mkdtempSync(join(tmpdir(), 'native-taint-outside-'));
    try {
      writeFileSync(join(outside, 'source.ts'), fixtures[0].source);
      symlinkSync(join(outside, 'source.ts'), join(root, 'source.ts'));
      const result = await analyze(root, 'ts', ['source.ts']);
      expect(result.error).toContain('outside source scope');
      expect(result.findings).toEqual([]);
      expect(result.freshness.health).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
  it('reports a malformed rule as unavailable analysis rather than a safe empty result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-taint-invalid-rule-'));
    try {
      writeFileSync(join(root, 'source.ts'), fixtures[0].source);
      const result = await analyze(root, 'ts', ['source.ts'], { ...patterns, sources: ['function ('] });
      expect(result.error).not.toBeNull();
      expect(result.freshness.health).toBe('unknown');
      expect(result.dynamicBoundary).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
});

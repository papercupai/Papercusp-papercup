import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const parser = vi.hoisted(() => ({ version: '0.45.1', inputs: [] as Buffer[] }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn().mockResolvedValue(true) }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, existsSync: (path: string) => path.includes('.papercusp/vendor/ast-grep') || fs.existsSync(path) };
});
vi.mock('node:child_process', async original => {
  const childProcess = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = vi.fn((_bin: string, _args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => ({
    stdin: { on: vi.fn(), end: (bytes: Buffer) => {
      parser.inputs.push(Buffer.from(bytes));
      callback(null, JSON.stringify([{ ruleId: 'declaration', text: 'function target() {}', range: { start: { line: 1 } } }]), '');
    } },
  }));
  Object.defineProperty(execFile, promisify.custom, { value: async () => ({ stdout: 'ast-grep ' + parser.version }) });
  return { ...childProcess, execFile };
});
import { astGrepSyntaxIndex, buildSyntaxIndexArgs, SYNTAX_INDEX_KINDS } from './ast-grep-facade';
afterEach(() => { parser.version = '0.45.1'; parser.inputs = []; });

describe('P-005 syntax profile admission', () => {
  it('uses the maintained grammars in read-only stdin mode', () => {
    for (const language of Object.keys(SYNTAX_INDEX_KINDS) as Array<keyof typeof SYNTAX_INDEX_KINDS>) {
      const args = buildSyntaxIndexArgs(language);
      expect(args).toContain('--stdin');
      expect(args).toContain('--json=compact');
      expect(args).not.toContain('--update-all');
      expect(args).not.toContain('-U');
      expect(args.join(' ')).toContain('declaration');
      expect(args.join(' ')).toContain('imports');
    }
  });
  it('rejects an unadmitted grammar instead of certifying an empty result', async () => {
    const result = await astGrepSyntaxIndex({ language: 'cpp' as 'ts', rootPath: '/absent', paths: ['x.cpp'] });
    expect(result.error).toContain('unsupported');
    expect(result.freshness.health).toBe('unknown');
    expect(result.sites).toEqual([]);
    expect(() => buildSyntaxIndexArgs('cpp' as 'ts')).toThrow(/unsupported/);
  });
  it('retains inferred syntax and the exact stdin identity without compiler resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'syntax-unit-'));
    const text = 'import { missing } from "unavailable";\nfunction target() {}\n';
    writeFileSync(join(root, 'probe.ts'), text);
    try {
      const result = await astGrepSyntaxIndex({ language: 'ts', rootPath: root, paths: ['probe.ts'] });
      expect(result.error).toBeNull();
      expect(result.sites).toHaveLength(1);
      expect(result.evidence?.relationships).toEqual([{ siteIndex: 0, kind: 'structural-search', origin: 'syntax', knowledge: 'inferred', runtimeExecution: 'unknown' }]);
      expect(result.evidence?.languageCapabilities).toEqual([{ language: 'ts', intent: 'structural-search', status: 'syntax-only' }]);
      expect(result.coverage?.sourceCompleteness).toBe('unverified');
      expect(result.evidence?.sourceScope.supportingFiles[0].contentHash).toBe(createHash('sha256').update(text).digest('hex'));
      expect(parser.inputs).toEqual([Buffer.from(text)]);
      expect(readFileSync(join(root, 'probe.ts'), 'utf8')).toBe(text);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses an unadmitted parser generation before scanning', async () => {
    parser.version = '0.45.2';
    const result = await astGrepSyntaxIndex({ language: 'ts', rootPath: '/absent', paths: ['probe.ts'] });
    expect(result.error).toContain('unsupported syntax-index grammar generation');
    expect(result.freshness.health).toBe('unknown');
    expect(parser.inputs).toEqual([]);
  });
});

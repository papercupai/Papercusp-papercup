import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { assertSemgrepManifest, decodeTaintOutput, provisionSemgrepRuntime,
  SEMGREP_RUNTIME_MANIFEST, SEMGREP_VERSION, semgrepTaint } from './semgrep-taint-facade';

describe('local-taint evidence admission boundaries', () => {
  const captured = new Map([['/captured/input.ts', 'source.ts']]);
  const complete = { version: SEMGREP_VERSION, results: [], errors: [], paths: { scanned: [...captured.keys()] }, skipped_rules: [] };
  it('refuses a progress/diagnostic prefix instead of silently discarding evidence', () => {
    const empty = JSON.stringify(complete);
    expect(() => decodeTaintOutput('.\n' + empty, captured)).toThrow();
    expect(() => decodeTaintOutput('warning: partial analysis\n' + empty, captured)).toThrow();
  });
  it('refuses partial/parser errors even when the analyzer returned no matches', () => {
    expect(() => decodeTaintOutput(JSON.stringify({ results: [], errors: [{ error_type: 'ParseError' }] }), captured)).toThrow('analysis_incomplete');
    expect(() => decodeTaintOutput(JSON.stringify({ results: [] }), captured)).toThrow('analysis_incomplete');
    expect(decodeTaintOutput(JSON.stringify(complete), captured)).toEqual([]);
  });
  it('refuses partial, duplicate, foreign or skipped scans even with zero findings and zero errors', () => {
    for (const change of [
      { paths: { scanned: [] } },
      { paths: { scanned: ['/captured/input.ts', '/captured/input.ts'] } },
      { paths: { scanned: ['/ambient/other.ts'] } },
      { paths: { scanned: [...captured.keys()], skipped: [{ path: '/captured/input.ts' }] } },
      { skipped_rules: [{ rule_id: 'native-local-taint' }] },
      { version: 'other' },
      { paths: null },
    ]) expect(() => decodeTaintOutput(JSON.stringify({ ...complete, ...change }), captured)).toThrow('analysis_incomplete');
  });
  it('refuses a self-consistent manifest substitution even if the library count is unchanged', () => {
    const manifest = structuredClone(SEMGREP_RUNTIME_MANIFEST);
    const names = Object.keys(manifest.libraryFiles) as Array<keyof typeof manifest.libraryFiles>;
    manifest.libraryFiles[names[0]] = '0'.repeat(64);
    expect(Object.keys(manifest.libraryFiles)).toHaveLength(Object.keys(SEMGREP_RUNTIME_MANIFEST.libraryFiles).length);
    expect(() => assertSemgrepManifest(manifest)).toThrow('library_closure_mismatch');
    expect(() => assertSemgrepManifest({ ...SEMGREP_RUNTIME_MANIFEST, distributionAdmission: true })).toThrow('not_admitted');
    expect(() => assertSemgrepManifest({ ...SEMGREP_RUNTIME_MANIFEST, sourceCommit: '0'.repeat(40) })).toThrow('not_admitted');
    expect(() => assertSemgrepManifest(SEMGREP_RUNTIME_MANIFEST)).not.toThrow();
  });
  it('preserves an existing unrecognized installation instead of overwriting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-taint-install-'));
    const receipt = JSON.stringify({ version: 'unrecognized' });
    try {
      writeFileSync(join(root, 'manifest.json'), receipt);
      await expect(provisionSemgrepRuntime(root)).rejects.toThrow('not_admitted');
      expect(readFileSync(join(root, 'manifest.json'), 'utf8')).toBe(receipt);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses to replace an existing incomplete installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-taint-incomplete-install-'));
    try {
      writeFileSync(join(root, 'keep'), 'foreign bytes');
      await expect(provisionSemgrepRuntime(root)).rejects.toThrow('existing_incomplete');
      expect(readFileSync(join(root, 'keep'), 'utf8')).toBe('foreign bytes');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('compiles for the CommonJS root and launches provisioning without touching the ambient runtime', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const script = new URL('../../../../scripts/provision-lsp.ts', import.meta.url);
    const home = mkdtempSync(join(tmpdir(), 'native-taint-cli-home-'));
    const vendor = join(home, 'vendor', 'semgrep', SEMGREP_VERSION);
    // Reuse cut-seed-cli.test.ts's guarded CLI pattern. This command loads
    // source only; scoped tsImport cannot resolve its CJS package subpaths.
    try {
      mkdirSync(vendor, { recursive: true });
      const marker = join(vendor, 'keep');
      writeFileSync(marker, 'foreign bytes');
      expect(() => transformSync(readFileSync(script, 'utf8'), { format: 'cjs', loader: 'ts' })).not.toThrow();
      const resolver = [
        'export async function resolve(specifier, context, nextResolve) {',
        '  const resolved = await nextResolve(specifier, context);',
        '  if (resolved.url.startsWith("file:") &&',
        '      (new URL(resolved.url).pathname.endsWith(".ts") || new URL(resolved.url).pathname.endsWith(".tsx")) &&',
        '      !resolved.url.includes("/node_modules/"))',
        '    return { ...resolved, format: "module-typescript" };',
        '  return resolved;',
        '}',
      ].join('\n');
      const bootstrap = [
        'import { register } from "node:module";',
        'register("data:text/javascript," + encodeURIComponent(' + JSON.stringify(resolver) + '), import.meta.url);',
        'process.argv = [process.execPath, ' + JSON.stringify(fileURLToPath(script)) + ', "semgrep"];',
        'await import(' + JSON.stringify(script.href) + ');',
      ].join('\n');
      let childError: unknown;
      try {
        await promisify(execFile)(process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', bootstrap],
          { cwd: root, env: { ...process.env, PAPERCUSP_HOME: home }, timeout: 30_000, maxBuffer: 16 * 1024 });
      } catch (error) { childError = error; }
      expect(childError).toBeInstanceOf(Error);
      expect((childError as { stderr?: string } | undefined)?.stderr).toContain('semgrep_runtime_existing_incomplete');
      expect(readFileSync(marker, 'utf8')).toBe('foreign bytes');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 45_000);
  it('refuses findings that cannot be tied to a captured path, rule and one-based location', () => {
    for (const row of [
      { path: '/ambient/other.ts', check_id: 'native-local-taint', start: { line: 1 } },
      { path: '/captured/input.ts', check_id: 'other-rule', start: { line: 1 } },
      { path: '/captured/input.ts', check_id: 'native-local-taint', start: { line: 0 } },
    ]) expect(() => decodeTaintOutput(JSON.stringify({ ...complete, results: [row] }), captured)).toThrow('uncited_finding');
  });
  it('refuses an unsupported grammar without claiming healthy emptiness or dynamic safety', async () => {
    const result = await semgrepTaint({ language: 'cpp', rootPath: '/absent', paths: ['x.cpp'] });
    expect(result.error).toContain('unsupported');
    expect(result.freshness.health).toBe('unknown');
    expect(result.dynamicBoundary).toBe('unknown');
    expect(result.limitations.join(' ')).toContain('not proof of safety');
  });
});

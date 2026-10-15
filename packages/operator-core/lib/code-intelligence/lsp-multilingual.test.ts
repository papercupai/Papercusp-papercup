import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { languageForFile, LSP_LANGUAGES, readinessStrategyFor, resolveProjectRoot,
  resolveSymbolSearchScope, specForLanguage } from './lsp-adapter';
import { resolveLspDaemonDispatchContext } from './lsp-daemon-protocol';
import { initializeCapabilityObservations, LspUnsupportedIntentError, requireLspCapability } from './lsp-capability-matrix';
import lspQueryTool from '../agent-tools/lsp/query';

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'lsp-languages-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('P-004 compiler language profiles', () => {
  it.each([['a.js', 'typescript'], ['a.tsx', 'typescript'], ['a.rs', 'rust'],
    ['a.py', 'python'], ['a.pyi', 'python'], ['a.go', 'go'], ['a.cpp', null]])('routes %s to its own server', (file, language) => {
    expect(languageForFile(file)).toBe(language);
  });
  it('admits the same closed language cohort through the native tool', () => {
    expect(lspQueryTool.args.shape.language.unwrap().options).toEqual([...LSP_LANGUAGES]);
    expect(lspQueryTool.args.safeParse({ op: 'workspace_symbols', language: 'cpp', name: 'target' }).success).toBe(false);
  });
  it.each(['python', 'go'] as const)('%s does not inherit Rust initialization or completeness', language => {
    const spec = specForLanguage(language);
    expect(spec.languageId).toBe(language);
    expect(spec.initializationOptions('/project')).not.toHaveProperty('cargo');
    expect(spec.serverArgs).toEqual(language === 'python' ? ['--stdio'] : ['serve']);
    for (const intent of ['definition', 'references', 'implementations'] as const)
      expect(readinessStrategyFor(language, intent).kind).toBe('canary-query');
  });
  it.each([['rust', 'Cargo.toml', 'x.rs'], ['python', 'pyproject.toml', 'x.py'],
    ['go', 'go.mod', 'x.go']] as const)('%s resolves the intended project and shares it with daemon admission', (language, marker, file) => {
    const root = fixture();
    for (const project of ['a', 'b']) {
      mkdirSync(join(root, project, 'src'), { recursive: true });
      writeFileSync(join(root, project, marker), '');
      writeFileSync(join(root, project, 'src', file), '');
    }
    const anchor = join(root, 'b', 'src', file);
    expect(resolveProjectRoot(language, anchor, root)).toEqual({ root: join(root, 'b'), error: null });
    const context = resolveLspDaemonDispatchContext({ op: 'references', args: { file: anchor, rootPath: root } }, new AbortController().signal);
    expect(context).toMatchObject({ language, projectRoot: join(root, 'b') });
    expect(resolveSymbolSearchScope(language, anchor, root).root).toBe(join(root, 'b'));
  });
  it.each([['python', 'x.py'], ['go', 'x.go']] as const)('%s refuses missing build/project prerequisites', (language, file) => {
    const root = fixture(); const anchor = join(root, file); writeFileSync(anchor, '');
    expect(resolveProjectRoot(language, anchor, root).error).toMatch(/no .*verified project\/build scope/);
    expect(resolveSymbolSearchScope(language, undefined, root).error).toMatch(/requires a source file anchor/);
    expect(resolveSymbolSearchScope(language, root, root).error).toMatch(/unsupported/);
  });
  it('does not walk into a same-prefix sibling or a symlink outside the requested project', () => {
    const root = fixture(); const project = join(root, 'app'); const other = join(root, 'app-other');
    mkdirSync(project); mkdirSync(other); writeFileSync(join(other, 'go.mod'), ''); writeFileSync(join(other, 'x.go'), '');
    symlinkSync(join(other, 'x.go'), join(project, 'linked.go'));
    for (const file of [join(other, 'x.go'), join(project, 'linked.go')]) {
      expect(resolveProjectRoot('go', file, project).error).toMatch(/outside project boundary/);
      expect(resolveSymbolSearchScope('go', file, project).error).toMatch(/outside project boundary/);
    }
  });
  it.each(['python', 'go', 'rust'] as const)('%s capabilities remain per intent and refuse unsupported implementations', async language => {
    const observations = initializeCapabilityObservations(language, 'a'.repeat(64), { definitionProvider: true });
    const key = { language, serverIdentity: 'a'.repeat(64), intent: 'implementations' as const };
    const store = { get: async () => observations.find(row => row.intent === key.intent) ?? null, observe: async () => {} };
    await expect(requireLspCapability(store, key)).rejects.toBeInstanceOf(LspUnsupportedIntentError);
    expect(observations.find(row => row.intent === 'definition')?.supported).toBe(true);
  });
});

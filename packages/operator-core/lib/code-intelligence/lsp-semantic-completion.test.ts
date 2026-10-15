import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import semanticCompletionPlugin, { registerNativeSemanticCompletion, requestSemanticCompletion,
  semanticCompletionPlugins,
  SEMANTIC_COMPLETION_SCHEMA, SEMANTIC_COMPLETION_TYPESCRIPT_VERSION,
  type NativeSemanticSession, type SemanticCompletionRequest } from './lsp-semantic-completion';

const request: SemanticCompletionRequest = { file: '/repo/target.ts', line: 2, offset: 1,
  population: [{ projectName: '/repo/tsconfig.json', anchorFile: '/repo/target.ts',
    files: ['/repo/target.ts', '/repo/consumer.ts', '/repo/tsconfig.json'] }] };
function fixture() {
  let cancelled = false;
  let enabled = true;
  let files = [...request.population[0].files];
  let extra = false;
  let handler: Parameters<NativeSemanticSession['addProtocolHandler']>[1] | undefined;
  const project = { getProjectName: () => '/repo/tsconfig.json', getFileNames: () => files,
    isOrphan: () => false, get languageServiceEnabled() { return enabled; } };
  const session: NativeSemanticSession = {
    cancellationToken: { isCancellationRequested: () => cancelled },
    projectService: { forEachProject: cb => { cb(project); if (extra) cb({ ...project,
      getProjectName: () => '/repo/extra/tsconfig.json' }); } },
    getCanonicalFileName: file => file,
    getProjectInfoWorker: vi.fn(),
    getReferences: vi.fn(() => ({ refs: [] })),
    addProtocolHandler: vi.fn((_command, callback) => { handler = callback; }),
  };
  return { session, cancel: () => { cancelled = true; }, disable: () => { enabled = false; },
    omit: () => { files = files.filter(file => !file.endsWith('consumer.ts')); },
    addFile: () => { files.push('/repo/unexpected.ts'); }, addProject: () => { extra = true; },
    invoke: (args = request) => { registerNativeSemanticCompletion(session, '6.0.3'); return handler!({ arguments: args }); } };
}

describe('candidate semantic completion refusal boundary', () => {
  it('allows an unchanged complete declared population after native traversal', () => {
    const f = fixture();
    expect(f.invoke()).toMatchObject({ responseRequired: true, response: { refs: [], population:
      [{ ...request.population[0], files: [...request.population[0].files].sort() }] } });
    expect(f.session.getProjectInfoWorker).toHaveBeenCalledTimes(2);
  });
  it.each(['omit', 'addFile', 'addProject', 'disable'] as const)('refuses %s before traversal', control => {
    const f = fixture(); f[control]();
    expect(() => f.invoke()).toThrow(/refused/);
    expect(f.session.getReferences).not.toHaveBeenCalled();
  });
  it('refuses missing declared projects even when a smaller census is successful', () => {
    const f = fixture();
    expect(() => f.invoke({ ...request, population: [...request.population,
      { projectName: '/repo/missing.json', anchorFile: '/repo/missing.ts', files: ['/repo/missing.ts'] }] })).toThrow(/population-mismatch/);
  });
  it.each(['omit', 'addFile'] as const)('preserves independently declared versus native %s diagnostics', control => {
    const f = fixture(); f[control]();
    const expected = control === 'omit' ? { missingCount: 1, extraCount: 0,
      missingFiles: ['/repo/consumer.ts'], extraFiles: [] } : { missingCount: 0, extraCount: 1,
      missingFiles: [], extraFiles: ['/repo/unexpected.ts'] };
    let diagnostic: unknown;
    try { f.invoke(); } catch (error) {
      diagnostic = JSON.parse((error as Error).message.split('project-or-file-population-mismatch:')[1]);
    }
    expect(diagnostic).toEqual({ projectCount: 1, projects: [{ projectName: '/repo/tsconfig.json',
      missingProject: false, ...expected }] });
    expect(f.session.getReferences).not.toHaveBeenCalled();
    expect(request.population[0].files).toHaveLength(3);
  });
  it('refuses cancellation before traversal', () => {
    const f = fixture(); f.cancel();
    expect(() => f.invoke()).toThrow(/cancelled/);
    expect(f.session.getReferences).not.toHaveBeenCalled();
  });
  it('refuses partial refs returned after native traversal cancels', () => {
    const f = fixture(); vi.mocked(f.session.getReferences).mockImplementation(() => { f.cancel(); return { refs: [] }; });
    expect(() => f.invoke()).toThrow(/cancelled/);
  });
  it('refuses population drift during native traversal', () => {
    const f = fixture(); vi.mocked(f.session.getReferences).mockImplementation(() => { f.omit(); return { refs: [] }; });
    expect(() => f.invoke()).toThrow(/population-mismatch/);
  });
  it('refuses a native canceled body despite available refs', () => {
    const f = fixture(); vi.mocked(f.session.getReferences).mockReturnValue({ canceled: true, refs: [] });
    expect(() => f.invoke()).toThrow(/incomplete-native-result/);
  });
  it('refuses unsupported native versions and missing methods', () => {
    const f = fixture();
    expect(() => registerNativeSemanticCompletion(f.session, '6.0.4')).toThrow(/unsupported/);
    expect(() => registerNativeSemanticCompletion({ ...f.session, getReferences: undefined } as unknown as NativeSemanticSession, '6.0.3')).toThrow(/unsupported/);
  });
  it('registers once across multiple project plugin instances without replacing the language service', () => {
    const f = fixture(); const service = {};
    const plugin = semanticCompletionPlugin({ typescript: { version: '6.0.3' } });
    expect(plugin.create({ session: f.session, languageService: service })).toBe(service);
    plugin.create({ session: f.session, languageService: service });
    expect(f.session.addProtocolHandler).toHaveBeenCalledTimes(1);
  });
  it('registers once across separate project factories on the same native session', () => {
    const f = fixture(); const firstService = {}; const secondService = {};
    vi.mocked(f.session.addProtocolHandler).mockImplementationOnce(() => {})
      .mockImplementation(() => { throw new Error('Protocol handler already exists'); });
    const first = semanticCompletionPlugin({ typescript: { version: '6.0.3' } });
    const second = semanticCompletionPlugin({ typescript: { version: '6.0.3' } });
    expect(first.create({ session: f.session, languageService: firstService })).toBe(firstService);
    expect(second.create({ session: f.session, languageService: secondService })).toBe(secondService);
    expect(f.session.addProtocolHandler).toHaveBeenCalledTimes(1);
  });
  it('registers independently for distinct native sessions', () => {
    const first = fixture(); const second = fixture(); const service = {};
    const plugin = semanticCompletionPlugin({ typescript: { version: '6.0.3' } });
    plugin.create({ session: first.session, languageService: service });
    plugin.create({ session: second.session, languageService: service });
    expect(first.session.addProtocolHandler).toHaveBeenCalledTimes(1);
    expect(second.session.addProtocolHandler).toHaveBeenCalledTimes(1);
  });
  it('retries failed registration from a subsequent factory', () => {
    const f = fixture(); const service = {};
    vi.mocked(f.session.addProtocolHandler).mockImplementationOnce(() => { throw new Error('registration failed'); });
    const first = semanticCompletionPlugin({ typescript: { version: '6.0.3' } });
    const second = semanticCompletionPlugin({ typescript: { version: '6.0.3' } });
    expect(() => first.create({ session: f.session, languageService: service })).toThrow('registration failed');
    expect(second.create({ session: f.session, languageService: service })).toBe(service);
    expect(f.session.addProtocolHandler).toHaveBeenCalledTimes(2);
  });
  it.each(['before', 'after'] as const)('refuses outer cancellation %s the custom RPC', async when => {
    const token = { isCancellationRequested: when === 'before' };
    const send = vi.fn(async () => { token.isCancellationRequested = true; return {}; });
    await expect(requestSemanticCompletion(request, token, send)).rejects.toThrow(/outer-cancelled/);
    expect(send).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
  });
  it('refuses success:true/body.canceled from the native request boundary', async () => {
    await expect(requestSemanticCompletion(request, { isCancellationRequested: false }, async () =>
      ({ type: 'response', success: true, body: { canceled: true } }))).rejects.toThrow(/incomplete-native-response/);
  });
  it('binds the response to the predeclared population', async () => {
    const body = { schemaVersion: SEMANTIC_COMPLETION_SCHEMA, typescriptVersion: SEMANTIC_COMPLETION_TYPESCRIPT_VERSION,
      refs: [], population: request.population };
    await expect(requestSemanticCompletion(request, { isCancellationRequested: false }, async () =>
      ({ type: 'response', success: true, body }))).resolves.toEqual(body);
    await expect(requestSemanticCompletion(request, { isCancellationRequested: false }, async () =>
      ({ type: 'response', success: true, body: { ...body, population: [{ ...request.population[0], files: ['/repo/target.ts'] }] } }))).rejects.toThrow(/response-population-mismatch/);
  });
  it('captures caller population before an asynchronous RPC can mutate it', async () => {
    const input = structuredClone(request);
    const result = await requestSemanticCompletion(input, { isCancellationRequested: false }, async (_command, frozen) => {
      input.population[0].files.pop();
      expect(frozen.population[0].files).toHaveLength(3);
      return { type: 'response', success: true, body: { schemaVersion: SEMANTIC_COMPLETION_SCHEMA,
        typescriptVersion: SEMANTIC_COMPLETION_TYPESCRIPT_VERSION, refs: [], population: frozen.population } };
    });
    expect(result.population[0].files).toHaveLength(3);
  });
  it.each(['manifest', 'entry'] as const)('requires independently declared matching plugin %s bytes', file => {
    const location = mkdtempSync(join(tmpdir(), 'lsp-plugin-declaration-'));
    try {
      const root = join(location, 'node_modules', 'fixture-plugin'); mkdirSync(root, { recursive: true });
      const manifest = join(root, 'package.json'); const entry = join(root, 'index.cjs');
      writeFileSync(manifest, JSON.stringify({ name: 'fixture-plugin', main: 'index.cjs' }));
      writeFileSync(entry, 'module.exports = function() {};');
      const files = Object.fromEntries([manifest, entry].map(path => [path,
        createHash('sha256').update(readFileSync(path)).digest('hex')]));
      const plugin = { name: 'fixture-plugin', location, files };
      expect(semanticCompletionPlugins(plugin)).toEqual([{ name: plugin.name, location }]);
      const changed = file === 'manifest' ? manifest : entry;
      const missing = { ...files }; delete missing[changed];
      expect(() => semanticCompletionPlugins({ ...plugin, files: missing })).toThrow('plugin-byte-mismatch');
      writeFileSync(changed, readFileSync(changed, 'utf8') + '\n');
      expect(() => semanticCompletionPlugins(plugin)).toThrow('plugin-byte-mismatch');
    } finally { rmSync(location, { recursive: true, force: true }); }
  });
});

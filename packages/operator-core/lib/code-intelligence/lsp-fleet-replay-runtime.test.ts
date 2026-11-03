import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import ts from 'typescript';
import { assertReplayOracleRuntimeQualified, assertReplaySemanticGraph, replaySemanticCompletionContext, freezeCompilerReplayConfig, freezeQualifiedReplayConfig, freezeReplayRuntimeFiles, materializeReplaySource, replayBoundaryProblems, replayDurableReport, replayEvidenceProblems, replayFileMismatches, replayHash, replayOracleFingerprint,
  replayPackageRuntimeSources, replayPopulationFingerprint, replayProcessIdentity, replayRepositorySources, replayServerPopulation, replaySourceFingerprint, replayWireOverlap,
  runDaemonReplay, validateDaemonReplayConfig, type DaemonReplayConfig, type ReplayBoundary, type ReplayOracleInput } from './lsp-fleet-replay-runtime';
import { callLspDaemonRpc, readLspDaemonAdmission } from './lsp-daemon-client';
import { scopeUnitForTask } from '../task-manager/types';
import { verifierSourceFiles, type VerifierSourceReceipt } from '../verifier-source';
import { buildReplayTrace, type ReplayReport } from './lsp-fleet-replay';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { runSaturationCli } from './lsp-saturation-bench-cli';
import { semanticCompletionPlugins } from './lsp-semantic-completion';
import { resolveLspVendorDir, resolveTsserverPath, specForLanguage } from './lsp-adapter';

vi.mock('./code-intel-bench.ts', () => { throw new Error('legacy benchmark must not load in independent replay mode'); });
vi.mock('./lsp-daemon-client', () => ({ callLspDaemonRpc: vi.fn(), readLspDaemonAdmission: vi.fn() }));

const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('prelaunch replay runtime dependency population', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'lsp-runtime-population-')); roots.push(root);
    const modules = join(root, 'node_modules'); mkdirSync(modules);
    const pkg = join(modules, 'external'); mkdirSync(pkg);
    const entry = join(pkg, 'index.js'); writeFileSync(entry, 'module.exports = 7;');
    return { root, modules, pkg, entry };
  }
  it('freezes external files, canonical aliases and the declared native dependency graph before launch', () => {
    const f = fixture();
    const addon = join(f.pkg, 'pty.node'); writeFileSync(addon, 'native addon');
    const library = join(f.root, 'libutil.so.1'); writeFileSync(library, 'native library');
    symlinkSync('index.js', join(f.pkg, 'alias.js'));
    const files = freezeReplayRuntimeFiles([f.modules], { nativeDependencies: path => path === addon ? [library] : [] });
    expect(files[f.entry]).toBe(replayHash(readFileSync(f.entry)));
    expect(files[join(f.pkg, 'alias.js')]).toBe(files[f.entry]);
    expect(files[addon]).toBe(replayHash('native addon'));
    expect(files[library]).toBe(replayHash('native library'));
    writeFileSync(f.entry, 'module.exports = 8;');
    expect(replayFileMismatches(files)).toContain(`changed-file:${f.entry}`);
  });
  it('refuses a dependency symlink escaping the independently copied input root', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'live.js'), 'live donor');
    symlinkSync('../../live.js', join(f.pkg, 'live.js'));
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: () => [] })).toThrow('escaping-replay-runtime-link');
  });
  it('retains directory alias descendants regardless of canonical traversal order', () => {
    const f = fixture();
    const metadata = join(f.pkg, 'package.json'); writeFileSync(metadata, '{"main":"index.js"}');
    const alias = join(f.modules, 'alias'); symlinkSync('external', alias);
    for (const paths of [[f.pkg, alias], [alias, f.pkg], [f.modules]]) {
      const files = freezeReplayRuntimeFiles(paths, { nativeDependencies: () => [] });
      expect(files[join(alias, 'package.json')]).toBe(replayHash(readFileSync(metadata)));
      expect(files[join(alias, 'index.js')]).toBe(files[f.entry]);
      writeFileSync(metadata, '{"main":"changed.js"}');
      expect(replayFileMismatches(files)).toContain(`changed-file:${join(alias, 'package.json')}`);
      writeFileSync(metadata, '{"main":"index.js"}');
    }
  });
  it('refuses canonical directory cycles rather than silently dropping their descendants', () => {
    const f = fixture(); symlinkSync('.', join(f.pkg, 'loop'));
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: () => [] })).toThrow('cyclic-replay-runtime-link');
  });
  it('refuses missing transitive libraries and changed files instead of returning a partial population', () => {
    const f = fixture();
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: () => [join(f.root, 'missing.so')] })).toThrow();
    expect(() => freezeReplayRuntimeFiles([f.modules], { nativeDependencies: path => {
      writeFileSync(path, 'changed during dependency discovery'); return [];
    } })).toThrow('changed-during-replay-runtime-freeze');
  });
  it.each([
    { host: 'glibc', libc: ['musl'], excluded: true },
    { host: 'musl', libc: 'glibc', excluded: true },
    { host: 'glibc', libc: ['!glibc'], excluded: true },
    { host: 'glibc', libc: ['glibc'], excluded: false },
    { host: 'musl', libc: ['musl'], excluded: false },
    { host: 'unknown', libc: ['musl'], excluded: false },
    { host: 'glibc', libc: undefined, excluded: false },
    { host: 'glibc', libc: ['unknown'], excluded: false },
    { host: 'glibc', libc: ['any'], excluded: false },
  ])('freezes optional package bytes and refuses missing selected dependencies: $host/$libc', ({ host, libc, excluded }) => {
    const f = fixture();
    const addon = join(f.pkg, 'optional.node');
    const metadata = join(f.pkg, 'package.json');
    writeFileSync(metadata, JSON.stringify({ libc }));
    const header = Buffer.alloc(20);
    header.set([0x7f, 0x45, 0x4c, 0x46]); header[5] = 1;
    const machine: Partial<Record<typeof process.arch, number>> = { x64: 62, arm64: 183, ia32: 3, arm: 40 };
    header.writeUInt16LE(machine[process.arch] ?? 0, 18); writeFileSync(addon, header);
    const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: string[]) => {
      expect(command).toBe('ldd');
      if (args[0] === process.execPath) return host === 'glibc' ? 'libc.so.6 => /lib/libc.so.6 (0x1)' :
        host === 'musl' ? '/lib/ld-musl-x86_64.so.1 (0x1)' : 'statically linked';
      expect(args[0]).toBe(addon);
      return 'libmissing.so => not found';
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    try {
      if (excluded) {
        const files = freezeReplayRuntimeFiles([f.modules]);
        expect(files[addon]).toBe(replayHash(header));
        expect(files[metadata]).toBe(replayHash(readFileSync(metadata)));
        expect(spy.mock.calls.some(([, args]) => args?.[0] === addon)).toBe(false);
        writeFileSync(addon, 'changed foreign ABI bytes');
        expect(replayFileMismatches(files)).toContain(`changed-file:${addon}`);
      } else expect(() => freezeReplayRuntimeFiles([f.modules])).toThrow(`missing-replay-native-dependency:${addon}`);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it.each([
    { target: 'foreign', loader: 'require-addon', prebuilds: true, excluded: true },
    { target: 'foreign', loader: 'bare-addon', prebuilds: true, excluded: true },
    { target: 'foreign', loader: 'node-gyp-build', prebuilds: true, excluded: true },
    { target: 'foreign', loader: 'node-gyp-build-optional-packages', prebuilds: true, excluded: true },
    { target: 'host', loader: 'require-addon', prebuilds: true, excluded: false },
    { target: 'unknown', loader: 'require-addon', prebuilds: true, excluded: false },
    { target: 'foreign', loader: 'unknown-loader', prebuilds: true, excluded: false },
    { target: 'foreign', loader: undefined, prebuilds: true, excluded: false },
    { target: 'foreign', loader: 'require-addon', prebuilds: false, excluded: false },
  ])('freezes foreign prebuild bytes only for a declared maintained loader: $target/$loader/$prebuilds', ({ target, loader, prebuilds, excluded }) => {
    const f = fixture();
    const platform = target === 'host' ? process.platform : target === 'foreign' ?
      (process.platform === 'android' ? 'linux' : 'android') : 'unknown';
    const directory = join(f.pkg, prebuilds ? 'prebuilds' : 'other', `${platform}-${process.arch}`);
    mkdirSync(directory, { recursive: true });
    const addon = join(directory, 'addon.node');
    const metadata = join(f.pkg, 'package.json');
    writeFileSync(metadata, JSON.stringify({ dependencies: loader ? { [loader]: '^1.0.0' } : {} }));
    const header = Buffer.alloc(20);
    header.set([0x7f, 0x45, 0x4c, 0x46]); header[5] = 1;
    const machines: Partial<Record<typeof process.arch, number>> = { x64: 62, arm64: 183, ia32: 3, arm: 40 };
    header.writeUInt16LE(machines[process.arch] ?? 0, 18); writeFileSync(addon, header);
    const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: string[]) => {
      expect(command).toBe('ldd'); expect(args[0]).toBe(addon);
      return 'libmissing.so => not found';
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    try {
      if (excluded) {
        const files = freezeReplayRuntimeFiles([f.modules]);
        expect(files[addon]).toBe(replayHash(header));
        expect(files[metadata]).toBe(replayHash(readFileSync(metadata)));
        expect(spy).not.toHaveBeenCalled();
        writeFileSync(addon, 'changed foreign platform bytes');
        expect(replayFileMismatches(files)).toContain(`changed-file:${addon}`);
      } else expect(() => freezeReplayRuntimeFiles([f.modules])).toThrow(`missing-replay-native-dependency:${addon}`);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it.runIf(process.platform === 'linux').each([
    { host: 'glibc', abi: 'musl', loader: 'napi', excluded: true },
    { host: 'musl', abi: 'gnu', loader: 'napi', excluded: true },
    { host: 'glibc', abi: 'gnu', loader: 'napi', excluded: false },
    { host: 'musl', abi: 'musl', loader: 'napi', excluded: false },
    { host: 'unknown', abi: 'musl', loader: 'napi', excluded: false },
    { host: 'glibc', abi: 'musl', loader: 'unknown', excluded: false },
    { host: 'glibc', abi: 'unknown', loader: 'napi', excluded: false },
    { host: 'glibc', abi: 'musl', loader: 'node-gyp-build', excluded: true },
    { host: 'musl', abi: 'musl', loader: 'node-gyp-build', excluded: false },
  ])('freezes co-packaged Linux ABI bytes without traversing foreign dependencies: $host/$abi/$loader', ({ host, abi, loader, excluded }) => {
    const f = fixture();
    const directory = loader === 'node-gyp-build' ? join(f.pkg, 'prebuilds', `linux-${process.arch}-${abi}`) : f.pkg;
    mkdirSync(directory, { recursive: true });
    const addon = join(directory, loader === 'node-gyp-build' ? 'addon.node' : `external.linux-${process.arch}-${abi}.node`);
    const metadata = join(f.pkg, 'package.json');
    writeFileSync(metadata, JSON.stringify(loader === 'napi' ? { napi: { binaryName: 'external' } } :
      { dependencies: { [loader]: '^1.0.0' } }));
    const header = Buffer.alloc(20);
    header.set([0x7f, 0x45, 0x4c, 0x46]); header[5] = 1;
    const machines: Partial<Record<typeof process.arch, number>> = { x64: 62, arm64: 183, ia32: 3, arm: 40 };
    header.writeUInt16LE(machines[process.arch] ?? 0, 18); writeFileSync(addon, header);
    const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: string[]) => {
      expect(command).toBe('ldd');
      if (args[0] === process.execPath) return host === 'glibc' ? 'libc.so.6 => /lib/libc.so.6 (0x1)' :
        host === 'musl' ? '/lib/ld-musl-x86_64.so.1 (0x1)' : 'statically linked';
      expect(args[0]).toBe(addon);
      return 'libmissing.so => not found';
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    try {
      if (excluded) {
        const files = freezeReplayRuntimeFiles([f.modules]);
        expect(files[addon]).toBe(replayHash(header));
        expect(files[metadata]).toBe(replayHash(readFileSync(metadata)));
        expect(spy.mock.calls.some(([, args]) => args?.[0] === addon)).toBe(false);
        writeFileSync(addon, 'changed foreign ABI bytes');
        expect(replayFileMismatches(files)).toContain(`changed-file:${addon}`);
      } else expect(() => freezeReplayRuntimeFiles([f.modules])).toThrow(`missing-replay-native-dependency:${addon}`);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it.runIf(process.platform === 'linux')('captures the actual Node ELF dependency graph with the default scanner', () => {
    const files = freezeReplayRuntimeFiles([process.execPath]);
    const libraries = [...execFileSync('ldd', [process.execPath], { encoding: 'utf8' })
      .matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s+\(/gm)].map(match => realpathSync(match[1]));
    expect(libraries.length).toBeGreaterThan(0);
    for (const file of [realpathSync(process.execPath), ...libraries])
      expect(files[file]).toBe(replayHash(readFileSync(file)));
  });
});
describe('independently declared semantic graph', () => {
  function fixture(options: Record<string, unknown> = {}) {
    const frozen = config();
    const root = frozen.rootPath;
    writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], ...options } }));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', files: ['source.ts'] }));
    const runtimeFile = join(root, 'runtime.cjs'); writeFileSync(runtimeFile, 'module.exports = 1;');
    const input: ReplayOracleInput = { runId: 'declared-graph', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 1000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [runtimeFile], evidenceRef: 'independent-graph-fixture' };
    return { root, runtimeFile, input };
  }
  it('retains the predeclared service runtime alongside the independent compiler graph', () => {
    const f = fixture({ noLib: true });
    const runtimeWitness = { directory: join(f.root, 'service-receipts'), runId: f.input.runId,
      bootstraps: {}, files: { [f.runtimeFile]: replayHash(readFileSync(f.runtimeFile)) } };
    const frozen = freezeCompilerReplayConfig({ ...f.input, runtimeWitness });
    expect(frozen.runtimeWitness).toEqual(runtimeWitness);
    expect(frozen.files[f.runtimeFile]).toBe(runtimeWitness.files[f.runtimeFile]);
    expect(assertReplaySemanticGraph(frozen).projects[0].files).not.toContain(f.runtimeFile);
  });
  it('retains configured roots, imported declarations, libraries and inherited config without runtime files', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'source.ts'), "import './ambient';\nexport function hot() {}\nhot();\n");
    writeFileSync(join(f.root, 'ambient.d.ts'), 'declare const ambient: string;');
    const input = { ...f.input, definition: { file: 'source.ts', line1: 3, character: 1 },
      references: { file: 'source.ts', line1: 3, character: 1 } };
    const frozen = freezeCompilerReplayConfig(input);
    const graph = assertReplaySemanticGraph(frozen);
    const project = graph.projects[0];
    expect(project.rootNames).toEqual([join(f.root, 'source.ts')]);
    expect(project.configFiles).toEqual([join(f.root, 'base.json'), join(f.root, 'tsconfig.json')]);
    expect(project.files).toEqual(expect.arrayContaining([...project.configFiles, join(f.root, 'source.ts'), join(f.root, 'ambient.d.ts')]));
    expect(project.files).toContain(ts.getDefaultLibFilePath(project.compilerOptions as ts.CompilerOptions));
    expect(project.compilerOptions.strict).toBe(true);
    expect(project.compilerOptions).not.toHaveProperty('configFile');
    expect(project.files).not.toContain(f.runtimeFile);
    expect(frozen.files[f.runtimeFile]).toBeTruthy();
    expect(graph.compilerVersion).toBe(ts.version);
    const compilerPaths = Object.keys(graph.compilerEntries);
    expect(compilerPaths.some(file => file.endsWith('/typescript/lib/typescript.js'))).toBe(true);
    expect(compilerPaths.some(file => file.endsWith('/@typescript/old/lib/typescript.js'))).toBe(true);
    for (const file of [...project.files, ...compilerPaths]) expect(frozen.files[file]).toBe(replayHash(readFileSync(file)));
  });
  it('refuses a project reference before loading an incomplete compiler graph', () => {
    const f = fixture({ noLib: true });
    mkdirSync(join(f.root, 'other'));
    writeFileSync(join(f.root, 'other', 'tsconfig.json'), JSON.stringify({ compilerOptions: { composite: true }, files: [] }));
    writeFileSync(join(f.root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], references: [{ path: './other' }] }));
    const phases: string[] = [];
    expect(() => freezeCompilerReplayConfig(f.input, { onProgress: row => phases.push(row.phase) }))
      .toThrow('replay-semantic-project-references-unsupported');
    expect(phases).not.toContain('compiler-loaded');
  });
  it('uses the declared compiler and its own libraries instead of the freezer compiler', () => {
    const f = fixture({ lib: ['es5'] });
    const directory = join(f.root, 'compiler', 'lib');
    cpSync(dirname(createRequire(import.meta.url).resolve('@typescript/old')), directory, { recursive: true });
    const compilerEntry = join(directory, 'typescript.js');
    const alias = join(f.root, 'compiler.cjs'); symlinkSync(compilerEntry, alias);
    const frozen = freezeCompilerReplayConfig({ ...f.input, compilerEntry: alias });
    const graph = assertReplaySemanticGraph(frozen);
    expect(Object.keys(graph.compilerEntries)).toEqual([compilerEntry]);
    expect(graph.projects[0].files).toContain(join(directory, 'lib.es5.d.ts'));
    expect(graph.projects[0].files).not.toContain(join(dirname(ts.getDefaultLibFilePath({})), 'lib.es5.d.ts'));
    expect(frozen.files[compilerEntry]).toBe(replayHash(readFileSync(compilerEntry)));
    expect(frozen.corpus['hot-references'].oracle.sites).toEqual(
      expect.arrayContaining([{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]));
  });
  it('refuses relative, directory and unsupported-version compiler entries before parsing', () => {
    const f = fixture();
    const phases: string[] = [];
    const options = { onProgress: (row: { phase: string }) => phases.push(row.phase) };
    expect(() => freezeCompilerReplayConfig({ ...f.input, compilerEntry: './compiler.cjs' }, options))
      .toThrow('replay-semantic-compiler-entry-absolute');
    expect(() => freezeCompilerReplayConfig({ ...f.input, compilerEntry: f.root }, options))
      .toThrow('replay-semantic-compiler-entry-invalid');
    const compilerEntry = join(f.root, 'compiler.cjs');
    writeFileSync(compilerEntry, "module.exports = { version: '0.0.0' };");
    expect(() => freezeCompilerReplayConfig({ ...f.input, compilerEntry }, options))
      .toThrow('replay-semantic-compiler-version-unsupported');
    expect(phases).toEqual([]);
  });
  it('refuses a canonical compiler escape before executing its entry', () => {
    const f = fixture();
    const external = mkdtempSync(join(tmpdir(), 'lsp-external-compiler-')); roots.push(external);
    const marker = join(external, 'executed'); const entry = join(external, 'compiler.cjs');
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const alias = join(f.root, 'compiler.cjs'); symlinkSync(entry, alias);
    expect(() => freezeCompilerReplayConfig({ ...f.input, compilerEntry: alias,
      sourceSnapshot: { manifestPath: join(f.root, 'snapshot.json'), sha256: '0'.repeat(64) } }))
      .toThrow('snapshot-input-escape');
    expect(existsSync(marker)).toBe(false);
  });
  it.each(['absolute', 'relative', 'symlink'])('rejects a %s snapshot runtime escape before compiler execution or parent census', async kind => {
    const f = fixture({ noLib: true });
    const externalRoot = mkdtempSync(join(tmpdir(), 'lsp-external-runtime-')); roots.push(externalRoot);
    const external = join(externalRoot, 'launcher'); writeFileSync(external, 'external launcher');
    const marker = join(f.root, 'compiler-executed');
    const compilerEntry = join(f.root, 'compiler.cjs');
    writeFileSync(compilerEntry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const alias = join(f.root, 'launcher'); symlinkSync(external, alias);
    const runtimeFile = kind === 'absolute' ? external : kind === 'relative' ? relative(f.root, external) : alias;
    const input: ReplayOracleInput = { ...f.input, compilerEntry, runtimeFiles: [runtimeFile],
      sourceSnapshot: { manifestPath: join(f.root, 'snapshot.json'), sha256: '0'.repeat(64) },
      // Declaring an external executable witness does not turn it into copied source.
      runtimeWitness: { directory: join(externalRoot, 'service'), runId: f.input.runId,
        bootstraps: {}, files: { [external]: replayHash(readFileSync(external)) } } };
    const phases: string[] = [];
    expect(() => freezeCompilerReplayConfig(input, { onProgress: row => phases.push(row.phase) }))
      .toThrow(`snapshot-input-escape:${external}`);
    expect(phases).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    const inputPath = join(externalRoot, 'input.json'); writeFileSync(inputPath, JSON.stringify(input));
    const outputPath = join(externalRoot, 'qualified.json'); const witnessDirectory = join(externalRoot, 'oracle');
    const nativeDependencies = vi.fn(() => []);
    await expect(freezeQualifiedReplayConfig(inputPath, outputPath, { freezerEntry: compilerEntry,
      compilerEntries: [compilerEntry], runtimePaths: [external], witnessDirectory, timeoutMs: 1000 },
    { nativeDependencies })).rejects.toThrow(`snapshot-input-escape:${external}`);
    expect(nativeDependencies).not.toHaveBeenCalled();
    expect(existsSync(witnessDirectory)).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
  it('retains external runtime inputs for a source-only oracle without a snapshot claim', () => {
    const f = fixture({ noLib: true });
    const externalRoot = mkdtempSync(join(tmpdir(), 'lsp-source-only-runtime-')); roots.push(externalRoot);
    const external = join(externalRoot, 'launcher'); writeFileSync(external, 'external launcher');
    const frozen = freezeCompilerReplayConfig({ ...f.input, runtimeFiles: [external] });
    expect(frozen.files[external]).toBe(replayHash(readFileSync(external)));
    expect(frozen.corpus['hot-references'].oracle.sites).toHaveLength(2);
    expect(() => assertReplayOracleRuntimeQualified(frozen)).toThrow('replay-oracle-runtime-unmeasured');
  });
  it('refuses an unconfigured cursor instead of silently adding it to roots', () => {
    const f = fixture({ noLib: true });
    writeFileSync(join(f.root, 'outside.ts'), 'export function outside() {}\noutside();');
    expect(() => freezeCompilerReplayConfig({ ...f.input, definition: { file: 'outside.ts', line1: 2, character: 1 } }))
      .toThrow('oracle cursor outside compiler population');
  });
  it.each(['compiler-version', 'config', 'root', 'duplicate-file', 'compiler-entry'])('refuses a changed declaration: %s', change => {
    const f = fixture({ noLib: true });
    const frozen = freezeCompilerReplayConfig(f.input);
    const graph = JSON.parse(JSON.stringify(frozen.semanticGraph)) as NonNullable<DaemonReplayConfig['semanticGraph']>;
    const project = graph.projects[0];
    if (change === 'compiler-version') Object.assign(graph, { compilerVersion: 'other' });
    if (change === 'config') project.files.splice(project.files.indexOf(project.projectName), 1);
    if (change === 'root') project.rootNames.push(join(f.root, 'unfrozen.ts'));
    if (change === 'duplicate-file') project.files.push(project.files[0]);
    if (change === 'compiler-entry') Object.assign(graph, { compilerEntries: { [join(f.root, 'unfrozen.js')]: '0'.repeat(64) } });
    const { fingerprint: _fingerprint, ...declaration } = graph;
    Object.assign(graph, { fingerprint: replayHash(JSON.stringify(declaration)) });
    expect(() => assertReplaySemanticGraph({ ...frozen, semanticGraph: graph })).toThrow(/replay-semantic-/);
  });
  it('preserves absent historical declarations as unmeasured', () => {
    expect(() => assertReplaySemanticGraph(config())).toThrow('replay-semantic-graph-unmeasured');
  });
  it('binds the independent graph to matching source and runtime plugin bytes', () => {
    const f = fixture({ noLib: true });
    const location = join(f.root, 'probe'); const root = join(location, 'node_modules', 'fixture-plugin');
    mkdirSync(root, { recursive: true });
    const manifest = join(root, 'package.json'); const entry = join(root, 'index.cjs');
    writeFileSync(manifest, JSON.stringify({ name: 'fixture-plugin', main: 'index.cjs' }));
    writeFileSync(entry, 'module.exports = function() {};');
    const files = Object.fromEntries([manifest, entry].map(file => [file, replayHash(readFileSync(file))]));
    const plugin = { name: 'fixture-plugin', location, files };
    const frozen = freezeCompilerReplayConfig({ ...f.input, runtimeFiles: [manifest, entry], semanticCompletionPlugin: plugin });
    const configured = { ...frozen, runtimeWitness: { directory: location, runId: frozen.runId, bootstraps: {}, files } };
    const context = replaySemanticCompletionContext(configured);
    expect(context.population).toEqual(frozen.semanticGraph!.projects.map(project => ({
      projectName: project.projectName, anchorFile: project.anchorFile, files: project.files })));
    context.population[0].files.pop();
    expect(context.population[0].files).not.toEqual(frozen.semanticGraph!.projects[0].files);
    expect(() => replaySemanticCompletionContext({ ...configured, semanticCompletionPlugin: undefined }))
      .toThrow('replay-semantic-plugin-unmeasured');
    expect(() => replaySemanticCompletionContext({ ...configured, runtimeWitness: { ...configured.runtimeWitness, files: {} } }))
      .toThrow('replay-semantic-plugin-unfrozen');
    expect(() => replaySemanticCompletionContext({ ...configured, files: { ...configured.files, [entry]: 'wrong' } }))
      .toThrow('replay-semantic-plugin-unfrozen');
    writeFileSync(entry, 'changed after declaration');
    expect(() => replaySemanticCompletionContext(configured)).toThrow('plugin-byte-mismatch');
  });
});
describe('oracle runtime acceptance prerequisite', () => {
  it('refuses a freezer child without an independent parent before reading compiler input', async () => {
    // Vitest workers themselves have IPC. Model a disconnected child explicitly.
    const connected = process.connected;
    try {
      process.connected = false;
      await expect(runSaturationCli(['node', 'cli', '--freeze-replay-child', '/missing/input', '/missing/output']))
        .rejects.toThrow('replay-oracle-parent-channel-required');
    } finally { process.connected = connected; }
  });
  it('refuses historical source-only proof before the CLI creates an archive or calls the daemon', async () => {
    const frozen = config();
    const input = join(frozen.rootPath, 'frozen.json');
    writeFileSync(input, JSON.stringify(frozen));
    expect(() => assertReplayOracleRuntimeQualified(frozen)).toThrow('replay-oracle-runtime-unmeasured');
    await expect(runSaturationCli(['node', 'cli', '--fleet-replay', input, frozen.rootPath]))
      .rejects.toThrow('replay-oracle-runtime-unmeasured');
    expect(existsSync(join(frozen.rootPath, frozen.runId))).toBe(false);
    expect(callLspDaemonRpc).not.toHaveBeenCalled();
  });
  it('refuses an independently copied repository oracle before a direct runner performs warmups', async () => {
    const frozen = config();
    const manifestPath = join(frozen.rootPath, 'manifest.json');
    writeFileSync(manifestPath, '{}');
    const files = { ...frozen.files, [manifestPath]: replayHash('{}') };
    const corpus = Object.fromEntries(Object.entries(frozen.corpus).map(([key, row]) =>
      [key, { ...row, oracle: { ...row.oracle, sourceFingerprint: replaySourceFingerprint(files) } }])) as DaemonReplayConfig['corpus'];
    const copied = { ...frozen, files, corpus, sourceSnapshot: { manifestPath, sha256: files[manifestPath] } };
    await expect(runDaemonReplay(copied, frozen.rootPath)).rejects.toThrow('replay-oracle-runtime-unmeasured');
    expect(existsSync(join(frozen.rootPath, frozen.runId))).toBe(false);
    expect(callLspDaemonRpc).not.toHaveBeenCalled();
  });
});
function config(): DaemonReplayConfig {
  const rootPath = mkdtempSync(join(tmpdir(), 'lsp-replay-config-')); roots.push(rootPath);
  const file = join(rootPath, 'source.ts');
  writeFileSync(file, 'export function hot() {}\nhot();\n');
  const files = { [file]: replayHash(readFileSync(file)) };
  const sites = [{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }];
  const make = (expected: typeof sites) => ({ cursor: { file, line1: 2, character: 1 },
    oracle: { sites: expected, sourceFingerprint: replaySourceFingerprint(files), oracleFingerprint: replayOracleFingerprint({ sites: expected }) } });
  return { schemaVersion: 'lsp-daemon-replay-config-v1', runId: 'source-oracle', rootPath, socketPath: join(rootPath, 'daemon.sock'),
    workspaceId: 'test', levels: [1, 8, 1000], requestTimeoutMs: 90_000,
    oracleProvenance: { method: 'source-authored exact locations', evidenceRef: 'fixture:source.ts' }, files,
    corpus: { definition: make(sites.slice(0, 1)), 'hot-references': make(sites) } };
}
function report(): ReplayReport {
  const population = buildReplayTrace(3, 'mixed', 'live');
  const samples = population.map(request => {
    const receiptId = `receipt/${request.id}`;
    const hot = request.queryClass === 'hot-references';
    const answer: LspDaemonAnswer = { backend: 'lsp-adapter', intent: hot ? 'references' : 'definition', query: 'hot', sites: [],
      truncation: { truncated: false, totalAvailable: 0, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 5, error: null,
      daemonEvidence: { requestId: request.id, daemonPid: 10, receivedAtMs: 1, respondedAtMs: hot ? 21 : 10,
        events: [{ phase: 'durable-enqueued', atMs: 2, receiptId }, { phase: 'durable-settled', atMs: hot ? 20 : 9, receiptId, confirmed: true }],
        wire: [{ method: hot ? 'textDocument/references' : 'textDocument/definition', taskId: 'server-task', pid: 11,
          startedAtMs: hot ? 4 : 5, endedAtMs: hot ? 18 : 7, outcome: 'response' }] } };
    return { request, issuedAtMs: 0, settledAtMs: 22, answer, transportError: null };
  });
  return { schemaVersion: 'lsp-fleet-replay-v1', concurrency: 3, mode: 'mixed', population, samples,
    classes: {} as ReplayReport['classes'], sourceFingerprint: 'source', oracleFingerprint: 'oracle',
    complete: true, accountingErrors: [], certifiedFalseEmpty: 0, certifiedStale: 0, failures: [], classesOverlap: true };
}
describe('daemon replay RPC cursor origin', () => {
  it.each(['relative', 'absolute'])('uses the declared source root for %s cursor files without rewriting the oracle', async kind => {
    const frozen = config();
    if (kind === 'relative') for (const corpus of Object.values(frozen.corpus)) corpus.cursor.file = 'source.ts';
    const original = JSON.stringify(frozen);
    vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) => {
      if (request.op === 'health') throw new Error('fixture-stop-before-load');
      return readyAnswer(frozen, request.op === 'symbol' ? 'definition' : 'hot-references');
    });
    await expect(runDaemonReplay(frozen, frozen.rootPath)).rejects.toThrow('fixture-stop-before-load');
    const queries = vi.mocked(callLspDaemonRpc).mock.calls.filter(([, request]) => request.op !== 'health');
    expect(queries.map(([, request]) => [request.op, request.args.file, request.args.rootPath]))
      .toEqual(['symbol', 'references'].map(op => [op, join(frozen.rootPath, 'source.ts'), frozen.rootPath]));
    expect(JSON.stringify(frozen)).toBe(original);
    expect(JSON.parse(readFileSync(join(frozen.rootPath, frozen.runId, 'config.json'), 'utf8')).config).toEqual(frozen);
  });
});
function readyAnswer(frozen: DaemonReplayConfig, queryClass: 'definition' | 'hot-references'): LspDaemonAnswer {
  const sites = frozen.corpus[queryClass].oracle.sites.map(site => ({ ...site, kind: 'function' }));
  return { backend: 'lsp-adapter', intent: queryClass === 'definition' ? 'definition' : 'references', query: 'fixture', sites,
    truncation: { truncated: false, totalAvailable: sites.length, continuation: null },
    freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 1, error: null };
}
describe('daemon replay readiness and runtime admission', () => {
  function boundary(frozen: DaemonReplayConfig): ReplayBoundary {
    const taskId = 'replayserver';
    const cgroup = `0::/papercusp.slice/${scopeUnitForTask(taskId)}`;
    const executable = { path: join(frozen.rootPath, 'source.ts'), sha256: frozen.files[join(frozen.rootPath, 'source.ts')] };
    const process = (pid: number) => ({ pid, identity: `fixture:${pid}`, cmdline: ['fixture'], cgroup, executable,
      loadedModules: { receipts: [], native: [], unknown: [] }, unknown: [] });
    return { label: 'fixture', atMs: 1, fileDrift: [],
      health: { ...readyAnswer(frozen, 'definition'), daemonRuntime: {
        enabled: true, overall: 'healthy', provisioned: {} as NonNullable<LspDaemonAnswer['daemonRuntime']>['provisioned'],
        pid: 10, node: executable.path, entry: executable.path, sampledAtMs: 1,
        servers: [{ language: 'typescript', rootPath: frozen.rootPath, taskId, pid: 11, health: 'healthy', coldStartMs: 1,
          openDocs: 1, everSettled: true, quiescent: true, pendingProgress: 0, progressGeneration: 1,
          certifiedReadiness: ['definition', 'references'], unprovenReadiness: [] }],
      } },
      processes: [process(10), process(11)],
      populations: [{ taskId, rootPid: 11, cgroup, groups: [], processes: [process(11), process(12)], unknown: [] }],
      admission: { queued: 0, inFlight: 0, settlementFailures: [] } };
  }
  function rows(frozen: DaemonReplayConfig, file: string) {
    return readFileSync(join(frozen.rootPath, frozen.runId, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  }
  it.each(['refusal', 'empty', 'degraded', 'stale', 'truncated', 'missing-site', 'unexpected-site'])
    ('archives a %s hot-reference warmup and issues no measured request', async failure => {
      const frozen = config();
      const answer = readyAnswer(frozen, 'hot-references');
      const failed: LspDaemonAnswer = { ...answer,
        error: failure === 'refusal' ? 'not ready' : null,
        sites: failure === 'empty' ? [] : failure === 'missing-site' ? answer.sites.slice(0, 1) :
          failure === 'unexpected-site' ? [...answer.sites, { path: 'source.ts', line1: 3, kind: 'function' }] : answer.sites,
        freshness: { ...answer.freshness, health: failure === 'degraded' ? 'degraded' : 'healthy', staleVsDisk: failure === 'stale' },
        truncation: { ...answer.truncation, truncated: failure === 'truncated' } };
      vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) =>
        request.op === 'symbol' ? readyAnswer(frozen, 'definition') : failed);
      await expect(runDaemonReplay(frozen, frozen.rootPath)).rejects.toThrow('replay-readiness-refused:hot-references:');
      expect(vi.mocked(callLspDaemonRpc).mock.calls.map(([, request]) => request.actorId)).toEqual(['warmup', 'warmup']);
      expect(rows(frozen, 'warmups.jsonl')).toHaveLength(2);
      expect(rows(frozen, 'preflights.jsonl')[0]).toMatchObject({ phase: 'readiness', ready: false });
      expect(rows(frozen, 'errors.jsonl')[0].error).toContain('replay-readiness-refused');
      expect(existsSync(join(frozen.rootPath, frozen.runId, 'runs.jsonl'))).toBe(false);
      expect(existsSync(join(frozen.rootPath, frozen.runId, 'result.json'))).toBe(false);
      const saved = readFileSync(join(frozen.rootPath, frozen.runId, 'warmups.jsonl'), 'utf8');
      await expect(runDaemonReplay(frozen, frozen.rootPath)).rejects.toThrow('archive already exists');
      expect(readFileSync(join(frozen.rootPath, frozen.runId, 'warmups.jsonl'), 'utf8')).toBe(saved);
    });
  it.each(['root-load', 'child-load', 'population', 'executable', 'health', 'unsettled', 'drift', 'missing-root', 'wrong-server'])
    ('refuses %s at the first runtime boundary before measured load', async failure => {
      const frozen = config();
      const start = boundary(frozen);
      if (failure === 'root-load') start.processes[0].loadedModules = 'unmeasured';
      if (failure === 'child-load') start.populations[0].processes[1].loadedModules = 'unmeasured';
      if (failure === 'population') start.populations[0].unknown.push('unreadable-census');
      if (failure === 'executable') start.processes[0].executable!.sha256 = replayHash('changed inode');
      if (failure === 'health') start.health.daemonRuntime!.servers[0].health = 'degraded';
      if (failure === 'unsettled') start.admission.inFlight = 1;
      if (failure === 'missing-root') start.processes.shift();
      if (failure === 'wrong-server') start.populations[0].rootPid = 999;
      vi.mocked(readLspDaemonAdmission).mockResolvedValue({ ...start.admission } as Awaited<ReturnType<typeof readLspDaemonAdmission>>);
      vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) => {
        if (request.op === 'health') {
          if (failure === 'drift') writeFileSync(join(frozen.rootPath, 'source.ts'), 'changed after warmup');
          return start.health;
        }
        return readyAnswer(frozen, request.op === 'symbol' ? 'definition' : 'hot-references');
      });
      await expect(runDaemonReplay(frozen, frozen.rootPath, { captureRuntime: () => start }))
        .rejects.toThrow('replay-start-boundary-refused');
      expect(vi.mocked(callLspDaemonRpc).mock.calls.filter(([, request]) => request.op !== 'health'))
        .toHaveLength(2);
      expect(rows(frozen, 'boundaries.jsonl')).toHaveLength(1);
      expect(rows(frozen, 'preflights.jsonl')[1]).toMatchObject({ phase: 'runtime', ready: false });
      expect(rows(frozen, 'errors.jsonl')[0].error).toContain('replay-start-boundary-refused');
      expect(existsSync(join(frozen.rootPath, frozen.runId, 'runs.jsonl'))).toBe(false);
    });
  it('advances exact healthy warmups and qualified runtime boundaries through all three triplets', async () => {
    const frozen = { ...config(), levels: [1] };
    const start = boundary(frozen);
    expect(replayBoundaryProblems(start, frozen)).toEqual([]);
    vi.mocked(readLspDaemonAdmission).mockResolvedValue({ ...start.admission } as Awaited<ReturnType<typeof readLspDaemonAdmission>>);
    vi.mocked(callLspDaemonRpc).mockImplementation(async (_socket, request) => request.op === 'health' ? start.health :
      readyAnswer(frozen, request.op === 'symbol' ? 'definition' : 'hot-references'));
    await runDaemonReplay(frozen, frozen.rootPath, { captureRuntime: () => start });
    expect(rows(frozen, 'runs.jsonl')).toHaveLength(9);
    expect(rows(frozen, 'triplets.jsonl')).toHaveLength(3);
    expect(rows(frozen, 'preflights.jsonl').every(row => row.ready === true)).toBe(true);
    expect(existsSync(join(frozen.rootPath, frozen.runId, 'result.json'))).toBe(true);
    // Synthetic transport has no durable query evidence; admission is proven,
    // while the archive must still refuse to claim acceptance for these runs.
    expect(rows(frozen, 'triplets.jsonl').every(row => row.qualification.qualified === false)).toBe(true);
  });
});
describe('replay Git source population', () => {
  function repository() {
    const root = mkdtempSync(join(tmpdir(), 'lsp-replay-git-')); roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    return root;
  }
  it('retains tracked deletions, ordinary untracked files and initialized tracked submodules', () => {
    const root = repository();
    writeFileSync(join(root, 'deleted.ts'), 'tracked');
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    execFileSync('git', ['-C', root, 'add', 'deleted.ts', '.gitignore']);
    rmSync(join(root, 'deleted.ts'));
    mkdirSync(join(root, 'new')); writeFileSync(join(root, 'new', 'source.ts'), 'new');
    writeFileSync(join(root, 'ignored.ts'), 'ignored');
    const child = join(root, 'child'); execFileSync('git', ['init', '-q', child]);
    writeFileSync(join(child, 'source.ts'), 'child');
    execFileSync('git', ['-C', child, 'add', 'source.ts']);
    execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo',
      '160000,0123456789012345678901234567890123456789,child']);
    const excluded: string[] = [];
    expect(replayRepositorySources(root, { onExcludedRepository: path => excluded.push(path) }))
      .toEqual(['.gitignore', 'child/source.ts', 'deleted.ts', 'new/source.ts']);
    expect(excluded).toEqual([]);
  });
  it.each(['repository', 'worktree'])('records an untracked embedded %s boundary without copying foreign files', kind => {
    const root = repository();
    writeFileSync(join(root, 'source.ts'), 'export const source = 1;');
    writeFileSync(join(root, 'tsconfig.json'), '{"files":["source.ts"]}');
    const foreign = join(root, 'foreign');
    if (kind === 'repository') execFileSync('git', ['init', '-q', foreign]);
    else {
      const origin = repository();
      execFileSync('git', ['-C', origin, '-c', 'user.name=Replay test', '-c',
        'user.email=replay-test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
      execFileSync('git', ['-C', origin, 'worktree', 'add', '-q', '--detach', foreign]);
    }
    writeFileSync(join(foreign, 'foreign.ts'), 'must not enter the product graph');
    const excluded: string[] = [];
    expect(replayRepositorySources(root, { onExcludedRepository: path => excluded.push(path) }))
      .toEqual(['source.ts', 'tsconfig.json']);
    expect(excluded).toEqual(['foreign']);
    const parent = mkdtempSync(join(tmpdir(), 'lsp-replay-boundary-copy-')); roots.push(parent);
    const copied = materializeReplaySource({ runId: 'boundary-copy', rootPath: root,
      socketPath: join(parent, 'daemon.sock'), workspaceId: 'test', levels: [1], requestTimeoutMs: 1000,
      tsconfigPath: 'tsconfig.json', definition: { file: 'source.ts', line1: 1, character: 1 },
      references: { file: 'source.ts', line1: 1, character: 1 }, runtimeFiles: [], evidenceRef: 'git-boundary-fixture' },
    join(parent, 'source'), { checkSourceHeadroom: () => {}, snapshotDependencies: (_root, out) =>
      writeFileSync(join(out, '.papercusp-pinned-deps'), 'mode=copy\ntrees=0\n') });
    const manifest = readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8');
    expect(JSON.parse(manifest).sourcePopulation).toEqual({ policy: 'git-root-and-tracked-submodules-v1',
      excludedRepositories: ['foreign'] });
    expect(JSON.parse(readFileSync(join(copied.rootPath, '.replay-source-capture.json'), 'utf8')).sourcePopulation)
      .toEqual(JSON.parse(manifest).sourcePopulation);
    expect(copied.sourceSnapshot!.sha256).toBe(replayHash(manifest));
    expect(existsSync(join(copied.rootPath, 'foreign'))).toBe(false);
    expect(readFileSync(join(copied.rootPath, 'source.ts'), 'utf8')).toContain('source = 1');
  });
  it('refuses an uninitialized tracked submodule rather than excluding it as foreign', () => {
    const root = repository(); mkdirSync(join(root, 'child'));
    execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo',
      '160000,0123456789012345678901234567890123456789,child']);
    expect(() => replayRepositorySources(root)).toThrow('uninitialized-replay-submodule');
  });
  it.each(['source', 'repository'])('refuses a new %s population member during capture', kind => {
    const root = repository();
    writeFileSync(join(root, 'source.ts'), 'export const source = 1;');
    writeFileSync(join(root, 'tsconfig.json'), '{"files":["source.ts"]}');
    const parent = mkdtempSync(join(tmpdir(), 'lsp-replay-population-drift-')); roots.push(parent);
    const target = join(parent, 'source');
    expect(() => materializeReplaySource({ runId: 'population-drift', rootPath: root,
      socketPath: join(parent, 'daemon.sock'), workspaceId: 'test', levels: [1], requestTimeoutMs: 1000,
      tsconfigPath: 'tsconfig.json', definition: { file: 'source.ts', line1: 1, character: 1 },
      references: { file: 'source.ts', line1: 1, character: 1 }, runtimeFiles: [], evidenceRef: 'population-drift-fixture' },
    target, { checkSourceHeadroom: () => {}, snapshotDependencies: (_root, out) => {
      if (kind === 'source') writeFileSync(join(root, 'added.ts'), 'new source');
      else execFileSync('git', ['init', '-q', join(root, 'foreign')]);
      writeFileSync(join(out, '.papercusp-pinned-deps'), 'mode=copy\ntrees=0\n');
    } })).toThrow('changed-during-replay-source-population');
    expect(existsSync(join(target, '.replay-source-capture.json'))).toBe(true);
    expect(existsSync(join(target, '.replay-source-snapshot.json'))).toBe(false);
  });
});
describe('committed replay archive and canonical runtime inputs', () => {
  function fixture(pkg: Record<string, unknown> = { name: 'workspace', main: './dist/index.js' }) {
    const parent = mkdtempSync(join(tmpdir(), 'lsp-replay-archive-')); roots.push(parent);
    const donor = join(parent, 'canonical'); const archive = join(parent, 'archive');
    const target = join(parent, 'captured'); mkdirSync(donor); mkdirSync(archive);
    execFileSync('git', ['init', '-q', donor]);
    for (const root of [donor, archive]) {
      writeFileSync(join(root, '.gitignore'), 'dist/\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
      writeFileSync(join(root, 'source.ts'), 'export const original = 1;');
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'] }));
    }
    mkdirSync(join(donor, 'dist')); writeFileSync(join(donor, 'dist/index.js'), 'module.exports = 1;');
    const receipt: VerifierSourceReceipt = { schemaVersion: 'verifier-source-v1', sourceCommit: '1'.repeat(40),
      testedInputs: [{ path: 'source.ts', sha256: replayHash(readFileSync(join(archive, 'source.ts'))) }],
      files: verifierSourceFiles(archive), submodules: [] };
    writeFileSync(join(archive, '.verifier-source.json'), JSON.stringify(receipt));
    const dependencies = vi.fn((_root: string, out: string) =>
      writeFileSync(join(out, '.papercusp-pinned-deps'), 'mode=copy\ntrees=0\n'));
    const input: ReplayOracleInput = { runId: 'committed-source', rootPath: archive,
      socketPath: join(parent, 'daemon.sock'), workspaceId: 'test', levels: [1], requestTimeoutMs: 1000,
      tsconfigPath: 'tsconfig.json', definition: { file: 'source.ts', line1: 1, character: 1 },
      references: { file: 'source.ts', line1: 1, character: 1 }, runtimeFiles: [], evidenceRef: 'archive-fixture' };
    const options = { sourceArchive: { receipt, dependencyDonor: donor }, checkSourceHeadroom: vi.fn(),
      snapshotDependencies: dependencies };
    return { donor, archive, target, receipt, input, options, dependencies };
  }
  it('keeps every archived source byte while copying declared ignored outputs and using the canonical dependency mutex', () => {
    const f = fixture(); writeFileSync(join(f.donor, 'source.ts'), 'uncommitted replacement');
    writeFileSync(join(f.donor, 'unrelated.ts'), 'untracked source');
    const copied = materializeReplaySource(f.input, f.target, f.options);
    expect(readFileSync(join(f.target, 'source.ts'), 'utf8')).toBe('export const original = 1;');
    expect(existsSync(join(f.target, 'unrelated.ts'))).toBe(false);
    expect(readFileSync(join(f.target, 'dist/index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(statSync(join(f.target, 'dist/index.js')).ino).not.toBe(statSync(join(f.donor, 'dist/index.js')).ino);
    expect(f.dependencies).toHaveBeenCalledWith(f.donor, f.target);
    expect(f.options.checkSourceHeadroom).toHaveBeenCalledWith(f.donor, f.target, expect.any(Number));
    const manifest = JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8'));
    expect(manifest.sourcePopulation).toMatchObject({ policy: 'verifier-source-v1', sourceCommit: f.receipt.sourceCommit,
      runtimeOutputPolicy: 'declared-package-ignored-inputs-v2', dependencyDonor: f.donor });
    for (const file of f.receipt.files) expect(manifest.sourceFiles[file.path]).toBe(file.sha256);
    expect(manifest.sourceFiles['dist/index.js']).toBe(replayHash('module.exports = 1;'));
    expect(manifest.loadedRuntime).toBe('unmeasured');
  });
  it('keeps source exports bound to the archive despite new matching and unrelated live siblings', () => {
    const f = fixture({ main: './source.ts', exports: { './lib/*': './lib/*.ts', './generated': './dist/index.js' } });
    mkdirSync(join(f.donor, 'lib')); mkdirSync(join(f.donor, 'lib/nested'));
    writeFileSync(join(f.donor, 'lib/new.test.ts'), 'new nonignored source matching the wildcard');
    writeFileSync(join(f.donor, 'lib/nested/new.ts'), 'nested source matching the wildcard');
    writeFileSync(join(f.donor, 'new.ts'), 'unrelated sibling of exact source entry');
    const copied = materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: (root, out) => {
      f.dependencies(root, out);
      writeFileSync(join(root, 'lib/added.ts'), 'new source during capture');
    } });
    expect(readFileSync(join(f.target, 'source.ts'), 'utf8')).toBe('export const original = 1;');
    expect(existsSync(join(f.target, 'lib'))).toBe(false);
    expect(existsSync(join(f.target, 'new.ts'))).toBe(false);
    expect(readFileSync(join(f.target, 'dist/index.js'), 'utf8')).toBe('module.exports = 1;');
    expect(JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8')).loadedRuntime).toBe('unmeasured');
  });
  it('refuses an exact nonignored runtime target while excluding unrelated wildcard source', () => {
    const f = fixture({ exports: { './lib/*': './lib/*.ts', './required': './lib/required.ts' } });
    mkdirSync(join(f.donor, 'lib'));
    writeFileSync(join(f.donor, 'lib/new.test.ts'), 'unrelated source');
    writeFileSync(join(f.donor, 'lib/required.ts'), 'required unrecorded runtime');
    expect(() => materializeReplaySource(f.input, f.target, f.options))
      .toThrow('replay-archive-unrecorded-source:lib/required.ts');
    expect(existsSync(f.target)).toBe(false); expect(f.dependencies).not.toHaveBeenCalled();
  });
  it('copies nested ignored wildcard outputs and exact-entry sibling dependencies without sweeping other source', () => {
    const f = fixture({ module: './build/nested/entry.js', exports: { './generated/*': './dist/*.js' } });
    writeFileSync(join(f.donor, '.gitignore'), 'dist/\nbuild/\n');
    mkdirSync(join(f.donor, 'build/nested'), { recursive: true });
    writeFileSync(join(f.donor, 'build/nested/entry.js'), 'import "./dependency.js";');
    writeFileSync(join(f.donor, 'build/nested/dependency.js'), 'export const dependency = 1;');
    mkdirSync(join(f.donor, 'dist/nested'));
    writeFileSync(join(f.donor, 'dist/nested/generated.js'), 'nested generated output');
    writeFileSync(join(f.donor, 'dist/unrelated.txt'), 'does not match the export pattern');
    const copied = materializeReplaySource(f.input, f.target, f.options);
    expect(readFileSync(join(f.target, 'build/nested/dependency.js'), 'utf8')).toContain('dependency = 1');
    expect(readFileSync(join(f.target, 'dist/nested/generated.js'), 'utf8')).toBe('nested generated output');
    expect(existsSync(join(f.target, 'dist/unrelated.txt'))).toBe(false);
    const manifest = JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8'));
    expect(manifest.sourceFiles['dist/nested/generated.js']).toBe(replayHash('nested generated output'));
  });
  it('refuses an unrecorded nonignored member of an explicit directory target', () => {
    const f = fixture({ exports: { './lib/*': './lib/*.ts' }, main: './lib' });
    mkdirSync(join(f.donor, 'lib'));
    writeFileSync(join(f.donor, 'lib/required.ts'), 'required directory member also matching wildcard');
    expect(() => materializeReplaySource(f.input, f.target, f.options))
      .toThrow('replay-archive-unrecorded-source:lib/required.ts');
    expect(existsSync(f.target)).toBe(false); expect(f.dependencies).not.toHaveBeenCalled();
  });
  it.each(['archive', 'declaration', 'unrecorded-source', 'custom-population', 'git-checkout'])
    ('refuses an invalid archive input before creating a capture: %s', kind => {
      const f = fixture();
      if (kind === 'archive') writeFileSync(join(f.archive, 'source.ts'), 'changed archived source');
      if (kind === 'declaration') writeFileSync(join(f.donor, 'package.json'), '{"main":"other.js"}');
      if (kind === 'unrecorded-source') writeFileSync(join(f.donor, '.gitignore'), '');
      if (kind === 'git-checkout') f.receipt.gitCheckout = { parentCommit: '2'.repeat(40), trackedFilesHash: 'x' };
      const enumerateSources = kind === 'custom-population' ? () => ['source.ts'] : undefined;
      const expected = { archive: 'tampered verification source archive', declaration: 'replay-archive-package-declaration-drift',
        'unrecorded-source': 'replay-archive-unrecorded-source', 'custom-population': 'replay-archive-custom-population-forbidden',
        'git-checkout': 'replay-archive-must-be-source-only' }[kind]!;
      expect(() => materializeReplaySource(f.input, f.target, { ...f.options, enumerateSources })).toThrow(expected);
      expect(existsSync(f.target)).toBe(false); expect(f.dependencies).not.toHaveBeenCalled();
    });
  it.each(['archive', 'declaration', 'output', 'output-population'])('refuses phase drift without a final manifest: %s', kind => {
    const f = fixture();
    const expected = { archive: 'tampered verification source archive', declaration: 'replay-archive-package-declaration-drift',
      output: 'changed-during-replay-archive-output:', 'output-population': 'changed-during-replay-archive-output-population' }[kind]!;
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: (root, out) => {
      f.dependencies(root, out);
      if (kind === 'archive') writeFileSync(join(f.archive, 'source.ts'), 'changed archived source');
      if (kind === 'declaration') writeFileSync(join(f.donor, 'package.json'), '{"main":"other.js"}');
      if (kind === 'output') writeFileSync(join(f.donor, 'dist/index.js'), 'replacement output');
      if (kind === 'output-population') writeFileSync(join(f.donor, 'dist/added.js'), 'new output');
    } })).toThrow(expected);
    expect(existsSync(join(f.target, '.replay-source-capture.json'))).toBe(true);
    expect(existsSync(join(f.target, '.replay-source-snapshot.json'))).toBe(false);
  });
  it('requires the archive declaration before the CLI reads any source input', async () => {
    await expect(runSaturationCli(['node', 'cli', '--materialize-archived-replay', '/missing/input', '/missing/source', '/missing/out']))
      .rejects.toThrow('requires archive receipt and canonical dependency donor declaration');
  });
});
describe('independent replay source materialization', () => {
  function fixture() {
    const frozen = config();
    const parent = mkdtempSync(join(tmpdir(), 'lsp-replay-snapshot-')); roots.push(parent);
    const target = join(parent, 'source');
    writeFileSync(join(frozen.rootPath, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const input: ReplayOracleInput = { runId: 'copied-source', rootPath: frozen.rootPath,
      socketPath: frozen.socketPath, workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000,
      tsconfigPath: 'tsconfig.json', definition: { file: 'source.ts', line1: 2, character: 1 },
      references: { file: 'source.ts', line1: 2, character: 1 }, runtimeFiles: [], evidenceRef: 'source-copy-fixture' };
    const dependencies = (_donor: string, out: string) => writeFileSync(join(out, '.papercusp-pinned-deps'), 'mode=copy\ntrees=0\n');
    const options = { enumerateSources: () => ['source.ts', 'tsconfig.json'], snapshotDependencies: dependencies,
      checkSourceHeadroom: vi.fn() };
    return { input, target, options, parent };
  }
  it('relocates a declared in-root compiler entry with the independently copied sources', () => {
    const f = fixture(); const compilerEntry = join(f.input.rootPath, 'compiler.cjs');
    writeFileSync(compilerEntry, "module.exports = { version: '6.0.3' };");
    const copied = materializeReplaySource({ ...f.input, compilerEntry }, f.target, { ...f.options,
      enumerateSources: () => ['source.ts', 'tsconfig.json', 'compiler.cjs'] });
    expect(copied.compilerEntry).toBe(join(f.target, 'compiler.cjs'));
    expect(readFileSync(copied.compilerEntry!, 'utf8')).toBe(readFileSync(compilerEntry, 'utf8'));
  });
  it('delegates snapshot execution to the maintained helper without a whole-copy wall deadline', () => {
    const f = fixture();
    const helper = join(f.input.rootPath, 'papercusp-desktop/bin/lib/pinned-deps.sh');
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, '#!/usr/bin/env bash\nif [ "$1" = preflight ]; then cat >/dev/null; exit 0; fi\n[ "$1" = snapshot-locked ] && [ "$4" = copy ] && [ -f "$5" ] || exit 2\nprintf "mode=copy\\ntrees=0\\n" > "$3/.papercusp-pinned-deps"\n');
    const execute = childProcess.execFileSync;
    let snapshotCalls = 0;
    let preflightCalls = 0;
    const spy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: string[], options: { timeout?: number }) => {
      if (args.includes('preflight')) {
        preflightCalls++;
        expect(existsSync(f.target)).toBe(false);
        expect(f.options.checkSourceHeadroom).not.toHaveBeenCalled();
      }
      if (args.includes('snapshot-locked')) {
        snapshotCalls++;
        // Model a still-progressing snapshot past the former deadline without
        // spending ten minutes. The real helper still executes and stamps it.
        if (options.timeout !== undefined && options.timeout <= 600_001)
          throw Object.assign(new Error('snapshot still progressing'), { code: 'ETIMEDOUT' });
      }
      return execute(command, args, options);
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    try {
      const copied = materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: undefined });
      expect(snapshotCalls).toBe(1);
      expect(preflightCalls).toBe(1);
      expect(readFileSync(join(f.target, '.papercusp-pinned-deps'), 'utf8')).toContain('mode=copy');
      expect(copied.sourceSnapshot).toBeDefined();
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
  it.each(['dangling-bin', 'unplanned-workspace'])('WI-41095 actual helper refuses %s before source admission/allocation', kind => {
    const f = fixture();
    for (const path of ['papercusp-desktop/bin/lib/pinned-deps.sh', 'apps/operator/bin/release/dependency-generation.sh']) {
      mkdirSync(dirname(join(f.input.rootPath, path)), { recursive: true });
      cpSync(new URL(`../../../../${path}`, import.meta.url), join(f.input.rootPath, path));
    }
    mkdirSync(join(f.input.rootPath, 'node_modules/.bin'), { recursive: true });
    if (kind === 'dangling-bin') symlinkSync('../vitest/vitest.mjs', join(f.input.rootPath, 'node_modules/.bin/vitest'));
    else {
      mkdirSync(join(f.input.rootPath, 'excluded')); writeFileSync(join(f.input.rootPath, 'excluded/index.js'), 'omitted');
      symlinkSync('../excluded', join(f.input.rootPath, 'node_modules/workspace'));
    }
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: undefined }))
      .toThrow(kind === 'dangling-bin' ? 'dangling-pinned-dependency-link' : 'unplanned-pinned-dependency-target');
    expect(existsSync(f.target)).toBe(false);
    expect(f.options.checkSourceHeadroom).not.toHaveBeenCalled();
  });
  it('refuses an external compiler or an escaping alias before creating the source copy', () => {
    const f = fixture();
    const entry = createRequire(import.meta.url).resolve('typescript');
    expect(() => materializeReplaySource({ ...f.input, compilerEntry: entry }, f.target, f.options))
      .toThrow('escaping-replay-compiler-entry');
    const alias = join(f.input.rootPath, 'compiler.cjs'); symlinkSync(entry, alias);
    expect(() => materializeReplaySource({ ...f.input, compilerEntry: alias }, f.target, f.options))
      .toThrow('escaping-replay-compiler-entry');
    expect(existsSync(f.target)).toBe(false);
    expect(f.options.checkSourceHeadroom).not.toHaveBeenCalled();
  });
  function compilerPackageFixture() {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'lsp-compiler-package-')); roots.push(root);
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'declared-compiler', main: './lib/typescript.cjs' }));
    writeFileSync(join(root, 'lib/typescript.cjs'), "module.exports = { version: '6.0.3' };");
    writeFileSync(join(root, 'lib/lib.fixture.d.ts'), 'declare const fixtureLibrary: string;');
    const input = { ...f.input, compilerEntry: join(root, 'lib/typescript.cjs'), compilerPackageRoot: root };
    return { ...f, root, input };
  }
  it('preserves a standalone copied vendor installation for production server and compiler selection', () => {
    const f = fixture();
    const vendor = mkdtempSync(join(tmpdir(), 'lsp-declared-vendor-')); roots.push(vendor);
    writeFileSync(join(vendor, 'package.json'), '{"name":"declared-lsp-installation"}');
    const compiler = join(vendor, 'node_modules', '@typescript', 'old', 'lib');
    mkdirSync(compiler, { recursive: true });
    writeFileSync(join(compiler, 'typescript.js'), "module.exports = { version: '6.0.3' };");
    writeFileSync(join(compiler, 'tsserver.js'), '// independently declared server entry');
    const server = join(vendor, 'node_modules', 'typescript-language-server');
    const dependency = join(server, 'node_modules', 'declared-dependency');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'index.js'), "module.exports = 'copied dependency';");
    writeFileSync(join(server, 'cli.js'), "module.exports = require('declared-dependency');");
    mkdirSync(join(vendor, 'node_modules', '.bin'));
    symlinkSync('../typescript-language-server/cli.js', join(vendor, 'node_modules', '.bin', 'typescript-language-server'));
    const copied = materializeReplaySource({ ...f.input, compilerEntry: join(compiler, 'typescript.js'),
      compilerPackageRoot: vendor }, f.target, f.options);
    rmSync(vendor, { recursive: true });
    const root = resolveLspVendorDir(copied.compilerPackageRoot);
    vi.stubEnv('PAPERCUSP_LSP_MAX_TSSERVER_MEMORY_MB', '8192');
    const spec = specForLanguage('typescript');
    const tsserver = resolveTsserverPath(root);
    expect(copied.compilerEntry).toBe(join(root, 'node_modules', '@typescript', 'old', 'lib', 'typescript.js'));
    expect(spec.initializationOptions(f.target, undefined, root)).toMatchObject({ tsserver: { path: tsserver } });
    expect(spec.identityFiles!(root)).toEqual([tsserver]);
    expect(createRequire(tsserver)('./typescript.js').version).toBe('6.0.3');
    expect(createRequire(tsserver)(spec.resolveBin(root)!)).toBe('copied dependency');
    for (const file of [copied.compilerEntry!, tsserver, spec.resolveBin(root)!,
      join(root, 'node_modules', 'typescript-language-server', 'node_modules', 'declared-dependency', 'index.js')])
      expect(copied.runtimeFiles).toContain(file);
  });

  it('copies every declared external compiler member with independent inodes and frozen hashes', () => {
    const f = compilerPackageFixture();
    const server = join(f.root, 'lib/tsserver.cjs'); writeFileSync(server, 'server executable'); chmodSync(server, 0o755);
    const copied = materializeReplaySource({ ...f.input, runtimeFiles: [server] }, f.target, f.options);
    const root = copied.compilerPackageRoot!;
    expect(root.startsWith(join(f.target, '.replay-runtime/'))).toBe(true);
    expect(copied.compilerEntry).toBe(join(root, 'lib/typescript.cjs'));
    const manifest = JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8'));
    for (const file of ['package.json', 'lib/typescript.cjs', 'lib/lib.fixture.d.ts', 'lib/tsserver.cjs']) {
      const source = join(f.root, file); const out = join(root, file);
      expect(readFileSync(out)).toEqual(readFileSync(source));
      expect(statSync(out).ino).not.toBe(statSync(source).ino);
      expect(copied.runtimeFiles).toContain(out);
      expect(manifest.sourceFiles[out.slice(f.target.length + 1)]).toBe(replayHash(readFileSync(source)));
    }
    expect(statSync(join(root, 'lib/tsserver.cjs')).mode & 0o777).toBe(0o755);
  });
  it('freezes a real copied compiler and its library graph without consulting the external donor', () => {
    const f = compilerPackageFixture();
    const entry = createRequire(import.meta.url).resolve('@typescript/old');
    cpSync(dirname(dirname(entry)), f.root, { recursive: true });
    writeFileSync(join(f.input.rootPath, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { lib: ['es5'] } }));
    const copied = materializeReplaySource({ ...f.input, compilerEntry: join(f.root, 'lib/typescript.js') }, f.target, f.options);
    rmSync(f.root, { recursive: true });
    const frozen = freezeCompilerReplayConfig(copied);
    const graph = assertReplaySemanticGraph(frozen);
    expect(graph.compilerVersion).toBe('6.0.3');
    expect(graph.compilerEntries).toHaveProperty(copied.compilerEntry!);
    expect(graph.projects[0].files).toContain(join(copied.compilerPackageRoot!, 'lib/lib.es5.d.ts'));
    expect(Object.keys(frozen.files).every(file => file.startsWith(f.target + '/'))).toBe(true);
    expect(frozen.sourceSnapshot).toEqual(copied.sourceSnapshot);
  }, 30_000);
  it('relocates package symlinks while preserving their independent targets', () => {
    const f = compilerPackageFixture();
    symlinkSync(join(f.root, 'lib/lib.fixture.d.ts'), join(f.root, 'absolute-lib'));
    symlinkSync('lib', join(f.root, 'relative-libs'));
    const copied = materializeReplaySource(f.input, f.target, f.options);
    expect(realpathSync(join(copied.compilerPackageRoot!, 'absolute-lib'))).toBe(join(copied.compilerPackageRoot!, 'lib/lib.fixture.d.ts'));
    expect(realpathSync(join(copied.compilerPackageRoot!, 'relative-libs/lib.fixture.d.ts'))).toBe(join(copied.compilerPackageRoot!, 'lib/lib.fixture.d.ts'));
  });
  it('refuses undeclared compiler packages, escaping members and alias roots before copying', () => {
    const f = compilerPackageFixture();
    const alias = join(f.parent, 'compiler-alias'); symlinkSync(f.root, alias);
    expect(() => materializeReplaySource({ ...f.input, compilerPackageRoot: alias }, f.target, f.options))
      .toThrow('replay-compiler-package-declaration-invalid');
    expect(() => materializeReplaySource({ ...f.input, compilerEntry: join(f.input.rootPath, 'source.ts') }, f.target, f.options))
      .toThrow('escaping-replay-compiler-entry');
    symlinkSync(join(f.input.rootPath, 'source.ts'), join(f.root, 'outside'));
    expect(() => materializeReplaySource(f.input, f.target, f.options)).toThrow('escaping-replay-compiler-package');
    expect(existsSync(f.target)).toBe(false);
    expect(f.options.checkSourceHeadroom).not.toHaveBeenCalled();
  });
  it('includes the complete compiler tree in admission and refuses mutation after admission', () => {
    const f = compilerPackageFixture();
    let admitted = 0;
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, checkSourceHeadroom: (_donor, _out, bytes) => {
      admitted = bytes; writeFileSync(join(f.root, 'lib/lib.fixture.d.ts'), 'replacement library bytes');
    } })).toThrow('changed-since-replay-admission');
    expect(admitted).toBeGreaterThan(8192 + 3 * 4096);
  });
  it('refuses additions to a declared compiler tree during the dependency copy', () => {
    const f = compilerPackageFixture();
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: (donor, out) => {
      f.options.snapshotDependencies(donor, out); writeFileSync(join(f.root, 'new-lib.d.ts'), 'added library');
    } })).toThrow('changed-during-replay-compiler-copy');
    expect(existsSync(join(f.target, '.replay-source-snapshot.json'))).toBe(false);
  });
  it('refuses a dependency phase replacing predeclared compiler bytes', () => {
    const f = compilerPackageFixture();
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: (donor, out) => {
      f.options.snapshotDependencies(donor, out);
      const root = join(out, '.replay-runtime', replayHash(f.root)); mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'lib/typescript.cjs'), 'replacement executable');
    } })).toThrow('replay-compiler-copy-byte-mismatch');
  });
  function realHeadroomFixture() {
    const f = fixture();
    const helper = join(f.input.rootPath, 'apps/operator/bin/release/dependency-generation.sh');
    mkdirSync(join(f.input.rootPath, 'apps/operator/bin/release'), { recursive: true });
    writeFileSync(helper, readFileSync(new URL('../../../../apps/operator/bin/release/dependency-generation.sh', import.meta.url)));
    vi.stubEnv('DEPENDENCY_GENERATION_COPY_LOCK_FILE', join(f.parent, 'copy.lock'));
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES', '1000000');
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES', '1');
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES', '0');
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT', '0');
    vi.stubEnv('DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC', '0');
    vi.stubEnv('DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC', '0');
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_SAME_FS', '1');
    return { ...f, options: { ...f.options, checkSourceHeadroom: undefined } };
  }
  it('refuses actual low-space admission before creating a source capture and releases its copy lease', () => {
    const f = realHeadroomFixture();
    const retained = join(f.parent, 'source.generation-tmp.evidence');
    mkdirSync(retained); writeFileSync(join(retained, 'proof'), 'retained peer evidence');
    const dependencies = vi.fn(f.options.snapshotDependencies);
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: dependencies }))
      .toThrow('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
    expect(existsSync(f.target)).toBe(false);
    expect(dependencies).not.toHaveBeenCalled();
    expect(readFileSync(join(retained, 'proof'), 'utf8')).toBe('retained peer evidence');
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES', '1000000');
    const copied = materializeReplaySource(f.input, f.target, f.options);
    expect(readFileSync(join(copied.rootPath, 'source.ts'), 'utf8')).toContain('hot();');
  });
  it('fails closed when headroom cannot be measured, leaving no capture', () => {
    const f = realHeadroomFixture();
    const bin = join(f.parent, 'bin'); mkdirSync(bin);
    const stat = join(bin, 'stat'); writeFileSync(stat, '#!/usr/bin/env bash\nexit 1\n'); chmodSync(stat, 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES', '');
    vi.stubEnv('DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES', '');
    expect(() => materializeReplaySource(f.input, f.target, f.options))
      .toThrow('DEPENDENCY_GENERATION_HEADROOM_UNMEASURED');
    expect(existsSync(f.target)).toBe(false);
  });
  it('admits ignored package outputs and declared external runtime bytes before source writes', () => {
    const f = fixture();
    const binary = join(f.parent, 'runtime'); writeFileSync(binary, Buffer.alloc(64000));
    mkdirSync(join(f.input.rootPath, 'dist'));
    writeFileSync(join(f.input.rootPath, 'dist', 'cli.js'), Buffer.alloc(32000));
    writeFileSync(join(f.input.rootPath, 'package.json'), JSON.stringify({ bin: './dist/cli.js' }));
    let observed = 0;
    const copied = materializeReplaySource({ ...f.input, runtimeFiles: [binary] }, f.target, { ...f.options,
      enumerateSources: () => [...f.options.enumerateSources(), 'package.json', 'deleted.ts'],
      checkSourceHeadroom: (root, target, bytes) => {
        expect(root).toBe(realpathSync(f.input.rootPath));
        expect(target).toBe(f.target); expect(existsSync(target)).toBe(false);
        observed = bytes;
      } });
    expect(observed).toBeGreaterThan(96000);
    expect(readFileSync(copied.runtimeFiles[0])).toHaveLength(64000);
    expect(JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8')).absent).toEqual(['deleted.ts']);
  });
  it.each(['growth', 'resurrection'])('refuses unadmitted source bytes after the census (%s)', change => {
    const f = fixture();
    const file = change === 'growth' ? 'source.ts' : 'deleted.ts';
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options,
      enumerateSources: () => [file, 'tsconfig.json'],
      checkSourceHeadroom: () => writeFileSync(join(f.input.rootPath, file), Buffer.alloc(1000000)),
    })).toThrow('changed-since-replay-admission');
    expect(existsSync(join(f.target, file))).toBe(false);
    expect(existsSync(join(f.target, '.replay-source-snapshot.json'))).toBe(false);
  });
  function pluginFixture(external: boolean) {
    const f = fixture();
    const location = join(external ? f.parent : f.input.rootPath, 'probe');
    const packageRoot = join(location, 'node_modules', 'fixture-plugin');
    mkdirSync(packageRoot, { recursive: true });
    const manifest = join(packageRoot, 'package.json'); const entry = join(packageRoot, 'index.cjs');
    writeFileSync(manifest, JSON.stringify({ name: 'fixture-plugin', main: 'index.cjs' }));
    writeFileSync(entry, 'module.exports = function() {};\n');
    const files = Object.fromEntries([manifest, entry].map(file => [file, replayHash(readFileSync(file))]));
    return { ...f, manifest, entry, input: { ...f.input, runtimeFiles: [manifest, entry],
      semanticCompletionPlugin: { name: 'fixture-plugin', location, files } } };
  }
  it.each([false, true])('copies the declared plugin package independently (external=%s)', external => {
    const f = pluginFixture(external);
    const copied = materializeReplaySource(f.input, f.target, f.options);
    const plugin = copied.semanticCompletionPlugin!;
    expect(plugin.location.startsWith(copied.rootPath + '/')).toBe(true);
    expect(plugin.location).not.toBe(f.input.semanticCompletionPlugin.location);
    expect(Object.keys(plugin.files).every(file => copied.runtimeFiles.includes(file))).toBe(true);
    for (const [file, hash] of Object.entries(plugin.files)) {
      expect(file.startsWith(plugin.location + '/node_modules/fixture-plugin/')).toBe(true);
      expect(replayHash(readFileSync(file))).toBe(hash);
      expect(JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8')).sourceFiles[file.slice(copied.rootPath.length + 1)])
        .toBe(hash);
    }
    const copiedEntry = join(plugin.location, 'node_modules', plugin.name, 'index.cjs');
    expect(statSync(copiedEntry).ino).not.toBe(statSync(f.entry).ino);
    writeFileSync(f.entry, 'changed live donor');
    expect(() => semanticCompletionPlugins(plugin)).not.toThrow();
    writeFileSync(copiedEntry, 'changed copied input');
    expect(() => semanticCompletionPlugins(plugin)).toThrow('plugin-byte-mismatch');
  });
  it('refuses a plugin package whose captured runtime declaration omits an input', () => {
    const f = pluginFixture(true);
    expect(() => materializeReplaySource({ ...f.input, runtimeFiles: [f.manifest] }, f.target, f.options))
      .toThrow('replay-plugin-input-undeclared');
    expect(existsSync(f.target)).toBe(false);
  });
  it('refuses substituted dependency bytes before publishing a plugin snapshot', () => {
    const f = pluginFixture(false);
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: (donor, out) => {
      f.options.snapshotDependencies(donor, out);
      const packageRoot = join(out, 'probe', 'node_modules', 'fixture-plugin');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), readFileSync(f.manifest));
      writeFileSync(join(packageRoot, 'index.cjs'), 'substituted dependency output');
    } })).toThrow('replay-plugin-copy-byte-mismatch');
    expect(existsSync(join(f.target, '.replay-source-snapshot.json'))).toBe(false);
  });
  it('uses independent source and external runtime bytes after the donor changes in place', () => {
    const f = fixture();
    const binary = join(f.parent, 'node-fixture');
    writeFileSync(binary, 'original executable', { mode: 0o755 });
    const copied = materializeReplaySource({ ...f.input, runtimeFiles: [binary],
      definition: { ...f.input.definition, file: join(f.input.rootPath, 'source.ts') } }, f.target, f.options);
    expect(copied.definition.file).toBe('source.ts');
    expect(statSync(join(copied.rootPath, 'source.ts')).ino).not.toBe(statSync(join(f.input.rootPath, 'source.ts')).ino);
    writeFileSync(join(f.input.rootPath, 'source.ts'), 'export const replacement = 1;');
    writeFileSync(binary, 'changed executable');
    expect(readFileSync(copied.runtimeFiles[0], 'utf8')).toBe('original executable');
    expect(statSync(copied.runtimeFiles[0]).mode & 0o111).toBe(0o111);
    // This source-copy fixture deliberately installs no compiler. It cannot
    // qualify an isolated graph using this worker's already loaded live compiler.
    expect(() => freezeCompilerReplayConfig(copied)).toThrow('snapshot-input-escape');
    // Keep the source-byte/manifest drift control separately scoped as local
    // source-only evidence; it carries no repository-isolation/runtime claim.
    const oracle = freezeCompilerReplayConfig({ ...copied, sourceSnapshot: undefined });
    expect(() => assertReplayOracleRuntimeQualified(oracle)).toThrow('replay-oracle-runtime-unmeasured');
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]);
    expect(() => validateDaemonReplayConfig(oracle)).not.toThrow();
    writeFileSync(copied.sourceSnapshot!.manifestPath, '{}');
    expect(() => validateDaemonReplayConfig(oracle)).toThrow('changed-file');
  });
  it('freezes through the maintained CLI without loading Git-dependent legacy probes', async () => {
    const f = fixture();
    expect(existsSync(join(f.input.rootPath, '.git'))).toBe(false);
    const inputPath = join(f.parent, 'input.json');
    const outputPath = join(f.parent, 'frozen.json');
    writeFileSync(inputPath, JSON.stringify(f.input));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const progress = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runSaturationCli(['node', 'lsp-saturation-bench-cli.ts', '--freeze-replay', inputPath, outputPath]);
      const frozen = JSON.parse(readFileSync(outputPath, 'utf8')) as DaemonReplayConfig;
      expect(frozen.rootPath).toBe(f.input.rootPath);
      expect(frozen.corpus['hot-references'].oracle.sites).toEqual([
        { path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 },
      ]);
      expect(() => validateDaemonReplayConfig(frozen)).not.toThrow();
    } finally { output.mockRestore(); progress.mockRestore(); }
  });
  it('refuses a source-directory escape through the destination parent', () => {
    const f = fixture();
    const alias = join(f.parent, 'donor-link');
    symlinkSync(f.input.rootPath, alias);
    expect(() => materializeReplaySource(f.input, join(alias, 'snapshot'), f.options)).toThrow('must-be-disjoint');
    expect(existsSync(join(f.input.rootPath, 'snapshot'))).toBe(false);
  });
  it('retains deletions and refuses an existing output instead of overwriting another run', () => {
    const f = fixture();
    const copied = materializeReplaySource(f.input, f.target, { ...f.options,
      enumerateSources: () => ['source.ts', 'tsconfig.json', 'deleted.ts'] });
    expect(JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8')).absent).toEqual(['deleted.ts']);
    expect(() => materializeReplaySource(f.input, f.target, f.options)).toThrow();
    expect(() => materializeReplaySource(copied, join(f.parent, 'again'), f.options)).toThrow('already-materialized');
    expect(readFileSync(join(f.target, 'source.ts'), 'utf8')).toContain('hot();');
  });
  it('refuses a dependency symlink to the live donor before publishing the source manifest', () => {
    const f = fixture();
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, snapshotDependencies: (donor, out) => {
      f.options.snapshotDependencies(donor, out);
      mkdirSync(join(out, 'node_modules'));
      symlinkSync(join(donor, 'source.ts'), join(out, 'node_modules', 'live-source'));
    } })).toThrow('escaping-replay-snapshot-link');
    expect(existsSync(join(f.target, '.replay-source-snapshot.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.target, '.replay-source-capture.json'), 'utf8')).sourceFiles['source.ts']).toBeTruthy();
  });
  it('admits an ignored workspace launcher through the real donor preflight before allocating a source copy', () => {
    const f = fixture();
    const root = f.input.rootPath;
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'cli.js'), 'export const cli = 1;');
    writeFileSync(join(root, 'dist', 'support.js'), 'export const support = 1;');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ bin: { fixture: './dist/cli.js' } }));
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    symlinkSync('../../dist/cli.js', join(root, 'node_modules', '.bin', 'fixture'));
    const sources = [...f.options.enumerateSources(), 'package.json'];
    const helper = fileURLToPath(new URL('../../../../papercusp-desktop/bin/lib/pinned-deps.sh', import.meta.url));
    const preflight = (population: string[]) => execFileSync('bash', [helper, 'preflight', root, '-'],
      { input: JSON.stringify(population), stdio: ['pipe', 'pipe', 'pipe'] });
    expect(() => preflight(sources)).toThrow();
    const population = replayPackageRuntimeSources(root, sources);
    expect(population).toEqual(expect.arrayContaining(['dist/cli.js', 'dist/support.js']));
    expect(() => preflight(population)).not.toThrow();
    expect(existsSync(f.target)).toBe(false);
  });
  it('captures ignored workspace launcher and conditional-export output named by package metadata', () => {
    const f = fixture();
    mkdirSync(join(f.input.rootPath, 'dist'));
    writeFileSync(join(f.input.rootPath, 'dist', 'cli.js'), 'export const cli = 1;');
    writeFileSync(join(f.input.rootPath, 'dist', 'api.js'), 'export const api = 1;');
    writeFileSync(join(f.input.rootPath, 'package.json'), JSON.stringify({ bin: { fixture: './dist/cli.js' },
      exports: { '.': { import: './dist/api.js' } } }));
    const copied = materializeReplaySource(f.input, f.target, { ...f.options,
      enumerateSources: () => [...f.options.enumerateSources(), 'package.json'], snapshotDependencies: (donor, out) => {
        f.options.snapshotDependencies(donor, out);
        mkdirSync(join(out, 'node_modules'));
        symlinkSync('../dist/cli.js', join(out, 'node_modules', 'fixture-cli'));
      } });
    expect(readFileSync(join(copied.rootPath, 'node_modules', 'fixture-cli'), 'utf8')).toContain('cli = 1');
    expect(readFileSync(join(copied.rootPath, 'dist', 'api.js'), 'utf8')).toContain('api = 1');
    writeFileSync(join(f.input.rootPath, 'dist', 'cli.js'), 'changed donor');
    expect(readFileSync(join(copied.rootPath, 'node_modules', 'fixture-cli'), 'utf8')).toContain('cli = 1');
    expect(JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8')).sourceFiles['dist/cli.js']).toBeTruthy();
  });
  it('refuses source path escapes and hardlinked dependency mode', () => {
    const f = fixture();
    expect(() => materializeReplaySource(f.input, f.target, { ...f.options, enumerateSources: () => ['../foreign.ts'] }))
      .toThrow('escaping-replay-source');
    const second = join(f.parent, 'hardlinked');
    expect(() => materializeReplaySource(f.input, second, { ...f.options, snapshotDependencies: (_donor, out) =>
      writeFileSync(join(out, '.papercusp-pinned-deps'), 'mode=hardlink\n') })).toThrow('not-independent-copies');
  });
  it('rejects a shared compiler library outside the copied population', () => {
    const f = fixture();
    writeFileSync(join(f.input.rootPath, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'] }));
    const copied = materializeReplaySource(f.input, f.target, f.options);
    const phases: string[] = [];
    // This test's compiler is intentionally the original one, like a shared CLI.
    expect(() => freezeCompilerReplayConfig(copied, { onProgress: progress => phases.push(progress.phase) })).toThrow('snapshot-input-escape');
    expect(phases).not.toContain('references-scanned');
  });
});
describe('daemon replay qualification', () => {
  it('hashes complete multi-chunk binary bytes and reports each final validation attempt', () => {
    const frozen = config();
    const binary = join(frozen.rootPath, 'runtime.bin');
    const bytes = Buffer.alloc(192 * 1024 + 17);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    writeFileSync(binary, bytes);
    const missing = join(frozen.rootPath, 'absent.bin');
    const files = { ...frozen.files, [binary]: replayHash(bytes), [missing]: replayHash('absent') };
    const progress: { phase: string; file?: string; completed: number; total: number }[] = [];
    expect(replayFileMismatches(files, { onProgress: row => progress.push(row) })).toEqual([`unreadable-file:${missing}`]);
    const completed = progress.filter(row => row.phase === 'file-validated');
    expect(completed.map(row => row.file)).toEqual(Object.keys(files));
    expect(completed.map(row => row.completed)).toEqual([1, 2, 3]);
    expect(progress.find(row => row.file === binary)).toMatchObject({ phase: 'files-validating', completed: 1, total: 3 });
    bytes[bytes.length - 1] ^= 255;
    writeFileSync(binary, bytes);
    expect(replayFileMismatches(files)).toEqual([`changed-file:${binary}`, `unreadable-file:${missing}`]);
  });
  it('refuses a mutation during final file validation and never emits frozen success', () => {
    const frozen = config();
    const root = frozen.rootPath;
    const source = join(root, 'source.ts');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const phases: string[] = [];
    expect(() => freezeCompilerReplayConfig({ runId: 'validation-drift', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'final-validation-mutation-control' }, { onProgress: progress => {
        phases.push(progress.phase);
        if (progress.phase === 'files-validating' && progress.file === source)
          writeFileSync(source, 'export function replacement() {}\nreplacement();\n');
      } })).toThrow(`changed-file:${source}`);
    expect(phases).toContain('file-validated');
    expect(phases).not.toContain('validated');
  });
  it('freezes source and exact oracle before querying, and rejects cursor/source drift', () => {
    const frozen = config();
    expect(() => validateDaemonReplayConfig(frozen)).not.toThrow();
    writeFileSync(Object.keys(frozen.files)[0], 'changed');
    expect(replayFileMismatches(frozen.files)).toHaveLength(1);
    expect(() => validateDaemonReplayConfig(frozen)).toThrow('changed-file');
  });
  it('rejects unfrozen, escaping and duplicate expected sites rather than blessing subject output', () => {
    const frozen = config();
    for (const sites of [[{ path: '../escape.ts', line1: 1 }], [{ path: 'unknown.ts', line1: 1 }],
      [{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 1 }]]) {
      const modified = { ...frozen, corpus: { ...frozen.corpus, definition: { ...frozen.corpus.definition,
        oracle: { ...frozen.corpus.definition.oracle, sites, oracleFingerprint: replayOracleFingerprint({ sites }) } } } };
      expect(() => validateDaemonReplayConfig(modified)).toThrow();
    }
    expect(() => validateDaemonReplayConfig({ ...frozen, levels: [1, 1] })).toThrow('ladder');
    expect(() => validateDaemonReplayConfig({ ...frozen, runId: '../overwrite' })).toThrow('identity');
  });
  it('requires cheap completion inside actual expensive wire occupancy, not just overlapping RPC waits', () => {
    const live = report();
    expect(replayWireOverlap(live)).toBe(true);
    for (const sample of live.samples) if (sample.request.queryClass === 'hot-references') {
      (sample.answer as LspDaemonAnswer).daemonEvidence!.wire[0].endedAtMs = 9;
    }
    expect(live.classesOverlap).toBe(true);
    expect(replayWireOverlap(live)).toBe(false);
  });
  it('requires exact native reference command identity for overlap and terminal wire proof', () => {
    const live = report();
    for (const sample of live.samples) if (sample.request.queryClass === 'hot-references') {
      const evidence = (sample.answer as LspDaemonAnswer).daemonEvidence!;
      evidence.wire[0] = { ...evidence.wire[0], method: 'workspace/executeCommand', command: 'papercusp/semanticReferences' };
    }
    expect(replayWireOverlap(live)).toBe(true);
    expect(replayEvidenceProblems(live)).toEqual([]);
    for (const sample of live.samples) if (sample.request.queryClass === 'hot-references') {
      const evidence = (sample.answer as LspDaemonAnswer).daemonEvidence!;
      evidence.wire[0] = { ...evidence.wire[0], command: 'unrelated-command' };
    }
    expect(replayWireOverlap(live)).toBe(false);
    expect(replayEvidenceProblems(live)).toEqual(live.samples.filter(sample => sample.request.queryClass === 'hot-references')
      .map(sample => `unsettled-wire:${sample.request.id}`));
  });
  it('refuses wrong request IDs, unconfirmed durable receipts and pending wires even on healthy replies', () => {
    const live = report();
    expect(replayEvidenceProblems(live)).toEqual([]);
    (live.samples[0].answer as LspDaemonAnswer).daemonEvidence!.wire[0].endedAtMs = null;
    const answer = live.samples[1].answer as LspDaemonAnswer;
    const broken: LspDaemonAnswer = { ...answer, daemonEvidence: { ...answer.daemonEvidence!,
      events: answer.daemonEvidence!.events.map(event => event.phase === 'durable-settled' ? { ...event, confirmed: false } : event) } };
    const missing = { ...live.samples[2], answer: { ...live.samples[2].answer!, daemonEvidence: undefined } };
    expect(replayEvidenceProblems({ ...live, samples: [live.samples[0], { ...live.samples[1], answer: broken }, missing] }))
      .toEqual([`unsettled-wire:${live.samples[0].request.id}`, `unconfirmed-durable-settlement:${live.samples[1].request.id}`,
        `missing-daemon-identity:${live.samples[2].request.id}`]);
  });
  it('measures the whole durable settlement tail while retaining the later client completion', () => {
    const live = report();
    const oracle = { sites: [], sourceFingerprint: 'source', oracleFingerprint: 'oracle' };
    const durable = replayDurableReport(live, { definition: oracle, 'hot-references': oracle });
    expect(durable.classes.definition.elapsedMs).toBe(9);
    expect(durable.classes['hot-references'].elapsedMs).toBe(20);
    expect(durable.samples[0]).toMatchObject({ settledAtMs: 9, clientSettledAtMs: 22 });
    expect(replayEvidenceProblems(durable)).toEqual([]);
  });
  it('builds the complete source oracle across an alias while excluding comments and a same-name shadow', () => {
    const frozen = config();
    const root = frozen.rootPath;
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: ['source.ts', 'consumer.ts'] }));
    writeFileSync(join(root, 'consumer.ts'), ["import { hot as alias } from './source';", 'alias();',
      'function shadow() { const hot = () => 2; hot(); }', '// hot();', ''].join('\n'));
    const oracle = freezeCompilerReplayConfig({ runId: 'independent', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1, 8, 1000], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'consumer.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'source-authored-test' });
    expect(oracle.corpus.definition.oracle.sites).toEqual([{ path: 'source.ts', line1: 1 }]);
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([{ path: 'consumer.ts', line1: 1 },
      { path: 'consumer.ts', line1: 2 }, { path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]);
  });
  it.each(['hot', 'hot: alias'])('counts the exported property of dynamic-import destructuring (%s), excluding local uses and a same-name export', binding => {
    const frozen = config();
    const root = frozen.rootPath;
    const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, files: ['source.ts', 'consumer.ts', 'decoy.ts'] }));
    writeFileSync(join(root, 'decoy.ts'), 'export function hot() {}\n');
    writeFileSync(join(root, 'consumer.ts'), ['export async function consume() {',
      `  const [{ ${binding} }, { hot: shadow }] = await Promise.all([import('./source'), import('./decoy')]);`,
      `  ${binding === 'hot' ? 'hot' : 'alias'}(); shadow();`, '}'].join('\n'));
    // An independent checker observation distinguishes a missing export-property
    // reference from a same-spelling local binding or another module's export.
    const program = ts.createProgram(['source.ts', 'consumer.ts', 'decoy.ts'].map(file => join(root, file)), options);
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(join(root, 'source.ts'))!;
    const target = checker.getSymbolAtLocation((source.statements[0] as ts.FunctionDeclaration).name!)!;
    const consumer = program.getSourceFile(join(root, 'consumer.ts'))!;
    const fn = consumer.statements[0] as ts.FunctionDeclaration;
    const declaration = (fn.body!.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    const patterns = (declaration.name as ts.ArrayBindingPattern).elements as ts.NodeArray<ts.BindingElement>;
    const element = (patterns[0].name as ts.ObjectBindingPattern).elements[0];
    expect(checker.getTypeAtLocation(element.parent).getProperty('hot')).toBe(target);
    expect(checker.getSymbolAtLocation(element.name)).not.toBe(target);
    expect(checker.getTypeAtLocation(patterns[1].name).getProperty('hot')).not.toBe(target);
    const oracle = freezeCompilerReplayConfig({ runId: 'dynamic-binding', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'independent-dynamic-binding-fixture' });
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([
      { path: 'consumer.ts', line1: 2 }, { path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 },
    ]);
  });
  it.each(['hot', 'hot: alias'])('resolves workspace package exports through Promise.all destructuring (%s)', binding => {
    const frozen = config();
    const root = frozen.rootPath;
    const pkg = join(root, 'workspace-package'); mkdirSync(pkg);
    mkdirSync(join(root, 'node_modules', '@fixture'), { recursive: true });
    symlinkSync(pkg, join(root, 'node_modules', '@fixture', 'hot'));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/hot', type: 'module',
      main: './index.ts', types: './index.ts', exports: { '.': './index.ts' } }));
    writeFileSync(join(pkg, 'index.ts'), "export { hot } from '../source';\n");
    writeFileSync(join(root, 'decoy.ts'), 'export function hot() {}\n');
    writeFileSync(join(root, 'consumer.ts'), ["import { hot as imported } from '@fixture/hot';", 'imported();',
      'export async function consume() {',
      `  const [{ ${binding} }, { hot: shadow }] = await Promise.all([import('@fixture/hot'), import('./decoy')]);`,
      `  ${binding === 'hot' ? 'hot' : 'alias'}(); shadow();`, '}'].join('\n'));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext',
      moduleResolution: 'Bundler', strict: true }, files: ['source.ts', 'consumer.ts', 'decoy.ts'] }));
    const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
    const program = ts.createProgram(['source.ts', 'consumer.ts', 'decoy.ts'].map(file => join(root, file)), options);
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(join(root, 'source.ts'))!;
    const target = checker.getSymbolAtLocation((source.statements[0] as ts.FunctionDeclaration).name!)!;
    const consumer = program.getSourceFile(join(root, 'consumer.ts'))!;
    const fn = consumer.statements[2] as ts.FunctionDeclaration;
    const declaration = (fn.body!.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    const patterns = (declaration.name as ts.ArrayBindingPattern).elements as ts.NodeArray<ts.BindingElement>;
    const element = (patterns[0].name as ts.ObjectBindingPattern).elements[0];
    const exported = checker.getTypeAtLocation(element.parent).getProperty('hot')!;
    expect(checker.getAliasedSymbol(exported)).toBe(target);
    // The historical scanner saw only this local symbol in the shorthand case;
    // package spelling, re-exports and the other tuple member must not blur it.
    expect(checker.getSymbolAtLocation(element.name)).not.toBe(target);
    expect(checker.getTypeAtLocation(patterns[1].name).getProperty('hot')).not.toBe(target);
    const oracle = freezeCompilerReplayConfig({ runId: 'package-dynamic-binding', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'authored-workspace-package-binding-fixture' });
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([
      { path: 'consumer.ts', line1: 1 }, { path: 'consumer.ts', line1: 2 }, { path: 'consumer.ts', line1: 4 },
      { path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }, { path: 'workspace-package/index.ts', line1: 1 },
    ]);
  });
  it('freezes inherited config and declaration dependencies that determine symbol binding', () => {
    const frozen = config();
    const root = frozen.rootPath;
    writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', files: ['source.ts', 'ambient.d.ts'] }));
    writeFileSync(join(root, 'ambient.d.ts'), 'declare const ambient: string;\n');
    const oracle = freezeCompilerReplayConfig({ runId: 'config-closure', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'config-closure-fixture' });
    expect(oracle.files[join(root, 'base.json')]).toBe(replayHash(readFileSync(join(root, 'base.json'))));
    expect(oracle.files[join(root, 'ambient.d.ts')]).toBeTruthy();
    writeFileSync(join(root, 'base.json'), '{}');
    expect(() => validateDaemonReplayConfig(oracle)).toThrow('changed-file');
  });
  it('rejects a disk edit after compiler load instead of labeling old bindings with the new bytes', () => {
    const frozen = config();
    const root = frozen.rootPath;
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const phases: string[] = [];
    expect(() => freezeCompilerReplayConfig({ runId: 'loaded-drift', rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'disk-mutation-control' }, { onProgress: progress => {
        phases.push(progress.phase);
        if (progress.phase === 'compiler-loaded') writeFileSync(join(root, 'source.ts'), 'export function replacement() {}\nreplacement();\n');
      } })).toThrow(`changed-file:${join(root, 'source.ts')}`);
    expect(phases).toContain('references-scanned');
    expect(phases).not.toContain('validated');
  });
  it.each(['utf8', 'utf16le', 'utf16be'] as const)('retains original %s BOM bytes used for compiler binding', encoding => {
    const frozen = config();
    const root = frozen.rootPath;
    const source = 'export function hot() {}\nhot();\n';
    const bytes = encoding === 'utf8' ? Buffer.from(`\uFEFF${source}`) :
      Buffer.concat([Buffer.from(encoding === 'utf16le' ? [255, 254] : [254, 255]),
        encoding === 'utf16le' ? Buffer.from(source, 'utf16le') : Buffer.from(source, 'utf16le').swap16()]);
    writeFileSync(join(root, 'source.ts'), bytes);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['source.ts'], compilerOptions: { noLib: true } }));
    const oracle = freezeCompilerReplayConfig({ runId: `bom-${encoding}`, rootPath: root, socketPath: frozen.socketPath,
      workspaceId: 'test', levels: [1], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: { file: 'source.ts', line1: 2, character: 1 }, references: { file: 'source.ts', line1: 2, character: 1 },
      runtimeFiles: [], evidenceRef: 'encoded-source-control' });
    expect(oracle.files[join(root, 'source.ts')]).toBe(replayHash(bytes));
    expect(oracle.corpus['hot-references'].oracle.sites).toEqual([{ path: 'source.ts', line1: 1 }, { path: 'source.ts', line1: 2 }]);
  });
});

describe('kernel replay process provenance', () => {
  const taskId = 'replayserver';
  const cgroup = `/papercusp.slice/${scopeUnitForTask(taskId)}`;
  function fixture() {
    const identities = new Map([[10, 'linux:boot:100'], [11, 'linux:boot:101']]);
    const process = {
      identity: (pid: number) => identities.get(pid) ?? null,
      text: (path: string) => path.endsWith('/cgroup') ? `0::${cgroup}${path.includes('/11/') ? '/worker' : ''}` : 'node\0server.js\0',
      bytes: () => Buffer.from('actual executable inode'),
      link: () => '/usr/bin/node',
    };
    const root = `/sys/fs/cgroup${cgroup}`;
    const fs = {
      readFile: (path: string) => path === `${root}/cgroup.procs` ? '10\n' : path === `${root}/worker/cgroup.procs` ? '11\n' : null,
      readDir: (path: string) => path === root ? ['worker'] : [],
      isDir: (path: string) => path === root || path === `${root}/worker`,
    };
    return { process, fs, identities };
  }
  it('censuses nested server children and retains kernel executable bytes without claiming loaded JS', () => {
    const deps = fixture();
    const population = replayServerPopulation(10, taskId, deps);
    expect(population.unknown).toEqual([]);
    expect(population.processes.map(row => row.pid)).toEqual([10, 11]);
    expect(population.processes[1]).toMatchObject({ identity: 'linux:boot:101',
      executable: { path: '/usr/bin/node', sha256: replayHash(Buffer.from('actual executable inode')) }, loadedModules: 'unmeasured' });
    deps.identities.set(11, 'linux:boot:999');
    expect(replayPopulationFingerprint(replayServerPopulation(10, taskId, deps))).not.toBe(replayPopulationFingerprint(population));
  });
  it('rejects PID reuse during reads and unavailable executable evidence', () => {
    const deps = fixture();
    let calls = 0;
    deps.process.identity = () => ++calls === 1 ? 'linux:boot:100' : 'linux:boot:999';
    expect(replayProcessIdentity(10, deps.process).unknown).toContain('process-replaced-during-snapshot');
    expect(replayProcessIdentity(10, { ...fixture().process, bytes: () => { throw new Error('inaccessible'); } }).unknown)
      .toEqual(['executable:Error: inaccessible']);
  });
  it('rejects foreign task scopes before walking them and lost or escaped descendants', () => {
    const deps = fixture();
    expect(replayServerPopulation(10, 'other-task', deps).groups).toEqual([]);
    expect(replayServerPopulation(10, 'other-task', deps).unknown).toContain('server-task-cgroup-mismatch');
    deps.identities.delete(11);
    expect(replayServerPopulation(10, taskId, deps).unknown).toContain('pid:11:process-identity-unavailable');
    const escaped = { ...fixture().process, text: (path: string) => path.endsWith('/cgroup') ? `0::${path.includes('/11/') ? '/foreign' : cgroup}` : 'node\0' };
    expect(replayServerPopulation(10, taskId, { ...fixture(), process: escaped }).unknown).toContain('process-outside-server-cgroup:11');
  });
  it('does not treat unreadable cgroup branches as an empty, qualified population', () => {
    const deps = fixture();
    const readable = deps.fs.readFile;
    deps.fs.readFile = path => path.includes('/worker/') ? null : readable(path);
    expect(replayServerPopulation(10, taskId, deps).unknown).toContain(`unreadable-cgroup:/sys/fs/cgroup${cgroup}/worker/cgroup.procs`);
    expect(replayServerPopulation(10, taskId, { ...fixture(), fs: { ...fixture().fs,
      readDir: () => { throw new Error('permission denied'); } } }).unknown.join('\n')).toContain('permission denied');
  });
});

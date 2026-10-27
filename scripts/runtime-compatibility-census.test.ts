import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyNativeInventory, collectSystemdDirectives, INVENTORY_GROUPS, inventoryElfLibraryCandidates, inventoryNativePackages, inventorySources, parseElfDependencies, readCommittedSources } from './lib/runtime-compatibility-census.mjs';
const require = createRequire(import.meta.url);
const { collectImports } = require('../papercusp-desktop/bin/lib/runtime-import-census.cjs');
const source = (path: string, text: string) => ({ path, bytes: Buffer.from(text), repository: '.', commit: 'a'.repeat(40), blobOid: 'b'.repeat(40) });
const snapshot = (sources: ReturnType<typeof source>[]) => ({ sources, repositories: [{ path: '.', commit: 'a'.repeat(40) }], unresolved: [] as object[] });

describe('native dependency byte inventory', () => {
  const temporary: string[] = [];
  afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
  const fixture = () => {
    const path = mkdtempSync(join(tmpdir(), 'runtime-native-')); temporary.push(path);
    writeFileSync(join(path, 'package.json'), '{"name":"fixture","version":"1"}');
    return { id: path, path, manifestSha256: createHash('sha256').update(readFileSync(join(path, 'package.json'))).digest('hex') };
  };
  const elf = 'ELF Header:\n  Class: ELF64\n  Machine: Advanced Micro Devices X86-64\nDynamic section:\n 0x1 (NEEDED) Shared library: [libc.so.6]\n 0x1 (NEEDED) Shared library: [libm.so.6]\n 0x1d (RUNPATH) Library runpath: [$ORIGIN/lib]\n';
  it('finds extensionless binaries by magic and fingerprints exact bytes without loading them', async () => {
    const pkg = fixture(), bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]);
    writeFileSync(join(pkg.path, 'runner'), bytes); writeFileSync(join(pkg.path, 'ordinary.js'), 'export const x=1;');
    writeFileSync(join(pkg.path, 'model.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const inspected: string[] = [];
    const result = await inventoryNativePackages([pkg], { readelf: (path: string) => { inspected.push(path); return elf; } });
    expect(result.files.map((row) => row.path)).toEqual(['model.wasm', 'runner']);
    expect(inspected).toEqual([join(pkg.path, 'runner')]);
    expect(result.files[1]).toMatchObject({ sha256: createHash('sha256').update(bytes).digest('hex'),
      elf: { needed: ['libc.so.6', 'libm.so.6'], runpath: ['$ORIGIN/lib'] } });
    expect(result.unresolved).toEqual([]); expect(result.closureAccepted).toBe(false);
    writeFileSync(join(pkg.path, 'runner'), Buffer.concat([bytes, Buffer.from('changed')]));
    expect((await inventoryNativePackages([pkg], { readelf: () => elf })).fingerprint).not.toBe(result.fingerprint);
  });
  it('retains missing packages, escaping links, cycles and nested package exclusions', async () => {
    const pkg = fixture(), external = fixture();
    mkdirSync(join(pkg.path, 'node_modules')); writeFileSync(join(external.path, 'addon.node'), 'outside');
    symlinkSync(pkg.path, join(pkg.path, 'cycle')); symlinkSync(join(external.path, 'addon.node'), join(pkg.path, 'outside.node'));
    symlinkSync(join(pkg.path, 'missing'), join(pkg.path, 'broken.node'));
    const result = await inventoryNativePackages([pkg, { id: 'missing', path: join(pkg.path, 'missing') }]);
    expect(result.unresolved.map((row) => row.reason)).toEqual(expect.arrayContaining(['package-unavailable', 'external-symlink', 'file-unavailable']));
    expect(result.links).toContainEqual(expect.objectContaining({ path: 'cycle', target: '' }));
    expect(result.excluded).toContainEqual(expect.objectContaining({ path: 'node_modules' }));
    expect(result.files).toEqual([]); expect(result.closureAccepted).toBe(false);
  });
  it('keeps inspection failures, foreign binaries and incomplete walks explicit', async () => {
    const pkg = fixture();
    writeFileSync(join(pkg.path, 'a.node'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    writeFileSync(join(pkg.path, 'b.dll'), 'MZforeign'); writeFileSync(join(pkg.path, 'c.node'), 'unrecognized');
    const result = await inventoryNativePackages([pkg], { readelf: () => { throw new Error('missing inspector'); } });
    expect(result.unresolved.map((row) => row.reason)).toEqual(['elf-inspection-failed', 'platform-inspection-unavailable', 'unrecognized-native-file']);
    const bounded = await inventoryNativePackages([pkg], { maxEntries: 1, readelf: () => elf });
    expect(bounded.unresolved).toContainEqual(expect.objectContaining({ reason: 'entry-budget' }));
    expect(bounded.closureAccepted).toBe(false);
  });
  it('refuses manifest drift and does not infer a dependency-free ELF from invalid inspector output', async () => {
    const pkg = fixture(); writeFileSync(join(pkg.path, 'package.json'), '{}');
    const result = await inventoryNativePackages([pkg]);
    expect(result.files).toEqual([]); expect(result.unresolved[0].reason).toBe('manifest-pin-mismatch');
    expect(() => parseElfDependencies('missing readelf output')).toThrow('Incomplete ELF header');
  });
  it('detects native mutation during inspection rather than attaching stale metadata to a hash', async () => {
    const pkg = fixture(), path = join(pkg.path, 'addon.node');
    writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const result = await inventoryNativePackages([pkg], { readelf: () => { writeFileSync(path, 'changed'); return elf; } });
    expect(result.unresolved).toContainEqual(expect.objectContaining({ reason: 'file-changed-during-inspection' }));
  });
  const binary = (path: string) => {
    writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    return { realPath: path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  };
  const metadata = (needed: string[] = [], extra = '') => 'Class: ELF64\nMachine: Advanced Micro Devices X86-64\n'
    + needed.map((name) => ` (NEEDED) Shared library: [${name}]\n`).join('') + extra;
  it('follows transitive cache candidates and origin paths, terminating cycles without claiming loader acceptance', async () => {
    const pkg = fixture(), entry = binary(join(pkg.path, 'addon.node'));
    const one = binary(join(pkg.path, 'libone.so')), two = binary(join(pkg.path, 'libtwo.so'));
    const result = await inventoryElfLibraryCandidates([entry], {
      libraryCache: [{ name: 'libtwo.so', path: two.realPath }],
      readelf: (path: string) => path === entry.realPath ? metadata(['libone.so'], ' (RUNPATH) Library runpath: [$ORIGIN]\n')
        : path === one.realPath ? metadata(['libtwo.so']) : metadata(['libone.so'], ' (RPATH) Library rpath: [${ORIGIN}]\n'),
    });
    expect(result.libraries).toHaveLength(3); expect(result.edges).toHaveLength(3);
    expect(result.edges[0].candidates).toEqual([one.realPath]); expect(result.unresolved).toEqual([]);
    expect(result.closureAccepted).toBe(false); expect(result.actualLoaderResolutionVerified).toBe(false);
  });
  it('retains absent, ambiguous, incompatible and unsupported loader inputs', async () => {
    const pkg = fixture(), other = fixture(), entry = binary(join(pkg.path, 'addon.node'));
    const first = binary(join(pkg.path, 'libsame.so')), second = binary(join(other.path, 'libsame.so'));
    const foreign = binary(join(pkg.path, 'libforeign.so'));
    const result = await inventoryElfLibraryCandidates([entry], {
      libraryCache: [first, second].map((row) => ({ name: 'libsame.so', path: row.realPath }))
        .concat([{ name: 'libforeign.so', path: foreign.realPath }]),
      readelf: (path: string) => path === entry.realPath
        ? metadata(['libsame.so', 'libforeign.so', 'libmissing.so', 'relative/lib.so'], ' (RUNPATH) Library runpath: [$LIB:relative::]\n')
        : path === foreign.realPath ? metadata().replace('ELF64', 'ELF32') : metadata(),
    });
    expect(result.edges[0].candidates).toEqual([first.realPath, second.realPath]);
    expect(result.edges[1].incompatible).toEqual([foreign.realPath]);
    expect(result.unresolved.map((row) => row.reason)).toEqual(expect.arrayContaining([
      'ambiguous-library-candidates', 'needed-library-unresolved', 'relative-needed-path', 'unsupported-library-search-path',
    ]));
    expect(result.actualLoaderResolutionVerified).toBe(false);
  });
  it('rejects stale source pins and refuses unstable or uninspectable library evidence', async () => {
    const pkg = fixture(), entry = binary(join(pkg.path, 'addon.node'));
    const stale = await inventoryElfLibraryCandidates([{ ...entry, sha256: 'a'.repeat(64) }], { readelf: () => metadata(['libc.so.6']) });
    expect(stale.edges).toEqual([]); expect(stale.unresolved[0].reason).toBe('source-pin-mismatch');
    const unstable = await inventoryElfLibraryCandidates([entry], { readelf: () => { writeFileSync(entry.realPath, 'changed'); return metadata(); } });
    expect(unstable.libraries).toEqual([]); expect(unstable.unresolved[0].reason).toBe('library-changed-during-inspection');
    const invalid = await inventoryElfLibraryCandidates([entry], { readelf: () => 'not ELF' });
    expect(invalid.unresolved[0].reason).toBe('library-inspection-failed');
  });
  it('retains budget exhaustion and fingerprints the supplied library environment', async () => {
    const pkg = fixture(), entry = binary(join(pkg.path, 'addon.node')), library = binary(join(pkg.path, 'libone.so'));
    const options = { libraryCache: [{ name: 'libone.so', path: library.realPath }],
      readelf: (path: string) => metadata(path === entry.realPath ? ['libone.so'] : []) };
    const bounded = await inventoryElfLibraryCandidates([entry], { ...options, maxLibraries: 1 });
    expect(bounded.unresolved.map((row) => row.reason)).toEqual(['library-budget', 'needed-library-unresolved']);
    const first = await inventoryElfLibraryCandidates([entry], options);
    const second = await inventoryElfLibraryCandidates([entry], { ...options, environmentDirectories: [pkg.path] });
    expect(first.fingerprint).not.toBe(second.fingerprint);
    await expect(inventoryElfLibraryCandidates([entry], { libraryCache: [{ name: 'bad', path: 'relative' }] })).rejects.toThrow('absolute library inputs');
  });
});

describe('native target and caller review', () => {
  const cells = [{ id: 'server:linux:x64', os: 'linux', arch: 'x64' }, { id: 'gui:linux:arm64', os: 'linux', arch: 'arm64' }];
  const host = { os: 'linux', arch: 'x64', libc: 'glibc' };
  const file = (path: string, machine = 'Advanced Micro Devices X86-64') => ({ packageId: 'node_modules/addon', path,
    realPath: '/candidate/' + path, sha256: 'a'.repeat(64), format: 'elf', elf: { machine, needed: ['libc.so.6'] } });
  const review = (files: object[], packages: object[] = []) => classifyNativeInventory({ roots: [{ id: 'node_modules/addon' }],
    files, unresolved: [], fingerprint: 'native-pin' }, { unresolved: [], fingerprint: 'elf-pin' }, { packages, platformCells: cells, host });
  it('keeps Android x64 distinct from Linux x64 and retains supported foreign architectures', () => {
    const result = review([{ ...file('prebuilds/android-x64/addon.node'), elf: { machine: 'Advanced Micro Devices X86-64', needed: ['libc.so'] } },
      file('prebuilds/linux-arm64/addon.node', 'AArch64')]);
    expect(result.rows[0]).toMatchObject({ hostRelation: 'different-os', candidateCells: [], target: { os: 'android', arch: 'x64', libc: 'bionic' } });
    expect(result.rows[1]).toMatchObject({ hostRelation: 'different-arch', candidateCells: ['gui:linux:arm64'] });
    expect(result.closureAccepted).toBe(false);
  });
  it('retains package optionality and separates musl targets from the glibc host', () => {
    const result = review([{ ...file('addon.node'), packageId: 'node_modules/addon-linux-x64-musl', elf: { machine: 'Advanced Micro Devices X86-64', needed: ['libc.musl-x86_64.so.1'] } }],
      [{ key: 'node_modules/parent', edges: [{ to: 'node_modules/addon', field: 'optionalDependencies', optional: true }] },
        { key: 'node_modules/addon-linux-x64-musl', lock: { os: ['linux'], cpu: ['x64'] } }]);
    expect(result.rows[0]).toMatchObject({ hostRelation: 'different-libc', operationalRole: 'node-addon-candidate', selectorVerified: false });
    expect(result.packages[0].callerEdges).toEqual([{ from: 'node_modules/parent', field: 'optionalDependencies', optional: true }]);
  });
  it('does not trust target names over binary architecture or package exclusions', () => {
    const result = review([file('prebuilds/linux-x64/addon.node', 'AArch64')],
      [{ key: 'node_modules/addon', lock: { os: ['!linux'], cpu: ['x64'] } }]);
    expect(result.rows[0].target.conflicts).toEqual(['path-elf-architecture-mismatch', 'package-os-mismatch', 'package-cpu-mismatch']);
    expect(result.rows[0].hostRelation).toBe('conflicting-evidence');
    expect(result.actualLoaderResolutionVerified).toBe(false);
  });
  it('retains unattributed transitive gaps and unknown target evidence', () => {
    const result = classifyNativeInventory({ roots: [], files: [file('addon.node')], unresolved: [{ packageId: 'missing', path: 'package.json', reason: 'package-unavailable' }] },
      { unresolved: [{ path: '/system/libfoo.so', reason: 'needed-library-unresolved', name: 'libbar.so' }] },
      { packages: [], platformCells: cells, host });
    expect(result.rows[0]).toMatchObject({ hostRelation: 'unknown', packageContextAvailable: false, target: { os: null } });
    expect(result.gaps).toHaveLength(2); expect(result.gaps[1].file).toBeNull();
    expect(result.rows[0].runtimeAcceptance).toBe('not-measured');
  });
});

describe('committed runtime migration inventory discovery', () => {
  it('decodes exact Git blob bytes with binary input/output rather than an encoding named buffer', () => {
    const bytes = Buffer.from('export const x = "😀";'), oid = 'b'.repeat(40), root = process.cwd();
    const runGit = (_root: string, args: string[], options?: { encoding: unknown; input: Buffer }) => {
      if (args.includes('--show-toplevel')) return root;
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'ls-tree') return `100644 blob ${oid} ${bytes.length}\tmain.ts\0`;
      expect(options?.encoding).toBeNull(); expect(Buffer.isBuffer(options?.input)).toBe(true);
      return Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]);
    };
    const result = readCommittedSources(root, 'HEAD', { runGit });
    expect(result.sources[0].bytes).toEqual(bytes); expect(result.unresolved).toEqual([]);
  });
  it('retains an oversized source as a pinned gap without reading its blob', () => {
    const root = process.cwd(), oid = 'b'.repeat(40);
    const runGit = (_root: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return root;
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      expect(args[0]).toBe('ls-tree'); return `100644 blob ${oid} 999999999\tlarge.js\0`;
    };
    const result = readCommittedSources(root, 'HEAD', { runGit });
    expect(result.sources).toEqual([]);
    expect(result.unresolved[0]).toMatchObject({ path: 'large.js', blobOid: oid, reason: 'nonregular-or-over-budget-source' });
  });
  it('includes extensionless executables and launch control formats from committed tree metadata', () => {
    const root = process.cwd();
    const entries = [
      ['100755', 'bin/launch', '#!/bin/sh\nexec node host.mjs\n'],
      ['100644', 'runner.py', 'subprocess.run(["node", "host.mjs"])\n'],
      ['100644', 'operator.desktop', '[Desktop Entry]\nExec=node host.mjs\n'],
      ['100644', 'Dockerfile.operator', 'ENTRYPOINT ["node", "host.mjs"]\n'],
      ['100644', 'agent.plist', '<string>node</string>\n'],
      ['100644', 'systemd/host.service.d/override.conf', '[Service]\nExecStart=\nExecStart=node host.mjs\n'],
      ['100644', 'systemd/host.timer', '[Timer]\nUnit=host.service\n'],
      ['120000', 'bin/linked-launch', 'launch'],
      ['100644', 'unrelated.txt', 'not a source'],
    ].map(([mode, path, text], index) => ({ mode, path, bytes: Buffer.from(text), oid: (index + 1).toString(16).repeat(40) }));
    const runGit = (_root: string, args: string[], options?: { input: Buffer }) => {
      if (args.includes('--show-toplevel')) return root;
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'ls-tree') return entries.map((entry) => `${entry.mode} blob ${entry.oid} ${entry.bytes.length}\t${entry.path}\0`).join('');
      return Buffer.concat(options!.input.toString().trim().split('\n').map((oid) => {
        const entry = entries.find((candidate) => candidate.oid === oid)!;
        return Buffer.concat([Buffer.from(`${oid} blob ${entry.bytes.length}\n`), entry.bytes, Buffer.from('\n')]);
      }));
    };
    const result = inventorySources(readCommittedSources(root, 'HEAD', { runGit }));
    expect(result.files.map((file) => file.path)).toEqual(['agent.plist', 'bin/launch', 'Dockerfile.operator', 'operator.desktop', 'runner.py',
      'systemd/host.service.d/override.conf', 'systemd/host.timer']);
    expect(result.groups.launchers.map((row) => row.id)).toEqual(['agent.plist', 'bin/launch', 'Dockerfile.operator', 'operator.desktop', 'runner.py',
      'systemd/host.service.d/override.conf']);
    expect(result.unresolved).toContainEqual(expect.objectContaining({ path: 'bin/linked-launch', reason: 'nonregular-or-over-budget-source' }));
    expect(result.closureAccepted).toBe(false);
  });
  it('does not reuse a fingerprint across changed unavailable repository pins', () => {
    const input = snapshot([]); input.unresolved.push({ repository: 'missing', revision: 'old', reason: 'unavailable' });
    const first = inventorySources(input).sourceFingerprint;
    input.unresolved[0] = { repository: 'missing', revision: 'new', reason: 'unavailable' };
    expect(inventorySources(input).sourceFingerprint).not.toBe(first);
  });
  it('retains multiline launch overrides and empty resets separately from inactive comments', () => {
    const text = ['# ExecStart=node wrong.mjs', '[Service]', 'ExecStart=',
      'ExecStart=/bin/bash -c "exec env \\', '# comment in a continuation',
      '  PAPERCUSP_BACKGROUND_WORKERS=1 \\', '  node dist-host/hono-host.mjs"',
      'EnvironmentFile=-/external/runtime.env', '[Unit]', 'Requires=db.service'].join('\n');
    const result = inventorySources(snapshot([source('systemd/host.service.d/95-entry.conf', text)]));
    const control = result.files[0].launchControl;
    expect(control.directives.filter((row) => row.key === 'ExecStart')).toEqual([
      { section: 'Service', key: 'ExecStart', value: '', firstLine: 3, lastLine: 3 },
      { section: 'Service', key: 'ExecStart', value: '/bin/bash -c "exec env    PAPERCUSP_BACKGROUND_WORKERS=1    node dist-host/hono-host.mjs"', firstLine: 4, lastLine: 7 },
    ]);
    expect(control.directives).toContainEqual(expect.objectContaining({ section: 'Service', key: 'EnvironmentFile', value: '-/external/runtime.env' }));
    expect(control.directives).toContainEqual(expect.objectContaining({ section: 'Unit', key: 'Requires', value: 'db.service' }));
    expect(control.unresolved).toEqual([]);
    expect(control.effectiveConfigurationVerified).toBe(false);
    expect(result.closureAccepted).toBe(false);
  });
  it('keeps malformed or incomplete unit input as a gap instead of certifying its launch command', () => {
    const control = collectSystemdDirectives('host.service', 'ExecStart=node outside-section.mjs\n[Service]\n.invalid\nExecStart=node \\');
    expect(control.directives).toEqual([]);
    expect(control.unresolved.map((row) => row.reason)).toEqual([
      'unparsed-systemd-statement', 'unparsed-systemd-statement', 'unterminated-systemd-continuation',
    ]);
    const result = inventorySources(snapshot([source('host.service', '[Service]\nExecStart=node \\')]));
    expect(result.unresolved).toContainEqual(expect.objectContaining({ path: 'host.service', reason: 'unterminated-systemd-continuation' }));
  });
  it('selects generated unit templates without interpreting arbitrary scripts or inline hash characters as comments', () => {
    const control = collectSystemdDirectives('infra/systemd/host.service.tmpl', '[Service]\nEnvironment="LABEL=a#b"\nExecStart=node host.mjs');
    expect(control.directives[0].value).toBe('"LABEL=a#b"');
    expect(collectSystemdDirectives('infra/systemd/install.sh', '[Service]\nExecStart=node host.mjs')).toBeNull();
  });
  it('parses pinned bytes without a corresponding working-tree file', () => {
    expect(collectImports('/nonexistent/pinned.ts', Buffer.from('import addon from "some-native-addon";')).imports[0].specifier).toBe('some-native-addon');
  });
  it('includes arbitrary value imports without restricting discovery to native addon seeds', () => {
    const result = inventorySources(snapshot([source('apps/main.ts', 'import x from "new-capability"; export const run = () => x();')]));
    expect(result.groups.capabilities.map((row) => row.id)).toEqual(['apps/main.ts']);
    expect(result.closureAccepted).toBe(false);
  });
  it('retains dynamic imports and unavailable gitlinks as unresolved', () => {
    const input = snapshot([source('packages/host.ts', 'export const run = (name) => import(name);')]);
    input.unresolved.push({ repository: 'libs/missing', reason: 'pinned-repository-unavailable' });
    expect(inventorySources(input).unresolved.map((row) => row.reason)).toEqual(['pinned-repository-unavailable', 'dynamic-or-generated-module']);
  });
  it('does not turn a comment into a launch boundary', () => {
    const result = inventorySources(snapshot([source('packages/types.ts', '// spawn("node")\nimport type { X } from "not-executed";')]));
    expect(result.groups.launchers).toEqual([]);
    // Syntax signals can overapproximate type declarations; the import record
    // itself must preserve typeOnly so review cannot treat it as execution.
    expect(result.files[0].imports[0].typeOnly).toBe(true);
  });
  it('keeps test/fixture source visible without declaring it unreachable', () => {
    const result = inventorySources(snapshot([source('packages/__tests__/host.test.ts', 'import { fork } from "node:child_process"; fork("child.js");')]));
    expect(result.files[0].sourceKind).toBe('test-or-fixture');
    expect(result.groups.launchers[0].classification).toBe('unreviewed');
  });
  it('changes the fingerprint for changed bytes or a changed repository revision', () => {
    const input = snapshot([source('apps/main.ts', 'export const n = 1;')]), first = inventorySources(input).sourceFingerprint;
    input.sources[0].bytes = Buffer.from('export const n = 2;'); expect(inventorySources(input).sourceFingerprint).not.toBe(first);
    input.sources[0].bytes = Buffer.from('export const n = 1;'); input.sources[0].commit = 'c'.repeat(40);
    expect(inventorySources(input).sourceFingerprint).not.toBe(first);
  });
  it('keeps distinct platform signals without claiming they define a matrix', () => {
    const result = inventorySources(snapshot([source('release.config.ts', 'export const targets = ["linux-arm64", "macos-universal", "windows-x86_64"];')]));
    expect(Object.keys(result.groups)).toEqual(INVENTORY_GROUPS);
    expect(result.groups.platforms[0].signals).toHaveLength(3);
    expect(result.closureAccepted).toBe(false);
  });
  it('recognizes platform strings after interpolated templates without swallowing source text', () => {
    const text = 'export const message = `echo ${value}`; export const targets = ["windows-x86_64", "macos-universal"];';
    const result = inventorySources(snapshot([source('release.config.ts', text)]));
    expect(result.groups.platforms[0].signals.map((signal) => signal.value)).toEqual(['windows-x86_64', 'macos-universal']);
  });
});

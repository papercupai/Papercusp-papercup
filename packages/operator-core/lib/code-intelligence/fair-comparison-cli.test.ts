import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildArm, fairProcessCensus, FAIR_ARM_IDS, frozenGraphRequest, indexFileCensus, loadFairInputs, materializeFrozenControls,
  materializeFrozenRepositoryTask, measureFairToolPayload, prepareFrozenControl, validateFrozenInputs, verifyFrozenSource,
  verifyFairWorkerSource, workspaceDirs, type FrozenFairInputs } from './fair-comparison-cli';

// Transitive users can mock only their own subprocess seam. Importing the CLI's
// helpers must not read/promisify the absent execFile before an actual CLI run.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
// The engines have their own conformance suites. Isolate their subprocess graph
// so a different engine's eager wrapper cannot hide this CLI import regression.
vi.mock('./fair-comparison-arms', () => ({
  createRgFairArm: vi.fn(() => ({ capabilities: { armId: 'rg' } })),
}));
vi.mock('./fair-comparison-engines', () => ({}));
vi.mock('./fair-comparison-first-party', () => ({}));

// P-017 (D-011..D-016): each arm's tree gets node_modules/<name> links built from the
// root `workspaces`. workspaceDirs is the expansion; a pattern it cannot expand would
// silently drop links and make cross-package answers look like engine misses.

const root = mkdtempSync(join(tmpdir(), 'p017-ws-'));
const pkg = (dir: string, name = dir.replace(/\//g, '-')) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name }));
};
pkg('apps/operator');
pkg('apps/operator-checkpoint');
pkg('packages/a');
pkg('packages/b');
mkdirSync(join(root, 'packages/no-manifest'), { recursive: true });
writeFileSync(join(root, 'packages/README.md'), 'not a package');
pkg('libs/exact');
mkdirSync(join(root, 'libs/exact-missing-manifest'), { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('workspaceDirs', () => {
  it('expands a trailing /* to the child dirs that hold a package.json', async () => {
    expect((await workspaceDirs(root, ['packages/*'])).sort()).toEqual(['packages/a', 'packages/b']);
  });

  it('keeps an exact dir only when it holds a package.json', async () => {
    expect(await workspaceDirs(root, ['libs/exact', 'libs/exact-missing-manifest', 'apps/operator'])).toEqual(['libs/exact', 'apps/operator']);
  });

  it('treats a missing /* parent as empty rather than throwing', async () => {
    expect(await workspaceDirs(root, ['nowhere/*', 'packages/a'])).toEqual(['packages/a']);
  });

  it('applies exclusions regardless of order and deduplicates overlapping inclusions', async () => {
    expect(await workspaceDirs(root, ['apps/*', '!apps/*-checkpoint', 'apps/operator'])).toEqual(['apps/operator']);
    expect(await workspaceDirs(root, ['!apps/*-checkpoint', 'apps/*'])).toEqual(['apps/operator']);
    expect(await workspaceDirs(root, ['!apps/*-checkpoint'])).toEqual([]);
  });

  it('resolves the real root workspace inclusions while honoring its exclusions', async () => {
    const repo = resolve(__dirname, '../../../..');
    const { workspaces = [] } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { workspaces?: string[] };
    expect(workspaces.length).toBeGreaterThan(0);
    const dirs = await workspaceDirs(repo, workspaces);
    expect(dirs).toContain('apps/operator');
    expect(dirs.some(dir => /^apps\/.*-checkpoint$/.test(dir))).toBe(false);
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const p of workspaces.filter(pattern => !pattern.startsWith('!'))) {
      expect(await workspaceDirs(repo, [p]), p).not.toEqual([]);
    }
  });
});

describe('FAIR_ARM_IDS', () => {
  it('names the eight arms the preregistration froze', () => {
    expect([...FAIR_ARM_IDS].sort()).toEqual(['codebase-memory', 'codegraph', 'codegraphcontext', 'gitnexus', 'lsp-query', 'no-third-party', 'rg', 'trace-mcp']);
  });
});

describe('CLI import without execFile', () => {
  it('constructs an arm without starting a subprocess under a narrow mock', async () => {
    expect((await buildArm('rg')).capabilities.armId).toBe('rg');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses mixed worker contracts before launch and propagates unreadable provenance', async () => {
    const read = vi.fn(async (path: string, version: 'working' | 'committed') =>
      version === 'working' && path.endsWith('fair-comparison-run.ts') ? 'new-contract' : 'committed-contract');
    await expect(verifyFairWorkerSource(read)).rejects.toThrow(/differs from committed child.*lint:as-committed/);
    expect(spawn).not.toHaveBeenCalled();
    await expect(verifyFairWorkerSource(async () => 'same-contract')).resolves.toBeUndefined();
    await expect(verifyFairWorkerSource(async () => { throw new Error('git source unavailable'); }))
      .rejects.toThrow('git source unavailable');
  });
});

describe('logical index file census', () => {
  it('keeps source and dependency baseline files apart from newly created index/cache files', async () => {
    const isolated = mkdtempSync(join(tmpdir(), 'fair-index-census-'));
    try {
      const source = join(isolated, 'source.ts');
      writeFileSync(source, 'export const source = 1;');
      expect(await indexFileCensus([isolated], new Set([source]))).toEqual([]);
      mkdirSync(join(isolated, 'cache'));
      const index = join(isolated, 'cache', 'index');
      writeFileSync(index, '1234567');
      expect(await indexFileCensus([isolated], new Set([source]))).toEqual([{ path: index, bytes: 7 }]);
    } finally { rmSync(isolated, { recursive: true, force: true }); }
  });
  it('returns unknown for incomplete paths, rather than an apparently measured empty index', async () => {
    expect(await indexFileCensus([join(root, 'missing-index-root')], new Set())).toBeNull();
  });
});

describe('fresh task point process census', () => {
  const taskId = 'aaa123', cgroupPath = '/user.slice/pc-aaa123.scope';
  const absolute = `/sys/fs/cgroup${cgroupPath}`;
  const expected = { taskId, cgroupPath, rootPid: 10, rootIdentity: 'linux:boot:10' };
  const fixture = () => ({
    fs: {
      readFile: (path: string) => path === `${absolute}/cgroup.procs` ? '10\n11\n' :
        path === `${absolute}/child/cgroup.procs` ? '12\n' : '999\n',
      readDir: (path: string) => path === absolute ? ['child', 'cgroup.procs', 'pids.current'] : [],
      isDir: (path: string) => path === absolute || path === `${absolute}/child`,
    },
    identity: (pid: number) => `linux:boot:${pid}`,
    cgroup: (pid: number) => pid === 12 ? `${cgroupPath}/child` : cgroupPath,
  });

  it('counts process leaders across child scopes, excludes the worker and ignores thread counters', () => {
    const deps = fixture();
    const read = vi.spyOn(deps.fs, 'readFile');
    const census = fairProcessCensus(expected, deps);
    expect(census.childProcesses).toBe(2);
    expect(census.processes.map(row => row.pid)).toEqual([10, 11, 12]);
    expect(census.unknown).toEqual([]);
    expect(read.mock.calls.some(([path]) => path.endsWith('/pids.current'))).toBe(false);
    expect(census).not.toHaveProperty('peakChildProcesses');
  });

  it('refuses foreign scopes and changed worker identity before reading their population', () => {
    for (const changed of [{ ...expected, taskId: 'bbb123' }, { ...expected, rootIdentity: 'linux:boot:old' }]) {
      const deps = fixture(), read = vi.spyOn(deps.fs, 'readFile');
      expect(fairProcessCensus(changed, deps).childProcesses).toBeNull();
      expect(read).not.toHaveBeenCalled();
    }
  });

  it('keeps unreadable and malformed child branches unknown instead of counting an empty branch', () => {
    for (const missing of [null, '12\ninvalid\n']) {
      const deps = fixture(), read = deps.fs.readFile;
      const census = fairProcessCensus(expected, { ...deps, fs: { ...deps.fs,
        readFile: path => path === `${absolute}/child/cgroup.procs` ? missing : read(path) } });
      expect(census.childProcesses).toBeNull();
      expect(census.unknown).toContain(`unreadable-process-census:${absolute}/child/cgroup.procs`);
    }
    const deps = fixture();
    expect(fairProcessCensus(expected, { ...deps, fs: { ...deps.fs,
      readDir: () => { throw new Error('denied'); } } }).childProcesses).toBeNull();
  });

  it('rejects population changes, PID replacement and processes that escape their task scope', () => {
    const deps = fixture(), read = deps.fs.readFile;
    let reads = 0;
    const changing = fairProcessCensus(expected, { ...deps, fs: { ...deps.fs,
      readFile: path => path === `${absolute}/cgroup.procs` && ++reads > 1 ? '10\n' : read(path) } });
    expect(changing.childProcesses).toBeNull();
    expect(changing.unknown).toContain('cgroup-population-changed-during-census');
    let identities = 0;
    const replaced = fairProcessCensus(expected, { ...deps,
      identity: pid => pid === 11 && ++identities > 1 ? 'linux:boot:new' : deps.identity(pid) });
    expect(replaced.childProcesses).toBeNull();
    expect(replaced.unknown).toContain('process-replaced-during-census:11');
    const escaped = fairProcessCensus(expected, { ...deps,
      cgroup: pid => pid === 12 ? `${cgroupPath}-foreign` : cgroupPath });
    expect(escaped.childProcesses).toBeNull();
    expect(escaped.unknown).toContain('process-outside-worker-cgroup:12');
  });
});

describe('saved native protocol inputs and worker controls', () => {
  const frozenPath = new URL('../../../../docs/evidence/native-code-intelligence-preregistration-2026-10-09.json', import.meta.url);
  const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as FrozenFairInputs;
  const control = (state: string, configuration = 'configured') => frozen.cases.find(kase =>
    kase.language === 'typescript' && kase.intent === 'callers' && kase.source === 'authored' &&
    kase.subject === 'target' && kase.sourceState === state && kase.configuration === configuration)!;

  it('refuses changed native questions and text-search topology substitution before dispatch', () => {
    const kase = frozen.cases.find(candidate => candidate.id === 'native-real-javascript-definition-main')!;
    expect(frozenGraphRequest(kase, frozen)).toMatchObject({ op: 'symbol', paths: [kase.anchorFile] });
    expect(() => frozenGraphRequest({ ...kase, subject: 'unregistered' }, frozen)).toThrow(/differs from frozen/);
    expect(() => frozenGraphRequest(frozen.cases.find(candidate =>
      candidate.id === 'native-real-javascript-text-search-main')!, frozen)).toThrow(/does not cover text-search/);
  });

  it('loads all saved cases and keys without generating or rewriting preregistration', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fair-frozen-input-'));
    try {
      const original = readFileSync(frozenPath, 'utf8');
      const loaded = await loadFairInputs(out, frozenPath.pathname);
      expect(loaded.cases).toHaveLength(143);
      expect(loaded.keys).toHaveLength(143);
      expect(loaded.preregistration.hash).toBe(frozen.preregistration.hash);
      expect(readFileSync(frozenPath, 'utf8')).toBe(original);
      expect(existsSync(join(out, 'prereg.json'))).toBe(false);
      writeFileSync(join(out, 'prereg.json'), JSON.stringify(frozen.preregistration));
      await expect(loadFairInputs(out)).rejects.toThrow(/requires --frozen/);
      await expect(loadFairInputs(out, frozenPath.pathname)).resolves.toEqual(frozen);
      writeFileSync(join(out, 'prereg.json'), JSON.stringify({ ...frozen.preregistration, seed: 1 }));
      await expect(loadFairInputs(out, frozenPath.pathname)).rejects.toThrow(/differs from frozen/);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('refuses changed questions, keys, fixture bytes and unsafe file paths before materialization', async () => {
    expect(() => validateFrozenInputs({ ...frozen, cases: frozen.cases.slice(1) })).toThrow(/cases or keys/);
    expect(() => validateFrozenInputs({ ...frozen, keys: frozen.keys.slice(1) })).toThrow(/cases or keys/);
    const path = control('current').anchorFile!;
    expect(() => validateFrozenInputs({ ...frozen, controlFiles: { ...frozen.controlFiles, [path]: 'changed' } }))
      .toThrow(/fixture hash/);
    for (const unsafe of ['../escape.ts', '/escape.ts', 'folder/../escape.ts', 'folder\\escape.ts']) {
      expect(() => validateFrozenInputs({ ...frozen, controlFiles: { ...frozen.controlFiles, [unsafe]: 'bad' } }))
        .toThrow(/path or bytes/);
    }
    expect(() => validateFrozenInputs({ ...frozen, sourcePins: [] })).toThrow(/source custody/);
    expect(() => validateFrozenInputs({ ...frozen, sourcePins: frozen.sourcePins.map(pin =>
      ({ ...pin, commit: '0'.repeat(40) })) })).toThrow(/source custody/);
  });

  it('refuses a donor with mismatched pinned source bytes before starting a worker', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'fair-source-custody-'));
    try {
      const pin = frozen.sourcePins[0]!;
      mkdirSync(join(tree, pin.path, '..'), { recursive: true });
      writeFileSync(join(tree, pin.path), 'a changed source at a plausible snapshot path');
      await expect(verifyFrozenSource(tree, frozen)).rejects.toThrow(`source mismatch: ${pin.path}`);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  it('refuses changed real-task questions and source bytes before writing a replay file', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'fair-repository-task-'));
    const kase = frozen.cases.find(candidate => candidate.source === 'repository-task')!;
    try {
      await expect(materializeFrozenRepositoryTask(tree, { ...kase, subject: 'changed' }, frozen, 'wrong'))
        .rejects.toThrow(/differs from frozen question/);
      await expect(materializeFrozenRepositoryTask(tree, kase, frozen, 'wrong source at the right path'))
        .rejects.toThrow(/source differs from frozen pin/);
      await expect(materializeFrozenRepositoryTask(tree, control('current'), frozen, 'authored'))
        .rejects.toThrow(/differs from frozen question/);
      expect(existsSync(join(tree, kase.anchorFile!))).toBe(false);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  it('indexes original bytes, removes configuration, mutates or deletes source, then restores the next control', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'fair-control-worker-'));
    try {
      const kase = control('current'), path = kase.anchorFile!, source = frozen.controlFiles[path]!;
      const config = join(tree, 'native-controls/typescript/tsconfig.json');
      await materializeFrozenControls(tree, frozen);
      expect(readFileSync(join(tree, path), 'utf8')).toBe(source);
      const current = await prepareFrozenControl(tree, kase, frozen);
      const unconfigured = await prepareFrozenControl(tree, control('current', 'unconfigured'), frozen);
      expect(existsSync(config)).toBe(false);
      expect(unconfigured?.configurationFiles.map(file => file.hash)).toEqual([null]);
      const stale = await prepareFrozenControl(tree, control('stale'), frozen);
      expect(existsSync(config)).toBe(true);
      expect(stale?.originalSourceHash).toBe(current?.currentSourceHash);
      expect(stale?.currentSourceHash).not.toBe(stale?.originalSourceHash);
      expect(readFileSync(join(tree, path), 'utf8')).not.toContain('return target()');
      expect((await prepareFrozenControl(tree, control('deleted'), frozen))?.currentSourceHash).toBeNull();
      expect(existsSync(join(tree, path))).toBe(false);
      expect((await prepareFrozenControl(tree, kase, frozen))?.currentSourceHash).toBe(current?.currentSourceHash);
      expect(readFileSync(join(tree, path), 'utf8')).toBe(source);
      await expect(prepareFrozenControl(tree, { ...kase, subject: 'changed' }, frozen)).rejects.toThrow(/differs from frozen/);
      expect(readFileSync(join(tree, path), 'utf8')).toBe(source);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });
});

describe('raw native tool token witnesses', () => {
  it('binds exact tokenizer counts to preserved Unicode requests and refusal responses', async () => {
    const request = { name: '日本語 🦀', limit: 20 };
    const response = { error: 'unsupported language', sites: [] };
    const witness = await measureFairToolPayload(request, response);
    const { getEncoding } = await import('js-tiktoken');
    const encoder = getEncoding('o200k_base');
    expect(witness).toMatchObject({ encoding: 'o200k_base', scope: 'raw-tool-payload-only',
      requestTokens: encoder.encode(JSON.stringify(request)).length,
      responseTokens: encoder.encode(JSON.stringify(response)).length,
      requestBytes: Buffer.byteLength(JSON.stringify(request)),
      responseBytes: Buffer.byteLength(JSON.stringify(response)) });
    expect(witness.requestTokens).not.toBe(witness.requestBytes / 4);
    expect(witness.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(witness.responseHash).toMatch(/^[a-f0-9]{64}$/);
    const changed = await measureFairToolPayload(request, { error: null, sites: [] });
    expect(changed.requestHash).toBe(witness.requestHash);
    expect(changed.responseHash).not.toBe(witness.responseHash);
    expect(changed.responseTokens).not.toBe(witness.responseTokens);
  });

  it('refuses absent JSON bytes instead of manufacturing a zero-token measurement', async () => {
    await expect(measureFairToolPayload(undefined, {})).rejects.toThrow(/JSON representation/);
    await expect(measureFairToolPayload({}, undefined)).rejects.toThrow(/JSON representation/);
  });
});

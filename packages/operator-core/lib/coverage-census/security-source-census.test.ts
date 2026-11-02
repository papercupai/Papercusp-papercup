import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { advanceSecuritySourceProgress, captureSecuritySourceShard, enumerateSecuritySourcePopulation,
  prepareSecuritySourceShard, validateSecuritySourceProgress,
  type PinnedSecuritySource, type SecuritySourceProgress, type SecuritySourceSnapshot } from './security-source-census';

const commit = 'a'.repeat(40);
const blobHash = (bytes: Uint8Array) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const source = (path: string, text: string): PinnedSecuritySource => ({ path, repository: '.', commit,
  blobOid: blobHash(Buffer.from(text)), bytes: Buffer.from(text) });
const snapshot = (sources: PinnedSecuritySource[]): SecuritySourceSnapshot => ({ sources, repositories: [{ path: '.', commit }], unresolved: [] });
const progress = (sources: PinnedSecuritySource[]): SecuritySourceProgress => ({ schema: 'security-source-discovery-progress-v1',
  parentArchive: '1'.repeat(64), parentRawSha256: '2'.repeat(64), repositories: [{ path: '.', commit }],
  pending: sources.map(file => ({ path: file.path, commit: file.commit, blobOid: file.blobOid,
    bytes: file.bytes.length, reason: 'source-byte-budget' })), capturedShards: [], populationComplete: false, closureAccepted: false });
const selectedSnapshot = (sources: PinnedSecuritySource[], paths: string[]): SecuritySourceSnapshot => ({ ...snapshot(sources),
  selection: { paths: [...paths].sort(), maxBytes: 1000, maxFiles: paths.length,
    filesRead: sources.length, bytesRead: sources.reduce((sum, file) => sum + file.bytes.length, 0), populationComplete: false } });
const receipt = (censusFingerprint: string) => ({ sha256: '3'.repeat(64), censusFingerprint });

describe('pinned security source discovery', () => {
  it('loads the bundled source scanner without requiring a sibling source checkout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'security-source-bundle-'));
    try {
      const bundle = join(directory, 'census.mjs');
      const require = createRequire(import.meta.url);
      await build({ entryPoints: [fileURLToPath(new URL('./security-source-census.ts', import.meta.url))],
        outfile: bundle, bundle: true, platform: 'node', format: 'esm',
        define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true' },
        banner: { js: "import { createRequire as bundleRequire } from 'node:module'; const require = bundleRequire(import.meta.url);" },
        plugins: [{ name: 'external-parser', setup(builder) {
          builder.onResolve({ filter: /^typescript$/ }, () => ({ path: require.resolve('typescript'), external: true }));
        } }],
      });
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
        import { enumerateSecuritySourcePopulation } from ${JSON.stringify(pathToFileURL(bundle).href)};
        import { createHash } from 'node:crypto';
        const bytes = Buffer.from('import fs from "node:fs"; fs.readFileSync("fixture");');
        const commit = 'a'.repeat(40);
        const result = enumerateSecuritySourcePopulation({ sources: [{ path: 'fixture.ts', repository: '.', commit,
          bytes, blobOid: createHash('sha1').update('blob ' + bytes.length + '\\0').update(bytes).digest('hex') }],
          repositories: [{ path: '.', commit }], unresolved: [] });
        console.log(JSON.stringify(result));
      `], { cwd: directory, encoding: 'utf8', timeout: 20_000 });
      const result = JSON.parse(output);
      expect(result.inventory.files[0].imports).toEqual(expect.arrayContaining([
        expect.objectContaining({ specifier: 'node:fs' }),
      ]));
      expect(result.sites).toEqual(expect.arrayContaining([expect.objectContaining({ expression: 'fs.readFileSync' })]));
      expect(result.closureAccepted).toBe(false);
      expect(result.executionAdmitted).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('bounds serialized evidence independently of call count and retains exact omission gaps', () => {
    const text = `if ("${'x'.repeat(6000)}") { ${'run();'.repeat(100)} }`;
    const input = snapshot([source('minified.ts', text)]);
    const discovery = enumerateSecuritySourcePopulation(input, { maxSites: 1000, maxEvidenceBytes: 4096 });
    expect(Buffer.byteLength(JSON.stringify(discovery))).toBeLessThan(4096);
    expect(discovery.sites).toHaveLength(0);
    expect(discovery.inventory.files.map(file => file.path)).toEqual(['minified.ts']);
    expect(discovery.inventory.unresolved).toContainEqual(expect.objectContaining({ path: 'minified.ts',
      reason: 'source-site-evidence-budget', omittedSites: 100, firstOmittedByte: text.indexOf('run()') }));
    expect(discovery.closureAccepted).toBe(false); expect(discovery.executionAdmitted).toBe(false);
    expect(enumerateSecuritySourcePopulation(input).sites).toHaveLength(100);
    expect(() => enumerateSecuritySourcePopulation(input, { maxEvidenceBytes: 100 })).toThrow('security_source_evidence_budget');
    expect(() => enumerateSecuritySourcePopulation(input, { maxEvidenceBytes: 0 })).toThrow('positive_budget');
  });

  it('advances only archived inputs and retains unrequested, reader-refused and parser-budget inputs byte for byte', () => {
    const files = [source('a.ts', 'run();'), source('b.rs', 'fn main() {}'), source('c.sh', 'echo hello'), source('d.ts', 'large();')];
    const queue = progress(files), before = structuredClone(queue);
    const input = selectedSnapshot([files[0], files[3]], ['a.ts', 'b.rs', 'd.ts']);
    input.unresolved = [{ path: 'b.rs', reason: 'source-reader-byte-budget' }];
    const shard = prepareSecuritySourceShard(queue, ['d.ts', 'b.rs', 'a.ts'], input, { maxFiles: 1 });
    const next = advanceSecuritySourceProgress(queue, shard, receipt(shard.discovery.fingerprint));
    expect(next.pending).toEqual(before.pending.slice(1));
    expect(next.capturedShards[0].consumedPaths).toEqual(['a.ts']);
    expect(shard.discovery.inventory.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'b.rs', reason: 'source-reader-byte-budget' }),
      expect.objectContaining({ path: 'd.ts', reason: 'source-file-budget' }),
    ]));
    expect(queue).toEqual(before);
    next.pending[0].reason = 'changed';
    expect(queue).toEqual(before);
  });

  it('refuses repository, blob, byte-count, repository-owner and selection substitutions', () => {
    const file = source('lib/a.ts', 'run();'), queue = progress([file]);
    const prepare = (input: SecuritySourceSnapshot) => prepareSecuritySourceShard(queue, ['lib/a.ts'], input);
    const input = () => selectedSnapshot([file], ['lib/a.ts']);
    expect(() => prepare({ ...input(), repositories: [{ path: '.', commit: 'b'.repeat(40) }] })).toThrow('repository_substitution');
    for (const changed of [{ ...file, blobOid: 'c'.repeat(40) }, { ...file, bytes: Buffer.from('longer();') },
      { ...file, repository: 'lib' }]) expect(() => prepare({ ...input(), sources: [changed] })).toThrow('input_substitution');
    expect(() => prepare({ ...input(), selection: undefined })).toThrow('selection_mismatch');
    expect(() => prepare({ ...input(), sources: [{ ...file, bytes: Buffer.from('bad();') }] })).toThrow('blob_mismatch');
    const nested = { ...queue, repositories: [...queue.repositories, { path: 'lib', commit: 'd'.repeat(40) }] };
    expect(() => validateSecuritySourceProgress(nested)).toThrow('invalid_pending_input');
  });

  it('refuses replay, stale queues and archive identity mutations before discarding inputs', () => {
    const files = [source('a.ts', 'run();'), source('b.ts', 'next();')], queue = progress(files);
    const shard = prepareSecuritySourceShard(queue, ['a.ts'], selectedSnapshot([files[0]], ['a.ts']));
    const next = advanceSecuritySourceProgress(queue, shard, receipt(shard.discovery.fingerprint));
    expect(() => advanceSecuritySourceProgress(next, shard, receipt(shard.discovery.fingerprint))).toThrow('stale_progress');
    expect(() => captureSecuritySourceShard('/must-not-read-git', next, ['a.ts'])).toThrow('not_pending');
    expect(() => prepareSecuritySourceShard(queue, ['a.ts', 'a.ts'], selectedSnapshot([files[0]], ['a.ts']))).toThrow('not_pending');
    const altered = structuredClone(shard); altered.discovery.sites = [];
    expect(() => advanceSecuritySourceProgress(queue, altered, receipt(shard.discovery.fingerprint))).toThrow('identity_mismatch');
    expect(() => advanceSecuritySourceProgress(queue, shard, receipt('4'.repeat(64)))).toThrow('identity_mismatch');
  });

  it('keeps parser gaps after archival and never turns an exhausted input queue into a closure claim', () => {
    const file = source('broken.ts', 'function broken( {'), queue = progress([file]);
    const shard = prepareSecuritySourceShard(queue, [file.path], selectedSnapshot([file], [file.path]));
    const next = advanceSecuritySourceProgress(queue, shard, receipt(shard.discovery.fingerprint));
    expect(next.pending).toEqual([]);
    expect(shard.discovery.inventory.unresolved).toContainEqual(expect.objectContaining({ reason: 'source-site-parser-failed' }));
    expect(next.populationComplete).toBe(false); expect(next.closureAccepted).toBe(false);
    expect(shard.discovery.executionAdmitted).toBe(false);
    const unavailable = prepareSecuritySourceShard(queue, [file.path], selectedSnapshot([], [file.path]));
    expect(() => advanceSecuritySourceProgress(queue, unavailable, receipt(unavailable.discovery.fingerprint))).toThrow('no_progress');
  });

  it('preserves selected reader scope in the archived discovery and its content identity', () => {
    const input = snapshot([source('a.ts', 'run();')]);
    input.selection = { paths: ['a.ts'], maxBytes: 100, maxFiles: 1, bytesRead: 6, filesRead: 1, populationComplete: false };
    const result = enumerateSecuritySourcePopulation(input);
    expect(result.inventory.selection).toEqual(input.selection);
    input.selection.maxBytes = 200;
    expect(result.inventory.selection.maxBytes).toBe(100);
    expect(enumerateSecuritySourcePopulation(input).fingerprint).not.toBe(result.fingerprint);
    expect(result.closureAccepted).toBe(false);
  });

  it('retains every call/import occurrence and alias, dynamic and test leads without claiming runtime closure', () => {
    const text = `import { spawn as launch } from 'node:child_process';
      export async function handler(){ launch('one'); launch('one'); await import(which); operations[name](); }`;
    const result = enumerateSecuritySourcePopulation(snapshot([source('handlers/a.ts', text),
      source('tests/fixture.ts', 'fetch("http://fixture");'),
      source('systemd/operator.service', '[Service]\nExecStart=/usr/bin/node host.js\n')]));
    expect(result.sites.filter(site => site.path === 'handlers/a.ts')).toHaveLength(5);
    const launches = result.sites.filter(site => site.expression === 'launch');
    expect(launches).toHaveLength(2);
    expect(launches[0].binding).toEqual({ imported: 'spawn', specifiers: ['node:child_process'] });
    expect(launches[0].fingerprint).not.toBe(launches[1].fingerprint);
    expect(launches.every(site => site.calleeCoverage === 'UNKNOWN')).toBe(true);
    expect(result.sites.find(site => site.expression === 'operations[name]')?.calleeCoverage).toBe('UNKNOWN');
    expect(result.sites.find(site => site.kind === 'dynamic-import')?.specifier).toBeNull();
    expect(result.sites.find(site => site.path === 'tests/fixture.ts')?.sourceKind).toBe('test-or-fixture');
    expect(result.sites[0].fileSha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(result.inventory.groups.launchers.map(lead => lead.id)).toContain('systemd/operator.service');
    expect(result.inventory.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'dynamic-or-generated-module' })]));
    expect(result.closureAccepted).toBe(false); expect(result.executionAdmitted).toBe(false);
  });

  it('keeps every bounded/unreadable input and parser gap addressable', () => {
    const input = snapshot([source('a.ts', 'one();two();'), source('b.ts', 'three();'),
      source('c.ts', 'four();'), source('d.ts', 'function broken( {'),
      { ...source('e.ts', ''), bytes: Buffer.from([0xff]), blobOid: blobHash(Buffer.from([0xff])) }]);
    input.unresolved = [{ path: 'missing-submodule', reason: 'pinned-repository-unavailable' }];
    const bounded = enumerateSecuritySourcePopulation(input, { maxFiles: 1, maxSites: 1 });
    expect(bounded.sites).toHaveLength(1);
    expect(bounded.inventory.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'b.ts', reason: 'source-file-budget' }),
      expect.objectContaining({ path: 'c.ts', reason: 'source-file-budget' }),
      expect.objectContaining({ path: 'a.ts', reason: 'source-site-budget', omittedSites: 1 }),
      expect.objectContaining({ path: 'missing-submodule', reason: 'pinned-repository-unavailable' }),
    ]));
    const parsed = enumerateSecuritySourcePopulation(input);
    expect(parsed.inventory.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'd.ts', reason: 'source-site-parser-failed' }),
      expect.objectContaining({ path: 'e.ts', reason: 'source-not-utf8' }),
    ]));
    expect(enumerateSecuritySourcePopulation(snapshot([source('a.ts', 'one();')]), { maxBytes: 1 }).inventory.unresolved)
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'source-byte-budget' })]));
    expect(enumerateSecuritySourcePopulation(snapshot([source('a.ts', 'one();')]), { maxInputBytes: 1 }).inventory.unresolved)
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'source-input-budget' })]));
  });

  it('binds exact bytes and repositories deterministically and refuses aliases, duplicates and changed pins', () => {
    const a = source('a.ts', 'one();'), b = source('b.ts', 'two();');
    const first = enumerateSecuritySourcePopulation(snapshot([a, b]));
    expect(enumerateSecuritySourcePopulation(snapshot([b, a])).fingerprint).toBe(first.fingerprint);
    expect(enumerateSecuritySourcePopulation(snapshot([a, source('b.ts', 'other();')])).fingerprint).not.toBe(first.fingerprint);
    expect(() => enumerateSecuritySourcePopulation(snapshot([a, a]))).toThrow('duplicate_path');
    expect(() => enumerateSecuritySourcePopulation(snapshot([{ ...a, path: '../escape.ts' }]))).toThrow('noncanonical_path');
    expect(() => enumerateSecuritySourcePopulation(snapshot([{ ...a, commit: 'c'.repeat(40) }]))).toThrow('pin_mismatch');
    expect(() => enumerateSecuritySourcePopulation(snapshot([{ ...a, bytes: Buffer.from('changed();') }]))).toThrow('blob_mismatch');
    expect(() => enumerateSecuritySourcePopulation(snapshot([a]), { maxSites: 0 })).toThrow('positive_budget');
  });
});

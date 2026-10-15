import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { summarizeHeapSnapshot, summarizeHeapSnapshotStream, summarizeHeapRetainers, checkNativeHeapDecode } from '../../../scripts/analyze-heap-snapshots.mjs';
import { createCdpClient, readPinnedHeapObjectIds } from '../../../scripts/cdp-inspector.mjs';

// The focused router provides a parent admission; CI's unit lane does not.
// Exercise the real governor with its existing memory store in both routes,
// while keeping the actual native child and byte transport under test.
vi.mock('../../../scripts/lib/governed-test-process.mjs', async (original) => {
  const bridge = await original<typeof import('../../../scripts/lib/governed-test-process.mjs')>();
  const api = await import('./resource-governor/execution');
  const { Governor } = await import('./resource-governor/admission');
  const { WorkItemAdmissionQueueDriver } = await import('./resource-governor/queue');
  const { MemoryAdmissionQueueStore } = await import('./resource-governor/memory-admission-queue-store');
  return {
    ...bridge,
    executeGovernedByteProcess: (executable: string, args: string[], input: Uint8Array, options: Parameters<typeof bridge.executeGovernedByteProcess>[3]) => {
      const driver = new WorkItemAdmissionQueueDriver(new MemoryAdmissionQueueStore(), { namespace: options.namespace! });
      return bridge.executeGovernedByteProcess(executable, args, input, {
        ...options,
        env: { ...process.env, PAPERCUSP_ADMISSION_CONTEXT: '' },
        executionApi: {
          ...api,
          runGovernedOperation: (operation: Parameters<typeof api.runGovernedOperation>[0], run: Parameters<typeof api.runGovernedOperation>[1]) =>
            api.withGovernedExecution(
              { ...operation, idempotencyKey: operation.idempotencyKey ?? crypto.randomUUID() },
              operation,
              { driver, governor: new Governor(driver) },
              run,
            ),
        },
      });
    },
  };
});

describe('private V8 heap snapshot census', () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const targetDirectory = resolve(repository, '.heap-retainers-cargo-target');
  const nativeExecutable = join(targetDirectory, 'release/papercusp-heap-retainers');
  beforeAll(() => {
    // CI builds the exact pinned adapter too; these are real-suite guards, not
    // an opt-in check against an unrelated/pre-existing native executable.
    const build = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path',
      resolve(repository, 'scripts/heap-retainers-native/Cargo.toml')], {
      cwd: repository, env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
      encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    expect(build.status, build.stderr).toBe(0);
    const version = spawnSync(nativeExecutable, ['--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe('papercusp-heap-retainers 0.1.0');
  }, 130_000);

  it('binds exact singleton IDs outside class rankings without retaining remote handles or invoking unsafe roots', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'p011-exact-heap-roots-'));
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '-e', String.raw`
      class ExactHeapFixture { constructor(length) { this.values = Array(length).fill(23); } }
      const exclusive = new ExactHeapFixture(250000);
      const shared = Array(2000000).fill(31);
      const left = new ExactHeapFixture(125000), right = new ExactHeapFixture(125000);
      left.shared = shared; right.shared = shared;
      globalThis.effects = 0;
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['fixture.exclusive', { value: exclusive }], ['fixture.left', { value: left }],
        ['fixture.right', { value: right }], ['fixture.alias', { value: left }],
        ['fixture.accessor', { get value() { globalThis.effects++; return exclusive; } }],
        ['fixture.proxy', { value: new Proxy({}, { getOwnPropertyDescriptor() { globalThis.effects++; throw Error('unsafe'); } }) }],
        ['fixture.primitive', { value: 17 }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 15000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null)
        await new Promise(resolve => setTimeout(resolve, 20));
      expect(stdout, stderr).toContain('ready');
      const endpoint = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0];
      expect(endpoint).toBeTruthy();
      client = createCdpClient(endpoint!); await client.connect();
      await client.send('HeapProfiler.enable');
      const snapshot = join(directory, 'exact.heapsnapshot');
      await client.evaluate('process.getBuiltinModule("v8").writeHeapSnapshot(' + JSON.stringify(snapshot) + ')', { returnByValue: true });
      const groups: string[] = [];
      const probe = { evaluate: client.evaluate, send: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.releaseObjectGroup') groups.push(String(params?.objectGroup));
        return client!.send(method, params);
      } };
      const owners = ['fixture.exclusive', 'fixture.left', 'fixture.right', 'fixture.alias',
        'fixture.accessor', 'fixture.proxy', 'fixture.primitive', 'fixture.absent'];
      const binding = await readPinnedHeapObjectIds(probe, { expectedPid: child.pid!, owners });
      expect(binding.roots.map(root => root.status)).toEqual(['found', 'found', 'found', 'found', 'unsafe', 'unsafe', 'nonobject', 'missing']);
      expect(binding.roots[1].id).toBe(binding.roots[3].id);
      expect(new Set(binding.roots.slice(0, 3).map(root => root.id)).size).toBe(3);
      expect(JSON.stringify(binding)).not.toMatch(/objectId|objectGroup|heapsnapshot/);
      expect((await client.evaluate('globalThis.effects', { returnByValue: true })).result.value).toBe(0);
      const ids = binding.roots.slice(0, 3).map(root => root.id!);
      const report = await summarizeHeapRetainers(readFileSync(snapshot), {
        nativeExecutable, top: 1, perClass: 1, objectIds: [...ids, Number.MAX_SAFE_INTEGER],
      });
      expect(report.groups.flatMap(group => group.nodes).some(node => ids.includes(node.id))).toBe(false);
      expect(report.requestedNodes?.map(row => row.id)).toEqual([...ids, Number.MAX_SAFE_INTEGER]);
      expect(report.requestedNodes?.map(row => row.status)).toEqual(['found', 'found', 'found', 'missing']);
      const nodes = report.requestedNodes!.slice(0, 3).map(row => row.node!);
      expect(nodes.every(node => node.class === 'ExactHeapFixture')).toBe(true);
      expect(nodes[0].retainedSizeBytes).toBeGreaterThan(2_000_000);
      expect(nodes.slice(1).every(node => node.retainedSizeBytes > 1_000_000 && node.retainedSizeBytes < 2_000_000)).toBe(true);
      expect(nodes.every(node => node.retainerCount > 0 && node.retainers.length <= 32)).toBe(true);
      const bytes = readFileSync(snapshot);
      for (const objectIds of [[], [0], [-1], [1.5], [1, 1], Array.from({ length: 65 }, (_, i) => i + 1)])
        await expect(summarizeHeapRetainers(bytes, { nativeExecutable, objectIds })).rejects.toThrow('Invalid heap object IDs');
      await expect(summarizeHeapRetainers(bytes, { objectIds: ids })).rejects.toThrow('native adapter');
      await expect(readPinnedHeapObjectIds(probe, { expectedPid: child.pid! + 1, owners: ['fixture.left'] })).rejects.toThrow('PID mismatch');
      expect(groups).toHaveLength(2); expect(new Set(groups).size).toBe(2);
      const calls: string[] = [];
      await expect(readPinnedHeapObjectIds({ evaluate: client.evaluate, send: async method => {
        calls.push(method); if (method === 'HeapProfiler.getHeapObjectId') throw Error('injected ID failure'); return {};
      } }, { expectedPid: child.pid!, owners: ['fixture.left'] })).rejects.toThrow('injected ID failure');
      expect(calls).toEqual(['HeapProfiler.getHeapObjectId', 'Runtime.releaseObjectGroup']);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      }
      child.stdout.destroy(); child.stderr.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 75000);

  it('detects a real surviving large array without exporting private string payloads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'p011-heap-census-'));
    try {
      const result = spawnSync(process.execPath, ['-e', String.raw`
        const { writeHeapSnapshot } = require('node:v8');
        const path = require('node:path');
        writeHeapSnapshot(path.join(process.env.P011_HEAP_DIR, 'before.heapsnapshot'));
        class P011LargeFixture { constructor() { this.values = Array(2000000).fill(17);
          this.payload = 'never-emit-me' + 'sensitive'.repeat(100000); } }
        globalThis.fixture = new P011LargeFixture();
        writeHeapSnapshot(path.join(process.env.P011_HEAP_DIR, 'after.heapsnapshot'));
        if (globalThis.fixture.values.length !== 2000000) process.exit(2);
      `], { env: { ...process.env, P011_HEAP_DIR: directory }, encoding: 'utf8', timeout: 60000 });
      expect(result.status, result.stderr).toBe(0);
      const before = summarizeHeapSnapshot(JSON.parse(readFileSync(join(directory, 'before.heapsnapshot'), 'utf8')));
      const after = summarizeHeapSnapshot(JSON.parse(readFileSync(join(directory, 'after.heapsnapshot'), 'utf8')));
      const arrayBytes = (report: typeof after) => report.types.find((row: any) => row.type === 'array')!.selfSizeBytes;
      expect(arrayBytes(after) - arrayBytes(before)).toBeGreaterThan(15_000_000);
      expect(after.topClasses.some((row: any) => row.class === '(object elements)' && row.selfSizeBytes > 15_000_000)).toBe(true);
      expect(after.types.reduce((sum: number, row: any) => sum + row.count, 0)).toBe(after.nodeCount);
      expect(after.types.reduce((sum: number, row: any) => sum + row.selfSizeBytes, 0)).toBe(after.totalSelfSizeBytes);
      expect(JSON.stringify(after)).not.toMatch(/never-emit-me|sensitive/);
      expect(after.definition).toContain('not retained/exclusive');
      const streamed = await summarizeHeapSnapshotStream(createReadStream(join(directory, 'after.heapsnapshot')));
      expect(streamed.census).toEqual(after);
      const raw = readFileSync(join(directory, 'after.heapsnapshot'));
      expect(streamed.bytes).toBe(raw.length);
      expect(streamed.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 75000);

  it('rejects partial metadata and invalid node values instead of reporting a complete census', () => {
    const snapshot = { snapshot: { node_count: 1, meta: {
      node_fields: ['type', 'name', 'self_size'], node_types: [['string']] } },
      nodes: [0, 0, 12], strings: ['never-emit-me'] };
    expect(summarizeHeapSnapshot(snapshot).topClasses[0].class).toBe('(string)');
    expect(() => summarizeHeapSnapshot({ ...snapshot, nodes: [] })).toThrow('Incomplete');
    expect(() => summarizeHeapSnapshot({ ...snapshot, nodes: [3, 0, 12] })).toThrow('values');
    expect(() => summarizeHeapSnapshot({ ...snapshot, nodes: [0, 0, -1] })).toThrow('values');
    expect(() => summarizeHeapSnapshot(snapshot, { top: 0 })).toThrow('limit');
  });

  it('consumes chunked oversized strings without packing payloads and rejects incomplete streams', async () => {
    const prefix = '{"snapshot":{"node_count":1,"meta":{"node_fields":["type","name","self_size"],"node_types":[["string"]]}},"nodes":[0,0,12],"edges":[],"strings":["';
    const suffix = '"]}';
    const payload = 'never-emit-me'.repeat(60000);
    const input = Readable.from([prefix, ...Array(16).fill(payload), suffix]);
    const result = await summarizeHeapSnapshotStream(input);
    expect(result.bytes).toBe(Buffer.byteLength(prefix + suffix) + 16 * Buffer.byteLength(payload));
    expect(result.census.topClasses).toEqual([{ type: 'string', class: '(string)', count: 1, selfSizeBytes: 12 }]);
    expect(JSON.stringify(result)).not.toContain('never-emit-me');
    await expect(summarizeHeapSnapshotStream(Readable.from([prefix]))).rejects.toThrow();
  });

  it('retains every class before a multi-snapshot CLI ranking instead of truncating each input', async () => {
    const snapshot = { snapshot: { node_count: 150, meta: {
      node_fields: ['type', 'name', 'self_size'], node_types: [['object']] } },
      nodes: Array.from({ length: 150 }, (_, i) => [0, i, i + 1]).flat(),
      strings: Array.from({ length: 150 }, (_, i) => 'FixtureClass' + i) };
    const result = await summarizeHeapSnapshotStream(Readable.from([JSON.stringify(snapshot)]), { top: 0 });
    expect(result.census.topClasses).toHaveLength(150);
    expect(result.census.topClasses.reduce((sum: number, row: any) => sum + row.selfSizeBytes, 0))
      .toBe(result.census.totalSelfSizeBytes);
  });

  it('reports decode failures without quoting private input', async () => {
    const { summarizeHeapRetainers } = await import('../../../scripts/analyze-heap-snapshots.mjs');
    const consoleError = console.error;
    await expect(summarizeHeapRetainers(Buffer.from('{"private":"DoNotExportThisPayload"}')))
      .rejects.toThrow('Heap retainer analysis failed at decode-bytes');
    try { await summarizeHeapRetainers(Buffer.from('{"private":"DoNotExportThisPayload"}')); }
    catch (error) {
      expect(String(error)).not.toContain('DoNotExportThisPayload');
      expect(JSON.stringify(error)).not.toContain('DoNotExportThisPayload');
    }
    expect(console.error).toBe(consoleError);
  });

  it('distinguishes exclusive large allocations from shared holders in a real dominator graph', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'p011-heap-retainers-'));
    try {
      const result = spawnSync(process.execPath, ['-e', String.raw`
        const { writeHeapSnapshot } = require('node:v8');
        class ExclusiveHeapFixture { constructor() { this.values = Array(2000000).fill(17); } }
        // A known private allocation puts the shared-holder class in the ranked
        // window, while the much larger shared array must remain non-exclusive.
        class SharedHeapFixture { constructor(values) { this.values = values;
          this.privateValues = Array(125000).fill(29); } }
        globalThis.exclusive = new ExclusiveHeapFixture();
        const shared = Array(2000000).fill(23);
        globalThis.left = new SharedHeapFixture(shared);
        globalThis.right = new SharedHeapFixture(shared);
        globalThis.payload = 'DoNotExportThisPayload' + 'sensitive'.repeat(100000);
        writeHeapSnapshot(require('node:path').join(process.env.P011_HEAP_DIR, 'owners.heapsnapshot'));
        if (globalThis.left.values !== globalThis.right.values) process.exit(2);
      `], { env: { ...process.env, P011_HEAP_DIR: directory }, encoding: 'utf8', timeout: 60000 });
      expect(result.status, result.stderr).toBe(0);
      const bytes = readFileSync(join(directory, 'owners.heapsnapshot'));
      if (process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER) {
        const control = await checkNativeHeapDecode(bytes, process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER);
        expect(control.decoded).toBe(true);
        expect(control.inputSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        const invalid = await checkNativeHeapDecode(Buffer.from('{"private":"DoNotExportThisPayload"}'), process.env.PAPERCUSP_P011_NATIVE_HEAP_DECODER);
        expect(invalid.decoded).toBe(false);
        expect(invalid.stderrBytes).toBeGreaterThan(0);
        expect(JSON.stringify(invalid)).not.toContain('DoNotExportThisPayload');
      }
      const report = await summarizeHeapRetainers(bytes, { top: 30, perClass: 4, retainerDepth: 1 });
      const exclusive = report.groups.find(group => group.class === 'ExclusiveHeapFixture');
      expect(exclusive?.nodes[0].retainedSizeBytes).toBeGreaterThan(15_000_000);
      const shared = report.groups.find(group => group.class === 'SharedHeapFixture');
      expect(shared?.count).toBe(2);
      expect(shared?.nodes).toHaveLength(2);
      expect(shared?.nodes.every(node => node.retainedSizeBytes > 1_000_000 && node.retainedSizeBytes < 2_000_000)).toBe(true);
      const retainedSharedArray = report.groups.flatMap(group => group.nodes).find(node =>
        node.type === 'Object' && node.class === 'Array' && node.retainedSizeBytes > 15_000_000 &&
        node.retainers.filter(retainer => retainer.class === 'SharedHeapFixture').length === 2);
      expect(retainedSharedArray, 'Both shared holders must retain the same large array.').toBeDefined();
      expect(JSON.stringify(report)).not.toMatch(/DoNotExportThisPayload|sensitive|heapsnapshot|P011_HEAP_DIR/);
      expect(report.definition).toContain('class retained sizes overlap');
      expect(report.groups.length).toBeLessThanOrEqual(30);
      const native = await summarizeHeapRetainers(bytes, { top: 30, perClass: 4, retainerDepth: 1, nativeExecutable });
      expect(native.native?.inputSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(native.native?.executableSha256).toBe(createHash('sha256').update(readFileSync(nativeExecutable)).digest('hex'));
      expect(native.native?.stderrBytes).toBe(0);
      expect(native.rootIndex).toBe(report.rootIndex);
      const nativeExclusive = native.groups.find(group => group.class === 'ExclusiveHeapFixture');
      expect(nativeExclusive?.nodes[0].index).toBe(exclusive?.nodes[0].index);
      expect(nativeExclusive?.nodes[0].retainedSizeBytes).toBe(exclusive?.nodes[0].retainedSizeBytes);
      const nativeShared = native.groups.find(group => group.class === 'SharedHeapFixture');
      expect(nativeShared?.nodes.map(node => [node.index, node.retainedSizeBytes]).sort())
        .toEqual(shared?.nodes.map(node => [node.index, node.retainedSizeBytes]).sort());
      const nativeArray = native.groups.flatMap(group => group.nodes).find(node => node.index === retainedSharedArray!.index);
      expect(nativeArray?.retainedSizeBytes).toBe(retainedSharedArray?.retainedSizeBytes);
      expect(nativeArray?.retainers.filter(node => node.class === 'SharedHeapFixture')).toHaveLength(2);
      expect(JSON.stringify(native)).not.toMatch(/DoNotExportThisPayload|sensitive|heapsnapshot|P011_HEAP_DIR/);
      await expect(summarizeHeapRetainers(bytes, { nativeExecutable, retainerDepth: 2 })).rejects.toThrow('retainerDepth 1');
      await expect(summarizeHeapRetainers(Buffer.from('{"snapshot":'))).rejects.toThrow();
      await expect(summarizeHeapRetainers(bytes, { retainerDepth: 4 })).rejects.toThrow('Invalid');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 75000);

  it('bounds direct native parents, deduplicates properties and excludes weak/non-root shortcut edges', async () => {
    const names = ['root', 'FixtureTarget', 'HolderA', 'HolderB', 'WeakOnly', 'ShortcutOnly',
      'DoNotExportThisPayload', 'DoNotExportEdge'];
    const types = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic'];
    const nf = 7;
    const snapshot = { snapshot: { node_count: 7, edge_count: 12, meta: {
      node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
      node_types: [types, 'string', 'number', 'number', 'number', 'number', 'number'],
      edge_fields: ['type', 'name_or_index', 'to_node'],
      edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
      trace_function_info_fields: [], trace_node_fields: [], sample_fields: [], location_fields: [],
    } }, nodes: [[9, 0, 1, 0, 5, 0, 0], [3, 1, 3, 100, 0, 0, 0],
      [3, 2, 5, 24, 4, 0, 0], [3, 3, 7, 24, 1, 0, 0], [3, 4, 9, 24, 1, 0, 0],
      [3, 5, 11, 24, 1, 0, 0], [2, 6, 13, 12, 0, 0, 0]].flat(),
      edges: [...[2, 3, 4, 5, 6].map(index => [5, 7, index * nf]),
        [2, 7, nf], [2, 7, nf], [6, 7, nf], [5, 7, nf],
        [2, 7, nf], [6, 7, nf], [5, 7, nf]].flat(), strings: names };
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const report = await summarizeHeapRetainers(bytes, { nativeExecutable, top: 30, perClass: 10, maxRetainers: 1 });
    const target = report.groups.flatMap(group => group.nodes).find(node => node.class === 'FixtureTarget')!;
    expect(target.retainerCount).toBe(2);
    expect(target.retainersTruncated).toBe(true);
    expect(target.retainers).toHaveLength(1);
    expect(target.retainers[0].class).toBe('HolderA');
    expect(target.retainers[0].edgeType).toBe('Property');
    expect(report.groups.flatMap(group => group.nodes).find(node => node.type === 'String')?.class).toBe('(string)');
    expect(JSON.stringify(report)).not.toMatch(/DoNotExportThisPayload|DoNotExportEdge/);
    const bounded = await summarizeHeapRetainers(bytes, { nativeExecutable, top: 1, perClass: 1, maxRetainers: 1 });
    expect(bounded.groups).toHaveLength(1);
    expect(bounded.groups[0].nodes).toHaveLength(1);
    await expect(summarizeHeapRetainers(bytes, { nativeExecutable, top: 31 })).rejects.toThrow('Invalid');
    const direct = spawnSync(nativeExecutable, ['1', '1', '2', '1'], { input: bytes, encoding: 'utf8' });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toBe('');
    expect(JSON.parse(direct.stdout).error.kind).toBe('invalid-limits');
    // Upstream indexes string-table names while grouping. Malformed indexes
    // can panic; the process must still emit only the fixed phase/kind.
    const corrupt = spawnSync(nativeExecutable, ['30', '10', '1', '1'], {
      input: JSON.stringify({ ...snapshot, strings: [] }), encoding: 'utf8',
    });
    expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toBe('');
    expect(JSON.parse(corrupt.stdout).error).toEqual({ phase: 'class-dominators', kind: 'upstream-panic' });
  });

  it('redacts malformed native input and upstream panic output', async () => {
    const bytes = Buffer.from('{"private":"DoNotExportThisPayload"}');
    const direct = spawnSync(nativeExecutable, ['1', '1', '1', '1'], { input: bytes, encoding: 'utf8' });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toBe('');
    expect(JSON.parse(direct.stdout).error.phase).toBe('decode-bytes');
    try { await summarizeHeapRetainers(bytes, { nativeExecutable }); throw Error('Expected failure'); }
    catch (error) {
      expect(String(error)).toContain('failed at decode-bytes');
      expect(String(error) + JSON.stringify(error)).not.toContain('DoNotExportThisPayload');
    }
  });
});

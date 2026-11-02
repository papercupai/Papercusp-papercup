import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { appendFileSync, chmodSync, closeSync, constants, cpSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';
import { readTaskCgroupMemoryScope } from '../../../../scripts/lib/task-cgroup-limits.mjs';
import * as terminalCounters from '../../../../scripts/lib/terminal-counter-fields.mjs';

import { parseTaskBudgetRefusal } from '../../../../scripts/lib/task-exit-class.mjs';
import {
  admissionMutexName,
  classifyAffectedBlastRadius,
  createCgroupMemoryObserver,
  createNativeArtifactPersister,
  durationEstimate,
  emptyDurationHistory,
  estimateBudgetedTaskWallMs,
  formatAdmissionHolder,
  formatAdmissionProspect,
  formatAffectedTaskShardMarker,
  formatCgroupMemoryObservedMarker,
  formatTaskBudgetMarker,
  formatTaskBudgetObservedMarker,
  isSharedAdmissionDeferral,
  isSharedAdmissionTimeout,
  mergeDurationHistory,
  pidsEventRefusalDelta,
  planAffectedTaskShards,
  prepareBudgetedTaskComparison,
  evaluateBudgetedTaskComparison,
  readBudgetedTaskComparisonArtifacts,
  readDurationHistory,
  readTaskCgroupMemoryMaxMb,
  readTaskCgroupMemoryUsage,
  readTaskCgroupPidsEventMax,
  readTaskCgroupPidsMax,
  resolveGlobalWorkerBudget,
  resolveMemoryBudgetMb,
  resolveTaskBudget,
  resolveWorkerMemoryMb,
  retainReporterEvaluatorArtifacts,
  retainNativeProofPacket,
  verifyNativeProofPacket,
  runBudgetedTaskShards,
  runBudgetedTasks,
  timeoutDurationEstimate,
  writeDurationHistoryAtomic,
  writeBudgetedTaskNativeExecutionReceipt,
  syncBudgetedTaskNativeExecutionReceipt,
} from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS policy module, no declaration file.
import { resolveTaskTimeoutMs } from '../../../../scripts/lib/batch-watchdog.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-Node entrypoint, consumed directly by scripts/*.mjs.
import { withFsMutex, withFsMutexBudget } from '../../../../scripts/lib/fs-mutex.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/affected-tests.mjs'), 'utf8');
const SCHEDULER_SRC = readFileSync(
  resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs'),
  'utf8',
);

describe('private native proof custody (P002)', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
  function fixture(attempts: Array<'primary' | 'detail'> = ['primary']) {
    const root = mkdtempSync(join(tmpdir(), 'native-custody-'));
    roots.push(root);
    const producer = join(root, 'producer');
    mkdirSync(producer);
    const identity = { workspace: 'custody-workspace', harness: 'papercusp', runId: basename(root) };
    const expected = attempts.map((attempt, index) => {
      const out = join(producer, `out-${index}.json`);
      for (const suffix of ['.modules', '.native-processes', '.processes']) mkdirSync(out + suffix);
      const code = Buffer.from('export const exact = "é\\u0000";\n');
      const sha256 = createHash('sha256').update(code).digest('hex');
      const codeRef = join(out + '.modules', `${sha256}.js`);
      writeFileSync(codeRef, code);
      const pin = { codeRef, sha256, byteLength: code.length };
      const moduleEvaluations = { schemaVersion: 'vitest-evaluator-inputs-v1',
        scope: 'vitest-inlined-evaluator-inputs', basis: 'before-evaluator-call', entries: [pin, pin], vmInputs: [pin] };
      writeFileSync(out, JSON.stringify({ rows: [{ moduleEvaluations }], diagnostics: [{ moduleEvaluations }],
        nativeRun: { state: 'partial', reason: 'fixture-diagnostic', files: [{ proof: { inputs: { moduleEvaluations } } }] } }));
      for (const suffix of ['source', 'stream', 'json']) {
        const bytes = Buffer.from(suffix === 'json' ? '{"kind":"observation"}' : `raw-${suffix}\u0000\xff`);
        const digest = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(join(out + '.native-processes', `${digest}.${suffix}`), bytes);
      }
      writeFileSync(join(out + '.processes', 'process.closed'), '{"state":"closed"}');
      const auxiliary = ['command-exit', 'stdout', 'stderr', 'report', 'cleanup'].map(role => {
        const path = join(producer, `${index}.${role}`);
        writeFileSync(path, Buffer.from(`exact-${role}\u0000\xff`));
        return { role, path, state: 'produced' as const };
      });
      return { id: `group-${index}`, attempt, selected: [join(producer, `test-${index}.ts`)],
        runner: 'vitest' as const, armed: true, out, auxiliary };
    });
    const observations = expected.map(group => ({ id: group.id, out: group.out, captureComplete: true }));
    const directory = join(root, 'packet');
    const contract = { identity, expected };
    const save = () => retainNativeProofPacket(directory, { ...contract, observations,
      execution: { state: 'failed' }, cleanup: { complete: false } });
    return { root, producer, directory, contract, observations, save };
  }

  function consumeRetained(f: ReturnType<typeof fixture>, locator: ReturnType<typeof f.save>['locator'], contract = f.contract) {
    expect(fs.existsSync(f.producer)).toBe(false);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { verifyNativeProofPacket } from ' + JSON.stringify(resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs')) + ';' +
      'import { readFileSync, statSync } from "node:fs"; import { join } from "node:path";' +
      'const [directory,locator,contract]=JSON.parse(process.argv[1]);' +
      'try { const r=verifyNativeProofPacket(directory,locator,contract);' +
      'const entries=r.manifest.groups.flatMap(g=>[...g.families.flatMap(f=>f.entries),...g.auxiliary.filter(a=>a.artifact)]);' +
      'process.stdout.write(JSON.stringify({refused:false,pid:process.pid,status:r.status,manifest:r.manifest,' +
      'objects:entries.map(e=>({original:e.original??e.path,pin:e.artifact,mode:statSync(join(directory,"objects",e.artifact.ref)).mode&511,' +
      'bytes:readFileSync(join(directory,"objects",e.artifact.ref)).toString("base64")}))})); }' +
      'catch(error) { process.stdout.write(JSON.stringify({refused:true,error:String(error),pid:process.pid})); }',
      JSON.stringify([f.directory, locator, contract])], { encoding: 'utf8', timeout: 15_000 });
    const childResult = { error: child.error ? String(child.error) : undefined, stderr: child.stderr, status: child.status };
    expect(childResult, JSON.stringify(childResult)).toEqual({ error: undefined, stderr: '', status: 0 });
    const result = JSON.parse(child.stdout);
    expect(result.pid).not.toBe(process.pid);
    return result;
  }

  it('P003 reconciles independent raw-byte pins and private modes for two primaries and a detail after retirement', () => {
    const f = fixture(['primary', 'primary', 'detail']);
    const originals = f.contract.expected.flatMap(group => [group.out,
      ...['.modules', '.native-processes', '.processes'].flatMap(suffix =>
        readdirSync(group.out + suffix).map(name => join(group.out + suffix, name))),
      ...group.auxiliary.map(entry => entry.path)]).map(original => {
      const bytes = readFileSync(original);
      return { original, bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), length: bytes.length };
    });
    const saved = f.save();
    expect(saved.status).toBe('complete');
    expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(f.directory, 'objects')).mode & 0o777).toBe(0o700);
    rmSync(f.producer, { recursive: true });
    const result = consumeRetained(f, saved.locator);
    expect(result.status).toBe('complete');
    expect(result.objects).toHaveLength(originals.length);
    for (const expected of originals) expect(result.objects.find((entry: { original: string }) => entry.original === expected.original))
      .toMatchObject({ bytes: expected.bytes, pin: { sha256: expected.sha256, byteLength: expected.length }, mode: 0o600 });
    expect(result.manifest.groups.map((group: { references: unknown[] }) => group.references.length)).toEqual([9, 9, 9]);
    expect(result.manifest.verdicts).toMatchObject({ execution: { state: 'failed' }, cleanup: { complete: false },
      producerRetirement: 'not-performed', protocol: 'unqualified', nativeProof: 'unqualified', acceptance: 'unmeasured' });
  });

  it('keeps repeated evaluator occurrences separate from the distinct artifact population', () => {
    const f = fixture(), group = f.contract.expected[0]!;
    const payload = JSON.parse(readFileSync(group.out!, 'utf8'));
    const source = payload.rows[0].moduleEvaluations, pin = source.entries[0];
    payload.rows = Array.from({ length: 4096 }, () => ({ moduleEvaluations: {
      ...source, entries: [pin], vmInputs: [pin],
    } }));
    payload.diagnostics = [];
    payload.nativeRun.files = [];
    writeFileSync(group.out!, JSON.stringify(payload));
    const saved = f.save(), retained = saved.manifest.groups[0]!;
    expect(saved.status).toBe('complete');
    expect(retained.references).toHaveLength(8192);
    expect(retained.referenceArtifacts).toEqual([{ codeRef: pin.codeRef, sha256: pin.sha256, byteLength: pin.byteLength }]);
    expect(retained.referenceGaps).toEqual([]);
    expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('complete');
  });

  it('retains evaluator references across the segment object boundary and preserves historical partial packets', () => {
    const f = fixture(), group = f.contract.expected[0]!, modules = group.out! + '.modules';
    rmSync(modules, { recursive: true });
    mkdirSync(modules);
    const pins = Array.from({ length: 8193 }, (_, index) => {
      const bytes = Buffer.from(`export const exact = ${index};\n`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const codeRef = join(modules, sha256 + '.js');
      writeFileSync(codeRef, bytes);
      return { codeRef, sha256, byteLength: bytes.length };
    });
    const payload = JSON.parse(readFileSync(group.out!, 'utf8'));
    payload.rows = [{ moduleEvaluations: { ...payload.rows[0].moduleEvaluations, entries: pins, vmInputs: [] } }];
    payload.diagnostics = []; payload.nativeRun.files = [];
    writeFileSync(group.out!, JSON.stringify(payload));
    const saved = f.save();
    expect(saved.status).toBe('complete');
    expect(saved.manifest.groups[0]!.referenceArtifacts).toEqual(pins);
    expect(saved.manifest.groups[0]!.referenceGaps).toEqual([]);
    expect(saved.manifest.referenceArtifactLimit).toBe(saved.manifest.archiveLimits!.objects);
    expect(saved.manifest.segments!.length).toBeGreaterThan(1);
    for (const segment of saved.manifest.segments!)
      expect(segment.objectsReadByFamily.B).toBeLessThanOrEqual(saved.manifest.limits.families!.B.objects);
    rmSync(f.producer, { recursive: true });
    const consumed = verifyNativeProofPacket(f.directory, saved.locator, f.contract);
    expect(consumed.status).toBe('complete');
    expect(consumed.manifest.groups[0]!.referenceArtifacts).toEqual(pins);
    expect(consumed.manifest.verdicts).toMatchObject({ nativeProof: 'unqualified', acceptance: 'unmeasured' });

    // The original packet used a segment-wide census and remains partial. A new
    // consumer must neither reject that history nor promote it to complete.
    const historical = structuredClone(saved.manifest);
    delete historical.referenceArtifactLimit;
    historical.groups[0]!.referenceArtifacts = pins.slice(0, 8192);
    historical.groups[0]!.referenceGaps = ['evaluator-artifact-limit'];
    historical.gaps = [group.id + ':A:evaluator-artifact-limit'];
    historical.verdicts.custody = 'partial';
    const persist = createNativeArtifactPersister(join(f.directory, 'objects')).persist;
    const historicalPin = persist(Buffer.from(JSON.stringify(historical)), 'native-proof.json');
    const inventoryHash = createHash('sha256').update(JSON.stringify({ groups: historical.groups,
      gaps: historical.gaps, segments: historical.segments })).digest('hex');
    expect(verifyNativeProofPacket(f.directory, { ...saved.locator, manifest: historicalPin, inventoryHash }, f.contract).status)
      .toBe('partial');
    const invalid = { ...saved.manifest, referenceArtifactLimit: saved.manifest.archiveLimits!.objects + 1 };
    const invalidPin = persist(Buffer.from(JSON.stringify(invalid)), 'native-proof.json');
    expect(() => verifyNativeProofPacket(f.directory, { ...saved.locator, manifest: invalidPin }, f.contract))
      .toThrow('custody reference artifact limit mismatch');
  }, 60_000);

  it('keeps an evaluator census above the archive object bound partial', () => {
    const f = fixture(), group = f.contract.expected[0]!, modules = group.out! + '.modules';
    const payload = JSON.parse(readFileSync(group.out!, 'utf8'));
    const pins = Array.from({ length: 16385 }, (_, index) => {
      const sha256 = index.toString(16).padStart(64, '0');
      return { codeRef: join(modules, sha256 + '.js'), sha256, byteLength: 0 };
    });
    payload.rows = [{ moduleEvaluations: { ...payload.rows[0].moduleEvaluations, entries: pins, vmInputs: [] } }];
    payload.diagnostics = []; payload.nativeRun.files = [];
    writeFileSync(group.out!, JSON.stringify(payload));
    const saved = f.save();
    expect(saved.status).toBe('partial');
    expect(saved.manifest.groups[0]!.referenceArtifacts).toHaveLength(16384);
    expect(saved.manifest.groups[0]!.referenceGaps).toEqual(['evaluator-artifact-limit']);
    expect(saved.manifest.gaps).toContain(group.id + ':A:evaluator-artifact-limit');
    expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('partial');
  }, 60_000);

  it.each(['native-proof-custody-v1', 'native-proof-custody-v2'] as const)
    ('continues to verify retained %s packets', schemaVersion => {
      const f = fixture(), saved = f.save(), manifest = structuredClone(saved.manifest);
      manifest.schemaVersion = schemaVersion;
      delete manifest.referenceArtifactLimit;
      delete manifest.segments;
      delete manifest.archiveLimits;
      for (const group of manifest.groups) for (const entry of [
        ...group.families.flatMap(family => family.entries), ...group.auxiliary,
      ]) if (entry.artifact) delete entry.artifact.segment;
      if (schemaVersion === 'native-proof-custody-v1')
        manifest.limits = { objects: 16384, bytes: 64 * 1024 * 1024, objectBytes: 16 * 1024 * 1024 };
      const pin = createNativeArtifactPersister(join(f.directory, 'objects'))
        .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
      const inventoryHash = createHash('sha256').update(JSON.stringify({ groups: manifest.groups, gaps: manifest.gaps })).digest('hex');
      expect(verifyNativeProofPacket(f.directory, { ...saved.locator, manifest: pin, inventoryHash }, f.contract).status).toBe('complete');
    });

  it.each(['reporter-json', 'native-digest'] as const)
    ('retains rejected %s bytes as sealed partial diagnostics', fault => {
      const f = fixture(), group = f.contract.expected[0]!;
      if (fault === 'reporter-json') writeFileSync(group.out!, '{');
      else {
        const directory = group.out! + '.native-processes';
        writeFileSync(join(directory, readdirSync(directory)[0]!), 'wrong digest');
      }
      const saved = f.save();
      expect(saved.status).toBe('partial');
      expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('partial');
    });

  it('rolls evaluator custody into bounded segments without losing other families or receipts', () => {
    const f = fixture(), group = f.contract.expected[0]!, modules = group.out! + '.modules';
    rmSync(modules, { recursive: true });
    mkdirSync(modules);
    const pins = [16, 8].map((size, index) => {
      const bytes = Buffer.alloc(size * 1024 * 1024, index + 1);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const codeRef = join(modules, sha256 + '.js');
      writeFileSync(codeRef, bytes);
      return { codeRef, sha256, byteLength: bytes.length };
    });
    const payload = JSON.parse(readFileSync(group.out!, 'utf8'));
    payload.rows = [{ moduleEvaluations: { ...payload.rows[0].moduleEvaluations, entries: pins, vmInputs: [] } }];
    payload.diagnostics = [];
    payload.nativeRun.files = [];
    writeFileSync(group.out!, JSON.stringify(payload));
    const saved = f.save(), retained = saved.manifest.groups[0]!;
    const family = (name: 'A' | 'B' | 'C' | 'D') => retained.families.find(row => row.family === name)!;
    expect(saved.status).toBe('complete');
    expect(family('B')).toMatchObject({ state: 'produced' });
    expect(family('C').state).toBe('produced');
    expect(family('D').state).toBe('produced');
    expect(retained.auxiliary.every(entry => entry.artifact)).toBe(true);
    expect(saved.manifest.segments!.length).toBeGreaterThan(1);
    for (const segment of saved.manifest.segments!)
      expect(segment.bytesReadByFamily.B).toBeLessThanOrEqual(saved.manifest.limits.families!.B.bytes);
    expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('complete');
  });

  describe('bounded manifest metadata', () => {
    let f: ReturnType<typeof fixture>, saved: ReturnType<ReturnType<typeof fixture>['save']>;
    let index: { schemaVersion: string; byteLength: number; sha256: string;
      parts: Array<{ offset: number; artifact: { ref: string; sha256: string; byteLength: number } }> };
    beforeAll(() => {
      f = fixture();
      const out = f.contract.expected[0]!.out!, payload = JSON.parse(readFileSync(out, 'utf8'));
      const evaluation = { ...payload.rows[0].moduleEvaluations,
        entries: Array(1024).fill(payload.rows[0].moduleEvaluations.entries[0]), vmInputs: [] };
      payload.rows = Array.from({ length: 64 }, () => ({ moduleEvaluations: evaluation }));
      payload.diagnostics = []; payload.nativeRun.files = [];
      writeFileSync(out, JSON.stringify(payload));
      saved = f.save();
      index = JSON.parse(readFileSync(join(f.directory, 'objects', saved.locator.manifest.ref), 'utf8'));
      rmSync(f.producer, { recursive: true });
    }, 60_000);

    it('retains a large reference inventory within the unchanged object and metadata byte limits', () => {
      expect(index.schemaVersion).toBe('native-proof-index-v1');
      expect(index.byteLength).toBeGreaterThan(16 * 1024 * 1024);
      expect(saved.locator.manifest.byteLength).toBeLessThan(16 * 1024 * 1024);
      expect(index.parts.every(part => part.artifact.byteLength <= 8 * 1024 * 1024)).toBe(true);
      const consumed = verifyNativeProofPacket(f.directory, saved.locator, f.contract);
      expect(consumed.status).toBe('complete');
      expect(consumed.manifest.groups[0]!.references).toHaveLength(65536);
      expect(consumed.manifest.verdicts.nativeProof).toBe('unqualified');
      expect(consumed.manifest.limits.objectBytes).toBe(16 * 1024 * 1024);
      expect(consumed.manifest.limits.bytes).toBe(64 * 1024 * 1024);
    });

    it.each(['offset', 'digest', 'missing-part', 'object-bound', 'aggregate-bound'])
      ('refuses metadata %s without trusting a replacement index', fault => {
        const changed = structuredClone(index);
        if (fault === 'offset') changed.parts[1]!.offset++;
        if (fault === 'digest') changed.sha256 = '0'.repeat(64);
        if (fault === 'missing-part') changed.parts.pop();
        if (fault === 'object-bound') changed.parts[0]!.artifact.byteLength = 16 * 1024 * 1024 + 1;
        if (fault === 'aggregate-bound') changed.byteLength = 64 * 1024 * 1024 + 1;
        const manifest = createNativeArtifactPersister(join(f.directory, 'objects'))
          .persist(Buffer.from(JSON.stringify(changed)), 'native-proof.json');
        expect(() => verifyNativeProofPacket(f.directory, { ...saved.locator, manifest }, f.contract)).toThrow();
      });
  });

  function largeOutFixture() {
    const f = fixture(), out = f.contract.expected[0]!.out!;
    const payload = JSON.parse(readFileSync(out, 'utf8'));
    // Multi-byte code points cross chunk boundaries: decode only after reassembly.
    payload.padding = '☃'.repeat(6 * 1024 * 1024);
    const bytes = Buffer.from(JSON.stringify(payload));
    writeFileSync(out, bytes);
    return { ...f, bytes };
  }

  it('retains an oversized OUT in bounded chunks and verifies exact bytes after producer retirement', () => {
    const f = largeOutFixture(), saved = f.save();
    const entry = saved.manifest.groups[0]!.families.find(row => row.family === 'A')!.entries[0]!;
    expect(saved.status).toBe('complete');
    expect(entry.chunked).toMatchObject({ complete: true, byteLength: f.bytes.length,
      sha256: createHash('sha256').update(f.bytes).digest('hex') });
    expect(entry.chunked!.parts.length).toBeGreaterThan(1);
    for (const segment of saved.manifest.segments!) {
      expect(segment.bytesReadByFamily.A).toBeLessThanOrEqual(saved.manifest.limits.families!.A.bytes);
      expect(segment.bytesRead).toBeLessThanOrEqual(saved.manifest.limits.bytes);
    }
    rmSync(f.producer, { recursive: true });
    const retained = entry.chunked!.parts.map(part => {
      expect(part.artifact.byteLength).toBeLessThanOrEqual(saved.manifest.limits.objectBytes);
      const path = join(f.directory, 'objects', part.artifact.ref);
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      return readFileSync(path);
    });
    expect(Buffer.concat(retained).equals(f.bytes)).toBe(true);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { verifyNativeProofPacket } from ' + JSON.stringify(resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs')) + ';' +
      'console.log(verifyNativeProofPacket(...JSON.parse(process.argv[1])).status)',
      JSON.stringify([f.directory, saved.locator, f.contract])], { encoding: 'utf8', timeout: 30_000 });
    assertNativeFixtureCompleted(child, join(f.root, 'consumer.json'), 'oversized-out-consumer');
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    expect(child.stdout.trim()).toBe('complete');
    expect(saved.manifest.verdicts).toMatchObject({ nativeProof: 'unqualified', acceptance: 'unmeasured' });
  }, 60_000);

  it('rejects missing, reordered or altered OUT chunks even with a newly sealed manifest', () => {
    const f = largeOutFixture(), saved = f.save();
    rmSync(f.producer, { recursive: true });
    for (const fault of ['omit', 'reorder', 'offset', 'length', 'digest', 'first-pin', 'erase-layout']) {
      const manifest = structuredClone(saved.manifest);
      const entry = manifest.groups[0]!.families.find(row => row.family === 'A')!.entries[0]!;
      const chunks = entry.chunked!;
      if (fault === 'omit') chunks.parts.pop();
      if (fault === 'reorder') [chunks.parts[1], chunks.parts[2]] = [chunks.parts[2]!, chunks.parts[1]!];
      if (fault === 'offset') chunks.parts[1]!.offset++;
      if (fault === 'length') chunks.byteLength++;
      if (fault === 'digest') chunks.sha256 = '0'.repeat(64);
      if (fault === 'first-pin') entry.artifact = chunks.parts[1]!.artifact;
      if (fault === 'erase-layout') delete entry.chunked;
      const pin = createNativeArtifactPersister(join(f.directory, 'objects'))
        .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
      const inventoryHash = createHash('sha256').update(JSON.stringify({ groups: manifest.groups,
        gaps: manifest.gaps, segments: manifest.segments })).digest('hex');
      expect(() => verifyNativeProofPacket(f.directory, { ...saved.locator, manifest: pin, inventoryHash }, f.contract), fault)
        .toThrow();
    }
    const entry = saved.manifest.groups[0]!.families.find(row => row.family === 'A')!.entries[0]!;
    const path = join(f.directory, 'objects', entry.chunked!.parts[1]!.artifact.ref);
    const original = readFileSync(path), altered = Buffer.from(original);
    altered[0] = altered[0]! ^ 1;
    writeFileSync(path, altered);
    expect(() => verifyNativeProofPacket(f.directory, saved.locator, f.contract)).toThrow('custody retained bytes differ');
    writeFileSync(path, original);
    expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('complete');
    rmSync(path);
    expect(() => verifyNativeProofPacket(f.directory, saved.locator, f.contract)).toThrow();
  }, 60_000);

  it('keeps oversized malformed OUT diagnostics partial and preserves the archive byte bound', () => {
    const f = fixture(), out = f.contract.expected[0]!.out!;
    writeFileSync(out, '{' + ' '.repeat(17 * 1024 * 1024));
    const saved = f.save(), family = saved.manifest.groups[0]!.families.find(row => row.family === 'A')!;
    expect(saved.status).toBe('partial');
    expect(family.state).toBe('partial');
    expect(family.entries[0]!.chunked!.complete).toBe(true);
    rmSync(f.producer, { recursive: true });
    expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('partial');

    const bounded = fixture(), large = bounded.contract.expected[0]!.out!;
    fs.truncateSync(large, 64 * 16 * 1024 * 1024 + 1);
    const partial = bounded.save();
    expect(partial.status).toBe('partial');
    expect(partial.manifest.gaps).toContain('group-0:A:custody OUT archive byte limit');
    expect(partial.manifest.bytesReadByFamily!.A).toBe(0);
    expect(verifyNativeProofPacket(bounded.directory, partial.locator, bounded.contract).status).toBe('partial');
  }, 60_000);

  it('retains more than 64MiB across segments in a fresh consumer and rejects segment loss or replacement', () => {
    const f = fixture(), group = f.contract.expected[0]!;
    for (let index = 0; index < 9; index++)
      writeFileSync(join(group.out! + '.modules', `large-${index}.js`), Buffer.alloc(8 * 1024 * 1024, index));
    const saved = f.save();
    expect(saved.status).toBe('complete');
    expect(saved.manifest.bytesRead).toBeGreaterThan(64 * 1024 * 1024);
    expect(saved.manifest.segments!.length).toBeGreaterThan(1);
    for (const segment of saved.manifest.segments!)
      expect(segment.bytesRead).toBeLessThanOrEqual(64 * 1024 * 1024);
    rmSync(f.producer, { recursive: true });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { verifyNativeProofPacket } from ' + JSON.stringify(resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs')) + ';' +
      'console.log(verifyNativeProofPacket(...JSON.parse(process.argv[1])).status)',
      JSON.stringify([f.directory, saved.locator, f.contract])], { encoding: 'utf8', timeout: 30_000 });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    expect(child.stdout.trim()).toBe('complete');
    const pin = saved.manifest.segments![1]!.artifact;
    const path = join(f.directory, 'objects', pin.ref), original = readFileSync(path);
    writeFileSync(path, Buffer.from('{}'));
    expect(() => verifyNativeProofPacket(f.directory, saved.locator, f.contract)).toThrow();
    writeFileSync(path, original);
    const manifest = structuredClone(saved.manifest);
    manifest.segments!.pop();
    const forged = createNativeArtifactPersister(join(f.directory, 'objects'))
      .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
    expect(() => verifyNativeProofPacket(f.directory, { ...saved.locator, manifest: forged }, f.contract)).toThrow();
    rmSync(path);
    expect(() => verifyNativeProofPacket(f.directory, saved.locator, f.contract)).toThrow();
  });

  it.each(['group', 'attempt', 'family', 'occurrence', 'auxiliary', 'workspace', 'harness', 'run',
    'population', 'bytes', 'length', 'escape', 'object-mode', 'native-object', 'process-object'])
  ('P003 refuses retained-only %s loss or corruption after producer retirement', mutation => {
    const f = fixture(['primary', 'primary', 'detail']), saved = f.save();
    const manifest = structuredClone(saved.manifest), contract = structuredClone(f.contract);
    const detail = manifest.groups[2];
    if (mutation === 'group') manifest.groups.pop();
    if (mutation === 'attempt') detail.attempt = 'primary';
    if (mutation === 'family') detail.families.pop();
    if (mutation === 'occurrence') detail.references.pop();
    if (mutation === 'auxiliary') detail.auxiliary.pop();
    if (mutation === 'workspace') contract.identity.workspace = 'foreign';
    if (mutation === 'harness') contract.identity.harness = 'foreign';
    if (mutation === 'run') contract.identity.runId = 'foreign';
    if (mutation === 'population') contract.expected.pop();
    const entry = detail.families[1].entries[0];
    if (mutation === 'bytes') writeFileSync(join(f.directory, 'objects', entry.artifact.ref), Buffer.from('corrupt'));
    if (mutation === 'length') entry.artifact.byteLength++;
    if (mutation === 'escape') entry.artifact.ref = '../' + entry.artifact.ref;
    if (mutation === 'object-mode') chmodSync(join(f.directory, 'objects', entry.artifact.ref), 0o644);
    if (mutation === 'native-object') detail.families.find(family => family.family === 'C')!.entries.pop();
    if (mutation === 'process-object') detail.families.find(family => family.family === 'D')!.entries.pop();
    const pin = createNativeArtifactPersister(join(f.directory, 'objects'))
      .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
    rmSync(f.producer, { recursive: true });
    expect(consumeRetained(f, { ...saved.locator, manifest: pin }, contract)).toMatchObject({ refused: true });
  });

  it.each(['pending', 'missing-out', 'truncated-stream'])('P003 keeps %s custody partial independently of terminal execution and cleanup', fault => {
    const f = fixture(['primary', 'primary', 'detail']);
    if (fault === 'pending') writeFileSync(join(f.contract.expected[2].out + '.processes', 'worker.pending'), 'pending');
    if (fault === 'missing-out') rmSync(f.contract.expected[2].out);
    if (fault === 'truncated-stream') f.observations[2].captureComplete = false;
    const saved = retainNativeProofPacket(f.directory, { ...f.contract, observations: f.observations,
      execution: { state: 'closed', exitCode: 0 }, cleanup: { complete: true } });
    expect(saved.status).toBe('partial');
    rmSync(f.producer, { recursive: true });
    const result = consumeRetained(f, saved.locator);
    expect(result).toMatchObject({ refused: false, status: 'partial', manifest: { verdicts: {
      custody: 'partial', execution: { state: 'closed', exitCode: 0 }, cleanup: { complete: true },
      protocol: 'unqualified', nativeProof: 'unqualified', acceptance: 'unmeasured' } } });
    expect(result.manifest.gaps.length).toBeGreaterThan(0);
  });

  it('reads every primary/detail family and duplicate occurrence in a fresh process after producer removal', () => {
    const f = fixture(['primary', 'primary', 'detail']);
    const first = f.save(), again = f.save();
    expect(first.status).toBe('complete');
    expect(again.locator).toEqual(first.locator);
    expect(first.manifest.groups.map(group => group.references.length)).toEqual([9, 9, 9]);
    const original = first.manifest.groups.map(group => group.families.map(family => family.entries.map(entry => ({
      bytes: readFileSync(entry.original).toString('base64'), artifact: entry.artifact,
    }))));
    rmSync(f.producer, { recursive: true });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { verifyNativeProofPacket } from ' + JSON.stringify(resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs')) + ';' +
      'const r=verifyNativeProofPacket(...JSON.parse(process.argv[1]));' +
      'process.stdout.write(JSON.stringify({status:r.status,verdicts:r.manifest.verdicts,groups:r.manifest.groups.length}));',
      JSON.stringify([f.directory, first.locator, f.contract])], { encoding: 'utf8', timeout: 15_000 });
    expect({ error: child.error, stderr: child.stderr, status: child.status }).toEqual({ error: undefined, stderr: '', status: 0 });
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'complete', groups: 3, verdicts: {
      execution: { state: 'failed' }, cleanup: { complete: false }, nativeProof: 'unqualified', acceptance: 'unmeasured' } });
    for (const groups of original) for (const entries of groups) for (const entry of entries)
      expect(readFileSync(join(f.directory, 'objects', entry.artifact.ref)).toString('base64')).toBe(entry.bytes);
  });

  it('retains explicit partial custody at the auxiliary-family budget without charging metadata twice', () => {
    const f = fixture(), group = f.contract.expected[0]!;
    const initial = f.save();
    const auxiliaryLimit = initial.manifest.limits.families!.auxiliary.bytes;
    const usedBeforeLast = group.auxiliary.slice(0, 4).reduce((sum, spec) =>
      sum + readFileSync(spec.path).length + 1, 0);
    const remaining = auxiliaryLimit - usedBeforeLast - 1;
    writeFileSync(group.auxiliary[4]!.path, Buffer.alloc(remaining));
    const full = f.save();
    expect(full.status).toBe('complete');
    expect(full.manifest.bytesReadByFamily!.auxiliary).toBe(auxiliaryLimit - group.auxiliary.length);
    expect(full.manifest.bytesRead).toBeLessThanOrEqual(full.manifest.limits.bytes);
    expect(verifyNativeProofPacket(f.directory, full.locator, f.contract).status).toBe('complete');
    // An individual object must fit its family's segment budget. Rollover
    // cannot make a single oversized object admissible.
    writeFileSync(group.auxiliary[4].path, Buffer.alloc(auxiliaryLimit + 1));
    const partial = f.save();
    expect(partial.status).toBe('partial');
    expect(partial.manifest.gaps).toContain('group-0:cleanup:custody auxiliary byte limit');
    expect(partial.manifest.groups[0]!.auxiliary[4]!.captureError).toBe('custody auxiliary byte limit');
    expect(partial.manifest.groups[0]!.families.find(row => row.family === 'C')!.state).toBe('produced');
    expect(verifyNativeProofPacket(f.directory, partial.locator, f.contract)).toMatchObject({
      status: 'partial', verified: true, manifest: { verdicts: { nativeProof: 'unqualified', acceptance: 'unmeasured' } },
    });
  });

  it('keeps a retained reporter with an unsupported reference population explicitly partial', () => {
    const f = fixture(), group = f.contract.expected[0];
    const payload = JSON.parse(readFileSync(group.out, 'utf8'));
    payload.rows = Array.from({ length: 4097 }, () => ({}));
    writeFileSync(group.out, JSON.stringify(payload));
    const saved = f.save();
    expect(saved.status).toBe('partial');
    expect(saved.manifest.gaps).toContain('group-0:A:custody observation population');
    expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('partial');
  });

  it.each(['group', 'A', 'B', 'C', 'D', 'auxiliary', 'pending', 'truncated-stream'])('keeps %s absence/pending explicit and refuses complete custody', omission => {
    const f = fixture(['primary', 'detail']);
    const group = f.contract.expected[1];
    if (omission === 'group') f.observations.pop();
    else if (omission === 'truncated-stream') f.observations[1].captureComplete = false;
    else if (omission === 'auxiliary') rmSync(group.auxiliary[0].path);
    else if (omission === 'pending') writeFileSync(join(group.out + '.processes', 'process.pending'), 'pending');
    else rmSync(group.out + (({ A: '', B: '.modules', C: '.native-processes', D: '.processes' } as Record<string, string>)[omission] ?? ''), { recursive: true });
    const saved = f.save();
    expect(saved.status).toBe('partial');
    expect(saved.manifest.groups).toHaveLength(2);
    expect(saved.manifest.gaps.length).toBeGreaterThan(0);
    expect(verifyNativeProofPacket(f.directory, saved.locator, f.contract).status).toBe('partial');
    expect(saved.manifest.verdicts).toMatchObject({ nativeProof: 'unqualified', acceptance: 'unmeasured' });
  });

  it.each(['bytes', 'workspace', 'harness', 'run', 'population', 'root-mode', 'object-mode', 'leaf-symlink', 'ancestor-symlink'])('rejects %s corruption or private-boundary violations', mutation => {
    const f = fixture();
    const saved = f.save();
    let directory = f.directory;
    const contract = structuredClone(f.contract);
    const pin = saved.manifest.groups[0].families[0].entries[0].artifact;
    const object = join(f.directory, 'objects', pin.ref);
    if (mutation === 'bytes') { const bytes = readFileSync(object); bytes[0] ^= 1; writeFileSync(object, bytes); }
    if (mutation === 'workspace') contract.identity.workspace = 'foreign';
    if (mutation === 'harness') contract.identity.harness = 'foreign';
    if (mutation === 'run') contract.identity.runId = 'foreign';
    if (mutation === 'population') contract.expected.push({ ...contract.expected[0], id: 'omitted' });
    if (mutation === 'root-mode') chmodSync(directory, 0o755);
    if (mutation === 'object-mode') chmodSync(object, 0o644);
    if (mutation === 'leaf-symlink') { rmSync(object); symlinkSync(join(f.producer, 'out-0.json'), object); }
    if (mutation === 'ancestor-symlink') { const alias = join(f.root, 'alias'); symlinkSync(f.directory, alias); directory = alias; }
    expect(() => verifyNativeProofPacket(directory, saved.locator, contract)).toThrow();
  });

  it.each(['family', 'occurrence', 'auxiliary', 'verdict'])('rejects a self-consistent manifest omitting %s from the independent contract', mutation => {
    const f = fixture(), saved = f.save();
    const manifest = structuredClone(saved.manifest);
    if (mutation === 'family') manifest.groups[0].families.pop();
    if (mutation === 'occurrence') manifest.groups[0].references.pop();
    if (mutation === 'auxiliary') manifest.groups[0].auxiliary.pop();
    // @ts-expect-error Deliberately forge an invalid native-proof qualification.
    if (mutation === 'verdict') manifest.verdicts.nativeProof = 'qualified';
    const pin = createNativeArtifactPersister(join(f.directory, 'objects')).persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
    expect(() => verifyNativeProofPacket(f.directory, { ...saved.locator, manifest: pin }, f.contract)).toThrow();
  });

  it('refuses a resealed detail manifest missing its produced OUT declaration in a fresh retained-only consumer (P003)', () => {
    const f = fixture(['primary', 'primary', 'detail']), saved = f.save();
    const manifest = structuredClone(saved.manifest);
    const detail = manifest.groups[2];
    detail.families.find(family => family.family === 'A')!.entries = [];
    detail.references = [];
    const pin = createNativeArtifactPersister(join(f.directory, 'objects'))
      .persist(Buffer.from(JSON.stringify(manifest)), 'native-proof.json');
    rmSync(f.producer, { recursive: true });
    expect(fs.existsSync(f.producer)).toBe(false);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { verifyNativeProofPacket } from ' + JSON.stringify(resolve(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs')) + ';' +
      'try { const r=verifyNativeProofPacket(...JSON.parse(process.argv[1]));' +
      'process.stdout.write(JSON.stringify({refused:false,status:r.status,pid:process.pid})); }' +
      'catch(error) { process.stdout.write(JSON.stringify({refused:true,error:String(error),pid:process.pid})); }',
      JSON.stringify([f.directory, { ...saved.locator, manifest: pin }, f.contract])],
    { encoding: 'utf8', timeout: 15_000 });
    expect({ error: child.error, stderr: child.stderr, status: child.status })
      .toEqual({ error: undefined, stderr: '', status: 0 });
    const result = JSON.parse(child.stdout);
    expect(result.pid).not.toBe(process.pid);
    expect(result).toMatchObject({ refused: true });
  });
});

// Retain failure evidence before the fixture's finally block removes its trace.
// An absent entry is unknown startup progress, not proof the child never ran.
function assertNativeFixtureCompleted(child: ReturnType<typeof spawnSync>, out: string, phase: string) {
  if (!child.error) return;
  const events: { pid?: number; event?: string; atMs?: number; loadId?: number; url?: string }[] = [];
  let traceReadError: string | null = null;
  let traceFiles = 0;
  try {
    const names = readdirSync(`${out}.native-processes`).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    traceFiles = names.length;
    const buffer = Buffer.alloc(128 * 1024 + 1);
    for (const name of names.slice(0, 2048)) {
      const fd = openSync(join(`${out}.native-processes`, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let length = 0;
      try {
        if (!fstatSync(fd).isFile()) continue;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (!count) break;
          length += count;
        }
      } finally { closeSync(fd); }
      if (length > 128 * 1024) continue;
      const bytes = buffer.subarray(0, length);
      if (createHash('sha256').update(bytes).digest('hex') !== name.slice(0, 64)) continue;
      const row = JSON.parse(bytes.toString('utf8'));
      if (row.kind === 'native-node-process-event') events.push(row);
    }
  } catch (error) { traceReadError = error instanceof Error ? error.name : 'unknown'; }
  events.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  const terminalLoads = new Set(events.filter(row => row.event === 'module-load-return' || row.event === 'module-load-error')
    .map(row => `${row.pid}:${row.loadId}`));
  const tail = (value: Buffer | string | null) => {
    const bytes = Buffer.from(value ?? '');
    return { byteLength: bytes.length, tailBase64: bytes.subarray(-2048).toString('base64') };
  };
  const diagnostic = {
    phase, pid: child.pid, code: (child.error as NodeJS.ErrnoException).code ?? null,
    status: child.status, signal: child.signal,
    // An exit event records synchronous listener completion. It does not prove
    // OS process termination, closed inherited pipes, or parent collection.
    terminationObserved: false,
    traceStatus: events.length ? 'observed' : 'unknown', traceFiles, traceReadError,
    traceTruncated: traceFiles > 2048, eventCount: events.length,
    rootProcess: {
      entryObserved: events.some(row => row.pid === child.pid && row.event === 'node-entry'),
      exitStartedObserved: events.some(row => row.pid === child.pid && row.event === 'node-exit-start'),
      exitCompletedObserved: events.some(row => row.pid === child.pid && row.event === 'node-exit'),
      loadTraceLimited: events.some(row => row.pid === child.pid &&
        (row.event === 'module-load-limit' || row.event === 'trace-limit')),
      lastEvent: events.filter(row => row.pid === child.pid).at(-1)?.event ?? null,
    },
    lastEvents: events.slice(-8).map(({ pid, event, atMs }) => ({ pid, event, atMs })),
    pendingLoads: events.filter(row => row.event === 'module-load-start' && !terminalLoads.has(`${row.pid}:${row.loadId}`))
      .slice(-8).map(({ pid, loadId, url }) => ({ pid, loadId, url: url?.slice(-512) })),
    stdout: tail(child.stdout), stderr: tail(child.stderr),
  };
  let retainedRoot: string | null = null;
  let retentionError: string | null = null;
  try {
    retainedRoot = mkdtempSync(join(tmpdir(), 'native-fixture-failure-'));
    cpSync(dirname(out), join(retainedRoot, 'fixture'), { recursive: true, dereference: false });
    writeFileSync(join(retainedRoot, 'failure.json'), JSON.stringify(diagnostic), { mode: 0o600 });
  } catch (error) { retentionError = error instanceof Error ? error.message : String(error); }
  child.error.message += `\nNATIVE_FIXTURE_FAILURE ${JSON.stringify({ ...diagnostic, retainedRoot, retentionError })}`;
  throw child.error;
}

describe('native npm lifecycle diagnostics', () => {
  function observe(root: string, fail: string | null = null, shell = '/bin/sh') {
    const scripts = Object.fromEntries(['pretest', 'test', 'posttest'].map(phase =>
      [phase, `printf 'shell-${phase}\\n'; node fixture.mjs ${phase}`]));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'native-npm-protocol-fixture', private: true, scripts }));
    writeFileSync(join(root, 'fixture.mjs'), `
      import { spawn } from 'node:child_process';
      process.stdout.write('node-' + process.argv[2] + '\\n');
      process.stderr.write('stderr-' + process.argv[2] + '\\n');
      if (process.argv[2] === 'test') spawn(process.execPath, ['-e', 'process.stdout.write("descendant")'], {stdio:'inherit'});
      process.exitCode = process.argv[2] === ${JSON.stringify(fail)} ? 7 : 0;
    `);
    const out = join(root, 'out.json'), command = ['npm', 'run', 'test'];
    const pins = ['package.json', 'fixture.mjs'].map(path => ({ path,
      sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }));
    const startedAtMs = Date.now();
    const child = spawnSync(command[0]!, command.slice(1), { cwd: root, timeout: 20_000,
      env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        npm_config_script_shell: shell, PAPERCUSP_TEST_STARTUP_TRACE: '0' }) });
    assertNativeFixtureCompleted(child, out, `npm-lifecycle:${fail ?? 'success'}`);
    return { task: 'native-npm-protocol-fixture', attempt: 'initial', cwd: root, command,
      originalCommand: scripts.test, startedAtMs, finishedAtMs: Date.now(), exitCode: child.status,
      signal: child.signal, error: null, captureComplete: true, stdout: child.stdout, stderr: child.stderr,
      before: pins, after: pins, processTrace: { out, rootPid: child.pid } };
  }
  let root: string, baseline: ReturnType<typeof observe>;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'native-npm-lifecycle-')); baseline = observe(root); }, 30_000);
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });
  it.each([null, 'pretest', 'test', 'posttest'])('native-npm-shell-identity: retains actual npm shells, inherited stdio and lifecycle failure %s', fail => {
    const runRoot = fail === null ? root : mkdtempSync(join(tmpdir(), 'native-npm-failure-'));
    try {
      const input = fail === null ? baseline : observe(runRoot, fail);
      const expectedScripts = JSON.parse(readFileSync(join(input.cwd, 'package.json'), 'utf8')).scripts as Record<string, string>;
      const result = writeBudgetedTaskNativeExecutionReceipt(join(runRoot, 'retained'), input);
      const trace = result.observation.processTrace, lifecycle = trace.npmLifecycle;
      const expected = ['pretest', 'test', 'posttest'].slice(0, fail === 'pretest' ? 1 : fail === 'test' ? 2 : 3);
      expect(lifecycle.status).toBe('observed');
      expect(lifecycle.spans.map(row => row.event)).toEqual(expected);
      expect(lifecycle.root!.pid).toBe(input.processTrace.rootPid);
      for (const [index, span] of lifecycle.spans.entries()) {
        expect(span.command).toBe('/bin/sh');
        expect(span.script).toBe(expectedScripts[span.event]);
        expect(span.argv).toEqual(['-c', expectedScripts[span.event]]);
        expect(span.cwd).toBe(input.cwd);
        expect(span.stdioAccessible).toEqual({ stdout: false, stderr: false });
        expect(span.observerPid).toBe(input.processTrace.rootPid);
        expect(span.closedAtMs).toBeGreaterThanOrEqual(span.startedAtMs);
        expect(span.startedAtMs).toBeGreaterThanOrEqual(index ? lifecycle.spans[index - 1]!.closedAtMs : input.startedAtMs);
        expect(span.exitCode).toBe(span.event === fail ? 7 : 0);
        for (const pin of [span.spawn, span.close]) expect(createHash('sha256')
          .update(readFileSync(join(result.root, pin.ref))).digest('hex')).toBe(pin.sha256);
      }
      if (expected.includes('test')) expect(trace.events.some(row => row.event === 'child-spawn' &&
        row.pid !== input.processTrace.rootPid && (row.lifecycle as { event: string })?.event === 'test')).toBe(true);
      expect(result.observation.execution.exitCode).toBe(fail === null ? 0 : 7);
      expect(lifecycle.gaps).toEqual(expect.arrayContaining(['lifecycle-shell-streams-unobserved', 'lifecycle-step-reports-unobserved']));
      expect(result.observation.steps).toEqual([]);
      expect(result.observation.orderedChainQualified).toBe(false);
      expect(result.observation.runtimeClosure).toBe('unmeasured');
      expect(result.observation.operationalAcceptance).toBe(false);
    } finally { if (runRoot !== root) rmSync(runRoot, { recursive: true, force: true }); }
  }, 30_000);
  it('native-npm-shell-identity: preserves an actually configured bash shell without relabelling the original sh capture', () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'native-npm-bash-'));
    try {
      const input = observe(runRoot, null, '/bin/bash');
      const expectedScripts = JSON.parse(readFileSync(join(input.cwd, 'package.json'), 'utf8')).scripts as Record<string, string>;
      const originalScripts = JSON.parse(readFileSync(join(baseline.cwd, 'package.json'), 'utf8')).scripts as Record<string, string>;
      const result = writeBudgetedTaskNativeExecutionReceipt(join(runRoot, 'retained'), input);
      expect(result.observation.processTrace.npmLifecycle.spans).toHaveLength(3);
      expect(result.observation.processTrace.npmLifecycle.spans.every(span => span.command === '/bin/bash')).toBe(true);
      const original = writeBudgetedTaskNativeExecutionReceipt(join(root, 'original-retained'), baseline);
      expect(original.observation.processTrace.npmLifecycle.spans.every(span => span.command === '/bin/sh')).toBe(true);
      for (const [receipt, nativeInput, scripts] of [
        [result, input, expectedScripts], [original, baseline, originalScripts],
      ] as const) {
        expect(receipt.observation.processTrace.npmLifecycle.spans.map(span => span.event)).toEqual(['pretest', 'test', 'posttest']);
        for (const span of receipt.observation.processTrace.npmLifecycle.spans) {
          expect(span.script).toBe(scripts[span.event]);
          expect(span.argv).toEqual(['-c', scripts[span.event]]);
          expect(span.cwd).toBe(nativeInput.cwd);
        }
      }
      expect(result.observation.orderedChainQualified).toBe(false);
    } finally { rmSync(runRoot, { recursive: true, force: true }); }
  }, 30_000);
  it.each(['missing-close', 'duplicate-close', 'duplicate-spawn', 'observer', 'child', 'argv',
    'stdio', 'close-status', 'overlap', 'root', 'root-script'] as const)('does not promote %s observations into lifecycle spans', fault => {
    const replay = mkdtempSync(join(tmpdir(), 'native-npm-protocol-replay-'));
    try {
      const out = join(replay, 'out.json'), source = `${out}.native-processes`;
      cpSync(`${baseline.processTrace.out}.native-processes`, source, { recursive: true });
      const rows = readdirSync(source).filter(name => name.endsWith('.json')).map(name =>
        ({ name, row: JSON.parse(readFileSync(join(source, name), 'utf8')) }));
      const spawn = rows.find(({ row }) => row.event === 'child-spawn' && row.pid === baseline.processTrace.rootPid &&
        row.lifecycle?.event === 'pretest')!;
      const close = rows.find(({ row }) => row.event === 'child-close' && row.childIdentity === spawn.row.childIdentity)!;
      const entry = rows.find(({ row }) => row.event === 'node-entry' && row.pid === baseline.processTrace.rootPid)!;
      const replace = (target: typeof spawn, row: typeof spawn.row, keep = false) => {
        if (!keep) rmSync(join(source, target.name));
        const bytes = Buffer.from(JSON.stringify(row));
        writeFileSync(join(source, `${createHash('sha256').update(bytes).digest('hex')}.json`), bytes);
      };
      if (fault === 'missing-close') rmSync(join(source, close.name));
      if (fault === 'duplicate-close') replace(close, { ...close.row, extraObservation: true }, true);
      if (fault === 'duplicate-spawn') replace(spawn, { ...spawn.row, extraObservation: true }, true);
      if (fault === 'observer') replace(spawn, { ...spawn.row, processIdentity: 'unrelated-observer' });
      if (fault === 'child') replace(close, { ...close.row, childIdentity: 'unrelated-child' });
      if (fault === 'argv') replace(spawn, { ...spawn.row, argv: ['-c', 'unobserved command'] });
      if (fault === 'stdio') replace(spawn, { ...spawn.row, stdioAccessible: {} });
      if (fault === 'close-status') replace(close, { ...close.row, code: null, signal: null });
      if (fault === 'overlap') replace(close, { ...close.row, atMs: baseline.finishedAtMs });
      if (fault === 'root') replace(entry, { ...entry.row, processIdentity: 'another-root' }, true);
      if (fault === 'root-script') replace(entry, { ...entry.row, argv: [entry.row.argv[0], entry.row.argv[1], 'run', 'other'] });
      const result = writeBudgetedTaskNativeExecutionReceipt(join(replay, 'retained'), {
        ...baseline, processTrace: { ...baseline.processTrace, out } });
      const trace = result.observation.processTrace;
      expect(trace.events.length).toBeGreaterThan(0);
      expect(trace.streams.length).toBeGreaterThan(0);
      expect(trace.npmLifecycle.spans.some(row => row.childIdentity === spawn.row.childIdentity)).toBe(false);
      expect(trace.npmLifecycle.gaps.length).toBeGreaterThan(3);
      if (fault === 'root' || fault === 'root-script') expect(trace.npmLifecycle.status).toBe('unknown');
      expect(result.observation.orderedChainQualified).toBe(false);
      expect(result.observation.operationalAcceptance).toBe(false);
    } finally { rmSync(replay, { recursive: true, force: true }); }
  });
});

describe('native affected-task parent receipt transport', () => {
  it('retains bounded native timeout diagnostics after fixture cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-process-timeout-'));
    let failure: Error | undefined;
    let observed: ReturnType<typeof spawnSync> | undefined;
    try {
      const out = join(root, 'source-map.json');
      // A real blocked child, with the production preload and inherited loader.
      // Startup may itself exceed the ceiling; its progress then stays unknown.
      observed = spawnSync(process.execPath, ['-e',
        "process.stdout.write('fixture-ready'); process.stderr.write('fixture-stderr'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);"], {
        cwd: REPO_ROOT, timeout: 2000,
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }),
      });
      try { assertNativeFixtureCompleted(observed, out, 'forced-timeout'); }
      catch (error) { failure = error as Error; }
    } finally { rmSync(root, { recursive: true, force: true }); }
    expect(failure).toBe(observed!.error);
    const diagnostic = JSON.parse(failure!.message.split('\nNATIVE_FIXTURE_FAILURE ')[1]!);
    expect(diagnostic).toMatchObject({ phase: 'forced-timeout', code: 'ETIMEDOUT', pid: observed!.pid,
      stdout: { byteLength: observed!.stdout.length }, stderr: { byteLength: observed!.stderr.length } });
    expect(Buffer.from(diagnostic.stdout.tailBase64, 'base64')).toEqual(Buffer.from(observed!.stdout).subarray(-2048));
    expect(Buffer.from(diagnostic.stderr.tailBase64, 'base64')).toEqual(Buffer.from(observed!.stderr).subarray(-2048));
    expect(diagnostic.lastEvents.length).toBeLessThanOrEqual(8);
    expect(diagnostic.pendingLoads.length).toBeLessThanOrEqual(8);
    expect(diagnostic.traceStatus).toBe(diagnostic.eventCount ? 'observed' : 'unknown');
    expect(readdirSync(dirname(root))).not.toContain(root.split('/').at(-1));
    // The original finally cleanup must leave an independently readable packet.
    try {
      expect(diagnostic.retentionError).toBeNull();
      const retained = JSON.parse(readFileSync(join(diagnostic.retainedRoot, 'failure.json'), 'utf8'));
      expect(retained).toMatchObject({ phase: 'forced-timeout', code: 'ETIMEDOUT',
        pid: observed!.pid, terminationObserved: false });
      expect(retained.stdout).toEqual(diagnostic.stdout);
      expect(retained.stderr).toEqual(diagnostic.stderr);
      if (diagnostic.traceStatus === 'observed') {
        const names = readdirSync(join(diagnostic.retainedRoot, 'fixture', 'source-map.json.native-processes'));
        expect(names.filter(name => name.endsWith('.json'))).toHaveLength(diagnostic.traceFiles);
      }
    } finally { if (diagnostic.retainedRoot) rmSync(diagnostic.retainedRoot, { recursive: true, force: true }); }
  }, 15_000);

  it.each([16384, 16385, 55278])('retains bounded authenticated observations from %i artifacts including streams', count => {
    const root = mkdtempSync(join(tmpdir(), 'native-process-population-'));
    try {
      const out = join(root, 'source-map.json'), source = `${out}.native-processes`;
      mkdirSync(source);
      const publish = (bytes: Buffer, suffix: string) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(join(source, `${sha256}.${suffix}`), bytes);
        return { ref: `${sha256}.${suffix}`, sha256, byteLength: bytes.length,
          observedByteLength: bytes.length, scope: 'node-writable-call-inputs', captureComplete: true };
      };
      const stdout = publish(Buffer.from('population output'), 'stream');
      const stderr = publish(Buffer.from('population error'), 'stream');
      for (let i = 0; i < count - 2; i++) publish(Buffer.from(JSON.stringify({
        schemaVersion: 1, kind: 'native-node-process-event', processIdentity: 'population-fixture',
        pid: 1234, ppid: 1, atMs: 100 + i,
        event: i === 0 ? 'node-entry' : i === 1 ? 'node-exit' : 'module-load-return',
        ...(i === 1 ? { exitListenersComplete: true, streams: { stdout, stderr } } : {}),
      })), 'json');
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), {
        task: 'population-fixture', attempt: 'initial', cwd: REPO_ROOT, command: ['node', 'fixture'],
        startedAtMs: 100, finishedAtMs: 100 + count, exitCode: 0, signal: null, error: null,
        captureComplete: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        processTrace: { out, rootPid: 1234 },
      });
      const trace = result.observation.processTrace;
      expect(trace.population).toMatchObject({ artifactLimit: 16384,
        artifactsVisited: Math.min(count, 16384), complete: count === 16384,
        truncatedBy: count === 16384 ? null : 'artifact-count' });
      expect(trace.events.length).toBeGreaterThan(0);
      expect(trace.events.length).toBeLessThanOrEqual(16384);
      expect(trace.population!.eventBytesRead).toBeLessThanOrEqual(trace.population!.eventByteLimit);
      expect(trace.gaps.some(gap => gap.startsWith('native-process-trace-unreadable:'))).toBe(false);
      expect(trace.gaps.includes('native-process-population-truncated:artifact-count')).toBe(count > 16384);
      if (count === 16384) {
        expect(trace.events).toHaveLength(count - 2);
        expect(trace.streams).toHaveLength(2);
      }
      for (const event of [trace.events[0]!, trace.events.at(-1)!]) {
        const bytes = readFileSync(join(result.root, event.artifact.ref));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(event.artifact.sha256);
        expect(event.atMs).toBeGreaterThanOrEqual(100);
        expect(event.atMs).toBeLessThanOrEqual(100 + count);
      }
      expect(result.observation.orderedChainQualified).toBe(false);
      expect(result.observation.operationalAcceptance).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  it('binds real process-step artifacts to the native root while preserving chain/runtime refusal', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-process-parent-'));
    try {
      const out = join(root, 'source-map.json');
      const command = [process.execPath, '-e', "require('node:child_process').spawn(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,10])); process.stderr.write(Buffer.from([254,13,10])); process.exitCode = 3'], {stdio:'inherit'});"];
      const startedAtMs = Date.now();
      const child = spawnSync(command[0]!, command.slice(1), { cwd: REPO_ROOT,
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), timeout: 15_000 });
      assertNativeFixtureCompleted(child, out, 'process-step-root');
      const unrelated = spawnSync(process.execPath, ['-e', 'process.exitCode = 0'], {
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
          PAPERCUSP_TEST_STARTUP_TRACE: '0' }), timeout: 15_000 });
      assertNativeFixtureCompleted(unrelated, out, 'unrelated-process');
      const input = { task: 'native-fixture :: test', attempt: 'initial', cwd: REPO_ROOT, command,
        startedAtMs, finishedAtMs: Date.now(), exitCode: child.status, signal: child.signal,
        error: null, captureComplete: true, stdout: child.stdout, stderr: child.stderr,
        processTrace: { out, rootPid: child.pid } };
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input);
      const trace = result.observation.processTrace;
      expect(trace.events.map(row => row.event)).toEqual(expect.arrayContaining([
        'node-entry', 'node-exit', 'child-spawn', 'child-close',
      ]));
      expect(trace.events.filter(row => row.event === 'node-entry')).toHaveLength(2);
      expect(trace.events.some(row => row.pid === unrelated.pid)).toBe(false);
      expect(trace.events.find(row => row.event === 'child-close')).toMatchObject({ code: 3 });
      expect(trace.streams).toHaveLength(4);
      const leaf = trace.events.find(row => row.event === 'node-entry' && row.pid !== child.pid)!;
      const leafStreams = trace.streams.filter(row => row.processIdentity === leaf.processIdentity);
      for (const row of leafStreams) {
        expect(row.captureComplete).toBe(true);
        expect(readFileSync(join(result.root, row.artifact.ref))).toEqual(
          Buffer.from(row.role === 'stdout' ? [0,255,10] : [254,13,10]));
      }
      expect(trace.gaps).toContain('direct-fd-native-and-inherited-stream-writes-unobserved');
      for (const row of trace.events) {
        const bytes = readFileSync(join(result.root, row.artifact.ref));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.artifact.sha256);
      }
      expect(result.observation.steps).toEqual([]);
      expect(result.observation.orderedChainQualified).toBe(false);
      expect(result.observation.runtimeClosure).toBe('unmeasured');
      // Tampered or redirected process evidence is retained as a gap, never a
      // fabricated step or a successful qualification.
      const stream = leafStreams[0]!;
      writeFileSync(join(`${out}.native-processes`, `${stream.artifact.sha256}.stream`), Buffer.from([1,2,3]));
      const badStream = writeBudgetedTaskNativeExecutionReceipt(join(root, 'bad-stream'), input).observation;
      expect(badStream.processTrace.streams).toEqual([]);
      expect(badStream.processTrace.gaps.join(' ')).toContain('stream artifact hash mismatch');
      const names = readdirSync(`${out}.native-processes`).filter(name => name.endsWith('.json'));
      writeFileSync(join(`${out}.native-processes`, names[0]!), '{}');
      const bad = writeBudgetedTaskNativeExecutionReceipt(join(root, 'bad'), input).observation;
      expect(bad.processTrace.events).toEqual([]);
      expect(bad.processTrace.gaps.join(' ')).toContain('hash mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  function nativeReporterObservation(root: string, reason: 'passed' | 'failed' | null = 'passed', nested = false) {
    const out = join(root, 'native-out.json');
    // Protocol fixture only: a real observed Node process writes its own identity
    // and interval. The archive must not interpret this as a Vitest pass proof.
    const script = `
      const fs = require('node:fs');
      const startedAtMs = Date.now();
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ nativeRun: {
        schemaVersion: 'native-vitest-run-v1', scope: 'vitest-reporter-callbacks',
        pid: process.pid, ppid: process.ppid, startedAtMs, finishedAtMs: Date.now(),
        reason: ${JSON.stringify(reason)}, terminalHook: ${JSON.stringify(reason === null ? 'onExit' : 'onTestRunEnd')},
        unhandledErrorCount: ${reason === 'failed' ? 1 : 0}, files: []
      }}));
      process.stdout.write('observed protocol fixture');
      process.exitCode = ${reason === 'failed' ? 3 : 0};
    `;
    const command = nested ? [process.execPath, '-e', `
      require('node:child_process').spawn('/bin/sh', ['-c', '"$1" -e "$2"',
        'native-reporter', process.execPath, ${JSON.stringify(script)}], { stdio: 'inherit' })
        .once('close', code => { process.exitCode = code; });
    `] : [process.execPath, '-e', script];
    const startedAtMs = Date.now();
    const child = spawnSync(command[0]!, command.slice(1), { cwd: REPO_ROOT, timeout: 15_000,
      env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        PAPERCUSP_TEST_STARTUP_TRACE: '0' }) });
    assertNativeFixtureCompleted(child, out, nested ? 'nested-reporter' : 'reporter');
    return { out, input: { task: 'native-reporter-fixture', attempt: 'initial', cwd: REPO_ROOT,
      command, startedAtMs, finishedAtMs: Date.now(), exitCode: child.status,
      signal: child.signal, error: null, captureComplete: true, stdout: child.stdout,
      stderr: child.stderr, processTrace: { out, rootPid: child.pid } } };
  }
  it.each(['passed', 'failed', null] as const)('archives native reporter bytes and process binding without qualifying outcome %s', reason => {
    const root = mkdtempSync(join(tmpdir(), 'native-reporter-bound-'));
    try {
      const { out, input } = nativeReporterObservation(root, reason);
      const bytes = readFileSync(out);
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input);
      const reporter = result.observation.processTrace.reporter;
      expect(reporter.status).toBe('bound');
      expect(reporter.artifact).toMatchObject({ sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length });
      expect(readFileSync(join(result.root, reporter.artifact!.ref))).toEqual(bytes);
      expect(reporter.process).toMatchObject({ pid: input.processTrace.rootPid,
        ppid: process.pid });
      const entry = result.observation.processTrace.events.find(row => row.event === 'node-entry');
      expect(reporter.process!.entry).toEqual(entry!.artifact);
      expect(JSON.parse(readFileSync(join(result.root, reporter.artifact!.ref), 'utf8')).nativeRun.reason).toBe(reason);
      expect(result.observation.execution.exitCode).toBe(reason === 'failed' ? 3 : 0);
      expect(result.observation.steps).toEqual([]);
      expect(result.observation.orderedChainQualified).toBe(false);
      expect(result.observation.operationalAcceptance).toBe(false);
      expect(reporter.gaps).toContain('reporter-evaluator-sidecars-not-retained');
      expect(writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input).receipt).toEqual(result.receipt);
      writeFileSync(out, '{}');
      expect(readFileSync(join(result.root, reporter.artifact!.ref))).toEqual(bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('binds the main reporter with shared-PID thread evidence and rejects a thread-only reporter', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-reporter-thread-'));
    try {
      const { input } = nativeReporterObservation(root, 'passed');
      const source = `${input.processTrace.out}.native-processes`;
      const entries = readdirSync(source).filter(name => name.endsWith('.json')).map(name => ({
        name, row: JSON.parse(readFileSync(join(source, name), 'utf8')),
      }));
      const reporterEvents = entries.filter(({ row }) => row.pid === input.processTrace.rootPid &&
        ['node-entry', 'node-exit'].includes(row.event));
      expect(reporterEvents.filter(({ row }) => row.event === 'node-entry')).toHaveLength(1);
      for (const { row } of reporterEvents) {
        const bytes = Buffer.from(JSON.stringify({ ...row, threadId: 1, processIdentity: 'worker-thread-context' }));
        writeFileSync(join(source, `${createHash('sha256').update(bytes).digest('hex')}.json`), bytes);
      }
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input);
      expect(result.observation.processTrace.reporter.status).toBe('bound');
      expect(result.observation.processTrace.events.some(row => row.threadId === 1)).toBe(true);
      for (const { name } of reporterEvents) rmSync(join(source, name));
      const threadOnly = writeBudgetedTaskNativeExecutionReceipt(join(root, 'thread-only'), input);
      expect(threadOnly.observation.processTrace.reporter.status).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('binds a nested reporter through its observed lifecycle shell and rejects an unclosed span', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-reporter-lifecycle-'));
    try {
      const { input } = nativeReporterObservation(root, 'failed', true);
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input);
      const reporter = result.observation.processTrace.reporter;
      expect(reporter.status).toBe('bound');
      expect(reporter.process!.pid).not.toBe(input.processTrace.rootPid);
      expect(reporter.process!.lifecycle!.childPid).toBe(reporter.process!.ppid);
      expect(result.observation.execution.exitCode).toBe(3);
      const source = `${input.processTrace.out}.native-processes`;
      const close = result.observation.processTrace.events.find(row =>
        row.artifact.sha256 === reporter.process!.lifecycle!.close.sha256)!;
      rmSync(join(source, `${close.artifact.sha256}.json`));
      const unclosed = writeBudgetedTaskNativeExecutionReceipt(join(root, 'unclosed'), input);
      expect(unclosed.observation.processTrace.reporter.status).toBe('unknown');
      expect(unclosed.observation.processTrace.events.length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  function evaluatorObservation(out: string, code = 'export const observed = 1;') {
    const bytes = Buffer.from(code), sha256 = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(`${out}.modules`, { recursive: true });
    const codeRef = join(`${out}.modules`, `${sha256}.js`);
    writeFileSync(codeRef, bytes);
    const pin = { id: 'observed.ts', sha256, byteLength: bytes.length, codeRef };
    return { bytes, pin, observation: { schemaVersion: 'vitest-evaluator-inputs-v1',
      scope: 'vitest-inlined-evaluator-inputs', basis: 'before-evaluator-call',
      entries: [pin], vmInputs: [{ ...pin, inputIndex: 0, api: 'runInThisContext', filename: 'observed.ts' }],
      reasons: ['external-loader-bytes-unobserved'] } };
  }
  it('retains historical evaluator custody without inventing a native execution receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'historical-evaluator-custody-'));
    try {
      const out = join(root, 'original.json');
      const { bytes, pin, observation } = evaluatorObservation(out);
      const payload = { rows: [{ moduleEvaluations: observation }] };
      const original = Buffer.from(JSON.stringify(payload));
      const store = createNativeArtifactPersister(join(root, 'retained'));
      const reporter = store.persist(original, 'native-vitest-out.json');
      const retained = retainReporterEvaluatorArtifacts(payload, out, store.persist);
      expect(retained).toMatchObject({ status: 'retained', referencesVisited: 2, gaps: [] });
      // A foreign codeRef stays rejected even when the expected digest exists.
      const foreign = { rows: [{ moduleEvaluations: { ...observation,
        entries: [{ ...pin, codeRef: join(root, 'elsewhere', basename(pin.codeRef)) }], vmInputs: [] } }] };
      expect(retainReporterEvaluatorArtifacts(foreign, out, store.persist)).toMatchObject({
        status: 'partial', entries: [], gaps: ['evaluator-sidecar-rejected:redirected-reference'] });
      expect(() => store.persist(bytes, '../escape')).toThrow('invalid artifact bytes or suffix');
      rmSync(`${out}.modules`, { recursive: true });
      expect(readFileSync(join(store.root, reporter.ref))).toEqual(original);
      for (const row of retained.entries)
        expect(readFileSync(join(store.root, row.artifact.ref))).toEqual(bytes);
      expect(readdirSync(store.root).some(name => name.endsWith('.receipt.json'))).toBe(false);
      expect(JSON.parse(readFileSync(join(store.root, reporter.ref), 'utf8'))).toEqual(payload);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['passed', 'failed'] as const)('archives evaluator reference occurrences and bytes without qualifying %s reporter output', reason => {
    const root = mkdtempSync(join(tmpdir(), 'native-evaluator-retained-'));
    try {
      const { out, input } = nativeReporterObservation(root, reason);
      const { bytes, observation } = evaluatorObservation(out);
      const payload = JSON.parse(readFileSync(out, 'utf8'));
      payload.rows = [{ moduleEvaluations: observation }];
      payload.diagnostics = [{ moduleEvaluations: observation }];
      payload.nativeRun.files = [{ proof: { inputs: { moduleEvaluations: observation } } }];
      writeFileSync(out, JSON.stringify(payload));
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input);
      const reporter = result.observation.processTrace.reporter;
      expect(reporter.status).toBe('bound');
      expect(reporter.evaluatorArtifacts).toMatchObject({ scope: 'referenced-evaluator-code',
        status: 'retained', referencesVisited: 6, bytesRetained: bytes.length, gaps: [] });
      expect(reporter.evaluatorArtifacts!.entries.map(row => row.location)).toEqual([
        '/rows/0/moduleEvaluations/entries/0', '/rows/0/moduleEvaluations/vmInputs/0',
        '/diagnostics/0/moduleEvaluations/entries/0', '/diagnostics/0/moduleEvaluations/vmInputs/0',
        '/nativeRun/files/0/proof/inputs/moduleEvaluations/entries/0',
        '/nativeRun/files/0/proof/inputs/moduleEvaluations/vmInputs/0']);
      expect(reporter.gaps).not.toContain('reporter-evaluator-sidecars-not-retained');
      expect(writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input).receipt).toEqual(result.receipt);
      rmSync(`${out}.modules`, { recursive: true });
      for (const row of reporter.evaluatorArtifacts!.entries)
        expect(readFileSync(join(result.root, row.artifact.ref))).toEqual(bytes);
      expect(JSON.parse(readFileSync(join(result.root, reporter.artifact!.ref), 'utf8'))).toEqual(payload);
      expect(result.observation.execution.exitCode).toBe(reason === 'failed' ? 3 : 0);
      expect(result.observation).toMatchObject({ steps: [], orderedChainQualified: false,
        runtimeClosure: 'unmeasured', operationalAcceptance: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['missing', 'tampered', 'symlink', 'directory', 'escape', 'length', 'digest', 'oversized',
    'missing-reference', 'protocol', 'population', 'redirected-root'] as const)(
    'keeps bound reporter evidence and good evaluator references when a sidecar is %s', fault => {
      const root = mkdtempSync(join(tmpdir(), 'native-evaluator-partial-'));
      try {
        const { out, input } = nativeReporterObservation(root);
        const good = evaluatorObservation(out), bad = evaluatorObservation(out, 'export const other = 2;');
        const pin = { ...bad.pin }, observation = { ...bad.observation, entries: [pin], vmInputs: [] };
        if (fault === 'missing') rmSync(pin.codeRef);
        if (fault === 'tampered') writeFileSync(pin.codeRef, 'x'.repeat(pin.byteLength));
        if (fault === 'symlink' || fault === 'directory') {
          rmSync(pin.codeRef);
          if (fault === 'symlink') symlinkSync(good.pin.codeRef, pin.codeRef);
          else mkdirSync(pin.codeRef);
        }
        if (fault === 'escape') pin.codeRef = good.pin.codeRef;
        if (fault === 'length') pin.byteLength++;
        if (fault === 'digest') pin.sha256 = '0'.repeat(64);
        if (fault === 'oversized') pin.byteLength = 16 * 1024 * 1024 + 1;
        if (fault === 'missing-reference') delete (pin as Partial<typeof pin>).codeRef;
        if (fault === 'protocol') observation.schemaVersion = 'unknown-protocol';
        if (fault === 'population') (observation as unknown as { entries: unknown }).entries = {};
        if (fault === 'redirected-root') {
          const target = join(root, 'other-modules');
          cpSync(`${out}.modules`, target, { recursive: true });
          rmSync(`${out}.modules`, { recursive: true }); symlinkSync(target, `${out}.modules`);
        }
        const payload = JSON.parse(readFileSync(out, 'utf8'));
        payload.rows = [{ moduleEvaluations: good.observation }, { moduleEvaluations: observation }];
        writeFileSync(out, JSON.stringify(payload));
        const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input);
        const reporter = result.observation.processTrace.reporter;
        expect(reporter.status).toBe('bound');
        expect(reporter.artifact).not.toBeNull();
        expect(reporter.evaluatorArtifacts!.status).toBe('partial');
        expect(reporter.evaluatorArtifacts!.gaps.length).toBeGreaterThan(0);
        expect(reporter.evaluatorArtifacts!.entries).toHaveLength(fault === 'redirected-root' ? 0 : 2);
        expect(reporter.gaps).toContain('reporter-evaluator-sidecars-partial');
        expect(result.observation.processTrace.events.length).toBeGreaterThan(0);
        expect(result.observation.orderedChainQualified).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  it('bounds evaluator reference occurrences without dropping the authenticated prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-evaluator-limit-'));
    try {
      const { out, input } = nativeReporterObservation(root);
      const { pin, observation } = evaluatorObservation(out);
      observation.entries = Array.from({ length: 4097 }, () => pin);
      observation.vmInputs = [];
      const payload = JSON.parse(readFileSync(out, 'utf8'));
      payload.rows = [{ moduleEvaluations: observation }];
      writeFileSync(out, JSON.stringify(payload));
      const archive = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input)
        .observation.processTrace.reporter.evaluatorArtifacts!;
      expect(archive).toMatchObject({ status: 'partial', referencesVisited: 4096,
        bytesRetained: pin.byteLength, gaps: ['evaluator-reference-limit'] });
      expect(archive.entries).toHaveLength(4096);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('bounds unique evaluator artifact bytes independently of reference count', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-evaluator-byte-limit-'));
    try {
      const { out, input } = nativeReporterObservation(root);
      const pins = Array.from({ length: 5 }, (_, i) => evaluatorObservation(out,
        i === 4 ? 'x' : String(i).repeat(16 * 1024 * 1024)).pin);
      const { observation } = evaluatorObservation(out);
      observation.entries = pins; observation.vmInputs = [];
      const payload = JSON.parse(readFileSync(out, 'utf8'));
      payload.rows = [{ moduleEvaluations: observation }];
      writeFileSync(out, JSON.stringify(payload));
      const archive = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input)
        .observation.processTrace.reporter.evaluatorArtifacts!;
      expect(archive).toMatchObject({ status: 'partial', referencesVisited: 5,
        bytesRetained: 64 * 1024 * 1024, gaps: ['evaluator-sidecar-rejected:total-byte-limit'] });
      expect(archive.entries).toHaveLength(4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('charges rejected evaluator bytes to the total read budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-evaluator-rejected-limit-'));
    try {
      const { out, input } = nativeReporterObservation(root);
      const bad = evaluatorObservation(out, '1'.repeat(16 * 1024 * 1024));
      writeFileSync(bad.pin.codeRef, '2'.repeat(bad.pin.byteLength));
      const good = evaluatorObservation(out);
      const payload = JSON.parse(readFileSync(out, 'utf8'));
      payload.rows = [{ moduleEvaluations: { ...bad.observation,
        entries: [...Array.from({ length: 4 }, () => bad.pin), good.pin], vmInputs: [] } }];
      writeFileSync(out, JSON.stringify(payload));
      const archive = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input)
        .observation.processTrace.reporter.evaluatorArtifacts!;
      expect(archive.entries).toHaveLength(0);
      expect(archive).toMatchObject({ status: 'partial', referencesVisited: 5,
        bytesRead: 64 * 1024 * 1024, bytesRetained: 0 });
      expect(archive.gaps).toEqual(['evaluator-sidecar-rejected:digest-mismatch',
        'evaluator-sidecar-rejected:total-byte-limit']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['missing', 'malformed', 'redirected', 'oversized', 'unrelated-pid', 'wrong-parent',
    'stale', 'future', 'ambiguous', 'after-process-exit', 'wrong-schema'] as const)('leaves native reporter %s unbound without losing good process evidence', fault => {
    const root = mkdtempSync(join(tmpdir(), 'native-reporter-unbound-'));
    try {
      const { out, input } = nativeReporterObservation(root);
      const payload = JSON.parse(readFileSync(out, 'utf8'));
      if (fault === 'missing') rmSync(out);
      else if (fault === 'malformed') writeFileSync(out, '{');
      else if (fault === 'redirected') {
        const target = join(root, 'redirected.json');
        writeFileSync(target, readFileSync(out)); rmSync(out); symlinkSync(target, out);
      } else if (fault === 'oversized') writeFileSync(out, Buffer.alloc(16 * 1024 * 1024 + 1));
      else if (fault === 'ambiguous') {
        const events = join(`${out}.native-processes`);
        const entry = readdirSync(events).filter(name => name.endsWith('.json'))
          .map(name => JSON.parse(readFileSync(join(events, name), 'utf8')))
          .find(row => row.event === 'node-entry');
        const bytes = Buffer.from(JSON.stringify({ ...entry, processIdentity: 'another-observed-identity' }));
        writeFileSync(join(events, `${createHash('sha256').update(bytes).digest('hex')}.json`), bytes);
      } else {
        if (fault === 'unrelated-pid') payload.nativeRun.pid += 1000000;
        if (fault === 'wrong-parent') payload.nativeRun.ppid += 1000000;
        if (fault === 'stale') payload.nativeRun.startedAtMs = input.startedAtMs - 1;
        if (fault === 'future') payload.nativeRun.finishedAtMs = input.finishedAtMs + 1;
        if (fault === 'after-process-exit') payload.nativeRun.finishedAtMs = (input.finishedAtMs += 100);
        if (fault === 'wrong-schema') payload.nativeRun.schemaVersion = 'other-protocol';
        writeFileSync(out, JSON.stringify(payload));
      }
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), input);
      expect(result.observation.processTrace.events.length).toBeGreaterThan(0);
      expect(result.observation.processTrace.streams).toHaveLength(2);
      expect(result.observation.processTrace.reporter).toMatchObject({ status: 'unknown', artifact: null, process: null });
      expect(result.observation.processTrace.reporter.gaps.some(gap => gap.startsWith('native-vitest-out-unbound:'))).toBe(true);
      expect(result.observation.orderedChainQualified).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  function nativeObservation() {
    const command = [process.execPath, '-e',
      'process.stdout.write(Buffer.from([0,255,10])); process.stderr.write(Buffer.from([254,13,10]));'];
    const startedAtMs = Date.now();
    const child = spawnSync(command[0]!, command.slice(1), { cwd: REPO_ROOT, timeout: 10_000 });
    if (child.error) throw child.error;
    const inputs = [{ path: 'package.json', sha256: createHash('sha256')
      .update(readFileSync(join(REPO_ROOT, 'package.json'))).digest('hex') }];
    return { task: 'native-fixture :: test', attempt: 'initial', cwd: REPO_ROOT, command,
      originalCommand: 'native fixture', startedAtMs, finishedAtMs: Date.now(),
      exitCode: child.status, signal: child.signal, error: null, captureComplete: true,
      stdout: child.stdout, stderr: child.stderr, before: inputs, after: structuredClone(inputs) };
  }
  it.each(['valid', 'missing', 'symlink', 'corrupt', 'malformed', 'unavailable', 'oversized', 'budget'])
  ('archives bounded loader-source references without erasing process evidence: %s', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'native-loader-source-'));
    try {
      const out = join(root, 'out.json'), sourceRoot = `${out}.native-processes`;
      mkdirSync(sourceRoot);
      const publish = (bytes: Buffer, suffix: string) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const ref = `${sha256}.${suffix}`;
        writeFileSync(join(sourceRoot, ref), bytes);
        return { ref, sha256, byteLength: bytes.length };
      };
      const bytes = Buffer.alloc(scenario === 'budget' ? 16 * 1024 * 1024 : 20, 65);
      const source = { ...publish(bytes, 'source'), status: 'hashed', scope: 'node-loader-returned-source',
        artifactUnavailable: false };
      const file = join(sourceRoot, source.ref);
      if (scenario === 'missing') rmSync(file);
      if (scenario === 'symlink') {
        rmSync(file);
        const other = join(root, 'other'); writeFileSync(other, bytes); symlinkSync(other, file);
      }
      if (scenario === 'corrupt' || scenario === 'budget') writeFileSync(file, Buffer.alloc(bytes.length, 66));
      if (scenario === 'malformed') source.ref = '../outside.source';
      if (scenario === 'unavailable') source.artifactUnavailable = true;
      if (scenario === 'oversized') source.byteLength = 16 * 1024 * 1024 + 1;
      const stream = { ...publish(Buffer.alloc(0), 'stream'), scope: 'node-writable-call-inputs',
        observedByteLength: 0, captureComplete: true };
      const event = (event: string, atMs: number, fields = {}) => publish(Buffer.from(JSON.stringify({
        schemaVersion: 1, kind: 'native-node-process-event', event, atMs, processIdentity: 'loader-fixture',
        pid: 901, ppid: 1, ...fields,
      })), 'json');
      event('node-entry', 100);
      const loads = scenario === 'budget' ? 5 : 2;
      for (let i = 0; i < loads; i++) event('module-load-return', 101 + i,
        { loadId: i + 1, url: 'file:///native-fixture.mjs', source });
      event('node-exit', 110, { exitListenersComplete: true, streams: { stdout: stream, stderr: stream } });
      const result = writeBudgetedTaskNativeExecutionReceipt(join(root, 'retained'), {
        ...nativeObservation(), startedAtMs: 100, finishedAtMs: 110, processTrace: { out, rootPid: 901 },
      });
      const trace = result.observation.processTrace, archive = trace.loaderSources!;
      expect(trace.events).toHaveLength(loads + 2);
      expect(trace.streams).toHaveLength(2);
      expect(archive.referencesVisited).toBe(loads);
      if (scenario === 'valid') {
        expect(archive).toMatchObject({ status: 'retained', bytesRead: bytes.length, bytesRetained: bytes.length, gaps: [] });
        expect(archive.entries).toHaveLength(2);
        expect(archive.entries.map(row => row.loadId)).toEqual([1, 2]);
        expect(readFileSync(join(result.root, archive.entries[0]!.artifact.ref)).equals(bytes)).toBe(true);
        expect(archive.entries[0]!.artifact).toEqual(archive.entries[1]!.artifact);
      } else {
        expect(archive.status).toBe('partial');
        expect(archive.entries).toHaveLength(0);
        expect(archive.gaps.length).toBeGreaterThan(0);
        expect(archive.bytesRead).toBe(scenario === 'budget' ? 64 * 1024 * 1024 : scenario === 'corrupt' ? loads * bytes.length : 0);
        if (scenario === 'budget') expect(archive.gaps).toContain('native-loader-source-rejected:total-byte-limit');
      }
      expect(result.observation.runtimeClosure).toBe('unmeasured');
      expect(result.observation.orderedChainQualified).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains the actual command and binary streams in immutable independently hashed artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-task-receipt-'));
    try {
      const input = nativeObservation(), result = writeBudgetedTaskNativeExecutionReceipt(root, input);
      expect(input.exitCode).toBe(0);
      const original = JSON.parse(readFileSync(join(result.root, result.receipt.ref), 'utf8'));
      expect(original.execution).toMatchObject({ command: input.command, cwd: REPO_ROOT, exitCode: 0,
        captureComplete: true, startedAtMs: input.startedAtMs, finishedAtMs: input.finishedAtMs });
      for (const role of ['stdout', 'stderr'] as const) {
        const bytes = readFileSync(join(result.root, result.logs[role].ref));
        expect(bytes).toEqual(input[role]);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.logs[role].sha256);
        expect(bytes.length).toBe(result.logs[role].byteLength);
      }
      expect(original.sourceInputsUnchanged).toBe(true);
      expect(original.orderedChainQualified).toBe(false);
      expect(original.steps).toEqual([]);
      expect(original.gaps).toContain('original-step-boundaries-unobserved');
      expect(original.runtimeClosure).toBe('unmeasured');
      expect(original.operationalAcceptance).toBe(false);
      // Rewriting the exact observation is idempotent; input mutation cannot alter its stored proof.
      expect(writeBudgetedTaskNativeExecutionReceipt(root, input).receipt).toEqual(result.receipt);
      input.command[0] = 'substituted';
      expect(original.execution.command[0]).toBe(process.execPath);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves partial capture, native errors and unknown or drifted wrapper inputs as gaps', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-task-gaps-'));
    try {
      const input = nativeObservation();
      input.after[0]!.sha256 = '0'.repeat(64);
      const changed = writeBudgetedTaskNativeExecutionReceipt(root, input).observation;
      expect(changed.sourceInputsUnchanged).toBe(false);
      expect(changed.gaps).toContain('wrapper-inputs-unknown-or-changed');
      const partial = writeBudgetedTaskNativeExecutionReceipt(root, { ...input, before: null,
        captureComplete: false, exitCode: null, signal: 'SIGTERM', error: 'capture interrupted' }).observation;
      expect(partial.execution).toMatchObject({ exitCode: null, signal: 'SIGTERM', error: 'capture interrupted' });
      expect(partial.gaps).toContain('raw-stream-capture-incomplete');
      expect(partial.sourceInputsUnchanged).toBe(false);
      expect(partial.operationalAcceptance).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('refuses overwritten and symlinked sidecars without replacing their bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-task-refusal-'));
    try {
      const input = nativeObservation(), first = writeBudgetedTaskNativeExecutionReceipt(root, input);
      const path = join(root, first.logs.stdout.ref);
      writeFileSync(path, 'overwritten');
      expect(() => writeBudgetedTaskNativeExecutionReceipt(root, input)).toThrow('artifact bytes differ');
      expect(readFileSync(path, 'utf8')).toBe('overwritten');
      rmSync(path); symlinkSync(join(root, first.logs.stderr.ref), path);
      expect(() => writeBudgetedTaskNativeExecutionReceipt(root, input)).toThrow('redirected');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    ['stream', 'growth'], ['event', 'growth'], ['persist', 'growth'],
    ['stream', 'symlink'], ['event', 'symlink'], ['persist', 'symlink'],
    ['stream', 'replacement'], ['event', 'replacement'], ['persist', 'replacement'],
  ] as const)('bounds native artifact IO and rejects a %s %s race', (role, fault) => {
    const root = mkdtempSync(join(tmpdir(), 'native-artifact-race-'));
    try {
      const out = join(root, 'out.json'), source = `${out}.native-processes`;
      const retained = join(root, 'retained');
      mkdirSync(source); mkdirSync(retained);
      const publish = (bytes: Buffer, suffix: string) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const ref = `${sha256}.${suffix}`;
        writeFileSync(join(source, ref), bytes);
        return { ref, sha256, byteLength: bytes.length };
      };
      const stream = { ...publish(Buffer.from('native bytes'), 'stream'),
        scope: 'node-writable-call-inputs', observedByteLength: 12, captureComplete: true };
      const empty = { ...publish(Buffer.alloc(0), 'stream'),
        scope: 'node-writable-call-inputs', observedByteLength: 0, captureComplete: true };
      const entry = publish(Buffer.from(JSON.stringify({ schemaVersion: 1,
        kind: 'native-node-process-event', event: 'node-entry', pid: 901, ppid: 1,
        processIdentity: 'race-fixture', atMs: 100 })), 'json');
      publish(Buffer.from(JSON.stringify({ schemaVersion: 1,
        kind: 'native-node-process-event', event: 'node-exit', pid: 901, ppid: 1,
        processIdentity: 'race-fixture', atMs: 110, exitListenersComplete: true,
        streams: { stdout: stream, stderr: empty } })), 'json');
      const stdout = Buffer.from('aggregate bytes');
      const target = role === 'stream' ? join(source, stream.ref) : role === 'event' ?
        join(source, entry.ref) : join(retained,
          `${createHash('sha256').update(stdout).digest('hex')}.stdout`);
      const expected = role === 'stream' ? stream.byteLength : role === 'event' ? entry.byteLength : stdout.length;
      let injected = false, bytesRead = 0;
      const fds = new Map<number, string>();
      const inject = () => {
        if (injected) return;
        injected = true;
        if (fault === 'growth') appendFileSync(target, Buffer.alloc(2 * 1024 * 1024));
        else {
          const bytes = readFileSync(target), replacement = join(root, 'replacement');
          writeFileSync(replacement, bytes);
          rmSync(target);
          if (fault === 'symlink') symlinkSync(replacement, target);
          else fs.renameSync(replacement, target);
        }
      };
      // Execute the production writer with real file descriptors and only the
      // race boundary injected; the pathname reader is measured on old source too.
      const start = SCHEDULER_SRC.indexOf('const comparisonHash =');
      const end = SCHEDULER_SRC.indexOf('export function prepareBudgetedTaskComparison');
      const writer = new Script(`(() => {${SCHEDULER_SRC.slice(start, end)
        .replaceAll('export function ', 'function ')}\nreturn writeBudgetedTaskNativeExecutionReceipt;})()`)
        .runInNewContext({ ...fs, Buffer, createHash, basename, dirname, isAbsolute, join,
          relative, resolve, structuredClone,
          openSync: (file: string, flags: number) => {
            if (file === target && fault === 'symlink') inject();
            const fd = fs.openSync(file, flags); fds.set(fd, file); return fd;
          },
          closeSync: (fd: number) => { fds.delete(fd); return fs.closeSync(fd); },
          readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
            if (fds.get(fd) === target) inject();
            const count = fs.readSync(fd, buffer, offset, length, position);
            if (fds.get(fd) === target) bytesRead += count;
            return count;
          },
          readFileSync: (file: string) => {
            if (file === target) inject();
            const bytes = fs.readFileSync(file);
            if (file === target) bytesRead += bytes.length;
            return bytes;
          },
        }) as typeof writeBudgetedTaskNativeExecutionReceipt;
      const input = { task: 'race-fixture', attempt: 'initial', cwd: REPO_ROOT,
        command: ['node', 'fixture'], startedAtMs: 100, finishedAtMs: 110,
        exitCode: 0, signal: null, error: null, captureComplete: true,
        stdout, stderr: Buffer.alloc(0), processTrace: { out, rootPid: 901 } };
      if (role === 'persist') expect(() => writer(retained, input)).toThrow('artifact bytes differ');
      else {
        const trace = writer(retained, input).observation.processTrace;
        expect(trace.events).toHaveLength(0);
        expect(trace.streams).toHaveLength(0);
        expect(trace.gaps.some(gap => gap.startsWith('native-process-trace-unreadable:'))).toBe(true);
      }
      expect(injected).toBe(true);
      expect(bytesRead).toBeLessThanOrEqual(expected + 1);
      expect(fds.size).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])('executes the production OUT observation and settled journal with native binary output, qualification %s', qualification => {
    const root = mkdtempSync(join(tmpdir(), 'native-production-journal-'));
    try {
      const input = nativeObservation();
      const task = { ws: { name: 'native-fixture', dir: 'packages/operator-core', scripts: { test: 'native fixture' } }, script: 'test' };
      const observationStart = AFFECTED_TESTS_SRC.indexOf('const qualificationCapture =');
      const observationEnd = AFFECTED_TESTS_SRC.indexOf('const stdout = [];', observationStart);
      expect(observationStart).toBeGreaterThan(0); expect(observationEnd).toBeGreaterThan(observationStart);
      const observe = (out: string | null, integrationOut: string | null = null,
        qualificationOut: string | null = null) => new Script(
        `${AFFECTED_TESTS_SRC.slice(observationStart, observationEnd)}\nnativeObservation;`,
      ).runInNewContext({ inheritedExecutedMapOut: out, integrationSourceMapOut: integrationOut,
        qualificationNativeOut: qualificationOut, qualificationTaskOut: qualification ? 'task.json' : null,
        qualificationPhysicalExecution: { fingerprint: 'a'.repeat(64) },
        process: { env: { PAPERCUSP_TEST_RUN_GROUP: 'run' } }, governedEnv: {},
        partialTaskCommandInputs: () => [{ path: 'package.json', sha256: 'a'.repeat(64) }],
        partialSourceIdentity: () => ({ sourceCommit: 'candidate', sourceDigest: createHash('sha256').update('').digest('hex') }),
        ROOT: REPO_ROOT, spawnTask: task, spawnTaskKey: input.task, journalLabel: input.attempt,
        startedAt: input.startedAtMs, cwd: input.cwd, cmd: input.command[0], argv: input.command.slice(1),
        relative: (a: string, b: string) => resolve(b).slice(resolve(a).length + 1),
        join, readFileSync, createHash, Date, Set });
      if (!qualification) expect(observe(null)(0, null, null, input.stdout, input.stderr)).toBeNull();
      for (const [inheritedOut, integrationOut, qualificationOut, expectedOut] of [
        ['inherited.json', null, null, 'inherited.json'],
        [null, 'integration.json', null, 'integration.json'],
        [null, null, 'qualification.json', 'qualification.json'],
        ['inherited.json', 'integration.json', null, 'integration.json'],
        ['inherited.json', 'integration.json', 'qualification.json', 'qualification.json'],
      ] as const) {
        const captured = observe(inheritedOut, integrationOut, qualificationOut)(
          0, null, null, input.stdout, input.stderr, 321,
        );
        expect(captured.processTrace).toEqual({ out: qualification ? qualificationOut ?? 'task.json' : expectedOut, rootPid: 321 });
      }
      const observation = observe('requested.json')(0, null, null, input.stdout, input.stderr);
      expect(observation.command).toEqual(input.command);
      expect(observation.before).toHaveLength(qualification ? 1 : 2);
      expect(observation.before).toEqual(observation.after);
      const journalStart = AFFECTED_TESTS_SRC.indexOf('function journalCapturedTaskOutput(');
      const journalEnd = AFFECTED_TESTS_SRC.indexOf('\n}\n\nfunction emitCapturedTaskOutput(', journalStart) + 2;
      const log = join(root, 'run.log'), errors: string[] = [], announcements: string[] = [], synced: string[] = [];
      const journal = new Script(`(${AFFECTED_TESTS_SRC.slice(journalStart, journalEnd)})`).runInNewContext({
        taskKey: () => input.task, RUN_LOG_PATH: log, writeBudgetedTaskNativeExecutionReceipt,
        qualificationPhysicalExecution: { evidenceRoot: join(root, 'qualification') },
        syncBudgetedTaskNativeExecutionReceipt: (saved: ReturnType<typeof writeBudgetedTaskNativeExecutionReceipt>) => {
          syncBudgetedTaskNativeExecutionReceipt(saved); synced.push(saved.receipt.ref);
        },
        outSync: (line: string) => { expect(synced).toHaveLength(1); announcements.push(line); },
        appendAllSync: (path: string, chunks: string[]) => appendFileSync(path, chunks.join('')),
        rawErrSync: (text: string) => errors.push(text),
        formatTaskOutcomeFields: () => ({ exitStatus: 0, signal: 'none' }),
      });
      const result = { status: 0, signal: null, error: null, stdout: input.stdout.toString(),
        stderr: input.stderr.toString(), __nativeExecution: observation };
      expect(journal(task, result, { lane: 'primary', workers: 1, memoryMb: 1 }, 'initial')).toBe(true);
      const output = readFileSync(log, 'utf8');
      const marker = JSON.parse(output.split('\n').find(line => line.startsWith('AFFECTED_TASK_NATIVE_RECEIPT='))!
        .slice('AFFECTED_TASK_NATIVE_RECEIPT='.length));
      const receipt = JSON.parse(readFileSync(join(marker.root, marker.receipt.ref), 'utf8'));
      expect(receipt.execution.command).toEqual(input.command);
      expect(readFileSync(join(marker.root, receipt.execution.logs.stdout.ref))).toEqual(input.stdout);
      expect(marker.orderedChainQualified).toBe(false);
      expect(announcements).toHaveLength(qualification ? 1 : 0);
      if (qualification) expect(JSON.parse(announcements[0]!.slice('QUALIFICATION_TASK_COMPLETION='.length)))
        .toEqual({ task: input.task, root: marker.root, receipt: marker.receipt });
      expect(errors).toEqual([]);
      // Artifact failure is a diagnostic miss; the ordinary settled journal must still survive.
      writeFileSync(join(marker.root, receipt.execution.logs.stdout.ref), 'tampered');
      expect(journal(task, result, { lane: 'primary', workers: 1, memoryMb: 1 }, 'initial')).toBe(true);
      expect(errors[0]).toContain('AFFECTED_TASK_NATIVE_RECEIPT_FAILED');
      expect(readFileSync(log, 'utf8').match(/AFFECTED_TASK_OUTPUT_END/g)).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('R12 immutable full-gate comparison preparation', () => {
  const hash = 'a'.repeat(64);
  function input() {
    const policy = { workerBudget: 8, memoryBudgetMb: 32768, workerMemoryMb: 4096,
      maxConcurrentTasks: 2, reserveWorkers: 1, taskCgroupPidsMax: 32768 };
    return { selection: { kind: 'full-gate' as const, coverage: 'complete' as const,
      unenumerated: [] as string[], originalRef: 'fixture:full-selection', originalSha256: hash,
      files: ['long.test.ts', 'short.test.ts'] },
    source: { commit: 'b'.repeat(40), receiptSha256: hash, dependencySha256: hash,
      runtimeClosureSha256: hash, files: ['long.test.ts', 'short.test.ts'].map(path => ({ path, sha256: hash })) },
    tasks: [{ id: 'long', files: ['long.test.ts'] }, { id: 'short', files: ['short.test.ts'] }],
    baseline: policy, candidate: { ...policy, maxConcurrentTasks: 4 },
    envelope: { hardMemoryMb: 45056, pidsMax: 32768, heapMb: 4096 },
    estimates: [{ task: 'long', ms: 100, originalRef: 'fixture:long-wall', originalSha256: hash },
      { task: 'short', ms: 20, originalRef: 'fixture:short-wall', originalSha256: hash }] };
  }
  function pair() {
    const manifest = prepareBudgetedTaskComparison(input());
    const cohorts = manifest.order.map((key, index) => {
      const [side, repeat] = key.split(':');
      const executionWallMs = side === 'baseline' ? 100 : 50;
      return { side: side as 'baseline' | 'candidate', repeat: Number(repeat), runId: `fixture:run-${index}`,
        originalRef: `fixture:cohort-${index}`, originalSha256: hash, manifestSha256: manifest.manifestSha256,
        sourceUnchanged: true, sourceReceiptSha256: hash, dependencySha256: hash, runtimeClosureSha256: hash,
        policy: side === 'baseline' ? manifest.baseline : manifest.candidate, envelope: manifest.envelope,
        wallMs: executionWallMs + 30, acquiredWaitsMs: [10, 20], executionWallMs,
        memory: { pairedSamples: 3, maxAnonPerAllocatedWorkerMb: 300, oomKills: 0 },
        stats: { memoryReadings: 2, lastMemAvailableMb: 40000, observedMaxWorkers: 8,
          observedMaxTasks: side === 'baseline' ? 1 : 2, observedMaxMemoryMb: 32768 },
        children: manifest.tasks.map(task => ({ task: task.id, lane: 'primary' as const, files: [...task.files],
          code: 0, signal: null, childWallMs: 20,
          resultLine: 'TEST_FILE_RESULT status=passed requested=1 executed=1 matched=1 skippedTests=0 childSubstituted=0',
          originalRef: `fixture:child-${index}-${task.id}`, originalSha256: hash, expectedCgroup: '/fixture',
          runGroup: `fixture:group-${index}-${task.id}`, deadlineEpochMs: 1000,
          cgroupObservations: [{ pid: 123, cgroupPath: '/fixture', runGroup: `fixture:group-${index}-${task.id}`,
            deadlineEpochMs: 1000, vitestFork: true, phase: 'preload' }] })) };
    });
    return { manifest, cohorts };
  }
  it('detaches and deeply freezes the full selection, source, partition and ABBA order', () => {
    const original = input(); const manifest = prepareBudgetedTaskComparison(original);
    original.selection.files.pop(); original.source.files[0]!.sha256 = 'c'.repeat(64);
    expect(manifest.selection.files).toHaveLength(2);
    expect(manifest.source.files[0]!.sha256).toBe(hash);
    expect(Object.isFrozen(manifest.tasks[0]!.files)).toBe(true);
    expect(manifest.order).toEqual(['baseline:1', 'candidate:1', 'candidate:2', 'baseline:2']);
  });
  it.each(['partial', 'unknown-runtime', 'missing-file', 'duplicate-task', 'heap-change', 'unknown-estimate'])
  ('refuses %s inputs before any cohort is admitted', defect => {
    const data = input();
    if (defect === 'partial') data.selection.unenumerated.push('wide workspace');
    if (defect === 'unknown-runtime') data.source.runtimeClosureSha256 = 'unknown';
    if (defect === 'missing-file') data.tasks.pop();
    if (defect === 'duplicate-task') data.tasks[1]!.files = [...data.tasks[0]!.files];
    if (defect === 'heap-change') data.candidate.workerMemoryMb = 2048;
    if (defect === 'unknown-estimate') data.estimates[0]!.ms = NaN;
    expect(() => prepareBudgetedTaskComparison(data)).toThrow('COMPARISON_INPUT_REFUSAL');
  });
  it('qualifies exactly half the execution wall and excludes every acquired queue wait', () => {
    const { manifest, cohorts } = pair(); const result = evaluateBudgetedTaskComparison(manifest, cohorts);
    expect(result.assertions.every(row => row.passed)).toBe(true);
    expect(result).toMatchObject({ ratio: 0.5, baselineWallMs: 200, candidateWallMs: 100, operationalAcceptance: false });
  });
  it('refuses original command obligations even when a caller claims a complete test-file partition', () => {
    for (const placement of ['selection', 'original-task', 'task', 'original-lifecycle', 'lifecycle']) {
      const data = input();
      const commandObligations = [{ command: 'node guard.mjs', executed: false }];
      if (placement === 'selection') Object.assign(data.selection, { commandObligations });
      if (placement === 'original-task') Object.assign(data.selection, { tasks: [{ commandObligations }] });
      if (placement === 'task') Object.assign(data.tasks[0]!, { commandObligations });
      if (placement === 'original-lifecycle') Object.assign(data.selection, { tasks: [{ lifecycleCommands: commandObligations }] });
      if (placement === 'lifecycle') Object.assign(data.tasks[0]!, { lifecycleCommands: commandObligations });
      expect(() => prepareBudgetedTaskComparison(data)).toThrow('native original command-obligation receipts required');
    }
  });
  it('pins the original one-to-one occurrence population and refuses check inputs or collapsed repeats', () => {
    const data = input();
    const fileOccurrences = data.tasks.flatMap(task => task.files.map(file => ({ task: task.id,
      step: null, command: 'vitest run', file, kind: 'test-file' as const })));
    const manifest = prepareBudgetedTaskComparison({ ...data, selection: { ...data.selection, fileOccurrences } });
    expect(manifest.selection.fileOccurrences).toEqual(fileOccurrences);
    expect(Object.isFrozen(manifest.selection.fileOccurrences)).toBe(true);
    for (const bad of [[...fileOccurrences, fileOccurrences[0]!],
      [{ ...fileOccurrences[0]!, kind: 'check-input' as const }, fileOccurrences[1]!],
      [{ ...fileOccurrences[0]!, task: 'not-original' }, fileOccurrences[1]!],
      [fileOccurrences[0]!]]) {
      expect(() => prepareBudgetedTaskComparison({ ...data, selection: { ...data.selection, fileOccurrences: bad } }))
        .toThrow('native original command-step occurrence receipts required');
    }
  });
  it.each(['missing-repeat', 'duplicate-run', 'drift', 'skip', 'substitution', 'escape', 'oom',
    'unpaired', 'headroom', 'order', 'queue', 'slow', 'tampered-manifest'])
  ('fails closed on %s, with no operational acceptance from fixtures', defect => {
    const { manifest, cohorts } = pair(); const row = cohorts[1]!;
    if (defect === 'missing-repeat') cohorts.pop();
    if (defect === 'duplicate-run') row.runId = cohorts[0]!.runId;
    if (defect === 'drift') row.sourceUnchanged = false;
    if (defect === 'skip') row.children[0]!.resultLine = row.children[0]!.resultLine.replace('skippedTests=0', 'skippedTests=1');
    if (defect === 'substitution') row.children[0]!.resultLine = row.children[0]!.resultLine.replace('childSubstituted=0', 'childSubstituted=1');
    if (defect === 'escape') row.children[0]!.cgroupObservations[0]!.cgroupPath = '/elsewhere';
    if (defect === 'oom') row.memory.oomKills = 1;
    if (defect === 'unpaired') row.memory.pairedSamples = 0;
    if (defect === 'headroom') row.stats.memoryReadings = 0;
    if (defect === 'order') row.children.reverse();
    if (defect === 'queue') row.acquiredWaitsMs = [row.wallMs];
    if (defect === 'slow') { row.wallMs++; row.executionWallMs++; }
    const subject = defect === 'tampered-manifest' ? { ...manifest, manifestSha256: 'c'.repeat(64) } : manifest;
    expect(evaluateBudgetedTaskComparison(subject, cohorts).assertions.some(assertion => !assertion.passed)).toBe(true);
    expect(evaluateBudgetedTaskComparison(subject, cohorts).operationalAcceptance).toBe(false);
  });
  it('rejects malformed external rows rather than throwing or accepting missing data', () => {
    const { manifest } = pair();
    expect(evaluateBudgetedTaskComparison(manifest, [null] as never).assertions.every(a => !a.passed)).toBe(true);
  });
  it('retains each repeat so an aggregate half-time cannot hide a slow candidate', () => {
    const { manifest, cohorts } = pair();
    cohorts[1]!.wallMs += 10; cohorts[1]!.executionWallMs += 10;
    cohorts[2]!.wallMs -= 10; cohorts[2]!.executionWallMs -= 10;
    const result = evaluateBudgetedTaskComparison(manifest, cohorts);
    expect(result.ratio).toBe(0.5);
    expect(result.assertions.at(-1)!.passed).toBe(false);
  });
  it('resolves complete original artifact chains and rejects later byte drift', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r12-original-artifacts-'));
    const pin = (ref: string, value: unknown, raw = false) => {
      const bytes = raw ? String(value) : JSON.stringify(value);
      writeFileSync(join(root, ref), bytes);
      return { ref, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    try {
      const data = input();
      const selection = pin('selection.json', { kind: 'full-gate', coverage: 'complete', unenumerated: [], files: data.selection.files });
      data.selection.originalRef = selection.ref; data.selection.originalSha256 = selection.sha256;
      const source = pin('source.json', { schemaVersion: 'verifier-source-v1', sourceCommit: data.source.commit, files: data.source.files });
      const dependencies = pin('dependencies.txt', 'fixture independent dependency bytes', true);
      const runtimeClosure = pin('closure.json', { status: 'complete', sourceCommit: data.source.commit, files: data.selection.files });
      data.source.receiptSha256 = source.sha256; data.source.dependencySha256 = dependencies.sha256;
      data.source.runtimeClosureSha256 = runtimeClosure.sha256;
      data.estimates = data.estimates.map(estimate => {
        const original = pin(`${estimate.task}-wall.json`, { task: estimate.task, childWallMs: estimate.ms });
        return { ...estimate, originalRef: original.ref, originalSha256: original.sha256 };
      });
      const manifest = prepareBudgetedTaskComparison(data);
      const rows = pair().cohorts.map((row, index) => ({ ...row, manifestSha256: manifest.manifestSha256,
        sourceReceiptSha256: source.sha256, dependencySha256: dependencies.sha256, runtimeClosureSha256: runtimeClosure.sha256,
        children: row.children.map(child => {
          const { originalRef, originalSha256, ...fields } = child;
          void originalRef; void originalSha256;
          const original = pin(`child-${index}-${child.task}.json`, fields);
          return { ...fields, originalRef: original.ref, originalSha256: original.sha256 };
        }) }));
      const pins = { manifest: pin('manifest.json', manifest), source, dependencies, runtimeClosure,
        cohorts: rows.map((row, index) => pin(`cohort-${index}.json`, row)) };
      const original = await readBudgetedTaskComparisonArtifacts(root, pins);
      expect(original.originalArtifactsResolved).toBe(true);
      expect(evaluateBudgetedTaskComparison(original.manifest, original.cohorts).ratio).toBe(0.5);
      const occurrences = data.tasks.flatMap(task => task.files.map(file => ({ task: task.id,
        step: null, command: 'vitest run', file, kind: 'test-file' })));
      const occurrenceSelection = pin('selection.json', { kind: 'full-gate', coverage: 'complete', unenumerated: [],
        files: data.selection.files, fileOccurrences: occurrences });
      data.selection.originalSha256 = occurrenceSelection.sha256;
      await expect(readBudgetedTaskComparisonArtifacts(root, { ...pins,
        manifest: pin('occurrence-omission-manifest.json', prepareBudgetedTaskComparison(data)) }))
        .rejects.toThrow('Original command-step file occurrences were omitted or changed');
      for (const secondFile of ['long.test.ts', 'short.test.ts']) {
        const legacySelection = pin('selection.json', { kind: 'full-gate', coverage: 'complete', unenumerated: [],
          files: data.selection.files, tasks: [{ steps: [{ files: ['long.test.ts'] }, { files: [secondFile] }] }] });
        data.selection.originalSha256 = legacySelection.sha256;
        await expect(readBudgetedTaskComparisonArtifacts(root, { ...pins,
          manifest: pin('legacy-step-manifest.json', prepareBudgetedTaskComparison(data)) }))
          .rejects.toThrow('Original ordered command-step population requires native step receipts');
      }
      const obligationSelection = pin('selection.json', { kind: 'full-gate', coverage: 'complete', unenumerated: [],
        files: data.selection.files, commandObligations: [{ command: 'node guard.mjs', executed: false }] });
      data.selection.originalSha256 = obligationSelection.sha256;
      const omissionManifest = prepareBudgetedTaskComparison(data);
      await expect(readBudgetedTaskComparisonArtifacts(root, { ...pins,
        manifest: pin('omission-manifest.json', omissionManifest) }))
        .rejects.toThrow('Original command obligations were omitted');
      const lifecycleSelection = pin('selection.json', { kind: 'full-gate', coverage: 'complete', unenumerated: [],
        files: data.selection.files, tasks: [{ lifecycleCommands: [{ script: 'pretest', command: 'node build.mjs' }] }] });
      data.selection.originalSha256 = lifecycleSelection.sha256;
      await expect(readBudgetedTaskComparisonArtifacts(root, { ...pins,
        manifest: pin('lifecycle-manifest.json', prepareBudgetedTaskComparison(data)) }))
        .rejects.toThrow('Original command obligations were omitted');
      pin('selection.json', { kind: 'full-gate', coverage: 'complete', unenumerated: [], files: data.selection.files });
      writeFileSync(join(root, 'child-1-long.json'), '{}');
      await expect(readBudgetedTaskComparisonArtifacts(root, pins)).rejects.toThrow('hash mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('R12 native command-local artifact preparation', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'r12-native-command-'));
    const repositoryRoot = join(root, 'repo');
    mkdirSync(join(repositoryRoot, 'desktop/bin/lib'), { recursive: true });
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const pin = (ref: string, value: unknown, raw = false) => {
      const bytes = raw ? String(value) : JSON.stringify(value);
      writeFileSync(join(root, ref), bytes);
      return { ref, sha256: digest(bytes) };
    };
    const listed = ['b.selftest.sh', 'a.selftest.sh'];
    const files = listed.map(script => `desktop/bin/lib/${script}`);
    const inputs = [...files, 'desktop/bin/lib/run-selftests.sh', 'desktop/bin/lib/baseline.txt']
      .sort().map(path => {
        writeFileSync(join(repositoryRoot, path), path);
        return { path, sha256: digest(path) };
      });
    const command = 'bash bin/lib/run-selftests.sh';
    const obligation = { task: 'desktop :: test', step: 7, kind: 'command-check',
      check: 'desktop-selftest-aggregate', command, inputs, executed: false };
    const fileOccurrences = files.slice().sort().map(file => ({ task: obligation.task,
      step: 7, command, file, kind: 'test-file' }));
    const selection = { schemaVersion: 1, kind: 'full-gate', coverage: 'partial',
      unenumerated: ['remaining native chain'], fileOccurrences,
      commandObligations: [obligation], tasks: [{ id: obligation.task, dir: 'desktop',
        steps: [...Array.from({ length: 7 }, () => ({ command: 'other native command' })), { command }] }] };
    const before = { schemaVersion: 1, kind: 'command-check-inputs',
      check: obligation.check, files, inputs, listed, executed: false };
    const stdout = listed.map(script => `--- ${script}: PASS`).join('\n') +
      '\n  ✓ assertion about SKIP handling\nPASS — all 2 papercusp-desktop selftests green\n';
    const logs = { stdout: pin('command.out', stdout, true), stderr: pin('command.err', '', true),
      beforeStdout: pin('before.out', `COMMAND_CHECK_SELECTION=${JSON.stringify(before)}\n`, true),
      beforeStderr: pin('before.err', '', true),
      afterStdout: pin('after.out', `COMMAND_CHECK_SELECTION=${JSON.stringify(before)}\n`, true),
      afterStderr: pin('after.err', '', true) };
    const receipt = { schemaVersion: 1, kind: 'original-command-execution', cwd: 'desktop',
      command: ['bash', 'bin/lib/run-selftests.sh'], exitCode: 0, childWallMs: 1000,
      startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', before, after: before,
      logs: Object.values(logs).map(log => ({ path: log.ref, sha256: log.sha256 })) };
    const pins = { mode: 'command-preparation' as const, repositoryRoot,
      selection: pin('selection.log', `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`, true),
      commands: [{ task: obligation.task, step: 7, receipt: pin('receipt.json', receipt), logs }] };
    const saveSelection = () => { pins.selection = pin('selection.log',
      `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`, true); };
    const saveReceipt = () => { pins.commands[0]!.receipt = pin('receipt.json', receipt); };
    const saveStdout = (text: string) => {
      logs.stdout = pin('command.out', text, true);
      receipt.logs = Object.values(logs).map(log => ({ path: log.ref, sha256: log.sha256 }));
      saveReceipt();
    };
    return { root, pins, selection, receipt, stdout, files, pin, saveSelection, saveReceipt, saveStdout };
  }
  describe('bounded reads', () => {
    // Instrument the real native IO boundary, including the old readFile path.
    // Mutations happen after real bytes are read, before the reader can accept them.
    function observeRead(root: string, pins: unknown, target: string, mutation = 'none') {
      // The launcher correctly substitutes HEAD for dirty checkout modules in
      // native children. Use an exact private snapshot of this test's subject,
      // keeping the loader and its unchanged dependency checks enabled.
      const subjectRoot = join(root, 'reader-subject');
      mkdirSync(subjectRoot);
      const modulePath = join(subjectRoot, 'budgeted-task-scheduler.mjs');
      const subjectBytes = readFileSync(join(REPO_ROOT, 'scripts/lib/budgeted-task-scheduler.mjs'));
      writeFileSync(modulePath, subjectBytes);
      // This dependency evolves with the scheduler. A symlink is resolved back
      // into the checkout and the native loader can substitute older HEAD bytes.
      const mutexBytes = readFileSync(join(REPO_ROOT, 'scripts/lib/fs-mutex.mjs'));
      writeFileSync(join(subjectRoot, 'fs-mutex.mjs'), mutexBytes);
      const mutexSha256 = createHash('sha256').update(mutexBytes).digest('hex');
      for (const dependency of ['task-exit-class.mjs', 'executed-source-map.mjs',
        'task-cgroup-limits.mjs', 'task-deadline.mjs'])
        symlinkSync(join(REPO_ROOT, 'scripts/lib', dependency), join(subjectRoot, dependency));
      const subjectSha256 = createHash('sha256').update(subjectBytes).digest('hex');
      const script = `
        import fs from 'node:fs';
        import promises from 'node:fs/promises';
        import { createHash } from 'node:crypto';
        import { syncBuiltinESMExports } from 'node:module';
        import { pathToFileURL } from 'node:url';
        const config = JSON.parse(fs.readFileSync(0, 'utf8'));
        const subjectSha256 = createHash('sha256').update(fs.readFileSync(config.modulePath)).digest('hex');
        if (subjectSha256 !== config.subjectSha256) throw new Error('private reader subject differs');
        const mutexSha256 = createHash('sha256').update(fs.readFileSync(
          new URL('./fs-mutex.mjs', pathToFileURL(config.modulePath)))).digest('hex');
        if (mutexSha256 !== config.mutexSha256) throw new Error('private mutex subject differs');
        const originalBytes = fs.statSync(config.target).size < 1024 * 1024
          ? fs.readFileSync(config.target) : null;
        let bytesRead = 0, fullFileReads = 0, opens = 0, closes = 0, mutated = false;
        const mutate = () => {
          if (mutated || config.mutation === 'none') return;
          mutated = true;
          if (config.mutation === 'grow') fs.truncateSync(config.target, 64 * 1024 * 1024 + 1);
          if (config.mutation === 'shrink') fs.truncateSync(config.target, 1);
          if (config.mutation === 'rewrite') fs.writeFileSync(config.target, originalBytes);
          if (config.mutation === 'replace') {
            fs.renameSync(config.target, config.target + '.before');
            fs.writeFileSync(config.target, originalBytes);
          }
        };
        const readFile = promises.readFile.bind(promises);
        promises.readFile = async (path, ...args) => {
          const result = await readFile(path, ...args);
          if (String(path) === config.target) {
            fullFileReads++; bytesRead += Buffer.byteLength(result); mutate();
          }
          return result;
        };
        const open = promises.open.bind(promises);
        promises.open = async (path, ...args) => {
          const handle = await open(path, ...args);
          if (String(path) === config.target) {
            opens++;
            const read = handle.read.bind(handle), close = handle.close.bind(handle);
            handle.read = async (...args) => {
              const result = await read(...args); bytesRead += result.bytesRead; mutate(); return result;
            };
            handle.close = async () => { closes++; return close(); };
          }
          return handle;
        };
        syncBuiltinESMExports();
        const { readBudgetedTaskComparisonArtifacts } = await import(pathToFileURL(config.modulePath));
        let accepted = false, error = null;
        try { await readBudgetedTaskComparisonArtifacts(config.root, config.pins); accepted = true; }
        catch (cause) { error = String(cause.message); }
        console.log(JSON.stringify({ accepted, error, bytesRead, fullFileReads, opens, closes, mutated,
          subjectSha256, mutexSha256 }));
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        input: JSON.stringify({ root, pins, target, mutation, modulePath, subjectSha256, mutexSha256 }),
        encoding: 'utf8', timeout: 20_000,
      });
      if (child.error) throw child.error;
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout.trim()) as { accepted: boolean; error: string | null;
        bytesRead: number; fullFileReads: number; opens: number; closes: number; mutated: boolean;
        subjectSha256: string; mutexSha256: string };
      expect(result.subjectSha256).toBe(subjectSha256);
      expect(result.mutexSha256).toBe(mutexSha256);
      return result;
    }
    it.each(['artifact', 'current input'])('rejects an oversized %s before reading its contents', kind => {
      const f = fixture();
      try {
        const target = kind === 'artifact' ? join(f.root, f.pins.selection.ref)
          : join(f.pins.repositoryRoot, f.files[0]!);
        truncateSync(target, 64 * 1024 * 1024 + 1);
        const observed = observeRead(f.root, f.pins, target);
        expect(observed.accepted).toBe(false);
        expect(observed.error).toContain('exceeded read budget');
        expect(observed.bytesRead).toBe(0);
        expect(observed.fullFileReads).toBe(0);
        expect(observed.closes).toBe(observed.opens);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
    it('accepts an artifact at the byte ceiling and closes its descriptor', () => {
      const f = fixture();
      try {
        const target = join(f.root, f.pins.selection.ref);
        truncateSync(target, 64 * 1024 * 1024);
        f.pins.selection.sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
        expect(observeRead(f.root, f.pins, target)).toMatchObject({ accepted: true,
          bytesRead: 64 * 1024 * 1024, fullFileReads: 0, opens: 1, closes: 1 });
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
    it.each(['artifact', 'current input'].flatMap(kind =>
      ['grow', 'shrink', 'replace', 'rewrite'].map(mutation => ({ kind, mutation }))))
    ('rejects $kind that can $mutation during a read', ({ kind, mutation }) => {
      const f = fixture();
      try {
        const target = kind === 'artifact' ? join(f.root, f.pins.selection.ref)
          : join(f.pins.repositoryRoot, f.files[0]!);
        const originalLength = readFileSync(target).length;
        const observed = observeRead(f.root, f.pins, target, mutation);
        expect(observed).toMatchObject({ accepted: false, fullFileReads: 0,
          opens: 1, closes: 1, mutated: true });
        expect(observed.error).toContain('changed during read');
        expect(observed.bytesRead).toBeLessThanOrEqual(originalLength);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  });
  it('resolves raw receipts and logs, preserving script order, guard inputs and partial selection', async () => {
    const f = fixture();
    try {
      const result = await readBudgetedTaskComparisonArtifacts(f.root, f.pins);
      expect(result).toMatchObject({ mode: 'command-preparation', originalArtifactsResolved: true,
        currentDeclaredInputsMatched: true, operationalAcceptance: false,
        orderedChainQualified: false, runtimeClosure: 'unmeasured' });
      expect(result.commands[0]!.inputs).toHaveLength(4);
      expect(result.commands[0]!.fileOccurrences).toHaveLength(2);
      expect(result.commands[0]!.scriptOrder).toEqual(['b.selftest.sh', 'a.selftest.sh']);
      expect(result.selection).toMatchObject({ coverage: 'partial', unenumerated: ['remaining native chain'] });
      expect(Object.isFrozen(result.commands[0]!.inputs)).toBe(true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['step', 'task', 'command', 'format', 'exit', 'census', 'occurrence-kind',
    'occurrence-missing', 'occurrence-duplicate', 'script-order', 'skip', 'missing-verdict',
    'duplicate-marker', 'duplicate-command', 'role-alias', 'source-drift', 'source-escape', 'log-drift'])
  ('refuses %s without admitting any comparison cohort', async defect => {
    const f = fixture();
    try {
      if (defect === 'step') f.pins.commands[0]!.step = 6;
      if (defect === 'task') f.pins.commands[0]!.task = 'another task';
      if (defect === 'command') { f.receipt.command = ['bash', 'different.sh']; f.saveReceipt(); }
      if (defect === 'format') { f.selection.commandObligations[0]!.check = 'unknown-format'; f.saveSelection(); }
      if (defect === 'exit') { f.receipt.exitCode = 1; f.saveReceipt(); }
      if (defect === 'census') { f.selection.commandObligations[0]!.inputs.pop(); f.saveSelection(); }
      if (defect === 'occurrence-kind') { f.selection.fileOccurrences[0]!.kind = 'check-input'; f.saveSelection(); }
      if (defect === 'occurrence-missing') { f.selection.fileOccurrences.pop(); f.saveSelection(); }
      if (defect === 'occurrence-duplicate') { f.selection.fileOccurrences.push(f.selection.fileOccurrences[0]!); f.saveSelection(); }
      if (defect === 'script-order') f.saveStdout(f.stdout.replace('b.selftest.sh: PASS', 'a.selftest.sh: PASS')
        .replace('--- a.selftest.sh: PASS\n  ✓', '--- b.selftest.sh: PASS\n  ✓'));
      if (defect === 'skip') f.saveStdout(f.stdout.replace('b.selftest.sh: PASS', 'b.selftest.sh: SKIP'));
      if (defect === 'missing-verdict') f.saveStdout(f.stdout.replace('--- a.selftest.sh: PASS\n', ''));
      if (defect === 'duplicate-marker') { f.pins.selection = { ...f.pins.selection,
        sha256: createHash('sha256').update(readFileSync(join(f.root, 'selection.log'))).digest('hex') };
        const bytes = readFileSync(join(f.root, 'selection.log'), 'utf8');
        writeFileSync(join(f.root, 'selection.log'), bytes + bytes);
        f.pins.selection.sha256 = createHash('sha256').update(bytes + bytes).digest('hex'); }
      if (defect === 'duplicate-command') f.pins.commands.push(f.pins.commands[0]!);
      if (defect === 'role-alias') f.pins.commands[0]!.logs.afterStderr = f.pins.commands[0]!.logs.beforeStderr;
      if (defect === 'source-drift') writeFileSync(join(f.pins.repositoryRoot, f.files[0]!), 'changed');
      if (defect === 'source-escape') { const path = join(f.pins.repositoryRoot, f.files[0]!);
        rmSync(path); symlinkSync(join(f.root, 'receipt.json'), path); }
      if (defect === 'log-drift') writeFileSync(join(f.root, 'command.out'), 'changed');
      await expect(readBudgetedTaskComparisonArtifacts(f.root, f.pins)).rejects.toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('R12 original Astro command receipt', () => {
  it.each(['valid-standalone', 'valid-ordered', 'wrapper-command', 'wrapper-script', 'original-command',
    'failed-execution', 'signal', 'failed-discovery', 'discovery-command', 'discovery-order',
    'sync-incomplete', 'discovery-executed', 'duplicate-discovery', 'multiple-results',
    'changed-inputs', 'changed-population', 'wrong-occurrence-kind', 'missing-occurrence',
    'missing-summary', 'duplicate-summary', 'wrong-file-count', 'errors', 'missing-counter',
    'duplicate-counter', 'missing-wrapper-output', 'log-path', 'stderr-drift', 'source-drift'])
  ('qualifies Astro only with %s evidence', async defect => {
    const root = mkdtempSync(join(tmpdir(), 'r12-astro-command-'));
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const pin = (ref: string, value: unknown, raw = false) => {
      const bytes = raw ? String(value) : JSON.stringify(value);
      writeFileSync(join(root, ref), bytes);
      return { ref, sha256: digest(bytes) };
    };
    try {
      const repositoryRoot = join(root, 'repo'); mkdirSync(join(repositoryRoot, 'docs'), { recursive: true });
      const packageText = JSON.stringify({ scripts: { check: defect === 'wrapper-script' ? 'astro check && true' : 'astro check' } });
      const files = ['docs/page.astro', 'docs/types.d.ts'];
      const inputs = [...files, 'docs/package.json'].sort().map(path => {
        const bytes = path.endsWith('package.json') ? packageText : path;
        writeFileSync(join(repositoryRoot, path), bytes);
        return { path, sha256: digest(bytes) };
      });
      const command = 'astro check', task = 'docs :: test';
      const step = defect === 'valid-standalone' ? null : 0;
      const census = { ok: true, enumerated: true, repositoryFiles: files, inputs,
        config: { runner: 'astro-check', tsconfig: null }, sync: { status: 'completed', beforePopulation: true },
        executed: false, runtimeClosure: 'unmeasured', operationalAcceptance: false };
      const selection = { schemaVersion: 1, kind: 'full-gate', coverage: 'partial',
        unenumerated: ['remaining original chain'],
        fileOccurrences: files.map(file => ({ task, step, command, file, kind: 'check-input' })),
        tasks: [{ id: task, dir: 'docs', command: step === null ? command : 'astro check && vitest run',
          ...(step === null ? {} : { steps: [{ command }, { command: 'vitest run' }] }) }],
        commandObligations: [{ task, step, kind: 'command-check', check: 'astro-check', command, inputs, discovery: census }] };
      const before = structuredClone(census), after = structuredClone(census);
      if (defect === 'failed-discovery') before.ok = false;
      if (defect === 'sync-incomplete') before.sync.status = 'pending';
      if (defect === 'discovery-executed') before.executed = true;
      if (defect === 'changed-inputs') after.inputs[0]!.sha256 = 'f'.repeat(64);
      if (defect === 'changed-population') after.repositoryFiles.pop();
      if (defect === 'wrong-occurrence-kind') selection.fileOccurrences[0]!.kind = 'test-file';
      if (defect === 'missing-occurrence') selection.fileOccurrences.pop();
      const discovery = (value: typeof census, elapsedMs: number) => 'PC_VITEST_CONFIG_CONTRACTS=' +
        JSON.stringify({ results: [ { ...value, diagnostics: { elapsedMs } },
          ...(defect === 'multiple-results' ? [value] : []) ] }) + '\n';
      let stdout = '\n> docs@0.1.0 check\n> astro check\n\nResult (2 files): \n- 0 errors\n- 1 warnings\n- 23 hints\n';
      if (defect === 'missing-summary') stdout = stdout.replace('Result (2 files): \n', '');
      if (defect === 'duplicate-summary') stdout += 'Result (2 files): \n';
      if (defect === 'wrong-file-count') stdout = stdout.replace('(2 files)', '(1 files)');
      if (defect === 'errors') stdout = stdout.replace('- 0 errors', '- 1 errors');
      if (defect === 'missing-counter') stdout = stdout.replace('- 1 warnings\n', '');
      if (defect === 'duplicate-counter') stdout += '- 0 errors\n';
      if (defect === 'missing-wrapper-output') stdout = stdout.replace('> astro check\n', '');
      const beforeLog = discovery(before, 10);
      const logs = { stdout: pin('command.out', stdout, true), stderr: pin('command.err', 'deprecation\n', true),
        beforeStdout: pin('before.out', beforeLog + (defect === 'duplicate-discovery' ? beforeLog : ''), true),
        beforeStderr: pin('before.err', 'deprecation\n', true),
        afterStdout: pin('after.out', discovery(after, 20), true),
        afterStderr: pin('after.err', defect === 'stderr-drift' ? 'different\n' : 'deprecation\n', true) };
      const discoveryCommand = ['/installed/bin/node', 'scripts/resolve-vitest-config-contracts.mjs', '--astro-selection-child'];
      const receipt = { kind: 'original-native-command-execution', cwd: 'docs',
        originalCommand: defect === 'original-command' ? ['astro', 'sync'] : ['astro', 'check'],
        wrapperCommand: ['npm', 'run', 'check'],
        before: { command: defect === 'discovery-command' ? ['/installed/bin/node', 'other.mjs'] : discoveryCommand,
          startedAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:01Z',
          exitCode: 0, signal: null, error: null, stdout: join(root, 'before.out'), stderr: join(root, 'before.err') },
        execution: { command: defect === 'wrapper-command' ? ['npm', 'run', 'other'] : ['npm', 'run', 'check'],
          startedAt: '2026-10-14T00:00:01Z', completedAt: '2026-10-14T00:00:02Z',
          exitCode: defect === 'failed-execution' ? 1 : 0, signal: defect === 'signal' ? 'SIGTERM' : null,
          error: null, stdout: defect === 'log-path' ? '/elsewhere/command.out' : join(root, 'command.out'),
          stderr: join(root, 'command.err') },
        after: { command: discoveryCommand,
          startedAt: defect === 'discovery-order' ? '2026-10-14T00:00:01Z' : '2026-10-14T00:00:02Z',
          completedAt: '2026-10-14T00:00:03Z', exitCode: 0, signal: null, error: null,
          stdout: join(root, 'after.out'), stderr: join(root, 'after.err') } };
      const pins = { mode: 'command-preparation' as const, repositoryRoot,
        selection: pin('selection.log', `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`, true),
        commands: [{ task, step, receipt: pin('receipt.json', receipt), logs }] };
      if (defect === 'source-drift') writeFileSync(join(repositoryRoot, files[0]!), 'changed');
      if (defect.startsWith('valid-')) {
        const result = await readBudgetedTaskComparisonArtifacts(root, pins);
        expect(result.commands[0]).toMatchObject({ task, step, command, scriptsExecuted: 0,
          diagnostics: { filesChecked: 2, errors: 0, warnings: 1, hints: 23 } });
        expect(result.selection).toMatchObject({ coverage: 'partial', unenumerated: ['remaining original chain'] });
        expect(result.orderedChainQualified).toBe(false);
        expect(result.runtimeClosure).toBe('unmeasured');
        expect(result.operationalAcceptance).toBe(false);
        expect(Object.isFrozen(result.commands[0]!.diagnostics)).toBe(true);
      } else await expect(readBudgetedTaskComparisonArtifacts(root, pins)).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('R12 original native voice transcript receipt', () => {
  it.each(['valid', 'projection-only', 'missing-event-pin', 'duplicate-event', 'wrong-event', 'wrong-session',
    'wrong-cwd', 'wrong-shell', 'extra-shell-command', 'failed-execution', 'failed-selection',
    'unfinished-event', 'source-mismatch', 'wrong-clock', 'changed-census', 'executed-discovery',
    'fabricated-occurrence', 'missing-result', 'duplicate-result', 'warnings', 'log-drift', 'source-drift'])
  ('qualifies original voice only with %s evidence', async defect => {
    const root = mkdtempSync(join(tmpdir(), 'r12-voice-command-'));
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const pin = (ref: string, value: string) => {
      writeFileSync(join(root, ref), value);
      return { ref, sha256: digest(value) };
    };
    try {
      const repositoryRoot = join(root, 'repo'); mkdirSync(join(repositoryRoot, 'operator/scripts'), { recursive: true });
      const source = 'operator/scripts/el-tools-check.mjs';
      writeFileSync(join(repositoryRoot, source), 'source');
      const inputs = [{ path: source, sha256: digest('source') }];
      const task = 'operator :: lint:el-tools', command = 'node scripts/el-tools-check.mjs';
      const selection = { schemaVersion: 1, kind: 'full-gate', coverage: 'partial',
        unenumerated: ['remaining original chain'],
        fileOccurrences: defect === 'fabricated-occurrence' ? [{ task, step: null, command, file: source, kind: 'test-file' }] : [],
        tasks: [{ id: task, dir: 'operator', command }],
        commandObligations: [{ task, kind: 'command-check', check: 'el-tools-drift', command, inputs }] };
      const before = { schemaVersion: 1, kind: 'command-check-inputs', check: 'el-tools-drift', files: [], inputs,
        executed: defect === 'executed-discovery', runtimeClosure: 'unmeasured', operationalAcceptance: false };
      const after = structuredClone(before);
      if (defect === 'changed-census') after.inputs[0]!.sha256 = 'f'.repeat(64);
      const result = '[el-tools-check] ✓ aligned — 25 client tools, all backed by registry defs.\n';
      const logs = { stdout: pin('command.out', defect === 'missing-result' ? '' : result + (defect === 'duplicate-result' ? result : '')),
        stderr: pin('command.err', defect === 'warnings' ? '[el-tools-check] 1 warning:\n' : ''),
        beforeStdout: pin('before.out', `COMMAND_CHECK_SELECTION=${JSON.stringify(before)}\n`),
        afterStdout: pin('after.out', `COMMAND_CHECK_SELECTION=${JSON.stringify(after)}\n`) };
      const shell = [
        `${command} --print-selection > ${join(root, 'before.out')}`,
        `${command} > ${join(root, 'command.out')} 2> ${join(root, 'command.err')}`,
        'voice_status=$?',
        `${command} --print-selection > ${join(root, 'after.out')}`,
        'selection_status=$?',
        "printf 'voice_exit=%s selection_exit=%s\\n' \"$voice_status\" \"$selection_status\"",
        'exit "$voice_status"',
      ].join('\n');
      const event = { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'original-session',
        started_at_ms: 1000, completed_at_ms: defect === 'wrong-clock' ? 999 : 2000,
        item: { type: 'CommandExecution', id: 'original-event', cwd: `file://${join(repositoryRoot, 'operator')}`,
          command: ['/bin/bash', '-lc', defect === 'wrong-shell' ? shell.replace(command, 'node scripts/other.mjs') :
            shell + (defect === 'extra-shell-command' ? '\ntrue' : '')],
          source: defect === 'source-mismatch' ? 'agent-authored' : 'unified_exec_startup',
          status: defect === 'unfinished-event' ? 'running' : 'completed',
          exit_code: defect === 'failed-execution' ? 1 : 0,
          aggregated_output: defect === 'failed-selection' ? 'voice_exit=0 selection_exit=1\n' : 'voice_exit=0 selection_exit=0\n' } } };
      if (defect === 'wrong-cwd') event.payload.item.cwd = `file://${repositoryRoot}`;
      // A copied native event in tool-output text does not qualify as the native event.
      const projection = { type: 'response_item', payload: { type: 'custom_tool_call_output', output: JSON.stringify(event) } };
      const transcript = [projection, ...(defect === 'projection-only' ? [] : [event]),
        ...(defect === 'duplicate-event' ? [event] : [])].map(row => JSON.stringify(row)).join('\n') + '\n';
      const pins = { mode: 'command-preparation' as const, repositoryRoot,
        selection: pin('selection.log', `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`),
        commands: [{ task, step: null, receipt: pin('native.jsonl', transcript), logs,
          ...(defect === 'missing-event-pin' ? {} : { nativeEvent: {
            sessionId: defect === 'wrong-session' ? 'another-session' : 'original-session',
            eventId: defect === 'wrong-event' ? 'another-event' : 'original-event' } }) }] };
      if (defect === 'log-drift') writeFileSync(join(root, 'command.out'), 'changed');
      if (defect === 'source-drift') writeFileSync(join(repositoryRoot, source), 'changed');
      if (defect === 'valid') {
        const receipt = await readBudgetedTaskComparisonArtifacts(root, pins);
        expect(receipt.commands[0]).toMatchObject({ task, step: null, command, fileOccurrences: [],
          childWallMs: null, nativeExecutionWallMs: 1000, durationScope: 'discovery-and-command',
          scriptsExecuted: 0, scriptOrder: [], voiceResult: { clientTools: 25 } });
        expect(receipt.selection).toMatchObject({ coverage: 'partial' });
        expect(receipt.runtimeClosure).toBe('unmeasured');
        expect(receipt.orderedChainQualified).toBe(false);
        expect(receipt.operationalAcceptance).toBe(false);
      } else await expect(readBudgetedTaskComparisonArtifacts(root, pins)).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('R12 original fixture lifecycle receipt', () => {
  it.each(['valid', 'valid-ordered-lifecycle', 'missing-lifecycle', 'wrong-script', 'wrong-discovery', 'after-before-exit',
    'discovery-failure', 'missing-build-result'])('validates command-preparation lifecycle evidence: %s', async defect => {
    const root = mkdtempSync(join(tmpdir(), 'r12-fixture-lifecycle-'));
    const pin = (ref: string, value: unknown, raw = false) => {
      const bytes = raw ? String(value) : JSON.stringify(value);
      writeFileSync(join(root, ref), bytes);
      return { ref, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    try {
      const repositoryRoot = join(root, 'repo'); mkdirSync(repositoryRoot);
      writeFileSync(join(repositoryRoot, 'source.ts'), 'source');
      const inputs = [{ path: 'source.ts', sha256: createHash('sha256').update('source').digest('hex') }];
      const command = 'node scripts/build.mjs';
      const lifecycleCommands = defect === 'missing-lifecycle' ? [] :
        [{ script: defect === 'wrong-script' ? 'other' : 'pretest', command }];
      const selection = { schemaVersion: 1, kind: 'full-gate', coverage: 'partial',
        fileOccurrences: [] as Array<{ task: string; step: null; command: string; file: string; kind: string }>,
        tasks: [{ id: 'fixture :: test', dir: 'fixture', script: 'test', command: 'vitest run', lifecycleCommands,
          files: [] as string[] }],
        commandObligations: [{ task: 'fixture :: test', kind: 'npm-lifecycle', script: 'pretest', command, inputs }] };
      const census = { schemaVersion: 1, kind: 'command-check-inputs', check: 'fixture-build', files: [], inputs };
      const logs = { stdout: pin('command.out', defect === 'missing-build-result' ? 'partial build\n' :
        `Fixture built: ${'a'.repeat(64)}\n`, true), stderr: pin('command.err', '', true),
        beforeStdout: pin('before.out', `COMMAND_CHECK_SELECTION=${JSON.stringify(census)}\n`, true),
        beforeStderr: pin('before.err', '', true),
        afterStdout: pin('after.out', `COMMAND_CHECK_SELECTION=${JSON.stringify(census)}\n`, true),
        afterStderr: pin('after.err', '', true) };
      const discoveryCommand = ['node', 'scripts/build.mjs', '--print-selection', '--repository-root', repositoryRoot];
      const receipt = { kind: 'original-native-command-execution', cwd: 'fixture',
        before: { command: defect === 'wrong-discovery' ? ['node', 'unrelated.mjs'] : discoveryCommand,
          startedAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:01Z',
          exitCode: defect === 'discovery-failure' ? 1 : 0, stdout: 'before.out', stderr: 'before.err' },
        execution: { command: ['node', 'scripts/build.mjs'], startedAt: '2026-10-14T00:00:01Z',
          completedAt: '2026-10-14T00:00:02Z', exitCode: 0, stdout: 'command.out', stderr: 'command.err' },
        after: { command: discoveryCommand,
          startedAt: defect === 'after-before-exit' ? '2026-10-14T00:00:01Z' : '2026-10-14T00:00:02Z',
          completedAt: '2026-10-14T00:00:03Z', exitCode: 0, stdout: 'after.out', stderr: 'after.err' } };
      const pins = { mode: 'command-preparation' as const, repositoryRoot,
        selection: pin('selection.log', `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`, true),
        commands: [{ task: 'fixture :: test', step: null, receipt: pin('receipt.json', receipt), logs }] };
      if (defect === 'valid-ordered-lifecycle') {
        mkdirSync(join(repositoryRoot, 'fixture'));
        const testFile = 'fixture/check.test.ts', testBody = 'original test source';
        writeFileSync(join(repositoryRoot, testFile), testBody);
        const packageBody = JSON.stringify({ scripts: { pretest: command, test: 'vitest run' } });
        writeFileSync(join(repositoryRoot, 'fixture/package.json'), packageBody);
        const packageInput = { path: 'fixture/package.json', sha256: createHash('sha256').update(packageBody).digest('hex') };
        const testInputs = [packageInput, { path: testFile, sha256: createHash('sha256').update(testBody).digest('hex') }];
        selection.tasks[0]!.files = [testFile];
        selection.fileOccurrences.push({ task: 'fixture :: test', step: null, command: 'vitest run', file: testFile, kind: 'test-file' });
        pins.selection = pin('selection.log', `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`, true);
        const report = { success: true, numPassedTests: 1, numTotalTests: 1, numFailedTests: 0,
          numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0,
          testResults: [{ name: join(repositoryRoot, testFile), status: 'passed',
            assertionResults: [{ status: 'passed', failureMessages: [] }] }] };
        const testReceipt = { kind: 'original-native-command-execution', cwd: 'fixture', originalCommand: 'vitest run',
          before: { inputs: testInputs }, after: { inputs: testInputs }, execution: {
            command: ['bash', '-lc', 'vitest run'], exitCode: 0, signal: null, error: null,
            startedAt: '2026-10-14T00:00:03Z', completedAt: '2026-10-14T00:00:04Z',
            stdout: 'test.out', stderr: 'test.err', report: 'test.report.json' } };
        const chainSteps = [{ phase: 'pre', step: null, format: 'command-preparation', receipt: pins.commands[0]!.receipt },
          { phase: 'test', step: null, format: 'vitest-json', receipt: pin('test.json', testReceipt), logs: {
            stdout: pin('test.out', '', true), stderr: pin('test.err', '', true), report: pin('test.report.json', report) } }];
        const parent = { kind: 'original-native-command-execution', cwd: 'fixture', originalCommand: 'vitest run',
          inputs: [packageInput], execution: { command: ['npm', 'run', 'test'], exitCode: 0, signal: null, error: null,
            startedAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:05Z', stdout: 'parent.out', stderr: 'parent.err' },
          steps: chainSteps.map(({ phase, step, receipt }) => ({ phase, step, receipt })) };
        Object.assign(pins, { chains: [{ task: 'fixture :: test', receipt: pin('parent.json', parent), steps: chainSteps,
          logs: { stdout: pin('parent.out', '', true), stderr: pin('parent.err', '', true) } }] });
        await expect(readBudgetedTaskComparisonArtifacts(root, pins))
          .rejects.toThrow('complete native npm parent and process trace required for ordered evidence');
        return;
      }
      if (defect === 'valid') {
        const result = await readBudgetedTaskComparisonArtifacts(root, pins);
        expect(result.commands[0]).toMatchObject({ kind: 'npm-lifecycle', script: 'pretest',
          command, fileOccurrences: [], scriptsExecuted: 0 });
        expect(result.orderedChainQualified).toBe(false);
      } else await expect(readBudgetedTaskComparisonArtifacts(root, pins)).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('R12 original ordered native occurrence qualification', () => {
  function nativeVitestFixture(fault: 'none' | 'skip' = 'none') {
    const root = mkdtempSync(join(tmpdir(), 'r12-native-vitest-chain-'));
    const repositoryRoot = join(root, 'repo');
    const evidenceRoot = join(root, 'evidence');
    const appRoot = join(repositoryRoot, 'app');
    const testFile = 'app/repeated.test.mjs';
    const testBody = 'export {}; // original source census fixture\n';
    const sourcePath = join(repositoryRoot, testFile);
    const task = 'app :: test';
    const command = 'node node_modules/vitest/vitest.mjs run';
    const packageBody = JSON.stringify({ scripts: { test: command } });
    const runnerPath = join(appRoot, 'node_modules/vitest/vitest.mjs');
    mkdirSync(dirname(runnerPath), { recursive: true });
    writeFileSync(sourcePath, testBody);
    writeFileSync(join(appRoot, 'package.json'), packageBody);
    const runnerBody = `
      import { createHash } from 'node:crypto';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      const testFile = 'app/repeated.test.mjs';
      const sourceBytes = readFileSync(resolve(process.cwd(), 'repeated.test.mjs'));
      const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
      const specifications = [{ testFile, projectName: 'operator', pool: 'forks',
        testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }];
      const now = Date.now();
      const skipped = ${JSON.stringify(fault === 'skip')};
      const nativeRun = {
        schemaVersion: 'native-vitest-run-v1', scope: 'vitest-reporter-callbacks',
        pid: process.pid, ppid: process.ppid, startedAtMs: now - 1, finishedAtMs: now,
        terminalHook: 'onTestRunEnd', reason: 'passed', unhandledErrorCount: 0,
        reportedModulePaths: [testFile], modulePopulationMatched: true,
        selectedManifest: { sha256: createHash('sha256').update(JSON.stringify(specifications)).digest('hex'), specifications },
        files: [{ testFile, state: 'passed', observedAtMs: now, completionId: 'native-test-case-1',
          projectName: 'operator', firstAttemptVerdict: 'pass',
          proof: { inputs: null, sourceEvidence: { schemaVersion: 'vite-collected-source-evidence-v1',
            scope: 'repository-worker-vite-original-sources', status: 'stable',
            sources: [{ path: testFile, sha256: sourceSha, basis: 'vite-pre-transform', currentSha256: sourceSha }],
            reasons: [] } },
          execution: { passed: skipped ? 0 : 1, failed: 0, skipped: skipped ? 1 : 0, collectionFailed: false },
          cases: [{ caseIndex: 0, caseKey: 'native assertion', occurrence: 1,
            status: skipped ? 'skip' : 'pass', durationMs: 0, errorTail: null }] }],
        gaps: [],
      };
      writeFileSync(process.env.PC_EXECUTED_SOURCE_MAP_OUT, JSON.stringify({ nativeRun }));
      process.stdout.write('native Vitest stdout\\n');
      process.stderr.write('native Vitest stderr\\n');
    `;
    writeFileSync(runnerPath, runnerBody);
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const inputs = [
      { path: 'app/package.json', sha256: digest(packageBody) },
      { path: testFile, sha256: digest(testBody) },
      { path: 'app/node_modules/vitest/vitest.mjs', sha256: digest(runnerBody) },
    ];
    const out = join(root, 'native-run.json');
    const startedAtMs = Date.now();
    const child = spawnSync('npm', ['run', 'test'], { cwd: appRoot, timeout: 20_000,
      env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: out,
        npm_config_script_shell: '/bin/sh', PAPERCUSP_TEST_STARTUP_TRACE: '0' }) });
    assertNativeFixtureCompleted(child, out, 'ordered-native-reporter');
    if (child.status !== 0) throw new Error(`native Vitest fixture exited ${child.status}: ${String(child.stderr)}`);
    const retained = writeBudgetedTaskNativeExecutionReceipt(evidenceRoot, {
      task, attempt: 'initial', cwd: appRoot, command: ['npm', 'run', 'test'], originalCommand: command,
      startedAtMs, finishedAtMs: Date.now(), exitCode: child.status, signal: child.signal,
      error: null, captureComplete: true, stdout: child.stdout as Buffer, stderr: child.stderr as Buffer,
      before: inputs, after: inputs, processTrace: { out, rootPid: child.pid },
    });
    const pin = (ref: string, bytes: string | Buffer) => {
      const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      writeFileSync(join(evidenceRoot, ref), content);
      return { ref, sha256: digest(content) };
    };
    const pinRef = (artifact: { ref: string; sha256: string }) => ({ ref: artifact.ref, sha256: artifact.sha256 });
    const selection = { schemaVersion: 1, kind: 'full-gate', coverage: 'complete', unenumerated: [],
      fileOccurrences: [{ task, step: 0, command, file: testFile, kind: 'test-file' }],
      tasks: [{ id: task, dir: 'app', script: 'test', command, lifecycleCommands: [],
        steps: [{ command, script: 'test', files: [testFile] }] }],
      commandObligations: [] };
    const selectionPin = pin('selection.log', `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`);
    const trace = retained.observation.processTrace;
    const reporter = trace.reporter!;
    const reporterProcess = reporter.process!;
    const reporterArtifact = reporter.artifact!;
    const streams = trace.streams.filter((row: any) => row.processIdentity === reporterProcess.processIdentity &&
      row.pid === reporterProcess.pid);
    const streamPin = (role: 'stdout' | 'stderr') => {
      const rows = streams.filter((row: any) => row.role === role);
      if (rows.length !== 1) throw new Error(`native stream fixture expected one ${role} artifact`);
      return pinRef(rows[0].artifact);
    };
    const parentLogs = retained.logs;
    const pins = { mode: 'command-preparation' as const, repositoryRoot, selection: selectionPin, commands: [],
      chains: [{ task, receipt: pinRef(retained.receipt),
        logs: { stdout: pinRef(parentLogs.stdout), stderr: pinRef(parentLogs.stderr) },
        steps: [{ phase: 'test' as const, step: 0, format: 'vitest-native-run' as const,
          receipt: pinRef(reporterArtifact), logs: { stdout: streamPin('stdout'), stderr: streamPin('stderr'),
            report: pinRef(reporterArtifact) } }] }] };
    return { root, repositoryRoot, evidenceRoot, testFile, command, pins, pin };
  }

  it('qualifies a real npm sh lifecycle from the native reporter and process streams', async () => {
    const f = nativeVitestFixture();
    try {
      const result = await readBudgetedTaskComparisonArtifacts(f.evidenceRoot, f.pins);
      expect(result).toMatchObject({ orderedChainQualified: true, operationalAcceptance: false,
        runtimeClosure: 'unmeasured', orderedChainCoverage: { population: ['app :: test'],
          qualified: ['app :: test'], missing: [] } });
      expect(result.chains[0]!.steps).toMatchObject([{ phase: 'test', step: 0,
        command: f.command, testsPassed: 1, format: 'vitest-native-run',
        fileOccurrences: [{ file: f.testFile }] }]);
      const parent = JSON.parse(readFileSync(join(f.evidenceRoot, f.pins.chains[0]!.receipt.ref), 'utf8'));
      const span = parent.processTrace.npmLifecycle.spans[0];
      expect(span.command.split('/').at(-1)).toBe('sh');
      expect(span.argv).toEqual(['-c', f.command]);
      expect(span.stdioAccessible).toEqual({ stdout: false, stderr: false });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects a fabricated bash -lc receipt when the observed npm step is sh -c', async () => {
    const f = nativeVitestFixture();
    try {
      const fabricated = { kind: 'original-native-command-execution', cwd: 'app', originalCommand: f.command,
        execution: { command: ['bash', '-lc', f.command], exitCode: 0, signal: null, error: null } };
      f.pins.chains[0]!.steps[0]!.receipt = f.pin('fabricated-bash-step.json', JSON.stringify(fabricated));
      await expect(readBudgetedTaskComparisonArtifacts(f.evidenceRoot, f.pins)).rejects.toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects a native report whose source no longer matches current files', async () => {
    const f = nativeVitestFixture();
    try {
      writeFileSync(join(f.repositoryRoot, f.testFile), 'changed after native reporter execution\n');
      await expect(readBudgetedTaskComparisonArtifacts(f.evidenceRoot, f.pins)).rejects.toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects a reporter report that records a skipped case', async () => {
    const f = nativeVitestFixture('skip');
    try { await expect(readBudgetedTaskComparisonArtifacts(f.evidenceRoot, f.pins)).rejects.toThrow(); }
    finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  function fixture(format: 'node-test' | 'vitest-json' = 'node-test') {
    const root = mkdtempSync(join(tmpdir(), 'r12-ordered-native-'));
    const repositoryRoot = join(root, 'repo');
    mkdirSync(join(repositoryRoot, 'app'), { recursive: true });
    const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const pin = (ref: string, value: unknown, raw = false) => {
      const bytes = raw ? String(value) : JSON.stringify(value);
      writeFileSync(join(root, ref), bytes);
      return { ref, sha256: digest(bytes) };
    };
    const taskId = 'app :: test';
    const file = 'app/repeated.test.mjs';
    const body = "import { test } from 'node:test'; import assert from 'node:assert/strict';\ntest('original assertion', () => assert.equal(2 + 2, 4));\n";
    writeFileSync(join(repositoryRoot, file), body);
    const collector = join(REPO_ROOT, 'libs/test-config/src/node-test-ledger-collector.ts');
    const native = spawnSync(process.execPath, ['--test', `--test-reporter=${collector}`, 'repeated.test.mjs'],
      { cwd: join(repositoryRoot, 'app'), encoding: 'utf8', timeout: 10_000 });
    if (native.status !== 0) throw new Error(`native collector fixture failed: ${native.stderr}`);
    const nodeReport = JSON.parse(native.stdout);
    if (nodeReport.files?.length !== 1 || nodeReport.files[0]?.file !== join(repositoryRoot, file)) {
      throw new Error(`native collector fixture population differs: ${JSON.stringify(nodeReport.files?.map(
        (row: { file: string; passed: number; failed: number }) => ({ file: row.file, passed: row.passed, failed: row.failed }),
      ))}; stderr=${native.stderr}`);
    }
    const command = format === 'node-test' ? 'node --test repeated.test.mjs' : 'vitest run';
    const packageBody = JSON.stringify({ scripts: { test: `${command} && ${command}` } });
    writeFileSync(join(repositoryRoot, 'app/package.json'), packageBody);
    const inputs = [{ path: file, sha256: digest(body) }, { path: 'app/package.json', sha256: digest(packageBody) }];
    const fileOccurrences = [0, 1].map(step => ({ task: taskId, step, command, file, kind: 'test-file' }));
    const task = { id: taskId, dir: 'app', script: 'test', command: `${command} && ${command}`,
      lifecycleCommands: [] as Array<{ script: string; command: string }>,
      steps: [0, 1].map(() => ({ command, script: 'test', files: [file] })) };
    const selection = { schemaVersion: 1, kind: 'full-gate', coverage: 'partial',
      unenumerated: ['runtime closure'], tasks: [task], commandObligations: [], fileOccurrences };
    const report = format === 'node-test' ? nodeReport : { success: true, numPassedTests: 1,
      numTotalTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0,
      testResults: [{ name: join(repositoryRoot, file), status: 'passed',
        assertionResults: [{ status: 'passed', failureMessages: [] }] }] };
    const receipts = [0, 1].map(step => ({ kind: 'original-native-command-execution', cwd: 'app',
      originalCommand: command, before: { inputs }, after: { inputs: structuredClone(inputs) },
      execution: { command: ['bash', '-lc', command], exitCode: 0, signal: null, error: null,
        startedAt: `2026-10-14T00:00:0${step * 2 + 1}Z`, completedAt: `2026-10-14T00:00:0${step * 2 + 2}Z`,
        stdout: `step${step}.out`, stderr: `step${step}.err`, report: `step${step}.report.json` } }));
    const steps = receipts.map((receipt, step) => ({ phase: 'test' as const, step, format,
      receipt: pin(`step${step}.json`, receipt), logs: {
        stdout: pin(receipt.execution.stdout, native.stdout, true),
        stderr: pin(receipt.execution.stderr, '', true), report: pin(receipt.execution.report, report) } }));
    const parent = { kind: 'original-native-command-execution', cwd: 'app', originalCommand: task.command,
      inputs: [inputs[1]], execution: { command: ['npm', 'run', 'test'], exitCode: 0, signal: null, error: null,
        startedAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:05Z', stdout: 'parent.out', stderr: 'parent.err' },
      steps: steps.map(({ phase, step, receipt }) => ({ phase, step, receipt })) };
    const pins = { mode: 'command-preparation' as const, repositoryRoot, commands: [],
      selection: pin('selection.log', `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`, true),
      chains: [{ task: taskId, receipt: pin('parent.json', parent), steps,
        logs: { stdout: pin('parent.out', native.stdout, true), stderr: pin('parent.err', '', true) } }] };
    const saveSelection = () => { pins.selection = pin('selection.log',
      `AFFECTED_TESTS_SELECTION=${JSON.stringify(selection)}\n`, true); };
    const saveParent = () => { pins.chains[0]!.receipt = pin('parent.json', parent); };
    const saveSteps = () => {
      receipts.forEach((receipt, i) => { steps[i]!.receipt = pin(`step${i}.json`, receipt); });
      parent.steps = steps.map(({ phase, step, receipt }) => ({ phase, step, receipt }));
      saveParent();
    };
    const saveReport = () => { steps[0]!.logs.report = pin('step0.report.json', report); };
    return { root, pins, selection, task, parent, receipts, steps, report, inputs, file, pin,
      saveSelection, saveParent, saveSteps, saveReport };
  }
  it.each(['node-test', 'vitest-json'] as const)
  ('rejects legacy %s chain receipts without native process binding', async format => {
    const f = fixture(format);
    try {
      await expect(readBudgetedTaskComparisonArtifacts(f.root, f.pins)).rejects.toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it('refuses an empty original evidence set before computing missing-chain coverage', async () => {
    const f = fixture();
    try {
      f.pins.chains = [];
      await expect(readBudgetedTaskComparisonArtifacts(f.root, f.pins))
        .rejects.toThrow('bounded original command pins required');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['missing-step', 'reversed-step', 'duplicate-chain', 'parent-binding', 'parent-exit', 'parent-command',
    'parent-signal', 'parent-wrapper', 'parent-source-drift', 'step-command', 'step-exit', 'step-signal',
    'interval-overlap', 'interval-outside-parent', 'input-drift', 'input-missing', 'source-drift',
    'occurrence-missing', 'occurrence-duplicate', 'occurrence-command', 'occurrence-kind', 'extra-occurrence',
    'report-missing-file', 'report-duplicate-file', 'report-skip', 'report-zero-tests', 'report-failed',
    'report-source-escape', 'receipt-reuse', 'log-role-alias', 'log-symlink-alias', 'log-drift',
    'wrong-runner-report', 'unsupported-lifecycle', 'parent-log-drift', 'parent-log-alias', 'undeclared-lifecycle'])
  ('refuses %s in original ordered evidence', async defect => {
    const f = fixture();
    try {
      if (defect === 'missing-step') f.steps.pop();
      if (defect === 'reversed-step') f.steps.reverse();
      if (defect === 'duplicate-chain') f.pins.chains.push(f.pins.chains[0]!);
      if (defect === 'parent-binding') { f.parent.steps[0]!.receipt.sha256 = 'a'.repeat(64); f.saveParent(); }
      if (defect === 'parent-exit') { f.parent.execution.exitCode = 1; f.saveParent(); }
      if (defect === 'parent-command') { f.parent.execution.command = ['npm', 'run', 'other']; f.saveParent(); }
      if (defect === 'parent-signal') { Object.assign(f.parent.execution, { signal: 'SIGTERM' }); f.saveParent(); }
      if (defect === 'parent-wrapper') { f.parent.originalCommand = 'other'; f.saveParent(); }
      if (defect === 'parent-source-drift') writeFileSync(join(f.pins.repositoryRoot, 'app/package.json'), '{}');
      if (defect === 'step-command') { f.receipts[0]!.execution.command = ['bash', '-lc', 'other']; f.saveSteps(); }
      if (defect === 'step-exit') { f.receipts[0]!.execution.exitCode = 1; f.saveSteps(); }
      if (defect === 'step-signal') { Object.assign(f.receipts[0]!.execution, { signal: 'SIGTERM' }); f.saveSteps(); }
      if (defect === 'interval-overlap') { f.receipts[1]!.execution.startedAt = f.receipts[0]!.execution.startedAt; f.saveSteps(); }
      if (defect === 'interval-outside-parent') { f.parent.execution.completedAt = '2026-10-14T00:00:03Z'; f.saveParent(); }
      if (defect === 'input-drift') { f.receipts[0]!.after.inputs[0]!.sha256 = 'a'.repeat(64); f.saveSteps(); }
      if (defect === 'input-missing') { f.receipts[0]!.before.inputs = [f.inputs[1]!];
        f.receipts[0]!.after.inputs = [f.inputs[1]!]; f.saveSteps(); }
      if (defect === 'source-drift') writeFileSync(join(f.pins.repositoryRoot, f.file), 'changed');
      if (defect === 'occurrence-missing') { f.selection.fileOccurrences.pop(); f.saveSelection(); }
      if (defect === 'occurrence-duplicate') { f.selection.fileOccurrences.push(f.selection.fileOccurrences[0]!); f.saveSelection(); }
      if (defect === 'occurrence-command') { f.selection.fileOccurrences[0]!.command = 'other'; f.saveSelection(); }
      if (defect === 'occurrence-kind') { f.selection.fileOccurrences[0]!.kind = 'check-input'; f.saveSelection(); }
      if (defect === 'extra-occurrence') { f.selection.fileOccurrences.push({ ...f.selection.fileOccurrences[0]!, step: 99 }); f.saveSelection(); }
      if (defect === 'report-missing-file') { f.report.files = []; f.saveReport(); }
      if (defect === 'report-duplicate-file') { f.report.files.push(f.report.files[0]); f.saveReport(); }
      if (defect === 'report-skip') { f.report.files[0].skipped = 1; f.saveReport(); }
      if (defect === 'report-zero-tests') { f.report.files[0].passed = 0; f.saveReport(); }
      if (defect === 'report-failed') { f.report.files[0].failed = 1; f.saveReport(); }
      if (defect === 'report-source-escape') { f.report.files[0].file = join(f.root, 'parent.json'); f.saveReport(); }
      if (defect === 'receipt-reuse') { f.steps[1]!.receipt = f.steps[0]!.receipt;
        f.parent.steps = f.steps.map(({ phase, step, receipt }) => ({ phase, step, receipt })); f.saveParent(); }
      if (defect === 'log-role-alias') f.steps[0]!.logs.stderr = f.steps[0]!.logs.stdout;
      if (defect === 'log-symlink-alias') {
        symlinkSync(join(f.root, 'step0.out'), join(f.root, 'alias.out'));
        f.steps[1]!.logs.stdout = { ...f.steps[0]!.logs.stdout, ref: 'alias.out' };
        f.receipts[1]!.execution.stdout = 'alias.out'; f.saveSteps();
      }
      if (defect === 'log-drift') writeFileSync(join(f.root, 'step0.out'), 'changed');
      if (defect === 'wrong-runner-report') Object.assign(f.steps[0]!, { format: 'vitest-json' });
      if (defect === 'parent-log-drift') writeFileSync(join(f.root, 'parent.out'), 'changed');
      if (defect === 'parent-log-alias') f.pins.chains[0]!.logs.stderr = f.pins.chains[0]!.logs.stdout;
      if (defect === 'undeclared-lifecycle') {
        const body = JSON.stringify({ scripts: { test: f.task.command, pretest: 'other' } });
        writeFileSync(join(f.pins.repositoryRoot, 'app/package.json'), body);
        f.inputs[1]!.sha256 = createHash('sha256').update(body).digest('hex'); f.saveParent();
      }
      if (defect === 'unsupported-lifecycle') { f.task.lifecycleCommands.push({ script: 'before', command: 'other' }); f.saveSelection(); }
      await expect(readBudgetedTaskComparisonArtifacts(f.root, f.pins)).rejects.toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

// HYGIENE, NOT A FIX — do not read this as the reason the timeouts went away.
//
// 33466aadb9 wrapped `runBudgetedTasks` in the SHARED, cross-process admission mutex
// (`papercusp-test-process-admission`, 4h timeout). A unit test asserting allocation
// logic has no business taking the production lock the real runner uses, so this
// redirects the lock root to a per-file temp dir: these tests take a REAL lock that
// nobody else contends on, and a leaked one cannot reach another process.
//
// It is worth being explicit that this did NOT fix the 9 timeouts, because I first
// believed it would and said so. Measured with this redirect in place and the mutex
// otherwise live: 552s / 9 timeouts / 12 failed — IDENTICAL to without it. So
// cross-process contention was never the cause. The real cause is the tick-count
// assumption documented on `until` below; see EI-21882326796062266 for the
// falsification.
//
// Deliberately not PAPERCUSP_DISABLE_FS_MUTEX: that removes the mechanism entirely
// and silently breaks the one test asserting the gate actually serializes.
// The gate test already redirects the root this same way and restores whatever it
// found — which is now this dir, so it keeps working unchanged.
let mutexLockRoot: string;
let previousMutexLockRoot: string | undefined;
beforeAll(() => {
  previousMutexLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  mutexLockRoot = mkdtempSync(join(tmpdir(), 'pc-budgeted-scheduler-locks-'));
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = mutexLockRoot;
});
afterAll(() => {
  if (previousMutexLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousMutexLockRoot;
  rmSync(mutexLockRoot, { recursive: true, force: true });
});

const config = {
  workerBudget: 4,
  memoryBudgetMb: 4096,
  workerMemoryMb: 1024,
  maxConcurrentTasks: 2,
  reserveWorkers: 1,
  // Hermeticity: `runBudgetedTaskShards` reads the LAUNCHER's PAPERCUSP_TASK_DEADLINE_EPOCH_MS
  // when this is undefined, and a launcher with a modest deadline (a capability:bash job with a
  // 40-minute timeout, a gate run near its budget) makes it print AFFECTED_TESTS_DEADLINE_TIGHT
  // through console.error — which vitest-fail-on-console turns into a red for a test that
  // measured nothing about the launcher. An explicit null means "no deadline" (the scheduler's
  // documented test setting); the deadline behaviour has its own explicit-deadline tests.
  deadlineEpochMs: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Wait for an OBSERVED condition instead of guessing how many ticks it takes.
 *
 * 33466aadb9 put an async filesystem-mutex acquisition (`withFsMutex`) in front of
 * task admission. `await Promise.resolve()` — one microtask — was enough to observe
 * admission before that, and is not now: the assertions saw `starts` still EMPTY.
 *
 * That cost far more than three assertion failures. A test that fails mid-flight
 * abandons a `runBudgetedTasks` which is still HOLDING the mutex (its fake `runTask`
 * gates never resolve, so `withFsMutex` never reaches its release). Every later call
 * in the process then blocked until vitest's 60s cap — 9 of them, ~9.2 min of every
 * canonical run, presenting as timeouts with no connection to the real defect.
 *
 * MEASURED: the first timing-out test PASSES ALONE in 13s (`-t`), and the first
 * assertion failure reproduces alone in 12s with 0 timeouts. So the timeouts are
 * collateral from the earlier failures, not independent hangs.
 *
 * Waiting on the signal is robust to however much async sits in front of admission,
 * which is the property a fixed tick count never had.
 */
async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((done) => setImmediate(done));
  }
}

describe('runBudgetedTasks', () => {
  it('gives the longest task all but one worker and overlaps the shortest on the reserved lane', async () => {
    const tasks = [
      { id: 'long', estimateMs: 100 },
      { id: 'medium', estimateMs: 50 },
      { id: 'short', estimateMs: 5 },
    ];
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const starts: Array<{ id: string; lane: string; workers: number }> = [];
    const running = runBudgetedTasks(tasks, {
      ...config,
      estimateMs: (task: (typeof tasks)[number]) => task.estimateMs,
      runTask: async (task: (typeof tasks)[number], allocation: { lane: string; workers: number }) => {
        starts.push({ id: task.id, lane: allocation.lane, workers: allocation.workers });
        return gates.get(task.id)!.promise;
      },
    });

    await until(() => starts.length >= 2, 'the first two admissions');
    expect(starts).toEqual([
      { id: 'long', lane: 'primary', workers: 3 },
      { id: 'short', lane: 'reserved', workers: 1 },
    ]);
    gates.get('short')!.resolve('short-result');
    await until(() => starts.length >= 3, 'the uncontended reserved lane refill');
    expect(starts[2]).toEqual({ id: 'medium', lane: 'reserved', workers: 1 });
    gates.get('medium')!.resolve('medium-result');
    gates.get('long')!.resolve('long-result');

    const result = await running;
    expect(result.results.map((entry: { task: { id: string } }) => entry.task.id)).toEqual(['long', 'medium', 'short']);
    expect(result.results.map((entry: { value: string }) => entry.value)).toEqual([
      'long-result',
      'medium-result',
      'short-result',
    ]);
    expect(result.stats.observedMaxWorkers).toBe(4);
    expect(result.stats.observedMaxMemoryMb).toBe(4096);
    expect(result.stats.observedMaxTasks).toBe(2);
  });

  it('funds two longest-first primary tasks and a shortest-first reserved task under a raised ceiling', async () => {
    const tasks = ['long', 'middle', 'pending', 'short'].map((id, index) => ({ id, estimateMs: 100 - index * 25 }));
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const starts: Array<{ id: string; lane: string; workers: number }> = [];
    const running = runBudgetedTasks(tasks, {
      ...config, workerBudget: 13, memoryBudgetMb: 13 * 1024, maxConcurrentTasks: 3,
      estimateMs: (task) => task.estimateMs,
      runTask: (task, allocation) => {
        starts.push({ id: task.id, lane: allocation.lane, workers: allocation.workers });
        return gates.get(task.id)!.promise;
      },
    });
    try {
      await until(() => starts.length === 3, 'three independently funded lanes');
      expect(starts).toEqual([
        { id: 'long', lane: 'primary', workers: 6 },
        { id: 'middle', lane: 'primary', workers: 6 },
        { id: 'short', lane: 'reserved', workers: 1 },
      ]);
      gates.get('middle')!.resolve('middle');
      await until(() => starts.length === 4, 'primary lane refill');
      expect(starts[3]).toEqual({ id: 'pending', lane: 'primary', workers: 6 });
    } finally {
      for (const [id, gate] of gates) gate.resolve(id);
      await running;
    }
    const result = await running;
    expect(result.results.map((entry) => entry.value)).toEqual(tasks.map((task) => task.id));
    expect(result.stats.observedMaxWorkers).toBe(13);
    expect(result.stats.observedMaxMemoryMb).toBe(13 * 1024);
    expect(result.stats.observedMaxTasks).toBe(3);
  });

  it('limits raised task concurrency to payable worker tokens and the pids envelope', async () => {
    for (const options of [
      { workerBudget: 3, memoryBudgetMb: 3072, maxConcurrentTasks: 10 },
      { workerBudget: 13, memoryBudgetMb: 13 * 1024, maxConcurrentTasks: 10, taskCgroupPidsMax: 9216 },
    ]) {
      const result = await runBudgetedTasks(['a', 'b', 'c', 'd'], {
        ...config, ...options,
        runTask: async () => { await new Promise<void>((done) => setImmediate(done)); },
      });
      expect(result.stats.observedMaxWorkers).toBeLessThanOrEqual(options.workerBudget);
      expect(result.stats.observedMaxMemoryMb).toBeLessThanOrEqual(options.memoryBudgetMb);
      expect(result.stats.observedMaxTasks).toBe(options.taskCgroupPidsMax ? 2 : 3);
      expect(result.results).toHaveLength(4);
    }
  });

  it('drains every raised lane after rejection without refilling a surviving lane', async () => {
    const tasks = ['long', 'middle', 'pending', 'short'].map((id, index) => ({ id, estimateMs: 100 - index * 25 }));
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const starts: string[] = [];
    const running = runBudgetedTasks(tasks, {
      ...config, workerBudget: 13, memoryBudgetMb: 13 * 1024, maxConcurrentTasks: 3,
      estimateMs: (task) => task.estimateMs,
      runTask: (task) => { starts.push(task.id); return gates.get(task.id)!.promise; },
    });
    let settled = false;
    const outcome = running.then(() => null, (error: Error) => error).finally(() => { settled = true; });
    try {
      await until(() => starts.length === 3, 'three lanes before rejection');
      gates.get('long')!.reject(new Error('primary failed'));
      await new Promise<void>((done) => setImmediate(done));
      gates.get('middle')!.resolve('middle');
      await new Promise<void>((done) => setImmediate(done));
      expect(starts).toEqual(['long', 'middle', 'short']);
      expect(settled).toBe(false);
      gates.get('short')!.resolve('short');
      expect((await outcome)?.message).toBe('primary failed');
    } finally {
      for (const [id, gate] of gates) gate.resolve(id);
      await outcome;
    }
  });

  it('publishes a settled task before an in-flight sibling lets the pool return', async () => {
    const tasks = [
      { id: 'long', estimateMs: 100 },
      { id: 'short', estimateMs: 5 },
    ];
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const settled: string[] = [];
    // Admission is the thing we have to wait for, so it has to be observable —
    // this test previously had no record of it and relied on a microtask tick.
    const started: string[] = [];
    let poolReturned = false;
    const running = runBudgetedTasks(tasks, {
      ...config,
      estimateMs: (task: (typeof tasks)[number]) => task.estimateMs,
      runTask: (task: (typeof tasks)[number]) => {
        started.push(task.id);
        return gates.get(task.id)!.promise;
      },
      onTaskSettled: (entry: { task: { id: string } }) => {
        settled.push(entry.task.id);
      },
    });
    void running.then(() => {
      poolReturned = true;
    });

    await until(() => started.length >= 2, 'both tasks to be admitted');
    gates.get('short')!.resolve('short-result');
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toEqual(['short']);
    expect(poolReturned).toBe(false);

    gates.get('long')!.resolve('long-result');
    await expect(running).resolves.toMatchObject({
      results: [{ task: { id: 'long' } }, { task: { id: 'short' } }],
    });
    expect(settled).toEqual(['short', 'long']);
  });

  it('lets the memory budget reduce the worker ceiling independently', async () => {
    const allocations: number[] = [];
    const result = await runBudgetedTasks(['a', 'b'], {
      ...config,
      workerBudget: 8,
      memoryBudgetMb: 2048,
      runTask: async (_task: string, allocation: { workers: number }) => {
        allocations.push(allocation.workers);
      },
    });
    expect(result.stats.effectiveWorkerBudget).toBe(2);
    expect(result.stats.observedMaxWorkers).toBeLessThanOrEqual(2);
    expect(result.stats.observedMaxMemoryMb).toBeLessThanOrEqual(2048);
    expect(allocations.sort()).toEqual([1, 1]);
  });

  it('collapses to serial when the global budget cannot fund a reserved lane', async () => {
    let active = 0;
    let highWater = 0;
    const result = await runBudgetedTasks(['a', 'b', 'c'], {
      ...config,
      workerBudget: 1,
      memoryBudgetMb: 1024,
      runTask: async () => {
        active++;
        highWater = Math.max(highWater, active);
        await Promise.resolve();
        active--;
      },
    });
    expect(result.stats.mode).toBe('serial');
    expect(result.stats.observedMaxWorkers).toBe(1);
    expect(result.stats.observedMaxTasks).toBe(1);
    expect(highWater).toBe(1);
  });

  it('honours an explicit one-task ceiling even when worker and memory tokens are plentiful', async () => {
    const result = await runBudgetedTasks(['a', 'b'], {
      ...config,
      maxConcurrentTasks: 1,
      runTask: async () => undefined,
    });
    expect(result.stats.mode).toBe('serial');
    expect(result.stats.observedMaxTasks).toBe(1);
    expect(result.stats.observedMaxWorkers).toBe(4);
  });

  it('rejects a memory budget that cannot admit even one worker token', () => {
    expect(() => resolveTaskBudget({ ...config, memoryBudgetMb: 512 })).toThrow(
      /cannot admit one workerMemoryMb=1024 token/,
    );
  });

  it('drains the other in-flight lane after a rejection without admitting another task', async () => {
    const tasks = [
      { id: 'long', estimateMs: 100 },
      { id: 'medium', estimateMs: 50 },
      { id: 'short', estimateMs: 5 },
    ];
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const starts: string[] = [];
    const running = runBudgetedTasks(tasks, {
      ...config,
      estimateMs: (task: (typeof tasks)[number]) => task.estimateMs,
      runTask: (task: (typeof tasks)[number]) => {
        starts.push(task.id);
        return gates.get(task.id)!.promise;
      },
    });
    const outcome = running.then(
      () => ({ error: null as Error | null }),
      (error: Error) => ({ error }),
    );

    await until(() => starts.length >= 2, 'long and short to be admitted');
    expect(starts).toEqual(['long', 'short']);
    gates.get('long')!.reject(new Error('primary failed'));
    await new Promise<void>((done) => setImmediate(done));
    expect(starts).toEqual(['long', 'short']);

    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gates.get('short')!.resolve('short-result');
    expect((await outcome).error?.message).toBe('primary failed');
    expect(starts).toEqual(['long', 'short']);
  });

  it('serializes concurrent scheduler invocations behind the shared process admission gate', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'pc-test-process-admission-'));
    const previousLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = lockRoot;
    const firstStarted = deferred<void>();
    const firstRelease = deferred<void>();
    const starts: string[] = [];
    let active = 0;
    let peak = 0;

    const runInvocation = (id: string, waitFor?: Promise<void>) =>
      runBudgetedTasks([id], {
        ...config,
        maxConcurrentTasks: 1,
        runTask: async () => {
          starts.push(id);
          active += 1;
          peak = Math.max(peak, active);
          if (id === 'first') firstStarted.resolve();
          if (waitFor) await waitFor;
          active -= 1;
          return id;
        },
      });

    try {
      const first = runInvocation('first', firstRelease.promise);
      await firstStarted.promise;

      const second = runInvocation('second');
      await new Promise<void>((resolveNext) => setImmediate(resolveNext));
      expect(starts).toEqual(['first']);
      expect(peak).toBe(1);

      firstRelease.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(starts).toEqual(['first', 'second']);
      expect(peak).toBe(1);
    } finally {
      if (previousLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
      else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousLockRoot;
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});

describe('task-sized shared admission (EI-26797533961242022)', () => {
  it('wires the real affected runner private ceiling separately from its shared envelope', async () => {
    const start = AFFECTED_TESTS_SRC.indexOf('const SCHEDULER_CONFIG = (() => {');
    const end = AFFECTED_TESTS_SRC.indexOf('\n})();', start) + '\n})();'.length;
    const makeBudget = (scope: string | null, max: number | null = 8192) =>
      new Script(AFFECTED_TESTS_SRC.slice(start, end) + '\nSCHEDULER_CONFIG;').runInNewContext({
        process: { env: { NODE_OPTIONS: '--max-old-space-size=131072', AFFECTED_MAX_CONCURRENT_TASKS: '4' } },
        TASK_CGROUP_MEMORY_MAX_MB: max, SCHEDULER_WORKER_BUDGET: 8,
        SCHEDULER_WORKER_MEMORY_MB: 1024, TASK_CGROUP_PIDS_MAX: null, MEM_AVAILABLE_MB: 1,
        readTaskCgroupMemoryScope: () => scope, resolveMemoryBudgetMb, resolveWorkerMemoryMb,
        resolveTaskBudget, refuseOnTaskBudget: (error: Error) => { throw error; },
      });
    const budget = makeBudget('cgroup:/fixture-private');
    expect(budget).toMatchObject({ memoryBudgetMb: 6144,
      memoryBudgetScope: 'cgroup:/fixture-private', sharedMemoryBudgetMb: 1_048_576 });
    expect(makeBudget(null)).not.toHaveProperty('memoryBudgetScope');
    expect(makeBudget('cgroup:/fixture-private', null)).not.toHaveProperty('memoryBudgetScope');
    const release = deferred<void>(), started = deferred<void>();
    const holder = withFsMutexBudget(admissionMutexName(), async () => {
      started.resolve(); await release.promise;
    }, { workers: 3, workerBudget: 8, maxConcurrentTasks: 4, resource: 'runner-host',
      workerMemoryMb: 131_072, memoryBudgetMb: 1_048_576, timeoutMs: 8000 });
    try {
      await started.promise;
      const result = await runBudgetedTasks(['runner-private'], { ...config, ...budget,
        admissionTimeoutMs: 1000, onAdmissionNotice: () => {}, taskAdmissionKey: task => task,
        runTask: async (_task, allocation) => allocation.workers,
      });
      // Shared worker accounting remains conservative: six effective private
      // worker tokens minus the host reader's three leaves three available.
      expect(result.results.map(row => row.value)).toEqual([3]);
    } finally { release.resolve(); await holder; }
  }, 20_000);

  it('rejects incomplete scoped budgets instead of silently granting unknown capacity', async () => {
    for (const fields of [
      { memoryBudgetScope: 'cgroup:/fixture' },
      { memoryBudgetScope: '', sharedMemoryBudgetMb: 10000 },
      { memoryBudgetScope: ' ', sharedMemoryBudgetMb: 10000 },
      { sharedMemoryBudgetMb: 10000 },
      { memoryBudgetScope: 'cgroup:/fixture', sharedMemoryBudgetMb: NaN },
    ]) {
      expect(() => resolveTaskBudget({ ...config, ...fields })).toThrow('Scoped admission');
      await expect(withFsMutexBudget(admissionMutexName(), async () => 'must-not-run', {
        workers: 1, workerBudget: 4, workerMemoryMb: 1024, memoryBudgetMb: 4096,
        maxConcurrentTasks: 2, resource: 'invalid', ...fields,
      })).rejects.toThrow('Scoped admission');
    }
  });

  it('reads a shared cgroup identity and preserves unknown identity on missing/malformed proc data', () => {
    expect(readTaskCgroupMemoryScope({ readFile: () => '0::/user.slice/task.scope\n' }))
      .toBe('cgroup:/user.slice/task.scope');
    for (const text of ['2:cpu:/legacy', '0::relative', '0::/../escape', ''])
      expect(readTaskCgroupMemoryScope({ readFile: () => text })).toBeNull();
    expect(readTaskCgroupMemoryScope({ readFile: () => { throw new Error('unreadable'); } })).toBeNull();
  });

  it('fails closed for a live reader with an incomplete scoped lease, then progresses after release', async () => {
    const readers = join(mutexLockRoot, `${admissionMutexName()}.readers`);
    const lease = join(readers, 'scoped-malformed.lock');
    mkdirSync(lease, { recursive: true });
    writeFileSync(join(lease, 'owner.json'), JSON.stringify({ pid: process.pid,
      host: 'fixture', startedAt: new Date().toISOString(),
      admission: { workers: 1, workerBudget: 8, memoryBudgetMb: 7168, workerMemoryMb: 1024,
        maxConcurrentTasks: 4, resource: 'malformed-holder', memoryBudgetScope: 'cgroup:/fixture' } }));
    const options = { workers: 1, workerBudget: 8, memoryBudgetMb: 7168, workerMemoryMb: 1024,
      maxConcurrentTasks: 4, resource: 'malformed-peer', memoryBudgetScope: 'cgroup:/peer',
      sharedMemoryBudgetMb: 65_536, timeoutMs: 100, retryMs: 5 };
    let ran = false;
    try {
      await expect(withFsMutexBudget(admissionMutexName(), async () => { ran = true; }, options))
        .rejects.toThrow('Timed out');
      expect(ran).toBe(false);
    } finally { rmSync(lease, { recursive: true, force: true }); }
    await expect(withFsMutexBudget(admissionMutexName(), async () => 'after-release', options))
      .resolves.toBe('after-release');
  });

  it('does not charge an unrelated reader against a private cgroup memory budget', async () => {
    const release = deferred<void>();
    let started = false;
    const holder = withFsMutexBudget(admissionMutexName(), async () => {
      started = true; await release.promise;
    }, { workers: 3, workerBudget: 8, maxConcurrentTasks: 4, resource: 'host-reader',
      workerMemoryMb: 131_072, memoryBudgetMb: 1_048_576, timeoutMs: 8_000 });
    try {
      await until(() => started, 'the host-budget reader');
      const run = runBudgetedTasks(['private'], { ...config,
        workerBudget: 8, maxConcurrentTasks: 4, memoryBudgetMb: 7168,
        memoryBudgetScope: 'cgroup:fixture-private', sharedMemoryBudgetMb: 1_048_576,
        admissionTimeoutMs: 1000, onAdmissionNotice: () => {}, taskAdmissionKey: task => task,
        runTask: async (_task, allocation) => allocation.workers });
      await expect(run).resolves.toMatchObject({ results: [{ value: 4 }] });
      // A different cgroup must still obey the host's explicitly shared budget.
      await expect(withFsMutexBudget(admissionMutexName(), async () => 'must-not-run', {
        workers: 1, workerBudget: 8, maxConcurrentTasks: 4, resource: 'capped-private',
        workerMemoryMb: 1024, memoryBudgetMb: 7168,
        memoryBudgetScope: 'cgroup:fixture-private', sharedMemoryBudgetMb: 393_216,
        timeoutMs: 100, retryMs: 5,
      })).rejects.toThrow('Timed out');
    } finally { release.resolve(); await holder; }
  }, 20_000);

  it('retains same-cgroup reservations and live legacy writer exclusion until release', async () => {
    const release = deferred<void>();
    let started = false, queued = false, peerStarted = false;
    const options = { workers: 1, workerBudget: 8, maxConcurrentTasks: 4,
      workerMemoryMb: 4096, memoryBudgetMb: 7168,
      memoryBudgetScope: 'cgroup:fixture-shared', sharedMemoryBudgetMb: 65_536,
      timeoutMs: 8000, retryMs: 5 };
    const holder = withFsMutexBudget(admissionMutexName(), async () => {
      started = true; await release.promise;
    }, { ...options, resource: 'same-cgroup-holder' });
    let peer: Promise<unknown> | undefined;
    try {
      await until(() => started, 'the same-cgroup reader');
      peer = withFsMutexBudget(admissionMutexName(), async () => { peerStarted = true; }, {
        ...options, resource: 'same-cgroup-peer', onWaiting: () => { queued = true; },
      });
      await until(() => queued, 'same-cgroup memory exclusion');
      expect(peerStarted).toBe(false);
    } finally { release.resolve(); await Promise.allSettled([holder, ...(peer ? [peer] : [])]); }
    expect(peerStarted).toBe(true);

    const start = AFFECTED_TESTS_SRC.indexOf('const admissionIntent = (() => {');
    const end = AFFECTED_TESTS_SRC.indexOf('\n})();', start) + '\n})();'.length;
    const intent = new Script(AFFECTED_TESTS_SRC.slice(start, end) + '\nadmissionIntent;')
      .runInNewContext({ ROOT: REPO_ROOT, readFileSync, createHash, join,
        process: { env: { AFFECTED_TESTS_DISCARDABLE: '1' } },
        TASK_CONTEXT_SHARD_PLAN: [], SCHEDULER_CONFIG: {}, durationHistory: {},
        taskKey: () => '', durationEstimate: () => 0,
        derivationSource: 'all', changedPathsOverride: null, changedPathTotal: 0,
        affected: [], tasks: [], estimateBudgetedTaskWallMs: () => ({
          projectedWallMs: 1000, knownWorkMs: 1000, knownTasks: 0,
          unknownTasks: 0, mode: 'parallel', maxConcurrentTasks: 2,
        }),
      });
    const sourceHash = createHash('sha256').update(AFFECTED_TESTS_SRC).digest('hex');
    const previousOwner = process.env.PAPERCUSP_SID;
    const previousTask = process.env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
    process.env.PAPERCUSP_SID = 'writer-fixture-owner';
    process.env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID = 'writer-fixture-task';
    const writerRelease = deferred<void>(), acquired = deferred<void>();
    let notice = '', queuedTaskStarted = false;
    let waitingTask: Promise<unknown> | undefined;
    const writer = withFsMutex(admissionMutexName(), async () => {
      acquired.resolve(); await writerRelease.promise;
    }, { intent });
    try {
      await acquired.promise;
      let ranUnderWriter = false;
      await expect(withFsMutexBudget(admissionMutexName(), async () => { ranUnderWriter = true; }, {
        ...options, resource: 'private-under-writer', timeoutMs: 100,
        onWaiting: info => { notice = formatAdmissionHolder(info.owner); },
      })).rejects.toThrow('Timed out');
      expect(ranUnderWriter).toBe(false);
      notice = '';
      waitingTask = runBudgetedTasks(['private-after-writer'], {
        ...config, admissionTimeoutMs: 8000, taskAdmissionKey: task => task,
        onAdmissionNotice: line => { notice = line; },
        runTask: async () => { queuedTaskStarted = true; return 'after-release'; },
      });
      await until(() => !!notice, 'the attributed writer-blocked scheduler notice');
      expect(queuedTaskStarted).toBe(false);
      expect(notice).toContain('AFFECTED_TESTS_ADMISSION_QUEUED');
      expect(notice).toContain('owner=writer-fixture-owner task=writer-fixture-task');
      expect(notice).toContain('caller=scripts/affected-tests.mjs');
      expect(notice).toContain(`sourceFileSha256=${sourceHash}`);
      expect(notice).toContain('discardable=true');
      expect(notice).toContain('constraints=writer');
    } finally {
      writerRelease.resolve(); await writer;
      await waitingTask;
      if (previousOwner === undefined) delete process.env.PAPERCUSP_SID;
      else process.env.PAPERCUSP_SID = previousOwner;
      if (previousTask === undefined) delete process.env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
      else process.env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID = previousTask;
    }
    expect(queuedTaskStarted).toBe(true);
    await expect(waitingTask).resolves.toMatchObject({ results: [{ value: 'after-release' }] });
  }, 20_000);

  it('reports a blocking reader and exact reservation constraints when no writer exists', async () => {
    const release = deferred<string>();
    let started = false, peerStarted = false;
    const notices: string[] = [];
    const options = { ...config, admissionTimeoutMs: 8_000,
      taskAdmissionKey: (task: string) => task, onAdmissionNotice: () => {} };
    const holder = withFsMutexBudget(admissionMutexName(), async () => {
      started = true; return release.promise;
    }, { workers: 3, workerBudget: 4, maxConcurrentTasks: 2, resource: 'reader-holder',
      workerMemoryMb: 131_072, memoryBudgetMb: 524_288,
      intent: { purpose: 'retained-matrix' }, timeoutMs: 8_000 });
    let peer: ReturnType<typeof runBudgetedTasks> | undefined;
    try {
      await until(() => started, 'the high-reservation reader');
      peer = runBudgetedTasks(['peer'], { ...options, maxConcurrentTasks: 1, memoryBudgetMb: 4096,
        onAdmissionNotice: line => { notices.push(line); },
        runTask: async () => { peerStarted = true; return 'peer'; } });
      await until(() => notices.length > 0, 'the reader-aware wait notice');
      expect(notices[0]).toContain(`pid=${process.pid}`);
      expect(notices[0]).toContain('resource=reader-holder');
      expect(notices[0]).toContain('purpose=retained-matrix');
      expect(notices[0]).toContain('constraints=task-cap,memory-reservation');
      expect(notices[0]).toContain('availableMemoryMb=-389120');
      expect(notices[0]).toContain('readers=1[');
      expect(notices[0]).not.toContain('(owner unknown)');
      expect(peerStarted).toBe(false);
    } finally {
      release.resolve('holder');
      await Promise.allSettled([holder, ...(peer ? [peer] : [])]);
    }
    expect(peerStarted).toBe(true);
  }, 20_000);

  it('identifies an eligible FIFO predecessor separately from resident readers', async () => {
    const root = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR!;
    const queue = join(root, `${admissionMutexName()}.queue`);
    const ticket = join(queue, '0000000000000-predecessor.ticket');
    mkdirSync(ticket, { recursive: true });
    writeFileSync(join(ticket, 'owner.json'), JSON.stringify({ pid: process.pid,
      startedAt: new Date().toISOString(), ownerId: 'fixture-owner', taskId: 'fixture-task',
      admission: { workers: 1, workerMemoryMb: 1024, workerBudget: 4, memoryBudgetMb: 4096,
        maxConcurrentTasks: 2, resource: 'older-config' } }));
    let notice: string | undefined, ran = false;
    const run = withFsMutexBudget(admissionMutexName(), async () => { ran = true; }, {
      workers: 1, workerMemoryMb: 1024, workerBudget: 4, memoryBudgetMb: 4096,
      maxConcurrentTasks: 2, resource: 'new-config', timeoutMs: 8_000, retryMs: 5,
      onWaiting: info => { notice = formatAdmissionHolder(info.owner); },
    });
    try {
      await until(() => !!notice, 'the eligible predecessor notice');
      expect(notice).toContain('constraints=queue-predecessor');
      expect(notice).toContain('owner=fixture-owner task=fixture-task');
      expect(notice).toContain(`predecessorPid=${process.pid} predecessorResource=older-config`);
      expect(notice).toContain('readers=0[');
      expect(ran).toBe(false);
    } finally {
      rmSync(ticket, { recursive: true, force: true });
      await run;
    }
    expect(ran).toBe(true);
  }, 20_000);

  it.each(['wildcard', 'memory'])('keeps %s exclusions across independent invocations', async mode => {
    const release = deferred<string>();
    let started = false, queued = false, peerStarted = false;
    const options = { ...config, admissionTimeoutMs: 8_000, onAdmissionNotice: () => {},
      taskAdmissionKey: (task: string) => mode === 'wildcard' && task === 'holder' ? '*' : task };
    const holder = runBudgetedTasks(['holder'], { ...options,
      workerMemoryMb: mode === 'memory' ? 4096 : config.workerMemoryMb,
      runTask: async () => { started = true; return release.promise; } });
    let peer: ReturnType<typeof runBudgetedTasks> | undefined;
    try {
      await until(() => started, 'the exclusive or memory-saturating holder');
      peer = runBudgetedTasks(['peer'], { ...options,
        onAdmissionNotice: (_, info) => { if (info.kind === 'queued') queued = true; },
        runTask: async () => { peerStarted = true; return 'peer'; } });
      await until(() => queued, 'the peer to encounter the shared exclusion');
      expect(peerStarted).toBe(false);
    } finally {
      release.resolve('holder');
      await Promise.allSettled([holder, ...(peer ? [peer] : [])]);
    }
    expect(peerStarted).toBe(true);
  }, 20_000);

  it('uses the spare lane for integration before a long unit child finishes, without multiplying workers', async () => {
    const long = deferred<string>(), short = deferred<string>(), peer = deferred<string>();
    const starts: string[] = [];
    let workers = 0, peakWorkers = 0, peerQueued = false;
    const options = { ...config, admissionTimeoutMs: 8_000,
      onAdmissionNotice: () => {},
      taskAdmissionKey: (task: { id: string }) => task.id,
      estimateMs: (task: { id: string }) => task.id === 'long' ? 100 : 1,
      runTask: async (task: { id: string }, allocation: { workers: number }) => {
        starts.push(task.id); workers += allocation.workers; peakWorkers = Math.max(peakWorkers, workers);
        try { return await ({ long, short, peer })[task.id as 'long' | 'short' | 'peer'].promise; }
        finally { workers -= allocation.workers; }
      },
    };
    const broad = runBudgetedTasks([{ id: 'long' }, { id: 'short' }], options);
    let narrow: ReturnType<typeof runBudgetedTasks> | undefined;
    try {
      await until(() => starts.length === 2, 'the broad active wave');
      narrow = runBudgetedTasks([{ id: 'peer' }], { ...options,
        onAdmissionNotice: (_, info) => { if (info.kind === 'queued') peerQueued = true; },
      });
      await until(() => peerQueued, 'integration to queue behind the full envelope');
      short.resolve('short');
      await until(() => starts.includes('peer'), 'integration to use the released lane while long remains resident');
      expect(starts).toHaveLength(3);
      expect(peakWorkers).toBeLessThanOrEqual(config.workerBudget);
      expect(workers).toBe(4); // long=3, integration is clamped to the remaining one token.
    } finally {
      long.resolve('long'); short.resolve('short'); peer.resolve('peer');
      await Promise.allSettled([broad, ...(narrow ? [narrow] : [])]);
    }
  }, 20_000);

  it('serializes duplicate configs but does not let their queued ticket block a disjoint config', async () => {
    const release = deferred<string>();
    let started = false, duplicateQueued = false, duplicates = 0, integration = false;
    const options = { ...config, admissionTimeoutMs: 8_000,
      onAdmissionNotice: () => {},
      taskAdmissionKey: (task: string) => task === 'integration' ? 'integration-config' : 'unit-config',
    };
    const holder = runBudgetedTasks(['holder', 'initial'], { ...options,
      estimateMs: task => task === 'holder' ? 100 : 1,
      runTask: async task => {
      if (task === 'initial') return 'initial';
      started = true; return release.promise;
    } });
    let duplicate: ReturnType<typeof runBudgetedTasks> | undefined;
    let independent: ReturnType<typeof runBudgetedTasks> | undefined;
    try {
      await until(() => started, 'the config holder');
      duplicate = runBudgetedTasks(['duplicate'], { ...options,
        onAdmissionNotice: (_, info) => { if (info.kind === 'queued') duplicateQueued = true; },
        runTask: async () => { duplicates++; return 'duplicate'; },
      });
      await until(() => duplicateQueued, 'the duplicate config to queue');
      independent = runBudgetedTasks(['integration'], { ...options, runTask: async () => {
        integration = true; return 'integration';
      } });
      await until(() => integration, 'the disjoint config to pass the blocked duplicate');
      expect(duplicates).toBe(0);
    } finally {
      release.resolve('holder');
      await Promise.allSettled([holder, ...(duplicate ? [duplicate] : []), ...(independent ? [independent] : [])]);
    }
    expect(duplicates).toBe(1);
  }, 20_000);

  it('releases a task lease after failure so the same config can run again', async () => {
    const options = { ...config, admissionTimeoutMs: 1_000, taskAdmissionKey: () => 'same-config', onAdmissionNotice: () => {} };
    await expect(runBudgetedTasks(['broken'], { ...options, runTask: async () => { throw new Error('fixture failure'); } }))
      .rejects.toThrow('fixture failure');
    await expect(runBudgetedTasks(['restored'], { ...options, runTask: async () => 'restored' }))
      .resolves.toMatchObject({ results: [{ value: 'restored' }] });
  });

  it('rechecks the launcher deadline after queueing and retains an attributable refusal before spawning', async () => {
    const acquired = deferred<void>(), release = deferred<void>();
    const holder = withFsMutex(admissionMutexName(), async () => { acquired.resolve(); await release.promise; });
    await acquired.promise;
    const runTask = vi.fn(async () => 'must-not-run');
    const running = runBudgetedTasks(['schema'], { ...config, runTask,
      admissionTimeoutMs: 8_000, deadlineEpochMs: Date.now() + 1_000,
      estimateMs: () => 50, taskAdmissionKey: () => 'integration-config', onAdmissionNotice: () => {},
    });
    const outcome = running.then(() => null, error => error as Error);
    try { await new Promise<void>(done => setTimeout(done, 1_200)); }
    finally { release.resolve(); await holder; }
    expect((await outcome)?.message).toContain('TASK_DEADLINE_REFUSAL');
    expect(runTask).not.toHaveBeenCalled();
  }, 20_000);
});

describe('cooperative shared admission (WI-10006150)', () => {
  it('rejects inputs changed while queued before starting a shard and releases admission', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(admissionMutexName(), async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    let fingerprint = 'baseline';
    let queued = false;
    const runTask = vi.fn(async (task: string) => task);
    const plan = planAffectedTaskShards(['first', 'second'], {
      blastRadius: { kind: 'scoped', reason: 'path-closure', triggerPaths: [] },
      taskKey: (task: string) => task,
      maxTasksPerShard: 2,
    });
    const running = runBudgetedTaskShards(plan, {
      ...config,
      admissionRunBudgetMs: 8_000,
      onAdmissionNotice: (_, info) => { if (info.kind === 'queued') queued = true; },
      onAdmissionAcquired: () => {
        if (fingerprint !== 'baseline') throw new Error('calibration input drift');
      },
      runTask,
    });
    // Observe the rejection before releasing the holder to avoid an unhandled
    // rejection racing the assertion. The failure occurs after FIFO admission.
    const rejected = expect(running).rejects.toThrow('calibration input drift');
    try {
      await until(() => queued, 'the calibration to queue');
      fingerprint = 'changed';
    } finally {
      release.resolve();
      await holder;
    }
    await rejected;
    expect(runTask).not.toHaveBeenCalled();
    await expect(runBudgetedTaskShards(plan, {
      ...config,
      admissionRunBudgetMs: 1_000,
      runTask,
    })).resolves.toMatchObject({ results: [{ value: 'first' }, { value: 'second' }] });
    expect(runTask).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('drains the active wave and lets a queued peer run before refilling the shard', async () => {
    const tasks = [
      { id: 'long', estimateMs: 100 },
      { id: 'medium', estimateMs: 50 },
      { id: 'short', estimateMs: 5 },
    ];
    const gates = new Map(tasks.map((task) => [task.id, deferred<string>()]));
    const events: string[] = [];
    const notices: string[] = [];
    const admissions: Array<{ waitedMs: number; budgetMs: number }> = [];
    const leaseIntents: Array<Record<string, unknown>> = [];
    let activeWorkers = 0;
    let observedWorkers = 0;
    let peerQueued = false;
    const running = runBudgetedTasks(tasks, {
      ...config,
      admissionTimeoutMs: 8_000,
      // Index-based history also proves a resumed task retains its original index.
      estimateMs: (_, index) => [100_000, 50_000, 5_000][index],
      admissionIntent: { purpose: 'yield-eta', tasks: 3, etaProjectedSec: 999 },
      readMemAvailableMb: () => 8192,
      onAdmissionNotice: (line) => notices.push(line),
      onAdmissionAcquired: (info) => {
        admissions.push(info);
        leaseIntents.push(JSON.parse(readFileSync(
          join(mutexLockRoot, `${admissionMutexName()}.lock`, 'owner.json'), 'utf8',
        )).intent);
      },
      runTask: async (task, allocation) => {
        events.push(task.id);
        activeWorkers += allocation.workers;
        observedWorkers = Math.max(observedWorkers, activeWorkers);
        try { return await gates.get(task.id)!.promise; }
        finally { activeWorkers -= allocation.workers; }
      },
    });
    await until(() => events.length === 2, 'the initial concurrent wave');
    const peer = runBudgetedTasks(['peer'], {
      ...config,
      onAdmissionNotice: (_, info) => { if (info.kind === 'queued') peerQueued = true; },
      runTask: async (_, allocation) => {
        events.push('peer');
        activeWorkers += allocation.workers;
        observedWorkers = Math.max(observedWorkers, activeWorkers);
        activeWorkers -= allocation.workers;
        return 'peer-result';
      },
    });
    await until(() => peerQueued, 'the peer FIFO ticket');
    gates.get('short')!.resolve('short-result');
    // Wait for the contention check, using its queue directory observation rather
    // than a guessed timer. The long child still owns the slot at this point.
    await until(() => readdirSync(join(mutexLockRoot, `${admissionMutexName()}.queue`)).length === 1,
      'the peer remains queued while the long child drains');
    gates.get('long')!.resolve('long-result');
    await peer;
    await until(() => events.length === 4, 'the remaining task to resume');
    gates.get('medium')!.resolve('medium-result');
    const result = await running;
    expect(events).toEqual(['long', 'short', 'peer', 'medium']);
    expect(result.results.map((entry) => [entry.index, entry.task.id, entry.value])).toEqual([
      [0, 'long', 'long-result'], [1, 'medium', 'medium-result'], [2, 'short', 'short-result'],
    ]);
    expect(observedWorkers).toBe(4);
    expect(result.stats.observedMaxWorkers).toBe(4);
    expect(result.stats.memoryReadings).toBe(2);
    expect(notices.some((line) => line.startsWith('AFFECTED_TESTS_ADMISSION_YIELD '))).toBe(true);
    expect(admissions).toHaveLength(2);
    expect(admissions[1].budgetMs).toBe(admissions[0].budgetMs - admissions[0].waitedMs);
    expect(leaseIntents).toEqual([
      { purpose: 'yield-eta', tasks: 3, etaProjectedSec: 100, etaWorkSec: 155,
        etaFromTasks: '3/3', etaUnknownTasks: 0, etaMode: 'parallel', etaConcurrency: 2 },
      { purpose: 'yield-eta', tasks: 1, etaProjectedSec: 50, etaWorkSec: 50,
        etaFromTasks: '1/1', etaUnknownTasks: 0, etaMode: 'parallel', etaConcurrency: 2 },
    ]);
  }, 20_000);

  it('retains one queue budget across a yield after an initial admission wait', async () => {
    const releaseInitial = deferred<void>();
    const initialAcquired = deferred<void>();
    const initial = withFsMutex(admissionMutexName(), async () => {
      initialAcquired.resolve();
      await releaseInitial.promise;
    });
    await initialAcquired.promise;
    const releaseFirst = deferred<void>();
    let firstStarted = false;
    let firstQueued = false;
    let peerQueued = false;
    const admissions: Array<{ waitedMs: number; budgetMs: number }> = [];
    const running = runBudgetedTasks(['first', 'remaining'], {
      ...config,
      maxConcurrentTasks: 1,
      admissionTimeoutMs: 8_000,
      onAdmissionNotice: (_, info) => { if (info.kind === 'queued') firstQueued = true; },
      onAdmissionAcquired: (info) => admissions.push(info),
      runTask: async (task) => {
        if (task === 'first') { firstStarted = true; await releaseFirst.promise; }
        return task;
      },
    });
    await until(() => firstQueued, 'the initial queue wait');
    await new Promise<void>((done) => setTimeout(done, 300));
    releaseInitial.resolve();
    await initial;
    await until(() => firstStarted, 'the first task to start');
    const peer = runBudgetedTasks(['peer'], {
      ...config,
      onAdmissionNotice: (_, info) => { if (info.kind === 'queued') peerQueued = true; },
      runTask: async () => 'peer',
    });
    await until(() => peerQueued, 'the peer to queue');
    releaseFirst.resolve();
    await Promise.all([running, peer]);
    expect(admissions).toHaveLength(2);
    expect(admissions[0].waitedMs).toBeGreaterThanOrEqual(250);
    expect(admissions[1].budgetMs).toBe(8_000 - admissions[0].waitedMs);
  }, 20_000);

  it('drains a failed wave and its persistence before releasing to a queued peer', async () => {
    const failLong = deferred<string>();
    const finishShort = deferred<string>();
    const finishPersistence = deferred<void>();
    let persistenceStarted = false;
    let queued = false;
    const starts: string[] = [];
    const running = runBudgetedTasks([
      { id: 'long', estimateMs: 100 }, { id: 'remaining', estimateMs: 50 }, { id: 'short', estimateMs: 5 },
    ], {
      ...config,
      estimateMs: (task) => task.estimateMs,
      onAdmissionNotice: () => undefined,
      runTask: async (task) => {
        starts.push(task.id);
        return task.id === 'long' ? failLong.promise : finishShort.promise;
      },
      onTaskSettled: async () => { persistenceStarted = true; await finishPersistence.promise; },
    });
    const failure = running.catch((error: Error) => error.message);
    await until(() => starts.length === 2, 'the failed wave to start');
    const peer = runBudgetedTasks(['peer'], {
      ...config,
      onAdmissionNotice: (_, info) => { if (info.kind === 'queued') queued = true; },
      runTask: async () => { starts.push('peer'); return 'peer'; },
    });
    await until(() => queued, 'the peer to wait on the failed wave');
    failLong.reject(new Error('failed child'));
    finishShort.resolve('short');
    await until(() => persistenceStarted, 'the surviving child persistence');
    expect(starts).toEqual(['long', 'short']);
    finishPersistence.resolve();
    expect(await failure).toBe('failed child');
    await peer;
    expect(starts).toEqual(['long', 'short', 'peer']);
  }, 20_000);
});

describe('near-tree-wide deterministic sharding (P-011)', () => {
  const broad = classifyAffectedBlastRadius({ changedPaths: ['package-lock.json'] });

  it('classifies root manifests/config as near-tree-wide and ordinary source as scoped', () => {
    expect(broad).toMatchObject({ kind: 'near-tree-wide', reason: 'root-manifest-or-config' });
    expect(classifyAffectedBlastRadius({ changedPaths: ['tsconfig.base.json'] }).kind).toBe('near-tree-wide');
    expect(classifyAffectedBlastRadius({ changedPaths: ['packages/operator-core/lib/a.ts'] }).kind).toBe('scoped');
    expect(classifyAffectedBlastRadius({ runAll: true }).reason).toBe('all-requested');
    expect(classifyAffectedBlastRadius({ derivationDegraded: true }).reason).toBe('derivation-degraded');
  });

  it('preserves the exact union once, in declaration order, across bounded shards', () => {
    const tasks = Array.from({ length: 10 }, (_, id) => ({ id }));
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: broad,
      maxTasksPerShard: 3,
      taskKey: (task) => task.id,
    });
    expect(plan.shards.map((shard) => shard.tasks.length)).toEqual([3, 3, 3, 1]);
    expect(plan.shards.flatMap((shard) => shard.tasks.map((task) => task.id))).toEqual(tasks.map((task) => task.id));
    expect(new Set(plan.shards.flatMap((shard) => shard.taskKeys)).size).toBe(tasks.length);
    expect(formatAffectedTaskShardMarker(plan, 8192)).toContain('shards=4');
  });

  it('fails before launch when the finalized task set contains a duplicate', () => {
    expect(() =>
      planAffectedTaskShards([{ id: 'a' }, { id: 'a' }], {
        blastRadius: broad,
        maxTasksPerShard: 2,
        taskKey: (task) => task.id,
      }),
    ).toThrow(/duplicate affected task/);
  });

  it('runs shards sequentially while keeping each shard under the scheduler topology cap', async () => {
    const tasks = Array.from({ length: 7 }, (_, id) => ({ id }));
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: broad,
      maxTasksPerShard: 3,
      taskKey: (task) => task.id,
    });
    let active = 0;
    let peak = 0;
    const run = await runBudgetedTaskShards(plan, {
      ...config,
      runTask: async (task) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return task.id;
      },
    });
    expect(run.results.map((entry) => entry.value)).toEqual(tasks.map((task) => task.id));
    expect(run.shardStats).toHaveLength(3);
    expect(peak).toBeLessThanOrEqual(config.maxConcurrentTasks);
    expect(run.stats.observedMaxWorkers).toBeLessThanOrEqual(config.workerBudget);
  });

  it('projects wall time from the concurrent lane policy instead of summing serial work', () => {
    const tasks = [{ id: 'long' }, { id: 'short' }, { id: 'middle' }];
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: { kind: 'scoped', reason: 'path-closure', triggerPaths: [] },
      taskKey: (task) => task.id,
    });
    const projection = estimateBudgetedTaskWallMs(plan, {
      ...config,
      estimateMs: (task: { id: string }) => ({ long: 10_000, short: 1_000, middle: 4_000 })[task.id],
    });

    // The primary lane starts the 10s task, the reserved lane starts the 1s task and then the
    // 4s task. The serial-equivalent sum is 15s, but the actual two-lane wall projection is 10s.
    expect(projection).toMatchObject({
      projectedWallMs: 10_000,
      knownWorkMs: 15_000,
      knownTasks: 3,
      unknownTasks: 0,
      mode: 'parallel',
      maxConcurrentTasks: 2,
    });
  });

  it.each([
    { name: 'mixed known and unknown history', durations: [90_000, 30_000, null, 12_000],
      estimates: [
        { etaProjectedSec: 90, etaWorkSec: 120, etaFromTasks: '2/2', etaUnknownTasks: 0 },
        { etaProjectedSec: 12, etaWorkSec: 12, etaFromTasks: '1/2', etaUnknownTasks: 1 },
      ] },
    { name: 'no duration history', durations: [null, null, null, null],
      estimates: [
        { etaProjectedSec: 0, etaWorkSec: 0, etaFromTasks: '0/2', etaUnknownTasks: 2 },
        { etaProjectedSec: 0, etaWorkSec: 0, etaFromTasks: '0/2', etaUnknownTasks: 2 },
      ] },
  ])('publishes current-shard lease ETA with $name', async ({ durations, estimates }) => {
    const tasks = Array.from({ length: 4 }, (_, id) => ({ id }));
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: broad, maxTasksPerShard: 2, taskKey: (task) => task.id,
    });
    const unrelated = { scope: 'git-status', paths: 11, workspaces: 4,
      workItem: 'EI-25482105942475587', discardable: true };
    const original = Object.freeze({ ...unrelated, tasks: 4, etaProjectedSec: 999,
      etaWorkSec: 999, etaFromTasks: '4/4', etaUnknownTasks: 0,
      etaMode: 'serial', etaConcurrency: 1 });
    // The real fs-mutex contract caps declarations at twelve scalar fields.
    expect(Object.keys(original)).toHaveLength(12);
    const leases: Array<Record<string, unknown>> = [];
    const run = await runBudgetedTaskShards(plan, {
      ...config, admissionIntent: original,
      estimateMs: (task) => durations[task.id],
      onAdmissionAcquired: () => leases.push(JSON.parse(readFileSync(
        join(mutexLockRoot, `${admissionMutexName()}.lock`, 'owner.json'), 'utf8',
      )).intent),
      runTask: async (task) => task.id,
    });
    expect(run.results.map((entry) => entry.value)).toEqual([0, 1, 2, 3]);
    expect(leases).toEqual(estimates.map((estimate) => ({ ...unrelated, tasks: 2,
      ...estimate, etaMode: 'parallel', etaConcurrency: 2 })));
    for (const lease of leases) {
      if (lease.etaFromTasks === '0/2') {
        expect(formatAdmissionProspect(JSON.stringify({ intent: lease }),
          { elapsedMs: 0, budgetMs: 60_000 })).toContain('PROSPECT UNKNOWN');
      }
    }
    expect(original).toEqual({ ...unrelated, tasks: 4, etaProjectedSec: 999,
      etaWorkSec: 999, etaFromTasks: '4/4', etaUnknownTasks: 0,
      etaMode: 'serial', etaConcurrency: 1 });
  });

  it('projects raised primary lanes with the same launch order as execution', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: { kind: 'scoped', reason: 'path-closure', triggerPaths: [] },
      taskKey: (task) => task.id,
    });
    const projection = estimateBudgetedTaskWallMs(plan, {
      ...config, workerBudget: 13, memoryBudgetMb: 13 * 1024, maxConcurrentTasks: 3,
      estimateMs: () => 10_000,
    });
    expect(projection).toMatchObject({ projectedWallMs: 20_000, knownWorkMs: 50_000, maxConcurrentTasks: 3 });
  });

  it('falls back to serial-equivalent wall time when concurrency is disabled', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }];
    const plan = planAffectedTaskShards(tasks, {
      blastRadius: { kind: 'scoped', reason: 'path-closure', triggerPaths: [] },
      taskKey: (task) => task.id,
    });
    const projection = estimateBudgetedTaskWallMs(plan, {
      ...config,
      maxConcurrentTasks: 1,
      estimateMs: (task: { id: string }) => ({ a: 10_000, b: 1_000 })[task.id],
    });

    expect(projection).toMatchObject({
      projectedWallMs: 11_000,
      knownWorkMs: 11_000,
      mode: 'serial',
      maxConcurrentTasks: 1,
    });
  });
});

describe('runBudgetedTasks memory-aware admission (EI-20801764054303492 route (a))', () => {
  // Serialised so each admission is a separate, ordered event: the clamp is a per-ADMISSION
  // decision, and interleaved lanes would make the assertion order-dependent rather than wrong.
  const serialConfig = { ...config, maxConcurrentTasks: 1 };

  /** Readings are consumed in order; the last one repeats once exhausted. */
  function readerFrom(readings: Array<number | null>) {
    let i = 0;
    const calls: number[] = [];
    const read = () => {
      const value = readings[Math.min(i, readings.length - 1)];
      i += 1;
      calls.push(i);
      return value;
    };
    return { read, callCount: () => calls.length };
  }

  async function widthsFor(options: Record<string, unknown>) {
    const widths: number[] = [];
    const result = await runBudgetedTasks(['a', 'b', 'c'], {
      ...serialConfig,
      ...options,
      runTask: async (_task: string, allocation: { workers: number }) => {
        widths.push(allocation.workers);
      },
    });
    return { widths, stats: result.stats };
  }

  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: admission is no longer narrowed
  // by the reading. The MEASUREMENT is still taken and still reported (memoryReadings,
  // lastMemAvailableMb) — losing the observability was never the goal — but it no longer moves
  // the lane width, so admissionClamps is now always 0.
  it('still MEASURES memory each admission, but no longer clamps the width', async () => {
    // Previously: 3000MB afforded 2 workers and 2000MB afforded 1, against a 4-worker lane.
    const reader = readerFrom([3000, 2000]);
    const { widths, stats } = await widthsFor({ readMemAvailableMb: reader.read });

    expect(widths[0]).toBe(4);
    expect(widths.slice(1)).toEqual([4, 4]);
    // The reader is still consulted on every post-startup admission — the telemetry survives.
    expect(reader.callCount()).toBe(2);
    expect(stats.memoryReadings).toBe(2);
    expect(stats.admissionClamps).toBe(0);
    expect(stats.minAdmittedWorkers).toBe(4);
    expect(stats.lastMemAvailableMb).toBe(2000);
  });

  it('never lets a clamped run exceed the peak of the same run unclamped', async () => {
    const unclamped = await widthsFor({});
    const clamped = await widthsFor({ readMemAvailableMb: readerFrom([2000]).read });

    expect(clamped.stats.observedMaxWorkers).toBeLessThanOrEqual(unclamped.stats.observedMaxWorkers);
    expect(clamped.stats.observedMaxMemoryMb).toBeLessThanOrEqual(unclamped.stats.observedMaxMemoryMb);
    // The peak can still be SET by the unmeasured first admission — that is the documented cost
    // of skipping the re-measure there, pinned so a future change to that rule is visible.
    expect(clamped.widths[0]).toBe(unclamped.widths[0]);
  });

  it('leaves allocations byte-identical to a no-reader run when the reading is null', async () => {
    const baseline = await widthsFor({});
    const withNullReader = await widthsFor({ readMemAvailableMb: () => null });

    expect(withNullReader.widths).toEqual(baseline.widths);
    expect(withNullReader.stats.observedMaxWorkers).toBe(baseline.stats.observedMaxWorkers);
    expect(withNullReader.stats.observedMaxMemoryMb).toBe(baseline.stats.observedMaxMemoryMb);
    expect(withNullReader.stats.admissionClamps).toBe(0);
    // A null reading is still a READING — it just carries no number to clamp with.
    expect(withNullReader.stats.memoryReadings).toBe(2);
    expect(withNullReader.stats.lastMemAvailableMb).toBeNull();
    // No reader at all reports null, which is what keeps the legacy marker string intact.
    expect(baseline.stats.memoryReadings).toBeNull();
  });

  it('does not fail the run when the reader THROWS', async () => {
    const baseline = await widthsFor({});
    const { widths, stats } = await widthsFor({
      readMemAvailableMb: () => {
        throw new Error('meminfo unreadable');
      },
    });

    // A broken instrument must not read as "no memory" — that would throttle a healthy box to 1.
    expect(widths).toEqual(baseline.widths);
    expect(stats.admissionClamps).toBe(0);
    expect(stats.memoryReadings).toBe(0);
  });

  it('keeps the full lane even at a zero reading (WI-41206)', async () => {
    // The old contract narrowed to a single worker here. The reasoning behind that floor —
    // "refusing admission outright would deadlock a run already under memory pressure" — is
    // exactly the argument extended: the run proceeds at full width and the host slows itself
    // through real contention rather than through a pre-emptive narrowing.
    const { widths, stats } = await widthsFor({ readMemAvailableMb: () => 0 });

    expect(widths.slice(1).every((w) => w === 4)).toBe(true);
    expect(stats.minAdmittedWorkers).toBe(4);
    expect(stats.admissionClamps).toBe(0);
  });
});

describe('resolveGlobalWorkerBudget', () => {
  it('keeps the green-checkpoint two-fork rail binding when modern max-workers was filled higher', () => {
    expect(
      resolveGlobalWorkerBudget({
        vitestMaxWorkers: '12',
        vitestMaxForks: '2',
        vitestMaxThreads: '2',
        fallback: 12,
      }),
    ).toBe(2);
  });

  it('lets an affected-tests-specific ceiling tighten but never widen an inherited limit', () => {
    expect(
      resolveGlobalWorkerBudget({
        affectedWorkerBudget: '1',
        vitestMaxWorkers: '12',
        fallback: 12,
      }),
    ).toBe(1);
    expect(
      resolveGlobalWorkerBudget({
        affectedWorkerBudget: '16',
        vitestMaxWorkers: '4',
        fallback: 12,
      }),
    ).toBe(4);
  });
});

describe('resolveWorkerMemoryMb', () => {
  it('accounts for the inherited V8 heap instead of understating a gate worker as 1 GiB', () => {
    expect(
      resolveWorkerMemoryMb({
        nodeOptions: '--expose-gc --max-old-space-size=4096',
        fallback: 1024,
      }),
    ).toBe(4096);
  });

  it('accepts both NODE_OPTIONS spellings and never lets an explicit estimate shrink the heap', () => {
    expect(
      resolveWorkerMemoryMb({
        affectedWorkerMemoryMb: '2048',
        nodeOptions: '--max_old_space_size 8192',
        fallback: 1024,
      }),
    ).toBe(8192);
  });

  // WI-10002092, a RECURRENCE of EI-23242580927683488 (closed as a stale-runtime report with no
  // source edit; reproduced six days later with byte-identical numbers). `--max-old-space-size` is
  // a heap CEILING, not a reservation. The bare `Math.max` above read an agent shell's ambient
  // 128 GiB ceiling as a 128 GiB-per-worker DEMAND, so `resolveMemoryBudgetMb` refused before
  // launch inside every ~6 GiB agent task cgroup and `test:affected` ran ZERO tasks.
  describe('an inherited heap ceiling is not a per-worker reservation (WI-10002092)', () => {
    // The exact reproduction: TASK_BUDGET_REFUSAL kind=memory limit=6144 reserve=1536 required=131072.
    const AGENT_NODE_OPTIONS = '--max-old-space-size=131072 --expose-gc';
    const AGENT_CGROUP_MB = 6144;
    const AGENT_CGROUP_BUDGET_MB = 4608; // floor(6144 * (1 - MEMORY_RESERVE_FRACTION))

    it('disregards a ceiling the task cgroup could never pay for, leaving the estimate to size the token', () => {
      expect(
        resolveWorkerMemoryMb({
          nodeOptions: AGENT_NODE_OPTIONS,
          fallback: 1024,
          taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
        }),
      ).toBe(1024);
    });

    it('announces each disregarded candidate rather than silently changing admitted concurrency', () => {
      const notices: string[] = [];
      resolveWorkerMemoryMb({
        nodeOptions: AGENT_NODE_OPTIONS,
        fallback: 1024,
        taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
        onNotice: (line) => notices.push(line),
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('131072MB');
      expect(notices[0]).toContain(`${AGENT_CGROUP_BUDGET_MB}MB`);
      expect(notices[0]).toContain('not a per-worker reservation');
    });

    it('keeps an explicit AFFECTED_WORKER_MEMORY_MB authoritative when the ambient ceiling is disregarded', () => {
      expect(
        resolveWorkerMemoryMb({
          affectedWorkerMemoryMb: '2048',
          nodeOptions: AGENT_NODE_OPTIONS,
          fallback: 1024,
          taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
        }),
      ).toBe(2048);
    });

    // The property the pre-fix docstring defended, now asserted WITH an envelope in play: a
    // deliberate sizing that fits is still credible and must still raise the token.
    it('credits a ceiling that fits the envelope, so the gate 4 GiB fork pin still raises the token', () => {
      expect(
        resolveWorkerMemoryMb({
          nodeOptions: '--expose-gc --max-old-space-size=4096',
          fallback: 1024,
          taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
        }),
      ).toBe(4096);
    });

    it('draws the credibility line at exactly what one task can pay for', () => {
      expect(
        resolveWorkerMemoryMb({
          nodeOptions: `--max-old-space-size=${AGENT_CGROUP_BUDGET_MB}`,
          fallback: 1024,
          taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
        }),
      ).toBe(AGENT_CGROUP_BUDGET_MB);
      expect(
        resolveWorkerMemoryMb({
          nodeOptions: `--max-old-space-size=${AGENT_CGROUP_BUDGET_MB + 1}`,
          fallback: 1024,
          taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
        }),
      ).toBe(1024);
    });

    it('leaves the prior behaviour exact when the cgroup is unbounded or unreadable', () => {
      // readTaskCgroupMemoryMaxMb yields null for `max`/unreadable. With no envelope there is
      // nothing to judge credibility against, so every candidate still stands.
      for (const envelope of [undefined, null, ''] as const) {
        expect(
          resolveWorkerMemoryMb({
            nodeOptions: AGENT_NODE_OPTIONS,
            fallback: 1024,
            taskCgroupMemoryMaxMb: envelope,
          }),
        ).toBe(131072);
      }
    });

    it('validates a nonsensical reserve fraction instead of silently disarming the credibility test', () => {
      expect(() =>
        resolveWorkerMemoryMb({
          nodeOptions: AGENT_NODE_OPTIONS,
          fallback: 1024,
          taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
          cgroupReserveFraction: 1,
        }),
      ).toThrow(/cgroupReserveFraction must be in \[0, 1\)/);
    });

    // Both rails together — this pair IS the reported symptom and its boundary.
    it('reaches a live budget for the agent-shell case instead of refusing before launch', () => {
      const workerMemoryMb = resolveWorkerMemoryMb({
        nodeOptions: AGENT_NODE_OPTIONS,
        fallback: 1024,
        taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
      });
      const budgetMb = resolveMemoryBudgetMb({
        memAvailableMb: 200_000,
        taskCgroupMemoryMaxMb: AGENT_CGROUP_MB,
        workerBudget: 4,
        workerMemoryMb,
      });
      expect(budgetMb).toBe(4096);
      expect(Math.floor(budgetMb / workerMemoryMb)).toBe(4);
    });

    it('still refuses when the cgroup cannot pay for even one ESTIMATED worker', () => {
      // The refusal is not removed — only stopped from firing on a number that was never a
      // requirement. A genuinely too-small cgroup is exactly what it was built to catch.
      const workerMemoryMb = resolveWorkerMemoryMb({
        nodeOptions: AGENT_NODE_OPTIONS,
        fallback: 1024,
        taskCgroupMemoryMaxMb: 1024,
      });
      expect(workerMemoryMb).toBe(1024);
      expect(() =>
        resolveMemoryBudgetMb({
          memAvailableMb: 200_000,
          taskCgroupMemoryMaxMb: 1024,
          workerBudget: 4,
          workerMemoryMb,
        }),
      ).toThrow(/refusing before launch/);
    });

    it('wires the envelope into the real call site, read BEFORE the token is sized', () => {
      const tokenAt = AFFECTED_TESTS_SRC.indexOf(
        'const SCHEDULER_WORKER_MEMORY_MB = resolveWorkerMemoryMb({',
      );
      const envelopeAt = AFFECTED_TESTS_SRC.indexOf(
        'const TASK_CGROUP_MEMORY_MAX_MB = readTaskCgroupMemoryMaxMb()',
      );
      expect(tokenAt).toBeGreaterThan(-1);
      expect(envelopeAt).toBeGreaterThan(-1);
      // Move the read back below the token and the credibility test is disarmed at the one call
      // site that actually suffers the bug, while every unit case above still passes.
      expect(envelopeAt).toBeLessThan(tokenAt);
      const call = AFFECTED_TESTS_SRC.slice(tokenAt, tokenAt + 900);
      expect(call).toContain('taskCgroupMemoryMaxMb: TASK_CGROUP_MEMORY_MAX_MB');
      expect(call).toContain('onNotice:');
    });
  });
});

describe('resolveMemoryBudgetMb', () => {
  // WI-39472: the caller's old default (workerBudget * workerMemoryMb) made memoryWorkerBudget
  // identically equal to workerBudget, so resolveTaskBudget's Math.min could NEVER bind and the
  // memory rail was inert. These cases pin the property that made it inert, so a regression to
  // the old default fails here rather than silently un-arming the clamp again.
  const base = { workerBudget: 8, workerMemoryMb: 1024 };

  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: these three asserted that the
  // reading BOUND the budget. It no longer does — a host driven into paging should slow down
  // from real contention, not from a snapshot narrowing the lane pre-emptively. The ceiling
  // property (never widen past the worker budget) is unchanged and still pinned below.
  it('does NOT bind on available memory — a loaded host keeps its full worker ceiling', () => {
    // Previously: 4096 MiB available, 25% reserved => 3072 usable => 3 tokens.
    const budget = resolveMemoryBudgetMb({ ...base, memAvailableMb: 4096 });
    expect(budget).toBe(8 * 1024);
    expect(
      resolveTaskBudget({ ...base, memoryBudgetMb: budget, maxConcurrentTasks: 8, reserveWorkers: 1 }),
    ).toMatchObject({
      memoryWorkerBudget: 8,
      effectiveWorkerBudget: 8,
    });
  });

  it('NEVER widens the budget past the worker ceiling, however much memory is free', () => {
    // Unchanged by WI-41206: the ceiling is a WORKER budget, not a memory one.
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 1024 * 1024 })).toBe(8 * 1024);
  });

  it('a near-zero reading no longer degrades the host to serial', () => {
    // Previously 100 MiB available floored the budget to a single 1024 MiB worker.
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 100 })).toBe(8 * 1024);
    expect(() =>
      resolveTaskBudget({ ...base, memoryBudgetMb: 8 * 1024, maxConcurrentTasks: 8, reserveWorkers: 1 }),
    ).not.toThrow();
  });

  it('returns the SAME budget for every reading, all else equal (WI-41206 regression guard)', () => {
    const at = (memAvailableMb: number) => resolveMemoryBudgetMb({ ...base, memAvailableMb });
    expect(at(100)).toBe(at(1024 * 1024));
  });

  it('lets an explicit AFFECTED_GLOBAL_MEMORY_MB win over the measured host', () => {
    expect(resolveMemoryBudgetMb({ ...base, affectedGlobalMemoryMb: '2048', memAvailableMb: 999_999 })).toBe(2048);
  });

  it('caps against the hard task cgroup memory.max without re-arming host-memory heuristics', () => {
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: 1, taskCgroupMemoryMaxMb: 4096 })).toBe(3072);
    expect(
      resolveMemoryBudgetMb({
        ...base,
        affectedGlobalMemoryMb: 7000,
        taskCgroupMemoryMaxMb: 4096,
      }),
    ).toBe(3072);
    expect(() =>
      resolveMemoryBudgetMb({
        ...base,
        taskCgroupMemoryMaxMb: 1024,
      }),
    ).toThrow(/refusing before launch/);
  });

  // P-006: a requested budget must be resolved before declaring experiment workers.
  it.each([
    { hardGiB: 40, budgetMiB: 30 * 1024, workers: 7 },
    { hardGiB: 44, budgetMiB: 32 * 1024, workers: 8 },
  ])('resolves eight 4 GiB tokens under a $hardGiB GiB hard envelope to $workers workers', ({ hardGiB, budgetMiB, workers }) => {
    const workerPolicy = { workerBudget: 8, workerMemoryMb: 4096 };
    const memoryBudgetMb = resolveMemoryBudgetMb({
      ...workerPolicy,
      affectedGlobalMemoryMb: 32 * 1024,
      taskCgroupMemoryMaxMb: hardGiB * 1024,
    });
    expect(memoryBudgetMb).toBe(budgetMiB);
    expect(resolveTaskBudget({
      ...workerPolicy, memoryBudgetMb, maxConcurrentTasks: 4,
      reserveWorkers: 1, taskCgroupPidsMax: 32768,
    })).toMatchObject({ memoryBudgetMb: budgetMiB, effectiveWorkerBudget: workers, maxConcurrentTasks: 4 });
  });

  it('reads memory.max from the current unified cgroup and treats max/unreadable as unbounded', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/user.slice/test.scope\n'],
      ['/sys/fs/cgroup/user.slice/test.scope/memory.max', String(8 * 1024 * 1024 * 1024)],
    ]);
    const readFile = (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path)!;
    };
    expect(readTaskCgroupMemoryMaxMb({ readFile })).toBe(8192);
    files.set('/sys/fs/cgroup/user.slice/test.scope/memory.max', 'max');
    expect(readTaskCgroupMemoryMaxMb({ readFile })).toBeNull();
  });

  it('reads pids.max from the current unified cgroup and treats max/unreadable as unbounded', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/user.slice/test.scope\n'],
      ['/sys/fs/cgroup/user.slice/test.scope/pids.max', '2048'],
    ]);
    const readFile = (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path)!;
    };
    expect(readTaskCgroupPidsMax({ readFile })).toBe(2048);
    files.set('/sys/fs/cgroup/user.slice/test.scope/pids.max', 'max');
    expect(readTaskCgroupPidsMax({ readFile })).toBeNull();
  });

  it('reads the cumulative refused-fork count from pids.events', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/user.slice/test.scope\n'],
      ['/sys/fs/cgroup/user.slice/test.scope/pids.events', 'max 121\n'],
    ]);
    const readFile = (path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path)!;
    };
    expect(readTaskCgroupPidsEventMax({ readFile })).toBe(121);
    files.set('/sys/fs/cgroup/user.slice/test.scope/pids.events', 'max not-a-number');
    expect(readTaskCgroupPidsEventMax({ readFile })).toBeNull();
  });

  describe('cgroup memory usage evidence (WI-10007629, P-006)', () => {
    const MB = 1024 * 1024;
    const scope = '/sys/fs/cgroup/user.slice/test.scope';
    const cgroupFiles = (entries: Record<string, string>) => {
      const files = new Map<string, string>([['/proc/self/cgroup', '0::/user.slice/test.scope\n']]);
      for (const [name, body] of Object.entries(entries)) files.set(`${scope}/${name}`, body);
      const readFile = (path: string) => {
        if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files.get(path)!;
      };
      return { files, readFile };
    };

    it('reads anon (not file cache), the cumulative peak and the oom_kill counter', () => {
      const { readFile } = cgroupFiles({
        // `file` is page cache and must NOT be counted as worker demand.
        'memory.stat': `anon ${9000 * MB}\nfile ${20000 * MB}\nanon_thp 0\n`,
        'memory.peak': `${31000 * MB}\n`,
        'memory.events': 'low 0\nhigh 0\nmax 4\noom 1\noom_kill 1\n',
      });
      expect(readTaskCgroupMemoryUsage({ readFile })).toEqual({
        anonMb: 9000,
        peakMb: 31000,
        oomKills: 1,
      });
    });

    it('keeps each field independent and returns null only when nothing is readable', () => {
      // memory.peak needs a recent kernel; its absence must not hide the anon reading.
      const partial = cgroupFiles({ 'memory.stat': `anon ${512 * MB}\n` });
      expect(readTaskCgroupMemoryUsage({ readFile: partial.readFile })).toEqual({
        anonMb: 512,
        peakMb: null,
        oomKills: null,
      });
      // `anon_thp` must not be mistaken for `anon`, and a malformed counter is unreadable.
      const malformed = cgroupFiles({ 'memory.stat': 'anon_thp 77\nanon nope\n' });
      expect(readTaskCgroupMemoryUsage({ readFile: malformed.readFile })).toBeNull();
      expect(readTaskCgroupMemoryUsage({ readFile: cgroupFiles({}).readFile })).toBeNull();
    });

    it('tracks the sampled anon maximum and reports oom kills as a delta over the run', () => {
      const readings = [
        { anonMb: 4000, peakMb: 20000, oomKills: 3 },
        null,
        { anonMb: 11000, peakMb: 26000, oomKills: 3 },
        { anonMb: 6000, peakMb: 26000, oomKills: 5 },
      ];
      const observer = createCgroupMemoryObserver({ read: () => readings.shift() ?? null });
      for (let i = 0; i < 4; i++) observer.sample();
      // The cgroup carried 3 kills from before the run; only the 2 during it count.
      expect(observer.summary()).toEqual({ samples: 3, maxAnonMb: 11000, peakMb: 26000, oomKills: 2,
        pairedSamples: 0, maxAnonPerAllocatedWorkerMb: null });
    });

    it('reports every field as unknown, never zero, when nothing was measured', () => {
      const observer = createCgroupMemoryObserver({ read: () => null });
      observer.sample();
      const line = formatCgroupMemoryObservedMarker(observer.summary(), { observedMaxWorkers: 7 });
      expect(line).toBe(
        'AFFECTED_TESTS_CGROUP_MEMORY_OBSERVED samples=0 anonMaxMb=unknown peakMb=unknown ' +
          'oomKills=unknown maxWorkers=7 anonPerWorkerMb=unknown workerBasis=paired-allocation pairedSamples=0',
      );
    });

    it('does not derive worker demand from unrelated memory and worker peaks', () => {
      const line = formatCgroupMemoryObservedMarker(
        { samples: 12, maxAnonMb: 10001, peakMb: 29000, oomKills: 0 },
        { observedMaxWorkers: 7 },
      );
      expect(line).toContain('anonMaxMb=10001 peakMb=29000 oomKills=0 maxWorkers=7 anonPerWorkerMb=unknown');
      expect(
        formatCgroupMemoryObservedMarker(
          { samples: 1, maxAnonMb: 100, peakMb: null, oomKills: 0 },
          { observedMaxWorkers: 0 },
        ),
      ).toContain('anonPerWorkerMb=unknown');
    });

    it('keeps the one-worker memory peak paired when the worker-count peak happened earlier', async () => {
      let anonMb = 200;
      const observer = createCgroupMemoryObserver({ read: () => ({ anonMb, peakMb: 500, oomKills: 0 }) });
      await observer.withWorkers(1, async () => {
        await observer.withWorkers(1, async () => observer.sample()); // 200 / 2 = 100
        anonMb = 400;
        observer.sample(); // 400 / 1 = 400, not maxAnon(400) / maxWorkers(2) = 200
      });
      expect(observer.summary()).toMatchObject({ maxAnonMb: 400, maxAnonPerAllocatedWorkerMb: 400 });
      expect(formatCgroupMemoryObservedMarker(observer.summary(), { observedMaxWorkers: 2 })).toContain('anonPerWorkerMb=400');
    });

    it('releases worker grants on rejection and excludes idle samples from the paired ratio', async () => {
      let anonMb = 100;
      const observer = createCgroupMemoryObserver({ read: () => ({ anonMb, peakMb: 5000, oomKills: 0 }) });
      await expect(observer.withWorkers(2, async () => { observer.sample(); throw new Error('task failed'); })).rejects.toThrow('task failed');
      anonMb = 5000; observer.sample();
      expect(observer.summary()).toMatchObject({ maxAnonMb: 5000, maxAnonPerAllocatedWorkerMb: 50 });
      await observer.withWorkers(1, async () => { anonMb = 101; observer.sample(); });
      expect(observer.summary().maxAnonPerAllocatedWorkerMb).toBe(101);
    });

    it('rounds a paired ratio up and never admits an invalid worker count', async () => {
      const read = vi.fn(() => ({ anonMb: 101, peakMb: 200, oomKills: 0 }));
      const observer = createCgroupMemoryObserver({ read });
      await observer.withWorkers(2, async () => observer.sample());
      expect(observer.summary().maxAnonPerAllocatedWorkerMb).toBe(51);
      await expect(observer.withWorkers(0, async () => {})).rejects.toThrow('positive integer');
      await expect(observer.withWorkers(1.5, async () => {})).rejects.toThrow('positive integer');
    });

    it('keeps an unreadable diagnostic from changing the task result or masking its failure', async () => {
      const observer = createCgroupMemoryObserver({ read: () => { throw new Error('measurement unavailable'); } });
      await expect(observer.withWorkers(1, async () => 42)).resolves.toBe(42);
      await expect(observer.withWorkers(1, async () => { throw new Error('actual task failure'); })).rejects.toThrow('actual task failure');
      expect(observer.summary()).toMatchObject({ samples: 0, pairedSamples: 0, maxAnonPerAllocatedWorkerMb: null });
    });

    it('is wired into affected-tests: sampled on every progress beat and printed once beside OBSERVED', () => {
      expect(AFFECTED_TESTS_SRC).toContain('const cgroupMemoryObserver = createCgroupMemoryObserver();');
      const emitProgress = AFFECTED_TESTS_SRC.slice(AFFECTED_TESTS_SRC.indexOf('const emitProgress = ('));
      expect(emitProgress.slice(0, emitProgress.indexOf('AFFECTED_TASK_PROGRESS state=${state}'))).toContain(
        'cgroupMemoryObserver.sample();',
      );
      expect(AFFECTED_TESTS_SRC.indexOf('const cgroupMemoryObserver')).toBeLessThan(
        AFFECTED_TESTS_SRC.indexOf('const emitProgress = ('),
      );
      const observed = AFFECTED_TESTS_SRC.indexOf('outSync(formatTaskBudgetObservedMarker(initialPool.stats));');
      expect(observed).toBeGreaterThan(-1);
      expect(AFFECTED_TESTS_SRC.slice(observed, observed + 400)).toContain('formatCgroupMemoryObservedMarker(');
      expect(AFFECTED_TESTS_SRC).toContain('cgroupMemoryObserver.withWorkers(allocation.workers,');
    });
  });

  it('invalidates only red runs when the cgroup refused forks during the run', () => {
    expect(pidsEventRefusalDelta({ start: 30, end: 121, hasFailures: true })).toBe(91);
    expect(pidsEventRefusalDelta({ start: 30, end: 121, hasFailures: false })).toBe(0);
    expect(pidsEventRefusalDelta({ start: 121, end: 121, hasFailures: true })).toBe(0);
    expect(pidsEventRefusalDelta({ start: null, end: 121, hasFailures: true })).toBe(0);
  });

  it('serializes an 8192-pid task scope instead of admitting two peak-sized test tasks', () => {
    const resolved = resolveTaskBudget({ ...config, taskCgroupPidsMax: 8192 });
    expect(resolved).toMatchObject({
      mode: 'serial',
      maxConcurrentTasks: 1,
      configuredMaxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 1,
      taskBoundBy: 'pids',
    });
    const marker = formatTaskBudgetMarker(resolved);
    expect(marker).toContain('effectiveWorkers=4 maxTasks=1 reserveWorkers=1');
    expect(marker).toContain(
      'configuredMaxTasks=2 pidsMaxTasks=1 taskBoundBy=pids ' +
        'taskCgroupPidsMax=8192 pidsPerTask=4096 pidsReserve=1024',
    );
  });

  it('adapts a 512-pid task scope to one serial task instead of refusing', () => {
    const resolved = resolveTaskBudget({ ...config, taskCgroupPidsMax: 512 });
    expect(resolved).toMatchObject({
      mode: 'serial',
      maxConcurrentTasks: 1,
      configuredMaxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 1,
      taskBoundBy: 'pids',
      pidsBudgetAdapted: true,
      pidsReserve: 102,
      pidsPerConcurrentTask: 410,
    });
    expect(resolved.pidsReserve + resolved.pidsPerConcurrentTask).toBe(512);
  });

  it('adapts a 4096-pid task scope to one serial task instead of refusing', () => {
    const resolved = resolveTaskBudget({ ...config, taskCgroupPidsMax: 4096 });
    expect(resolved).toMatchObject({
      mode: 'serial',
      maxConcurrentTasks: 1,
      configuredMaxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 1,
      taskBoundBy: 'pids',
      pidsBudgetAdapted: true,
      pidsReserve: 819,
      pidsPerConcurrentTask: 3277,
    });
    expect(resolved.pidsReserve + resolved.pidsPerConcurrentTask).toBe(4096);
  });

  it('keeps two-task scheduling only when both 4096-task envelopes plus reserve fit', () => {
    expect(resolveTaskBudget({ ...config, taskCgroupPidsMax: 9216 })).toMatchObject({
      mode: 'parallel',
      maxConcurrentTasks: 2,
      pidsMaxConcurrentTasks: 2,
      taskBoundBy: 'ceiling',
    });
    expect(() => resolveTaskBudget({ ...config, taskCgroupPidsMax: 0 })).toThrow(
      /below one pidsPerConcurrentTask=4096 envelope; refusing before launch/,
    );
  });

  // EI-21442389733525112. These refusals are the ONLY evidence that a pre-launch refusal
  // happened: nothing is spawned, so the task ledger never samples pids and every downstream
  // caller sees a bare non-zero exit. Round-tripping the REAL thrown message through the REAL
  // parser is what keeps the emitter and the reader on one grammar — a hand-copied literal on
  // either side would let them drift apart silently, and the symptom of that drift is a
  // resource refusal being read as a red test suite.
  it('emits a machine-readable refusal marker the shared parser recovers, on both refusal sites', () => {
    const pidsMessage = (() => {
      try {
        resolveTaskBudget({ ...config, taskCgroupPidsMax: 0 });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(pidsMessage).not.toBeNull();
    expect(parseTaskBudgetRefusal(pidsMessage!)).toEqual({
      kind: 'pids',
      unit: 'tasks',
      limit: 0,
      reserve: 1_024,
      requiredPerTask: 4_096,
    });

    const memoryMessage = (() => {
      try {
        resolveMemoryBudgetMb({ ...base, taskCgroupMemoryMaxMb: 1024 });
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(memoryMessage).not.toBeNull();
    expect(parseTaskBudgetRefusal(memoryMessage!)).toMatchObject({
      kind: 'memory',
      unit: 'mb',
      limit: 1_024,
    });

    // The human sentence must survive alongside the marker — the marker is added evidence,
    // not a replacement for a message a person has to read at 3am.
    expect(pidsMessage).toContain('refusing before launch');
    expect(pidsMessage).toContain('remedy=processes:limit');
  });

  it('does not emit a refusal marker on a budget that resolves', () => {
    const marker = formatTaskBudgetMarker(resolveTaskBudget({ ...config, taskCgroupPidsMax: 8192 }));
    expect(parseTaskBudgetRefusal(marker)).toBeNull();
  });

  it('falls back to the ceiling when the host reading is unavailable, never to zero', () => {
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: null })).toBe(8 * 1024);
    expect(resolveMemoryBudgetMb({ ...base, memAvailableMb: '' })).toBe(8 * 1024);
  });

  it('rejects a nonsensical reserve fraction instead of silently admitting everything', () => {
    expect(() => resolveMemoryBudgetMb({ ...base, memAvailableMb: 4096, reserveFraction: 1 })).toThrow(
      /reserveFraction/,
    );
    expect(() => resolveMemoryBudgetMb({ ...base, memAvailableMb: 4096, reserveFraction: -0.5 })).toThrow(
      /reserveFraction/,
    );
  });
});

describe('duration history', () => {
  it('keeps an EWMA and treats missing or malformed history as unknown', () => {
    const empty = emptyDurationHistory();
    expect(durationEstimate(empty, 'missing')).toBeNull();
    const first = mergeDurationHistory(empty, [{ key: 'a :: test', durationMs: 1000 }], 't1');
    const second = mergeDurationHistory(first, [{ key: 'a :: test', durationMs: 3000 }], 't2');
    expect(second.tasks['a :: test']).toEqual({
      durationMs: 1500,
      peakMs: 3000,
      samples: 2,
      updatedAt: 't2',
    });
  });

  // EI-20803703725014949: lane-stateful is bimodal (~7m vs ~45m, both honest
  // completions). The watchdog bound must clear the honest SLOW mode even when
  // the EWMA has been dragged down by a run of fast finishes — otherwise the
  // timeout collapses to its floor and a legitimate slow finish races a timer
  // set at exactly its own duration (the measured ~50% SIGKILL coin flip).
  it('timeoutDurationEstimate keeps the slow mode of a bimodal task alive through fast runs', () => {
    const SLOW = 45 * 60_000;
    const FAST = 7 * 60_000;
    let history = mergeDurationHistory(emptyDurationHistory(), [{ key: 'oc :: lane', durationMs: SLOW }], 't1');
    for (let i = 0; i < 4; i += 1) {
      history = mergeDurationHistory(history, [{ key: 'oc :: lane', durationMs: FAST }], `t${i + 2}`);
    }
    const ewma = durationEstimate(history, 'oc :: lane');
    const forTimeout = timeoutDurationEstimate(history, 'oc :: lane');
    // The EWMA has collapsed well below the slow mode…
    expect(ewma).toBeLessThan(SLOW / 2);
    // …but the peak-aware estimate still remembers it (modulo slow decay).
    expect(forTimeout).toBeGreaterThan(SLOW * 0.9 ** 4 * 0.99);
    // End to end: the bound computed from it clears the honest slow mode.
    const timeoutMs = resolveTaskTimeoutMs({
      overrideMs: null,
      floorMs: 45 * 60_000,
      durationMs: forTimeout,
      headroomMultiplier: 2,
      quantumMs: 5 * 60_000,
      maxMs: 90 * 60_000,
    });
    expect(timeoutMs).toBeGreaterThan(SLOW);
    // Control: the same bound computed from the bare EWMA is the floor — the
    // exact coin-flip configuration this estimator exists to prevent.
    const ewmaTimeoutMs = resolveTaskTimeoutMs({
      overrideMs: null,
      floorMs: 45 * 60_000,
      durationMs: ewma,
      headroomMultiplier: 2,
      quantumMs: 5 * 60_000,
      maxMs: 90 * 60_000,
    });
    expect(ewmaTimeoutMs).toBe(45 * 60_000);
  });

  it('timeoutDurationEstimate falls back to the EWMA for a legacy entry without peakMs', () => {
    const legacy = {
      version: emptyDurationHistory().version,
      tasks: { 'a :: test': { durationMs: 1234, samples: 3, updatedAt: 't0' } },
    };
    expect(timeoutDurationEstimate(legacy, 'a :: test')).toBe(1234);
    expect(timeoutDurationEstimate(legacy, 'missing')).toBeNull();
  });

  it('a merge over a legacy entry seeds the peak from its EWMA rather than zero', () => {
    const legacy = {
      version: emptyDurationHistory().version,
      tasks: { 'a :: test': { durationMs: 10_000, samples: 3, updatedAt: 't0' } },
    };
    const next = mergeDurationHistory(legacy, [{ key: 'a :: test', durationMs: 1000 }], 't1');
    // decayed EWMA seed (10000 * 0.9) beats the fast observation
    expect(next.tasks['a :: test'].peakMs).toBe(9000);
  });

  it('the recorded peak decays so a one-off outlier does not pin the bound forever', () => {
    let history = mergeDurationHistory(emptyDurationHistory(), [{ key: 'a :: test', durationMs: 100_000 }], 't1');
    for (let i = 0; i < 30; i += 1) {
      history = mergeDurationHistory(history, [{ key: 'a :: test', durationMs: 1000 }], `t${i + 2}`);
    }
    // 100000 * 0.9^30 ≈ 4240 — the outlier has decayed to the same order as
    // the observed durations instead of pinning the timeout at its own scale.
    expect(timeoutDurationEstimate(history, 'a :: test')).toBeLessThan(10_000);
  });

  it('atomically replaces a complete local file and leaves no temporary sibling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const path = join(dir, 'history.json');
    try {
      const history = mergeDurationHistory(
        emptyDurationHistory(),
        [{ key: '@papercusp/web :: test', durationMs: 42 }],
        'now',
      );
      writeDurationHistoryAtomic(path, history, 'test-nonce');
      expect(readDurationHistory(path)).toEqual(history);
      expect(readdirSync(dir)).toEqual(['history.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // EI-20806073740910935: gate run 10 loaded EMPTY history while a valid,
  // populated file sat at the path — the bare catch{} swallowed whatever the
  // transient read failure was, every watchdog bound fell to its floor, and
  // the estimator fix above was inert for the entire ~55min run with zero
  // trace. A read failure that is NOT plain first-run ENOENT must say so.
  it('a non-ENOENT read failure returns empty AND reports itself on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A DIRECTORY at the path makes readFileSync throw EISDIR — a stand-in
      // for the whole non-ENOENT class (EMFILE/EIO/EACCES) without flakiness.
      expect(readDurationHistory(dir)).toEqual(emptyDurationHistory());
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('READ FAILED');
      expect(written).toContain(dir);
      expect(written).toContain('EI-20806073740910935');
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a version-mismatched file returns empty AND reports the discard on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const path = join(dir, 'history.json');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeFileSync(path, JSON.stringify({ version: 999, tasks: { 'a :: test': { durationMs: 5 } } }));
      expect(readDurationHistory(path)).toEqual(emptyDurationHistory());
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('DISCARDED');
      expect(written).toContain('version=999');
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plain ENOENT (first run, no history yet) stays quiet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-task-history-test-'));
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(readDurationHistory(join(dir, 'never-written.json'))).toEqual(emptyDurationHistory());
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('operator-visible budget markers', () => {
  it('reports configured and observed ceilings separately', () => {
    const resolved = resolveTaskBudget(config);
    expect(formatTaskBudgetMarker(resolved)).toContain(
      'workerBudget=4 memoryBudgetMb=4096 workerMemoryMb=1024 effectiveWorkers=4 maxTasks=2',
    );
    expect(
      formatTaskBudgetObservedMarker({
        ...resolved,
        observedMaxWorkers: 4,
        observedMaxMemoryMb: 4096,
        observedMaxTasks: 2,
      }),
    ).toBe('AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=4 maxMemoryMb=4096 maxTasks=2');
  });

  // EI-20801764054303492 route (a). The admission fields are appended ONLY when a reader was
  // wired, so the legacy string above stays byte-identical for every caller that passes none —
  // the two assertions are a matched pair and must be read together.
  it('appends the admission terms only when a memory reader was wired', () => {
    const resolved = resolveTaskBudget(config);
    const observed = { ...resolved, observedMaxWorkers: 4, observedMaxMemoryMb: 4096, observedMaxTasks: 2 };

    expect(formatTaskBudgetObservedMarker({ ...observed, memoryReadings: null })).toBe(
      'AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=4 maxMemoryMb=4096 maxTasks=2',
    );
    expect(
      formatTaskBudgetObservedMarker({
        ...observed,
        memoryReadings: 3,
        admissionClamps: 2,
        minAdmittedWorkers: 1,
      }),
    ).toBe(
      'AFFECTED_TESTS_SCHEDULER_OBSERVED maxWorkers=4 maxMemoryMb=4096 maxTasks=2 ' +
        'memReadings=3 clamps=2 minAdmittedWorkers=1',
    );
  });

  // EI-20801764054303492 step 3. The gate log used to record the RESOLVED concurrency but not the
  // REASON for it, so "is the memory rail engaging?" could only be answered by re-deriving the
  // whole chain from source — which is how the rail stayed inert unnoticed. These assert the two
  // readings are distinguishable in the log, because that distinction is the whole point: under
  // 'ceiling' a ceiling raise would take effect, under 'memory' it would change nothing.
  it('names the CEILING as the binding term when memory has headroom to spare', () => {
    const resolved = resolveTaskBudget({ ...config, memoryBudgetMb: 64 * 1024 });
    expect(resolved.boundBy).toBe('ceiling');
    expect(resolved.memoryWorkerBudget).toBeGreaterThan(resolved.workerBudget);
    expect(resolved.effectiveWorkerBudget).toBe(resolved.workerBudget);
    expect(formatTaskBudgetMarker(resolved)).toContain('memoryWorkers=64 boundBy=ceiling');
  });

  it('names MEMORY as the binding term when the host measurement holds concurrency down', () => {
    // 2 workers' worth of memory against a 4-worker ceiling: the min() binds on memory.
    const resolved = resolveTaskBudget({ ...config, memoryBudgetMb: 2 * 1024 });
    expect(resolved.boundBy).toBe('memory');
    expect(resolved.effectiveWorkerBudget).toBe(2);
    expect(resolved.effectiveWorkerBudget).toBeLessThan(resolved.workerBudget);
    expect(formatTaskBudgetMarker(resolved)).toContain('memoryWorkers=2 boundBy=memory');
  });

  it('reports the host measurement when one was taken, and omits it when there was none', () => {
    const resolved = resolveTaskBudget(config);
    // Present: the operator can compare what the box had against what was admitted.
    expect(formatTaskBudgetMarker({ ...resolved, memAvailableMb: 51_200 })).toContain('memAvailableMb=51200');
    // Absent: "no measurement" is meaningful and must NOT be rendered as 0/null, which would
    // read as "the box had no memory" — the exact misreading this marker exists to prevent.
    expect(formatTaskBudgetMarker(resolved)).not.toContain('memAvailableMb');
    expect(formatTaskBudgetMarker({ ...resolved, memAvailableMb: null })).not.toContain('memAvailableMb');
  });

  it('derives the binding term for a caller that supplies no boundBy (older/hand-built stats)', () => {
    expect(formatTaskBudgetMarker({ ...resolveTaskBudget(config), boundBy: undefined })).toContain('boundBy=ceiling');
  });
});

describe('affected-tests scheduler wiring', () => {
  it('bounds initial watchdog and progress extensions by the maintained launcher cleanup cutoff', () => {
    const body = AFFECTED_TESTS_SRC.slice(AFFECTED_TESTS_SRC.indexOf('const launchBudget ='));
    expect(body).toMatch(/const launchBudget = [\s\S]{0,100}?admitTaskDeadline\(\{/);
    expect(body).toContain('launchBudget.childCutoffEpochMs - Date.now()');
    const watchdog = body.slice(body.indexOf('const watchdog = createProgressAwareWatchdog({'),
      body.indexOf('let progressTimer = null;'));
    expect(watchdog).toContain('timeoutMs: Math.min(taskTimeoutMs, launcherWatchdogMs)');
    expect(watchdog).toContain(': Math.min(watchdogCeilingMs, launcherWatchdogMs)');
    // The gate's "no ceiling" (null) still honours a finite launcher cutoff.
    expect(watchdog).toContain('Number.isFinite(launcherWatchdogMs) ? launcherWatchdogMs : null');
  });

  it('awaits the initial budgeted pool and preserves allocation-specific Vitest ceilings', () => {
    expect(AFFECTED_TESTS_SRC).toContain('initialPool = await runBudgetedTaskShards(TASK_CONTEXT_SHARD_PLAN');
    for (const variable of ['VITEST_MAX_WORKERS', 'VITEST_MAX_FORKS', 'VITEST_MAX_THREADS']) {
      expect(AFFECTED_TESTS_SRC).toContain(`${variable}: String(allocation.workers)`);
    }
  });

  // EI-20801764054303492 route (a), the SAME inert-rail class WI-39472 records below — and it
  // already happened once to this very feature: `admissibleWorkersForMemory` sat exported, tested
  // and CALLED BY NOTHING for hours, which every unit test above passes cleanly through. A clamp
  // nothing wires is not a clamp. Pinned at BOTH call sites and matched structurally (a bounded
  // gap after the call opening) rather than as a bare substring, so the prose explaining the
  // wiring cannot satisfy the assertion on its own.
  it('passes the live memory reader to BOTH budgeted pools, so the admission clamp is not inert', () => {
    expect(AFFECTED_TESTS_SRC).toMatch(
      /initialPool = await runBudgetedTaskShards\(TASK_CONTEXT_SHARD_PLAN[\s\S]{0,500}?\n\s*readMemAvailableMb,/,
    );
    // P-004 (gate-latency-selection-and-retry-policy-2026-09-06): the retries run through ONE
    // pool now, so this is the second — and only other — budgeted pool in the runner.
    expect(AFFECTED_TESTS_SRC).toMatch(
      /const retryPool = await runBudgetedTasks\(retryPoolTasks, \{[\s\S]{0,500}?\n\s*readMemAvailableMb,/,
    );
  });

  // WI-39472: the memory rail was INERT for as long as this default was
  // `SCHEDULER_WORKER_BUDGET * SCHEDULER_WORKER_MEMORY_MB` — that makes memoryWorkerBudget
  // identically equal to workerBudget, so resolveTaskBudget's Math.min can never bind. Nothing
  // failed loudly, which is exactly why it survived. Pin the wiring at the source, because a
  // behavioural test cannot see the difference on a host with plenty of free memory.
  it('measures the host for its memory budget instead of deriving it from the worker budget', () => {
    expect(AFFECTED_TESTS_SRC).toContain('memoryBudgetMb: resolveMemoryBudgetMb({');
    // EI-20801764054303492: the reading is hoisted to a const so the budget and the
    // operator-visible marker report the SAME measurement (two readFileSync calls would drift on
    // a busy box). The guard's INTENT is unchanged — "the host is measured, not derived" — so it
    // now pins the hoist plus its use, which is strictly more than the single call site it
    // replaced. Both halves are required: the const alone could be measured and then ignored.
    expect(AFFECTED_TESTS_SRC).toContain('const MEM_AVAILABLE_MB = readMemAvailableMb()');
    expect(AFFECTED_TESTS_SRC).toContain('memAvailableMb: MEM_AVAILABLE_MB');
    expect(AFFECTED_TESTS_SRC).toContain('taskCgroupMemoryMaxMb: TASK_CGROUP_MEMORY_MAX_MB');
    expect(AFFECTED_TESTS_SRC).toContain('const TASK_CGROUP_PIDS_MAX = readTaskCgroupPidsMax()');
    expect(AFFECTED_TESTS_SRC).toContain('taskCgroupPidsMax: TASK_CGROUP_PIDS_MAX');
    expect(AFFECTED_TESTS_SRC).toContain('const TASK_CGROUP_PIDS_EVENTS_MAX_START = readTaskCgroupPidsEventMax()');
    expect(AFFECTED_TESTS_SRC).toContain('AFFECTED_TESTS_REFUSAL kind=pids-exhausted');
    // MemAvailable, never MemFree/os.freemem() — the latter two ignore reclaimable page cache and
    // read catastrophically low on a long-lived box. (Asserted on the READ, not on the absence of
    // the string "os.freemem()" anywhere in the file: the prose explaining WHY we avoid it names
    // it, so an absence assertion would be defeated by its own rationale.)
    expect(AFFECTED_TESTS_SRC).toContain('MemAvailable:');
    expect(AFFECTED_TESTS_SRC).not.toMatch(/memAvailableMb:\s*(?:os\.)?freemem\(/);
    // THE REGRESSION: the self-referential default that made the clamp unable to bind. Matched
    // STRUCTURALLY (as the value of memoryBudgetMb) rather than as a bare substring — a bare
    // substring assertion is defeated by the comment that explains the regression, which is a
    // trap this very test fell into twice while being written.
    expect(AFFECTED_TESTS_SRC).not.toMatch(
      /memoryBudgetMb:[\s\S]{0,120}?SCHEDULER_WORKER_BUDGET \* SCHEDULER_WORKER_MEMORY_MB/,
    );
  });

  it('drains the initial pool, then the retry pool, before reporting — and reuses the same scheduler for retries', () => {
    // WI-1490656 wrapped this await in a try/catch so an admission-starvation throw becomes a
    // reported refusal rather than an uncaught top-level rejection, so the declaration is now
    // `let initialPool;` above the assignment.
    // P-004 (gate-latency-selection-and-retry-policy-2026-09-06): retries are DECIDED (phase A)
    // and RUN through one pool (phase B) before the reporting loop (phase C) replays them in
    // declaration order — so the retry pool now sits BETWEEN the initial pool and reporting,
    // where it used to be inline inside the reporting loop and therefore serial.
    const pool = AFFECTED_TESTS_SRC.indexOf('initialPool = await runBudgetedTaskShards(TASK_CONTEXT_SHARD_PLAN');
    const retry = AFFECTED_TESTS_SRC.indexOf('const retryPool = await runBudgetedTasks(retryPoolTasks');
    const reporting = AFFECTED_TESTS_SRC.indexOf('const prep = retryPrep.get(scheduled.index);');
    expect(pool).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(pool);
    expect(reporting).toBeGreaterThan(retry);
  });
});

/**
 * WI-1490656 — the shared-admission QUEUE, and why a queued run reads as a wedge.
 *
 * Measured on this box: green-checkpoint run pid 952836 (candidate 6da5cd4db218) ran 16 of
 * its 126 planned tasks, then produced nothing for 1h42m while holding the gate's SINGLETON
 * run lock, so every later fire recorded `skipped-locked`. It was filed as
 * "affected-tests.mjs --related hangs". It was not hanging. `/proc` showed the textbook
 * wedge signature — parked in `ep_poll`, ZERO child processes, a run log frozen mid-run —
 * which is ALSO exactly what a caller queued on `papercusp-test-process-admission` looks
 * like, because a queued caller does nothing by definition.
 *
 * A live instance was captured while writing this: pid 4094320 held the mutex 50 min while
 * pid 911055 sat queued 23.5 min, its log frozen at the exact line before the acquisition.
 *
 * Two independent defects made that indistinguishable and unbounded:
 *
 *  1. INVISIBLE. The queued notice went to `console.error`, which cannot reach the
 *     affected-tests RUN LOG (written by the runner's own `logLine`) — the very file the
 *     run's BEGIN line tells a triager to grep. Confirmed by census: zero occurrences of
 *     `AFFECTED_TESTS_ADMISSION_QUEUED` across all 993 run logs present on the box. It also
 *     fired exactly ONCE, at t≈0, so even on stderr a multi-hour queue said nothing after
 *     the first instant.
 *
 *  2. UNBOUNDED. `SHARED_TEST_PROCESS_ADMISSION_TIMEOUT_MS` (4h) bounds ONE acquisition, and
 *     `runBudgetedTaskShards` acquires once PER SHARD. The 126-task run planned 16 shards, so
 *     the bound everyone reads as "4h" was really 16 × 4h.
 */
describe('shared test-process admission queue (WI-1490656)', () => {
  const heldTasks = ['a'];
  const trivialRun = {
    ...config,
    runTask: async () => 'ok',
  };

  it('re-announces while still queued instead of falling silent after the first notice', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      'wi1490656-reannounce',
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    const notices: number[] = [];
    const waiter = withFsMutex('wi1490656-reannounce', async () => 'done', {
      timeoutMs: 10_000,
      staleMs: 60_000,
      retryMs: 5,
      waitingNoticeIntervalMs: 25,
      onWaiting: ({ elapsedMs }: { elapsedMs: number }) => notices.push(elapsedMs),
    });

    // THE POINT: a caller that keeps waiting keeps SAYING SO. Before this fix `onWaiting`
    // was one-shot, so this could never exceed 1 no matter how long the wait ran.
    await until(() => notices.length >= 3, 're-announced waiting notices');
    release.resolve();
    await holder;
    await waiter;

    expect(notices.length).toBeGreaterThanOrEqual(3);
    // Each notice reports a strictly later elapsed time — they are real re-announcements on
    // a cadence, not the same event delivered repeatedly.
    for (let i = 1; i < notices.length; i += 1) {
      expect(notices[i]).toBeGreaterThan(notices[i - 1]);
    }
  }, 20_000);

  it('CONTROL: without an interval the notice stays one-shot, so the count above is caused by the interval', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      'wi1490656-oneshot',
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    let notices = 0;
    const waiter = withFsMutex('wi1490656-oneshot', async () => 'done', {
      timeoutMs: 10_000,
      staleMs: 60_000,
      retryMs: 5,
      onWaiting: () => {
        notices += 1;
      },
    });
    await until(() => notices >= 1, 'first waiting notice');
    // Give it far more poll cycles than the re-announcing case needed for 3 notices.
    await new Promise<void>((done) => setTimeout(done, 200));
    expect(notices).toBe(1);

    release.resolve();
    await holder;
    await waiter;
  }, 20_000);

  it('routes the queued notice to an injected sink so it can reach the run log', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      // Hold the lane the scheduler will ACTUALLY queue on: under the gate
      // (PC_HEAVY_RELEASE_GATE=1) that is the `-release-gate` lane (WI-1746759), so a
      // hard-coded shared name never contends and the queued notice never arrives.
      admissionMutexName(),
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    const lines: string[] = [];
    const running = runBudgetedTasks(heldTasks, {
      ...trivialRun,
      onAdmissionNotice: (line: string) => lines.push(line),
    });
    await until(() => lines.length >= 1, 'queued notice on the injected sink');
    release.resolve();
    await holder;
    await running;

    // The marker a triager greps for, carried on the sink the runner wires to `errSync`
    // (stderr AND the run log) rather than `console.error` (stderr only).
    expect(lines[0]).toContain('AFFECTED_TESTS_ADMISSION_QUEUED');
    expect(lines[0]).toContain('not a hang');
  }, 20_000);

  it('spends ONE queue budget across all shards instead of restarting it per shard', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      // Hold the lane the scheduler will ACTUALLY queue on: under the gate
      // (PC_HEAVY_RELEASE_GATE=1) that is the `-release-gate` lane (WI-1746759), so a
      // hard-coded shared name never contends and the queued notice never arrives.
      admissionMutexName(),
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    const admissions: Array<{ waitedMs: number; budgetMs: number }> = [];
    // `near-tree-wide` is the class that actually splits — and the class the 126-task run
    // that lost the gate was assigned (`class=near-tree-wide reason=root-manifest-or-config`,
    // 126 tasks ⇒ 16 shards). A scoped plan is one shard and cannot exhibit the defect.
    const plan = planAffectedTaskShards(['s1', 's2'], {
      blastRadius: { kind: 'near-tree-wide', reason: 'root-manifest-or-config', triggerPaths: [] },
      taskKey: (task: string) => task,
      maxTasksPerShard: 1,
    });
    expect(plan.shards.length).toBe(2);

    const queuedNotices: string[] = [];
    const running = runBudgetedTaskShards(plan, {
      ...trivialRun,
      admissionRunBudgetMs: 8_000,
      onAdmissionNotice: (line: string) => queuedNotices.push(line),
      onAdmissionAcquired: (info: { waitedMs: number; budgetMs: number }) =>
        admissions.push(info),
    });

    // Hold long enough that shard 1's queue time is unambiguously larger than timer noise,
    // so the budget it consumes is measurable rather than a rounding artefact.
    await until(() => queuedNotices.length >= 1, 'shard 1 queued');
    await new Promise<void>((done) => setTimeout(done, 300));
    release.resolve();
    await holder;
    await running;

    expect(admissions.length).toBe(2);
    const [first, second] = admissions;
    expect(first.budgetMs).toBe(8_000);
    expect(first.waitedMs).toBeGreaterThanOrEqual(250);
    // THE POINT: shard 2 inherits what shard 1 LEFT, not a fresh full budget. Before this
    // fix every shard got the full value, so an N-shard run's real admission bound was
    // N × the timeout — 16 × 4h for the 126-task run that lost the gate.
    expect(second.budgetMs).toBeLessThan(first.budgetMs);
    expect(second.budgetMs).toBeCloseTo(8_000 - first.waitedMs, -2);
  }, 20_000);

  it('defers a release-gate waiter once the unreclaimed holder has consumed its remaining queue budget', async () => {
    const previousReleaseGate = process.env.PC_HEAVY_RELEASE_GATE;
    process.env.PC_HEAVY_RELEASE_GATE = '1';
    const release = deferred<void>(), started = deferred<void>();
    const holder = withFsMutex(admissionMutexName(), async () => {
      started.resolve();
      await release.promise;
    });
    const runTask = vi.fn(async () => 'must-not-run');
    let thrown: unknown;
    try {
      await started.promise;
      // The caller below receives a 1.5s queue budget. Make the holder's recorded
      // lease age exceed that same budget before the caller enters admission.
      await new Promise<void>((resolveNext) => setTimeout(resolveNext, 1_600));
      thrown = await runBudgetedTasks(['waiting-gate'], {
        ...config,
        admissionTimeoutMs: 1_500,
        deferWhenHolderOlderThanBudget: true,
        onAdmissionNotice: () => {},
        runTask,
      }).then(() => null, (error: unknown) => error);
    } finally {
      release.resolve();
      await holder;
      if (previousReleaseGate === undefined) delete process.env.PC_HEAVY_RELEASE_GATE;
      else process.env.PC_HEAVY_RELEASE_GATE = previousReleaseGate;
    }

    expect(thrown).toMatchObject({ code: 'EADMISSIONDEFERRED' });
    expect(isSharedAdmissionDeferral(thrown)).toBe(true);
    expect(isSharedAdmissionTimeout(thrown)).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
  }, 20_000);

  it('records the GRANT instant, so a holder\'s hold duration is measurable rather than inferred from attempt-start', async () => {
    // `startedAt` is stamped when a caller begins TRYING, so it silently includes that
    // caller's own queue wait. Reading it as "held since" overstates the hold by exactly the
    // holder's wait — an error made and retracted during this investigation. `acquiredAt` is
    // written at the mkdir that IS the grant, so the two are distinguishable.
    const lockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR as string;
    const blocker = deferred<void>();
    const blocking = deferred<void>();
    const first = withFsMutex(
      'wi1490656-acquiredat',
      async () => {
        blocking.resolve();
        await blocker.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await blocking.promise;

    // Second caller starts NOW and is forced to queue, so its attempt-start precedes its grant
    // by a measurable margin.
    const attemptStartedAt = Date.now();
    let ownerJson: Record<string, string> = {};
    const second = withFsMutex(
      'wi1490656-acquiredat',
      async () => {
        ownerJson = JSON.parse(
          readFileSync(join(lockRoot, 'wi1490656-acquiredat.lock', 'owner.json'), 'utf8'),
        );
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await new Promise<void>((done) => setTimeout(done, 300));
    blocker.resolve();
    await first;
    await second;

    expect(ownerJson.startedAt).toBeTruthy();
    expect(ownerJson.acquiredAt).toBeTruthy();
    const startedAt = Date.parse(ownerJson.startedAt);
    const acquiredAt = Date.parse(ownerJson.acquiredAt);
    // THE POINT: they are DIFFERENT, and the gap is this caller's queue wait. Before this
    // field existed there was no way to tell a long-held lock from a long-queued one.
    expect(acquiredAt).toBeGreaterThan(startedAt);
    expect(startedAt).toBeGreaterThanOrEqual(attemptStartedAt - 50);
    expect(acquiredAt - startedAt).toBeGreaterThanOrEqual(200);
  }, 20_000);

  it('classifies a REAL admission timeout, so exhausting the budget cannot become a lost run', async () => {
    const release = deferred<void>();
    const acquired = deferred<void>();
    const holder = withFsMutex(
      // Hold the lane the scheduler will ACTUALLY queue on: under the gate
      // (PC_HEAVY_RELEASE_GATE=1) that is the `-release-gate` lane (WI-1746759), so a
      // hard-coded shared name never contends and the queued notice never arrives.
      admissionMutexName(),
      async () => {
        acquired.resolve();
        await release.promise;
      },
      { timeoutMs: 10_000, staleMs: 60_000, retryMs: 5 },
    );
    await acquired.promise;

    // Provoke the ACTUAL error object the runner will have to classify — not a hand-written
    // lookalike. If someone rewords the throw in fs-mutex.mjs, this fails here instead of
    // silently restoring "gate run exits with no verdict".
    let thrown: unknown;
    try {
      await runBudgetedTasks(heldTasks, {
        ...trivialRun,
        admissionTimeoutMs: 60,
        // Keep the notice off `console.error` — vitest-fail-on-console treats the default
        // sink as a test failure, which is itself a small demonstration of why the sink had
        // to become injectable.
        onAdmissionNotice: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    release.resolve();
    await holder;

    expect(thrown).toBeInstanceOf(Error);
    expect(isSharedAdmissionTimeout(thrown)).toBe(true);

    // CONTROLS: a real test failure and a timeout on a DIFFERENT mutex must not be swallowed
    // as admission starvation — misclassifying either way loses a genuine red.
    expect(isSharedAdmissionTimeout(new Error('boom: 3 tests failed'))).toBe(false);
    expect(
      isSharedAdmissionTimeout(
        new Error('Timed out after 60ms waiting for fs-mutex "some-other-lock" (/tmp/x)'),
      ),
    ).toBe(false);
    expect(isSharedAdmissionTimeout(undefined)).toBe(false);
  }, 20_000);

  it('the runner turns that classification into an attributable refusal instead of an uncaught rejection', () => {
    // `runBudgetedTaskShards` is awaited at module top level. An uncaught rejection there
    // kills the process with no AFFECTED_TESTS_RESULT line — the exact "exit-without-verdict"
    // shape the gate records as a lost run — so bounding the wait is only safe if the throw
    // is caught and reported. Pinned structurally: the catch must re-throw anything that is
    // NOT admission starvation, so this can never become a blanket swallow.
    expect(AFFECTED_TESTS_SRC).toContain('AFFECTED_TESTS_REFUSAL kind=${admissionReason}');
    expect(AFFECTED_TESTS_SRC).toContain('status=refused reason=${admissionReason}');
    expect(AFFECTED_TESTS_SRC).toContain('admissionDeferral ? "admission-deferred" : "admission-starved"');
    expect(AFFECTED_TESTS_SRC).toContain('deferWhenHolderOlderThanBudget: true');
    expect(AFFECTED_TESTS_SRC).toMatch(/if\s*\(!admissionDeferral && !isSharedAdmissionTimeout\(error\)\)\s*throw error;/);
    // And the queue notices must be routed to `errSync` (stderr AND the run log), not left on
    // the scheduler's `console.error` default, which never reaches RUN_LOG_PATH.
    expect(AFFECTED_TESTS_SRC).toMatch(/onAdmissionNotice:\s*\(line\)\s*=>\s*errSync\(line\)/);
  });

  it.each([
    { reason: 'admission-starved', completedTasks: 0, observedNonzeroExits: 0, remaining: 5 },
    { reason: 'admission-starved', completedTasks: 2, observedNonzeroExits: 1, remaining: 3 },
    { reason: 'admission-deferred', completedTasks: 0, observedNonzeroExits: 0, remaining: 5 },
    { reason: 'admission-deferred', completedTasks: 2, observedNonzeroExits: 1, remaining: 3 },
    { reason: 'deadline-insufficient', completedTasks: 0, observedNonzeroExits: 0, remaining: 5 },
    { reason: 'deadline-insufficient', completedTasks: 2, observedNonzeroExits: 1, remaining: 3 },
  ])('retains settled shard evidence on $reason: $completedTasks completed', (sample) => {
    // Execute the production refusal boundary, including its actual result marker.
    // The second case reproduces a failed pure shard followed by a queued shard;
    // a wholly unstarted run is the contrasting control.
    const runAt = AFFECTED_TESTS_SRC.indexOf('initialPool = await runBudgetedTaskShards');
    const catchAt = AFFECTED_TESTS_SRC.indexOf('} catch (error) {', runAt);
    const bodyAt = catchAt + '} catch (error) {'.length;
    const endAt = AFFECTED_TESTS_SRC.indexOf('\n}\n', bodyAt);
    expect(runAt).toBeGreaterThan(-1);
    expect(catchAt).toBeGreaterThan(runAt);
    expect(endAt).toBeGreaterThan(bodyAt);
    const output: string[] = [];
    const exit = new Error('captured process exit');
    const admissionError = sample.reason === 'admission-deferred'
      ? Object.assign(
          new Error(`Admission deferred for fs-mutex "${admissionMutexName()}"`),
          { code: 'EADMISSIONDEFERRED' },
        )
      : new Error(`Timed out after 60ms waiting for fs-mutex "${admissionMutexName()}" (/tmp/private-test-lock)`);
    const context = {
      ...terminalCounters,
      error: admissionError,
      isTaskDeadlineRefusal: () => sample.reason === 'deadline-insufficient',
      isSharedAdmissionTimeout,
      isSharedAdmissionDeferral: (error: unknown) => isSharedAdmissionDeferral(error),
      tasks: Array.from({ length: 5 }),
      readTerminalCounters: () => ({
        tasks: 5, failed: 0, quarantinedFailed: 0, timedOutTasks: 0,
        undeterminedTasks: 0, observedAdmissionErrors: 0, ...sample,
      }),
      coverage: {},
      formatCoverageFields: () => `testsExecuted=${sample.completedTasks * 3} testsSkipped=0`,
      errSync: (line: string) => output.push(line),
      RUN_LOG_PATH: '/tmp/private-test-log',
      terminalEmitted: false,
      process: { exit: (_code: number) => { throw exit; } },
    };
    expect(() => new Script(AFFECTED_TESTS_SRC.slice(bodyAt, endAt)).runInNewContext(context)).toThrow(exit);
    const marker = output.find((line) => line.startsWith('AFFECTED_TESTS_RESULT '));
    expect(marker).toContain(`status=refused reason=${sample.reason}`);
    expect(marker).toContain(`completedTasks=${sample.completedTasks}`);
    expect(marker).toContain(`undeterminedTasks=${sample.remaining}`);
    expect(marker).toContain(`observedNonzeroExits=${sample.observedNonzeroExits}`);
    expect(marker).toContain(`testsExecuted=${sample.completedTasks * 3}`);
    expect(output.join('\n')).not.toContain('never got to run its tasks');
    expect(output.join('\n')).not.toContain('refused before running anything');
    if (sample.observedNonzeroExits) expect(marker).toContain('TALLY-UNDERCOUNT');
    else expect(marker).not.toContain('TALLY-UNDERCOUNT');
  });

  it('counts known initial settlements before persistence while leaving unreadable outcomes undetermined', () => {
    const runAt = AFFECTED_TESTS_SRC.indexOf('initialPool = await runBudgetedTaskShards');
    const callbackAt = AFFECTED_TESTS_SRC.indexOf('onTaskSettled: (scheduled) => {', runAt);
    const bodyAt = callbackAt + 'onTaskSettled: (scheduled) => {'.length;
    const endAt = AFFECTED_TESTS_SRC.indexOf('\n  },', bodyAt);
    expect(callbackAt).toBeGreaterThan(runAt);
    expect(endAt).toBeGreaterThan(bodyAt);
    const countsSeenByCoverage: number[] = [];
    const initialExecutedMapReads = new Map<string, unknown>();
    const executedMapSnapshot = { status: 'unknown', reason: 'report-not-written' };
    const context = {
      observedCompletedTasks: 0,
      foldSettledTaskCoverage: () => countsSeenByCoverage.push(context.observedCompletedTasks),
      persistPartialResumeCheckpoint: () => {},
      persistCleanFirstPassTaskVerdict: () => {},
      taskKey: (task: { key: string }) => task.key,
      executedMapResultFiles: new Map([['settled-task', '/results/settled-task.json']]),
      initialExecutedMapReads,
      executedMapReportExpectations: new Map([['settled-task', { expectsReport: true }]]),
      readExecutedMapResults: (path: string) => {
        expect(path).toBe('/results/settled-task.json');
        return executedMapSnapshot;
      },
    };
    const settle = new Script(`(scheduled) => {${AFFECTED_TESTS_SRC.slice(bodyAt, endAt)}}`).runInNewContext(context);
    for (const value of [
      { status: 0 }, { status: 1 }, { status: null, signal: 'SIGTERM' },
      { status: null }, { status: Number.NaN },
    ]) settle({ task: { t: { key: 'settled-task' } }, value });
    expect(context.observedCompletedTasks).toBe(3);
    expect(countsSeenByCoverage).toEqual([1, 2, 3, 3, 3]);
    expect(initialExecutedMapReads.get('settled-task')).toEqual({
      ...executedMapSnapshot, expectsReport: true,
    });
    // The refusal boundary reads the observation, not the later aggregate tally.
    const counterAt = AFFECTED_TESTS_SRC.lastIndexOf('readTerminalCounters = () => ({', runAt);
    const counterEnd = AFFECTED_TESTS_SRC.indexOf('\n});', counterAt) + '\n});'.length;
    expect(counterAt).toBeGreaterThan(-1);
    expect(counterEnd).toBeGreaterThan(counterAt);
    const readCounters = new Script(AFFECTED_TESTS_SRC.slice(counterAt, counterEnd)).runInNewContext({
      ...context, tasks: Array.from({ length: 5 }), failed: 0,
      quarantinedFailed: 0, timedOutTasks: 0, undeterminedTasks: 0,
      observedNonzeroExits: 1, observedAdmissionErrors: 0,
    });
    expect(readCounters()).toMatchObject({ tasks: 5, completedTasks: 3, observedNonzeroExits: 1 });
  });

  describe('WI-1746759: the release gate rides its own admission lane', () => {
    // Why a separate lane at all: `runBudgetedTasks` takes the mutex ONCE PER SHARD, so on the
    // shared lane the gate re-queues per shard and each re-entry lands behind whoever arrived
    // meanwhile. Measured 2026-08-31T12:23:04Z — shards=17, 46 queued notices, ZERO acquisitions
    // in 45 min, then death on the run budget with 130/130 tasks undetermined. Not a red: a
    // non-verdict.

    it('routes the gate off the shared lane, keyed on PC_HEAVY_RELEASE_GATE', () => {
      expect(admissionMutexName({ PC_HEAVY_RELEASE_GATE: '1' })).toBe(
        'papercusp-test-process-admission-release-gate',
      );
      expect(admissionMutexName({})).toBe('papercusp-test-process-admission');
      // pc-heavy.sh tests the literal "1", not truthiness — an empty or odd value is NOT the gate.
      expect(admissionMutexName({ PC_HEAVY_RELEASE_GATE: '' })).toBe(
        'papercusp-test-process-admission',
      );
      expect(admissionMutexName({ PC_HEAVY_RELEASE_GATE: '0' })).toBe(
        'papercusp-test-process-admission',
      );
    });

    it('does NOT let GREEN_CHECKPOINT=1 buy a private lane — the hole pc-heavy.sh already closed once', () => {
      // The load-bearing control. GREEN_CHECKPOINT is double-duty: it also drives
      // `describe.skipIf` in load-/network-sensitive tests, so agents legitimately export it BY
      // HAND to reproduce the gate's skip-set. pc-heavy.sh records that keying ADMISSION off it
      // once meant `GREEN_CHECKPOINT=1 npm run test:affected` bypassed that semaphore at nice 0,
      // "re-opening the very hole this wrapper closes". Keying a private LANE off it would repeat
      // the incident one layer down: any agent exporting the marker would silently leave the
      // queue its peers are waiting in. Only the dedicated key may do this.
      expect(admissionMutexName({ GREEN_CHECKPOINT: '1' })).toBe(
        'papercusp-test-process-admission',
      );
      // ...and the gate itself carries BOTH, so the dedicated key still decides.
      expect(admissionMutexName({ GREEN_CHECKPOINT: '1', PC_HEAVY_RELEASE_GATE: '1' })).toBe(
        'papercusp-test-process-admission-release-gate',
      );
    });

    it('keeps a GATE-lane timeout classified as admission starvation, not a lost run', () => {
      // WI-1490656's failure mode, reachable only through this change. `isSharedAdmissionTimeout`
      // classifies by `message.includes(<shared name>)`, and `affected-tests.mjs` re-throws
      // anything it rejects. So an unrelated gate-lane name would make the gate's OWN timeouts
      // re-throw instead of becoming `status=refused reason=admission-starved` — no
      // AFFECTED_TESTS_RESULT line, and green-checkpoint records a lost run. Deriving the gate
      // name from the shared one makes the containment structural rather than coincidental.
      const gateLane = admissionMutexName({ PC_HEAVY_RELEASE_GATE: '1' });
      expect(gateLane).toContain(admissionMutexName({}));
      expect(
        isSharedAdmissionTimeout(
          new Error(
            `Timed out after 2700000ms waiting for fs-mutex "${gateLane}" ` +
              `(/tmp/pcv/fs-mutex-locks/${gateLane}.lock)`,
          ),
        ),
      ).toBe(true);
      // CONTROL: the containment must not be so loose that a genuinely unrelated lock passes.
      expect(
        isSharedAdmissionTimeout(
          new Error('Timed out after 60ms waiting for fs-mutex "papercusp-something-else" (/tmp/x)'),
        ),
      ).toBe(false);
    });

    it('is wired into the acquisition itself, not just exported', () => {
      // Structural pin: the export existing proves nothing if `runBudgetedTasks` still passes the
      // bare constant. Guards the one-line regression that would silently restore the shared lane.
      expect(SCHEDULER_SRC).toMatch(/withFsMutex\(\s*(?:\/\/[^\n]*\n\s*)*admissionMutexName\(\),/);
      // And the gate name must stay DERIVED, so it cannot drift out of that containment.
      expect(SCHEDULER_SRC).toMatch(
        /RELEASE_GATE_ADMISSION_MUTEX\s*=\s*`\$\{SHARED_TEST_PROCESS_ADMISSION_MUTEX\}-release-gate`/,
      );
    });
  });
});

// EI-21917992245424964: a blocked peer could see THAT a holder existed and never whether it
// was worth waiting for, so the safe default was always to wait. The notice is the surface
// that has to answer it — it is re-announced on a 60s cadence for the whole queue wait, and
// it previously spent all of that repeating four identity fields as pretty-printed JSON.
describe('formatAdmissionHolder', () => {
  it('renders a declared holder as one line carrying scope and a bounded ETA', () => {
    const line = formatAdmissionHolder(
      JSON.stringify({
        pid: 4242,
        host: 'somehost',
        name: 'papercusp-test-process-admission',
        acquiredAt: '2026-08-31T12:00:00.000Z',
        intent: {
          scope: 'git-status',
          tasks: 90,
          etaProjectedSec: 1560,
          etaWorkSec: 3120,
          etaMode: 'parallel',
          etaFromTasks: '61/90',
        },
      }),
      Date.parse('2026-08-31T12:02:00.000Z'),
    );

    expect(line).toContain('pid=4242');
    expect(line).toContain('held=120s');
    expect(line).toContain('scope=git-status');
    expect(line).toContain('etaProjectedSec=1560');
    expect(line).toContain('etaWorkSec=3120');
    // Coverage and projection method travel WITH the ETA: serial work is not wall time.
    expect(line).toContain('etaFromTasks=61/90');
    expect(line).not.toContain('\n');
  });

  it('says intent=undeclared rather than staying silent, so "did not say" cannot read as "cheap"', () => {
    const line = formatAdmissionHolder(
      JSON.stringify({
        pid: 7,
        host: 'somehost',
        startedAt: '2026-08-31T12:00:00.000Z',
        name: 'papercusp-test-process-admission',
      }),
    );

    expect(line).toContain('intent=undeclared');
  });

  it('falls open to the raw text instead of throwing while a caller is already blocked', () => {
    expect(formatAdmissionHolder('not json at all')).toBe('not json at all');
    expect(formatAdmissionHolder(undefined)).toBe('');
    // A JSON array parses but is not an owner record; it must not be mined for fields.
    expect(formatAdmissionHolder('[1,2,3]')).toBe('[1,2,3]');
  });

  it('is what the queued notice actually calls, not a helper nothing reaches', () => {
    expect(SCHEDULER_SRC).toMatch(/holder: \$\{formatAdmissionHolder\(owner\)\}/);
  });

  it('is fed by affected-tests, which derives its declaration instead of hand-maintaining it', () => {
    // Derived from the run's own settled facts — the acquisition sits below the derivation
    // boundary, so these are known by then and cannot drift from what the run really does.
    expect(AFFECTED_TESTS_SRC).toMatch(/admissionIntent,/);
    expect(AFFECTED_TESTS_SRC).toContain('scope: derivationSource');
    expect(AFFECTED_TESTS_SRC).toContain('estimateBudgetedTaskWallMs(TASK_CONTEXT_SHARD_PLAN');
    expect(AFFECTED_TESTS_SRC).toContain('etaProjectedSec');
    expect(AFFECTED_TESTS_SRC).toContain('etaFromTasks');
  });
});

// WI-2142172: the queued notice told a waiter about the HOLDER but never about ITSELF, so a
// run could spend a full 2700s budget queued and end `refused` with 28/28 undetermined
// while every line it printed read as ordinary serialization.
describe('formatAdmissionProspect', () => {
  const NOW = Date.parse('2026-09-02T17:40:00.000Z');
  const owner = (intent: Record<string, unknown> | null, heldSec = 120) =>
    JSON.stringify({
      pid: 1298335,
      acquiredAt: new Date(NOW - heldSec * 1000).toISOString(),
      ...(intent ? { intent } : {}),
    });

  it('warns on the REPORTED numbers — the case a strict exceeds-budget rule would miss', () => {
    // The measured incident: the holder's projected wall time nearly fills the waiter's
    // 2700s budget. This pins the warning to a projection rather than a serial-sum proof.
    const line = formatAdmissionProspect(
      owner({
        scope: 'explicit',
        workspaces: 13,
        tasks: 36,
        etaProjectedSec: 2654,
        etaWorkSec: 5308,
        etaFromTasks: '30/36',
      }),
      { elapsedMs: 120_000, budgetMs: 2_700_000 },
      NOW,
    );

    expect(line).toContain('ADMISSION AT RISK');
    expect(line).toContain('etaProjectedSec=2654');
    expect(line).toContain('history-based projection');
    expect(line).not.toContain('LOWER BOUND');
    expect(line).toMatch(/fall(ing)? back/i);
  });

  it('escalates to PROJECTED TO STARVE once even the optimistic figure does not fit', () => {
    const line = formatAdmissionProspect(
      owner({ tasks: 36, etaProjectedSec: 3600, etaFromTasks: '30/36' }),
      { elapsedMs: 600_000, budgetMs: 2_700_000 },
      NOW,
    );

    expect(line).toContain('PROJECTED TO STARVE');
    expect(line).toContain('projection exceeds');
  });

  it('stays SILENT rather than emitting reassurance a projection cannot support', () => {
    // A cheap holder must produce NO clause at all — an "on track" line derived from a
    // history-based projection would be false reassurance.
    const line = formatAdmissionProspect(
      owner({ tasks: 2, etaProjectedSec: 30, etaFromTasks: '2/2' }),
      { elapsedMs: 60_000, budgetMs: 2_700_000 },
      NOW,
    );

    expect(line).toBe('');
  });

  it('subtracts time already held, so a nearly-finished holder stops raising alarm', () => {
    const intent = { tasks: 36, etaProjectedSec: 2000, etaFromTasks: '30/36' };
    // Same declaration, same budget — only elapsed hold time differs.
    const fresh = formatAdmissionProspect(owner(intent, 0), { elapsedMs: 0, budgetMs: 2_400_000 }, NOW);
    const nearlyDone = formatAdmissionProspect(owner(intent, 1900), { elapsedMs: 0, budgetMs: 2_400_000 }, NOW);

    expect(fresh).not.toBe('');
    expect(nearlyDone).toBe('');
  });

  it.each([0, 5000])('reports an unusable ETA of %s as an explicit unknown', (etaProjectedSec) => {
    // Same reason `intent=undeclared` is emitted rather than omitted: "could not estimate"
    // and "nearly done" must never read alike. A 0-numerator ratio means the projection saw
    // no duration history at all, so the number carries no information.
    const line = formatAdmissionProspect(
      owner({ tasks: 9, etaProjectedSec, etaFromTasks: '0/9' }),
      { elapsedMs: 60_000, budgetMs: 2_700_000 },
      NOW,
    );

    expect(line).toContain('PROSPECT UNKNOWN');
    expect(line).toContain('0/9');
    expect(line).not.toContain('STARVE');
  });

  it('fails open to an empty clause instead of throwing while a caller is already blocked', () => {
    const waiter = { elapsedMs: 60_000, budgetMs: 2_700_000 };
    expect(formatAdmissionProspect('not json at all', waiter, NOW)).toBe('');
    expect(formatAdmissionProspect(undefined, waiter, NOW)).toBe('');
    expect(formatAdmissionProspect('[1,2,3]', waiter, NOW)).toBe('');
    // An owner record with no declared intent, and a declaration with no usable ETA.
    expect(formatAdmissionProspect(owner(null), waiter, NOW)).toBe('');
    expect(formatAdmissionProspect(owner({ tasks: 4 }), waiter, NOW)).toBe('');
    expect(formatAdmissionProspect(owner({ tasks: 4, etaMinSec: 9999 }), waiter, NOW)).toContain(
      'legacy etaMinSec=9999',
    );
    // A caller that cannot describe its own budget gets no projection, not a NaN one.
    expect(
      formatAdmissionProspect(
        owner({ etaProjectedSec: 9999, etaFromTasks: '4/4' }),
        { elapsedMs: 0, budgetMs: 0 },
        NOW,
      ),
    ).toBe('');
  });

  it('is what the queued notice actually appends, not a helper nothing reaches', () => {
    // The sibling of formatAdmissionHolder's wiring test. Without this the projection could
    // be silently dropped from the notice and every unit test above would still pass.
    expect(SCHEDULER_SRC).toMatch(
      /formatAdmissionProspect\(owner,\s*\{\s*elapsedMs,\s*budgetMs:\s*remainingQueueMs\s*\}\)/,
    );
  });
});

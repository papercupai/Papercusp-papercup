import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestRunArtifactPacket, testRunDeadline } from './run-artifacts';
import { verifyNativeProofPacket } from '../../../../../scripts/lib/budgeted-task-scheduler.mjs';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('maintained run deadlines and retained artifacts', () => {
  function nativePacket() {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-custody-')); roots.push(root);
    const source = join(root, 'producer'); mkdirSync(source);
    writeFileSync(join(source, 'subject.test.ts'), 'export {};');
    const packet = new TestRunArtifactPacket('run-custody', source, testRunDeadline(60_000), join(root, 'retained'));
    packet.bindNativeIdentity('custody-workspace', 'papercusp');
    packet.captureSelectedSources(['subject.test.ts'], { commit: 'fixture' });
    for (const name of ['configuration.json', 'router.json', 'ledger.json']) packet.write(name, { fixture: true });
    const log = join(source, 'stdout.log'); writeFileSync(log, Buffer.from([0, 255, 10]));
    packet.captureOutputLogs([log]);
    return { root, source, packet };
  }
  it('preserves private bytes after producer removal without upgrading pending execution or cleanup', async () => {
    const { source, packet } = nativePacket();
    packet.childState = 'pending';
    await packet.finish({ cleanup: { complete: false } });
    const manifest = JSON.parse(readFileSync(packet.paths.manifest, 'utf8'));
    expect(manifest.nativeCustody).toMatchObject({ byteCustody: 'complete', writerState: 'pending',
      nativeProof: 'unqualified', acceptance: 'unmeasured' });
    const locator = manifest.nativeCustody.locator;
    const bytes = readFileSync(join(packet.paths.nativeProof, 'objects', locator.manifest.ref));
    const retained = JSON.parse(bytes.toString('utf8'));
    rmSync(source, { recursive: true });
    const read = verifyNativeProofPacket(packet.paths.nativeProof, locator, { identity: {
      workspace: 'custody-workspace', harness: 'papercusp', runId: 'run-custody',
    }, expected: [{ id: 'packet', attempt: 'primary', selected: [join(source, 'subject.test.ts')],
      runner: 'unsupported', armed: false, out: null, auxiliary: retained.expected[0].auxiliary }] });
    expect(read.status).toBe('complete');
    const log = read.manifest.groups[0].auxiliary.find(row => row.role === 'router-output/0')!.artifact!;
    expect(readFileSync(join(packet.paths.nativeProof, 'objects', log.ref))).toEqual(Buffer.from([0, 255, 10]));
  });
  it('links late-close settlement without changing a sealed pending edition', async () => {
    const { packet } = nativePacket();
    packet.childState = 'pending'; await packet.finish({ cleanup: { complete: false } });
    const first = JSON.parse(readFileSync(packet.paths.manifest, 'utf8')).nativeCustody.locator;
    const original = readFileSync(join(packet.paths.nativeProof, 'objects', first.manifest.ref));
    packet.childState = 'closed'; packet.stage('late-child-close'); await packet.finish({ cleanup: { complete: true } });
    const second = JSON.parse(readFileSync(packet.paths.manifest, 'utf8')).nativeCustody;
    expect(second.writerState).toBe('settled');
    expect(second.locator.manifest.sha256).not.toBe(first.manifest.sha256);
    expect(JSON.parse(readFileSync(join(packet.paths.nativeProof, 'objects', second.locator.manifest.ref), 'utf8')).predecessor).toEqual(first);
    expect(readFileSync(join(packet.paths.nativeProof, 'objects', first.manifest.ref))).toEqual(original);
  });
  it('retains actual cleanup outcome when custody refuses a redirected root', async () => {
    const { source, packet } = nativePacket();
    symlinkSync(source, packet.paths.nativeProof);
    packet.childState = 'closed'; await packet.finish({ cleanup: { complete: true } });
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({ cleanup: { complete: true },
      nativeCustody: { byteCustody: 'unavailable', nativeProof: 'unqualified', acceptance: 'unmeasured' } });
  });
  it('keeps native-proof fsync waits off the request event loop', async () => {
    const { packet, root } = nativePacket();
    const probe = await openAsync(join(root, 'sync-probe'), 'w');
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    const realSync = fileHandlePrototype.sync;
    await probe.close();
    let releaseFirstSync!: () => void;
    let enteredFirstSync!: () => void;
    const firstSyncEntered = new Promise<void>(resolve => { enteredFirstSync = resolve; });
    const firstSyncGate = new Promise<void>(resolve => { releaseFirstSync = resolve; });
    let first = true;
    const sync = vi.spyOn(fileHandlePrototype, 'sync').mockImplementation(async function () {
      if (first) {
        first = false;
        enteredFirstSync();
        await firstSyncGate;
      }
      return realSync.call(this);
    });

    let finished = false;
    const finishing = packet.finish({ cleanup: { complete: true } }).then(() => { finished = true; });
    await firstSyncEntered;
    let eventLoopTurned = false;
    await new Promise<void>(resolve => setImmediate(() => { eventLoopTurned = true; resolve(); }));
    expect(eventLoopTurned).toBe(true);
    expect(finished).toBe(false);
    expect(sync).toHaveBeenCalled();
    releaseFirstSync();
    await finishing;
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({
      nativeCustody: { byteCustody: 'complete', nativeProof: 'unqualified' },
    });
  });
  it('holds an explicit cleanup reserve behind one absolute child cutoff', () => {
    expect(testRunDeadline(45_000, { now: 1000, cleanupReserveMs: 10_000 })).toEqual({
      startedAtMs: 1000, taskDeadlineAtMs: 46_000, childCutoffAtMs: 36_000, cleanupReserveMs: 10_000,
    });
    expect(testRunDeadline(45_000, { now: 20_000, taskDeadlineAtMs: 46_000, cleanupReserveMs: 10_000 }))
      .toMatchObject({ taskDeadlineAtMs: 46_000, childCutoffAtMs: 36_000, cleanupReserveMs: 10_000 });
  });
  it('never refreshes an exhausted inherited deadline or accepts an invalid reserve', () => {
    expect(testRunDeadline(45_000, { now: 50_000, taskDeadlineAtMs: 46_000 }))
      .toMatchObject({ taskDeadlineAtMs: 46_000, childCutoffAtMs: 46_000, cleanupReserveMs: 0 });
    expect(() => testRunDeadline(1000, { cleanupReserveMs: 1000 })).toThrow(/reserve/);
    expect(() => testRunDeadline(0)).toThrow(/budget/);
  });
  it('never borrows an explicit reserve when inherited preparation consumed the child slot', () => {
    expect(testRunDeadline(45_000, { now: 40_000, taskDeadlineAtMs: 46_000, cleanupReserveMs: 10_000 }))
      .toMatchObject({ taskDeadlineAtMs: 46_000, childCutoffAtMs: 36_000, cleanupReserveMs: 10_000 });
  });
  it.each(['closed', 'pending'] as const)('retains reports, channels, source pins and receipts when child state is %s', async childState => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-')); roots.push(root);
    writeFileSync(join(root, 'subject.test.ts'), 'export {};');
    const packet = new TestRunArtifactPacket('run-1', root, testRunDeadline(1000), join(root, 'retained'));
    packet.captureSelectedSources(['subject.test.ts'], { commit: 'abc', porcelain: '' });
    packet.childState = childState;
    writeFileSync(join(packet.paths.reports, 'report.json'), '{"complete":true}');
    writeFileSync(join(packet.paths.directory, 'stdout.log'), 'first byte\nlast byte\n');
    writeFileSync(join(packet.paths.directory, 'stderr.log'), 'separate error\n');
    packet.stage('router-result'); await packet.finish({ cleanup: { complete: childState === 'closed' } });
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({ state: 'retained', childState });
    expect(readFileSync(join(packet.paths.reports, 'report.json'), 'utf8')).toContain('complete');
    expect(readFileSync(join(packet.paths.directory, 'stdout.log'), 'utf8')).toContain('first byte');
    expect(readFileSync(join(packet.paths.directory, 'stderr.log'), 'utf8')).toContain('separate error');
    expect(JSON.parse(readFileSync(join(packet.paths.directory, 'source.json'), 'utf8')).inputs[0])
      .toMatchObject({ path: 'subject.test.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(readFileSync(packet.paths.phases, 'utf8')).toContain('router-result');
  });
});

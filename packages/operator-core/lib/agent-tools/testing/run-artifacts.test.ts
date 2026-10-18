import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestRunArtifactPacket, testRunDeadline } from './run-artifacts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('maintained run deadlines and retained artifacts', () => {
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
  it.each(['closed', 'pending'] as const)('retains reports, channels, source pins and receipts when child state is %s', childState => {
    const root = mkdtempSync(join(tmpdir(), 'run-artifacts-')); roots.push(root);
    writeFileSync(join(root, 'subject.test.ts'), 'export {};');
    const packet = new TestRunArtifactPacket('run-1', root, testRunDeadline(1000), join(root, 'retained'));
    packet.captureSelectedSources(['subject.test.ts'], { commit: 'abc', porcelain: '' });
    packet.childState = childState;
    writeFileSync(join(packet.paths.reports, 'report.json'), '{"complete":true}');
    writeFileSync(join(packet.paths.directory, 'stdout.log'), 'first byte\nlast byte\n');
    writeFileSync(join(packet.paths.directory, 'stderr.log'), 'separate error\n');
    packet.stage('router-result'); packet.finish({ cleanup: { complete: childState === 'closed' } });
    expect(JSON.parse(readFileSync(packet.paths.manifest, 'utf8'))).toMatchObject({ state: 'retained', childState });
    expect(readFileSync(join(packet.paths.reports, 'report.json'), 'utf8')).toContain('complete');
    expect(readFileSync(join(packet.paths.directory, 'stdout.log'), 'utf8')).toContain('first byte');
    expect(readFileSync(join(packet.paths.directory, 'stderr.log'), 'utf8')).toContain('separate error');
    expect(JSON.parse(readFileSync(join(packet.paths.directory, 'source.json'), 'utf8')).inputs[0])
      .toMatchObject({ path: 'subject.test.ts', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(readFileSync(packet.paths.phases, 'utf8')).toContain('router-result');
  });
});

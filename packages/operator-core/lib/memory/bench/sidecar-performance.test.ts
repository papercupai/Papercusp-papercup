import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { latencySummary, performanceSchedule, performanceInputSchema, loadPerformanceInput, verifyCompletedPerformanceRun, type PerformanceInput } from './sidecar-performance';
import { measurementManifestFixture } from './fixtures/measurement-manifest';
import type { PreparedMeasurement } from './measurement-manifest';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('matching-route performance contracts', () => {
  it('verifies predecessor identity explicitly without rebinding the executing session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-predecessor-')); dirs.push(dir);
    const manifest = measurementManifestFixture(dir);
    manifest.ownerId = 'frozen-predecessor';
    const file = path.join(dir, 'manifest.json');
    const bytes = JSON.stringify(manifest); fs.writeFileSync(file, bytes);
    const fingerprint = crypto.createHash('sha256').update(bytes).digest('hex');
    const identity = process.env.PAPERCUSP_SID;
    await expect(verifyCompletedPerformanceRun(file, fingerprint)).rejects.toThrow('predecessor owner mismatch');
    await expect(verifyCompletedPerformanceRun(file, fingerprint, 'frozen-predecessor')).rejects.not.toThrow('predecessor owner mismatch');
    await expect(verifyCompletedPerformanceRun(file, fingerprint, 'wrong-predecessor')).rejects.toThrow('predecessor owner mismatch');
    await expect(verifyCompletedPerformanceRun(file, '0'.repeat(64), 'frozen-predecessor')).rejects.toThrow('predecessor manifest fingerprint mismatch');
    expect(process.env.PAPERCUSP_SID).toBe(identity);
  });
  it('freezes a reproducible five-block permutation with every arm exactly once per block', () => {
    const rows = performanceSchedule('measurement-WI10004539-v1', 5, ['mdenseon', 'gemma', 'harrier']);
    expect(rows).toEqual(performanceSchedule('measurement-WI10004539-v1', 5, ['harrier', 'gemma', 'mdenseon']));
    expect(rows).toHaveLength(15);
    for (let b = 0; b < 5; b++) expect(rows.filter((r) => r.block === b).map((r) => r.armId).sort()).toEqual(['gemma', 'harrier', 'mdenseon']);
    expect(new Set(rows.map((r) => r.cellId)).size).toBe(15);
    expect(new Set(Array.from({ length: 5 }, (_, b) => rows.filter((r) => r.block === b).map((r) => r.armId).join(','))).size).toBeGreaterThan(1);
    expect(() => performanceSchedule('fixed', 4, ['m', 'g', 'h'])).toThrow('five blocks');
    expect(() => performanceSchedule('fixed', 5, ['m', 'm', 'h'])).toThrow('distinct');
  });
  it('derives nearest-rank tails from raw unsorted samples without mutating them', () => {
    const raw = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(latencySummary(raw)).toMatchObject({ n: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, minMs: 1, maxMs: 100 });
    expect(raw[0]).toBe(100);
    for (const bad of [[], [NaN], [-1], [Infinity]]) expect(() => latencySummary(bad)).toThrow('raw latency');
  });
  it('refuses client-truncated or undeclared request shapes before model inference', () => {
    expect(performanceInputSchema.safeParse({ formatVersion: 1, blocks: 4 }).success).toBe(false);
  });
  it('binds the complete randomized population and request bytes before any child can run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-contract-')); dirs.push(dir);
    const m = measurementManifestFixture(dir);
    const input: PerformanceInput = { formatVersion: 1, seed: m.seed, blocks: 5, warmSamples: 2, rounds: 1,
      batches: [1], concurrency: [1], cachedSamples: 1, serverConcurrency: 1,
      requests: { query: [{ id: 'q', corpus: 'memory', text: 'q' }], document: [{ id: 'd', corpus: 'prose', text: 'd' }] } };
    const file = path.join(dir, 'requests.json'), bytes = Buffer.from(JSON.stringify(input)); fs.writeFileSync(file, bytes);
    m.inputs.requests = { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    m.cells = performanceSchedule(m.seed, 5, m.arms.map((a) => a.id)).map((s) => ({ id: s.cellId, bar: 'performance',
      armId: s.armId, inputIds: ['requests'], parameters: { block: s.block, order: s.order, requests: 'requests' }, output: s.cellId }));
    const p = { manifest: m, cell: m.cells[0] } as PreparedMeasurement;
    expect(loadPerformanceInput(p)).toEqual(input);
    m.cells.pop(); expect(() => loadPerformanceInput(p)).toThrow('population');
    fs.appendFileSync(file, ' '); expect(() => loadPerformanceInput(p)).toThrow('fingerprint');
  });
});

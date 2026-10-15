import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Sql } from 'postgres';
import { buildAbDeps, type RealAbDepsConfig } from '../ab-runner-real';
import type { AbRunHandle } from '../ab-runner';
import { readTraceBundle, writeTraceBundle } from '../collector';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gym-trace-retention-'));
  roots.push(root);
  const scratchRoot = join(root, 'scratch');
  const traceRoot = join(root, 'retained');
  let output = 'controlled submission';
  const sql = (async (query: TemplateStringsArray) => query.join('').includes('run_id, role')
    ? [{ run_id: 'worker-run', role: 'worker', out_body: output }]
    : [{ out_body: output }]) as unknown as Sql;
  const deps = buildAbDeps({ gymSql: sql, ports: {} as RealAbDepsConfig['ports'],
    llmCall: async () => { throw new Error('judge must not run'); },
    timeoutMs: 100, pollIntervalMs: 1, scratchRoot, traceRoot,
    collectStrategy: 'work-item-output' });
  const handle: AbRunHandle = { harnessSlug: 'controlled-run', clonePath: scratchRoot,
    workflowID: 'controlled-workflow', outcome: 'passed', pipelineUsd: 0,
    deterministicSignals: { regressions: false } };
  const collect = () => deps.collectAndDistill({ handle,
    task: { taskId: 'controlled-task', pool: 'train', repoUrl: '', repoCommit: '',
      spec: 's', intent: 'i', projectContext: 'c' }, maxChars: 60000 });
  return { scratchRoot, traceRoot, collect, changeOutput: (next: string) => { output = next; } };
}

describe('real Gym trace storage lifetime', () => {
  it('retains the actual trace bytes after the pipeline scratch is removed', async () => {
    const f = fixture();
    const result = await f.collect();
    const before = readFileSync(result.traceRef);
    rmSync(f.scratchRoot, { recursive: true, force: true });
    expect(readFileSync(result.traceRef)).toEqual(before);
    expect(JSON.parse(before.toString())).toMatchObject({ diff: 'controlled submission',
      terminalState: 'passed', signals: { regressions: false },
      roleTranscripts: [{ role: 'worker', runId: 'worker-run', text: 'controlled submission' }] });
    const hash = createHash('sha256').update(before).digest('hex');
    expect(basename(result.traceRef)).toBe(`${hash}.trace.json`);
    expect(result.traceRef.startsWith(f.traceRoot)).toBe(true);
    expect(await readTraceBundle(result.traceRef)).toBe(before.toString());
  });

  it('keeps distinct bytes for repeated collections of the same harness', async () => {
    const f = fixture();
    const first = await f.collect();
    const bytes = await readTraceBundle(first.traceRef);
    f.changeOutput('a later submission');
    const second = await f.collect();
    expect(second.traceRef).not.toBe(first.traceRef);
    expect(await readTraceBundle(first.traceRef)).toBe(bytes);
    expect(JSON.parse(await readTraceBundle(second.traceRef)).diff).toBe('a later submission');
  });

  it('deduplicates concurrent identical bytes without leaking pending files', async () => {
    const f = fixture();
    const refs = await Promise.all(Array.from({ length: 5 }, () => writeTraceBundle(f.traceRoot, '{"trace":"同じ"}')));
    expect(new Set(refs).size).toBe(1);
    expect(await readTraceBundle(refs[0])).toBe('{"trace":"同じ"}');
    expect(readdirSync(f.traceRoot)).toEqual([basename(refs[0])]);
  });

  it('refuses a corrupted artifact on read and deduplication without overwriting it', async () => {
    const f = fixture();
    const ref = await writeTraceBundle(f.traceRoot, 'original');
    writeFileSync(ref, 'changed');
    await expect(readTraceBundle(ref)).rejects.toThrow('hash mismatch');
    await expect(writeTraceBundle(f.traceRoot, 'original')).rejects.toThrow('hash mismatch');
    expect(readFileSync(ref, 'utf8')).toBe('changed');
    expect(readdirSync(f.traceRoot)).toEqual([basename(ref)]);
  });

  it('refuses a retained root inside scratch and unaddressed trace references', async () => {
    const f = fixture();
    expect(() => buildAbDeps({ gymSql: {} as Sql, ports: {} as RealAbDepsConfig['ports'],
      llmCall: async () => { throw new Error('unused'); }, timeoutMs: 1, pollIntervalMs: 1,
      scratchRoot: f.scratchRoot, traceRoot: join(f.scratchRoot, 'traces') })).toThrow('outside');
    await expect(readTraceBundle(join(f.traceRoot, 'old.trace.json'))).rejects.toThrow('not content-addressed');
  });
});

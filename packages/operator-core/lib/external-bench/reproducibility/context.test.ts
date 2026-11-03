import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRestoredBenchmarkContext, restoreBenchmarkContext, readFrozenBenchmarkMemory, type BenchmarkContextInput } from './context';

const roots: string[] = [];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-context-')); roots.push(root);
  const snapshotRoot = join(root, 'frozen'), checkout = join(root, 'assignment-a');
  mkdirSync(snapshotRoot); mkdirSync(checkout);
  // The frozen corpus uses the maintained CorpusEntry fixture representation.
  const corpus = JSON.stringify({ version: 'v1', entries: [{ key: 'doc:public', text: 'Public context π' }] });
  const memory = JSON.stringify({ entries: [{ key: 'memory:permitted', text: 'Shared starting memory.' }] });
  writeFileSync(join(snapshotRoot, 'corpus.json'), corpus); writeFileSync(join(snapshotRoot, 'memory.json'), memory);
  writeFileSync(join(snapshotRoot, 'other-arm-solutions.json'), 'OTHER_ARM_SENTINEL');
  writeFileSync(join(snapshotRoot, 'hidden-grader-answers.json'), 'GRADER_SENTINEL');
  const input: BenchmarkContextInput = {
    binding: { workspaceId: 'bench-private', runId: 'matched-run', preregHash: 'a'.repeat(64),
      assignmentId: 'bench-assignment:a', harnessSlug: 'xbench-a' },
    context: { corpusRef: 'corpus.json', memoryRef: 'memory.json', corpusHash: sha(corpus), memoryHash: sha(memory),
      isolation: 'fresh-per-assignment', forbiddenSources: ['other-arm-solutions', 'hidden-grader-answers'] },
    checkout, snapshotRoot,
  };
  return { root, input, corpus, memory };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('physical frozen benchmark context', () => {
  it('recalls only pinned snapshot bytes and refuses altered or linked memory', () => {
    const f = fixture(), restored = restoreBenchmarkContext(f.input);
    expect(readFrozenBenchmarkMemory(f.input.checkout, f.input.context.memoryHash))
      .toEqual([{ key: 'memory:permitted', text: 'Shared starting memory.' }]);
    expect(() => readFrozenBenchmarkMemory(f.input.checkout, 'f'.repeat(64))).toThrow(/bytes differ/);
    writeFileSync(restored.memoryPath, JSON.stringify({ entries: [{ key: 'foreign', text: 'PRIVATE' }] }));
    expect(() => readFrozenBenchmarkMemory(f.input.checkout, f.input.context.memoryHash)).toThrow(/bytes differ/);
    rmSync(restored.memoryPath); symlinkSync(join(f.input.snapshotRoot, 'memory.json'), restored.memoryPath);
    expect(() => readFrozenBenchmarkMemory(f.input.checkout, f.input.context.memoryHash)).toThrow(/symbolic link/);
  });
  it('restores byte-identical permitted context for both matched arms and independently reads each receipt', () => {
    const f = fixture(); const a = restoreBenchmarkContext(f.input);
    const second = join(f.root, 'assignment-b'); mkdirSync(second);
    const input = { ...f.input, checkout: second, binding: { ...f.input.binding, assignmentId: 'bench-assignment:b', harnessSlug: 'xbench-b' } };
    const b = restoreBenchmarkContext(input);
    expect(a.contextText).toBe(b.contextText); expect(a.contextTextSha256).toBe(b.contextTextSha256);
    expect(a.receiptRef).not.toBe(b.receiptRef);
    expect(readFileSync(a.corpusPath, 'utf8')).toBe(f.corpus);
    expect(readFileSync(b.memoryPath, 'utf8')).toBe(f.memory);
    expect(readRestoredBenchmarkContext(f.input)).toEqual(a);
    expect(readRestoredBenchmarkContext(input)).toEqual(b);
    expect(a.contextText).not.toMatch(/OTHER_ARM_SENTINEL|GRADER_SENTINEL/);
    expect(existsSync(join(second, '.papercusp/benchmark-context/other-arm-solutions.json'))).toBe(false);
    writeFileSync(a.memoryPath, JSON.stringify({ entries: [{ key: 'memory:previous-arm', text: 'OTHER_ARM_SENTINEL' }] }));
    expect(() => readRestoredBenchmarkContext(f.input)).toThrow(/bytes differ/);
    expect(readRestoredBenchmarkContext(input)).toEqual(b);
  });
  it.each(['corpus', 'memory'] as const)('rejects changed %s source bytes before creating a restoration directory', kind => {
    const f = fixture(); writeFileSync(join(f.input.snapshotRoot, `${kind}.json`), JSON.stringify({ entries: [] }));
    expect(() => restoreBenchmarkContext(f.input)).toThrow(/bytes differ/);
    expect(existsSync(join(f.input.checkout, '.papercusp/benchmark-context'))).toBe(false);
  });
  it.each(['corpus', 'memory', 'receipt', 'extra-file'] as const)('detects %s contamination on pre-generation re-read', kind => {
    const f = fixture(), receipt = restoreBenchmarkContext(f.input);
    if (kind === 'extra-file') writeFileSync(join(f.input.checkout, '.papercusp/benchmark-context/solution.json'), 'OTHER_ARM_SENTINEL');
    else writeFileSync(kind === 'corpus' ? receipt.corpusPath : kind === 'memory' ? receipt.memoryPath : receipt.receiptPath, '{}');
    expect(() => readRestoredBenchmarkContext(f.input)).toThrow();
  });
  it('refuses receipt reuse across assignments and never overwrites an earlier restoration', () => {
    const f = fixture(); restoreBenchmarkContext(f.input);
    expect(() => restoreBenchmarkContext(f.input)).toThrow();
    expect(() => readRestoredBenchmarkContext({ ...f.input,
      binding: { ...f.input.binding, assignmentId: 'bench-assignment:foreign' } })).toThrow(/receipt differs/);
  });
  it.each(['../corpus.json', '/corpus.json', './corpus.json', 'nested/../corpus.json', 'nested\\corpus.json'])
  ('rejects an escaping or noncanonical source reference %s', corpusRef => {
    const f = fixture(); expect(() => restoreBenchmarkContext({ ...f.input, context: { ...f.input.context, corpusRef } })).toThrow(/reference/);
  });
  it.each(['source', 'source-parent', 'destination', 'restored-file'])('rejects a symbolic link in the %s path', kind => {
    const f = fixture();
    if (kind === 'restored-file') {
      const a = restoreBenchmarkContext(f.input); rmSync(a.corpusPath); symlinkSync(join(f.input.snapshotRoot, 'corpus.json'), a.corpusPath);
      expect(() => readRestoredBenchmarkContext(f.input)).toThrow(/symbolic link/); return;
    }
    if (kind === 'source') {
      const file = join(f.input.snapshotRoot, 'corpus.json'); rmSync(file); symlinkSync(join(f.input.snapshotRoot, 'memory.json'), file);
    } else if (kind === 'source-parent') {
      symlinkSync(f.input.snapshotRoot, join(f.input.snapshotRoot, 'linked'));
      f.input.context.corpusRef = 'linked/corpus.json';
    } else symlinkSync(f.input.snapshotRoot, join(f.input.checkout, '.papercusp'));
    expect(() => restoreBenchmarkContext(f.input)).toThrow(/symbolic link/);
  });
  it.each(['other-arm-solutions', 'hidden-grader-answers'])('rejects declared forbidden snapshot source %s even with a matching hash', source => {
    const f = fixture(), text = JSON.stringify({ entries: [{ key: `${source}:fixture`, text: 'SECRET_SENTINEL' }] });
    writeFileSync(join(f.input.snapshotRoot, 'corpus.json'), text); f.input.context.corpusHash = sha(text);
    expect(() => restoreBenchmarkContext(f.input)).toThrow(/forbidden source/);
  });
  it('rejects snapshots with duplicate keys rather than silently overwriting memory', () => {
    const f = fixture(), text = JSON.stringify({ entries: [{ key: 'm', text: 'first' }, { key: 'm', text: 'second' }] });
    writeFileSync(join(f.input.snapshotRoot, 'memory.json'), text); f.input.context.memoryHash = sha(text);
    expect(() => restoreBenchmarkContext(f.input)).toThrow(/keys must be unique/);
  });
});

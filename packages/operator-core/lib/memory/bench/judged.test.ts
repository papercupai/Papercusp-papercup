/**
 * T3 judged-usefulness tier — pure parts + fake-LLM integration
 * (memory-backend-benchmark P-008). No real LLM, no PG: the llm seam
 * gets a fake judge, the backend context an in-memory store.
 */

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CorpusEntry } from '@papercusp/memory/bench';
import { candidateSourcePartition } from './candidate-hybrid-bench';
import { hashJson, fingerprintFile } from './measurement-manifest';

import { deriveRubricVersion, JUDGE_PROMPT_SCAFFOLD_VERSION } from '@papercusp/testing-shell/llm';
import type { LlmCallFn } from '@papercusp/testing-shell/llm';
import type { GoldQuery } from '@papercusp/memory/bench';
import type { MemoryBackend, MemoryEntry, RememberOptions } from '@papercusp/memory';

import {
  JUDGED_CLASSES,
  JUDGED_INSTRUCTION_CONTRACT,
  JUDGED_TIER_JUDGE_MODEL,
  JUDGED_TIER_RUBRIC_VERSION,
  MEMORY_USEFULNESS_RUBRIC,
  MEMORY_USEFULNESS_RUBRIC_CONTENT,
  aggregateOutcomes,
  deriveJudgedTierRubricVersion,
  renderTopHit,
  runJudgedTier,
  sampleGoldForJudging,
  synthesizeRun,
  deriveBlindConsensus,
  BLIND_COHORT_CONTRACT,
  collectIndependentCohort,
  writeBlindReceipt,
  parseBlindChunkVotes,
  BLIND_FORMAT_REPAIR,
  parseBlindTargetBudget,
  selectBlindSourceTargets,
  type JudgedQueryOutcome,
} from './judged';
import type { BackendCtx } from './run-bench';

function gq(id: string, cls: GoldQuery['class'], over: Partial<GoldQuery> = {}): GoldQuery {
  return { id, class: cls, query: `query ${id}`, expected: [`key-${id}`], ...over };
}

describe('immutable blind receipt publication', () => {
  it('keeps an interrupted partial write out of the final receipt namespace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-receipt-write-'));
    const file = path.join(root, 'call.json'), originalWrite = fs.writeFileSync;
    const interrupted = new Error('interrupted receipt write');
    const writer = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (typeof target === 'number') {
        originalWrite(target, '{');
        expect(fs.existsSync(file)).toBe(false);
        throw interrupted;
      }
      return originalWrite(target, data, options);
    });
    try {
      expect(() => writeBlindReceipt(file, { result: 'complete' })).toThrow(interrupted);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(root)).toEqual([]);
      writer.mockRestore();
      writeBlindReceipt(file, { result: 'complete' });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ result: 'complete' });
      expect(fs.readdirSync(root)).toEqual(['call.json']);
    } finally { writer.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves a competing complete receipt rather than overwriting it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-receipt-race-'));
    const file = path.join(root, 'call.json'), originalLink = fs.linkSync;
    const winner = JSON.stringify({ invocationId: 'other', result: 'winner' });
    const publish = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      fs.writeFileSync(file, winner, { flag: 'wx' });
      return originalLink(from, to);
    });
    try {
      expect(() => writeBlindReceipt(file, { invocationId: 'this', result: 'loser' })).toThrow(/EEXIST/);
      expect(fs.readFileSync(file, 'utf8')).toBe(winner);
      expect(fs.readdirSync(root)).toEqual(['call.json']);
    } finally { publish.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('independent blind label consensus', () => {
  const entries = ['a', 'b'].map((key) => ({ key, text: `source ${key}`, kind: 'fact',
    metadata: { cluster: key, partition: key === 'a' ? 'calibration' : 'test' } }));
  const questions = entries.flatMap((e) => ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'].map((cls) => ({
    id: `${e.key}-${cls}`, class: cls, query: 'frozen blind question', expected: [], group: e.key,
    partition: e.metadata.partition as 'calibration' | 'test',
  })));
  const votes = questions.map((q) => ({ queryId: q.id, relevantKeys: q.class === 'hard-negative' ? [] : [q.group], ambiguous: false, note: 'raw judgment' }));
  it('requires complete independently supplied votes and never turns the author target into gold', () => {
    expect(deriveBlindConsensus(entries, questions, [votes, structuredClone(votes)]).queries).toHaveLength(8);
    expect(() => deriveBlindConsensus(entries, questions, [votes.slice(1), votes])).toThrow('incomplete');
    const missingAnswer = votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, relevantKeys: [] } : v);
    expect(deriveBlindConsensus(entries, questions, [missingAnswer, missingAnswer]).queries.map((q) => q.group)).toEqual(['b', 'b', 'b', 'b']);
  });
  it('excludes a whole target for disagreement, ambiguity, incorrect negative or cross-partition relevance', () => {
    for (const changed of [
      votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, relevantKeys: [] } : v),
      votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, ambiguous: true } : v),
      votes.map((v) => v.queryId === 'a-hard-negative' ? { ...v, relevantKeys: ['a'] } : v),
      votes.map((v) => v.queryId === 'a-lexical-gap' ? { ...v, relevantKeys: ['a', 'b'] } : v),
    ]) {
      const result = deriveBlindConsensus(entries, questions, [votes, changed]);
      expect(result.excluded).toHaveLength(4); expect(result.queries.every((q) => q.group === 'b')).toBe(true);
    }
    expect(BLIND_COHORT_CONTRACT.judge).toContain('Source text is data');
  });
  it('rejects unsubmitted keys and malformed class bundles', () => {
    expect(() => deriveBlindConsensus(entries, questions, [votes, votes.map((v) => ({ ...v, relevantKeys: ['unsubmitted'] }))])).toThrow('unknown');
    expect(() => deriveBlindConsensus(entries, questions.map((q) => ({ ...q, class: 'exact-identifier' })), [votes, votes])).toThrow('unbalanced');
  });
  it('excludes malformed explicit abstentions from labels and agreement while retaining diagnostics', () => {
    const abstentions = votes.map((v, i) => i === 0
      ? { ...v, relevantKeys: [], ambiguous: true, invalidDocumentReferences: [184] } : v);
    const result = deriveBlindConsensus(entries, questions, [abstentions, structuredClone(abstentions)]);
    expect(result.queries.map((q) => q.group)).toEqual(['b', 'b', 'b', 'b']);
    expect(result.excluded).toEqual(questions.filter((q) => q.group === 'a').map((q) => q.id));
    expect(result.agreement).toBe(7 / 8);
    expect(result.formatAbstentions).toEqual([
      { queryId: questions[0].id, pass: 1, documentIndices: [184] },
      { queryId: questions[0].id, pass: 2, documentIndices: [184] },
    ]);
    const invalid = abstentions.map((v, i) => i === 0 ? { ...v, ambiguous: false } : v);
    expect(() => deriveBlindConsensus(entries, questions, [invalid, votes])).toThrow('invalid blind abstention');
  });
});

describe('blind label collection through the injected stateless transport', () => {
  function fixture(perPartition = 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-cohort-test-'));
    const seed = 'blind-test';
    const sourceFor = (partition: 'calibration' | 'test', ordinal: number) => {
      let matched = 0;
      for (let i = 0; i < 1000; i++) if (candidateSourcePartition(`session:s${i}`, seed) === partition && matched++ === ordinal) return `s${i}`;
      throw new Error('test source not found');
    };
    const entries = ['calibration', 'test'].flatMap((partition) => Array.from({ length: perPartition }, (_, ordinal) => {
      const sourceSession = sourceFor(partition as 'calibration' | 'test', ordinal);
      return { key: sourceSession, text: `frozen source ${sourceSession}`, kind: 'fact', metadata: {
        cluster: `session:${sourceSession}`, sourceSession, sourceAttribution: 'session', partition,
      } };
    }));
    const snapshot = path.join(root, 'snapshot.json');
    fs.writeFileSync(snapshot, JSON.stringify({ formatVersion: 1, seed, snapshotAt: '2026-01-01T00:00:00.000Z',
      suites: { memory: { entries }, prose: { entries } } }));
    let calls = 0;
    const llm: LlmCallFn = async (opts) => {
      calls++; expect(opts.ownerId).toBeTruthy(); expect(opts.model).toBe(BLIND_COHORT_CONTRACT.model);
      const input = JSON.parse(opts.messages[0].content);
      const json = input.questions ? { votes: input.questions.map((q: { index: number; query: string }) => ({
        q: q.index, d: q.query.endsWith('hard-negative') ? []
          : input.sources.filter((s: { index: number; text: string }) => q.query.includes(`target=${s.text.split(' ').at(-1)};`)).map((s: { index: number }) => s.index),
        a: false,
      })) } : { queries: ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'].map((cls) => ({
        class: cls, query: `target=${input.sources[0].key}; fixture question ${cls}`,
      })) };
      return { text: JSON.stringify(json), json, inputTokens: 1, outputTokens: 1, costUsd: 0, raw: null };
    };
    return { root, snapshot, llm, get calls() { return calls; } };
  }
  function smallerMemorySnapshot(f: ReturnType<typeof fixture>, perPartition: number, name: string) {
    const snapshot = JSON.parse(fs.readFileSync(f.snapshot, 'utf8'));
    snapshot.suites.memory.entries = snapshot.suites.memory.entries.filter((_: CorpusEntry, index: number) =>
      index % (snapshot.suites.prose.entries.length / 2) < perPartition);
    const file = path.join(f.root, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot));
    return file;
  }
  it('produces byte-identical labels at any call concurrency, bounded by the requested limit (WI-10004537 V20)', async () => {
    const f = fixture(9); // 18 sources -> 72 questions -> two question chunks per judge pass
    try {
      const run = async (callConcurrency: number) => {
        let inFlight = 0, peak = 0;
        const llm: LlmCallFn = async (opts) => {
          inFlight++; peak = Math.max(peak, inFlight);
          try { await new Promise((resolve) => setTimeout(resolve, 2)); return await f.llm(opts); } finally { inFlight--; }
        };
        const out = path.join(f.root, `c${callConcurrency}`);
        const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 'all', callConcurrency });
        return { peak, labels: fs.readFileSync(receipt.labels.path), files: fs.readdirSync(out).sort() };
      };
      const sequential = await run(1), concurrent = await run(4);
      expect(sequential.peak).toBe(1);
      expect(concurrent.peak).toBeGreaterThan(1);
      expect(concurrent.peak).toBeLessThanOrEqual(4);
      expect(concurrent.labels).toEqual(sequential.labels);
      expect(concurrent.files).toEqual(sequential.files);
      expect(sequential.files.some((name) => /-judge-1-0-q64\.json$/.test(name))).toBe(true);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('refuses a call concurrency outside [1, 32]', async () => {
    const f = fixture(1);
    try {
      for (const callConcurrency of [0, 33, 1.5]) {
        await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, `bad-${callConcurrency}`), llm: f.llm,
          targetsPerPartition: 'all', callConcurrency })).rejects.toThrow(/callConcurrency/);
      }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('parses a frozen snapshot once per invocation while rechecking its fingerprint across reused ancestry', async () => {
    const f = fixture(2);
    try {
      const first = path.join(f.root, 'first'), middle = path.join(f.root, 'middle');
      await collectIndependentCohort({ snapshot: f.snapshot, out: first, llm: f.llm, targetsPerPartition: 'all' });
      await collectIndependentCohort({ snapshot: f.snapshot, out: middle, llm: f.llm,
        targetsPerPartition: 'all', reuseCallsFrom: first, reuseSnapshotExpansion: true });
      const read = vi.spyOn(fs, 'readFileSync'), stream = vi.spyOn(fs, 'createReadStream'), llm = vi.fn(f.llm);
      try {
        const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'final'), llm,
          targetsPerPartition: 'all', reuseCallsFrom: middle, reuseSnapshotExpansion: true });
        expect(llm).not.toHaveBeenCalled();
        expect(read.mock.calls.filter(([file]) => file === f.snapshot)).toHaveLength(2); // Current + one validated donor parse.
        expect(stream.mock.calls.filter(([file]) => file === f.snapshot).length).toBeGreaterThan(2);
        expect(fs.readFileSync(receipt.labels.path)).toEqual(fs.readFileSync(path.join(middle, 'labels.json')));
      } finally { read.mockRestore(); stream.mockRestore(); }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['snapshot', 'identity'])('refuses an ancestor %s changed after the first cached recovery', async failure => {
    const f = fixture(2);
    try {
      const first = path.join(f.root, 'first'), middle = path.join(f.root, 'middle');
      await collectIndependentCohort({ snapshot: f.snapshot, out: first, llm: f.llm, targetsPerPartition: 'all' });
      await collectIndependentCohort({ snapshot: f.snapshot, out: middle, llm: f.llm,
        targetsPerPartition: 'all', reuseCallsFrom: first, reuseSnapshotExpansion: true });
      const llm = vi.fn(f.llm); let changed = false;
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'refused'), llm,
        targetsPerPartition: 'all', reuseCallsFrom: middle, reuseSnapshotExpansion: true,
        log: message => {
          if (!changed && message.includes(' reused original ')) {
            changed = true;
            fs.appendFileSync(failure === 'snapshot' ? f.snapshot : path.join(first, 'identity.json'), ' ');
          }
        } })).rejects.toThrow('fingerprint');
      expect(changed).toBe(true); expect(llm).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('expands memory without repaying unchanged prose or exact author prompts, including reference-bearing ancestry', async () => {
    const f = fixture(3);
    try {
      const firstSnapshot = smallerMemorySnapshot(f, 1, 'first-snapshot');
      const secondSnapshot = smallerMemorySnapshot(f, 2, 'second-snapshot');
      const first = path.join(f.root, 'first'), second = path.join(f.root, 'second'), final = path.join(f.root, 'final');
      await collectIndependentCohort({ snapshot: firstSnapshot, out: first, llm: f.llm, targetsPerPartition: 'all' });
      expect(f.calls).toBe(12); // Two memory authors, six prose authors, four judges.
      const originals = fs.readdirSync(first).map((name) => ({ name, bytes: fs.readFileSync(path.join(first, name)) }));
      const prosePasses = [1, 2].map((pass) => JSON.parse(fs.readFileSync(path.join(first, `prose-judge-${pass}-pass.json`), 'utf8')));
      let donor = first;
      for (const [snapshot, out] of [[secondSnapshot, second], [f.snapshot, final]]) {
        const before = f.calls;
        const receipt = await collectIndependentCohort({ snapshot, out, llm: f.llm, targetsPerPartition: 'all',
          reuseCallsFrom: donor, reuseSnapshotExpansion: true });
        expect(f.calls - before).toBe(4); // Two new memory authors and two fresh memory judge passes, nothing else.
        const labels = JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8'));
        expect(labels.prose).toHaveLength(24);
        expect(labels.memory).toHaveLength(out === second ? 16 : 24);
        for (const [index, pass] of [1, 2].entries()) {
          const reused = JSON.parse(fs.readFileSync(path.join(out, `prose-judge-${pass}-pass.json`), 'utf8'));
          expect(reused.calls.map((c: { invocationId: string }) => c.invocationId))
            .toEqual(prosePasses[index].calls.map((c: { invocationId: string }) => c.invocationId));
          const memory = JSON.parse(fs.readFileSync(path.join(out, `memory-judge-${pass}-0.json`), 'utf8'));
          expect(memory.kind).toBe('selected-call');
        }
        donor = out;
      }
      for (const { name, bytes } of originals) expect(fs.readFileSync(path.join(first, name))).toEqual(bytes);
      const noCalls: LlmCallFn = vi.fn(async () => { throw new Error('unexpected paid replay'); });
      await collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'audit'), llm: noCalls,
        targetsPerPartition: 'all', reuseCallsFrom: final, reuseSnapshotExpansion: true });
      expect(noCalls).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('recovers unchanged prose judges through an interrupted memory expansion without new prose calls', async () => {
    const f = fixture(2);
    try {
      const firstSnapshot = smallerMemorySnapshot(f, 1, 'first-snapshot');
      const original = path.join(f.root, 'original'), partial = path.join(f.root, 'partial'), final = path.join(f.root, 'final');
      const first = await collectIndependentCohort({ snapshot: firstSnapshot, out: original, llm: f.llm, targetsPerPartition: 'all' });
      const originalFiles = fs.readdirSync(original).map(name => ({ name, bytes: fs.readFileSync(path.join(original, name)) }));
      let freshJudges = 0;
      const paused: LlmCallFn = async opts => {
        if (JSON.parse(opts.messages[0].content).questions && ++freshJudges === 2) throw new Error('fixture expansion interrupted');
        return f.llm(opts);
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: partial, llm: paused,
        targetsPerPartition: 'all', reuseCallsFrom: original, reuseSnapshotExpansion: true }))
        .rejects.toThrow('fixture expansion interrupted');
      expect(fs.readdirSync(partial).some(name => name.startsWith('prose-'))).toBe(false);
      const calls: unknown[] = [];
      const llm: LlmCallFn = async opts => {
        calls.push(JSON.parse(opts.messages[0].content));
        return f.llm(opts);
      };
      const result = await collectIndependentCohort({ snapshot: f.snapshot, out: final, llm,
        targetsPerPartition: 'all', reuseCallsFrom: partial, reuseSnapshotExpansion: true });
      expect(calls).toHaveLength(1); // Only the interrupted second memory judge, no authors or prose.
      for (const pass of [1, 2]) {
        const before = JSON.parse(fs.readFileSync(path.join(original, `prose-judge-${pass}-pass.json`), 'utf8'));
        const after = JSON.parse(fs.readFileSync(path.join(final, `prose-judge-${pass}-pass.json`), 'utf8'));
        expect(after.votes).toEqual(before.votes);
        expect(after.calls.map((c: { invocationId: string }) => c.invocationId))
          .toEqual(before.calls.map((c: { invocationId: string }) => c.invocationId));
      }
      expect(JSON.parse(fs.readFileSync(result.labels.path, 'utf8')).prose)
        .toEqual(JSON.parse(fs.readFileSync(first.labels.path, 'utf8')).prose);
      for (const { name, bytes } of originalFiles) expect(fs.readFileSync(path.join(original, name))).toEqual(bytes);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('refuses a changed judge contract in a partial donor ancestor before generating', async () => {
    const f = fixture();
    try {
      const original = path.join(f.root, 'original'), partial = path.join(f.root, 'partial');
      const judgeContract = BLIND_COHORT_CONTRACT.judge;
      try {
        BLIND_COHORT_CONTRACT.judge += ' altered';
        await collectIndependentCohort({ snapshot: f.snapshot, out: original, llm: f.llm, targetsPerPartition: 1 });
      } finally { BLIND_COHORT_CONTRACT.judge = judgeContract; }
      const identityFile = path.join(original, 'identity.json');
      const ancestor = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      // An interrupted exact-call donor with no local calls and an altered
      // ancestor: author prompts still match, judge contracts do not.
      const reference = { identity: await fingerprintFile(identityFile), identityHash: ancestor.identityHash };
      const identity = { ...ancestor.identity, contract: { ...BLIND_COHORT_CONTRACT },
        authorReuse: reference, callReuse: reference };
      fs.mkdirSync(partial);
      fs.writeFileSync(path.join(partial, 'identity.json'), JSON.stringify({ identity, identityHash: hashJson(identity) }));
      // No paid call is allowed while testing the missing-judge ancestry branch.
      const llm: LlmCallFn = vi.fn(async () => { throw new Error('unexpected generation'); });
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'final'),
        llm, reuseCallsFrom: partial, targetsPerPartition: 1 })).rejects.toThrow('ancestor judge contract');
      expect(llm).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('reauthors only a source whose prompt grows and does not reuse that changed corpus judges', async () => {
    const f = fixture();
    try {
      const donor = path.join(f.root, 'donor');
      await collectIndependentCohort({ snapshot: f.snapshot, out: donor, llm: f.llm, targetsPerPartition: 'all' });
      const snapshot = JSON.parse(fs.readFileSync(f.snapshot, 'utf8'));
      const entry = snapshot.suites.memory.entries[0];
      snapshot.suites.memory.entries.push({ ...entry, key: `${entry.key}-extra` });
      const expanded = path.join(f.root, 'expanded.json');
      fs.writeFileSync(expanded, JSON.stringify(snapshot));
      const before = f.calls;
      await collectIndependentCohort({ snapshot: expanded, out: path.join(f.root, 'expanded'), llm: f.llm,
        targetsPerPartition: 'all', reuseCallsFrom: donor, reuseSnapshotExpansion: true });
      expect(f.calls - before).toBe(3); // One changed author prompt + two new memory judges; prose costs zero.
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['missing-opt-in', 'text', 'metadata', 'removed', 'order', 'seed', 'date', 'donor-bytes', 'budget'])
    ('refuses %s snapshot expansion before any paid call or output creation', async (failure) => {
      const f = fixture(2);
      try {
        const small = smallerMemorySnapshot(f, 1, 'small'), donor = path.join(f.root, 'donor');
        await collectIndependentCohort({ snapshot: small, out: donor, llm: f.llm, targetsPerPartition: 'all' });
        const snapshot = JSON.parse(fs.readFileSync(f.snapshot, 'utf8'));
        if (failure === 'text') snapshot.suites.memory.entries[0].text += ' changed';
        if (failure === 'metadata') snapshot.suites.memory.entries[0].metadata.textSha256 = 'changed';
        if (failure === 'removed') snapshot.suites.memory.entries.splice(0, 1);
        if (failure === 'order') snapshot.suites.memory.entries.reverse();
        if (failure === 'seed') snapshot.seed += ' changed';
        if (failure === 'date') snapshot.snapshotAt = '2026-01-02T00:00:00.000Z';
        if (failure === 'donor-bytes') fs.appendFileSync(small, '\n');
        const expanded = path.join(f.root, 'expanded.json');
        fs.writeFileSync(expanded, JSON.stringify(snapshot));
        const noCalls: LlmCallFn = vi.fn(f.llm), out = path.join(f.root, 'refused');
        await expect(collectIndependentCohort({ snapshot: expanded, out, llm: noCalls,
          targetsPerPartition: failure === 'budget' ? 1 : 'all', reuseCallsFrom: donor,
          ...(failure === 'missing-opt-in' ? {} : { reuseSnapshotExpansion: true }) }))
          .rejects.toThrow(/recovery|partition/);
        expect(noCalls).not.toHaveBeenCalled();
        expect(fs.existsSync(out)).toBe(false);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  it('requires exact-call recovery for the snapshot expansion opt-in', async () => {
    const f = fixture();
    try {
      const out = path.join(f.root, 'refused');
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: f.llm,
        reuseSnapshotExpansion: true })).rejects.toThrow('expansion requires exact-call recovery');
      expect(f.calls).toBe(0); expect(fs.existsSync(out)).toBe(false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('binds expansion to the original owner, complete contract and accepted reference ancestry', async () => {
    for (const failure of ['owner', 'judge', 'author', 'reference']) {
      const f = fixture(2);
      try {
        const small = smallerMemorySnapshot(f, 1, 'small'), original = path.join(f.root, 'original');
        await collectIndependentCohort({ snapshot: small, out: original, llm: f.llm, targetsPerPartition: 'all' });
        const middle = path.join(f.root, 'middle');
        await collectIndependentCohort({ snapshot: small, out: middle, llm: f.llm,
          targetsPerPartition: 'all', reuseCallsFrom: original });
        const identityFile = path.join(middle, 'identity.json'), identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        if (failure === 'owner') identity.identity.ownerId = 'foreign-owner';
        if (failure === 'judge') identity.identity.contract.judge += ' changed';
        if (failure === 'author') identity.identity.contract.author += ' changed';
        if (failure !== 'reference') {
          identity.identityHash = hashJson(identity.identity);
          fs.writeFileSync(identityFile, JSON.stringify(identity));
        } else {
          const name = fs.readdirSync(middle).find((name) => /^memory-author-[a-f0-9]+\.json$/.test(name))!;
          const file = path.join(middle, name), ref = JSON.parse(fs.readFileSync(file, 'utf8'));
          ref.invocationId = 'foreign-invocation'; fs.writeFileSync(file, JSON.stringify(ref));
        }
        const noCalls: LlmCallFn = vi.fn(f.llm);
        await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'refused'), llm: noCalls,
          targetsPerPartition: 'all', reuseCallsFrom: middle, reuseSnapshotExpansion: true })).rejects.toThrow(/recovery|reference/);
        // A foreign call may be discovered lazily; its rejection must never
        // supply synthetic labels or pay to replace that valid reference.
        if (failure !== 'reference') expect(noCalls).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(f.root, 'refused', 'judgments.json'))).toBe(false);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }
  });
  it('handles fenced blind replies after prose with earlier JSON-like braces without rewriting raw receipts', async () => {
    const f = fixture();
    try {
      const llm: LlmCallFn = async (opts) => {
        const result = await f.llm(opts);
        return { ...result, json: undefined, stopReason: 'end_turn',
          text: `Prose notation { q: index, d: [] } is not JSON.\n\`\`\`json\n${result.text}\n\`\`\`\nEnd of response.` };
      };
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'fenced'), llm, targetsPerPartition: 1 });
      const labels = JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8'));
      expect(labels.memory).toHaveLength(8); expect(labels.prose).toHaveLength(8);
      expect(f.calls).toBe(8);
      const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(receipt.labels.path), 'memory-judge-1-0-attempt-1.json'), 'utf8'));
      expect(raw.result.text).toContain('{ q: index, d: [] }');
      expect(raw.result.json).toBeUndefined();
      expect(raw.promptSha256).toBe(hashJson({ system: raw.system, messages: raw.messages, model: raw.model }));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('retries malformed votes without inferring ambiguity, preserves failed raw and resumes valid calls', async () => {
    const f = fixture();
    try {
      const donor = path.join(f.root, 'donor'), out = path.join(f.root, 'recovered');
      let first = true;
      const malformed: LlmCallFn = async (opts) => {
        if (!first) throw new Error('fixture interruption after malformed reply');
        const result = await f.llm(opts);
        if (JSON.parse(opts.messages[0].content).questions && first) {
          first = false;
          const payload = result.json as { votes: Array<{ q: number; d: number[]; a?: boolean }> };
          delete payload.votes[2].a;
          return { ...result, json: undefined, text: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` };
        }
        return result;
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: donor, llm: malformed, targetsPerPartition: 1 }))
        .rejects.toThrow('fixture interruption');
      const failed = path.join(donor, 'memory-judge-1-0-attempt-1.json'), pin = await fingerprintFile(failed);
      expect(JSON.parse(fs.readFileSync(failed, 'utf8')).result.text).toContain('"q":2');
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm: f.llm,
        targetsPerPartition: 1, reuseCallsFrom: donor });
      expect(f.calls).toBe(9); // Four authors + four valid judges + one retained malformed judge.
      expect(await fingerprintFile(failed)).toEqual(pin);
      const chosen = JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0.json'), 'utf8'));
      expect(chosen.kind).toBe('selected-call');
      expect(chosen.origin.path).toBe(path.join(out, 'memory-judge-1-0-attempt-2.json'));
      expect(JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8')).memory).toHaveLength(8);
      const noCalls: LlmCallFn = vi.fn(async () => { throw new Error('unexpected paid replay'); });
      await collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'final'), llm: noCalls,
        targetsPerPartition: 1, reuseCallsFrom: out });
      expect(noCalls).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('recovers a legacy malformed canonical donor only with a fresh exact-prompt judge response', async () => {
    const f = fixture();
    try {
      const donor = path.join(f.root, 'legacy-malformed'), out = path.join(f.root, 'recovered-legacy');
      let failed = false;
      const malformed: LlmCallFn = async (opts) => {
        if (failed) throw new Error('fixture legacy boundary');
        const result = await f.llm(opts);
        if (JSON.parse(opts.messages[0].content).questions) {
          failed = true;
          const json = result.json as { votes: Array<{ a?: boolean }> };
          delete json.votes[2].a;
          return { ...result, json, text: JSON.stringify(json) };
        }
        return result;
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: donor, llm: malformed, targetsPerPartition: 1 }))
        .rejects.toThrow('legacy boundary');
      const canonical = path.join(donor, 'memory-judge-1-0.json');
      fs.writeFileSync(canonical, fs.readFileSync(path.join(donor, 'memory-judge-1-0-attempt-1.json')));
      const pin = await fingerprintFile(canonical), original = JSON.parse(fs.readFileSync(canonical, 'utf8'));
      let replacement: unknown;
      const llm: LlmCallFn = async (opts) => {
        replacement ??= { model: opts.model, system: opts.system, messages: opts.messages };
        return f.llm(opts);
      };
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1, reuseCallsFrom: donor });
      expect(replacement).toEqual({ model: original.model, system: original.system, messages: original.messages });
      expect(await fingerprintFile(canonical)).toEqual(pin);
      const rejected = JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0-rejected-donor.json'), 'utf8'));
      expect(rejected).toMatchObject({ kind: 'rejected-call', origin: pin, invocationId: original.invocationId });
      const selected = JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0.json'), 'utf8'));
      expect(selected.invocationId).not.toBe(original.invocationId);
      expect(path.basename(selected.origin.path)).toBe('memory-judge-1-0-attempt-2.json');
      expect(JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8')).memory).toHaveLength(8);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('bounds malformed response attempts across same-output interruption recovery', async () => {
    const f = fixture();
    try {
      const out = path.join(f.root, 'bounded');
      const bad: LlmCallFn = async (opts) => {
        const result = await f.llm(opts);
        if (JSON.parse(opts.messages[0].content).questions) return { ...result, json: { votes: [] } };
        return result;
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: bad, targetsPerPartition: 1 }))
        .rejects.toThrow(/invalid blind.*3 attempts and a format repair/);
      expect(f.calls).toBe(6); // Two authors, three malformed attempts and exactly one bounded format repair.
      expect(JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0-format-repair.json'), 'utf8')).repair.of)
        .toBe(JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0-attempt-3.json'), 'utf8')).invocationId);
      const noCalls: LlmCallFn = vi.fn(bad);
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: noCalls, targetsPerPartition: 1 }))
        .rejects.toThrow(/invalid blind.*3 attempts/);
      expect(noCalls).not.toHaveBeenCalled();
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'successor'),
        llm: noCalls, targetsPerPartition: 1, reuseCallsFrom: out })).rejects.toThrow(/invalid blind.*3 attempts/);
      expect(noCalls).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(out, 'memory-judge-1-0.json'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'labels.json'))).toBe(false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('accepts only a strictly valid format repair of the same judge and recovers it without paying again', async () => {
    const f = fixture();
    try {
      const out = path.join(f.root, 'repaired');
      const repairTurns: string[] = [];
      const scalar: LlmCallFn = async (opts) => {
        const result = await f.llm(opts);
        if (!JSON.parse(opts.messages[0].content).questions) return result;
        if (opts.messages.length > 1) { repairTurns.push(String(opts.messages.at(-1)?.content)); return result; }
        const payload = structuredClone(result.json) as { votes: Array<{ q: number; d: unknown; a: boolean }> };
        payload.votes[0].d = 0; // The observed live failure: a scalar where an index array is required.
        return { ...result, json: payload, text: JSON.stringify(payload) };
      };
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm: scalar, targetsPerPartition: 1 });
      expect(repairTurns).toHaveLength(4); // One repair per judge call, never a fourth plain attempt.
      for (const turn of repairTurns) {
        expect(turn).toContain(BLIND_FORMAT_REPAIR);
        expect(turn).toMatch(/expected array/);
      }
      expect(f.calls).toBe(20); // Four authors; four judge calls x (three rejected attempts + one repair).
      const selected = JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0.json'), 'utf8'));
      expect(path.basename(selected.origin.path)).toBe('memory-judge-1-0-format-repair.json');
      const repaired = JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0-format-repair.json'), 'utf8'));
      expect(repaired.repair.of).toBe(JSON.parse(fs.readFileSync(path.join(out, 'memory-judge-1-0-attempt-3.json'), 'utf8')).invocationId);
      expect(repaired.repair.turns.map((t: { role: string }) => t.role)).toEqual(['assistant', 'user']);
      expect(JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8')).memory).toHaveLength(8);
      const noCalls: LlmCallFn = vi.fn(scalar);
      await collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'successor'),
        llm: noCalls, targetsPerPartition: 1, reuseCallsFrom: out });
      expect(noCalls).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['invalid-json', 'missing-votes', 'out-of-range', 'missing-ambiguity', 'truncated'])
    ('does not accept %s as a fenced transport repair', async (failure) => {
      const f = fixture();
      try {
        const out = path.join(f.root, 'refused');
        const llm: LlmCallFn = async (opts) => {
          const result = await f.llm(opts);
          if (!JSON.parse(opts.messages[0].content).questions) return result;
          const payload = result.json as { votes: Array<{ q: number; d: number[]; a: boolean }> };
          if (failure === 'missing-votes') payload.votes.pop();
          if (failure === 'out-of-range') payload.votes[0].q = 999;
          if (failure === 'missing-ambiguity') Reflect.deleteProperty(payload.votes[0], 'a');
          return { ...result, json: undefined, stopReason: failure === 'truncated' ? 'max_tokens' : 'end_turn',
            text: `\`\`\`json\n${failure === 'invalid-json' ? '{broken' : JSON.stringify(payload)}\n\`\`\`` };
        };
        await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1 }))
          .rejects.toThrow(/invalid blind|incomplete blind|outside|incomplete\/unpriced|invalid recovered/);
        expect(fs.existsSync(path.join(out, 'memory-judge-1-0-attempt-1.json'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'labels.json'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'judgments.json'))).toBe(false);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  it('recovers exact judge calls across new output identities and interruption chains without paying again', async () => {
    const f = fixture();
    try {
      const original = path.join(f.root, 'original'), middle = path.join(f.root, 'middle'), final = path.join(f.root, 'final');
      let judges = 0;
      const pause: LlmCallFn = async (opts) => {
        if (JSON.parse(opts.messages[0].content).questions && ++judges === 2) throw new Error('fixture paid-call boundary');
        return f.llm(opts);
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: original, llm: pause, targetsPerPartition: 1 }))
        .rejects.toThrow('paid-call boundary');
      const raw = path.join(original, 'memory-judge-1-0.json'), pin = await fingerprintFile(raw);
      judges = 1;
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: middle, llm: pause,
        reuseCallsFrom: original, targetsPerPartition: 1 })).rejects.toThrow('paid-call boundary');
      expect(f.calls).toBe(3); // Both middle authors and its first judge were references only.
      const reference = JSON.parse(fs.readFileSync(path.join(middle, 'memory-judge-1-0.json'), 'utf8'));
      expect(reference).toMatchObject({ kind: 'reused-call', origin: pin });
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out: final, llm: f.llm,
        reuseCallsFrom: middle, targetsPerPartition: 1 });
      expect(f.calls).toBe(8); // Four authors and four successful judge calls, once each over three attempts.
      expect(await fingerprintFile(raw)).toEqual(pin);
      expect(JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8')).memory).toHaveLength(8);
      const pass = JSON.parse(fs.readFileSync(path.join(final, 'memory-judge-1-pass.json'), 'utf8'));
      expect(pass.calls[0].invocationId).toBe(reference.invocationId);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('preserves original prose authors when its partial donor never reached the prose phase', async () => {
    const f = fixture();
    try {
      const original = path.join(f.root, 'original'), partial = path.join(f.root, 'partial'), final = path.join(f.root, 'final');
      await collectIndependentCohort({ snapshot: f.snapshot, out: original, llm: f.llm, targetsPerPartition: 1 });
      const originalPins = await Promise.all(fs.readdirSync(original).filter((n) => n.includes('-author-')).map((n) => fingerprintFile(path.join(original, n))));
      const pause: LlmCallFn = async () => { throw new Error('fixture before prose'); };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: partial, llm: pause,
        reuseAuthorsFrom: original, targetsPerPartition: 1 })).rejects.toThrow('before prose');
      expect(fs.readdirSync(partial).some((n) => n.startsWith('prose-author-'))).toBe(false);
      let authors = 0;
      const llm: LlmCallFn = async (opts) => {
        if (!JSON.parse(opts.messages[0].content).questions) authors++;
        return f.llm(opts);
      };
      await collectIndependentCohort({ snapshot: f.snapshot, out: final, llm, reuseCallsFrom: partial, targetsPerPartition: 1 });
      expect(authors).toBe(0);
      for (const ref of originalPins) expect(await fingerprintFile(ref.path)).toEqual(ref);
      const result = JSON.parse(fs.readFileSync(path.join(final, 'judgments.json'), 'utf8'));
      expect(result.prose.agreement).toBe(1);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['contract', 'budget', 'conflicting-options', 'prompt', 'foreign-reference'])
    ('refuses %s exact-call recovery before another priced request', async (failure) => {
      const f = fixture(2);
      try {
        const original = path.join(f.root, 'original');
        await collectIndependentCohort({ snapshot: f.snapshot, out: original, llm: f.llm, targetsPerPartition: 1 });
        const identityPath = path.join(original, 'identity.json'), saved = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
        if (failure === 'contract') {
          saved.identity.contract.judge += ' changed';
          saved.identityHash = hashJson(saved.identity);
          fs.writeFileSync(identityPath, JSON.stringify(saved));
        }
        if (failure === 'prompt') {
          const ref = JSON.parse(fs.readFileSync(path.join(original, 'memory-judge-1-0.json'), 'utf8'));
          const raw = ref.origin.path, body = JSON.parse(fs.readFileSync(raw, 'utf8'));
          body.messages[0].content += 'changed';
          fs.writeFileSync(raw, JSON.stringify(body));
        }
        let donor = original;
        if (failure === 'foreign-reference') {
          donor = path.join(f.root, 'middle');
          await collectIndependentCohort({ snapshot: f.snapshot, out: donor, llm: f.llm, targetsPerPartition: 1, reuseCallsFrom: original });
          const raw = path.join(donor, 'memory-judge-1-0.json'), body = JSON.parse(fs.readFileSync(raw, 'utf8'));
          body.origin.path = path.join(original, 'memory-judge-2-0.json');
          fs.writeFileSync(raw, JSON.stringify(body));
        }
        const llm: LlmCallFn = vi.fn(f.llm);
        await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'refused'), llm,
          targetsPerPartition: failure === 'budget' ? 2 : 1, reuseCallsFrom: donor,
          ...(failure === 'conflicting-options' ? { reuseAuthorsFrom: original } : {}) }))
          .rejects.toThrow(/recovery|recovered|choose|reference/);
        expect(llm).not.toHaveBeenCalled();
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });
  it('retains separate raw calls, labels from full-chunk consensus and exact-input recovery guards', async () => {
    const f = fixture(), { root, snapshot, llm } = f;
    try {
      const out = path.join(root, 'run');
      const receipt = await collectIndependentCohort({ snapshot, out, llm, targetsPerPartition: 1 });
      expect(f.calls).toBe(8);
      const labels = JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8'));
      const proofs = JSON.parse(fs.readFileSync(receipt.judgments.path, 'utf8'));
      expect(labels.memory).toHaveLength(8); expect(labels.prose).toHaveLength(8);
      expect(proofs.memory.agreement).toBe(1);
      expect(new Set(proofs.memory.judges.map((j: { transport: string }) => j.transport)).size).toBe(2);
      await expect(collectIndependentCohort({ snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('already finished');
      fs.unlinkSync(receipt.judgments.path);
      const rawFile = fs.readdirSync(out).find((name) => name.startsWith('memory-author-'))!;
      const raw = JSON.parse(fs.readFileSync(path.join(out, rawFile), 'utf8'));
      raw.messages[0].content = 'altered provenance'; fs.writeFileSync(path.join(out, rawFile), JSON.stringify(raw));
      await expect(collectIndependentCohort({ snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('invalid recovered');
      expect(f.calls).toBe(8);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  async function authorOnly(f: ReturnType<typeof fixture>) {
    const out = path.join(f.root, 'original');
    const llm: LlmCallFn = async (opts) => {
      if (JSON.parse(opts.messages[0].content).questions) throw new Error('fixture judge interruption');
      return f.llm(opts);
    };
    await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('fixture judge interruption');
    // This donor fixture exercises the historical direct-raw author format.
    for (const name of fs.readdirSync(out).filter((s) => /-author-[a-f0-9]+\.json$/.test(s))) {
      const file = path.join(out, name), selected = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, fs.readFileSync(selected.origin.path));
      fs.unlinkSync(selected.origin.path);
    }
    return out;
  }
  it('exhausts unequal snapshot partitions and accepts explicit per-corpus budgets without changing source assignment', async () => {
    const f = fixture(3);
    try {
      const snapshot = JSON.parse(fs.readFileSync(f.snapshot, 'utf8'));
      snapshot.suites.prose.entries.splice(0, 1);
      fs.writeFileSync(f.snapshot, JSON.stringify(snapshot));
      const all = selectBlindSourceTargets(snapshot, parseBlindTargetBudget('all'));
      expect(all.memory.chosen.calibration).toHaveLength(3); expect(all.memory.chosen.test).toHaveLength(3);
      expect(all.prose.chosen.calibration).toHaveLength(2); expect(all.prose.chosen.test).toHaveLength(3);
      const explicit = parseBlindTargetBudget('{"memory":{"calibration":2,"test":3},"prose":{"calibration":1,"test":2}}');
      const picked = selectBlindSourceTargets(snapshot, explicit);
      expect(picked.memory.chosen.calibration).toEqual(all.memory.chosen.calibration.slice(0, 2));
      expect(picked.prose.chosen.test).toEqual(all.prose.chosen.test.slice(0, 2));
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'all'), llm: f.llm, targetsPerPartition: 'all' });
      const labels = JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8'));
      expect(labels.memory).toHaveLength(24); expect(labels.prose).toHaveLength(20);
      expect(f.calls).toBe(15);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('refuses a later-corpus budget or source-provenance defect before any paid call or output creation', async () => {
    const f = fixture();
    try {
      const budget = { memory: { calibration: 1, test: 1 }, prose: { calibration: 2, test: 1 } };
      const out = path.join(f.root, 'invalid');
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: f.llm, targetsPerPartition: budget })).rejects.toThrow('prose/calibration');
      expect(f.calls).toBe(0); expect(fs.existsSync(out)).toBe(false);
      const snapshot = JSON.parse(fs.readFileSync(f.snapshot, 'utf8'));
      const foreign = structuredClone(snapshot); foreign.suites.prose.entries[0].metadata.partition = 'wrong';
      expect(() => selectBlindSourceTargets(foreign, 'all')).toThrow('partition');
      for (const input of ['0', '-1', '1.5', 'null', '[]', '{}', '{"memory":{"calibration":1,"test":1},"prose":{"calibration":1,"test":1,"extra":1}}']) {
        expect(() => selectBlindSourceTargets(snapshot, parseBlindTargetBudget(input))).toThrow('budget');
      }
      expect(parseBlindTargetBudget('2')).toBe(2);
      expect(() => parseBlindTargetBudget('typo')).toThrow();
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('joins bounded local question indices across every document chunk and both passes without omitting targets', async () => {
    const f = fixture(34);
    try {
      let judges = 0;
      const llm: LlmCallFn = async (opts) => {
        const input = JSON.parse(opts.messages[0].content);
        if (input.questions) {
          judges++; expect(input.questions.length).toBeLessThanOrEqual(64); expect(input.sources.length).toBeLessThanOrEqual(64);
          expect(input.questions.map((q: { index: number }) => q.index)).toEqual(input.questions.map((_: unknown, i: number) => i));
        }
        return f.llm(opts);
      };
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'batches'), llm, targetsPerPartition: 'all' });
      const labels = JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8'));
      const proofs = JSON.parse(fs.readFileSync(receipt.judgments.path, 'utf8'));
      for (const corpus of ['memory', 'prose']) {
        expect(labels[corpus]).toHaveLength(272); expect(new Set(labels[corpus].map((q: { group: string }) => q.group)).size).toBe(68);
        expect(proofs[corpus].excluded).toEqual([]); expect(proofs[corpus].agreement).toBe(1);
        const pass = JSON.parse(fs.readFileSync(path.join(path.dirname(receipt.labels.path), `${corpus}-judge-1-pass.json`), 'utf8'));
        expect(pass.calls).toHaveLength(10); expect(pass.votes).toHaveLength(272);
      }
      expect(judges).toBe(40); expect(f.calls).toBe(176);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('recovers an interrupted question batch from exact immutable calls without repeating finished chunks', async () => {
    const f = fixture(9);
    try {
      const out = path.join(f.root, 'interrupted-batch'); let attemptedJudges = 0;
      const interrupt: LlmCallFn = async (opts) => {
        if (JSON.parse(opts.messages[0].content).questions && ++attemptedJudges === 2) throw new Error('fixture second question batch interruption');
        return f.llm(opts);
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: interrupt, targetsPerPartition: 'all' })).rejects.toThrow('second question batch');
      expect(f.calls).toBe(19); // 18 memory authors + the first completed judge batch.
      const first = path.join(out, 'memory-judge-1-0-q0.json'); const pin = await fingerprintFile(first);
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm: f.llm, targetsPerPartition: 'all' });
      expect(await fingerprintFile(first)).toEqual(pin);
      expect(f.calls).toBe(44); // 36 authors plus 8 judge batches, exactly once per successful call.
      expect(JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8')).memory).toHaveLength(72);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('recovers authors by reference, preserves original invocation IDs and makes fresh independent judge calls', async () => {
    const f = fixture();
    try {
      const original = await authorOnly(f), out = path.join(f.root, 'new-attempt');
      // An old judge/source revision must not invalidate unchanged author prompts.
      const identityFile = path.join(original, 'identity.json'), donor = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      donor.identity.contract.judge = 'legacy string-key judge';
      donor.identity.sourceFingerprint.sha256 = '1'.repeat(64);
      donor.identityHash = hashJson(donor.identity); fs.writeFileSync(identityFile, JSON.stringify(donor));
      for (const name of fs.readdirSync(original).filter((s) => s.startsWith('memory-author-'))) {
        const file = path.join(original, name), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        raw.identityHash = donor.identityHash; fs.writeFileSync(file, JSON.stringify(raw));
      }
      fs.writeFileSync(path.join(original, 'memory-judge-1-0.json'), JSON.stringify({ invalidLegacyJudge: true }));
      const originals = fs.readdirSync(original).filter((name) => name.startsWith('memory-author-')).map((name) => ({
        name, bytes: fs.readFileSync(path.join(original, name)),
      }));
      const originalIds = originals.map(({ bytes }) => JSON.parse(bytes.toString()).invocationId).sort();
      let newCalls = 0;
      const llm: LlmCallFn = async (opts) => { newCalls++; return f.llm(opts); };
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1, reuseAuthorsFrom: original });
      expect(newCalls).toBe(6); // two prose authors + four fresh judge passes
      expect(f.calls).toBe(8);
      for (const { name, bytes } of originals) {
        expect(fs.readFileSync(path.join(original, name))).toEqual(bytes);
        const ref = JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
        expect(ref.kind).toBe('reused-author'); expect(ref.result).toBeUndefined();
        expect(ref.origin.path).toBe(path.join(original, name));
      }
      const authors = JSON.parse(fs.readFileSync(path.join(out, 'memory-authors.json'), 'utf8'));
      expect(authors.calls.map((c: { invocationId: string }) => c.invocationId).sort()).toEqual(originalIds);
      expect(JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8')).memory).toHaveLength(8);
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: original, llm, reuseAuthorsFrom: original })).rejects.toThrow('new output');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['messages', 'model', 'promptSha256', 'identityHash', 'finishedAt', 'stopReason'])('refuses altered recovered author %s before any new transport', async (field) => {
    const f = fixture();
    try {
      const original = await authorOnly(f), name = fs.readdirSync(original).find((s) => s.startsWith('memory-author-'))!;
      const file = path.join(original, name), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (field === 'messages') raw.messages[0].content = 'altered prompt';
      else if (field === 'stopReason') raw.result.stopReason = 'max_tokens';
      else raw[field] = field === 'finishedAt' ? '' : 'altered';
      fs.writeFileSync(file, JSON.stringify(raw));
      let calls = 0;
      const llm: LlmCallFn = async (opts) => { calls++; return f.llm(opts); };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'new'), llm, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('invalid recovered');
      expect(calls).toBe(0);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('reuses a completed reference-bearing donor across multiple attempts without reauthoring', async () => {
    const f = fixture();
    try {
      const original = await authorOnly(f), first = path.join(f.root, 'first');
      await collectIndependentCohort({ snapshot: f.snapshot, out: first, llm: f.llm, targetsPerPartition: 1, reuseAuthorsFrom: original });
      const originalIds = ['memory', 'prose'].map((corpus) => JSON.parse(fs.readFileSync(path.join(first, `${corpus}-authors.json`), 'utf8')).calls.map((c: { invocationId: string }) => c.invocationId));
      let donor = first;
      for (const name of ['second', 'third']) {
        const out = path.join(f.root, name); let newCalls = 0;
        const llm: LlmCallFn = async (opts) => {
          expect(JSON.parse(opts.messages[0].content).questions).toBeDefined();
          newCalls++; return f.llm(opts);
        };
        const result = await collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1, reuseAuthorsFrom: donor });
        expect(newCalls).toBe(4); // only independent judge passes
        for (const [index, corpus] of ['memory', 'prose'].entries()) {
          const authors = JSON.parse(fs.readFileSync(path.join(out, `${corpus}-authors.json`), 'utf8'));
          expect(authors.calls.map((c: { invocationId: string }) => c.invocationId)).toEqual(originalIds[index]);
        }
        expect(JSON.parse(fs.readFileSync(result.labels.path, 'utf8')).memory).toHaveLength(8);
        donor = out;
      }
      expect(f.calls).toBe(16);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each(['raw', 'identity', 'prompt', 'path', 'invocation', 'cycle'])('rejects a chained donor with altered %s before transport', async (field) => {
    const f = fixture();
    try {
      const original = await authorOnly(f), middle = path.join(f.root, 'middle');
      const pause: LlmCallFn = async () => { throw new Error('fixture pause after author recovery'); };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: middle, llm: pause, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('fixture pause');
      const name = fs.readdirSync(middle).find((s) => s.startsWith('memory-author-'))!;
      const file = path.join(middle, name), ref = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (field === 'raw') fs.appendFileSync(ref.origin.path, '\n');
      else if (field === 'identity') fs.appendFileSync(ref.authorReuse.identity.path, '\n');
      else if (field === 'prompt') {
        const raw = JSON.parse(fs.readFileSync(ref.origin.path, 'utf8')); raw.messages[0].content = 'changed inner prompt';
        fs.writeFileSync(ref.origin.path, JSON.stringify(raw)); ref.origin = await fingerprintFile(ref.origin.path);
      } else if (field === 'path') {
        const other = fs.readdirSync(original).find((s) => s.startsWith('memory-author-') && s !== name)!;
        ref.origin = await fingerprintFile(path.join(original, other));
      } else if (field === 'cycle') ref.origin = { ...ref.origin, path: file };
      else ref.invocationId = 'invented invocation';
      fs.writeFileSync(file, JSON.stringify(ref));
      let calls = 0; const llm: LlmCallFn = async () => { calls++; throw new Error('unexpected new transport'); };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'next'), llm, targetsPerPartition: 1, reuseAuthorsFrom: middle })).rejects.toThrow(/invalid .*reference|invalid .*fingerprint|invalid recovered/);
      expect(calls).toBe(0);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('revalidates an original raw fingerprint when resuming an existing author reference', async () => {
    const f = fixture();
    try {
      const original = await authorOnly(f), out = path.join(f.root, 'new');
      const paused: LlmCallFn = async () => { throw new Error('fixture new judge interruption'); };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: paused, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('fixture new judge interruption');
      const name = fs.readdirSync(original).find((s) => s.startsWith('memory-author-'))!;
      fs.appendFileSync(path.join(original, name), '\n');
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm: paused, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('invalid authors-only raw reference');
      expect(f.calls).toBe(2);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('resumes a foreign-owner donor only under an explicit, recorded owner succession', async () => {
    const f = fixture(), priorSid = process.env.PAPERCUSP_SID;
    try {
      // A genuinely different owner produced the donor (internally consistent receipts).
      process.env.PAPERCUSP_SID = 'predecessor-owner';
      const original = await authorOnly(f);
      process.env.PAPERCUSP_SID = 'successor-owner';
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'implicit'), llm: f.llm,
        targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('recovery identity');
      // Naming a different predecessor is still a mismatched recovery identity.
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'wrong-heir'), llm: f.llm,
        targetsPerPartition: 1, reuseAuthorsFrom: original, adoptDonorOwner: 'someone-else' })).rejects.toThrow('recovery identity');
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'no-donor'), llm: f.llm,
        targetsPerPartition: 1, adoptDonorOwner: 'predecessor-owner' })).rejects.toThrow('requires a named owner and a recovery donor');
      expect(f.calls).toBe(2);
      const out = path.join(f.root, 'heir');
      await collectIndependentCohort({ snapshot: f.snapshot, out, llm: f.llm, targetsPerPartition: 1,
        reuseAuthorsFrom: original, adoptDonorOwner: 'predecessor-owner' });
      const heir = JSON.parse(fs.readFileSync(path.join(out, 'identity.json'), 'utf8'));
      expect(heir.identity.ownerSuccession).toEqual({ donorOwnerId: 'predecessor-owner', successorOwnerId: 'successor-owner' });
      expect(heir.identity.ownerId).toBe('successor-owner');
      expect(fs.readdirSync(out).filter((s) => /^memory-author-[0-9a-f]+\.json$/.test(s))
        .map((s) => JSON.parse(fs.readFileSync(path.join(out, s), 'utf8')).kind)).toEqual(['reused-author', 'reused-author']);
    } finally {
      if (priorSid === undefined) delete process.env.PAPERCUSP_SID; else process.env.PAPERCUSP_SID = priorSid;
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
  it.each(['ownerId', 'snapshot', 'model', 'author'])('refuses a mismatched recovery identity %s', async (field) => {
    const f = fixture();
    try {
      const original = await authorOnly(f), file = path.join(original, 'identity.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (field === 'ownerId') saved.identity.ownerId = 'other-owner';
      else if (field === 'snapshot') saved.identity.snapshotFingerprint.sha256 = '0'.repeat(64);
      else saved.identity.contract[field] = 'changed contract';
      saved.identityHash = hashJson(saved.identity); fs.writeFileSync(file, JSON.stringify(saved));
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out: path.join(f.root, 'new'), llm: f.llm, targetsPerPartition: 1, reuseAuthorsFrom: original })).rejects.toThrow('recovery identity');
      expect(f.calls).toBe(2);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('retains malformed abstention receipts and publishes only other balanced source targets', async () => {
    const f = fixture(2);
    try {
      const out = path.join(f.root, 'abstention');
      const llm: LlmCallFn = async (opts) => {
        const result = await f.llm(opts);
        if (!JSON.parse(opts.messages[0].content).questions) return result;
        const json = JSON.parse(result.text); json.votes[0] = { ...json.votes[0], d: [184], a: true };
        return { ...result, json, text: JSON.stringify(json) };
      };
      const receipt = await collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 2 });
      const labels = JSON.parse(fs.readFileSync(receipt.labels.path, 'utf8'));
      const proofs = JSON.parse(fs.readFileSync(receipt.judgments.path, 'utf8'));
      for (const corpus of ['memory', 'prose']) {
        expect(labels[corpus]).toHaveLength(12);
        expect(labels[corpus].filter((q: { partition: string }) => q.partition === 'test')).toHaveLength(8);
        expect(labels[corpus].filter((q: { partition: string }) => q.partition === 'calibration')).toHaveLength(4);
        expect(proofs[corpus].excluded).toHaveLength(4);
        expect(proofs[corpus].formatAbstentions).toHaveLength(2);
        expect(proofs[corpus].agreement).toBe(15 / 16);
        const raw = JSON.parse(fs.readFileSync(path.join(out, `${corpus}-judge-1-0-attempt-1.json`), 'utf8'));
        expect(raw.result.json.votes[0]).toMatchObject({ d: [184], a: true });
      }
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
  it('retains an invalid numeric response and refuses labels before consensus', async () => {
    const f = fixture();
    try {
      const out = path.join(f.root, 'invalid');
      const llm: LlmCallFn = async (opts) => {
        const result = await f.llm(opts);
        if (!JSON.parse(opts.messages[0].content).questions) return result;
        const json = JSON.parse(result.text); json.votes[0].d = [999];
        return { ...result, json, text: JSON.stringify(json) };
      };
      await expect(collectIndependentCohort({ snapshot: f.snapshot, out, llm, targetsPerPartition: 1 })).rejects.toThrow('document index 999 outside');
      expect(fs.existsSync(path.join(out, 'memory-judge-1-0-attempt-1.json'))).toBe(true);
      expect(fs.existsSync(path.join(out, 'labels.json'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'judgments.json'))).toBe(false);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('blind numeric response validation', () => {
  const questions = [{ id: 'question-a' }, { id: 'question-b' }], chunk = [{ key: 'source-a' }, { key: 'source-b' }];
  const votes = [{ q: 0, d: [1], a: false }, { q: 1, d: [], a: false }];
  it('maps reordered numeric votes through submitted references only', () => {
    expect(parseBlindChunkVotes({ votes: [...votes].reverse() }, questions, chunk)).toEqual([
      { queryId: 'question-b', relevantKeys: [], ambiguous: false, note: '' },
      { queryId: 'question-a', relevantKeys: ['source-b'], ambiguous: false, note: '' },
    ]);
  });
  it('retains the 256-question/64-document explicit abstention without accepting its impossible source', () => {
    const expandedQuestions = Array.from({ length: 256 }, (_, i) => ({ id: `q-${i}` }));
    const sources = Array.from({ length: 64 }, (_, i) => ({ key: `source-${i}` }));
    const rows = expandedQuestions.map((_, q) => ({ q, d: q === 184 ? [184] : [], a: q === 184 }));
    const parsed = parseBlindChunkVotes({ votes: rows }, expandedQuestions, sources);
    expect(parsed[184]).toMatchObject({ queryId: 'q-184', relevantKeys: [], ambiguous: true,
      invalidDocumentReferences: [184] });
    expect(() => parseBlindChunkVotes({ votes: rows.map((v) => ({ ...v, a: false })) }, expandedQuestions, sources))
      .toThrow('document index 184 outside');
    expect(() => parseBlindChunkVotes({ votes: rows.map((v) => v.q === 184 ? { ...v, q: 256 } : v) }, expandedQuestions, sources))
      .toThrow('question index 256 outside');
  });
  it.each([
    ['missing', [votes[0]], 'missing question indices 1'],
    ['duplicate question', [votes[0], votes[0]], 'duplicate question index 0'],
    ['unknown question', [votes[0], { ...votes[1], q: 2 }], 'question index 2 outside'],
    ['unknown document', [{ ...votes[0], d: [2] }, votes[1]], 'document index 2 outside'],
    ['duplicate document', [{ ...votes[0], d: [1, 1] }, votes[1]], 'duplicate document index'],
    ['string question', [{ ...votes[0], q: '0' }, votes[1]], 'invalid blind numeric response'],
    ['negative document', [{ ...votes[0], d: [-1] }, votes[1]], 'invalid blind numeric response'],
    ['fractional document', [{ ...votes[0], d: [0.5] }, votes[1]], 'invalid blind numeric response'],
    ['legacy source key', [{ ...votes[0], relevantKeys: ['unsubmitted'] }, votes[1]], 'invalid blind numeric response'],
  ])('rejects %s without guessing a reference', (_name, rows, error) => {
    expect(() => parseBlindChunkVotes({ votes: rows }, questions, chunk)).toThrow(error);
  });
});

describe('sampleGoldForJudging', () => {
  const pool: GoldQuery[] = [
    gq('b-2', 'lexical-gap'),
    gq('a-1', 'lexical-gap'),
    gq('c-3', 'lexical-gap'),
    gq('e-1', 'exact-identifier'),
    gq('d-1', 'exact-identifier'),
    gq('h-1', 'hard-negative', { expected: [] }),
    gq('s-1', 'session-start-intent'),
  ];

  it('is deterministic, stratified, id-sorted, and excludes hard negatives', () => {
    const s1 = sampleGoldForJudging(pool, 2);
    const s2 = sampleGoldForJudging(pool, 2);
    expect(s1).toEqual(s2);
    expect(s1.map((q) => q.id)).toEqual(['a-1', 'b-2', 'd-1', 'e-1', 's-1']);
    expect(s1.some((q) => q.class === 'hard-negative')).toBe(false);
  });

  it('caps per class', () => {
    expect(sampleGoldForJudging(pool, 1).map((q) => q.id)).toEqual(['a-1', 'd-1', 's-1']);
  });
});

describe('renderTopHit / synthesizeRun', () => {
  it('renders a hit verbatim and the no-result sentinel', () => {
    const q = gq('x-1', 'lexical-gap');
    const hit: MemoryEntry = { id: 'm1', text: 'the fact body', scope: 'bench' };
    expect(renderTopHit(q, hit)).toContain('the fact body');
    expect(renderTopHit(q, null)).toContain('(no result');
  });

  it('synthesizes a one-turn judgeable RunSummary', () => {
    const run = synthesizeRun(gq('x-1', 'lexical-gap'), 'text', 12, 'judge-model');
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].assistantText).toBe('text');
    expect(run.turns[0].latencyMs).toBe(JUDGED_INSTRUCTION_CONTRACT.turnLatencyMs);
    expect(run.turns[0].costUsd).toBe(JUDGED_INSTRUCTION_CONTRACT.turnCostUsd);
    expect(run.scenarioId).toBe(JUDGED_INSTRUCTION_CONTRACT.scenarioId);
    expect(run.finishReason).toBe('completed');
    expect(run.judgeModel).toBe('judge-model');
  });
});

describe('content-derived judged rubric contract', () => {
  const versionOf = (rubric: unknown, instructions: unknown, scaffold = JUDGE_PROMPT_SCAFFOLD_VERSION) =>
    deriveRubricVersion('memory-usefulness', { rubric, instructions, scaffold });

  it('derives the live version from rubric, caller contract, and testing-shell scaffold', () => {
    expect(JUDGED_TIER_RUBRIC_VERSION).toBe(
      deriveJudgedTierRubricVersion(JUDGE_PROMPT_SCAFFOLD_VERSION),
    );
    expect(MEMORY_USEFULNESS_RUBRIC.version).toBe(JUDGED_TIER_RUBRIC_VERSION);
  });

  it('moves the version when rubric content, instructions, or scaffold changes', () => {
    expect(versionOf(
      { axes: [{ ...MEMORY_USEFULNESS_RUBRIC.axes[0], description: 'changed' }] },
      JUDGED_INSTRUCTION_CONTRACT,
    )).not.toBe(
      versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT),
    );
    expect(versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, {
      ...JUDGED_INSTRUCTION_CONTRACT,
      goalSummary: 'changed',
    })).not.toBe(
      versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT),
    );
    expect(versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT, 'aaaaaaaaaaaa')).not.toBe(
      versionOf(MEMORY_USEFULNESS_RUBRIC_CONTENT, JUDGED_INSTRUCTION_CONTRACT, 'bbbbbbbbbbbb'),
    );
  });

  it('keeps prompt-visible caller values on the shared contract path', () => {
    const run = synthesizeRun(gq('x-1', 'lexical-gap'), renderTopHit(gq('x-1', 'lexical-gap'), null), 99, 'judge-model');

    expect(run.turns[0].assistantText).toContain('(no result — the store returned nothing)');
    expect(run.turns[0].finishReason).toBe(JUDGED_INSTRUCTION_CONTRACT.turnFinishReason);
    expect(run.totalCostUsd).toBe(JUDGED_INSTRUCTION_CONTRACT.turnCostUsd);
  });
});

describe('aggregateOutcomes', () => {
  const o = (cls: GoldQuery['class'], usefulness: number): JudgedQueryOutcome => ({
    queryId: `q-${cls}-${usefulness}`,
    class: cls,
    query: 'q',
    topResultKey: null,
    topResultExpected: false,
    usefulness,
    searchLatencyMs: 1,
    judgeCostUsd: 0,
  });

  it('computes mean, useful-rate (≥3), and per-class rows', () => {
    const agg = aggregateOutcomes([
      o('lexical-gap', 5),
      o('lexical-gap', 1),
      o('exact-identifier', 3),
    ]);
    expect(agg.meanUsefulness).toBeCloseTo(3);
    expect(agg.usefulRate).toBeCloseTo(2 / 3);
    expect(agg.byClass['lexical-gap']).toEqual({ n: 2, meanUsefulness: 3, usefulRate: 0.5 });
    expect(agg.byClass['exact-identifier']).toEqual({ n: 1, meanUsefulness: 3, usefulRate: 1 });
  });

  it('handles empty input', () => {
    const agg = aggregateOutcomes([]);
    expect(agg.meanUsefulness).toBe(0);
    expect(agg.usefulRate).toBe(0);
  });
});

describe('runJudgedTier (fake llm + in-memory backend)', () => {
  function makeFakeCtx(): { ctx: BackendCtx; entries: MemoryEntry[] } {
    const entries: MemoryEntry[] = [];
    let n = 0;
    const backend: MemoryBackend = {
      name: 'fake-mem',
      available: async () => ({ ok: true }),
      remember: async (text: string, opts: RememberOptions) => {
        const id = `e-${n++}`;
        entries.push({ id, text, scope: opts.scope, metadata: opts.metadata ?? {} });
        return { ids: [id], storedEvents: 1 };
      },
      // Top hit = first seeded entry — plumbing test, not a rank test.
      search: async () => entries.slice(0, 1),
      list: async () => entries,
      get: async () => null,
      forget: async () => {},
      update: async () => {},
    };
    return {
      ctx: {
        backend,
        reinstantiate: () => backend,
        cleanup: async () => {},
        reach: {},
        embeds: false,
        extractionOnRemember: false,
      },
      entries,
    };
  }

  /** Fake judge: returns usefulness 4; records every call's temperature. */
  function makeFakeJudgeLlm(): { llm: LlmCallFn; temps: Array<number | undefined> } {
    const temps: Array<number | undefined> = [];
    const llm: LlmCallFn = async (opts) => {
      temps.push(opts.temperature);
      const json = {
        summary: 'ok',
        scores: { usefulness: 4 },
        findings: [],
        agrees_with_deterministic_asserts: true,
        novel_failures: [],
      };
      return { text: JSON.stringify(json), json, inputTokens: 1, outputTokens: 1, costUsd: 0.001, raw: null };
    };
    return { llm, temps };
  }

  it('seeds, judges the deterministic sample, double-scores, and renders the card', async () => {
    const { ctx, entries } = makeFakeCtx();
    const { llm, temps } = makeFakeJudgeLlm();

    const report = await runJudgedTier({
      llm,
      backends: ['mem0'], // routed to the fake ctx below
      makeCtx: async () => ctx,
      perClass: 2,
      doubleScoreN: 2,
      log: () => {},
    });

    // Seeded the real frozen corpus through the seam.
    expect(entries.length).toBeGreaterThan(50);

    expect(report.judgeModel).toBe(JUDGED_TIER_JUDGE_MODEL);
    expect(report.rubricVersion).toBe(JUDGED_TIER_RUBRIC_VERSION);
    expect(report.sampleSize).toBe(2 * JUDGED_CLASSES.length);
    expect(report.cards).toHaveLength(1);

    const card = report.cards[0];
    expect(card.backend).toBe('fake-mem');
    expect(card.outcomes).toHaveLength(report.sampleSize);
    expect(card.meanUsefulness).toBeCloseTo(4);
    expect(card.usefulRate).toBe(1);
    expect(card.judgeCostUsd).toBeGreaterThan(0);

    // Agreement probe ran with the 0.4-temperature second pass.
    expect(report.doubleScore).toEqual({ n: 2, meanAbsDelta: 0, maxAbsDelta: 0 });
    expect(temps.filter((t) => t === 0.4).length).toBe(2);

    // Markdown carries the comparison row + the agreement line.
    expect(report.markdown).toContain('fake-mem');
    expect(report.markdown).toContain('judge agreement');
    expect(report.excludedClasses).toEqual(['hard-negative']);
  });
});

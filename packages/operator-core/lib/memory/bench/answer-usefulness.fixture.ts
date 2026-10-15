/**
 * P-008 answer-usefulness test fixture, shared by the unit and integration tiers.
 *
 * A frozen four-entry memory corpus, gold labels (two answerable, one hard
 * negative, one calibration-only), and two arm reports whose pull routes differ
 * so every outcome is known in advance. `fakeLlm` answers from whichever
 * numbered source carries a FACT marker and judges from the answer text; the
 * real `judgeRun` builds the judge prompt, so only the transport is faked.
 */
import { expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LlmCallFn } from '@papercusp/testing-shell/llm';
import { ABSTAIN_TOKEN, ANSWER_CONTRACT, ANSWER_JUDGE_INSTRUCTIONS, ANSWER_JUDGE_MODEL } from './answer-usefulness';

export type Call = Parameters<LlmCallFn>[0];

export const ENTRIES = [
  { key: 'memory:a', text: 'The deploy port is 3070. FACT-A', kind: 'fact' },
  // Mentions an arm name as ordinary corpus content: the blinding guard must tolerate it.
  { key: 'memory:b', text: 'Unrelated note: the gemma arm was benchmarked last week.', kind: 'fact' },
  { key: 'memory:c', text: 'The retry budget is 3 attempts. FACT-C', kind: 'fact' },
  { key: 'memory:d', text: 'Filler about lunch.', kind: 'fact' },
];
export const GOLD = {
  memory: [
    { id: 'q1', class: 'exact-identifier', query: 'What port does deploy use?', expected: ['memory:a'], partition: 'test', group: 'g1' },
    { id: 'q2', class: 'lexical-gap', query: 'What is the retry budget?', expected: ['memory:c'], partition: 'test', group: 'g2' },
    { id: 'q3', class: 'hard-negative', query: 'What is the moon made of?', expected: [], partition: 'test', group: 'g3' },
    { id: 'cal', class: 'lexical-gap', query: 'calibration only', expected: ['memory:c'], partition: 'calibration', group: 'g4' },
  ],
  prose: [],
};
export const PULL: Record<string, Record<string, string[]>> = {
  mdenseon: { q1: ['memory:b', 'memory:d'], q2: ['memory:c'], q3: ['memory:d'] },
  gemma: { q1: ['memory:a', 'memory:b'], q2: ['memory:c'], q3: [] },
};

export function writeFixture(dir: string, opts: { synthetic?: boolean; names?: Record<string, string> } = {}) {
  const snapshot = path.join(dir, 'snapshot.json');
  const gold = path.join(dir, 'labels.json');
  fs.writeFileSync(snapshot, JSON.stringify({ formatVersion: 1, snapshotAt: '2026-10-06T00:00:00Z', seed: 's', suites: { memory: { entries: ENTRIES }, prose: { entries: [] } } }));
  fs.writeFileSync(gold, JSON.stringify(GOLD));
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const reports = Object.entries(PULL).map(([model, pulls]) => {
    const file = path.join(dir, `${opts.names?.[model] ?? `memory-${model}-v1`}.json`);
    fs.writeFileSync(file, JSON.stringify({
      runner: 'complete-hybrid-bench', model, corpus: 'memory',
      binding: { profileId: `profile-${model}`, schema: 'bench_shared', syntheticEmbedder: Boolean(opts.synthetic) },
      inputs: { snapshotSha256: sha(snapshot), goldSha256: sha(gold) },
      rows: GOLD.memory.filter((q) => q.partition === 'test').map((q) => ({ id: q.id, class: q.class, group: q.group, expected: q.expected,
        routes: { pull: { rankedKeys: pulls[q.id] } } })),
    }));
    return file;
  });
  return { snapshot, gold, reports };
}

export function fakeLlm(calls: Call[]): LlmCallFn {
  return async (call) => {
    calls.push(call);
    const text = [call.system ?? '', ...call.messages.map((m) => m.content)].join('\n');
    if (call.model === ANSWER_CONTRACT.model) {
      const fact = [...text.matchAll(/\[(S\d+)\] [^\n]*FACT-/g)][0];
      const answer = fact ? `Answer from FACT [${fact[1]}]` : text.includes('moon') && text.includes('[S1]') ? 'It is cheese [S1]' : ABSTAIN_TOKEN;
      return { text: answer, inputTokens: 100, outputTokens: 10, costUsd: 0.001, raw: null };
    }
    expect(call.model).toBe(ANSWER_JUDGE_MODEL);
    const score = text.includes('Answer from FACT') ? [5, 5]
      : text.includes('It is cheese') ? [1, 1]
        : text.includes(ANSWER_JUDGE_INSTRUCTIONS.noReference) ? [5, 5] : [1, 5];
    const json = { summary: 's', scores: { correctness: score[0], grounding: score[1] }, findings: [], agrees_with_deterministic_asserts: true, novel_failures: [] };
    return { text: JSON.stringify(json), json, inputTokens: 300, outputTokens: 40, costUsd: 0.004, raw: null };
  };
}

/**
 * P-008 answer-usefulness tier: unit tests with an in-process fake LLM.
 *
 * The fake answers from whichever numbered source carries a FACT marker and
 * judges from the answer text, so every outcome below is known in advance.
 * The real `judgeRun` builds the judge prompt; only the transport is faked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type Call, fakeLlm, writeFixture } from './answer-usefulness.fixture';
import {
  ABSTAIN_TOKEN,
  ANSWER_CONTRACT,
  ANSWER_JUDGE_INSTRUCTIONS,
  ANSWER_JUDGE_MODEL,
  BlindingViolation,
  acceptJudgedScore,
  assertJudgeBlind,
  buildJudgeInputs,
  buildPassages,
  cohenKappa,
  loadArmReports,
  parseAnswer,
  runAnswerUsefulness,
  usableScores,
} from './answer-usefulness';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-usefulness-'));
  dirs.push(d);
  return d;
}


describe('answer parsing and passages', () => {
  it('detects declines, citations and citations to sources that were never shown', () => {
    expect(parseAnswer(`  ${ABSTAIN_TOKEN}  `, 2)).toEqual({ abstained: true, citedLabels: [], invalidCitations: [] });
    expect(parseAnswer('Port 3070 [S2], see also [S2] and [S7].', 3)).toEqual({ abstained: false, citedLabels: ['S2', 'S7'], invalidCitations: ['S7'] });
  });

  it('truncates context to the frozen k and character budget and refuses unknown keys', () => {
    const texts = new Map(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(5000)] as const));
    const passages = buildPassages([...texts.keys()], texts);
    expect(passages).toHaveLength(ANSWER_CONTRACT.k);
    expect(passages.every((p) => p.text.length === ANSWER_CONTRACT.passageChars)).toBe(true);
    expect(passages.map((p) => p.label)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(() => buildPassages(['missing'], texts)).toThrow(/not in the snapshot corpus/);
  });

  it('agreement statistics and score usability', () => {
    expect(cohenKappa([true, true, false, false], [true, true, false, false])).toBe(1);
    expect(cohenKappa([true, false, true, false], [false, true, false, true])).toBe(-1);
    expect(cohenKappa([], [])).toBeNull();
    expect(usableScores({ correctness: 4, grounding: 1 })).toBe(true);
    expect(usableScores({ correctness: 0, grounding: 5 })).toBe(false);
  });
});

describe('blinding (MDENSE-blinded-answer-score)', () => {
  const inputs = buildJudgeInputs('Which arm?', [{ label: 'S1', key: 'k', text: 'the gemma arm wrote this' }], [], 'gemma did it [S1]');

  it('tolerates arm names that occur only inside arm-independent content', () => {
    const request = { system: `Scenario\n${inputs.sources}\n${inputs.question}`, messages: [{ role: 'user' as const, content: `Transcript: ${inputs.answer}` }] };
    const attestation = assertJudgeBlind(request, inputs, ['gemma', 'mdenseon']);
    expect(attestation.verified).toBe(true);
    expect(attestation.requestSha256).toHaveLength(2);
  });

  it('refuses a request whose scaffold names an arm, and a vacuous identifier list', () => {
    const leak = { system: 'Candidate retrieved by MDenseOn:\n' + inputs.sources, messages: [{ role: 'user' as const, content: inputs.answer }] };
    expect(() => assertJudgeBlind(leak, inputs, ['gemma', 'mdenseon'])).toThrow(BlindingViolation);
    expect(() => assertJudgeBlind(leak, inputs, ['', 'ab'])).toThrow(/vacuous/);
  });

  it('downstream refuses a judged score without a verified attestation', () => {
    const scores = { correctness: 5, grounding: 5 };
    expect(() => acceptJudgedScore({ scores } as never)).toThrow(BlindingViolation);
    expect(() => acceptJudgedScore({ scores, blind: { verified: false } } as never)).toThrow(BlindingViolation);
    expect(acceptJudgedScore({ scores, blind: { verified: true, requestSha256: ['x'], forbiddenChecked: 2 } })).toBe(scores);
  });
});

describe('runAnswerUsefulness', () => {
  it('pairs arms on identical answer/judge contracts, coalesces identical contexts and replays exact receipts', async () => {
    const dir = tmp();
    const fx = writeFixture(dir);
    const calls: Call[] = [];
    const receipts = path.join(dir, 'receipts');
    const report = await runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'out.json'), llm: fakeLlm(calls), baseline: 'mdenseon', concurrency: 3, bootstrapIters: 500 });

    const answers = calls.filter((c) => c.model === ANSWER_CONTRACT.model);
    const judges = calls.filter((c) => c.model === ANSWER_JUDGE_MODEL);
    // q2 has byte-identical context in both arms: one answer, one judgment per pass.
    expect(answers).toHaveLength(5);
    expect(judges).toHaveLength(10);
    // Identical answer contract for every arm.
    expect(new Set(answers.map((c) => `${c.system}|${c.temperature}|${c.maxTokens}`)).size).toBe(1);
    // No judge request names an arm outside corpus content (memory:b mentions gemma legitimately).
    for (const c of judges) expect([c.system, ...c.messages.map((m) => m.content)].join('\n').toLowerCase()).not.toContain('mdenseon');

    const row = (id: string) => report.rows.find((r) => r.id === id)!.arms;
    expect(row('q1').mdenseon).toMatchObject({ abstained: true, useful: false, contextHasGold: false });
    expect(row('q1').gemma).toMatchObject({ abstained: false, useful: true, citationGoldPrecision: 1, citedLabels: ['S1'] });
    expect(row('q2').gemma.answerFingerprint).toBe(row('q2').mdenseon.answerFingerprint);
    expect(row('q3').mdenseon).toMatchObject({ abstained: false, useful: false, unsupportedAnswer: true });
    expect(row('q3').gemma).toMatchObject({ abstained: true, useful: true, unsupportedAnswer: false });

    expect(report.summary.mdenseon.all).toMatchObject({ queries: 3, usefulRate: 1 / 3, groundedAccuracy: 0.5, correctRejection: 0, unsupportedOnUnanswerable: 1 });
    expect(report.summary.gemma.all).toMatchObject({ usefulRate: 1, groundedAccuracy: 1, correctRejection: 1, unsupportedAnswerRate: 0 });
    const paired = report.paired.gemma!;
    expect(paired.vs).toBe('mdenseon');
    expect(paired.useful).toMatchObject({ n: 3, wins: 2, losses: 0 });
    expect(paired.useful.mean).toBeCloseTo(2 / 3);
    expect(paired.unsupportedAnswer).toMatchObject({ n: 3, wins: 0, losses: 1 });
    expect(report.agreement.correctness).toMatchObject({ n: 6, binaryAgreement: 1 });
    expect(report.cost).toMatchObject({ answerCalls: 5, judgeCalls: 10, answerReplays: 0, judgeReplays: 0 });
    expect(report.cost.uniqueTotalUsd).toBeCloseTo(5 * 0.001 + 10 * 0.004);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).paired.gemma.useful.wins).toBe(2);

    // Exact-fingerprint replay: no model call, identical outcomes.
    const replayCalls: Call[] = [];
    const replay = await runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'out-2.json'), llm: fakeLlm(replayCalls), baseline: 'mdenseon', bootstrapIters: 500 });
    expect(replayCalls).toHaveLength(0);
    expect(replay.cost).toMatchObject({ answerCalls: 0, judgeCalls: 0, answerReplays: 5, judgeReplays: 10 });
    expect(replay.summary).toEqual(report.summary);
    expect(replay.paired).toEqual(report.paired);

    // A receipt whose request no longer matches is refused, never reused or re-called.
    const answerDir = path.join(receipts, 'answers');
    const first = path.join(answerDir, fs.readdirSync(answerDir)[0]!);
    // Partial resume counts newly generated and saved requests separately; their
    // sum, not new calls alone, is the complete unique receipt population.
    fs.unlinkSync(first);
    const partialCalls: Call[] = [];
    const partial = await runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'out-partial.json'),
      llm: fakeLlm(partialCalls), baseline: 'mdenseon', bootstrapIters: 500 });
    expect(partial.cost).toMatchObject({ answerCalls: 1, answerReplays: 4, judgeCalls: 0, judgeReplays: 10 });
    expect(partial.cost.answerCalls + partial.cost.answerReplays).toBe(5);
    expect(partial.cost.judgeCalls + partial.cost.judgeReplays).toBe(10);
    expect(partial.cost.uniqueTotalUsd).toBeCloseTo(0.001);
    expect(partial.summary).toEqual(report.summary);
    expect(partial.paired).toEqual(report.paired);
    const saved = JSON.parse(fs.readFileSync(first, 'utf8'));
    saved.request.system = 'tampered';
    fs.writeFileSync(first, JSON.stringify(saved));
    await expect(runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'out-3.json'), llm: fakeLlm([]), baseline: 'mdenseon' }))
      .rejects.toThrow(/does not match its request fingerprint/);
  });

  it('the blinding guard is live in the runner: an arm identifier that the judge scaffold carries stops the run', async () => {
    const dir = tmp();
    // The judge scaffold names its scenario ("answer-usefulness"); an arm whose report file has that name is identifiable.
    const fx = writeFixture(dir, { names: { gemma: ANSWER_JUDGE_INSTRUCTIONS.scenarioId } });
    const calls: Call[] = [];
    await expect(runAnswerUsefulness({ ...fx, receipts: path.join(dir, 'r'), out: path.join(dir, 'out.json'), llm: fakeLlm(calls) }))
      .rejects.toThrow(BlindingViolation);
    expect(calls.filter((c) => c.model === ANSWER_JUDGE_MODEL)).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'out.json'))).toBe(false);
  });

  it('refuses arm reports that do not share snapshot, labels and query set, and synthetic measurements', () => {
    const dir = tmp();
    const fx = writeFixture(dir, { synthetic: true });
    expect(() => loadArmReports(fx.reports, fx.snapshot, fx.gold)).toThrow(/synthetic-embedder/);
    expect(loadArmReports(fx.reports, fx.snapshot, fx.gold, true).corpus).toBe('memory');
    expect(() => loadArmReports([fx.reports[0]!], fx.snapshot, fx.gold, true)).toThrow(/at least two/);
    expect(() => loadArmReports([fx.reports[0]!, fx.reports[0]!], fx.snapshot, fx.gold, true)).toThrow(/duplicate arm/);
    fs.appendFileSync(fx.snapshot, ' ');
    expect(() => loadArmReports(fx.reports, fx.snapshot, fx.gold, true)).toThrow(/different snapshot/);
  });
});

/**
 * P-008 answer-usefulness tier, integration layer: the real CLI process.
 *
 * The unit tier drives `runAnswerUsefulness` in-process. Here the shipped CLI
 * (`answer-usefulness-cli.ts`) runs as a child process over frozen files on
 * disk, so argument parsing, the flag/gateway bootstrap, report loading,
 * receipt I/O and the output file are the production path. The receipts a
 * first in-process run writes must let the CLI reproduce the identical
 * comparison with ZERO model calls; a receipt whose request no longer matches
 * its fingerprint, and an arm the judge scaffold could identify, must each stop
 * the process before any score is written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type Call, fakeLlm, writeFixture } from './answer-usefulness.fixture';
import { ANSWER_CONTRACT, ANSWER_JUDGE_INSTRUCTIONS, ANSWER_JUDGE_MODEL, runAnswerUsefulness } from './answer-usefulness';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CLI = path.join(REPO_ROOT, 'packages/operator-core/lib/memory/bench/answer-usefulness-cli.ts');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-usefulness-int-'));
  dirs.push(d);
  return d;
}

function runCli(fx: { snapshot: string; gold: string; reports: string[] }, receipts: string, out: string) {
  const args = ['--import', 'tsx', CLI, ...fx.reports.flatMap((r) => ['--report', r]),
    '--snapshot', fx.snapshot, '--gold', fx.gold, '--receipts', receipts, '--out', out, '--baseline', 'mdenseon', '--concurrency', '2'];
  // No live model is reachable from this process: an unreplayed call fails instead of spending.
  const env = { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PAPERCUSP_GATEWAY_PORT: '1' };
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 90_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('answer-usefulness CLI over frozen inputs', () => {
  it('reproduces the paired comparison from exact-fingerprint receipts with zero model calls', async () => {
    const dir = tmp();
    const fx = writeFixture(dir);
    const receipts = path.join(dir, 'receipts');
    const calls: Call[] = [];
    const first = await runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'first.json'), llm: fakeLlm(calls), baseline: 'mdenseon', concurrency: 2 });
    expect(calls.filter((c) => c.model === ANSWER_CONTRACT.model)).toHaveLength(5);
    expect(calls.filter((c) => c.model === ANSWER_JUDGE_MODEL)).toHaveLength(10);

    const out = path.join(dir, 'cli.json');
    const r = runCli(fx, receipts, out);
    expect(r.status, r.stderr.slice(-2000)).toBe(0);
    const cli = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(cli.cost).toMatchObject({ answerCalls: 0, judgeCalls: 0, answerReplays: 5, judgeReplays: 10, uniqueTotalUsd: 0 });
    expect(cli.summary).toEqual(first.summary);
    expect(cli.paired).toEqual(first.paired);
    expect(cli.agreement).toEqual(first.agreement);
    expect(cli.rows).toEqual(first.rows);
    expect(cli.inputs).toEqual(first.inputs);
    expect(cli.paired.gemma.useful).toMatchObject({ n: 3, wins: 2, losses: 0 });
    // The CLI's stdout line is the same report, summarized.
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!).summary.gemma).toEqual(first.summary.gemma.all);
  }, 120_000);

  it('refuses a receipt whose request no longer matches its fingerprint, leaving it and the output untouched', async () => {
    const dir = tmp();
    const fx = writeFixture(dir);
    const receipts = path.join(dir, 'receipts');
    await runAnswerUsefulness({ ...fx, receipts, out: path.join(dir, 'first.json'), llm: fakeLlm([]), baseline: 'mdenseon', concurrency: 2 });
    const answerDir = path.join(receipts, 'answers');
    const target = path.join(answerDir, fs.readdirSync(answerDir).sort()[0]!);
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    saved.request.system = 'tampered';
    const tampered = JSON.stringify(saved);
    fs.writeFileSync(target, tampered);

    const out = path.join(dir, 'cli.json');
    const r = runCli(fx, receipts, out);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match its request fingerprint/);
    expect(fs.readFileSync(target, 'utf8')).toBe(tampered);
    expect(fs.existsSync(out)).toBe(false);
  }, 120_000);

  it('stops before judging when an arm identifier would reach the judge scaffold', async () => {
    const dir = tmp();
    // The judge scaffold names its scenario; an arm report file carrying that name is identifiable.
    const fx = writeFixture(dir, { names: { gemma: ANSWER_JUDGE_INSTRUCTIONS.scenarioId } });
    const receipts = path.join(dir, 'receipts');
    // Answers replay from receipts (arm-independent fingerprints); judgments must be requested fresh.
    const seed = writeFixture(tmp());
    await runAnswerUsefulness({ ...seed, receipts, out: path.join(dir, 'seed.json'), llm: fakeLlm([]), baseline: 'mdenseon', concurrency: 2 });
    fs.rmSync(path.join(receipts, 'judgments'), { recursive: true, force: true });

    const out = path.join(dir, 'cli.json');
    const r = runCli(fx, receipts, out);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/judge request names arm identifier/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(path.join(receipts, 'judgments'))).toHaveLength(0);
  }, 120_000);
});

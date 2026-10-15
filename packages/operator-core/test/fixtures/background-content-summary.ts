import { appendFileSync, readFileSync } from 'node:fs';
import { readContent } from '../../lib/content-intake';
import { summarizeContent, type SummaryDeps } from '../../lib/content-summary';

// Deterministic model boundary only. Intake, summarization, and the caller's
// managed shell process all execute their production implementations.
const [inputPath, startedPath, mode] = process.argv.slice(2);
appendFileSync(startedPath!, `${process.pid}\n`);
const input = JSON.parse(readFileSync(inputPath!, 'utf8'));
const requests: unknown[] = [];
const deps: SummaryDeps = {
  async *run(options) {
    requests.push(JSON.parse(options.promptText));
    if (mode === 'failure') { yield { type: 'error', message: 'Fixture provider failed' }; return; }
    yield { type: 'result', finalText: 'North reports 12, South reports 34, and the final total is 56.',
      costUsd: 0, tokensIn: 20, tokensOut: 16, stopReason: 'end_turn' };
  },
  isLocalModel: async () => false,
  checkBudget: async () => ({ exceeded: false }),
  recordSpend: async () => {},
  reuse: async (_workspace, _key, factory) => factory(),
};
try {
  const content = await readContent(input, { workspaceId: 'background-summary-fixture', readerId: 'fixture-reader' },
    { authorize: async () => true });
  const result = await summarizeContent(content, { allowCloud: true, cache: false, maxCalls: 1 }, undefined, deps);
  process.stdout.write(`SUMMARY-RESULT ${JSON.stringify({ result, requests })}\n`);
} catch (error) {
  process.stderr.write(`SUMMARY-FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

/** Execute an already frozen qualification policy; never retrieves or edits gold.
 * node --import tsx .../judge-qualification-cli.ts --policy <json> --out <new-json>
 * Calls are retained at <out>.calls.jsonl, including errors and unqualified usage.
 */
import fs from 'node:fs';
import { llmCall } from '../../llm-testing/llm-client';
import { qualificationHash, runJudgeQualification, validateQualificationPolicy,
  type QualificationPolicy } from './judge-qualification';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i < 0 ? undefined : process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`Required ${name}`);
  return value;
}
const policyPath = arg('--policy');
const out = arg('--out');
const p = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as QualificationPolicy;
validateQualificationPolicy(p);
const journal = `${out}.calls.jsonl`;
// Exclusive creation prevents a retry from overwriting paid evidence.
fs.writeFileSync(out, JSON.stringify({ status: 'running', policySha256: qualificationHash(p) }), { flag: 'wx' });
fs.writeFileSync(journal, '', { flag: 'wx' });
try {
  const report = await runJudgeQualification(p, { llm: llmCall,
    onCall: row => { fs.appendFileSync(journal, JSON.stringify(row) + '\n'); } });
  fs.writeFileSync(out, JSON.stringify({ status: 'complete', ...report }, null, 2) + '\n');
  console.log(JSON.stringify({ out, qualified: report.qualified, calls: report.calls, costUsd: report.costUsd }));
  if (!report.qualified) process.exitCode = 1;
} catch (e) {
  fs.writeFileSync(out, JSON.stringify({ status: 'failed', policySha256: qualificationHash(p),
    error: e instanceof Error ? e.message : String(e), journal, unqualifiedCostReservationRetained: true }, null, 2) + '\n');
  throw e;
}

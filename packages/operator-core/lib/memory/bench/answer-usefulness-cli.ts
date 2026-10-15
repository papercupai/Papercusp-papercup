/**
 * Answer-usefulness tier CLI (mdenseon-adoption-measurements-2026-10-01 P-008).
 *
 *   node --import tsx packages/operator-core/lib/memory/bench/answer-usefulness-cli.ts \
 *     --report <memory-mdenseon-v1.json> --report <memory-gemma-v1.json> [--report ...] \
 *     --snapshot <snapshot.json> --gold <labels.json> \
 *     --receipts <dir> --out <report.json> [--baseline mdenseon] [--concurrency 4] [--limit N]
 *
 * Inputs are complete-hybrid-bench arm reports built on the same snapshot and
 * gold labels. Every answer and judgment is a crash-safe receipt under
 * --receipts; re-running with the same receipts replays exact-fingerprint
 * matches without a model call, so an interrupted run resumes.
 */

import { writeStdoutSync } from '../../../../../scripts/lib/write-stdout-sync.mjs';
import { llmCall } from '../../llm-testing/llm-client';
import { runAnswerUsefulness } from './answer-usefulness';

function argValues(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === flag) out.push(process.argv[i + 1]!);
  return out;
}
function argValue(flag: string): string | undefined {
  return argValues(flag)[0];
}
function required(flag: string): string {
  const v = argValue(flag);
  if (!v) throw new Error(`${flag} is required`);
  return v;
}

// Same gateway seam as judged-cli: a generic shell task need not inherit the operator's gateway environment.
const { FLAGS } = await import('@papercusp/flags');
const { getFlag } = await import('@papercusp/flags/server');
const { installFlagOverrideStore } = await import('../../flag-override-store');
installFlagOverrideStore();
if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
  const { applyGatewayLlmEnv } = await import('../../inference-gateway/spawn-env');
  applyGatewayLlmEnv(true);
}

const limit = argValue('--limit');
const report = await runAnswerUsefulness({
  reports: argValues('--report'),
  snapshot: required('--snapshot'),
  gold: required('--gold'),
  receipts: required('--receipts'),
  out: required('--out'),
  llm: llmCall,
  ...(argValue('--baseline') ? { baseline: argValue('--baseline')! } : {}),
  concurrency: Number.parseInt(argValue('--concurrency') ?? '4', 10),
  ...(limit ? { limit: Number.parseInt(limit, 10) } : {}),
  callContext: { priority: 'su', ...(process.env.PAPERCUSP_SID ? { ownerId: process.env.PAPERCUSP_SID } : {}) },
});

writeStdoutSync(JSON.stringify({ out: argValue('--out'), queries: report.queries, cost: report.cost, paired: report.paired,
  summary: Object.fromEntries(Object.entries(report.summary).map(([arm, s]) => [arm, s.all])), agreement: report.agreement }) + '\n');
process.exit(0);

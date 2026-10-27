/**
 * Assess an independently retained adapter study; never retrieves or buys labels.
 * npx tsx packages/operator-core/lib/search/bench/adapter-baseline-cli.ts --input <receipts.json> --out <new-assessment.json>
 * Exit 0 = complete pass, 1 = observed failure/invalid input, 2 = unknown evidence.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAdapterBaseline } from './adapter-baseline';

export function assessAdapterBaselineArtifact(inputPath: string, outputPath: string) {
  if (resolve(inputPath) === resolve(outputPath)) throw new Error('assessment must not overwrite its input');
  const bytes = readFileSync(inputPath);
  const input = JSON.parse(bytes.toString('utf8')) as Parameters<typeof evaluateAdapterBaseline>[0];
  const result = evaluateAdapterBaseline(input);
  const artifact = { schemaVersion: 1, kind: 'frozen-adapter-baseline-assessment',
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    // This is a guard/evaluation artifact, not independent plan acceptance or shipment.
    planAcceptance: false, shipment: 'unverified', ...result };
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { artifact, exitCode: result.assertion.status === 'pass' ? 0 : result.assertion.status === 'fail' ? 1 : 2 };
}

export function runAdapterBaselineCli(argv: string[]): number {
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--out' || !argv[1] || !argv[3]) {
    throw new Error('usage: --input <receipts.json> --out <new-assessment.json>');
  }
  const { artifact, exitCode } = assessAdapterBaselineArtifact(argv[1], argv[3]);
  console.log(JSON.stringify({ status: artifact.assertion.status, inputSha256: artifact.inputSha256,
    attempted: artifact.run.attempts.length, cells: artifact.assertion.cells,
    failures: artifact.assertion.failures, unknowns: artifact.assertion.unknowns }));
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runAdapterBaselineCli(process.argv.slice(2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}

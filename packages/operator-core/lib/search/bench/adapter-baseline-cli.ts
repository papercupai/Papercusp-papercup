/**
 * Assess an independently retained adapter study; never retrieves or buys labels.
 * npx tsx packages/operator-core/lib/search/bench/adapter-baseline-cli.ts --input <receipts.json> --out <new-assessment.json>
 * Exit 0 = complete pass, 1 = observed failure/invalid input, 2 = unknown evidence.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCliEntry } from '../../util/cli-entry';
import { adapterStudyFingerprint, evaluateAdapterBaseline, type FrozenAdapterStudy } from './adapter-baseline';

/** Seal a declaration BEFORE retrieval. This is local structural validation,
 * not authentication of corpus/model pins or an acceptance verdict. */
export function freezeAdapterStudyArtifact(inputPath: string, outputPath: string) {
  if (resolve(inputPath) === resolve(outputPath)) throw new Error('freeze must not overwrite its input');
  const bytes = readFileSync(inputPath);
  const study = JSON.parse(bytes.toString('utf8')) as FrozenAdapterStudy;
  const sealedAtMs = Date.now();
  // The CLI supplies the actual declaration boundary, never a backdated draft.
  study.declaration.declaredAtMs = sealedAtMs;
  const failures: string[] = [];
  if (!study.declaration.cells.length) failures.push('no declared cells');
  for (const cell of study.declaration.cells) {
    const eligible = cell.attemptIds.filter(id => !cell.censoring?.attemptIds.includes(id));
    if (!eligible.length || cell.minExecuted > eligible.length || cell.minJudged > eligible.length) {
      failures.push(`${cell.id}: undersized declared population`);
    }
  }
  // Reuse the maintained receipt evaluator's manifest checks with NO receipts.
  // Missing-observation unknowns are expected here; no synthetic result is saved.
  const validation = evaluateAdapterBaseline({ study, executionDeclaration: study.declaration,
    executionStudyFingerprint: adapterStudyFingerprint(study), startedAtMs: sealedAtMs + 1,
    pins: study.declaration.pins, receipts: [], labels: [], costs: [], qualification: null });
  failures.push(...validation.assertion.failures);
  if (failures.length) throw new Error(`invalid prospective study: ${failures.join('; ')}`);
  const artifact = { schemaVersion: 1, kind: 'frozen-adapter-study', sealedAtMs,
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    studyFingerprint: adapterStudyFingerprint(study), study,
    pinAuthenticity: 'unverified', planAcceptance: false, shipment: 'unverified' };
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return artifact;
}

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
  if (argv[0] === '--freeze') {
    if (argv.length !== 5 || argv[1] !== '--input' || argv[3] !== '--out' || !argv[2] || !argv[4]) {
      throw new Error('usage: --freeze --input <study.json> --out <new-frozen-study.json>');
    }
    const artifact = freezeAdapterStudyArtifact(argv[2], argv[4]);
    console.log(JSON.stringify({ status: 'sealed', studyFingerprint: artifact.studyFingerprint,
      sealedAtMs: artifact.sealedAtMs, pinAuthenticity: artifact.pinAuthenticity }));
    return 0;
  }
  if (argv.length !== 4 || argv[0] !== '--input' || argv[2] !== '--out' || !argv[1] || !argv[3]) {
    throw new Error('usage: --input <receipts.json> --out <new-assessment.json>');
  }
  const { artifact, exitCode } = assessAdapterBaselineArtifact(argv[1], argv[3]);
  console.log(JSON.stringify({ status: artifact.assertion.status, inputSha256: artifact.inputSha256,
    attempted: artifact.run.attempts.length, cells: artifact.assertion.cells,
    failures: artifact.assertion.failures, unknowns: artifact.assertion.unknowns }));
  return exitCode;
}

if (isCliEntry(import.meta.url)) {
  try { process.exitCode = runAdapterBaselineCli(process.argv.slice(2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}

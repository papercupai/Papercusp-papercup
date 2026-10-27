#!/usr/bin/env -S tsx
/** D018 separately approved fixture replay. No retrieval qualification and no
 * regenerated summaries. The historical failed edition stays unchanged. */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractSemanticFunctions } from '../packages/operator-core/lib/code-intelligence/semantic-code';
import { judgeSemanticPair, semanticDigest, type SemanticPair } from '../packages/operator-core/lib/code-intelligence/semantic-code-judge';
import { flushFallbackObservations } from '../packages/operator-core/lib/degradation/fallback-observations';
import { getOrgPg } from '@papercusp/db-org';

const [destination, model] = process.argv.slice(2);
if (!destination || !model || existsSync(destination)) throw new Error('Usage: semantic-code-judge-replay.mts <new-report.json> <exact-model>');
const fixturePath = 'packages/operator-core/lib/code-intelligence/__fixtures__/semantic-judge-contracts-v2.json';
const manifestPath = 'packages/operator-core/lib/code-intelligence/__fixtures__/semantic-calibration-v1.json';
const fixtureBytes = await readFile(fixturePath), fixture = JSON.parse(fixtureBytes.toString());
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
const approvedSha256 = '41263d203f05828076c44c48c09167967f4db58337d613016917d03c9f8122b2';
if (fixtureSha256 !== approvedSha256) throw new Error('Fixture differs from independently approved edition');
const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString());
const report: Record<string, any> = { schemaVersion: 2, registration: `${fixture.registration}:explicit-domain-v1`,
  fixturePath, fixtureSha256, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), model,
  independentReview: { workItem: 'WI-6554700010023046', threadPost: '1200673', verdict: 'APPROVE', approvedSha256 },
  qualification: 'judge controls only; positive restricted to the reviewed behavior domain; retrieval remains unqualified',
  positiveDomain: fixture.positive.behaviorDomainReview, startedAt: new Date().toISOString(), cases: [], status: 'unknown' };
const fn = (path: string, source: string) => extractSemanticFunctions({ path, source })[0]!;
const cases: { id: string; expected: string; pair: SemanticPair; contractDomain?: string }[] = [{
  id: fixture.positive.id, expected: 'duplicate', pair: [fn(fixture.positive.leftPath, fixture.positive.leftSource),
    fn(fixture.positive.rightPath, fixture.positive.rightSource)],
  contractDomain: fixture.positive.behaviorDomainReview.domain,
}, ...manifest.judgePairs.map((sample: any) => ({ id: sample.id,
  expected: sample.id === 'sum-positive' ? 'distinct' : sample.expected,
  pair: [fn(manifest.samples[0].relevant[0], manifest.samples[0].source), fn(`src/${sample.id}.ts`, sample.rightSource)] as SemanticPair }))];
try {
  report.sourceCensus = await Promise.all(['scripts/semantic-code-judge-replay.mts',
    'packages/operator-core/lib/code-intelligence/semantic-code-judge.ts',
    'packages/operator-core/lib/code-intelligence/semantic-code.ts'].map(async path => ({ path,
      sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  for (const sample of cases) {
    const judgment = await judgeSemanticPair(sample.pair, { model,
      harness: process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp', contractDomain: sample.contractDomain });
    report.cases.push({ ...sample, judgment });
    console.error(`P012 judge v2 ${sample.id}: ${judgment.status}`);
  }
  report.status = report.cases.every((row: any) => row.judgment.parsed?.verdict === row.expected
    && (row.expected !== 'duplicate' || row.judgment.status === 'verified')) ? 'passed-judge-controls' : 'failed-judge-controls';
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  report.observationFlush = await flushFallbackObservations();
  await getOrgPg().sql.end({ timeout: 5 });
  report.finishedAt = new Date().toISOString();
  report.receiptDigest = semanticDigest(report);
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ status: report.status, destination, fixtureSha256 }));
if (report.status !== 'passed-judge-controls') process.exitCode = 1;

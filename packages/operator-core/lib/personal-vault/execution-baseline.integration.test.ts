/** Vault P-009 measurements on the existing private real-SDK probe.
 * These observations do not approve population closure or installed shipment.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { measureRuntime, runCapability } from '../../../../scripts/lib/runtime-compatibility.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const paths = ['scripts/lib/runtime-compatibility-dbos.mjs',
  'packages/operator-core/lib/observability/tracing.ts',
  'node_modules/@dbos-inc/dbos-sdk/dist/src/dbos-executor.js'];
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hashes = () => Object.fromEntries(paths.map(path => [join(root, path), digest(readFileSync(join(root, path)))]));
const evidenceRoot = process.env.VH_EVIDENCE_ROOT_BASE ?? tmpdir();
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(join(evidenceRoot, 'vault-baseline-'));
const nonce = randomUUID();
let db: FreshPgDb;
let frozen: ReturnType<typeof hashes>;
let runtime: Awaited<ReturnType<typeof measureRuntime>>;
let candidate: { sourceSha: string; lockfileSha256: string; configurationSha256: string; dependencyGeneration: string };
const receipts: Awaited<ReturnType<typeof runCapability>>[] = [];

type Sample = { round: number; index: number; condition: 'off' | 'on'; warmup: boolean;
  journeyMs: number; workMs: number; hostMs: number; failure: string | null;
  correlation: { traceId: string; spanId: string } | null };
type Round = { round: number; profile: { loaded: Record<string, string>; status: string;
  database: string; schema: string; externalExporter: boolean }; samples: Sample[];
  correlated: boolean; flushMs: number; requests: number; observedSpans: unknown[];
  health: { active: number; skipped: number; expired: number; queueDroppedSpans: number } };
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];

function validateRound(round: Round, index: number) {
  expect(round.profile.loaded).toEqual(frozen);
  expect(round.round).toBe(index);
  expect(round.profile).toMatchObject({ status: 'SUCCESS', schema: 'dbos', externalExporter: false });
  expect(round.profile.database).toBe(new URL(db.url).pathname.slice(1));
  expect(round.samples.filter(sample => sample.warmup)).toHaveLength(100);
  const measured = round.samples.filter(sample => !sample.warmup);
  expect(measured).toHaveLength(400);
  expect(measured.map(sample => sample.condition)).toEqual([
    ...Array(200).fill(index % 2 ? 'on' : 'off'), ...Array(200).fill(index % 2 ? 'off' : 'on'),
  ]);
  for (const condition of ['off', 'on']) {
    expect(measured.filter(sample => sample.condition === condition).map(sample => sample.index))
      .toEqual(Array.from({ length: 200 }, (_, n) => n));
  }
  expect(round.samples.every(sample => sample.failure === null && Number.isFinite(sample.hostMs) &&
    sample.hostMs >= 0 && sample.journeyMs >= sample.workMs)).toBe(true);
  expect(round.samples.filter(sample => sample.condition === 'on').every(sample =>
    sample.correlation && /^[a-f0-9]{32}$/.test(sample.correlation.traceId) &&
    /^[a-f0-9]{16}$/.test(sample.correlation.spanId))).toBe(true);
  expect(round.correlated).toBe(true);
  expect(JSON.stringify(round.observedSpans)).not.toContain('vault-private-payload-' + nonce);
  expect(round.requests).toBe(500);
  expect(round.health).toMatchObject({ active: 0, skipped: 0, expired: 0, queueDroppedSpans: 0 });
  expect(Number.isFinite(round.flushMs) && round.flushMs >= 0).toBe(true);
}

beforeAll(async () => {
  frozen = hashes();
  runtime = await measureRuntime(process.execPath);
  candidate = { sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    lockfileSha256: digest(readFileSync(join(root, 'package-lock.json'))),
    configurationSha256: digest('vault-baseline-v1:100warmup:5rounds:200each:counterbalanced:budget=max(1ms,0.1*offP95)'),
    dependencyGeneration: digest(readFileSync(join(root, 'node_modules/@dbos-inc/dbos-sdk/package.json'))) };
  db = await createFreshPgDb('runtime_dbos');
  await db.sql.unsafe('CREATE SCHEMA runtime_probe; CREATE TABLE runtime_probe.guard (nonce text PRIMARY KEY)').simple();
  await db.sql`INSERT INTO runtime_probe.guard (nonce) VALUES (${nonce})`;
}, 90_000);

afterAll(async () => {
  try {
    writeFileSync(join(evidence, 'custody.json'), JSON.stringify({ candidate, runtime, frozen,
      after: hashes(), receipts, nonce, populationClosureAccepted: false, shipmentAccepted: false }, null, 2));
    console.info('Vault baseline evidence: ' + evidence);
  } finally { await db?.cleanup(); }
});

describe('Vault P-009 isolated DBOS baseline', () => {
  it('retains the frozen paired timing design, loaded identity and real correlation with violating controls', async () => {
    const rounds: Round[] = [];
    for (let round = 0; round < 5; round++) {
      const receiptPath = join(evidence, `round-${round}.json`);
      const receipt = await runCapability({ capabilityId: 'vault-baseline-round-' + round,
        expected: { baselineRound: round, samples: 400, warmup: 100, requests: 500, correlated: true },
        runtime, candidate, probePath: join(root, paths[0]) }, {
        timeoutMs: 60_000, maxOutputBytes: 1024 * 1024, cwd: root,
        env: { PAPERCUSP_PROBE_PG_URL: db.url, PAPERCUSP_PROBE_NONCE: nonce,
          PAPERCUSP_PROBE_ATTEMPT: 'baseline-' + round, PAPERCUSP_PROBE_ACTION: 'baseline',
          PAPERCUSP_PROBE_WORKFLOW: 'vault-baseline-' + nonce + '-' + round,
          PAPERCUSP_PROBE_EXECUTOR: 'vault-baseline-' + round,
          PAPERCUSP_PROBE_BASELINE_ROUND: String(round), PAPERCUSP_PROBE_BASELINE_RECEIPT: receiptPath },
      });
      receipts.push(receipt);
      expect({ status: receipt.status, reasons: receipt.reasons, stderr: receipt.observation.stderr })
        .toMatchObject({ status: 'passed', reasons: [] });
      const observed = JSON.parse(readFileSync(receiptPath, 'utf8')) as Round;
      validateRound(observed, round);
      // Detector controls use observations from the actual completed run.
      expect(() => validateRound({ ...observed, profile: { ...observed.profile, loaded: {} } }, round)).toThrow();
      expect(() => validateRound({ ...observed, samples: observed.samples.slice(1) }, round)).toThrow();
      expect(() => validateRound({ ...observed, correlated: false }, round)).toThrow();
      rounds.push(observed);
    }
    const samples = rounds.flatMap(round => round.samples.filter(sample => !sample.warmup));
    const off = samples.filter(sample => sample.condition === 'off');
    const on = samples.filter(sample => sample.condition === 'on');
    expect(off).toHaveLength(1000); expect(on).toHaveLength(1000);
    const offP95 = p95(off.map(sample => sample.hostMs));
    const onP95 = p95(on.map(sample => sample.hostMs));
    const budgetMs = Math.max(1, .1 * offP95);
    const overheadMs = onP95 - offP95;
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    writeFileSync(join(evidence, 'comparison.json'), JSON.stringify({ candidate, frozen,
      conditions: ['off', 'on'].map(condition => {
        const rows = samples.filter(sample => sample.condition === condition);
        return { condition, count: rows.length, hostMedianMs: median(rows.map(row => row.hostMs)),
          hostP95Ms: p95(rows.map(row => row.hostMs)), journeyMedianMs: median(rows.map(row => row.journeyMs)),
          journeyP95Ms: p95(rows.map(row => row.journeyMs)) };
      }), offP95, onP95, overheadMs, budgetMs, withinBudget: overheadMs <= budgetMs,
      flushMs: rounds.map(round => round.flushMs), populationClosureAccepted: false }, null, 2));
    expect(hashes()).toEqual(frozen);
    expect(overheadMs, 'The frozen budget must not be relaxed after observation; see retained comparison.json')
      .toBeLessThanOrEqual(budgetMs);
  }, 330_000);
});

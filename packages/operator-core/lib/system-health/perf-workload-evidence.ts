/** D-012 evidence adapter: existing perf artifacts + rubric test_runs, no new store or monitor. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { contentAddressing, isHexSha256 } from '@papercusp/artifact-registry';
import { getOrgPg } from '@papercusp/db-org';
import { papercuspPath } from '@papercusp/host-platform/home';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { recordRubricCheckResults, rubricCheckLedgerPath, type RubricCheckLedgerScope } from '../check-results-ledger';
import { retainMeasurementProvenance } from '../measurement-provenance';
import { perfProtocolHash, type PerfProtocolEvidence } from './perf-workload-protocol';
import { intactPerfWorkloadRun } from './perf-workload-run';
import { intactPerfWorkloadEvaluation } from './perf-workload-evaluate';

const RUBRIC = 'acceptance-host-memory-right-sizing-2026-10-31';
const CHECK = 'P-001:artifact-integrity';
const SCHEME = contentAddressing({ prefix: 'workload-evidence', ext: '.json' });
const MAX_BYTES = 256 * 1024 * 1024;
type Sql = Parameters<typeof recordRubricCheckResults>[2];
export type PerfEvidenceBody = PerfProtocolEvidence extends infer E ? E extends { hash: string } ? Omit<E, 'hash' | 'publishedAtMs'> : never : never;

/** The hash covers the entire evidence body, never a caller's unrelated scalar. */
export function sealPerfEvidence(body: PerfEvidenceBody): PerfProtocolEvidence {
  const snapshot = structuredClone(body);
  return { ...snapshot, hash: perfProtocolHash(snapshot) } as PerfProtocolEvidence;
}

function parseEvidence(value: unknown): PerfProtocolEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { hash, ...body } = value as Record<string, unknown>;
  if ('publishedAtMs' in body || !isHexSha256(hash) || perfProtocolHash(body) !== hash) return null;
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const text = (x: unknown) => typeof x === 'string' && !!x.trim();
  const comparison = () => text(body.journey) && ['cold', 'warm', 'burst'].includes(String(body.stratum)) &&
    ['p95', 'p99', 'throughput'].includes(String(body.metric));
  switch (body.kind) {
    case 'evaluation':
      if (!finite(body.endedAtMs) || !intactPerfWorkloadEvaluation(body.evaluation)) return null;
      break;
    case 'matched-run':
      if (!finite(body.endedAtMs) || !intactPerfWorkloadRun(body.capture) || body.endedAtMs !== body.capture.endedAtMs) return null;
      break;
    case 'registration':
      if (!isHexSha256(body.protocolHash) || !finite(body.registeredAtMs)) return null;
      break;
    case 'independence':
      if (!text(body.independentRepeatId) || body.verified !== true) return null;
      break;
    case 'baseline':
      if (!finite(body.endedAtMs) || !isHexSha256(body.sourceManifestHash) || !isHexSha256(body.fixtureHash) ||
          !text(body.independentRepeatId) || !text(body.independenceEvidenceRef) || !Array.isArray(body.observations) ||
          !body.observations.length || !body.observations.every(row => row && typeof row === 'object' &&
            text(row.journey) && ['cold', 'warm', 'burst'].includes(row.stratum) &&
            Number.isSafeInteger(row.completedPerArm) && row.completedPerArm >= 0 && typeof row.allObservationsRetained === 'boolean')) return null;
      if (body.series !== undefined && (!Array.isArray(body.series) || !body.series.every(row => row && typeof row === 'object' &&
          text(row.journey) && ['cold', 'warm', 'burst'].includes(row.stratum) && ['p95', 'p99', 'throughput'].includes(row.metric) &&
          Array.isArray(row.a) && Array.isArray(row.b) && row.a.every(finite) && row.b.every(finite)))) return null;
      break;
    case 'power-computation':
      if (!finite(body.endedAtMs) || !isHexSha256(body.protocolInputHash) || !body.result || typeof body.result !== 'object') return null;
      break;
    case 'power':
      if (!comparison() || !finite(body.endedAtMs) || !isHexSha256(body.protocolInputHash) ||
          !finite(body.lowerPowerBound) || !finite(body.comparisonAlpha) || !finite(body.margin)) return null;
      break;
    case 'block-selection':
      if (!comparison() || !finite(body.endedAtMs) || !isHexSha256(body.baselineHash) || !text(body.independentRepeatId) ||
          body.method !== 'baseline-acf-noise-band-v1' || !Number.isSafeInteger(body.blockLength) || Number(body.blockLength) < 1) return null;
      break;
    default: return null;
  }
  return value as PerfProtocolEvidence;
}

/** Exact immutable row + artifact identity. No 'latest' lookup or arbitrary path in a ref. */
function parseRef(ref: string): { id: number; artifactHash: string } | null {
  const match = /^perf-evidence:([1-9][0-9]*):([a-f0-9]{64})$/.exec(ref);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  return { id: Number(match[1]), artifactHash: match[2] };
}

export interface PerfEvidenceOptions {
  scope: RubricCheckLedgerScope & { workspaceId: string; harnessSlug: string };
  /** Existing perf-baselines root; tests use a private temporary directory. */
  directory?: string;
  sql?: Sql;
  now?: () => number;
}

/**
 * A successful publication only proves retention/integrity. It never certifies power,
 * independence, performance acceptance or a saving. Those are separate executable checks.
 */
export function perfEvidenceRepository(options: PerfEvidenceOptions) {
  if (!options.scope.workspaceId.trim() || !options.scope.harnessSlug.trim()) throw new Error('perf evidence requires workspace/harness scope');
  const directory = options.directory ?? papercuspPath('perf-baselines');
  const sql = options.sql ?? getOrgPg().sql;
  const now = options.now ?? Date.now;
  const pathFor = (hash: string) => join(directory, SCHEME.key(hash));
  const readArtifact = async (hash: string): Promise<PerfProtocolEvidence | null> => {
    // No symlink following; read and hash from one handle. Files never overwritten by this adapter.
    const file = await open(pathFor(hash), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return null;
      const bytes = await file.readFile();
      if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== hash) return null;
      return parseEvidence(JSON.parse(bytes.toString('utf8')));
    } finally { await file.close(); }
  };

  const read = async (ref: string): Promise<PerfProtocolEvidence | null> => {
    try {
      const identity = parseRef(ref);
      if (!identity) return null;
      const rows = await sql`
        SELECT id, framework, file_path, status, workspace_id, harness_slug, created_at, execution_details
          FROM harness_shared.test_runs
         WHERE id = ${identity.id} AND workspace_id = ${options.scope.workspaceId}
           AND harness_slug = ${options.scope.harnessSlug} AND framework = 'rubric-check'
      ` as Array<{ id: number | string; framework: string; file_path: string; status: string;
        workspace_id: string; harness_slug: string; created_at: Date | string; execution_details: unknown }>;
      const row = rows[0];
      const subject = { kind: 'perf-evidence', ref: identity.artifactHash };
      if (rows.length !== 1 || Number(row.id) !== identity.id || row.status !== 'pass' || row.framework !== 'rubric-check' ||
          row.workspace_id !== options.scope.workspaceId || row.harness_slug !== options.scope.harnessSlug ||
          row.file_path !== rubricCheckLedgerPath(RUBRIC, CHECK, subject)) return null;
      const check = parseTestRunExecutionDetails(row.execution_details)?.check;
      const provenance = check?.provenance;
      if (!check || check.id !== CHECK || check.rubricRef !== RUBRIC || check.criterionKey !== 'R-1' ||
          check.subject?.kind !== subject.kind || check.subject.ref !== subject.ref ||
          check.kind !== 'instrument' || check.unit !== null || check.value !== identity.artifactHash || !provenance ||
          provenance.truncated || provenance.redacted || provenance.gaps.length) return null;
      const descriptor = JSON.parse(provenance.procedure.snapshot);
      if (descriptor.kind !== 'perf-evidence-artifact-v1' || descriptor.artifactHash !== identity.artifactHash ||
          descriptor.artifactKey !== SCHEME.key(identity.artifactHash) || perfProtocolHash(descriptor) !== provenance.procedure.sha256) return null;
      const evidence = await readArtifact(identity.artifactHash);
      const publishedAtMs = new Date(row.created_at).getTime();
      if (!evidence || !Number.isFinite(publishedAtMs) || publishedAtMs > now()) return null;
      // The DB insertion clock, not a caller backdate, controls pretrial publication.
      const eventAtMs = evidence.kind === 'registration' ? evidence.registeredAtMs : 'endedAtMs' in evidence ? evidence.endedAtMs : null;
      if (eventAtMs !== null && (!Number.isFinite(eventAtMs) || eventAtMs > publishedAtMs)) return null;
      // Keep authored bytes/hash intact; the verifier checks BOTH clocks.
      return { ...evidence, publishedAtMs };
    } catch { return null; }
  };

  const publish = async (body: PerfEvidenceBody): Promise<{ ref: string; evidence: PerfProtocolEvidence; artifactPath: string }> => {
    const evidence = sealPerfEvidence(body);
    if (!parseEvidence(evidence)) throw new Error('invalid perf evidence');
    const bytes = Buffer.from(JSON.stringify(evidence));
    if (bytes.length > MAX_BYTES) throw new Error('perf evidence too large');
    const artifactHash = createHash('sha256').update(bytes).digest('hex');
    const artifactPath = pathFor(artifactHash);
    await mkdir(join(directory, SCHEME.prefix), { recursive: true });
    let file;
    try { file = await open(artifactPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (file) { try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
    if (!await readArtifact(artifactHash)) throw new Error('perf artifact readback failed');
    const at = new Date(now()).toISOString();
    const descriptor = { kind: 'perf-evidence-artifact-v1', artifactHash, artifactKey: SCHEME.key(artifactHash) };
    const ids = await recordRubricCheckResults([{
      // Subject scope keeps artifact integrity out of the rubric-wide acceptance grade.
      check: { id: CHECK, rubricRef: RUBRIC, criterionKey: 'R-1', kind: 'instrument', value: artifactHash, unit: null,
        subject: { kind: 'perf-evidence', ref: artifactHash },
        provenance: retainMeasurementProvenance({ procedure: descriptor, result: { artifactHash }, startedAt: at, finishedAt: at }) },
      verdict: 'pass', measuredAt: at, durationMs: 0,
    }], options.scope, sql);
    if (ids.length !== 1 || !Number.isSafeInteger(ids[0]) || ids[0] < 1) throw new Error('perf ledger receipt missing');
    const ref = `perf-evidence:${ids[0]}:${artifactHash}`;
    const retained = await read(ref);
    if (!retained) throw new Error('perf ledger/artifact readback failed');
    return { ref, evidence: retained, artifactPath };
  };
  return { publish, read };
}

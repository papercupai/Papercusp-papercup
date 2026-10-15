/** R9 evidence inspection, composed through the maintained release-profile seam.
 * Pins are supplied by the authoritative spec-evidence reader, not minted here.
 * A valid receipt does not create approval authority or prove its own authenticity.
 * Integration fixtures can qualify only an explicitly requested integration check.
 */
import type { ComponentCheckResult, ComponentRawVerdict, ComponentSpec } from '@papercusp/release-profile';

export interface DeploymentProfile {
  id: string;
  os: string;
  delivery: 'desktop-hosted' | 'private-cloud';
  artifactSha256: string;
  datasetId: string;
  expectedDataSha256: string;
  expectedRestrictionsSha256: string;
  installId: string;
  restoreId: string;
  runtime: { ref: string; owner: string; isolationBoundary: string; routeRef?: string };
  networkCases: readonly string[];
  updateRings: readonly string[];
  managedEndpoint: boolean;
  privateNetwork: boolean;
  /** No defaults: these must be frozen before the exercise, even in a fixture. */
  maxRtoMs: number | null;
  maxRpoMs: number | null;
}

export interface DeploymentSelection {
  planRef: string;
  specRevision: string;
  sourceBlobSha256: string;
  recordSha256: string;
  assumptionRegisterSha256: string;
  approvalRef: string;
  approvedBy: string;
  approvedAt: string;
  frozenAt: string;
  candidateSha: string;
  profiles: readonly DeploymentProfile[];
}

export interface DeploymentReceipt {
  ref: string;
  assertionIds: readonly string[];
  plane: 'integration' | 'operational';
  runtime: {
    ref: string;
    owner: string;
    isolationBoundary: string;
    kind: 'integration-fixture' | 'isolated-candidate';
    /** Pin the maintained dev:pipeline_position.currentBuildTestRoute receipt. */
    routeRef?: string;
    artifactSha256: string;
  };
  candidateSha: string;
  recordSha256: string;
  profileId: string;
  artifactSha256: string;
  datasetId: string;
  installId: string;
  restoreId: string;
  phase: string;
  startedAt: string;
  finishedAt: string;
  verdict: ComponentRawVerdict;
  backupRef?: string;
  recovery?: {
    backupRef: string;
    recoveryPointAt: string;
    incidentAt: string;
    healthyAt: string;
    expectedDataSha256: string;
    restoredDataSha256: string;
    expectedRestrictionsSha256: string;
    restoredRestrictionsSha256: string;
    legitimateAllowed: boolean | null;
    unauthorizedDenied: boolean | null;
  };
}

export interface DeploymentEvidenceInput {
  selection?: DeploymentSelection | null;
  receipts: readonly DeploymentReceipt[];
  requiredPlane?: 'integration' | 'operational';
  nowMs?: number;
}

export interface DeploymentEvidenceResult extends ComponentCheckResult {
  checks: { id: string; verdict: ComponentRawVerdict; reason: string }[];
  coverage: {
    population: string[];
    checked: string[];
    notChecked: string[];
    notApplicable: string[];
    residue: string[];
  };
}

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BASE_PHASES = ['install', 'boot', 'configuration', 'upgrade', 'health', 'diagnostics', 'backup', 'restore'];
const MDM_PHASES = ['mdm-packaging', 'administrator-controls', 'isolated-endpoint'];
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function deploymentPhases(profile: DeploymentProfile): string[] {
  return [...BASE_PHASES, ...profile.networkCases.map(c => `network:${c}`),
    ...profile.updateRings.map(r => `rollout:${r}`),
    ...(profile.managedEndpoint ? MDM_PHASES : []), ...(profile.privateNetwork ? ['private-network'] : [])];
}

export function inspectEnterpriseDeployment(input: DeploymentEvidenceInput): DeploymentEvidenceResult {
  const now = input.nowMs ?? Date.now();
  const plane = input.requiredPlane ?? 'operational';
  const checks: DeploymentEvidenceResult['checks'] = [];
  const coverage: DeploymentEvidenceResult['coverage'] = {
    population: [], checked: [], notChecked: [], notApplicable: [], residue: [],
  };
  const evidence: ComponentCheckResult['evidence'] = [];
  const add = (id: string, verdict: ComponentRawVerdict, reason: string) => checks.push({ id, verdict, reason });
  const missing = (id: string, reason: string) => add(id, 'unknown', reason);
  const compare = (id: string, actual: unknown, expected: unknown) => {
    if (expected === undefined || expected === null || expected === '' ||
      actual === undefined || actual === null || actual === '') missing(id, 'identity or observation absent');
    else if (actual !== expected) add(id, 'fail', 'measured value disagrees with the frozen selection');
  };
  let oldest = now;
  const selected = input.selection;
  if (!selected) missing('selection', 'approved frozen selection absent');
  else {
    for (const key of ['planRef', 'specRevision', 'approvalRef', 'approvedBy'] as const) {
      if (!text(selected[key])) missing(`selection:${key}`, 'qualified provenance absent');
    }
    for (const key of ['sourceBlobSha256', 'recordSha256', 'assumptionRegisterSha256'] as const) {
      if (!HASH.test(selected[key] ?? '')) missing(`selection:${key}`, 'immutable source pin absent or invalid');
    }
    if (!COMMIT.test(selected.candidateSha ?? '')) missing('selection:candidate', 'candidate commit absent or invalid');
    const frozen = Date.parse(selected.frozenAt), approved = Date.parse(selected.approvedAt);
    if (!finite(frozen) || !finite(approved)) missing('selection:time', 'approval/freeze time absent');
    else if (approved > frozen || frozen > now) add('selection:time', 'fail', 'approval must precede the frozen exercise');
    if (!selected.profiles.length) missing('population', 'supported profile population is empty');
    const seenProfiles = new Set<string>();
    for (const profile of selected.profiles) {
      const prefix = `profile:${profile.id}`;
      if (!text(profile.id) || seenProfiles.has(profile.id)) add(prefix, 'fail', 'empty or duplicate profile identity');
      seenProfiles.add(profile.id);
      if (!text(profile.os) || !['desktop-hosted', 'private-cloud'].includes(profile.delivery)) {
        missing(`${prefix}:supported`, 'supported OS/delivery qualification absent');
      }
      if (!HASH.test(profile.artifactSha256 ?? '')) missing(`${prefix}:artifact`, 'artifact digest absent');
      for (const key of ['expectedDataSha256', 'expectedRestrictionsSha256'] as const) {
        if (!HASH.test(profile[key] ?? '')) missing(`${prefix}:${key}`, 'frozen dataset/restriction digest absent');
      }
      if (typeof profile.managedEndpoint !== 'boolean' || typeof profile.privateNetwork !== 'boolean') {
        missing(`${prefix}:selection`, 'managed endpoint/private network selection absent');
      }
      for (const key of ['ref', 'owner', 'isolationBoundary'] as const) {
        if (!text(profile.runtime?.[key])) missing(`${prefix}:runtime:${key}`, 'frozen runtime qualification absent');
      }
      if (plane === 'operational' && !text(profile.runtime?.routeRef)) {
        missing(`${prefix}:runtime:route`, 'frozen maintained test route absent');
      }
      for (const key of ['datasetId', 'installId', 'restoreId'] as const) {
        if (!text(profile[key])) missing(`${prefix}:${key}`, 'frozen exercise identity absent');
      }
      for (const key of ['networkCases', 'updateRings'] as const) {
        const values = profile[key];
        if (!values.length) missing(`${prefix}:${key}`, 'case population is empty');
        if (values.some(v => !text(v)) || new Set(values).size !== values.length) {
          add(`${prefix}:${key}`, 'fail', 'case population has empty or duplicate entries');
        }
      }
      for (const key of ['maxRtoMs', 'maxRpoMs'] as const) {
        if (!finite(profile[key])) missing(`${prefix}:${key}`, 'explicit numeric recovery objective absent');
      }
      for (const phase of deploymentPhases(profile)) {
        const id = `${prefix}/${phase}`;
        coverage.population.push(id);
        const rows = input.receipts.filter(r => r.profileId === profile.id && r.phase === phase);
        if (!rows.length) {
          coverage.notChecked.push(id);
          missing(id, 'required exercise receipt absent');
          continue;
        }
        coverage.checked.push(id);
        if (rows.length !== 1) add(id, 'fail', 'ambiguous duplicate exercise receipts');
        // Inspect every row: a passing duplicate must never hide a contradiction.
        for (const row of rows) {
          if (!text(row.ref) || !row.assertionIds.length || row.assertionIds.some(a => !text(a))) {
            missing(`${id}:provenance`, 'receipt/assertion identity absent');
          }
          evidence.push({ ref: row.ref, kind: `${row.plane}-deployment-receipt`,
            detail: { profileId: row.profileId, phase, assertionIds: [...row.assertionIds] } });
          for (const [key, expected] of Object.entries({ candidateSha: selected.candidateSha,
            recordSha256: selected.recordSha256, artifactSha256: profile.artifactSha256,
            datasetId: profile.datasetId, installId: profile.installId, restoreId: profile.restoreId })) {
            compare(`${id}:${key}`, row[key as keyof DeploymentReceipt], expected);
          }
          if (row.plane !== plane) missing(`${id}:plane`, `requires ${plane} observations; ${row.plane} cannot substitute`);
          const runtime = row.runtime;
          if (!runtime || !text(runtime.ref) || !text(runtime.owner) || !text(runtime.isolationBoundary)) {
            missing(`${id}:runtime`, 'isolated runtime identity absent');
          } else {
            compare(`${id}:runtime-artifact`, runtime.artifactSha256, profile.artifactSha256);
            for (const key of ['ref', 'owner', 'isolationBoundary'] as const) {
              compare(`${id}:runtime:${key}`, runtime[key], profile.runtime?.[key]);
            }
            if (plane === 'operational' && (runtime.kind !== 'isolated-candidate' || !text(runtime.routeRef))) {
              missing(`${id}:runtime-route`, 'maintained isolated/candidate test route receipt absent');
            }
            if (plane === 'operational') compare(`${id}:runtime-route`, runtime.routeRef, profile.runtime?.routeRef);
          }
          const start = Date.parse(row.startedAt), end = Date.parse(row.finishedAt);
          if (!finite(start) || !finite(end)) missing(`${id}:time`, 'exercise times absent');
          else {
            oldest = Math.min(oldest, start);
            if (start < frozen || end < start || end > now) add(`${id}:time`, 'fail', 'exercise is outside its frozen measurement window');
          }
          if (row.verdict === 'fail') add(id, 'fail', 'exercise reported a measured failure');
          else if (row.verdict !== 'pass') missing(id, 'exercise did not measure a pass');
          else add(id, 'pass', 'exercise passed on its recorded plane');
          if (phase !== 'restore') continue;
          const recovery = row.recovery;
          if (!recovery) { missing(`${id}:recovery`, 'recovery observation absent'); continue; }
          if (!text(recovery.backupRef)) missing(`${id}:backup`, 'completed backup reference absent');
          const backups = input.receipts.filter(r => r.profileId === profile.id && r.phase === 'backup');
          if (!backups.length) missing(`${id}:backup-join`, 'completed backup receipt absent');
          for (const backup of backups) compare(`${id}:backup-join`, recovery.backupRef, backup.backupRef);
          compare(`${id}:dataset-pin`, recovery.expectedDataSha256, profile.expectedDataSha256);
          compare(`${id}:restrictions-pin`, recovery.expectedRestrictionsSha256, profile.expectedRestrictionsSha256);
          for (const [expected, actual] of [
            [recovery.expectedDataSha256, recovery.restoredDataSha256],
            [recovery.expectedRestrictionsSha256, recovery.restoredRestrictionsSha256],
          ]) {
            if (!HASH.test(expected ?? '') || !HASH.test(actual ?? '')) missing(`${id}:state`, 'data/restriction digest absent');
            else compare(`${id}:state`, actual, expected);
          }
          for (const key of ['legitimateAllowed', 'unauthorizedDenied'] as const) {
            compare(`${id}:${key}`, recovery[key], true);
          }
          const point = Date.parse(recovery.recoveryPointAt), incident = Date.parse(recovery.incidentAt);
          const healthy = Date.parse(recovery.healthyAt);
          if (![point, incident, healthy].every(finite)) missing(`${id}:objectives`, 'recovery timing observation absent');
          else if (point < frozen || point > incident || incident > healthy || incident < start || healthy > end) {
            add(`${id}:objectives`, 'fail', 'recovery timestamps do not describe this exercise');
          } else {
            const rtoMs = healthy - incident, rpoMs = incident - point;
            if (finite(profile.maxRtoMs) && rtoMs > profile.maxRtoMs) add(`${id}:rto`, 'fail', 'measured RTO exceeds frozen objective');
            if (finite(profile.maxRpoMs) && rpoMs > profile.maxRpoMs) add(`${id}:rpo`, 'fail', 'measured RPO exceeds frozen objective');
            evidence.push({ ref: recovery.backupRef, kind: 'recovery-measurement', detail: { rtoMs, rpoMs } });
          }
        }
      }
    }
    for (const row of input.receipts) {
      const profile = selected.profiles.find(p => p.id === row.profileId);
      if (!profile || !deploymentPhases(profile).includes(row.phase)) {
        add(`receipt:${row.ref}`, 'fail', 'receipt names an unsupported profile or unselected phase');
      }
    }
  }
  // Contradictions survive missing evidence. Unknown can never erase a measured failure.
  const verdict = checks.some(c => c.verdict === 'fail') ? 'fail'
    : checks.some(c => c.verdict === 'unknown') ? 'unknown' : 'pass';
  const blocking = checks.filter(c => c.verdict !== 'pass');
  return { verdict, reason: blocking.length ? blocking.map(c => `${c.id}: ${c.reason}`).join('; ')
    : `${plane} selected deployment/recovery evidence passes; receipt validation does not establish external authority`,
  measuredAt: new Date(oldest).toISOString(), evidence, checks, coverage,
  lineage: { sha: selected?.candidateSha, recordSha256: selected?.recordSha256 } };
}

/** Adds one case to the existing profile evaluator; no parallel gate or store. */
export function enterpriseDeploymentComponent(input: DeploymentEvidenceInput, maxAgeMs: number): ComponentSpec {
  return { key: 'enterprise-deployment-recovery', title: `Enterprise deployment/recovery (${input.requiredPlane ?? 'operational'})`,
    mandatory: true, maxAgeMs, check: async () => inspectEnterpriseDeployment(input) };
}

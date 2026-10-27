/**
 * Independent D294-D297 consumer refusals, WI-6554700010020476.
 * This is the dispatch/missing-original slice of the six-outcome packet.
 * Signed positive packets, qualification and seed fixtures remain separate work;
 * passing this file alone never grants source or physical admission.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeCandidateManifestFromRecords,
  type ComputeDeps,
  type ComputeOptions,
} from './run-p2p-candidate-manifest';

// Freeze the outcome population independently of the future implementation.
const OUTCOMES = ['P-401', 'P-502', 'P-503', 'P-521'] as const;
type Outcome = typeof OUTCOMES[number];
const PLAN = 'p2p-public-release-endgame-2026-09-01';
const SOURCE = 'cbd21646b5c73bd23cad5608f9526cf9bd0048ce';
const DESKTOP = 'b'.repeat(40);
const NOW = Date.parse('2026-10-23T09:00:00Z');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ARTIFACT = sha256('private prospective outcome artifact');
const DIGEST = sha256(`${ARTIFACT}  OutcomeFixture.deb\n`);

interface Request {
  outcome: Outcome;
  planSlug: string;
  workspaceId: string;
  harnessSlug: string;
  sourceSha: string;
  artifactDigest: string;
}
// Unknown is intentional at the untrusted original-record boundary. These
// adversarial fixtures must not borrow a future producer's trust verdict.
type Reader = (request: Request) => Promise<unknown>;
interface Report {
  ok: boolean;
  checks: Array<{ id: string; status: string; detail: string }>;
  go: unknown | null;
  drill: unknown | null;
  defaultChoice: unknown | null;
  candidateAcceptance: unknown | null;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(reader?: Reader): { options: ComputeOptions; deps: ComputeDeps } {
  const root = mkdtempSync(join(tmpdir(), 'p2p-outcome-originals-'));
  roots.push(root);
  const provenancePath = join(root, 'build-provenance.json');
  writeFileSync(provenancePath, JSON.stringify({
    version: '0.0.25', buildSha: DESKTOP.slice(0, 12), gitHead: DESKTOP,
    gitDirty: false, gitDirtyAtEmit: false, reused: false,
    dirtySource: { status: 'captured', repositories: [
      { label: 'workspace', gitHead: SOURCE, files: [] },
      { label: 'desktop', gitHead: DESKTOP, files: [] },
    ] },
    builtAtUtc: new Date(NOW - 60_000).toISOString(),
    artifacts: [{ name: 'OutcomeFixture.deb', sha256: ARTIFACT, bytes: 37, sig: true }],
  }));
  const deps: ComputeDeps = {
    readLedger: async () => ({ version: '0.0.25', channel: 'alpha', gitSha: SOURCE,
      artifacts: [{ name: 'OutcomeFixture.deb', sha256: ARTIFACT }] }),
    readBuildCommand: async () => ({
      tool: 'release:cut', invocationId: 'private-outcome-build',
      invokedAt: new Date(NOW - 90_000).toISOString(), servingBuildSha: SOURCE,
      args: { op: 'run', version: '0.0.25', channel: 'alpha', confirm: true, sourceSha: SOURCE },
    }),
    hashFile: async () => ARTIFACT,
  };
  // Install the prospective optional reader at the maintained public seam.
  // Avoid importing an absent export: baseline failure must be an assertion.
  if (reader) Object.assign(deps, { readEndgameOutcomeOriginals: reader });
  return {
    options: { version: '0.0.25', channel: 'alpha',
      legs: [{ leg: 'linux', path: provenancePath }], repoRoot: root, now: NOW },
    deps,
  };
}

async function compute(reader?: Reader) {
  const { options, deps } = fixture(reader);
  return computeCandidateManifestFromRecords(options, deps);
}

function refused(result: Awaited<ReturnType<typeof compute>>, outcome?: Outcome): Report {
  const value: unknown = Reflect.get(result, 'outcomes');
  expect(value, 'computed outcomes must expose missing original evidence').toEqual(
    expect.objectContaining({ ok: false, checks: expect.any(Array) }),
  );
  // The preceding assertion terminates the baseline before any dereference.
  const report = value as Report;
  for (const id of outcome ? [outcome] : OUTCOMES) {
    const rows = report.checks.filter(check => check.id === id);
    expect(rows, `${id} requires exactly one aggregate diagnostic`).toHaveLength(1);
    expect(rows[0]!.status).not.toBe('pass');
    expect(rows[0]!.detail.trim().length).toBeGreaterThan(0);
  }
  for (const field of ['go', 'drill', 'defaultChoice', 'candidateAcceptance']) {
    expect(Reflect.has(report, field), `retain the ${field} result slot`).toBe(true);
  }
  return report;
}

describe('D294-D297 prospective computed outcome original readers', () => {
  it('derives source and artifact pins through the real provenance consumer (fixture control)', async () => {
    const result = await compute();
    expect(result.provenance.sourceSha).toBe(SOURCE);
    expect(result.provenance.provenance.candidateDigest).toBe(DIGEST);
    expect(result.manifest.artifact.sha256).toBe(DIGEST);
  });

  it('retains every outcome as non-pass when the optional original reader is absent', async () => {
    refused(await compute());
  });

  it('requests every outcome exactly once using candidate-derived pins', async () => {
    const requests: Request[] = [];
    await compute(async request => { requests.push(structuredClone(request)); return null; });
    expect(requests).toHaveLength(OUTCOMES.length);
    expect(requests.map(request => request.outcome).sort()).toEqual([...OUTCOMES].sort());
    for (const request of requests) {
      expect(request).toEqual(expect.objectContaining({
        planSlug: PLAN, sourceSha: SOURCE, artifactDigest: DIGEST,
        workspaceId: expect.any(String), harnessSlug: expect.any(String),
      }));
      expect(request.workspaceId.trim()).not.toBe('');
      expect(request.harnessSlug.trim()).not.toBe('');
    }
  });

  it.each(OUTCOMES)('%s missing original is a retained non-pass outcome', async outcome => {
    refused(await compute(async () => null), outcome);
  });

  it.each(OUTCOMES)('%s lookup failure cannot prevent the other original readers from running', async outcome => {
    const requests: Request[] = [];
    const result = await compute(async request => {
      requests.push(structuredClone(request));
      if (request.outcome === outcome) throw new Error(`private ${outcome} original lookup unavailable`);
      return null;
    });
    expect(requests.map(request => request.outcome).sort()).toEqual([...OUTCOMES].sort());
    refused(result);
  });

  it.each(OUTCOMES)('%s cannot pass on caller-supplied trust/status flags', async outcome => {
    const result = await compute(async request => ({
      ...request, status: 'passed', ok: true, authenticated: true, eligible: true,
      readiness: { go: true }, signedGo: { verified: true },
      physical: { accepted: true }, phaseG: { ok: true }, phaseI: { ok: true },
      candidateAcceptance: { passed: true },
    }));
    refused(result, outcome);
  });

  it.each(OUTCOMES)('%s cannot pass on unresolved references instead of original bytes', async outcome => {
    const result = await compute(async request => ({
      ...request, readiness: 'readiness:private', ledgerFlips: ['plan-revision:private'],
      approval: 'plan-audit:private', signedGo: 'go:private', signerTrust: 'witness:private',
      physical: 'physical:private', phaseG: 'phase-g:private', phaseI: 'phase-i:private',
      decision: 'decision:private', source: 'source:private', qualifications: ['qualification:private'],
    }));
    refused(result, outcome);
  });

  it.each(['foreign-source', 'foreign-artifact', 'foreign-plan', 'wrong-discriminant'] as const)(
    'refuses a %s packet rather than adopting its claimed pins', async defect => {
      const result = await compute(async request => ({
        ...request,
        ...(defect === 'foreign-source' ? { sourceSha: 'f'.repeat(40) } : {}),
        ...(defect === 'foreign-artifact' ? { artifactDigest: 'f'.repeat(64) } : {}),
        ...(defect === 'foreign-plan' ? { planSlug: 'private-foreign-plan' } : {}),
        ...(defect === 'wrong-discriminant' ? { outcome: 'P-403' } : {}),
        status: 'passed', ok: true,
      }));
      refused(result);
      expect(result.provenance.sourceSha).toBe(SOURCE);
      expect(result.provenance.provenance.candidateDigest).toBe(DIGEST);
    },
  );
});

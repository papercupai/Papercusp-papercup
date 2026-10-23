import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareArtifactSets,
  deriveCandidateProvenance,
  deriveJourneyEvidence,
  evidenceVerdict,
  ENDGAME_SHIPMENT_PLANS,
  parseLegBuildProvenance,
  validateEndgameDefaultChoice,
  validateEndgameShipmentLedger,
  type LegBuildProvenance,
  type LegProvenanceInput,
  type ReleaseLedgerRecord,
} from './p2p-candidate-evidence';
import { buildP2pCandidateManifest } from './p2p-candidate-manifest';
import {
  computeCandidateManifestFromRecords,
  redactHome,
  sha256Bytes,
  type ComputeDeps,
} from './run-p2p-candidate-manifest';

const SRC = '93f1c72063bb422583c9c24e7092f1bed767f64f';
const DESKTOP = 'cddbd8d530d8d3a7c49f22a371347d601a24ba47';
const h = (seed: string) => createHash('sha256').update(seed).digest('hex');

describe('endgame R-15 persisted default choice', () => {
  const pins = { artifactDigest: h('private-candidate'), sourceSha: SRC };
  const valid = () => ({
    ...pins, decisionRef: 'p2p-public-release-endgame-2026-09-01#D-300', choice: 'legacy',
    rationale: 'Keep the current default after inspecting the witness and recovery drill.',
    recordedAt: '2026-10-22T10:00:03Z',
    evidence: ['witness', 'independent-go', 'owner-freeze-recovery-drill'].map((kind, i) => ({
      ...pins, kind, status: 'passed', ref: `docs/evidence/${kind}.json`, sha256: h(kind),
      finishedAt: `2026-10-22T10:00:0${i}Z`,
    })),
  });
  it('accepts a persisted choice tied to a witness and post-GO drill without an elapsed soak', () => {
    expect(validateEndgameDefaultChoice(valid(), pins)).toEqual([]);
  });
  it.each(['missing-decision', 'missing-drill', 'foreign-artifact', 'unknown-drill', 'pre-go-drill', 'late-evidence', 'malformed-extra'])
  ('rejects %s independently of the passing witness', fault => {
    const input = valid();
    if (fault === 'missing-decision') input.decisionRef = '';
    if (fault === 'missing-drill') input.evidence.pop();
    if (fault === 'foreign-artifact') input.evidence[2]!.artifactDigest = h('other-candidate');
    if (fault === 'unknown-drill') input.evidence[2]!.status = 'unknown';
    if (fault === 'pre-go-drill') input.evidence[2]!.finishedAt = input.evidence[0]!.finishedAt;
    if (fault === 'late-evidence') input.recordedAt = input.evidence[0]!.finishedAt;
    if (fault === 'malformed-extra') Object.assign(input, { evidence: [...input.evidence, null] });
    expect(validateEndgameDefaultChoice(input, pins).length).toBeGreaterThan(0);
  });
});

describe('endgame R-17 exact six-plan shipment ledger', () => {
  const pins = { artifactDigest: h('private-candidate'), sourceSha: SRC };
  const valid = () => ENDGAME_SHIPMENT_PLANS.map((planSlug, i) => ({
    ...pins, planSlug: String(planSlug), status: 'shipped', forcedPast: null as unknown,
    acceptanceRubricRevision: 1, acceptanceCriteriaHash: h(`criteria:${planSlug}`),
    codeTruthAudit: { ref: `plan-audit:${i + 1}`, planSlug: String(planSlug), verdict: 'implemented' },
    independentGrade: {
      rubricRef: `acceptance-${planSlug}`, rubricRevision: 1, criteriaHash: h(`criteria:${planSlug}`), scorecardId: `EI-${i + 1}`,
      graderId: 'independent-grader', gradingAuditRef: `EI-${i + 100}`,
      eligibility: { ref: `lineage:${i + 1}`, graderId: 'independent-grader', rubricAuthorId: 'implementer',
        implementerIds: ['implementer'], outsideImplementationLineage: true, outsideRubricAuthorLineage: true, liveAtGrading: true,
        soleVettingCritic: false, launchedByImplementer: false },
    },
    authorVerdict: { ref: `EI-${i + 200}`, verdict: 'accept', acceptanceOf: `EI-${i + 1}`, authorId: 'implementer' },
  }));
  it('accepts six distinct shipped plans including both stragglers with independent grades and author verdicts', () => {
    expect(validateEndgameShipmentLedger(valid(), pins)).toEqual([]);
  });
  it.each(['missing', 'extra', 'duplicate', 'foreign-slug', 'not-shipped', 'foreign-bytes', 'forced',
    'missing-audit', 'wrong-rubric', 'missing-grade-audit', 'implementer-grader', 'related-lineage',
    'sole-critic', 'implementer-launch', 'wrong-author-card', 'missing-lineage-evidence',
    'stale-rubric-revision', 'foreign-criteria-hash', 'rubric-author-lineage', 'not-live-at-grade'])
  ('rejects %s while the other five rows remain valid', fault => {
    const rows = valid();
    const row = rows[0]!;
    if (fault === 'missing') rows.pop();
    if (fault === 'extra') rows.push(structuredClone(row));
    if (fault === 'duplicate') rows[1] = structuredClone(row);
    if (fault === 'foreign-slug') row.planSlug = 'unrelated-plan';
    if (fault === 'not-shipped') row.status = 'ready';
    if (fault === 'foreign-bytes') row.artifactDigest = h('other-candidate');
    if (fault === 'forced') row.forcedPast = { checks: ['rubric-grading'] };
    if (fault === 'missing-audit') row.codeTruthAudit.ref = '';
    if (fault === 'wrong-rubric') row.independentGrade.rubricRef = 'acceptance-other';
    if (fault === 'missing-grade-audit') row.independentGrade.gradingAuditRef = '';
    if (fault === 'implementer-grader') row.independentGrade.graderId = 'implementer';
    if (fault === 'related-lineage') row.independentGrade.eligibility.outsideImplementationLineage = false;
    if (fault === 'sole-critic') row.independentGrade.eligibility.soleVettingCritic = true;
    if (fault === 'implementer-launch') row.independentGrade.eligibility.launchedByImplementer = true;
    if (fault === 'wrong-author-card') row.authorVerdict.acceptanceOf = 'EI-999';
    if (fault === 'missing-lineage-evidence') row.independentGrade.eligibility.ref = '';
    if (fault === 'stale-rubric-revision') row.independentGrade.rubricRevision = 2;
    if (fault === 'foreign-criteria-hash') row.independentGrade.criteriaHash = h('old-criteria');
    if (fault === 'rubric-author-lineage') row.independentGrade.eligibility.outsideRubricAuthorLineage = false;
    if (fault === 'not-live-at-grade') row.independentGrade.eligibility.liveAtGrading = false;
    expect(validateEndgameShipmentLedger(rows, pins).length).toBeGreaterThan(0);
  });
});

// Independent oracle for the candidate identity: sha256 over sorted "<sha>  <basename>\n".
function digestOracle(pairs: [string, string][]): string {
  return createHash('sha256')
    .update(pairs.map(([name, sha]) => `${sha}  ${name}\n`).sort().join(''))
    .digest('hex');
}

function leg(artifacts: [string, string][], over: Partial<LegBuildProvenance> = {}): LegBuildProvenance {
  return {
    version: '0.0.25',
    buildSha: 'cddbd8d5',
    reused: false,
    gitHead: DESKTOP,
    gitDirty: false,
    gitDirtyAtEmit: true,
    dirtySource: {
      status: 'captured',
      repositories: [
        { label: 'desktop', gitHead: DESKTOP, files: [] },
        { label: 'workspace', gitHead: SRC, files: [] },
      ],
    },
    toolchain: { rustc: '1.97.1' },
    releaseHostSha256: h('host'),
    sidecar: { gitHead: SRC, serveMjsSha256: h('serve') },
    builtAtUtc: '2026-09-29T17:22:14Z',
    artifacts: artifacts.map(([name, sha]) => ({ name, sha256: sha, bytes: 10, sig: true })),
    ...over,
  };
}

const LINUX: [string, string][] = [
  ['deb/Papercusp Server_0.0.25_amd64.deb', h('server-deb')],
  ['deb/Papercusp GUI_0.0.25_amd64.deb', h('gui-deb')],
];
const MAC: [string, string][] = [['macos/Papercusp Server.app.tar.gz', h('server-tgz')]];

function legs(over: Record<string, Partial<LegBuildProvenance>> = {}): LegProvenanceInput[] {
  return [
    { leg: 'linux', path: '/x/linux/build-provenance.json', record: leg(LINUX, over.linux) },
    { leg: 'mac', path: '/x/mac/build-provenance.json', record: leg(MAC, over.mac) },
  ];
}

function ledger(over: Partial<ReleaseLedgerRecord> = {}): ReleaseLedgerRecord {
  return {
    version: '0.0.25',
    channel: 'alpha',
    gitSha: SRC,
    cutAt: '2026-09-29T17:55:29Z',
    publishedAt: null,
    artifacts: [
      { name: 'Papercusp Server_0.0.25_amd64.deb', sha256: h('server-deb'), size: 10 },
      { name: 'Papercusp Server_0.0.25_x64-setup.zip', sha256: h('win-zip'), size: 10 },
    ],
    ...over,
  };
}

const RUN_CMD = {
  tool: 'release:cut',
  invocationId: '30021770',
  invokedAt: '2026-09-29T15:45:54.326Z',
  args: { op: 'run', version: '0.0.25', channel: 'alpha', sourceSha: SRC, confirm: true },
};

const statusOf = (p: ReturnType<typeof deriveCandidateProvenance>, id: string) =>
  p.provenance.checks.find((c) => c.id === id)?.status;

describe('deriveCandidateProvenance', () => {
  it('derives an unpublished private source from the producer primary snapshot corroborated by its sidecar', () => {
    const over = { dirtySource: { status: 'captured', repositories: [{ label: 'primary', gitHead: SRC, files: [] }] } };
    const p = deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs({ linux: over, mac: over }) });
    expect(p.sourceSha).toBe(SRC);
    expect(statusOf(p, 'source-revision')).toBe('pass');
    // Source identification does not manufacture a missing release-cut receipt.
    expect(statusOf(p, 'build-command')).not.toBe('pass');
  });

  it.each([
    { repositories: [{ label: 'primary', gitHead: DESKTOP, files: [] }] },
    { repositories: [{ label: 'primary', gitHead: SRC, files: [] }, { label: 'primary', gitHead: SRC, files: [] }] },
  ])('refuses an uncorroborated or ambiguous primary source: %j', ({ repositories }) => {
    const over = { dirtySource: { status: 'captured', repositories } };
    expect(() => deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs({ linux: over, mac: over }) }))
      .toThrow(/cannot identify the candidate source/);
  });

  it('keeps explicit workspace source authoritative over a primary desktop capture', () => {
    const over = { dirtySource: { status: 'captured', repositories: [
      { label: 'primary', gitHead: DESKTOP, files: [] }, { label: 'workspace', gitHead: SRC, files: [] },
    ] } };
    const p = deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs({ linux: over, mac: over }) });
    expect(p.sourceSha).toBe(SRC);
    expect(statusOf(p, 'source-revision')).toBe('pass');
  });

  it('reports a primary source contradicting the release ledger instead of silently replacing the ledger', () => {
    const over = { dirtySource: { status: 'captured', repositories: [{ label: 'primary', gitHead: SRC, files: [] }] } };
    const p = deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs({ linux: over, mac: over }),
      ledger: ledger({ gitSha: 'f'.repeat(40) }) });
    expect(statusOf(p, 'source-revision')).toBe('fail');
    expect(p.provenance.ok).toBe(false);
  });

  it('derives source, pins and a digest over the union of leg + ledger artifacts', () => {
    const p = deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs(), ledger: ledger(), buildCommand: RUN_CMD });
    expect(p.sourceSha).toBe(SRC);
    expect(p.provenance.desktopSha).toBe(DESKTOP);
    expect(p.provenance.buildSha).toBe('cddbd8d5');
    expect(p.artifacts.map((a) => a.name)).toEqual([
      'Papercusp GUI_0.0.25_amd64.deb',
      'Papercusp Server.app.tar.gz',
      'Papercusp Server_0.0.25_amd64.deb',
      'Papercusp Server_0.0.25_x64-setup.zip',
    ]);
    expect(p.provenance.candidateDigest).toBe(
      digestOracle([
        ['Papercusp GUI_0.0.25_amd64.deb', h('gui-deb')],
        ['Papercusp Server.app.tar.gz', h('server-tgz')],
        ['Papercusp Server_0.0.25_amd64.deb', h('server-deb')],
        ['Papercusp Server_0.0.25_x64-setup.zip', h('win-zip')],
      ]),
    );
    const deb = p.provenance.artifacts.find((a) => a.name === 'Papercusp Server_0.0.25_amd64.deb');
    expect(deb?.sources).toEqual(['leg:linux', 'ledger']);
    for (const id of ['version-agreement', 'source-revision', 'desktop-pin', 'clean-source', 'built-not-reused', 'artifact-identity', 'sidecar-payload', 'build-command']) {
      expect(statusOf(p, id), id).toBe('pass');
    }
    // the zip is vouched for only by the ledger, and nothing was re-hashed
    expect(statusOf(p, 'ledger-corroboration')).toBe('warn');
    expect(statusOf(p, 'rehash')).toBe('warn');
    expect(p.provenance.ok).toBe(true);
  });

  it('a matching on-disk re-hash corroborates a ledger-only artifact', () => {
    const p = deriveCandidateProvenance({
      version: '0.0.25',
      channel: 'alpha',
      legs: legs(),
      ledger: ledger(),
      rehashes: [{ name: 'Papercusp Server_0.0.25_x64-setup.zip', sha256: h('win-zip'), bytes: 10, path: '/x/zip' }],
    });
    expect(statusOf(p, 'ledger-corroboration')).toBe('pass');
    expect(statusOf(p, 'rehash')).toBe('pass');
  });

  it.each([
    ['source-revision', { linux: { dirtySource: { repositories: [{ label: 'workspace', gitHead: 'f'.repeat(40), files: [] }] } } }],
    ['built-not-reused', { mac: { reused: true } }],
    ['clean-source', { linux: { gitDirty: true } }],
    ['clean-source', { mac: { dirtySource: { repositories: [{ label: 'workspace', gitHead: SRC, files: [{ path: 'a.ts' }] }] } } }],
    ['desktop-pin', { mac: { gitHead: 'e'.repeat(40), buildSha: 'eeeeeeee' } }],
    ['desktop-pin', { linux: { buildSha: 'deadbeef' } }],
    ['version-agreement', { mac: { version: '0.0.24' } }],
    ['sidecar-payload', { mac: { sidecar: { gitHead: SRC, serveMjsSha256: h('other-serve') } } }],
    ['sidecar-payload', { linux: { sidecar: { gitHead: 'a'.repeat(40), serveMjsSha256: h('serve') } } }],
  ] as const)('a contradiction fails %s', (id, over) => {
    const p = deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs(over as never), ledger: ledger() });
    expect(statusOf(p, id)).toBe('fail');
    expect(p.provenance.ok).toBe(false);
  });

  it('fails when one basename carries two byte identities or a re-hash disagrees', () => {
    const conflict = deriveCandidateProvenance({
      version: '0.0.25',
      channel: 'alpha',
      legs: legs(),
      ledger: ledger({ artifacts: [{ name: 'Papercusp Server_0.0.25_amd64.deb', sha256: h('tampered') }] }),
    });
    expect(statusOf(conflict, 'artifact-identity')).toBe('fail');
    const drift = deriveCandidateProvenance({
      version: '0.0.25',
      channel: 'alpha',
      legs: legs(),
      rehashes: [{ name: 'deb/Papercusp GUI_0.0.25_amd64.deb', sha256: h('bitrot'), bytes: 10, path: '/x' }],
    });
    expect(statusOf(drift, 'rehash')).toBe('fail');
    expect(drift.provenance.ok).toBe(false);
  });

  it('fails a ledger or build command that names different source or runs after the build', () => {
    const wrongLedger = deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs(), ledger: ledger({ gitSha: 'b'.repeat(40) }) });
    expect(statusOf(wrongLedger, 'source-revision')).toBe('fail');
    expect(statusOf(wrongLedger, 'ledger-corroboration')).toBe('fail');
    const wrongCmd = deriveCandidateProvenance({
      version: '0.0.25',
      channel: 'alpha',
      legs: legs(),
      buildCommand: { ...RUN_CMD, args: { ...RUN_CMD.args, sourceSha: 'c'.repeat(40) } },
    });
    expect(statusOf(wrongCmd, 'build-command')).toBe('fail');
    const late = deriveCandidateProvenance({
      version: '0.0.25',
      channel: 'alpha',
      legs: legs(),
      buildCommand: { ...RUN_CMD, invokedAt: '2026-09-29T18:00:00Z' },
    });
    expect(statusOf(late, 'build-command')).toBe('fail');
  });

  it('refuses when no record identifies the source', () => {
    expect(() =>
      deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs({ linux: { dirtySource: null }, mac: { dirtySource: null } }) }),
    ).toThrow(/cannot identify the candidate source/);
  });
});

// WI-6554700010012218: the D-224 candidate nominated a seedless Mac Server and nothing in
// the binding could see it until P-521 J8 failed offline-restore by construction.
describe('server-seed check', () => {
  const SEED = h('seed-manifest');
  const present = { status: 'present', profile: 'dogfood', manifestSha256: SEED, reason: null };
  const seedCheck = (over: Record<string, Partial<LegBuildProvenance>>) => {
    const p = deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs(over), ledger: ledger() });
    return { p, c: p.provenance.checks.find((c) => c.id === 'server-seed')! };
  };

  it('passes when every Server leg carries the same present seed, and the leg summary shows it', () => {
    const { p, c } = seedCheck({ linux: { seed: present }, mac: { seed: present } });
    expect(c.status).toBe('pass');
    expect(c.detail).toContain(`manifest ${SEED}`);
    expect(p.provenance.legs.find((l) => l.leg === 'mac')?.seed).toEqual(present);
  });

  it('FAILS the D-224 shape: a Server_<version> installer whose guard recorded no seed (absent-unaudited)', () => {
    // LINUX's only Server artifact is `Papercusp Server_0.0.25_amd64.deb`: this also pins
    // the artifact match against `\bserver\b`, which `_` defeats.
    const { p, c } = seedCheck({ linux: { seed: { ...present, status: 'absent-unaudited', manifestSha256: null } }, mac: { seed: present } });
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/leg linux ships a Server with seed=absent-unaudited/);
    expect(p.provenance.ok).toBe(false);
  });

  it.each([
    ['refused', /seed=refused/],
    ['not-applicable', /seed=not-applicable/],
    ['bogus', /'bogus' is not a release-seed-guard verdict/],
  ])('fails a Server leg whose receipt is %s', (status, re) => {
    const { c } = seedCheck({ linux: { seed: present }, mac: { seed: { ...present, status } } });
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(re);
  });

  it('warns (never passes) on an explicit seedless allowance, a missing receipt, or diverging seeds', () => {
    const allowed = seedCheck({ linux: { seed: present }, mac: { seed: { ...present, status: 'absent-allowed', manifestSha256: null, reason: 'D-999 VM build' } } }).c;
    expect(allowed.status).toBe('warn');
    expect(allowed.detail).toContain('D-999 VM build');

    const predates = seedCheck({ linux: { seed: present } }).c; // mac fixture has no seed key
    expect(predates.status).toBe('warn');
    expect(predates.detail).toMatch(/leg mac records no seed receipt \(emitter predates the field\)/);

    const noGuard = seedCheck({ linux: { seed: present }, mac: { seed: null } }).c;
    expect(noGuard.detail).toMatch(/no guard ran/);

    const diverging = seedCheck({ linux: { seed: present }, mac: { seed: { ...present, manifestSha256: h('other-seed') } } }).c;
    expect(diverging.status).toBe('warn');
    expect(diverging.detail).toMatch(/different seed manifests/);
  });

  it('passes a vm-release Server excluded by profile, and ignores GUI-only legs', () => {
    const excluded = seedCheck({ linux: { seed: present }, mac: { seed: { ...present, status: 'excluded-by-profile', profile: 'vm-release', manifestSha256: null } } }).c;
    expect(excluded.status).toBe('pass');

    const guiOnly = deriveCandidateProvenance({
      version: '0.0.25',
      channel: 'alpha',
      legs: [{ leg: 'linux', path: '/x/l/build-provenance.json', record: leg([['deb/Papercusp GUI_0.0.25_amd64.deb', h('gui-deb')]]) }],
    });
    expect(guiOnly.provenance.checks.find((c) => c.id === 'server-seed')).toMatchObject({ status: 'pass', detail: 'no leg ships a Server artifact' });
  });
});

describe('parseLegBuildProvenance', () => {
  it('keeps the seed receipt\'s missing / null / object distinction', () => {
    const base = leg(LINUX);
    expect('seed' in parseLegBuildProvenance(base, 'missing')).toBe(false);
    expect(parseLegBuildProvenance({ ...base, seed: null }, 'null').seed).toBeNull();
    expect(parseLegBuildProvenance({ ...base, seed: { status: 'present', profile: 'public', manifestSha256: h('m'), reason: null } }, 'obj').seed)
      .toEqual({ status: 'present', profile: 'public', manifestSha256: h('m'), reason: null });
    expect(parseLegBuildProvenance({ ...base, seed: { profile: 'public' } }, 'nostatus').seed?.status).toBe('malformed');
  });

  it('accepts an emitter record and rejects malformed ones', () => {
    expect(parseLegBuildProvenance(leg(LINUX), 'ok').artifacts).toHaveLength(2);
    expect(() => parseLegBuildProvenance({ ...leg(LINUX), artifacts: [] }, 'empty')).toThrow(/non-empty array/);
    expect(() => parseLegBuildProvenance({ ...leg([['a.deb', 'XYZ']]) }, 'bad')).toThrow(/malformed sha256/);
    expect(() => parseLegBuildProvenance({ ...leg(LINUX), reused: 'no' }, 'bool')).toThrow(/'reused' must be a boolean/);
  });
});

describe('compareArtifactSets', () => {
  it('classifies identical, differing, missing and extra artifacts', () => {
    const cmp = compareArtifactSets(
      [
        { name: 'deb/a.deb', sha256: h('a') },
        { name: 'b.deb', sha256: h('b') },
        { name: 'c.deb', sha256: h('c') },
      ],
      [
        { name: 'a.deb', sha256: h('a') },
        { name: 'b.deb', sha256: h('b2') },
        { name: 'd.deb', sha256: h('d') },
      ],
    );
    expect(cmp).toEqual({
      identical: ['a.deb'],
      differing: [{ name: 'b.deb', recorded: h('b'), rebuilt: h('b2') }],
      missingInRebuild: ['c.deb'],
      extraInRebuild: ['d.deb'],
      reproducible: false,
    });
    expect(compareArtifactSets([{ name: 'a', sha256: h('a') }], [{ name: 'a', sha256: h('a') }]).reproducible).toBe(true);
  });
});

function evidenceDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'operational-test-evidence',
    name: 'journey run',
    subject: { debSha256: h('server-deb'), topology: { hosts: [{ id: 'tower' }, { id: 'mac-vm' }] } },
    exitCode: 0,
    finishedAt: '2026-09-29T20:55:18Z',
    assertions: [{ id: 'exact-artifact', passed: true }],
    ...over,
  };
}

describe('evidenceVerdict', () => {
  it('passes only on exit 0 with a positive signal; fails on any failure; never passes a skip', () => {
    expect(evidenceVerdict(evidenceDoc()).verdict).toBe('pass');
    expect(evidenceVerdict(evidenceDoc({ exitCode: 1 })).verdict).toBe('fail');
    expect(evidenceVerdict(evidenceDoc({ assertions: [{ id: 'x', passed: false }] })).verdict).toBe('fail');
    expect(evidenceVerdict(evidenceDoc({ physicalRun: { legVerdicts: [{ leg: 'A', status: 'pass' }, { leg: 'G', status: 'skip' }] } })).verdict).toBe('unknown');
    expect(evidenceVerdict(evidenceDoc({ physicalRun: { legVerdicts: [{ leg: 'A', status: 'fail' }] } })).verdict).toBe('fail');
    expect(evidenceVerdict(evidenceDoc({ assertions: [] })).verdict).toBe('unknown');
    expect(evidenceVerdict(evidenceDoc({ exitCode: undefined })).verdict).toBe('unknown');
  });
});

describe('deriveJourneyEvidence → manifest', () => {
  const candidate = () => deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs(), ledger: ledger() });

  it('a declared journey measured on a candidate member reads passed-on-this-artifact', async () => {
    const c = candidate();
    const derived = deriveJourneyEvidence({
      candidate: c,
      evidence: [{ path: 'docs/evidence/f3.json', sha256: h('doc'), doc: evidenceDoc({ p521Journey: 'serving-identity-restart' }) }],
    });
    expect(Object.keys(derived.journeys)).toEqual(['serving-identity-restart']);
    const manifest = await buildP2pCandidateManifest({ candidate: c, journeys: derived.journeys, now: Date.parse('2026-09-30T00:00:00Z') });
    const row = manifest.current.rows.find((r) => r.capability === 'serving-identity-restart');
    expect(row?.state).toBe('passed-on-this-artifact');
    expect(row?.evidence.refs[0]?.ref).toBe('docs/evidence/f3.json');
    // the other seven journeys stay unmeasured, so the candidate is not GO
    expect(manifest.current.rows.filter((r) => r.state === 'unmeasured')).toHaveLength(7);
    expect(manifest.current.go).toBe(false);
  });

  it('evidence on other bytes surfaces as lineage-mismatch, never as a pass', async () => {
    const c = candidate();
    const derived = deriveJourneyEvidence({
      candidate: c,
      evidence: [
        {
          path: 'docs/evidence/old.json',
          sha256: h('old'),
          doc: evidenceDoc({ p521Journeys: ['github-bridge'], subject: { debSha256: h('0.0.24-deb'), topology: { hosts: [{ id: 'tower' }, { id: 'mac-vm' }] } } }),
        },
      ],
    });
    expect(derived.bindings[0]?.binding).toBe('other-artifact');
    const manifest = await buildP2pCandidateManifest({ candidate: c, journeys: derived.journeys });
    const row = manifest.current.rows.find((r) => r.capability === 'github-bridge');
    expect(row?.result).toBe('lineage-mismatch');
    expect(row?.state).not.toBe('passed-on-this-artifact');
  });

  it('a missing peer keeps the row advancing', async () => {
    const c = candidate();
    const derived = deriveJourneyEvidence({
      candidate: c,
      evidence: [
        {
          path: 'docs/evidence/one-host.json',
          sha256: h('one'),
          doc: evidenceDoc({ p521Journey: 'discovery-join', subject: { debSha256: h('server-deb'), topology: { hosts: [{ id: 'tower' }] } } }),
        },
      ],
    });
    const manifest = await buildP2pCandidateManifest({ candidate: c, journeys: derived.journeys });
    const row = manifest.current.rows.find((r) => r.capability === 'discovery-join');
    expect(row?.state).toBe('advancing');
    expect(row?.missingPeers).toEqual(['mac-vm']);
  });

  it('prefers the latest on-candidate run over a newer foreign one, and keeps every run in bindings', () => {
    const c = candidate();
    const derived = deriveJourneyEvidence({
      candidate: c,
      evidence: [
        { path: 'a.json', sha256: h('a'), doc: evidenceDoc({ p521Journey: 'discovery-join', finishedAt: '2026-09-29T10:00:00Z', exitCode: 1 }) },
        { path: 'b.json', sha256: h('b'), doc: evidenceDoc({ p521Journey: 'discovery-join', finishedAt: '2026-09-29T12:00:00Z' }) },
        {
          path: 'c.json',
          sha256: h('c'),
          doc: evidenceDoc({ p521Journey: 'discovery-join', finishedAt: '2026-09-29T14:00:00Z', subject: { debSha256: h('foreign') } }),
        },
      ],
    });
    expect(derived.journeys['discovery-join']?.verdict).toBe('pass');
    expect(derived.journeys['discovery-join']?.evidence[0]?.ref).toBe('b.json');
    expect(derived.bindings.map((b) => [b.path, b.selected, b.verdict])).toEqual([
      ['a.json', false, 'fail'],
      ['b.json', true, 'pass'],
      ['c.json', false, 'pass'],
    ]);
  });

  it('reports undeclared candidate evidence as unmapped and rejects unknown journey keys', () => {
    const c = candidate();
    const derived = deriveJourneyEvidence({
      candidate: c,
      evidence: [
        { path: 'run34.json', sha256: h('34'), doc: evidenceDoc() },
        { path: 'typo.json', sha256: h('t'), doc: evidenceDoc({ p521Journey: 'discovery' }) },
        { path: 'notes.json', sha256: h('n'), doc: { kind: 'something-else' } },
      ],
    });
    expect(derived.journeys).toEqual({});
    expect(derived.unmapped).toEqual([{ path: 'run34.json', sha256: h('34'), name: 'journey run' }]);
    expect(derived.ignored.map((i) => i.path)).toEqual(['typo.json', 'notes.json']);
    expect(derived.mappings).toEqual([]);
  });
});

function mappingDoc(evidencePath: string, evidenceSha256: string, journeys: unknown, over: Record<string, unknown> = {}) {
  return {
    kind: 'p521-journey-mapping',
    evidence: { path: evidencePath, sha256: evidenceSha256 },
    p521Journeys: journeys,
    decision: 'p2p-public-release-endgame-2026-09-01#D-083',
    ...over,
  };
}

describe('deriveJourneyEvidence with sha-pinned journey mappings', () => {
  const candidate = () => deriveCandidateProvenance({ version: '0.0.25', channel: 'alpha', legs: legs(), ledger: ledger() });
  const run34 = { path: 'docs/evidence/run34.json', sha256: h('run34-bytes'), doc: evidenceDoc() };

  it('a mapping pinned to the evidence bytes declares its journeys without touching the evidence', async () => {
    const c = candidate();
    const derived = deriveJourneyEvidence({
      candidate: c,
      evidence: [
        run34,
        {
          path: 'docs/evidence/run34.p521-journeys.json',
          sha256: h('map'),
          doc: mappingDoc(run34.path, run34.sha256, ['discovery-join', 'git-consistency-signed-scope']),
        },
      ],
    });
    expect(Object.keys(derived.journeys).sort()).toEqual(['discovery-join', 'git-consistency-signed-scope']);
    expect(derived.unmapped).toEqual([]);
    // the mapping document itself is consumed, not reported as an unusable document
    expect(derived.ignored).toEqual([]);
    expect(derived.bindings.map((b) => [b.path, b.declaredBy, b.binding])).toEqual([
      ['docs/evidence/run34.json', 'docs/evidence/run34.p521-journeys.json', 'this-candidate'],
    ]);
    expect(derived.mappings).toEqual([
      {
        path: 'docs/evidence/run34.p521-journeys.json',
        evidencePath: run34.path,
        evidenceSha256: run34.sha256,
        journeys: ['discovery-join', 'git-consistency-signed-scope'],
        decision: 'p2p-public-release-endgame-2026-09-01#D-083',
        applied: true,
        reason: 'applied',
      },
    ]);
    const result = derived.journeys['discovery-join'];
    expect(result?.evidence.map((r) => [r.ref, r.kind])).toEqual([
      ['docs/evidence/run34.json', 'operational-test-evidence'],
      ['docs/evidence/run34.p521-journeys.json', 'p521-journey-mapping'],
    ]);
    const manifest = await buildP2pCandidateManifest({ candidate: c, journeys: derived.journeys });
    expect(manifest.current.rows.find((r) => r.capability === 'discovery-join')?.state).toBe('passed-on-this-artifact');
    // a mapping cannot count an unmapped journey: github-bridge stays unmeasured
    expect(manifest.current.rows.find((r) => r.capability === 'github-bridge')?.state).toBe('unmeasured');
  });

  it('a mapping pinned to different bytes does not apply: the evidence stays unmapped', () => {
    const derived = deriveJourneyEvidence({
      candidate: candidate(),
      evidence: [run34, { path: 'm.json', sha256: h('m'), doc: mappingDoc(run34.path, h('edited-bytes'), ['discovery-join']) }],
    });
    expect(derived.journeys).toEqual({});
    expect(derived.unmapped.map((u) => u.path)).toEqual([run34.path]);
    expect(derived.mappings[0]?.applied).toBe(false);
    expect(derived.mappings[0]?.reason).toContain(`pinned to evidence sha256 ${h('edited-bytes')}`);
  });

  it('two mappings for one evidence document are an unresolved call: neither applies', () => {
    const derived = deriveJourneyEvidence({
      candidate: candidate(),
      evidence: [
        run34,
        { path: 'm1.json', sha256: h('m1'), doc: mappingDoc(run34.path, run34.sha256, ['discovery-join']) },
        { path: 'm2.json', sha256: h('m2'), doc: mappingDoc(run34.path, run34.sha256, ['github-bridge']) },
      ],
    });
    expect(derived.journeys).toEqual({});
    expect(derived.unmapped.map((u) => u.path)).toEqual([run34.path]);
    expect(derived.mappings.map((m) => [m.path, m.applied])).toEqual([
      ['m1.json', false],
      ['m2.json', false],
    ]);
    expect(derived.mappings[0]?.reason).toContain('more than one mapping');
  });

  it('a mapping that contradicts an inline declaration fails closed; one that agrees is recorded', () => {
    const inline = { path: 'inline.json', sha256: h('inline'), doc: evidenceDoc({ p521Journey: 'discovery-join' }) };
    const conflict = deriveJourneyEvidence({
      candidate: candidate(),
      evidence: [inline, { path: 'm.json', sha256: h('m'), doc: mappingDoc(inline.path, inline.sha256, ['github-bridge']) }],
    });
    expect(conflict.journeys).toEqual({});
    expect(conflict.ignored[0]?.reason).toContain('journey declaration conflict');
    expect(conflict.mappings[0]?.applied).toBe(false);

    const agree = deriveJourneyEvidence({
      candidate: candidate(),
      evidence: [inline, { path: 'm.json', sha256: h('m'), doc: mappingDoc(inline.path, inline.sha256, ['discovery-join']) }],
    });
    expect(Object.keys(agree.journeys)).toEqual(['discovery-join']);
    expect(agree.bindings[0]?.declaredBy).toBe('inline');
    expect(agree.mappings[0]).toMatchObject({ applied: true, reason: 'agrees with the inline declaration' });
  });

  it('reports malformed, dangling and unknown-key mappings without counting anything', () => {
    const derived = deriveJourneyEvidence({
      candidate: candidate(),
      evidence: [
        run34,
        { path: 'bad-sha.json', sha256: h('b'), doc: mappingDoc('x.json', 'not-a-sha', ['discovery-join']) },
        { path: 'no-journeys.json', sha256: h('n'), doc: mappingDoc('y.json', h('y'), []) },
        { path: 'dangling.json', sha256: h('d'), doc: mappingDoc('docs/evidence/absent.json', h('absent'), ['discovery-join']) },
        { path: 'typo.json', sha256: h('t'), doc: mappingDoc(run34.path, run34.sha256, ['discovery']) },
      ],
    });
    expect(derived.journeys).toEqual({});
    const byPath = Object.fromEntries(derived.mappings.map((m) => [m.path, m]));
    expect(byPath['bad-sha.json']?.reason).toMatch(/^malformed mapping: evidence.sha256/);
    expect(byPath['no-journeys.json']?.reason).toContain('declares no p521Journeys');
    expect(byPath['dangling.json']?.reason).toBe('no evidence document at this path');
    expect(byPath['typo.json']).toMatchObject({ applied: false, reason: 'unknown P-521 journey key(s): discovery' });
    expect(derived.ignored).toEqual([{ path: run34.path, reason: 'unknown P-521 journey key(s): discovery (declared by typo.json)' }]);
    expect(derived.mappings.every((m) => !m.applied)).toBe(true);
  });
});

describe('computeCandidateManifestFromRecords (CLI core)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('computes provenance, corroborates a ledger-only artifact by re-hash, and binds evidence into the manifest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'p2p-cand-'));
    const linuxDir = join(dir, 'linux');
    const winDir = join(dir, 'win');
    const evDir = join(dir, 'evidence');
    for (const d of [linuxDir, join(linuxDir, 'deb'), winDir, evDir]) mkdirSync(d, { recursive: true });
    const debBytes = Buffer.from('server deb bytes');
    const zipBytes = Buffer.from('windows zip bytes');
    writeFileSync(join(linuxDir, 'deb', 'Server.deb'), debBytes);
    writeFileSync(join(winDir, 'Server.zip'), zipBytes);
    writeFileSync(join(linuxDir, 'build-provenance.json'), JSON.stringify(leg([['deb/Server.deb', sha256Bytes(debBytes)]])));
    writeFileSync(join(winDir, 'build-provenance.json'), JSON.stringify(leg([['Setup.exe', h('setup')]])));
    writeFileSync(
      join(evDir, 'f4.json'),
      JSON.stringify(evidenceDoc({ p521Journey: 'replicated-write-outage-replay', subject: { debSha256: sha256Bytes(debBytes), topology: { hosts: [{ id: 'tower' }, { id: 'mac-vm' }] } } })),
    );
    const hashed: string[] = [];
    const deps: ComputeDeps = {
      readLedger: async () => ({
        version: '0.0.25',
        channel: 'alpha',
        gitSha: SRC,
        artifacts: [
          { name: 'Server.deb', sha256: sha256Bytes(debBytes) },
          { name: 'Server.zip', sha256: sha256Bytes(zipBytes) },
        ],
      }),
      readBuildCommand: async () => RUN_CMD,
      hashFile: async (path) => {
        hashed.push(path);
        return sha256Bytes(zipBytes);
      },
    };
    const result = await computeCandidateManifestFromRecords(
      {
        version: '0.0.25',
        channel: 'alpha',
        legs: [
          { leg: 'linux', path: join(linuxDir, 'build-provenance.json') },
          { leg: 'windows', path: join(winDir, 'build-provenance.json') },
        ],
        evidenceDir: evDir,
        repoRoot: dir,
        rehash: 'ledger-only',
        now: Date.parse('2026-09-30T00:00:00Z'),
      },
      deps,
    );
    expect(hashed).toEqual([join(winDir, 'Server.zip')]);
    expect(result.provenance.provenance.checks.find((c) => c.id === 'ledger-corroboration')?.status).toBe('pass');
    expect(result.provenance.provenance.legs.map((l) => l.fileSha256)).toEqual([
      sha256Bytes(JSON.stringify(leg([['deb/Server.deb', sha256Bytes(debBytes)]]))),
      sha256Bytes(JSON.stringify(leg([['Setup.exe', h('setup')]]))),
    ]);
    expect(result.manifest.artifact.sha256).toBe(
      digestOracle([
        ['Server.deb', sha256Bytes(debBytes)],
        ['Setup.exe', h('setup')],
        ['Server.zip', sha256Bytes(zipBytes)],
      ]),
    );
    expect(result.evidence.bindings.map((b) => b.path)).toEqual(['evidence/f4.json']);
    const row = result.manifest.current.rows.find((r) => r.capability === 'replicated-write-outage-replay');
    expect(row?.state).toBe('passed-on-this-artifact');
  });

  it('redacts the home directory from evidence text', () => {
    const fakeHome = join(tmpdir(), 'fake-home-user');
    expect(redactHome(`${fakeHome}/x and ${fakeHome}/y`, fakeHome)).toBe('~/x and ~/y');
    expect(redactHome('/mnt/data/x', fakeHome)).toBe('/mnt/data/x');
  });
});

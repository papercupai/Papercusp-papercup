import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  P2pCandidateProvenance,
  P2pJourneyResult,
} from './p2p-candidate-manifest';
import { renderReadinessTable } from './current-readiness-manifest';

// The maintained mutation probe supplies a relocated copy; ordinary CI imports
// the production module. No mock or alternate evaluator is involved.
const { buildP2pCandidateManifest: buildManifest, candidateArtifactDigest } = await import(
  process.env.PROBE_P2P_CANDIDATE_MANIFEST ?? './p2p-candidate-manifest'
) as typeof import('./p2p-candidate-manifest');

// P-521's contract is the oracle. Importing the producer's population here would
// let a deleted journey or peer silently weaken both the subject and its test.
const REQUIRED_JOURNEYS = [
  'discovery-join',
  'git-consistency-signed-scope',
  'serving-identity-restart',
  'replicated-write-outage-replay',
  'delegated-seat-lifecycle',
  'protected-effect-fencing',
  'github-bridge',
  'full-installer-compat',
] as const;
const REQUIRED_PEERS = ['mac-vm', 'tower'] as const;

const NOW = Date.parse('2026-09-23T01:00:00.000Z');
const SHA = 'f22392a985e0bf1c3dc54365276b81a77bab84c1';
const hex = (c: string) => c.repeat(64);

const candidate: P2pCandidateProvenance = {
  version: '0.0.22',
  channel: 'alpha',
  sourceSha: SHA,
  artifacts: [
    { name: 'Papercusp_0.0.22_amd64.AppImage', sha256: hex('a') },
    { name: 'Papercusp_0.0.22_universal.dmg', sha256: hex('b') },
  ],
};

function passOn(digest: string, peers: readonly string[] = REQUIRED_PEERS): P2pJourneyResult {
  return {
    verdict: 'pass',
    reason: 'journey passed',
    measuredAt: '2026-09-23T00:59:00.000Z',
    evidence: [{ ref: 'run-1', kind: 'physical-drill' }],
    artifactDigest: digest,
    startedAt: '2026-09-23T00:58:00.000Z',
    precheckSubject: { artifactDigest: digest },
    observedPeers: peers,
  };
}

// These legacy peer/lineage fixtures satisfy the newly mandatory prerequisite;
// the unchanged independent P535 oracle exercises refusal of invalid prechecks.
function buildP2pCandidateManifest(options: Parameters<typeof buildManifest>[0]) {
  return buildManifest({
    ...options,
    localPrechecks: options.localPrechecks ?? REQUIRED_JOURNEYS.map((journey) => ({
      journey, check: 'p521-local-precheck:' + journey, verdict: 'pass',
      startedAt: '2026-09-23T00:56:00.000Z', finishedAt: '2026-09-23T00:57:00.000Z',
      subject: { artifactDigest: candidateArtifactDigest(options.candidate.artifacts) },
      command: ['local-fixture'], evidence: [{ ref: 'local-fixture', kind: 'local-precheck' }],
    })),
  });
}

describe('P-521 candidate manifest', () => {
  it('runs local admission as guarded ESM and refuses changed installer bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'p521-local-cli-'));
    try {
      const installer = join(root, 'candidate.deb');
      writeFileSync(installer, 'local installer fixture');
      const sha256 = createHash('sha256').update('local installer fixture').digest('hex');
      const artifacts = [{ name: 'candidate.deb', sha256 }];
      const subject = { artifactDigest: candidateArtifactDigest(artifacts), installerSha256: sha256 };
      const bundle = join(root, 'prechecks.json');
      writeFileSync(bundle, JSON.stringify({ candidate: { ...candidate, artifacts }, artifactDir: root,
        precheckSubject: subject, bytePaths: { installer }, localPrechecks: [{
          journey: 'delegated-seat-lifecycle', check: 'p521-local-precheck:delegated-seat-lifecycle',
          verdict: 'pass', startedAt: '2026-09-23T00:56:00.000Z', finishedAt: '2026-09-23T00:57:00.000Z',
          subject, command: ['local-fixture'], evidence: [{ ref: 'local-fixture' }],
        }] }));
      const run = () => spawnSync(process.execPath, [
        '--import', resolve('../../scripts/lib/committed-source-loader.mjs'),
        '--import', resolve('../../node_modules/tsx/dist/esm/index.mjs'),
        resolve('lib/release/run-p521-local-precheck.mts'),
        '--bundle', bundle, '--journey', 'delegated-seat-lifecycle',
      ], { encoding: 'utf8', timeout: 30_000 });
      const valid = run();
      expect(valid.error).toBeUndefined();
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      writeFileSync(installer, 'changed installer bytes');
      const changed = run();
      expect(changed.error).toBeUndefined();
      expect(changed.status, changed.stdout + changed.stderr).toBe(2);
      expect(changed.stderr).toContain('candidate artifact bytes mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('admits ISO offset receipts and evidence refs with an omitted optional kind', async () => {
    const digest = candidateArtifactDigest(candidate.artifacts);
    const manifest = await buildP2pCandidateManifest({
      candidate, now: NOW, journeys: { 'discovery-join': passOn(digest) },
      localPrechecks: [{
        journey: 'discovery-join', check: 'p521-local-precheck:discovery-join', verdict: 'pass',
        startedAt: '2026-09-23T00:56:00+00:00', finishedAt: '2026-09-23T00:57:00+00:00',
        subject: { artifactDigest: digest }, command: ['local-fixture'], evidence: [{ ref: 'local-fixture' }],
      }],
    });
    expect(manifest.current.rows.find((row) => row.capability === 'discovery-join')?.state)
      .toBe('passed-on-this-artifact');
  });

  it('derives an order-independent content digest that changes with any artifact byte', () => {
    const reversed = candidateArtifactDigest([...candidate.artifacts].reverse());
    expect(candidateArtifactDigest(candidate.artifacts)).toBe(reversed);
    expect(candidateArtifactDigest(candidate.artifacts)).toMatch(/^[0-9a-f]{64}$/);
    const changed = candidateArtifactDigest([candidate.artifacts[0], { ...candidate.artifacts[1], sha256: hex('c') }]);
    expect(changed).not.toBe(reversed);
  });

  it('refuses an empty, malformed, or duplicate artifact set', () => {
    expect(() => candidateArtifactDigest([])).toThrow(/empty/);
    expect(() => candidateArtifactDigest([{ name: 'x', sha256: 'nothex' }])).toThrow(/malformed/);
    expect(() => candidateArtifactDigest([{ name: 'dir/x', sha256: hex('a') }])).toThrow(/basename/);
    expect(() =>
      candidateArtifactDigest([
        { name: 'x', sha256: hex('a') },
        { name: 'x', sha256: hex('b') },
      ]),
    ).toThrow(/duplicate/);
  });

  it('a freshly cut candidate is NO-GO: every journey unmeasured and missing both peers', async () => {
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW });
    expect(manifest.artifact.sha256).toBe(candidateArtifactDigest(candidate.artifacts));
    expect(manifest.artifact.sourceRevision).toBe(SHA);
    expect(manifest.artifact.id).toBe('desktop-v0.0.22-alpha@f22392a985e0');
    expect(manifest.current.go).toBe(false);
    expect(manifest.profile.go).toBe(false);
    const byKey = new Map(manifest.current.rows.map((r) => [r.capability, r]));
    expect([...byKey.keys()]).toEqual(REQUIRED_JOURNEYS);
    for (const key of REQUIRED_JOURNEYS) {
      expect(byKey.get(key)?.state).toBe('unmeasured');
      expect(byKey.get(key)?.expectedPeers).toEqual(REQUIRED_PEERS);
      expect(byKey.get(key)?.missingPeers).toEqual(REQUIRED_PEERS);
    }
  });

  it('source-closed F-items are journey dependencies, never rows of their own (D-036/D-037)', async () => {
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW });
    expect(manifest.current.rows.map((r) => r.capability)).toEqual(REQUIRED_JOURNEYS);
    const deps = new Set(manifest.current.rows.flatMap((r) => r.dependencies));
    for (const item of ['P-512', 'P-513', 'P-514', 'P-515', 'P-516', 'P-517', 'P-518', 'P-520']) {
      expect(deps.has(item)).toBe(true);
    }
    expect(manifest.current.rows.filter((r) => r.state === 'passed-on-this-artifact')).toEqual([]);
  });

  it('a journey passes only on THIS artifact with every expected peer observed', async () => {
    const digest = candidateArtifactDigest(candidate.artifacts);
    const manifest = await buildP2pCandidateManifest({
      candidate,
      now: NOW,
      journeys: {
        'discovery-join': passOn(digest),
        'serving-identity-restart': passOn(digest, ['tower']),
        'github-bridge': passOn(hex('9')),
      },
    });
    const byKey = new Map(manifest.current.rows.map((r) => [r.capability, r]));
    expect(byKey.get('discovery-join')?.state).toBe('passed-on-this-artifact');
    expect(byKey.get('serving-identity-restart')?.state).toBe('advancing');
    expect(byKey.get('serving-identity-restart')?.missingPeers).toEqual(['mac-vm']);
    // evidence measured on a different artifact is refused, never counted
    expect(byKey.get('github-bridge')?.state).not.toBe('passed-on-this-artifact');
    expect(byKey.get('github-bridge')?.result).toBe('lineage-mismatch');
    expect(manifest.current.go).toBe(false);
  });

  it('GO only when all eight journeys pass on this artifact', async () => {
    const digest = candidateArtifactDigest(candidate.artifacts);
    const journeys = Object.fromEntries(REQUIRED_JOURNEYS.map((key) => [key, passOn(digest)]));
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW, journeys });
    expect(manifest.current.go).toBe(true);
    const failing = { ...journeys, 'full-installer-compat': { ...passOn(digest), verdict: 'fail' as const } };
    const refused = await buildP2pCandidateManifest({ candidate, now: NOW, journeys: failing });
    expect(refused.current.go).toBe(false);
    expect(refused.current.rows.find((r) => r.capability === 'full-installer-compat')?.state).toBe('failed-on-this-artifact');
  });

  it.each(REQUIRED_JOURNEYS)('keeps a partial profile NO-GO when %s is unmeasured', async (missing) => {
    const digest = candidateArtifactDigest(candidate.artifacts);
    const journeys = Object.fromEntries(
      REQUIRED_JOURNEYS.filter((key) => key !== missing).map((key) => [key, passOn(digest)]),
    );
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW, journeys });
    expect(manifest.current.go).toBe(false);
    expect(manifest.profile.go).toBe(false);
    expect(manifest.current.rows.find((r) => r.capability === missing)?.state).toBe('unmeasured');
  });

  it.each(REQUIRED_PEERS)('keeps otherwise passing journeys NO-GO when %s is absent', async (missing) => {
    const digest = candidateArtifactDigest(candidate.artifacts);
    const peers = REQUIRED_PEERS.filter((peer) => peer !== missing);
    const journeys = Object.fromEntries(REQUIRED_JOURNEYS.map((key) => [key, passOn(digest, peers)]));
    const manifest = await buildP2pCandidateManifest({ candidate, now: NOW, journeys });
    expect(manifest.profile.go).toBe(true);
    expect(manifest.current.go).toBe(false);
    expect(manifest.current.rows).toHaveLength(REQUIRED_JOURNEYS.length);
    for (const row of manifest.current.rows) {
      expect(row.state).toBe('advancing');
      expect(row.missingPeers).toEqual([missing]);
    }
  });

  it('refuses an unknown journey key and a malformed source sha', async () => {
    await expect(
      buildP2pCandidateManifest({ candidate, now: NOW, journeys: { 'not-a-journey': passOn(hex('a')) } }),
    ).rejects.toThrow(/unknown P-521 journey/);
    await expect(buildP2pCandidateManifest({ candidate: { ...candidate, sourceSha: 'abc' }, now: NOW })).rejects.toThrow(
      /40-char/,
    );
  });

  it('renders a readiness table naming every journey', async () => {
    const table = renderReadinessTable(await buildP2pCandidateManifest({ candidate, now: NOW }));
    for (const key of REQUIRED_JOURNEYS) expect(table).toContain(key);
  });
});

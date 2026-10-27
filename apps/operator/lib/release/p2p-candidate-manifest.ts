/**
 * P-521 candidate manifest — plan p2p-public-release-endgame-2026-09-01, D-038
 * (WI-10002524).
 *
 * Binds the ONE packaged release candidate (exact source sha + exact artifact bytes)
 * to the P-519 computed readiness manifest (`current-readiness-manifest.ts`):
 *
 *   - the eight physical two-machine journeys P-521 names are MANDATORY rows. A journey
 *     reads `passed-on-this-artifact` only when its evidence was measured against THIS
 *     candidate's content digest and saw every expected peer. Evidence from any other
 *     artifact is refused as `lineage-mismatch` (twice: by the profile evaluator via
 *     `expectedLineage`, and by the manifest adapter's artifact-lineage check).
 *   - the F1–F8 + v1-scope items (P-512..P-520) closed on source/test evidence and handed
 *     their packaged proof to these journeys (D-036, D-037). They are therefore journey
 *     DEPENDENCIES, never rows: a manifest row is GO only when it passed on this artifact,
 *     so component tests alone cannot advance the verdict (P-521: "do not advance the
 *     global release verdict from component tests alone").
 *
 * The candidate's artifact identity is a content digest over the sorted
 * `<sha256>  <basename>` lines of its artifact set, so the identity is independent of
 * listing order and changes when any byte of any artifact changes.
 */
import { P521_JOURNEYS, candidateArtifactDigest, validateP521LocalPrechecks } from './p521-local-precheck.mts';
export { P521_JOURNEYS, candidateArtifactDigest, p521PrecheckSubjectsMatch, validateP521LocalPrechecks } from './p521-local-precheck.mts';
import {
  evaluateReleaseProfile,
  type ComponentRawVerdict,
  type ComponentSpec,
  type EvidenceRef,
} from '@papercusp/release-profile';
import {
  buildCurrentReadinessManifest,
  type CurrentReadinessManifest,
  type ReadinessCapabilityInput,
  type ReadinessHistoryEntry,
} from './current-readiness-manifest';

export const P2P_CANDIDATE_PROFILE_REF = 'p2p-public-release-p521-candidate';

/** The two physical machines every P-521 journey must observe. */
export const P2P_EXPECTED_PEERS = ['mac-vm', 'tower'] as const;

export interface P2pCandidateArtifact {
  /** Artifact basename (e.g. `Papercusp_0.0.22_amd64.AppImage`). */
  name: string;
  /** Lower-case hex sha256 of the artifact bytes. */
  sha256: string;
}

export interface P2pCandidateProvenance {
  version: string;
  channel: string;
  /** Exact 40-char superproject commit the candidate was cut from. */
  sourceSha: string;
  artifacts: readonly P2pCandidateArtifact[];
}

/** One physical journey's measured outcome on a specific artifact. */
export interface P2pJourneyResult {
  verdict: ComponentRawVerdict;
  reason: string;
  measuredAt: string;
  evidence: EvidenceRef[];
  /** `candidateArtifactDigest` of the artifact the journey actually ran on. */
  artifactDigest: string;
  observedPeers: readonly string[];
  /** Physical start, distinct from the observation/finish time. */
  startedAt?: string;
  precheckSubject?: P521PrecheckSubject;
}

export interface P521PrecheckSubject {
  artifactDigest: string;
  installerSha256?: string;
  runtimeSha256?: string;
  seedSha256?: string;
}

export interface P521LocalPrecheck {
  journey: string;
  check: string;
  verdict: string;
  startedAt: string;
  finishedAt: string;
  subject: P521PrecheckSubject;
  command: string[];
  evidence: EvidenceRef[];
  exitCode?: number;
  skipped?: boolean | number;
}

const GIT_SHA = /^[0-9a-f]{40}$/;

export interface BuildP2pCandidateManifestOptions {
  candidate: P2pCandidateProvenance;
  /** Journey results keyed by `P521_JOURNEYS[].key`; an absent key is unmeasured. */
  journeys?: Readonly<Record<string, P2pJourneyResult>>;
  localPrechecks?: readonly P521LocalPrecheck[];
  now?: number;
  history?: readonly ReadinessHistoryEntry[];
}

export async function buildP2pCandidateManifest(
  options: BuildP2pCandidateManifestOptions,
): Promise<CurrentReadinessManifest> {
  const { candidate } = options;
  if (!GIT_SHA.test(candidate.sourceSha)) throw new Error('candidate sourceSha must be a 40-char git sha');
  const known = new Set(P521_JOURNEYS.map((j) => j.key));
  for (const key of Object.keys(options.journeys ?? {})) {
    if (!known.has(key)) throw new Error(`unknown P-521 journey '${key}'`);
  }
  const nowMs = options.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const digest = candidateArtifactDigest(candidate.artifacts);

  const journeyComponents: ComponentSpec[] = P521_JOURNEYS.map((journey) => ({
    key: journey.key,
    title: journey.title,
    mandatory: true,
    check: async () => {
      const result = options.journeys?.[journey.key];
      if (!result) {
        return { verdict: 'unknown', reason: 'not yet run on this artifact', measuredAt: nowIso, evidence: [] };
      }
      const precheck = validateP521LocalPrechecks(
        options.localPrechecks, result.precheckSubject, result.startedAt, [journey.key],
      );
      const subjectMatches = result.precheckSubject?.artifactDigest === digest
        && result.artifactDigest === digest;
      return {
        verdict: precheck.ok && subjectMatches ? result.verdict : 'fail',
        reason: precheck.ok && subjectMatches ? result.reason
          : 'local precheck refused: ' + [...precheck.errors, ...(subjectMatches ? [] : ['candidate subject mismatch'])].join('; '),
        measuredAt: result.measuredAt,
        evidence: result.evidence,
        lineage: { sha: result.artifactDigest },
      };
    },
  }));

  const profile = await evaluateReleaseProfile(
    {
      profileRef: P2P_CANDIDATE_PROFILE_REF,
      expectedLineage: { sha: digest },
      components: journeyComponents,
    },
    { now: nowMs },
  );

  const capabilities: ReadinessCapabilityInput[] = P521_JOURNEYS.map((journey) => {
    const result = options.journeys?.[journey.key];
    return {
      key: journey.key,
      scenario: journey.title,
      expectedPeers: P2P_EXPECTED_PEERS,
      observedPeers: result?.observedPeers ?? [],
      owner: 'P-521',
      dependencies: journey.dependencies,
      executionState: result ? 'executed' : 'unmeasured',
    };
  });

  return buildCurrentReadinessManifest({
    profile,
    artifact: {
      id: `desktop-v${candidate.version}-${candidate.channel}@${candidate.sourceSha.slice(0, 12)}`,
      sha256: digest,
      sourceRevision: candidate.sourceSha,
    },
    capabilities,
    now: nowMs,
    history: options.history,
  });
}

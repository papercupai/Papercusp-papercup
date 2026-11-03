/**
 * release-profile.test.ts — the papercusp wiring over the generic composite evaluator
 * (rubric-system-and-auto-loop-release-profile-2026-07-15 P-006). Every dependency is
 * INJECTED (deps.* — matches this package's existing gate-test convention, e.g.
 * perf-gate.test.ts's PerfGateIO), so these run hermetically with no PG / git / DB.
 *
 * Terminal proof required by the plan item: the composite REFUSES GO on a real
 * fail / stale / lineage-mismatch case, wired through the actual adapter (not just the
 * generic lib's fabricated-component tests in libs/generic/release-profile).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildPapercuspReleaseProfile,
  buildAutoloopReleaseProfile,
  evaluateAutoloopReleaseProfile,
  classifyRatingForGate,
  deployStalenessGateComponent,
  evaluatePapercuspReleaseProfile,
  rubricReleaseComponent,
  worstCaseVerdict,
  DEFAULT_RUBRIC_STALE_AFTER_MS,
  AUTOLOOP_COMPONENT_RUBRIC_REFS,
  AUTOLOOP_RELEASE_PROFILE_REF,
  WINDOWS_SMOKE_FRESHNESS_MAX_AGE_MS,
  WINDOWS_SMOKE_SUCCESS_MARKER_FILENAME,
  windowsSmokeFreshnessComponent,
} from './release-profile';
import { evaluateReleaseProfile } from '@papercusp/release-profile';
import type { Rubric } from '@papercusp/operator-core/lib/rubrics';
import type { ScorecardRow } from '@papercusp/operator-core/lib/scorecards';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');

function rubric(overrides: Partial<Rubric> = {}): Rubric {
  return {
    rubricId: 'test-rubric',
    workspaceId: 'ws',
    kind: 'standard',
    characteristic: 'test',
    title: 'Test rubric',
    description: '',
    criteria: [
      // Explicitly manual criteria keep this generic fixture valid under the strict
      // release-gating instrument contract; instrument-backed behavior is covered below.
      { key: 'c1', title: 'C1', model: 'm', method: 'me', driftMarkers: 'd', instrumentKey: 'none' },
      { key: 'c2', title: 'C2', model: 'm', method: 'me', driftMarkers: 'd', instrumentKey: 'none' },
    ],
    ratingScale: ['pass', 'fail', 'unknown'],
    methodRef: null,
    releaseGating: true,
    status: 'active',
    createdBy: 'owner',
    proposedBy: 'owner',
    ratifiedBy: 'reviewer',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function scorecardRow(overrides: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'EI-1',
    createdAt: new Date(NOW).toISOString(),
    createdBy: 'agent-1',
    rubricRef: 'test-rubric',
    ratings: { c1: { rating: 'pass', evidence: 'e1' }, c2: { rating: 'pass', evidence: 'e2' } },
    nKeys: 2,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: 10,
    linkedItems: [],
    gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: new Date(NOW).toISOString(),
      auditIssueId: 'EI-independent-audit', auditor: 'agent-independent', auditedAt: new Date(NOW).toISOString(),
      rubricRevision: 1, criteriaHash: 'audit-v1' },
    gradingAuditCurrentness: { state: 'current', reason: 'current', recordedRevision: 1, currentRevision: 1,
      recordedCriteriaHash: 'audit-v1', currentCriteriaHash: 'audit-v1' },
    ...overrides,
  };
}

describe('classifyRatingForGate / worstCaseVerdict — the pass-bar', () => {
  it('classifies common pass/fail/unknown vocabularies', () => {
    expect(classifyRatingForGate('pass')).toBe('pass');
    expect(classifyRatingForGate('HEALTHY')).toBe('pass');
    expect(classifyRatingForGate('unknown')).toBe('unknown');
    expect(classifyRatingForGate('fail')).toBe('fail');
    expect(classifyRatingForGate('broken')).toBe('fail');
  });
  it('treats partial/degraded as FAIL for gating — a gate does not average away a mid rating', () => {
    expect(classifyRatingForGate('partial')).toBe('fail');
    expect(classifyRatingForGate('degraded')).toBe('fail');
  });
  it('worstCaseVerdict picks the single worst criterion, not a majority vote', () => {
    const { verdict, worstKey, worstRating } = worstCaseVerdict({
      a: { rating: 'pass' },
      b: { rating: 'pass' },
      c: { rating: 'broken' },
    });
    expect(verdict).toBe('fail');
    expect(worstKey).toBe('c');
    expect(worstRating).toBe('broken');
  });
  it('all-pass ratings verdict pass', () => {
    expect(worstCaseVerdict({ a: { rating: 'pass' }, b: { rating: 'healthy' } }).verdict).toBe('pass');
  });
});

describe('rubricReleaseComponent — real adapter, injected deps', () => {
  it('unknown when the rubric does not resolve', async () => {
    const comp = rubricReleaseComponent('missing-rubric', { deps: { getRubric: async () => null } });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/not found/);
  });

  it('unknown when the rubric is not ratified (proposed, not active)', async () => {
    const comp = rubricReleaseComponent('draft-rubric', {
      deps: { getRubric: async () => rubric({ status: 'proposed' }) },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/not ratified/);
  });

  it('unknown when there is no scorecard on record', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: { getRubric: async () => rubric(), listScorecards: async () => [] },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/no scorecard/);
  });

  it('unknown when the latest scorecard is INCOMPLETE', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => rubric(),
        listScorecards: async () => [scorecardRow({ missingKeys: ['c2'] })],
      },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/INCOMPLETE/);
  });

  it('pass when the latest complete scorecard rates every criterion pass', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: { getRubric: async () => rubric(), listScorecards: async () => [scorecardRow()] },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('pass');
    expect(result.evidence[0]).toEqual({ ref: 'EI-1', kind: 'scorecard', detail: { sourceHive: null } });
  });

  it.each(['diagnostic', 'provisional', 'pending-audit', 'failed-audit', 'missing-audit', 'stale-audit', 'unknown-audit'])(
    'cannot authorize release with a %s receipt', async scenario => {
      const row = scorecardRow();
      if (scenario === 'diagnostic') row.purpose = 'diagnostic';
      if (scenario === 'provisional') row.provisional = { stampedAt: row.createdAt, violatableKeys: ['c1'] };
      if (scenario === 'pending-audit') row.gradingAudit!.state = 'pending';
      if (scenario === 'failed-audit') row.gradingAudit!.state = 'failed';
      if (scenario === 'missing-audit') delete row.gradingAudit;
      if (scenario === 'stale-audit') row.gradingAuditCurrentness!.state = 'stale';
      if (scenario === 'unknown-audit') delete row.gradingAuditCurrentness;
      const list = vi.fn(async () => [row]);
      const result = await rubricReleaseComponent('test-rubric', {
        deps: { getRubric: async () => rubric(), listScorecards: list },
      }).check();
      expect(result.verdict).toBe('unknown');
      expect(result.reason).toContain('not settled');
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ finalizedOnly: true, comparableOnly: true, limit: 1 }));
    });

  it('unknown when a persisted release-gating scorecard is missing its instrument snapshot', async () => {
    const nowMs = Date.parse('2026-07-16T12:00:00.000Z');
    const instrumentedRubric = rubric({
      criteria: [
        {
          key: 'c1',
          title: 'C1',
          model: 'm',
          method: 'me',
          driftMarkers: 'd',
          instrumentKey: 'metrics.c1',
          window: { kind: 'rolling', ms: 60 * 60_000 },
        },
        { key: 'c2', title: 'C2', model: 'm', method: 'me', driftMarkers: 'd', instrumentKey: 'none' },
      ],
    });
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => instrumentedRubric,
        listScorecards: async () => [scorecardRow({ instrumentSnapshots: {} })],
        nowMs: () => nowMs,
      },
    });

    const result = await comp.check();

    expect(result.verdict).toBe('unknown');
    expect(result.reason).toContain('invalid instrument contract');
    expect(result.reason).toContain('missing snapshots: metrics.c1');
  });

  it('passes an instrument-backed scorecard only when its snapshot is fresh and verdict-consistent', async () => {
    const nowMs = Date.parse('2026-07-16T12:00:00.000Z');
    const instrumentedRubric = rubric({
      criteria: [
        {
          key: 'c1',
          title: 'C1',
          model: 'm',
          method: 'me',
          driftMarkers: 'd',
          instrumentKey: 'metrics.c1',
          window: { kind: 'rolling', ms: 60 * 60_000 },
        },
        { key: 'c2', title: 'C2', model: 'm', method: 'me', driftMarkers: 'd', instrumentKey: 'none' },
      ],
    });
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => instrumentedRubric,
        listScorecards: async () => [
          scorecardRow({
            instrumentSnapshots: {
              'metrics.c1': {
                verdict: 'pass',
                measuredAt: '2026-07-16T11:30:00.000Z',
              },
            },
          }),
        ],
        nowMs: () => nowMs,
      },
    });

    const result = await comp.check();

    expect(result.verdict).toBe('pass');
  });

  it('fail when any criterion is rated broken/fail', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => rubric(),
        listScorecards: async () => [
          scorecardRow({ ratings: { c1: { rating: 'pass', evidence: 'e' }, c2: { rating: 'broken', evidence: 'e' } } }),
        ],
      },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('fail');
    expect(result.reason).toMatch(/c2' rated 'broken'/);
  });

  it('carries gradedGeneration through as lineage — BOTH the sha and the generation boundary', async () => {
    const comp = rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => rubric(),
        listScorecards: async () => [scorecardRow({ gradedGeneration: { deployedSha: 'shaX', hostStartedAt: null } })],
      },
    });
    const result = await comp.check();
    // WI-5277: `generation` was previously DROPPED here, which is what made a restart that
    // did not move the sha invisible to a profile's expectedLineage check.
    expect(result.lineage).toEqual({ sha: 'shaX', generation: null });
  });
});

/**
 * WI-5277 — dead evidence must never authorize GO.
 *
 * The 2026-07-17 incident: a 4.5h soak and a 6/6 scorecard were voided by a bg-host
 * restart three minutes after they were emitted, and NOTHING downstream could tell. The
 * stamp (`gradedGeneration.hostStartedAt`) had been persisted since EI-12147, but no read
 * path ever compared it against the live boundary — so the only thing preventing a GO
 * being assembled from dead evidence was a hand-written, expiring fact.
 *
 * These drive the REAL adapter (`rubricReleaseComponent().check()`) with injected deps,
 * not the pure comparator — the comparator already had unit coverage while the wiring
 * that matters did not exist, which is exactly the failure mode being guarded against.
 */
describe('WI-5277 — a scorecard graded against a DEAD generation cannot authorize GO', () => {
  /** EI-14957's real numbers: the restart moved the boundary but NOT the sha. */
  const SHARED_SHA = '7beca0c677';
  const GRADED_BOUNDARY = '2026-07-17T14:39:17.000Z';
  const LIVE_BOUNDARY_AFTER_RESTART = '2026-07-17T17:25:32.000Z';

  function component(opts: {
    gradedHostStartedAt: string | null;
    liveBoundaryMs: number | null;
    ratings?: ScorecardRow['ratings'];
  }) {
    return rubricReleaseComponent('test-rubric', {
      deps: {
        getRubric: async () => rubric(),
        listScorecards: async () => [
          scorecardRow({
            gradedGeneration: { deployedSha: SHARED_SHA, hostStartedAt: opts.gradedHostStartedAt },
            ...(opts.ratings ? { ratings: opts.ratings } : {}),
          }),
        ],
        readBgHostActiveEnterMs: async () => opts.liveBoundaryMs,
      },
    });
  }

  it('PRECONDITION — the very same all-pass fixture verdicts PASS while its generation is still live', async () => {
    // Without this, every assertion below is satisfiable by a fixture that was never
    // capable of passing in the first place, and the guard would prove nothing.
    const result = await component({
      gradedHostStartedAt: GRADED_BOUNDARY,
      liveBoundaryMs: Date.parse(GRADED_BOUNDARY),
    }).check();
    expect(result.verdict).toBe('pass');
  });

  it('downgrades a 6/6 PASS to unknown once bg-host has restarted past the graded generation', async () => {
    const result = await component({
      gradedHostStartedAt: GRADED_BOUNDARY,
      liveBoundaryMs: Date.parse(LIVE_BOUNDARY_AFTER_RESTART),
    }).check();
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toMatch(/no longer exists/);
    expect(result.reason).toContain(LIVE_BOUNDARY_AFTER_RESTART);
  });

  it('CONTROL — the pre-fix signal (lineage.sha) is IDENTICAL across that restart, so only the boundary check can catch it', async () => {
    // The pre-WI-5277 code compared shas and nothing else. In EI-14957 the sha did not
    // move, so sha equality was — and still is — satisfied by the dead generation. This
    // pins that the 'unknown' above cannot have come from a sha mismatch: the component
    // reports the SAME sha it always did, and still refuses. Delete the staleness branch
    // and this test reds, because the verdict reverts to 'pass'.
    const result = await component({
      gradedHostStartedAt: GRADED_BOUNDARY,
      liveBoundaryMs: Date.parse(LIVE_BOUNDARY_AFTER_RESTART),
    }).check();
    expect(result.lineage).toEqual({ sha: SHARED_SHA, generation: GRADED_BOUNDARY });
    expect(result.verdict).toBe('unknown');
  });

  it('CALIBRATION — a genuine FAIL is still reported as fail, not masked by the freshness path', async () => {
    const result = await component({
      gradedHostStartedAt: GRADED_BOUNDARY,
      liveBoundaryMs: Date.parse(GRADED_BOUNDARY),
      ratings: { c1: { rating: 'pass', evidence: 'e' }, c2: { rating: 'broken', evidence: 'e' } },
    }).check();
    expect(result.verdict).toBe('fail');
  });

  it('BLAST RADIUS — an UNREADABLE live boundary does NOT block GO; only a PROVEN restart does', async () => {
    // Deliberate, and the conservative half of the design: readBgHostActiveEnterMs returns
    // null whenever bg-host is not under systemd --user (CI, a dev box, a bundled build).
    // Downgrading on "cannot tell" would turn this into a gate that blocks every release
    // off-box. Only a POSITIVE stale determination blocks; an unresolvable boundary leaves
    // the pre-existing verdict untouched and is surfaced as `unknown` freshness for a
    // reader instead.
    const result = await component({
      gradedHostStartedAt: GRADED_BOUNDARY,
      liveBoundaryMs: null,
    }).check();
    expect(result.verdict).toBe('pass');
  });

  it('a pre-stamp scorecard (no generation boundary at all) is likewise not blocked', async () => {
    const result = await component({
      gradedHostStartedAt: null,
      liveBoundaryMs: Date.parse(LIVE_BOUNDARY_AFTER_RESTART),
    }).check();
    expect(result.verdict).toBe('pass');
  });
});

describe('deployStalenessGateComponent — real adapter, injected git-ops', () => {
  it('unknown when the deployed sha cannot be resolved', async () => {
    const comp = deployStalenessGateComponent({ deps: { deployedSha: async () => null } });
    const result = await comp.check();
    expect(result.verdict).toBe('unknown');
  });

  it('pass when the pin is fresh and close to tip', async () => {
    const comp = deployStalenessGateComponent({
      deps: {
        deployedSha: async () => 'deployed-sha',
        currentSha: async () => 'candidate-sha',
        commitUnixTime: async () => Math.floor(Date.now() / 1000) - 60, // 1 min old
        commitsBetween: async () => ['c1', 'c2'],
      },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('pass');
    expect(result.lineage).toEqual({ sha: 'deployed-sha' });
  });

  it('fails when the pin is stale (old + far behind tip)', async () => {
    const comp = deployStalenessGateComponent({
      deps: {
        deployedSha: async () => 'deployed-sha',
        currentSha: async () => 'candidate-sha',
        commitUnixTime: async () => Math.floor(Date.now() / 1000) - 20 * 3_600, // 20h old
        commitsBetween: async () => Array.from({ length: 50 }, (_, i) => `c${i}`),
      },
      thresholds: { maxPinAgeMs: 6 * 3_600_000, maxCommitsBehind: 20 },
    });
    const result = await comp.check();
    expect(result.verdict).toBe('fail');
    expect(result.reason).toMatch(/deploy stale/);
  });
});

describe('buildPapercuspReleaseProfile / evaluatePapercuspReleaseProfile — end to end', () => {
  const healthyDeps = {
    listRubrics: async () => [rubric()],
    readRunningGeneration: async () => ({
      deployedSha: 'gen-sha-1',
      hostStartedAt: null,
      bootHeadSha: null,
      scoutCodeHash: null,
      staleHost: true,
    }),
  };
  const healthyGateOpts = {
    deps: {
      deployedSha: async () => 'gen-sha-1',
      currentSha: async () => 'gen-sha-1',
      commitUnixTime: async () => Math.floor(Date.now() / 1000) - 60,
      commitsBetween: async () => [],
    },
  };

  it('GOes when the rubric passes and the deploy gate is fresh', async () => {
    const spec = await buildPapercuspReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      rubricOpts: { deps: { listScorecards: async () => [scorecardRow({ gradedGeneration: { deployedSha: 'gen-sha-1', hostStartedAt: null } })] } },
    });
    const verdict = await evaluateReleaseProfile(spec, { now: NOW });
    expect(verdict.go).toBe(true);
    expect(verdict.components).toHaveLength(2); // 1 rubric + 1 gate
  });

  it('REFUSES GO on a real FAIL case — a mandatory rubric criterion rated broken', async () => {
    const verdict = await evaluatePapercuspReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: {
        deps: {
          listScorecards: async () => [
            scorecardRow({
              ratings: { c1: { rating: 'pass', evidence: 'e' }, c2: { rating: 'broken', evidence: 'e' } },
              gradedGeneration: { deployedSha: 'gen-sha-1', hostStartedAt: null },
            }),
          ],
        },
      },
    });
    expect(verdict.go).toBe(false);
    expect(verdict.reason).toMatch(/rubric:test-rubric/);
    expect(verdict.components.find((c) => c.key === 'rubric:test-rubric')?.verdict).toBe('fail');
  });

  it('REFUSES GO on a real STALE case — the scorecard predates the freshness window', async () => {
    const staleMeasuredAt = new Date(NOW - 7 * 60 * 60_000).toISOString(); // 7h old vs 6h default window
    const verdict = await evaluateReleaseProfile(
      await buildPapercuspReleaseProfile({
        deps: healthyDeps,
        gateOpts: healthyGateOpts,
        rubricOpts: {
          maxAgeMs: DEFAULT_RUBRIC_STALE_AFTER_MS,
          deps: {
            listScorecards: async () => [
              scorecardRow({ createdAt: staleMeasuredAt, gradedGeneration: { deployedSha: 'gen-sha-1', hostStartedAt: null } }),
            ],
          },
        },
      }),
      { now: NOW },
    );
    expect(verdict.go).toBe(false);
    const rubricComp = verdict.components.find((c) => c.key === 'rubric:test-rubric');
    expect(rubricComp?.verdict).toBe('stale');
  });

  it('REFUSES GO on a real LINEAGE-MISMATCH case — the scorecard graded a different generation', async () => {
    const verdict = await evaluatePapercuspReleaseProfile({
      deps: healthyDeps, // running generation is 'gen-sha-1'
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: {
        deps: {
          // this scorecard graded an OLDER generation than what's running now
          listScorecards: async () => [
            scorecardRow({ gradedGeneration: { deployedSha: 'gen-sha-0-OLD', hostStartedAt: null } }),
          ],
        },
      },
    });
    expect(verdict.go).toBe(false);
    const rubricComp = verdict.components.find((c) => c.key === 'rubric:test-rubric');
    expect(rubricComp?.verdict).toBe('lineage-mismatch');
    expect(rubricComp?.reason).toMatch(/disagrees with the expected candidate on: sha/);
  });

  it('REFUSES GO on the deploy-staleness hard gate alone, even with a healthy rubric', async () => {
    const verdict = await evaluatePapercuspReleaseProfile({
      deps: healthyDeps,
      evaluateOpts: { now: NOW },
      rubricOpts: {
        deps: { listScorecards: async () => [scorecardRow({ gradedGeneration: { deployedSha: 'gen-sha-1', hostStartedAt: null } })] },
      },
      gateOpts: {
        // deployedSha matches the running generation ('gen-sha-1') so this case isolates
        // the STALENESS gate — not a lineage mismatch, which is covered by its own test above.
        deps: {
          deployedSha: async () => 'gen-sha-1',
          currentSha: async () => 'candidate-sha',
          commitUnixTime: async () => Math.floor(Date.now() / 1000) - 20 * 3_600,
          commitsBetween: async () => Array.from({ length: 50 }, (_, i) => `c${i}`),
        },
        thresholds: { maxPinAgeMs: 6 * 3_600_000, maxCommitsBehind: 20 },
      },
    });
    expect(verdict.go).toBe(false);
    expect(verdict.components.find((c) => c.key === 'gate:deploy-staleness')?.verdict).toBe('fail');
  });
});

describe('buildAutoloopReleaseProfile / evaluateAutoloopReleaseProfile — the P-008 scoped auto-loop profile', () => {
  const healthyGateOpts = {
    deps: {
      deployedSha: async () => 'gen-sha-1',
      currentSha: async () => 'gen-sha-1',
      commitUnixTime: async () => Math.floor(Date.now() / 1000) - 60,
      commitsBetween: async () => [],
    },
  };
  const healthyDeps = {
    readRunningGeneration: async () => ({
      deployedSha: 'gen-sha-1',
      hostStartedAt: null,
      bootHeadSha: null,
      scoutCodeHash: null,
      staleHost: true,
    }),
    getRubric: async (ref: string) => rubric({ rubricId: ref }),
  };
  const healthyScorecard = scorecardRow({ gradedGeneration: { deployedSha: 'gen-sha-1', hostStartedAt: null } });
  const healthyWindowsSmokeOpts = {
    markerPath: `/tmp/${WINDOWS_SMOKE_SUCCESS_MARKER_FILENAME}`,
    deps: {
      readMarker: async () => JSON.stringify({
        schemaVersion: 'papercusp-windows-smoke-success/v1',
        result: 'pass',
        platform: 'windows',
        tag: 'desktop-v1.2.3',
        version: '1.2.3',
        buildSha: 'build-sha',
        verifiedAtUtc: new Date(NOW).toISOString(),
      }),
      nowMs: () => NOW,
    },
  };

  it('composes the fixed rubric set and both operational gates — never auto-discovery', async () => {
    const spec = await buildAutoloopReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      rubricOpts: { deps: { listScorecards: async () => [healthyScorecard] } },
    });
    expect(spec.profileRef).toBe(AUTOLOOP_RELEASE_PROFILE_REF);
    expect(spec.components).toHaveLength(AUTOLOOP_COMPONENT_RUBRIC_REFS.length + 2); // 4 rubrics + 2 gates
    expect(AUTOLOOP_COMPONENT_RUBRIC_REFS).toEqual([
      'blender-release-readiness',
      'autonomy-owner-controls',
      'release-integrity-health',
      'production-soak-health',
    ]);
    const keys = spec.components.map((c) => c.key);
    for (const ref of AUTOLOOP_COMPONENT_RUBRIC_REFS) expect(keys).toContain(`rubric:${ref}`);
    expect(keys).toContain('gate:deploy-staleness');
    expect(keys).toContain('gate:windows-smoke-freshness');
    expect(spec.components.find((component) => component.key === 'gate:windows-smoke-freshness')).toMatchObject({
      mandatory: true,
      maxAgeMs: 7 * 24 * 60 * 60_000,
    });
  });

  it('passes only with a well-formed recent Windows smoke success watermark', async () => {
    const marker = {
      schemaVersion: 'papercusp-windows-smoke-success/v1',
      result: 'pass',
      platform: 'windows',
      tag: 'desktop-v1.2.3',
      version: '1.2.3',
      buildSha: 'build-sha',
      verifiedAtUtc: new Date(NOW - WINDOWS_SMOKE_FRESHNESS_MAX_AGE_MS + 1).toISOString(),
    };
    const component = windowsSmokeFreshnessComponent({
      markerPath: `/tmp/${WINDOWS_SMOKE_SUCCESS_MARKER_FILENAME}`,
      deps: { readMarker: async () => JSON.stringify(marker), nowMs: () => NOW },
    });

    await expect(component.check()).resolves.toMatchObject({ verdict: 'pass', measuredAt: marker.verifiedAtUtc });
  });

  it('refuses GO when no successful Windows smoke watermark exists', async () => {
    const verdict = await evaluateAutoloopReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: { deps: { listScorecards: async () => [healthyScorecard] } },
      windowsSmokeOpts: { deps: { readMarker: async () => null, nowMs: () => NOW } },
    });

    expect(verdict.go).toBe(false);
    expect(verdict.components.find((component) => component.key === 'gate:windows-smoke-freshness')?.verdict).toBe('unknown');
  });

  it('REFUSES GO when the latest successful Windows smoke is older than seven days', async () => {
    const marker = {
      schemaVersion: 'papercusp-windows-smoke-success/v1',
      result: 'pass',
      platform: 'windows',
      tag: 'desktop-v1.2.3',
      version: '1.2.3',
      buildSha: 'build-sha',
      verifiedAtUtc: new Date(NOW - WINDOWS_SMOKE_FRESHNESS_MAX_AGE_MS - 1).toISOString(),
    };
    const verdict = await evaluateAutoloopReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: { deps: { listScorecards: async () => [healthyScorecard] } },
      windowsSmokeOpts: { deps: { readMarker: async () => JSON.stringify(marker), nowMs: () => NOW } },
    });

    expect(verdict.go).toBe(false);
    expect(verdict.components.find((component) => component.key === 'gate:windows-smoke-freshness')?.verdict).toBe('stale');
  });

  /**
   * WI-5379 — a MANDATORY component that cannot be graded is a permanently-red gate, not a
   * strict one. The Mug/Cup/Kettle tier was retired 2026-08-09 (its feature flag DELETED,
   * cup:/kettle: tools now REFUSE), but its three component rubrics stayed `active` and
   * mandatory here, each with ZERO complete scorecards ever recorded. This pins the removal
   * so a future edit cannot silently re-admit a leg that grades a subsystem that no longer
   * runs — the failure mode is invisible, because an ungradeable leg looks exactly like a
   * leg that is merely awaiting its first scorecard.
   */
  it('does not gate the release on the RETIRED Mug/Cup/Kettle tier', async () => {
    const retiredTierRubrics = [
      'mug-pot-coordination-health',
      'cup-lifecycle-durability',
      'kettle-supervision-health',
    ];
    for (const ref of retiredTierRubrics) {
      expect(AUTOLOOP_COMPONENT_RUBRIC_REFS as readonly string[]).not.toContain(ref);
    }

    const spec = await buildAutoloopReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      rubricOpts: { deps: { listScorecards: async () => [healthyScorecard] } },
    });
    const keys = spec.components.map((c) => c.key);
    for (const ref of retiredTierRubrics) expect(keys).not.toContain(`rubric:${ref}`);

    // The surviving legs are still present — this removed the dead tier, not the gate.
    expect(keys).toContain('rubric:blender-release-readiness');
    expect(keys).toContain('gate:deploy-staleness');
  });

  it('GOes when every leg rubric passes and the deploy gate is fresh', async () => {
    const verdict = await evaluateAutoloopReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: { deps: { listScorecards: async () => [healthyScorecard] } },
      windowsSmokeOpts: healthyWindowsSmokeOpts,
    });
    expect(verdict.go).toBe(true);
  });

  it('REFUSES GO when the blender leg alone fails, even with every other leg + the gate healthy', async () => {
    const verdict = await evaluateAutoloopReleaseProfile({
      deps: healthyDeps,
      gateOpts: healthyGateOpts,
      evaluateOpts: { now: NOW },
      rubricOpts: {
        deps: {
          listScorecards: async (opts: { rubricRef?: string } = {}) =>
            opts.rubricRef === 'blender-release-readiness'
              ? [scorecardRow({ ratings: { c1: { rating: 'broken', evidence: 'e' }, c2: { rating: 'pass', evidence: 'e' } }, gradedGeneration: { deployedSha: 'gen-sha-1', hostStartedAt: null } })]
              : [healthyScorecard],
        },
      },
      windowsSmokeOpts: healthyWindowsSmokeOpts,
    });
    expect(verdict.go).toBe(false);
    expect(verdict.components.find((c) => c.key === 'rubric:blender-release-readiness')?.verdict).toBe('fail');
    // every other leg stayed healthy — the refusal is attributable to the one failing leg, not a broad break
    for (const ref of AUTOLOOP_COMPONENT_RUBRIC_REFS.filter((r) => r !== 'blender-release-readiness')) {
      expect(verdict.components.find((c) => c.key === `rubric:${ref}`)?.verdict).toBe('pass');
    }
  });

  it('REFUSES GO on the deploy-staleness gate alone, even with every leg rubric healthy', async () => {
    const verdict = await evaluateAutoloopReleaseProfile({
      deps: healthyDeps,
      evaluateOpts: { now: NOW },
      rubricOpts: { deps: { listScorecards: async () => [healthyScorecard] } },
      gateOpts: {
        deps: {
          deployedSha: async () => 'gen-sha-1',
          currentSha: async () => 'candidate-sha',
          commitUnixTime: async () => Math.floor(Date.now() / 1000) - 20 * 3_600,
          commitsBetween: async () => Array.from({ length: 50 }, (_, i) => `c${i}`),
        },
        thresholds: { maxPinAgeMs: 6 * 3_600_000, maxCommitsBehind: 20 },
      },
      windowsSmokeOpts: healthyWindowsSmokeOpts,
    });
    expect(verdict.go).toBe(false);
    expect(verdict.components.find((c) => c.key === 'gate:deploy-staleness')?.verdict).toBe('fail');
  });
});

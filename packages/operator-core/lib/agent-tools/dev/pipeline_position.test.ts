import { describe, it, expect, vi } from 'vitest';
import tool, { PIPELINE_POSITION_RESPONSE_BUDGET_CHARS, shapePipelinePosition } from './pipeline_position';
import { gitPipelinePosition, type PipelinePosition, type RuntimeOwnership } from '../../git-pipeline-position';
import { resolveSeeAlso } from '@papercusp/agent-mcp';
import { takeNamedViewFromArgs } from '../../result-projection';
/**
 * P-010: the handler reads the LIVE cell registry, which the tool barrel populates via
 * this wiring module (agent-tools/index.ts). A test importing only the tool would see an
 * EMPTY registry — and an empty registry stamps nothing, silently, which would make the
 * P-010 assertions below pass-by-vacuity in the one direction that matters.
 */
import '../cell-registrations-wiring';

vi.mock('../../git-pipeline-position', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git-pipeline-position')>();
  return { ...actual, gitPipelinePosition: vi.fn() };
});

vi.mock('../../harness/operator-home-harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/operator-home-harness')>()),
  operatorHomeHarnessSlug: () => 'test-home',
}));

/**
 * deploy-pipeline-legibility-2026-06-18 P-005: the shared DEPLOY_PIPELINE_NOTE (in every spawned
 * role's prompt) tells EVERY execution/judgment role to reach for `dev:pipeline_position` instead
 * of polling :3070. So the tool's allowlist MUST cover them all — this guards against a silent
 * re-narrowing that would re-break the note's promise. The tool is read-only (intel:read), so a
 * wide allowlist is safe.
 */
describe('dev:pipeline_position accepted-source contract (WI-10007982)', () => {
  const expectedSourceSha256 = 'a'.repeat(64);
  const path = 'packages/operator-core/lib/harness/routines/loop-execution-recovery.ts';

  it('requires a concrete path and a valid frozen SHA256', () => {
    expect(tool.args.safeParse({ expectedSourceSha256 }).success).toBe(false);
    expect(tool.args.safeParse({ path, expectedSourceSha256: 'bad' }).success).toBe(false);
    expect(tool.args.safeParse({ path, expectedSourceSha256 }).success).toBe(true);
    expect(tool.args.safeParse({}).success).toBe(true);
  });

  it('forwards the expected fingerprint and keeps keyed containment in a bounded response', async () => {
    const acceptedSource = { expectedSha256: expectedSourceSha256, observedSha256: expectedSourceSha256,
      matches: true, deployedContains: false, runtimeContainment: { 'release-operator': false, 'bg-host': null } };
    const result = { input: { path, sha: null }, repoRoot: '/repo', acceptedSource,
      notes: ['large detail '.repeat(2000)] } as unknown as PipelinePosition;
    vi.mocked(gitPipelinePosition).mockResolvedValue(result);
    const out = await tool.handler({ path, expectedSourceSha256 } as never, {} as never) as { data: Record<string, unknown> };
    expect(gitPipelinePosition).toHaveBeenLastCalledWith(expect.objectContaining({ path, expectedSourceSha256 }));
    expect(out.data.acceptedSource).toEqual(acceptedSource);
    expect((out.data.projection as { fullRead: { args: unknown } }).fullRead.args)
      .toMatchObject({ path, expectedSourceSha256 });
  });
});

describe('native P017 pipeline source-runtime measurement selector', () => {
  it('survives the actual named-view extraction boundary and catches the reserved-key control', () => {
    const args = tool.args.parse({ path: 'target.ts', sourceRuntimeOnly: true });
    expect(takeNamedViewFromArgs(args, 'dev:pipeline_position')).toEqual({ kind: 'none', args });
    expect(takeNamedViewFromArgs({ path: 'target.ts', view: 'source-runtime' }, 'dev:pipeline_position').kind).toBe('error');
  });
  it('preserves exact repository and bound source/runtime identity without the large pipeline digest', async () => {
    const digest = 'a'.repeat(64);
    const acceptedSource = { expectedSha256: digest, observedSha256: digest, matches: true,
      deployedContains: false, runtimeContainment: { 'staging-operator': true, 'release-operator': false } };
    const servingRuntimes = [{ runtime: 'release-operator', buildSha: 'b'.repeat(40), containsChange: false },
      { runtime: 'staging-operator', buildSha: 'c'.repeat(40), containsChange: true }];
    vi.mocked(gitPipelinePosition).mockResolvedValue({ repoRoot: '/native-fixture', submodule: null,
      acceptedSource, servingRuntimes, gate: { ownerBrief: 'x'.repeat(20_000) } } as unknown as PipelinePosition);
    const args = tool.args.parse({ path: 'target.ts', expectedSourceSha256: digest, sourceRuntimeOnly: true });
    const result = await tool.handler(args, {} as never) as { data: Record<string, unknown> };
    expect(result.data).toEqual({ repoRoot: '/native-fixture', submodule: null, acceptedSource, servingRuntimes });
    expect(gitPipelinePosition).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'target.ts', expectedSourceSha256: digest }));
  });
});

describe('dev:pipeline_position role allowlist', () => {
  it('is available to every execution/judgment role the cross-role note points at', () => {
    const roles = new Set(tool.agentRoles ?? []);
    const expected = [
      'operator', 'mug', 'architect', 'worker', 'scoper', 'validator', 'reviewer', 'judge',
      'debugger', 'documenter', 'curator', 'cup', 'papercup', 'papercup-deep', 'kettle',
      'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
    ];
    for (const r of expected) {
      expect(roles.has(r), `pipeline_position must be allowed for role '${r}'`).toBe(true);
    }
  });
});

describe('dev:pipeline_position transaction boundary', () => {
  it('does not hold an ambient workspace transaction across subprocess probes', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

/**
 * WI-10004551: a completed-late read must surface its result, not a false `timeout`. The dispatch
 * ok-on-abort exemption (libs/generic/tooldef dispatch-stack.ts) only covers tools whose every
 * capability is tier 'low' OR that declare `idempotent:true`. This tool's capability `intel:read` is
 * tier 'high' by design (it also gates the prompt/activity-exposing intel panels), so without the
 * flag 23 of 25 slow calls over 72h were reported `timeout` with their valid result discarded.
 * The abort-race branch itself is exercised in dispatch-projected.test.ts; this pins the link that
 * is easy to lose — that THIS read still declares the opt-in, and that the capability stays 'high'
 * (so the flag, not a tier change, remains the reason it qualifies).
 */
describe('dev:pipeline_position late-completion opt-in (WI-10004551)', () => {
  it('declares idempotent:true so a completed-but-slow read surfaces its result past the deadline', () => {
    expect((tool as { idempotent?: boolean }).idempotent).toBe(true);
  });

  it('stays on the high-tier intel:read capability (the reason the flag is needed at all)', () => {
    expect((tool as { capability?: string }).capability).toBe('intel:read');
  });
});

describe('dev:pipeline_position current-build test route selection', () => {
  const PATH = 'packages/operator-core/lib/serving-runtimes.ts';
  const running = {
    input: { path: PATH, sha: null },
    positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
    runtime: { host: 'bg-host', releasePipelineApplies: false, restartTarget: 'bg-host', activation: 'restart' },
    runtimes: [{ host: 'bg-host', releasePipelineApplies: false }],
    servingRuntimes: { entries: [] },
  } as unknown as PipelinePosition;

  it('keeps the original native selectors and route through schema, named-view and oversized handler output (EI-25679146311569247)', async () => {
    const request = {
      path: 'packages/operator-core/lib/goal-holder-behavior-metrics.ts',
      testClass: 'operator-api',
      marker: 'ideationAttribution',
    };
    const parsed = tool.args.parse(request);
    const selected = takeNamedViewFromArgs(parsed, 'dev:pipeline_position');
    expect(selected).toEqual({ kind: 'none', args: request });
    if (selected.kind !== 'none') throw new Error('unexpected named-view selection');

    // A missing repository measurement and a large digest must not erase the
    // route selected by the handler. This uses the reporter's original marker;
    // a control with a different marker cannot attest these inputs.
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...running,
      input: { path: request.path, sha: null },
      repoRoot: null,
      notes: Array.from({ length: 40 }, () => 'oversized diagnostic '.repeat(100)),
    } as unknown as PipelinePosition);
    const out = await tool.handler(selected.args, {} as never) as {
      data: { currentBuildTestRoute?: { id: string; runtime: string }; projection?: { fullRead: { args: unknown } } };
    };
    expect(gitPipelinePosition).toHaveBeenLastCalledWith(expect.objectContaining({
      path: request.path, marker: request.marker,
    }));
    expect(out.data.currentBuildTestRoute).toMatchObject({ id: 'operator-api', runtime: 'staging-operator' });
    expect(Object.keys(out.data)[0]).toBe('currentBuildTestRoute');
    expect(JSON.stringify(out.data).slice(0, 2_000)).toContain('"currentBuildTestRoute"');
    expect(out.data.projection?.fullRead.args).toEqual(request);
    expect(JSON.stringify(out.data).length).toBeLessThanOrEqual(PIPELINE_POSITION_RESPONSE_BUDGET_CHARS);
  });

  it('returns an exact route with isolation and prerequisites before main is green', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue(running);
    const out = await tool.handler({ path: PATH, testClass: 'operator-api' } as never, {} as never) as {
      data: { currentBuildTestRoute?: { id: string; readiness: string; isolation: string; prerequisites: string[] } };
    };
    expect(out.data.currentBuildTestRoute).toMatchObject({
      id: 'operator-api', readiness: 'ready',
      prerequisites: ['Containing staging commit loaded', 'private test identity/data for writes'],
    });
    expect(out.data.currentBuildTestRoute?.isolation).toMatch(/database and workspace are not isolated/i);
  });

  it('requires private background runtime prerequisites before claiming a runnable route', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue(running);
    const out = await tool.handler({ path: PATH, testClass: 'background-federation' } as never, {} as never) as {
      data: { currentBuildTestRoute?: { readiness: string; runtime: string; route: string; prerequisites: string[] } };
    };
    expect(out.data.currentBuildTestRoute).toMatchObject({
      readiness: 'requires-prerequisites',
      runtime: 'bg-host',
      route: expect.stringContaining('--isolated-runtime'),
      prerequisites: expect.arrayContaining(['explicit teardown assertion']),
    });
  });

  it('returns the maintained AWS candidate route while the current build is absent from main', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue(running);
    const out = await tool.handler({
      path: 'packages/operator-core/lib/workspace-host/aws-ami-production.ts',
      testClass: 'aws-ami-candidate',
    } as never, {} as never) as {
      data: { currentBuildTestRoute?: {
        readiness: string; runtime: string | null; route: string; routeFile: string;
        prerequisites: string[]; isolation: string; verification: string;
      } };
    };
    const route = out.data.currentBuildTestRoute;
    expect(route).toMatchObject({ readiness: 'requires-prerequisites', runtime: null });
    expect(route?.routeFile).toBe('apps/operator/lib/release/aws-ami-release-cli.ts');
    expect(route?.route).toContain('workspace-host-clean-room-acceptance-cli.ts --input-file');
    expect(route?.route).toContain('aws-ami-release-cli.ts --request-file');
    expect(route?.prerequisites.join(' ')).toMatch(/persisted AWS publisher connection/i);
    expect(route?.prerequisites.join(' ')).toMatch(/distinct clean-account role/i);
    expect(route?.prerequisites.join(' ')).toMatch(/private SSM parameter prefix/i);
    expect(route?.isolation).toMatch(/unique owned fixture/i);
    expect(route?.verification).toMatch(/termination with zero residual resources/i);
    expect(route?.verification).toMatch(/preflight alone is not cloud acceptance/i);
  });

  it('rejects unknown classes rather than defaulting them to the release route', async () => {
    const out = await tool.handler({ path: PATH, testClass: 'anything' } as never, {} as never) as {
      data: { error: string; supportedClasses: string[] };
    };
    expect(out.data.error).toBe('unknown_test_class');
    expect(out.data.supportedClasses).toContain('final-release');
  });
});

describe('dev:pipeline_position bounded response wiring (EI-20245527109472763)', () => {
  type Out = { data: Record<string, unknown> };

  const PATH = 'packages/operator-core/lib/agent-tools/dev/pipeline_position.ts';
  const marker = 'shape-pipeline-position-regression-marker';
  const singleRelease = {
    host: 'operator-release',
    releasePipelineApplies: true,
    restartTarget: 'staging',
    activation: 'deploy',
  };
  const singleStaging = {
    host: 'bg-host',
    releasePipelineApplies: false,
    restartTarget: 'bg-host',
    activation: 'restart bg-host',
  };
  const oversized = {
    input: { path: PATH, sha: null },
    repoRoot: '/repo',
    submodule: null,
    targetSha: 'sha0000001',
    targetShortSha: 'sha000000',
    targetSubject: 'subj',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    assessments: {
      pipelinePosition: 'live',
      gateVerdict: 'passing-current',
      gateCandidate: 'no-active-run',
      gateOwnership: 'claimable',
      deployedSha: 'executing',
      mainBehindStaging: 'caught-up',
    },
    deployedSha: 'sha0000001',
    serving: {
      host: 'operator-release',
      unit: 'papercusp-dev-api.service',
      pid: 99,
      startedAtMs: 1,
      codeAsOfMs: 1,
      codeAsOfSource: 'deploy',
      startedSinceCodeChange: true,
      behindMin: null,
      restartLever: 'deploy',
      restartSupersededBy: null,
      unknownReason: null,
    },
    verdictUnknown: [{ leg: 'gate.consecutiveReds', unknown: { code: 'resolver-failed', detail: 'fixture' } }],
    gate: {
      stalled: false,
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      ownership: { claimState: 'unheld', thread: 'x'.repeat(12_000) },
    },
    verdictProvenance: {
      lastGreenSha: 'sha0000001',
      lastGreenShortSha: 'sha000000',
      lastGreenAgeMs: 1000,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    runtimeGenerations: [
      {
        unit: 'papercusp-bg-host.service',
        label: 'bg-host',
        pid: 42,
        startedAtMs: 1,
        codeAsOfMs: 1,
        codeAsOfSource: 'file-mtime',
        runningYourCode: true,
        behindMin: null,
        loadedIdentity: {
          source: 'runtime-vintage',
          unit: 'bg-host',
          host: 'tower',
          treeSha: 'abc123',
          bundleVersion: '0.0.15-alpha',
          buildTime: null,
          reportedAt: '2026-08-13T10:00:01.000Z',
        },
        loadedIdentityUnknown: null,
        activationLever: 'restart',
        unknownReason: null,
      },
    ],
    gitSync: {
      status: 'skipped-locked',
      skippedPaths: [{ scope: 'superproject', path: PATH, owner: 'su-test', intent: 'editing the pipeline' }],
    },
    summary: 'stub summary',
    notes: [],
  } as unknown as PipelinePosition;

  const expectBounded = (out: Out) => {
    const projection = out.data.projection as Record<string, unknown>;
    expect(projection).toMatchObject({ kind: 'bounded', truncated: true });
    expect(projection.fullRead).toEqual({
      tool: 'dev:pipeline_position',
      args: { path: PATH, marker },
    });
    expect(projection.omittedFields).toContain('gate.ownership.thread');
    expect(projection.omittedFields).not.toContain('verdictUnknown');
    expect(out.data.verdictUnknown).toEqual([
      { leg: 'gate.consecutiveReds', unknown: { code: 'resolver-failed', detail: 'fixture' } },
    ]);
    expect(out.data.assessments).toEqual(oversized.assessments);
    expect(projection.omittedFields).not.toContain('assessments');
    expect(out.data.serving).toMatchObject({
      host: 'operator-release',
      startedSinceCodeChange: true,
      restartLever: 'deploy',
    });
    expect(out.data.runtimeGenerations).toMatchObject([
      {
        unit: 'papercusp-bg-host.service',
        loadedIdentity: { source: 'runtime-vintage', treeSha: 'abc123', host: 'tower' },
        loadedIdentityUnknown: null,
      },
    ]);
    expect(out.data.gitSync).toMatchObject({
      status: 'skipped-locked',
      skippedPaths: [{ scope: 'superproject', path: PATH, owner: 'su-test', intent: 'editing the pipeline' }],
    });
    expect(JSON.stringify(out.data).length).toBeLessThanOrEqual(PIPELINE_POSITION_RESPONSE_BUDGET_CHARS);
  };

  it('retains positionsMarker in the final minimal fallback', () => {
    const verboseDetail = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`detail${index}`, 'x'.repeat(360)]),
    );
    const positionsMarker = {
      marker,
      onStaging: {
        marker,
        sha: 'sha0000002',
        present: true,
        count: 1,
        pathPresent: true,
        unknownReason: null,
      },
      inMain: null,
      deployed: null,
    };
    const out = shapePipelinePosition(
      {
        input: { path: PATH, sha: null },
        targetSha: 'sha0000001',
        targetShortSha: 'sha000000',
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        positionsMarker,
        submodule: verboseDetail,
        submodulePin: verboseDetail,
      } as unknown as PipelinePosition,
      {},
      { path: PATH, marker },
    ) as Record<string, unknown>;
    const projection = out.projection as Record<string, unknown>;

    expect(projection).toMatchObject({ kind: 'bounded', truncated: true });
    expect(projection.returnedChars).toBeLessThanOrEqual(PIPELINE_POSITION_RESPONSE_BUDGET_CHARS);
    expect(projection.fullRead).toEqual({ tool: 'dev:pipeline_position', args: { path: PATH, marker } });
    expect(out).not.toHaveProperty('submodule');
    expect(out).not.toHaveProperty('submodulePin');
    expect(out.positionsMarker).toEqual(positionsMarker);
  });

  it('bounds the multi-consumer exit without dropping activations', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...oversized,
      runtime: singleStaging,
      runtimes: [singleStaging, singleRelease],
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: PATH, marker } as never, {} as never)) as Out;

    expectBounded(out);
    expect(out.data.activations).toHaveLength(2);
  });

  it('bounds the non-release exit without dropping activation guidance', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...oversized,
      runtime: singleStaging,
      runtimes: [singleStaging],
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: PATH, marker } as never, {} as never)) as Out;

    expectBounded(out);
    expect(out.data.activation).toMatchObject({ host: 'bg-host', releasePipelineApplies: false });
  });

  it('bounds the default exit without dropping the deploy awaitable', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...oversized,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      blockedOn: 'deployed',
      nextAction: null,
      runtime: singleRelease,
      runtimes: [singleRelease],
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: PATH, marker } as never, {} as never)) as Out;

    expectBounded(out);
    expect(out.data.awaitable).toMatchObject({ sugar: 'deploy:await' });
  });
});

/**
 * WI-5440: a path can have MORE THAN ONE consumer on different activation
 * routes (git-pipeline-position.ts's `runtimes`, plural). Collapsing to a
 * single `activation` block routed a live activation decision the wrong
 * way during the 0.0.11-alpha release watch — this asserts the handler
 * surfaces `activations` (one per consumer) instead of picking one.
 */
describe('dev:pipeline_position multi-consumer paths (WI-5440)', () => {
  type Out = { data: Record<string, unknown> };

  it('returns `activations` (plural), not a single misleading `activation`, when `runtimes` has more than one entry', async () => {
    const fakeResult = {
      input: { path: 'packages/operator-core/lib/scout/success-metrics.ts', sha: null },
      repoRoot: '/repo',
      submodule: null,
      targetSha: 'sha0000001',
      targetShortSha: 'sha000000',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      deployedSha: 'sha0000001',
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      verdictProvenance: {
        lastGreenSha: 'sha0000001',
        lastGreenShortSha: 'sha000000',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      runtime: {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation: 'bg-host activation text',
      },
      runtimes: [
        {
          host: 'bg-host',
          releasePipelineApplies: false,
          restartTarget: 'bg-host',
          activation: 'bg-host activation text',
        },
        {
          host: 'operator-release',
          releasePipelineApplies: true,
          restartTarget: 'staging',
          activation: 'release activation text',
        },
      ],
      summary: 'stub summary',
      notes: [],
    } as unknown as PipelinePosition;
    vi.mocked(gitPipelinePosition).mockResolvedValue(fakeResult);

    const out = (await tool.handler(
      { path: 'packages/operator-core/lib/scout/success-metrics.ts' } as never,
      {} as never,
    )) as Out;

    const activations = out.data.activations as Array<Record<string, unknown>>;
    expect(activations).toHaveLength(2);
    expect(activations[0]).toMatchObject({ host: 'bg-host', releasePipelineApplies: false });
    expect(activations[1]).toMatchObject({ host: 'operator-release', releasePipelineApplies: true });
    expect(activations[0].args).toMatchObject({
      target: 'bg-host',
      confirm: true,
      authorize: true,
      reason: 'load the edit',
    });
    expect(activations[1].args).toMatchObject({
      target: 'staging',
      confirm: true,
      authorize: true,
      reason: 'load the edit',
    });
    // Never the single-consumer shape — that's exactly the misroute this fixes.
    expect(out.data.activation).toBeUndefined();
    // At least one consumer needs the deploy pipeline, so the note must not
    // blanket-tell the caller to skip deploy:await.
    expect(out.data.note).not.toMatch(/^Do NOT deploy:await/);
    expect(out.data.note).toMatch(/operator-release/);
  });
});

describe('dev:pipeline_position single runtime activation (EI-20242154394397741)', () => {
  it('includes the audited enablement gate in the concrete restart args', async () => {
    const fakeResult = {
      input: { path: 'packages/operator-core/lib/dbos/routines-tick.ts', sha: null },
      repoRoot: '/repo',
      submodule: null,
      targetSha: 'sha0000001',
      targetShortSha: 'sha000000',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      deployedSha: 'sha0000001',
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      verdictProvenance: {
        lastGreenSha: 'sha0000001',
        lastGreenShortSha: 'sha000000',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      runtime: {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation: 'bg-host activation text',
      },
      summary: 'stub summary',
      notes: [],
    } as unknown as PipelinePosition;
    vi.mocked(gitPipelinePosition).mockResolvedValue(fakeResult);

    const out = (await tool.handler(
      { path: 'packages/operator-core/lib/dbos/routines-tick.ts' } as never,
      {} as never,
    )) as { data: Record<string, unknown> };

    expect(out.data.activation).toMatchObject({
      tool: 'dev:restart',
      args: { target: 'bg-host', confirm: true, authorize: true, reason: 'load the edit' },
    });
  });
});

/**
 * P-005: the payload must not carry TWO contradictory instructions.
 *
 * `awaitable` says "sleep on the deploy". That is true advice only when the deploy is
 * genuinely what the change waits for. When an EARLIER stage owns the next move — the work
 * is uncommitted, the push leg is faulted, the gate is red or judging a candidate without
 * this change — sleeping on `release:deployed` waits for an event that will land carrying
 * someone else's code, while the thing that would actually help goes undone. Emitting both
 * is worse than emitting either.
 */
describe('dev:pipeline_position awaitable defers to nextAction (P-005)', () => {
  type Out = { data: Record<string, unknown> };

  const base = {
    input: { path: 'apps/operator/app/x.ts', sha: null },
    repoRoot: '/repo',
    submodule: null,
    targetSha: 'sha0000001',
    targetShortSha: 'sha000000',
    targetSubject: 'subj',
    dirtyUncommitted: false,
    deployedSha: 'sha0000001',
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
    verdictProvenance: {
      lastGreenSha: 'sha0000001',
      lastGreenShortSha: 'sha000000',
      lastGreenAgeMs: 1000,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    runtime: { host: 'operator-release', releasePipelineApplies: true, restartTarget: 'dev', activation: 'deploy' },
    runtimes: [{ host: 'operator-release', releasePipelineApplies: true, restartTarget: 'dev', activation: 'deploy' }],
    summary: 'stub summary',
    notes: [],
  };

  it('SUPPRESSES the deploy-await when an earlier stage owns the next move', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...base,
      positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
      blockedOn: 'committed',
      nextAction: 'git-sync:run (commit the working tree — the gate cannot see it)',
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: 'apps/operator/app/x.ts' } as never, {} as never)) as Out;
    expect(out.data.awaitable).toBeUndefined();
    expect(out.data.nextAction).toMatch(/git-sync:run/);
  });

  it('STILL offers the deploy-await when waiting really is the answer', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...base,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      blockedOn: 'deployed',
      nextAction: null,
    } as unknown as PipelinePosition);

    const out = (await tool.handler({ path: 'apps/operator/app/x.ts' } as never, {} as never)) as Out;
    expect(out.data.awaitable).toMatchObject({ sugar: 'deploy:await' });
  });

  /**
   * WI-6595 — the case `nextAction` alone could never catch, which cost a live session
   * ~26 minutes of silence on 2026-07-28.
   *
   * A RED gate with a run already in flight has no lever, so `nextAction` is legitimately
   * null — this tool's own documented "blocked, and WAITING IS CORRECT" verdict. The old
   * `deployed || nextAction` guard therefore did NOT suppress the hint, and the agent was
   * told to sleep on `release:deployed`. The gate then went red, so no deploy was ever
   * attempted and neither `release:deployed` nor `release:deploy-failed` could fire. Worse,
   * sleeping on an await suppresses the monitor loop's fires, so the advice silenced the
   * agent's own heartbeat too.
   *
   * The verdict must key on WHERE THE CHANGE SITS, not on whether a lever happens to exist.
   */
  for (const blockedOn of ['committed', 'pushed', 'gate', 'main'] as const) {
    it(`SUPPRESSES the deploy-await when blocked at "${blockedOn}" even with NO nextAction`, async () => {
      vi.mocked(gitPipelinePosition).mockResolvedValue({
        ...base,
        positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
        gate: { stalled: false, consecutiveReds: 1, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
        blockedOn,
        // No lever: a red gate with a run already in flight is a legitimate "just wait".
        nextAction: null,
      } as unknown as PipelinePosition);

      const out = (await tool.handler({ path: 'apps/operator/app/x.ts' } as never, {} as never)) as Out;
      expect(out.data.awaitable).toBeUndefined();
    });
  }
});

/**
 * state-plane-adoption-2026-08-02 P-002 — this tool is the door agents already use
 * (626 calls/7d), so it is where the state plane gets discovered. The pointer is a
 * result-time `seeAlso` rather than a prompt-time `chaining` line: this tool projects
 * at 1411 against the 1500 prompt-weight budget (dev:restart 1491, release:deploy 1472),
 * so the prompt-time route is effectively closed across the family — and a re-read is
 * advice that only makes sense at the moment the value is in the caller's hand.
 */
describe('dev:pipeline_position routes to the state plane (P-002)', () => {
  const ptrs = (data: unknown) =>
    resolveSeeAlso(
      tool.guidance?.seeAlso,
      { content: [{ type: 'text' as const, text: JSON.stringify(data) }] } as never,
      {},
      {},
    );

  it('always points at state:read for a re-read at the moment of acting', () => {
    const read = ptrs({ blockedOn: null }).find((x) => x.tool === 'state:read');
    expect(read).toBeDefined();
    expect(read?.reason).toMatch(/re-read|transcribe/i);
  });

  /** The pointer must name the ONE cell that re-answers the question the caller has. */
  const cases = [
    ['gate', 'gate.greenCheckpoint.verdict'],
    ['main', 'git.mainBehindStaging'],
    ['deployed', 'deploy.3070.sha'],
    ['serving', 'deploy.3070.sha'],
    ['committed', 'git.pipelinePosition'],
    [null, 'git.pipelinePosition'],
  ] as const;
  for (const [blockedOn, cell] of cases) {
    it(`names ${cell} when blocked at "${blockedOn}"`, () => {
      expect(ptrs({ blockedOn }).find((x) => x.tool === 'state:read')?.selector).toContain(cell);
    });
  }

  /**
   * The gate is the one leg with no lever and no existing await advice (the handler
   * deliberately suppresses `awaitable` there — WI-6595). Everywhere else, offering
   * state:subscribe would be a SECOND door for a wait deploy:await already owns.
   */
  it('offers state:subscribe ONLY on the gate leg, never as a second door for the deploy', () => {
    expect(ptrs({ blockedOn: 'gate' }).some((x) => x.tool === 'state:subscribe')).toBe(true);
    for (const blockedOn of ['deployed', 'serving', 'committed', 'pushed', 'main', null]) {
      expect(ptrs({ blockedOn }).some((x) => x.tool === 'state:subscribe')).toBe(false);
    }
  });

  /**
   * THE REGRESSION THAT WOULD MAKE THIS A SILENT NO-OP. seeAlso runs on the SERIALIZED
   * result, and on the MCP transport the {data} envelope may be TOON — readJsonResult
   * returns undefined and a JSON-only gate never fires, on the exact transport agents
   * actually use. The regex fallback must keep the gating alive.
   */
  it('still gates correctly when the envelope is TOON, not JSON', () => {
    const toon = { content: [{ type: 'text' as const, text: 'blockedOn: gate\ndeployed: false' }] };
    const p = resolveSeeAlso(tool.guidance?.seeAlso, toon as never, {}, {});
    expect(p.find((x) => x.tool === 'state:read')?.selector).toContain('gate.greenCheckpoint.verdict');
    expect(p.some((x) => x.tool === 'state:subscribe')).toBe(true);
  });

  /**
   * The three pre-existing pointers are BARE STRINGS, so normalizeEntry puts the whole
   * sentence (prose and all) in `tool` — match on prefix, not equality. Adding the state
   * plane must not drop them.
   */
  it('keeps the pre-existing activation/deploy pointers', () => {
    const tools = ptrs({ blockedOn: 'deployed' }).map((x) => x.tool);
    for (const name of ['dev:restart', 'dev:build_status', 'release:deploy']) {
      expect(tools.some((t) => t.startsWith(name))).toBe(true);
    }
  });
  /**
   * EI-21515547059659539 — a CROSS-HARNESS caller cannot reach the state plane
   * (audience-filtered; cell_absent is deliberately indistinguishable from
   * nonexistent). The pointers stay (option b: teach the boundary) but must say
   * WHICH audience owns the cells and what the caller will get.
   */
  it('qualifies state pointers with the audience boundary on a harnessMismatch reply', () => {
    const data = {
      blockedOn: 'gate',
      harnessMismatch: { callerHarness: 'sb-devboard-hive', reportedHarness: 'papercusp' },
    };
    for (const p of ptrs(data).filter((x) => x.tool === 'state:read' || x.tool === 'state:subscribe')) {
      expect(p.reason).toMatch(/AUDIENCE/);
      expect(p.reason).toContain("in the 'papercusp' state-plane audience");
      expect(p.reason).toContain("from 'sb-devboard-hive'");
      expect(p.reason).toMatch(/cell_absent/);
    }
  });

  it('does NOT add the audience note when the caller is in-harness', () => {
    const statePtrs = ptrs({ blockedOn: 'gate' }).filter(
      (x) => x.tool === 'state:read' || x.tool === 'state:subscribe',
    );
    expect(statePtrs.length).toBeGreaterThan(0);
    for (const p of statePtrs) expect(p.reason).not.toMatch(/AUDIENCE/);
  });

  /** The TOON fallback path must keep the qualification alive too. */
  it('detects harnessMismatch through the regex fallback on non-JSON text', () => {
    const toon = {
      content: [
        {
          type: 'text' as const,
          text: 'blockedOn: gate\nharnessMismatch:\ncallerHarness: "sb-devboard-hive"\nreportedHarness: "papercusp"',
        },
      ],
    };
    const p = resolveSeeAlso(tool.guidance?.seeAlso, toon as never, {}, {});
    expect(p.find((x) => x.tool === 'state:read')?.reason).toMatch(/AUDIENCE.*sb-devboard-hive/s);
  });
});

/**
 * state-plane-adoption-2026-08-02 P-010 — the door EMITS the plane.
 *
 * P-002 above points at the plane and names one cell; that is promotion, and promotion
 * asymptotes (ACT/QUOTE 1.7%, D-030). This block asserts the door hands back every
 * volatile value already stamped with the cell that re-answers it.
 *
 * The stamping logic itself is unit-tested hermetically in state-plane-stamp.test.ts.
 * What can ONLY be caught here is the wiring: which exits carry the block, and whether
 * the caller's own subject reaches the handle.
 */
describe('dev:pipeline_position EMITS the state plane (P-010)', () => {
  type Out = { data: Record<string, unknown> };
  type Plane = {
    note: string;
    cells: Array<{
      path: string;
      cell: string;
      reread?: { args: { cell: string; as?: string } };
      unreadable?: { needs: string };
    }>;
  };

  const PATH = 'apps/operator/app/x.ts';

  /**
   * ⚠ THE READER IS LOAD-BEARING, so this block passes a real one.
   *
   * Every cell this door stamps (git.pipelinePosition, gate.greenCheckpoint.verdict/
   * .candidate/.ownership, deploy.3070.sha, git.mainBehindStaging) is
   * `{ kind: 'harness', ref: 'papercusp' }` — EI-20709429494940822 narrowed them so a
   * foreign harness cannot read Papercusp's gate and deploy state as if it were its own,
   * and cell-registrations.test.ts pins exactly that.
   *
   * `planeFor` stamps from `listCells(reader)`, which is audience-scoped. So the plane has
   * cells to stamp only for a reader INSIDE the home harness — which is what a real
   * in-harness MCP call carries, and what the cross-harness block at the bottom of this
   * file already models. A bare `{}` ctx models no real caller: it resolves to an empty
   * audience, `listCells` returns nothing pipeline-shaped, and the plane silently comes
   * back undefined — which would make every assertion below pass or fail for a reason
   * that has nothing to do with the wiring they exist to pin.
   */
  const CTX = { role: 'cup', harnessSlug: 'papercusp' };

  const full = {
    input: { path: PATH, sha: null },
    repoRoot: '/repo',
    submodule: null,
    targetSha: 'sha0000001',
    targetShortSha: 'sha000000',
    targetSubject: 'subj',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    deployedSha: 'sha0000001',
    gate: {
      stalled: false,
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      ownership: { claimState: 'unheld' },
    },
    changeInCandidate: { judgingSha: 'cand0001' },
    verdictProvenance: {
      lastGreenSha: 'sha0000001',
      lastGreenShortSha: 'sha000000',
      lastGreenAgeMs: 1000,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    summary: 'stub summary',
    notes: [],
  };

  const single = { host: 'operator-release', releasePipelineApplies: true, restartTarget: 'dev', activation: 'deploy' };
  const bgHost = {
    host: 'bg-host',
    releasePipelineApplies: false,
    restartTarget: 'bg-host',
    activation: 'restart bg-host',
  };

  const planeOf = (out: Out) => out.data.plane as Plane | undefined;

  /**
   * THE WIRING REGRESSION. The handler has THREE exits — multi-consumer, non-release
   * runtime, and the default — and stamping only the default would drop the plane for
   * exactly the paths with unusual activation routes, whose readers are the most likely
   * to be reasoning about what is and is not live.
   */
  const exits = [
    ['default (release-carried, single consumer)', { ...full, runtime: single, runtimes: [single] }],
    ['non-release runtime (bg-host — activation, not deploy)', { ...full, runtime: bgHost, runtimes: [bgHost] }],
    ['multi-consumer (activations, plural)', { ...full, runtime: bgHost, runtimes: [bgHost, single] }],
  ] as const;

  for (const [label, result] of exits) {
    it(`stamps the plane on the "${label}" exit`, async () => {
      vi.mocked(gitPipelinePosition).mockResolvedValue(result as unknown as PipelinePosition);
      const out = (await tool.handler({ path: PATH } as never, CTX as never)) as Out;
      const plane = planeOf(out);
      expect(plane, 'this exit must carry the plane block').toBeDefined();
      expect(plane!.cells.length).toBeGreaterThan(0);
      expect(plane!.note).toMatch(/re-read|transcribe/i);
    });
  }

  it("names the cell for each volatile value, addressed to the CALLER'S path", async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...full,
      runtime: single,
      runtimes: [single],
    } as unknown as PipelinePosition);
    const plane = planeOf((await tool.handler({ path: PATH } as never, CTX as never)) as Out)!;
    const byCell = new Map(plane.cells.map((c) => [c.cell, c]));

    // The global cells: a complete handle, no subject needed.
    expect(byCell.get('deploy.3070.sha')?.reread?.args).toEqual({ cell: 'deploy.3070.sha' });
    expect(byCell.get('gate.greenCheckpoint.verdict')?.reread?.args).toEqual({ cell: 'gate.greenCheckpoint.verdict' });

    // The caller-relative ones MUST carry the caller's own path, or they re-read a
    // different subject than the value sitting in this very payload.
    expect(byCell.get('gate.greenCheckpoint.candidate')?.reread?.args).toEqual({
      cell: 'gate.greenCheckpoint.candidate',
      as: PATH,
    });
    expect(byCell.get('git.pipelinePosition')?.reread?.args).toEqual({ cell: 'git.pipelinePosition', as: PATH });

    // Each stamp points at where the value actually sits in THIS payload.
    expect(byCell.get('deploy.3070.sha')?.path).toBe('deployedSha');
    expect(byCell.get('gate.greenCheckpoint.candidate')?.path).toBe('changeInCandidate.judgingSha');
  });

  /**
   * A no-arg call is legal (P-007/D-067: the three global cells resolve through it). The
   * per-path legs are then unmeasured, so their stamps must not hand back an unqualified
   * handle that would answer about a different subject.
   */
  it('on a no-arg call, stamps the globals and refuses to fake a caller-relative handle', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...full,
      input: { path: null, sha: null },
      runtime: undefined,
      runtimes: undefined,
    } as unknown as PipelinePosition);

    const plane = planeOf((await tool.handler({} as never, CTX as never)) as Out)!;
    const byCell = new Map(plane.cells.map((c) => [c.cell, c]));

    expect(byCell.get('deploy.3070.sha')?.reread?.args).toEqual({ cell: 'deploy.3070.sha' });

    const relative = byCell.get('gate.greenCheckpoint.candidate');
    expect(relative?.reread, 'must NOT emit an unqualified handle for a per-path cell').toBeUndefined();
    expect(relative?.unreadable?.needs).toBe('path');
  });

  /** A null reading is the one a caller must least transcribe — the stamp must survive it. */
  it('still stamps a value that is present-and-NULL', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      ...full,
      deployedSha: null,
      runtime: single,
      runtimes: [single],
    } as unknown as PipelinePosition);
    const plane = planeOf((await tool.handler({ path: PATH } as never, CTX as never)) as Out)!;
    expect(plane.cells.some((c) => c.cell === 'deploy.3070.sha')).toBe(true);
  });

  /** The enrichment must never break the door it decorates. */
  it('degrades to no block rather than throwing when the payload carries nothing stampable', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({
      input: { path: null, sha: null },
      summary: 'nothing measured',
      notes: [],
    } as unknown as PipelinePosition);
    const out = (await tool.handler({} as never, CTX as never)) as Out;
    expect(out.data.plane).toBeUndefined();
    expect(out.data.summary).toBe('nothing measured');
  });
});

/**
 * EI-20742070351584478 — `gitPipelinePosition` reads the operator-home pipeline,
 * not the caller's harness pipeline. Keep that scope visible so a SideStage
 * caller cannot quote Papercusp gate/deploy values as its own release truth.
 */
describe('dev:pipeline_position subject disclosure', () => {
  type Out = { data: Record<string, unknown> };

  const base = {
    input: { path: 'apps/operator/app/x.ts', sha: null },
    repoRoot: '/test/integration-root',
    submodule: null,
    targetSha: 'sha0000001',
    targetShortSha: 'sha000000',
    targetSubject: 'subject',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    deployedSha: 'sha0000001',
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
    verdictProvenance: {
      lastGreenSha: 'sha0000001',
      lastGreenShortSha: 'sha000000',
      lastGreenAgeMs: 1000,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    summary: 'stub summary',
    notes: [],
  } as unknown as PipelinePosition;

  const release: RuntimeOwnership = {
    host: 'operator-release',
    releasePipelineApplies: true,
    restartTarget: 'staging',
    activation: 'deploy',
  };
  const staging: RuntimeOwnership = {
    host: 'bg-host',
    releasePipelineApplies: false,
    restartTarget: 'bg-host',
    activation: 'restart bg-host',
  };

  it('stamps the operator-home pipeline and warns a foreign caller', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({ ...base, runtime: release, runtimes: [release] });

    const out = (await tool.handler(
      { path: 'apps/operator/app/x.ts' } as never,
      { role: 'cup', harnessSlug: 'sidestage' } as never,
    )) as Out;

    expect(out.data.subject).toMatchObject({
      harness: 'test-home',
      scope: 'operator-home-release-pipeline',
      integrationRoot: '/test/integration-root',
    });
    expect(out.data.subject).toMatchObject({ note: expect.stringContaining('test-home') });
    expect(out.data.harnessMismatch).toMatchObject({
      callerHarness: 'sidestage',
      reportedHarness: 'test-home',
    });
    expect((out.data.harnessMismatch as { warning: string }).warning).toContain('sidestage');
    expect((out.data.harnessMismatch as { warning: string }).warning).toContain('test-home');
  });

  it('stamps every activation exit and does not invent a mismatch for same or wildcard callers', async () => {
    const exits = [
      { runtime: release, runtimes: [release] },
      { runtime: staging, runtimes: [staging] },
      { runtime: staging, runtimes: [staging, release] },
    ];

    for (const result of exits) {
      vi.mocked(gitPipelinePosition).mockResolvedValue({ ...base, ...result });
      const foreign = (await tool.handler(
        { path: 'apps/operator/app/x.ts' } as never,
        { role: 'cup', harnessSlug: 'sidestage' } as never,
      )) as Out;
      expect(foreign.data.subject).toMatchObject({ harness: 'test-home' });
      expect(foreign.data.harnessMismatch).toMatchObject({ callerHarness: 'sidestage' });

      for (const harnessSlug of ['test-home', '*', undefined]) {
        vi.mocked(gitPipelinePosition).mockResolvedValue({ ...base, ...result });
        const same = (await tool.handler(
          { path: 'apps/operator/app/x.ts' } as never,
          { role: 'cup', harnessSlug } as never,
        )) as Out;
        expect(same.data.subject).toMatchObject({ harness: 'test-home' });
        expect(same.data.harnessMismatch).toBeUndefined();
      }
    }
  });

  it('canonicalizes a retired foreign harness alias before warning', async () => {
    vi.mocked(gitPipelinePosition).mockResolvedValue({ ...base, runtime: release, runtimes: [release] });
    const out = (await tool.handler(
      { path: 'apps/operator/app/x.ts' } as never,
      { role: 'cup', harnessSlug: 'papercup' } as never,
    )) as Out;

    expect(out.data.harnessMismatch).toMatchObject({ callerHarness: 'papercusp', reportedHarness: 'test-home' });
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import type { FlagAttestation } from '@papercusp/flags/server';
import type { JournalReadResult } from '../journal-read';
import type { Rubric } from '../rubrics';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import { assessDreamR2ClauseAssertions, readDreamControlObservations } from './dream-control-observations';
import { DREAM_ACTION_DECISION_PREFIX, DREAM_ADMISSION_GATES } from './dream-config';
import { GYM_ADMISSION_DECISION_PREFIX, GYM_ADMISSION_GATES } from '../gym/autoloop-tick';
import {
  DREAM_CONTROL_LIVE_INSTRUMENT_KEY as key, DREAM_CONTROL_SOURCE_PLAN as plan,
  DREAM_CONTROL_LIVE_SPEC, DREAM_CONTROL_RUNTIME_UNITS as units, DREAM_CONTROL_LIVE_SOURCES as paths,
  DREAM_CONTROL_LIVE_TEST as testFile, dreamControlEditionDigest, measureDreamControlLiveEdition,
  type DreamControlLiveDeps,
} from './dream-control-live-instrument';

const captured = Date.parse('2026-10-22T12:00:00.000Z');
const iso = (delta: number) => new Date(captured + delta).toISOString();
const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const build = 'a'.repeat(40);
const api = { host: 'port-3170', processId: 'linux:boot:100', buildSha: build };
const bg = { host: 'port-3271', processId: 'linux:boot:200', buildSha: build };
const input = { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: plan,
  windowStart: iso(-900_000), windowEnd: iso(-1_000) };
type Row = Record<string, unknown>;

/** Controlled unit fixture runs the maintained observation reader. It is never
 * persisted or labelled as a live observation. */
async function fixture() {
  const scope = { workspaceId: input.workspaceId, potSlug: input.harnessSlug,
    since: input.windowStart, until: input.windowEnd, expectedRuntime: api,
    actionJournalUnit: 'papercusp-bg-host.service', expectedActionRuntime: bg,
    gymJournalUnit: 'papercusp-bg-host.service', expectedGymRuntime: bg };
  const tick = (id: string, lens: string) => ({ id, workspace_id: 'ws', pot_slug: 'papercusp',
    origin: 'scout', tick_at: iso(-2_000), status: 'ran', ideas_routed: 0, budget_used_usd: 0.12,
    detail: { ideators: [{ lens, ok: true, raw: 0, produced: 0 }], budgetProvenance: { schemaVersion: 1,
      supplied: { maxIdeators: 1, maxCostUsd: 0.2 }, resolved: { maxIdeators: 1, maxCostUsd: 0.2, maxCriticsPerIdea: 2 } } } });
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?');
    expect(query.trim()).toMatch(/^SELECT\b/);
    if (query.includes('FROM harness_shared.routines')) return ['auto', 'manual'].map(mode => ({
      name: `dream-cycle-${mode}`, active: false, next_fire_at: null, metadata: {}, payload_template: { mode, cycle: {} } }));
    if (query.includes('FROM harness_shared.gym_autoloop_config')) return [{ workspace_id: 'ws', harness_slug: 'papercusp',
      enabled: true, budget_usd: 2, spent_usd: 0.25, status: 'idle', last_cycle: null, last_cycle_at: null, updated_at: captured }];
    if (query.includes('FROM harness_shared.learning_governor_loops')) return [{ workspace_id: 'ws', loop_id: values[1],
      pot_slug: 'papercusp', budget_kind: 'per-cycle', budget_usd: null, spent_usd: 0, enabled: true,
      enforcement: 'native', registered_at: new Date(captured), updated_at: new Date(captured) }];
    if (query.includes('FROM harness_shared.scout_ticks')) return [tick('one', 'analogical'), tick('two', 'counterfactual')];
    return [];
  }) as unknown as Sql;
  const action = { schemaVersion: 1, actionId: 'dream', workspaceId: 'ws', potSlug: 'papercusp',
    capturedAt: scope.since, runtime: bg, source: 'dream/dream-cycle-action:makeDreamCycleAction', mode: 'auto',
    reason: 'owner-idle-disabled', disposition: 'pre-attempt-policy-skip', paidCalls: 0, model: null, usage: null, costUsd: 0,
    admission: DREAM_ADMISSION_GATES.map((gate, index) => ({ gate,
      status: index === 0 ? 'passed' : index === 1 ? 'refused' : 'not-reached', inputs: {} })) };
  const gym = ['owner-idle', ...GYM_ADMISSION_GATES].map(gate => ({ schemaVersion: 1, actionId: 'gym',
    workspaceId: 'ws', potSlug: gate === 'owner-idle' ? null : 'papercusp', capturedAt: scope.since, runtime: bg,
    source: 'harness/routines/gym-actions:runGymCycleInline', gate, status: 'passed', inputs: {} }));
  const journal = (rows: Row[], prefix: string): JournalReadResult => ({ journalAvailable: true, journalError: null,
    backend: 'systemd', matched: rows.length, collapsed: 0, truncated: false,
    window: { since: scope.since, until: scope.until, resolved: null }, units: [scope.actionJournalUnit], unitsUnknown: [],
    windowOutsideJournal: null, command: 'controlled-unit-fixture', entries: rows.map(row => ({ ts: scope.since,
      unit: scope.actionJournalUnit, level: 'info', repeat: 1, message: prefix + JSON.stringify(row) })) });
  const flag = (flagKey: FlagAttestation['key']): FlagAttestation => ({ key: flagKey, resolvedValue: true, compiledDefault: true,
    source: 'env-override', observedAtMs: captured, backendConfigured: false, overrideRead: { kind: 'not-read',
      storeConfigured: false, cacheKey: 'fixture', cacheGeneration: null, cacheLoadedAtMs: null, cacheAgeMs: null,
      ttlMs: 5000, ttlRemainingMs: 0, loadError: null } });
  const observation = await readDreamControlObservations(sql, scope, { now: () => captured, workspace: () => 'ws', runtime: () => api,
    flags: async () => ({ dream: flag(FLAGS.DREAM_CYCLE), learningGovernor: flag(FLAGS.LEARNING_GOVERNOR) }),
    journal: async request => request.grep === DREAM_ACTION_DECISION_PREFIX
      ? journal([action], DREAM_ACTION_DECISION_PREFIX) : journal(gym, GYM_ADMISSION_DECISION_PREFIX) });
  expect(observation.r2Assertions.healthy, JSON.stringify(observation.r2Assertions)).toBe(true);
  const artifact = { schemaVersion: 1, kind: 'dream-control-operational-method-edition', pinnedCommit: build,
    sourceFiles: paths.map(path => ({ path, sha256: sha(`controlled source:${path}`) })),
    nativeOperationalRun: { ok: true, runGroupId: 'operational-native:fixture', testRunIds: [19], status: 'pass', runtimeEnvironmentMeasured: true },
    edition: { consumedAt: iso(100), observation } };
  const witness = (delta: number) => ({ schemaVersion: 1, units: [...units], fingerprint: 'b'.repeat(64), observedAt: iso(delta) });
  const execution = { schemaVersion: 1, root: '/controlled-unit-fixture', filePath: testFile,
    runGroupId: artifact.nativeOperationalRun.runGroupId, workspaceId: 'ws', harnessSlug: 'papercusp', testNamePattern: null,
    passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null, commitSha: build, worktreeDirty: false,
    operational: { schemaVersion: 1, command: ['npm', 'run', 'test:file', '--', testFile] },
    runtimeEnvironmentBefore: witness(-100), runtimeEnvironmentAfter: witness(200),
    passedCaseTitles: [`method:edition-sha256:${dreamControlEditionDigest(artifact.edition)}`] };
  const run = { id: 19, framework: 'operational', file_path: testFile, status: 'pass', finished_at: iso(200),
    workspace_id: 'ws', harness_slug: 'papercusp', run_group_id: execution.runGroupId, commit_sha: build,
    worktree_dirty: false, execution_details: execution };
  const binding = { id: 23, planSlug: plan, specId: DREAM_CONTROL_LIVE_SPEC, specRevision: 3, currentRevision: 3, testRunId: run.id,
    details: { dreamLiveEdition: { relPath: 'verification/controlled-unit-fixture.json', sha256: sha(JSON.stringify(artifact)) } },
    currentness: { overall: 'current', provenance: 'server-measured', comparisonSupplied: true, staleReasons: [], unknownReasons: [],
      dimensions: { spec: 'current', source: 'current', test: 'current', fixture: 'current', environment: 'current', testRun: 'current',
        rubric: 'not-applicable', coverageEvidence: 'not-applicable' } },
    serverMeasurement: { status: 'measured', measuredAtCommit: build, measuredDimensions: ['source', 'test', 'fixture', 'environment'] } };
  const runtimes = units.map((unit, i) => ({ workspaceId: 'ws', unit, host: 'controlled-unit-fixture', treeSha: build,
    buildTime: iso(-10_000), bundleVersion: null, pid: i + 1, extra: { kernelProcessIdentity: i ? bg.processId : api.processId }, reportedAt: iso(-100) }));
  const deps: DreamControlLiveDeps = { now: () => captured + 1000,
    bindings: vi.fn(async () => [binding]) as unknown as DreamControlLiveDeps['bindings'],
    artifact: vi.fn(async () => JSON.stringify(artifact)), runs: vi.fn(async () => [run]),
    runtimes: vi.fn(async () => runtimes), runtimeFingerprint: vi.fn(() => 'b'.repeat(64)),
    source: vi.fn(async (_ref, path) => `controlled source:${path}`) };
  const repinArtifact = () => { binding.details.dreamLiveEdition.sha256 = sha(JSON.stringify(artifact)); };
  return { deps, artifact, binding, run, execution, runtimes, repinArtifact };
}

describe('Dream R4 structured current live edition instrument', () => {
  it('connects canonical edition, measured current binding, native consumed hash, two runtimes and all five maintained product clauses', async () => {
    const f = await fixture();
    const measured = await measureDreamControlLiveEdition(input, f.deps);
    expect(measured, JSON.stringify(measured)).toMatchObject({ verdict: 'pass', bindingId: 23, consumedAt: iso(100) });
    expect(measured.clauses).toHaveLength(5);
    expect(f.deps.bindings).toHaveBeenCalledWith(expect.objectContaining({ current: true, specIds: [DREAM_CONTROL_LIVE_SPEC] }));
    expect(f.deps.source).toHaveBeenCalledWith(build, testFile);
    expect(f.deps.runtimeFingerprint).toHaveBeenCalledWith(f.runtimes, units);
  });

  it.each(['api-only', 'background-process', 'background-build', 'wrong-unit', 'wrong-window', 'expired',
    'restamped', 'hash-mismatch', 'stale-binding', 'unknown-binding', 'attested-binding', 'fixture-unchecked',
    'missing-clause', 'forged-green-clause', 'dispatch-only', 'native-hash-mismatch', 'changed-runtime',
    'source-hash', 'test-hash', 'fixture-hash', 'missing-source', 'dirty-run', 'wrong-run'] as const)(
    'refuses %s instead of accepting a stored green label', async fault => {
      const f = await fixture();
      expect((await measureDreamControlLiveEdition(input, f.deps)).verdict).toBe('pass');
      if (fault === 'api-only') f.runtimes.pop();
      if (fault === 'background-process') f.runtimes[1].extra.kernelProcessIdentity = 'replacement';
      if (fault === 'background-build') f.runtimes[1].treeSha = 'c'.repeat(40);
      if (fault === 'wrong-unit') f.runtimes[1].unit = 'other.service';
      if (fault === 'wrong-window') f.artifact.edition.observation.scope.until = iso(-2_000);
      if (fault === 'expired') f.deps.now = () => captured + 60_000;
      if (fault === 'restamped') { f.artifact.edition.observation.capturedAt = iso(1); f.artifact.edition.observation.expiresAt = iso(60_001); }
      if (fault === 'stale-binding') f.binding.currentness.dimensions.environment = 'stale';
      if (fault === 'unknown-binding') f.binding.currentness.dimensions.source = 'unknown';
      if (fault === 'attested-binding') f.binding.currentness.provenance = 'attested-current';
      if (fault === 'fixture-unchecked') f.binding.currentness.dimensions.fixture = 'not-applicable';
      if (fault === 'missing-clause') f.artifact.edition.observation.r2Assertions.clauses.pop();
      if (fault === 'forged-green-clause') f.artifact.edition.observation.r2Assertions.clauses[0].reason = 'fabricated';
      if (fault === 'dispatch-only' && 'actionDecisions' in f.artifact.edition.observation
        && f.artifact.edition.observation.actionDecisions.status === 'observed')
        f.artifact.edition.observation.actionDecisions.value.journal.entries = [];
      if (fault === 'native-hash-mismatch') f.execution.passedCaseTitles = ['method:edition-sha256:' + 'f'.repeat(64)];
      if (fault === 'changed-runtime') f.deps.runtimeFingerprint = () => 'c'.repeat(64);
      if (fault === 'source-hash' || fault === 'test-hash' || fault === 'fixture-hash') {
        const changed = fault === 'source-hash' ? paths[0] : fault === 'test-hash' ? testFile : paths.at(-1)!;
        f.deps.source = async (_ref, path) => path === changed ? 'changed bytes' : `controlled source:${path}`;
      }
      if (fault === 'missing-source') f.artifact.sourceFiles.pop();
      if (fault === 'dirty-run') f.run.worktree_dirty = true;
      if (fault === 'wrong-run') f.run.id = 20;
      // Authenticate semantic mutations as a freshly consumed controlled edition
      // so each detector, rather than the native hash guard alone, must reject it.
      if (!['restamped', 'hash-mismatch', 'native-hash-mismatch'].includes(fault))
        f.execution.passedCaseTitles = [`method:edition-sha256:${dreamControlEditionDigest(f.artifact.edition)}`];
      if (fault !== 'hash-mismatch') f.repinArtifact();
      else f.binding.details.dreamLiveEdition.sha256 = 'f'.repeat(64);
      expect((await measureDreamControlLiveEdition(input, f.deps)).verdict).toBe('unknown');
    },
  );

  it('expires during collection without restamping the original consumer time', async () => {
    const f = await fixture();
    f.deps.now = vi.fn().mockReturnValueOnce(captured + 1000).mockReturnValue(captured + 60_000);
    expect(await measureDreamControlLiveEdition(input, f.deps)).toMatchObject({ verdict: 'unknown', consumedAt: iso(100) });
  });

  it.each(['fail', 'unknown'] as const)('preserves a measured %s product clause after the live identity joins pass', async verdict => {
    const f = await fixture();
    const observation = f.artifact.edition.observation;
    const activity = observation.observations?.activity;
    if (!activity || activity.status !== 'observed') throw Error('controlled activity missing');
    const scout = (activity.value as { scout: { observations: Array<{ suppliedOneIdeatorCapRespected: boolean | null }> } }).scout;
    scout.observations[0].suppliedOneIdeatorCapRespected = verdict === 'fail' ? false : null;
    observation.r2Assertions = assessDreamR2ClauseAssertions(observation, captured + 100);
    f.execution.passedCaseTitles = [`method:edition-sha256:${dreamControlEditionDigest(f.artifact.edition)}`];
    f.repinArtifact();
    const measured = await measureDreamControlLiveEdition(input, f.deps);
    expect(measured).toMatchObject({ verdict, clauses: expect.arrayContaining([
      expect.objectContaining({ id: 'r2:scout-zero-route-lens-cap-provenance', status: verdict }),
    ]) });
  });

  it('keeps an unavailable canonical artifact unknown', async () => {
    const f = await fixture(); f.deps.artifact = async () => { throw Error('canonical store unavailable'); };
    expect(await measureDreamControlLiveEdition(input, f.deps)).toMatchObject({ verdict: 'unknown' });
  });

  it('does not rescue the latest invalid binding with an older pass', async () => {
    const f = await fixture();
    f.deps.bindings = vi.fn(async () => [f.binding, { ...f.binding, id: 24, currentness: { ...f.binding.currentness, overall: 'stale' } }]) as unknown as DreamControlLiveDeps['bindings'];
    expect(await measureDreamControlLiveEdition(input, f.deps)).toMatchObject({ verdict: 'unknown', bindingId: 24 });
  });

  const rubric = { workspaceId: 'ws', subjectPlan: plan, subjectHarnessSlug: 'papercusp',
    // The maintained dual binding preserves R4's named METHOD tests while
    // independently requiring the live instrument on that same criterion.
    criteria: [{ key: 'r-4', check: { kind: 'tests', files: [testFile] }, instrumentKey: key }] } as unknown as Rubric;
  const subject = { kind: 'plan' as const, ref: plan, windowStart: input.windowStart, windowEnd: input.windowEnd };
  it.each(['pass', 'fail', 'unknown'] as const)('scorecard stores independently resolved %s over a supplied pass', async verdict => {
    const dreamControlLive = vi.fn(async () => ({ verdict, reason: 'controlled unit result', evidenceRefs: ['spec-evidence:23'] }));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject,
      supplied: { [key]: { verdict: 'pass', provenance: 'platform-computed', measuredAt: iso(1000) } } },
    { now: () => captured + 1000, dreamControlLive });
    expect(snapshots?.[key]).toMatchObject({ verdict, provenance: 'platform-computed', value: { evidenceRefs: ['spec-evidence:23'] } });
    expect(dreamControlLive).toHaveBeenCalledWith(input);
  });

  it('scorecard refuses a foreign plan before collecting live evidence', async () => {
    const dreamControlLive = vi.fn();
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject: { ...subject, ref: 'foreign' } }, { dreamControlLive });
    expect(snapshots?.[key]?.verdict).toBe('unknown');
    expect(dreamControlLive).not.toHaveBeenCalled();
  });
});

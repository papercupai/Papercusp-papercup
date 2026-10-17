/**
 * compaction-compliance-watchdog.test.ts — seeding + over-limit sweep
 * (agent-managed-compaction P-009 · context-trimming-tiers P-006/D-006).
 *
 * The seeding step is THE hook that arms agent-managed compaction: the
 * P-007 usage signal and self-compaction only engage for sessions whose
 * presence row carries a compaction_limit, and nothing else writes one by
 * default. Mocks the estimator/spec-resolver/presence writes; drives the
 * sweep with a fake `sql` tag that answers the two queries by shape.
 *
 * Run: cd packages/operator-core && npx vitest run lib/system-health/compaction-compliance-watchdog.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { join } from 'node:path';
import type { ResolveResumeResult } from '../agent-launch-core';
import type { CompactionForceSuccessorInput, CompactionForceSuccessorResult } from './compaction-force-successor';

const {
  estimateMock,
  observedPromptFloorMock,
  contextWindowMock,
  specMock,
  setEstimateMock,
  setLimitMock,
  deathMock,
  toolRefDeathMock,
  resolveSessionRefMock,
  resolveSessionRefReconciledMock,
  resolveLaunchLimitMock,
  openEscalationMock,
  listEscalationsMock,
  resolveEscalationMock,
  getFlagMock,
  findLiveHostMock,
  hostSupportsMock,
  injectMock,
  findTranscriptMock,
  newestTranscriptMock,
  buildOwnerRespawnMock,
  resolveSelfSessionMock,
  writePresenceMock,
  clearEstimateMock,
  codexProvenanceMock,
  runFlushGateMock,
  resolveResumeTargetMock,
} = vi.hoisted(() => ({
  clearEstimateMock: vi.fn(async () => {}),
  // EI-21595542328480968: where a codex reading came from. Default null = "not codex /
  // no rollout", which keeps every pre-existing test on the trusted path.
  codexProvenanceMock: vi.fn(
    async (_owner: string) =>
      null as null | {
        rolloutPath: string;
        rolloutMtimeMs: number | null;
        rolloutSessionId: string | null;
        refSessionId: string | null;
      },
  ),
  estimateMock: vi.fn(),
  observedPromptFloorMock: vi.fn(() => null as null | { tokens: number; observations: number; at: number }),
  contextWindowMock: vi.fn(async (_owner: string) => null as number | null),
  specMock: vi.fn(),
  setEstimateMock: vi.fn(async () => true),
  setLimitMock: vi.fn(async () => {}),
  deathMock: vi.fn(async (_owner: string) => false),
  // WI-10003466: default null = no tool-reference death, so every pre-existing
  // test keeps its sweep path unchanged.
  toolRefDeathMock: vi.fn(
    async (_owner: string) =>
      null as null | { turns: number; toolName: string | null; evidence: string | null },
  ),
  resolveSessionRefMock: vi.fn(
    async (_owner: string) => null as null | { agent: string | null; sessionId: string | null; sessionKey?: number | null },
  ),
  resolveSessionRefReconciledMock: vi.fn(
    async (_owner: string) =>
      null as null | {
        agent: string | null;
        sessionId: string | null;
        sessionKey?: number | null;
        transcriptOwner?: string | null;
      },
  ),
  // P-005 per-member-declarative-launch-specs: an EXPLICIT psu --compaction-limit
  // on the recorded launch argv. Default null (no override) keeps every existing
  // seeding test's spawn-record/resolver precedence expectations unaffected.
  resolveLaunchLimitMock: vi.fn(async (_owner: string) => null as number | null),
  openEscalationMock: vi.fn(async () => ({ msg_id: 'esc-1' })),
  // WI-2140608: recoverBootConfig looks up + resolves the open dark-telemetry row.
  listEscalationsMock: vi.fn(
    async (_opts?: { status?: 'open' | 'resolved' }) => [] as Array<Record<string, unknown>>,
  ),
  resolveEscalationMock: vi.fn(
    async (_input: { msg_id: string; choice: string; resolver?: string; note?: string }) => ({ msg_id: 'esc-1' }),
  ),
  // P-012 force-compact deps. Defaults keep the EXISTING over-limit tests unaffected:
  // flag ON but NO live host ⇒ maybeForceCompact no-ops (out.forceCompacted stays []).
  getFlagMock: vi.fn(async (_key: string, _scope?: string) => true),
  findLiveHostMock: vi.fn((_ownerId: string) => null as null | { sock: string; caps?: string[] }),
  hostSupportsMock: vi.fn((_host: unknown, _cap: string) => false),
  injectMock: vi.fn(async (_sock: string, _payload: unknown) => true),
  findTranscriptMock: vi.fn(async () => '/tmp/live-session.jsonl' as string | null),
  newestTranscriptMock: vi.fn((_ownerId: string) => null as string | null),
  buildOwnerRespawnMock: vi.fn(async () => ({
    systemPromptAddendum: 'deterministic carry',
    firstPrompt: null as string | null,
    budgetChars: 32_000,
    openOwnerQuestion: { crossesOpenOwnerMessage: false },
  })),
  resolveSelfSessionMock: vi.fn(async () => null as null | { filePath: string; sourceKind: string }),
  writePresenceMock: vi.fn(async () => {}),
  runFlushGateMock: vi.fn(async () => ({ verdict: 'clear' as const, tripwires: [] })),
  // The watchdog tests use fakeSql for the sweep query; keep the new hostless
  // resolver off real PG unless a case explicitly injects its own fixture.
  resolveResumeTargetMock: vi.fn(async (_ref: { agentId?: string | null; sessionId?: string | null }) => ({
    ok: false as const,
    error: 'not_found' as const,
    detail: 'no fixture source',
  })),
}));
vi.mock('../compaction-usage', () => ({
  observeHealthyClaudeTranscriptForOwner: async () => null,
  estimateContextTokensForOwner: estimateMock,
  observedPromptFloorForOwner: observedPromptFloorMock,
  estimateContextWindowForOwner: contextWindowMock,
  resolveModelSpecForOwner: specMock,
  detectContextDeathForOwner: deathMock,
  detectToolReferenceDeathForOwner: toolRefDeathMock,
  resolveSessionRef: resolveSessionRefMock,
  // EI-13477: the watchdog now resolves through the RECONCILED ref (same
  // reasoning as resolveLiveTranscriptPath in compaction-usage.ts) — route it
  // to the SAME configurable mock so every existing resolveSessionRefMock
  // stub in this file keeps driving both import names identically.
  resolveSessionRefReconciled: resolveSessionRefReconciledMock,
  resolveLaunchCompactionLimitForOwner: resolveLaunchLimitMock,
  codexReadingProvenanceForOwner: codexProvenanceMock,
}));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../agent-launch-core', () => ({ resolveResumeTarget: resolveResumeTargetMock }));
// Original-producer observation outcomes are asserted by the canonical rail cases.
// This unit fixture must never flush incidental observations to the live database.
vi.mock('../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  readConditionEnvelopes: async () => [], computeConditionStates: () => [],
}));
vi.mock('../agent-tools/coordination/log', () => ({
  coordScopeReady: vi.fn(async () => {}),
  coordScopeWorkspace: vi.fn(() => 'workspace'),
}));
vi.mock('../agent-tools/coordination/presence', () => ({
  setContextEstimate: setEstimateMock,
  clearContextEstimate: clearEstimateMock,
  setCompactionLimit: setLimitMock,
  writePresence: writePresenceMock,
}));
vi.mock('../agent-tools/coordination/escalations', () => ({
  openEscalation: openEscalationMock,
  listEscalations: listEscalationsMock,
  resolveEscalation: resolveEscalationMock,
}));
// P-012/P-018: force-compact + deterministic carry-respawn rollout deps.
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagMock }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    COMPACTION_WATCHDOG_FORCE_COMPACT: 'papercusp-compaction-watchdog-force-compact',
    CONTEXT_GAUGE: 'papercusp-context-gauge',
    GATEWAY_MAINTENANCE_CARRY: 'papercusp-gateway-maintenance-carry',
  },
}));
vi.mock('../events/await/psu-pty-discovery', () => ({
  findLiveHost: findLiveHostMock,
  findLiveHostAsync: async (ownerId: string) => findLiveHostMock(ownerId),
  hostSupports: hostSupportsMock,
  injectIntoHost: injectMock,
}));
vi.mock('../claude-sessions', () => ({
  findSessionTranscript: findTranscriptMock,
  newestTranscriptUnderOwner: newestTranscriptMock,
}));
vi.mock('../carry-respawn', () => ({
  buildOwnerRespawnLaunchSpec: buildOwnerRespawnMock,
}));
vi.mock('../search/self-session', () => ({
  resolveSelfSession: resolveSelfSessionMock,
}));
vi.mock('../enforcement-gate-io', () => ({
  runFlushGate: runFlushGateMock,
}));
// The spawn-record honor leg lazily imports the tier menu — pin a small one so
// the test never reads the real workspace agent-config.
vi.mock('../agent-config', () => ({
  readAgentConfig: async () => ({
    tiers: [{ name: 'deep', spec: 'opus:high', compactionLimit: 120_000 }],
  }),
}));
vi.mock('../fleet/model-tiers', () => ({
  effectiveTierConfig: (cfg: { tiers?: unknown } | null) => ({ tiers: cfg?.tiers }),
}));

import {
  checkCompactionCompliance,
  detectCompactionStranding,
  resetContextDeathEscalationsForTests,
  resetCarryRespawnForTests,
  resetForceCompactedForTests,
  resetBootConfigAssertForTests,
  resetNoHostWarnedForTests,
  resetImplausibleReadingsForTests,
  resetFrozenCodexReadingsForTests,
  staleCutoversForProcessStart,
  resetStaleCutoverEscalationsForTests,
  resetCompactionStrandingForTests,
  startCompactionComplianceWatchdog,
  WATCHDOG_BEHAVIOR_CUTOVERS,
  discoverPresencelessLoopOwners,
  carryRespawnLoopEscalationBody,
  carryRespawnStreakVerdict,
  compactionConditionKey,
  type CompactionComplianceDeps,
} from './compaction-compliance-watchdog';
import {
  getContextUsage,
  isContextGaugeEnabled,
  resetContextUsageCacheForTests,
} from './context-usage-cache';
import { defaultCompactionLimitForWindow, MODEL_WINDOW_1M, MODEL_WINDOW_DEFAULT } from '../agent-config-constants';

/** Fake postgres tag: routes on the query text — the seed query selects
 *  `compaction_limit IS NULL`, the sweep `IS NOT NULL`, the honor leg reads
 *  `spawned_agents` keyed by the interpolated ownerId (first tag value). */
const observedSqlQueries: Array<{ query: string; values: unknown[] }> = [];

function fakeSql(opts: {
  unseeded?: Array<{ owner_id: string; fleet_slug?: string | null; fleet_role?: string | null }>;
  seeded?: Array<{
    owner_id: string;
    owner_label: string;
    workspace_id?: string;
    compaction_limit: number;
    compaction_limit_explicit?: boolean | null;
    fleet_slug?: string | null;
    fleet_role?: string | null;
    /** Latest eligible turn call returned by the bounded, session-scoped probe. */
    last_turn_at?: string | Date | null;
    last_turn_session_id?: string | null;
    active_session_id?: string | null;
    active_session_started_at?: string | Date | null;
    /** Fresh hook-only presence activity used to guard against false turn evidence. */
    last_active_at?: string | null;
  }>;
  /** Legacy raw rows guard against bypassing the shared liveness oracle. */
  legacyUnendedSessionOwners?: string[];
  /** Exercise the fail-open condition-family read path. */
  conditionEpisodesError?: boolean;
  /** Open compaction episodes returned by the family-scoped lifecycle read. */
  conditionEpisodes?: Array<{ condition_key: string; opened_at: string | Date }>;
  spawnRecords?: Record<string, { model_spec: string | null; model_tier: string | null }>;
  /** P-003: claim-freshness rows keyed by owner (the work_item_claims⋈carry_notes read). */
  claimFreshness?: Record<
    string,
    Array<{ work_item_id: string; acquired_ms: string; last_activity_ms: string; checkpoint_updated_ms: string | null }>
  >;
  /** EI-18127246030401689: active-loop owners with no coord_presence row. */
  presenceGaps?: Array<{ owner_id: string; workspace_id: string | null }>;
  /** owner_id → label, from harness_shared.fleet_membership_events. */
  fleetLabels?: Record<string, string>;
  /** D-137: exact event-latch evidence keyed by owner. */
  compactionBoundaries?: Array<{
    event_key: string;
    fire_count: number | string;
    last_fired_at: string | Date;
  }>;
  /** D-137: target paths stored on the live work-item payload. */
  targetPaths?: Array<{ work_item_id: string; paths: string[] }>;
  /** D-137: attributed target edits after the latest compaction boundary. */
  targetEdits?: Array<{ file: string; edited_ms: number | string }>;
}) {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    observedSqlQueries.push({ query: q, values });
    if (q.includes('harness_shared.routines') && q.includes('target_owner_id')) {
      return Promise.resolve(opts.presenceGaps ?? []);
    }
    if (q.includes('harness_shared.event_key_fires')) {
      return Promise.resolve(opts.compactionBoundaries ?? []);
    }
    if (q.includes('harness_shared.edit_attribution_ledger')) {
      return Promise.resolve(opts.targetEdits ?? []);
    }
    if (q.includes('harness_shared.work_items') && q.includes("payload->'paths'")) {
      return Promise.resolve(opts.targetPaths ?? []);
    }
    if (q.includes('fleet_membership_events')) {
      const label = opts.fleetLabels?.[String(values[0])];
      return Promise.resolve(label ? [{ owner_label: label }] : []);
    }
    if (q.includes('harness_shared.coord_presence cp') && q.includes('harness_shared.adv_sessions s')) {
      return Promise.resolve(opts.seeded ?? []);
    }
    if (q.includes('harness_shared.adv_sessions') && q.includes('ended_at IS NULL')) {
      const owners = opts.legacyUnendedSessionOwners ?? [];
      return Promise.resolve(owners.map((owner_id) => ({ owner_id })));
    }
    if (q.includes('harness_shared.coord_event_log') && q.includes('jsonb_array_elements_text')) {
      if (opts.conditionEpisodesError) return Promise.reject(new Error('condition query failed'));
      return Promise.resolve(opts.conditionEpisodes ?? []);
    }
    if (q.includes('compaction_limit IS NULL')) return Promise.resolve(opts.unseeded ?? []);
    if (q.includes('compaction_limit IS NOT NULL')) return Promise.resolve(opts.seeded ?? []);
    if (q.includes('spawned_agents')) {
      const rec = opts.spawnRecords?.[String(values[0])];
      return Promise.resolve(rec ? [rec] : []);
    }
    // P-003 freshness read: `c.owner = ${owner}` is the first interpolated value.
    if (q.includes('work_item_claims')) return Promise.resolve(opts.claimFreshness?.[String(values[0])] ?? []);
    return Promise.resolve([]);
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  observedSqlQueries.length = 0;
  estimateMock.mockResolvedValue(null);
  observedPromptFloorMock.mockReturnValue(null);
  contextWindowMock.mockResolvedValue(null);
  specMock.mockResolvedValue(null);
  setEstimateMock.mockResolvedValue(true);
  setLimitMock.mockResolvedValue(undefined);
  deathMock.mockResolvedValue(false);
  toolRefDeathMock.mockResolvedValue(null);
  clearEstimateMock.mockResolvedValue(undefined);
  codexProvenanceMock.mockResolvedValue(null);
  resetFrozenCodexReadingsForTests();
  resolveLaunchLimitMock.mockResolvedValue(null);
  openEscalationMock.mockResolvedValue({ msg_id: 'esc-1' });
  listEscalationsMock.mockResolvedValue([]);
  resolveEscalationMock.mockResolvedValue({ msg_id: 'esc-1' });
  // Keep the existing gauge + force rung ON, but the shared P-017/P-018 cutover
  // OFF by default. Individual carry tests opt in explicitly.
  getFlagMock.mockImplementation(
    async (key: string) => key !== 'papercusp-gateway-maintenance-carry',
  );
  findLiveHostMock.mockReturnValue(null);
  hostSupportsMock.mockReturnValue(false);
  injectMock.mockResolvedValue(true);
  findTranscriptMock.mockResolvedValue('/tmp/live-session.jsonl');
  // P-022: provide a stable native session for estimate fencing in this fixture.
  newestTranscriptMock.mockReturnValue('/tmp/live-session.jsonl');
  resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-current', sessionKey: 1 });
  resolveSessionRefReconciledMock.mockImplementation((owner: string) => resolveSessionRefMock(owner));
  buildOwnerRespawnMock.mockResolvedValue({
    systemPromptAddendum: 'deterministic carry',
    firstPrompt: null,
    budgetChars: 32_000,
    openOwnerQuestion: { crossesOpenOwnerMessage: false },
  });
  resolveSelfSessionMock.mockResolvedValue(null);
  resetCarryRespawnForTests();
  resetForceCompactedForTests();
  resetNoHostWarnedForTests(); // EI-9982 no-live-host diagnostic dedup
  resetBootConfigAssertForTests(); // P-018 boot self-assert dedup + streak
  resetContextUsageCacheForTests(); // P-013 gauge cache + flag mirror
  resetImplausibleReadingsForTests(); // EI-10434 sanity-clamp warn dedup
  resetStaleCutoverEscalationsForTests(); // EI-16190 pre-cutover-process dedup
  resetCompactionStrandingForTests(); // D-137 repeated-compaction detector dedup
  writePresenceMock.mockResolvedValue(undefined);
  // The watchdog narrates seeds/over-limit crossings on the console by design;
  // silence it so vitest-fail-on-console doesn't flag the expected output.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // turn-provenance P-002: the force-compact continuation is envelope+ledger-
  // tagged (origin watchdog) — point the ledger at a throwaway dir so this suite
  // never writes the real ~/.papercusp/turn-provenance.
  process.env.PAPERCUSP_TURN_PROVENANCE_DIR = join(tmpdir(), `wd-prov-${process.pid}`);
});

afterEach(() => { vi.useRealTimers(); expect(readRealPgRailBlocks().blocked).toBe(0); });

describe('original compaction durable episodes', () => {
  function forceSuccessorSource(
    overrides: Partial<Omit<Extract<ResolveResumeResult, { ok: true }>, 'ok'>> = {},
  ): ResolveResumeResult {
    return {
      ok: true,
      sessionId: 'source-session',
      ompThreadId: null,
      resumeId: 'source-session',
      ownerId: 'su-episode',
      workspaceId: 'workspace',
      harnessSlug: 'papercusp',
      agent: 'claude',
      role: null,
      feature: null,
      cwd: '/repo',
      model: null,
      modelSource: null,
      account: null,
      headless: false,
      endedAt: null,
      endedBy: null,
      live: false,
      advSessionId: 44,
      binding: { coordOwnerId: 'su-episode', sessionId: 'source-session', startedAt: '2026-10-15 08:00:00+00' },
      ...overrides,
    };
  }

  function fixture() {
    const openedKeys: string[] = [], resolvedKeys: string[] = [];
    const open = new Map<string, number>();
    const row = { owner_id: 'su-episode', owner_label: 'episode', workspace_id: 'workspace',
      compaction_limit: 100_000, compaction_limit_explicit: true, last_turn_at: new Date().toISOString() };
    const resolveForceSuccessorTarget = vi.fn(async (_ownerId: string): Promise<ResolveResumeResult> => ({
      ok: false as const, error: 'not_found' as const, detail: 'no fixture source',
    }));
    const dispatchForceSuccessor = vi.fn(async (_input: CompactionForceSuccessorInput): Promise<CompactionForceSuccessorResult> => ({
      verified: false, detail: 'fixture successor was not verified',
    }));
    const deps: CompactionComplianceDeps = { readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) =>
      ({ conditionKey, openedAtMs })), rail: {
      broadcast: async event => { expect(event.oneShot).toBe(true); expect(event.conditionKey).toBeTruthy();
        if (!open.has(event.conditionKey!)) openedKeys.push(event.conditionKey!);
        open.set(event.conditionKey!, open.get(event.conditionKey!) ?? Date.now()); return true; },
      resolve: async event => { if (!open.delete(event.conditionKey)) return false;
        resolvedKeys.push(event.conditionKey); return true; },
    },
      resolveSessionStatesFn: async (subjects) => new Map(subjects.map(({ ownerId }) =>
        [ownerId, { sessionState: 'recorded' } as never] as const)),
      resolveForceSuccessorTarget, dispatchForceSuccessor };
    const key = (kind: Parameters<typeof compactionConditionKey>[2], subject = '') =>
      compactionConditionKey('workspace', row.owner_id, kind, subject);
    return { deps, open, row, key, openedKeys, resolvedKeys, resolveForceSuccessorTarget, dispatchForceSuccessor,
      run: (rows = [row], sqlOpts: Parameters<typeof fakeSql>[0] = {}) =>
        checkCompactionCompliance(fakeSql({ ...sqlOpts, seeded: rows }), deps) };
  }
  it('dispatches a workspace/harness-bound capability successor and records applied only after positive launch evidence', async () => {
    const h = fixture();
    estimateMock.mockResolvedValue(150_000);
    h.resolveForceSuccessorTarget.mockResolvedValue(forceSuccessorSource({ headless: true }));
    h.dispatchForceSuccessor.mockResolvedValue({ verified: true, detail: 'first turn observed' });

    const result = await h.run();

    expect(result.forceCompacted).toEqual(['su-episode']);
    expect(h.dispatchForceSuccessor).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        ownerId: 'su-episode',
        workspaceId: 'workspace',
        harnessSlug: 'papercusp',
        advSessionId: 44,
      }),
      brief: expect.stringContaining('FORCE'),
    }));
    expect(h.open.has(h.key('force-unavailable'))).toBe(false);
  });

  it('keeps force-unavailable when a scoped successor refuses or lacks positive launch evidence', async () => {
    const h = fixture();
    estimateMock.mockResolvedValue(150_000);
    h.resolveForceSuccessorTarget.mockResolvedValue(forceSuccessorSource());
    h.dispatchForceSuccessor.mockResolvedValue({ verified: false, detail: 'first turn is unconfirmed' });

    const result = await h.run();

    expect(result.forceCompacted).toEqual([]);
    expect(h.dispatchForceSuccessor).toHaveBeenCalledTimes(1);
    expect(h.open.has(h.key('force-unavailable'))).toBe(true);
  });

  it('does not classify an excluded OMP session as force-unavailable when no PTY host exists', async () => {
    const h = fixture();
    estimateMock.mockResolvedValue(150_000);
    resolveSessionRefReconciledMock.mockResolvedValue({ agent: 'omp', sessionId: 's-omp' });

    const result = await h.run();

    expect(result.forceCompacted).toEqual([]);
    expect(h.resolveForceSuccessorTarget).not.toHaveBeenCalled();
    expect(h.dispatchForceSuccessor).not.toHaveBeenCalled();
    expect(h.open.has(h.key('force-unavailable'))).toBe(false);
  });

  it('refuses hostless actuation when the recorded source lacks its harness binding', async () => {
    const h = fixture();
    estimateMock.mockResolvedValue(150_000);
    h.resolveForceSuccessorTarget.mockResolvedValue(forceSuccessorSource({ harnessSlug: null }));

    const result = await h.run();

    expect(result.forceCompacted).toEqual([]);
    expect(h.dispatchForceSuccessor).not.toHaveBeenCalled();
    expect(h.open.has(h.key('force-unavailable'))).toBe(true);
  });
  it('opens before legacy force latches and survives restart, absence and unknown measurements', async () => {
    const h = fixture(); estimateMock.mockResolvedValue(150_000);
    await h.run(); expect(h.open.size).toBe(2);
    expect(h.open.has(h.key('over-limit'))).toBe(true);
    expect(h.open.has(h.key('force-unavailable'))).toBe(true);
    await h.run(); expect(h.openedKeys).toHaveLength(2);
    resetForceCompactedForTests(); resetNoHostWarnedForTests(); resetCarryRespawnForTests();
    await h.run([]); expect(h.open.size).toBe(2);
    estimateMock.mockResolvedValue(null); await h.run(); expect(h.open.size).toBe(2);
    estimateMock.mockResolvedValue(50_000); await h.run(); expect(h.open.size).toBe(0);
    expect(h.resolvedKeys).toEqual(expect.arrayContaining(h.openedKeys));
  });
  it.each(['foreign-workspace', 'foreign-owner', 'duplicate', 'invalid-limit', 'invalid-estimate',
    'future-episode', 'unknown-clock', 'failed-ledger', 'unknown-ledger', 'unexpected-subject', 'duplicate-episode'])('preserves %s recovery', async kind => {
    const h = fixture(); h.open.set(h.key('over-limit'), Date.now() - 100);
    estimateMock.mockResolvedValue(50_000);
    if (kind === 'foreign-workspace') h.row.workspace_id = 'other';
    if (kind === 'foreign-owner') h.row.owner_id = 'other';
    if (kind === 'invalid-limit') h.row.compaction_limit = Number.NaN;
    if (kind === 'invalid-estimate') estimateMock.mockResolvedValue(Number.NaN);
    if (kind === 'future-episode') h.open.set(h.key('over-limit'), Date.now() + 100_000);
    if (kind === 'unknown-clock') h.open.set(h.key('over-limit'), Number.NaN);
    if (kind === 'failed-ledger') h.deps.readOpenConditions = async () => { throw new Error('ledger unreadable'); };
    if (kind === 'unknown-ledger') h.deps.readOpenConditions = async () => undefined as never;
    if (kind === 'unexpected-subject') { h.open.clear(); h.open.set(h.key('over-limit', 'foreign-session'), Date.now() - 100); }
    if (kind === 'duplicate-episode') h.deps.readOpenConditions = async () => [
      { conditionKey: h.key('over-limit'), openedAtMs: Date.now() - 100 },
      { conditionKey: h.key('over-limit'), openedAtMs: Date.now() - 100 },
    ];
    await h.run(kind === 'duplicate' ? [h.row, h.row] : [h.row]);
    expect(h.open.size).toBe(1); expect(h.resolvedKeys).toHaveLength(0);
  });
  it('false/null death checks cannot recover without a fresh positive live transcript response', async () => {
    const h = fixture(); deathMock.mockResolvedValue(true); await h.run();
    deathMock.mockResolvedValue(false); toolRefDeathMock.mockResolvedValue({ turns: 3, toolName: 'lost', evidence: 'rejected' });
    await h.run(); expect(h.open.size).toBe(2);
    toolRefDeathMock.mockResolvedValue(null); estimateMock.mockResolvedValue(50_000);
    await h.run(); expect(h.open.size).toBe(2);
    h.deps.observeHealthyTranscript = async () => ({ sessionId: 'current', measuredAtMs: 1 });
    await h.run(); expect(h.open.size).toBe(2);
    h.deps.observeHealthyTranscript = async () => ({ sessionId: 'current', measuredAtMs: Date.now() });
    await h.run(); expect(h.open.size).toBe(0);
  });
  it('failed keyed delivery or resolution does not suppress independent signals or a later retry', async () => {
    const h = fixture(); estimateMock.mockResolvedValue(150_000);
    const broadcast = h.deps.rail!.broadcast!;
    h.deps.rail!.broadcast = async event => {
      if (event.conditionKey === h.key('over-limit')) throw new Error('rail delivery unavailable');
      return broadcast(event);
    };
    await h.run(); expect(h.open.has(h.key('force-unavailable'))).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('condition delivery failed'));
    h.deps.rail!.broadcast = broadcast; await h.run(); expect(h.open.size).toBe(2);
    const resolve = h.deps.rail!.resolve!;
    h.deps.rail!.resolve = async () => { throw new Error('resolution unavailable'); };
    estimateMock.mockResolvedValue(50_000); await h.run(); expect(h.open.size).toBe(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('condition resolution failed'));
    h.deps.rail!.resolve = resolve; await h.run(); expect(h.open.size).toBe(0);
  });
  it('uses shared liveness and resolves current-signal episodes only for an explicit ended verdict', async () => {
    const h = fixture();
    const endedSessionSignals = [
      'dark-telemetry', 'over-limit', 'force-unavailable', 'implausible-reading',
      'frozen-codex-reading', 'default-1m-served-small', 'unsatisfiable-limit',
    ] as const;
    const needsFollowUp = [
      'context-death', 'tool-reference-death', 'compaction-stranding',
      'dark-presence', 'carry-respawn-loop', 'stale-cutover',
    ] as const;
    for (const kind of endedSessionSignals) h.open.set(h.key(kind), Date.now() - 100);
    for (const kind of needsFollowUp) h.open.set(h.key(kind), Date.now() - 100);

    let sessionState: string | null = 'recorded';
    const oracleCalls: Array<{ ownerIds: string[]; options: unknown }> = [];
    h.deps.resolveSessionStatesFn = async (subjects, options) => {
      oracleCalls.push({ ownerIds: subjects.map(({ ownerId }) => ownerId), options });
      return new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState } as never] as const));
    };

    // Inactivity alone leaves the owner's recorded session and its alarms intact.
    await h.run([], { legacyUnendedSessionOwners: [h.row.owner_id] });
    expect(h.open.size).toBe(endedSessionSignals.length + needsFollowUp.length);
    expect(h.resolvedKeys).toEqual([]);

    // An explicit ended verdict resolves current-signal episodes even when
    // an uncleanly ended raw adv_sessions row still has ended_at IS NULL.
    sessionState = 'ended';
    await h.run([], { legacyUnendedSessionOwners: [h.row.owner_id] });
    expect([...h.open.keys()].sort()).toEqual(needsFollowUp.map(kind => h.key(kind)).sort());
    expect(h.resolvedKeys.sort()).toEqual(endedSessionSignals.map(kind => h.key(kind)).sort());
    expect(oracleCalls[0]).toEqual({
      ownerIds: [h.row.owner_id],
      options: { hydrateBatch: true, psuHostPositiveAuthority: true, selfWake: true, hostCondition: true },
    });
    expect(observedSqlQueries.some(({ query }) =>
      query.includes('harness_shared.adv_sessions s') &&
      query.includes('s.ended_at IS NULL') &&
      query.includes('s.ended_by IS NULL'),
    )).toBe(true);
  });
  it('preserves one-shot episodes when the shared liveness read fails', async () => {
    const h = fixture();
    h.open.set(h.key('over-limit'), Date.now() - 100);
    h.open.set(h.key('dark-telemetry'), Date.now() - 100);
    h.deps.resolveSessionStatesFn = async () => { throw new Error('liveness oracle unavailable'); };
    await h.run([]);
    expect(h.open.size).toBe(2);
    expect(h.resolvedKeys).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ended-session liveness read failed'));
  });
  it('logs condition-family read failures and exact-key resolutions that return false', async () => {
    const h = fixture();
    const key = h.key('over-limit');
    await checkCompactionCompliance(fakeSql({ conditionEpisodesError: true }), {
      rail: { resolve: async () => true },
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ended-session condition read failed'));

    h.open.set(key, Date.now() - 100);
    h.deps.rail!.resolve = async () => false;
    h.deps.resolveSessionStatesFn = async (subjects) => new Map(subjects.map(({ ownerId }) =>
      [ownerId, { sessionState: 'ended' } as never] as const));
    await h.run([]);
    expect(h.open.has(key)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`condition recovery returned false for exact key ${key}`));
  });
  it('preserves an episode when the condition reader returns duplicate lifecycle evidence', async () => {
    const h = fixture();
    const key = h.key('over-limit');
    h.open.set(key, Date.now() - 100);
    h.deps.readOpenConditions = async () => [
      { conditionKey: key, openedAtMs: Date.now() - 100 },
      { conditionKey: key, openedAtMs: Date.now() - 100 },
    ];
    h.deps.resolveSessionStatesFn = async (subjects) => new Map(subjects.map(({ ownerId }) =>
      [ownerId, { sessionState: 'ended' } as never] as const));
    await h.run([]);
    expect(h.open.has(key)).toBe(true);
    expect(h.resolvedKeys).toEqual([]);
  });
  it('only measured same-session rollout recovery clears a frozen episode', async () => {
    const h = fixture(); h.open.set(h.key('frozen-codex-reading'), Date.now() - 100);
    estimateMock.mockResolvedValue(50_000); await h.run(); expect(h.open.size).toBe(1);
    codexProvenanceMock.mockResolvedValue({ rolloutPath: 'rollout', refSessionId: 'current',
      rolloutSessionId: 'other', rolloutMtimeMs: Date.now() });
    await h.run(); expect(h.open.size).toBe(1);
    codexProvenanceMock.mockResolvedValue({ rolloutPath: 'rollout', refSessionId: 'current',
      rolloutSessionId: 'current', rolloutMtimeMs: Date.now() });
    await h.run(); expect(h.open.size).toBe(0);
  });
  it('null stranding detector results preserve until a positive edit on the exact target is measured', async () => {
    const h = fixture(); const key = h.key('compaction-stranding', JSON.stringify(['packages/target.ts']));
    h.open.set(key, Date.now() - 100); estimateMock.mockResolvedValue(50_000);
    await h.run(); expect(h.open.size).toBe(1);
    await checkCompactionCompliance(fakeSql({ seeded: [h.row], targetEdits: [
      { file: 'packages/target.ts', edited_ms: Date.now() } ] }), h.deps);
    expect(h.open.size).toBe(0);
  });
  it('independent dark and implausible episodes recover only on a trustworthy numeric measurement', async () => {
    const h = fixture(); resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'current' });
    await h.run(); await h.run(); await h.run(); expect(h.open.has(h.key('dark-telemetry'))).toBe(true);
    estimateMock.mockResolvedValue(2_000_001); await h.run(); expect(h.open.size).toBe(2);
    estimateMock.mockResolvedValue(Number.NaN); await h.run(); expect(h.open.size).toBe(2);
    estimateMock.mockResolvedValue(50_000); await h.run(); expect(h.open.size).toBe(0);
  });
  it('retires a legacy unsatisfiable-limit episode only after a fresh total-input observation', async () => {
    const h = fixture(); estimateMock.mockResolvedValue(50_000);
    const key = h.key('unsatisfiable-limit');
    h.open.set(key, Date.now() - 100);
    observedPromptFloorMock.mockReturnValue(null);
    await h.run(); expect(h.open.has(key)).toBe(true);
    observedPromptFloorMock.mockReturnValue({ tokens: 150_000, observations: 3, at: 1 });
    await h.run(); expect(h.open.has(key)).toBe(true);
    observedPromptFloorMock.mockReturnValue({ tokens: 150_000, observations: 3, at: Date.now() });
    await h.run(); expect(h.open.has(key)).toBe(false);
    expect(h.resolvedKeys).toContain(key);
  });
  it('a missing measured model window preserves the default-window alarm after restart', async () => {
    const h = fixture(); h.open.set(h.key('default-1m-served-small'), Date.now() - 1);
    estimateMock.mockResolvedValue(50_000); await h.run(); expect(h.open.size).toBe(1);
    contextWindowMock.mockResolvedValue(1_000_000); await h.run(); expect(h.open.size).toBe(0);
  });
  it('requires a sustained measured under-limit stretch after a missed sweep before clearing the loop', async () => {
    vi.useFakeTimers(); const h = fixture(); h.open.set(h.key('carry-respawn-loop'), Date.now() - 1);
    estimateMock.mockResolvedValue(50_000); await h.run(); expect(h.open.size).toBe(1);
    vi.advanceTimersByTime(30 * 60_000); await h.run(); expect(h.open.size).toBe(1);
    for (let i = 0; i < 15; i++) { vi.advanceTimersByTime(2 * 60_000); await h.run(); }
    expect(h.open.size).toBe(0);
  });
  it.each(['unsupported-host', 'missing-transcript', 'failed-builder', 'rejected-injection', 'failed-discovery'])
    ('opens the original force fallback for %s', async kind => {
      const h = fixture(); estimateMock.mockResolvedValue(150_000);
      findLiveHostMock.mockReturnValue({ sock: 'fixture-socket', caps: ['carry-respawn'] });
      hostSupportsMock.mockReturnValue(kind !== 'unsupported-host');
      if (kind === 'missing-transcript') { findTranscriptMock.mockResolvedValue(null); newestTranscriptMock.mockReturnValue(null); }
      if (kind === 'failed-builder') buildOwnerRespawnMock.mockRejectedValueOnce(new Error('builder unavailable'));
      if (kind === 'rejected-injection') injectMock.mockResolvedValue(false);
      if (kind === 'failed-discovery') findLiveHostMock.mockImplementationOnce(() => { throw new Error('host unreadable'); });
      await h.run(); expect(h.open.has(h.key('force-unavailable'))).toBe(true);
      estimateMock.mockResolvedValue(50_000); await h.run(); expect(h.open.size).toBe(0);
    });
  it('runtime cutover recovery survives restart and only clears the same known host/entrypoint after a measured boot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = fixture(); const cutover = WATCHDOG_BEHAVIOR_CUTOVERS[0];
    const runtime = `${hostname()}:${process.argv[1]}`;
    const exact = compactionConditionKey(DEFAULT_COORD_WORKSPACE, runtime, 'stale-cutover', cutover.id);
    const foreign = compactionConditionKey(DEFAULT_COORD_WORKSPACE, 'other-host:entry', 'stale-cutover', cutover.id);
    const unknown = compactionConditionKey(DEFAULT_COORD_WORKSPACE, runtime, 'stale-cutover', 'unknown-cutover');
    const opened = cutover.atMs - 1_000;
    h.open.set(exact, opened); h.open.set(foreign, opened); h.open.set(unknown, opened);
    vi.setSystemTime(cutover.atMs + 1_000); vi.spyOn(process, 'uptime').mockReturnValue(0);
    try {
      startCompactionComplianceWatchdog(fakeSql({}), { ...h.deps, intervalMs: 999_999_999 });
      await vi.waitFor(() => expect(h.open.has(exact)).toBe(false));
      expect(h.open.has(foreign)).toBe(true); expect(h.open.has(unknown)).toBe(true);
    } finally { const { stopManaged } = await import('@papercusp/scheduled-registry'); stopManaged('compaction-compliance-watchdog'); }
  });
});

describe('checkCompactionCompliance seeding (context-trimming-tiers P-006)', () => {
  it('seeds the model-derived default for limit-less live sessions: fable [1m] → 450k cap, unresolvable → 450k (WI-3383)', async () => {
    specMock.mockImplementation(async (owner: string) =>
      owner === 'su-wide' ? 'claude-fable-5[1m]' : null,
    );
    const out = await checkCompactionCompliance(
      fakeSql({ unseeded: [{ owner_id: 'su-wide' }, { owner_id: 'su-narrow' }] }),
    );
    expect(out.seeded).toEqual(['su-wide', 'su-narrow']);
    expect(setLimitMock).toHaveBeenCalledWith('su-wide', 450_000, { explicit: false });
    // WI-3383: an UNRESOLVABLE spec no longer mis-seeds the haiku-sized 158k — on this
    // opus[1m]-default fleet a truly-unknown spec is an opus[1m] session ⇒ the leader/solo
    // 1M policy (450k since owner directive 2026-09-21; was 400k).
    expect(setLimitMock).toHaveBeenCalledWith('su-narrow', 450_000, { explicit: false });
  });

  // The member figure is COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP, raised 200k → 250k
  // by owner directive 2026-09-02 (WI-2142006) as deliberate headroom alongside the
  // claim-time brief budget going 14k → 50k chars. Leader/solo stay at 400k.
  it('shapes the [1m] default by fleet role: member → 250k, leader/solo → 450k (owner directives 2026-09-02, raised 2026-09-21)', async () => {
    specMock.mockResolvedValue('sonnet[1m]:high');
    const out = await checkCompactionCompliance(
      fakeSql({
        unseeded: [
          { owner_id: 'su-member', fleet_slug: 'backlog-clearance', fleet_role: 'member' },
          { owner_id: 'su-leader', fleet_slug: 'backlog-clearance', fleet_role: 'leader' },
          { owner_id: 'su-solo', fleet_slug: null, fleet_role: null },
          // member shaping reaches the spawn-record spec leg too (D-006 honor leg)
          { owner_id: 'su-spawned-member', fleet_slug: 'backlog-clearance', fleet_role: 'member' },
        ],
        spawnRecords: {
          'su-spawned-member': { model_spec: 'claude-fable-5[1m]', model_tier: null },
        },
      }),
    );
    expect(out.seeded).toEqual(['su-member', 'su-leader', 'su-solo', 'su-spawned-member']);
    expect(setLimitMock).toHaveBeenCalledWith('su-member', 250_000, { explicit: false });
    expect(setLimitMock).toHaveBeenCalledWith('su-leader', 450_000, { explicit: false });
    expect(setLimitMock).toHaveBeenCalledWith('su-solo', 450_000, { explicit: false });
    expect(setLimitMock).toHaveBeenCalledWith('su-spawned-member', 250_000, { explicit: false });
  });

  it('honors the spawn record: explicit tier limit > recorded spec default > resolver (D-006)', async () => {
    specMock.mockResolvedValue(null); // resolver unresolvable ⇒ the 400k [1m] fallback (WI-3383)
    const out = await checkCompactionCompliance(
      fakeSql({
        unseeded: [
          { owner_id: 's-tier' }, // spawn record names tier "deep" → explicit 120k
          { owner_id: 's-spec' }, // spawn record carries only a fable [1m] spec → 400k cap
          { owner_id: 's-none' }, // no spawn record → unresolvable resolver fallback → 400k (WI-3383)
        ],
        spawnRecords: {
          's-tier': { model_spec: 'opus:high', model_tier: 'deep' },
          's-spec': { model_spec: 'claude-fable-5[1m]', model_tier: null },
        },
      }),
    );
    expect(out.seeded).toEqual(['s-tier', 's-spec', 's-none']);
    expect(setLimitMock).toHaveBeenCalledWith('s-tier', 120_000, { explicit: true });
    expect(setLimitMock).toHaveBeenCalledWith('s-spec', 450_000, { explicit: false });
    expect(setLimitMock).toHaveBeenCalledWith('s-none', 450_000, { explicit: false });
    // the fs/argv resolver only ran for the record-less owner
    expect(specMock).toHaveBeenCalledTimes(1);
    expect(specMock).toHaveBeenCalledWith('s-none');
  });

  it('a per-owner seed failure never fails the pass (best-effort)', async () => {
    specMock.mockResolvedValue(null);
    setLimitMock.mockRejectedValueOnce(new Error('pg down'));
    const out = await checkCompactionCompliance(
      fakeSql({ unseeded: [{ owner_id: 'a' }, { owner_id: 'b' }] }),
    );
    expect(out.seeded).toEqual(['b']); // 'a' failed silently, 'b' seeded
  });
});

/**
 * WI-38347 — the measured window outranks the spec-derived guess, in BOTH
 * directions, for a DERIVED limit only.
 *
 * `modelWindowForSpec` keys on the `[1m]` marker, a Claude/CC auto-compact
 * signal with no meaning on codex or omp, so every non-Claude spec fell to the
 * conservative 200k branch and seeded 158,000 against a true 258,400 window.
 * The re-limit was lower-only, so 158,000 could never be corrected upward and
 * the mis-seed was permanent — while a session that named NO model resolved a
 * null spec, seeded 400,000, and was correctly lowered to 207,000.
 *
 * The two properties under test, kept deliberately separate:
 *   • the seed must not fabricate a window it cannot derive; and
 *   • a running session already carrying the bad seed must HEAL — but only
 *     when its stored limit is still exactly the number nobody chose.
 */
describe('measured window outranks the spec-derived guess (WI-38347)', () => {
  // A real live codex spec on the NON-EXTENDED family: names a model, carries no
  // `[1m]` marker (no codex spec ever does), and therefore still falls to the
  // conservative 200k branch → 158,000.
  //
  // ⚠ DO NOT "modernise" this to gpt-5.6-sol. Since codex-1m-context-window-2026-08-17
  // (D-002) the gpt-5.6 sol/terra/luna family and gpt-5.4 are EXTENDED-window
  // specs: they derive 872k → the 400k role cap, which sits ABOVE the measured
  // window below. Every case here would still run, but the block would stop
  // testing what it claims to: `falls back to the spec-derived default` would
  // assert 400_000, and `RAISES a session still carrying the spec-derived seed`
  // would no longer describe a raise at all — a stored 158_000 would read as a
  // deliberate lower override and be left alone, so the test would pass by
  // exercising nothing. gpt-5.5 has no extended window (max == default 272,000),
  // which is also what makes CODEX_WINDOW below a truthful measurement.
  const CODEX_SPEC = 'gpt-5.5:xhigh';
  const CODEX_WINDOW = 258_400; // 272k model × the CLI's 95% effective window
  const CODEX_SAFE_LIMIT = 207_000; // (258_400 − 10_000) / 1.2, floored to 1k

  describe('seed pass', () => {
    it('seeds from the MEASURED window, not the spec guess — the 158k mis-seed never lands', async () => {
      specMock.mockResolvedValue(CODEX_SPEC);
      contextWindowMock.mockResolvedValue(CODEX_WINDOW);
      const out = await checkCompactionCompliance(fakeSql({ unseeded: [{ owner_id: 'cx' }] }));
      expect(out.seeded).toEqual(['cx']);
      expect(setLimitMock).toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT, { explicit: false });
      expect(setLimitMock).not.toHaveBeenCalledWith('cx', 158_000);
    });

    it('falls back to the spec-derived default when NO window can be measured', async () => {
      specMock.mockResolvedValue(CODEX_SPEC);
      contextWindowMock.mockResolvedValue(null); // omp / a rollout that has not landed yet
      await checkCompactionCompliance(fakeSql({ unseeded: [{ owner_id: 'cx' }] }));
      // 158_000 is CORRECT here, and is NOT a re-pin of the "fabricated 200k
      // window" bug: CODEX_SPEC is gpt-5.5, which genuinely has no extended
      // window (D-002), so the conservative branch IS the honest derivation for
      // this model. The extended family's 400k derivation is pinned by its own
      // case below against its own spec — keeping the two contracts on separate
      // fixtures is what lets both stay truthful.
      expect(setLimitMock).toHaveBeenCalledWith('cx', 158_000, { explicit: false });
    });

    it('derives the 450k role cap — NOT the 158k fallback — for an EXTENDED codex spec (D-001/D-002)', async () => {
      specMock.mockResolvedValue('gpt-5.6-sol:xhigh');
      contextWindowMock.mockResolvedValue(null); // no measurement: the spec guess is all there is
      await checkCompactionCompliance(fakeSql({ unseeded: [{ owner_id: 'cx' }] }));
      // The point of codex-1m-context-window-2026-08-17: an extended codex session
      // must stop seeding against the fabricated 200k window. 872k binds to the
      // 450k su/leader role cap (D-001; raised from 400k by owner directive
      // 2026-09-21). This is the falsifier for a revert of the
      // codex-aware branch in modelWindowForSpec — without it, that branch is
      // untested at this consumer and a revert passes silently.
      expect(setLimitMock).toHaveBeenCalledWith('cx', 450_000, { explicit: false });
      expect(setLimitMock).not.toHaveBeenCalledWith('cx', 158_000);
    });

    it('never overrides an EXPLICIT launch --compaction-limit with the measured window', async () => {
      specMock.mockResolvedValue(CODEX_SPEC);
      contextWindowMock.mockResolvedValue(CODEX_WINDOW);
      resolveLaunchLimitMock.mockResolvedValue(120_000);
      await checkCompactionCompliance(fakeSql({ unseeded: [{ owner_id: 'cx' }] }));
      expect(setLimitMock).toHaveBeenCalledWith('cx', 120_000, { explicit: true });
      expect(setLimitMock).not.toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT);
    });

    it('never overrides an EXPLICIT per-tier compactionLimit with the measured window', async () => {
      specMock.mockResolvedValue(CODEX_SPEC);
      contextWindowMock.mockResolvedValue(CODEX_WINDOW);
      await checkCompactionCompliance(
        fakeSql({
          unseeded: [{ owner_id: 'cx' }],
          // tier "deep" carries an explicit compactionLimit of 120_000
          spawnRecords: { cx: { model_spec: 'opus:high', model_tier: 'deep' } },
        }),
      );
      expect(setLimitMock).toHaveBeenCalledWith('cx', 120_000, { explicit: true });
      expect(setLimitMock).not.toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT);
    });
  });

  describe('live re-limit', () => {
    /** A live session well under its limit: reaches the D-011 block without
     *  tripping the over-limit warn or the force rung. */
    const sweep = (compaction_limit: number) =>
      fakeSql({ seeded: [{ owner_id: 'cx', owner_label: 'su · cx', compaction_limit }] });

    beforeEach(() => {
      estimateMock.mockResolvedValue(50_000);
      contextWindowMock.mockResolvedValue(CODEX_WINDOW);
      specMock.mockResolvedValue(CODEX_SPEC);
    });

    /**
     * The raise gate uses VALUE EQUALITY with the current derived seed as its
     * provenance signal (see the sibling cases below). After
     * codex-1m-context-window-2026-08-17, an extended-window codex spec derives
     * 400k — always ABOVE the limit its measured 258.4k window justifies — so for
     * codex the seed can now only be LOWERED, and this branch is unreachable with
     * CODEX_SPEC. The mechanism itself is unchanged and still load-bearing for any
     * spec whose derived seed sits BELOW its measured window, so it is pinned here
     * with a 200k-window spec (derives 158k) against the same measured window.
     *
     * ⚠ Consequence deliberately NOT hidden by this retarget: a codex session
     * seeded 158_000 BEFORE that plan landed no longer equals the derived seed, so
     * it reads as a deliberate override and is never healed upward. Filed for the
     * owning lane rather than papered over here.
     */
    it('RAISES a session still carrying the spec-derived seed (the heal the lower-only rule could not reach)', async () => {
      specMock.mockResolvedValue('claude-sonnet-4-6'); // 200k window ⇒ derives 158_000
      const out = await checkCompactionCompliance(sweep(158_000));
      expect(out.relimited).toContainEqual({ owner: 'cx', from: 158_000, to: CODEX_SAFE_LIMIT });
      expect(setLimitMock).toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT);
    });

    it('HEALS a seed a SUPERSEDED policy derived — the orphan a derivation CHANGE would otherwise strand (WI-39789)', async () => {
      // The failure this pins is one level up from the original WI-38347 bug: not
      // a repair that only runs downhill, but one whose provenance proxy is
      // value-equality against the CURRENT default. Move a derivation and every
      // session still carrying the OLD number stops matching, reads as a
      // deliberate override, and is stranded below the correct limit where the
      // lower-only branch can never reach it.
      //
      // Here: an extended codex spec derives the role cap today, but this session
      // was seeded 158_000 under the pre-codex-aware policy (codex-1m-context-
      // window-2026-08-17). Equality with the current default fails; only the
      // superseded-value test rescues it.
      specMock.mockResolvedValue('gpt-5.6-sol:xhigh');
      const out = await checkCompactionCompliance(sweep(158_000));
      expect(out.relimited).toContainEqual({ owner: 'cx', from: 158_000, to: CODEX_SAFE_LIMIT });
      expect(setLimitMock).toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT);
    });

    it('does NOT treat a deliberate override as superseded just because the spec is extended (WI-39789 falsifier)', async () => {
      // The guard against the fix above over-reaching: 100_000 is not a value ANY
      // policy derived for this spec, so an extended spec must not make it
      // healable. Without this, "heal superseded values" quietly becomes "raise
      // anything below the safe limit" and D-006 leanness is gone.
      specMock.mockResolvedValue('gpt-5.6-sol:xhigh');
      const out = await checkCompactionCompliance(sweep(100_000));
      expect(out.relimited).toEqual([]);
      expect(setLimitMock).not.toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT);
    });

    /**
     * WI-10006049 (owner Avi 2026-10-05 #1369/#1371): a 1M-family session that a bare
     * /model menu pick (Claude Code 2.1.289) dropped to a 200k window was LOWERED by this
     * very branch to the 200k window's derived limit. Once it is served at 1M again its
     * spec derives the 1M limit, so the old 158k no longer equals the seed — it must still
     * heal, because the watchdog wrote it, not a human. Replays su-56e2f83b, 2026-10-06.
     */
    it('HEALS the 200k-window limit this branch wrote once the live window is back at 1M (WI-10006049)', async () => {
      const lowered = defaultCompactionLimitForWindow(MODEL_WINDOW_DEFAULT);
      const healed = defaultCompactionLimitForWindow(MODEL_WINDOW_1M);
      specMock.mockResolvedValue('opus[1m]'); // derives the 1M limit, so `lowered` != seed
      contextWindowMock.mockResolvedValue(MODEL_WINDOW_1M);
      const out = await checkCompactionCompliance(sweep(lowered));
      expect(out.relimited).toContainEqual({ owner: 'cx', from: lowered, to: healed });
      expect(setLimitMock).toHaveBeenCalledWith('cx', healed);
    });

    it('does NOT heal that value while the live window is still 200k, nor an unrelated low value at 1M (WI-10006049 falsifiers)', async () => {
      const lowered = defaultCompactionLimitForWindow(MODEL_WINDOW_DEFAULT);
      specMock.mockResolvedValue('opus[1m]');
      contextWindowMock.mockResolvedValue(MODEL_WINDOW_DEFAULT);
      const stillSmall = await checkCompactionCompliance(sweep(lowered));
      expect(stillSmall.relimited).toEqual([]);
      setLimitMock.mockClear();
      contextWindowMock.mockResolvedValue(MODEL_WINDOW_1M);
      const deliberate = await checkCompactionCompliance(sweep(100_000));
      expect(deliberate.relimited).toEqual([]);
      expect(setLimitMock).not.toHaveBeenCalled();
    });

    /**
     * WI-10006236 (owner Avi 2026-10-05, #1309 prevention): the WI-10006049 incident left
     * one trace, the quiet `re-limited 450000 → 158000` log line. Lowering a session whose
     * model family is served at 1M by default to the 200k window is now an owner-facing
     * escalation, once per owner.
     */
    it('ESCALATES once when a 1M-default family is measured at 200k and lowered (WI-10006236)', async () => {
      const healed = defaultCompactionLimitForWindow(MODEL_WINDOW_1M);
      const lowered = defaultCompactionLimitForWindow(MODEL_WINDOW_DEFAULT);
      for (const spec of ['opus[1m]', 'sonnet', 'fable:high']) {
        resetCarryRespawnForTests();
        openEscalationMock.mockClear();
        specMock.mockResolvedValue(spec);
        contextWindowMock.mockResolvedValue(MODEL_WINDOW_DEFAULT);
        const out = await checkCompactionCompliance(sweep(healed));
        expect(out.relimited).toContainEqual({ owner: 'cx', from: healed, to: lowered });
        expect(out.default1mServedSmall).toEqual([
          { owner: 'cx', spec, from: healed, to: lowered, window: MODEL_WINDOW_DEFAULT },
        ]);
        expect(openEscalationMock).toHaveBeenCalledTimes(1);
        const [, input] = openEscalationMock.mock.calls[0] as unknown as [
          unknown,
          { summary: string; meta: { subjectSignature: string } },
        ];
        expect(input.meta.subjectSignature).toBe('compaction-watchdog:default-1m-served-small:cx');
        expect(input.summary).toContain(`${MODEL_WINDOW_DEFAULT}-token window`);
        // Same owner, next sweep: still recorded, not re-escalated.
        await checkCompactionCompliance(sweep(healed));
        expect(openEscalationMock).toHaveBeenCalledTimes(1);
      }
    });

    it('does NOT escalate a 200k-window family, nor a 1M family lowered at a window above 200k (WI-10006236 falsifiers)', async () => {
      const healed = defaultCompactionLimitForWindow(MODEL_WINDOW_1M);
      specMock.mockResolvedValue('claude-sonnet-4-6'); // a genuine 200k model
      contextWindowMock.mockResolvedValue(MODEL_WINDOW_DEFAULT);
      const small = await checkCompactionCompliance(sweep(healed));
      expect(small.relimited).not.toEqual([]);
      expect(small.default1mServedSmall).toEqual([]);
      specMock.mockResolvedValue('opus[1m]');
      contextWindowMock.mockResolvedValue(CODEX_WINDOW); // lowered, but not to the 200k window
      const codexSized = await checkCompactionCompliance(sweep(healed));
      expect(codexSized.relimited).not.toEqual([]);
      expect(codexSized.default1mServedSmall).toEqual([]);
      expect(openEscalationMock).not.toHaveBeenCalled();
    });

    it('leaves a DELIBERATE lower override alone — its value differs from the derived seed (D-006 leanness)', async () => {
      const out = await checkCompactionCompliance(sweep(100_000));
      expect(out.relimited).toEqual([]);
      expect(setLimitMock).not.toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT);
    });

    /**
     * The falsifier that separates the two readings of "may I raise this?".
     * Here the stored limit is NUMERICALLY EQUAL to what the spec would derive,
     * so an equality-only rule would raise it — but it was stated outright on
     * the launch argv. Provenance, not the value, decides.
     */
    it('leaves an EXPLICIT launch limit alone even when it EQUALS the derived default', async () => {
      resolveLaunchLimitMock.mockResolvedValue(158_000);
      const out = await checkCompactionCompliance(sweep(158_000));
      expect(out.relimited).toEqual([]);
      expect(setLimitMock).not.toHaveBeenCalledWith('cx', CODEX_SAFE_LIMIT);
    });

    /**
     * The lower branch deliberately reads NO provenance: a limit above the true
     * window means the session never preempts and the host compacts it
     * mid-task, so safety outranks intent. This pins that asymmetry — an
     * explicit launch limit is present and the lower branch fires anyway — so
     * that a later reader cannot "restore symmetry" by gating both directions
     * on `!seed.explicit`.
     */
    it('still LOWERS unconditionally — a limit above the true window is a safety fault, not an intent', async () => {
      resolveLaunchLimitMock.mockResolvedValue(250_000);
      const out = await checkCompactionCompliance(sweep(250_000));
      expect(out.relimited).toContainEqual({ owner: 'cx', from: 250_000, to: CODEX_SAFE_LIMIT });
    });

    it('is idempotent: a healed session is not re-written on the next sweep', async () => {
      const out = await checkCompactionCompliance(sweep(CODEX_SAFE_LIMIT));
      expect(out.relimited).toEqual([]);
      expect(setLimitMock).not.toHaveBeenCalled();
    });

    it('never raises above the measured window safe limit', async () => {
      const out = await checkCompactionCompliance(sweep(158_000));
      const raised = out.relimited.find((r) => r.owner === 'cx')?.to ?? 0;
      expect(raised).toBeLessThanOrEqual(CODEX_SAFE_LIMIT);
      expect(raised * 1.2).toBeLessThanOrEqual(CODEX_WINDOW); // overshoot still fits under the wall
    });
  });
});

describe('checkCompactionCompliance sweep (agent-managed-compaction P-009)', () => {
  it('caches estimates and flags sessions over their own limit', async () => {
    estimateMock.mockImplementation(async (owner: string) => (owner === 'hot' ? 170_000 : 40_000));
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 },
          { owner_id: 'cool', owner_label: 'su · cool', compaction_limit: 158_000 },
        ],
      }),
    );
    expect(out.estimated).toEqual(['hot', 'cool']);
    expect(out.overLimit).toEqual(['hot']);
    expect(setEstimateMock).toHaveBeenCalledWith('hot', 170_000, {
      nativeSessionId: 'native-current',
      advSessionId: 1,
    });
  });

  it('discards the sample and skips gauge/cut actions when the native-session fence rejects it', async () => {
    resolveSessionRefMock.mockResolvedValue({
      agent: 'claude',
      sessionId: 'native-predecessor',
      sessionKey: 41,
    });
    estimateMock.mockResolvedValue(170_000);
    setEstimateMock.mockResolvedValue(false);

    const out = await checkCompactionCompliance(fakeSql({
      seeded: [{ owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 }],
    }));

    expect(setEstimateMock).toHaveBeenCalledWith('hot', 170_000, {
      nativeSessionId: 'native-predecessor',
      advSessionId: 41,
    });
    expect(out.estimated).toEqual([]);
    expect(out.bootConfigAlerts).toEqual([]); // the measured estimate was non-null; only its guarded cache write was rejected
    expect(out.overLimit).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('P-003: SURFACES an over-limit session\'s unflushed (stale-checkpoint) claim, and skips a fresh one', async () => {
    estimateMock.mockImplementation(async () => 170_000); // over 158k
    const now = Date.now();
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [{ owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 }],
        claimFreshness: {
          hot: [
            // never-checkpointed, held 20 min ⇒ stale 'never'
            { work_item_id: 'WI-500', acquired_ms: String(now - 20 * 60_000), last_activity_ms: String(now), checkpoint_updated_ms: null },
            // checkpointed 30s ago ⇒ fresh, NOT surfaced
            { work_item_id: 'WI-501', acquired_ms: String(now - 60 * 60_000), last_activity_ms: String(now), checkpoint_updated_ms: String(now - 30_000) },
          ],
        },
      }),
    );
    expect(out.overLimit).toEqual(['hot']);
    expect(out.unflushedClaims).toEqual([
      { owner: 'hot', workItemId: 'WI-500', reason: 'never', staleMs: expect.any(Number) },
    ]);
  });

  it('P-003: a session UNDER its limit is never scanned for unflushed claims', async () => {
    estimateMock.mockImplementation(async () => 40_000); // under 158k
    const now = Date.now();
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [{ owner_id: 'cool', owner_label: 'su · cool', compaction_limit: 158_000 }],
        claimFreshness: {
          cool: [{ work_item_id: 'WI-9', acquired_ms: String(now - 60 * 60_000), last_activity_ms: String(now), checkpoint_updated_ms: null }],
        },
      }),
    );
    expect(out.overLimit).toEqual([]);
    expect(out.unflushedClaims).toEqual([]); // under limit ⇒ the claim read never runs
  });
});

describe('D-137 repeated-compaction/pre-edit detector', () => {
  const nowMs = Date.parse('2026-08-28T03:00:00Z');
  const targetPath = 'packages/operator-core/lib/workspace-host/initialization-operations-resolver.ts';
  const base = {
    owner: 'su-hot',
    ownerLabel: 'su · hot',
    event: {
      key: 'session:compacted:su-hot',
      fireCount: 2,
      latestBoundaryMs: nowMs - 5 * 60_000,
    },
    staleClaims: [{ workItemId: 'EI-137', reason: 'drift' as const, staleMs: 20 * 60_000 }],
    targetPaths: [targetPath],
    expiredOwnerLocks: [{ path: targetPath, expiresAtMs: nowMs - 60_000 }],
    targetEditsAfterBoundary: [],
    nowMs,
  };

  it('fires only when every durable signal agrees', () => {
    expect(detectCompactionStranding(base)).toEqual({
      owner: 'su-hot',
      ownerLabel: 'su · hot',
      eventKey: 'session:compacted:su-hot',
      fireCount: 2,
      latestBoundaryMs: nowMs - 5 * 60_000,
      workItemIds: ['EI-137'],
      staleClaims: [{ workItemId: 'EI-137', reason: 'drift', staleMs: 20 * 60_000 }],
      targetPaths: [targetPath],
      expiredOwnerLocks: [{ path: targetPath, expiresAtMs: nowMs - 60_000 }],
    });
  });

  it.each([
    ['one boundary', { event: { ...base.event, fireCount: 1 } }],
    ['no stale claim', { staleClaims: [] }],
    ['live target lock only', { expiredOwnerLocks: [{ path: targetPath, expiresAtMs: nowMs + 60_000 }] }],
    [
      'target edit after boundary',
      { targetEditsAfterBoundary: [{ file: targetPath, editedAtMs: nowMs - 60_000 }] },
    ],
    ['unreadable event', { event: null }],
    ['unreadable lock read', { expiredOwnerLocks: null }],
  ])('fails open for %s', (_label, override) => {
    expect(detectCompactionStranding({ ...base, ...override })).toBeNull();
  });

  it('rejects a non-owner event key rather than treating a sibling compaction as evidence', () => {
    expect(
      detectCompactionStranding({
        ...base,
        event: { ...base.event, key: 'session:compacted:someone-else' },
      }),
    ).toBeNull();
  });

  it('integrates the exact event latch, work-item paths, edit ledger, and injected SU lock reader', async () => {
    estimateMock.mockResolvedValue(40_000);
    const readExpiredOwnerFileLocks = vi.fn(async () => [
      { path: targetPath, expiresAtMs: nowMs - 60_000 },
    ]);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          {
            owner_id: 'su-hot',
            owner_label: 'su · hot',
            workspace_id: 'ws-1',
            compaction_limit: 158_000,
          },
        ],
        compactionBoundaries: [
          {
            event_key: 'session:compacted:su-hot',
            fire_count: 2,
            last_fired_at: new Date(nowMs - 5 * 60_000),
          },
        ],
        claimFreshness: {
          'su-hot': [
            {
              work_item_id: 'EI-137',
              acquired_ms: String(nowMs - 60 * 60_000),
              last_activity_ms: String(nowMs - 20 * 60_000),
              checkpoint_updated_ms: String(nowMs - 40 * 60_000),
            },
          ],
        },
        targetPaths: [{ work_item_id: 'EI-137', paths: [targetPath] }],
        targetEdits: [],
      }),
      { readExpiredOwnerFileLocks },
    );

    expect(out.compactionStrandingAlerts).toHaveLength(1);
    expect(out.compactionStrandingAlerts[0]).toMatchObject({
      owner: 'su-hot',
      workItemIds: ['EI-137'],
      targetPaths: [targetPath],
    });
    expect(readExpiredOwnerFileLocks).toHaveBeenCalledWith('su-hot', [targetPath]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const payload = (openEscalationMock.mock.calls[0] as unknown as [
      unknown,
      { severity?: string; summary?: string; meta?: { subjectSignature?: string },
    }])[1];
    expect(payload.severity).toBe('blocker');
    expect(payload.summary).toContain('compaction-stranding SUSPECT');
    expect(payload.meta?.subjectSignature).toBe('compaction-watchdog:compaction-stranding:su-hot');
  });

  it('suppresses the integrated alert when the edit ledger proves target progress', async () => {
    estimateMock.mockResolvedValue(40_000);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          {
            owner_id: 'su-hot',
            owner_label: 'su · hot',
            workspace_id: 'ws-1',
            compaction_limit: 158_000,
          },
        ],
        compactionBoundaries: [
          {
            event_key: 'session:compacted:su-hot',
            fire_count: 2,
            last_fired_at: new Date(nowMs - 5 * 60_000),
          },
        ],
        claimFreshness: {
          'su-hot': [
            {
              work_item_id: 'EI-137',
              acquired_ms: String(nowMs - 60 * 60_000),
              last_activity_ms: String(nowMs - 20 * 60_000),
              checkpoint_updated_ms: String(nowMs - 40 * 60_000),
            },
          ],
        },
        targetPaths: [{ work_item_id: 'EI-137', paths: [targetPath] }],
        targetEdits: [{ file: targetPath, edited_ms: nowMs - 60_000 }],
      }),
      {
        readExpiredOwnerFileLocks: async () => [
          { path: targetPath, expiresAtMs: nowMs - 60_000 },
        ],
      },
    );

    expect(out.compactionStrandingAlerts).toEqual([]);
    expect(openEscalationMock).not.toHaveBeenCalled();
  });
});

describe('deterministic carry-respawn cutover (P-018)', () => {
  const seeded = [
    {
      owner_id: 'hot',
      owner_label: 'su · hot',
      workspace_id: 'ws-1',
      compaction_limit: 158_000,
    },
  ];

  it('queues a deterministic successor at the soft threshold on a capable Claude host', async () => {
    estimateMock.mockResolvedValue(170_000);
    specMock.mockResolvedValue('sonnet');
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-1' });
    findLiveHostMock.mockReturnValue({
      sock: '/tmp/hot.sock',
      caps: ['carry-respawn', 'compact'],
    });
    hostSupportsMock.mockImplementation(
      (host: unknown, cap: string) =>
        (host as { caps?: string[] }).caps?.includes(cap) ?? false,
    );
    buildOwnerRespawnMock.mockResolvedValue({
      systemPromptAddendum: 'deterministic carry',
      firstPrompt: 'answer the open owner message',
      budgetChars: 32_000,
      openOwnerQuestion: { crossesOpenOwnerMessage: false },
    });

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.overLimit).toEqual(['hot']);
    expect(out.carryRespawned).toEqual(['hot']);
    expect(out.forceCompacted).toEqual([]);
    expect(findTranscriptMock).toHaveBeenCalledWith('native-1', { owner: 'hot' });
    expect(buildOwnerRespawnMock).toHaveBeenCalledWith(
      'hot',
      expect.objectContaining({
        effectiveWindowTokens: 200_000,
        buildOpts: expect.objectContaining({
          workspaceId: 'ws-1',
          ownerLabel: 'su · hot',
          transcriptPath: '/tmp/live-session.jsonl',
          transcriptSourceKind: 'claude',
          boundaryDeliberate: true,
          // Clean but NOT self-requested: the rendered carry doc must never claim
          // the session flushed before a cut it did not ask for.
          boundarySelfRequested: false,
        }),
      }),
    );
    expect(injectMock).toHaveBeenCalledWith('/tmp/hot.sock', {
      mode: 'carry-respawn',
      data: 'answer the open owner message',
      systemPromptAddendum: 'deterministic carry',
      ownerId: 'hot',
    });
    expect(runFlushGateMock).toHaveBeenCalledWith(
      expect.objectContaining({ boundary: 'compaction', mode: 'forced', ownerId: 'hot' }),
    );
  });

  it('re-limits from Codex telemetry and opens a null-firstPrompt carry on a real continuation turn (WI-39942)', async () => {
    estimateMock.mockResolvedValue(215_000);
    contextWindowMock.mockResolvedValue(258_400);
    specMock.mockResolvedValue('gpt-5.6-sol:max');
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'codex', sessionId: 'rollout-1', sessionKey: 14795 });
    resolveSelfSessionMock.mockResolvedValue({
      filePath: '/tmp/codex-rollout.jsonl',
      sourceKind: 'codex',
    });
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);

    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [{ ...seeded[0]!, compaction_limit: 400_000 }],
      }),
    );

    expect(setLimitMock).toHaveBeenCalledWith('hot', 207_000);
    expect(out.relimited).toContainEqual({ owner: 'hot', from: 400_000, to: 207_000 });
    expect(out.overLimit).toEqual(['hot']);
    expect(out.carryRespawned).toEqual(['hot']);
    expect(buildOwnerRespawnMock).toHaveBeenCalledWith(
      'hot',
      expect.objectContaining({
        effectiveWindowTokens: 258_400,
        buildOpts: expect.objectContaining({
          transcriptPath: '/tmp/codex-rollout.jsonl',
          transcriptSourceKind: 'codex',
        }),
      }),
    );
    const [, payload] = injectMock.mock.calls[0] as unknown as [
      string,
      { data: string; systemPromptAddendum: string; ownerId: string },
    ];
    // RespawnLaunchSpec.firstPrompt is null after an answered owner turn. Before
    // WI-39942 the polite watchdog converted that to data:'', so psu-pty-host
    // booted the successor but intentionally skipped injectTurnAtPrompt; a solo
    // interactive session with no loop/event wake then parked until Avi typed.
    expect(payload.data).toMatch(/^⟦turn-origin:watchdog nonce:/);
    expect(payload.data).toContain('ADDRESSED TO hot');
    expect(payload.data).toContain('⟦post-compaction-recovery⟧');
    expect(payload.data).toContain('do not call coord:orient');
    expect(payload.data).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    expect(payload.data).toContain('coord:orient { afterCompaction: true }');
    expect(payload.data).toContain('exactly once only when the marker is absent');
    expect(payload.data).not.toContain('First re-run coord:orient');
    expect(payload.data).toContain("sessions:search { session:'self', mode:'verbatim' }");
    expect(payload.systemPromptAddendum).toBe('deterministic carry');
    expect(payload.ownerId).toBe('hot');
  });

  it('is byte-identical to the prior grace-band behavior while the cutover flag is OFF', async () => {
    estimateMock.mockResolvedValue(170_000);
    specMock.mockResolvedValue('sonnet');
    findLiveHostMock.mockReturnValue({
      sock: '/tmp/hot.sock',
      caps: ['carry-respawn', 'compact'],
    });
    hostSupportsMock.mockReturnValue(true);

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.overLimit).toEqual(['hot']);
    expect(out.carryRespawned).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(buildOwnerRespawnMock).not.toHaveBeenCalled();
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('refuses a deliberate cut that would cross an unanswered owner message', async () => {
    estimateMock.mockResolvedValue(170_000);
    specMock.mockResolvedValue('sonnet');
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-1' });
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);
    buildOwnerRespawnMock.mockResolvedValue({
      systemPromptAddendum: 'deterministic carry',
      firstPrompt: null,
      budgetChars: 32_000,
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.carryRespawned).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('P-022: a host without carry-respawn is neither cut NOR force-compacted — native /compact has no fallback; the death detector covers it', async () => {
    estimateMock.mockResolvedValue(195_000);
    specMock.mockResolvedValue('sonnet');
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-1' });
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockImplementation(
      (host: unknown, cap: string) =>
        (host as { caps?: string[] }).caps?.includes(cap) ?? false,
    );

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.carryRespawned).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });
});

describe('force rung (agent-managed-compaction P-012, carry-respawn under P-022)', () => {
  const seeded = [{ owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 }];

  it('force-respawns an over-limit session with a carry-respawn-capable live host (mode:carry-respawn, addendum + bound-naming first prompt)', async () => {
    estimateMock.mockResolvedValue(200_000); // over 158k
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);
    newestTranscriptMock.mockReturnValue('/tmp/live-session.jsonl');
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']);
    expect(out.forceCompacted).toEqual(['hot']);
    expect(injectMock).toHaveBeenCalledTimes(1);
    const [sock, payload] = injectMock.mock.calls[0] as unknown as [
      string,
      { mode: string; data: string; systemPromptAddendum?: string },
    ];
    expect(sock).toBe('/tmp/hot.sock');
    expect(payload.mode).toBe('carry-respawn');
    expect(payload.systemPromptAddendum).toBe('deterministic carry');
    // A forced cut is NOT a clean deliberate boundary — the spec build must say so.
    expect(buildOwnerRespawnMock).toHaveBeenCalledWith(
      'hot',
      expect.objectContaining({
        buildOpts: expect.objectContaining({ boundaryDeliberate: false }),
      }),
    );
    expect(runFlushGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: 'compaction',
        mode: 'forced',
        ownerId: 'hot',
        workspaceId: '*',
        sessionId: 'hot',
      }),
    );
    expect(runFlushGateMock.mock.invocationCallOrder[0]).toBeLessThan(
      buildOwnerRespawnMock.mock.invocationCallOrder[0]!,
    );
    // Unknown window (no spec resolvable) ⇒ the overshoot bound set forceAt — the
    // note must name THAT, not claim "≈ 1.3 ×" (false math; owner 2026-07-05).
    expect(payload.data).toContain('ADDRESSED TO hot');
    expect(payload.data).toContain('conservative bound used when the model window is unknown');
    expect(payload.data).toContain('1.2 × your soft limit of 158k');
    expect(payload.data).not.toContain('≈ 1.3 ×');
  });

  it('P-022: no carry-respawn capability ⇒ NOT forced — native /compact has no fallback anymore', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock' });
    hostSupportsMock.mockReturnValue(false);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('P-010 at force level: an OPEN owner message rides verbatim as the successor first prompt (never blocks the forced cut)', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);
    newestTranscriptMock.mockReturnValue('/tmp/live-session.jsonl');
    buildOwnerRespawnMock.mockResolvedValue({
      systemPromptAddendum: 'deterministic carry',
      firstPrompt: 'and also fix the login page',
      budgetChars: 32_000,
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.forceCompacted).toEqual(['hot']);
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(payload.mode).toBe('carry-respawn');
    expect(payload.data).toBe('and also fix the login page');
  });

  it('an unresolved session ref and no transcript cannot drive an estimate-based cut', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);
    resolveSessionRefMock.mockResolvedValue(null);
    newestTranscriptMock.mockReturnValue(null);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.forceCompacted).toEqual([]);
    expect(out.overLimit).toEqual([]);
    expect(estimateMock).not.toHaveBeenCalled();
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('does NOT force-compact when the flag is OFF (warn-only, byte-identical to pre-P-012)', async () => {
    estimateMock.mockResolvedValue(200_000);
    getFlagMock.mockResolvedValue(false);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']); // still detected + warned
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('no live psu-pty host ⇒ over-limit but not forced (the context-death detector covers it)', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue(null);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']);
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('EI-9982: no live host ⇒ warns ONCE per crossing with a distinct diagnostic (not silent)', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue(null);
    const warnSpy = vi.spyOn(console, 'warn');
    // Pass 1: crossing ⇒ exactly one diagnostic warn naming findLiveHost/EI-9982.
    await checkCompactionCompliance(fakeSql({ seeded }));
    const diagCalls = () =>
      warnSpy.mock.calls.filter((c) => String(c[0]).includes('findLiveHost() found no live psu-pty host'));
    expect(diagCalls()).toHaveLength(1);
    expect(diagCalls()[0]?.[0]).toContain('EI-9982');
    // Pass 2: still over limit, still no host ⇒ deduped, no second diagnostic.
    await checkCompactionCompliance(fakeSql({ seeded }));
    expect(diagCalls()).toHaveLength(1);
    // Recovery ⇒ dedup clears; a later crossing warns again.
    estimateMock.mockResolvedValue(10);
    await checkCompactionCompliance(fakeSql({ seeded }));
    estimateMock.mockResolvedValue(200_000);
    await checkCompactionCompliance(fakeSql({ seeded }));
    expect(diagCalls()).toHaveLength(2);
  });

  it('injects ONCE per crossing (deduped across passes), and re-arms after recovery', async () => {
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    // Pass 1: over limit ⇒ force-compact.
    estimateMock.mockResolvedValue(200_000);
    const p1 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p1.forceCompacted).toEqual(['hot']);
    expect(injectMock).toHaveBeenCalledTimes(1);
    // Pass 2: STILL over limit but already forced ⇒ no duplicate inject.
    const p2 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p2.forceCompacted).toEqual([]);
    expect(injectMock).toHaveBeenCalledTimes(1);
    // Pass 3: recovered (under limit) — clears the dedup.
    estimateMock.mockResolvedValue(40_000);
    await checkCompactionCompliance(fakeSql({ seeded }));
    // Pass 4: over limit AGAIN ⇒ re-fires.
    estimateMock.mockResolvedValue(200_000);
    const p4 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p4.forceCompacted).toEqual(['hot']);
    expect(injectMock).toHaveBeenCalledTimes(2);
  });

  it('a failed inject is not recorded, so the next pass retries', async () => {
    estimateMock.mockResolvedValue(200_000);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    injectMock.mockResolvedValueOnce(false); // pass 1 inject fails
    const p1 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p1.forceCompacted).toEqual([]);
    const p2 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p2.forceCompacted).toEqual(['hot']); // retried, succeeded
    expect(injectMock).toHaveBeenCalledTimes(2);
  });

  it('over limit but inside the grace band ⇒ warned, NOT forced (owner grace 2026-07-04)', async () => {
    // sonnet = 200k window ⇒ forceAt = min(158k × 1.3 ≈ 205k, 200k − 10k) = 190k.
    specMock.mockResolvedValue('sonnet');
    estimateMock.mockResolvedValue(170_000); // over the 158k limit, under 190k
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.overLimit).toEqual(['hot']); // the 100% warn band is unchanged
    expect(out.forceCompacted).toEqual([]);
    expect(injectMock).not.toHaveBeenCalled();
  });

  it('the window cap bites before 130% on a 200k-window session (forces at window − margin)', async () => {
    specMock.mockResolvedValue('sonnet'); // 200k window ⇒ cap 190k, though 1.3 × 158k ≈ 205k
    estimateMock.mockResolvedValue(195_000); // past the cap, still under 1.3 × limit
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.forceCompacted).toEqual(['hot']);
    // The note names the bound that actually bound: the window cap, not "≈ 1.3 ×".
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { data: string }];
    expect(payload.data).toContain('model-window cap');
    expect(payload.data).toContain('binds below 1.3 × your soft limit of 158k');
    expect(payload.data).not.toContain('≈ 1.3 ×');
    // Cap (190k) > soft limit (158k) ⇒ a self-compact band still exists.
    expect(payload.data).toContain('anywhere between it and the FORCE threshold');
  });

  it('window cap AT/BELOW the soft limit ⇒ the note says there is NO self-compact band (owner 2026-07-05: "~190k ≈ 1.3 × 400k" was false math)', async () => {
    specMock.mockResolvedValue('sonnet'); // 200k window ⇒ cap 190k, BELOW the 300k soft limit
    estimateMock.mockResolvedValue(310_000); // over the limit, under the 2× contradiction bar
    findLiveHostMock.mockReturnValue({ sock: '/tmp/big.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({ seeded: [{ owner_id: 'big', owner_label: 'su · big', compaction_limit: 300_000 }] }),
    );
    expect(out.forceCompacted).toEqual(['big']);
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { data: string }];
    expect(payload.data).toContain('model-window cap');
    expect(payload.data).toContain('no self-compact band');
    expect(payload.data).toContain('config:set-compaction-limit');
    expect(payload.data).not.toContain('≈ 1.3 ×');
    expect(payload.data).not.toContain('anywhere between it and the FORCE threshold');
  });

  it('EI-7632 stale-window guard: an estimate ≥2× the resolved window disproves it — falls back to the unknown-window bound', async () => {
    // The real 2026-07-05 incident: a live [1m] session estimating ~676k while the
    // shared settings.json (rewritten by a mid-session /model toggle) resolved a bare
    // spec ⇒ 200k window. A session truly past its window dies (P-019); a live one
    // this far past has proven the resolution stale — don't cap on it.
    specMock.mockResolvedValue('sonnet'); // stale resolution: 200k window
    estimateMock.mockResolvedValue(676_000); // alive at ≥2× that ⇒ contradiction
    findLiveHostMock.mockReturnValue({ sock: '/tmp/big.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({ seeded: [{ owner_id: 'big', owner_label: 'su · big', compaction_limit: 400_000 }] }),
    );
    expect(out.forceCompacted).toEqual(['big']); // 676k ≥ 480k overshoot bound — still forced
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { data: string }];
    expect(payload.data).toContain('conservative bound used when the model window is unknown');
    expect(payload.data).toContain('1.2 × your soft limit of 400k');
    expect(payload.data).not.toContain('model-window cap');
  });

  it('a [1m] session gets the full 130% band: forced at ≥390k on a 300k limit, not before', async () => {
    specMock.mockResolvedValue('sonnet[1m]'); // 1M window ⇒ forceAt = 300k × 1.3 = 390k
    estimateMock.mockImplementation(async (owner: string) => (owner === 'past' ? 400_000 : 350_000));
    findLiveHostMock.mockReturnValue({ sock: '/tmp/wide.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'warm', owner_label: 'su · warm', compaction_limit: 300_000 },
          { owner_id: 'past', owner_label: 'su · past', compaction_limit: 300_000 },
        ],
      }),
    );
    expect(out.overLimit).toEqual(['warm', 'past']); // both past 100%
    expect(out.forceCompacted).toEqual(['past']); // only the ≥130% one is forced
    // Fraction regime (wide window): the ratified "≈ 1.3 × soft limit" wording holds.
    const [, payload] = injectMock.mock.calls[0] as unknown as [string, { data: string }];
    expect(payload.data).toContain('≈ 1.3 × your configured soft limit of 300k');
  });

  it('EI-9982: a 20k-limit session at 14.8× (295623 est) with a live host force-compacts', async () => {
    // The P-005 rehearsal probe: config:set-compaction-limit { limit: 20000 }, then
    // read 12 large files → 295623 est (1478% of the soft limit). No --model recorded
    // ⇒ window unknown ⇒ overshoot bound (20000 × 1.2 = 24000). 295623 ≫ 24000 ⇒ force.
    specMock.mockResolvedValue(null);
    estimateMock.mockResolvedValue(295_623);
    findLiveHostMock.mockReturnValue({ sock: '/tmp/probe.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({ seeded: [{ owner_id: 'probe', owner_label: 'su · probe', compaction_limit: 20_000 }] }),
    );
    expect(out.overLimit).toEqual(['probe']);
    expect(out.forceCompacted).toEqual(['probe']);
    expect(injectMock).toHaveBeenCalledTimes(1);
  });

  it('EI-9982: re-injects when a prior force-compact never landed (still over-threshold past the retry grace)', async () => {
    // The probe kept taking turns, so its single idle-gated /compact was deferred and
    // never landed — est stayed at 14.8× across sweeps. The pre-EI-9982 dedup suppressed
    // any further inject forever (it only re-armed when est dropped below the SOFT limit,
    // which never happened). Now: within the grace it stays deduped (once-per-crossing),
    // but once the grace elapses and the session is STILL over its force threshold, the
    // watchdog re-injects.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = new Date('2026-07-12T05:00:00Z').getTime();
      vi.setSystemTime(t0);
      specMock.mockResolvedValue(null); // window unknown ⇒ overshoot bound 24000
      estimateMock.mockResolvedValue(295_623); // 14.8× the 20k limit — never drops (host defers)
      findLiveHostMock.mockReturnValue({ sock: '/tmp/probe.sock', caps: ['compact'] });
      hostSupportsMock.mockReturnValue(true);
      const probe = [{ owner_id: 'probe', owner_label: 'su · probe', compaction_limit: 20_000 }];

      // Sweep 1: force-compacts (inject 1).
      const p1 = await checkCompactionCompliance(fakeSql({ seeded: probe }));
      expect(p1.forceCompacted).toEqual(['probe']);
      expect(injectMock).toHaveBeenCalledTimes(1);

      // Sweep 2, ~2 min later (within the grace): still over, but not re-injected —
      // the /compact may still be about to land, so we don't spam.
      vi.setSystemTime(t0 + 2 * 60_000);
      const p2 = await checkCompactionCompliance(fakeSql({ seeded: probe }));
      expect(p2.forceCompacted).toEqual([]);
      expect(injectMock).toHaveBeenCalledTimes(1);

      // Sweep 3, past FORCE_RETRY_GRACE_MS (~6 min): the compaction PROVABLY never landed
      // (est is still 14.8×), so the watchdog re-injects instead of staying silent forever.
      vi.setSystemTime(t0 + 7 * 60_000);
      const p3 = await checkCompactionCompliance(fakeSql({ seeded: probe }));
      expect(p3.forceCompacted).toEqual(['probe']);
      expect(injectMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unknown window ⇒ falls back to the overshoot-factor bound (limit × 1.2); a spawn-record [1m] spec restores the full band', async () => {
    specMock.mockResolvedValue(null); // fs/argv resolver blind (the fleet-bee case)
    estimateMock.mockResolvedValue(370_000); // 300k limit: ≥ 1.2 × 300k = 360k, < 1.3 × 300k = 390k
    findLiveHostMock.mockReturnValue({ sock: '/tmp/bee.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const seeded300 = [{ owner_id: 'cup', owner_label: 'bee · b', compaction_limit: 300_000 }];
    // No spawn record ⇒ window unknown ⇒ conservative 360k bound ⇒ forced at 370k.
    const blind = await checkCompactionCompliance(fakeSql({ seeded: seeded300 }));
    expect(blind.forceCompacted).toEqual(['cup']);
    resetForceCompactedForTests();
    // Same session WITH a [1m] spawn record ⇒ real 1M window ⇒ full 390k band ⇒ not forced yet.
    const known = await checkCompactionCompliance(
      fakeSql({
        seeded: seeded300,
        spawnRecords: { cup: { model_spec: 'claude-fable-5[1m]', model_tier: null } },
      }),
    );
    expect(known.overLimit).toEqual(['cup']);
    expect(known.forceCompacted).toEqual([]);
  });
});

describe('live-config reach (agent-managed-compaction P-017)', () => {
  it('lowers a stale-above-cap limit on a running MEMBER to the current shaped default (250k)', async () => {
    estimateMock.mockResolvedValue(40_000); // under the new limit ⇒ no force
    specMock.mockResolvedValue('sonnet[1m]:high');
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          {
            owner_id: 'stale',
            owner_label: 'su · stale',
            compaction_limit: 500_000,
            compaction_limit_explicit: false,
            fleet_slug: 'backlog-clearance',
            fleet_role: 'member',
          },
        ],
      }),
    );
    expect(setLimitMock).toHaveBeenCalledWith('stale', 250_000);
    expect(out.relimited).toEqual([{ owner: 'stale', from: 500_000, to: 250_000 }]);
    expect(out.overLimit).toEqual([]); // 40k < the corrected 250k
  });

  it('preserves an explicit 680k runtime override below the measured self-set ceiling', async () => {
    estimateMock.mockResolvedValue(40_000);
    contextWindowMock.mockResolvedValue(828_400);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          {
            owner_id: 'explicit',
            owner_label: 'su · explicit',
            compaction_limit: 680_000,
            compaction_limit_explicit: true,
          },
        ],
      }),
    );
    expect(setLimitMock).not.toHaveBeenCalled();
    expect(out.relimited).toEqual([]);
    expect(out.overLimit).toEqual([]);
  });

  it('lowers an explicit override only when it exceeds the measured self-set ceiling', async () => {
    estimateMock.mockResolvedValue(40_000);
    contextWindowMock.mockResolvedValue(828_400);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          {
            owner_id: 'too-wide',
            owner_label: 'su · too-wide',
            compaction_limit: 700_000,
            compaction_limit_explicit: true,
          },
        ],
      }),
    );
    expect(setLimitMock).toHaveBeenCalledWith('too-wide', 682_000);
    expect(out.relimited).toEqual([{ owner: 'too-wide', from: 700_000, to: 682_000 }]);
    expect(out.overLimit).toEqual([]);
  });

  it('a leader/solo stale limit is lowered to the leader cap (400k), not the member 200k', async () => {
    estimateMock.mockResolvedValue(40_000);
    specMock.mockResolvedValue('opus[1m]');
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'lead', owner_label: 'su · lead', compaction_limit: 500_000, fleet_slug: 'backlog-clearance', fleet_role: 'leader' },
          { owner_id: 'solo', owner_label: 'su · solo', compaction_limit: 500_000, fleet_slug: null, fleet_role: null },
        ],
      }),
    );
    expect(setLimitMock).toHaveBeenCalledWith('lead', 450_000);
    expect(setLimitMock).toHaveBeenCalledWith('solo', 450_000);
    expect(out.relimited.map((r) => r.to)).toEqual([450_000, 450_000]);
  });

  it('does NOT touch a limit AT/BELOW the cap (respects a valid explicit override; no spec resolution)', async () => {
    estimateMock.mockResolvedValue(40_000);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'ok', owner_label: 'su · ok', compaction_limit: 300_000, fleet_slug: 'backlog-clearance', fleet_role: 'member' },
          { owner_id: 'atcap', owner_label: 'su · atcap', compaction_limit: 400_000, fleet_slug: null, fleet_role: null },
        ],
      }),
    );
    expect(out.relimited).toEqual([]);
    expect(setLimitMock).not.toHaveBeenCalled();
    expect(specMock).not.toHaveBeenCalled(); // cheap >cap gate skipped the spec resolution entirely
  });

  it('a re-limit CASCADES: a now-over session (est between old & new limit) force-compacts the same pass', async () => {
    estimateMock.mockResolvedValue(450_000); // < old 500k (was safe) but ≥ the new 250k
    specMock.mockResolvedValue('sonnet[1m]');
    findLiveHostMock.mockReturnValue({ sock: '/tmp/stale.sock', caps: ['compact'] });
    hostSupportsMock.mockReturnValue(true);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'stale', owner_label: 'su · stale', compaction_limit: 500_000, fleet_slug: 'backlog-clearance', fleet_role: 'member' },
        ],
      }),
    );
    expect(out.relimited).toEqual([{ owner: 'stale', from: 500_000, to: 250_000 }]);
    expect(out.overLimit).toEqual(['stale']); // 450k ≥ the corrected 250k
    expect(out.forceCompacted).toEqual(['stale']); // and the P-012 rung fires on the corrected limit
  });
});

describe('gateway observed total-input floor semantics', () => {
  it('does not re-limit or skip ordinary over-limit handling for a high total-input floor', async () => {
    estimateMock.mockResolvedValue(300_000);
    observedPromptFloorMock.mockReturnValue({ tokens: 396_171, observations: 3, at: Date.now() });
    contextWindowMock.mockResolvedValue(1_000_000);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [{
          owner_id: 'floor-bound',
          owner_label: 'su · floor-bound',
          compaction_limit: 250_000,
          compaction_limit_explicit: false,
          fleet_slug: 'nonp2p-bug-drain-luna-max-50',
          fleet_role: 'member',
        }],
      }),
    );

    expect(setLimitMock).not.toHaveBeenCalled();
    expect(out.relimited).toEqual([]);
    expect(out.unsatisfiableLimits).toEqual([]);
    expect(out.overLimit).toEqual(['floor-bound']);
    expect(out.carryRespawned).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(openEscalationMock).not.toHaveBeenCalled();
  });

  it('keeps an explicit limit and ordinary over-limit handling under a high total-input floor', async () => {
    estimateMock.mockResolvedValue(300_000);
    observedPromptFloorMock.mockReturnValue({ tokens: 340_000, observations: 3, at: Date.now() });
    contextWindowMock.mockResolvedValue(1_000_000);
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [{
          owner_id: 'explicit-floor-bound',
          owner_label: 'su · explicit-floor-bound',
          compaction_limit: 250_000,
          compaction_limit_explicit: true,
        }],
      }),
    );

    expect(out.unsatisfiableLimits).toEqual([]);
    expect(setLimitMock).not.toHaveBeenCalled();
    expect(out.overLimit).toEqual(['explicit-floor-bound']);
    expect(out.carryRespawned).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(openEscalationMock).not.toHaveBeenCalled();
  });
});

describe('context-death detector (context-trimming-tiers P-019)', () => {
  it('carry-respawns a dead session before escalating, using a forced boundary and measured window', async () => {
    resetContextDeathEscalationsForTests();
    estimateMock.mockResolvedValue(40_000);
    contextWindowMock.mockResolvedValue(258_400);
    deathMock.mockImplementation(async (owner: string) => owner === 'dead');
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-dead' });
    findLiveHostMock.mockReturnValue({ sock: '/tmp/dead.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);
    buildOwnerRespawnMock.mockResolvedValue({
      systemPromptAddendum: 'deterministic carry',
      firstPrompt: 'resume after the overflow',
      budgetChars: 32_000,
      // A death recovery is FORCED, so even an open owner message is carried
      // rather than refused at the deliberate-boundary gate.
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });
    const seeded = [
      {
        owner_id: 'dead',
        owner_label: 'bee · dead',
        workspace_id: 'ws-dead',
        compaction_limit: 158_000,
      },
    ];

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.contextDeaths).toEqual(['dead']);
    expect(out.carryRespawned).toEqual(['dead']);
    expect(openEscalationMock).not.toHaveBeenCalled();
    expect(buildOwnerRespawnMock).toHaveBeenCalledWith(
      'dead',
      expect.objectContaining({
        effectiveWindowTokens: 258_400,
        buildOpts: expect.objectContaining({
          workspaceId: 'ws-dead',
          ownerLabel: 'bee · dead',
          transcriptPath: '/tmp/live-session.jsonl',
          transcriptSourceKind: 'claude',
          boundaryDeliberate: false,
          boundarySelfRequested: false,
        }),
      }),
    );
    expect(injectMock).toHaveBeenCalledWith('/tmp/dead.sock', {
      mode: 'carry-respawn',
      data: 'resume after the overflow',
      systemPromptAddendum: 'deterministic carry',
      ownerId: 'dead',
    });

    // The detector may still see the dead tail while the host is replacing the
    // child; the socket-ACK grace prevents a duplicate successor or fallback.
    const again = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(again.contextDeaths).toEqual(['dead']);
    expect(again.carryRespawned).toEqual([]);
    expect(injectMock).toHaveBeenCalledTimes(1);
    expect(openEscalationMock).not.toHaveBeenCalled();
  });

  it('falls back to the blocker escalation when death recovery injection fails', async () => {
    resetContextDeathEscalationsForTests();
    contextWindowMock.mockResolvedValue(200_000);
    deathMock.mockImplementation(async (owner: string) => owner === 'dead');
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-dead' });
    findLiveHostMock.mockReturnValue({ sock: '/tmp/dead.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);
    injectMock.mockResolvedValue(false);
    const seeded = [
      {
        owner_id: 'dead',
        owner_label: 'bee · dead',
        workspace_id: 'ws-dead',
        compaction_limit: 158_000,
      },
    ];

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.contextDeaths).toEqual(['dead']);
    expect(out.carryRespawned).toEqual([]);
    expect(injectMock).toHaveBeenCalledTimes(1);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [, input] = openEscalationMock.mock.calls[0] as unknown as [
      { ownerId: string },
      { summary: string },
    ];
    expect(input.summary).toContain('Prompt is too long');
    expect(input.summary).toContain('dead');
  });

  it('a "Prompt is too long" transcript raises ONE blocker escalation, deduped across passes', async () => {
    resetContextDeathEscalationsForTests();
    estimateMock.mockResolvedValue(40_000);
    deathMock.mockImplementation(async (owner: string) => owner === 'dead');
    const seeded = [
      { owner_id: 'dead', owner_label: 'bee · dead', compaction_limit: 158_000 },
      { owner_id: 'fine', owner_label: 'bee · fine', compaction_limit: 158_000 },
    ];
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.contextDeaths).toEqual(['dead']);
    expect(out.estimated).toEqual(['fine']); // the dead session is not estimated
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [identity, input] = openEscalationMock.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string; meta?: { subjectSignature?: string } },
    ];
    expect(identity.ownerId).toBe('compaction-watchdog');
    expect(input.severity).toBe('blocker');
    expect(input.summary).toContain('Prompt is too long');
    expect(input.summary).toContain('dead');
    // WI-5848: stable conditionKey, keyed only on the owner identity — never on
    // anything that could vary across occurrences (defense-in-depth alongside
    // EI-18668025239634541's fix).
    expect(input.meta?.subjectSignature).toBe('compaction-watchdog:context-death:dead');
    // Second pass: still dead, but already escalated — no duplicate.
    const again = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(again.contextDeaths).toEqual(['dead']);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });
});

describe('tool-reference death detector (WI-10003466)', () => {
  const strandedTail = {
    turns: 3,
    toolName: 'mcp__papercusp-su__capability_bash',
    evidence: "API Error: 400 Tool reference 'mcp__papercusp-su__capability_bash' not found in available tools",
  };
  const seeded = [
    { owner_id: 'stranded', owner_label: 'su · stranded', workspace_id: 'ws-s', compaction_limit: 158_000 },
    { owner_id: 'fine', owner_label: 'su · fine', workspace_id: 'ws-s', compaction_limit: 158_000 },
  ];

  it('heals a stranded live session with a forced carry-respawn instead of leaving it beating', async () => {
    resetContextDeathEscalationsForTests();
    resetCarryRespawnForTests();
    estimateMock.mockResolvedValue(40_000);
    contextWindowMock.mockResolvedValue(1_000_000);
    toolRefDeathMock.mockImplementation(async (owner: string) => (owner === 'stranded' ? strandedTail : null));
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-stranded' });
    findLiveHostMock.mockReturnValue({ sock: '/tmp/stranded.sock', caps: ['carry-respawn'] });
    hostSupportsMock.mockReturnValue(true);

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.toolReferenceDeaths).toEqual(['stranded']);
    expect(out.contextDeaths).toEqual([]);
    expect(out.carryRespawned).toContain('stranded');
    expect(out.estimated).not.toContain('stranded'); // a dead session is never estimated
    expect(openEscalationMock).not.toHaveBeenCalled();
    // Forced boundary: a death is never a deliberate/self-requested cut.
    expect(buildOwnerRespawnMock).toHaveBeenCalledWith(
      'stranded',
      expect.objectContaining({
        effectiveWindowTokens: 1_000_000,
        buildOpts: expect.objectContaining({ boundaryDeliberate: false, boundarySelfRequested: false }),
      }),
    );
    // No firstPrompt from the carry ⇒ the watchdog's own continue note names the cause.
    expect(injectMock).toHaveBeenCalledWith(
      '/tmp/stranded.sock',
      expect.objectContaining({
        mode: 'carry-respawn',
        ownerId: 'stranded',
        data: expect.stringContaining('referenced a tool that was no longer available'),
      }),
    );

    // Same tail on the next pass while the host replaces the child: grace, no duplicate.
    const again = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(again.toolReferenceDeaths).toEqual(['stranded']);
    expect(again.carryRespawned).not.toContain('stranded');
    expect(injectMock).toHaveBeenCalledTimes(1);
  });

  it('escalates once, under its own condition key, when no host can carry-respawn it', async () => {
    resetContextDeathEscalationsForTests();
    resetCarryRespawnForTests();
    estimateMock.mockResolvedValue(40_000);
    toolRefDeathMock.mockImplementation(async (owner: string) => (owner === 'stranded' ? strandedTail : null));
    // Default: no live host ⇒ maybeCarryRespawn cannot queue a successor.
    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.toolReferenceDeaths).toEqual(['stranded']);
    expect(out.carryRespawned).toEqual([]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [, input] = openEscalationMock.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string; meta?: { subjectSignature?: string } },
    ];
    expect(input.severity).toBe('blocker');
    expect(input.summary).toContain('references a tool that is no longer available');
    expect(input.summary).not.toContain('Prompt is too long');
    expect(input.meta?.subjectSignature).toBe('compaction-watchdog:tool-reference-death:stranded');

    const again = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(again.toolReferenceDeaths).toEqual(['stranded']);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });

  it('a context-dead owner is recovered once as a context death, never double-counted', async () => {
    resetContextDeathEscalationsForTests();
    resetCarryRespawnForTests();
    deathMock.mockImplementation(async (owner: string) => owner === 'stranded');
    toolRefDeathMock.mockResolvedValue(strandedTail);

    const out = await checkCompactionCompliance(fakeSql({ seeded }));

    expect(out.contextDeaths).toEqual(['stranded']);
    expect(out.toolReferenceDeaths).toEqual(['fine']);
    expect(toolRefDeathMock).not.toHaveBeenCalledWith('stranded');
    expect(openEscalationMock).toHaveBeenCalledTimes(2);
    const signatures = openEscalationMock.mock.calls.map(
      (c) => (c as unknown as [unknown, { meta?: { subjectSignature?: string } }])[1].meta?.subjectSignature,
    );
    expect(signatures).toEqual([
      'compaction-watchdog:context-death:stranded',
      'compaction-watchdog:tool-reference-death:fine',
    ]);
  });
});

describe('gauge cache + flag mirror wiring (agent-managed-compaction P-013)', () => {
  const seeded = [{ owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 300_000 }];

  it('mirrors each estimated session into the in-process gauge cache', async () => {
    estimateMock.mockResolvedValue(210_000); // 70% of 300k
    expect(getContextUsage('hot')).toBeNull();
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.estimated).toEqual(['hot']);
    expect(getContextUsage('hot')).toEqual({ tokens: 210_000, limit: 300_000 });
  });

  it('threads route-bound prompt-floor evidence into the existing gauge cache', async () => {
    estimateMock.mockResolvedValue(199_236);
    observedPromptFloorMock.mockReturnValue({ tokens: 167_686, observations: 3, at: Date.now() });
    await checkCompactionCompliance(fakeSql({ seeded }));
    expect(getContextUsage('hot')).toEqual({
      tokens: 199_236,
      limit: 300_000,
      observedPromptFloor: { tokens: 167_686, observations: 3 },
    });
  });

  it('does not cache a session whose estimate is unresolvable (null)', async () => {
    estimateMock.mockResolvedValue(null);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.estimated).toEqual([]);
    expect(getContextUsage('hot')).toBeNull();
  });

  it('mirrors FLAGS.CONTEXT_GAUGE into the sync gauge switch each pass', async () => {
    estimateMock.mockResolvedValue(210_000);
    expect(isContextGaugeEnabled()).toBe(true); // default
    getFlagMock.mockResolvedValue(false); // gauge (and force) flag OFF this pass
    await checkCompactionCompliance(fakeSql({ seeded }));
    expect(isContextGaugeEnabled()).toBe(false);
    // Flag flipped back ON reaches the switch on the next sweep.
    getFlagMock.mockResolvedValue(true);
    await checkCompactionCompliance(fakeSql({ seeded }));
    expect(isContextGaugeEnabled()).toBe(true);
  });
});

describe('boot self-assert: dark telemetry (agent-managed-compaction P-018)', () => {
  // WI-2140608: the streak only advances on ACTIVE null sweeps (last eligible turn inside
  // DARK_TELEMETRY_ACTIVE_WINDOW_MS), so the blind session under test is one that keeps
  // taking turns. `idle()` is the parked / provider-stalled shape the old rule misread.
  const active = () => [
    { owner_id: 'blind', owner_label: 'su · blind', compaction_limit: 300_000, last_turn_at: new Date().toISOString() },
  ];
  const idle = () => [
    {
      owner_id: 'blind',
      owner_label: 'su · blind',
      compaction_limit: 300_000,
      last_turn_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    },
  ];
  let seeded: ReturnType<typeof active> = [];
  beforeEach(() => {
    seeded = active();
  });

  // The genuinely-blind session this detector targets is a REAL launched session: it has an
  // adv_sessions row, so resolveSessionRef resolves to a non-null ref (agent 'claude'/unknown) —
  // only its transcript/estimate won't resolve. Default the mock to that so the 'blind' tests
  // model reality. WI-2917 made a NULL ref mean "synthetic principal, not a session" (exempt), so
  // without this default the blind tests would silently exercise the synthetic-exempt path instead.
  beforeEach(() => {
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 's-blind' });
  });

  it('escalates a session whose estimate never resolves — only after the grace sweeps, once (deduped)', async () => {
    estimateMock.mockResolvedValue(null); // context estimate never resolves ⇒ dark telemetry
    // Sweeps 1-2 are within the grace window (a normal boot reads null briefly) ⇒ no escalation.
    const p1 = await checkCompactionCompliance(fakeSql({ seeded }));
    const p2 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p1.bootConfigAlerts).toEqual([]);
    expect(p2.bootConfigAlerts).toEqual([]);
    expect(p1.estimated).toEqual([]); // a null-estimate session is never cached/estimated
    expect(openEscalationMock).not.toHaveBeenCalled();
    // Sweep 3 crosses DARK_TELEMETRY_MAX_NULL_SWEEPS ⇒ one advisory escalation.
    const p3 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p3.bootConfigAlerts).toEqual([{ owner: 'blind', kind: 'dark-telemetry', detail: '3 null sweeps' }]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [identity, input] = openEscalationMock.mock.calls[0] as unknown as [
      { ownerId: string },
      { severity: string; summary: string; meta?: { subjectSignature?: string } },
    ];
    expect(identity.ownerId).toBe('compaction-watchdog');
    expect(input.severity).toBe('advisory'); // self-clearing band, not a blocker
    expect(input.summary).toContain('DARK context telemetry');
    expect(input.summary).toContain('blind');
    // WI-5848: stable conditionKey keyed on owner+kind ONLY — the summary above embeds
    // a live streak/duration (`~Nmin`) that backs off across occurrences exactly like
    // EI-18668025239634541's fixed bug, so the dedup key must NOT vary with it (the
    // in-memory bootConfigEscalated guard is the only OTHER protection, and it resets
    // on a process restart — this is the durable defense-in-depth).
    expect(input.meta?.subjectSignature).toBe('compaction-watchdog:boot-config:blind:dark-telemetry');
    // Sweep 4 still dark, but already escalated ⇒ alert still surfaced, escalation deduped.
    const p4 = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(p4.bootConfigAlerts).toEqual([{ owner: 'blind', kind: 'dark-telemetry', detail: '4 null sweeps' }]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat a fresh hook-only presence dispatch as an active turn', async () => {
    estimateMock.mockResolvedValue(null);
    const hookOnly = [{
      owner_id: 'blind',
      owner_label: 'su · blind',
      compaction_limit: 300_000,
      last_active_at: new Date().toISOString(),
      last_turn_at: null,
    }];

    for (let sweep = 0; sweep < 4; sweep++) {
      const out = await checkCompactionCompliance(fakeSql({ seeded: hookOnly }));
      expect(out.bootConfigAlerts).toEqual([]);
    }
    expect(openEscalationMock).not.toHaveBeenCalled();

    const query = observedSqlQueries.find(({ query }) =>
      query.includes('FROM harness_shared.coord_presence cp') && query.includes('harness_shared.tool_invocations'));
    expect(query).toBeDefined();
    expect(query!.query).toContain("ti.invoked_at > now() - interval '15 minutes'");
    expect(query!.query).toContain('ti.coord_owner_id = cp.owner_id');
    expect(query!.query).toContain("ti.call_origin = 'agent'");
    expect(query!.query).toContain("ti.call_origin = 'hook' AND ti.tool_name = 'activity:report'");
    expect(query!.query).toContain("ti.args_json->>'phase' = ANY(");
    expect(query!.values).toContainEqual(['session:request-compaction']);
    expect(query!.values).toContainEqual(['journal:record-turn', 'locks:acquire', 'locks:check_command', 'locks:release']);
    expect(query!.values).toContainEqual(['pre', 'post']);
  });

  it('does not treat a predecessor-session activity hook as a current active turn', async () => {
    estimateMock.mockResolvedValue(null);
    const sessionStartedAtMs = Date.now() - 2 * 60_000;
    const sessionStartedAt = new Date(sessionStartedAtMs);
    const beforeSessionStart = new Date(sessionStartedAtMs - 13_122);
    const afterSessionStart = new Date(Date.now() - 1_000);
    const currentRef = {
      agent: 'codex',
      sessionId: 'codex-current',
      sessionKey: 45210,
      startedAtMs: sessionStartedAtMs,
    };
    resolveSessionRefMock.mockResolvedValue(currentRef);

    const seeded = [
      {
        owner_id: 'blind-before-session',
        owner_label: 'su · blind-before-session',
        compaction_limit: 300_000,
        last_turn_at: beforeSessionStart,
        last_turn_session_id: 'codex-predecessor',
        active_session_id: 'codex-current',
        active_session_started_at: sessionStartedAt,
      },
      {
        owner_id: 'blind-late-predecessor-hook',
        owner_label: 'su · blind-late-predecessor-hook',
        compaction_limit: 300_000,
        last_turn_at: afterSessionStart,
        last_turn_session_id: 'codex-predecessor',
        active_session_id: 'codex-current',
        active_session_started_at: sessionStartedAt,
      },
      {
        owner_id: 'blind-current-session',
        owner_label: 'su · blind-current-session',
        compaction_limit: 300_000,
        last_turn_at: afterSessionStart,
        last_turn_session_id: 'codex-current',
        active_session_id: 'codex-current',
        active_session_started_at: sessionStartedAt,
      },
    ];

    for (let sweep = 0; sweep < 3; sweep++) {
      const out = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(out.bootConfigAlerts).toEqual(sweep < 2 ? [] : [
        { owner: 'blind-current-session', kind: 'dark-telemetry', detail: '3 null sweeps' },
      ]);
    }

    const query = observedSqlQueries.find(({ query }) =>
      query.includes('FROM harness_shared.coord_presence cp') && query.includes('harness_shared.tool_invocations'));
    expect(query).toBeDefined();
    expect(query!.query).toContain('FROM harness_shared.adv_sessions s');
    expect(query!.query).toContain('s.coord_owner_id = cp.owner_id');
    expect(query!.query).toContain('ti.invoked_at >= active_session.started_at');
    expect(query!.query).toContain("ti.args_json->>'session_id' = active_session.session_id");
  });

  it('a resolved estimate clears the streak — a brief null run never reaches the escalation threshold', async () => {
    estimateMock.mockResolvedValue(null);
    await checkCompactionCompliance(fakeSql({ seeded })); // streak 1
    await checkCompactionCompliance(fakeSql({ seeded })); // streak 2
    estimateMock.mockResolvedValue(210_000);
    const p3 = await checkCompactionCompliance(fakeSql({ seeded })); // resolves ⇒ streak cleared
    expect(p3.estimated).toEqual(['blind']);
    estimateMock.mockResolvedValue(null);
    const p4 = await checkCompactionCompliance(fakeSql({ seeded })); // streak back to 1
    const p5 = await checkCompactionCompliance(fakeSql({ seeded })); // streak 2 — still under grace
    expect(p4.bootConfigAlerts).toEqual([]);
    expect(p5.bootConfigAlerts).toEqual([]);
    expect(openEscalationMock).not.toHaveBeenCalled(); // never 3 CONSECUTIVE nulls
  });

  it('resets the dark-telemetry grace when the Codex native session ref changes', async () => {
    estimateMock.mockResolvedValue(null);
    resolveSessionRefMock
      .mockResolvedValueOnce({ agent: 'codex', sessionId: 'codex-old', sessionKey: 1 })
      .mockResolvedValueOnce({ agent: 'codex', sessionId: 'codex-old', sessionKey: 1 })
      .mockResolvedValueOnce({ agent: 'codex', sessionId: 'codex-new', sessionKey: 1 })
      .mockResolvedValueOnce({ agent: 'codex', sessionId: 'codex-new', sessionKey: 1 })
      .mockResolvedValueOnce({ agent: 'codex', sessionId: 'codex-new', sessionKey: 1 });

    const old1 = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    const old2 = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    const new1 = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    const new2 = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    const new3 = await checkCompactionCompliance(fakeSql({ seeded: active() }));

    expect(old1.bootConfigAlerts).toEqual([]);
    expect(old2.bootConfigAlerts).toEqual([]);
    expect(new1.bootConfigAlerts).toEqual([]);
    expect(new2.bootConfigAlerts).toEqual([]);
    expect(new3.bootConfigAlerts).toEqual([
      { owner: 'blind', kind: 'dark-telemetry', detail: '3 null sweeps' },
    ]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });

  it('WI-2140608: an IDLE blind session never accumulates a streak — no turns, nothing to overflow', async () => {
    estimateMock.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) {
      const out = await checkCompactionCompliance(fakeSql({ seeded: idle() }));
      expect(out.bootConfigAlerts).toEqual([]);
    }
    expect(openEscalationMock).not.toHaveBeenCalled();
    // A row with NO recorded activity (never took a turn since presence started) is idle too.
    const never = [{ owner_id: 'blind', owner_label: 'su · blind', compaction_limit: 300_000, last_turn_at: null }];
    for (let i = 0; i < 5; i++) await checkCompactionCompliance(fakeSql({ seeded: never }));
    expect(openEscalationMock).not.toHaveBeenCalled();
  });

  it('WI-2140608: idle sweeps neither advance nor reset the streak — three ACTIVE null sweeps over any span escalate', async () => {
    estimateMock.mockResolvedValue(null);
    await checkCompactionCompliance(fakeSql({ seeded: active() })); // active-null 1
    await checkCompactionCompliance(fakeSql({ seeded: active() })); // active-null 2
    for (let i = 0; i < 3; i++) await checkCompactionCompliance(fakeSql({ seeded: idle() })); // parked — no change
    expect(openEscalationMock).not.toHaveBeenCalled();
    const p = await checkCompactionCompliance(fakeSql({ seeded: active() })); // active-null 3 ⇒ escalate
    expect(p.bootConfigAlerts).toEqual([{ owner: 'blind', kind: 'dark-telemetry', detail: '3 null sweeps' }]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const [, input] = openEscalationMock.mock.calls[0] as unknown as [unknown, { summary: string }];
    expect(input.summary).toContain('ACTIVE watchdog sweeps');
    expect(input.summary).not.toContain('since boot'); // the old wording asserted a boot-time defect that the data refuted
  });

  it('WI-2140608: a recovered estimate resolves the open dark-telemetry row and re-arms the guard', async () => {
    estimateMock.mockResolvedValue(null);
    for (let i = 0; i < 3; i++) await checkCompactionCompliance(fakeSql({ seeded: active() }));
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    listEscalationsMock.mockResolvedValue([
      { msg_id: 'esc-1', from: 'compaction-watchdog', subjectSignature: 'compaction-watchdog:boot-config:blind:dark-telemetry' },
      { msg_id: 'esc-other', from: 'compaction-watchdog', subjectSignature: 'compaction-watchdog:boot-config:other:dark-telemetry' },
    ]);
    estimateMock.mockResolvedValue(210_000);
    const rec = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    expect(rec.bootConfigRecovered).toEqual([{ owner: 'blind', kind: 'dark-telemetry' }]);
    expect(listEscalationsMock).toHaveBeenCalledWith({ status: 'open' });
    expect(resolveEscalationMock).toHaveBeenCalledTimes(1);
    expect(resolveEscalationMock.mock.calls[0][0]).toMatchObject({
      msg_id: 'esc-1',
      choice: 'recovered',
      resolver: 'compaction-watchdog',
    });
    // Steady state: a resolved session never re-touches the escalation store.
    const steady = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    expect(steady.bootConfigRecovered).toEqual([]);
    expect(listEscalationsMock).toHaveBeenCalledTimes(1);
    // Re-darkening re-escalates (the guard was re-armed) on a fresh row.
    estimateMock.mockResolvedValue(null);
    for (let i = 0; i < 3; i++) await checkCompactionCompliance(fakeSql({ seeded: active() }));
    expect(openEscalationMock).toHaveBeenCalledTimes(2);
  });

  it('WI-2140608: a failed lookup/resolve keeps the guard armed so the next pass retries', async () => {
    estimateMock.mockResolvedValue(null);
    for (let i = 0; i < 3; i++) await checkCompactionCompliance(fakeSql({ seeded: active() }));
    listEscalationsMock.mockRejectedValueOnce(new Error('pg down'));
    estimateMock.mockResolvedValue(210_000);
    const p1 = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    expect(p1.bootConfigRecovered).toEqual([]);
    const p2 = await checkCompactionCompliance(fakeSql({ seeded: active() }));
    expect(p2.bootConfigRecovered).toEqual([{ owner: 'blind', kind: 'dark-telemetry' }]);
    expect(resolveEscalationMock).not.toHaveBeenCalled(); // no open row was listed ⇒ nothing to resolve, guard still cleared
  });

  it('resolves a one-shot dark-telemetry episode only for ended owners, preserving recorded and unknown states', async () => {
    const endedKey = compactionConditionKey('workspace', 'ended-dark', 'dark-telemetry');
    const endedResolved: string[] = [];
    const endedDeps: CompactionComplianceDeps = {
      readOpenConditions: async () => [{ conditionKey: endedKey, openedAtMs: Date.now() - 1_000 }],
      resolveSessionStatesFn: async (subjects) => new Map(subjects.map(({ ownerId }) =>
        [ownerId, { sessionState: 'ended' } as never] as const)),
      rail: {
        resolve: async (event) => {
          endedResolved.push(event.conditionKey);
          return true;
        },
      },
    };
    await checkCompactionCompliance(fakeSql({}), endedDeps);
    expect(endedResolved).toEqual([endedKey]);

    const activeKey = compactionConditionKey('workspace', 'active-dark', 'dark-telemetry');
    const activeResolved: string[] = [];
    const activeDeps: CompactionComplianceDeps = {
      readOpenConditions: async () => [{ conditionKey: activeKey, openedAtMs: Date.now() - 1_000 }],
      resolveSessionStatesFn: async (subjects) => new Map(subjects.map(({ ownerId }) =>
        [ownerId, { sessionState: 'recorded' } as never] as const)),
      rail: {
        resolve: async (event) => {
          activeResolved.push(event.conditionKey);
          return true;
        },
      },
    };
    await checkCompactionCompliance(fakeSql({
      seeded: [{ owner_id: 'active-dark', owner_label: 'su · active-dark', compaction_limit: 300_000,
        last_turn_at: new Date().toISOString() }],
    }), activeDeps);
    expect(activeResolved).toEqual([]);

    const unknownResolved: string[] = [];
    const unknownDeps: CompactionComplianceDeps = {
      readOpenConditions: async () => [{ conditionKey: endedKey, openedAtMs: Date.now() - 1_000 }],
      resolveSessionStatesFn: async (subjects) => new Map(subjects.map(({ ownerId }) =>
        [ownerId, { sessionState: null } as never] as const)),
      rail: {
        resolve: async (event) => {
          unknownResolved.push(event.conditionKey);
          return true;
        },
      },
    };
    await checkCompactionCompliance(fakeSql({}), unknownDeps);
    expect(unknownResolved).toEqual([]);
  });

  it('reads old compaction episodes outside the generic condition window before lifecycle recovery', async () => {
    const endedKey = compactionConditionKey('workspace', 'ended-old', 'over-limit');
    const resolved: string[] = [];
    const deps: CompactionComplianceDeps = {
      rail: { resolve: async (event) => { resolved.push(event.conditionKey); return true; } },
      resolveSessionStatesFn: async (subjects) => new Map(subjects.map(({ ownerId }) =>
        [ownerId, { sessionState: 'ended' } as never] as const)),
    };
    await checkCompactionCompliance(fakeSql({
      conditionEpisodes: [{ condition_key: endedKey, opened_at: new Date(Date.now() - 86_400_000) }],
    }), deps);
    expect(resolved).toEqual([endedKey]);
  });

  it('a context-DEAD session (P-019) is not double-counted as dark telemetry', async () => {
    resetContextDeathEscalationsForTests();
    estimateMock.mockResolvedValue(null);
    deathMock.mockImplementation(async (owner: string) => owner === 'blind');
    // Even across the grace window, the death detector `continue`s before the dark-telemetry
    // counter, so it is escalated as a context-death (blocker), never as dark-telemetry.
    for (let i = 0; i < 4; i++) await checkCompactionCompliance(fakeSql({ seeded }));
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.contextDeaths).toEqual(['blind']);
    expect(out.bootConfigAlerts).toEqual([]); // never reached the dark-telemetry counter
  });

  it('does NOT flag an OMP session — its null estimate is BY DESIGN, not blindness (WI-2910)', async () => {
    // OMP self-compacts natively, so its null estimate remains intentional.
    const ompSeeded = [{ owner_id: 'omp-sess', owner_label: 'su · omp-sess', compaction_limit: 300_000 }];
    estimateMock.mockResolvedValue(null);
    resolveSessionRefMock.mockResolvedValue({ agent: 'omp', sessionId: 's-omp' });
    openEscalationMock.mockClear();
    let last;
    for (let i = 0; i < 5; i++) last = await checkCompactionCompliance(fakeSql({ seeded: ompSeeded }));
    expect(last!.bootConfigAlerts).toEqual([]); // never flagged despite 5 consecutive null sweeps
    expect(openEscalationMock).not.toHaveBeenCalled();
    resolveSessionRefMock.mockResolvedValue(null); // reset default for any later tests
  });

  it('flags a Codex session whose rollout telemetry stays dark now that native compaction is disabled (D-011)', async () => {
    estimateMock.mockResolvedValue(null);
    resolveSessionRefMock.mockResolvedValue({ agent: 'codex', sessionId: 's-codex', sessionKey: 42 });
    const codexSeeded = [
      { owner_id: 'codex-sess', owner_label: 'su · codex-sess', compaction_limit: 207_000, last_turn_at: new Date().toISOString() },
    ];
    openEscalationMock.mockClear();
    let last;
    for (let i = 0; i < 3; i++) last = await checkCompactionCompliance(fakeSql({ seeded: codexSeeded }));
    expect(last!.bootConfigAlerts).toEqual([
      { owner: 'codex-sess', kind: 'dark-telemetry', detail: '3 null sweeps' },
    ]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT exempt a raw NULL adv_sessions owner when reconciliation recovers a real Claude session', async () => {
    const recovered = [
      { owner_id: 'recovered-no-row', owner_label: 'su · recovered', compaction_limit: 300_000, last_turn_at: new Date().toISOString() },
    ];
    estimateMock.mockResolvedValue(null);
    // The incident shape: the primary DB row is absent, but the owner-scoped
    // self-relaunch event recovered the live native id. The synthetic-principal
    // exemption must consult the reconciled result or it clears a real session's
    // null streak and leaves the context-death detector permanently dark.
    resolveSessionRefMock.mockResolvedValue(null);
    resolveSessionRefReconciledMock.mockResolvedValue({
      agent: 'claude',
      sessionId: '21dfdd94-current',
      sessionKey: null,
      transcriptOwner: null,
    });
    let last;
    for (let i = 0; i < 3; i++) last = await checkCompactionCompliance(fakeSql({ seeded: recovered }));
    expect(last!.bootConfigAlerts).toEqual([
      { owner: 'recovered-no-row', kind: 'dark-telemetry', detail: '3 null sweeps' },
    ]);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT flag a SYNTHETIC principal (mcp-call / UI-client) — a null adv_sessions ref means it is not a launched session, not a blind one (WI-2917)', async () => {
    // A synthetic coord_presence principal — an MCP-call principal (`mcp-call-<pid>`) or a bare-UUID
    // UI client — carries a live heartbeat, so the seed pass hands it a compaction_limit. But it is
    // NOT a launched agent session: it has no adv_sessions row, so resolveSessionRef returns null and
    // there is no transcript to compact. Its null estimate is meaningless, not blindness, and must
    // never raise a dark-telemetry alarm (the ~2/3h mcp-call false positives observed 2026-07-05).
    const synthSeeded = [
      { owner_id: 'mcp-call-2666139', owner_label: 'su · mcp-call', compaction_limit: 300_000 },
    ];
    estimateMock.mockResolvedValue(null);
    resolveSessionRefMock.mockResolvedValue(null); // no adv_sessions row ⇒ not a real session
    openEscalationMock.mockClear();
    let last;
    for (let i = 0; i < 5; i++) last = await checkCompactionCompliance(fakeSql({ seeded: synthSeeded }));
    expect(last!.bootConfigAlerts).toEqual([]); // never flagged despite 5 consecutive null sweeps
    expect(openEscalationMock).not.toHaveBeenCalled();
  });
});

describe('implausible-reading sanity clamp (EI-10434)', () => {
  const seeded = [{ owner_id: 'garbage', owner_label: 'su · garbage', compaction_limit: 158_000 }];

  it('discards a reading past the absolute plausibility ceiling — no cache write, no over-limit, no force-compact', async () => {
    // The exact garbage-reading signature reported live: a cumulative-total
    // misread as current usage, physically impossible against any real window.
    estimateMock.mockResolvedValue(21_173_000);
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.estimated).toEqual([]); // never counted as a resolved estimate
    expect(out.overLimit).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(out.implausibleReadings).toEqual([
      { owner: 'garbage', est: 21_173_000, ceiling: 2_000_000 },
    ]);
    expect(setEstimateMock).not.toHaveBeenCalled(); // never cached — the gauge must never render it either
    expect(injectMock).not.toHaveBeenCalled(); // never force-compacted off it
  });

  it('a plausible reading — even one genuinely over its own limit — is NOT clamped', async () => {
    estimateMock.mockResolvedValue(200_000); // over 158k but well within any real model window
    const out = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(out.implausibleReadings).toEqual([]);
    expect(out.overLimit).toEqual(['garbage']);
    expect(setEstimateMock).toHaveBeenCalledWith('garbage', 200_000, {
      nativeSessionId: 'native-current',
      advSessionId: 1,
    });
  });

  it('a reading that RECOVERS to plausible after an implausible sweep is no longer discarded (re-arms the dedup)', async () => {
    estimateMock.mockResolvedValue(25_000_000);
    const first = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(first.implausibleReadings).toHaveLength(1);

    estimateMock.mockResolvedValue(40_000); // the session self-compacted / the misread cleared
    const second = await checkCompactionCompliance(fakeSql({ seeded }));
    expect(second.implausibleReadings).toEqual([]);
    expect(second.estimated).toEqual(['garbage']);
    expect(setEstimateMock).toHaveBeenCalledWith('garbage', 40_000, {
      nativeSessionId: 'native-current',
      advSessionId: 1,
    });
  });

  it('warns only ONCE per owner across repeated implausible sweeps (dedup)', async () => {
    estimateMock.mockResolvedValue(30_000_000);
    await checkCompactionCompliance(fakeSql({ seeded }));
    await checkCompactionCompliance(fakeSql({ seeded }));
    await checkCompactionCompliance(fakeSql({ seeded }));
    const implausibleWarnings = (console.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('DISCARDING an implausible'),
    );
    expect(implausibleWarnings).toHaveLength(1);
  });
});

describe('WI-5075 carry-respawn kill-loop breaker (rapid-refire guard)', () => {
  const seeded = [
    {
      owner_id: 'hot',
      owner_label: 'su · hot',
      workspace_id: 'ws-1',
      compaction_limit: 158_000,
    },
  ];

  function armCarryCapableHost() {
    estimateMock.mockResolvedValue(170_000); // never recovers — the stale-ref signature
    specMock.mockResolvedValue('sonnet');
    getFlagMock.mockResolvedValue(true);
    resolveSessionRefMock.mockResolvedValue({ agent: 'claude', sessionId: 'native-1' });
    findLiveHostMock.mockReturnValue({ sock: '/tmp/hot.sock', caps: ['carry-respawn', 'compact'] });
    hostSupportsMock.mockImplementation(
      (host: unknown, cap: string) => (host as { caps?: string[] }).caps?.includes(cap) ?? false,
    );
    buildOwnerRespawnMock.mockResolvedValue({
      systemPromptAddendum: 'deterministic carry',
      firstPrompt: null,
      budgetChars: 32_000,
      openOwnerQuestion: { crossesOpenOwnerMessage: false },
    });
  }

  it('3 cuts with the estimate never recovering ⇒ no 4th cut, ONE blocker escalation, force rung suppressed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
      armCarryCapableHost();

      // Cuts 1–3 fire (each sweep past the FORCE_RETRY_GRACE_MS suppression).
      for (let i = 0; i < 3; i += 1) {
        const out = await checkCompactionCompliance(fakeSql({ seeded }));
        expect(out.carryRespawned).toEqual(['hot']);
        vi.setSystemTime(Date.now() + 7 * 60_000);
      }
      expect(injectMock).toHaveBeenCalledTimes(3);

      // Sweep 4: the breaker opens — no cut, no force-compact, one escalation.
      const out4 = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(out4.carryRespawned).toEqual([]);
      expect(out4.forceCompacted).toEqual([]);
      expect(injectMock).toHaveBeenCalledTimes(3);
      expect(openEscalationMock).toHaveBeenCalledTimes(1);
      // WI-5217: openEscalationMock is declared as a 0-arg vi.fn() (see line ~41), so
      // `.mock.calls[0]` is a `[]` tuple with no index 1 — cast through `unknown` first,
      // matching the pattern already used elsewhere in this file (e.g. line ~786).
      const escPayload = (openEscalationMock.mock.calls[0] as unknown as [unknown, { severity?: string; summary?: string; meta?: { subjectSignature?: string } }])?.[1] as
        | { severity?: string; summary?: string; meta?: { subjectSignature?: string } }
        | undefined;
      expect(escPayload?.severity).toBe('blocker');
      expect(escPayload?.summary).toContain('carry-respawn LOOP');
      // WI-5848: stable conditionKey keyed on owner ONLY — the summary above embeds a
      // live `${streak}` count that changes across occurrences exactly like
      // EI-18668025239634541's fixed bug, so the dedup key must NOT vary with it.
      expect(escPayload?.meta?.subjectSignature).toBe('compaction-watchdog:carry-respawn-loop:hot');

      // Sweep 5: still suppressed, escalation NOT duplicated.
      vi.setSystemTime(Date.now() + 7 * 60_000);
      const out5 = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(out5.carryRespawned).toEqual([]);
      expect(openEscalationMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transient successor recovery samples do not re-arm the breaker — landed churn is suppressed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
      armCarryCapableHost();

      // Each landed cut briefly produces a fresh successor below the limit before
      // the successor burns back over it. Those low samples must not erase the
      // streak that eventually suppresses the churn loop.
      for (let i = 0; i < 3; i += 1) {
        estimateMock.mockResolvedValue(170_000);
        const cut = await checkCompactionCompliance(fakeSql({ seeded }));
        expect(cut.carryRespawned).toEqual(['hot']);

        vi.setSystemTime(Date.now() + 7 * 60_000);
        estimateMock.mockResolvedValue(10_000);
        const successorBoot = await checkCompactionCompliance(fakeSql({ seeded }));
        expect(successorBoot.overLimit).toEqual([]);

        if (i < 2) vi.setSystemTime(Date.now() + 7 * 60_000);
      }

      vi.setSystemTime(Date.now() + 7 * 60_000);
      estimateMock.mockResolvedValue(170_000);
      const suppressed = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(suppressed.carryRespawned).toEqual([]);
      expect(suppressed.forceCompacted).toEqual([]);
      expect(injectMock).toHaveBeenCalledTimes(3);
      expect(openEscalationMock).toHaveBeenCalledTimes(1);

      const escPayload = (openEscalationMock.mock.calls[0] as unknown as [
        unknown,
        { summary?: string },
      ])?.[1];
      expect(escPayload?.summary).toContain('carry-respawn CHURN');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sustained recovery below the limit closes the breaker — a later genuine crossing cuts again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
      armCarryCapableHost();
      for (let i = 0; i < 3; i += 1) {
        await checkCompactionCompliance(fakeSql({ seeded }));
        vi.setSystemTime(Date.now() + 7 * 60_000);
      }
      // Breaker open.
      const tripped = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(tripped.carryRespawned).toEqual([]);

      // One low successor sample is not enough to prove sustained recovery.
      estimateMock.mockResolvedValue(10_000);
      vi.setSystemTime(Date.now() + 7 * 60_000);
      const transient = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(transient.overLimit).toEqual([]);

      // The owner remains below the limit, but not yet for the full streak
      // window measured from the first low sample.
      vi.setSystemTime(Date.now() + 29 * 60_000);
      const stillRetained = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(stillRetained.overLimit).toEqual([]);
      estimateMock.mockResolvedValue(170_000);
      const stillSuppressed = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(stillSuppressed.carryRespawned).toEqual([]);

      // The owner remains below the limit for the full streak window, so the
      // streak + escalation dedup finally clear with the other per-owner state.
      vi.setSystemTime(Date.now() + 1 * 60_000);
      estimateMock.mockResolvedValue(10_000);
      const recovered = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(recovered.overLimit).toEqual([]);

      // A later genuine crossing respawns normally again.
      estimateMock.mockResolvedValue(170_000);
      vi.setSystemTime(Date.now() + 7 * 60_000);
      const again = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(again.carryRespawned).toEqual(['hot']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a compaction-limit change immediately re-arms a retained streak', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
      armCarryCapableHost();

      for (let i = 0; i < 3; i += 1) {
        estimateMock.mockResolvedValue(170_000);
        const cut = await checkCompactionCompliance(fakeSql({ seeded }));
        expect(cut.carryRespawned).toEqual(['hot']);
        vi.setSystemTime(Date.now() + 7 * 60_000);
        estimateMock.mockResolvedValue(10_000);
        await checkCompactionCompliance(fakeSql({ seeded }));
        if (i < 2) vi.setSystemTime(Date.now() + 7 * 60_000);
      }

      vi.setSystemTime(Date.now() + 7 * 60_000);
      estimateMock.mockResolvedValue(170_000);
      const suppressed = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(suppressed.carryRespawned).toEqual([]);
      expect(openEscalationMock).toHaveBeenCalledTimes(1);

      // Changing the configured limit is an explicit operator re-arm, even
      // though the current estimate is still below the new limit.
      const changedLimit = [{ ...seeded[0], compaction_limit: 200_000 }];
      const rearmed = await checkCompactionCompliance(fakeSql({ seeded: changedLimit }));
      expect(rearmed.overLimit).toEqual([]);

      const restoredLimit = await checkCompactionCompliance(fakeSql({ seeded }));
      expect(restoredLimit.carryRespawned).toEqual(['hot']);
      expect(openEscalationMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EI-16190 pre-cutover-process self-check', () => {
  const cutovers = [{ id: 'test-cutover', atMs: Date.parse('2026-07-18T00:00:00Z'), note: 'a test cutover' }];

  it('staleCutoversForProcessStart: a process that booted BEFORE the cutover is flagged', () => {
    const bootedBefore = Date.parse('2026-07-17T12:00:00Z');
    expect(staleCutoversForProcessStart(bootedBefore, cutovers)).toEqual(cutovers);
  });

  it('staleCutoversForProcessStart: a process that booted AT/AFTER the cutover is clean', () => {
    const bootedAt = Date.parse('2026-07-18T00:00:00Z');
    const bootedAfter = Date.parse('2026-07-19T00:00:00Z');
    expect(staleCutoversForProcessStart(bootedAt, cutovers)).toEqual([]);
    expect(staleCutoversForProcessStart(bootedAfter, cutovers)).toEqual([]);
  });

  it('staleCutoversForProcessStart: multiple cutovers each independently evaluated', () => {
    const twoCutovers = [
      { id: 'old-cutover', atMs: Date.parse('2026-06-01T00:00:00Z'), note: 'old' },
      { id: 'new-cutover', atMs: Date.parse('2026-07-18T00:00:00Z'), note: 'new' },
    ];
    // Booted between the two ⇒ only predates the newer one.
    const bootedBetween = Date.parse('2026-06-15T00:00:00Z');
    expect(staleCutoversForProcessStart(bootedBetween, twoCutovers)).toEqual([twoCutovers[1]]);
  });

  it('staleCutoversForProcessStart: defaults to the real WATCHDOG_BEHAVIOR_CUTOVERS registry when no override is passed', () => {
    // A process that booted in the deep past predates every known cutover —
    // just asserts the default-arg wiring reaches the real registry, not any
    // particular entry's content (which may grow over time).
    const ancientBoot = Date.parse('2000-01-01T00:00:00Z');
    expect(staleCutoversForProcessStart(ancientBoot).length).toBeGreaterThan(0);
  });

  it('registers the ended-session exact-key recovery cutover for stale watchdog processes', () => {
    const recoveryCutover = WATCHDOG_BEHAVIOR_CUTOVERS.find(
      (cutover) => cutover.id === 'ended-session-compaction-exact-key-recovery',
    );
    expect(recoveryCutover).toBeDefined();
    expect(staleCutoversForProcessStart(recoveryCutover!.atMs - 1)).toContainEqual(recoveryCutover);
    expect(staleCutoversForProcessStart(recoveryCutover!.atMs)).not.toContainEqual(recoveryCutover);
  });

  it('startCompactionComplianceWatchdog escalates ONCE when this process predates a known cutover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 2026-06-01: before the real P-022-native-compact-retirement cutover
      // (2026-07-18) baked into the module's WATCHDOG_BEHAVIOR_CUTOVERS.
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      vi.spyOn(process, 'uptime').mockReturnValue(0); // "just booted" at the faked system time
      startCompactionComplianceWatchdog(fakeSql({}), { intervalMs: 999_999_999 });
      // Escalation is fire-and-forget (best-effort async) — flush microtasks.
      await vi.waitFor(() => {
        expect(openEscalationMock).toHaveBeenCalled();
      });
      const escPayload = (
        openEscalationMock.mock.calls[0] as unknown as [
          unknown,
          { severity?: string; summary?: string; meta?: { subjectSignature?: string } },
        ]
      )?.[1];
      expect(escPayload?.severity).toBe('advisory');
      expect(escPayload?.summary).toContain('pre-cutover process');
      // WI-5848: stable conditionKey keyed on cutoverId ONLY — the summary above embeds
      // `process.pid`, which would differ across a process restart for the SAME
      // cutoverId exactly like EI-18668025239634541's fixed bug, so the dedup key must
      // key on cutoverId (the in-memory guard's own key), never on the pid.
      expect(escPayload?.meta?.subjectSignature).toBe(
        'compaction-watchdog:stale-cutover:P-022-native-compact-retirement',
      );

      // A second start() call within the same process must NOT re-escalate
      // the same cutover (dedup).
      startCompactionComplianceWatchdog(fakeSql({}), { intervalMs: 999_999_999 });
      await Promise.resolve();
      expect(openEscalationMock).toHaveBeenCalledTimes(1);
    } finally {
      const { stopManaged } = await import('@papercusp/scheduled-registry');
      stopManaged('compaction-compliance-watchdog');
      vi.useRealTimers();
    }
  });

  it('startCompactionComplianceWatchdog does NOT escalate when this process postdates every known cutover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
      vi.spyOn(process, 'uptime').mockReturnValue(0);
      startCompactionComplianceWatchdog(fakeSql({}), { intervalMs: 999_999_999 });
      await Promise.resolve();
      expect(openEscalationMock).not.toHaveBeenCalled();
    } finally {
      const { stopManaged } = await import('@papercusp/scheduled-registry');
      stopManaged('compaction-compliance-watchdog');
      vi.useRealTimers();
    }
  });
});

describe('dark-presence gap backstop (EI-18127246030401689)', () => {
  it('discoverPresencelessLoopOwners returns active-loop owners with no presence row', async () => {
    const rows = await discoverPresencelessLoopOwners(
      fakeSql({ presenceGaps: [{ owner_id: 'su-ghost', workspace_id: 'ws-1' }] }) as never,
    );
    expect(rows).toEqual([{ ownerId: 'su-ghost', workspaceId: 'ws-1' }]);
  });

  it('discoverPresencelessLoopOwners fails soft to [] on a query error', async () => {
    const throwingSql = (() => {
      throw new Error('boom');
    }) as never;
    await expect(discoverPresencelessLoopOwners(throwingSql)).resolves.toEqual([]);
  });

  it('self-heals a presence row for a presence-less active-loop owner and escalates once, using the fleet-membership label', async () => {
    const out = await checkCompactionCompliance(
      fakeSql({
        presenceGaps: [{ owner_id: 'su-ghost', workspace_id: 'ws-1' }],
        fleetLabels: { 'su-ghost': 'su · ghost' },
      }),
    );
    expect(out.presenceGapsHealed).toEqual(['su-ghost']);
    expect(writePresenceMock).toHaveBeenCalledTimes(1);
    const [identity] = writePresenceMock.mock.calls[0] as unknown as [
      { ownerId: string; ownerLabel: string; workspaceId: string | null; source: string },
    ];
    expect(identity).toMatchObject({ ownerId: 'su-ghost', ownerLabel: 'su · ghost', workspaceId: 'ws-1' });
    expect(out.bootConfigAlerts).toHaveLength(1);
    expect(out.bootConfigAlerts[0]).toMatchObject({ owner: 'su-ghost', kind: 'dark-presence' });
    expect(openEscalationMock).toHaveBeenCalledTimes(1);

    // A second sweep must NOT re-heal or re-escalate the SAME owner once its presence
    // row exists (the discovery query itself won't return it — cp.owner_id IS NULL no
    // longer matches — so this models the query correctly excluding it next pass).
    const out2 = await checkCompactionCompliance(fakeSql({ fleetLabels: { 'su-ghost': 'su · ghost' } }));
    expect(out2.presenceGapsHealed).toEqual([]);
    expect(writePresenceMock).toHaveBeenCalledTimes(1);
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the ownerId as the label when no fleet-membership fact exists', async () => {
    const out = await checkCompactionCompliance(
      fakeSql({ presenceGaps: [{ owner_id: 'su-solo-ghost', workspace_id: null }] }),
    );
    expect(out.presenceGapsHealed).toEqual(['su-solo-ghost']);
    const [identity] = writePresenceMock.mock.calls[0] as unknown as [{ ownerLabel: string }];
    expect(identity.ownerLabel).toBe('su-solo-ghost');
  });

  it('still escalates (but does not mark healed) when the presence write itself fails', async () => {
    writePresenceMock.mockRejectedValueOnce(new Error('db down'));
    const out = await checkCompactionCompliance(
      fakeSql({ presenceGaps: [{ owner_id: 'su-unhealable', workspace_id: null }] }),
    );
    expect(out.presenceGapsHealed).toEqual([]);
    expect(out.bootConfigAlerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ owner: 'su-unhealable', kind: 'dark-presence' })]),
    );
    expect(openEscalationMock).toHaveBeenCalledTimes(1);
  });
});

describe('WI-38347 carry-respawn-loop escalation body is backend-specific', () => {
  // The defect: this BLOCKER-severity body hardcoded a Claude diagnosis
  // ("adv_sessions.session_id not re-anchored") and a remedy ("relaunch the
  // session"), then fired it at 9 live codex owners in 11 minutes. For codex the
  // named column is never read (resolveSelfSession → rollout), so the fix is a
  // no-op; and the fallback remedy would have killed multi-hour live agents.
  // These two strings are the harm, so they are what the guard pins. NOTE the
  // remedy constant is the FULL prescriptive clause, not the bare words
  // "relaunch the session": a non-claude body must be free to say "DO NOT
  // relaunch ...", and a substring guard cannot tell a prescription from a
  // prohibition. So the absence check pins the prescription, and a separate
  // POSITIVE check requires the prohibition — together those are unambiguous.
  const CLAUDE_ONLY_DIAGNOSIS = 'adv_sessions.session_id not re-anchored';
  const CLAUDE_ONLY_REMEDY = 'relaunch the session so the post-fix launcher reports respawns';

  it('never hands a CODEX owner the claude-only diagnosis or the relaunch remedy', () => {
    const body = carryRespawnLoopEscalationBody('codex', 3);
    expect(body).not.toContain(CLAUDE_ONLY_DIAGNOSIS);
    expect(body).not.toContain(CLAUDE_ONLY_REMEDY);
    // and it must positively name the mechanism that DOES govern a codex estimate
    expect(body).toContain('resolveSelfSession');
    expect(body).toContain('DO NOT relaunch');
  });

  it('does not assert a root cause for codex — that one is still unestablished (WI-38347)', () => {
    const body = carryRespawnLoopEscalationBody('codex', 3);
    expect(body).toContain('NOT yet established');
  });

  it('still gives a CLAUDE owner the WI-5075 diagnosis, which is correct for that backend', () => {
    const body = carryRespawnLoopEscalationBody('claude', 4);
    expect(body).toContain(CLAUDE_ONLY_DIAGNOSIS);
    expect(body).toContain('WI-5075');
  });

  it('offers no backend-specific diagnosis when the backend is unresolved', () => {
    for (const agent of [null, 'omp'] as const) {
      const body = carryRespawnLoopEscalationBody(agent, 3);
      expect(body).not.toContain(CLAUDE_ONLY_DIAGNOSIS);
      expect(body).not.toContain(CLAUDE_ONLY_REMEDY);
      // the prohibition must be present, not merely the prescription absent
      expect(body).toContain('DO NOT relaunch');
    }
  });

  it('an UNRECOGNIZED backend string gets the neutral body, NOT the claude one', () => {
    // SessionRef.agent is `string | null`, and this file's usual convention is
    // "unknown ⇒ treat as claude" — correct for resolving a transcript, wrong
    // here, where inheriting the claude branch means a no-op fix plus a
    // destructive "relaunch" at blocker severity. Pinned so the narrowing in
    // escalateCarryRespawnLoop is not "simplified" back to a cast later.
    const body = carryRespawnLoopEscalationBody(
      'some-future-backend' as unknown as 'claude',
      3,
    );
    expect(body).not.toContain(CLAUDE_ONLY_DIAGNOSIS);
    expect(body).not.toContain(CLAUDE_ONLY_REMEDY);
    expect(body).toContain('DO NOT relaunch');
  });

  it('always states the streak and the suppression, on every backend', () => {
    for (const agent of ['claude', 'codex', 'omp', null] as const) {
      const body = carryRespawnLoopEscalationBody(agent, 7);
      expect(body).toContain('7 consecutive cuts');
      expect(body).toContain('STOPPED respawning');
    }
  });

// WI-38347 leg 4. The streak breaker names a defect it never measured: it increments
// on "a respawn fired and this owner is over limit again later" and then escalates
// asserting "the context estimate never dropping". Those are different claims, and
// when the limit sits well below the model window the second one is simply false —
// a successor whose cut landed perfectly is back over the limit within minutes
// (measured 2026-08-13: codex su sessions open ~50k, burn ~10k/min, re-crossed a
// 158,000 limit in 5–18 min). These pin the discriminator itself.
describe('WI-38347 leg 4 — a streak verdict must be MEASURED, not inferred', () => {
  const base = { limit: 158_000, window: 258_400 } as const;

  it('reports CHURN when the estimate demonstrably moved between cuts', () => {
    expect(
      carryRespawnStreakVerdict({ ...base, estAtFirstCut: 200_000, minEstSince: 165_000 }),
    ).toBe('churn');
  });

  it('reports PINNED when the estimate came back EXACTLY equal — the frozen-tail signature', () => {
    expect(
      carryRespawnStreakVerdict({ ...base, estAtFirstCut: 170_000, minEstSince: 170_000 }),
    ).toBe('pinned');
  });

  it('reports PINNED for a drift too small to be a landed cut', () => {
    expect(
      carryRespawnStreakVerdict({ ...base, estAtFirstCut: 170_000, minEstSince: 169_100 }),
    ).toBe('pinned');
  });

  it('defaults to PINNED with no evidence — an un-instrumented caller keeps the old diagnosis', () => {
    expect(carryRespawnStreakVerdict(null)).toBe('pinned');
    expect(carryRespawnStreakVerdict(undefined)).toBe('pinned');
  });

  // CALIBRATION. An earlier draft compared minEstSince against a FRACTION (≤85%) of
  // the first-cut estimate. Every assertion above still passed under it, because they
  // are all far from that boundary — but the churn branch was DEAD CODE: only
  // over-limit sweeps are ever sampled, so every admissible reading is ≥ the limit,
  // and from a first-cut estimate near the limit nothing can reach 85% of it. This
  // case sits in exactly that band (170,000 first cut, 160,000 low, 158,000 limit:
  // a real 10k drop, but 94% — above the old fraction) and so FAILS under the
  // fractional rule and passes under the absolute one. It is what makes the four
  // assertions above non-vacuous.
  it('a real drop that stays just above the limit is CHURN — reachable, not dead code', () => {
    expect(
      carryRespawnStreakVerdict({ ...base, estAtFirstCut: 170_000, minEstSince: 160_000 }),
    ).toBe('churn');
  });

  it('a CHURN body drops the transcript diagnosis entirely and sends the reader at headroom', () => {
    const body = carryRespawnLoopEscalationBody('claude', 3, {
      ...base,
      estAtFirstCut: 200_000,
      minEstSince: 165_000,
    });
    // the claude branch is otherwise CORRECT for a claude owner — it must still be
    // suppressed here, because the defect it describes is not the one that occurred
    expect(body).not.toContain(CLAUDE_ONLY_DIAGNOSIS);
    expect(body).not.toContain(CLAUDE_ONLY_REMEDY);
    expect(body).toContain('CHURN');
    expect(body).toContain('cuts ARE LANDING');
    expect(body).toContain('DO NOT relaunch');
    // and it must name the actual lever: the limit against the real window
    expect(body).toContain('158000');
    expect(body).toContain('258400');
    expect(body).toContain('61%');
  });

  it('the CHURN body is backend-NEUTRAL — churn is not a property of the backend', () => {
    const bodies = (['claude', 'codex', 'omp', null] as const).map((agent) =>
      carryRespawnLoopEscalationBody(agent, 3, {
        ...base,
        estAtFirstCut: 200_000,
        minEstSince: 165_000,
      }),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it('a PINNED verdict still routes to the per-backend leg-2 bodies', () => {
    const pinned = { ...base, estAtFirstCut: 170_000, minEstSince: 170_000 };
    expect(carryRespawnLoopEscalationBody('claude', 3, pinned)).toContain(CLAUDE_ONLY_DIAGNOSIS);
    const codex = carryRespawnLoopEscalationBody('codex', 3, pinned);
    expect(codex).not.toContain(CLAUDE_ONLY_DIAGNOSIS);
    expect(codex).toContain('resolveSelfSession');
  });

  it('names an unresolved window honestly instead of printing a ratio it cannot compute', () => {
    const body = carryRespawnLoopEscalationBody('codex', 3, {
      limit: 158_000,
      window: null,
      estAtFirstCut: 200_000,
      minEstSince: 165_000,
    });
    expect(body).toContain('could not be resolved');
    expect(body).not.toContain('NaN');
    expect(body).not.toContain('Infinity');
  });
  });
});

/**
 * EI-21595542328480968 — the frozen-codex-reading gate.
 *
 * These four tests exist to stop the gate being BROADENED back to the shape that was
 * measured harmful. A first attempt gated the estimate on the identity mismatch alone
 * (plus file staleness) inside the resolver, for every codex session: measured across
 * all 134 live codex sessions it nulled 16, of which exactly ONE was the pathology —
 * the other 15 were healthy and under their limit, i.e. 15 sessions' compaction
 * backstop disarmed to fix one. Each test below pins one of the narrowing conditions
 * that measurement forced, so removing any of them fails here instead of in production.
 */
describe('EI-21595542328480968: frozen codex readings never drive a cut', () => {
  const NOW = 1_800_000_000_000;
  /** A rollout belonging to some OTHER session, last written `lagMin` before this
   *  session's own last activity. */
  const provenance = (lagMin: number, sameSession = false) => ({
    rolloutPath: '/codex/session-19845/rollout-2026-08-27T01-00-00-dead0000-aaaa-bbbb.jsonl',
    rolloutMtimeMs: NOW - lagMin * 60_000,
    rolloutSessionId: sameSession ? 'live1111-cccc-dddd' : 'dead0000-aaaa-bbbb',
    refSessionId: 'live1111-cccc-dddd',
  });
  const sweepRow = (limit = 200_000) => ({
    owner_id: 'cx',
    owner_label: 'su · cx',
    compaction_limit: limit,
    last_turn_at: new Date(NOW).toISOString(),
  });

  it("IGNORES an over-limit reading proven to come from another session's frozen rollout", async () => {
    estimateMock.mockResolvedValue(227_005); // over the 200k limit
    codexProvenanceMock.mockResolvedValue(provenance(90.7)); // the measured pathology
    const out = await checkCompactionCompliance(fakeSql({ seeded: [sweepRow()] }));

    expect(out.frozenCodexReadings).toEqual([{ owner: 'cx', est: 227_005, lagMs: 90.7 * 60_000 }]);
    // The whole point: the reading drives NOTHING. Acting on it force-compacts a live
    // session on a dead predecessor's usage at every grace expiry, forever.
    expect(out.overLimit).toEqual([]);
    expect(out.forceCompacted).toEqual([]);
    expect(out.estimated).toEqual([]);
    expect(setEstimateMock).not.toHaveBeenCalled();
    // A frozen cached number is worse than none — it pins a live gauge over-limit.
    expect(clearEstimateMock).toHaveBeenCalledWith('cx');
  });

  it('does not mark an idle session frozen from hook-only presence activity', async () => {
    estimateMock.mockResolvedValue(227_005);
    codexProvenanceMock.mockResolvedValue(provenance(90.7));
    const hookOnly = {
      ...sweepRow(),
      last_active_at: new Date(NOW).toISOString(),
      last_turn_at: null,
    };
    const out = await checkCompactionCompliance(fakeSql({ seeded: [hookOnly] }));

    expect(out.frozenCodexReadings).toEqual([]);
    expect(out.overLimit).toEqual(['cx']);
    expect(clearEstimateMock).not.toHaveBeenCalled();
    expect(codexProvenanceMock).not.toHaveBeenCalled();
  });

  it('leaves an UNDER-LIMIT session alone even when it satisfies both conjuncts', async () => {
    // THE LOAD-BEARING PLACEMENT TEST. Measured 2026-08-27: a live, actively-working,
    // under-limit session (su-da1ed036) had BOTH an identity mismatch and a 186.9min
    // lag. Evaluating the gate for the whole population would have silenced its
    // telemetry for nothing — an under-limit reading drives no cut, so there is
    // nothing to protect it from. Hoisting the check out of the over-limit branch
    // fails HERE.
    estimateMock.mockResolvedValue(179_963); // well under the 400k limit
    codexProvenanceMock.mockResolvedValue(provenance(186.9));
    const out = await checkCompactionCompliance(fakeSql({ seeded: [sweepRow(400_000)] }));

    expect(out.frozenCodexReadings).toEqual([]);
    expect(out.estimated).toEqual(['cx']);
    expect(setEstimateMock).toHaveBeenCalledWith('cx', 179_963, {
      nativeSessionId: 'native-current',
      advSessionId: 1,
    });
    expect(clearEstimateMock).not.toHaveBeenCalled();
  });

  it('TRUSTS an idle session whose rollout is merely old (the liveness conjunct)', async () => {
    // An IDLE session legitimately shows an identity mismatch: nobody has written its
    // rollout, while its ref's native id churned past it. Its last eligible turn is old
    // too, so the lag stays small — which is the only thing separating it from the
    // pathology. This is the class (15 of 16) the reverted gate wrongly nulled.
    estimateMock.mockResolvedValue(219_915);
    codexProvenanceMock.mockResolvedValue(provenance(0.4));
    const out = await checkCompactionCompliance(fakeSql({ seeded: [sweepRow()] }));

    expect(out.frozenCodexReadings).toEqual([]);
    expect(out.overLimit).toEqual(['cx']);
    expect(setEstimateMock).toHaveBeenCalledWith('cx', 219_915, {
      nativeSessionId: 'native-current',
      advSessionId: 1,
    });
  });

  it("TRUSTS a long lag when the rollout IS this session's (the identity conjunct)", async () => {
    // A session whose own rollout has not moved in hours is not misrouted — it is
    // simply quiet, or mid-turn. Dropping the identity check would cut it.
    estimateMock.mockResolvedValue(219_915);
    codexProvenanceMock.mockResolvedValue(provenance(3132.6, /* sameSession */ true));
    const out = await checkCompactionCompliance(fakeSql({ seeded: [sweepRow()] }));

    expect(out.frozenCodexReadings).toEqual([]);
    expect(out.overLimit).toEqual(['cx']);
  });
});

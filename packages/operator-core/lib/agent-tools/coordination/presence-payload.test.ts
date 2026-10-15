/**
 * presence-payload.test.ts — guards for the P-009 two-lane partition
 * (presence-v2-2026-06-14 / D-005 / D-006).
 *
 * Asserts: (1) the partition classifies fields into the right lane for local +
 * federated rows; (2) the byte-stable invariant — identity+state of an
 * unchanged agent serialize byte-identically across two reads (only the
 * liveness scalar moves); (3) the drift guard — every emitted field is
 * classified into exactly one lane (or deliberately dropped), the lanes are
 * pairwise disjoint, and liveness never enters the delta-eligible set; (4) the
 * emitted row drops the raw churning timestamps.
 */
import { describe, it, expect } from 'vitest';
import { mergeTier1, type PresenceTier1Joins } from './presence-tier1';
import type { UnifiedPresenceRecord } from './federated-presence';
import {
  partitionPresenceRow,
  deltaEligibleProjection,
  toStableRosterRow,
  normalizeFullPresenceRows,
  PRESENCE_IDENTITY_FIELDS,
  PRESENCE_STATE_FIELDS,
  PRESENCE_LIVENESS_FIELDS,
  PRESENCE_DROPPED_FIELDS,
  PRESENCE_DELTA_FIELDS,
  PLACEHOLDER_INTENT,
  isLifecycleIntent,
  type RosterRow,
} from './presence-payload';

/** A maximal row carrying EVERY field the roster can emit — the coverage-guard
 *  fixture. If a new presence field is added, the guard fails until it is added
 *  here AND classified into a lane. */
const MAXIMAL_ROW: RosterRow = {
  // — identity —
  ownerId: 'su-x',
  ownerLabel: 'su · x',
  workspaceId: 'ws',
  source: 'omp-hook-session',
  host: 'box',
  pid: 123,
  tty: '/dev/pts/3',
  startedAt: '2026-06-14T00:00:00.000Z',
  agentRole: 'su',
  potSlug: 'papercup-hive',
  fleetSlug: 'ui-fleet',
  fleetRole: 'leader',
  fleetControlState: 'active',
  canAcquireWork: true,
  model: 'opus',
  userId: 'u1',
  federated: false,
  devicePubkey: 'pk',
  harnessSlug: 'papercup',
  // — state —
  intent: 'doing things',
  intentDeclaredAt: '2026-06-14T00:50:00.000Z',
  // P-010 (#D-006): intent provenance — derived from the held work item below.
  intentSource: 'derived',
  intentDerivedFrom: { workItemId: 'WI-1', planItemRef: 'plan-x#P-002' },
  currentPlanSlug: 'plan-x',
  currentView: 'harness/papercup',
  currentFiles: ['a.ts'],
  claimedItems: ['P-001'],
  claimCount: 2,
  claimedPlanItemRefs: ['plan-x#P-002'],
  awaitingEvent: true,
  awaitingEventKey: 'k',
  awaitingNote: 'note',
  wakeMode: 'auto',
  revoked: false,
  // — liveness —
  lastActiveSecAgo: 42,
  lastActiveSource: 'presence',
  intentStale: false,
  intentAgeSec: 600,
  intentDivergent: false,
  stale: false,
  sessionState: 'live',
  wakeable: true,
  confirmLiveness: false,
  // P-011(a) / D-011: null on a live row (set only alongside sessionState 'suspect').
  wedged: null,
  loopArmed: false,
  selfWake: 'loop',
  // EI-22805550006169069: the forward-looking schedule pair — a turn is in flight
  // here (parked), which is why nextFireAt is null alongside a true flag.
  dormantScheduled: true,
  nextFireAt: null,
  onDesktop: true,
  viewerAttached: true,
  contextPressure: 'ok',
  contextPressureAgeSec: 10,
  // — dropped (raw churning timestamps + the DG-3-only capability tags) —
  heartbeatAt: '2026-06-14T01:00:00.000Z',
  lastActiveAt: '2026-06-14T00:59:00.000Z',
  capabilityTags: ['node', 'docker', 'pg'],
  // P-011: derivation input behind lastActiveSecAgo/lastActiveSource — same dropped
  // lane as lastActiveAt, and mergeTier1 strips it before rows are ever built.
  turnPartLastAt: '2026-06-14T00:58:00.000Z',
  // P-010: derivation input behind intent/intentSource/intentDerivedFrom — dropped,
  // and mergeTier1 strips it before rows are ever built.
  heldWorkIntent: { workItemId: 'WI-1', title: 'doing things', planItemRef: 'plan-x#P-002' },
};

/** A local PresenceRecord (pre-enrichment) for the byte-stability pipeline test. */
const LOCAL_BASE: UnifiedPresenceRecord = {
  ownerId: 'su-a',
  ownerLabel: 'su · a',
  workspaceId: 'ws',
  source: 'omp-hook-session',
  intent: 'reviewing the fold',
  intentDeclaredAt: '2026-06-14T00:59:00.000Z',
  currentPlanSlug: 'presence-v2-2026-06-14',
  currentFiles: ['presence.ts'],
  host: 'box',
  pid: 7,
  tty: '/dev/pts/4',
  startedAt: '2026-06-14T00:00:00.000Z',
  heartbeatAt: '2026-06-14T01:00:00.000Z',
  lastActiveAt: '2026-06-14T00:59:00.000Z',
  agentRole: 'su',
  potSlug: 'papercup-hive',
  capabilityTags: [],
  stale: false,
  userId: 'u1',
  revoked: false,
};

const JOINS: PresenceTier1Joins = {
  claimedItems: ['P-009'],
  model: 'opus',
  awaitingEvent: false,
  awaitingEventKey: null,
  awaitingNote: null,
  wakeMode: 'auto',
};

describe('partitionPresenceRow', () => {
  it('classifies a local enriched row into identity / state / liveness', () => {
    const { identity, state, liveness } = partitionPresenceRow(MAXIMAL_ROW);
    expect(identity).toMatchObject({ ownerId: 'su-x', model: 'opus', potSlug: 'papercup-hive' });
    expect(state).toMatchObject({
      intent: 'doing things',
      claimedItems: ['P-001'],
      claimCount: 2,
      wakeMode: 'auto',
    });
    expect(liveness).toEqual({ lastActiveSecAgo: 42, lastActiveSource: 'presence', intentStale: false, intentAgeSec: 600, intentDivergent: false, stale: false, sessionState: 'live', wakeable: true, confirmLiveness: false, wedged: null, loopArmed: false, selfWake: 'loop', dormantScheduled: true, nextFireAt: null, onDesktop: true, viewerAttached: true, contextPressure: 'ok', contextPressureAgeSec: 10 });
    // raw timestamps live in no lane
    expect(identity).not.toHaveProperty('heartbeatAt');
    expect(state).not.toHaveProperty('lastActiveAt');
  });

  it('omits fields a federated row lacks (no local Tier-1 join)', () => {
    const fed: RosterRow = {
      ownerId: 'fed:42@thinkpad',
      ownerLabel: 'gh:42 · thinkpad',
      workspaceId: 'ws',
      source: 'federated',
      intent: 'remote work',
      intentDeclaredAt: null,
      currentPlanSlug: null,
      currentFiles: [],
      host: 'thinkpad',
      pid: null,
      tty: null,
      startedAt: '2026-06-14T00:00:00.000Z',
      heartbeatAt: '2026-06-14T00:00:00.000Z',
      lastActiveAt: null,
      agentRole: null,
      potSlug: 'papercup-hive',
      capabilityTags: [],
      stale: false,
      userId: '42',
      revoked: false,
      federated: true,
      devicePubkey: 'pk',
      harnessSlug: 'papercup',
      currentView: 'harness/papercup',
      lastActiveSecAgo: null,
    };
    const { identity, state } = partitionPresenceRow(fed);
    expect(identity).toMatchObject({ federated: true, devicePubkey: 'pk', harnessSlug: 'papercup' });
    // federated rows have no local-table joins → these keys are simply absent
    expect(state).not.toHaveProperty('claimedItems');
    expect(identity).not.toHaveProperty('model');
  });
});

describe('byte-stability (D-006)', () => {
  it('identity + state serialize byte-identically across two reads; only liveness moves', () => {
    // Clock must be AFTER the fixture's lastActiveAt or computeLastActiveSecAgo
    // clamps both reads to 0 (≥0 floor) and the "liveness moves" check is moot.
    const now1 = Date.parse('2026-06-14T01:00:00.000Z'); // 60s after lastActiveAt
    const now2 = now1 + 5_000; // +5s of read-time drift
    const [r1] = mergeTier1([LOCAL_BASE], new Map([[LOCAL_BASE.ownerId, JOINS]]), now1);
    const [r2] = mergeTier1([LOCAL_BASE], new Map([[LOCAL_BASE.ownerId, JOINS]]), now2);

    const p1 = partitionPresenceRow(r1);
    const p2 = partitionPresenceRow(r2);

    // The delta-eligible lanes are byte-stable when nothing transitioned.
    expect(JSON.stringify(p1.identity)).toBe(JSON.stringify(p2.identity));
    expect(JSON.stringify(p1.state)).toBe(JSON.stringify(p2.state));
    expect(JSON.stringify(deltaEligibleProjection(r1))).toBe(JSON.stringify(deltaEligibleProjection(r2)));

    // Liveness DOES move with the clock — and is the only thing that does.
    expect(p1.liveness.lastActiveSecAgo).not.toBe(p2.liveness.lastActiveSecAgo);
  });

  it('toStableRosterRow drops the raw timestamps but keeps the derived scalar', () => {
    const [row] = mergeTier1([LOCAL_BASE], new Map([[LOCAL_BASE.ownerId, JOINS]]), 1_700_000_000_000);
    const emitted = toStableRosterRow(row);
    expect(emitted).not.toHaveProperty('heartbeatAt');
    expect(emitted).not.toHaveProperty('lastActiveAt');
    expect(emitted).not.toHaveProperty('stale'); // conveyed by the active/stale array split
    expect(emitted).toHaveProperty('ownerId', 'su-a');
    expect(emitted).toHaveProperty('startedAt'); // stable identity timestamp — kept
    expect(emitted).toHaveProperty('lastActiveSecAgo');
    // P-011: provenance of the reading, always emitted — and the raw transcript-part
    // timestamp behind it must NOT ride the row.
    expect(emitted).toHaveProperty('lastActiveSource');
    expect(emitted).not.toHaveProperty('turnPartLastAt');
    expect(emitted).toHaveProperty('intentStale'); // stale-ownership signal, always emitted
    expect(emitted).toHaveProperty('intentAgeSec'); // EI-8988: seconds since intent text last changed
    expect(emitted).toHaveProperty('intentDivergent'); // EI-8988: fresh activity + old intent text
    // P-001 wakeability signals are always emitted (null when un-derived).
    expect(emitted).toHaveProperty('sessionState');
    expect(emitted).toHaveProperty('wakeable');
    expect(emitted).toHaveProperty('confirmLiveness');
    expect(emitted).toHaveProperty('loopArmed');
    expect(emitted).toHaveProperty('selfWake');
    // on-desktop is always emitted (null when un-derived, e.g. a federated row).
    expect(emitted).toHaveProperty('onDesktop');
    // viewer-attached (PTY panel) is likewise always emitted.
    expect(emitted).toHaveProperty('viewerAttached');
    // P-007: context-pressure bucket is always emitted (null when untracked).
    expect(emitted).toHaveProperty('contextPressure');
    expect(emitted).toHaveProperty('contextPressureAgeSec');
  });
});

describe('normalizeFullPresenceRows', () => {
  it('fills source-specific fields with null so mixed rows share one wire key set', () => {
    const rows = normalizeFullPresenceRows([
      { ownerId: 'local', claimCount: 2, contextPressure: 'high', modes: ['auto'] },
      { ownerId: 'fed', federated: true, contextPressure: null },
    ]);

    expect(new Set(rows.map((row) => Object.keys(row).sort().join('|'))).size).toBe(1);
    expect(rows[0]).toMatchObject({ claimCount: 2, contextPressure: 'high', modes: ['auto'] });
    expect(rows[1]).toMatchObject({
      claimCount: null,
      contextPressure: null,
      modes: null,
      model: null,
    });
  });

  it('normalizes undefined overlays instead of letting JSON omit them', () => {
    const [row] = normalizeFullPresenceRows([{ ownerId: 'local', parkedOn: undefined }]);
    expect(row).toHaveProperty('parkedOn', null);
  });
});

describe('stale-intent idle prefix (EI-9696)', () => {
  it('prefixes a STALE row\'s intent with its human idle-age — the string itself carries the staleness', () => {
    const emitted = toStableRosterRow({
      ...MAXIMAL_ROW,
      intent: 'UNPAUSE fleet — resume drain',
      intentStale: true,
      lastActiveSecAgo: 2 * 3600 + 41 * 60,
      sessionState: 'parked',
    });
    expect(emitted.intent).toBe('[idle 2h41m] UNPAUSE fleet — resume drain');
  });

  it('falls back to a bare [idle] marker when the age is unknown (sessionState-forced staleness)', () => {
    const emitted = toStableRosterRow({
      ...MAXIMAL_ROW,
      intent: 'remote work',
      intentStale: true,
      lastActiveSecAgo: null,
    });
    expect(emitted.intent).toBe('[idle] remote work');
  });

  it('leaves a FRESH row\'s intent untouched', () => {
    const emitted = toStableRosterRow({ ...MAXIMAL_ROW, intent: 'doing things', intentStale: false, lastActiveSecAgo: 42 });
    expect(emitted.intent).toBe('doing things');
    // unknown staleness (null) is also not prefixed — never guess
    const unknown = toStableRosterRow({ ...MAXIMAL_ROW, intent: 'doing things', intentStale: null });
    expect(unknown.intent).toBe('doing things');
  });

  it('never resurrects the normalized placeholder intent (stale placeholder stays null)', () => {
    const emitted = toStableRosterRow({
      ...MAXIMAL_ROW,
      intent: '(active — see coord:presence for current work)',
      intentStale: true,
      lastActiveSecAgo: 9641,
    });
    expect(emitted.intent).toBeNull();
  });

  it('does not touch the delta-eligible projection (the prefix is emit-side only)', () => {
    const stale: RosterRow = { ...MAXIMAL_ROW, intent: 'doing things', intentStale: true, lastActiveSecAgo: 9641 };
    expect(deltaEligibleProjection(stale).intent).toBe('doing things');
  });
});

describe('two-lane drift guard (D-005)', () => {
  const overlap = (a: readonly string[], b: readonly string[]) => a.filter((x) => b.includes(x));

  it('every emitted field is classified into exactly one lane (or deliberately dropped)', () => {
    const classified = [
      ...PRESENCE_IDENTITY_FIELDS,
      ...PRESENCE_STATE_FIELDS,
      ...PRESENCE_LIVENESS_FIELDS,
      ...PRESENCE_DROPPED_FIELDS,
    ] as readonly string[];
    const emittedKeys = Object.keys(MAXIMAL_ROW);
    // Exact set equality, both directions: a new field forces classification,
    // and a typo'd field-set entry that can't appear is also caught.
    expect(emittedKeys.filter((k) => !classified.includes(k))).toEqual([]);
    expect(classified.filter((k) => !emittedKeys.includes(k))).toEqual([]);
  });

  it('the lanes are pairwise disjoint', () => {
    expect(overlap(PRESENCE_IDENTITY_FIELDS, PRESENCE_STATE_FIELDS)).toEqual([]);
    expect(overlap(PRESENCE_IDENTITY_FIELDS, PRESENCE_LIVENESS_FIELDS)).toEqual([]);
    expect(overlap(PRESENCE_STATE_FIELDS, PRESENCE_LIVENESS_FIELDS)).toEqual([]);
    expect(overlap(PRESENCE_DROPPED_FIELDS, [...PRESENCE_IDENTITY_FIELDS, ...PRESENCE_STATE_FIELDS, ...PRESENCE_LIVENESS_FIELDS])).toEqual([]);
  });

  it('liveness is never delta-eligible (the notify-storm guard)', () => {
    expect(overlap(PRESENCE_LIVENESS_FIELDS, PRESENCE_DELTA_FIELDS)).toEqual([]);
    // delta-eligible IS exactly identity ∪ state
    expect([...PRESENCE_DELTA_FIELDS].sort()).toEqual(
      [...PRESENCE_IDENTITY_FIELDS, ...PRESENCE_STATE_FIELDS].sort(),
    );
  });
});

describe('isLifecycleIntent — one canonical sentinel test (EI-20055604348536487)', () => {
  // This predicate had grown THREE disagreeing copies before it was canonicalized here:
  // locks/enrich-busy.ts covered `capability:` + the placeholder, git-sync-action.ts covered
  // neither, and the lock hook carries a Python third. Each narrower copy classified a real
  // sentinel as usable intent. Pin the union so a later edit cannot quietly re-narrow it.
  it.each([
    ['PreToolUse:Edit', 'the hook label on 3,047 of 3,257 ledger rows'],
    ['PreToolUse:Write', 'the same, for Write'],
    ['PostToolUse:Edit', 'the other hook phase'],
    ['pretooluse:edit', 'case-insensitive — the hook is not the only writer'],
    ['capability:edit', 'the in-dispatch lock-guard label'],
    ['capability:write', 'the same, for write'],
    ['', 'blank is no-intent'],
    ['   ', 'whitespace is no-intent'],
    [PLACEHOLDER_INTENT, 'heartbeated every turn, so more common than real intent'],
  ])('treats %j as a lifecycle label (%s)', (s) => {
    expect(isLifecycleIntent(s)).toBe(true);
  });

  it.each([undefined, null])('treats %j as a lifecycle label', (s) => {
    expect(isLifecycleIntent(s)).toBe(true);
  });

  it.each([
    ['WI-42: fix the sync resolver', 'an ordinary declared intent'],
    [
      'EI-20055604348536487: stop PreToolUse:Edit leaking into the ledger',
      'ANCHORED, not substring — an intent that talks about the label is still real intent',
    ],
    ['reviewing capability:edit call sites', 'the same anchoring hazard, other prefix'],
    ['PreToolUse handling in the hook', 'no colon: not the label shape'],
  ])('treats %j as real declared intent (%s)', (s) => {
    expect(isLifecycleIntent(s)).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  deriveLiveness,
  scopePresenceToWorkspace,
  mergeRosterEntries,
  pendingLaunchesToRosterEntries,
  startingLaunchesToRosterEntries,
  readStartingLaunchLogHints,
  dedupeStartingAgainstActive,
  dedupeEndedAgainstActive,
  shouldProbePid,
  type RosterEntry,
  LIVE_MS,
  GLOBAL_WORKSPACE,
  type NurseryLiveness,
} from './adv-roster';
import { PRESENCE_STALE_MS, type PresenceRecord } from './agent-tools/coordination/presence';
import { STALE_MS } from './liveness';
import type { AdvSessionRow } from './adv-sessions';

it('liveness STALE_MS leaf mirrors coordination PRESENCE_STALE_MS (no drift)', () => {
  expect(STALE_MS).toBe(PRESENCE_STALE_MS);
});

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

it('bounds spawned-session handle resolution to live/restarting rows', () => {
  const source = readFileSync(new URL('./adv-roster.ts', import.meta.url), 'utf8');
  const resolver = source.match(
    /export async function spawnedAgentNativeSessionsByOwner[\s\S]*?export async function spawnedAgentSessionsByOwner/,
  )?.[0];

  expect(resolver).toBeDefined();
  expect(resolver).toContain("WHERE status IN ('running', 'restarting')");
  expect(resolver).not.toMatch(/FROM harness_shared\.spawned_agents\s+WHERE COALESCE/);
});

function presence(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    ownerId: 'su-1',
    ownerLabel: 'su · su-1',
    workspaceId: 'ws1',
    source: 'claude',
    intent: 'doing X',
    currentPlanSlug: null,
    currentFiles: [],
    host: 'h',
    pid: 100,
    tty: null,
    startedAt: iso(NOW - 3_600_000),
    heartbeatAt: iso(NOW - 5_000),
    lastActiveAt: iso(NOW - 5_000),
    intentDeclaredAt: iso(NOW - 5_000),
    agentRole: null,
    potSlug: null,
    capabilityTags: [],
    stale: false,
    userId: null,
    revoked: false,
    ...overrides,
  };
}

function adv(overrides: Partial<AdvSessionRow> = {}): AdvSessionRow {
  return {
    id: 1,
    workspaceId: 'ws1',
    planSlug: 'my-plan',
    agent: 'claude',
    role: 'worker',
    feature: 'F-001',
    mode: 'console',
    terminalBin: null,
    pid: 100,
    windowId: 'w-1',
    ompThreadId: null,
    label: 'worker · F-001',
    cwd: '/repo',
    coordOwnerId: 'su-1',
    sessionId: null,
    display: null,
    launchArgv: null,
    launchedAt: null,
    startedAt: iso(NOW - 3_600_000),
    endedAt: null,
    exitCode: null,
    endedBy: null,
    endedSignal: null,
    ...overrides,
  };
}

describe('deriveLiveness', () => {
  it('live when the heartbeat is younger than LIVE_MS', () => {
    expect(deriveLiveness(iso(NOW - 30_000), NOW)).toBe('live');
    expect(deriveLiveness(iso(NOW - (LIVE_MS - 1)), NOW)).toBe('live');
  });

  it('idle between LIVE_MS and PRESENCE_STALE_MS (boundary is idle)', () => {
    expect(deriveLiveness(iso(NOW - LIVE_MS), NOW)).toBe('idle'); // exactly LIVE_MS → not < → idle
    expect(deriveLiveness(iso(NOW - 300_000), NOW)).toBe('idle');
    expect(deriveLiveness(iso(NOW - (PRESENCE_STALE_MS - 1)), NOW)).toBe('idle');
  });

  it('stale at/after PRESENCE_STALE_MS', () => {
    expect(deriveLiveness(iso(NOW - PRESENCE_STALE_MS), NOW)).toBe('stale');
    expect(deriveLiveness(iso(NOW - 3_600_000), NOW)).toBe('stale');
  });
});

describe('scopePresenceToWorkspace', () => {
  const rows = [
    presence({ ownerId: 'a', workspaceId: 'ws1' }),
    presence({ ownerId: 'b', workspaceId: 'ws2' }),
    presence({ ownerId: 'c', workspaceId: GLOBAL_WORKSPACE }),
  ];

  it('includes the matching workspace AND the global (*) rows, excludes others', () => {
    const got = scopePresenceToWorkspace(rows, 'ws1').map((r) => r.ownerId);
    expect(got).toEqual(['a', 'c']); // ws1 + the '*' SU shell; ws2 dropped
  });

  it('null workspace = the All scope (every row)', () => {
    expect(scopePresenceToWorkspace(rows, null).map((r) => r.ownerId)).toEqual(['a', 'b', 'c']);
    expect(scopePresenceToWorkspace(rows, undefined)).toHaveLength(3);
  });
});

describe('mergeRosterEntries', () => {
  it('presence-only agent (no adv_sessions row) still appears, with null enrichment', () => {
    const [entry] = mergeRosterEntries([presence({ currentPlanSlug: 'live-plan' })], new Map(), NOW);
    expect(entry.hasLaunchRecord).toBe(false);
    expect(entry.advSessionId).toBeNull();
    expect(entry.role).toBeNull();
    expect(entry.feature).toBeNull();
    expect(entry.currentPlanSlug).toBe('live-plan'); // from presence
    expect(entry.liveness).toBe('live');
    expect(entry.liveTurn).toBeNull();
    expect(entry.transcriptFresh).toBe(false);
    expect(entry.thinking).toBe(false); // deprecated compatibility alias
  });

  it('carries the shared oracle live-turn activity beside its session-state verdict', () => {
    const [entry] = mergeRosterEntries(
      [presence()],
      new Map(),
      NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        verdictByOwner: new Map([
          ['su-1', { sessionState: 'live', liveTurn: true, heartbeatFresh: true }],
        ]),
      },
    );
    expect(entry.sessionState).toBe('live');
    expect(entry.liveTurn).toBe(true);
    expect(entry.heartbeatFresh).toBe(true);
  });

  it('joins adv_sessions enrichment by owner id', () => {
    const advByOwner = new Map<string, AdvSessionRow>([['su-1', adv()]]);
    const [entry] = mergeRosterEntries([presence()], advByOwner, NOW);
    expect(entry.hasLaunchRecord).toBe(true);
    expect(entry.advSessionId).toBe(1);
    expect(entry.role).toBe('worker');
    expect(entry.feature).toBe('F-001');
    expect(entry.windowId).toBe('w-1');
    expect(entry.cwd).toBe('/repo');
  });

  it('currentPlanSlug prefers the live presence plan, falls back to the launch plan', () => {
    const advByOwner = new Map<string, AdvSessionRow>([['su-1', adv({ planSlug: 'launch-plan' })]]);
    // presence has no live plan → fall back to adv.planSlug
    const [fallback] = mergeRosterEntries([presence({ currentPlanSlug: null })], advByOwner, NOW);
    expect(fallback.currentPlanSlug).toBe('launch-plan');
    // presence has a live plan → it wins
    const [live] = mergeRosterEntries([presence({ currentPlanSlug: 'live-plan' })], advByOwner, NOW);
    expect(live.currentPlanSlug).toBe('live-plan');
  });

  it('harnessSlug: null with no spawned run and no session brief (today\'s baseline)', () => {
    const [entry] = mergeRosterEntries([presence()], new Map(), NOW);
    expect(entry.harnessSlug).toBeNull();
  });

  it('harnessSlug falls back to the session-brief harness for an interactive session with no spawned run (chat-ref-pills-2026-07-26 P-007 finding: this is the ONLY source for every real psu/su session — spawnedAgentRunInfoByOwner has zero rows for them)', () => {
    const [entry] = mergeRosterEntries(
      [presence()],
      new Map(),
      NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map(), // runInfoByOwner: no spawned run for this owner
      undefined,
      undefined,
      { sessionBriefHarness: new Map([['su-1', 'papercusp']]) },
    );
    expect(entry.harnessSlug).toBe('papercusp');
  });

  it('harnessSlug prefers the spawned-run harness over the session-brief fallback when both exist (the runId-paired live-thinking-stream semantics stay authoritative)', () => {
    const [entry] = mergeRosterEntries(
      [presence()],
      new Map(),
      NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Map([['su-1', { runId: 'run-1', harness: 'spawned-harness' }]]),
      undefined,
      undefined,
      { sessionBriefHarness: new Map([['su-1', 'brief-harness']]) },
    );
    expect(entry.harnessSlug).toBe('spawned-harness');
    expect(entry.runId).toBe('run-1');
  });

  it('preserves presence order (newest-heartbeat-first from listPresence)', () => {
    const got = mergeRosterEntries(
      [presence({ ownerId: 'x' }), presence({ ownerId: 'y' }), presence({ ownerId: 'z' })],
      new Map(),
      NOW,
    );
    expect(got.map((r) => r.ownerId)).toEqual(['x', 'y', 'z']);
  });

  it('attaches canonical claims from the fleet_assignment view by owner id (D-002)', () => {
    const claims = new Map([
      [
        'su-1',
        [
          {
            type: 'plan-item' as const,
            harnessSlug: 'all',
            planSlug: 'plan-x',
            id: 'P-001',
            itemKind: null,
            detail: 'building',
            status: null,
            acquiredTs: iso(NOW - 60_000),
            expiresTs: iso(NOW + 60_000),
            active: true,
            orphaned: false,
            stalled: null,
            lastProgressAt: null,
            activity: 'reserved' as const,
            rank: null,
            rankWriter: null,
          },
        ],
      ],
    ]);
    const [withClaims, without] = mergeRosterEntries(
      [presence({ ownerId: 'su-1' }), presence({ ownerId: 'su-2' })],
      new Map(),
      NOW,
      claims,
    );
    expect(withClaims.claims).toHaveLength(1);
    expect(withClaims.claims[0].id).toBe('P-001');
    expect(without.claims).toEqual([]);
  });

  it('stamps fleetSlug + the fleet accent color from fleetByOwner; null when no fleet (#3 grouping)', () => {
    const fleetByOwner = new Map([
      ['su-1', { fleetSlug: 'atlas', fleetColor: '#86efac', fleetRole: 'leader' }],
    ]);
    const [inFleet, noFleet] = mergeRosterEntries(
      [presence({ ownerId: 'su-1' }), presence({ ownerId: 'su-2' })],
      new Map(), // advByOwner
      NOW,
      new Map(), // claimsByOwner
      new Map(), // sessionsByOwner
      new Map(), // wakeModesByOwner
      'auto', // defaultWakeMode
      new Map(), // pendingWakesByOwner
      new Map(), // nurseryByOwner
      fleetByOwner,
    );
    // The pui Fleet tab groups by fleetSlug and paints the group header in fleetColor.
    expect(inFleet.fleetSlug).toBe('atlas');
    expect(inFleet.fleetColor).toBe('#86efac');
    // An owner absent from the map = no fleet → both null (pui draws a neutral "No fleet" group).
    expect(noFleet.fleetSlug).toBeNull();
    expect(noFleet.fleetColor).toBeNull();
  });

  // ── adv-hud-fleet-board-2026-07-25 P-001: the signals /adv/HUD's columns need ──

  it('propagates fleetRole from the membership row (the LEAD badge; it used to be dropped)', () => {
    const fleetByOwner = new Map([
      ['lead', { fleetSlug: 'atlas', fleetColor: '#86efac', fleetRole: 'leader' }],
      ['mem', { fleetSlug: 'atlas', fleetColor: '#86efac', fleetRole: 'member' }],
    ]);
    const [lead, mem, solo] = mergeRosterEntries(
      [presence({ ownerId: 'lead' }), presence({ ownerId: 'mem' }), presence({ ownerId: 'solo' })],
      new Map(),
      NOW,
      new Map(),
      new Map(),
      new Map(),
      'auto',
      new Map(),
      new Map(),
      fleetByOwner,
    );
    expect(lead.fleetRole).toBe('leader');
    expect(mem.fleetRole).toBe('member');
    // Not in a fleet ⇒ no role at all (never defaulted to 'member', which would
    // invent a membership the agent does not have).
    expect(solo.fleetRole).toBeNull();
  });

  it('carries context pressure + intent age straight off the presence row, preserving UNKNOWN as null', () => {
    const [measured, unmeasured] = mergeRosterEntries(
      [
        presence({
          ownerId: 'a',
          contextTokens: 124_000,
          compactionLimit: 200_000,
          intentDeclaredAt: '2026-07-25T12:00:00.000Z',
        }),
        // A row that has never been sampled: the watchdog has not written a
        // context estimate, and the intent was never declared.
        presence({ ownerId: 'b', intentDeclaredAt: null }),
      ],
      new Map(),
      NOW,
    );
    expect(measured.contextTokens).toBe(124_000);
    expect(measured.compactionLimit).toBe(200_000);
    expect(measured.intentDeclaredAt).toBe('2026-07-25T12:00:00.000Z');
    // The important half: an unsampled context stays null, NOT 0. Coercing to 0
    // would render as "0% used — plenty of room", the opposite of the truth.
    expect(unmeasured.contextTokens).toBeNull();
    expect(unmeasured.compactionLimit).toBeNull();
    expect(unmeasured.intentDeclaredAt).toBeNull();
  });

  /**
   * popup-agent-state-coverage-2026-08-18 P-001. `PresenceRecord` has carried
   * these four all along (`pg-store.ts` `toRecord()` maps every one); the shaper
   * simply dropped them on the floor, so no surface downstream could render
   * them. The costly one is `contextEstimatedAt`: without it the `ctx 47%` pill
   * has no provenance at all, which is what let a frozen estimate go unnoticed
   * across 48 sessions (one at 2.7× its true usage).
   */
  it('forwards contextEstimatedAt / potSlug / capabilityTags / tty from the presence row', () => {
    const [full, bare] = mergeRosterEntries(
      [
        presence({
          ownerId: 'a',
          contextTokens: 124_000,
          contextEstimatedAt: '2026-08-18T12:00:00.000Z',
          potSlug: 'sb-devboard-hive',
          capabilityTags: ['linux', 'pg17'],
          tty: '/dev/pts/4',
        }),
        // Never sampled / never reported: a federated peer, a headless session,
        // a standalone agent with no hive.
        presence({ ownerId: 'b' }),
      ],
      new Map(),
      NOW,
    );
    expect(full.contextEstimatedAt).toBe('2026-08-18T12:00:00.000Z');
    expect(full.potSlug).toBe('sb-devboard-hive');
    expect(full.capabilityTags).toEqual(['linux', 'pg17']);
    expect(full.tty).toBe('/dev/pts/4');

    // The null case. `contextEstimatedAt` is UNDEFINED on PresenceRecord when
    // the watchdog has never sampled the row, and it must arrive here as null
    // rather than vanishing — a reader distinguishes "no reading" from "a
    // reading whose age I can show", and both are legitimate.
    expect(bare.contextEstimatedAt).toBeNull();
    expect(bare.potSlug).toBeNull();
    expect(bare.tty).toBeNull();
    // `[]` is a POSITIVE value here ("resolved, no tags"), not a stand-in for
    // unknown — which is why it is an empty array and not null.
    expect(bare.capabilityTags).toEqual([]);
  });

  /**
   * The four fields are OPTIONAL precisely so the two launch tiers, which have
   * no presence row to source them from, can omit them. `undefined` there means
   * "the roster could not tell us"; defaulting them to null/[] would let a
   * pending launch claim it had been measured and found empty. This asserts the
   * omission on purpose so a later "tidy up the fixtures" change has to argue
   * with a test rather than silently invent the reading.
   */
  it('omits the presence-only fields on tiers that have no presence row', () => {
    const [pending] = pendingLaunchesToRosterEntries([adv({ display: 'workbench' })], 'h');
    expect(pending.contextEstimatedAt).toBeUndefined();
    expect(pending.potSlug).toBeUndefined();
    expect(pending.capabilityTags).toBeUndefined();
    expect(pending.tty).toBeUndefined();
  });

  it('attaches the open await via the extra options bag; absent owners get null', () => {
    const awaitByOwner = new Map([
      [
        'blocked',
        {
          eventKey: 'fleet:release-gate:suite-green',
          note: 'waiting on the gate verdict',
          sinceIso: '2026-07-25T11:00:00.000Z',
          expiresIso: '2026-07-25T11:30:00.000Z',
        },
      ],
    ]);
    const [blocked, free] = mergeRosterEntries(
      [presence({ ownerId: 'blocked' }), presence({ ownerId: 'free' })],
      new Map(),
      NOW,
      new Map(),
      new Map(),
      new Map(),
      'auto',
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Map(),
      { awaitByOwner },
    );
    expect(blocked.openAwait?.eventKey).toBe('fleet:release-gate:suite-green');
    expect(blocked.openAwait?.note).toBe('waiting on the gate verdict');
    expect(free.openAwait).toBeNull();
  });

  it('scopes the await join by OWNER IDS, not workspace (the cross-tenant trap)', async () => {
    // Regression for a bug that only live data exposed. event_awaits and
    // coord_presence do not share a workspace vocabulary — on this box every
    // open await carries workspace_id 'default' while every presence row
    // carries 'papercusp-workspace'. Filtering awaits by the roster's workspace
    // therefore matched ZERO rows on any scoped read: the Blocked column
    // rendered empty in the app while an unscoped curl of the same endpoint
    // returned 13. Pin the contract at the SQL boundary so the workspace
    // predicate cannot come back.
    const { openAwaitsByOwner } = await import('./adv-roster');
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./adv-roster.ts', import.meta.url), 'utf8'),
    );
    const fn = src.slice(src.indexOf('export async function openAwaitsByOwner'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('subscriber_id = ANY(');
    expect(body).not.toMatch(/workspace_id\s*=/);
    // The always-armed inbox wake must stay excluded (see the guard above).
    expect(body).toContain("NOT LIKE 'coord:inbox-wake:%'");
    // An empty roster short-circuits without touching PG.
    await expect(openAwaitsByOwner([])).resolves.toEqual(new Map());
  });

  it('defaults the extra bag so every existing positional call site keeps working', () => {
    // The 3-arg form is what most callers (and every pre-existing test) use.
    const [entry] = mergeRosterEntries([presence()], new Map(), NOW);
    expect(entry.openAwait).toBeNull();
    expect(entry.fleetRole).toBeNull();
  });
});

describe('dedupeEndedAgainstActive', () => {
  it('drops ended rows whose coord owner is still live in the active roster', () => {
    const ended = [adv({ id: 1, coordOwnerId: 'su-live' }), adv({ id: 2, coordOwnerId: 'su-gone' })];
    const got = dedupeEndedAgainstActive(ended, [{ ownerId: 'su-live' }]);
    expect(got.map((r) => r.id)).toEqual([2]); // su-live shown in active; su-gone kept as ended
  });

  it('keeps ended rows with no coord_owner_id (console/legacy cannot collide)', () => {
    const ended = [adv({ id: 5, coordOwnerId: null })];
    expect(dedupeEndedAgainstActive(ended, [{ ownerId: 'su-x' }]).map((r) => r.id)).toEqual([5]);
  });

  it('keeps everything when nothing is active', () => {
    const ended = [adv({ id: 1, coordOwnerId: 'a' }), adv({ id: 2, coordOwnerId: 'b' })];
    expect(dedupeEndedAgainstActive(ended, []).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('shouldProbePid (zombie detection eligibility, P-008)', () => {
  const make = (over: Partial<PresenceRecord>) =>
    mergeRosterEntries([presence({ host: 'box1', pid: 42, ...over })], new Map(), NOW)[0];

  it('probes a same-host non-stale entry with a pid', () => {
    expect(shouldProbePid(make({}), 'box1')).toBe(true);
  });
  it('probes a host-less (empty host) entry — assumed local', () => {
    expect(shouldProbePid(make({ host: '' }), 'box1')).toBe(true);
  });
  it('skips a different host (can’t check, pid could collide)', () => {
    expect(shouldProbePid(make({}), 'other-box')).toBe(false);
  });
  it('skips an entry with no pid', () => {
    expect(shouldProbePid(make({ pid: null }), 'box1')).toBe(false);
  });
  it('skips a stale entry (already known-gone)', () => {
    const e = make({ heartbeatAt: iso(NOW - STALE_MS - 1) });
    expect(e.liveness).toBe('stale');
    expect(shouldProbePid(e, 'box1')).toBe(false);
  });
});

describe('pendingLaunchesToRosterEntries (pui-reactive-session-panes D-006)', () => {
  it('synthesizes a pending workbench RosterEntry the pui panes', () => {
    const row = adv({
      id: 42,
      display: 'workbench',
      launchArgv: ['psu', '--no-picker', '--agent=claude', '--plan=my-plan'],
      label: 'claude · my-plan',
      cwd: '/repo/papercup',
    });
    const [e] = pendingLaunchesToRosterEntries([row], 'box-1');
    expect(e.ownerId).toBe('pending:adv:42');
    expect(e.liveness).toBe('pending');
    expect(e.sessionState).toBeNull();
    expect(e.liveTurn).toBeNull();
    expect(e.heartbeatFresh).toBeNull();
    expect(e.host).toBe('box-1'); // local — the recording box
    expect(e.display).toBe('workbench');
    expect(e.launchArgv).toEqual(['psu', '--no-picker', '--agent=claude', '--plan=my-plan']);
    expect(e.advSessionId).toBe(42);
    expect(e.hasLaunchRecord).toBe(true);
    expect(e.cwd).toBe('/repo/papercup');
    expect(e.pid).toBeNull();
  });

  it('falls back to an agent·plan label and tolerates a null launchArgv', () => {
    const row = adv({ id: 7, display: 'workbench', label: null, launchArgv: null, planSlug: 'p' });
    const [e] = pendingLaunchesToRosterEntries([row], 'box-1');
    expect(e.label).toBe('claude · p'); // agent · planSlug
    expect(e.launchArgv).toEqual([]);
  });
});

describe('startingLaunchesToRosterEntries (WI-6376 — terminal launch boot window)', () => {
  it('keys the entry on the PRE-PINNED coord owner, so it is the same identity presence will use', () => {
    const row = adv({
      id: 91,
      display: 'terminal',
      coordOwnerId: 'su-abc',
      launchArgv: ['psu', '--no-picker', '--agent=claude', '--owner-id=su-abc'],
      pid: 4242,
    });
    const [e] = startingLaunchesToRosterEntries([row], 'box-1');
    expect(e.ownerId).toBe('su-abc'); // NOT a synthetic id — dedupe depends on this
    expect(e.liveness).toBe('pending');
    expect(e.sessionState).toBeNull();
    expect(e.liveTurn).toBeNull();
    expect(e.heartbeatFresh).toBeNull();
    expect(e.lastActiveAt).toBeNull(); // → needs-you via deriveColumn step 1c
    expect(e.advSessionId).toBe(91);
    expect(e.pid).toBe(4242);
  });

  // WI-6821 — the launch died and the card kept saying "starting up". The verdict
  // is read off PERSISTED state, so the board, the modal and the pui cannot
  // disagree about it and it survives a reload.
  it('marks a launch that ended without ever registering as FAILED, in the past tense', () => {
    const row = adv({
      id: 93,
      display: 'terminal',
      coordOwnerId: 'su-dead',
      endedAt: '2026-08-02T02:25:11.000Z',
      sessionId: null,
    });
    const [e] = startingLaunchesToRosterEntries([row], 'box-1');
    expect(e.launchFailed).toBe(true);
    expect(e.intent).toBe('launch failed');
  });

  it('leaves a launch still inside its boot window saying "starting up"', () => {
    const row = adv({ id: 94, display: 'terminal', coordOwnerId: 'su-boot', endedAt: null });
    const [e] = startingLaunchesToRosterEntries([row], 'box-1');
    expect(e.launchFailed).toBe(false);
    expect(e.intent).toBe('starting up');
  });

  it('marks a live headless launch parked at the weekly-limit dialog as BLOCKED, not failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adv-roster-headless-'));
    try {
      const log = join(root, '.papercusp', 'fleet-logs', 'claude-headless-123-456.log');
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(
        log,
        "\x1b[38;2;255;107;128mYou've hit your weekly limit \u00b7 resets 7am (America/New_York)\r\x1b[39m",
      );
      const rows = [
        adv({
          id: 96,
          display: 'terminal',
          coordOwnerId: 'su-blocked',
          terminalBin: `headless (log: ${log})`,
          sessionId: '8cda4456-bc7d-4131-a764-f339a50680ac',
          endedAt: null,
        }),
      ];
      const [e] = startingLaunchesToRosterEntries(
        rows,
        'box-1',
        await readStartingLaunchLogHints(rows),
      );
      expect(e.launchBlocked).toBe(true);
      expect(e.launchFailed).toBe(false);
      expect(e.intent).toBe('launch blocked');
      expect(e.launchBlockedHint).toContain('resets 7am (America/New_York)');
      expect(e.launchBlockedHint).toContain('Launch with Codex or an available account');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not call an ordinary live headless boot blocked merely because it has a log', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adv-roster-headless-'));
    try {
      const log = join(root, '.papercusp', 'fleet-logs', 'claude-headless-123-789.log');
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, 'Claude Code booting\nMCP connected\n');
      const rows = [adv({ id: 97, display: 'terminal', terminalBin: `headless (log: ${log})` })];
      const hints = await readStartingLaunchLogHints(rows);
      expect(hints.get(97)).toEqual({ blockedHint: null, failureHint: null });
      const [e] = startingLaunchesToRosterEntries(rows, 'box-1', hints);
      expect(e.launchBlocked).toBe(false);
      expect(e.launchBlockedHint).toBeNull();
      expect(e.intent).toBe('starting up');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // EI-24748208098755918: this mapper runs on every roster poll on the operator's
  // main thread. It used to readSync each starting launch's log, and a profile
  // charged 790 ms of one 3 s window to that read. The mapper must stay PURE:
  // given no hints it reports no hint, even when a blocking log sits on disk.
  it('does no file I/O itself: a blocking log on disk is ignored unless hints were read first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adv-roster-headless-'));
    try {
      const log = join(root, '.papercusp', 'fleet-logs', 'claude-headless-123-999.log');
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, "You've hit your weekly limit · resets 7am\n");
      const rows = [adv({ id: 98, display: 'terminal', terminalBin: `headless (log: ${log})` })];

      const [pure] = startingLaunchesToRosterEntries(rows, 'box-1');
      expect(pure.launchBlocked).toBe(false);
      expect(pure.launchBlockedHint).toBeNull();

      // Positive control: the same row IS blocked once the async reader ran, so
      // the assertion above is about where the read happens, not a dead log.
      const [read] = startingLaunchesToRosterEntries(
        rows,
        'box-1',
        await readStartingLaunchLogHints(rows),
      );
      expect(read.launchBlocked).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hint reader never rejects and never reads a log for a FAILED launch as a block', async () => {
    const failed = adv({
      id: 99,
      display: 'terminal',
      coordOwnerId: 'su-not-a-real-owner-for-this-test',
      terminalBin: 'headless (log: /nonexistent/.papercusp/fleet-logs/x.log)',
      endedAt: '2026-08-02T02:25:11.000Z',
      sessionId: null,
    });
    const hints = await readStartingLaunchLogHints([failed]);
    expect(hints.get(99)?.blockedHint).toBeNull();
    const [e] = startingLaunchesToRosterEntries([failed], 'box-1', hints);
    expect(e.launchFailed).toBe(true);
    expect(e.launchBlocked).toBe(false);
  });

  // A session that booted and later ended is an ORDINARY end. Calling that a
  // failed launch would be a second lie, pointed the other way.
  it('does not call a session that registered before ending a failed launch', () => {
    const row = adv({
      id: 95,
      display: 'terminal',
      coordOwnerId: 'su-ok',
      endedAt: '2026-08-02T02:25:11.000Z',
      sessionId: 'sess-1',
    });
    const [e] = startingLaunchesToRosterEntries([row], 'box-1');
    expect(e.launchFailed).toBe(false);
  });

  it("keeps display='terminal' so the pui's workbench-only pane filter can never pane it", () => {
    const row = adv({ id: 92, display: 'terminal', coordOwnerId: 'su-x' });
    const [e] = startingLaunchesToRosterEntries([row], 'box-1');
    // is_displayable (apps/tui/src/session_panes.rs) requires exactly 'workbench'.
    expect(e.display).toBe('terminal');
    expect(e.display).not.toBe('workbench');
  });

  it("classifies a role-less psu launch as 'su' so the board's DEFAULT su-only filter shows it", () => {
    // FOUND LIVE 2026-07-27, not by a unit test: the card was BUILT but invisible
    // unless ?hudall=true, because classifyAgentPane only yields 'su' for a
    // role-less session whose coord id has the psu `su-` prefix — and this mapper
    // was not passing ownerId, so it fell to 'cup' and isSuSession filtered it out.
    // The board defaults to su-only, so "renders" and "is visible" were not the
    // same claim, which is exactly what the live check exists to separate.
    const [e] = startingLaunchesToRosterEntries(
      [adv({ id: 94, display: 'terminal', coordOwnerId: 'su-abc', role: null })],
      'box-1',
    );
    expect(e.agentPaneKind).toBe('su');
  });

  it('still honours an explicit role over the su- prefix (a planner stays a planner)', () => {
    // Non-vacuity guard: the ownerId must not override a real role, or a New-plan
    // launch would lose its planner pane kind.
    const [e] = startingLaunchesToRosterEntries(
      [adv({ id: 95, display: 'terminal', coordOwnerId: 'su-abc', role: 'planner' })],
      'box-1',
    );
    expect(e.agentPaneKind).toBe('planner');
  });

  it('falls back to a synthetic id for a pre-WI-6363 row with no pre-pinned owner', () => {
    const row = adv({ id: 93, display: 'terminal', coordOwnerId: null });
    const [e] = startingLaunchesToRosterEntries([row], 'box-1');
    expect(e.ownerId).toBe('starting:adv:93');
  });
});

describe('dedupeStartingAgainstActive (WI-6376 — no double card once it boots)', () => {
  // Only `ownerId` is read; a full RosterEntry would obscure that.
  const online = (ownerId: string): RosterEntry => ({ ownerId }) as RosterEntry;

  it('drops a starting row whose session has come online', () => {
    const starting = startingLaunchesToRosterEntries(
      [adv({ id: 1, display: 'terminal', coordOwnerId: 'su-online' })],
      'box-1',
    );
    expect(starting).toHaveLength(1); // guard: the dedupe below is not vacuous
    expect(dedupeStartingAgainstActive(starting, [online('su-online')])).toEqual([]);
  });

  it('keeps a starting row whose session has NOT registered yet', () => {
    const starting = startingLaunchesToRosterEntries(
      [adv({ id: 2, display: 'terminal', coordOwnerId: 'su-booting' })],
      'box-1',
    );
    expect(
      dedupeStartingAgainstActive(starting, [online('su-someone-else')]).map((e) => e.ownerId),
    ).toEqual(['su-booting']);
  });
});

describe('agentPaneKind stamping (hive-agent-tabs-psu-tui P-001)', () => {
  it('active entries: brain→queen, operator→sentinel, worker→bee, bare→bee', () => {
    const [brain] = mergeRosterEntries(
      [presence({ ownerId: 'b' })],
      new Map([['b', adv({ role: 'brain' })]]),
      NOW,
    );
    expect(brain.agentPaneKind).toBe('mug');
    expect(brain.driveMode).toBe('auto');

    const [op] = mergeRosterEntries(
      [presence({ ownerId: 'o' })],
      new Map([['o', adv({ role: 'operator' })]]),
      NOW,
    );
    expect(op.agentPaneKind).toBe('papercup');
    expect(op.driveMode).toBe('responsive');

    const [w] = mergeRosterEntries([presence({ ownerId: 'w' })], new Map([['w', adv({ role: 'worker' })]]), NOW);
    expect(w.agentPaneKind).toBe('cup');

    // Plain SU shell (no adv row, role null) → bee default.
    const [bare] = mergeRosterEntries([presence({ ownerId: 'x' })], new Map(), NOW);
    expect(bare.agentPaneKind).toBe('cup');
  });

  it('classifies invoke-launched queen/overwatch from presence agentRole when there is no adv row (dock panes)', () => {
    // The autonomous Queen + Overwatch fire via the invoke route — NO adv_sessions
    // row (adv.role null) — but their presence row carries agentRole. Without the
    // fallback they dropped to the bee arm and vanished from the dock --queen /
    // --overwatch panes.
    const [queen] = mergeRosterEntries([presence({ ownerId: 'q', agentRole: 'mug' })], new Map(), NOW);
    expect(queen.agentPaneKind).toBe('mug');
    expect(queen.role).toBe('mug');

    const [ow] = mergeRosterEntries([presence({ ownerId: 'ow', agentRole: 'kettle' })], new Map(), NOW);
    expect(ow.agentPaneKind).toBe('kettle');

    // An explicit adv-record role still wins over the presence agentRole.
    const [adved] = mergeRosterEntries(
      [presence({ ownerId: 'a', agentRole: 'mug' })],
      new Map([['a', adv({ role: 'worker' })]]),
      NOW,
    );
    expect(adved.agentPaneKind).toBe('cup');
  });

  it('surfaces the bee session_id from the spawned-agents map → claude --resume handle (P-004)', () => {
    const [e] = mergeRosterEntries(
      [presence({ ownerId: 's-bee-1' })],
      new Map([['s-bee-1', adv({ role: 'cup' })]]),
      NOW,
      new Map(),
      new Map([['s-bee-1', 'claude-uuid-xyz']]),
    );
    expect(e.sessionId).toBe('claude-uuid-xyz');
    expect(e.nativeSession).toMatchObject({
      backend: 'claude',
      source: 'spawned_agents',
      ownerId: 's-bee-1',
      sessionId: 'claude-uuid-xyz',
      exactResumeSupported: true,
    });
    // No session recorded (omp bee / pre-flag) → null.
    const [none] = mergeRosterEntries([presence({ ownerId: 's-2' })], new Map(), NOW);
    expect(none.sessionId).toBeNull();
    expect(none.nativeSession).toBeNull();
  });

  it('keeps the legacy sessionId alias Claude-only while surfacing backend-neutral Codex and OMP handles', () => {
    const [claude] = mergeRosterEntries(
      [presence({ ownerId: 'claude-owner' })],
      new Map([['claude-owner', adv({ agent: 'claude', coordOwnerId: 'claude-owner', sessionId: 'claude-session' })]]),
      NOW,
    );
    expect(claude.sessionId).toBe('claude-session');

    const [codex] = mergeRosterEntries(
      [presence({ ownerId: 'codex-owner' })],
      new Map([['codex-owner', adv({
        id: 9,
        agent: 'codex',
        coordOwnerId: 'codex-owner',
        sessionId: '01a032b7-147a-7cc2-8411-e59c26bb6a02',
      })]]),
      NOW,
    );
    expect(codex.sessionId).toBeNull();
    expect(codex.nativeSession).toMatchObject({
      backend: 'codex',
      source: 'adv_sessions',
      ownerId: 'codex-owner',
      exactResumeSupported: false,
    });
    expect(codex.nativeSession && 'codexHome' in codex.nativeSession ? codex.nativeSession.codexHome : '').toContain('session-9');

    const [omp] = mergeRosterEntries(
      [presence({ ownerId: 'omp-owner' })],
      new Map([['omp-owner', adv({
        agent: 'omp',
        coordOwnerId: 'omp-owner',
        sessionId: 'opaque-omp-session-id',
        ompThreadId: 'omp-thread',
      })]]),
      NOW,
    );
    expect(omp.sessionId).toBeNull();
    expect(omp.nativeSession).toMatchObject({
      backend: 'omp',
      source: 'adv_sessions',
      ownerId: 'omp-owner',
      ompThreadId: 'omp-thread',
      exactResumeSupported: true,
    });
  });

  it('surfaces backend-neutral spawned Codex and OMP handles from the spawned-agent handle map', () => {
    const [codex, omp] = mergeRosterEntries(
      [
        presence({ ownerId: 'codex-spawn' }),
        presence({ ownerId: 'omp-spawn' }),
      ],
      new Map(),
      NOW,
      new Map(),
      new Map([
        [
          'codex-spawn',
          {
            backend: 'codex',
            source: 'spawned_agents',
            ownerId: 'codex-spawn',
            codexHome: '',
            rolloutId: null,
            exactResumeSupported: false,
            missingReason: 'spawned Codex agent has no durable CODEX_HOME/rollout handle recorded',
          },
        ],
        [
          'omp-spawn',
          {
            backend: 'omp',
            source: 'spawned_agents',
            ownerId: 'omp-spawn',
            ompThreadId: null,
            agentHome: null,
            exactResumeSupported: false,
            missingReason: 'spawned OMP agent has no thread id recorded',
          },
        ],
      ]),
    );
    expect(codex.sessionId).toBeNull();
    expect(codex.nativeSession).toMatchObject({
      backend: 'codex',
      source: 'spawned_agents',
      exactResumeSupported: false,
    });
    expect(omp.nativeSession).toMatchObject({
      backend: 'omp',
      source: 'spawned_agents',
      exactResumeSupported: false,
    });
  });

  it('resolves each agent wake mode (override ?? default ?? auto) for the P-008 badge', () => {
    // per-agent override wins
    const [overridden] = mergeRosterEntries(
      [presence({ ownerId: 's-1' })], new Map(), NOW, new Map(), new Map(),
      new Map([['s-1', 'manual']]) as Map<string, 'auto' | 'manual'>,
      'auto',
    );
    expect(overridden.wakeMode).toBe('manual');
    // no override → the global default
    const [def] = mergeRosterEntries(
      [presence({ ownerId: 's-2' })], new Map(), NOW, new Map(), new Map(), new Map(), 'manual',
    );
    expect(def.wakeMode).toBe('manual');
    // nothing configured → auto (default-preserving)
    const [bare] = mergeRosterEntries([presence({ ownerId: 's-3' })], new Map(), NOW);
    expect(bare.wakeMode).toBe('auto');
  });

  it('attaches the staged-wake count (P-008 badge) — absent owner → 0', () => {
    const [staged, none] = mergeRosterEntries(
      [presence({ ownerId: 's-1' }), presence({ ownerId: 's-2' })],
      new Map(), NOW, new Map(), new Map(), new Map(), 'auto',
      new Map([['s-1', 3]]),
    );
    expect(staged.pendingWakes).toBe(3);
    expect(none.pendingWakes).toBe(0);
    // pending (not-yet-spawned) entries never have staged wakes
    const row = adv({ id: 11, display: 'workbench', role: 'worker', launchArgv: ['psu'] });
    expect(pendingLaunchesToRosterEntries([row], 'box-1')[0].pendingWakes).toBe(0);
  });

  it('pending entry: a retired --brain launch argv no longer implies queen', () => {
    const row = adv({ id: 9, display: 'workbench', role: null, launchArgv: ['psu', '--brain'] });
    const [e] = pendingLaunchesToRosterEntries([row], 'box-1');
    expect(e.agentPaneKind).toBe('cup');
    expect(e.driveMode).toBe('auto');
  });

  it('pending entry: worker role → bee', () => {
    const row = adv({ id: 10, display: 'workbench', role: 'worker', launchArgv: ['psu', '--agent=claude'] });
    const [e] = pendingLaunchesToRosterEntries([row], 'box-1');
    expect(e.agentPaneKind).toBe('cup');
  });

  it('pending entry: a New-plan launch types as planner from EITHER signal (P-006)', () => {
    // argv hint alone (role-less row).
    const byArgv = adv({
      id: 12, display: 'workbench', role: null,
      launchArgv: ['psu', '--no-picker', '--agent=claude', '--role=planner'],
    });
    const [a] = pendingLaunchesToRosterEntries([byArgv], 'box-1');
    expect(a.agentPaneKind).toBe('planner');
    expect(a.driveMode).toBe('responsive'); // auto-injection OFF
    // recorded role alone (launch-su records role='planner').
    const byRole = adv({ id: 13, display: 'workbench', role: 'planner', launchArgv: ['psu'] });
    const [b] = pendingLaunchesToRosterEntries([byRole], 'box-1');
    expect(b.agentPaneKind).toBe('planner');
  });
});

/**
 * EI-348 (liveness-hardening P-013/P-015): the colony roster dropped LIVE
 * working bees — presence is tool-call-coupled, so a bee heads-down in local
 * tools went presence-stale within LIVE_MS while its process was alive and its
 * nursery row said running. The nursery is now a first-class liveness leg.
 * Fixture = the live 2026-06-11 repro: bee alive 413s, presence 397s stale,
 * roster showed 18 su sessions and NO bee.
 */
describe('mergeRosterEntries — nursery liveness join (EI-348)', () => {
  const BEE = 's-1781222766931-b8ad8613';
  const beePresence = () =>
    presence({
      ownerId: BEE,
      ownerLabel: `bee · ${BEE}`,
      heartbeatAt: iso(NOW - 397_000), // presence 397s old — beyond LIVE_MS
    });
  const nursery = (over: Partial<NurseryLiveness> = {}): NurseryLiveness => ({
    spawnId: BEE,
    heartbeatAt: iso(NOW - 20_000), // supervisor beat 20s ago
    lastOutputAt: iso(NOW - 8_000),
    pidAlive: true,
    ...over,
  });
  const withNursery = (n: NurseryLiveness | null) =>
    mergeRosterEntries(
      [beePresence()],
      new Map(),
      NOW,
      new Map(),
      new Map(),
      new Map(),
      'auto',
      new Map(),
      n ? new Map([[BEE, n]]) : new Map(),
    )[0];

  it('the exact repro: stale presence + running nursery + pid-alive → LIVE bee', () => {
    const e = withNursery(nursery());
    expect(e.liveness).toBe('live');
    expect(e.pidAlive).toBe(true);
    expect(e.lastOutputAt).toBe(iso(NOW - 8_000));
  });

  it('pid-alive alone is definitive even when the nursery beat is old', () => {
    const e = withNursery(nursery({ heartbeatAt: iso(NOW - 900_000), pidAlive: true }));
    expect(e.liveness).toBe('live');
  });

  it('cross-host bee (pidAlive unknown) rides the nursery heartbeat', () => {
    const e = withNursery(nursery({ pidAlive: null, heartbeatAt: iso(NOW - 20_000) }));
    expect(e.liveness).toBe('live');
  });

  it('nursery NEVER downgrades a presence-live entry (best-of-both)', () => {
    const e = mergeRosterEntries(
      [presence({ ownerId: BEE, heartbeatAt: iso(NOW - 5_000) })],
      new Map(), NOW, new Map(), new Map(), new Map(), 'auto', new Map(),
      new Map([[BEE, nursery({ pidAlive: false, heartbeatAt: iso(NOW - 900_000) })]]),
    )[0];
    expect(e.liveness).toBe('live');
  });

  it('without a nursery row the pre-EI-348 presence-only behavior is unchanged (su sessions unaffected)', () => {
    const e = withNursery(null);
    expect(e.liveness).toBe('idle'); // 397s = between LIVE_MS and STALE_MS
    expect(e.lastOutputAt).toBeNull();
    expect(e.pidAlive).toBeNull();
  });
});

describe('mergeRosterEntries — activity + loop-armed (WI-1488)', () => {
  it('passes lastActiveAt through and marks loopArmed from the owner set', () => {
    const [armed, plain] = mergeRosterEntries(
      [presence({ ownerId: 'a', lastActiveAt: iso(NOW - 1_000) }), presence({ ownerId: 'b' })],
      new Map(),
      NOW,
      new Map(),
      new Map(),
      new Map(),
      'auto',
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(['a']),
    );
    expect(armed.ownerId).toBe('a');
    expect(armed.loopArmed).toBe(true);
    expect(armed.lastActiveAt).toBe(iso(NOW - 1_000));
    expect(plain.ownerId).toBe('b');
    expect(plain.loopArmed).toBe(false);
  });

  it('defaults loopArmed=false when no owner set is provided', () => {
    const [e] = mergeRosterEntries([presence()], new Map(), NOW);
    expect(e.loopArmed).toBe(false);
  });

  // Standing modes reach the GUI chips WITH provenance. The roster used to
  // flatten agent_modes to a bare id even though the batched read already
  // returned owner_directed/set_at, so a card could say "AUTO" but never
  // "…because you put it there" — and owner-directed is exactly what decides
  // whether a peer agent can override it.
  it('carries mode provenance through to the roster entry', () => {
    const [e, none] = mergeRosterEntries(
      [presence({ ownerId: 'a' }), presence({ ownerId: 'b' })],
      new Map(),
      NOW,
      new Map(),
      new Map(),
      new Map(),
      'auto',
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Map([
        // `subject` is null for AUTO — it is the GOAL axis that populates it
        // (the goal id this session runs, D-007/P-020).
        ['a', [{ mode: 'auto', ownerDirected: true, since: iso(NOW - 60_000), subject: null }]],
      ]),
    );
    expect(e.modes).toEqual([
      { mode: 'auto', ownerDirected: true, since: iso(NOW - 60_000), subject: null },
    ]);
    expect(none.modes).toEqual([]);
  });

  it('does not render durable mode registrations as staffing after the session ended', () => {
    const mode = { mode: 'grade', ownerDirected: false, since: iso(NOW - 60_000), subject: null };
    const modes = new Map([['a', [mode]]]);
    const endedVerdict = new Map([
      [
        'a',
        {
          sessionState: 'ended' as const,
          liveTurn: false,
          heartbeatFresh: false,
        },
      ],
    ]);
    const unknownVerdict = new Map([
      [
        'a',
        {
          sessionState: null,
          liveTurn: false,
          heartbeatFresh: false,
        },
      ],
    ]);

    const build = (verdictByOwner: typeof endedVerdict | typeof unknownVerdict) =>
      mergeRosterEntries(
        [presence({ ownerId: 'a' })],
        new Map(),
        NOW,
        new Map(),
        new Map(),
        new Map(),
        'auto',
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Set(),
        modes,
        { verdictByOwner },
      )[0];

    expect(build(endedVerdict).modes).toEqual([]);
    // Unknown is not death: preserve the registration until the oracle can
    // make a positive determination.
    expect(build(unknownVerdict).modes).toEqual([mode]);
  });

  it('a loop-owned monitor is not declared-unclaimed between wakes', () => {
    const [monitor] = mergeRosterEntries(
      [presence({ ownerId: 'monitor', currentPlanSlug: 'watch-plan' })],
      new Map(),
      NOW,
      new Map(),
      new Map(),
      new Map(),
      'auto',
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(['monitor']),
    );
    expect(monitor.loopArmed).toBe(true);
    expect(monitor.declaredUnclaimed).toBe(false);
  });

  it('tags local rows isLocal:true and federated rows with their machineLabel', () => {
    const fedRow = {
      ...presence({ ownerId: 'remote1' }),
      federated: true,
      machineLabel: 'box-B',
      host: 'box-B',
    } as unknown as PresenceRecord;
    const [local, remote] = mergeRosterEntries([presence({ ownerId: 'local1' }), fedRow], new Map(), NOW);
    expect(local.isLocal).toBe(true);
    expect(local.machineLabel).toBeNull(); // stamped later in mergeRosterWithAssignments
    expect(remote.isLocal).toBe(false);
    expect(remote.machineLabel).toBe('box-B');
  });
});

describe('mergeRosterEntries — display name + objective (hud-session-display-names P-004)', () => {
  /** The signature is at 13 positionals before the options bag; this fills the defaults. */
  function merge(
    extra: NonNullable<Parameters<typeof mergeRosterEntries>[13]>,
    p: PresenceRecord = presence(),
  ): RosterEntry {
    return mergeRosterEntries(
      [p],
      new Map(),
      NOW,
      new Map(),
      new Map(),
      new Map(),
      'auto',
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Map(),
      extra,
    )[0];
  }

  it('carries the manual name RAW, without flattening it into the objective', () => {
    const e = merge({ displayNameByOwner: new Map([['su-1', 'release wrangler']]) });
    expect(e.displayName).toBe('release wrangler');
    // the objective is still its own layer — the board resolves the headline
    expect(e.objective).toBe('doing X');
  });

  it('objective prefers the in-flight work-item title and reports its ref', () => {
    const e = merge({
      wipByOwner: new Map([['su-1', { title: 'Green the checkpoint gate', workItemRef: 'WI-42' }]]),
    });
    expect(e.objective).toBe('Green the checkpoint gate');
    expect(e.objectiveWorkItemRef).toBe('WI-42');
  });

  it('falls back to the declared intent, and then carries NO work-item ref', () => {
    const e = merge({});
    expect(e.objective).toBe('doing X');
    // an intent-derived objective must not print a work-item id the headline is not about
    expect(e.objectiveWorkItemRef).toBeNull();
  });

  it('a claimed work item with a blank title still falls back to the intent, ref dropped', () => {
    const e = merge({ wipByOwner: new Map([['su-1', { title: '   ', workItemRef: 'WI-42' }]]) });
    expect(e.objective).toBe('doing X');
    expect(e.objectiveWorkItemRef).toBeNull();
  });

  it('an undeclared intent reads as absent, not as an empty objective', () => {
    // coord_presence.intent is NOT NULL DEFAULT '' — the blank must not leak through
    const e = merge({}, presence({ intent: '' }));
    expect(e.objective).toBeNull();
    expect(e.objectiveWorkItemRef).toBeNull();
  });

  it('degraded joins read exactly like an unnamed, unclaimed agent (R9)', () => {
    const e = merge({});
    expect(e.displayName).toBeNull();
    expect(e.objective).toBe('doing X'); // still renders — never a blank card
  });
});

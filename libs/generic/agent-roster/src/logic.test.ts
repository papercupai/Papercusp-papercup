import { describe, expect, it } from 'vitest';
import {
  activityLiveness,
  activityLivenessTitle,
  canFocusWindow,
  canForkSession,
  displayName,
  distinctMachineCount,
  filterRoster,
  fmtCompactAge,
  groupByFleet,
  hasThinking,
  isAgentThinking,
  isRunningAgent,
  isSessionGone,
  isTranscriptFresh,
  machineKey,
  machineTabs,
  resumableSessionId,
  shortOwner,
  thinkingStreamUrl,
} from './logic';
import { agentGlyph } from './glyphs';
import { LIVE_MS, LIVE_TURN_MS, type RosterAgent } from './types';

const NOW = Date.parse('2026-08-31T00:00:00.000Z');

function agent(over: Partial<RosterAgent> = {}): RosterAgent {
  return {
    ownerId: 'su-1234abcd-0000-0000-0000-000000000000',
    label: '',
    agent: 'claude',
    role: null,
    intent: '',
    feature: null,
    currentPlanSlug: null,
    liveness: 'live',
    heartbeatAt: new Date(NOW).toISOString(),
    ...over,
  };
}

/** `nowMs` minus `ms`, as the ISO string the roster payload carries. */
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

describe('groupByFleet', () => {
  it('puts fleeted groups first alphabetically and "No fleet" last', () => {
    const groups = groupByFleet([
      agent({ ownerId: 'a', fleetSlug: null }),
      agent({ ownerId: 'b', fleetSlug: 'zulu', fleetColor: '#111' }),
      agent({ ownerId: 'c', fleetSlug: 'alpha', fleetColor: '#222' }),
      agent({ ownerId: 'd', fleetSlug: 'alpha', fleetColor: '#222' }),
    ]);
    expect(groups.map((g) => g.slug)).toEqual(['alpha', 'zulu', null]);
    expect(groups[0].agents.map((a) => a.ownerId)).toEqual(['c', 'd']);
    expect(groups[0].color).toBe('#222');
  });

  it('preserves input order within a group', () => {
    const groups = groupByFleet([
      agent({ ownerId: 'second', fleetSlug: 'f' }),
      agent({ ownerId: 'first', fleetSlug: 'f' }),
    ]);
    expect(groups[0].agents.map((a) => a.ownerId)).toEqual(['second', 'first']);
  });

  it('treats a blank/whitespace fleetSlug as no fleet, and gives that group no colour', () => {
    const groups = groupByFleet([agent({ fleetSlug: '   ', fleetColor: '#abc' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].slug).toBeNull();
    expect(groups[0].color).toBeNull();
  });
});

describe('activityLiveness', () => {
  it('reads genuine activity, not the keepalive heartbeat', () => {
    expect(activityLiveness({ lastActiveAt: agoIso(1_000) }, NOW)).toBe('live');
    expect(activityLiveness({ lastActiveAt: agoIso(LIVE_MS + 1) }, NOW)).toBe('idle');
    expect(activityLiveness({ lastActiveAt: agoIso(LIVE_TURN_MS + 1) }, NOW)).toBe('stale');
  });

  it('is stale — never live — when lastActiveAt is missing or unparseable', () => {
    // The owner's standing rule: a keepalive heartbeat is not evidence of taking
    // turns, so a row that never stamped a real turn must not read as live.
    expect(activityLiveness({ lastActiveAt: null }, NOW)).toBe('stale');
    expect(activityLiveness({ lastActiveAt: undefined }, NOW)).toBe('stale');
    expect(activityLiveness({ lastActiveAt: 'not-a-date' }, NOW)).toBe('stale');
  });

  it('does NOT treat an armed loop as liveness — a killed loop-armed session reads stale', () => {
    const wedged = { lastActiveAt: agoIso(3 * LIVE_TURN_MS), loopArmed: true };
    expect(activityLiveness(wedged, NOW)).toBe('stale');
    expect(activityLivenessTitle(wedged, NOW)).toBe(
      'stale — no turn in over 10m (loop armed but not firing)',
    );
  });

  it('mentions an armed loop in the live/idle titles', () => {
    expect(activityLivenessTitle({ lastActiveAt: agoIso(1_000), loopArmed: true }, NOW))
      .toBe('live — took a turn in the last minute · loop armed');
    expect(activityLivenessTitle({ lastActiveAt: agoIso(LIVE_MS + 1), loopArmed: false }, NOW))
      .toBe('idle — no turn in the last minute');
  });
});

describe('fmtCompactAge', () => {
  it('renders each unit band', () => {
    expect(fmtCompactAge(agoIso(3_000), NOW)).toBe('3s');
    expect(fmtCompactAge(agoIso(2 * 60_000), NOW)).toBe('2m');
    expect(fmtCompactAge(agoIso(4 * 3_600_000), NOW)).toBe('4h');
    expect(fmtCompactAge(agoIso(2 * 86_400_000), NOW)).toBe('2d');
  });

  it('is empty for a missing/invalid timestamp and clamps clock skew to 0s', () => {
    expect(fmtCompactAge(null, NOW)).toBe('');
    expect(fmtCompactAge(undefined, NOW)).toBe('');
    expect(fmtCompactAge('nonsense', NOW)).toBe('');
    expect(fmtCompactAge(new Date(NOW + 5_000).toISOString(), NOW)).toBe('0s');
  });
});

describe('hasThinking', () => {
  it('accepts each backend handle', () => {
    expect(hasThinking({ runId: 'r1', harnessSlug: 'h' })).toBe(true);
    expect(hasThinking({ sessionId: 's1' })).toBe(true);
    expect(hasThinking({ agent: 'codex', advSessionId: 7 })).toBe(true);
    expect(hasThinking({ ompThreadId: 't1' })).toBe(true);
  });

  it('needs BOTH halves of the run handle', () => {
    expect(hasThinking({ runId: 'r1' })).toBe(false);
    expect(hasThinking({ harnessSlug: 'h' })).toBe(false);
  });

  it('is false for a presence-only row', () => {
    expect(hasThinking({})).toBe(false);
  });

  it('lets thinkingResolvable:false VETO an otherwise-present handle', () => {
    // The server resolved the transcript and found none; offering the button
    // would open an empty pane.
    expect(hasThinking({ sessionId: 's1', thinkingResolvable: false })).toBe(false);
  });
});

describe('isAgentThinking', () => {
  it('counts silent ongoing turns independently of transcript output or stream availability', () => {
    const live = agent({ sessionState: 'live', transcriptFresh: false, thinking: false,
      thinkingResolvable: false, liveness: 'stale' });
    expect(isTranscriptFresh(live)).toBe(false);
    expect(hasThinking(live)).toBe(false);
    expect(isAgentThinking(live)).toBe(true);
  });

  it.each(['parked', 'draining', 'suspect', 'ended', 'recorded', null, undefined])(
    'does not label %s as thinking even with fresh output and an armed loop', (sessionState) => {
      expect(isAgentThinking(agent({ sessionState, transcriptFresh: true, thinking: true,
        loopArmed: true, liveness: 'live' }))).toBe(false);
    },
  );
});

describe('thinkingStreamUrl', () => {
  it('prefers the run-log leg', () => {
    expect(thinkingStreamUrl({ runId: 'r 1', harnessSlug: 'h/x', sessionId: 's' }))
      .toBe('/api/harness/h%2Fx/agents/r%201/stream?phase=staging');
  });

  it('routes a codex row by its session-row id, NOT the claude leg', () => {
    // A codex row commonly carries a rollout uuid in sessionId; a sessionId-first
    // order would send it to a resolver that cannot resolve it — an empty pane.
    expect(thinkingStreamUrl({ agent: 'codex', advSessionId: 42, sessionId: 'rollout-uuid' }))
      .toBe('/api/adv/session/thinking?codexSessionKey=42');
  });

  it('carries the per-session omp home key when present', () => {
    expect(thinkingStreamUrl({ ompThreadId: 't1', advSessionId: 9 }))
      .toBe('/api/adv/session/thinking?ompThreadId=t1&ompSessionKey=9');
    expect(thinkingStreamUrl({ ompThreadId: 't1' }))
      .toBe('/api/adv/session/thinking?ompThreadId=t1');
  });

  it('hints the owner, and passes ended=1 only when the server said unresolvable', () => {
    expect(thinkingStreamUrl({ sessionId: 's1', ownerId: 'su-1' }))
      .toBe('/api/adv/session/thinking?sessionId=s1&owner=su-1');
    expect(thinkingStreamUrl({ sessionId: 's1', ownerId: 'su-1', thinkingResolvable: false }))
      .toBe('/api/adv/session/thinking?sessionId=s1&owner=su-1&ended=1');
    // Omitted (not `ended=0`) when resolvable — absence means "don't know".
    expect(thinkingStreamUrl({ sessionId: 's1', thinkingResolvable: true }))
      .toBe('/api/adv/session/thinking?sessionId=s1');
  });

  it('returns null when no handle resolves', () => {
    expect(thinkingStreamUrl({})).toBeNull();
  });

  it('defaults basePath to "" so the operator URLs are unchanged, and prefixes a cross-origin host', () => {
    expect(thinkingStreamUrl({ sessionId: 's1' })).toBe('/api/adv/session/thinking?sessionId=s1');
    expect(thinkingStreamUrl({ sessionId: 's1' }, { basePath: 'https://op.example' }))
      .toBe('https://op.example/api/adv/session/thinking?sessionId=s1');
    expect(thinkingStreamUrl({ runId: 'r', harnessSlug: 'h' }, { basePath: 'https://op.example' }))
      .toBe('https://op.example/api/harness/h/agents/r/stream?phase=staging');
  });
});

describe('session action availability', () => {
  it('canFocusWindow needs a windowId or a session-row id — a pid alone is not enough', () => {
    expect(canFocusWindow({ windowId: '0x1', advSessionId: null })).toBe(true);
    expect(canFocusWindow({ windowId: null, advSessionId: 5 })).toBe(true);
    expect(canFocusWindow({ windowId: null, advSessionId: null })).toBe(false);
  });

  it('resumableSessionId excludes codex and prefers the native session id', () => {
    expect(resumableSessionId({ agent: 'codex', sessionId: 's', ompThreadId: 't' })).toBeNull();
    expect(resumableSessionId({ agent: 'claude', sessionId: 's', ompThreadId: 't' })).toBe('s');
    expect(resumableSessionId({ agent: 'omp', sessionId: null, ompThreadId: 't' })).toBe('t');
    expect(resumableSessionId({ agent: 'claude', sessionId: null, ompThreadId: null })).toBeNull();
  });

  it('canForkSession is claude-only', () => {
    expect(canForkSession({ agent: 'claude' })).toBe(true);
    expect(canForkSession({ agent: 'omp' })).toBe(false);
    expect(canForkSession({ agent: 'codex' })).toBe(false);
  });
});

describe('machine grouping', () => {
  it('buckets an unlabeled local row separately from an unlabeled remote one', () => {
    expect(machineKey({ machineLabel: null, isLocal: true })).toBe('__local__');
    expect(machineKey({ machineLabel: null, isLocal: false })).toBe('__remote__');
    expect(machineKey({ machineLabel: 'box-2', isLocal: false })).toBe('box-2');
    expect(distinctMachineCount([
      { machineLabel: null, isLocal: true },
      { machineLabel: null, isLocal: false },
      { machineLabel: 'box-2', isLocal: false },
      { machineLabel: 'box-2', isLocal: false },
    ])).toBe(3);
  });

  it('orders tabs local-first then alphabetically, with per-machine counts', () => {
    const tabs = machineTabs([
      agent({ ownerId: '1', machineLabel: 'zeta', isLocal: false }),
      agent({ ownerId: '2', machineLabel: 'beta', isLocal: false }),
      agent({ ownerId: '3', isLocal: true }),
      agent({ ownerId: '4', machineLabel: 'zeta', isLocal: false }),
    ]);
    expect(tabs.map((t) => [t.label, t.count])).toEqual([['Local', 1], ['beta', 1], ['zeta', 2]]);
    expect(tabs[0].isLocal).toBe(true);
  });

  it('produces at most one tab for a single-machine roster (the caller then hides the bar)', () => {
    expect(machineTabs([agent({ ownerId: '1' }), agent({ ownerId: '2' })])).toHaveLength(1);
    expect(machineTabs([])).toHaveLength(0);
  });
});

describe('naming', () => {
  it('shortOwner keeps a recognizable prefix and truncates a long opaque id', () => {
    expect(shortOwner('su-5577c5df-1111-2222-3333-444444444444')).toBe('su-5577c5df');
    expect(shortOwner('short')).toBe('short');
    expect(shortOwner('X'.repeat(40))).toBe(`${'X'.repeat(15)}…`);
  });

  it('displayName prefers the human label and NEVER the backend type', () => {
    expect(displayName({ label: 'Ada', ownerId: 'su-1234abcd' })).toBe('Ada');
    expect(displayName({ label: '   ', ownerId: 'su-1234abcd-x' })).toBe('su-1234abcd');
  });

  it('routes the stored label through the host normalizer when one is given', () => {
    expect(displayName({ label: 'queen', ownerId: 'o' }, (raw) => raw.toUpperCase())).toBe('QUEEN');
    // A host without a lexicon keeps the label exactly as stored.
    expect(displayName({ label: 'queen', ownerId: 'o' })).toBe('queen');
    // The normalizer applies to the LABEL only — an id fallback is not a label.
    expect(displayName({ label: '', ownerId: 'su-1234abcd' }, () => 'NEVER')).toBe('su-1234abcd');
  });
});

describe('agentGlyph', () => {
  it('resolves both generations of pane-kind id to the same glyph', () => {
    expect(agentGlyph({ agentPaneKind: 'mug', role: null })).toBe('☕');
    expect(agentGlyph({ agentPaneKind: 'queen', role: null })).toBe('☕');
    expect(agentGlyph({ agentPaneKind: 'cup', role: null })).toBe('🍵');
    expect(agentGlyph({ agentPaneKind: 'bee', role: null })).toBe('🍵');
  });

  it('falls back to role, then to a neutral dot', () => {
    expect(agentGlyph({ agentPaneKind: null, role: 'SU' })).toBe('🛠');
    expect(agentGlyph({ agentPaneKind: null, role: 'nonesuch' })).toBe('·');
    expect(agentGlyph({ agentPaneKind: null, role: null })).toBe('·');
  });
});

describe('isRunningAgent / isTranscriptFresh', () => {
  it.each(['live', 'parked', 'recorded'])('counts living %s sessions independently of heartbeat and loops', (sessionState) => {
    expect(isRunningAgent({ sessionState, liveness: 'stale', loopArmed: false })).toBe(true);
  });

  it.each(['draining', 'suspect', 'ended', 'unknown', null])('does not count %s verdicts as living sessions', (sessionState) => {
    expect(isRunningAgent({ sessionState, liveness: 'live', loopArmed: true })).toBe(false);
  });

  it('retains a loop-armed agent whose presence heartbeat went stale', () => {
    expect(isRunningAgent({ liveness: 'stale', loopArmed: true })).toBe(true);
    expect(isRunningAgent({ liveness: 'stale', loopArmed: false })).toBe(false);
    expect(isRunningAgent({ liveness: 'idle', loopArmed: false })).toBe(true);
  });

  it('falls back to the deprecated `thinking` alias only when transcriptFresh is absent', () => {
    expect(isTranscriptFresh({ transcriptFresh: false, thinking: true })).toBe(false);
    expect(isTranscriptFresh({ transcriptFresh: null, thinking: true })).toBe(true);
    expect(isTranscriptFresh({ transcriptFresh: null, thinking: null })).toBe(false);
  });
});

describe('filterRoster', () => {
  const roster = [
    agent({ ownerId: 'su-aaaa1111', label: 'Ada', intent: 'extracting the roster' }),
    agent({ ownerId: 'su-bbbb2222', label: 'Grace', feature: 'WI-99', currentPlanSlug: 'portal-bar' }),
    agent({ ownerId: 'su-cccc3333', label: 'Linus', fleetSlug: 'compilers', machineLabel: 'box-2' }),
  ];

  it('returns the input UNCHANGED (same identity) for a blank query', () => {
    expect(filterRoster(roster, '')).toBe(roster);
    expect(filterRoster(roster, '   ')).toBe(roster);
  });

  it('matches name, owner id, intent, work-item, plan, fleet and machine, case-insensitively', () => {
    expect(filterRoster(roster, 'ada').map((a) => a.ownerId)).toEqual(['su-aaaa1111']);
    expect(filterRoster(roster, 'BBBB').map((a) => a.ownerId)).toEqual(['su-bbbb2222']);
    expect(filterRoster(roster, 'roster').map((a) => a.ownerId)).toEqual(['su-aaaa1111']);
    expect(filterRoster(roster, 'wi-99').map((a) => a.ownerId)).toEqual(['su-bbbb2222']);
    expect(filterRoster(roster, 'portal-bar').map((a) => a.ownerId)).toEqual(['su-bbbb2222']);
    expect(filterRoster(roster, 'compilers').map((a) => a.ownerId)).toEqual(['su-cccc3333']);
    expect(filterRoster(roster, 'box-2').map((a) => a.ownerId)).toEqual(['su-cccc3333']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterRoster(roster, 'no-such-thing')).toEqual([]);
  });

  it('searches the NORMALIZED display name when a normalizer is supplied', () => {
    const upper = (raw: string) => raw.toUpperCase();
    // 'ADA' only exists post-normalization; the raw label is 'Ada'. Matching is
    // case-insensitive, so prove the seam with a normalizer that CHANGES the word.
    const renamed = filterRoster(roster, 'brain', (raw) => (raw === 'Ada' ? 'brain' : raw));
    expect(renamed.map((a) => a.ownerId)).toEqual(['su-aaaa1111']);
    expect(filterRoster(roster, 'grace', upper).map((a) => a.ownerId)).toEqual(['su-bbbb2222']);
  });
});

describe('sessionState is the authoritative verdict (WI-2142889)', () => {
  // The just-died case: a real turn seconds ago, keepalive still arriving, but the
  // shared oracle has ruled the session gone. Activity timing alone paints this
  // green for a minute and amber for ten; the oracle's verdict wins immediately.
  const justDied = { lastActiveAt: agoIso(1_000), sessionState: 'ended', loopArmed: true } as const;

  it('reads sessionState at runtime — a gone session is stale however fresh its last turn', () => {
    expect(activityLiveness(justDied, NOW)).toBe('stale');
    expect(activityLiveness({ lastActiveAt: agoIso(1_000), sessionState: 'suspect' }, NOW)).toBe('stale');
  });

  it('says WHY in the tooltip, including an orphaned armed loop', () => {
    expect(activityLivenessTitle(justDied, NOW)).toBe(
      'stale — session ended (loop armed but the session is gone)',
    );
    expect(activityLivenessTitle({ lastActiveAt: agoIso(1_000), sessionState: 'suspect' }, NOW)).toBe(
      'stale — process gone (suspect)',
    );
  });

  it('drops a gone session from the broader running roster even when loop-armed', () => {
    expect(isRunningAgent({ liveness: 'live', loopArmed: true, sessionState: 'ended' })).toBe(false);
    expect(isRunningAgent({ liveness: 'stale', loopArmed: true, sessionState: 'suspect' })).toBe(false);
  });

  it('only ever DEMOTES — live/parked/draining/recorded and an absent verdict fall through to activity timing', () => {
    // `recorded` is authoritatively ALIVE per the session log (a console agent that is
    // not coord-wakeable); treating it as gone would grey out every console agent.
    for (const sessionState of ['live', 'parked', 'draining', 'recorded', null, undefined] as const) {
      expect(isSessionGone({ sessionState })).toBe(false);
      expect(activityLiveness({ lastActiveAt: agoIso(1_000), sessionState }, NOW)).toBe('live');
      expect(activityLiveness({ lastActiveAt: agoIso(LIVE_TURN_MS + 1), sessionState }, NOW)).toBe('stale');
    }
    // An unknown future state is not a "gone" ruling either.
    expect(isSessionGone({ sessionState: 'hibernating' })).toBe(false);
    // And a stale-by-activity row is still stale with a live verdict: the oracle never PROMOTES.
    expect(activityLiveness({ lastActiveAt: null, sessionState: 'live' }, NOW)).toBe('stale');
  });
});

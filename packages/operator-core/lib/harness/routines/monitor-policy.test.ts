import { describe, expect, it, vi } from 'vitest';
import type { AgentFleetRecord } from '../../agent-fleets-store';
import type { PresenceRecord } from '../../agent-tools/coordination/presence';
import type { WorkItem } from '../../work-items';
import {
  admitMonitorArm,
  decideMonitorAdmission,
  isLiveProgressingWorkItem,
  normalizeMonitorPredicateKey,
  prepareMonitorConfig,
  type MonitorAdmissionDependencies,
  type MonitorOwnerTurnEvidence,
  type PersistedMonitorConfig,
} from './monitor-policy';

const OWNER = 'su-owner';
const NOW = Date.parse('2026-08-25T04:00:00.000Z');

function config(
  authority: PersistedMonitorConfig['authority'] = { kind: 'work-item', workItem: 'WI-42' },
): PersistedMonitorConfig {
  return {
    predicateKey: 'release:green:papercusp',
    stopCondition: 'the exact green verdict is recorded',
    noDeltaBudget: 1,
    remainingNoDeltaBudget: 1,
    authority,
  };
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-42',
    kind: 'feature',
    family: 'feature',
    harness: 'papercusp',
    title: 'drive release repair',
    summary: 'drive release repair',
    state: 'open',
    assignee: OWNER,
    takenAt: '2026-08-25T03:58:00.000Z',
    lastProgressAt: '2026-08-25T03:59:00.000Z',
    assignedBy: null,
    createdBy: null,
    severity: null,
    goalId: null,
    parent: null,
    payload: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    createdAt: '2026-08-25T03:00:00.000Z',
    updatedAt: '2026-08-25T03:59:00.000Z',
    closedAt: null,
    ...overrides,
  } as WorkItem;
}

function presence(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    ownerId: OWNER,
    ownerLabel: 'su owner',
    workspaceId: 'ws',
    source: 'codex',
    intent: 'work',
    currentPlanSlug: null,
    currentFiles: [],
    host: '',
    pid: null,
    tty: null,
    startedAt: '2026-08-25T03:00:00.000Z',
    heartbeatAt: '2026-08-25T03:59:59.000Z',
    lastActiveAt: '2026-08-25T03:59:59.000Z',
    intentDeclaredAt: null,
    agentRole: 'su',
    potSlug: 'papercusp',
    capabilityTags: [],
    compactionLimit: null,
    compactionLimitExplicit: false,
    contextTokens: null,
    contextEstimatedAt: null,
    stale: false,
    userId: null,
    revoked: false,
    ...overrides,
  } as PresenceRecord;
}

function fleet(overrides: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
  return {
    workspaceId: 'ws',
    fleetSlug: 'alpha',
    title: 'alpha',
    description: null,
    owner: OWNER,
    leaderOwnerId: OWNER,
    leaderMissingSinceMs: null,
    colorScheme: null,
    controlState: 'active',
    fleetType: 'single',
    controlReason: null,
    controlBy: null,
    controlAt: null,
    lastLaunchTransaction: null,
    controlResumeGate: null,
    controlExpiresAt: null,
    controlNoResumePath: false,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function turn(overrides: Partial<MonitorOwnerTurnEvidence> = {}): MonitorOwnerTurnEvidence {
  return {
    ref: 'session_turn:codex:abc12345:7',
    found: true,
    checked: true,
    ownerId: OWNER,
    speaker: 'user',
    verdict: 'owner-typed',
    origin: null,
    quoteMatch: true,
    ...overrides,
  };
}

describe('monitor policy — normalization and bounded state', () => {
  it('canonicalizes predicate identity and installs the one-wake default budget', () => {
    const prepared = prepareMonitorConfig({
      predicateKey: '  Release:GREEN:Papercusp  ',
      stopCondition: '  exact green   verdict exists ',
      authority: { kind: 'work-item', workItem: 'wi-42' },
    });
    expect(prepared).toEqual({
      allowed: true,
      config: {
        predicateKey: 'release:green:papercusp',
        stopCondition: 'exact green verdict exists',
        noDeltaBudget: 1,
        remainingNoDeltaBudget: 1,
        authority: { kind: 'work-item', workItem: 'WI-42' },
      },
    });
    expect(normalizeMonitorPredicateKey(' RELEASE:GREEN:Papercusp ')).toBe('release:green:papercusp');
  });

  it('rejects an unbounded/excessive no-delta budget', () => {
    expect(
      prepareMonitorConfig({
        predicateKey: 'p',
        stopCondition: 's',
        noDeltaBudget: 101,
        authority: { kind: 'work-item', workItem: 'WI-42' },
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_config_invalid' });
  });
});

describe('monitor policy — pure authority and duplicate-owner decisions', () => {
  it('admits an existing nonterminal work-item already held by the owner', () => {
    expect(
      decideMonitorAdmission({ ownerId: OWNER, config: config(), evidence: { workItem: item() }, nowMs: NOW }),
    ).toEqual({ allowed: true, config: config() });
  });

  it('rejects terminal work authority and a progressing live peer holder', () => {
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: config(),
        evidence: { workItem: item({ state: 'done' }) },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_work_item_terminal' });

    const peerItem = item({ assignee: 'su-peer' });
    expect(isLiveProgressingWorkItem(peerItem, presence({ ownerId: 'su-peer' }), NOW)).toBe(true);
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: config(),
        evidence: {
          workItem: peerItem,
          workItemHolderPresence: presence({ ownerId: 'su-peer' }),
        },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_peer_owned_progress' });
  });

  it('admits only a live durable fleet leader', () => {
    const fleetConfig = config({ kind: 'fleet-leader', fleet: 'alpha' });
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: fleetConfig,
        evidence: { fleet: fleet(), ownerPresence: presence() },
        nowMs: NOW,
      }),
    ).toEqual({ allowed: true, config: fleetConfig });
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: fleetConfig,
        evidence: { fleet: fleet({ leaderOwnerId: 'su-peer' }), ownerPresence: presence() },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_fleet_not_led' });
  });

  it('requires an owner-candidate verdict and an exact matching quote', () => {
    const ownerConfig = config({
      kind: 'owner-turn',
      turnRef: 'session_turn:codex:abc12345:7',
      quote: 'keep watching until the release is green',
    });
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: ownerConfig,
        evidence: { ownerTurn: turn() },
        nowMs: NOW,
      }),
    ).toEqual({ allowed: true, config: ownerConfig });
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: ownerConfig,
        evidence: { ownerTurn: turn({ verdict: 'agent-injected', origin: 'loop-fire' }) },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_owner_turn_not_owner' });
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: ownerConfig,
        evidence: { ownerTurn: turn({ quoteMatch: false }) },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_owner_quote_mismatch' });
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: ownerConfig,
        evidence: { ownerTurn: turn({ ownerId: 'su-other-owner' }) },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_owner_turn_not_owner' });
  });

  it.each([
    ['agent-authored loop replay', 'agent-injected', 'loop-fire'],
    ['inherited carry replay', 'agent-injected', 'carry-respawn'],
    ['machine-authored surface', 'machine-surface', null],
    ['synthetic fixture turn', 'synthetic', null],
  ] as const)('rejects %s as owner-turn authority', (_label, verdict, origin) => {
    const ownerConfig = config({
      kind: 'owner-turn',
      turnRef: 'session_turn:codex:abc12345:7',
      quote: 'keep watching until the release is green',
    });
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: ownerConfig,
        evidence: { ownerTurn: turn({ verdict, origin }) },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_owner_turn_not_owner' });
  });

  it('rejects a live peer monitor with the same normalized predicate', () => {
    expect(
      decideMonitorAdmission({
        ownerId: OWNER,
        config: config(),
        evidence: { workItem: item(), duplicateLiveOwnerId: 'su-peer' },
        nowMs: NOW,
      }),
    ).toMatchObject({ allowed: false, code: 'monitor_duplicate_live_owner' });
  });
});

describe('monitor policy — resolved admission', () => {
  function deps(overrides: Partial<MonitorAdmissionDependencies> = {}): MonitorAdmissionDependencies {
    return {
      loadWorkItem: vi.fn(async () => item()),
      loadPresence: vi.fn(async (ownerId) => presence({ ownerId })),
      loadFleet: vi.fn(async () => fleet()),
      verifyOwnerTurn: vi.fn(async () => turn()),
      listActiveMonitorOwners: vi.fn(async () => []),
      nowMs: () => NOW,
      ...overrides,
    };
  }

  it('rejects malformed owner refs before any routine mutation can be reached', async () => {
    const out = await admitMonitorArm(
      {
        ownerId: OWNER,
        workspaceId: 'ws',
        harness: 'papercusp',
        monitor: {
          predicateKey: 'p',
          stopCondition: 's',
          authority: { kind: 'owner-turn', turnRef: 'not-a-session-turn-ref', quote: 'watch it' },
        },
      },
      deps(),
    );
    expect(out).toMatchObject({ allowed: false, code: 'monitor_owner_turn_invalid' });
  });

  it('fails closed when an authority read throws', async () => {
    const out = await admitMonitorArm(
      {
        ownerId: OWNER,
        workspaceId: 'ws',
        harness: 'papercusp',
        monitor: {
          predicateKey: 'p',
          stopCondition: 's',
          authority: { kind: 'work-item', workItem: 'WI-42' },
        },
      },
      deps({
        loadWorkItem: vi.fn(async () => {
          throw new Error('db unavailable');
        }),
      }),
    );
    expect(out).toMatchObject({ allowed: false, code: 'monitor_admission_unavailable' });
  });
});

import { describe, expect, it } from 'vitest';
import leaderBriefTool from './leader-brief';
import { compactCampaign, LEADER_BRIEF_SHAPER_BUDGET_CHARS, shapeLeaderBrief } from './leader-brief-shape';
import { projectFleetHeadcountState } from '../../agent-fleets-store';

describe('parked capacity delivery', () => {
  it('preserves eligible and unread member identities under emergency pressure', () => {
    const base = largeBrief();
    const out = shapeLeaderBrief({ ...base, summary: { ...base.summary,
      parkedCapacityAlert: true,
      parked_capacity: { population: 'current runnable members', eligible: ['spare'], unknown: ['unread'], protected: [], atCapacity: [], noWork: [] },
    } }, 'trimmed') as Record<string, any>;
    expect(out.summary).toMatchObject({ parkedCapacityAlert: true, parked_capacity: { eligible: ['spare'], unknown: ['unread'], eligibleCount: 1, unknownCount: 1 } });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });
  it('keeps actionable identities and unknown admission distinct through monitor shaping', () => {
    const out = shapeLeaderBrief({ ok: true,
      summary: { parkedCapacityAlert: true, parked_capacity: { population: 'current runnable members', eligible: ['spare'], unknown: ['unread'], protected: ['owner-only'], atCapacity: ['capped'], noWork: ['restricted'] } },
      members: [{ agentId: 'spare', parkedCapacity: { status: 'eligible', claimable: 3, activeClaims: 0, maxConcurrentClaims: 2, heldIds: [], blockerParkedIds: ['WI-blocked'], specRef: 'override@4', recoverVia: 'Resume managed pull and retain blocker wake.' } }],
    }, 'trimmed') as Record<string, any>;
    expect(out.summary).toMatchObject({ parkedCapacityAlert: true, parked_capacity: { eligibleCount: 1, eligible: ['spare'], unknownCount: 1, unknown: ['unread'], protected: ['owner-only'], atCapacity: ['capped'], noWork: ['restricted'] } });
    expect(out.members[0].parkedCapacity).toMatchObject({ status: 'eligible', specRef: 'override@4', blockerParkedIds: ['WI-blocked'], maxConcurrentClaims: 2 });
  });
});

describe('claimability supervision delivery', () => {
  it.each([false, true])('retains degraded queue supervision and its recovery read under emergency pressure=%s', (emergency) => {
    const base = emergency ? largeBrief() : { ok: true, summary: { fleet: 'alpha', members: 2 } };
    const supervision = {
      status: 'degraded', fleet: 'alpha', harness: 'papercusp', value: null,
      reason: 'The claimability diagnostic did not settle.',
      recoverVia: 'work_items:claimable { harness:"papercusp", spec:"alpha", breakdownOnly:true }',
    };
    const out = shapeLeaderBrief({
      ...base,
      summary: { ...base.summary, claimability_supervision: supervision, claimabilitySupervisionDegraded: true },
    }, 'trimmed') as Record<string, any>;
    expect(out.summary.claimabilitySupervisionDegraded).toBe(true);
    expect(out.summary.claimability_supervision).toMatchObject({
      status: 'degraded', fleet: 'alpha', value: null, recoverVia: supervision.recoverVia,
    });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });
});

describe('member directive actuation delivery (P-030)', () => {
  it('preserves the selected member and actuation summary through emergency shaping', () => {
    const directiveActuation = {
      total: 1,
      satisfied: 0,
      notYet: 1,
      unprovable: 0,
      outstanding: ['✗ NOT ACTED ON — expected `checkpoint` on EI-26022616555506152: no checkpoint receipt yet'],
    };
    const input = largeBrief() as Record<string, any>;
    input.memberOwnerId = 'su-52';
    input.members[52].directiveActuation = directiveActuation;
    input.admissionBlocked = [{
      itemId: 'EI-1', member: 'su-01', specId: 'fleet-spec', specRevision: 1,
      code: 'fleet_scope_violation', occurrences: 1, action: 'revise-spec', reason: 'Member excluded.',
    }];

    const out = shapeLeaderBrief(input, 'trimmed') as Record<string, any>;

    expect(out.leaderBriefProjection.emergency).toBe(true);
    expect(out).toMatchObject({
      memberOwnerId: 'su-52',
      members: [{ agentId: 'su-52', directiveActuation }],
    });
  });
});

describe('leader checkpoint progress delivery (P-005)', () => {
  it('keeps source identity, unknown state and truncation/recovery markers in the default tier', () => {
    const recovery = { tool: 'work_items:get', args: { id: 'WI-A', harness: 'fixture' } };
    const out = shapeLeaderBrief({
      ok: true,
      members: [{
        agentId: 'owner',
        checkpointProgress: {
          status: 'unknown', source: 'work_items:checkpoint', snapshotOnly: true, readAtMs: 100,
          rosterItems: 3, omitted: 1, note: 'Snapshot only; full-item checks/walls remain binding.',
          items: [{
            id: 'WI-A', harness: 'fixture', holderProof: { ownerId: 'owner', workspaceId: 'ws' },
            status: 'stored', checkpoint: 'x'.repeat(700), checkpointUpdatedAtMs: 90,
            checkpointContentHash: 'full-note-hash', checkpointTruncated: false, recovery,
            freshness: { basis: 'relative-activity', stale: true, lagMs: 360_000, reason: 'Verify later work.' },
          }, {
            id: 'WI-B', status: 'unknown', checkpoint: null, checkpointTruncated: false,
          }],
        },
      }],
    }, 'trimmed') as Record<string, any>;
    const progress = out.members[0].checkpointProgress;
    expect(progress).toMatchObject({
      status: 'unknown', source: 'work_items:checkpoint', snapshotOnly: true,
      omitted: 1, itemsOmittedByProjection: 1,
    });
    expect(progress.items[0]).toMatchObject({
      id: 'WI-A', checkpointContentHash: 'full-note-hash', checkpointTruncated: true,
      checkpointUpdatedAtMs: 90, recovery,
      freshness: { basis: 'relative-activity', stale: true, lagMs: 360_000, reason: 'Verify later work.' },
    });
    expect(progress.items[0].checkpoint.length).toBeLessThanOrEqual(240);
  });

  it.each([false, true])('emergency delivery preserves freshness unless admission blocks consume the member slot: %s', (admissionBlocked) => {
    const input = largeBrief();
    (input as Record<string, unknown>).admissionBlocked = admissionBlocked
      ? [{ itemId: 'WI-blocked', member: 'owner', code: 'fleet_scope_violation' }]
      : [];
    const freshness = { basis: 'declared', verdict: 'recomputed', declared: 2, changed: 0, unresolvable: 1 };
    (input.members[0] as Record<string, unknown>).checkpointProgress = {
      status: 'read', source: 'work_items:checkpoint', snapshotOnly: true, readAtMs: 100,
      rosterItems: 1, omitted: 0,
      items: [{
        id: 'WI-A', harness: 'fixture', status: 'stored', checkpoint: 'Next: verify.',
        checkpointContentHash: 'source-hash', freshness,
        recovery: { tool: 'work_items:get', args: { id: 'WI-A', harness: 'fixture' } },
      }],
    };
    const out = shapeLeaderBrief(input, 'trimmed') as Record<string, any>;
    expect(out.leaderBriefProjection.emergency).toBe(true);
    if (!admissionBlocked) {
      expect(out.members).toHaveLength(1);
      expect(out.members[0].checkpointProgress.items[0].freshness).toEqual(freshness);
      expect(out.members[0].checkpointProgress.snapshotOnly).toBe(true);
    } else {
      expect(out.members).toEqual([]);
      expect(out.membersTruncated).toMatchObject({ shown: 0, total: 53 });
    }
  });
});

describe('leader plan history delivery', () => {
  const recovery = { tool: 'plans:get', args: { slug: 'history', harness: 'papercusp', heading: 'History' } };
  const planHistory = {
    status: 'available',
    recovery,
    brief: {
      fingerprint: 'history-2',
      authority: [],
      attempts: [{ authority: 'checkpoint', rawRef: 'WI-1#checkpoint', text: 'Root cause: child lesson.' }],
      fanOut: { admitted: 1, total: 1, cap: 24, truncated: false },
      omission: { truncated: false },
    },
  };
  it('retains a child lesson, generation and exact recovery in the final lean sink', () => {
    const result = shapeLeaderBrief({ ok: true, planHistory }, 'trimmed');
    expect(JSON.stringify(result)).toContain('Root cause: child lesson');
    expect(result).toMatchObject({ planHistory: { status: 'available', fingerprint: 'history-2', recovery } });
  });
  it('keeps recovery under pressure and unknown scope explicit', () => {
    const result = shapeLeaderBrief({ ...largeBrief(), planHistory: { ...planHistory, status: 'unknown' } }, 'trimmed');
    expect(result).toMatchObject({ planHistory: { status: 'unknown', recovery } });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });
});

function largeBrief() {
  const members = Array.from({ length: 53 }, (_, index) => ({
    agentId: `su-${String(index).padStart(2, '0')}`,
    verdict: index % 2 === 0 ? 'monitoring' : 'speaking',
    idleCause: index % 2 === 0 ? 'genuinely-idle' : 'working',
    intent: 'x'.repeat(1000),
    doing: { id: `EI-${index}`, title: 'large diagnostic title '.repeat(20), status: 'open' },
    benchSuggestion: { kind: 'laneless-idle', reason: 'x'.repeat(500) },
  }));
  return {
    ok: true,
    blockedAt: {
      layer: 'members',
      reason: '22 members are idle'.repeat(20),
      remedy: 'wake the members'.repeat(20),
      subordinate: members,
      falsifier: { tool: 'work_items:claimable', check: 'x'.repeat(500), kills: 'y'.repeat(500) },
    },
    summary: {
      fleet: 'large-fleet',
      members: members.length,
      dead: 2,
      dead_member_ids: ['su-51', 'su-52'],
      stalled: 3,
      cumulative: { admission_blocked: 4 },
      claimable_now: {
        value: 1432,
        population: {
          kind: 'fleet-claim-spec',
          fleet: 'large-fleet',
          harness: 'papercusp',
          spec: {
            ref: 'large-fleet@7',
            revision: 7,
            matchedBy: 'fleet',
            assigneeScoped: null,
          },
          basis: 'issue+feature-family',
          matchedByFilter: 1432,
          note: 'the fleet claim-spec population',
        },
      },
      population: { candidates: 63, counted: 53, withheld: 10, basis: 'x'.repeat(1000) },
      populationLifecycle: {
        schemaVersion: 'fleet-population-lifecycle-v1',
        fleet: 'large-fleet',
        window: { startAt: '2026-08-13T00:00:00.000Z', endAt: '2026-08-26T20:00:00.000Z' },
        populationBasis: {
          writer: 'fleet-roster',
          comparisonRule: 'compare only identical population, window, and unit',
        },
        currentRunnableRoster: {
          census: {
            population: 'current-runnable-roster',
            candidates: 63,
            counted: 53,
            withheld: 10,
            basis: 'runnable roster',
          },
          ownerIds: members.map((member) => member.agentId),
        },
        relevantRoster: {
          census: {
            population: 'relevant-roster',
            candidates: 63,
            counted: 53,
            withheld: 10,
            basis: 'relevant roster',
          },
          ownerIds: members.map((member) => member.agentId),
        },
        everMembers: { counted: 53, ownerIds: members.map((member) => member.agentId) },
        membersLost: {
          population: 'ever-members-absent-from-roster',
          basis: 'x'.repeat(300),
          writer: 'harness_shared.fleet_membership_events',
          available: true,
          count: 9,
          ownerIds: ['lost-1', 'lost-2', 'lost-3', 'lost-4', 'lost-5', 'lost-6', 'lost-7', 'lost-8', 'lost-9'],
          timing: { status: 'not-measured', reason: 'y'.repeat(300), insteadRead: 'z'.repeat(120) },
        },
        target: { enabled: true, target: 53, current: 53, shortfall: 0, underStrength: false, verdict: 'at-target' },
        liveness: { live: 25, parked: 28, dead: 0, suspect: 0, draining: 0, recorded: 0, unknown: 0 },
        claimFlow: { status: 'unknown', values: null, reason: 'claim-flow-unread' },
      },
      pool_capacity: { poolExhausted: false, degraded: false, factor: 1, queueDepth: 0 },
    },
    monitoringBlindAdvisory: {
      line: 'You are monitoring blind: 1/4 required fleet transition event key(s) have live_awaiters:0.',
      missingEventKeys: ['fleet:drained:large-fleet'],
      arm: {
        tool: 'events:await',
        args: {
          event: '@fleet:large-fleet',
          note: 'Restore a pushed transition wake; leader control repairs the durable watches.',
        },
      },
    },
    memberVerdicts: members,
    members,
    unownedCriticals: members,
    customInvariants: members,
    announcedGates: Array.from({ length: 12 }, (_, index) => ({
      event: `fleet:large-fleet:gate-${index}`,
      note: 'gate note '.repeat(80),
      scope: 'fleet:large-fleet',
      announcedBy: `su-${index}`,
      fired: index % 2 === 0,
      firedAt: index % 2 === 0 ? '2026-08-26T20:00:00.000Z' : null,
      awaiters: index,
    })),
    specFilter: { nested: 'x'.repeat(2000) },
    idleCauses: { 'genuinely-idle': 22 },
    strandedFleetAlertReason: 'x'.repeat(1000),
    strandedFleetAlertFalsifier: { tool: 'fleet:capacity', check: 'x'.repeat(1000) },
    campaign: {
      boundary: { at: '2026-08-13T00:00:00.000Z', source: 'fleet-created-at' },
      everMembers: { available: true, count: 53, writer: 'harness_shared.fleet_membership_events' },
      axes: Object.fromEntries(
        ['membership', 'speaking', 'claims', 'terminals', 'issues', 'gateEvents', 'jobs', 'corrections'].map((name) => [
          name,
          {
            available: true,
            writer: `writer:${name}`,
            units: { total: 'exact rows from the authoritative writer' },
            cap: { aggregates: 'none', recentRows: 12 },
            data: { total: 53, recent: { total: 53, shown: 12, truncated: true, rows: members.slice(0, 12) } },
          },
        ]),
      ),
    },
  };
}

// P-007 / R-17: the silent members `headcount.current` excluded must survive shaping.
describe('leader-brief shaping keeps silentMembers', () => {
  it('keeps measured silent members on every tier, capping the id list at 8', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `su-quiet-${i}`);
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeLeaderBrief(
        {
          ok: true,
          summary: {
            fleet: 'f',
            silentMembers: { status: 'measured', ownerIds: ids, thresholdMs: 1_200_000, paused: false },
          },
        },
        tier,
      ) as Record<string, any>;
      expect(out.summary.silentMembers).toEqual({
        status: 'measured',
        ownerIds: ids.slice(0, 8),
        ownerIdsTruncated: 10,
        thresholdMs: 1_200_000,
        paused: false,
      });
    }
  });

  it('keeps an unknown silent-member read with its reason instead of dropping it', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'f', silentMembers: { status: 'unknown', reason: 'execution or await leg unreadable' } },
      },
      'trimmed',
    ) as Record<string, any>;
    expect(out.summary.silentMembers).toEqual({ status: 'unknown', reason: 'execution or await leg unreadable' });
  });
});

describe('fleet:leader-brief payload projection (EI-20243661938229668)', () => {
  it('keeps the owner-directive root distinct and strips diagnostic targetRef from its action', () => {
    const out = shapeLeaderBrief({
      ok: true,
      ownerDirectives: {
        schemaVersion: 'agent-obligations-v1',
        evaluatedAt: '2026-09-21T20:00:00.000Z',
        sourceGeneration: 'agenda-1',
        state: 'known',
        directives: [{
          id: 'obl:owner-directive:1',
          status: 'due',
          title: 'Owner directive #27',
          priority: 'critical',
          applicableDemand: 1,
          action: {
            kind: 'repair',
            summary: 'close it',
            tool: 'orders:disposition',
            targetRef: 'internal-provider-symbol',
            recoveryRef: 'orders:get #27',
          },
          authority: { kind: 'owner-candidate', sourceRef: 'owner-directive:27', turnOrigin: 'unknown' },
          evidence: [],
        }],
        projection: {
          text: '- [DUE] Owner directive #27 — close it; full: orders:get #27',
          receipt: { sink: 'fleet:leader-brief:owner-directives', mode: 'truncate', entriesAvailable: 1, entriesDelivered: 1, entriesOmitted: 0, bodyDeliveredChars: 60, estimatedTokens: 15, bodyTruncated: false, refused: false },
        },
        detailRef: 'fleet:leader-brief { payloadTier:"full" }',
        read: { elapsedMs: 2, degradedSources: [] },
      },
    }, 'trimmed') as Record<string, any>;
    expect(out.ownerDirectives).toMatchObject({
      state: 'known',
      directives: [{ action: { tool: 'orders:disposition', recoveryRef: 'orders:get #27' } }],
    });
    expect(out.ownerDirectives.directives[0].action).not.toHaveProperty('targetRef');
  });

  it('preserves degraded roster status beside a zero-member fallback', () => {
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeLeaderBrief(
        {
          ok: true,
          degraded: true,
          degradedLegs: ['roster.presence'],
          summary: {
            fleet: 'fleet-a',
            members: 0,
            degraded_roster_legs: ['presence'],
          },
        },
        tier,
      ) as Record<string, any>;
      expect(out).toMatchObject({
        ok: true,
        degraded: true,
        degradedLegs: ['roster.presence'],
        summary: { members: 0 },
      });
    }
  });

  it('keeps degraded roster status in the emergency projection', () => {
    const input = largeBrief() as Record<string, any>;
    input.degraded = true;
    input.degradedLegs = ['roster.presence'];
    const out = shapeLeaderBrief(input, 'trimmed') as Record<string, any>;
    expect(out.leaderBriefProjection.emergency).toBe(true);
    expect(out).toMatchObject({ degraded: true, degradedLegs: ['roster.presence'] });
  });

  it('preserves an unavailable admission-block count as null through every bounded tier', () => {
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeLeaderBrief(
        { ok: true, summary: { fleet: 'fleet-a', cumulative: { admission_blocked: null } } },
        tier,
      ) as { summary: { cumulative: { admission_blocked: number | null } } };
      expect(out.summary.cumulative.admission_blocked).toBeNull();
    }
  });

  it('keeps a canonical fleet-metrics unavailable result and recovery path atomically', () => {
    const fleetMetrics = {
      ok: false,
      schemaVersion: 'fleet-metrics-v1',
      error: 'fleet_metrics_unavailable',
      reason: 'source capped',
      recoverVia: 'work_items:burn_down { window: "fleet-lifetime" }',
      requested: {
        fleet: 'large-fleet',
        harness: 'papercusp',
        flowMode: 'current-spec',
        window: 'fleet-lifetime',
      },
    };
    const out = shapeLeaderBrief({ ok: true, summary: { fleet: 'large-fleet' }, fleetMetrics }, 'trimmed') as Record<
      string,
      unknown
    >;
    expect(out.fleetMetrics).toEqual(fleetMetrics);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });

  it('keeps the shared obligation action core, omission receipt, and detail reference', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'large-fleet' },
        agentObligations: {
          schemaVersion: 'agent-obligations-v1',
          evaluatedAt: '2026-09-05T20:00:00.000Z',
          sourceGeneration: 'agenda-1',
          primary: [
            {
              id: 'obl:owner-report:1',
              ruleRevision: 'goal-owner-report-v1',
              sourceGeneration: 'goal-source-42',
              family: 'owner-report',
              status: 'due',
              title: 'Owner report is due',
              applicableDemand: 1,
              action: { kind: 'report', summary: 'send the owner report now', tool: 'coord:send', recoveryRef: 'coord:orient' },
            },
          ],
          projection: {
            text: '- [DUE] Owner report is due — send it now',
            receipt: {
              sink: 'fleet:leader-brief',
              entriesAvailable: 4,
              entriesDelivered: 1,
              entriesOmitted: 3,
              estimatedTokens: 11,
              bodyTruncated: true,
              refused: false,
            },
          },
          detailRef: 'fleet:leader-brief { payloadTier:"full" }',
          read: { elapsedMs: 12, degradedSources: [] },
        },
      },
      'trimmed',
    ) as Record<string, any>;

    expect(out.agentObligations).toMatchObject({
      sourceGeneration: 'agenda-1',
      primary: [{ family: 'owner-report', status: 'due', ruleRevision: 'goal-owner-report-v1',
        sourceGeneration: 'goal-source-42', action: { kind: 'report', tool: 'coord:send', recoveryRef: 'coord:orient' } }],
      projection: { receipt: { entriesAvailable: 4, entriesDelivered: 1, entriesOmitted: 3, bodyTruncated: true } },
      detailRef: 'fleet:leader-brief { payloadTier:"full" }',
      read: { elapsedMs: 12, degradedSources: [] },
    });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });

  it('does not retain a delivery receipt for an action cut by the final shaper', () => {
    const first = '- [DUE] First action ' + 'a'.repeat(390);
    const second = '- [DUE] Second action ' + 'b'.repeat(390);
    const out = shapeLeaderBrief({ ok: true, summary: { fleet: 'goal-fleet' }, agentObligations: {
      sourceGeneration: 'generation-1', primary: [], detailRef: 'fleet:leader-brief { payloadTier:"full" }',
      projection: { text: `${first}\n${second}`, receipt: {
        sink: 'fleet:leader-brief', mode: 'truncate', entriesAvailable: 4, entriesDelivered: 2,
        entriesOmitted: 2, bodyDeliveredChars: first.length + second.length + 1,
        estimatedTokens: 206, bodyTruncated: true, refused: false,
      } },
    } }, 'trimmed') as { agentObligations: { projection: { text: string; receipt: Record<string, unknown> } } };
    expect(out.agentObligations.projection.text).toBe(first);
    expect(out.agentObligations.projection.receipt).toMatchObject({ entriesDelivered: 1, entriesOmitted: 3,
      bodyDeliveredChars: first.length, bodyTruncated: true, reason: 'character-cap' });
  });

  it('reports zero complete actions when the emergency tier cannot fit one', () => {
    const input = { ...largeBrief(), agentObligations: {
      sourceGeneration: 'generation-1', primary: [], detailRef: 'fleet:leader-brief { payloadTier:"full" }',
      projection: { text: '- [DUE] ' + 'x'.repeat(250), receipt: {
        sink: 'fleet:leader-brief', mode: 'truncate', entriesAvailable: 1, entriesDelivered: 1,
        entriesOmitted: 0, bodyDeliveredChars: 258, estimatedTokens: 65, bodyTruncated: false, refused: false,
      } },
    } };
    const out = shapeLeaderBrief(input, 'trimmed') as { leaderBriefProjection: { emergency: boolean };
      agentObligations: { detailRef: string; projection: { text: string; receipt: Record<string, unknown> } } };
    expect(out.leaderBriefProjection.emergency).toBe(true);
    expect(out.agentObligations.projection.text).toBe('');
    expect(out.agentObligations.projection.receipt).toMatchObject({ entriesDelivered: 0, entriesOmitted: 1,
      bodyDeliveredChars: 0, bodyTruncated: true, reason: 'character-cap' });
    expect(out.agentObligations.detailRef).toContain('payloadTier');
  });

  it('does not count a newline in a clipped reason as a complete obligation', () => {
    const out = shapeLeaderBrief({ ok: true, summary: { fleet: 'goal-fleet' }, agentObligations: {
      primary: [], detailRef: 'fleet:leader-brief { payloadTier:"full" }',
      projection: { text: '- [DUE] Act on the goal; why:\n' + 'r'.repeat(800), receipt: {
        entriesAvailable: 1, entriesDelivered: 1, entriesOmitted: 0, bodyTruncated: false,
      } },
    } }, 'trimmed') as { agentObligations: { projection: { text: string; receipt: Record<string, unknown> } } };
    expect(out.agentObligations.projection.text).toBe('');
    expect(out.agentObligations.projection.receipt).toMatchObject({ entriesDelivered: 0, entriesOmitted: 1,
      bodyDeliveredChars: 0, bodyTruncated: true });
  });

  it('declares a bounded shaper and a ceiling below the result-door envelope', () => {
    expect((leaderBriefTool as { shape?: unknown }).shape).toBeDefined();
    expect((leaderBriefTool as { payloadTierCeilingChars?: number }).payloadTierCeilingChars).toBe(
      LEADER_BRIEF_SHAPER_BUDGET_CHARS,
    );
  });

  it('declares both runtime membersTruncated representations in the result contract', () => {
    const resultSchema = (
      leaderBriefTool as unknown as {
        result: { safeParse: (value: unknown) => { success: boolean } };
      }
    ).result;
    const shaped = shapeLeaderBrief(largeBrief(), 'trimmed') as Record<string, unknown>;

    expect(shaped.membersTruncated).toMatchObject({ total: 53 });
    expect(resultSchema.safeParse(shaped).success).toBe(true);
    expect(resultSchema.safeParse({ ok: true, membersTruncated: true }).success).toBe(true);
  });

  it('P-009: keeps the member recovery block through shaping instead of silently dropping it', () => {
    // The shaper is an ALLOWLIST, and its flat leg carries scalars only. A nested object
    // added upstream reaches this point and disappears with no error anywhere — the field
    // is present on the projected row, absent from what the leader reads, and nothing
    // fails. That silent gap is what this asserts against, so it is a drop-detector, not a
    // formatting check.
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'f' },
        members: [
          {
            agentId: 'su-stranded',
            verdict: 'monitoring',
            recovery: {
              disposition: 'stranded',
              reason: 'kill_failed: scope release unverified',
              taskId: 'task-abc',
              strandedAt: '2026-09-05T01:00:00.000Z',
            },
            // CALIBRATION: an unshaped nested field, shaped exactly like `recovery` was
            // before its shaper leg existed. If this survived, the shaper would not be an
            // allowlist at all and the assertion below would prove nothing about `recovery`.
            unshapedNested: { disposition: 'stranded', reason: 'should not survive' },
          },
        ],
      },
      'trimmed',
    ) as Record<string, unknown>;

    const members = out.members as Array<Record<string, unknown>>;
    // The calibration must hold FIRST: an unshaped nested field is dropped. That is what
    // makes the surviving `recovery` below evidence of the shaper leg rather than evidence
    // that the shaper passes everything through.
    expect(members[0].unshapedNested).toBeUndefined();
    expect(members[0].recovery).toMatchObject({
      disposition: 'stranded',
      taskId: 'task-abc',
      strandedAt: '2026-09-05T01:00:00.000Z',
    });
    // The reason is the triage payload; a prefix-truncated cause is not actionable.
    expect(members[0].recovery).toMatchObject({ reason: 'kill_failed: scope release unverified' });
  });

  it('keeps the decision core and returns complete parseable JSON under the budget', () => {
    const out = shapeLeaderBrief(largeBrief(), 'trimmed') as Record<string, unknown>;
    const encoded = JSON.stringify(out);

    expect(() => JSON.parse(encoded)).not.toThrow();
    expect(encoded.length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
    expect(out.ok).toBe(true);
    expect(out.blockedAt).toMatchObject({ layer: 'members' });
    expect(out.summary).toMatchObject({
      fleet: 'large-fleet',
      members: 53,
      cumulative: { admission_blocked: 4 },
      claimable_now: {
        value: 1432,
        population: {
          kind: 'fleet-claim-spec',
          fleet: 'large-fleet',
          harness: 'papercusp',
          spec: { ref: 'large-fleet@7', revision: 7, assigneeScoped: null },
          basis: 'issue+feature-family',
        },
      },
    });
    // This oversized fixture reaches the explicit emergency tier. The ordinary
    // monitor projection preserves populationLifecycle; emergency mode reports
    // its omission through leaderBriefProjection instead of breaking 5 KB.
    expect(out.summary).not.toHaveProperty('populationLifecycle');
    expect(out.summary).toMatchObject({ dead: 2, dead_member_ids: ['su-51', 'su-52'] });
    expect(out.monitoringBlindAdvisory).toMatchObject({
      line: expect.stringContaining('monitoring blind'),
      arm: { tool: 'events:await', args: { event: '@fleet:large-fleet' } },
    });
    expect(out.announcedGates).toBeUndefined();
    expect(out.leaderBriefProjection).toMatchObject({
      tier: 'trimmed',
      emergency: true,
    });
    expect(out.campaign).toMatchObject({
      boundary: { source: 'fleet-created-at' },
      axes: { speaking: { available: true, writer: 'writer:speaking' } },
    });
  });

  it('keeps four announced gates in the ordinary trimmed tier and bounds the rest truthfully', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'gate-fleet', members: 1 },
        announcedGates: Array.from({ length: 7 }, (_, index) => ({
          event: `fleet:gate-fleet:gate-${index}`,
          note: `gate ${index}`,
          scope: 'fleet:gate-fleet',
          announcedBy: 'su-leader',
          fired: index === 0,
          firedAt: index === 0 ? '2026-08-26T20:00:00.000Z' : null,
          awaiters: index + 1,
        })),
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.announcedGates).toHaveLength(4);
    expect(out.announcedGatesTruncated).toEqual({
      total: 7,
      shown: 4,
      more: 'fleet:leader-brief { payloadTier:"full" } or a narrow follow-up',
    });
    expect((out.announcedGates as Array<Record<string, unknown>>)[0]).toEqual({
      event: 'fleet:gate-fleet:gate-0',
      note: 'gate 0',
      scope: 'fleet:gate-fleet',
      announcedBy: 'su-leader',
      fired: true,
      firedAt: '2026-08-26T20:00:00.000Z',
      awaiters: 1,
    });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });

  it('preserves the canonical population/lifecycle contract in an ordinary monitor projection', () => {
    const lifecycle = (largeBrief() as { summary: Record<string, unknown> }).summary.populationLifecycle;
    const out = shapeLeaderBrief(
      { ok: true, summary: { fleet: 'small-fleet', members: 1, populationLifecycle: lifecycle } },
      'trimmed',
    ) as { summary: Record<string, unknown>; leaderBriefProjection: { emergency?: boolean } };

    expect(out.leaderBriefProjection.emergency).not.toBe(true);
    expect(out.summary.populationLifecycle).toMatchObject({
      schemaVersion: 'fleet-population-lifecycle-v1',
      currentRunnableRoster: { census: { counted: 53 }, ownerIds: expect.any(Array) },
      everMembers: { counted: 53, ownerIds: expect.any(Array) },
      claimFlow: { status: 'unknown', values: null },
    });
  });

  // P-019: the loss read is the ONE population here that reports absence rather than
  // presence, and a leader on a trimmed monitor projection is precisely the reader who
  // needs it — every other field in this object would still render a fleet that lost
  // nine members as healthy. Shaped away, the field may as well not exist.
  it('keeps membersLost and its unmeasured-timing marker through the trimmed projection', () => {
    const lifecycle = (largeBrief() as { summary: Record<string, unknown> }).summary.populationLifecycle;
    const out = shapeLeaderBrief(
      { ok: true, summary: { fleet: 'small-fleet', members: 1, populationLifecycle: lifecycle } },
      'trimmed',
    ) as { summary: Record<string, unknown> };

    const shaped = (out.summary.populationLifecycle as Record<string, unknown>).membersLost as Record<string, unknown>;
    expect(shaped).toMatchObject({ available: true, count: 9, timingStatus: 'not-measured' });
    // Bounded identities, but the TOTAL must survive the bound — otherwise a reader
    // counts four ids and concludes four were lost.
    expect(shaped.ownerIds).toEqual(['lost-1', 'lost-2', 'lost-3', 'lost-4']);
    expect(shaped.ownerIdsTruncated).toBe(9);
    // The long rationale prose is deliberately NOT carried at this tier (it rides on
    // the unshaped snapshot); what must survive is the count and the "do not date this
    // from the reaper's column" pointer.
    expect(shaped.timingInsteadRead).toBe('coord_presence.last_active_at');
    expect(JSON.stringify(shaped).length).toBeLessThan(400);
  });

  // WI-2034563 / P-008: shaped away, `underStrength` reads as MISSING capacity when
  // the seats are alive and parked by the leader's own directive — and the response to
  // missing capacity is to relaunch, which is the wrong move and the expensive one.
  it('keeps the policy-parked capacity row beside headcount at the normal monitor tier', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: {
          fleet: 'nonp2p-bug-drain',
          members: 45,
          headcount: { enabled: true, target: 45, current: 22, shortfall: 23, underStrength: true },
          policyParked: {
            members: 23,
            kind: 'gate',
            by: 'su-leader',
            reason: 'D-059 stand-down',
            gate: 'fleet:nonp2p-bug-drain:resume',
            expiresAt: null,
            expired: false,
            parkedForMs: 3 * 3_600_000,
            indefinite: false,
            message:
              '23 members of nonp2p-bug-drain policy-parked by su-leader (D-059 stand-down) for 3h. ' +
              "LOST CAPACITY, recoverable: fire the declared resume gate 'fleet:nonp2p-bug-drain:resume' " +
              '(fleet:resume does this) to wake every member parked on it. Do NOT relaunch them — they are alive and waiting.',
          },
        },
      },
      'trimmed',
    ) as { summary: Record<string, unknown> };

    expect(out.summary.policyParked).toMatchObject({
      members: 23,
      kind: 'gate',
      gate: 'fleet:nonp2p-bug-drain:resume',
      indefinite: false,
    });
    // The verdict half has to survive too: the row's whole job is to stop the leader
    // relaunching alive members, and only `message` carries that instruction.
    expect(String((out.summary.policyParked as { message: string }).message)).toContain('Do NOT relaunch');
  });

  it('keeps distinct productive, live-roster, and transaction-ready count contracts in a trimmed brief', () => {
    const headcount = projectFleetHeadcountState(
      { enabled: true, target: 5 } as never,
      { transactionId: 'tx-1', workerReadyMemberIds: ['su-a'] } as never,
      ['su-a', 'su-b', 'su-c'],
      new Set(['su-a', 'su-b']),
      { measuredAt: '2026-09-05T20:00:00.000Z', scope: { fleet: 'fleet-a' } },
    );
    const out = shapeLeaderBrief({ ok: true, summary: { fleet: 'fleet-a', members: 3, headcount } }, 'trimmed') as {
      summary: { headcount: typeof headcount };
    };

    expect(out.summary.headcount.countEvidence.productive?.contract.population.id).toBe(
      'live-roster-non-silent-intersection',
    );
    expect(out.summary.headcount.countEvidence.liveRoster?.contract.population.id).toBe('fleet-live-launch-roster');
    expect(out.summary.headcount.countEvidence.transactionWorkerReady?.contract.population.id).toBe(
      'current-launch-transaction-worker-ready',
    );
  });

  it('retains the dark-fleet verdict, reason, and independent falsifier at the normal monitor tier', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'dark-fleet', members: 5, darkFleetAlert: true },
        darkFleetAlertReason: '5 registered members have taken zero turns in 30 minutes',
        darkFleetAlertFalsifier: {
          tool: 'fleet:assignments',
          check: "fleet:assignments { fleet: 'dark-fleet', include_stale: true }",
          measurement: 'fresh agent-activity tool calls',
          kills: 'any member shows a recent tool call or progressing claim',
        },
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.summary).toMatchObject({ darkFleetAlert: true });
    expect(out).toMatchObject({
      darkFleetAlertReason: expect.stringContaining('zero turns'),
      darkFleetAlertFalsifier: {
        tool: 'fleet:assignments',
        check: expect.stringContaining("fleet: 'dark-fleet'"),
      },
    });
  });

  it('retains the execution-collapse tri-state and evidence handle at the normal monitor tier', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: {
          fleet: 'mute-fleet',
          members: 3,
          fleetExecutionCollapseAlert: true,
          fleetExecutionCollapse: {
            status: 'measured',
            rosterMembers: 3,
            agentOriginMembers: 0,
            heldClaimMembers: 2,
            heldClaims: 2,
            silentHeldClaimMembers: 2,
            windowMs: 1_800_000,
          },
        },
        fleetExecutionCollapseAlertReason: '2 members hold 2 claims, but ZERO agent-origin calls in 30 minutes',
        fleetExecutionCollapseAlertFalsifier: {
          tool: 'fleet:assignments',
          check: "fleet:assignments { fleet: 'mute-fleet', include_stale: true }",
        },
      },
      'trimmed',
    ) as { summary: Record<string, unknown>; fleetExecutionCollapseAlertReason?: string };

    expect(out.summary).toMatchObject({
      fleetExecutionCollapseAlert: true,
      fleetExecutionCollapse: { status: 'measured', agentOriginMembers: 0, heldClaims: 2 },
    });
    expect(out.fleetExecutionCollapseAlertReason).toMatch(/ZERO agent-origin/);
  });

  it('retains the executable-frontier verdict, reason, and falsifier at the normal monitor tier', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'frontier-fleet', members: 6, fleetHeadcountVsExecutableFrontierAlert: true },
        fleetHeadcountVsExecutableFrontierAlertReason:
          "5 live non-leader workers exceed exact plan 'one-plan' executableWidth=2 by 3",
        fleetHeadcountVsExecutableFrontierAlertFalsifier: {
          tool: 'fleet:leader-brief',
          check: "fleet:leader-brief { fleet: 'frontier-fleet', harness: 'papercusp' }",
          measurement: 'fresh roster, exact-plan DAG, and fleet claim lane',
          kills: 'the fresh alert is false or absent',
        },
      },
      'trimmed',
    ) as Record<string, unknown>;
    expect(out.summary).toMatchObject({ fleetHeadcountVsExecutableFrontierAlert: true });
    expect(out).toMatchObject({
      fleetHeadcountVsExecutableFrontierAlertReason: expect.stringContaining('executableWidth=2'),
      fleetHeadcountVsExecutableFrontierAlertFalsifier: { tool: 'fleet:leader-brief' },
    });
  });

  // P-005 / D-030 step 5: the under-staff alarm must reach the leader at every
  // tier — the summary flag, the reason and the read-only falsifier.
  const UNDER_STAFFED = {
    fleetUnderStaffedAlertReason:
      '0 of 3 target worker(s) are productive (short 3). Target 3 is recorded but supervise was never ' +
      'granted, so the governor does not hold it. Repair: fleet:headcount-target { target, supervise:true }.',
    fleetUnderStaffedAlertFalsifier: {
      tool: 'fleet:assignments',
      check: "fleet:assignments { fleet: 'short-fleet' }",
      measurement: 'each live member and the work-item it holds right now',
      kills: '3 or more members are live and each holds a claim',
    },
  };

  it('keeps the under-staff alert, its reason and falsifier in the trimmed projection', () => {
    const out = shapeLeaderBrief(
      { ok: true, summary: { fleet: 'short-fleet', members: 1, fleetUnderStaffedAlert: true }, ...UNDER_STAFFED },
      'trimmed',
    ) as Record<string, unknown>;
    expect(out.summary).toMatchObject({ fleetUnderStaffedAlert: true });
    expect(out).toMatchObject({
      fleetUnderStaffedAlertReason: expect.stringContaining('0 of 3 target worker(s)'),
      fleetUnderStaffedAlertFalsifier: { tool: 'fleet:assignments' },
    });
  });

  it('keeps the under-staff alert, its reason and falsifier when emergency shaping drops rows', () => {
    const input = { ...largeBrief(), ...UNDER_STAFFED };
    (input.summary as Record<string, unknown>).fleetUnderStaffedAlert = true;

    const out = shapeLeaderBrief(input, 'trimmed') as Record<string, unknown>;

    expect(out.leaderBriefProjection).toMatchObject({ tier: 'trimmed', emergency: true });
    expect(out.summary).toMatchObject({ fleetUnderStaffedAlert: true });
    expect(out.fleetUnderStaffedAlertReason).toEqual(expect.stringContaining('0 of 3 target worker(s)'));
    expect(out.fleetUnderStaffedAlertFalsifier).toMatchObject({ tool: 'fleet:assignments' });
  });

  it('keeps the measured dependency ranking and its population contract together', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        dependencyBottlenecks: {
          status: 'measured',
          mermaid: '```mermaid\nflowchart LR\n  n0 --> n1\n```',
          population: {
            kind: 'exact-plan-open-roots',
            planSlug: 'one-plan',
            harnessSlug: 'papercusp',
            basis: 'unified-dependency-graph',
            openRoots: 7,
            candidates: 9,
            shown: 8,
            limit: 8,
            truncated: true,
            depthLimited: false,
            maxDepth: 64,
            progressBasis: 'harness_shared.work_items.last_progress_at',
            holderBasis: 'reconciled-fleet-assignment-claims',
          },
          findings: [
            {
              code: 'high-degree-node',
              classification: 'advisory',
              confidence: 'medium',
              nodes: ['work_item:WI-0', 'plan_item:one-plan#P-001'],
              edges: [{ subject: 'plan_item:one-plan#P-001', dependency: 'work_item:WI-0' }],
              evidence: { topologyMetrics: { directFanOut: 4 } },
              provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
              suggestedAction: 'Review the node as a fragility bottleneck.',
            },
          ],
          rows: Array.from({ length: 8 }, (_, index) => ({
            rank: index + 1,
            key: `work_item:WI-${index}`,
            kind: 'work_item',
            ref: `WI-${index}`,
            status: 'open',
            title: 'ranked dependency '.repeat(40),
            workItemRefs: Array.from({ length: 9 }, (__, refIndex) => `WI-${index}-${refIndex}`),
            openBlockedCount: 8 - index,
            lastProgressAt: '2026-08-20T01:02:03.000Z',
            hoursSinceProgress: 100 + index,
            holder: {
              state: 'held',
              count: 4,
              agents: Array.from({ length: 4 }, (__, agentIndex) => ({
                agentId: `su-${agentIndex}`,
                label: `member-${agentIndex}`,
                alive: agentIndex === 0,
                sessionState: agentIndex === 0 ? 'live' : 'ended',
                verdict: agentIndex === 0 ? 'speaking' : 'dead',
              })),
              truncated: true,
            },
          })),
        },
      },
      'trimmed',
    ) as Record<string, unknown>;

    const bottlenecks = out.dependencyBottlenecks as {
      rows: Array<Record<string, unknown>>;
      findings: Array<Record<string, unknown>>;
      rowsTruncated: { total: number; shown: number };
      mermaid: string;
    };
    expect(bottlenecks).toMatchObject({
      status: 'measured',
      population: {
        planSlug: 'one-plan',
        openRoots: 7,
        candidates: 9,
        progressBasis: 'harness_shared.work_items.last_progress_at',
        holderBasis: 'reconciled-fleet-assignment-claims',
      },
      rowsTruncated: { total: 8, shown: 4 },
    });
    expect(bottlenecks.rows).toHaveLength(4);
    expect(bottlenecks.findings).toEqual([
      expect.objectContaining({
        code: 'high-degree-node',
        classification: 'advisory',
        confidence: 'medium',
        nodes: ['work_item:WI-0', 'plan_item:one-plan#P-001'],
        edges: [{ subject: 'plan_item:one-plan#P-001', dependency: 'work_item:WI-0' }],
        provenance: ['dependency-graph-admission-and-health-2026-08-26#D-005'],
      }),
    ]);
    expect(bottlenecks.rows[0]).toMatchObject({
      rank: 1,
      ref: 'WI-0',
      openBlockedCount: 8,
      workItemRefsTruncated: { total: 9, shown: 4 },
      holder: { state: 'held', count: 4 },
    });
    expect(bottlenecks.mermaid).toBe('```mermaid\nflowchart LR\n  n0 --> n1\n```');
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });

  it('never clips a large Mermaid document into invalid syntax', () => {
    const mermaid = `\`\`\`mermaid\nflowchart LR\n${'  n0 --> n1\n'.repeat(200)}\`\`\``;
    const out = shapeLeaderBrief(
      {
        ok: true,
        dependencyBottlenecks: {
          status: 'measured',
          population: { planSlug: 'one-plan' },
          rows: [],
          mermaid,
        },
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.dependencyBottlenecks).toMatchObject({
      status: 'measured',
      mermaidOmitted: {
        chars: mermaid.length,
        reason: 'bounded monitor projection never clips Mermaid',
        more: expect.stringContaining('payloadTier:"full"'),
      },
    });
    expect(out.dependencyBottlenecks).not.toHaveProperty('mermaid');
  });

  it('keeps an unknown dependency read explicit instead of emitting an empty measured table', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        dependencyBottlenecks: {
          status: 'unknown',
          reason: 'read-failed',
          planSlug: 'one-plan',
          harnessSlug: 'papercusp',
        },
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.dependencyBottlenecks).toEqual({
      status: 'unknown',
      reason: 'read-failed',
      planSlug: 'one-plan',
      harnessSlug: 'papercusp',
    });
  });

  it('keeps the blocker-stall tri-state, triggering row, and falsifier together', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'one-fleet', leaderBlockerStallAlert: true },
        leaderBlockerStall: {
          status: 'alert',
          alert: true,
          thresholdHours: 4,
          row: { rank: 1, itemRef: 'WI-40086' },
          reason: 'WI-40086 blocks 2 open items and has not progressed for 5h.',
          falsifier: {
            tool: 'fleet:assignments',
            check: "fleet:assignments { fleet: 'one-fleet', include_stale: true }",
            measurement: 'independent reconciled holder and progress evidence',
            kills: 'a live holder or newer progress kills the alert',
          },
        },
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.summary).toMatchObject({ leaderBlockerStallAlert: true });
    expect(out.leaderBlockerStall).toMatchObject({
      status: 'alert',
      alert: true,
      thresholdHours: 4,
      row: { rank: 1, itemRef: 'WI-40086' },
      falsifier: { tool: 'fleet:assignments', check: expect.stringContaining("fleet: 'one-fleet'") },
    });
  });

  it('keeps an unmeasured dependency source explicit in the blocker-stall alarm', () => {
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { leaderBlockerStallAlert: null },
        leaderBlockerStall: {
          status: 'unknown',
          alert: null,
          thresholdHours: 4,
          checkedRows: 0,
          reason: 'leader-blocker stall state is UNKNOWN: dependency bottlenecks were not measured (read-failed).',
          unknown: { code: 'dependency-bottlenecks-unmeasured', sourceReason: 'read-failed' },
        },
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.summary).toMatchObject({ leaderBlockerStallAlert: null });
    expect(out.leaderBlockerStall).toMatchObject({
      status: 'unknown',
      alert: null,
      checkedRows: 0,
      unknown: { code: 'dependency-bottlenecks-unmeasured', sourceReason: 'read-failed' },
    });
  });

  it('keeps every typed terminal audit-feed field through campaign compaction', () => {
    const row = {
      id: 'WI-42',
      kind: 'change',
      title: 'Add the fleet completion feed',
      status: 'done',
      terminalOwner: 'su-member',
      terminalCompletionRef: 'verified implementation',
      completionEvidence: {
        verifiedHow: 'unit',
        testsRun: 'npm run test:file -- fleet-campaign.test.ts',
        testResult: 'green',
        addedTests: true,
        filesChanged: ['fleet-campaign.ts'],
      },
      verifiedHow: 'unit',
      addedTests: true,
      completionAuthority: 'committed',
      countsTowardBurnDown: true,
      terminalizedAt: '2026-08-23T00:00:00.000Z',
    };
    const campaign = compactCampaign(
      {
        boundary: { at: '2026-08-23T00:00:00.000Z', source: 'fleet-created-at' },
        everMembers: { available: true, count: 1 },
        axes: {
          terminals: {
            available: true,
            writer: 'harness_shared.work_items',
            units: { auditFeed: 'terminal completion rows' },
            cap: { aggregates: 'none', recentRows: 12 },
            data: { auditFeed: { total: 1, shown: 1, truncated: false, rows: [row] } },
          },
        },
      },
      1,
    ) as Record<string, unknown>;

    expect(campaign).toMatchObject({
      axes: {
        terminals: {
          data: {
            auditFeed: {
              rows: [
                {
                  completionEvidence: row.completionEvidence,
                  countsTowardBurnDown: true,
                  terminalizedAt: row.terminalizedAt,
                },
              ],
            },
          },
        },
      },
    });
  });

  it('keeps the complete member identity index while bounding verbose row families', () => {
    const out = shapeLeaderBrief(largeBrief(), 'trimmed') as Record<string, unknown>;

    expect((out.memberVerdicts as Array<{ agentId: string }>).map(({ agentId }) => agentId)).toEqual(
      Array.from({ length: 53 }, (_, index) => `su-${String(index).padStart(2, '0')}`),
    );
    expect(out.memberVerdictsTruncated).toBeUndefined();
    expect(out.leaderBriefProjection).toMatchObject({
      memberVerdicts: { shown: 53, total: 53, complete: true },
    });
    expect((out.members as unknown[]).length).toBeLessThan(53);
    expect(out.membersTruncated).toMatchObject({ total: 53 });
    expect(out.unownedCriticalsTruncated).toMatchObject({ total: 53 });
    expect(out.customInvariantsTruncated).toMatchObject({ total: 53 });
    expect(out.specFilterOmitted).toMatchObject({ reason: 'bounded for monitor transport' });
  });

  it('keeps the custom-invariant alert in the summary when emergency shaping drops rows', () => {
    const input = largeBrief();
    (input.summary as Record<string, unknown>).customInvariantAlert = true;

    const out = shapeLeaderBrief(input, 'trimmed') as Record<string, unknown>;

    expect(out.leaderBriefProjection).toMatchObject({ tier: 'trimmed', emergency: true });
    expect(out.summary).toMatchObject({ customInvariantAlert: true });
    expect(out.customInvariants).toEqual([]);
    expect(out.customInvariantsTruncated).toMatchObject({ total: 53, shown: 0 });
  });

  it('keeps every bench target in a complete exceptional index when member rows are truncated', () => {
    const members = [
      ...Array.from({ length: 20 }, (_, index) => ({ agentId: `ordinary-${index}`, verdict: 'monitoring' })),
      { agentId: 'bench-a', verdict: 'monitoring', benchSuggestion: { kind: 'laneless-idle' } },
      { agentId: 'bench-b', verdict: 'monitoring', benchSuggestion: { kind: 'stalled-no-mcp' } },
      { agentId: 'bench-c', verdict: 'monitoring', benchSuggestion: { kind: 'idle-with-claimable' } },
    ];
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'bench-fleet', members: members.length, bench_suggested: 3, laneless_idle: 1 },
        members,
        benchSuggestions: [
          { agentId: 'bench-a', kind: 'laneless-idle' },
          { agentId: 'bench-b', kind: 'stalled-no-mcp' },
          { agentId: 'bench-c', kind: 'idle-with-claimable' },
        ],
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.benchSuggestions).toEqual([
      { agentId: 'bench-a', kind: 'laneless-idle' },
      { agentId: 'bench-b', kind: 'stalled-no-mcp' },
      { agentId: 'bench-c', kind: 'idle-with-claimable' },
    ]);
    expect(out.summary).toMatchObject({ bench_suggested: 3 });
    expect((out.members as Array<{ agentId: string }>).some((member) => member.agentId === 'bench-a')).toBe(false);
  });

  it('keeps every repeated-recovery target and diagnostic-only authority when member rows are truncated', () => {
    const members = Array.from({ length: 25 }, (_, index) => ({
      agentId: `member-${index}`,
      verdict: 'monitoring',
      ...(index >= 20
        ? {
            repeatedRecovery: {
              consecutiveRecoveryOnlyCycles: index - 18,
              action: 'diagnose',
              takeoverAuthorized: false,
              guidance: 'inspect the actual blocker',
            },
          }
        : {}),
    }));
    const repeatedRecovery = members.slice(20).map((member) => ({
      agentId: member.agentId,
      consecutiveRecoveryOnlyCycles: member.repeatedRecovery!.consecutiveRecoveryOnlyCycles,
      action: 'diagnose',
      takeoverAuthorized: false,
    }));
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'recovery-fleet', members: members.length, repeated_recovery: 5 },
        memberVerdicts: members.map(({ agentId, verdict }) => ({ agentId, verdict, idleCause: 'genuinely-idle' })),
        members,
        repeatedRecovery,
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.repeatedRecovery).toEqual(repeatedRecovery);
    expect(out.summary).toMatchObject({ repeated_recovery: 5 });
    expect(out.leaderBriefProjection).toMatchObject({
      repeatedRecovery: { shown: 5, total: 5, complete: true },
    });
    expect((out.members as unknown[]).length).toBeLessThan(members.length);
  });

  it('keeps every intent target and resolving action when verbose member rows are truncated', () => {
    const members = [
      ...Array.from({ length: 20 }, (_, index) => ({ agentId: `ordinary-${index}`, verdict: 'monitoring' })),
      {
        agentId: 'intent-stale',
        intentAttention: {
          kind: 'intent-stale',
          action: 'verify-ownership-before-reclaim',
          reason: 'verify current assignments and checkpoint before reclaiming',
        },
      },
      {
        agentId: 'intent-divergent',
        intentAttention: {
          kind: 'intent-divergent',
          action: 'request-intent-refresh',
          reason: 'request a fresh declaration',
        },
      },
    ];
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'intent-fleet', members: members.length, intent_attention: 2 },
        members,
        intentAttention: [
          {
            agentId: 'intent-stale',
            kind: 'intent-stale',
            action: 'verify-ownership-before-reclaim',
          },
          {
            agentId: 'intent-divergent',
            kind: 'intent-divergent',
            action: 'request-intent-refresh',
          },
        ],
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.summary).toMatchObject({ intent_attention: 2 });
    expect(out.intentAttention).toEqual([
      { agentId: 'intent-stale', kind: 'intent-stale', action: 'verify-ownership-before-reclaim' },
      { agentId: 'intent-divergent', kind: 'intent-divergent', action: 'request-intent-refresh' },
    ]);
    expect((out.members as Array<{ agentId: string }>).some((member) => member.agentId === 'intent-stale')).toBe(false);
  });

  it('preserves the monitoring-blind advisory in the emergency byte-pressure projection', () => {
    const input = largeBrief();
    (input.summary as Record<string, unknown>).cumulative = { admission_blocked: 6 };
    (input.summary as Record<string, unknown>).darkFleetAlert = true;
    (input as Record<string, unknown>).darkFleetAlertReason =
      '53 registered members have taken zero turns in 30 minutes';
    (input as Record<string, unknown>).darkFleetAlertFalsifier = {
      tool: 'fleet:assignments',
      check: "fleet:assignments { fleet: 'large-fleet', include_stale: true }",
      measurement: 'fresh agent-activity tool calls',
      kills: 'any member shows a recent tool call or progressing claim',
    };
    (input.summary as Record<string, unknown>).fleetHeadcountVsExecutableFrontierAlert = true;
    (input as Record<string, unknown>).fleetHeadcountVsExecutableFrontierAlertReason =
      "52 live non-leader workers exceed exact plan 'large-plan' executableWidth=4 by 48";
    (input as Record<string, unknown>).fleetHeadcountVsExecutableFrontierAlertFalsifier = {
      tool: 'fleet:leader-brief',
      check: "fleet:leader-brief { fleet: 'large-fleet', harness: 'papercusp' }",
      measurement: 'fresh roster, exact-plan DAG, and fleet claim lane',
      kills: 'the fresh alert is false or absent',
    };
    (input as Record<string, unknown>).admissionBlocked = Array.from({ length: 6 }, (_, index) => ({
      itemId: `WI-${5891 + index}`,
      member: `su-blocked-${index}`,
      specId: 'large-fleet-spec',
      specRevision: 3,
      code: 'fleet_scope_violation',
      occurrences: index + 1,
      action: `work_items:claim WI-${5891 + index} → su-blocked-${index}`,
      reason: 'work item is outside the fleet claim spec '.repeat(20),
    }));
    (input as Record<string, unknown>).admissionBlockedAction =
      'NOT member discipline — widen the lane with scheduler:set_claim_spec, then let the member self-claim.';
    (input as Record<string, unknown>).dependencyBottlenecks = {
      status: 'measured',
      population: {
        kind: 'exact-plan-open-roots',
        planSlug: 'one-plan',
        harnessSlug: 'papercusp',
        basis: 'unified-dependency-graph',
        openRoots: 8,
        candidates: 8,
        shown: 8,
        limit: 8,
        truncated: false,
        depthLimited: false,
        maxDepth: 64,
        progressBasis: 'harness_shared.work_items.last_progress_at',
        holderBasis: 'reconciled-fleet-assignment-claims',
      },
      rows: Array.from({ length: 8 }, (_, index) => ({
        rank: index + 1,
        key: `work_item:WI-${index}`,
        kind: 'work_item',
        ref: `WI-${index}`,
        status: 'open',
        title: 'x'.repeat(500),
        workItemRefs: [`WI-${index}`],
        openBlockedCount: 8 - index,
        lastProgressAt: null,
        hoursSinceProgress: null,
        holder: { state: 'unowned', count: 0, agents: [], truncated: false },
      })),
    };
    (input.summary as Record<string, unknown>).leaderBlockerStallAlert = true;
    (input as Record<string, unknown>).leaderBlockerStall = {
      status: 'alert',
      alert: true,
      thresholdHours: 4,
      row: { rank: 1, itemRef: 'WI-0' },
      reason: 'WI-0 blocks 8 open items and has not progressed for 100h.',
      falsifier: {
        tool: 'fleet:assignments',
        check: "fleet:assignments { fleet: 'large-fleet', include_stale: true }",
        measurement: 'independent holder and progress evidence',
        kills: 'a live holder or newer progress kills the alert',
      },
    };
    input.campaign.axes = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `axis-${index}`,
        {
          available: true,
          writer: `writer:${index}:${'x'.repeat(300)}`,
          units: { total: 'x'.repeat(300) },
          cap: { aggregates: 'none', recentRows: 0 },
          data: {
            total: index,
            recent: { total: 0, shown: 0, truncated: false, rows: [] },
          },
        },
      ]),
    );

    const out = shapeLeaderBrief(input, 'trimmed') as Record<string, unknown>;

    expect(out.leaderBriefProjection).toMatchObject({ tier: 'trimmed', emergency: true });
    expect(out.summary).toMatchObject({ darkFleetAlert: true });
    expect(out).toMatchObject({
      darkFleetAlertReason: expect.stringContaining('zero turns'),
      darkFleetAlertFalsifier: { tool: 'fleet:assignments' },
    });
    expect(out.summary).toMatchObject({ fleetHeadcountVsExecutableFrontierAlert: true });
    expect(out).toMatchObject({
      fleetHeadcountVsExecutableFrontierAlertReason: expect.stringContaining('executableWidth=4'),
      fleetHeadcountVsExecutableFrontierAlertFalsifier: { tool: 'fleet:leader-brief' },
    });
    expect(out.monitoringBlindAdvisory).toMatchObject({
      line: expect.stringContaining('monitoring blind'),
      arm: { tool: 'events:await', args: { event: '@fleet:large-fleet' } },
    });
    expect(out.summary).toMatchObject({ cumulative: { admission_blocked: 6 } });
    expect(out.summary).not.toHaveProperty('admission_blocked');
    expect(out.admissionBlocked).toEqual([
      expect.objectContaining({
        itemId: 'WI-5891',
        member: 'su-blocked-0',
        specId: 'large-fleet-spec',
        specRevision: 3,
      }),
    ]);
    expect(out.admissionBlockedTruncated).toMatchObject({ total: 6, shown: 1 });
    expect(out.admissionBlockedAction).toContain('scheduler:set_claim_spec');
    expect(out.dependencyBottlenecks).toMatchObject({
      status: 'measured',
      population: { planSlug: 'one-plan', openRoots: 8 },
      rows: [expect.objectContaining({ rank: 1, ref: 'WI-0', openBlockedCount: 8 })],
      rowsTruncated: { total: 8, shown: 1 },
    });
    expect(out.summary).not.toHaveProperty('leaderBlockerStallAlert');
    expect(out.leaderBlockerStall).toMatchObject({
      status: 'alert',
      alert: true,
      row: { rank: 1, itemRef: 'WI-0' },
      falsifier: { tool: 'fleet:assignments' },
    });
    expect(out.membersTruncated).toMatchObject({ total: 53, shown: 0 });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });
});

describe('P-004 / R-4 stalled-item rotation survives shaping', () => {
  it('keeps the named item, its age, the ready count and the required action, plus the summary count', () => {
    const requiredAction = 'require ONE accountable action: finish, split, record a real blocker, or release';
    const out = shapeLeaderBrief({
      ok: true,
      summary: { fleet: 'fdr', stalled_item: 1 },
      members: [{
        agentId: 'su-busy',
        stalledItem: {
          item: 'WI-77', itemTitle: 'week-old item', noAdvanceMin: 45,
          advancedAt: '2026-07-10T11:15:00.000Z', advanceSignal: 'claim_acquired_at',
          readyWaiting: 2, requiredAction,
        },
      }],
    }, 'trimmed') as Record<string, any>;
    expect(out.summary.stalled_item).toBe(1);
    expect(out.members[0].stalledItem).toMatchObject({
      item: 'WI-77', noAdvanceMin: 45, advancedAt: '2026-07-10T11:15:00.000Z', readyWaiting: 2, requiredAction,
    });
  });
});

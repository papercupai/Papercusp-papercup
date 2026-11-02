/**
 * EI-18680302159738037: fleet-scope admission blocks must reach fleet:leader-brief.
 *
 * The pure halves are tested here (the SQL half is exercised by the integration
 * suite): parsing a stamp, and collapsing repeat refusals into distinct problems.
 */
import { describe, expect, it } from 'vitest';
import {
  FLEET_ADMISSION_BLOCK_ROW_CAP,
  admissionBlockResolvedByLeaderClaim,
  admissionBlockTargetIsResolved,
  dedupeAdmissionBlocks,
  filterCurrentFleetAdmissionBlocks,
  filterCurrentAdmissionBlocks,
  parseAdmissionBlockStamp,
  readFleetAdmissionBlocks,
  type FleetAdmissionBlock,
} from './fleet-scope-admission-blocks';
import { detectFleetAdmissionTransitions } from '../../fleet-transition-events';
import type { FleetDependencyEscape } from '../../scheduler/fleet-scope-admission';

const META = { msgId: 'msg-1', atMs: 1_700_000_000_000 };

const stamp = (over: Record<string, unknown> = {}) => ({
  itemId: 'WI-5891',
  member: 'su-b0971',
  specId: 'gui-chat-controls',
  specRevision: 3,
  code: 'fleet_scope_violation',
  action: 'work_items:claim WI-5891 → su-b0971',
  reason: 'work-item WI-5891 does not match gui-chat-controls (spec rev 3)',
  ...over,
});

const block = (over: Partial<FleetAdmissionBlock> = {}): FleetAdmissionBlock => ({
  itemId: 'WI-5891',
  member: 'su-b0971',
  specId: 'gui-chat-controls',
  specRevision: 3,
  code: 'fleet_scope_violation',
  action: null,
  reason: null,
  msgId: 'msg-1',
  atMs: 1_000,
  occurrences: 1,
  dependencyEscape: null,
  ...over,
});

describe('parseAdmissionBlockStamp', () => {
  it('recovers the leader-actionable core from a well-formed stamp', () => {
    const parsed = parseAdmissionBlockStamp(stamp(), META);
    expect(parsed).toMatchObject({
      itemId: 'WI-5891',
      member: 'su-b0971',
      specId: 'gui-chat-controls',
      specRevision: 3,
      code: 'fleet_scope_violation',
      msgId: 'msg-1',
      atMs: META.atMs,
      occurrences: 1,
    });
  });

  it.each([
    ['no itemId', stamp({ itemId: undefined })],
    ['blank itemId', stamp({ itemId: '   ' })],
    ['no member', stamp({ member: undefined })],
    ['blank member', stamp({ member: '' })],
  ])('returns null when the stamp lacks the actionable pair (%s)', (_label, raw) => {
    // A row naming only one half tells a leader "something, somewhere was refused",
    // which is strictly worse than silence on a dashboard whose whole purpose is
    // naming the thing only they can unblock.
    expect(parseAdmissionBlockStamp(raw, META)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'WI-5891 was refused'],
    ['an array', [{ itemId: 'WI-5891', member: 'su-b0971' }]],
    ['an empty object', {}],
  ])('returns null for a non-stamp payload (%s)', (_label, raw) => {
    expect(parseAdmissionBlockStamp(raw, META)).toBeNull();
  });

  it('returns null when the timestamp is unusable', () => {
    expect(parseAdmissionBlockStamp(stamp(), { msgId: 'm', atMs: Number.NaN })).toBeNull();
    expect(parseAdmissionBlockStamp(stamp(), { msgId: 'm', atMs: 0 })).toBeNull();
  });

  it('keeps a missing specRevision as null rather than coercing it to 0', () => {
    // 0 is a REAL revision here, so a coerced default would send a leader to
    // re-widen a spec at a revision that never refused anything.
    const parsed = parseAdmissionBlockStamp(stamp({ specRevision: undefined }), META);
    expect(parsed?.specRevision).toBeNull();
    const zero = parseAdmissionBlockStamp(stamp({ specRevision: 0 }), META);
    expect(zero?.specRevision).toBe(0);
  });

  it('clips a pathological reason instead of letting it into the brief whole', () => {
    const parsed = parseAdmissionBlockStamp(stamp({ reason: 'x'.repeat(5_000) }), META);
    expect(parsed?.reason?.length).toBeLessThanOrEqual(240);
  });

  it('recovers a typed three-route dependency escape from the refusal stamp', () => {
    const dependencyEscape = {
      kind: 'dependency_escape',
      dependency: { id: 'WI-blocker', kind: 'issue' },
      blockedHeldItems: [{ id: 'WI-held', kind: 'change', harness: 'papercusp' }],
      blockedHeldItemIds: ['WI-held'],
      member: 'su-b0971',
      ownershipPreserved: true,
      routes: [
        { kind: 'spec_widen', calls: [] },
        { kind: 'outside_lane_placement', calls: [] },
        { kind: 'leader_claim', calls: [] },
      ],
    };
    expect(parseAdmissionBlockStamp(stamp({ dependencyEscape }), META)?.dependencyEscape).toMatchObject({
      kind: 'dependency_escape',
      dependency: { id: 'WI-blocker', kind: 'issue' },
      blockedHeldItemIds: ['WI-held'],
      ownershipPreserved: true,
    });
  });

  it('drops a malformed dependency escape without dropping the admission block', () => {
    const parsed = parseAdmissionBlockStamp(
      stamp({
        dependencyEscape: { kind: 'dependency_escape', blockedHeldItemIds: [] },
      }),
      META,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.dependencyEscape).toBeNull();
  });
});

describe('dedupeAdmissionBlocks', () => {
  it('collapses repeat refusals of the same pair and counts them', () => {
    const rows = dedupeAdmissionBlocks([
      block({ atMs: 3_000, msgId: 'c' }),
      block({ atMs: 2_000, msgId: 'b' }),
      block({ atMs: 1_000, msgId: 'a' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
  });

  it('keeps the NEWEST refusal detail for a repeated pair', () => {
    // The spec revision on the latest refusal is the one the leader is about to
    // edit; an older one sends them to re-widen a spec that has already moved on.
    const rows = dedupeAdmissionBlocks([
      block({ atMs: 1_000, specRevision: 3, msgId: 'old' }),
      block({ atMs: 9_000, specRevision: 6, msgId: 'new' }),
    ]);
    expect(rows[0]).toMatchObject({ specRevision: 6, msgId: 'new', occurrences: 2 });
  });

  it('treats a different item or a different member as a distinct problem', () => {
    const rows = dedupeAdmissionBlocks([
      block({ itemId: 'WI-1' }),
      block({ itemId: 'WI-2' }),
      block({ itemId: 'WI-1', member: 'su-other' }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.occurrences === 1)).toBe(true);
  });

  it('orders newest-first and caps the row list', () => {
    const many = Array.from({ length: 40 }, (_, i) => block({ itemId: `WI-${i}`, atMs: 1_000 + i }));
    const rows = dedupeAdmissionBlocks(many);
    expect(rows).toHaveLength(FLEET_ADMISSION_BLOCK_ROW_CAP);
    expect(rows[0]?.itemId).toBe('WI-39');
    expect(rows.map((r) => r.atMs)).toEqual([...rows.map((r) => r.atMs)].sort((a, b) => b - a));
  });

  it('counts every repeat even when the cap drops the row', () => {
    // A member stuck in a refusal LOOP is the more urgent read, so the count must
    // not depend on whether that pair survived the cap.
    const rows = dedupeAdmissionBlocks(
      [
        ...Array.from({ length: 5 }, () => block({ itemId: 'WI-loop', atMs: 500 })),
        ...Array.from({ length: 30 }, (_, i) => block({ itemId: `WI-${i}`, atMs: 1_000 + i })),
      ],
      50,
    );
    expect(rows.find((r) => r.itemId === 'WI-loop')?.occurrences).toBe(5);
  });

  it('returns an empty list for no input', () => {
    expect(dedupeAdmissionBlocks([])).toEqual([]);
  });
});

describe('filterCurrentAdmissionBlocks', () => {
  it('drops a historical refusal after its target becomes terminal', async () => {
    const historical = [block({ itemId: 'WI-done', member: 'su-grader' })];
    const isTargetTerminal = async () => true;

    const current = await filterCurrentAdmissionBlocks(historical, {
      harness: 'papercusp',
      isTargetTerminal,
    });

    expect(current).toEqual([]);
    // A fresh sweep snapshot starts at zero. The historical envelope must not
    // manufacture the field incident's false 0→1 edge after terminalization.
    expect(
      detectFleetAdmissionTransitions(new Map([['acceptance', 0]]), [
        { fleetSlug: 'acceptance', blockedCount: current.length },
      ]),
    ).toEqual([]);
  });

  it('retains a nonterminal refusal and passes the concrete harness to the resolver', async () => {
    const isTargetTerminal = async (_block: FleetAdmissionBlock, harness: string | null) => {
      expect(harness).toBe('papercusp');
      return false;
    };
    const live = block({ itemId: 'WI-open' });
    await expect(filterCurrentAdmissionBlocks([live], { harness: 'papercusp', isTargetTerminal })).resolves.toEqual([
      live,
    ]);
  });

  it('fails open when lifecycle revalidation is unavailable', async () => {
    const historical = block({ itemId: 'WI-unknown' });
    const isTargetTerminal = async () => {
      throw new Error('ledger unavailable');
    };
    await expect(filterCurrentAdmissionBlocks([historical], { isTargetTerminal })).resolves.toEqual([historical]);
  });
});

describe('admissionBlockTargetIsResolved — superseded by a direct assignment (EI-24439258189705130)', () => {
  const reads: Array<[string, string | undefined]> = [];
  const reader =
    (item: { state: string; assignee?: string | null } | null) =>
    async (itemId: string, harness: string | undefined) => {
      reads.push([itemId, harness]);
      return item;
    };

  it('resolves a refusal once the refused member itself holds the item, and stops the transition edge', async () => {
    // The field incident: fleet p013-bcd, no claim spec (so no fleet harness), two
    // refusals whose items the refused members claimed a minute later.
    const stale = block({ itemId: 'WI-10003491', member: 'su-f86897ca', harness: 'papercusp', code: 'fleet_scope_missing' });
    reads.length = 0;
    await expect(
      admissionBlockTargetIsResolved(stale, null, reader({ state: 'open', assignee: 'su-f86897ca' })),
    ).resolves.toBe(true);
    // The stamped harness resolves the bare WI id even though the fleet has none.
    expect(reads).toEqual([['WI-10003491', 'papercusp']]);

    const current = await filterCurrentAdmissionBlocks([stale], {
      isTargetTerminal: (b, h) => admissionBlockTargetIsResolved(b, h, reader({ state: 'open', assignee: 'su-f86897ca' })),
    });
    expect(current).toEqual([]);
    // A restarted sweep (baseline 0) must not re-announce it as a 0→1 block.
    expect(
      detectFleetAdmissionTransitions(new Map(), [{ fleetSlug: 'p013-bcd', blockedCount: current.length }]),
    ).toEqual([]);
  });

  it('keeps the refusal while the item is unheld or held by someone other than the refused member', async () => {
    const live = block({ itemId: 'WI-open', member: 'su-b0971', harness: 'papercusp' });
    await expect(admissionBlockTargetIsResolved(live, null, reader({ state: 'open', assignee: null }))).resolves.toBe(false);
    await expect(
      admissionBlockTargetIsResolved(live, null, reader({ state: 'open', assignee: 'su-someone-else' })),
    ).resolves.toBe(false);
  });

  it('still resolves a terminal target, and prefers the stamped harness over the fleet harness', async () => {
    reads.length = 0;
    const done = block({ itemId: 'WI-done', member: 'su-b0971', harness: 'item-harness' });
    await expect(admissionBlockTargetIsResolved(done, 'fleet-harness', reader({ state: 'done' }))).resolves.toBe(true);
    expect(reads).toEqual([['WI-done', 'item-harness']]);
  });

  it('fails open without any harness for a bare WI id (never reads an ambiguous id) and on a missing item', async () => {
    reads.length = 0;
    const legacy = block({ itemId: 'WI-legacy', member: 'su-b0971' }); // pre-field stamp, no harness
    await expect(
      admissionBlockTargetIsResolved(legacy, null, reader({ state: 'open', assignee: 'su-b0971' })),
    ).resolves.toBe(false);
    expect(reads).toEqual([]);
    await expect(admissionBlockTargetIsResolved(legacy, 'papercusp', reader(null))).resolves.toBe(false);
  });

  it('carries the stamped harness through parseAdmissionBlockStamp', () => {
    expect(parseAdmissionBlockStamp(stamp({ harness: 'papercusp' }), META)?.harness).toBe('papercusp');
    expect(parseAdmissionBlockStamp(stamp(), META)?.harness).toBeNull();
  });
});

// A well-formed three-route dependency escape (see `asDependencyEscape`), reused
// across the leader-claim tests below. `dependency.id` matches `block.itemId`
// (the leader claims the DEPENDENCY, not the refused member's own item).
const LEADER_CLAIM_ESCAPE: FleetDependencyEscape = {
  kind: 'dependency_escape',
  dependency: { id: 'WI-blocker', kind: 'issue' },
  blockedHeldItems: [{ id: 'WI-held', kind: 'change', harness: 'papercusp' }],
  blockedHeldItemIds: ['WI-held'],
  member: 'su-b0971',
  ownershipPreserved: true,
  routes: [
    {
      kind: 'spec_widen',
      calls: [
        { tool: 'scheduler:set_claim_spec', args: {} },
        { tool: 'scheduler:set_claim_spec', args: {} },
      ],
    },
    {
      kind: 'outside_lane_placement',
      substitute: { liveNonMemberAssignee: 'su-other' },
      calls: [
        { tool: 'work_items:claim', args: {} },
        { tool: 'work_items:claim', args: {} },
      ],
    },
    { kind: 'leader_claim', calls: [{ tool: 'work_items:claim', args: {} }] },
  ],
};

describe('admissionBlockResolvedByLeaderClaim (EI-22066839645010639)', () => {
  const escapedBlock = block({ itemId: 'WI-blocker', member: 'su-b0971', dependencyEscape: LEADER_CLAIM_ESCAPE });

  it('resolves true once the dependency is claimed by the fleet\'s registered leader', async () => {
    await expect(
      admissionBlockResolvedByLeaderClaim(escapedBlock, 'acceptance', 'ws-1', 'papercusp', {
        resolveFleetLeader: async (fleetSlug, workspaceId) => {
          expect(fleetSlug).toBe('acceptance');
          expect(workspaceId).toBe('ws-1');
          return 'su-leader';
        },
        resolveDependencyAssignee: async (dependencyId, harness) => {
          expect(dependencyId).toBe('WI-blocker');
          expect(harness).toBe('papercusp');
          return 'su-leader';
        },
      }),
    ).resolves.toBe(true);
  });

  it.each([
    ['no fleetSlug', null, 'ws-1'],
    ['no workspaceId', 'acceptance', null],
  ])('fails open when the fleet identity is incomplete (%s)', async (_label, fleetSlug, workspaceId) => {
    await expect(
      admissionBlockResolvedByLeaderClaim(escapedBlock, fleetSlug, workspaceId, 'papercusp', {
        resolveFleetLeader: async () => 'su-leader',
        resolveDependencyAssignee: async () => 'su-leader',
      }),
    ).resolves.toBe(false);
  });

  it('fails open when the block carries no (or a malformed) dependency escape', async () => {
    await expect(
      admissionBlockResolvedByLeaderClaim(block({ itemId: 'WI-plain' }), 'acceptance', 'ws-1', 'papercusp', {
        resolveFleetLeader: async () => 'su-leader',
        resolveDependencyAssignee: async () => 'su-leader',
      }),
    ).resolves.toBe(false);
  });

  it('fails open when the fleet leader cannot be resolved', async () => {
    await expect(
      admissionBlockResolvedByLeaderClaim(escapedBlock, 'acceptance', 'ws-1', 'papercusp', {
        resolveFleetLeader: async () => null,
        resolveDependencyAssignee: async () => 'su-leader',
      }),
    ).resolves.toBe(false);
  });

  it('resolves false when the dependency is unassigned or assigned to someone else', async () => {
    await expect(
      admissionBlockResolvedByLeaderClaim(escapedBlock, 'acceptance', 'ws-1', 'papercusp', {
        resolveFleetLeader: async () => 'su-leader',
        resolveDependencyAssignee: async () => null,
      }),
    ).resolves.toBe(false);
    await expect(
      admissionBlockResolvedByLeaderClaim(escapedBlock, 'acceptance', 'ws-1', 'papercusp', {
        resolveFleetLeader: async () => 'su-leader',
        resolveDependencyAssignee: async () => 'su-someone-else',
      }),
    ).resolves.toBe(false);
  });

  // The default (`?? currentFleetLeaderOwnerId` / `?? currentDependencyAssignee`)
  // path is intentionally NOT exercised here: it opens a real DB connection, which
  // is precisely what adding `resolveDependencyAssignee` as a seam exists to make
  // unnecessary for unit coverage. That path is the integration suite's job.
});

describe('filterCurrentAdmissionBlocks — leader-claim dependency escape (EI-22066839645010639)', () => {
  it('drops a dependency-escape block once the fleet leader has directly claimed the blocking dependency', async () => {
    const historical = [block({ itemId: 'WI-blocker', member: 'su-b0971', dependencyEscape: LEADER_CLAIM_ESCAPE })];
    // Deliberately nonterminal: the leader is ACTIVELY WORKING the dependency
    // (the whole point of EI-22066839645010639), not done with it. The terminal
    // check alone must not be what clears this block.
    const isTargetTerminal = async () => false;

    const current = await filterCurrentAdmissionBlocks(historical, {
      harness: 'papercusp',
      isTargetTerminal,
      fleetSlug: 'acceptance',
      workspaceId: 'ws-1',
      resolveFleetLeader: async () => 'su-leader',
      resolveDependencyAssignee: async () => 'su-leader',
    });

    expect(current).toEqual([]);
    // Mirrors the terminal-check regression above: a fresh sweep snapshot starts
    // at zero, and the resolved escape must not manufacture a false 0->1 edge
    // after a restart's snapshot reset (the exact symptom EI-22066839645010639
    // reported — it re-fired 0->N on every restart even though the leader had
    // already exercised the documented leader_claim route).
    expect(
      detectFleetAdmissionTransitions(new Map([['acceptance', 0]]), [
        { fleetSlug: 'acceptance', blockedCount: current.length },
      ]),
    ).toEqual([]);
  });

  it('retains the block when the dependency is claimed by someone OTHER than the fleet leader', async () => {
    const live = block({ itemId: 'WI-blocker', member: 'su-b0971', dependencyEscape: LEADER_CLAIM_ESCAPE });
    await expect(
      filterCurrentAdmissionBlocks([live], {
        harness: 'papercusp',
        isTargetTerminal: async () => false,
        fleetSlug: 'acceptance',
        workspaceId: 'ws-1',
        resolveFleetLeader: async () => 'su-leader',
        resolveDependencyAssignee: async () => 'su-someone-else',
      }),
    ).resolves.toEqual([live]);
  });

  it('retains the block when no fleetSlug/workspaceId is threaded through (a caller that has not migrated)', async () => {
    const live = block({ itemId: 'WI-blocker', member: 'su-b0971', dependencyEscape: LEADER_CLAIM_ESCAPE });
    await expect(
      filterCurrentAdmissionBlocks([live], {
        harness: 'papercusp',
        isTargetTerminal: async () => false,
        // no fleetSlug/workspaceId supplied
        resolveFleetLeader: async () => 'su-leader',
        resolveDependencyAssignee: async () => 'su-leader',
      }),
    ).resolves.toEqual([live]);
  });

  it('retains an ordinary refusal with no dependency escape (never a leader-claim candidate)', async () => {
    const live = block({ itemId: 'WI-plain' }); // dependencyEscape: null (default)
    await expect(
      filterCurrentAdmissionBlocks([live], {
        harness: 'papercusp',
        isTargetTerminal: async () => false,
        fleetSlug: 'acceptance',
        workspaceId: 'ws-1',
        resolveFleetLeader: async () => 'su-leader',
        resolveDependencyAssignee: async () => 'su-leader',
      }),
    ).resolves.toEqual([live]);
  });
});

describe('filterCurrentFleetAdmissionBlocks', () => {
  it('drops superseded revisions and members absent from the live roster', () => {
    const current = block({ itemId: 'WI-current', member: 'su-live', specRevision: 7 });
    const superseded = block({ itemId: 'WI-old-revision', member: 'su-live', specRevision: 6 });
    const deadMember = block({ itemId: 'WI-dead-member', member: 'su-dead', specRevision: 7 });

    expect(
      filterCurrentFleetAdmissionBlocks([current, superseded, deadMember], {
        currentSpec: { specId: 'gui-chat-controls', revision: 7 },
        liveMemberIds: ['su-live'],
      }),
    ).toEqual([current]);
  });

  it('keeps legacy or unresolved rows when the authoritative head is incomplete', () => {
    const legacy = block({ specId: null, specRevision: null });
    const historical = block({ specRevision: 2 });

    expect(filterCurrentFleetAdmissionBlocks([legacy, historical], { currentSpec: null })).toEqual([
      legacy,
      historical,
    ]);
    expect(filterCurrentFleetAdmissionBlocks([legacy], { currentSpec: { specId: 'lane', revision: null } })).toEqual([
      legacy,
    ]);
  });

  it('treats an explicitly empty live roster as authoritative', () => {
    expect(
      filterCurrentFleetAdmissionBlocks([block()], {
        currentSpec: { specId: 'gui-chat-controls', revision: 3 },
        liveMemberIds: new Set(),
      }),
    ).toEqual([]);
  });

  it('retires a winding-down refusal after active resume but retains it while paused or unknown', () => {
    const windingDown = block({ itemId: 'WI-paused', code: 'fleet_winding_down' });
    const ordinary = block({ itemId: 'WI-scoped', code: 'fleet_scope_violation' });

    expect(
      filterCurrentFleetAdmissionBlocks([windingDown, ordinary], {
        currentControlState: 'active',
      }),
    ).toEqual([ordinary]);
    expect(
      filterCurrentFleetAdmissionBlocks([windingDown, ordinary], {
        currentControlState: 'winding-down',
      }),
    ).toEqual([windingDown, ordinary]);
    expect(filterCurrentFleetAdmissionBlocks([windingDown, ordinary])).toEqual([windingDown, ordinary]);
  });
});

describe('readFleetAdmissionBlocks availability contract (EI-22054599451266989)', () => {
  it('distinguishes an unavailable row read from a measured empty result', async () => {
    const unavailable = await readFleetAdmissionBlocks('fleet-a', {
      hasPgFastPath: () => true,
      readRows: async () => {
        throw new Error('coord read unavailable');
      },
    });
    expect(unavailable).toEqual({
      available: false,
      blocks: null,
      reason: 'fleet admission-block read failed',
    });

    const measuredEmpty = await readFleetAdmissionBlocks('fleet-a', {
      hasPgFastPath: () => true,
      readRows: async () => [],
    });
    expect(measuredEmpty).toEqual({ available: true, blocks: [] });
  });

  it('does not emit a new edge for a refusal superseded by a newer spec or an already successful claim', async () => {
    const fleetSlug = 'frozen-burndown';
    const itemId = 'EI-27227496676244088';
    const member = 'su-4b0d1e41';
    const readAt = META.atMs + 1_000;
    const currentHeads: Array<{ specId: string; revision: number } | null> = [
      { specId: 'frozen-burndown-buckets', revision: 11 },
      null,
    ];

    for (const currentSpec of currentHeads) {
      const measured = await readFleetAdmissionBlocks(fleetSlug, {
        nowMs: readAt,
        hasPgFastPath: () => true,
        readRows: async () => [{
          msg_id: 'superseded-refusal',
          ts_ms: META.atMs,
          stamp: stamp({
            itemId,
            member,
            specId: 'frozen-burndown-buckets',
            specRevision: 10,
            harness: 'papercusp',
          }),
        }],
        resolveFleetSpec: async () => currentSpec,
        resolveFleetControlState: async () => 'active',
        resolveFleetHarness: async () => 'papercusp',
        liveMemberIds: [member],
        isTargetTerminal: async (candidate, harness) =>
          admissionBlockTargetIsResolved(candidate, harness, async () => ({ state: 'open', assignee: member })),
      });

      const blockedCount = measured.available ? measured.blocks?.length ?? null : null;
      const newestBlockAtMs = measured.available && measured.blocks && measured.blocks.length > 0
        ? Math.max(...measured.blocks.map((candidate) => candidate.atMs))
        : null;
      expect(measured).toEqual({ available: true, blocks: [] });
      expect(
        detectFleetAdmissionTransitions(
          new Map([[fleetSlug, 0]]),
          [{ fleetSlug, blockedCount, newestBlockAtMs }],
        ),
      ).toEqual([]);
    }
  });

  it('reconciles a pause refusal against the current fleet control state after resume', async () => {
    const read = (currentControlState: 'active' | 'winding-down') =>
      readFleetAdmissionBlocks('fleet-a', {
        nowMs: META.atMs + 1_000,
        hasPgFastPath: () => true,
        readRows: async () => [{ msg_id: 'paused-refusal', ts_ms: META.atMs, stamp: stamp({ code: 'fleet_winding_down' }) }],
        resolveFleetSpec: async () => ({ specId: 'gui-chat-controls', revision: 3 }),
        resolveFleetControlState: async () => currentControlState,
        resolveFleetHarness: async () => 'papercusp',
        liveMemberIds: ['su-b0971'],
        isTargetTerminal: async () => false,
      });

    await expect(read('winding-down')).resolves.toMatchObject({
      available: true,
      blocks: [{ itemId: 'WI-5891', member: 'su-b0971', code: 'fleet_winding_down' }],
    });
    await expect(read('active')).resolves.toEqual({ available: true, blocks: [] });
  });
});

/**
 * orient-core-result-door-priority.test.ts — EI-18689334534773965 regression.
 *
 * coord:orient's whole value proposition is "bootstrap in ONE round-trip":
 * assignments (`me`), the claimable backlog, and the inbox summary. Those
 * arrived at assembleOrientOutput bundled inside `result`, spread in DEAD
 * LAST — behind ownerDirectives / modes / instructionPrecedence / ideate /
 * captureMiss / configIntegrity / codexLocks / taskToolSchemaPack. Any one of
 * those preamble legs being large enough (a real taskToolSchemaPack + a real
 * instructionPrecedence trace routinely are) starves `me`/`claimable`/`inbox`
 * entirely once result-door.ts caps the serialized text — degrading the
 * advertised one-call bootstrap into several follow-up calls
 * (fleet:assignments, work_items:list, coord:inbox) to reconstruct exactly
 * what orient was supposed to hand over, on the turn (often
 * post-compaction) an agent has the least spare context to even notice the
 * gap.
 *
 * `coord:orient` now avoids that generic fallback in production: it declares a
 * result-door exemption and applies its own bounded domain shaper. These tests
 * pin that complete three-leg contract. The remaining direct `applyResultDoor`
 * cases are defence in depth: pathological JSON must stay parseable and exactly
 * resumable, while the historical recovery-priority rule remains intact.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/orient-core-result-door-priority.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPayloadTier } from '@papercusp/tooldef';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../../context-doors';

// Same PG-free door-config stub pattern as result-door.test.ts.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { BAKED_DOOR_CONSTANTS } from '../../../context-doors';
import { applyResultDoor, RESULT_DOOR_TOKENS } from '../../../result-door';
import orientTool, {
  assembleOrientOutput,
  ORIENT_PAYLOAD_TIER_CEILING_CHARS,
  ORIENT_RESULT_PRIORITY_IS_EXHAUSTIVE,
} from './orient';
import { SHAPER_BUDGET_CHARS, shapeOrient } from './orient-shape';
import {
  ORIENT_CORE_RESULT_KEYS,
  ORIENT_FACTS_RECOVERY_VIA,
  ORIENT_OPTIONAL_PRIORITY,
} from './orient-priority';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

let sandbox: string;
let prevScratchRoot: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-orient-core-result-door-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Every discretionary preamble leg blown up well past the WHOLE door budget
 *  on its own — a real taskToolSchemaPack (tool descriptions + arg schemas)
 *  and a real instructionPrecedence trace (decisions + suppressed + reasons)
 *  both routinely reach this size. */
function bigPreamble(marker: string) {
  const filler = (n: number) => `${marker}-filler-`.repeat(Math.ceil(n / 16)).slice(0, n);
  return {
    ownerDirectives: filler(BUDGET_CHARS),
    modes: { active: filler(BUDGET_CHARS / 4) },
    instructionPrecedence: { blob: filler(BUDGET_CHARS) },
    ideate: { blob: filler(BUDGET_CHARS / 2) },
    captureMiss: { blob: filler(BUDGET_CHARS / 4) },
    configIntegrity: { blob: filler(BUDGET_CHARS / 4) },
    codexLocks: { blob: filler(BUDGET_CHARS / 4) },
    taskToolSchemaPack: { blob: filler(BUDGET_CHARS) },
  };
}

const ME_MARKER = 'EI-18689334534773965-ME-CANARY';
const CLAIMABLE_MARKER = 'EI-18689334534773965-CLAIMABLE-CANARY';
const INBOX_MARKER = 'EI-18689334534773965-INBOX-CANARY';

function doorify(out: Record<string, unknown>) {
  return applyResultDoor(
    { content: [{ type: 'text' as const, text: JSON.stringify(out) }] },
    { toolName: 'coord:orient', workspaceId: 'ws-1', runId: '11111111-2222-4333-8444-555555555556' },
  );
}

/**
 * WI-37843. READ THIS BEFORE THE SUITES BELOW, which otherwise look like they
 * describe live behavior: coord:orient no longer passes through the result door
 * at all — it declares `skipResultDoor: 'oversize-by-design'`.
 *
 * The key-ordering work those suites pin is therefore DEFENCE IN DEPTH now, not
 * the mechanism keeping orient's core result in context. It is deliberately kept
 * (a) because the ordering is still what decides which fields survive if the
 * exemption is ever removed or a shaper re-trims, and (b) because they encode
 * WHICH fields are load-bearing — knowledge that would otherwise be lost.
 *
 * This first suite is the one that pins the exemption itself. It asserts on the
 * TOOL DEFINITION rather than on a dispatch, because the failure it guards is
 * precisely a declaration that never reaches the host: `skipResultDoor` spent
 * time fully typed and threaded while the one call site ignored it
 * (EI-19389430626961976), and a `payloadTierCeilingChars` that silently failed
 * to thread would look identical from the outside — orient would just quietly
 * go back to being truncated, with every test still green.
 */
describe('coord:orient declares ALL THREE uncapping legs (WI-37843)', () => {
  it("opts out of the result door as 'oversize-by-design' — the MODEL-FACING reason", () => {
    // Not 'programmatic-caller': that reason additionally suppresses appended
    // prose, and orient's reader is an agent that must still receive warnings
    // (see mayAnnotateResultText).
    expect(orientTool.skipResultDoor).toBe('oversize-by-design');
  });

  it('sets a client-safe payload-tier ceiling — the guard paired with the door exemption', () => {
    // The door spills what it cuts; this ceiling runs before serialization. The
    // exemption is safe only when ordinary/full orient calls are forced through
    // the domain shaper below the narrowest downstream client cap.
    expect(orientTool.payloadTierCeilingChars).toBe(ORIENT_PAYLOAD_TIER_CEILING_CHARS);
    expect(ORIENT_PAYLOAD_TIER_CEILING_CHARS).toBe(18_000);
    expect(ORIENT_PAYLOAD_TIER_CEILING_CHARS).toBeGreaterThan(SHAPER_BUDGET_CHARS);
    expect(ORIENT_PAYLOAD_TIER_CEILING_CHARS).toBeLessThanOrEqual(20_000);
  });

  // The leg that actually uncaps AGENTS. The two above were landed first and
  // looked like a complete fix; they are not, because an MCP agent session
  // resolves ctx_tier='trimmed' and is cut by the SHAPER before either applies.
  it('opts out of routine per-session tier shaping — the leg that cuts agents', () => {
    expect(orientTool.ignoreSessionPayloadTier).toBe(true);
  });

  // The pairing is the whole design, and it is the easy thing to "tidy" away:
  // deleting the shapers looks like finishing the uncapping, and every test
  // above would still pass. It would remove the hard ceiling's degradation
  // path and re-open the 2026-07-01 43k-token incident (P-012).
  it('KEEPS its shapers despite the opt-out — they are the ceiling degradation path', () => {
    expect(orientTool.shape).toBeDefined();
    expect(typeof orientTool.shape?.trimmed).toBe('function');
    expect(typeof orientTool.shape?.standard).toBe('function');
  });

  it('keeps an ordinary oversized/full orient below the client-safe ceiling through the domain shaper', async () => {
    const inbox = Array.from({ length: 80 }, (_, i) => ({
      kind: 'message',
      from: `su-${i}`,
      summary: `oversized inbox entry ${i} ${'x'.repeat(1_200)}`,
    }));
    const source = {
      ok: true,
      self: { ownerId: 'su-test' },
      me: 'ownerId: su-test\ncoverage[37]:\n' + '  - plan: p\n'.repeat(400),
      claimable: Array.from({ length: 100 }, (_, i) => ({
        id: `WI-${i}`,
        kind: 'bug',
        title: `bug ${i} ${'t'.repeat(600)}`,
        summary: 'duplicate summary '.repeat(100),
        state: 'open',
        payload: { plan_item: { item_id: 'P-001' }, blob: 'p'.repeat(2_000) },
      })),
      inbox: { summary: { total: 80 }, entries: inbox },
    };
    const shaped = shapeOrient(source, 'trimmed') as Record<string, unknown>;
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);
    const shapedInbox = shaped.inbox as {
      entries: unknown[];
      recent: { movedTo: string; length: number };
    };
    expect(shapedInbox.entries.length).toBeGreaterThan(0);
    expect(shapedInbox.recent).toEqual({
      movedTo: 'inbox.entries',
      length: shapedInbox.entries.length,
    });
    expect(shaped.inbox).toHaveProperty('recentTruncated');

    // Exercise the actual framework hard-ceiling path used by default/full orient
    // calls after `ignoreSessionPayloadTier:true`, not only the pure shaper seam.
    const ceilingLog = vi.fn();
    const applied = applyPayloadTier({
      toolName: 'coord:orient',
      shape: {
        trimmed: (data) => shapeOrient(data, 'trimmed'),
        standard: (data) => shapeOrient(data, 'standard'),
      },
      response: { data: source },
      tier: 'full',
      args: {},
      ceilingChars: ORIENT_PAYLOAD_TIER_CEILING_CHARS,
      log: ceilingLog,
    });
    expect(applied.payloadProjection).toMatchObject({ forced: true, tier: 'trimmed' });
    expect(JSON.stringify(applied.data).length).toBeLessThanOrEqual(SHAPER_BUDGET_CHARS);
    expect(ceilingLog).toHaveBeenCalledWith(expect.stringContaining('force-applied the trimmed shaper'));
  });
});

describe('EI-20213176698128052: assembler and shaper share one priority ledger', () => {
  it('keeps the facts recovery pointer scoped for every selector in the fold', () => {
    const factsLeg = ORIENT_OPTIONAL_PRIORITY.tier4.find((leg) => leg.name === 'facts');
    const evictionLeg = ORIENT_OPTIONAL_PRIORITY.tier4.find((leg) => leg.name === 'factEvictionDisclosures');

    expect(factsLeg?.recoverVia).toBe(ORIENT_FACTS_RECOVERY_VIA);
    expect(evictionLeg?.recoverVia).toBe(ORIENT_FACTS_RECOVERY_VIA);
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scope:'workspace'");
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scope:'owner'");
    expect(ORIENT_FACTS_RECOVERY_VIA).toContain("scope:'harness'");
  });

  it('emits the real assembled keys in the declared tier order', () => {
    const tier3 = Object.fromEntries(
      ORIENT_OPTIONAL_PRIORITY.tier3.flatMap((leg) => leg.fields.map((field) => [field, `${field}-value`])),
    );
    const tier4 = Object.fromEntries(
      ORIENT_OPTIONAL_PRIORITY.tier4.flatMap((leg) =>
        leg.fields
          // These two are shaper-generated disclosure companions, not producer fields.
          .filter((field) => field !== 'factsTruncated' && field !== 'factsBodiesTruncated')
          .map((field) => [field, `${field}-value`]),
      ),
    );
    const result = {
      ok: true,
      me: 'me-value',
      claimable: [],
      claimableHarnessScope: { requested: 'h', resolved: 'h', resolution: 'requested' },
      claimableTruncated: { shown: 0, total: 1, more: 'work_items:list' },
      inbox: { summary: {}, recent: [] },
      presenceDrift: { fleet: 'f', note: 'drift' },
      recoveredFleetScope: { fleet: 'f', role: 'leader', note: 'recovered' },
      laneClaim: { requested: ['P-001'], claimed: ['P-001'] },
      leaderBrief: null,
      fleetSummaries: [{ fleet: 'f', summary: { members: 2, stalled: 0 } }],
      fleetSummariesTruncated: { total: 13, shown: 12, more: 'fleet:leader-brief' },
      // goalPortfolio is a non-evictable core key for GOAL callers; include
      // a concrete value so this fixture exercises the complete core order.
      goalPortfolio: { schemaVersion: 1, goal: { id: 'goal-1' } },
      obligations: {
        schemaVersion: 'agent-obligations-v1',
        sourceGeneration: 'agenda-1',
        evaluations: [],
        primary: [{ id: 'obligation-1', status: 'due' }],
        projection: { receipt: { entriesAvailable: 1, entriesDelivered: 1, entriesOmitted: 0 } },
        detailRef: 'coord:orient for the complete obligation agenda',
      },
      // Key-order fixture only: in production this accompanies obligations:null.
      obligationsWithheldBy: 'experiment-arm',
      ...tier4,
    };
    const out = assembleOrientOutput({
      self: 'self-value',
      recovery: 'recovery-value',
      presenceDrift: result.presenceDrift,
      result,
      ...tier3,
    });
    const expected = [
      'self',
      'recovery',
      ...ORIENT_CORE_RESULT_KEYS,
      ...ORIENT_OPTIONAL_PRIORITY.tier3.flatMap((leg) => [...leg.fields]),
      ...ORIENT_OPTIONAL_PRIORITY.tier4.flatMap((leg) =>
        leg.fields.filter((field) => field !== 'factsTruncated' && field !== 'factsBodiesTruncated'),
      ),
    ];

    expect(ORIENT_RESULT_PRIORITY_IS_EXHAUSTIVE).toBe(true);
    expect(Object.keys(out)).toEqual(expected);
  });

  it('omits GOAL-only core fields for an ordinary caller', () => {
    const out = assembleOrientOutput({
      result: { ok: true, me: 'me-value', claimable: [], inbox: {} },
    });

    expect(out).not.toHaveProperty('goalPortfolio');
    expect(out).not.toHaveProperty('obligations');
  });
});

describe('EI-18689334534773965: generic result-door fallback stays parseable and resumable', () => {
  it('returns one bounded JSON object with an exact recovery cursor under a pathological preamble', () => {
    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: {
        ok: true,
        me: ME_MARKER,
        claimable: [{ id: CLAIMABLE_MARKER, title: 'a claimable bug' }],
        inbox: { summary: { unread: 1 }, recent: [{ summary: INBOX_MARKER }] },
        // discretionary result-tail legs — these are the ones allowed to spill.
        memory: { query: 'x', hits: ['DISCRETIONARY-TAIL-SHOULD-SPILL'.repeat(200)] },
      },
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    expect(doored.content).toHaveLength(1); // structural JSON replaces the old kept-head + footer pair
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept.length).toBeLessThanOrEqual(BUDGET_CHARS);
    const parsed = JSON.parse(kept) as { _projection: Record<string, unknown> };
    expect(parsed._projection).toMatchObject({
      kind: 'bounded-payload',
      truncated: true,
      cursor: { tool: 'capability:read', args: { byte_offset: 0, byte_limit: 3_072 } },
    });
  });

  it('recovery still outranks the core result when both are present', () => {
    const RECOVERY_MARKER = 'EI-18689334534773965-RECOVERY-CANARY';
    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      recovery: { checkpoints: [{ id: RECOVERY_MARKER }], blob: 'x'.repeat(BUDGET_CHARS) },
      result: { ok: true, me: ME_MARKER, claimable: [], inbox: { summary: {}, recent: [] } },
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    const kept = (doored.content[0] as { text: string }).text;
    // recovery is genuinely unrecoverable any other way, so it wins the race
    // when it alone is large enough to consume the whole budget.
    expect(kept).toContain(RECOVERY_MARKER);
  });

  it('legacy tail order also remains structurally recoverable when the preview omits the canaries', () => {
    // Mirrors the pre-fix key order (me/claimable/inbox bundled inside
    // `result`, spread dead last behind every preamble leg) to prove this
    // suite actually discriminates the bug.
    const preamble = bigPreamble('preamble');
    const preFixOrder = {
      self: { ownerId: 'su-test' },
      ownerDirectives: preamble.ownerDirectives,
      modes: preamble.modes,
      instructionPrecedence: preamble.instructionPrecedence,
      ideate: preamble.ideate,
      captureMiss: preamble.captureMiss,
      configIntegrity: preamble.configIntegrity,
      codexLocks: preamble.codexLocks,
      taskToolSchemaPack: preamble.taskToolSchemaPack,
      // <- pre-fix: the whole result object, core mandate included, last.
      ok: true,
      me: ME_MARKER,
      claimable: [{ id: CLAIMABLE_MARKER, title: 'a claimable bug' }],
      inbox: { summary: { unread: 1 }, recent: [{ summary: INBOX_MARKER }] },
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(JSON.parse(kept)._projection).toMatchObject({
      kind: 'bounded-payload',
      cursor: { tool: 'capability:read' },
    });
    expect(kept).not.toContain(ME_MARKER); // the defect EI-18689334534773965 reported
  });
});

/** A LEADER's fleet briefing is the same class of defect as the core result above,
 *  and it bit a live leader on 2026-08-01: `me.summary.agents` counts only resolved
 *  PRESENCE (self, on a monitor tick), so a leader whose `leaderBrief` was spilled
 *  reads `agents: 1` and concludes the whole fleet is dead. Two consecutive wakes
 *  reported "my 11-member fleet is gone" while the spilled tail of that very orient
 *  said `members: 11, dead: 0`.
 *
 *  EI-19282566865609166 had already fixed the FOLD (monitor OR afterCompaction) but
 *  left the assembled key in `resultRest` — dead last — so on a trimmed payload tier
 *  the door ate it anyway. Fold-enabled and never-delivered are indistinguishable to
 *  the reader, which is why folding it is not sufficient on its own. */
describe('leaderBrief through the generic result-door fallback', () => {
  const LEADER_BRIEF_MARKER = 'LEADER-BRIEF-MEMBERS-CANARY';

  function leaderResult() {
    return {
      ok: true,
      me: ME_MARKER,
      claimable: [],
      inbox: { summary: {}, recent: [] },
      leaderBrief: {
        ok: true,
        summary: { fleet: 'f', members: 11, dead: 0, note: LEADER_BRIEF_MARKER },
      },
      memory: { hits: ['DISCRETIONARY-TAIL-SHOULD-SPILL'.repeat(200)] },
    };
  }

  it('stays exactly recoverable under the full pathological preamble', () => {
    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: leaderResult(),
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    expect(doored.content).toHaveLength(1); // structural JSON replaces the old kept-head + footer pair
    const kept = (doored.content[0] as { text: string }).text;
    expect(JSON.parse(kept)._projection).toMatchObject({
      kind: 'bounded-payload',
      cursor: { tool: 'capability:read' },
    });
  });

  it('structural projection preserves leaderBrief even in the legacy result-tail shape', () => {
    // WI-38402 removes the old character-prefix dependence: small semantic
    // branches survive even when they follow oversized strings in key order.
    const preamble = bigPreamble('preamble');
    const preFixOrder = {
      self: { ownerId: 'su-test' },
      ok: true,
      me: ME_MARKER,
      claimable: [],
      inbox: { summary: {}, recent: [] },
      ownerDirectives: preamble.ownerDirectives,
      instructionPrecedence: preamble.instructionPrecedence,
      taskToolSchemaPack: preamble.taskToolSchemaPack,
      // <- pre-fix: leaderBrief rode `resultRest`, spread after every preamble leg.
      leaderBrief: { ok: true, summary: { members: 11, dead: 0, note: LEADER_BRIEF_MARKER } },
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(() => JSON.parse(kept)).not.toThrow();
    expect(kept).toContain(LEADER_BRIEF_MARKER);
  });

  it('a FAILED fold (leaderBrief: null) stays distinguishable from "not a leader" (key absent)', () => {
    // `null` means "I tried and could not tell you"; absent means "not applicable".
    // A truthiness spread would collapse both to absent and silently recreate the
    // exact ambiguity this fix removes.
    const withNull = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: { ok: true, me: ME_MARKER, leaderBrief: null },
    });
    expect('leaderBrief' in withNull).toBe(true);
    expect(withNull.leaderBrief).toBeNull();

    const notALeader = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: { ok: true, me: ME_MARKER },
    });
    expect('leaderBrief' in notALeader).toBe(false);
  });
});

/** EI-20013545515660920: `laneClaim` says whether the caller actually HOLDS the
 *  `planItems` lane it just asked for. It is the same class of defect as
 *  leaderBrief above: losing it to the door leaves `intentDeclared: true` as the
 *  only visible signal, and an agent then believes it holds a lane it does not
 *  hold — surfacing later as a double-placement, far from the call site.
 *
 *  Placement is the whole fix. The field is useless in `resultRest` (tier 4,
 *  beside `intentDeclared`), which is exactly the mistake WI-6749 recorded for
 *  leaderBrief: the fold was enabled and the key still never arrived. */
describe('laneClaim through the generic result-door fallback', () => {
  const LANE_WARNING_MARKER = 'LANE-CLAIM-WARNING-CANARY';

  function laneResult() {
    return {
      ok: true,
      me: ME_MARKER,
      claimable: [],
      inbox: { summary: {}, recent: [] },
      intentDeclared: true,
      laneClaim: {
        requested: ['P-005', 'P-046'],
        claimed: [],
        alreadyHeld: [],
        released: [],
        conflicts: [],
        unknown: ['P-005', 'P-046'],
        warning: LANE_WARNING_MARKER,
      },
      memory: { hits: ['DISCRETIONARY-TAIL-SHOULD-SPILL'.repeat(200)] },
    };
  }

  it('stays exactly recoverable under the full pathological preamble', () => {
    const out = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: laneResult(),
      ...bigPreamble('preamble'),
    });

    const doored = doorify(out);
    expect(doored.content).toHaveLength(1); // structural JSON replaces the old kept-head + footer pair
    const kept = (doored.content[0] as { text: string }).text;
    expect(JSON.parse(kept)._projection).toMatchObject({
      kind: 'bounded-payload',
      cursor: { tool: 'capability:read' },
    });
  });

  it('structural projection preserves the warning even in the legacy result-tail shape', () => {
    // Proves this suite discriminates the bug rather than passing vacuously — a
    // laneClaim nobody can read is the silent no-op wearing a new field name.
    const preamble = bigPreamble('preamble');
    const preFixOrder = {
      self: { ownerId: 'su-test' },
      ok: true,
      me: ME_MARKER,
      claimable: [],
      inbox: { summary: {}, recent: [] },
      ownerDirectives: preamble.ownerDirectives,
      instructionPrecedence: preamble.instructionPrecedence,
      taskToolSchemaPack: preamble.taskToolSchemaPack,
      // <- pre-fix: laneClaim would ride `resultRest`, after every preamble leg.
      laneClaim: { requested: ['P-005'], claimed: [], warning: LANE_WARNING_MARKER },
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(() => JSON.parse(kept)).not.toThrow();
    expect(kept).toContain(LANE_WARNING_MARKER);
  });

  it('the key is absent when no planItems were requested (never a silent empty report)', () => {
    const noLane = assembleOrientOutput({
      self: { ownerId: 'su-test' },
      result: { ok: true, me: ME_MARKER, intentDeclared: true },
    });
    expect('laneClaim' in noLane).toBe(false);
  });
});

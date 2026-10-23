/**
 * presence-cost.test.ts — the P-012 token-budget guard (presence-v2-2026-06-14).
 *
 * Asserts the CONTROLLABLE lean read shape stays an inline glance at hive scale:
 *   (1) a heavy-but-realistic lean roster row stays under the per-agent budget;
 *   (2) a hive-scale snapshot (≤ PRESENCE_HIVE_SCALE_AGENTS lean rows) stays
 *       under the snapshot inline-glance budget — i.e. the default slice never
 *       grows into a file-persist;
 *   (3) include_detail adds bounded, opt-in overhead (never on the lean path);
 *   (4) include_coupling's appended expanded[] is capped, and leaves the base
 *       rows byte-identical (D-053).
 *
 * These are the CI ceiling that a future presence field addition can't silently
 * breach. The real-corpus numbers that justify the budgets live in
 * presence-cost.ts's header (measured from tool_invocations.output_size); the
 * weekly token report (P-016) watches the live read VOLUME so the workspace /
 * admin paths can't regress silently either.
 */
import { describe, it, expect } from 'vitest';
import type { RosterRow } from './presence-payload';
import { toStableRosterRow } from './presence-payload';
import type { PresenceSnapshot } from './presence-snapshot';
import {
  estimateTokens,
  measurePresenceCost,
  presenceRowCost,
  presenceSnapshotCost,
  PRESENCE_HIVE_SCALE_AGENTS,
  PRESENCE_LEAN_ROW_TOKEN_BUDGET,
  PRESENCE_INLINE_GLANCE_TOKEN_BUDGET,
} from './presence-cost';
import { COUPLED_EXPANSION_MAX } from '../../coord/coupled-expansion';

/** A realistic, heavy-end active SU row: a long intent sentence, several files
 *  and claims — about as big as a single legitimately-busy lean row gets. */
function makeHeavyRow(i: number): RosterRow {
  return {
    ownerId: `su-${i.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-1234567890ab`,
    ownerLabel: `su · su-${i.toString(16).padStart(5, '0')}`,
    workspaceId: 'papercusp-workspace',
    source: 'omp-hook-session',
    host: '',
    pid: null,
    tty: null,
    startedAt: '2026-06-18T04:40:00.000Z',
    agentRole: 'su',
    potSlug: 'papercup-hive',
    model: 'opus',
    userId: null,
    federated: false,
    intent:
      'Implementing the presence read-volume guardrail in the weekly token report ' +
      'and the hive-scale cost measurement; reusing token-usage-reduction P-001 ' +
      'interactive telemetry and the P-009 byte-stability test pattern — not rebuilding.',
    currentPlanSlug: 'presence-v2-2026-06-14',
    currentFiles: [
      'packages/operator-core/lib/agent-tools/coordination/presence-cost.ts',
      'packages/operator-core/lib/agent-tools/coordination/presence-cost.test.ts',
      'packages/operator-core/lib/harness/routines/token-report-action.ts',
      'packages/operator-core/lib/harness/routines/token-report-action.test.ts',
    ],
    claimedItems: ['P-012', 'P-016'],
    awaitingEvent: true,
    awaitingEventKey: `coord:inbox-wake:su-${i}`,
    awaitingNote: 'always-armed inbox-wake (turn-lifecycle-control)',
    wakeMode: 'auto',
    revoked: false,
    // Not part of the emitted lean row (PRESENCE_DROPPED_FIELDS) — present only
    // to satisfy the type, never counted in the token-budget measurement below.
    capabilityTags: [],
    stale: false,
    lastActiveSecAgo: 7,
    heartbeatAt: '2026-06-18T08:43:00.000Z',
    lastActiveAt: '2026-06-18T08:42:53.000Z',
    intentDeclaredAt: '2026-06-18T08:42:53.000Z',
  };
}

/** A light, idle row (no intent / files / claims) — the common roster member. */
function makeIdleRow(i: number): RosterRow {
  return {
    ownerId: `su-${i.toString(16).padStart(8, '0')}-1111-2222-3333-0987654321fe`,
    ownerLabel: `su · su-${i.toString(16).padStart(5, '0')}`,
    workspaceId: 'papercusp-workspace',
    source: 'omp-hook-session',
    host: '',
    pid: null,
    tty: null,
    startedAt: '2026-06-18T04:40:00.000Z',
    agentRole: null,
    potSlug: 'papercup-hive',
    model: null,
    userId: null,
    federated: false,
    intent: '',
    currentPlanSlug: null,
    currentFiles: [],
    claimedItems: [],
    awaitingEvent: true,
    awaitingEventKey: `coord:inbox-wake:su-${i}`,
    awaitingNote: 'always-armed inbox-wake (turn-lifecycle-control)',
    wakeMode: 'auto',
    revoked: false,
    capabilityTags: [],
    stale: false,
    lastActiveSecAgo: 0,
    heartbeatAt: '2026-06-18T08:43:00.000Z',
    lastActiveAt: '2026-06-18T08:43:00.000Z',
    intentDeclaredAt: '2026-06-18T08:43:00.000Z',
  };
}

describe('estimateTokens', () => {
  it('estimates ~chars/4, never negative', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-100)).toBe(0);
    expect(estimateTokens(400)).toBe(100);
    expect(estimateTokens(401)).toBe(101); // rounds up
  });
});

describe('presence row cost (P-012 lean-row budget)', () => {
  it('a heavy-but-realistic lean row stays under the per-agent budget', () => {
    const cost = presenceRowCost(makeHeavyRow(1));
    expect(cost.tokens).toBeGreaterThan(0);
    expect(cost.tokens).toBeLessThan(PRESENCE_LEAN_ROW_TOKEN_BUDGET);
  });

  it('an idle row is cheaper than a busy one (state drives the cost, not identity)', () => {
    expect(presenceRowCost(makeIdleRow(2)).tokens).toBeLessThan(presenceRowCost(makeHeavyRow(2)).tokens);
  });
});

describe('hive-scale snapshot cost (P-012 inline-glance budget)', () => {
  it('a full hive-scale snapshot stays an inline glance (not a file-persist)', () => {
    // Worst realistic hive: every agent busy (all heavy rows), at the upper
    // bound of "a hive's worth of agents" (D-002).
    const rows = Array.from({ length: PRESENCE_HIVE_SCALE_AGENTS }, (_, i) => makeHeavyRow(i));
    const snapshot: PresenceSnapshot = {
      as_of: '2026-06-18T08:43:00.000Z',
      scope: 'hive',
      hive: 'papercup-hive',
      summary: { active: rows.length, stale: 0, federated: 0, wakeable: 0, onDesktop: 0, viewerAttached: 0, byState: { live: 0, parked: 0, ended: 0, recorded: 0, unknown: 0 }, byContextPressure: { high: 0, critical: 0 } },
      active: rows.map(toStableRosterRow),
      etag: 'test-etag',
    };
    const cost = presenceSnapshotCost(snapshot);
    expect(cost.tokens).toBeLessThan(PRESENCE_INLINE_GLANCE_TOKEN_BUDGET);
    // And the per-agent average stays small — the lean-glance property.
    const perAgent = cost.tokens / PRESENCE_HIVE_SCALE_AGENTS;
    expect(perAgent).toBeLessThan(PRESENCE_LEAN_ROW_TOKEN_BUDGET);
  });
});

describe('include_detail overhead (P-011 — opt-in, never on the lean path)', () => {
  it('heldFiles adds bounded overhead beyond the lean row', () => {
    const lean = presenceRowCost(makeHeavyRow(3));
    const heldFiles = Array.from({ length: 15 }, (_, i) => `packages/operator-core/lib/some/path/file-${i}.ts`);
    const detailed = measurePresenceCost({ ...toStableRosterRow(makeHeavyRow(3)), heldFiles });
    expect(detailed.tokens).toBeGreaterThan(lean.tokens); // detail genuinely adds
    // Even with detail, a single agent's row stays well bounded (opt-in admin read).
    expect(detailed.tokens).toBeLessThan(PRESENCE_LEAN_ROW_TOKEN_BUDGET * 2);
  });
});

describe('include_coupling overhead (P-031 leg d — appended block, never the base rows)', () => {
  /** A full block: every coupled peer resolved, each with a long stated reason —
   *  about as big as the appended block can legitimately get. */
  const fullBlock = Array.from({ length: COUPLED_EXPANSION_MAX }, (_, i) => ({
    ownerId: `su-${i.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-1234567890ab`,
    expandedBecause:
      'coupled — derived, and declared by su-1234abcd-aaaa-bbbb-cccc-1234567890ab: ' +
      'both editing packages/operator-core/lib/sync-resolver and racing the same migration',
    source: 'both' as const,
    reason: 'both editing packages/operator-core/lib/sync-resolver and racing the same migration',
    declaredBy: 'su-1234abcd-aaaa-bbbb-cccc-1234567890ab',
    inRoster: true,
    ownerLabel: `su · su-${i.toString(16).padStart(5, '0')}`,
    sessionState: 'live',
    intent: 'Wiring the union consumer into coord:presence and re-verifying on :3170',
    intentStale: false,
    lastActiveSecAgo: 7,
  }));

  it('a MAXED block stays inside the inline-glance budget on its own', () => {
    // The cap (COUPLED_EXPANSION_MAX) is what makes this bounded — without it a
    // third-party coupler could declare arbitrarily many edges against one agent
    // and grow this block without limit.
    expect(measurePresenceCost(fullBlock).tokens).toBeLessThan(PRESENCE_INLINE_GLANCE_TOKEN_BUDGET);
  });

  it('D-053: the block APPENDS — the base rows are byte-identical with it and without it', () => {
    // The contract that matters. Not "the payload is small" but "the payload the
    // caller would have gotten anyway did not change".
    const rows = Array.from({ length: 8 }, (_, i) => toStableRosterRow(makeHeavyRow(i)));
    const base = { active: rows, summary: { active: rows.length } };
    const withCoupling = { ...base, expanded: fullBlock, expandedTotal: fullBlock.length };
    expect(JSON.stringify(withCoupling.active)).toBe(JSON.stringify(base.active));
    expect(JSON.stringify(withCoupling.summary)).toBe(JSON.stringify(base.summary));
  });
});

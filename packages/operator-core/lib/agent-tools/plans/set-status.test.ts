import { describe, expect, it, vi } from 'vitest';
import {
  shouldPushNeedsHuman,
  itemImportance,
  flipStatusInBody,
  truncateInlineNote,
  isTerminalStatus,
  releaseTerminalGrips,
  releaseTodoClaim,
  terminalFlipConflict,
  terminalGuardTrips,
  blockedGuardTrips,
  completedGuardTrips,
  expectedStatusMismatch,
  planSyncWorkItemState,
  planItemCompensationMutation,
  shouldFirePlanItemDone,
  type HolderInfo,
} from './set-status';
import { deriveIndexFromContent } from './derive-index';
import { planExecutionMeaning } from './plan-execution-meaning';

describe('completion reflection execution meaning (WI-6554700010045479)', () => {
  const original = '# Scope\n## Requirements\nPreserve findings.\n## Phase 1\n- **P-001** `todo` Preserve findings blocked-by: P-002\n';

  it.each(['WI-123', 'EI-456', 'F-789'])('keeps activation current for the real completion writer suffix from %s', id => {
    const completed = flipStatusInBody(original, 'P-001', 'done', `← ${id} completed (done)`);
    expect(completed.found).toBe(true);
    expect(completed.newBody).toContain(` — note: ← ${id} completed (done)`);
    expect(planExecutionMeaning(completed.newBody)).toBe(planExecutionMeaning(original));
    const replaced = flipStatusInBody(completed.newBody, 'P-001', 'done', '← WI-999 completed (done)');
    expect(planExecutionMeaning(replaced.newBody)).toBe(planExecutionMeaning(original));
  });

  it.each([
    ['author scope', 'Preserve findings blocked-by:', 'Discard findings blocked-by:'],
    ['dependency', 'blocked-by: P-002', 'blocked-by: P-003'],
    ['requirements', 'Preserve findings.', 'Preserve findings and history.'],
  ])('retains material %s changes alongside a completion suffix', (_kind, before, after) => {
    const completed = flipStatusInBody(original.replace(before, after), 'P-001', 'done', '← WI-123 completed (done)');
    expect(planExecutionMeaning(completed.newBody)).not.toBe(planExecutionMeaning(original));
  });

  it.each([
    'Author explanation',
    '← WI-123 completed (done); discard history',
    '← WI-123 completed (done) blocked-by: P-999',
    '← WI-123 completed (unknown)',
    'prefix ← WI-123 completed (done)',
  ])('preserves non-machine or extended note text: %s', note => {
    expect(planExecutionMeaning(flipStatusInBody(original, 'P-001', 'done', note).newBody))
      .not.toBe(planExecutionMeaning(original));
  });

  it('keeps a dropped transition and decisions material even with an exact completion suffix', () => {
    const dropped = flipStatusInBody(original, 'P-001', 'dropped', '← WI-123 completed (dropped)');
    expect(planExecutionMeaning(dropped.newBody)).not.toBe(planExecutionMeaning(original));
    const completed = flipStatusInBody(original, 'P-001', 'done', '← WI-123 completed (done)');
    expect(planExecutionMeaning(completed.newBody + '\n## Decisions\n### D-001 Delete old findings\nDelete history.\n'))
      .not.toBe(planExecutionMeaning(original));
  });
});

// EI-22377738415938641: the `plan-item:done` EDGE gate. Reported as "the event can precede
// the durable status transition"; the ledger disproves that (one fire, 560ms AFTER the
// work-item went terminal, plan row already done). What was genuinely missing is any test of
// the gate itself — and events/await.ts's latch is only sound while it holds.
describe('shouldFirePlanItemDone (EI-22377738415938641)', () => {
  it('fires on a real →done edge', () => {
    expect(shouldFirePlanItemDone('done', 'todo')).toBe(true);
    expect(shouldFirePlanItemDone('done', 'wip')).toBe(true);
    expect(shouldFirePlanItemDone('done', 'blocked')).toBe(true);
  });

  it('does NOT re-fire when an already-done item is set done again', () => {
    // The awaiter contract: this key fires exactly once. A re-set that fired again would
    // wake every awaiter spuriously and break the once-only equivalence the latch relies on.
    expect(shouldFirePlanItemDone('done', 'done')).toBe(false);
  });

  it('does not fire for any non-done target status', () => {
    for (const next of ['todo', 'wip', 'blocked', 'needs-human', 'dropped']) {
      expect(shouldFirePlanItemDone(next, 'todo')).toBe(false);
      expect(shouldFirePlanItemDone(next, 'done')).toBe(false);
    }
  });

  it('treats an unknown prior status as an edge (fail toward waking awaiters)', () => {
    // An unreadable oldStatus must not silently swallow the fire: a missed wake strands a
    // parked awaiter for its whole timeout, which is the worse direction than one extra wake.
    // Both spellings: the call site's `oldStatus` is `string | null`, so null is the shape
    // that actually reaches this in production — undefined only via a direct caller.
    expect(shouldFirePlanItemDone('done', undefined)).toBe(true);
    expect(shouldFirePlanItemDone('done', null)).toBe(true);
  });
});

describe('planItemCompensationMutation (P-010)', () => {
  const body = (status: string) =>
    `---\ntitle: t\nupdated: 2026-08-01\n---\n\n- **P-003** \`${status}\` Restore this gate.\n`;

  it('restores only the exact terminal status written by the bulk action', () => {
    const result = planItemCompensationMutation(body('done'), {
      itemId: 'P-003',
      expectedStatus: 'done',
      priorStatus: 'needs-human',
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(result.value).toBe('restored');
    expect(result.newBody).toContain('updated: 2026-09-01');
    expect(result.newBody).toContain('- **P-003** `needs-human` Restore this gate.');
  });

  it('is idempotent and refuses to overwrite a newer status', () => {
    expect(
      planItemCompensationMutation(body('needs-human'), {
        itemId: 'P-003',
        expectedStatus: 'done',
        priorStatus: 'needs-human',
      }),
    ).toEqual({ newBody: null, value: 'already_restored' });
    expect(
      planItemCompensationMutation(body('wip'), {
        itemId: 'P-003',
        expectedStatus: 'done',
        priorStatus: 'needs-human',
      }),
    ).toEqual({ newBody: null, value: 'source_changed' });
  });
});

// P-020 (planning-attention-importance): plans:set-status pushes a
// notification when an item transitions INTO needs-human at importance
// >= high. These cover the two pure pieces of that gate; the push itself
// (notifyWorkspace) is the proven mobile-delivery path exercised elsewhere.

// Caller-DX (watchdog P-006): an over-long inline note is truncated-with-marker,
// not rejected — the agent never bounces; the long form belongs in `rationale`.
describe('truncateInlineNote (P-006)', () => {
  it('passes a short note through untouched', () => {
    expect(truncateInlineNote('short note')).toEqual({ note: 'short note', truncated: false });
  });
  it('passes undefined through (no note)', () => {
    expect(truncateInlineNote(undefined)).toEqual({ note: undefined, truncated: false });
  });
  it('keeps a note exactly at the 1000-char cap', () => {
    const exact = 'x'.repeat(1000);
    expect(truncateInlineNote(exact)).toEqual({ note: exact, truncated: false });
  });
  it('truncates an over-cap note to 1000 chars with an ellipsis marker', () => {
    const out = truncateInlineNote('y'.repeat(1500));
    expect(out.truncated).toBe(true);
    expect(out.note).toHaveLength(1000);
    expect(out.note!.endsWith('…')).toBe(true);
    expect(out.note!.slice(0, 999)).toBe('y'.repeat(999));
  });
});

describe('shouldPushNeedsHuman', () => {
  it('fires on a fresh needs-human flip at urgent/high', () => {
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'urgent')).toBe(true);
    expect(shouldPushNeedsHuman('todo', 'needs-human', 'high')).toBe(true);
    expect(shouldPushNeedsHuman(null, 'needs-human', 'urgent')).toBe(true);
  });

  it('does NOT fire below high importance', () => {
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'normal')).toBe(false);
    expect(shouldPushNeedsHuman('wip', 'needs-human', 'low')).toBe(false);
  });

  it('does NOT fire when the item was already needs-human (re-set, not a transition)', () => {
    expect(shouldPushNeedsHuman('needs-human', 'needs-human', 'urgent')).toBe(false);
  });

  it('does NOT fire for non-needs-human target statuses', () => {
    expect(shouldPushNeedsHuman('todo', 'done', 'urgent')).toBe(false);
    expect(shouldPushNeedsHuman('wip', 'blocked', 'high')).toBe(false);
  });
});

// EI-14699: a plan-item flipped to blocked/needs-human must reflect onto its
// linked work_item's state, or scheduler:get_next keeps serving the (still-
// claimable) work_item → perpetual claim/release ping-pong. This is the pure
// decider; the PG lookup + setWorkItemState wiring rides on top of it.
describe('planSyncWorkItemState (EI-14699)', () => {
  it('blocks a claimable work_item when the plan item flips to blocked/needs-human', () => {
    // both families' claimable states
    expect(planSyncWorkItemState('todo', 'blocked', 'todo')).toBe('blocked');
    expect(planSyncWorkItemState('todo', 'needs-human', 'todo')).toBe('blocked');
    expect(planSyncWorkItemState('wip', 'blocked', 'open')).toBe('blocked'); // issue-family claimable
  });

  it('does NOT re-block a work_item that is not claimable (wip/validating/already-blocked)', () => {
    expect(planSyncWorkItemState('todo', 'blocked', 'wip')).toBeNull();
    expect(planSyncWorkItemState('todo', 'blocked', 'validating')).toBeNull();
    expect(planSyncWorkItemState('todo', 'blocked', 'blocked')).toBeNull();
  });

  it('reopens a blocked work_item onto the unified claimable token `open` when the plan item is REOPENED from blocked/needs-human', () => {
    // work-item-status-full-unify (P-005): the plan-item status is `todo` (its own vocabulary),
    // but the work_item is re-opened onto the SINGLE claimable token `open` for both families.
    expect(planSyncWorkItemState('blocked', 'todo', 'blocked')).toBe('open');
    expect(planSyncWorkItemState('needs-human', 'todo', 'blocked')).toBe('open');
  });

  it('does NOT reopen a work_item that is not blocked, nor on a reopen from a non-blocked status', () => {
    expect(planSyncWorkItemState('blocked', 'todo', 'wip')).toBeNull(); // someone re-picked it up
    expect(planSyncWorkItemState('wip', 'todo', 'blocked')).toBeNull(); // plan wasn't blocked before
    expect(planSyncWorkItemState('done', 'todo', 'blocked')).toBeNull();
  });

  it('is a no-op for a re-set of the same status (transition-gated)', () => {
    expect(planSyncWorkItemState('blocked', 'blocked', 'todo')).toBeNull();
    expect(planSyncWorkItemState('todo', 'todo', 'blocked')).toBeNull();
    expect(planSyncWorkItemState(null, 'todo', 'todo')).toBeNull();
  });

  it('never touches the work_item on wip/done/dropped flips (owned by claim + terminal-grip paths)', () => {
    expect(planSyncWorkItemState('todo', 'wip', 'todo')).toBeNull();
    expect(planSyncWorkItemState('wip', 'done', 'wip')).toBeNull();
    expect(planSyncWorkItemState('blocked', 'dropped', 'blocked')).toBeNull();
  });
});

describe('itemImportance', () => {
  const body = [
    '## Phase 1',
    '',
    '- **P-001** `todo` plain item, no keyword',
    '- **P-002** `wip` urgent one importance: urgent',
    '- **P-003** `todo` high one blocked-by: P-001 importance: high',
    '- **P-004** `done` explicit normal importance: normal',
    '- **P-005** `todo` bogus value importance: spicy',
    '',
  ].join('\n');

  it('defaults to normal when the keyword is absent', () => {
    expect(itemImportance(body, 'P-001')).toBe('normal');
  });

  it('reads the importance keyword regardless of position on the line', () => {
    expect(itemImportance(body, 'P-002')).toBe('urgent');
    expect(itemImportance(body, 'P-003')).toBe('high');
    expect(itemImportance(body, 'P-004')).toBe('normal');
  });

  it('degrades an unrecognised value to normal (no throw)', () => {
    expect(itemImportance(body, 'P-005')).toBe('normal');
  });

  it('returns normal for an unknown item id', () => {
    expect(itemImportance(body, 'P-999')).toBe('normal');
  });

  it('ignores an importance keyword that only appears inside a fenced example', () => {
    const fenced = [
      '## Phase 1',
      '',
      '- **P-010** `todo` real item',
      '',
      '```',
      '- **P-010** `todo` example importance: urgent',
      '```',
      '',
    ].join('\n');
    expect(itemImportance(fenced, 'P-010')).toBe('normal');
  });
});

// EI-2298: a terminal flip (done/dropped) must clear BOTH the caller's live
// claim AND the item's durable ASSIGNMENT. The assignment is item-level and can
// belong to a DIFFERENT agent than the one closing the item (a verify-first
// `done` set by a peer) — if left dangling, the item sits done+assigned-idle
// forever and a dispatcher that re-pokes assigned-idle items re-targets the
// stale assignee endlessly. These guard that exact invariant.
describe('isTerminalStatus', () => {
  it('treats done + dropped as terminal, everything else as non-terminal', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('dropped')).toBe(true);
    expect(isTerminalStatus('wip')).toBe(false);
    expect(isTerminalStatus('todo')).toBe(false);
    expect(isTerminalStatus('blocked')).toBe(false);
    expect(isTerminalStatus('needs-human')).toBe(false);
  });
});

describe('releaseTerminalGrips (EI-2298)', () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'h' };
  function fakes(assignmentRow: unknown = { itemId: 'P-001' }) {
    const calls = { releaseClaim: [] as unknown[][], clearAssignment: [] as unknown[][] };
    return {
      calls,
      releaseClaim: async (...a: unknown[]) => {
        calls.releaseClaim.push(a);
        return true;
      },
      clearAssignment: async (...a: unknown[]) => {
        calls.clearAssignment.push(a);
        return assignmentRow;
      },
    };
  }
  const at = (slug = 'plan-a', itemId = 'P-001') => ({ scope, slug, itemId });

  it('on done with NO caller identity (a peer verify-first close): still clears the dangling assignment — THE bug', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: null, // the closer is not the assignee
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out.assignmentReleased).toBe(true);
    expect(f.calls.clearAssignment).toEqual([['ws', 'h', 'plan-a', 'P-001']]);
    expect(f.calls.releaseClaim).toHaveLength(0); // no caller claim to release
  });

  it('on done with an attributable agent: releases BOTH the caller claim and the assignment', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out).toEqual({ claimReleased: true, assignmentReleased: true });
    expect(f.calls.releaseClaim).toEqual([['ws', 'h', 'plan-a', 'P-001', 'su-x']]);
    expect(f.calls.clearAssignment).toEqual([['ws', 'h', 'plan-a', 'P-001']]);
  });

  it('on dropped: also clears the assignment', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'dropped',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out.assignmentReleased).toBe(true);
  });

  it('on a NON-terminal flip (wip): touches neither claim nor assignment', async () => {
    const f = fakes();
    const out = await releaseTerminalGrips({
      status: 'wip',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out).toEqual({ claimReleased: false, assignmentReleased: false });
    expect(f.calls.releaseClaim).toHaveLength(0);
    expect(f.calls.clearAssignment).toHaveLength(0);
  });

  it('assignmentReleased=false when there was no active assignment (clearAssignment → null)', async () => {
    const f = fakes(null);
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
      clearAssignment: f.clearAssignment,
    });
    expect(out.assignmentReleased).toBe(false);
  });

  it('is fail-safe: a clearAssignment throw is swallowed → assignmentReleased=false, no throw', async () => {
    // The helper logs the swallowed error via console.warn; mock it so
    // vitest-fail-on-console does not fail the test, and assert it occurred
    // (the fail-safe path IS expected to warn).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await releaseTerminalGrips({
      status: 'done',
      agentOwnerId: null,
      ...at(),
      releaseClaim: async () => true,
      clearAssignment: async () => {
        throw new Error('pg down');
      },
    });
    expect(out.assignmentReleased).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// EI-5822: a →todo flip is the documented "hand it back to the pool"
// affordance, but only the ASSIGNMENT/status token released — the caller's
// live coord claim LEASE (what actually blocks a peer's next wip-flip with
// claim_conflict) survived until TTL expiry. releaseTodoClaim closes that gap
// WITHOUT touching the durable assignment (unlike a terminal flip).
describe('releaseTodoClaim (EI-5822)', () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'h' };
  function fakes() {
    const calls: unknown[][] = [];
    return {
      calls,
      releaseClaim: async (...a: unknown[]) => {
        calls.push(a);
        return true;
      },
    };
  }
  const at = (slug = 'plan-a', itemId = 'P-001') => ({ scope, slug, itemId });

  it("on →todo with an attributable agent: releases the caller's own claim", async () => {
    const f = fakes();
    const out = await releaseTodoClaim({
      status: 'todo',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: f.releaseClaim,
    });
    expect(out).toEqual({ claimReleased: true });
    expect(f.calls).toEqual([['ws', 'h', 'plan-a', 'P-001', 'su-x']]);
  });

  it('on →todo with NO caller identity (a human/principal flip): never calls releaseClaim', async () => {
    const f = fakes();
    const out = await releaseTodoClaim({ status: 'todo', agentOwnerId: null, ...at(), releaseClaim: f.releaseClaim });
    expect(out).toEqual({ claimReleased: false });
    expect(f.calls).toHaveLength(0);
  });

  it('on a NON-todo flip (wip/done/blocked/…): never calls releaseClaim — this is todo-specific, not a blanket release', async () => {
    const f = fakes();
    for (const status of ['wip', 'done', 'dropped', 'blocked', 'needs-human']) {
      const out = await releaseTodoClaim({ status, agentOwnerId: 'su-x', ...at(), releaseClaim: f.releaseClaim });
      expect(out).toEqual({ claimReleased: false });
    }
    expect(f.calls).toHaveLength(0);
  });

  it('is fail-safe: a releaseClaim throw is swallowed → claimReleased=false, no throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await releaseTodoClaim({
      status: 'todo',
      agentOwnerId: 'su-x',
      ...at(),
      releaseClaim: async () => {
        throw new Error('coord store down');
      },
    });
    expect(out).toEqual({ claimReleased: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// WI-2156 (completion-integrity, terminal-flip holdership): a done/dropped flip by an
// AGENT who is not the item's live claim holder is refused — the prevention leg the
// close path historically lacked (ornith run-10: a member bulk-flipped items its
// sibling held). These cover the pure decision; the getClaim glue is a thin read.
describe('terminalFlipConflict (WI-2156)', () => {
  const peer: HolderInfo = {
    owner: 'su-peer',
    ownerLabel: 'peer · su-peer',
    intent: 'verifying P-003',
    expiresTs: '2026-07-04T10:00:00Z',
    expired: false,
  };
  it('BLOCKS a terminal flip when a LIVE peer holds the item (returns the holder)', () => {
    const c = terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: peer });
    expect(c).not.toBeNull();
    expect(c?.owner).toBe('su-peer');
    expect(c?.intent).toBe('verifying P-003');
    // dropped is terminal too
    expect(terminalFlipConflict({ status: 'dropped', agentOwnerId: 'su-me', holder: peer })).not.toBeNull();
  });
  it('ALLOWS closing your OWN held item (holder === caller)', () => {
    const mine: HolderInfo = { ...peer, owner: 'su-me', ownerLabel: 'me' };
    expect(terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: mine })).toBeNull();
  });
  it('ALLOWS when the peer claim is EXPIRED/lapsed (a dead peer never wedges closure)', () => {
    expect(
      terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: { ...peer, expired: true } }),
    ).toBeNull();
  });
  it('ALLOWS a human/principal caller (agentOwnerId null — the guard binds agents, not the owner)', () => {
    expect(terminalFlipConflict({ status: 'done', agentOwnerId: null, holder: peer })).toBeNull();
  });
  it('ALLOWS when the item is unheld (no claim)', () => {
    expect(terminalFlipConflict({ status: 'done', agentOwnerId: 'su-me', holder: null })).toBeNull();
  });
  it('is a NO-OP for non-terminal flips — the wip path owns that claim (no double-guard)', () => {
    expect(terminalFlipConflict({ status: 'wip', agentOwnerId: 'su-me', holder: peer })).toBeNull();
    expect(terminalFlipConflict({ status: 'blocked', agentOwnerId: 'su-me', holder: peer })).toBeNull();
    expect(terminalFlipConflict({ status: 'needs-human', agentOwnerId: 'su-me', holder: peer })).toBeNull();
  });
});

// Guard the status-flip helper the push gate rides on, so a regression in
// the regex (which also feeds importance lookup) trips here.
describe('flipStatusInBody', () => {
  it('flips a status token and reports the old one', () => {
    const body = '- **P-001** `wip` do the thing';
    const out = flipStatusInBody(body, 'P-001', 'needs-human');
    expect(out.found).toBe(true);
    expect(out.oldStatus).toBe('wip');
    expect(out.newBody).toContain('`needs-human`');
  });

  it('targets the parsed phase item when ## Now has an earlier P-NNN summary line', () => {
    const body = [
      '---',
      'title: t',
      'slug: t',
      'status: shipped',
      '---',
      '',
      '## Now',
      '- **P-001** `done` summary placeholder',
      '',
      '## Phase — Now',
      '- **P-001** `todo` the actual work item',
    ].join('\n');

    const out = flipStatusInBody(body, 'P-001', 'done');

    expect(out.found).toBe(true);
    expect(out.oldStatus).toBe('todo');
    expect(out.newBody).toContain('- **P-001** `done` summary placeholder');
    expect(out.newBody).toContain('- **P-001** `done` the actual work item');
    expect(deriveIndexFromContent(out.newBody).items.find((item) => item.id === 'P-001')?.status).toBe('done');
  });

  describe('note handling (EI-384)', () => {
    it("appends a note verbatim — never strips the caller's own punctuation", () => {
      const body = '- **P-001** `wip` do the thing';
      const out = flipStatusInBody(body, 'P-001', 'wip', 'ratified in (a) prior review, see (b)');
      // Before the fix: `.replace(/[()]/g, '')` turned this into
      // "ratified in a prior review, see b" — a meaning-changing mangle.
      expect(out.newBody).toContain('ratified in (a) prior review, see (b)');
    });

    it('a second call with a corrected note REPLACES the first instead of stacking', () => {
      const body = '- **P-001** `wip` do the thing';
      const first = flipStatusInBody(body, 'P-001', 'wip', 'oops typo');
      const second = flipStatusInBody(first.newBody, 'P-001', 'wip', 'fixed note');
      expect(second.newBody).toContain('fixed note');
      expect(second.newBody).not.toContain('oops typo');
      // Exactly one note marker survives, not two.
      expect((second.newBody.match(/—\s*note:/g) ?? []).length).toBe(1);
    });

    it('a note-free flip leaves an existing injected note untouched', () => {
      const body = '- **P-001** `wip` do the thing';
      const withNote = flipStatusInBody(body, 'P-001', 'wip', 'keep me').newBody;
      const out = flipStatusInBody(withNote, 'P-001', 'needs-human');
      expect(out.newBody).toContain('keep me');
    });
  });
});

// `onlyIfNotTerminal` — the non-destructive flip an AUTOMATED reflection asks for so it can
// never un-finish shipped work. The bug this closes: plan-items/reflect-rules.ts reflected
// `work_items:release` (an OWNERSHIP event, carrying no completion information) as a flat
// `status:'todo'`, so releasing a still-open work-item de-completed an already-`done` plan
// item — re-pooling finished work for duplicate pickup and flipping its dependents to a
// false `blocked`. Live case: memory-write-latency-2026-07-26#P-007 via WI-6211's release.
describe('terminalGuardTrips — never move a finished item off terminal', () => {
  it('SKIPS a terminal → non-terminal flip when the caller asked for the guard', () => {
    for (const currentStatus of ['done', 'dropped']) {
      for (const nextStatus of ['todo', 'wip', 'blocked', 'needs-human']) {
        expect(
          terminalGuardTrips({ onlyIfNotTerminal: true, currentStatus, nextStatus }),
          `${currentStatus} → ${nextStatus}`,
        ).toBe(true);
      }
    }
  });

  it('ALLOWS terminal → terminal — a done→dropped reclassification is legitimate', () => {
    expect(terminalGuardTrips({ onlyIfNotTerminal: true, currentStatus: 'done', nextStatus: 'dropped' })).toBe(false);
    expect(terminalGuardTrips({ onlyIfNotTerminal: true, currentStatus: 'dropped', nextStatus: 'done' })).toBe(false);
  });

  it('ALLOWS every flip of an item that is not yet terminal', () => {
    for (const currentStatus of ['todo', 'wip', 'blocked', 'needs-human']) {
      expect(terminalGuardTrips({ onlyIfNotTerminal: true, currentStatus, nextStatus: 'todo' })).toBe(false);
      expect(terminalGuardTrips({ onlyIfNotTerminal: true, currentStatus, nextStatus: 'done' })).toBe(false);
    }
  });

  // The guard is OPT-IN: a human deliberately reopening a done item must still be able to.
  // If this ever inverts, every manual reopen silently becomes a no-op.
  it('is inert without the flag — a deliberate reopen is untouched', () => {
    expect(terminalGuardTrips({ onlyIfNotTerminal: undefined, currentStatus: 'done', nextStatus: 'todo' })).toBe(false);
    expect(terminalGuardTrips({ onlyIfNotTerminal: false, currentStatus: 'done', nextStatus: 'todo' })).toBe(false);
  });

  it('is inert when the item does not exist yet (no current status to protect)', () => {
    expect(terminalGuardTrips({ onlyIfNotTerminal: true, currentStatus: null, nextStatus: 'todo' })).toBe(false);
  });
});

// EI-20408645914630287 — an ownership reflection can reopen a plan item from `blocked`
// or `needs-human` to `todo` even though the explicit plan gate still stands. This guard
// is opt-in for automated reflections; a human deliberately clearing or completing the
// gate omits it.
describe('blockedGuardTrips — never weaken an explicit plan gate', () => {
  it('SKIPS a blocked/needs-human → non-gated flip when the caller asked for the guard', () => {
    for (const currentStatus of ['blocked', 'needs-human']) {
      for (const nextStatus of ['todo', 'wip', 'done', 'dropped']) {
        expect(
          blockedGuardTrips({ onlyIfNotBlocked: true, currentStatus, nextStatus }),
          `${currentStatus} → ${nextStatus}`,
        ).toBe(true);
      }
    }
  });

  it('ALLOWS transitions that keep the item explicitly gated', () => {
    expect(blockedGuardTrips({ onlyIfNotBlocked: true, currentStatus: 'blocked', nextStatus: 'blocked' })).toBe(false);
    expect(blockedGuardTrips({ onlyIfNotBlocked: true, currentStatus: 'blocked', nextStatus: 'needs-human' })).toBe(
      false,
    );
    expect(blockedGuardTrips({ onlyIfNotBlocked: true, currentStatus: 'needs-human', nextStatus: 'blocked' })).toBe(
      false,
    );
    expect(blockedGuardTrips({ onlyIfNotBlocked: true, currentStatus: 'needs-human', nextStatus: 'needs-human' })).toBe(
      false,
    );
  });

  it('does not guard non-gated items, missing items, or deliberate human flips', () => {
    for (const currentStatus of ['todo', 'wip', 'done', 'dropped']) {
      expect(blockedGuardTrips({ onlyIfNotBlocked: true, currentStatus, nextStatus: 'todo' })).toBe(false);
    }
    expect(blockedGuardTrips({ onlyIfNotBlocked: true, currentStatus: null, nextStatus: 'todo' })).toBe(false);
    expect(blockedGuardTrips({ onlyIfNotBlocked: undefined, currentStatus: 'blocked', nextStatus: 'todo' })).toBe(
      false,
    );
    expect(blockedGuardTrips({ onlyIfNotBlocked: false, currentStatus: 'needs-human', nextStatus: 'done' })).toBe(
      false,
    );
  });
});

// EI-20129670928216719 — the gap BETWEEN the two guards above and the coverage guard.
// `terminalGuardTrips` deliberately permits terminal→terminal (pinned by the
// 'ALLOWS terminal → terminal' case above), and the coverage guard counts only NON-terminal
// siblings — so the DONE work-item that actually completed a plan item is invisible to it.
// Result: dropping a merely `relates`-linked follow-on silently downgraded an already-`done`
// plan item. Live case: fix-0014-platform-defects-2026-08-10#P-005, flipped done→dropped 67ms
// after WI-37872 was dropped, while its real completer WI-37735 sat `done`.
describe('expectedStatusMismatch — compare-and-set for a RECORDED observation (P-011)', () => {
  // The defect: a bulk clean-up run scans a plan, its report sits open for
  // hours, and Apply then wrote the recorded transition with no precondition —
  // silently overwriting whatever the item became in between.
  //
  // Deliberately unlike every onlyIf* guard beside it: those are non-destructive
  // SKIPS for automated cascades (ok:true, `skipped`). This is an ERROR, because
  // the caller is asserting a fact about the world that turned out false.

  it('is inert when the caller made no claim', () => {
    // Every existing caller passes nothing; the precondition must not change
    // behaviour for them, including when the status cannot be read at all.
    expect(expectedStatusMismatch({ expectedStatus: undefined, currentStatus: 'done' })).toBe(false);
    expect(expectedStatusMismatch({ expectedStatus: undefined, currentStatus: null })).toBe(false);
  });

  it('permits the write when the world still matches the recording', () => {
    expect(expectedStatusMismatch({ expectedStatus: 'todo', currentStatus: 'todo' })).toBe(false);
  });

  it('refuses the write when the item moved since the scan', () => {
    // The whole point: some other agent flipped it while the report was open.
    expect(expectedStatusMismatch({ expectedStatus: 'todo', currentStatus: 'wip' })).toBe(true);
    expect(expectedStatusMismatch({ expectedStatus: 'todo', currentStatus: 'done' })).toBe(true);
    expect(expectedStatusMismatch({ expectedStatus: 'blocked', currentStatus: 'todo' })).toBe(true);
  });

  it('FAILS CLOSED on an unreadable current status', () => {
    // null means the flip helper could not read one, which is indistinguishable
    // from "it changed". Treating it as a match would let exactly the
    // unverifiable case through — the one the guard exists for.
    expect(expectedStatusMismatch({ expectedStatus: 'todo', currentStatus: null })).toBe(true);
  });

  it('is an exact comparison, not a terminal-family one', () => {
    // done and dropped are both terminal, but a report that recorded done and
    // finds dropped is looking at a different decision.
    expect(expectedStatusMismatch({ expectedStatus: 'done', currentStatus: 'dropped' })).toBe(true);
  });
});

describe('completedGuardTrips — an automated cascade never downgrades finished work', () => {
  it('SKIPS done → dropped when the caller asked for the guard (the P-005 regression)', () => {
    expect(completedGuardTrips({ onlyIfNotCompleted: true, currentStatus: 'done', nextStatus: 'dropped' })).toBe(true);
  });

  // The complement of terminalGuardTrips' own contract: that guard owns terminal→NON-terminal,
  // this one owns done→dropped. Neither should widen into the other's territory.
  it('leaves every other transition to the other guards', () => {
    for (const nextStatus of ['todo', 'wip', 'blocked', 'needs-human', 'done']) {
      expect(
        completedGuardTrips({ onlyIfNotCompleted: true, currentStatus: 'done', nextStatus }),
        `done → ${nextStatus}`,
      ).toBe(false);
    }
    // A genuine abandonment of unfinished work must still cascade through.
    for (const currentStatus of ['todo', 'wip', 'blocked', 'needs-human', 'dropped']) {
      expect(
        completedGuardTrips({ onlyIfNotCompleted: true, currentStatus, nextStatus: 'dropped' }),
        `${currentStatus} → dropped`,
      ).toBe(false);
    }
  });

  // OPT-IN, exactly like terminalGuardTrips: a human deliberately reclassifying finished work
  // as abandoned omits the flag. If this ever inverts, that reclassification silently no-ops.
  it('is inert without the flag — a deliberate human reclassification is untouched', () => {
    expect(completedGuardTrips({ onlyIfNotCompleted: undefined, currentStatus: 'done', nextStatus: 'dropped' })).toBe(
      false,
    );
    expect(completedGuardTrips({ onlyIfNotCompleted: false, currentStatus: 'done', nextStatus: 'dropped' })).toBe(
      false,
    );
  });

  it('is inert when the item does not exist yet (no current status to protect)', () => {
    expect(completedGuardTrips({ onlyIfNotCompleted: true, currentStatus: null, nextStatus: 'dropped' })).toBe(false);
  });
});

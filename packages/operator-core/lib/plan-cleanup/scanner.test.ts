/**
 * plan-cleanup/scanner fixture tests (cleanup-report-flows-2026-08-24 P-003) —
 * one block per finding kind, exercising the pure pass with plain-row fixtures
 * (no Postgres). Also pins the scanner's local terminal-state copy to the
 * conversion plane's canonical set so the two can never drift apart silently.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARCHIVE_STALE_MS,
  DEFAULT_CLAIM_GRACE_MS,
  TERMINAL_WORK_ITEM_STATES_SCAN,
  scanForCleanupFindings,
  type CleanupFinding,
  type CleanupPlanInput,
  type CleanupPlanItemInput,
  type CleanupScanInputs,
  type LinkedWorkItemInput,
  type PlanItemClaimInput,
} from './scanner';
import { TERMINAL_WORK_ITEM_STATES } from '../plan-items/convert';

const NOW = Date.parse('2026-08-24T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function item(id: string, status: string, over: Partial<CleanupPlanItemInput> = {}): CleanupPlanItemInput {
  return { id, text: `item ${id}`, status, blockedBy: [], ...over };
}

function plan(over: Partial<CleanupPlanInput> = {}): CleanupPlanInput {
  return {
    workspaceId: 'ws',
    harnessSlug: 'h',
    planSlug: 'my-plan',
    title: 'My plan',
    status: 'active',
    opStatus: 'started',
    archived: false,
    updatedAtMs: NOW - HOUR,
    nowState: null,
    nowNext: null,
    items: [],
    ...over,
  };
}

function link(itemId: string, workItemId: string, state: string, over: Partial<LinkedWorkItemInput> = {}): LinkedWorkItemInput {
  return {
    planSlug: 'my-plan',
    itemId,
    workItemId,
    state,
    terminal: TERMINAL_WORK_ITEM_STATES_SCAN.has(state),
    hasCompletion: false,
    link: 'plan_item_stamp',
    ...over,
  };
}

function claim(itemId: string, over: Partial<PlanItemClaimInput> = {}): PlanItemClaimInput {
  return {
    planSlug: 'my-plan',
    itemId,
    owner: 'su-dead-owner',
    expiresAtMs: NOW - 2 * DEFAULT_CLAIM_GRACE_MS,
    holderAlive: false,
    ...over,
  };
}

function scan(inputs: Partial<CleanupScanInputs>, nowMs = NOW): CleanupFinding[] {
  return scanForCleanupFindings(
    { plans: [], linkedWorkItems: [], claims: [], ...inputs },
    { nowMs },
  );
}

function ofKind(findings: CleanupFinding[], kind: CleanupFinding['kind']): CleanupFinding[] {
  return findings.filter((f) => f.kind === kind);
}

describe('terminal-state pin', () => {
  it('keeps review identity across scan days but changes it for source and dependency edits', () => {
    const p = plan({ opStatus: null, updatedAtMs: NOW - 10 * 24 * HOUR,
      items: [item('P-001', 'done')] });
    const basis = (inputs: Partial<CleanupScanInputs>, at = NOW) =>
      ofKind(scan(inputs, at), 'archive-candidate')[0]?.evidenceBasis;
    const original = basis({ plans: [p] });
    expect(original?.[0]).toMatch(/^cleanup-source:[a-f0-9]{64}$/);
    expect(basis({ plans: [p] }, NOW + 24 * HOUR)).toEqual(original);
    expect(basis({ plans: [{ ...p, updatedAtMs: p.updatedAtMs! + 1 }] })).not.toEqual(original);
    expect(basis({ plans: [p], linkedWorkItems: [link('P-001', 'WI-1', 'done')] })).not.toEqual(original);
  });

  it("scanner's local terminal set is identical to the conversion plane's canonical set", () => {
    expect([...TERMINAL_WORK_ITEM_STATES_SCAN].sort()).toEqual([...TERMINAL_WORK_ITEM_STATES].sort());
  });
});

describe('enlist-plan', () => {
  it('carries owner-only selection into an enlistment proposal without hiding it from review', () => {
    const findings = ofKind(scan({ plans: [plan()], goalWorklist: {
      goalId: 'picked-goal', refs: ['plan:h/picked'], version: 16, ownerSelectionRequired: true,
    } }), 'enlist-plan');
    expect(findings).toHaveLength(1);
    expect(findings[0].action).toMatchObject({ ownerSelectionRequired: true, planRef: 'plan:h/my-plan' });
  });

  it('emits only the bounded highest-priority ready/active plans missing from the goal worklist', () => {
    const findings = scanForCleanupFindings({
      plans: [
        plan({ planSlug: 'priority-newer', status: 'ready', opPriority: 1, createdAtMs: NOW - HOUR }),
        plan({ planSlug: 'priority-older', status: 'active', opPriority: 1, createdAtMs: NOW - 2 * HOUR }),
        plan({ planSlug: 'later', status: 'active', opPriority: 2, createdAtMs: NOW - 3 * HOUR }),
        plan({ planSlug: 'draft-first', status: 'draft', opPriority: 0, createdAtMs: NOW - 4 * HOUR }),
        plan({ planSlug: 'already-qualified', status: 'active', opPriority: 0 }),
        plan({ planSlug: 'already-short', status: 'active', opPriority: 0 }),
        plan({ planSlug: 'archived-first', status: 'active', opPriority: 0, archived: true }),
      ],
      linkedWorkItems: [],
      claims: [],
      goalWorklist: {
        goalId: 'goal-everything',
        refs: ['plan:h/already-qualified', 'plan:already-short'],
        version: 7,
      },
    }, { nowMs: NOW, enlistPlanLimit: 2 });

    const enlistments = ofKind(findings, 'enlist-plan');
    expect(enlistments.map((finding) => finding.findingId)).toEqual([
      'enlist-plan:h/priority-older',
      'enlist-plan:h/priority-newer',
    ]);
    expect(enlistments.every((finding) => finding.autoApply)).toBe(true);
    expect(enlistments[0]?.action).toEqual({
      kind: 'enlist-plan',
      goalId: 'goal-everything',
      planRef: 'plan:h/priority-older',
      worklist: ['plan:h/already-qualified', 'plan:already-short'],
      expectedVersion: 7,
    });
  });
});

describe('flip-to-done', () => {
  it('fires provable for an open item whose linked work-item is done WITH a completion record', () => {
    const p = plan({ items: [item('P-001', 'todo'), item('P-002', 'todo')] });
    const findings = scan({
      plans: [p],
      linkedWorkItems: [link('P-001', 'WI-100', 'done', { hasCompletion: true })],
    });
    const flips = ofKind(findings, 'flip-to-done');
    expect(flips).toHaveLength(1);
    const f = flips[0];
    expect(f.itemId).toBe('P-001');
    expect(f.from).toBe('todo');
    expect(f.to).toBe('done');
    expect(f.confidence).toBe('provable');
    expect(f.autoApply).toBe(true);
    expect(f.autoApplyBlockedBy).toBeNull();
    expect(f.findingId).toBe('flip-to-done:h/my-plan#P-001');
    expect(f.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'work-item', ref: 'WI-100' }),
        expect.objectContaining({ kind: 'plan-item', ref: 'P-001' }),
      ]),
    );
  });

  it('downgrades to recommended when the done work-item has NO completion record', () => {
    const p = plan({ items: [item('P-001', 'wip')] });
    const findings = scan({
      plans: [p],
      linkedWorkItems: [link('P-001', 'WI-100', 'done', { hasCompletion: false })],
    });
    const [f] = ofKind(findings, 'flip-to-done');
    expect(f.confidence).toBe('recommended');
    expect(f.autoApply).toBe(false);
    expect(f.autoApplyBlockedBy).toBe('judgment-call');
  });

  it('is blocked by other OPEN coverage (a second non-terminal linked work-item)', () => {
    const p = plan({ items: [item('P-001', 'todo')] });
    const findings = scan({
      plans: [p],
      linkedWorkItems: [
        link('P-001', 'WI-100', 'done', { hasCompletion: true }),
        link('P-001', 'WI-101', 'open'),
      ],
    });
    expect(ofKind(findings, 'flip-to-done')).toHaveLength(0);
  });

  it('treats an UNRESOLVED non-terminal link as open coverage (conservative)', () => {
    const p = plan({ items: [item('P-001', 'todo')] });
    const findings = scan({
      plans: [p],
      linkedWorkItems: [
        link('P-001', 'WI-100', 'done', { hasCompletion: true }),
        link('P-001', 'WI-999', 'open', { state: null, terminal: false }),
      ],
    });
    expect(ofKind(findings, 'flip-to-done')).toHaveLength(0);
  });

  it('never touches a needs-human item', () => {
    const p = plan({ items: [item('P-001', 'needs-human')] });
    const findings = scan({
      plans: [p],
      linkedWorkItems: [link('P-001', 'WI-100', 'done', { hasCompletion: true })],
    });
    expect(ofKind(findings, 'flip-to-done')).toHaveLength(0);
  });

  it('withholds auto-apply (keeps provable) when live agents hold claims on the plan', () => {
    const p = plan({ items: [item('P-001', 'todo'), item('P-002', 'wip')] });
    const findings = scan({
      plans: [p],
      linkedWorkItems: [link('P-001', 'WI-100', 'done', { hasCompletion: true })],
      claims: [claim('P-002', { owner: 'su-live', holderAlive: true, expiresAtMs: NOW + HOUR })],
    });
    const [f] = ofKind(findings, 'flip-to-done');
    expect(f.confidence).toBe('provable');
    expect(f.autoApply).toBe(false);
    expect(f.autoApplyBlockedBy).toBe('live-agents');
    expect(f.evidence.some((e) => e.note.includes('su-live'))).toBe(true);
  });
});

describe('cleared-blocker', () => {
  it('fires provable for a blocked item whose every blocker is terminal', () => {
    const p = plan({
      items: [
        item('P-001', 'blocked', { blockedBy: ['P-002', 'P-003'] }),
        item('P-002', 'done'),
        item('P-003', 'dropped'),
      ],
    });
    const findings = scan({ plans: [p] });
    const cleared = ofKind(findings, 'cleared-blocker');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].itemId).toBe('P-001');
    expect(cleared[0].to).toBe('todo');
    expect(cleared[0].confidence).toBe('provable');
    expect(cleared[0].evidence).toHaveLength(2);
  });

  it('does not fire while any blocker is still open', () => {
    const p = plan({
      items: [item('P-001', 'blocked', { blockedBy: ['P-002'] }), item('P-002', 'wip')],
    });
    expect(ofKind(scan({ plans: [p] }), 'cleared-blocker')).toHaveLength(0);
  });

  it('does not fire on an unresolvable blocker ref (left for the semantic resolver)', () => {
    const p = plan({ items: [item('P-001', 'blocked', { blockedBy: ['WI-777'] })] });
    expect(ofKind(scan({ plans: [p] }), 'cleared-blocker')).toHaveLength(0);
  });

  it('is superseded by flip-to-done on the same item', () => {
    const p = plan({
      items: [item('P-001', 'blocked', { blockedBy: ['P-002'] }), item('P-002', 'done')],
    });
    const findings = scan({
      plans: [p],
      linkedWorkItems: [link('P-001', 'WI-100', 'done', { hasCompletion: true })],
    });
    expect(ofKind(findings, 'flip-to-done')).toHaveLength(1);
    expect(ofKind(findings, 'cleared-blocker')).toHaveLength(0);
  });
});

describe('finish-plan', () => {
  it("fires provable for a started plan whose items are ALL terminal", () => {
    const p = plan({ items: [item('P-001', 'done'), item('P-002', 'dropped')] });
    const findings = scan({ plans: [p] });
    const fin = ofKind(findings, 'finish-plan');
    expect(fin).toHaveLength(1);
    expect(fin[0].itemId).toBeNull();
    expect(fin[0].to).toBe("op_status='done'");
    expect(fin[0].confidence).toBe('provable');
    expect(fin[0].evidence[0].note).toContain('2 item(s) terminal');
  });

  it('does not fire while any item is open, when the plan is not started, or with zero items', () => {
    expect(ofKind(scan({ plans: [plan({ items: [item('P-001', 'done'), item('P-002', 'todo')] })] }), 'finish-plan')).toHaveLength(0);
    expect(ofKind(scan({ plans: [plan({ opStatus: null, items: [item('P-001', 'done')] })] }), 'finish-plan')).toHaveLength(0);
    expect(ofKind(scan({ plans: [plan({ items: [] })] }), 'finish-plan')).toHaveLength(0);
  });
});

describe('orphaned-claim', () => {
  it('fires provable for a lapsed claim with a dead holder', () => {
    const p = plan({ items: [item('P-001', 'wip')] });
    const findings = scan({ plans: [p], claims: [claim('P-001')] });
    const orphaned = ofKind(findings, 'orphaned-claim');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].itemId).toBe('P-001');
    expect(orphaned[0].from).toBe('claimed by su-dead-owner');
    expect(orphaned[0].confidence).toBe('provable');
    expect(orphaned[0].autoApply).toBe(true);
    expect(orphaned[0].evidence[0]).toMatchObject({ kind: 'claim', ref: 'su-dead-owner' });
  });

  it('does not fire inside the grace window, and never for a live holder', () => {
    const p = plan({ items: [item('P-001', 'wip')] });
    expect(
      ofKind(scan({ plans: [p], claims: [claim('P-001', { expiresAtMs: NOW - DEFAULT_CLAIM_GRACE_MS / 2 })] }), 'orphaned-claim'),
    ).toHaveLength(0);
    expect(
      ofKind(scan({ plans: [p], claims: [claim('P-001', { holderAlive: true })] }), 'orphaned-claim'),
    ).toHaveLength(0);
  });
});

describe('stale-now', () => {
  it('withholds judgment findings while a live agent holds the plan', () => {
    const p = plan({ nowState: 'P-001 is complete.', nowNext: 'Ship P-001.',
      items: [item('P-001', 'done'), item('P-002', 'todo')] });
    const stale = ofKind(scan({ plans: [p], claims: [claim('P-002', { holderAlive: true })] }), 'stale-now');
    expect(stale).toHaveLength(1);
    expect(stale[0].autoApplyBlockedBy).toBe('live-agents');
    expect(stale[0].evidence.some((ref) => ref.note?.includes('live agent'))).toBe(true);
  });

  it('recommends a rewrite when ## Now references ONLY terminal items while open work exists', () => {
    const p = plan({
      nowState: 'Landed P-001 and P-002; wrapping up.',
      nowNext: 'Ship P-002.',
      items: [item('P-001', 'done'), item('P-002', 'dropped'), item('P-003', 'todo')],
    });
    const findings = scan({ plans: [p] });
    const stale = ofKind(findings, 'stale-now');
    expect(stale).toHaveLength(1);
    expect(stale[0].confidence).toBe('recommended');
    expect(stale[0].autoApply).toBe(false);
    expect(stale[0].autoApplyBlockedBy).toBe('judgment-call');
    expect(stale[0].evidence.map((e) => e.ref).sort()).toEqual(['P-001', 'P-002']);
  });

  it('does not fire when ## Now references an open item, has no refs, or the plan has no open items', () => {
    expect(
      ofKind(scan({ plans: [plan({ nowState: 'Working P-003.', items: [item('P-003', 'todo')] })] }), 'stale-now'),
    ).toHaveLength(0);
    expect(
      ofKind(scan({ plans: [plan({ nowState: 'No refs here.', items: [item('P-001', 'todo')] })] }), 'stale-now'),
    ).toHaveLength(0);
    expect(
      ofKind(scan({ plans: [plan({ nowState: 'Did P-001.', items: [item('P-001', 'done')] })] }), 'stale-now'),
    ).toHaveLength(0);
  });
});

describe('archive-candidate', () => {
  const doneItems = [item('P-001', 'done'), item('P-002', 'dropped')];

  it('recommends archiving an all-terminal, not-started, long-untouched, claim-free plan', () => {
    const p = plan({ opStatus: 'done', items: doneItems, updatedAtMs: NOW - DEFAULT_ARCHIVE_STALE_MS - HOUR });
    const findings = scan({ plans: [p] });
    const arch = ofKind(findings, 'archive-candidate');
    expect(arch).toHaveLength(1);
    expect(arch[0].confidence).toBe('recommended');
    expect(arch[0].autoApply).toBe(false);
    expect(arch[0].evidence[0].note).toMatch(/untouched \d+d/);
  });

  it('does not fire when recently touched, still started, holding claims, or already archived', () => {
    expect(
      ofKind(scan({ plans: [plan({ opStatus: 'done', items: doneItems, updatedAtMs: NOW - HOUR })] }), 'archive-candidate'),
    ).toHaveLength(0);
    expect(
      ofKind(
        scan({ plans: [plan({ opStatus: 'started', items: doneItems, updatedAtMs: NOW - DEFAULT_ARCHIVE_STALE_MS - HOUR })] }),
        'archive-candidate',
      ),
    ).toHaveLength(0);
    expect(
      ofKind(
        scan({
          plans: [plan({ opStatus: 'done', items: doneItems, updatedAtMs: NOW - DEFAULT_ARCHIVE_STALE_MS - HOUR })],
          claims: [claim('P-001', { holderAlive: true, expiresAtMs: NOW + HOUR })],
        }),
        'archive-candidate',
      ),
    ).toHaveLength(0);
    expect(
      scan({ plans: [plan({ archived: true, opStatus: 'done', items: doneItems, updatedAtMs: NOW - DEFAULT_ARCHIVE_STALE_MS - HOUR })] }),
    ).toHaveLength(0);
  });
});

describe('determinism + ordering', () => {
  it('same inputs produce byte-identical findings in stable (plan, kind, item) order', () => {
    const inputs: CleanupScanInputs = {
      plans: [
        plan({ planSlug: 'zz-plan', items: [item('P-001', 'done'), item('P-002', 'dropped')] }),
        plan({
          planSlug: 'aa-plan',
          items: [
            item('P-002', 'todo'),
            item('P-001', 'blocked', { blockedBy: ['P-002'] }),
          ],
        }),
      ],
      linkedWorkItems: [
        { ...link('P-002', 'WI-1', 'done', { hasCompletion: true }), planSlug: 'aa-plan' },
      ],
      claims: [{ ...claim('P-001'), planSlug: 'aa-plan' }],
    };
    const a = scanForCleanupFindings(inputs, { nowMs: NOW });
    const b = scanForCleanupFindings(inputs, { nowMs: NOW });
    expect(a).toEqual(b);
    expect(a.map((f) => f.findingId)).toEqual([
      'flip-to-done:h/aa-plan#P-002',
      'orphaned-claim:h/aa-plan#P-001',
      'finish-plan:h/zz-plan',
    ]);
  });
});

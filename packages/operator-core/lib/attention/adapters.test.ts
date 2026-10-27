import { describe, it, expect } from 'vitest';
import {
  applyTriage,
  importanceRank,
  sortByImportance,
  severityToImportance,
  severityToRiskTier,
  riskTierIsDecision,
  DECISION_RISK_TIER,
  ATTENTION_KIND_CATEGORY,
  attentionCategory,
  type AttentionItem,
  type AttentionKind,
} from './types';
import {
  planItemToAttention,
  coordEscalationToAttention,
  coordMessageToAttention,
  smokeFailToAttention,
  improvementToAttention,
  standingApprovalToAttention,
  conversationToAttention,
  scoutGradeToAttention,
  isOperationalEscalation,
  workItemNeedsHumanToAttention,
  ownerWallToAttention,
  darkFlagRatificationToAttention,
  blockedSessionToAttention,
  blockedWorkItemToAttention,
  decisionOwedToAttention,
} from './adapters';
import { dropDuplicateNeedsHumanWorkItems, dropDuplicateBlockedWorkItems } from './sources';
import { isAutonomyCategory } from '../autonomy/categories';

describe('importance helpers', () => {
  it('ranks urgent→low ascending', () => {
    expect(importanceRank('urgent')).toBeLessThan(importanceRank('high'));
    expect(importanceRank('high')).toBeLessThan(importanceRank('normal'));
    expect(importanceRank('normal')).toBeLessThan(importanceRank('low'));
  });

  it('sortByImportance is stable within a level', () => {
    const items = [
      { id: 'a', importance: 'normal' as const },
      { id: 'b', importance: 'urgent' as const },
      { id: 'c', importance: 'normal' as const },
      { id: 'd', importance: 'high' as const },
    ];
    expect(sortByImportance(items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('maps severity to importance (blocker→urgent, question→high, advisory→low)', () => {
    expect(severityToImportance('blocker')).toBe('urgent');
    expect(severityToImportance('question')).toBe('high');
    expect(severityToImportance('advisory')).toBe('low');
  });
});

describe('P-013 — escalation severity folds into risk_tier', () => {
  it('maps severity to risk_tier (blocker→critical, question→high, advisory→low)', () => {
    expect(severityToRiskTier('blocker')).toBe('critical');
    expect(severityToRiskTier('question')).toBe('high');
    expect(severityToRiskTier('advisory')).toBe('low');
  });

  it('risk_tier ⊥ importance: the two axes derive from severity INDEPENDENTLY (P-014)', () => {
    // blocker: importance urgent, but risk critical — different bands, same input.
    expect(severityToImportance('blocker')).toBe('urgent');
    expect(severityToRiskTier('blocker')).toBe('critical');
  });

  it('riskTierIsDecision splits at the moderate threshold (advisory=alert, else decision)', () => {
    expect(DECISION_RISK_TIER).toBe('moderate');
    expect(riskTierIsDecision('low')).toBe(false); // advisory → alert
    expect(riskTierIsDecision('moderate')).toBe(true);
    expect(riskTierIsDecision('high')).toBe(true); // question → decision
    expect(riskTierIsDecision('critical')).toBe(true); // blocker → decision
  });

  it('the escalation tier is now DERIVED from risk_tier (one scale, not two)', () => {
    // The adapter computes tier = riskTierIsDecision(severityToRiskTier(sev)) — assert
    // the live tier matches that fold for every severity (and stays behavior-neutral).
    for (const sev of ['blocker', 'question', 'advisory'] as const) {
      const a = coordEscalationToAttention({ msgId: `m-${sev}`, severity: sev, summary: 's' });
      const expected = riskTierIsDecision(severityToRiskTier(sev)) ? 'decision' : 'alert';
      expect(a.tier).toBe(expected);
    }
  });

  it('D-005: a SYSTEM-emitted escalation with no options is an ALERT, not a decision (cursed-placement flood)', () => {
    // placement-watchdog cursed placements escalate as a blocker from the REAL owner
    // `system:hive-placement-watchdog` (NOT bare `system`) but carry NO options —
    // operational, not a human decision. Without this, ~7000 open cursed-placement
    // escalations flooded the "waiting on you" decision tier.
    const sys = coordEscalationToAttention({
      msgId: 'm-sys',
      severity: 'blocker',
      summary: 'Cursed placement: F-X failed 301×',
      from: 'system:hive-placement-watchdog',
    });
    expect(sys.tier).toBe('alert');
    expect(sys.needsHuman).toBe(false);
    // bare `system` (e.g. aging sweeps) is operational too.
    expect(
      coordEscalationToAttention({ msgId: 'm-sys0', severity: 'blocker', summary: 's', from: 'system' }).tier,
    ).toBe('alert');
    // D-006 ext 1: named automated infra bots (green-checkpoint CI) are operational too.
    expect(
      coordEscalationToAttention({
        msgId: 'm-gc',
        severity: 'blocker',
        summary: 'green-checkpoint held',
        from: 'green-checkpoint',
      }).tier,
    ).toBe('alert');
    // A system escalation that DOES carry a choice stays a decision.
    const sysChoice = coordEscalationToAttention({
      msgId: 'm-sys2',
      severity: 'blocker',
      summary: 's',
      from: 'system:hive-placement-watchdog',
      options: [{ id: 'a', label: 'A' }],
    });
    expect(sysChoice.tier).toBe('decision');
    // A genuine agent escalation (non-system) is unchanged → decision.
    const agent = coordEscalationToAttention({ msgId: 'm-ag', severity: 'blocker', summary: 's', from: 'bee-7' });
    expect(agent.tier).toBe('decision');
  });
});

describe('planItemToAttention — tier + needsHuman (D-001/D-002/D-006)', () => {
  const base = {
    slug: 'p-2026-05-31',
    harnessSlug: 'papercup',
    id: 'P-007',
    text: 'Sign off before ship',
    storedStatus: 'needs-human',
    effectiveStatus: 'needs-human',
    importance: 'urgent' as const,
  };

  it('needs-human → decision tier + the full Answer/Resolve/Drop/Chat/Message-owner toolkit', () => {
    const a = planItemToAttention(base);
    expect(a.kind).toBe('plan-item');
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.triageState).toBe('untriaged');
    expect(a.actions.map((x) => x.id)).toEqual(['answer', 'mark-done', 'drop', 'chat', 'message-owner']);
    expect(a.actions.find((x) => x.id === 'mark-done')?.primary).toBe(true);
    expect(a.ref).toEqual({
      kind: 'plan-item',
      slug: 'p-2026-05-31',
      itemId: 'P-007',
      harnessSlug: 'papercup',
      priorStatus: 'needs-human',
    });
  });

  it('blocked → alert tier (not a decision), Chat + Message owner only', () => {
    const a = planItemToAttention({
      ...base,
      storedStatus: 'blocked',
      effectiveStatus: 'blocked',
      importance: 'normal',
    });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat', 'message-owner']);
  });

  it('todo → activity tier, not needs-human', () => {
    const a = planItemToAttention({ ...base, storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat', 'message-owner']);
  });

  it('carries an explicit owner when resolved', () => {
    const a = planItemToAttention({ ...base, ownerAgentId: 'su-worker', ownerLabel: 'worker' });
    expect(a.ownerAgentId).toBe('su-worker');
    expect(a.ownerLabel).toBe('worker');
  });
});

describe('coordEscalationToAttention — severity → tier', () => {
  it('blocker → decision (urgent), resolvable, owner from `from`', () => {
    const a = coordEscalationToAttention({
      msgId: 'm-1',
      severity: 'blocker',
      summary: 'Which auth lib?',
      harnessSlug: 'papercup',
      from: 'su-architect',
      options: [
        { id: 'authjs', label: 'Auth.js' },
        { id: 'lucia', label: 'Lucia' },
      ],
    });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('urgent');
    expect(a.ownerAgentId).toBe('su-architect');
    expect(a.actions.map((x) => x.id)).toEqual(['resolve', 'discuss']);
    if (a.ref.kind === 'coord-escalation') expect(a.ref.options).toHaveLength(2);
  });

  it('question → decision (this is where ask-owner lands)', () => {
    const a = coordEscalationToAttention({ msgId: 'm-q', severity: 'question', summary: 'ok to proceed?' });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('high');
    // No harness → no Chat, but Message owner is always offered.
    expect(a.actions.map((x) => x.id)).toEqual(['resolve', 'discuss']);
  });

  it('advisory → alert (FYI, not a decision)', () => {
    const a = coordEscalationToAttention({ msgId: 'm-a', severity: 'advisory', summary: 'heads up' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.importance).toBe('low');
  });
});

describe('coordMessageToAttention — structured classification (D-003)', () => {
  it('a plain broadcast FYI → activity, not needs-human', () => {
    const a = coordMessageToAttention({ msgId: 'm-2', summary: 'apps/tui is GREEN again', harnessSlug: 'papercup' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['ack', 'discuss']);
  });

  it('an auto lifecycle broadcast → activity (the over-flagging fix)', () => {
    const a = coordMessageToAttention({ msgId: 'm-3', summary: '▶ now working on X', auto: true, lifecycle: 'intent' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });

  it('lifecycle marker alone (no auto flag) still → activity', () => {
    const a = coordMessageToAttention({ msgId: 'm-3b', summary: '✅ done', lifecycle: 'completion' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });

  it('a non-auto message addressed directly to the human → alert, NOT a decision (P-102: a message is a communication, ack-only; decisions route through escalations)', () => {
    const a = coordMessageToAttention({
      msgId: 'm-4',
      summary: 'can you confirm the rename?',
      directToOwner: true,
      from: 'su-worker',
    });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.ownerAgentId).toBe('su-worker');
    // disposition stays ACK (a communication), never resolve-with-choice.
    expect(a.actions.some((x) => x.id === 'ack')).toBe(true);
  });

  it('an auto message addressed to the human is STILL activity (lifecycle wins)', () => {
    const a = coordMessageToAttention({
      msgId: 'm-5',
      summary: '✅ done',
      auto: true,
      lifecycle: 'completion',
      directToOwner: true,
    });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });
});

describe('coordMessageToAttention — report card payload (agent-report-cards P-002)', () => {
  const fleetUpdate = {
    title: 'Fleet update',
    plans: [
      {
        title: 'p2p-public-release',
        status: 'wip',
        items: [
          { id: 'P-003', text: 'remaining lanes', status: 'done' },
          { text: 'bg-host residual CPU load', status: 'wip' },
        ],
      },
    ],
  };

  it('stamps the validated ReportBlock onto the item (the card the detail pane renders)', () => {
    const a = coordMessageToAttention({
      msgId: 'm-r1',
      summary: '📋 Fleet update — 2 progressed',
      directToOwner: true,
      report: fleetUpdate,
    });
    expect(a.report).toBeDefined();
    expect(a.report?.title).toBe('Fleet update');
    expect(a.report?.plans[0]?.items?.length).toBe(2);
  });

  it('body falls back to the plain-text report rendition when the message has no body', () => {
    const a = coordMessageToAttention({
      msgId: 'm-r2',
      summary: '📋 Fleet update',
      report: fleetUpdate,
    });
    expect(a.body).toContain('p2p-public-release');
    expect(a.body).toContain('P-003');
    // …but the sender's own prose always wins when present.
    const b = coordMessageToAttention({
      msgId: 'm-r3',
      summary: '📋 Fleet update',
      body: 'my own prose',
      report: fleetUpdate,
    });
    expect(b.body).toBe('my own prose');
  });

  it('a clean report (no red statuses) on a broadcast stays activity — no elevation', () => {
    const a = coordMessageToAttention({ msgId: 'm-r4', summary: 'status', report: fleetUpdate });
    expect(a.tier).toBe('activity');
  });

  it('blocked/failing report statuses elevate a broadcast to alert (D-003)', () => {
    const a = coordMessageToAttention({
      msgId: 'm-r5',
      summary: 'status',
      report: { plans: [{ title: 'lane', items: [{ text: 'stuck on deploy', status: 'blocked' }] }] },
    });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
  });

  it('a needs-human report status CAPS at alert — a message is ack-only, never a decision (P-102/D-011)', () => {
    const a = coordMessageToAttention({
      msgId: 'm-r6',
      summary: 'status',
      directToOwner: true,
      report: { plans: [{ title: 'lane', status: 'needs-human' }] },
    });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.some((x) => x.id === 'ack')).toBe(true);
  });

  it('an auto lifecycle broadcast is NOT elevated by its report (lifecycle wins, matching the D-003 rule)', () => {
    const a = coordMessageToAttention({
      msgId: 'm-r7',
      summary: 'status',
      auto: true,
      lifecycle: 'completion',
      report: { plans: [{ title: 'lane', status: 'blocked' }] },
    });
    expect(a.tier).toBe('activity');
  });

  it('an invalid/foreign report payload degrades to a plain message — no report field, tier unchanged', () => {
    const a = coordMessageToAttention({
      msgId: 'm-r8',
      summary: 'weird row',
      report: { plans: [{ status: 'done' }] }, // no title/slug on any plan → parseReportBlock null
    });
    expect(a.report).toBeUndefined();
    expect(a.tier).toBe('activity');
    expect(a.body).toBe('weird row'); // summary fallback, not a rendition of nothing
  });
});

describe('smokeFailToAttention — alert tier', () => {
  it('is an alert (a problem to surface), not a decision', () => {
    const a = smokeFailToAttention({ harnessSlug: 'papercup', failureContent: 'boot crashed' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.body).toContain('boot crashed');
    // P-003: `ack` is the acknowledgement-class terminal — an operator cannot make
    // a past smoke run pass, so acknowledging that it was seen is the honest end
    // of the CARD (fixing it is engineering work with its own work-item).
    expect(a.actions.map((x) => x.id)).toEqual(['view-log', 'ack', 'discuss']);
  });
});

describe('unified shape invariants', () => {
  it('every adapter: unique-prefixed id, ref kind matches, needsHuman===decision, untriaged default, a discuss/message-owner action present', () => {
    const items: AttentionItem[] = [
      planItemToAttention({
        slug: 's',
        harnessSlug: null,
        id: 'P-001',
        text: 't',
        storedStatus: 'todo',
        effectiveStatus: 'todo',
        importance: 'normal',
      }),
      coordEscalationToAttention({ msgId: 'm', severity: 'question', summary: 's' }),
      coordMessageToAttention({ msgId: 'm', summary: 's' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
    ];
    for (const it of items) {
      expect(it.id.startsWith(`${it.kind}:`)).toBe(true);
      expect(it.ref.kind).toBe(it.kind);
      expect(it.actions.length).toBeGreaterThan(0);
      expect(it.needsHuman).toBe(it.tier === 'decision');
      expect(it.triageState).toBe('untriaged');
      expect(it.actions.some((a) => a.id === 'message-owner' || a.id === 'discuss')).toBe(true);
    }
  });
});

describe('needsHuman drops at the source (Brief 21 — the 62→12 intent)', () => {
  it('a representative feed leaves only genuine decisions as needs-human', () => {
    const items: AttentionItem[] = [
      // ── noise: auto lifecycle broadcasts (the bulk of the old false positives)
      ...Array.from({ length: 10 }, (_, i) =>
        coordMessageToAttention({ msgId: `auto-${i}`, summary: '▶ now working on', auto: true, lifecycle: 'intent' }),
      ),
      // ── alerts (surface, but not decisions)
      coordEscalationToAttention({ msgId: 'adv', severity: 'advisory', summary: 'fyi' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
      planItemToAttention({
        slug: 's',
        harnessSlug: 'h',
        id: 'P-9',
        text: 'stuck',
        storedStatus: 'blocked',
        effectiveStatus: 'blocked',
        importance: 'normal',
      }),
      // ── activity (normal work)
      ...Array.from({ length: 3 }, (_, i) =>
        planItemToAttention({
          slug: 's',
          harnessSlug: 'h',
          id: `P-${i}`,
          text: 'work',
          storedStatus: 'todo',
          effectiveStatus: 'todo',
          importance: 'normal',
        }),
      ),
      // ── genuine decisions
      planItemToAttention({
        slug: 's',
        harnessSlug: 'h',
        id: 'P-NH',
        text: 'sign off',
        storedStatus: 'needs-human',
        effectiveStatus: 'needs-human',
        importance: 'urgent',
      }),
      coordEscalationToAttention({ msgId: 'blk', severity: 'blocker', summary: 'blocked decision' }),
      coordEscalationToAttention({ msgId: 'ask', severity: 'question', summary: 'ask-owner question' }),
    ];
    const needsHuman = items.filter((i) => i.needsHuman);
    // 19 items, only the 3 genuine decisions await the human (the needs-human
    // plan item + the blocker + the question escalation; plan-review retired P-101).
    expect(items.length).toBe(19);
    expect(needsHuman.length).toBe(3);
    expect(needsHuman.every((i) => i.tier === 'decision')).toBe(true);
  });
});

describe('P-100 — folded disposition channels (B-14 / D-011)', () => {
  it('improvement: a human-routed improvement is a Decision (ideation-intake)', () => {
    const a = improvementToAttention({
      issueId: 'EI-42',
      title: 'fix the thing',
      severity: 'major',
      harnessSlug: 'papercup',
      ideaLifecycle: { state: 'open' },
    });
    expect(a.kind).toBe('improvement');
    expect(a.category).toBe('ideation-intake');
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('high'); // major → high
    expect(a.id).toBe('improvement:EI-42');
    expect(a.ref).toEqual({
      kind: 'improvement',
      issueId: 'EI-42',
      harnessSlug: 'papercup',
      priorIdeaLifecycle: { state: 'open' },
      priorDecidedReason: null,
    });
    // D-027 follow-on (1): Triage navigate (full place/gate/gym surface) + inline Dismiss (reject).
    expect(a.actions.map((x) => x.id)).toEqual(['open', 'dismiss']);
  });

  it('standing-approval is a Decision in the PROTECTED system-control category (never-auto)', () => {
    const a = standingApprovalToAttention({ capability: 'harness:write', targetHarness: 'sheets', count: 4 });
    expect(a.kind).toBe('standing-approval');
    expect(a.category).toBe('system-control'); // protected: the Queen can never auto-grant herself this
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.harnessSlug).toBe('sheets');
    expect(a.id).toBe('standing-approval:harness:write:sheets');
    expect(a.ref).toEqual({ kind: 'standing-approval', capability: 'harness:write', targetHarness: 'sheets' });
    // D-027 follow-on (1): inline terminal grant/dismiss (no navigate-to-source).
    expect(a.actions.map((x) => x.id)).toEqual(['grant', 'dismiss']);
    expect(a.actions.find((x) => x.id === 'grant')?.primary).toBe(true);
  });

  it('conversation: an open question is an Alert (surfaced, not demanded), escalations category', () => {
    const a = conversationToAttention({
      conversationId: 'CONV-7',
      title: 'which approach?',
      askerId: 'su-abc',
      harnessSlug: 'h',
    });
    expect(a.kind).toBe('conversation');
    expect(a.category).toBe('escalations');
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.ownerAgentId).toBe('su-abc');
    expect(a.ref).toEqual({ kind: 'conversation', conversationId: 'CONV-7' });
    // Carries Message owner (it has an asking agent), unlike improvement/scout.
    expect(a.actions.some((x) => x.id === 'discuss')).toBe(true);
    // D-027 follow-on (1): the primary action is now inline Answer (a navigate id
    // that reveals the InputCard → conversations:resolve), not navigate-to-source.
    expect(a.actions[0]).toMatchObject({ id: 'answer', primary: true });
  });

  it('scout-grade: ONE Activity-tier rollup (optional feedback, never per-idea)', () => {
    const a = scoutGradeToAttention({ count: 12 });
    expect(a.kind).toBe('scout-grade');
    expect(a.category).toBe('ideation-intake');
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.importance).toBe('low');
    expect(a.id).toBe('scout-grade:pending'); // stable singleton id (rollup)
    expect(a.title).toContain('12 Scout ideas');
    expect(scoutGradeToAttention({ count: 1 }).title).toContain('1 Scout idea ');
  });

  it('all four: id is kind-prefixed, ref.kind matches, needsHuman === (tier === decision)', () => {
    const items: AttentionItem[] = [
      improvementToAttention({ issueId: 'EI-1', title: 't' }),
      standingApprovalToAttention({ capability: 'c', targetHarness: 'h', count: 3 }),
      conversationToAttention({ conversationId: 'CONV-1', title: 'q' }),
      scoutGradeToAttention({ count: 5 }),
    ];
    for (const it of items) {
      expect(it.id.startsWith(`${it.kind}:`)).toBe(true);
      expect(it.ref.kind).toBe(it.kind);
      expect(it.actions.length).toBeGreaterThan(0);
      expect(it.needsHuman).toBe(it.tier === 'decision');
      expect(it.triageState).toBe('untriaged');
      expect(it.category).toBe(attentionCategory(it.kind));
    }
  });
});

describe('P-005 — the folded owner-gate channels (owner-inbox-single-pane-2026-07-17)', () => {
  it('work-item-needs-human: a Decision, plan-governance category, kind-aware status/body', () => {
    const a = workItemNeedsHumanToAttention({
      workItemId: 'WI-9001',
      itemKind: 'bug',
      title: 'connector auth broke',
      body: 'the token refresh path 401s',
      harnessSlug: 'papercusp',
      ownerAgentId: 'su-abc',
      status: 'blocked',
      ownerGateKeys: ['needsHuman'],
    });
    expect(a.kind).toBe('work-item-needs-human');
    expect(a.category).toBe('plan-governance');
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.status).toBe('needs-human (bug)');
    expect(a.id).toBe('work-item-needs-human:WI-9001');
    expect(a.ownerAgentId).toBe('su-abc');
    // P-003 added the two TERMINAL actions. Before them every action here was a
    // navigate, so the single largest population in the owner's inbox could be
    // opened, discussed or answered — but never ended, by click or by resolver.
    expect(a.actions.map((action) => [action.id, action.label, action.primary ?? false])).toEqual([
      ['answer', 'Answer', true],
      ['resolve', 'Release to agents', false],
      ['drop', 'Drop', false],
      ['open', 'Open work item', false],
      ['discuss', 'Discuss', false],
    ]);
    // `ownerGate` records WHICH leg of the source query admitted the row, because
    // the two are cleared differently (status vs payload keys).
    expect(a.ref).toEqual({
      kind: 'work-item-needs-human',
      workItemId: 'WI-9001',
      itemKind: 'bug',
      ownerGate: 'payload',
      harnessSlug: 'papercusp',
      priorStatus: 'blocked',
      ownerGateKeys: ['needsHuman'],
    });
  });

  it('work-item-needs-human: falls back to title as body when body is blank', () => {
    const a = workItemNeedsHumanToAttention({ workItemId: 'F-1', itemKind: 'feature', title: 'ship it' });
    expect(a.body).toBe('ship it');
    // No asker to answer, so the owner-gate CLEAR becomes the primary action
    // rather than a navigate to the source (P-003).
    expect(a.actions.map((action) => action.label)).toEqual(['Release to agents', 'Drop', 'Open source', 'Discuss']);
    expect(a.actions[0]?.primary).toBe(true);
  });

  /* WI-6597 — itemRef was hardcoded null here, which made the HUD Work-items
     board's ask-vs-work-item dedupe inert (its `!a.itemRef ||` disjunct was true
     for 60/60 live cards, so every needs-human item rendered TWICE in the same
     column), degraded the card's `ref` to the kind label "Work item", and left a
     curator `wi:<ref>` drill-in with nothing to match. */
  it('work-item-needs-human: carries the item id in itemRef, HARNESS-QUALIFIED', () => {
    const a = workItemNeedsHumanToAttention({
      workItemId: 'WI-9001',
      itemKind: 'bug',
      title: 'connector auth broke',
      harnessSlug: 'papercusp',
    });
    // The curator's own shape (`papercusp#WI-6594`) — a work-item lookup is
    // harness-scoped, so a bare id is not resolvable on a cross-harness surface.
    expect(a.itemRef).toBe('papercusp#WI-9001');
  });

  it('work-item-needs-human: falls back to the bare id when no harness is known', () => {
    const a = workItemNeedsHumanToAttention({ workItemId: 'EI-42', itemKind: 'bug', title: 't' });
    // Still populated: a null here is what made the downstream guard inert.
    expect(a.itemRef).toBe('EI-42');
  });

  it('owner-wall: a Decision; stranded status appends a respawn note to the body', () => {
    const waiting = ownerWallToAttention({
      source: 'loop-carry-note',
      ownerId: 'su-xyz',
      claim: 'pick account routing: default vs auto?',
      recheck: 'accounts:status',
      waitingHours: 5,
      status: 'waiting',
    });
    expect(waiting.kind).toBe('owner-wall');
    expect(waiting.category).toBe('plan-governance');
    expect(waiting.needsHuman).toBe(true);
    expect(waiting.importance).toBe('urgent'); // >= 4h
    expect(waiting.body).toContain('Recheck: accounts:status');
    expect(waiting.body).not.toContain('STRANDED');
    // P-003: 'Clear wall' is the terminal every branch of this adapter lacked —
    // a registered wall could previously only be talked about, never ended.
    expect(waiting.actions.map((action) => action.label)).toEqual([
      'Answer',
      'Clear wall',
      'Open agent session',
      'Discuss',
    ]);

    const stranded = ownerWallToAttention({
      source: 'work-item',
      ownerId: 'su-xyz',
      claim: 'ratify migration',
      ref: 'WI-42',
      waitingHours: 0.5,
      status: 'stranded',
    });
    expect(stranded.importance).toBe('normal'); // < 1h
    expect(stranded.body).toContain('STRANDED');
    // A STRANDED wall is exactly the case that most needs a terminal: its agent is
    // gone, so answering it would reach nobody and it would otherwise sit in the
    // inbox forever. Its ref names a work-item, so 'Clear wall' clears that item's
    // owner gate rather than merely recording an acknowledgement (P-003).
    expect(stranded.actions.map((action) => action.label)).toEqual(['Open source', 'Clear wall', 'Discuss']);
    expect(stranded.ref).toEqual({
      kind: 'owner-wall',
      wallSource: 'work-item',
      wallOwnerId: 'su-xyz',
      wallRef: 'WI-42',
    });
  });

  it('owner-wall: triage is scoped to a loop wall claim version', () => {
    const shared = {
      source: 'loop-carry-note' as const,
      ownerId: 'su-loop-owner',
      ref: 'loop:papercusp:su-loop-owner',
      recheck: 'recheck the active gate',
      status: 'waiting' as const,
    };
    const oldRouteWall = ownerWallToAttention({ ...shared, claim: 'Use the previous route' });
    const currentHoldWall = ownerWallToAttention({ ...shared, claim: 'Resolve the current headroom hold' });
    const resolved = {
      action: 'resolve' as const,
      note: 'cleared the previous route wall',
      triagedBy: 'operator',
      triagedAt: null,
    };
    const triageById = new Map([[oldRouteWall.id, resolved]]);
    const surfaced = [oldRouteWall, currentHoldWall].map((item) => {
      const record = triageById.get(item.id);
      return record ? applyTriage(item, record) : item;
    });

    expect(oldRouteWall.id).not.toBe(currentHoldWall.id);
    expect(ownerWallToAttention({ ...shared, claim: 'Use the previous route' }).id).toBe(oldRouteWall.id);
    expect(surfaced.map((item) => item.triageState)).toEqual(['resolved', 'untriaged']);
    expect(surfaced[1]?.tier).toBe('decision');
  });

  it('owner-wall: an explicit non-actionable oracle verdict demotes a stale row to an Alert', () => {
    const a = ownerWallToAttention({
      source: 'loop-carry-note',
      ownerId: 'su-ended',
      claim: 'answer the parked question',
      waitingHours: 8,
      // The source status can be stale while an independently-read oracle says
      // the owner is ended; the oracle classification wins at read time.
      status: 'waiting',
      actionability: 'non-actionable',
      livenessState: 'ended',
    });

    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.status).toBe('stranded');
    expect(a.body).toContain('STRANDED');
    expect(a.actions.some((action) => action.id === 'answer')).toBe(false);
  });

  it('owner-wall: unknown liveness remains visible but is not counted as waiting on the owner', () => {
    const a = ownerWallToAttention({
      source: 'loop-carry-note',
      ownerId: 'su-unknown',
      claim: 'resolve the unresolved wall',
      status: 'unknown',
      actionability: 'unknown',
      livenessState: null,
    });

    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.status).toBe('unknown');
    expect(a.body).toContain('LIVENESS UNKNOWN');
  });

  it('owner-wall: a standing fact preserves exact facts:retract coordinates', () => {
    const a = ownerWallToAttention({
      source: 'standing-fact',
      ownerId: null,
      claim: 'Owner must provide the credential.',
      ref: 'wall:voice-credential',
      factScope: 'harness',
      factScopeRef: 'papercusp',
      factKey: 'wall:voice-credential',
      status: 'unknown',
    });

    expect(a.actions[0]).toMatchObject({ id: 'resolve', label: 'Clear wall', primary: true });
    expect(a.ref).toEqual({
      kind: 'owner-wall',
      wallSource: 'standing-fact',
      wallOwnerId: null,
      wallRef: 'wall:voice-credential',
      factScope: 'harness',
      factScopeRef: 'papercusp',
      factKey: 'wall:voice-credential',
    });
  });

  it('dark-flag-ratification: a Decision naming the flag key, falling back to a generic body', () => {
    const withReason = darkFlagRatificationToAttention({
      flagKey: 'papercusp-open-signup',
      justification: 'SECURITY: internet-reachable.',
    });
    expect(withReason.kind).toBe('dark-flag-ratification');
    expect(withReason.category).toBe('system-control');
    expect(withReason.needsHuman).toBe(true);
    expect(withReason.body).toBe('SECURITY: internet-reachable.');
    expect(withReason.id).toBe('dark-flag-ratification:papercusp-open-signup');

    const noReason = darkFlagRatificationToAttention({ flagKey: 'papercusp-x' });
    expect(noReason.body).toContain('KNOWN_DARK_FLAGS allowlist');
  });

  it('dark-flag-ratification: owner review-by (DARK_FLAGS_OWNER_REVIEW_BY, advisory) surfaces in status without throwing', () => {
    expect(() =>
      darkFlagRatificationToAttention({
        flagKey: 'papercusp-cutover-thing',
        justification: 'staged cutover, owner must flip when ready.',
        reviewBy: '2026-10-01',
      }),
    ).not.toThrow();
    const withReviewBy = darkFlagRatificationToAttention({
      flagKey: 'papercusp-cutover-thing',
      reviewBy: '2026-10-01',
    });
    expect(withReviewBy.status).toBe('awaiting-ratification (review by 2026-10-01)');
  });

  it('dark-flag-ratification: id is derived from flagKey alone — repeat calls for the same flag never duplicate', () => {
    const first = darkFlagRatificationToAttention({
      flagKey: 'papercusp-dup-flag',
      justification: 'first pass',
    });
    const second = darkFlagRatificationToAttention({
      flagKey: 'papercusp-dup-flag',
      justification: 'second pass, different text',
      reviewBy: '2026-10-01',
    });
    expect(second.id).toBe(first.id);
    expect(first.id).toBe('dark-flag-ratification:papercusp-dup-flag');
  });

  it('blocked-session: a Decision; title/body use the mirrored question when present', () => {
    const withQuestion = blockedSessionToAttention({
      sessionId: 'sess-1',
      client: 'codex',
      refId: 'ref-1',
      gateKind: 'ask',
      question: 'should I proceed with the migration?',
      waitingHours: 2,
      actionability: 'actionable',
      livenessState: 'live',
    });
    expect(withQuestion.kind).toBe('blocked-session');
    expect(withQuestion.category).toBe('escalations');
    expect(withQuestion.needsHuman).toBe(true);
    expect(withQuestion.title).toBe('should I proceed with the migration?');
    expect(withQuestion.importance).toBe('high');
    expect(withQuestion.id).toBe('blocked-session:codex:sess-1:ref-1');

    const noQuestion = blockedSessionToAttention({
      sessionId: 'sess-2',
      client: 'codex',
      refId: 'ref-2',
      gateKind: 'permission_wait',
      actionability: 'actionable',
      livenessState: 'live',
    });
    expect(noQuestion.title).toContain('permission prompt');
    expect(noQuestion.body).toContain('D-002 capability matrix');
  });

  it('blocked-session: ended and unknown owners are Alerts with diagnostic status', () => {
    const ended = blockedSessionToAttention({
      sessionId: 'sess-ended',
      client: 'codex',
      refId: 'ref-ended',
      gateKind: 'ask',
      question: 'an old question',
      actionability: 'non-actionable',
      livenessState: 'ended',
    });
    expect(ended.tier).toBe('alert');
    expect(ended.needsHuman).toBe(false);
    expect(ended.status).toBe('stranded (codex)');
    expect(ended.body).toContain('STRANDED');

    const unknown = blockedSessionToAttention({
      sessionId: 'sess-unknown',
      client: 'codex',
      refId: 'ref-unknown',
      gateKind: 'permission_wait',
      actionability: 'unknown',
      livenessState: null,
    });
    expect(unknown.tier).toBe('alert');
    expect(unknown.needsHuman).toBe(false);
    expect(unknown.status).toBe('unknown (codex)');
    expect(unknown.body).toContain('LIVENESS UNKNOWN');
  });

  it('blocked-session: a suppressed_ask stays a Decision with its default + deadline even when the asker is gone (WI-10005039)', () => {
    for (const livenessState of ['ended', null] as const) {
      const card = blockedSessionToAttention({
        sessionId: 'sess-sup',
        client: 'claude',
        refId: 'sup-1',
        gateKind: 'suppressed_ask',
        question: 'Ship the migration now, or hold for the owner window?',
        waitingHours: 3,
        actionability: livenessState === 'ended' ? 'non-actionable' : 'unknown',
        livenessState,
        decideBy: '2026-10-09T12:00:00.000Z',
        defaultIfUnanswered: 'ship it at the deadline',
      });
      expect(card.tier).toBe('decision');
      expect(card.needsHuman).toBe(true);
      expect(card.body).toContain('Default if unanswered: ship it at the deadline');
      expect(card.body).toContain('decide by 2026-10-09T12:00:00.000Z');
      // The declaring agent dying is the DESIGN of this kind — it must not read as stranded work.
      expect(card.status).toBe('blocked (claude)');
      expect(card.body).not.toContain('STRANDED');
      expect(card.body).not.toContain('LIVENESS UNKNOWN');
    }
  });

  it('blocked-session: a suppressed_ask renders a non-string default as JSON and says so when none was declared', () => {
    const base = {
      sessionId: 's',
      client: 'claude',
      refId: 'r',
      gateKind: 'suppressed_ask' as const,
      question: 'q?',
      actionability: 'actionable' as const,
      livenessState: 'live' as const,
    };
    expect(blockedSessionToAttention({ ...base, defaultIfUnanswered: { choice: 'deny' } }).body).toContain(
      'Default if unanswered: {"choice":"deny"}',
    );
    const none = blockedSessionToAttention({ ...base, decideBy: null, defaultIfUnanswered: null });
    expect(none.body).toContain('No default declared');
    expect(none.body).not.toContain('undefined');
    expect(none.body).not.toContain('decide by');
  });

  it('CONTROL: a plain ask with an ended asker is still a stranded Alert with no default line', () => {
    // Pins the other side: if the suppressed branch ever leaked onto plain asks, the suppressed
    // assertions above would pass for the wrong reason (everything becoming a Decision).
    const plain = blockedSessionToAttention({
      sessionId: 'sess-plain',
      client: 'claude',
      refId: 'plain-1',
      gateKind: 'ask',
      question: 'an old question',
      actionability: 'non-actionable',
      livenessState: 'ended',
    });
    expect(plain.tier).toBe('alert');
    expect(plain.status).toBe('stranded (claude)');
    expect(plain.body).toContain('STRANDED');
    expect(plain.body).not.toContain('Default if unanswered');
  });

  it('all four: id is kind-prefixed, ref.kind matches, needsHuman === (tier === decision), category set', () => {
    const items: AttentionItem[] = [
      workItemNeedsHumanToAttention({ workItemId: 'WI-1', itemKind: 'chunk', title: 't' }),
      ownerWallToAttention({
        source: 'work-item',
        ownerId: 'su-live',
        claim: 'c',
        status: 'waiting',
        actionability: 'actionable',
        livenessState: 'live',
      }),
      darkFlagRatificationToAttention({ flagKey: 'k' }),
      blockedSessionToAttention({
        sessionId: 's',
        client: 'omp',
        refId: 'r',
        gateKind: 'ask',
        actionability: 'actionable',
        livenessState: 'live',
      }),
    ];
    for (const it of items) {
      expect(it.id.startsWith(`${it.kind}:`)).toBe(true);
      expect(it.ref.kind).toBe(it.kind);
      expect(it.needsHuman).toBe(it.tier === 'decision');
      expect(it.tier).toBe('decision'); // every one of these is a Decision by construction
      expect(it.triageState).toBe('untriaged');
      expect(it.category).toBe(attentionCategory(it.kind));
    }
  });
});

describe('decisionOwedToAttention (EI-147 — possibly-unrecorded owner decisions)', () => {
  it('is an Alert (never a Decision) — a heuristic nudge, not a governed verdict', () => {
    const a = decisionOwedToAttention({
      sessionId: 'sess-1',
      refId: 'toolu_9',
      client: 'claude',
      question: 'co-locate the Queen with the Hive?',
      ownerAgentId: 'su-abc',
      harnessSlug: 'papercusp',
      closedAt: '2026-07-20T12:00:00.000Z',
    });
    expect(a.kind).toBe('decision-owed');
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.category).toBeNull();
    expect(a.title).toBe('co-locate the Queen with the Hive?');
    expect(a.body).toContain('sess-1');
    expect(a.body).toContain('plans:add-decision');
    expect(a.ownerAgentId).toBe('su-abc');
    expect(a.id).toBe('decision-owed:sess-1:toolu_9');
    expect(a.ref).toEqual({ kind: 'decision-owed', sessionId: 'sess-1', refId: 'toolu_9' });
  });

  it('falls back to a generic title when the question is blank', () => {
    const a = decisionOwedToAttention({
      sessionId: 'sess-2',
      refId: 'toolu_1',
      client: 'codex',
      question: null,
      ownerAgentId: null,
      harnessSlug: null,
      closedAt: '2026-07-20T12:00:00.000Z',
    });
    expect(a.title).toContain('codex session');
    expect(a.ownerAgentId).toBeNull();
  });

  it('id is kind-prefixed, ref.kind matches, needsHuman === (tier === decision), category agrees with attentionCategory', () => {
    const a = decisionOwedToAttention({
      sessionId: 's',
      refId: 'r',
      client: 'claude',
      question: 'q',
      ownerAgentId: null,
      harnessSlug: null,
      closedAt: '2026-07-20T12:00:00.000Z',
    });
    expect(a.id.startsWith(`${a.kind}:`)).toBe(true);
    expect(a.ref.kind).toBe(a.kind);
    expect(a.needsHuman).toBe(a.tier === 'decision');
    expect(a.triageState).toBe('untriaged');
    expect(a.category).toBe(attentionCategory(a.kind));
  });
});

describe('P-005e — dropDuplicateNeedsHumanWorkItems (D-008 dedupe canonicalization)', () => {
  it('drops a work-item-needs-human row whose id an improvement item already covers', () => {
    const items: AttentionItem[] = [
      improvementToAttention({ issueId: 'EI-7', title: 'covered by improvement' }),
      workItemNeedsHumanToAttention({ workItemId: 'EI-7', itemKind: 'bug', title: 'same row, generic source' }),
      workItemNeedsHumanToAttention({ workItemId: 'WI-99', itemKind: 'feature', title: 'uncovered, keep' }),
    ];
    const kept = dropDuplicateNeedsHumanWorkItems(items);
    expect(kept.map((i) => i.id).sort()).toEqual(['improvement:EI-7', 'work-item-needs-human:WI-99'].sort());
  });

  it('drops a work-item-needs-human row whose id an owner-wall work-item leg already covers', () => {
    const items: AttentionItem[] = [
      ownerWallToAttention({ source: 'work-item', ownerId: 'su-a', claim: 'ratify', ref: 'F-3', status: 'waiting' }),
      workItemNeedsHumanToAttention({ workItemId: 'F-3', itemKind: 'feature', title: 'same row, generic source' }),
    ];
    const kept = dropDuplicateNeedsHumanWorkItems(items);
    expect(kept.length).toBe(1);
    expect(kept[0]!.kind).toBe('owner-wall');
  });

  it('never drops a loop-carry-note owner-wall (it has no work-item ref to collide on)', () => {
    const items: AttentionItem[] = [
      ownerWallToAttention({ source: 'loop-carry-note', ownerId: 'su-a', claim: 'a decision', status: 'waiting' }),
      workItemNeedsHumanToAttention({ workItemId: 'WI-1', itemKind: 'bug', title: 't' }),
    ];
    expect(dropDuplicateNeedsHumanWorkItems(items).length).toBe(2);
  });

  it('is a no-op when nothing overlaps (identity-preserving pass-through)', () => {
    const items: AttentionItem[] = [
      improvementToAttention({ issueId: 'EI-1', title: 't' }),
      workItemNeedsHumanToAttention({ workItemId: 'WI-2', itemKind: 'task', title: 't2' }),
    ];
    expect(dropDuplicateNeedsHumanWorkItems(items).length).toBe(2);
  });
});

describe('curated-signal-cards P-001/P-002 — blocked work-items become Alert cards', () => {
  it('blockedWorkItemToAttention: an Alert (never a Decision), ungoverned category, kind-aware status', () => {
    const a = blockedWorkItemToAttention({
      workItemId: 'WI-5231',
      itemKind: 'feature',
      title: 'verification lane',
      reason: 'waiting on the staging deploy',
      harnessSlug: 'papercusp',
      ownerAgentId: 'su-0e48',
      curatorRef: 'papercusp#WI-5231',
    });
    expect(a.kind).toBe('work-item-blocked');
    expect(a.id).toBe('work-item-blocked:WI-5231');
    expect(a.tier).toBe('alert');
    // The invariant that matters: an Alert must never inflate the Decisions
    // bucket — unblocking is work, not a triage verdict the human renders.
    expect(a.needsHuman).toBe(false);
    expect(a.category).toBeNull(); // ungoverned signal → never auto-disposed
    expect(a.status).toBe('blocked (feature)');
    expect(a.body).toBe('waiting on the staging deploy');
    expect(a.ownerAgentId).toBe('su-0e48');
    expect(a.ref).toEqual({ kind: 'work-item-blocked', workItemId: 'WI-5231', itemKind: 'feature' });
  });

  it('carries the curator ref as itemRef so the SHIPPED chat drill-in can select this card', () => {
    // resolveInboxDrillIn (deterministic-status-cards / WI-5342) matches a
    // `wi:<ref>` drill-in against each live item's OWN identifiers — itemRef is
    // the one it reads. Without this the drill-in selects nothing.
    const a = blockedWorkItemToAttention({
      workItemId: 'WI-7',
      itemKind: 'bug',
      title: 't',
      reason: 'r',
      curatorRef: 'papercusp#WI-7',
    });
    expect(a.itemRef).toBe('papercusp#WI-7');
  });

  it('falls back to the title when the blocker reason is blank', () => {
    const a = blockedWorkItemToAttention({
      workItemId: 'WI-8',
      itemKind: 'task',
      title: 'no reason recorded',
      reason: '   ',
    });
    expect(a.body).toBe('no reason recorded');
    expect(a.itemRef).toBeNull(); // no curatorRef supplied
  });

  it('dropDuplicateBlockedWorkItems: a needs-human card WINS over the blocked card for the same row', () => {
    // An issue-family row can be status=blocked AND payload.needsHuman — the
    // Decision-tier framing must win, or one row lands in two tiers.
    const items: AttentionItem[] = [
      workItemNeedsHumanToAttention({ workItemId: 'EI-5', itemKind: 'bug', title: 'needs the owner' }),
      blockedWorkItemToAttention({ workItemId: 'EI-5', itemKind: 'bug', title: 'same row', reason: 'r' }),
      blockedWorkItemToAttention({ workItemId: 'WI-9', itemKind: 'feature', title: 'uncovered', reason: 'r' }),
    ];
    const kept = dropDuplicateBlockedWorkItems(items);
    expect(kept.map((i) => i.id).sort()).toEqual(['work-item-blocked:WI-9', 'work-item-needs-human:EI-5'].sort());
  });

  it('dropDuplicateBlockedWorkItems: an improvement or owner-wall covering the row also wins', () => {
    const viaImprovement: AttentionItem[] = [
      improvementToAttention({ issueId: 'EI-6', title: 'covered' }),
      blockedWorkItemToAttention({ workItemId: 'EI-6', itemKind: 'bug', title: 'same', reason: 'r' }),
    ];
    expect(dropDuplicateBlockedWorkItems(viaImprovement).map((i) => i.kind)).toEqual(['improvement']);

    const viaWall: AttentionItem[] = [
      ownerWallToAttention({ source: 'work-item', ownerId: 'su-a', claim: 'ratify', ref: 'F-4', status: 'waiting' }),
      blockedWorkItemToAttention({ workItemId: 'F-4', itemKind: 'feature', title: 'same', reason: 'r' }),
    ];
    expect(dropDuplicateBlockedWorkItems(viaWall).map((i) => i.kind)).toEqual(['owner-wall']);
  });

  it('TEETH: is a no-op when nothing overlaps — a blocked card is never dropped on its own', () => {
    const items: AttentionItem[] = [
      workItemNeedsHumanToAttention({ workItemId: 'WI-1', itemKind: 'bug', title: 't' }),
      blockedWorkItemToAttention({ workItemId: 'WI-2', itemKind: 'bug', title: 't', reason: 'r' }),
    ];
    expect(dropDuplicateBlockedWorkItems(items).length).toBe(2);
  });
});

describe('P-100 — every Queue item carries its autonomy category (B-14 / D-009/D-011)', () => {
  const ALL_KINDS: AttentionKind[] = [
    'plan-item',
    'coord-escalation',
    'coord-message',
    'smoke-fail',
    'operator-report',
    'improvement',
    'standing-approval',
    'conversation',
    'scout-grade',
    'work-item-needs-human',
    'owner-wall',
    'dark-flag-ratification',
    'blocked-session',
    'work-item-blocked',
    'decision-owed',
    'unhandled-directive',
  ];

  it('the kind to category map covers every AttentionKind (no kind silently uncategorized)', () => {
    expect(Object.keys(ATTENTION_KIND_CATEGORY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('every non-null mapped category is one of the 13 canonical autonomy categories', () => {
    for (const cat of Object.values(ATTENTION_KIND_CATEGORY)) {
      if (cat !== null) expect(isAutonomyCategory(cat)).toBe(true);
    }
  });

  it('each adapter stamps its kind category (the disposition domain, not the underlying work)', () => {
    const planItem = planItemToAttention({
      slug: 's',
      harnessSlug: null,
      id: 'P-1',
      text: 't',
      storedStatus: 'needs-human',
      effectiveStatus: 'needs-human',
      importance: 'normal',
    });
    expect(planItem.category).toBe('plan-governance');
    expect(coordEscalationToAttention({ msgId: 'm', severity: 'blocker', summary: 's' }).category).toBe('escalations');
    expect(coordMessageToAttention({ msgId: 'm', summary: 's' }).category).toBe('inbox-triage');
  });

  it('ungoverned signals/reports carry a null category (fail-safe: nothing for the gate to open)', () => {
    expect(smokeFailToAttention({ harnessSlug: 'h' }).category).toBeNull();
    expect(ATTENTION_KIND_CATEGORY['operator-report']).toBeNull();
    expect(attentionCategory('smoke-fail')).toBeNull();
  });

  it('the adapter category always agrees with attentionCategory(kind) — one source of truth', () => {
    const items: AttentionItem[] = [
      planItemToAttention({
        slug: 's',
        harnessSlug: null,
        id: 'P-1',
        text: 't',
        storedStatus: 'todo',
        effectiveStatus: 'todo',
        importance: 'normal',
      }),
      coordEscalationToAttention({ msgId: 'm', severity: 'question', summary: 's' }),
      coordMessageToAttention({ msgId: 'm', summary: 's' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
    ];
    for (const it of items) expect(it.category).toBe(attentionCategory(it.kind));
  });

  it('behavior-neutral: tagging category leaves tier + needsHuman untouched', () => {
    const a = planItemToAttention({
      slug: 's',
      harnessSlug: null,
      id: 'P-1',
      text: 't',
      storedStatus: 'needs-human',
      effectiveStatus: 'needs-human',
      importance: 'urgent',
    });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.category).toBe('plan-governance'); // the new axis rides alongside, changing nothing
  });
});

describe('isOperationalEscalation — operational status vs a genuine owner ask (D-006)', () => {
  it('an OPTION-LESS escalation from system / system:* / a named infra emitter is operational', () => {
    expect(isOperationalEscalation('system', false)).toBe(true);
    expect(isOperationalEscalation('system:green-checkpoint', false)).toBe(true);
    expect(isOperationalEscalation('green-checkpoint', false)).toBe(true); // named AUTOMATED_INFRA_EMITTER
  });

  it('EI-6789/EI-6782: steering-lease and compaction-watchdog (named AUTOMATED_INFRA_EMITTERs) are operational', () => {
    // Both fire per-instance status broadcasts (a changing WI-id/count or session-id
    // embedded in the text) that never dedup-match a prior firing, so each becomes a
    // brand-new never-resolved "open" escalation — the flood that drove
    // computeEscalationsHealth's aging count to 593+ while the live paginated read
    // stayed single-digit. Neither carries options (a choice to make), matching every
    // observed production row.
    expect(isOperationalEscalation('steering-lease', false)).toBe(true);
    expect(isOperationalEscalation('compaction-watchdog', false)).toBe(true);
  });

  it('EI-16170: inference-gateway, scout-outcome-refresh-sweep, rubric-staleness-watchdog, scorecard-emission-pulse (named AUTOMATED_INFRA_EMITTERs) are operational', () => {
    // Same shape as the EI-6789/EI-6782 pair above — each is a named, option-less
    // status advisory from a system watchdog/sweep, verified live against the
    // papercusp-workspace open backlog to have never been in this set (so every
    // firing inflated the human-attention `aging` count instead of being demoted
    // to the alert tier and reconciled after TTL).
    expect(isOperationalEscalation('inference-gateway', false)).toBe(true);
    expect(isOperationalEscalation('scout-outcome-refresh-sweep', false)).toBe(true);
    expect(isOperationalEscalation('rubric-staleness-watchdog', false)).toBe(true);
    expect(isOperationalEscalation('scorecard-emission-pulse', false)).toBe(true);
  });

  it('an escalation WITH options is a genuine ask — never operational, even from system', () => {
    expect(isOperationalEscalation('system', true)).toBe(false);
    expect(isOperationalEscalation('green-checkpoint', true)).toBe(false);
  });

  it('an AGENT/bee escalation is never auto-classified operational (its ask may be genuine)', () => {
    expect(isOperationalEscalation('worker-3', false)).toBe(false);
    expect(isOperationalEscalation('some-bee', false)).toBe(false);
  });

  // WI-2140594: the named set is now RESIDUE — classification derives from the
  // sender's SHAPE (machine-authored.ts isMachineEscalationEmitter), so a
  // watchdog nobody remembered to list is still operational. These six are the
  // emitters measured OUTSIDE the set on 2026-09-01 (783-row live backlog), each
  // tiered as an owner decision and waiting the 7d dead-author TTL instead of 48h.
  it('WI-2140594: an option-less escalation from an UNLISTED watchdog/detector emitter is operational (derived from shape)', () => {
    for (const from of [
      'wall-lapse-watchdog',
      'unservable-critical-watchdog',
      'goal-owner-report-watchdog',
      'intent-divergence-detector',
      'goal-liveness-watchdog',
      'embed-latency-watchdog',
    ]) {
      expect(isOperationalEscalation(from, false), `${from} must be operational`).toBe(true);
      expect(isOperationalEscalation(from, true), `${from} WITH options must stay a genuine ask`).toBe(false);
    }
  });

  it('WI-2140594: the shape can never reach an agent session, the owner GUI, or a human — even with a machine-ish suffix', () => {
    for (const from of [
      'su-1a0a0a1a-4c71-4ce5-abcf-58897784edf1',
      'role-fleet-watchdog', // an AGENT role whose name ends in -watchdog: still a bee, its ask may be genuine
      '01d3ae25-c833-4270-bd07-132fa669da8a',
      'pc-admin-coord-ui',
      'human',
      'watchdog', // bare word, no `-` separator
    ]) {
      expect(isOperationalEscalation(from, false), `${from} must NOT be operational`).toBe(false);
    }
  });

  it('a null/undefined/non-string sender is not operational (never throws)', () => {
    expect(isOperationalEscalation(null, false)).toBe(false);
    expect(isOperationalEscalation(undefined, false)).toBe(false);
  });
});

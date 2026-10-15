/**
 * Backend integration: a real plan flows through the SAME pipeline
 * plans:attention runs — parse → resolveEffectiveStatus → filter →
 * planItemToAttention → buildAttentionGroups — plus the write↔read
 * round-trip (the add-item / set-importance writers produce markdown
 * the parser reads back identically). No PG / ctx — exercises the real
 * parser + adapters + grouping end to end.
 */

import { describe, it, expect } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import {
  planItemsToAttention,
  dropConvertedPlanItems,
  dropDuplicateQuestionConversations,
  reportTurnsToAttention,
  toIsoOrNull,
} from './sources';
import { buildAttentionGroups } from './group';
import { smokeFailToAttention, coordEscalationToAttention, conversationToAttention } from './adapters';
import type { AttentionItem } from './types';
import { planItemRef } from '../issue-blocks-merge';
import { buildItemLine } from '../agent-tools/plans/add-item';
import { setImportanceInBody } from '../agent-tools/plans/set-importance';

function wrap(itemsBlock: string, slug = 't-2026-05-31'): string {
  return [
    '---',
    'title: T',
    `slug: ${slug}`,
    'status: active',
    '---',
    '',
    '# T',
    '',
    '## Now',
    '',
    '**State:** s',
    '',
    '**Next:** n',
    '',
    '## Phase 1',
    '',
    itemsBlock,
    '',
  ].join('\n');
}

const MIXED = wrap(
  [
    '- **P-001** `done` shipped already',
    '- **P-002** `todo` urgent thing importance: urgent',
    '- **P-003** `needs-human` sign off importance: high',
    '- **P-004** `todo` waits on P-002 blocked-by: P-002',
    '- **P-005** `dropped` abandoned',
  ].join('\n'),
);

describe('planItemsToAttention (plan-item source of plans:attention)', () => {
  const items = planItemsToAttention([{ parsed: parsePlan(MIXED, { filePath: 't-2026-05-31.md' }) }], 'papercup');

  it('excludes done and dropped items', () => {
    expect(items.map((i) => i.itemRef).sort()).toEqual(['P-002', 'P-003', 'P-004']);
  });

  it('carries importance, plan slug and harness through', () => {
    const p2 = items.find((i) => i.itemRef === 'P-002')!;
    expect(p2.importance).toBe('urgent');
    expect(p2.planSlug).toBe('t-2026-05-31');
    expect(p2.harnessSlug).toBe('papercup');
  });

  it('flags the needs-human item and gives it the full Answer/Resolve/Drop/Chat toolkit', () => {
    const p3 = items.find((i) => i.itemRef === 'P-003')!;
    expect(p3.needsHuman).toBe(true);
    expect(p3.importance).toBe('high');
    // The needs-human action set is the single source the inbox card maps from
    // (inbox-cards-unification P-009): answer + Resolve(primary) + drop + chat +
    // message-owner (inbox-tiering-and-message-agent D-004).
    expect(p3.actions.map((a) => a.id)).toEqual(['answer', 'mark-done', 'drop', 'chat', 'message-owner']);
    expect(p3.actions.find((a) => a.id === 'mark-done')?.primary).toBe(true);
    expect(p3.tier).toBe('decision');
  });

  it('keeps a needs-human decision from a shipped plan in the attention feed', () => {
    const shipped = MIXED.replace('status: active', 'status: shipped');
    const shippedItems = planItemsToAttention(
      [{ parsed: parsePlan(shipped, { filePath: 't-2026-05-31.md' }) }],
      'papercup',
    );
    const decision = shippedItems.find((item) => item.itemRef === 'P-003');

    expect(decision?.needsHuman).toBe(true);
    expect(decision?.tier).toBe('decision');
  });

  it('surfaces a computed-blocked item with effective status blocked (alert tier, not needs-human)', () => {
    const p4 = items.find((i) => i.itemRef === 'P-004')!;
    expect(p4.status).toBe('blocked'); // effectiveStatus: blocked-by P-002 (not done)
    expect(p4.needsHuman).toBe(false);
    expect(p4.tier).toBe('alert');
  });

  it('skips legacy plans', () => {
    const legacy = parsePlan('# no frontmatter\n\n## Phase 1\n\n- **P-001** `todo` x importance: high\n');
    expect(planItemsToAttention([{ parsed: legacy }], null)).toEqual([]);
  });

  // WI-7259 (sibling of WI-7246): a scheduled-run snapshot's markdown is a
  // byte-identical copy of its parent's, frontmatter included, so
  // `parsed.frontmatter.slug` reads the PARENT's slug. When the caller has the
  // canonical DB row (readAllPlans always does), prefer `row.planSlug`.
  it('prefers `row.planSlug` over the frontmatter slug for a snapshot (WI-7259)', () => {
    const parsed = parsePlan(MIXED, { filePath: 't-2026-05-31.md' });
    const items = planItemsToAttention(
      [{ parsed, row: { planSlug: 't-2026-05-31@run-999' } }],
      'papercup',
    );
    const p2 = items.find((i) => i.itemRef === 'P-002')!;
    expect(p2.planSlug).toBe('t-2026-05-31@run-999');
  });

  it('falls back to the frontmatter-derived slug when no row is given (older caller/fixture)', () => {
    const parsed = parsePlan(MIXED, { filePath: 't-2026-05-31.md' });
    const items = planItemsToAttention([{ parsed }], 'papercup');
    const p2 = items.find((i) => i.itemRef === 'P-002')!;
    expect(p2.planSlug).toBe('t-2026-05-31');
  });
});

describe('dropConvertedPlanItems — decision↔execution dedup guard (P-104 / D-013)', () => {
  const planItems = planItemsToAttention(
    [{ parsed: parsePlan(MIXED, { filePath: 't-2026-05-31.md' }) }],
    'papercup',
  );
  const SLUG = 't-2026-05-31';
  // P-002 todo (activity), P-003 needs-human (decision), P-004 blocked (alert).

  it('drops an executing (converted) plan-item — it lives in the Work tab now', () => {
    const kept = dropConvertedPlanItems(planItems, new Set([planItemRef(SLUG, 'P-002')]));
    expect(kept.map((i) => i.itemRef).sort()).toEqual(['P-003', 'P-004']);
  });

  it('NEVER hides a needs-human DECISION, even if it carries an implements edge', () => {
    const kept = dropConvertedPlanItems(planItems, new Set([planItemRef(SLUG, 'P-003')]));
    expect(kept.some((i) => i.itemRef === 'P-003')).toBe(true); // decision always shows
  });

  it('drops a converted blocked (alert-tier) item too', () => {
    const kept = dropConvertedPlanItems(planItems, new Set([planItemRef(SLUG, 'P-004')]));
    expect(kept.some((i) => i.itemRef === 'P-004')).toBe(false);
  });

  it('empty convertedRefs → every item passes through unchanged', () => {
    expect(dropConvertedPlanItems(planItems, new Set())).toHaveLength(planItems.length);
  });

  it('passes non-plan-item kinds through untouched (only plan-items dedup)', () => {
    const smoke = smokeFailToAttention({ harnessSlug: 'papercup' });
    // a converted ref that happens to collide on string is irrelevant — smoke is not a plan-item
    const kept = dropConvertedPlanItems([smoke], new Set([planItemRef(SLUG, 'P-002')]));
    expect(kept).toHaveLength(1);
    expect(kept[0].kind).toBe('smoke-fail');
  });
});

describe('full pipeline → grouped, importance-sorted', () => {
  it('groups plan items under their plan and routes a smoke-fail to Alerts, most-urgent group first', () => {
    const planItems = planItemsToAttention(
      [{ parsed: parsePlan(MIXED, { filePath: 't-2026-05-31.md' }) }],
      'papercup',
    );
    const groups = buildAttentionGroups([
      ...planItems,
      smokeFailToAttention({ harnessSlug: 'papercup', failureContent: 'boot crashed' }),
    ]);

    // Plan group leads (its max item is urgent) over the high smoke-fail Alerts bucket.
    expect(groups.map((g) => g.key)).toEqual(['t-2026-05-31', 'alerts:papercup']);

    const plan = groups[0];
    expect(plan.kind).toBe('plan');
    expect(plan.maxImportance).toBe('urgent');
    // urgent → high → normal within the group.
    expect(plan.items.map((i) => i.itemRef)).toEqual(['P-002', 'P-003', 'P-004']);

    const alerts = groups[1];
    expect(alerts.kind).toBe('alerts');
    expect(alerts.items[0].kind).toBe('smoke-fail');
  });
});

describe('write ↔ read round-trip (writers produce parser-readable markdown)', () => {
  it('add-item importance round-trips through the parser', () => {
    const line = buildItemLine('P-010', 'do the work', [], 'urgent');
    const parsed = parsePlan(wrap(line));
    expect(parsed.items[0].id).toBe('P-010');
    expect(parsed.items[0].importance).toBe('urgent');
    expect(parsed.items[0].text).toBe('do the work');
  });

  it('a default (normal) item carries no keyword and parses as normal', () => {
    const line = buildItemLine('P-011', 'routine task', [], 'normal');
    expect(line).not.toMatch(/importance:/);
    expect(parsePlan(wrap(line)).items[0].importance).toBe('normal');
  });

  it('set-importance changes the level and the parser reads the new value', () => {
    const body = wrap(buildItemLine('P-012', 'tune it', [], 'low'));
    const raised = setImportanceInBody(body, 'P-012', 'urgent');
    expect(raised.found).toBe(true);
    expect(raised.oldImportance).toBe('low');
    expect(parsePlan(raised.newBody).items[0].importance).toBe('urgent');
  });

  it('setting importance back to normal removes the keyword and parses as normal', () => {
    const body = wrap(buildItemLine('P-013', 'calm down', [], 'high'));
    const lowered = setImportanceInBody(body, 'P-013', 'normal');
    expect(lowered.newBody).not.toMatch(/importance:/);
    expect(parsePlan(lowered.newBody).items[0].importance).toBe('normal');
  });

  it('round-trip preserves blocked-by alongside importance', () => {
    const line = buildItemLine('P-014', 'gated work', ['P-001'], 'high');
    const parsed = parsePlan(wrap(line));
    expect(parsed.items[0].blockedBy).toEqual(['P-001']);
    expect(parsed.items[0].importance).toBe('high');
  });
});

// inbox-pane-active-scope-dates-filters-2026-07-19 P-2xx: occurredAt plumbing.
describe('toIsoOrNull', () => {
  it('coerces ISO strings, epoch-ms numbers and Dates; null on absent/invalid', () => {
    expect(toIsoOrNull('2026-07-19T12:00:00.000Z')).toBe('2026-07-19T12:00:00.000Z');
    const ms = Date.parse('2026-07-19T12:00:00.000Z');
    expect(toIsoOrNull(ms)).toBe('2026-07-19T12:00:00.000Z');
    expect(toIsoOrNull(new Date(ms))).toBe('2026-07-19T12:00:00.000Z');
    expect(toIsoOrNull(null)).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
    expect(toIsoOrNull('not-a-date')).toBeNull();
  });
});

/**
 * EI-19401034233741994 — one coord:ask-owner question must render ONE card.
 *
 * Driven through the REAL adapters (not hand-built fixtures) so the test also
 * covers the wiring the fix depends on: that `coordEscalationToAttention`
 * actually carries `conversationId` onto the ref, and that a `question`
 * escalation actually lands Decision-tier. A fixture-only test would keep
 * passing if either of those regressed.
 */
describe('dropDuplicateQuestionConversations (EI-19401034233741994)', () => {
  /** The two rows one `coord:ask-owner` writes: Decision escalation + Alert conversation. */
  function askOwnerPair(conversationId: string, msgId = `esc-${conversationId}`) {
    return {
      escalation: coordEscalationToAttention({
        msgId,
        severity: 'question',
        summary: 'ok to proceed?',
        from: 'su-asker',
        conversationId,
      }),
      conversation: conversationToAttention({ conversationId, title: 'ok to proceed?', askerId: 'su-asker' }),
    };
  }

  it('drops the Alert-tier conversation twin when a Decision escalation links it', () => {
    const { escalation, conversation } = askOwnerPair('conv-1');
    // Precondition: the two legs really are the two tiers this dedupe is about.
    expect(escalation.tier).toBe('decision');
    expect(conversation.tier).toBe('alert');

    const kept = dropDuplicateQuestionConversations([escalation, conversation]);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.kind).toBe('coord-escalation');
    // The surviving card is the one carrying the resolve action.
    expect(kept[0]!.actions.some((a) => a.id === 'resolve')).toBe(true);
  });

  it('keeps a conversation nothing links — an unpaired question is the owner’s only card', () => {
    const lone = conversationToAttention({ conversationId: 'conv-lonely', title: 'unpaired?' });
    const other = coordEscalationToAttention({
      msgId: 'esc-unrelated',
      severity: 'blocker',
      summary: 'unrelated blocker',
      from: 'su-x',
    });

    const kept = dropDuplicateQuestionConversations([other, lone]);

    expect(kept).toHaveLength(2);
    expect(kept.map((i) => i.id)).toContain(lone.id);
  });

  it('fails OPEN: an Alert-tier escalation does not cover its conversation', () => {
    // A system-emitted escalation with no options is operational → Alert tier.
    // Dropping the conversation there would leave the owner ZERO cards for a
    // still-open question — strictly worse than the double-render.
    const operational = coordEscalationToAttention({
      msgId: 'esc-op',
      severity: 'question',
      summary: 'ok to proceed?',
      from: 'system',
      conversationId: 'conv-op',
    });
    const conversation = conversationToAttention({ conversationId: 'conv-op', title: 'ok to proceed?' });
    expect(operational.tier).toBe('alert');

    const kept = dropDuplicateQuestionConversations([operational, conversation]);

    expect(kept).toHaveLength(2);
  });

  it('matches the stamped id EXACTLY — a shared prefix never hides another question', () => {
    // Conversations and their escalations are minted ms apart, so real ids share
    // long base36 prefixes; a prefix heuristic would silently hide a live ask.
    const { escalation } = askOwnerPair('conv-msbkhoir-aaaa');
    const neighbour = conversationToAttention({ conversationId: 'conv-msbkhoir-bbbb', title: 'different question' });

    const kept = dropDuplicateQuestionConversations([escalation, neighbour]);

    expect(kept).toHaveLength(2);
    expect(kept.map((i) => i.id)).toContain(neighbour.id);
  });

  it('drops only the matching twin when several asks are open at once', () => {
    const a = askOwnerPair('conv-a');
    const b = askOwnerPair('conv-b');
    const orphan = conversationToAttention({ conversationId: 'conv-c', title: 'still open' });

    const kept = dropDuplicateQuestionConversations([a.escalation, a.conversation, b.escalation, b.conversation, orphan]);

    expect(kept.map((i) => i.id).sort()).toEqual([a.escalation.id, b.escalation.id, orphan.id].sort());
  });

  it('CONTROL: the exact-match assertion is load-bearing — a prefix matcher fails it', () => {
    // A deliberately-wrong implementation kept permanently as a control (the
    // repo's falsifiability discipline for an imported module). Prefix matching
    // is the plausible-looking mistake — it is how the original zombies were
    // FOUND — and this proves the neighbour case above would actually catch it,
    // rather than passing because the selector never matches anything.
    const dropByPrefix = (items: readonly AttentionItem[]): AttentionItem[] => {
      const linked: string[] = [];
      for (const it of items) {
        if (it.kind === 'coord-escalation' && it.ref.kind === 'coord-escalation' && it.tier === 'decision') {
          const id = it.ref.conversationId;
          if (typeof id === 'string' && id.trim()) linked.push(id.trim().slice(0, 12));
        }
      }
      return items.filter(
        (it) =>
          !(it.kind === 'conversation' && it.ref.kind === 'conversation') ||
          !linked.some((p) => it.ref.kind === 'conversation' && it.ref.conversationId.startsWith(p)),
      );
    };

    const { escalation } = askOwnerPair('conv-msbkhoir-aaaa');
    const neighbour = conversationToAttention({ conversationId: 'conv-msbkhoir-bbbb', title: 'different question' });
    const feed = [escalation, neighbour];

    // The wrong implementation silently hides an unrelated open question…
    expect(dropByPrefix(feed)).toHaveLength(1);
    // …where the real one keeps it. Same input, opposite outcome.
    expect(dropDuplicateQuestionConversations(feed)).toHaveLength(2);
  });

  it('is a no-op (copy) when no escalation carries a link, and passes other kinds through', () => {
    const unlinked = coordEscalationToAttention({
      msgId: 'esc-plain',
      severity: 'blocker',
      summary: 'plain blocker',
      from: 'su-x',
    });
    const conversation = conversationToAttention({ conversationId: 'conv-z', title: 'q' });
    const smoke = smokeFailToAttention({ harnessSlug: 'h' });
    const items = [unlinked, conversation, smoke];

    const kept = dropDuplicateQuestionConversations(items);

    expect(kept).toEqual(items);
    expect(kept).not.toBe(items); // copy, never the caller's array
  });
});

describe('reportTurnsToAttention occurredAt', () => {
  it('stamps occurredAt from the turn createdAt', () => {
    const createdAt = Date.parse('2026-07-19T09:30:00.000Z');
    const [item] = reportTurnsToAttention([
      {
        turnId: 't1',
        conversationId: 'c1',
        report: { title: 'Status', plans: [{ title: 'Plan A', status: 'active' }] },
        text: 'status',
        createdAt,
      },
    ]);
    expect(item?.occurredAt).toBe('2026-07-19T09:30:00.000Z');
  });
});

import { describe, expect, it } from 'vitest';
import {
  classifyInboxWakeGroup,
  classifyInboxWakeMessage,
  inboxWakeDeliveryMsgId,
  inboxWakeGroupHandled,
  inboxWakeMessageComponents,
} from './inbox-wake-actionability';

// review-system-rework-reduction-2026-09-23 P-024: "a wake with nothing to act on costs no turn".
const KEY = 'coord:inbox-wake:su-a';

function msg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: '2026-09-23T14:00:00.000Z', msg_id: 'm-1', from: 'su-b', to: ['su-a'], kind: 'message', ...over };
}

describe('RSR-P-024-B — a non-actionable inbox event does not start a turn', () => {
  it('classifies a directed FYI (expects none, no reply linkage) as non-actionable', () => {
    const v = classifyInboxWakeMessage(msg({ expects: 'none', summary: 'FYI: merged' }));
    expect(v.actionable).toBe(false);
    expect(v.class).toBe('fyi');
  });

  it('classifies a bare ack receipt as non-actionable, even when it threads to the ask', () => {
    const v = classifyInboxWakeMessage(msg({ kind: 'ack', related_msg_id: 'm-0' }));
    expect(v.actionable).toBe(false);
    expect(v.class).toBe('receipt');
  });

  it('classifies a plan event with no state change (todo→todo) as non-actionable', () => {
    const v = classifyInboxWakeMessage(
      msg({ kind: 'plan_event', event: 'item_status_changed', before: { status: 'todo', id: 'P-1' }, after: { id: 'P-1', status: 'todo' } }),
    );
    expect(v.actionable).toBe(false);
    expect(v.class).toBe('no-state-change');
  });

  it('keeps a plan event that DID change state actionable', () => {
    const v = classifyInboxWakeMessage(
      msg({ kind: 'plan_event', event: 'item_status_changed', before: { status: 'todo' }, after: { status: 'wip' } }),
    );
    expect(v.actionable).toBe(true);
  });

  it('the wake gate settles a group whose every message is non-actionable', () => {
    const envelopes = new Map<string, unknown>([
      ['m-1', msg({ msg_id: 'm-1', expects: 'none' })],
      ['m-2', msg({ msg_id: 'm-2', kind: 'ack', related_msg_id: 'm-0' })],
    ]);
    const gate = classifyInboxWakeGroup(
      [
        { eventKey: KEY, payload: { msg_id: 'm-1' } },
        { eventKey: KEY, payload: { msg_id: 'm-2' } },
      ],
      envelopes,
    );
    expect(gate).toEqual({ nonActionable: true, classes: ['fyi', 'receipt'] });
  });

  it('fails OPEN: an unresolved envelope, an unreadable one, a msg_id-less wake, an urgent one, or a foreign key keeps the turn', () => {
    const envelopes = new Map<string, unknown>([['m-1', msg({ expects: 'none' })], ['m-bad', 'not-an-envelope']]);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, payload: { msg_id: 'm-missing' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, payload: { msg_id: 'm-bad' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, payload: null }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: KEY, urgent: true, payload: { msg_id: 'm-1' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([{ eventKey: 'release:green:x', payload: { msg_id: 'm-1' } }], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeGroup([], envelopes).nonActionable).toBe(false);
    expect(classifyInboxWakeMessage(undefined)).toMatchObject({ actionable: true, class: 'unknown' });
  });

  it('reads the msg_id only from a well-formed payload', () => {
    expect(inboxWakeDeliveryMsgId({ msg_id: 'm-9' })).toBe('m-9');
    expect(inboxWakeDeliveryMsgId({ msg_id: '' })).toBeNull();
    expect(inboxWakeDeliveryMsgId({ coalesced: true })).toBeNull();
    expect(inboxWakeDeliveryMsgId(null)).toBeNull();
  });
});

describe('EI-16685 — exact handled-state proof for a pending host wake', () => {
  it('requires a shown receipt for known non-actionable mail', () => {
    const group = [{ eventKey: KEY, urgent: false, payload: { msg_id: 'm-fyi' } }];
    const envelopes = new Map<string, unknown>([['m-fyi', msg({ msg_id: 'm-fyi', expects: 'none' })]]);
    expect(inboxWakeGroupHandled(group, envelopes, '2026-09-23T14:01:00.000Z')).toBe(true);
    expect(inboxWakeGroupHandled(group, envelopes, null)).toBe(false);
  });

  it('does not cancel a merely shown actionable message, but exact recipient reply linkage is handled', () => {
    const group = [{ eventKey: KEY, urgent: false, payload: { msg_id: 'm-ask' } }];
    const envelopes = new Map<string, unknown>([['m-ask', msg({ msg_id: 'm-ask', expects: 'action' })]]);
    expect(inboxWakeGroupHandled(group, envelopes, '2026-09-23T14:01:00.000Z')).toBe(false);
    expect(inboxWakeGroupHandled(group, envelopes, null, new Set(['m-ask']))).toBe(true);
    expect(inboxWakeGroupHandled(group, envelopes, null, new Set(['m-other']))).toBe(false);
  });

  it('uses settled Inbox-run receipts only for the exact thread reply and preserves actionable classes', () => {
    const settled = new Set(['m-reply', 'm-fyi', 'm-ask', 'm-owner', 'm-wake']);
    const handled = (msgId: string, envelope: unknown) =>
      inboxWakeGroupHandled(
        [{ eventKey: KEY, urgent: false, payload: { msg_id: msgId } }],
        new Map([[msgId, envelope]]),
        null,
        new Set(),
        settled,
      );

    expect(handled('m-reply', msg({ msg_id: 'm-reply', related_msg_id: 'm-resolver-ask', expects: 'none' }))).toBe(true);
    expect(handled('m-fyi', msg({ msg_id: 'm-fyi', expects: 'none' }))).toBe(false);
    expect(handled('m-ask', msg({ msg_id: 'm-ask', related_msg_id: 'm-old-ask', expects: 'answer' }))).toBe(false);
    expect(handled('m-owner', msg({ msg_id: 'm-owner', from: 'human', related_msg_id: 'm-old-ask', expects: 'none' }))).toBe(false);
    expect(handled('m-wake', msg({ msg_id: 'm-wake', related_msg_id: 'm-old-ask', expects: 'none', wake: true }))).toBe(false);
    expect(
      inboxWakeGroupHandled(
        [{ eventKey: KEY, urgent: false, payload: { msg_id: 'm-missing' } }],
        new Map(),
        null,
        new Set(),
        new Set(['m-missing']),
      ),
    ).toBe(false);
  });

  it('expands every component of a coalesced inbox-only group and fails open on one unhandled component', () => {
    const group = [{
      eventKey: KEY,
      urgent: false,
      payload: {
        coalesced: true,
        events: [
          { event: KEY, urgent: false, payload: { msg_id: 'm-a' } },
          { event: KEY, urgent: false, payload: { msg_id: 'm-b' } },
        ],
      },
    }];
    const envelopes = new Map<string, unknown>([
      ['m-a', msg({ msg_id: 'm-a', expects: 'none' })],
      ['m-b', msg({ msg_id: 'm-b', expects: 'none' })],
    ]);
    expect(inboxWakeMessageComponents(group)?.map((component) => component.msgId)).toEqual(['m-a', 'm-b']);
    expect(inboxWakeGroupHandled(group, envelopes, '2026-09-23T14:01:00.000Z')).toBe(true);
    envelopes.set('m-b', msg({ msg_id: 'm-b', expects: 'action' }));
    expect(inboxWakeGroupHandled(group, envelopes, '2026-09-23T14:01:00.000Z')).toBe(false);
  });

  it('fails open on mixed, urgent, unresolved, mismatched, or timestamp-less components', () => {
    const good = new Map<string, unknown>([['m-1', msg({ msg_id: 'm-1', expects: 'none' })]]);
    const direct = [{ eventKey: KEY, urgent: false, payload: { msg_id: 'm-1' } }];
    expect(inboxWakeGroupHandled([{ ...direct[0], eventKey: 'release:green:x' }], good, '2026-09-23T14:01:00.000Z')).toBe(false);
    expect(inboxWakeGroupHandled([{ ...direct[0], urgent: true }], good, '2026-09-23T14:01:00.000Z')).toBe(false);
    expect(inboxWakeGroupHandled(direct, new Map(), '2026-09-23T14:01:00.000Z')).toBe(false);
    expect(inboxWakeGroupHandled(direct, new Map([['m-1', msg({ msg_id: 'm-other', expects: 'none' })]]), '2026-09-23T14:01:00.000Z')).toBe(false);
    expect(inboxWakeGroupHandled(direct, new Map([['m-1', { msg_id: 'm-1', expects: 'none' }]]), '2026-09-23T14:01:00.000Z')).toBe(false);
  });
});

describe('RSR-P-024-C — a directed ask or an owner directive starts a turn', () => {
  it.each([
    ['expects action', msg({ expects: 'action' })],
    ['expects answer', msg({ expects: 'answer' })],
    ['expectsReply', msg({ expectsReply: true })],
  ])('a directed ask (%s) is actionable', (_label, env) => {
    const v = classifyInboxWakeMessage(env);
    expect(v.actionable).toBe(true);
    expect(v.class).toBe('directed-ask');
  });

  it.each([
    ['from the owner chat pane', msg({ from: 'pc-admin-coord-ui', expects: 'none' })],
    ['from the human inbox', msg({ from: 'human', expects: 'none' })],
    ['an owner-origin relay stamp', msg({ expects: 'none', relayProvenance: { origin: 'owner', tier: 'owner-verified-turn' } })],
    ['an owner ack-shaped message', msg({ from: 'human', kind: 'ack' })],
  ])('an owner directive (%s) is actionable even when it looks like an FYI', (_label, env) => {
    const v = classifyInboxWakeMessage(env);
    expect(v.actionable).toBe(true);
    expect(v.class).toBe('owner-directive');
  });

  it("a wake:'required' message and its persisted boolean form plus a thread reply keep their turn", () => {
    expect(classifyInboxWakeMessage(msg({ expects: 'none', wake: 'required' }))).toMatchObject({ actionable: true, class: 'required-wake' });
    expect(classifyInboxWakeMessage(msg({ expects: 'none', wake: true }))).toMatchObject({ actionable: true, class: 'actionable' });
    expect(classifyInboxWakeMessage(msg({ expects: 'none', related_msg_id: 'm-0' }))).toMatchObject({ actionable: true, class: 'reply' });
  });

  it('the wake gate keeps the turn when ANY message in the group is an ask or an owner directive', () => {
    const envelopes = new Map<string, unknown>([
      ['m-fyi', msg({ msg_id: 'm-fyi', expects: 'none' })],
      ['m-ask', msg({ msg_id: 'm-ask', expects: 'action' })],
      ['m-own', msg({ msg_id: 'm-own', from: 'human', expects: 'none' })],
    ]);
    const withAsk = classifyInboxWakeGroup(
      [
        { eventKey: KEY, payload: { msg_id: 'm-fyi' } },
        { eventKey: KEY, payload: { msg_id: 'm-ask' } },
      ],
      envelopes,
    );
    expect(withAsk.nonActionable).toBe(false);
    expect(withAsk.classes).toEqual(['fyi', 'directed-ask']);
    const withOwner = classifyInboxWakeGroup(
      [
        { eventKey: KEY, payload: { msg_id: 'm-own' } },
        { eventKey: KEY, payload: { msg_id: 'm-fyi' } },
      ],
      envelopes,
    );
    expect(withOwner.nonActionable).toBe(false);
    expect(withOwner.classes).toEqual(['owner-directive']);
  });
});

/**
 * resolve-message-ref.integration.test.ts — WI-6725, against REAL Postgres.
 *
 * A full coord msg_id is `<short>-0000-<32 hex>`, but the LEADING SHORT FORM is
 * what circulates in prose, summaries and carry-notes. `getMessageById` matches
 * exactly, so a short-form lookup returned a well-formed EMPTY result that was
 * indistinguishable from "no such message" — and on 2026-08-01 a fleet leader
 * retracted a real, unanswered commitment on exactly that false negative.
 *
 * These pin the three-valued contract: a unique prefix RESOLVES, an ambiguous
 * one is reported AS ambiguous with candidates, and only a genuine miss is
 * not-found. Driven through `sendMessage` so the stored envelope shape matches
 * production exactly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import type { AgentIdentity } from './identity';
import { sendMessage, resolveMessageRef, getMessageById } from './messages';
import { openHandoff } from './handoffs';
import { openEscalation, reopenEscalation, resolveEscalation } from './escalations';
import { readCoordFeed } from './feed';
import { coordHasPgFastPath, coordWorkspaceId } from './log';
import ackTool from './tools/ack';
import readTool from './tools/read';
import threadTool from './tools/thread';

let fx: BaselineCoordFixture;

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: 'default', userId: null } as AgentIdentity;
}

const ASKER = ident('ref-asker');
const READER = ident('ref-reader');

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.admin`TRUNCATE harness_shared.coord_open_escalations`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
  await fx.admin`TRUNCATE harness_shared.coord_open_escalations`;
});

describe('resolveMessageRef (WI-6725)', () => {
  it('a FULL msg_id resolves exactly (unchanged fast path)', async () => {
    const sent = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'the design fork' });

    const res = await resolveMessageRef(sent.msg_id);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('exact');
    expect(res.msgId).toBe(sent.msg_id);
    expect(res.message.summary).toBe('the design fork');
  });

  it('WI-6725: the TRUNCATED short form — the one that circulates in prose — now RESOLVES', async () => {
    const sent = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'the design fork' });
    const shortForm = sent.msg_id.split('-')[0];
    expect(shortForm).not.toBe(sent.msg_id);
    // The exact-match primitive still misses it — that is the bug being fixed.
    expect(await getMessageById(shortForm)).toBeNull();

    const res = await resolveMessageRef(shortForm);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('prefix');
    expect(res.msgId).toBe(sent.msg_id);
    expect(res.message.summary).toBe('the design fork');
  });

  it('EI-21271857379493174: resolves an open escalation retained only in the projection', async () => {
    const fullId = 'mqlfq7me-0000-18f69a47da0046dd85a61f17ff88f87f';
    const escalation = {
      ts: '2026-06-19T21:22:38.388Z',
      msg_id: fullId,
      from: ASKER.ownerId,
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      summary: 'projection-only open escalation',
      resolved: null,
    };
    const workspaceId = coordWorkspaceId();
    await fx.admin`
      INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
      VALUES (${workspaceId}, ${fullId}, ${escalation.ts}, ${fx.admin.json(escalation)})
    `;

    const eventRows = await fx.admin`
      SELECT 1 FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND msg_id = ${fullId}
    `;
    expect(eventRows).toHaveLength(0);

    const res = await resolveMessageRef(fullId.split('-')[0]);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('prefix');
    expect(res.msgId).toBe(fullId);
    expect(res.message.kind).toBe('escalation');
    expect(res.message.summary).toBe('projection-only open escalation');
  });

  it('EI-21648471742359115: coord:ack acknowledges an escalation retained only in the projection', async () => {
    const fullId = 'mqlfq7me-0000-18f69a47da0046dd85a61f17ff88f880';
    const escalation = {
      ts: '2026-06-19T21:22:38.388Z',
      msg_id: fullId,
      from: ASKER.ownerId,
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      summary: 'ack projection-only open escalation',
      resolved: null,
    };
    const workspaceId = coordWorkspaceId();
    await fx.admin`
      INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
      VALUES (${workspaceId}, ${fullId}, ${escalation.ts}, ${fx.admin.json(escalation)})
    `;

    const eventRows = await fx.admin`
      SELECT 1 FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND msg_id = ${fullId}
    `;
    expect(eventRows).toHaveLength(0);

    const result = await ackTool.handler(
      { msg_id: fullId } as never,
      {
        principal: { kind: 'principal', slug: READER.ownerId, workspaceId: 'default' },
        harnessSlug: 'papercusp',
      } as never,
    );
    const body = (result as { data?: unknown; content?: { text: string }[] }).data ??
      JSON.parse((result as { content: { text: string }[] }).content![0].text);
    const payload = body as {
      ok: boolean;
      results: Array<{ ok: boolean; msg_id: string; ack_msg_id?: string; acked?: string; acked_from?: string }>;
    };

    expect(payload).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(payload.results[0]).toMatchObject({
      ok: true,
      msg_id: fullId,
      acked: fullId,
      acked_from: ASKER.ownerId,
    });
    expect(payload.results[0].ack_msg_id).toBeTruthy();

    const ack = await getMessageById(payload.results[0].ack_msg_id!);
    expect(ack).toMatchObject({
      kind: 'ack',
      from: READER.ownerId,
      to: [ASKER.ownerId],
      related_msg_id: fullId,
    });
  });

  it('EI-21550703014946163: a resolved escalation remains a valid reply target', async () => {
    const escalation = await openEscalation(ASKER, {
      severity: 'question',
      summary: 'resolve before the agent replies',
    });
    const resolved = await resolveEscalation({
      msg_id: escalation.msg_id,
      choice: 'handled',
      resolver: READER.ownerId,
    });
    expect(resolved).not.toBe('not_found');
    expect(resolved).not.toBe('already_resolved');

    const workspaceId = coordWorkspaceId();
    const openRows = await fx.admin`
      SELECT 1 FROM harness_shared.coord_open_escalations
       WHERE workspace_id = ${workspaceId} AND msg_id = ${escalation.msg_id}
    `;
    expect(openRows).toHaveLength(0);

    const res = await resolveMessageRef(escalation.msg_id);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('exact');
    expect(res.msgId).toBe(escalation.msg_id);
    expect(res.message.kind).toBe('escalation');
    expect(res.message.summary).toBe('resolve before the agent replies');
  });

  it('EI-21220247792567011: resolves an exact handoff id returned by coord:feed', async () => {
    const handoff = await openHandoff(ASKER, {
      to: [READER.ownerId],
      plan_slug: 'plan-x',
      summary: 'take over this work',
    });

    const res = await resolveMessageRef(handoff.msg_id);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('exact');
    expect(res.msgId).toBe(handoff.msg_id);
    expect(res.message.kind).toBe('handoff');
    expect(res.message.summary).toBe('take over this work');
  });

  it('EI-25503280746355318: coord:read resolves an idempotent coord:send id returned by coord:feed', async () => {
    expect(coordHasPgFastPath()).toBe(true);
    const fullId = `coord-send-${'a'.repeat(64)}`;
    const sent = await sendMessage(ASKER, {
      to: [READER.ownerId],
      msgId: fullId,
      summary: 'idempotent coord send',
    });

    const feed = await readCoordFeed({ from: ASKER.ownerId, limit: 20 });
    const row = feed.rows.find((entry) => entry.msg_id === sent.msg_id);
    expect(row).toBeDefined();
    if (!row) return;

    const result = await readTool.handler({ msg_id: row.msg_id }, {} as never);
    const payload = (result as { data?: unknown }).data as {
      found: boolean;
      msg_id: string;
      message: { msg_id: string; summary?: string } | null;
    };
    expect(payload).toMatchObject({
      found: true,
      msg_id: fullId,
      message: { msg_id: fullId, summary: 'idempotent coord send' },
    });
  });

  it('EI-25728544049822981: coord:thread resolves a full idempotent coord:send id', async () => {
    expect(coordHasPgFastPath()).toBe(true);
    const fullId = `coord-send-${'c'.repeat(64)}`;
    await sendMessage(ASKER, {
      to: [READER.ownerId],
      msgId: fullId,
      summary: 'idempotent coord send thread root',
    });

    const result = await threadTool.handler({ root_msg_id: fullId }, {} as never);
    const payload = (result as { data?: unknown }).data as {
      root: string;
      entries: Array<{ msg_id: string; summary?: string }>;
    };
    expect(payload.root).toBe(fullId);
    expect(payload.entries.map((entry) => entry.msg_id)).toContain(fullId);
    expect(payload.entries[0]?.summary).toBe('idempotent coord send thread root');
  });

  it('coord:thread names the coord:send full-ID shape when a reference is truncated', async () => {
    const truncatedId = `coord-send-${'d'.repeat(56)}`;
    const result = await threadTool.handler({ root_msg_id: truncatedId }, {} as never);
    const payload = (result as { data?: unknown }).data as { found: boolean; detail?: string };
    expect(payload.found).toBe(false);
    expect(payload.detail).toContain("or 'coord-send-<64 hex>'");
  });

  it('does not call a missing idempotent coord:send ID truncated', async () => {
    const fullId = `coord-send-${'b'.repeat(64)}`;
    const resolution = await resolveMessageRef(fullId);
    expect(resolution).toEqual({ status: 'not-found', msgId: fullId, looksTruncated: false });

    const result = await readTool.handler({ msg_id: fullId }, {} as never);
    const payload = (result as { data?: unknown }).data as {
      found: boolean;
      msg_id: string;
      detail?: string;
    };
    expect(payload).toMatchObject({ found: false, msg_id: fullId });
    expect(payload.detail).toBeUndefined();

    const partialId = fullId.slice(0, -8);
    const partialResult = await readTool.handler({ msg_id: partialId }, {} as never);
    const partialPayload = (partialResult as { data?: unknown }).data as {
      found: boolean;
      msg_id: string;
      detail?: string;
    };
    expect(partialPayload).toMatchObject({ found: false, msg_id: partialId });
    expect(partialPayload.detail).toContain("'<short>-0000-<32 hex>' or 'coord-send-<64 hex>'");
  });

  it('resolves a unique truncated handoff id without confusing it with a miss', async () => {
    const handoff = await openHandoff(ASKER, {
      to: [READER.ownerId],
      plan_slug: 'plan-x',
      summary: 'take over this work',
    });
    const shortForm = handoff.msg_id.split('-')[0];

    const res = await resolveMessageRef(shortForm);
    expect(res.status).toBe('found');
    if (res.status !== 'found') return;
    expect(res.resolvedFrom).toBe('prefix');
    expect(res.msgId).toBe(handoff.msg_id);
    expect(res.message.kind).toBe('handoff');
  });

  it('a genuinely absent FULL id is not-found, and is NOT flagged as truncated', async () => {
    const res = await resolveMessageRef('msnope99-0000-0123456789abcdef0123456789abcdef');
    expect(res.status).toBe('not-found');
    if (res.status !== 'not-found') return;
    expect(res.looksTruncated).toBe(false);
  });

  it('a short ref matching nothing is not-found AND flagged as truncated (so the caller can say why)', async () => {
    await sendMessage(ASKER, { to: [READER.ownerId], summary: 'unrelated' });

    const res = await resolveMessageRef('zzzznope');
    expect(res.status).toBe('not-found');
    if (res.status !== 'not-found') return;
    expect(res.looksTruncated).toBe(true);
  });

  it('an AMBIGUOUS prefix reports ambiguity with candidates — never a silent empty', async () => {
    const a = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'first' });
    const b = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'second' });
    // A 2-char prefix both ids share (coord short ids share the 'ms' stem).
    const shared = a.msg_id.slice(0, 2);
    expect(b.msg_id.startsWith(shared)).toBe(true);

    const res = await resolveMessageRef(shared);
    expect(res.status).toBe('ambiguous');
    if (res.status !== 'ambiguous') return;
    expect(res.candidates.length).toBeGreaterThan(1);
    expect(res.candidates).toContain(a.msg_id);
    expect(res.candidates).toContain(b.msg_id);
  });

  it('an empty/whitespace ref is not-found rather than matching everything', async () => {
    await sendMessage(ASKER, { to: [READER.ownerId], summary: 'present' });

    expect((await resolveMessageRef('   ')).status).toBe('not-found');
    expect((await resolveMessageRef('')).status).toBe('not-found');
  });

  it('prefix matching is anchored at the START — a mid-id substring does not resolve', async () => {
    const sent = await sendMessage(ASKER, { to: [READER.ownerId], summary: 'anchored' });
    const middle = sent.msg_id.slice(4, 12);

    const res = await resolveMessageRef(middle);
    expect(res.status).toBe('not-found');
  });
});

/**
 * WI-10005375 — coord:read returned the stored escalation record, which says resolved:null by
 * construction (the resolution is a sibling `escalation_resolved` event). On PG the fold now
 * reads ONLY that escalation's resolve/reopen rows (coord_event_log_related_msg_id_idx), so this
 * pins the new targeted SQL against real Postgres through the real coord:read handler.
 */
describe('coord:read folds an escalation resolution on Postgres (WI-10005375)', () => {
  async function coordRead(msgId: string): Promise<{ found: boolean; message: { resolved?: { choice?: string } | null } | null }> {
    const result = await readTool.handler({ msg_id: msgId }, {} as never);
    return (result as { data?: unknown }).data as never;
  }

  it('a resolved escalation reads resolved, an unrelated one stays open, and a reopen reads open again', async () => {
    // Positive control: this must drive the targeted PG read, not the in-memory replay.
    expect(coordHasPgFastPath()).toBe(true);
    const target = await openEscalation(ASKER, { severity: 'question', summary: 'withdrawn ask' });
    const other = await openEscalation(ASKER, { severity: 'question', summary: 'still-open ask' });
    expect(target.msg_id).not.toBe(other.msg_id);

    const resolved = await resolveEscalation({ msg_id: target.msg_id, choice: 'superseded', resolver: ASKER.ownerId });
    expect(typeof resolved).not.toBe('string');

    const before = await coordRead(target.msg_id);
    expect(before.found).toBe(true);
    expect(before.message?.resolved?.choice).toBe('superseded');
    expect((await coordRead(other.msg_id)).message?.resolved ?? null).toBeNull();

    await reopenEscalation({ msg_id: target.msg_id, by: 'owner', note: 'not withdrawn after all' });
    expect((await coordRead(target.msg_id)).message?.resolved ?? null).toBeNull();
  });
});

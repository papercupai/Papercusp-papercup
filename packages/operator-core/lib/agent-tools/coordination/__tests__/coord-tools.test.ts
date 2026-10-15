/**
 * coord-tools.test.ts — plan harness-test-coverage-for-launch P-026.
 *
 * The coord TOOL handlers wrap the (already-tested) channel library + identity.
 * This pins the handler envelopes for whoami / thread / ack over an in-memory
 * coordLog with a mocked identity — the layer that had no coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { InMemoryWatermarkStore } from '@papercusp/coordination/watermark-store';
import {
  COORD_CONVERSATIONAL_KINDS,
  COORD_EXECUTABLE_KINDS,
} from '@papercusp/coordination/core';
import { configureCoordLog, resetCoordLog } from '../log';
import {
  configureWatermarkStore,
  resetWatermarkStore,
  readWatermark,
  writeWatermark,
  emptyWatermark,
} from '../watermarks';
import { sendMessage } from '../messages';
import type { AgentIdentity } from '../identity';

const ME: AgentIdentity = {
  ownerId: 'me',
  ownerLabel: 'Me',
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
};
const resolvePresenceFleetMock = vi.hoisted(() =>
  vi.fn(
    async (
      _ownerId: string,
      launch: { fleetSlug: string | null; fleetRole: string | null },
    ) => launch,
  ),
);
// whoami reads live named-fleet membership through `../presence-fleet` (P-015),
// with launch membership as its failure fallback. Keep this handler suite DB-free.
vi.mock('../presence-fleet', () => ({ resolvePresenceFleet: resolvePresenceFleetMock }));
// Mock the identity module's full surface it consumes — no fleet env in the unit
// harness ⇒ the launch-membership fallback is no fleet.
vi.mock('../identity', () => ({
  resolveAgentIdentity: () => ME,
  deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
}));

// The handoff handler resolves short ownerId prefixes against the live presence
// roster (a PG read). For these in-memory handler tests the resolver is a
// deterministic pass-through — its own roster matching is covered elsewhere, and
// we only assert the handler wiring (open → accept → list).
//
// EI-10011: this is a FULL-module mock (no importOriginal), so every export
// `../inbox-wake.ts` pulls from `../recipient-resolve` must be present here too,
// not just the one this suite's own assertions touch — coord:handoff's
// fire-and-forget wake-on-open calls into inbox-wake.ts's wakeRecipients(),
// which imports `isSelectorOrWildcard` and `knownOwnerIdSet` alongside
// `resolveBestEffortAgainstRoster`. EI-9971 added `knownOwnerIdSet` to the real
// module and wired it into inbox-wake.ts without this mock being updated to
// match — the missing export threw ("No 'knownOwnerIdSet' export..."), caught
// by handoff.ts's fail-soft try/catch, which console.warn'd and tripped
// vitest-fail-on-console (the actual observed failure had nothing to do with
// the warn itself). `isSelectorOrWildcard` is pure and stable — reused verbatim
// rather than re-implemented; `knownOwnerIdSet` mocks to `null` (the
// "roster check unavailable/skip" default — mirrors inbox-wake.test.ts's own
// `vi.fn(async () => null)` convention).
vi.mock('../recipient-resolve', () => ({
  resolveBestEffortAgainstRoster: async (to: string[]) => [...to],
  isSelectorOrWildcard: (id: string) => id === '*' || id === 'human' || id === '' || id.startsWith('@'),
  knownOwnerIdSet: async () => null,
}));

// coord:handoff opens a durable handoff and then fire-and-forget wakes the
// recipient through the event-await engine. This suite exercises handler
// envelopes against in-memory coordination stores; keep the PG-backed wake
// engine at its unit-test seam (the dedicated handoff suite tests that wiring).
vi.mock('../../../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(async ({ key }: { key: string }) => ({
    ok: true,
    key,
    woken: 1,
    notified: [],
    msgId: null,
  })),
}));

import whoamiTool from '../tools/whoami';
import inboxTool, { boundInboxEntries } from '../tools/inbox';
import feedTool from '../tools/feed';
import ackTool from '../tools/ack';
import threadTool, { THREAD_RESPONSE_BUDGET_CHARS } from '../tools/thread';
import watermarkTool from '../tools/watermark';
import escalateTool from '../tools/escalate';
import escalationsTool from '../tools/escalations';
import resolveTool from '../tools/resolve';
import handoffTool from '../tools/handoff';
import handoffsTool from '../tools/handoffs';

const id = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: ownerId,
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, args: Record<string, unknown> = {}) => tool.handler(args as any, {} as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runWithCtx = (tool: any, args: Record<string, unknown>, ctx: Record<string, unknown>) =>
  tool.handler(args as any, ctx as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (res: any) => (res.data ?? JSON.parse(res.content[0].text));

beforeEach(() => {
  resolvePresenceFleetMock.mockImplementation(
    async (_ownerId: string, launch: { fleetSlug: string | null; fleetRole: string | null }) => launch,
  );
  configureCoordLog(new InMemoryCoordLog());
  configureWatermarkStore(new InMemoryWatermarkStore());
});
afterEach(() => {
  resetCoordLog();
  resetWatermarkStore();
});

describe('coord:whoami', () => {
  it('returns the server-resolved coordination identity', async () => {
    expect(parse(await run(whoamiTool))).toMatchObject({ ownerId: 'me', source: 'omp-hook-session' });
  });
  it('reports current presence membership after launch-env membership disappears', async () => {
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: 'live-fleet', fleetRole: 'member' });

    expect(parse(await run(whoamiTool))).toMatchObject({
      ownerId: 'me',
      fleetSlug: 'live-fleet',
      fleetRole: 'member',
    });
    expect(resolvePresenceFleetMock).toHaveBeenCalledWith('me', { fleetSlug: null, fleetRole: null });
  });
  // EI-1748 graceful-degrade path (resolveAgentIdentity throws → whoami returns
  // {resolved:false,...} instead of a structural error) is verified by inspection;
  // a unit test needs a throw-injecting identity mock (this suite mocks it to a
  // fixed ME), so it's left as a follow-up rather than restructuring the shared mock.
});

describe('boundInboxEntries (EI-1752)', () => {
  it('truncates long summary/body to maxChars + flags them; leaves short fields', () => {
    const long = 'x'.repeat(1000);
    const [e] = boundInboxEntries([{ summary: long, body: 'short', kind: 'message' }], 600);
    expect((e.summary as string).length).toBe(600);
    expect(e.summary_truncated).toBe(true);
    expect(e.summary_full_chars).toBe(1000);
    expect(e.body).toBe('short');
    expect(e.body_truncated).toBeUndefined();
  });
  it('maxChars<=0 disables truncation (full passthrough)', () => {
    const long = 'y'.repeat(1000);
    const [e] = boundInboxEntries([{ summary: long, kind: 'message' }], 0);
    expect((e.summary as string).length).toBe(1000);
    expect(e.summary_truncated).toBeUndefined();
  });
});

describe('coord:inbox `since` steer (EI-21349112990078630)', () => {
  // The missing time filter is DELIBERATE (D-002 / D-013 R1,
  // fleet-deltas-leader-primitives-2026-07-10) — but the bare unrecognized-key
  // rejection never said so, and "the documented since filter is missing" was
  // filed 10+ times. The authored redirect makes the rejection itself name
  // where a time-bounded read lives; the description steers upfront.
  const redirectKeys = ['since'] as const;

  it('authors a cross-tool redirect to coord:feed for since', () => {
    for (const key of redirectKeys) {
      const redirect = inboxTool.guidance?.argRedirects?.[key];
      expect(redirect, `argRedirects.${key}`).toBeDefined();
      expect(typeof redirect).toBe('object');
      const call = redirect as { tool: string; args: Record<string, unknown>; note?: string };
      expect(call.tool).toBe(feedTool.name);
      // The ratification pointer is the load-bearing half of the note: without
      // it the caller reads the redirect as a gap, refiles, and the cycle repeats.
      expect(call.note).toMatch(/D-002/);
      // Every arg the redirect teaches must exist on the target's live schema —
      // an authored call that feed rejects is worse than no hint at all.
      const feedShape = (feedTool.args as { shape: Record<string, unknown> }).shape;
      for (const taughtArg of Object.keys(call.args)) {
        expect(feedShape, `coord:feed declares \`${taughtArg}\``).toHaveProperty(taughtArg);
      }
    }
  });

  it('keeps since UNDECLARED on the inbox schema (redirects fire only for unknown keys)', () => {
    const shape = (inboxTool.args as { shape: Record<string, unknown> }).shape;
    for (const key of redirectKeys) {
      expect(shape, `inbox must not declare \`${key}\``).not.toHaveProperty(key);
    }
  });

  // EI-21349112990078630 requires that an agent reaching for `since` on coord:inbox is
  // told where a time-bounded read actually lives. This was originally asserted of the
  // DESCRIPTION ("upfront"). That sentence was then DELIBERATELY deleted to clear the
  // 1500-char prompt-weight HARD CAP (a gate RED at 1578; see the comment on inbox.ts's
  // guidance block) precisely because it was redundant with argRedirects.since, which
  // teaches the identical redirect at ZERO prompt weight, paid only on the failure path.
  // The requirement did not go away and is asserted far more strictly above, in "authors
  // a cross-tool redirect to coord:feed for since" (target tool, the D-002 ratification
  // pointer, and that every taught arg exists on coord:feed's live schema). So the useful
  // guard now runs the OTHER way: keep that sentence OUT, so a future edit does not
  // helpfully restore it and re-break the cap. The cap itself stays enforced by
  // `npm run lint:tool-prompts`; this does not restate a byte budget it owns.
  it('keeps the since steer OUT of the description (taught via argRedirects at zero prompt weight)', () => {
    expect(String(inboxTool.description)).not.toMatch(/time bounds \(`since`\)/i);
    expect(inboxTool.guidance?.argRedirects?.since).toBeDefined();
  });
});

describe('coord:inbox kind filter parity', () => {
  it('accepts every canonical CoordKind, including executable yield', () => {
    const canonicalKinds = [...COORD_EXECUTABLE_KINDS, ...COORD_CONVERSATIONAL_KINDS];

    for (const kind of canonicalKinds) {
      expect(
        inboxTool.args.safeParse({ kinds: [kind] }).success,
        `coord:inbox should accept canonical kind ${kind}`,
      ).toBe(true);
    }
  });

  it('distinguishes conceptual interrupts from the canonical yield wire kind', () => {
    const description = String(inboxTool.description);
    const canonicalKinds = [...COORD_EXECUTABLE_KINDS, ...COORD_CONVERSATIONAL_KINDS];

    expect(description).toMatch(/canonical `CoordKind` wire values/i);
    expect(description).toMatch(/`interrupt` is conceptual language.*not a `kinds` value/i);
    expect(description).toMatch(/cooperative turn-interrupt\/wrap-up.*canonical executable kind `yield`/i);
    for (const kind of canonicalKinds) {
      expect(description, `description should name canonical kind ${kind}`).toContain(kind);
    }
    expect(inboxTool.args.safeParse({ kinds: ['interrupt'] }).success).toBe(false);
  });
});

describe('coord:thread', () => {
  it('documents that an inbox msg_id is passed as root_msg_id', () => {
    const guidance = `${String(threadTool.description)} ${JSON.stringify(threadTool.guidance ?? {})}`;
    expect(guidance).toMatch(/inbox.*msg_id.*root_msg_id/i);
    expect(guidance).toMatch(/no [`']?msg_id[`']? argument/i);
  });

  it('reconstructs the thread rooted at a message (root + its ack)', async () => {
    const m = await sendMessage(id('alice'), { to: ['*'], summary: 'heads up' });
    await sendMessage(id('bob'), { to: ['alice'], kind: 'ack', related_msg_id: m.msg_id });

    const body = parse(await run(threadTool, { root_msg_id: m.msg_id }));
    expect(body.root).toBe(m.msg_id);
    const ids = body.entries.map((e: { msg_id: string }) => e.msg_id);
    expect(ids).toContain(m.msg_id);
    expect(body.entries.some((e: { kind: string }) => e.kind === 'ack')).toBe(true);
  });

  it('bounds a large thread while retaining the root and newest entries', async () => {
    const root = await sendMessage(id('alice'), {
      to: ['*'],
      summary: 'root ' + 'x'.repeat(2_000),
      body: 'body ' + 'y'.repeat(2_000),
    });
    const replyMsgIds: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      const reply = await sendMessage(id('bob'), {
        to: ['alice'],
        related_msg_id: root.msg_id,
        summary: `reply-${i} ` + 'z'.repeat(2_000),
      });
      replyMsgIds.push(reply.msg_id);
    }

    const body = parse(await run(threadTool, { root_msg_id: root.msg_id }));
    expect(body.entries_total).toBe(25);
    expect(body.entries_shown).toBeLessThan(20);
    expect(body.entries_shown).toBe(body.entries.length);
    expect(body.entries_truncated).toBe(true);
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(THREAD_RESPONSE_BUDGET_CHARS);
    expect(body.entries[0].msg_id).toBe(root.msg_id);
    expect(body.entries.at(-1).summary).toContain('reply-23');
    expect(body.entries.at(-1).summary_truncated).toBe(true);
    expect(body.entries.at(-1).summary_full_chars).toBeGreaterThan(600);
    expect(body.next_page_offset).toBe(0);

    const recovered: string[] = [];
    let pageOffset: number | null = body.next_page_offset;
    let pageCount = 0;
    while (pageOffset !== null) {
      const page = parse(await run(threadTool, { root_msg_id: root.msg_id, page_offset: pageOffset }));
      expect(page.page_offset).toBe(pageOffset);
      expect(page.entries.length).toBeGreaterThan(0);
      recovered.push(...page.entries.map((entry: { msg_id: string }) => entry.msg_id));
      const nextPageOffset = page.next_page_offset as number | null;
      if (nextPageOffset !== null) expect(nextPageOffset).toBeGreaterThan(pageOffset);
      pageOffset = nextPageOffset;
      pageCount += 1;
      expect(pageCount).toBeLessThanOrEqual(25);
    }
    expect(new Set(recovered)).toEqual(new Set([root.msg_id, ...replyMsgIds]));
  });

  it('projects away oversized open-envelope metadata before serializing the thread', async () => {
    const root = await sendMessage(id('alice'), {
      to: ['*'],
      summary: 'metadata overflow repro',
      extra: {
        diagnostic_blob: 'x'.repeat(100_000),
        nested_diagnostic: { payload: 'y'.repeat(100_000) },
      },
    });

    const body = parse(await run(threadTool, { root_msg_id: root.msg_id }));
    const entry = body.entries[0] as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(entry).toMatchObject({
      msg_id: root.msg_id,
      kind: 'message',
      summary: 'metadata overflow repro',
      thread_metadata_truncated: true,
    });
    expect(entry.thread_metadata_fields_omitted).toBeGreaterThan(0);
    expect(entry.diagnostic_blob).toBeUndefined();
    expect(entry.nested_diagnostic).toBeUndefined();
    expect(serialized).not.toContain('x'.repeat(1_000));
    expect(serialized).not.toContain('y'.repeat(1_000));
    expect(serialized.length).toBeLessThan(10_000);
  });

  it('fits authored thread metadata under the result budget while keeping the root and newest entry', async () => {
    const basedOn = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ref: `work-item:WI-${6000 + i}#completion`,
        via: 'work_items:get',
        readAt: '2026-10-07T08:30:00.000Z',
        versionAtSend: `open@${'v'.repeat(72)}`,
      }));

    const root = await sendMessage(id('alice'), {
      to: ['*'],
      summary: 'thread root',
      body: 'root body',
      extra: { basedOn: basedOn(3) },
    });
    await sendMessage(id('bob'), {
      to: ['alice'],
      related_msg_id: root.msg_id,
      summary: 'middle entry',
      body: 'middle body',
      extra: { basedOn: basedOn(30) },
    });
    const newest = await sendMessage(id('bob'), {
      to: ['alice'],
      related_msg_id: root.msg_id,
      summary: 'newest entry',
      body: 'newest body',
      extra: { basedOn: basedOn(3) },
    });

    const body = parse(await run(threadTool, { root_msg_id: root.msg_id }));

    expect(JSON.stringify(body).length).toBeLessThanOrEqual(THREAD_RESPONSE_BUDGET_CHARS);
    expect(body.entries_total).toBe(3);
    expect(body.entries_truncated).toBe(true);
    expect(body.entries_shown).toBe(body.entries.length);
    expect(body.entries[0].msg_id).toBe(root.msg_id);
    expect(body.entries.at(-1).msg_id).toBe(newest.msg_id);
    expect(body.entries[0].authored.basedOn).toHaveLength(3);
  });

  it('reduces one oversized root entry to core details within the result budget', async () => {
    const root = await sendMessage(id('alice'), {
      to: ['*'],
      summary: 'large authored root',
      body: 'root body',
      extra: {
        basedOn: Array.from({ length: 80 }, (_, i) => ({
          ref: `work-item:WI-${7000 + i}#completion`,
          via: 'work_items:get',
          readAt: '2026-10-07T08:30:00.000Z',
          versionAtSend: `open@${'x'.repeat(120)}`,
        })),
      },
    });

    const body = parse(await run(threadTool, { root_msg_id: root.msg_id }));

    expect(JSON.stringify(body).length).toBeLessThanOrEqual(THREAD_RESPONSE_BUDGET_CHARS);
    expect(body.entries_total).toBe(1);
    expect(body.entries_shown).toBe(1);
    expect(body.content_truncated).toBe(true);
    expect(body.entries[0]).toMatchObject({
      msg_id: root.msg_id,
      from: 'alice',
      thread_entry_truncated: true,
    });
    expect(body.entries[0].authored).toBeUndefined();
  });
});

describe('coord:ack', () => {
  it('acks a real message back to its sender', async () => {
    const m = await sendMessage(id('alice'), { to: ['*'], summary: 'please review' });
    const body = parse(await run(ackTool, { msg_id: m.msg_id }));
    // Bulk envelope (bulk-endpoint-standardization-2026-06-21): one ack is n=1 of
    // the batch; the per-message result self-describes under results[0].
    expect(body.ok).toBe(true);
    expect(body.results[0].acked).toBe(m.msg_id);
    expect(body.results[0].acked_from).toBe('alice'); // addressed back at the sender
    expect(body.results[0].ack_msg_id).toBeTruthy();

    // The ack is now in the thread.
    const thread = parse(await run(threadTool, { root_msg_id: m.msg_id }));
    expect(thread.entries.some((e: { kind: string; from: string }) => e.kind === 'ack' && e.from === 'me')).toBe(true);
  });

  it('returns a per-item unknown_msg_id for a msg_id that does not exist', async () => {
    const res = await run(ackTool, { msg_id: 'never' });
    // Bulk verbs never set top-level isError; a bad item surfaces under results[i] AND
    // in the envelope ok, which is DERIVED (`counts.failed === 0`) — EI-23737206446729041.
    expect(parse(res)).toMatchObject({ ok: false, results: [{ ok: false, error: 'unknown_msg_id' }] });
  });
});

// ── C3: the watermark HANDLERS (the store watermarks.ts is tested separately;
// these pin the tool wrappers — identity resolution + the partial-patch path +
// the envelope shape). Run over an InMemoryWatermarkStore.
// ── `coord:watermark-set` RETIRED — plan fleet-deltas-leader-primitives-2026-07-10,
// D-014. It was the client-REPORTED cursor write, with exactly one caller (the OMP
// hook's `onTurnEnd`), which meant no Claude/Codex session ever wrote the cursor at
// all. Both pointers it carried now settle SERVER-side from the authoritative read
// receipt: `messages_since_ts` at `journal:record-turn` (turn-end-tracking-io.ts,
// which fires on every CLI), and plan-events via the server-side read cursors.
//
// Its two cases here tested the tool's ARG ROUTING and its partial-patch behaviour.
// Arg routing died with the args. The partial-patch property belongs to
// `writeWatermark` itself, not to the deleted wrapper, so it is pinned directly —
// otherwise retiring the verb would silently drop a real invariant, which is how a
// deletion quietly widens the blast radius of the NEXT change.
describe('writeWatermark — partial patch (survives the coord:watermark-set retirement)', () => {
  it('is a partial patch — omitted fields keep their prior value', async () => {
    await writeWatermark('me', {
      messages_since_ts: '2026-06-16T10:00:00.000Z',
      escalations_since_ts: '2026-06-16T11:00:00.000Z',
    });
    // A second write carrying ONLY messages_since_ts must not clobber escalations.
    await writeWatermark('me', { messages_since_ts: '2026-06-16T20:00:00.000Z' });
    const wm = await readWatermark('me');
    expect(wm.messages_since_ts).toBe('2026-06-16T20:00:00.000Z'); // advanced
    expect(wm.escalations_since_ts).toBe('2026-06-16T11:00:00.000Z'); // preserved
  });
});

describe('coord:watermark (the turn-start read handler)', () => {
  it('reads the caller\'s persisted watermark + carries owner_id in the envelope', async () => {
    await writeWatermark('me', { messages_since_ts: '2026-06-16T09:00:00.000Z' });
    const body = parse(await run(watermarkTool));
    expect(body.owner_id).toBe('me');
    expect(body.watermark.messages_since_ts).toBe('2026-06-16T09:00:00.000Z');
  });

  it('a never-written owner reads an empty watermark', async () => {
    const body = parse(await run(watermarkTool));
    expect(body.owner_id).toBe('me');
    expect(body.watermark).toEqual(emptyWatermark());
  });
});

// ── C4: the escalate / escalations / handoff / handoffs HANDLERS (the lib
// escalations.ts / handoffs.ts is tested separately; these pin the tool
// wrappers over an InMemoryCoordLog). The spawn-gate routing case is the
// security-relevant one (P1).
describe('coord:escalate handler', () => {
  it('maps severity / options / plan_slug onto an open escalation record', async () => {
    const body = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'need a human call',
        body: 'detail',
        plan_slug: 'plan-x-2026-06-16',
        options: [
          { id: 'go', label: 'Go' },
          { id: 'stop', label: 'Stop' },
        ],
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.msg_id).toBeTruthy();
    expect(body.coalesced).toBeUndefined();

    const open = parse(await run(escalationsTool, { status: 'open' }));
    const rec = open.escalations.find((e: { msg_id: string }) => e.msg_id === body.msg_id);
    expect(rec).toBeTruthy();
    expect(rec.severity).toBe('blocker');
    expect(rec.summary).toBe('need a human call');
    expect(rec.plan_slug).toBe('plan-x-2026-06-16');
    expect(rec.options).toHaveLength(2);
    expect(rec.to).toEqual(['human']); // the channel always addresses the human
    expect(rec.resolved).toBeNull();
  });

  it('stamps raise-time predicate and evidence validation results with checkedAt', async () => {
    const body = parse(
      await runWithCtx(
        escalateTool,
        {
          severity: 'question',
          summary: 'validate this machine-checkable ask',
          predicate: {
            tool: 'coord:watermark',
            path: 'watermark.messages_since_ts',
            op: 'exists',
          },
          evidence: {
            band: 'tool-output',
            ref: 'package.json',
          },
        },
        { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' },
      ),
    );

    expect(body).toMatchObject({
      ok: true,
      predicate_validation: {
        status: expect.any(String),
        checkedAt: expect.any(String),
      },
      evidence_validation: {
        status: 'present',
        ref: 'package.json',
        checkedAt: expect.any(String),
      },
    });
    expect(Number.isNaN(Date.parse(body.predicate_validation.checkedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(body.evidence_validation.checkedAt))).toBe(false);

    const open = parse(await run(escalationsTool, { status: 'open' }));
    const rec = open.escalations.find((e: { msg_id: string }) => e.msg_id === body.msg_id);
    expect(rec).toMatchObject({
      escalationPredicate: {
        tool: 'coord:watermark',
        path: 'watermark.messages_since_ts',
        op: 'exists',
        args: {},
      },
      predicateValidation: {
        status: body.predicate_validation.status,
        checkedAt: body.predicate_validation.checkedAt,
      },
      evidenceValidation: {
        status: 'present',
        ref: 'package.json',
        checkedAt: body.evidence_validation.checkedAt,
      },
    });
  });

  // The escalation-flood fix: a watchdog re-checking the SAME condition on a cadence
  // writes a summary carrying a live count/duration, so the summary-derived dedup
  // signature never repeats and every wake used to leak a new permanently-open row.
  // A stable conditionKey must collapse those firings onto ONE open escalation.
  it('coalesces re-fires of the same conditionKey onto one open row, even as the summary changes', async () => {
    const first = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Mug stalled ~7h — 8 auto-eligible items stuck',
        conditionKey: 'mug-placement-stall',
      }),
    );
    const second = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Mug stalled ~10h — 12 auto-eligible items stuck',
        conditionKey: 'mug-placement-stall',
      }),
    );
    expect(second.msg_id).toBe(first.msg_id); // same row, bumped — not a new one
    expect(second.coalesced).toBe(true);
    expect(second.existingMsgId).toBe(first.msg_id);
    expect(second.bodyDiscarded).toBe(true);
    expect(second.notice).toMatch(/^COALESCED:/);

    // Exactly one open row survives both firings — the leak this key exists to stop.
    // (repeatCount/lastSeenTs are asserted only here as "not a second row": the bump is
    // PERSISTED by the PG projection path, while the append-only in-memory fold this
    // double exercises can only return a bumped view — it must not rewrite a past event.)
    const open = parse(await run(escalationsTool, { status: 'open' }));
    const mine = open.escalations.filter(
      (e: { msg_id: string }) => e.msg_id === first.msg_id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].summary).toBe('Mug stalled ~10h — 12 auto-eligible items stuck');
  });

  it('still opens distinct rows for distinct conditionKeys', async () => {
    const a = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Mug stalled',
        conditionKey: 'mug-placement-stall',
      }),
    );
    const b = parse(
      await run(escalateTool, {
        severity: 'blocker',
        summary: 'Work feed dead',
        conditionKey: 'work-feed-dead',
      }),
    );
    expect(b.msg_id).not.toBe(a.msg_id);
  });

  // Without a key the old behavior stands: two differently-worded escalations are
  // two rows. This is what makes the key necessary — it is not a regression.
  it('without a conditionKey, differently-worded re-fires still open separate rows', async () => {
    const a = parse(
      await run(escalateTool, { severity: 'blocker', summary: 'Mug stalled ~7h' }),
    );
    const b = parse(
      await run(escalateTool, { severity: 'blocker', summary: 'Mug stalled ~10h' }),
    );
    expect(b.msg_id).not.toBe(a.msg_id);
  });
});

describe('coord:escalations handler status filter', () => {
  it('filters open vs resolved', async () => {
    const e1 = parse(await run(escalateTool, { severity: 'advisory', summary: 'a' }));
    await run(escalateTool, { severity: 'question', summary: 'b' });
    // Resolve the first via the resolve handler.
    const resolved = parse(await run(resolveTool, { msg_id: e1.msg_id, choice: 'ok' }));
    expect(resolved.ok).toBe(true);

    const open = parse(await run(escalationsTool, { status: 'open' }));
    expect(open.escalations.map((e: { summary: string }) => e.summary)).toEqual(['b']);
    const done = parse(await run(escalationsTool, { status: 'resolved' }));
    expect(done.escalations.map((e: { summary: string }) => e.summary)).toEqual(['a']);
  });

  it('lets judge read one known escalation by exact msg_id and refuses list/search reads', async () => {
    const opened = parse(await run(escalateTool, { severity: 'advisory', summary: 'judge evidence target' }));

    expect(escalationsTool.agentRoles).toContain('judge');
    const exact = parse(await runWithCtx(escalationsTool, { msg_id: opened.msg_id }, { role: 'judge' }));
    expect(exact.escalations).toHaveLength(1);
    expect(exact.escalations[0]).toMatchObject({ msg_id: opened.msg_id, summary: 'judge evidence target' });
    expect(exact.truncated).toBe(false);

    const unfiltered = await runWithCtx(escalationsTool, {}, { role: 'judge' });
    expect(unfiltered.isError).toBe(true);
    expect(parse(unfiltered)).toMatchObject({ error: 'judge_requires_exact_msg_id' });

    const filtered = await runWithCtx(
      escalationsTool,
      { msg_id: opened.msg_id, q: 'judge evidence' },
      { role: 'judge' },
    );
    expect(filtered.isError).toBe(true);
    expect(parse(filtered)).toMatchObject({ error: 'judge_requires_exact_msg_id' });
  });
});

describe('coord:handoff + coord:handoffs handlers (open → accept → list filter)', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Opening a handoff to a concrete addressee fires the wake-on-open fanout,
    // which has no wake infra under the InMemoryCoordLog and fail-softs with a
    // `[coord:handoff] wake-on-open … failed` warn — expected noise, not a failure.
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('opens a handoff, accepts it, and the listing filters by status', async () => {
    const opened = parse(
      await run(handoffTool, {
        to: ['B'],
        plan_slug: 'plan-h-2026-06-16',
        summary: 'phase 1 done',
        next_action: 'pick up phase 2',
        files_modified: ['lib/foo.ts'],
      }),
    );
    expect(opened.ok).toBe(true);
    expect(opened.msg_id).toBeTruthy();

    // Open before acceptance.
    const openList = parse(await run(handoffsTool, { status: 'open' }));
    expect(openList.handoffs.map((h: { record: { msg_id: string } }) => h.record.msg_id)).toContain(
      opened.msg_id,
    );

    // Accept via the same tool with accept_msg_id (takes the accept branch).
    const accepted = parse(await run(handoffTool, { accept_msg_id: opened.msg_id, note: 'on it' }));
    expect(accepted.ok).toBe(true);
    expect(accepted.accepted.kind).toBe('handoff_accepted');
    expect(accepted.accepted.related_msg_id).toBe(opened.msg_id);

    // Now it lists as accepted and no longer as open.
    const acceptedList = parse(await run(handoffsTool, { status: 'accepted' }));
    expect(
      acceptedList.handoffs.map((h: { record: { msg_id: string } }) => h.record.msg_id),
    ).toContain(opened.msg_id);
    const openAfter = parse(await run(handoffsTool, { status: 'open' }));
    expect(
      openAfter.handoffs.map((h: { record: { msg_id: string } }) => h.record.msg_id),
    ).not.toContain(opened.msg_id);
  });

  it('open-handoff missing required fields → missing_fields (isError)', async () => {
    const res = await run(handoffTool, { summary: 'incomplete' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, error: 'missing_fields' });
  });

  it('accept of an unknown msg_id → not_found (isError)', async () => {
    const res = await run(handoffTool, { accept_msg_id: 'never' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, error: 'not_found' });
  });
});

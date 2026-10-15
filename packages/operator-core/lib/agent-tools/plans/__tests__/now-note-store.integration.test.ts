/**
 * now-note-store.integration.test.ts — derived-status-not-hand-written-2026-10-12
 * P-004 (D-007 / D-008), against real Postgres with migration 1480 applied.
 *
 * Drives the REAL plans:set-now and plans:set-content handlers through
 * withPlanLock (shared baseline-schema fixture), and the real federated note
 * apply, to pin the storage contract:
 *   1. a plan that never had a note reads its content `## Now` (migrate on read);
 *   2. set-now stores the note and its now_state/now_next projection while
 *      content, content_hash and version stay byte-identical;
 *   3. a later content write keeps now_state/now_next from the note;
 *   4. a peer note applies only when newer, and never moves the row clock back;
 *   5. (SPEC-P-004) a content write migrates an existing `## Now` section into a
 *      stored note with the same text, keeps a set-now note when the section
 *      comes back unchanged, and adopts a deliberate edit of the section.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setNowTool from '../set-now';
import setContentTool from '../set-content';
import { readPlanBySlug } from '../source';
import { applyFederatedNowNote, readPlanNowNote, type NowNoteSql, type PlanNowNote } from '../now-note-store';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-now-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-now-note-plan-2026-10-12';
const WS = DEFAULT_WORKSPACE_ID;
const SCOPE = { workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG };

const BODY = `---
title: Now Note Plan
slug: ${SLUG}
created: 2026-10-12
updated: 2026-10-12
status: active
---

# Now Note Plan

## Now

**State:** Legacy content state.

**Next:** Legacy content next.

## Background

Some prose for the body.

## Decisions
`;

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: 'agent-now-note-test', workspaceId: WS },
  } as never;
}

/** A tool result as data, whichever envelope the handler returns. */
function dataOf(res: unknown): Record<string, any> {
  const r = res as { data?: Record<string, any>; content?: Array<{ text: string }> };
  return r.data ?? JSON.parse(r.content![0].text);
}

interface Row {
  content: string;
  content_hash: string;
  version: number | string;
  now_state: string | null;
  now_next: string | null;
  now_note: unknown;
  fed_ts: string | null;
  fed_hlc: string | null;
  origin: string | null;
}

async function row(): Promise<Row> {
  const [r] = await admin<Row[]>`
    SELECT content, content_hash, version, now_state, now_next, now_note,
           fed_ts::text AS fed_ts, fed_hlc, origin
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  return r!;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await seedPlan(admin, WS, HARNESS, SLUG, BODY);
});

describe("AUTO-BAR-R-12: plans:set-now stores the note as structured fields without changing the plan's markdown content", () => {
  it('reads the content ## Now when no note was ever written', async () => {
    expect((await row()).now_note).toBeNull();
    const read = await readPlanBySlug(SLUG, { harnessSlug: HARNESS });
    expect(read?.parsed.now?.state).toBe('Legacy content state.');
    expect(read?.parsed.now?.next).toBe('Legacy content next.');
  });

  it('set-now stores the note without touching content, hash or version', async () => {
    const before = await row();
    const res = await setNowTool.handler(
      { harness: HARNESS, slug: SLUG, state: 'Structured state.', next: 'Structured next.', rationale: 'why' } as never,
      makeCtx(),
    );
    const data = dataOf(res);
    expect(data.results?.[0]?.ok ?? data.ok).toBe(true);

    const after = await row();
    expect(after.content).toBe(before.content);
    expect(after.content_hash).toBe(before.content_hash);
    expect(Number(after.version)).toBe(Number(before.version));
    expect(after.now_state).toBe('Structured state.');
    expect(after.now_next).toBe('Structured next.');

    const note = await readPlanNowNote(admin as unknown as NowNoteSql, SCOPE);
    expect(note).toMatchObject({
      state: 'Structured state.',
      next: 'Structured next.',
      rationale: 'why',
      source: 'set-now',
    });
    expect(note?.eventId).toEqual(expect.any(String));

    // Readers prefer the note over the frozen content section.
    const read = await readPlanBySlug(SLUG, { harnessSlug: HARNESS });
    expect(read?.parsed.now?.state).toBe('Structured state.');
    expect(read?.parsed.now?.next).toBe('Structured next.');
  });

  it('a later content write keeps now_state/now_next from the note', async () => {
    await setNowTool.handler(
      { harness: HARNESS, slug: SLUG, state: 'Note state.', next: 'Note next.' } as never,
      makeCtx(),
    );
    const res = await setContentTool.handler(
      { harness: HARNESS, slug: SLUG, content: BODY.replace('Some prose for the body.', 'Revised prose.') } as never,
      makeCtx(),
    );
    const data = dataOf(res);
    expect(data.ok ?? data.results?.[0]?.ok).not.toBe(false);

    const after = await row();
    expect(after.content).toContain('Revised prose.');
    expect(after.content).toContain('**State:** Legacy content state.');
    expect(after.now_state).toBe('Note state.');
    expect(after.now_next).toBe('Note next.');
  });

  it('applies a peer note only when newer, and never moves the row clock back', async () => {
    const sql = admin as unknown as NowNoteSql;
    const peer = (writtenAt: string, state: string): PlanNowNote => ({
      state, next: 'peer next', author: 'su-peer', writtenAt, eventId: `msg-${state}`,
      rationale: null, source: 'set-now',
    });
    // The seeded row's clock, whatever the capture trigger stamped on the local insert.
    // harness_shared.fed_order_key orders by the HLC text when present (else a
    // zero-padded ts), so op clocks are built as text keys around the row's key:
    // '0' sorts below any stamped key, and key + '~' sorts above it.
    const base = await row();
    const rowKey = base.fed_hlc ?? `${String(base.fed_ts ?? 0).padStart(15, '0')}:00000`;
    const olderOp = { origin: 'remote', fedTs: null, fedHlc: '0' };
    const newerOp = { origin: 'remote', fedTs: null, fedHlc: `${rowKey}~` };
    const clockOf = (r: Row) => [r.fed_ts, r.fed_hlc];

    // Newer note, but an OLDER op clock than the row's: the note applies, the clock stays.
    expect(await applyFederatedNowNote(sql, SCOPE, peer('2026-10-12T10:00:00.000Z', 'peer-new'), olderOp))
      .toBe(true);
    let r = await row();
    expect(r.now_state).toBe('peer-new');
    expect(clockOf(r)).toEqual(clockOf(base));

    // Older note with a NEWER op clock: ignored entirely.
    expect(await applyFederatedNowNote(sql, SCOPE, peer('2026-10-12T09:00:00.000Z', 'peer-old'), newerOp))
      .toBe(false);
    r = await row();
    expect(r.now_state).toBe('peer-new');
    expect(clockOf(r)).toEqual(clockOf(base));

    // Newer note with a newer op clock: the note applies; the row clock still stays
    // (D-009: the note is ordered by writtenAt, never by the row clock), and the row
    // is not re-stamped as a local write.
    expect(await applyFederatedNowNote(sql, SCOPE, peer('2026-10-12T11:00:00.000Z', 'peer-newest'), newerOp))
      .toBe(true);
    r = await row();
    expect(r.now_state).toBe('peer-newest');
    expect(clockOf(r)).toEqual(clockOf(base));
    expect(r.origin).toBe('remote');
    expect(r.content).toBe(BODY);
  });
});

describe('SPEC-P-004: migrating an existing Now section yields a stored note with the same text', () => {
  async function writeContent(body: string): Promise<void> {
    const data = dataOf(await setContentTool.handler({ harness: HARNESS, slug: SLUG, content: body } as never, makeCtx()));
    expect(data.ok ?? data.results?.[0]?.ok).not.toBe(false);
  }

  it('a content write stores the existing Now section as a note with the same state and next', async () => {
    expect((await row()).now_note).toBeNull();
    await writeContent(BODY.replace('Some prose for the body.', 'Unrelated edit.'));

    const note = await readPlanNowNote(admin as unknown as NowNoteSql, SCOPE);
    expect(note).toMatchObject({
      state: 'Legacy content state.',
      next: 'Legacy content next.',
      source: 'content',
      eventId: null,
    });
    const after = await row();
    expect(after.now_state).toBe('Legacy content state.');
    expect(after.now_next).toBe('Legacy content next.');
    // The section stays in content as it was; only the note column was added.
    expect(after.content).toContain('**State:** Legacy content state.');

    const read = await readPlanBySlug(SLUG, { harnessSlug: HARNESS });
    expect(read?.parsed.now?.state).toBe('Legacy content state.');
    expect(read?.parsed.now?.next).toBe('Legacy content next.');
  });

  it('a round-tripped content write that carries the frozen section back unchanged keeps the set-now note', async () => {
    await setNowTool.handler(
      { harness: HARNESS, slug: SLUG, state: 'Note state.', next: 'Note next.' } as never,
      makeCtx(),
    );
    const before = await readPlanNowNote(admin as unknown as NowNoteSql, SCOPE);
    await writeContent(BODY.replace('Some prose for the body.', 'Round-tripped edit.'));

    const after = await readPlanNowNote(admin as unknown as NowNoteSql, SCOPE);
    expect(after).toEqual(before);
    expect(after?.source).toBe('set-now');
  });

  it('a content write that edits the Now section replaces the stored note with the edited text', async () => {
    await setNowTool.handler(
      { harness: HARNESS, slug: SLUG, state: 'Note state.', next: 'Note next.' } as never,
      makeCtx(),
    );
    await writeContent(
      BODY.replace('**State:** Legacy content state.', '**State:** Edited in content.')
        .replace('**Next:** Legacy content next.', '**Next:** Edited next.'),
    );

    const note = await readPlanNowNote(admin as unknown as NowNoteSql, SCOPE);
    expect(note).toMatchObject({ state: 'Edited in content.', next: 'Edited next.', source: 'content' });
    const r = await row();
    expect(r.now_state).toBe('Edited in content.');
    expect(r.now_next).toBe('Edited next.');
  });

  it('a content write with no Now section stores no note', async () => {
    await writeContent(BODY.replace(/## Now\n[\s\S]*?(?=## Background)/, ''));
    expect((await row()).now_note).toBeNull();
  });
});

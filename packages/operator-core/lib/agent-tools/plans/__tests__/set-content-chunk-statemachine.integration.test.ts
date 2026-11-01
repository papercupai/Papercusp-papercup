/**
 * set-content-chunk-statemachine.integration.test.ts — the plans:set-content-chunk
 * begin/append/commit/abort state machine driven end-to-end.
 *
 * Only the pure join (appendChunkToContent) is unit-tested; the staged-draft
 * lifecycle + the commit write are the gap. The draft store is an on-disk
 * tmpdir FS (os.tmpdir()/papercusp-plan-content-drafts); commit is the only op
 * that touches the real plan row (through withPlanLock, reusing set-content's
 * CAS/lint/legacy/revision behavior). This covers:
 *
 *   - begin → append → commit round-trips a chunked body onto a seeded plan:
 *     the harness_plans row is updated AND exactly one plan_revisions row lands.
 *   - commit with a bogus draftId → draft_not_found (nothing written).
 *   - append with a mismatched slug → draft_mismatch.
 *   - abort removes the draft (a later commit on it → draft_not_found).
 *
 * Self-contained PG (own container + real migrations), wired like the sibling
 * plans integration tests so the file runs from operator-core's own config.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import chunkTool from '../set-content-chunk';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-chunk-plan-2026-06-04';
const OTHER_SLUG = 'zzz-chunk-other-2026-06-04';
const WS = DEFAULT_WORKSPACE_ID;

/** A starting plan body (so the row exists for commit's CAS/lint to read). */
function seedBody(): string {
  return `---
title: Chunk Plan
slug: ${SLUG}
created: 2026-06-04
updated: 2026-06-04
status: active
---

# Chunk Plan

## Now

**State:** original.

**Next:** rewrite via chunks.

## Decisions
`;
}

/** The full replacement body, split into two valid chunks (concatenate = whole). */
const NEW_HEAD = `---
title: Chunk Plan REWRITTEN
slug: ${SLUG}
created: 2026-06-04
updated: 2026-06-04
status: active
---

# Chunk Plan REWRITTEN

## Now

**State:** rewritten through begin/append/commit.

`;
const NEW_TAIL = `**Next:** verify the revision landed.

## Background

This body arrived in two chunks.

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
    principal: { kind: 'agent', slug: 'agent-chunk-test', workspaceId: WS },
  } as never;
}

async function runChunk(args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const res = (await chunkTool.handler({ harness: HARNESS, slug: SLUG, ...args } as never, makeCtx())) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0].text), isError: res.isError === true };
}

/**
 * The failure code on a chunk result. Per EI-6, set-content-chunk now reports
 * EVERY failure under a canonical `error` key (matching edit.ts / set-content.ts);
 * `code` is retained alongside it. We assert `error` is the source of truth and
 * that it agrees with `code` when both are present, so a regression that drops
 * `error` from any guard path is caught.
 */
function failCode(data: Record<string, unknown>): unknown {
  expect(data.error, 'every chunk failure must carry a canonical `error` key (EI-6)').toBeDefined();
  if (data.code !== undefined) expect(data.error).toBe(data.code);
  return data.error;
}

async function revisionCount(): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM harness_shared.plan_revisions
     WHERE harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function liveContent(): Promise<string> {
  const rows = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return rows[0]?.content ?? '';
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 180_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await seedPlan(admin, WS, HARNESS, SLUG, seedBody());
});

describe('plans:set-content-chunk — begin → append → commit round-trip', () => {
  it('streams a chunked body onto the seeded plan and records one revision', async () => {
    expect(await revisionCount()).toBe(0);

    // begin with the first chunk.
    const begin = await runChunk({ op: 'begin', chunk: NEW_HEAD });
    expect(begin.isError).toBe(false);
    expect(begin.data.ok).toBe(true);
    expect(begin.data.op).toBe('begin');
    const draftId = String(begin.data.draftId);
    expect(draftId.length).toBeGreaterThan(8);
    expect(begin.data.chunks).toBe(1);

    // append the rest.
    const append = await runChunk({ op: 'append', draftId, chunk: NEW_TAIL });
    expect(append.isError).toBe(false);
    expect(append.data.ok).toBe(true);
    expect(append.data.chunks).toBe(2);

    // commit — writes the joined body, records exactly one revision.
    const commit = await runChunk({ op: 'commit', draftId });
    expect(commit.isError).toBe(false);
    expect(commit.data.ok).toBe(true);
    expect(commit.data.op).toBe('commit');
    expect(commit.data.revision).toEqual({ seq: 1 });
    expect(typeof commit.data.contentHash).toBe('string');

    expect(await revisionCount()).toBe(1);
    const content = await liveContent();
    expect(content).toContain('Chunk Plan REWRITTEN');
    expect(content).toContain('This body arrived in two chunks.');
    expect(content).not.toContain('**Next:** rewrite via chunks.');

    // The committed draft is cleaned up → a second commit on it fails.
    const again = await runChunk({ op: 'commit', draftId });
    expect(again.isError).toBe(true);
    expect(failCode(again.data)).toBe('draft_not_found');
  });
});

describe('plans:set-content-chunk — failure branches', () => {
  it('requires an explicit decision-drop override and keeps the draft available for retry', async () => {
    const before = seedBody().replace(
      '## Decisions\n',
      '## Decisions\n\n### D-001 — Preserve this ruling\nThis decision must not be silently removed.\n',
    );
    await cleanupPlans(admin, WS, HARNESS);
    await seedPlan(admin, WS, HARNESS, SLUG, before);

    const begin = await runChunk({ op: 'begin', chunk: NEW_HEAD + NEW_TAIL });
    const draftId = String(begin.data.draftId);
    const refused = await runChunk({ op: 'commit', draftId });

    expect(refused.isError).toBe(true);
    expect(failCode(refused.data)).toBe('decisions_would_be_dropped');
    expect(refused.data.droppedDecisionIds).toEqual(['D-001']);
    expect(await liveContent()).toBe(before);
    expect(await revisionCount()).toBe(0);

    const allowed = await runChunk({ op: 'commit', draftId, allowDecisionDrop: true });
    expect(allowed.isError).toBe(false);
    expect(allowed.data.ok).toBe(true);
    expect(await liveContent()).not.toContain('D-001');
    expect(await revisionCount()).toBe(1);
  });

  it('commit rejects a raw terminal status transition without changing the plan', async () => {
    const before = await liveContent();
    const begin = await runChunk({ op: 'begin', chunk: NEW_HEAD.replace('status: active', 'status: shipped') });
    const draftId = String(begin.data.draftId);
    await runChunk({ op: 'append', draftId, chunk: NEW_TAIL });

    const commit = await runChunk({ op: 'commit', draftId });
    expect(commit.isError).toBe(true);
    expect(failCode(commit.data)).toBe('plan_status_change_requires_lifecycle_writer');
    expect(commit.data.writer).toBe('plans:set-plan-status');
    expect(String(commit.data.message)).toContain('plans:set-plan-status');
    expect(await liveContent()).toBe(before);
    expect(await revisionCount()).toBe(0);
  });

  it('commit with a bogus (well-formed) draftId → draft_not_found, nothing written', async () => {
    const before = await liveContent();
    const bogus = 'deadbeef-0000-4000-8000-000000000000'; // matches DRAFT_ID but no such draft.

    const { data, isError } = await runChunk({ op: 'commit', draftId: bogus });
    expect(isError).toBe(true);
    expect(failCode(data)).toBe('draft_not_found');

    expect(await liveContent()).toBe(before);
    expect(await revisionCount()).toBe(0);
  });

  it('append with a wrong slug → draft_mismatch', async () => {
    // begin a draft for SLUG.
    const begin = await runChunk({ op: 'begin', chunk: NEW_HEAD });
    const draftId = String(begin.data.draftId);

    // append carrying a DIFFERENT slug — the draft's recorded slug no longer matches.
    const res = (await chunkTool.handler(
      { harness: HARNESS, slug: OTHER_SLUG, op: 'append', draftId, chunk: NEW_TAIL } as never,
      makeCtx(),
    )) as { content: { text: string }[]; isError?: boolean };
    const data = JSON.parse(res.content[0].text);

    expect(res.isError).toBe(true);
    expect(failCode(data)).toBe('draft_mismatch');
  });

  it('abort removes the draft → a later commit on it returns draft_not_found', async () => {
    const begin = await runChunk({ op: 'begin', chunk: NEW_HEAD });
    const draftId = String(begin.data.draftId);

    const abort = await runChunk({ op: 'abort', draftId });
    expect(abort.isError).toBe(false);
    expect(abort.data.ok).toBe(true);
    expect(abort.data.op).toBe('abort');

    const commit = await runChunk({ op: 'commit', draftId });
    expect(commit.isError).toBe(true);
    expect(failCode(commit.data)).toBe('draft_not_found');
    // Nothing was written by the aborted draft.
    expect(await revisionCount()).toBe(0);
  });
});

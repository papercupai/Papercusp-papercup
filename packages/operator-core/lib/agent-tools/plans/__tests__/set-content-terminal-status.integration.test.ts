/**
 * set-content-terminal-status.integration.test.ts — raw plans:set-content
 * cannot bypass the dedicated plan lifecycle status writer.
 *
 * Lifecycle transitions to terminal states use plans:set-plan-status, which
 * applies the gate and clears the started/paused op-row. Raw prose writes keep
 * the current status and must leave both content and operational state
 * untouched when asked to change it.
 *
 * Drives the REAL handler through Postgres via withPlanLock + the shared
 * baseline-schema fixture (setupPlanPgFixture / inject('baselineSchemaDsn')),
 * mirroring edit-handler.integration's spine but using the injected baseline DB
 * rather than a self-stood container.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setContentTool from '../set-content';
import { hashPlanContent } from '../content-hash';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-setc-term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-setc-term-plan-2026-06-04';
const WS = DEFAULT_WORKSPACE_ID;

/** A minimal non-legacy plan that lints clean, at the given lifecycle status. */
function planBody(status: 'ready' | 'active' | 'superseded' | 'shipped'): string {
  return `---
title: Terminal Side-Effect Plan
slug: ${SLUG}
created: 2026-06-04
updated: 2026-06-04
status: ${status}
---

# Terminal Side-Effect Plan

## Now

**State:** Where things stand.

**Next:** The next concrete action.

## Background

Some prose for the body.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

/** Build a ctx with a resolvable principal so the write is attributable. */
function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: 'agent-setc-term-test', workspaceId: WS },
  } as never;
}

/** Run plans:set-content under the throwaway harness; parse its JSON result. */
async function runSetContent(content: string): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  const res = (await setContentTool.handler(
    { harness: HARNESS, slug: SLUG, content } as never,
    makeCtx(),
  )) as { content: { text: string }[]; isError?: boolean };
  return { data: JSON.parse(res.content[0].text), isError: res.isError === true };
}

/** Seed the plan row AND mark it operationally started. */
async function seedStartedPlan(status: 'active'): Promise<void> {
  await seedPlan(admin, WS, HARNESS, SLUG, planBody(status));
  await admin`
    UPDATE harness_shared.harness_plans
       SET status = ${status}, op_status = 'started', op_started_at = now(), op_updated_at = now()
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
}

async function opStatus(): Promise<string | null> {
  const rows = await admin<{ op_status: string | null }[]>`
    SELECT op_status FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return rows[0]?.op_status ?? null;
}

async function planStatus(): Promise<string | null> {
  const rows = await admin<{ status: string | null }[]>`
    SELECT status FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return rows[0]?.status ?? null;
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
}, 60_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
});

describe('plans:set-content handler — lifecycle status transitions stay on the dedicated writer', () => {
  it('refuses to copy stale markdown status over the canonical plan row during an unrelated edit', async () => {
    await seedStartedPlan('active');
    const staleBody = planBody('ready');
    await admin`
      UPDATE harness_shared.harness_plans
         SET content = ${staleBody}, content_hash = ${hashPlanContent(staleBody)}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;

    expect(await planStatus()).toBe('active');
    expect(await liveContent()).toBe(staleBody);

    const proposed = staleBody.replace('Some prose for the body.', 'Revised prose for the body.');
    const { data, isError } = await runSetContent(proposed);
    expect(isError).toBe(true);
    expect(data).toMatchObject({
      error: 'plan_status_change_requires_lifecycle_writer',
      currentStatus: 'active',
      proposedStatus: 'ready',
      writer: 'plans:set-plan-status',
    });
    expect(await planStatus()).toBe('active');
    expect(await liveContent()).toBe(staleBody);
  });

  it('refuses a raw transition to superseded and leaves the started plan untouched', async () => {
    await seedStartedPlan('active');
    expect(await opStatus()).toBe('started');

    const { data, isError } = await runSetContent(planBody('superseded'));
    expect(isError).toBe(true);
    expect(data.error).toBe('plan_status_change_requires_lifecycle_writer');
    expect(data.writer).toBe('plans:set-plan-status');
    expect(await opStatus()).toBe('started');
    expect(await liveContent()).toBe(planBody('active'));
  });

  it('refuses a raw transition to shipped and leaves the started plan untouched', async () => {
    await seedStartedPlan('active');
    expect(await opStatus()).toBe('started');

    const { data, isError } = await runSetContent(planBody('shipped'));
    expect(isError).toBe(true);
    expect(data.error).toBe('plan_status_change_requires_lifecycle_writer');
    expect(data.writer).toBe('plans:set-plan-status');
    expect(await opStatus()).toBe('started');
    expect(await liveContent()).toBe(planBody('active'));
  });

  it('refuses to supersede a PAUSED plan through the raw content writer', async () => {
    await seedStartedPlan('active');
    await admin`
      UPDATE harness_shared.harness_plans SET op_status = 'paused'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(await opStatus()).toBe('paused');

    const { data, isError } = await runSetContent(planBody('superseded'));
    expect(isError).toBe(true);
    expect(data.error).toBe('plan_status_change_requires_lifecycle_writer');
    expect(await opStatus()).toBe('paused');
    expect(await liveContent()).toBe(planBody('active'));
  });
});

describe('plans:set-content handler — non-terminal write leaves the started op-row', () => {
  it('rewriting prose while staying active does NOT clear a started plan', async () => {
    await seedStartedPlan('active');
    expect(await opStatus()).toBe('started');

    // A real prose change (so it is not a no-op), still status: active.
    const next = planBody('active').replace('Some prose for the body.', 'Revised prose for the body.');
    const { data, isError } = await runSetContent(next);
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);

    // No terminal status → the started op-row is untouched.
    expect(await opStatus()).toBe('started');
  });
});

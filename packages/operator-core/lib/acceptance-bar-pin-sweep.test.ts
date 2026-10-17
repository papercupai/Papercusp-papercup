import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ withWorkspace: vi.fn(), sql: vi.fn(), inScope: vi.fn(), prime: vi.fn() }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(), withWorkspace: h.withWorkspace,
}));
vi.mock('./agent-tools/plans/plan-lock-key', async (original) => ({
  ...(await original<typeof import('./agent-tools/plans/plan-lock-key')>()),
  acquirePlanAdvisoryLock: vi.fn(async () => undefined),
}));
vi.mock('./work-scope-policy', () => ({ isHarnessInScope: h.inScope, primeWorkScopePolicy: h.prime }));

import { getOrgPg } from '@papercusp/db-org';
import { mockOrgPgSql } from './testing/mock-org-pg';
import { runAcceptanceBarPinSweep, ACCEPTANCE_BAR_PIN_SWEEP_LIMIT } from './acceptance-bar-pin-sweep';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';
import { hashPlanContent } from './agent-tools/plans/content-hash';

const target = (planSlug: string) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', planSlug });
const plan = (requirement = 'Persist the canonical BAR.', now = 'working') => `---
title: Subject
slug: subject
status: active
---
# Subject
## Now
${now}
## Requirements
**R-1 — Canonical outcome.** ${requirement}
## Design
### Bar-to-work map for this plan
| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
## Phase 1 — Build
- **P-001** \`done\` persist the canonical BAR
`;

/** Exercise the real reconciler and synchronizer, without a plan-start door. */
function arrangeSubject(nextBody: string) {
  const previous = plan();
  const seeded = buildAcceptanceBarSeed({
    planSlug: 'subject', planContent: previous, actorId: 'test', declaredAt: '2026-10-15T00:00:00Z',
    cohort: 'post-epoch', adoptionEpoch: 1, subjectPlanRevision: 2, planStatus: 'active',
    rubricSlug: 'acceptance-subject', rubricRevision: 4,
  });
  if (!seeded.ok) throw new Error('invalid BAR fixture');
  let pin = 2;
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ');
    if (query.includes('SELECT version, content, acceptance_bar_rubric_slug')) {
      return [{ version: 3, content: nextBody, acceptance_bar_rubric_slug: 'acceptance-subject' }];
    }
    if (query.includes('LEFT JOIN harness_shared.plan_revisions')) {
      return [{ subject_version: String(pin), content_snapshot: previous, content_hash: hashPlanContent(previous) }];
    }
    if (query.includes('FROM harness_shared.plan_audits')) return [];
    if (query.includes('SELECT status, acceptance_bar_rubric_slug')) {
      return [{ status: 'active', acceptance_bar_rubric_slug: 'acceptance-subject',
        acceptance_bar_rubric_revision: 4, acceptance_bar_set_hash: seeded.barSetHash }];
    }
    if (query.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
    if (query.includes('SELECT version, template_data')) return [{ version: 4, template_data: seeded.templateData }];
    if (query.includes("SET template_data = jsonb_set")) {
      pin = Number(values[0]);
      return [{ plan_slug: 'acceptance-subject' }];
    }
    if (query.includes('SET acceptance_bar_verified_revision = NULL')) return [];
    throw new Error(`unexpected query: ${query}`);
  });
  h.withWorkspace.mockImplementation(async (_ws: string, fn: (sql: unknown) => unknown) => fn(tx));
  h.sql.mockResolvedValue([target('subject')]);
  return () => pin;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrgPgSql(vi.mocked(getOrgPg), h.sql);
  h.sql.mockReset().mockResolvedValue([]);
  h.withWorkspace.mockReset();
  h.inScope.mockReset().mockReturnValue(true);
  h.prime.mockReset().mockResolvedValue(undefined);
});

describe('unattended acceptance subject-pin recovery', () => {
  it('repairs post-start neutral drift through the existing witness/hash checks', async () => {
    const pin = arrangeSubject(plan(undefined, 'D-002 recorded after starting'));
    const result = await runAcceptanceBarPinSweep();
    expect(result).toMatchObject({ scanned: 1, reconciled: 1, errors: [], nextCursor: null });
    expect(pin()).toBe(3);
    expect(h.withWorkspace).toHaveBeenCalledWith('ws', expect.any(Function));
    // Once repaired, the same target is safe if it was selected by a racing scan.
    expect(await runAcceptanceBarPinSweep()).toMatchObject({ reconciled: 0, held: { pin_current: 1 } });
  });

  it('leaves a semantic Requirements change stale for an amendment', async () => {
    const pin = arrangeSubject(plan('A different outcome.'));
    expect(await runAcceptanceBarPinSweep()).toMatchObject({ reconciled: 0, held: { not_neutral: 1 }, errors: [] });
    expect(pin()).toBe(2);
  });

  it('advances past held targets and wraps after the last page', async () => {
    h.sql.mockResolvedValueOnce([target('a'), target('b')]).mockResolvedValueOnce([target('c')]);
    h.withWorkspace.mockImplementation(async (_ws: string, fn: (sql: unknown) => unknown) => fn(vi.fn().mockResolvedValue([])));
    const first = await runAcceptanceBarPinSweep({ limit: 2 });
    expect(first).toMatchObject({ held: { plan_absent: 2 }, nextCursor: target('b') });
    const second = await runAcceptanceBarPinSweep({ after: first.nextCursor, limit: 2 });
    expect(second).toMatchObject({ scanned: 1, nextCursor: null });
    expect(h.sql.mock.calls[1]!.slice(1)).toEqual(['ws', 'ws', 'papercusp', 'b', 2]);
  });

  it('primes scope before scanning and never repairs an excluded harness', async () => {
    h.prime.mockImplementation(async () => { h.inScope.mockReturnValue(false); });
    h.sql.mockResolvedValue([target('excluded')]);
    expect(await runAcceptanceBarPinSweep()).toMatchObject({ scopeSkipped: 1, reconciled: 0 });
    expect(h.withWorkspace).not.toHaveBeenCalled();
  });

  it('reports a failed target and continues to the next one', async () => {
    h.sql.mockResolvedValue([target('a'), target('b')]);
    h.withWorkspace.mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce(async (_ws: string, fn: (sql: unknown) => unknown) => fn(vi.fn().mockResolvedValue([])));
    expect(await runAcceptanceBarPinSweep()).toMatchObject({
      scanned: 2, held: { plan_absent: 1 }, errors: [{ ...target('a'), error: 'database unavailable' }],
    });
    expect(h.withWorkspace).toHaveBeenCalledTimes(2);
  });

  it('caps work per tick and propagates an unreadable scan rather than reporting empty success', async () => {
    await runAcceptanceBarPinSweep({ limit: 5000 });
    expect(h.sql.mock.calls[0]!.at(-1)).toBe(ACCEPTANCE_BAR_PIN_SWEEP_LIMIT);
    h.sql.mockRejectedValue(new Error('scan failed'));
    await expect(runAcceptanceBarPinSweep()).rejects.toThrow('scan failed');
  });
});

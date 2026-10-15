import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { gatherScheduledOccurrences, listPlanSchedules } from './scheduled-occurrences';

const start = Date.parse('2026-06-10T00:00:00Z');
const end = Date.parse('2026-06-16T23:59:59Z');
const oneShot = '2026-06-12 17:00:00.123+02';
const expiry = '2026-06-12 23:59:59+00';

function client(overrides: Record<string, unknown> = {}) {
  const rows = [{ plan_slug: 'calendar-plan', harness_slug: 'calendar-harness', title: 'Calendar plan',
    schedule: null, schedule_active: false, scheduled_at: null, expires_at: null, tzid: null, ...overrides }];
  return vi.fn((strings: TemplateStringsArray) => Promise.resolve(
    strings.join('?').includes('FROM harness_shared.harness_plans') ? rows : [],
  )) as unknown as Sql;
}

const window = { workspaceId: 'calendar-workspace', rangeStartMs: start, rangeEndMs: end };

describe('scheduled plan timestamp read boundary', () => {
  it.each([oneShot, new Date(oneShot)])('expands a one-shot with text or Date timestamps: %s', async scheduled_at => {
    const rows = await gatherScheduledOccurrences(client({ scheduled_at }), window);
    expect(rows).toEqual([{ templateSlug: 'calendar-plan', harnessSlug: 'calendar-harness', title: 'Calendar plan',
      occurrenceMs: Date.parse(oneShot), kind: 'one-shot', scheduleActive: false, lastOutcome: null }]);
  });

  it.each([expiry, new Date(expiry)])('bounds recurring and one-shot occurrences with text or Date expiry: %s', async expires_at => {
    const rows = await gatherScheduledOccurrences(client({ expires_at, scheduled_at: new Date('2026-06-13T15:00:00Z'),
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00Z' } }), window);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.kind === 'recurring' && row.occurrenceMs <= Date.parse(expiry))).toBe(true);
  });

  it.each([false, true])('returns normalized editor timestamps and preserves nulls (Date=%s)', async dates => {
    const rows = await listPlanSchedules(client({ scheduled_at: dates ? new Date(oneShot) : oneShot,
      expires_at: dates ? new Date(expiry) : expiry }), { workspaceId: window.workspaceId });
    expect(rows[0]).toMatchObject({ scheduledAt: '2026-06-12T15:00:00.123Z', expiresAt: '2026-06-12T23:59:59.000Z' });
    expect((await listPlanSchedules(client(), { workspaceId: window.workspaceId }))[0])
      .toMatchObject({ scheduledAt: null, expiresAt: null });
  });

  it.each(['scheduled_at', 'expires_at'])('rejects invalid %s rather than reporting an empty successful calendar', async column => {
    await expect(gatherScheduledOccurrences(client({ [column]: 'not-a-date' }), window))
      .rejects.toThrow(`harness_plans.${column} is not a timestamp`);
    await expect(listPlanSchedules(client({ [column]: 'not-a-date' }), { workspaceId: window.workspaceId }))
      .rejects.toThrow(`harness_plans.${column} is not a timestamp`);
  });
});

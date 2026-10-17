import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlCalls, sqlMock, upsertMock } = vi.hoisted(() => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  return {
    sqlCalls: calls,
    sqlMock: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: Array.from(parts).join('?'), values });
      return [];
    }),
    upsertMock: vi.fn(async () => ({ id: 'WI-CONFORMANCE-DRIFT', created: true })),
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: sqlMock }) };
});
vi.mock('../coord/condition-upsert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coord/condition-upsert')>();
  return { ...actual, upsertConditionWorkItem: upsertMock };
});

import { productionConformanceDeps } from './conformance-run-deps';

const PLAN = 'cloud-portal-chat-and-guide-recovery-2026-10-09';
const CONDITION = `spec-conformance-drift:papercusp/${PLAN}/R-9`;
const filing = {
  barKey: 'R-9',
  title: 'R-9 drift',
  conditionKey: CONDITION,
  firedFalsifiers: [],
  doneWhenRegressed: true,
  summary: 'Measured R-9 drift.',
};

describe('production conformance drift alarms', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockClear();
    upsertMock.mockReset();
  });

  it('stamps the source plan on a newly filed alarm', async () => {
    upsertMock.mockResolvedValueOnce({ id: 'WI-CONFORMANCE-DRIFT', created: true });

    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await deps.openDriftAlarm(filing);

    expect(upsertMock).toHaveBeenCalledWith(CONDITION, expect.objectContaining({ sourcePlanSlug: PLAN }));
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('repairs the source plan on an adopted alarm', async () => {
    upsertMock.mockResolvedValueOnce({ id: 'WI-CONFORMANCE-DRIFT', created: false });

    const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: PLAN });
    await deps.openDriftAlarm(filing);

    expect(upsertMock).toHaveBeenCalledWith(CONDITION, expect.objectContaining({ sourcePlanSlug: PLAN }));
    expect(sqlMock).toHaveBeenCalledOnce();
    expect(sqlCalls[0]?.query).toContain('source_plan_slug = ?');
    expect(sqlCalls[0]?.values).toContain(PLAN);
  });
});

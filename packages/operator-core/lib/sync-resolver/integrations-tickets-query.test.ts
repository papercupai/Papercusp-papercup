/**
 * integrations.tickets named query (plan linear-asana-task-sync-2026-10-05 P-007, D-014): the
 * Settings → Integrations ticket page reads its whole state through it, and every table the
 * background writers touch refetches it (migration 1399 + the table bridge).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  overview: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../integrations/ticket-integrations', () => ({ ticketIntegrationsOverview: mocks.overview }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import { TABLE_TO_QUERY_NAMES, queryNamesForTriggerEvent } from './table-to-query-names';

const NAME = 'integrations.tickets';

describe('integrations.tickets named query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.overview.mockResolvedValue({ providers: [{ id: 'linear' }], sources: [] });
  });

  it('returns the whole page as one row, for the named owner in the server-derived workspace', async () => {
    expect(knownQueryNamesV2()).toContain(NAME);
    await expect(resolveNamedQueryV2(NAME, { userId: '  owner-1  ' })).resolves.toEqual([
      { providers: [{ id: 'linear' }], sources: [] },
    ]);
    expect(mocks.overview).toHaveBeenCalledWith(mocks.sql, { workspaceId: 'ws-test', ownerUserId: 'owner-1' });
  });

  it('rejects a blank owner before reading anything', async () => {
    await expect(resolveNamedQueryV2(NAME, { userId: '   ' })).rejects.toBeTruthy();
    await expect(resolveNamedQueryV2(NAME, {})).rejects.toBeTruthy();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('refetches on writes to a source, a rule or an admission, from any writer', () => {
    for (const table of ['data_sources', 'admission_rules', 'work_admissions']) {
      expect(TABLE_TO_QUERY_NAMES[`harness_shared.${table}`]).toContain(NAME);
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`, { id: 'row-1' })).toContain(NAME);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { snapshotOrgFixture } from '../../test/_org-snapshot';
import { runLegalHoldDrill } from './legal-holds-operational';

let org: OrgTestDb;
beforeAll(async () => { org = await createOrgTestDb(); });
afterAll(async () => { await org?.cleanup(); });
describe('maintained legal-hold operational journey', () => {
  it('preserves chat and documents across physical restore and permits deletion only after release', async () => {
    const result = await runLegalHoldDrill({ sql: org.adminSql, snapshot: () => snapshotOrgFixture(org) });
    expect(result, JSON.stringify(result.assertions)).toMatchObject({ exitCode: 0 });
    expect(result.assertions.filter(a => !a.passed)).toEqual([]);
    expect(result.assertions.map(a => a.id)).toContain('authorized-release-permits-deletion');
  });
  it('records a failed snapshot instead of producing a passing acceptance artifact', async () => {
    const result = await runLegalHoldDrill({ sql: org.adminSql, snapshot: async () => { throw new Error('snapshot unavailable'); } });
    expect(result.exitCode).toBe(1);
    expect(result.assertions).toContainEqual({ id: 'journey-completed', passed: false, evidence: 'snapshot unavailable' });
  });
});

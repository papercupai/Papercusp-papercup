import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { captureInterfaceEligibility } from './interface-eligibility';
import { persistInterfaceEligibility, type EditEligibilityIdentity } from './edit-eligibility-journal';

describe('edit-time interface eligibility journal, real PG', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    const migration = new URL('../../../../libs/papercusp/libs/db/sql/1587-edit-attribution-signal-eligibility.sql', import.meta.url);
    const source = existsSync(migration) ? migration : new URL(migration.href + '.DRAFT');
    await db.adminSql.unsafe(readFileSync(source, 'utf8'));
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  async function row(via: string | null): Promise<EditEligibilityIdentity> {
    const [saved] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.edit_attribution_ledger
        (workspace_id, harness_slug, repo_root, file, agent_id, acquired_via)
      VALUES ('eligibility-ws', 'papercusp', '/fixture', 'target.ts', 'author', ${via})
      RETURNING id::text`;
    return { id: saved.id, workspace: 'eligibility-ws', harness: 'papercusp',
      repoRoot: '/fixture', file: 'target.ts', owner: 'author' };
  }
  const observation = () => captureInterfaceEligibility({
    file: 'target.ts', beforeText: 'export type Result = string;', afterText: 'export type Result = number;',
    capturedAt: new Date().toISOString(),
    peerEvidence: { status: 'measured', peers: [{ owner: 'peer', path: 'consumer.ts', via: 'lock' }] },
  });

  it.each(['codex:apply_patch', 'claude:Edit', 'claude:Write', 'capability:edit', null])(
    'journals acquisition path %s without relying on push output', async via => {
      const identity = await row(via), captured = observation();
      expect(await persistInterfaceEligibility(identity, captured, db.adminSql)).toBe(true);
      const [stored] = await db.adminSql<{ signal_eligibility: unknown }[]>`
        SELECT signal_eligibility FROM harness_shared.edit_attribution_ledger WHERE id = ${identity.id}::bigint`;
      expect(stored.signal_eligibility).toEqual({ interface: captured });
    });

  it('keeps the edit-time observation after peer release and preserves other signals', async () => {
    const identity = await row('codex:apply_patch'), captured = observation();
    await db.adminSql`UPDATE harness_shared.edit_attribution_ledger SET signal_eligibility = '{"clone":{"verdict":"unknown"}}'::jsonb
      WHERE id = ${identity.id}::bigint`;
    expect(await persistInterfaceEligibility(identity, captured, db.adminSql)).toBe(true);
    const later = { ...captured, verdict: 'ineligible' as const, peerEvidence: { status: 'measured' as const, peers: [] } };
    expect(await persistInterfaceEligibility(identity, later, db.adminSql)).toBe(false);
    const [stored] = await db.adminSql<{ signal_eligibility: unknown }[]>`
      SELECT signal_eligibility FROM harness_shared.edit_attribution_ledger WHERE id = ${identity.id}::bigint`;
    expect(stored.signal_eligibility).toEqual({ clone: { verdict: 'unknown' }, interface: captured });
  });

  it('refuses foreign scope, a different edit and retrospective reconstruction', async () => {
    const identity = await row('capability:edit'), captured = observation();
    for (const patch of [{ workspace: 'foreign' }, { harness: 'foreign' }, { owner: 'peer' },
      { repoRoot: '/other' }, { file: 'other.ts' }, { id: '0' }])
      expect(await persistInterfaceEligibility({ ...identity, ...patch }, captured, db.adminSql)).toBe(false);
    expect(await persistInterfaceEligibility(identity,
      { ...captured, capturedAt: new Date(Date.now() - 3_600_000).toISOString() }, db.adminSql)).toBe(false);
    const [stored] = await db.adminSql<{ signal_eligibility: unknown }[]>`
      SELECT signal_eligibility FROM harness_shared.edit_attribution_ledger WHERE id = ${identity.id}::bigint`;
    expect(stored.signal_eligibility).toBeNull();
  });
});

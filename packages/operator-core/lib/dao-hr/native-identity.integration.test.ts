/** Native mutation legs must coexist in the same real isolated identity store. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFixtureHive, prepareIdentityFixture } from '../../../../scripts/fixtures/dao-workbench-identity.mjs';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getHiveByPubkey, insertHiveIfAbsent } from '../hive-store';
import { nativeJourneyScope } from './native-bootstrap-runtime';

describe('native calibration hive identities (real PG)', () => {
  let db: OrgTestDb;
  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  it('registers and resolves every native leg independently while still refusing a reused public key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dao-hr-native-identities-'));
    try {
      const fixture = JSON.parse(readFileSync(prepareIdentityFixture(directory), 'utf8'));
      const workspaceId = 'verify-tauri-isolated-123';
      for (const phase of [undefined, 'baseline', 'copy-baseline', 'mutant']) {
        const { daoSlug } = nativeJourneyScope(phase === undefined ? {}
          : { PAPERCUSP_MUTATION_PROBE: '1', PAPERCUSP_MUTATION_PHASE: phase });
        const identity = identityFixtureHive(fixture, daoSlug);
        const input = { workspaceId, homeSlug: daoSlug, pubkeyBase64: identity.publicKey,
          keychainId: 'hive:' + workspaceId + ':' + daoSlug };
        expect((await insertHiveIfAbsent(input, db.adminSql)).created).toBe(true);
        expect((await insertHiveIfAbsent(input, db.adminSql)).created).toBe(false);
        expect((await getHiveByPubkey(workspaceId, identity.publicKey, db.adminSql))?.homeSlug).toBe(daoSlug);
      }
      await expect(insertHiveIfAbsent({ workspaceId, homeSlug: 'foreign-alias',
        pubkeyBase64: fixture.hive.publicKey, keychainId: 'foreign-alias' }, db.adminSql))
        .rejects.toThrow('already identifies another hive');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

/**
 * P-001 current-source observations, using synthetic data in a migrated throwaway
 * database. These cases describe the existing seams, not D-006's proposed seed
 * or the later D-020 contract. They cannot recreate a historical launch baseline.
 * Existing disclosure/transcript suites cover the full handler populations.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { buildPersonalAmbientContextBlock, resolvePersonalAmbientToolContext } from './ambient';
import { authorizePersonalAccess } from './authorization';
import { assertDisclosurePermits, discloseDocuments } from './disclosure-ledger';
import { createPersonalGrant, revokePersonalGrant, setPersonalVaultEnabled } from './store';
import { loadTranscriptExclusion } from './transcript-exclusion';

const WS = 'idop-vault-observation-test';
const SU = 'su-idop-vault-observation';
const PEER = 'su-idop-vault-observation-peer';
const SENDER = 'sender@private.example';
const OUTSIDER = 'outsider@else.example';
let org: OrgTestDb;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'idop-vault-' + randomUUID()}, 'Synthetic IDOP vault owner') RETURNING id`;
  userId = user.id;
  await org.adminSql`
    INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, pot_slug, agent_role)
    VALUES (${SU}, ${WS}, 'papercusp', 'su')`;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'synthetic-fixture');
});

function inWorkspace<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return org.appSql.begin(async tx => {
    await tx.unsafe("SELECT set_config('app.workspace_id', $1, true)", [WS]);
    return fn(tx);
  }) as Promise<T>;
}

async function grant(role: string, expiresAt: string | null = null) {
  return createPersonalGrant(org.adminSql, {
    workspaceId: WS, userId, principalType: 'agent-role', principalId: role,
    scopes: ['mail'], grantedBy: 'synthetic-fixture', expiresAt,
  });
}

async function discloseSynthetic(restricted: boolean) {
  if (restricted) {
    await org.adminSql`
      INSERT INTO harness_shared.personal_privacy_rules
        (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by)
      VALUES (${WS}, ${userId}, 'sender-domain', 'private.example', 'sender-only', 'fixture', 'fixture')`;
  }
  return inWorkspace(tx => discloseDocuments(tx, {
    workspaceId: WS, userId, agentOwnerId: SU, via: 'personal:search',
    documents: [{ id: randomUUID(), source: 'gmail', participants: [SENDER], metadata: { from: SENDER } }],
  }));
}

function permits(recipients: string[]) {
  return inWorkspace(tx => assertDisclosurePermits(tx, {
    workspaceId: WS, userId, agentOwnerId: SU, recipients, sink: 'mail:send',
  }));
}

describe('P-001 current-source grant terms', () => {
  it.each([
    { name: 'no expiry', expiresAt: null, allowed: true },
    { name: 'future expiry', expiresAt: '2099-01-01T00:00:00Z', allowed: true },
    { name: 'past expiry', expiresAt: '2000-01-01T00:00:00Z', allowed: false },
  ])('$name is enforced for a non-coding control', async ({ expiresAt, allowed }) => {
    // The migrated schema requires expiry > grant time. Model a previously
    // valid grant that has since expired, rather than inserting an invalid one.
    const created = await grant('meeting-prep', allowed ? expiresAt : null);
    if (!allowed) {
      await org.adminSql`
        UPDATE harness_shared.personal_grants
           SET granted_at = '1999-01-01T00:00:00Z'::timestamptz,
               expires_at = ${expiresAt}::timestamptz
         WHERE id = ${created.id}`;
    }
    const result = await authorizePersonalAccess(org.adminSql, { role: 'meeting-prep' }, WS, userId, ['mail']);
    expect(result).toMatchObject(allowed
      ? { allowed: true, scopes: ['personal:mail'] }
      : { allowed: false, reason: 'no_live_grant' });
  });

  it('revocation removes a previously live control grant', async () => {
    const created = await grant('meeting-prep');
    const context = { role: 'meeting-prep' };
    expect((await authorizePersonalAccess(org.adminSql, context, WS, userId, ['mail'])).allowed).toBe(true);
    expect(await revokePersonalGrant(org.adminSql, WS, userId, created.id)).toBe(true);
    expect(await authorizePersonalAccess(org.adminSql, context, WS, userId, ['mail'])).toMatchObject({
      allowed: false, reason: 'no_live_grant',
    });
  });

  it('repeated control checks use the standing grant and still refuse an ungranted scope', async () => {
    await grant('meeting-prep');
    for (let use = 0; use < 2; use++) {
      expect(await authorizePersonalAccess(org.adminSql, { role: 'meeting-prep' }, WS, userId, ['mail']))
        .toMatchObject({ allowed: true, scopes: ['personal:mail'] });
    }
    expect(await authorizePersonalAccess(org.adminSql, { role: 'meeting-prep' }, WS, userId, ['calendar']))
      .toMatchObject({ allowed: false, reason: 'scope_not_granted' });
  });

  it('a non-expiring su grant does not bypass the current coding-role refusal', async () => {
    await grant('su');
    const context = await resolvePersonalAmbientToolContext(org.adminSql, SU, WS);
    expect(context.role).toBe('su');
    expect(await authorizePersonalAccess(org.adminSql, context, WS, userId, ['mail']))
      .toEqual({ allowed: false, reason: 'coding_agent_denied', scopes: [], principal: null });
  });
});

describe('P-001 current-source automatic recall', () => {
  it('resolves su from fixture presence and emits no block or search despite its grant', async () => {
    await grant('su');
    const embedQuery = vi.fn(async () => null);
    const search = vi.fn(async () => []);
    const disclose = vi.fn(async () => ({ documents: [], disclosed: 0, withheld: 0 }));
    const block = await buildPersonalAmbientContextBlock(
      { ownerId: SU, userId, workspaceId: WS, query: 'synthetic marker' },
      { sql: org.adminSql, resolveContext: resolvePersonalAmbientToolContext,
        authorize: authorizePersonalAccess, embedQuery, search, disclose },
    );
    expect(block).toBeNull();
    expect(embedQuery).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(disclose).not.toHaveBeenCalled();
  });
});

describe('P-001 current-source after-read and transcript seams', () => {
  // Delivery is exercised independently of the refused su read path. These
  // cases do not assert that su can obtain a restricted document by that path.
  it('unlabelled synthetic delivery creates no hold', async () => {
    expect(await discloseSynthetic(false)).toMatchObject({ disclosed: 0, withheld: 0 });
    const rows = await org.adminSql`SELECT id FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
    expect(rows).toHaveLength(0);
    await expect(permits([OUTSIDER])).resolves.toBeUndefined();
  });

  it('restricted synthetic delivery registers a su hold before a recipient check', async () => {
    const delivery = await discloseSynthetic(true);
    expect(delivery).toMatchObject({ disclosed: 1, withheld: 0 });
    expect(delivery.documents[0].privacy).toEqual({ level: 'sender-only', readerSet: [SENDER] });
    const rows = await org.adminSql`
      SELECT agent_owner_id, released_at FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
    expect(rows).toEqual([{ agent_owner_id: SU, released_at: null }]);
    await expect(permits([SENDER])).resolves.toBeUndefined();
    await expect(permits([OUTSIDER])).rejects.toMatchObject({ code: 'disclosure_reader_set_violation' });
  });

  it('the current transcript seam exempts the recorder while withholding from a peer', async () => {
    await discloseSynthetic(true);
    const [row] = await org.adminSql<{ delivered_at: Date }[]>`
      SELECT delivered_at FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
    const stamp = { owner: SU, at: row.delivered_at };
    const own = await loadTranscriptExclusion(org.adminSql, { selfOwnerIds: [SU], stamps: [stamp] });
    const peer = await loadTranscriptExclusion(org.adminSql, { selfOwnerIds: [PEER], stamps: [stamp] });
    expect(own.withholds(stamp)).toBeNull();
    expect(peer.withholds(stamp)).toBe('disclosure-window');
  });
});

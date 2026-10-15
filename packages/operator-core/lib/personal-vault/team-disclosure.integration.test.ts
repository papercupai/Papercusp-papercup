/**
 * Team vs personal disclosure (plan crm-agent-sales-onboarding-apps-2026-10-06 P-004).
 *
 * Measured on a migrated throwaway database through the production seams: the Vault document
 * store, `personal_grants`, the owner's privacy rules, and the disclosure ledger. The default is
 * metadata only; content needs a live grant covering the source; revoking the grant removes it.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPersonalGrant, revokePersonalGrant, setPersonalVaultEnabled, upsertPersonalDocuments } from './store';
import {
  readTeamInteractions,
  TEAM_DISCLOSURE_VIA,
  TEAM_METADATA_FIELDS,
  type TeamInteractionRead,
} from './team-disclosure';
import type { PersonalToolContext } from './types';

const WS = 'team-disclosure-test';
const AGENT = 'su-team-disclosure-crm-agent';
const CRM_ROLE = 'crm-sales-agent';
const CRM_CTX: PersonalToolContext = { workspaceId: WS, role: CRM_ROLE };
const OWNER = 'owner@me.example';
const LEAD = 'lead@prospect.example';
const PRIVATE_SENDER = 'alice@private.example';
const BODY = 'Happy to start a trial next week; our security team needs the SOC 2 report first.';
const SUBJECT = 'Trial and security review';
const SECRET_SUBJECT = 'Board offsite venue';

let org: OrgTestDb;
let userId: string;
let mailId: string;
let eventId: string;
let privateMailId: string;

function inWorkspaceTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return org.appSql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
    return fn(tx);
  }) as Promise<T>;
}

function read(
  documentIds: string[],
  opts: { ctx?: PersonalToolContext; agentOwnerId?: string | null; wantContent?: boolean } = {},
): Promise<TeamInteractionRead> {
  return inWorkspaceTx((tx) =>
    readTeamInteractions(tx, {
      ctx: opts.ctx ?? CRM_CTX,
      workspaceId: WS,
      userId,
      documentIds,
      agentOwnerId: opts.agentOwnerId === undefined ? AGENT : opts.agentOwnerId,
      wantContent: opts.wantContent ?? true,
    }),
  );
}

function only(result: TeamInteractionRead) {
  expect(result.allowed).toBe(true);
  expect(result.interactions).toHaveLength(1);
  return result.interactions[0];
}

async function ledger(): Promise<Array<{ documentId: string; agentOwnerId: string; deliveredVia: string }>> {
  return org.adminSql`
    SELECT document_id::text AS "documentId", agent_owner_id AS "agentOwnerId", delivered_via AS "deliveredVia"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${WS} AND released_at IS NULL
     ORDER BY delivered_at, id`;
}

function grant(scopes: string[]): Promise<{ id: string }> {
  return createPersonalGrant(org.adminSql, {
    workspaceId: WS,
    userId,
    principalType: 'agent-role',
    principalId: CRM_ROLE,
    scopes,
    grantedBy: 'test-owner',
  });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'team-disclosure-' + Date.now()}, 'Team disclosure')
    RETURNING id`;
  userId = user.id;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'test');
  const { ids } = await upsertPersonalDocuments(org.adminSql, WS, userId, [
    {
      source: 'gmail',
      kind: 'email',
      externalId: `msg-${randomUUID()}`,
      occurredAt: '2026-10-05T15:00:00Z',
      participants: [LEAD, OWNER],
      title: SUBJECT,
      text: BODY,
      metadata: { from: LEAD, to: [OWNER], snippet: 'Happy to start a trial', html: `<p>${BODY}</p>` },
    },
    {
      source: 'gcal',
      kind: 'calendar-event',
      externalId: `evt-${randomUUID()}`,
      occurredAt: '2026-10-07T17:00:00Z',
      participants: [LEAD, OWNER],
      title: 'Onboarding call',
      text: 'Agenda: install, first plan, questions about pricing.',
      metadata: { organizer: OWNER, attendees: [LEAD], location: 'https://meet.example/abc' },
    },
    {
      source: 'gmail',
      kind: 'email',
      externalId: `msg-${randomUUID()}`,
      occurredAt: '2026-10-04T09:00:00Z',
      participants: [PRIVATE_SENDER, OWNER],
      title: SECRET_SUBJECT,
      text: 'Keep the venue quiet until we sign.',
      metadata: { from: PRIVATE_SENDER, to: [OWNER] },
    },
  ]);
  [mailId, eventId, privateMailId] = ids;
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    for (const table of ['personal_disclosures', 'personal_privacy_rules', 'personal_grants', 'personal_documents']) {
      await org.adminSql.unsafe(`DELETE FROM harness_shared.${table} WHERE workspace_id = $1`, [WS]).catch(() => {});
    }
    await org.adminSql`DELETE FROM harness_shared.personal_vault_settings WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await setPersonalVaultEnabled(org.adminSql, WS, userId, true, 'test');
});

describe('P-004: the shared CRM gets metadata by default', () => {
  it('returns participants, time, channel and subject, and no content, when no grant exists', async () => {
    const view = only(await read([mailId]));
    expect(Object.keys(view.metadata).sort()).toEqual([...TEAM_METADATA_FIELDS].sort());
    expect(view.metadata).toMatchObject({
      documentId: mailId,
      source: 'gmail',
      channel: 'email',
      occurredAt: '2026-10-05T15:00:00.000Z',
      subject: SUBJECT,
    });
    expect([...view.metadata.participants].sort()).toEqual([LEAD, OWNER].sort());
    expect(view.content).toBeNull();
    expect(view.contentWithheld).toBe('no_live_grant');
    expect(JSON.stringify(view)).not.toContain('SOC 2');
    expect(await ledger()).toEqual([]);
  });

  it('does not consult grants when content is not asked for', async () => {
    await grant(['gmail']);
    const view = only(await read([mailId], { wantContent: false }));
    expect(view.content).toBeNull();
    expect(view.contentWithheld).toBe('not_requested');
    expect(view.metadata.subject).toBe(SUBJECT);
  });

  it('keeps the caller order and omits ids that are not this owner’s documents', async () => {
    const result = await read([eventId, randomUUID(), mailId], { wantContent: false });
    expect(result.allowed).toBe(true);
    expect(result.interactions.map((v) => v.metadata.documentId)).toEqual([eventId, mailId]);
  });
});

describe('P-004: content needs an explicit grant, and revoking it removes access', () => {
  it('delivers the body and stored fields while a grant covers the source', async () => {
    await grant(['gmail']);
    const view = only(await read([mailId]));
    expect(view.contentWithheld).toBeNull();
    expect(view.content?.text).toBe(BODY);
    expect(view.content?.metadata).toMatchObject({ snippet: 'Happy to start a trial' });
    // An unrestricted document leaves no ledger row: nothing about it binds the agent's sinks.
    expect(await ledger()).toEqual([]);
  });

  it('grants per source: a gmail grant does not open calendar descriptions', async () => {
    await grant(['gmail']);
    const result = await read([mailId, eventId]);
    expect(result.allowed).toBe(true);
    const [mail, event] = result.interactions;
    expect(mail.content?.text).toBe(BODY);
    expect(event.content).toBeNull();
    expect(event.contentWithheld).toBe('scope_not_granted');
    expect(event.metadata.subject).toBe('Onboarding call');
    expect(JSON.stringify(event)).not.toContain('meet.example');
  });

  it('withholds content again on the next read after the grant is revoked', async () => {
    const { id } = await grant(['gmail']);
    expect(only(await read([mailId])).content?.text).toBe(BODY);
    expect(await revokePersonalGrant(org.adminSql, WS, userId, id)).toBe(true);
    const after = only(await read([mailId]));
    expect(after.content).toBeNull();
    expect(after.contentWithheld).toBe('no_live_grant');
    expect(after.metadata.subject).toBe(SUBJECT);
  });

  it('ignores a grant held by a different principal', async () => {
    await grant(['gmail']);
    const view = only(await read([mailId], { ctx: { workspaceId: WS, role: 'some-other-agent' } }));
    expect(view.content).toBeNull();
    expect(view.contentWithheld).toBe('no_live_grant');
  });
});

describe('P-004: restricted documents and the disclosure ledger', () => {
  beforeEach(async () => {
    await org.adminSql`
      INSERT INTO harness_shared.personal_privacy_rules
        (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by)
      VALUES (${WS}, ${userId}::uuid, 'sender', ${PRIVATE_SENDER}, 'participants', 'test', 'test')`;
  });

  it('drops the subject of a restricted document when no content grant exists', async () => {
    const view = only(await read([privateMailId]));
    expect(view.subjectWithheld).toBe(true);
    expect(view.metadata.subject).toBeNull();
    expect(view.metadata.channel).toBe('email');
    expect([...view.metadata.participants].sort()).toEqual([OWNER, PRIVATE_SENDER].sort());
    expect(JSON.stringify(view)).not.toContain(SECRET_SUBJECT);
    expect(await ledger()).toEqual([]);
  });

  it('records the delivery in the ledger when granted content goes to an agent identity', async () => {
    await grant(['gmail']);
    const view = only(await read([privateMailId]));
    expect(view.content?.text).toBe('Keep the venue quiet until we sign.');
    expect(view.subjectWithheld).toBe(false);
    expect(view.metadata.subject).toBe(SECRET_SUBJECT);
    expect(await ledger()).toEqual([{ documentId: privateMailId, agentOwnerId: AGENT, deliveredVia: TEAM_DISCLOSURE_VIA }]);
  });

  it('withholds restricted content from a caller with no agent identity, even with a grant', async () => {
    await grant(['gmail']);
    const view = only(await read([privateMailId], { agentOwnerId: null }));
    expect(view.content).toBeNull();
    expect(view.contentWithheld).toBe('restricted_unattributed');
    expect(view.metadata.subject).toBeNull();
    expect(await ledger()).toEqual([]);
  });
});

describe('P-004: who may read at all', () => {
  it('refuses coding and review roles outright, metadata included', async () => {
    await grant(['gmail']);
    const result = await read([mailId], { ctx: { workspaceId: WS, role: 'engineer' } });
    expect(result).toEqual({ allowed: false, reason: 'coding_agent_denied', interactions: [] });
  });

  it('refuses when the owner has switched the Vault off', async () => {
    await setPersonalVaultEnabled(org.adminSql, WS, userId, false, 'test');
    const result = await read([mailId], { wantContent: false });
    expect(result).toEqual({ allowed: false, reason: 'vault_disabled', interactions: [] });
  });
});

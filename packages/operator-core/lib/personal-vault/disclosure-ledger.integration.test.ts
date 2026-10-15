/**
 * Reader-set labels against real Postgres (WI-10004864, plan
 * personal-data-reader-set-labels-2026-10-01 P-001/P-003/P-004; owner controls
 * P-005, WI-10004902).
 *
 * The pure label maths is pinned by disclosure-labels.test.ts. What only a real
 * database can show is the ledger itself: that a delivery leaves exactly one
 * active row per (agent, document), that the conflict rule tightens and never
 * widens, that a sink reads the rows back across users, that a release touches
 * only the caller's rows delivered before the authorizing turn, and that
 * migration 1303's workspace RLS holds. Every ledger call runs as harness_app
 * inside a transaction carrying app.workspace_id — the shape ctx.tx has in
 * production.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { LabelableDocument, PrivacyLevel, PrivacyRuleMatch } from './disclosure-labels';
import {
  assertDisclosurePermits,
  deletePrivacyRule,
  discloseDocuments,
  DisclosureRefused,
  listPrivacyRuleRows,
  loadActiveDisclosures,
  loadReleasableDisclosures,
  releaseDisclosures,
  upsertPrivacyRule,
} from './disclosure-ledger';

const WS = 'disclosure-ledger-test';
const AGENT = 'su-disclosure-agent-a';
const OTHER_AGENT = 'su-disclosure-agent-b';
const OWNER_ADDRESS = 'owner@me.example';

let org: OrgTestDb;
let userId: string;
let secondUserId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  const users = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'disclosure-a-' + Date.now()}, 'Disclosure A'), (${'disclosure-b-' + Date.now()}, 'Disclosure B')
    RETURNING id`;
  [userId, secondUserId] = users.map((row) => row.id);
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id IN (${userId}, ${secondUserId})`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
});

function inWorkspace<T>(fn: (tx: postgres.TransactionSql) => Promise<T>, workspaceId = WS): Promise<T> {
  return org.appSql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return fn(tx);
  }) as Promise<T>;
}

async function setRule(matchKind: PrivacyRuleMatch, matchValue: string, level: PrivacyLevel) {
  await org.adminSql`
    INSERT INTO harness_shared.personal_privacy_rules
      (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by)
    VALUES (${WS}, ${userId}::uuid, ${matchKind}, ${matchValue}, ${level}, 'test', 'test')
    ON CONFLICT (workspace_id, user_id, match_kind, match_value)
    DO UPDATE SET level = EXCLUDED.level, updated_at = now()`;
}

function mail(from: string, participants: string[]): LabelableDocument {
  return { id: randomUUID(), source: 'gmail', participants, metadata: { from, to: participants } };
}

const privateMail = () => mail('alice@private.example', [OWNER_ADDRESS, 'bob@private.example', 'carol@else.example']);
const publicMail = () => mail('news@public.example', [OWNER_ADDRESS]);

function disclose(documents: LabelableDocument[], agentOwnerId: string | null = AGENT) {
  return inWorkspace((tx) => discloseDocuments(tx, {
    workspaceId: WS,
    userId,
    agentOwnerId,
    documents,
    via: 'personal:search',
  }));
}

function permits(recipients: string[] | null, overrides: { agentOwnerId?: string | null; userId?: string } = {}) {
  return inWorkspace((tx) => assertDisclosurePermits(tx, {
    workspaceId: WS,
    userId: overrides.userId ?? userId,
    agentOwnerId: overrides.agentOwnerId === undefined ? AGENT : overrides.agentOwnerId,
    recipients,
    sink: 'mail:send',
  }));
}

async function ledger() {
  return org.adminSql<Array<{ documentId: string; agentOwnerId: string; level: string; readerSet: string[]; deliveredVia: string }>>`
    SELECT document_id::text AS "documentId", agent_owner_id AS "agentOwnerId", level,
           reader_set AS "readerSet", delivered_via AS "deliveredVia"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${WS} AND released_at IS NULL
     ORDER BY delivered_at, id`;
}

describe('discloseDocuments', () => {
  it('returns documents unlabelled and records nothing when the owner has no rules', async () => {
    const result = await disclose([privateMail(), publicMail()]);
    expect(result.disclosed).toBe(0);
    expect(result.documents.every((doc) => doc.privacy === null)).toBe(true);
    expect(await ledger()).toEqual([]);
  });

  it('records one row per restricted document with a header-derived reader set and leaves unrestricted ones alone', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const restricted = privateMail();
    const result = await disclose([restricted, publicMail()]);

    expect(result).toMatchObject({ disclosed: 1, withheld: 0 });
    const readerSet = ['alice@private.example', 'bob@private.example', 'carol@else.example', OWNER_ADDRESS].sort();
    expect(result.documents.find((doc) => doc.id === restricted.id)?.privacy).toEqual({ level: 'participants', readerSet });
    expect(result.documents.filter((doc) => doc.privacy === null)).toHaveLength(1);
    expect(await ledger()).toEqual([
      { documentId: restricted.id, agentOwnerId: AGENT, level: 'participants', readerSet, deliveredVia: 'personal:search' },
    ]);
  });

  it('treats a re-read as the same disclosure; a tightened rule narrows the row and a loosened one never widens it', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const doc = privateMail();
    await disclose([doc]);
    await disclose([doc]);
    expect(await ledger()).toHaveLength(1);

    await setRule('sender-domain', 'private.example', 'sender-only');
    await disclose([doc]);
    expect(await ledger()).toMatchObject([{ level: 'sender-only', readerSet: ['alice@private.example'] }]);

    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([doc]);
    expect(await ledger()).toMatchObject([{ level: 'sender-only', readerSet: ['alice@private.example'] }]);
  });

  it('withholds restricted documents from a caller with no attributable identity', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const unrestricted = publicMail();
    const result = await disclose([privateMail(), unrestricted], null);

    expect(result).toMatchObject({ withheld: 1, disclosed: 0 });
    expect(result.documents.map((doc) => doc.id)).toEqual([unrestricted.id]);
    expect(await ledger()).toEqual([]);
  });
});

describe('assertDisclosurePermits', () => {
  it('permits any recipient, and an unenumerable audience, for an agent that holds no disclosure', async () => {
    await expect(permits(['anyone@anywhere.example'])).resolves.toBeUndefined();
    await expect(permits(null)).resolves.toBeUndefined();
  });

  it('permits a reader of the disclosed document and refuses an outsider', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(['Bob@Private.example'])).resolves.toBeUndefined();
    const refusal = await permits(['bob@private.example', 'mallory@evil.example']).catch((error) => error);
    expect(refusal).toBeInstanceOf(DisclosureRefused);
    expect(refusal).toMatchObject({ code: 'disclosure_reader_set_violation', violating: ['mallory@evil.example'] });
  });

  it("always permits the owner's own connected accounts, even under sender-only", async () => {
    await org.adminSql`
      INSERT INTO harness_shared.data_sources (workspace_id, kind, status, owner_user_id, provider_account_id)
      VALUES (${WS}, 'gmail', 'connected', ${userId}::uuid, ${OWNER_ADDRESS})`;
    await setRule('sender-domain', 'private.example', 'sender-only');
    await disclose([privateMail()]);

    await expect(permits([OWNER_ADDRESS, 'alice@private.example'])).resolves.toBeUndefined();
    await expect(permits(['bob@private.example'])).rejects.toBeInstanceOf(DisclosureRefused);
  });

  it('refuses an audience that cannot be enumerated while any disclosure is active', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(null)).rejects.toMatchObject({
      code: 'disclosure_reader_set_violation',
      violating: ['mail:send'],
    });
  });

  it('binds the agent across users: content read for one user cannot leave through another user’s account', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(['mallory@evil.example'], { userId: secondUserId })).rejects.toBeInstanceOf(DisclosureRefused);
  });

  it('constrains only the agent identity that received the content, and nothing for an unattributable caller', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(['mallory@evil.example'], { agentOwnerId: OTHER_AGENT })).resolves.toBeUndefined();
    await expect(permits(['mallory@evil.example'], { agentOwnerId: null })).resolves.toBeUndefined();
  });

  it('stops constraining once the disclosure is released', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);
    await org.adminSql`
      UPDATE harness_shared.personal_disclosures
         SET released_at = now(), released_by = 'owner', release_ref = 'test-release'
       WHERE workspace_id = ${WS}`;

    await expect(permits(['mallory@evil.example'])).resolves.toBeUndefined();
  });

  it('refuses rather than sending unchecked when the ledger cannot be read', async () => {
    const broken = (() => { throw new Error('ledger offline'); }) as unknown as postgres.Sql;
    await expect(assertDisclosurePermits(broken, {
      workspaceId: WS,
      userId,
      agentOwnerId: AGENT,
      recipients: ['bob@private.example'],
      sink: 'mail:send',
    })).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
  });
});

describe('owner controls (P-005)', () => {
  function upsert(level: PrivacyLevel, authorityRef: string | null) {
    return inWorkspace((tx) => upsertPrivacyRule(tx, {
      workspaceId: WS,
      userId,
      matchKind: 'sender-domain',
      matchValue: 'private.example',
      level,
      actor: AGENT,
      authorityRef,
    }));
  }

  function releasable(documentIds: string[] | null, agentOwnerId = AGENT) {
    return inWorkspace((tx) => loadReleasableDisclosures(tx, { workspaceId: WS, agentOwnerId, documentIds }));
  }

  function release(ids: string[], deliveredBefore: Date) {
    return inWorkspace((tx) => releaseDisclosures(tx, {
      workspaceId: WS,
      agentOwnerId: AGENT,
      ids,
      deliveredBefore,
      releasedBy: AGENT,
      releaseRef: 'owner_directive:9',
    }));
  }

  it('records the authority of a loosening edit and keeps it through a later tightening', async () => {
    expect(await upsert('sender-only', null)).toMatchObject({ level: 'sender-only', authorityRef: null, createdBy: AGENT });
    expect(await upsert('unrestricted', 'owner_directive:7')).toMatchObject({ level: 'unrestricted', authorityRef: 'owner_directive:7' });
    expect(await upsert('participants', null)).toMatchObject({ level: 'participants', authorityRef: 'owner_directive:7' });

    const rows = await inWorkspace((tx) => listPrivacyRuleRows(tx, WS, userId));
    expect(rows).toEqual([expect.objectContaining({
      matchKind: 'sender-domain',
      matchValue: 'private.example',
      level: 'participants',
      updatedBy: AGENT,
      authorityRef: 'owner_directive:7',
    })]);
    expect(rows[0].updatedAt).toBeInstanceOf(Date);
  });

  it('deletes a rule once and reports a second delete as absent', async () => {
    await upsert('participants', null);
    const remove = () => inWorkspace((tx) => deletePrivacyRule(tx, {
      workspaceId: WS,
      userId,
      matchKind: 'sender-domain',
      matchValue: 'private.example',
    }));

    expect(await remove()).toMatchObject({ level: 'participants' });
    expect(await remove()).toBeNull();
    expect(await inWorkspace((tx) => listPrivacyRuleRows(tx, WS, userId))).toEqual([]);
  });

  it("lists only this agent's active disclosures, all of them or narrowed to the named documents", async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const [first, second, foreign] = [privateMail(), privateMail(), privateMail()];
    await disclose([first, second]);
    await disclose([foreign], OTHER_AGENT);

    const all = await releasable(null);
    expect(all.map((row) => row.documentId).sort()).toEqual([first.id, second.id].sort());
    expect(all.every((row) => row.deliveredAt instanceof Date)).toBe(true);
    expect((await releasable([second.id])).map((row) => row.documentId)).toEqual([second.id]);
    expect(await releasable([foreign.id])).toEqual([]);
  });

  it("releases only this agent's rows delivered before the authorizing turn, after which the sink stops counting them", async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const [early, late, foreign] = [privateMail(), privateMail(), privateMail()];
    await disclose([early, late]);
    await disclose([foreign], OTHER_AGENT);
    const authorizedAt = new Date(Date.now() - 30 * 60_000);
    await org.adminSql`
      UPDATE harness_shared.personal_disclosures
         SET delivered_at = ${new Date(authorizedAt.getTime() - 60_000)}
       WHERE workspace_id = ${WS} AND document_id IN (${early.id}::uuid, ${foreign.id}::uuid)`;
    const ids = (await org.adminSql<{ id: string }[]>`
      SELECT id::text FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`).map((row) => row.id);

    expect(await release([], authorizedAt)).toEqual([]);
    // Every row id is offered, the other agent's included: the WHERE clause, not
    // the caller's list, decides what a release may touch.
    expect(await release(ids, authorizedAt)).toEqual([early.id]);
    const after = await org.adminSql<Array<{ documentId: string; releasedBy: string | null; releaseRef: string | null }>>`
      SELECT document_id::text AS "documentId", released_by AS "releasedBy", release_ref AS "releaseRef"
        FROM harness_shared.personal_disclosures
       WHERE workspace_id = ${WS} AND released_at IS NOT NULL`;
    expect(after).toEqual([{ documentId: early.id, releasedBy: AGENT, releaseRef: 'owner_directive:9' }]);
    await expect(permits(['mallory@evil.example'])).rejects.toBeInstanceOf(DisclosureRefused);

    expect(await release(ids, new Date(Date.now() + 60_000))).toEqual([late.id]);
    await expect(permits(['mallory@evil.example'])).resolves.toBeUndefined();
    await expect(permits(['mallory@evil.example'], { agentOwnerId: OTHER_AGENT })).rejects.toBeInstanceOf(DisclosureRefused);
  });

  it('labels the agent again when it re-reads a document it was released from', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const doc = privateMail();
    await disclose([doc]);
    const [row] = await releasable(null);
    expect(await release([row.id], new Date(Date.now() + 60_000))).toEqual([doc.id]);

    await disclose([doc]);
    expect((await releasable(null)).map((active) => active.documentId)).toEqual([doc.id]);
    await expect(permits(['mallory@evil.example'])).rejects.toBeInstanceOf(DisclosureRefused);
  });
});

describe('workspace isolation (migration 1303)', () => {
  it('hides one workspace’s disclosures from a transaction bound to another', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    expect(await inWorkspace((tx) => loadActiveDisclosures(tx, { workspaceId: WS, agentOwnerId: AGENT }))).toHaveLength(1);
    expect(await inWorkspace(
      (tx) => loadActiveDisclosures(tx, { workspaceId: WS, agentOwnerId: AGENT }),
      'some-other-workspace',
    )).toEqual([]);
  });
});

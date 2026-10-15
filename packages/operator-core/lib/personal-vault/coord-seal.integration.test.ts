/**
 * Sealed coord messages against real Postgres (WI-10004933, plan
 * personal-data-reader-set-labels-2026-10-01 P-006, D-006).
 *
 * coord-seal.test.ts pins the envelope split. What only a real database can show
 * is the store around it: that a sender holding a disclosure has its message
 * sealed with a snapshot of its labels and an unrestricted sender does not, that
 * opening the seal records those labels on the opener so the outbound check then
 * binds it, that the owner and an unattributable caller are handled per D-004,
 * and that migration 1307's workspace RLS holds. The seal runs on harness_app
 * exactly as the coord seam's handle does; opens run inside a transaction
 * carrying app.workspace_id, the shape withWorkspace gives coord:read.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { COORD_SEAL_STORE, mergeUnsealed, sealMarkerOf } from './coord-seal';
import type { LabelableDocument } from './disclosure-labels';
import { assertDisclosurePermits, discloseDocuments, DisclosureRefused } from './disclosure-ledger';
import { openSealedContent, openSealedForOwner, sealCoordEnvelope } from './sealed-contents';

const WS = 'coord-seal-test';
const SENDER = 'su-seal-sender';
const READER = 'su-seal-reader';
const OWNER_ADDRESS = 'owner@me.example';

let org: OrgTestDb;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'coord-seal-' + Date.now()}, 'Coord Seal')
    RETURNING id`;
  userId = user.id;
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_sealed_contents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`
    INSERT INTO harness_shared.personal_privacy_rules
      (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by)
    VALUES (${WS}, ${userId}::uuid, 'sender-domain', 'private.example', 'participants', 'test', 'test')`;
});

function inWorkspace<T>(fn: (tx: postgres.TransactionSql) => Promise<T>, workspaceId = WS): Promise<T> {
  return org.appSql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return fn(tx);
  }) as Promise<T>;
}

function privateMail(): LabelableDocument {
  const participants = [OWNER_ADDRESS, 'bob@private.example'];
  return { id: randomUUID(), source: 'gmail', participants, metadata: { from: 'alice@private.example', to: participants } };
}

function disclose(documents: LabelableDocument[], agentOwnerId = SENDER) {
  return inWorkspace((tx) => discloseDocuments(tx, { workspaceId: WS, userId, agentOwnerId, documents, via: 'personal:search' }));
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    ts: new Date().toISOString(),
    msg_id: `m-${randomUUID()}`,
    from: SENDER,
    to: [READER],
    kind: 'message',
    summary: 'Alice says the merger closes Friday',
    body: [{ text: 'Full text of the private email' }],
    ...overrides,
  };
}

function seal(env: ReturnType<typeof envelope>) {
  return sealCoordEnvelope(org.appSql, { workspaceId: WS, env });
}

function open(ref: string, opener: Parameters<typeof openSealedContent>[1]['opener'], workspaceId = WS) {
  return inWorkspace((tx) => openSealedContent(tx, { workspaceId: WS, store: COORD_SEAL_STORE, ref, opener }), workspaceId);
}

function permits(agentOwnerId: string | null, recipients: string[]) {
  return inWorkspace((tx) => assertDisclosurePermits(tx, { workspaceId: WS, userId, agentOwnerId, recipients, sink: 'coord:send' }));
}

async function sealedRows() {
  return org.adminSql<Array<{ ref: string; writerOwnerId: string; content: Record<string, unknown>; labels: Array<Record<string, unknown>> }>>`
    SELECT ref, writer_owner_id AS "writerOwnerId", content, labels
      FROM harness_shared.personal_sealed_contents
     WHERE workspace_id = ${WS}
     ORDER BY created_at, id`;
}

async function activeAgents() {
  const rows = await org.adminSql<{ agentOwnerId: string }[]>`
    SELECT DISTINCT agent_owner_id AS "agentOwnerId"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${WS} AND released_at IS NULL
     ORDER BY 1`;
  return rows.map((row) => row.agentOwnerId);
}

describe('sealCoordEnvelope', () => {
  it('persists an unrestricted sender’s message unchanged and stores nothing', async () => {
    const env = envelope();
    expect(await seal(env)).toEqual(env);
    expect(await sealedRows()).toEqual([]);
  });

  it('seals what a restricted sender authored, keeping a snapshot of its labels', async () => {
    const doc = privateMail();
    await disclose([doc]);
    const env = envelope();
    const stub = await seal(env);

    expect(sealMarkerOf(stub)).toEqual({ labels: 1, open: `coord:read { msg_id: '${env.msg_id}', unseal: true }` });
    expect(JSON.stringify(stub)).not.toContain('merger');
    expect(stub).toMatchObject({ msg_id: env.msg_id, from: SENDER, to: [READER], kind: 'message' });
    expect(await sealedRows()).toEqual([{
      ref: env.msg_id,
      writerOwnerId: SENDER,
      content: { summary: env.summary, body: env.body },
      labels: [{ userId, documentId: doc.id, source: 'gmail', level: 'participants', readerSet: ['alice@private.example', 'bob@private.example', OWNER_ADDRESS].sort() }],
    }]);
  });

  it('persists a bare ack from a restricted sender unchanged', async () => {
    await disclose([privateMail()]);
    const ack = { ts: new Date().toISOString(), msg_id: `m-${randomUUID()}`, from: SENDER, to: [READER], kind: 'ack', related_msg_id: 'm-1' };
    expect(await sealCoordEnvelope(org.appSql, { workspaceId: WS, env: ack })).toEqual(ack);
    expect(await sealedRows()).toEqual([]);
  });

  it('keeps the first seal when a write is replayed', async () => {
    await disclose([privateMail()]);
    const env = envelope();
    await seal(env);
    await seal({ ...env, summary: 'a different text' });
    expect((await sealedRows()).map((row) => row.content.summary)).toEqual([env.summary]);
  });

  it('refuses rather than sending unsealed when the ledger cannot be read', async () => {
    const broken = { begin: () => { throw new Error('ledger offline'); } } as unknown as postgres.Sql;
    const refusal = await sealCoordEnvelope(broken, { workspaceId: WS, env: envelope() }).catch((error) => error);
    expect(refusal).toBeInstanceOf(DisclosureRefused);
    expect(refusal).toMatchObject({ code: 'disclosure_ledger_unavailable' });
  });
});

describe('openSealedContent', () => {
  async function sealedMessage() {
    await disclose([privateMail()]);
    const env = envelope();
    const stub = await seal(env);
    return { env, stub };
  }

  it('returns the content and binds the opener to the sender’s readers from then on', async () => {
    const { env, stub } = await sealedMessage();
    await expect(permits(READER, ['mallory@evil.example'])).resolves.toBeUndefined();

    const opened = await open(env.msg_id, { kind: 'agent', ownerId: READER, via: 'coord:read' });
    expect(opened).toMatchObject({ found: true, withheld: false, writerOwnerId: SENDER, labelled: 1 });
    if (!opened.found || opened.withheld) throw new Error('unreachable');
    expect(mergeUnsealed(stub, opened.content)).toEqual(env);

    await expect(permits(READER, ['bob@private.example'])).resolves.toBeUndefined();
    await expect(permits(READER, ['mallory@evil.example'])).rejects.toMatchObject({
      code: 'disclosure_reader_set_violation',
      violating: ['mallory@evil.example'],
    });
  });

  it('still labels the opener after the sender’s own label is released', async () => {
    const { env } = await sealedMessage();
    await org.adminSql`
      UPDATE harness_shared.personal_disclosures
         SET released_at = now(), released_by = 'owner', release_ref = 'test-release'
       WHERE workspace_id = ${WS} AND agent_owner_id = ${SENDER}`;

    expect(await open(env.msg_id, { kind: 'agent', ownerId: READER, via: 'coord:read' })).toMatchObject({ labelled: 1 });
    expect(await activeAgents()).toEqual([READER]);
  });

  it('never widens a tighter label the opener already holds on the same document', async () => {
    const doc = privateMail();
    await disclose([doc]);
    const env = envelope();
    await seal(env);
    await org.adminSql`
      INSERT INTO harness_shared.personal_disclosures
        (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via)
      VALUES (${WS}, ${userId}::uuid, ${READER}, ${doc.id}::uuid, 'gmail', 'sender-only', ${['alice@private.example']}::text[], 'personal:search')`;

    await open(env.msg_id, { kind: 'agent', ownerId: READER, via: 'coord:read' });
    await expect(permits(READER, ['bob@private.example'])).rejects.toBeInstanceOf(DisclosureRefused);
  });

  it('opens for the owner without labelling anyone', async () => {
    const { env } = await sealedMessage();
    expect(await open(env.msg_id, { kind: 'owner' })).toMatchObject({ found: true, withheld: false, labelled: 0 });

    const byOwner = await inWorkspace((tx) => openSealedForOwner(tx, { workspaceId: WS, store: COORD_SEAL_STORE, refs: [env.msg_id, 'm-absent'] }));
    expect([...byOwner.keys()]).toEqual([env.msg_id]);
    expect(byOwner.get(env.msg_id)).toMatchObject({ summary: env.summary });
    expect(await activeAgents()).toEqual([SENDER]);
  });

  it('withholds the content from a caller with no attributable identity and records nothing', async () => {
    const { env } = await sealedMessage();
    expect(await open(env.msg_id, { kind: 'agent', ownerId: null, via: 'coord:read' })).toEqual({ found: true, withheld: true, labels: 1 });
    expect(await open(env.msg_id, { kind: 'agent', ownerId: '  ', via: 'coord:read' })).toMatchObject({ withheld: true });
    expect(await activeAgents()).toEqual([SENDER]);
  });

  it('reports an unknown ref as not found', async () => {
    expect(await open('m-never-sealed', { kind: 'agent', ownerId: READER, via: 'coord:read' })).toEqual({ found: false });
  });
});

describe('workspace isolation (migration 1307)', () => {
  it('hides one workspace’s sealed content from a transaction bound to another', async () => {
    await disclose([privateMail()]);
    const env = envelope();
    await seal(env);

    expect(await open(env.msg_id, { kind: 'owner' })).toMatchObject({ found: true });
    expect(await open(env.msg_id, { kind: 'owner' }, 'some-other-workspace')).toEqual({ found: false });
  });
});

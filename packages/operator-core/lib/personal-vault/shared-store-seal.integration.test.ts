/**
 * Sealed shared work stores against real Postgres (WI-10005520, plan
 * personal-data-reader-set-labels-2026-10-01 P-012, D-006, BAR R-8).
 *
 * A peer can read a work-item comment, a work-item checkpoint, a fact and a
 * harness/hive memory. This suite drives the REAL writers — commentWorkItem,
 * setWorkItemCheckpointWithPrior, assertFact and the memory:remember handler —
 * and asserts the falsifier of R-8 directly: no shared row written while the
 * writer holds an active disclosure contains its text, and opening the stub with
 * personal:open-sealed labels the opener. An unrestricted writer's rows are
 * unchanged, owner-scoped (user) memory is never sealed, an unattributable
 * opener is withheld the text, and a ledger that cannot be read refuses the
 * write rather than storing it in the clear.
 *
 * Only the memory BACKEND is faked (mem0/pgvector is outside this database);
 * what it receives is the shared row. Everything else runs on the migrated
 * throwaway database.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const WS = 'shared-seal-test';
const HARNESS = 'seal-h';
const SENDER = 'su-shared-seal-sender';
const READER = 'su-shared-seal-reader';
const OWNER_ADDRESS = 'owner@me.example';
const SECRET = 'Alice says the merger closes Friday';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  backendRemember: undefined as unknown as Mock<(...args: unknown[]) => Promise<{ ids: string[] }>>,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      h.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
// The agent identity is the coordination ownerId; tests name it on ctx.agent.
vi.mock('../agent-tools/_disclosure-subject', () => ({
  disclosureSubject: (ctx: { agent?: string | null }) => ctx?.agent ?? null,
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
// memory:remember collaborators that are not the shared row under test.
vi.mock('../memory/backend', () => ({
  getMemoryBackend: () => ({
    name: 'fake',
    available: async () => ({ ok: true }),
    get: async () => null,
    search: async () => [],
    remember: (...args: unknown[]) => h.backendRemember(...args),
    invalidateEntry: async () => true,
  }),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {},
}));
vi.mock('../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => null),
  markJournalCommitted: vi.fn(async () => {}),
}));
vi.mock('../auth', () => ({
  getSessionUserOrDefault: async () => ({ id: 'user-seal', display_name: 'Seal User' }),
}));
vi.mock('../memory/memory-pause', () => ({
  isMemoryPaused: async () => false,
  MEMORY_PAUSED_REFUSAL: { ok: false, reason: 'memory_paused' },
}));
vi.mock('../memory/ref-expand', () => ({ expandRefsForEmbed: async () => undefined }));
vi.mock('../knowledge-packs/identity-learning', () => ({ wornMemoryIdentityIds: async () => [] }));
vi.mock('../memory/invalidate-user-memory-views', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/invalidate-user-memory-views')>()),
  invalidateUserMemoryViews: async () => {},
}));
vi.mock('../memory/conflict-judge', () => ({
  resolveConflictJudge: async () => ({ available: false, reason: 'test: no judge' }),
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { discloseDocuments, assertDisclosurePermits, DisclosureRefused } = await import('./disclosure-ledger');
const { sealSharedText, sharedSealRefOf, sharedSealStub, SEALED_FIELD_STUB, openSharedSealsForOwner, unsealRowsForOwner } =
  await import('./shared-store-seal');
const { setWorkItemCheckpointWithPrior } = await import('../work-item-checkpoint');
const { workItemScope } = await import('../carry-note');
const { assertFact } = await import('../agent-facts/store');
const { commentWorkItem } = await import('../work-items');
const { default: remember } = await import('../agent-tools/memory/remember');
const { default: openSealed } = await import('../agent-tools/personal/open-sealed');
type LabelableDocument = import('./disclosure-labels').LabelableDocument;
type OrgTestDb = import('../../test/_org-test-db').OrgTestDb;

let org: OrgTestDb;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  h.sql = org.adminSql;
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'shared-seal-' + Date.now()}, 'Shared Seal')
    RETURNING id`;
  userId = user.id;
}, 120_000);

afterAll(async () => {
  if (org && userId) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  h.backendRemember = vi.fn(async (..._args: unknown[]) => ({ ids: [randomUUID()] }));
  await org.adminSql`DELETE FROM harness_shared.personal_sealed_contents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`
    INSERT INTO harness_shared.personal_privacy_rules
      (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by)
    VALUES (${WS}, ${userId}::uuid, 'sender-domain', 'private.example', 'participants', 'test', 'test')`;
});

function inWorkspace<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return org.appSql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
    return fn(tx);
  }) as Promise<T>;
}

function privateMail(): LabelableDocument {
  const participants = [OWNER_ADDRESS, 'bob@private.example'];
  return { id: randomUUID(), source: 'gmail', participants, metadata: { from: 'alice@private.example', to: participants } };
}

/** Give SENDER an active restricted label, the state of a session that read private mail. */
async function restrictSender(): Promise<void> {
  await inWorkspace((tx) =>
    discloseDocuments(tx, { workspaceId: WS, userId, agentOwnerId: SENDER, documents: [privateMail()], via: 'personal:search' }),
  );
}

function permits(agentOwnerId: string, recipients: string[]) {
  return inWorkspace((tx) => assertDisclosurePermits(tx, { workspaceId: WS, userId, agentOwnerId, recipients, sink: 'coord:send' }));
}

async function sealedRows(store: string) {
  return org.adminSql<Array<{ ref: string; writerOwnerId: string; content: { text?: string; context?: Record<string, unknown> } }>>`
    SELECT ref, writer_owner_id AS "writerOwnerId", content
      FROM harness_shared.personal_sealed_contents
     WHERE workspace_id = ${WS} AND store = ${store}
     ORDER BY created_at, id`;
}

/** Every column of a shared row, as text — the R-8 falsifier reads the whole row. */
async function rowText(query: PromiseLike<readonly unknown[]>): Promise<string> {
  return JSON.stringify(await query);
}

function openAs(agent: string | null, store: string, ref: string) {
  return openSealed.handler({ store, ref } as never, { agent, workspaceId: WS } as never) as Promise<{ data: Record<string, unknown> }>;
}

async function featureItem(): Promise<string> {
  const id = `WI-seal-${randomUUID().slice(0, 8)}`;
  await org.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, admission, title, summary, payload, created_ts)
    VALUES (${WS}, ${HARNESS}, ${id}, 'feature', 'open', 'admitted', 'Seal fixture', '', '{}'::jsonb, ${Date.now()})`;
  return id;
}

describe('work-item checkpoints (setWorkItemCheckpointWithPrior)', () => {
  async function checkpointRow(workItemId: string) {
    return rowText(org.adminSql`
      SELECT note, journal FROM harness_shared.carry_notes
       WHERE workspace_id = ${WS} AND scope = ${workItemScope(HARNESS, workItemId)}`);
  }

  it('stores a restricted writer’s checkpoint as a stub, note and journal alike', async () => {
    await restrictSender();
    const workItemId = `WI-cp-${randomUUID().slice(0, 8)}`;
    const { stored } = await setWorkItemCheckpointWithPrior({ workspaceId: WS, harness: HARNESS, workItemId }, SECRET, {
      writerOwnerId: SENDER,
    });

    expect(sharedSealRefOf(stored)).toMatchObject({ store: 'work-item-checkpoint' });
    const row = await checkpointRow(workItemId);
    expect(row).toContain('🔒 Sealed');
    expect(row).not.toContain('merger');
    expect(await sealedRows('work-item-checkpoint')).toEqual([
      expect.objectContaining({ writerOwnerId: SENDER, content: { text: SECRET, context: { workItemId, harness: HARNESS } } }),
    ]);
  });

  it('stores an unrestricted writer’s checkpoint unchanged', async () => {
    const workItemId = `WI-cp-${randomUUID().slice(0, 8)}`;
    const { stored } = await setWorkItemCheckpointWithPrior({ workspaceId: WS, harness: HARNESS, workItemId }, SECRET, {
      writerOwnerId: READER,
    });
    expect(stored).toBe(SECRET);
    expect(await checkpointRow(workItemId)).toContain('merger');
    expect(await sealedRows('work-item-checkpoint')).toEqual([]);
  });
});

describe('facts (assertFact)', () => {
  async function factRow(key: string) {
    return rowText(org.adminSql`SELECT * FROM harness_shared.agent_facts WHERE workspace_id = ${WS} AND key = ${key}`);
  }

  it('stores a restricted writer’s fact body as a stub', async () => {
    await restrictSender();
    const key = `seal-${randomUUID().slice(0, 8)}`;
    const fact = await assertFact({ workspaceId: WS, scope: 'workspace', key, body: SECRET, ttlSec: 3600, createdBy: SENDER, writerOwnerId: SENDER });

    expect(sharedSealRefOf(fact.body)).toMatchObject({ store: 'fact' });
    const row = await factRow(key);
    expect(row).toContain('🔒 Sealed');
    expect(row).not.toContain('merger');
    expect((await sealedRows('fact'))[0]).toMatchObject({ writerOwnerId: SENDER, content: { text: SECRET, context: { scope: 'workspace', key } } });
  });

  it('stores an unrestricted writer’s fact unchanged', async () => {
    const key = `seal-${randomUUID().slice(0, 8)}`;
    await assertFact({ workspaceId: WS, scope: 'workspace', key, body: SECRET, ttlSec: 3600, createdBy: READER, writerOwnerId: READER });
    expect(await factRow(key)).toContain('merger');
    expect(await sealedRows('fact')).toEqual([]);
  });

  // WI-10005549: the body is not the only authored text on a fact row.
  const authoredFields = {
    settledBy: `${SECRET} — settles when the merger memo lands`,
    recheck: { probe: `ask Alice whether the merger still closes`, falsifier: `the merger slips past Friday` },
    claim: { says: `merger closes Friday` },
    sourceRef: `mail: merger-friday-thread`,
  };

  it('seals every authored field of a restricted writer’s fact, not just the body', async () => {
    await restrictSender();
    const key = `seal-${randomUUID().slice(0, 8)}`;
    const fact = await assertFact({
      workspaceId: WS, scope: 'workspace', key, body: SECRET, ttlSec: 3600, createdBy: SENDER, writerOwnerId: SENDER,
      kind: 'undecidable', ...authoredFields,
    });

    const row = await factRow(key);
    expect(row).toContain('🔒 Sealed');
    expect(row).not.toContain('merger');
    expect(row).toContain(SEALED_FIELD_STUB); // the undecidable still reads as having an exit
    expect((await sealedRows('fact'))[0]).toMatchObject({
      writerOwnerId: SENDER,
      content: { text: SECRET, fields: authoredFields },
    });

    // Opening returns the sealed fields with the body, and labels the opener.
    const { data } = await openAs(READER, 'fact', sharedSealRefOf(fact.body)!.ref);
    expect(data).toMatchObject({ ok: true, text: SECRET, fields: authoredFields, labelled: 1 });
  });

  it('keeps an unrestricted writer’s authored fields on the row', async () => {
    const key = `seal-${randomUUID().slice(0, 8)}`;
    await assertFact({
      workspaceId: WS, scope: 'workspace', key, body: 'plain', ttlSec: 3600, createdBy: READER, writerOwnerId: READER,
      kind: 'undecidable', ...authoredFields,
    });
    const row = await factRow(key);
    for (const text of ['settles when the merger memo lands', 'ask Alice whether', 'merger closes Friday', 'merger-friday-thread']) {
      expect(row).toContain(text);
    }
    expect(await sealedRows('fact')).toEqual([]);
  });
});

describe('work-item comments (commentWorkItem)', () => {
  async function postRows(workItemId: string) {
    return rowText(org.adminSql`
      SELECT p.* FROM harness_shared.coord_thread_posts p
       WHERE p.thread_id = ${`work-item-thread-${workItemId}`}`);
  }

  it('posts a restricted writer’s comment as a stub, in the same transaction as the seal', async () => {
    await restrictSender();
    const id = await featureItem();
    const post = await commentWorkItem(id, SECRET, SENDER, { workspaceId: WS, harness: HARNESS, writerOwnerId: SENDER });

    expect(sharedSealRefOf(post?.body)).toMatchObject({ store: 'work-item-comment' });
    const rows = await postRows(id);
    expect(rows).toContain('🔒 Sealed');
    expect(rows).not.toContain('merger');
    expect((await sealedRows('work-item-comment'))[0]).toMatchObject({ writerOwnerId: SENDER, content: { text: SECRET, context: { workItemId: id } } });
  });

  it('posts an unrestricted writer’s comment unchanged', async () => {
    const id = await featureItem();
    await commentWorkItem(id, SECRET, READER, { workspaceId: WS, harness: HARNESS, writerOwnerId: READER });
    expect(await postRows(id)).toContain('merger');
    expect(await sealedRows('work-item-comment')).toEqual([]);
  });
});

describe('memory (memory:remember)', () => {
  function rememberAs(agent: string, args: Record<string, unknown>) {
    return remember.handler(
      { kind: 'project', ...args } as never,
      { agent, workspaceId: WS, principal: { workspaceId: WS } } as never,
    ) as Promise<{ content: Array<{ text: string }> }>;
  }
  const stored = () => JSON.stringify(h.backendRemember.mock.calls);

  it('hands the shared pool a stub for a restricted writer’s harness memory', async () => {
    await restrictSender();
    await rememberAs(SENDER, { content: SECRET, harness_slug: HARNESS });

    expect(h.backendRemember).toHaveBeenCalled();
    expect(stored()).toContain('🔒 Sealed');
    expect(stored()).not.toContain('merger');
    expect((await sealedRows('memory'))[0]).toMatchObject({ writerOwnerId: SENDER, content: { text: SECRET, context: { scope: `harness:${HARNESS}` } } });
  });

  it('never seals owner-scoped memory, which only the owner reads', async () => {
    await restrictSender();
    await rememberAs(SENDER, { content: SECRET });
    expect(stored()).toContain('merger');
    expect(await sealedRows('memory')).toEqual([]);
  });

  it('stores an unrestricted writer’s harness memory unchanged', async () => {
    await rememberAs(READER, { content: SECRET, harness_slug: HARNESS });
    expect(stored()).toContain('merger');
    expect(await sealedRows('memory')).toEqual([]);
  });
});

describe('personal:open-sealed', () => {
  async function sealedFact() {
    await restrictSender();
    const fact = await assertFact({
      workspaceId: WS, scope: 'workspace', key: `seal-${randomUUID().slice(0, 8)}`, body: SECRET, ttlSec: 3600, createdBy: SENDER, writerOwnerId: SENDER,
    });
    return sharedSealRefOf(fact.body)!;
  }

  it('returns the text and binds the opener to the writer’s readers from then on', async () => {
    const { store, ref } = await sealedFact();
    await expect(permits(READER, ['mallory@evil.example'])).resolves.toBeUndefined();

    const { data } = await openAs(READER, store, ref);
    expect(data).toMatchObject({ ok: true, store: 'fact', ref, writerOwnerId: SENDER, text: SECRET, labelled: 1 });

    await expect(permits(READER, ['bob@private.example'])).resolves.toBeUndefined();
    await expect(permits(READER, ['mallory@evil.example'])).rejects.toMatchObject({ code: 'disclosure_reader_set_violation' });
  });

  it('withholds the text from a caller with no attributable identity', async () => {
    const { store, ref } = await sealedFact();
    const { data } = await openAs(null, store, ref);
    expect(data).toMatchObject({ ok: false, code: 'disclosure_identity_required' });
    expect(JSON.stringify(data)).not.toContain('merger');
  });

  it('reports an unknown ref as not found', async () => {
    const { data } = await openAs(READER, 'fact', 'never-sealed');
    expect(data).toMatchObject({ ok: false, code: 'sealed_content_not_found' });
  });
});

// WI-10005548 / D-006: the owner is always a permitted reader. Every owner read
// surface (thread views, the Orders panel's checkpoints, the Learning memory views)
// shows a sealed row through unsealRowsForOwner; this drives it with the stub each
// REAL writer stores and asserts the text comes back with nobody labelled.
describe('the owner’s view of sealed rows (unsealRowsForOwner)', () => {
  async function disclosureCount(): Promise<number> {
    const [row] = await org.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
    return row!.n;
  }
  async function ownerView(text: string): Promise<string> {
    const before = await disclosureCount();
    const [row] = await unsealRowsForOwner([{ text }], {
      workspaceId: WS,
      textOf: (r) => r.text,
      withText: (r, t) => ({ ...r, text: t }),
    });
    expect(await disclosureCount()).toBe(before);
    return row!.text;
  }

  it('shows the text of a sealed work-item comment', async () => {
    await restrictSender();
    const post = await commentWorkItem(await featureItem(), SECRET, SENDER, { workspaceId: WS, harness: HARNESS, writerOwnerId: SENDER });
    expect(sharedSealRefOf(post?.body)).toMatchObject({ store: 'work-item-comment' });
    expect(await ownerView(post!.body)).toBe(SECRET);
  });

  it('shows the text of a sealed work-item checkpoint', async () => {
    await restrictSender();
    const workItemId = `WI-cp-${randomUUID().slice(0, 8)}`;
    const { stored } = await setWorkItemCheckpointWithPrior({ workspaceId: WS, harness: HARNESS, workItemId }, SECRET, {
      writerOwnerId: SENDER,
    });
    expect(sharedSealRefOf(stored)).toMatchObject({ store: 'work-item-checkpoint' });
    expect(await ownerView(stored!)).toContain(SECRET);
  });

  it('shows the text of a sealed shared memory', async () => {
    await restrictSender();
    await remember.handler(
      { kind: 'project', content: SECRET, harness_slug: HARNESS } as never,
      { agent: SENDER, workspaceId: WS, principal: { workspaceId: WS } } as never,
    );
    const stub = /🔒 Sealed:[^"]*/.exec(JSON.stringify(h.backendRemember.mock.calls))?.[0];
    expect(sharedSealRefOf(stub)).toMatchObject({ store: 'memory' });
    expect(await ownerView(stub!)).toBe(SECRET);
  });

  it('shows the text of a sealed fact', async () => {
    await restrictSender();
    const key = `owner-view-${randomUUID().slice(0, 8)}`;
    const fact = await assertFact({ workspaceId: WS, scope: 'workspace', key, body: SECRET, ttlSec: 3600, createdBy: SENDER, writerOwnerId: SENDER });
    expect(await ownerView(fact.body)).toBe(SECRET);
  });

  it('opens a page of mixed rows in one pass and leaves ordinary rows untouched', async () => {
    await restrictSender();
    const a = await commentWorkItem(await featureItem(), SECRET, SENDER, { workspaceId: WS, harness: HARNESS, writerOwnerId: SENDER });
    const b = await commentWorkItem(await featureItem(), `${SECRET} again`, SENDER, { workspaceId: WS, harness: HARNESS, writerOwnerId: SENDER });
    const rows = [{ id: 1, body: a!.body }, { id: 2, body: 'plain' }, { id: 3, body: b!.body }];
    const out = await unsealRowsForOwner(rows, { workspaceId: WS, textOf: (r) => r.body, withText: (r, body) => ({ ...r, body }) });
    expect(out).toEqual([{ id: 1, body: SECRET }, rows[1], { id: 3, body: `${SECRET} again` }]);
  });

  it('spends no query on a page without a stub', async () => {
    const untouchable = { begin: () => { throw new Error('the sealed store was read'); } } as unknown as postgres.Sql;
    expect((await openSharedSealsForOwner(untouchable, { workspaceId: WS, texts: ['plain', null, 42] })).size).toBe(0);
    const real = h.sql;
    h.sql = untouchable;
    try {
      const rows = [{ text: 'plain' }];
      expect(await unsealRowsForOwner(rows, { workspaceId: WS, textOf: (r) => r.text, withText: (r, text) => ({ ...r, text }) })).toEqual(rows);
    } finally {
      h.sql = real;
    }
  });

  it('keeps the stub when its sealed row is gone or the sealed store cannot be read', async () => {
    const orphan = sharedSealStub({ store: 'fact', ref: randomUUID(), writerOwnerId: SENDER, labels: 1 });
    expect(await ownerView(orphan)).toBe(orphan);

    await restrictSender();
    const post = await commentWorkItem(await featureItem(), SECRET, SENDER, { workspaceId: WS, harness: HARNESS, writerOwnerId: SENDER });
    const real = h.sql;
    h.sql = { begin: () => Promise.reject(new Error('sealed store offline')) } as unknown as postgres.Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const [row] = await unsealRowsForOwner([{ text: post!.body }], { workspaceId: WS, textOf: (r) => r.text, withText: (r, text) => ({ ...r, text }) });
      expect(row!.text).toBe(post!.body);
      expect(warn).toHaveBeenCalled();
    } finally {
      h.sql = real;
      warn.mockRestore();
    }
  });

  it('reads under row security, and only the workspace it names', async () => {
    await restrictSender();
    const post = await commentWorkItem(await featureItem(), SECRET, SENDER, { workspaceId: WS, harness: HARNESS, writerOwnerId: SENDER });
    const own = await inWorkspace((tx) => openSharedSealsForOwner(tx, { workspaceId: WS, texts: [post!.body] }));
    expect(own.get(post!.body)).toBe(SECRET);
    const other = await org.appSql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, ['shared-seal-other']);
      return openSharedSealsForOwner(tx, { workspaceId: 'shared-seal-other', texts: [post!.body] });
    });
    expect(other.size).toBe(0);
  });
});

describe('fail closed', () => {
  it('refuses a restricted writer’s write when the ledger cannot be read', async () => {
    const broken = { begin: () => { throw new Error('ledger offline'); } } as unknown as postgres.Sql;
    const refusal = await sealSharedText(broken, { workspaceId: WS, writerOwnerId: SENDER, store: 'memory', text: SECRET }).catch((e) => e);
    expect(refusal).toBeInstanceOf(DisclosureRefused);
    expect(refusal).toMatchObject({ code: 'disclosure_ledger_unavailable' });
  });
});

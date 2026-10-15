/** WI-6554700010008773 / D033: typed issue receiver, real current migrations.
 * Forward candidates are applied only to this disposable database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { applyOpVia, runInProjectionBatch, type TableProjection } from '../projection';
import { buildEngineerIssuesProjection, type EngineerIssueRow } from '../projections/engineer-issues';
import { composeEngineerIssueKey } from '../feature-issue-op-keys';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const FEATURE_DRAFT = resolve(ROOT, 'libs/papercusp/libs/db/sql/1466-feature-receiver-equal-key-apply-clock.sql.DRAFT');
const ISSUE_DRAFT = resolve(ROOT, 'libs/papercusp/libs/db/sql/1467-issue-receiver-equal-key-apply-clock.sql.DRAFT');
const WS = 'ws-remote-issue-clock';
const HARNESS = 'remote-issue-clock';
const AUTHOR = 'f'.repeat(64);
const OWN = 'e'.repeat(64);
let db: OrgTestDb;
let sql: postgres.Sql;
let sequence = 0;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  await sql.unsafe(readFileSync(FEATURE_DRAFT, 'utf8'));
  await sql.unsafe(readFileSync(ISSUE_DRAFT, 'utf8'));
}, 240_000);
afterAll(async () => { await db?.cleanup(); }, 30_000);

function issue(id: string, title: string, over: Partial<EngineerIssueRow> = {}): EngineerIssueRow {
  return {
    harness_slug: HARNESS, storage_harness_slug: HARNESS, issue_id: id,
    scope: `harness:${HARNESS}`, kind: 'bug', title, body: 'details',
    severity: 'minor', source: 'engineer', state: 'open', assignee: null,
    assigned_by: null, assigned_at: null, payload: { scenario: 'issue-clock' },
    found_during: null, linked_feature_id: null, created_by: null,
    created_at: new Date(1000).toISOString(), created_ts: 1000, ...over,
  };
}
function projection() {
  return buildEngineerIssuesProjection({ workspaceId: WS, harnessSlug: HARNESS, sql });
}
function apply(row: EngineerIssueRow, ts = 1500, hlc?: string) {
  const p = projection();
  return applyOpVia(tag => tag === 'engineer-issues' ? p as TableProjection<unknown> : null,
    { type: 'put', table: 'engineer-issues', hbKey: composeEngineerIssueKey(HARNESS, row.issue_id),
      value: row, ts, hlc, schema_version: 1, writerPubkey: 'forged-writer', sourceLogKeyHex: AUTHOR },
    { ownLogKeyHex: OWN });
}
async function state(id: string) {
  const [r] = await sql`SELECT title,status,origin,author_pubkey,fed_ts::text,fed_hlc,payload,
    admission,admitted_by,terminal_owner,terminal_completion_ref,authority
    FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${id}`;
  return r;
}
async function outbox(id: string) {
  const [r] = await sql`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
    WHERE workspace_id=${WS} AND key=ANY(${[id, composeEngineerIssueKey(HARNESS, id)]}::text[])`;
  return r.n;
}
async function choices(kind = 'bug') {
  const id = `WI-ISSUE-CLOCK-${++sequence}`;
  await apply(issue(id, 'first', { kind }));
  const payload = (await state(id)).payload;
  const rows = await sql`SELECT title,md5(concat_ws('|',${kind}::text,title,'details','open',NULL::text,
    ${sql.json(payload)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text)) AS digest
    FROM (VALUES ('first'),('second')) AS titles(title) ORDER BY digest`;
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${id}`;
  return { loser: rows[0].title as string, winner: rows[1].title as string, payload };
}
const key = (ms: number, withHlc: boolean) => withHlc ? `${String(ms).padStart(15, '0')}:00000:publisher` : undefined;

describe('typed issue equal-key receiver (real migrated PG, draft 1467)', () => {
  for (const withHlc of [false, true]) {
    it(`causally distinguishes missing typed admission from ordinary clock stamping (hlc=${withHlc})`, async () => {
      const { loser, winner } = await choices();
      await sql.unsafe(readFileSync(FEATURE_DRAFT, 'utf8'));
      try {
        const id = `WI-ISSUE-CLOCK-${++sequence}`;
        await apply(issue(id, loser), 1500, key(1500, withHlc));
        await apply(issue(id, winner), 1500, key(1500, withHlc));
        const restamped = await state(id);
        expect(restamped).toMatchObject({ title: winner, origin: 'local' });
        expect(Number(restamped.fed_ts)).toBeGreaterThan(1600);
        await apply(issue(id, 'intermediate'), 1600, key(1600, withHlc));
        expect(await state(id)).toEqual(restamped);
        // A moved key already works without the new seam; the generic stamp is
        // intentionally correct for genuinely local writes, not globally broken.
        const moved = `WI-ISSUE-CLOCK-${++sequence}`;
        await apply(issue(moved, loser), 1500, key(1500, withHlc));
        await apply(issue(moved, 'moved key'), 1600, key(1600, withHlc));
        expect(await state(moved)).toMatchObject({ title: 'moved key', fed_ts: '1600' });
        await sql`UPDATE harness_shared.work_items SET title='local control'
          WHERE workspace_id=${WS} AND feature_id=${moved}`;
        expect(await state(moved)).toMatchObject({ title: 'local control', origin: 'local' });
        expect(Number((await state(moved)).fed_ts)).toBeGreaterThan(1600);
      } finally {
        await sql.unsafe(readFileSync(ISSUE_DRAFT, 'utf8'));
      }
    });

    for (const kind of ['bug', 'change', 'task']) {
    it(`preserves both-order winners and accepts the intermediate key (kind=${kind}, hlc=${withHlc})`, async () => {
      const { loser, winner, payload } = await choices(kind);
      for (const order of [[loser, winner], [winner, loser]]) {
        const id = `WI-ISSUE-CLOCK-${++sequence}`;
        for (const title of order) await apply(issue(id, title, { kind }), 1500, key(1500, withHlc));
        expect(await state(id)).toMatchObject({ title: winner, origin: 'remote', author_pubkey: AUTHOR,
          fed_ts: '1500', fed_hlc: key(1500, withHlc) ?? null });
        expect((await state(id)).payload).toEqual(payload);
        expect(await outbox(id)).toBe(0);
        await apply(issue(id, 'intermediate', { kind }), 1600, key(1600, withHlc));
        expect(await state(id)).toMatchObject({ title: 'intermediate', origin: 'remote', author_pubkey: AUTHOR,
          fed_ts: '1600', fed_hlc: key(1600, withHlc) ?? null });
        const resident = await state(id);
        await apply(issue(id, 'lower key', { kind }), 1400, key(1400, withHlc));
        expect(await state(id)).toEqual(resident);
        expect(await outbox(id)).toBe(0);
      }
    });
    }

    it(`preserves exact publisher payload for an equal-key terminal update (hlc=${withHlc})`, async () => {
      const { payload } = await choices();
      const [candidate] = await sql`SELECT 'terminal-' || n AS title FROM generate_series(0,100) AS n
        WHERE md5(concat_ws('|','bug','terminal-' || n,'details','done',NULL::text,
          ${sql.json(payload)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text))
          > md5(concat_ws('|','bug','open','details','open',NULL::text,
          ${sql.json(payload)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text)) LIMIT 1`;
      expect(candidate).toBeDefined();
      for (const terminalFirst of [false, true]) {
        const id = `WI-ISSUE-CLOCK-${++sequence}`;
        const open = issue(id, 'open');
        const terminal = issue(id, candidate.title, { state: 'done' });
        for (const row of terminalFirst ? [terminal, open] : [open, terminal])
          await apply(row, 1500, key(1500, withHlc));
        expect(await state(id)).toMatchObject({ status: 'done', title: candidate.title,
          origin: 'remote', author_pubkey: AUTHOR, fed_ts: '1500', fed_hlc: key(1500, withHlc) ?? null });
        expect((await state(id)).payload).toEqual(payload);
        expect(await outbox(id)).toBe(0);
        await apply(issue(id, 'intermediate terminal', { state: 'done' }), 1600, key(1600, withHlc));
        expect(await state(id)).toMatchObject({ title: 'intermediate terminal', origin: 'remote', fed_ts: '1600' });
        expect((await state(id)).payload).toEqual(payload);
      }
    });
  }

  it('retains genuine local lifecycle writes and completion intent normalization', async () => {
    const { loser, winner } = await choices();
    const id = `WI-ISSUE-CLOCK-${++sequence}`;
    await apply(issue(id, loser));
    await apply(issue(id, winner));
    await sql`UPDATE harness_shared.work_items SET status='done',title='local close'
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    const closed = await state(id);
    expect(closed).toMatchObject({ status: 'done', origin: 'local' });
    expect(Number(closed.fed_ts)).toBeGreaterThan(1500);
    expect(closed.fed_hlc).not.toBeNull();
    expect(closed.payload._completionEventIntentId).toEqual(expect.any(String));
    await sql`UPDATE harness_shared.work_items SET status='open'
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect(await state(id)).toMatchObject({ status: 'open', origin: 'local' });
    expect((await state(id)).payload).not.toHaveProperty('_completionEventIntentId');
    expect(await outbox(id)).toBe(2);
  });

  it('keeps the remote reopen proof atomic before stamping a receiver token', async () => {
    const id = `WI-ISSUE-CLOCK-${++sequence}`;
    const closed = issue(id, 'remote close', { state: 'done', terminal_owner: 'closer',
      terminal_completion_ref: 'proof', authority: 'proposed' });
    await apply(closed);
    const resident = await state(id);
    await apply(issue(id, 'unproven reopen'), 1600);
    expect(await state(id)).toEqual(resident);
    const history = { at: '2026-10-12T00:00:00Z', by: 'reopener', force: false,
      prevState: 'done', terminalOwner: 'closer', terminalCompletionRef: 'proof',
      completionAuthority: 'proposed', terminalCompletionEvidence: null, assumptions: null };
    await apply(issue(id, 'proven reopen', { payload: { scenario: 'issue-clock', reopenHistory: [history] } }), 1600);
    expect(await state(id)).toMatchObject({ status: 'open', title: 'proven reopen', origin: 'remote', fed_ts: '1600' });
    expect((await state(id)).payload).not.toHaveProperty('_completionEventIntentId');
    expect(await outbox(id)).toBe(0);
  });

  it('derives provenance from the source log and preserves admission and identity floors', async () => {
    const id = `WI-ISSUE-CLOCK-${++sequence}`;
    await apply({ ...issue(id, 'original', { admission: 'pending' }),
      origin: 'local', author_pubkey: OWN } as EngineerIssueRow);
    expect(await state(id)).toMatchObject({ origin: 'remote', author_pubkey: AUTHOR, admission: 'pending' });
    await sql`UPDATE harness_shared.work_items SET admission='admitted',admitted_by='reviewer'
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    const ts = Number((await state(id)).fed_ts) + 10_000;
    await apply(issue(id, 'new remote', { admission: 'pending' }), ts);
    expect(await state(id)).toMatchObject({ title: 'new remote', origin: 'remote',
      admission: 'admitted', admitted_by: 'reviewer' });
    const resident = await state(id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await apply(issue(id, 'distinct entity', { created_ts: 20_000, created_at: new Date(20_000).toISOString() }), ts + 1000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('id collision'));
    } finally { warn.mockRestore(); }
    expect(await state(id)).toEqual(resident);
    const foreign = issue(`WI-ISSUE-CLOCK-${++sequence}`, 'foreign', { harness_slug: 'foreign-harness' });
    await apply(foreign);
    expect(await state(foreign.issue_id)).toBeUndefined();
  });

  it('does not grant the typed seam to unmatched source attribution', async () => {
    const { loser, winner } = await choices();
    const id = `WI-ISSUE-CLOCK-${++sequence}`;
    const provenance = { origin: 'remote' as const, authorPubkey: AUTHOR,
      sourceLogKeyHex: OWN, ts: 1500 };
    await projection().writeToPg(issue(id, loser), provenance);
    await projection().writeToPg(issue(id, winner), provenance);
    expect(await state(id)).toMatchObject({ title: winner, origin: 'local' });
    expect(Number((await state(id)).fed_ts)).toBeGreaterThan(1500);
  });

  it('bounds the token by operation, row family, publisher and signed-write protection', async () => {
    const id = `WI-ISSUE-CLOCK-${++sequence}`;
    await apply(issue(id, 'original'));
    await expect(sql`UPDATE harness_shared.work_items SET origin='remote:engineer-issues',author_pubkey=NULL
      WHERE workspace_id=${WS} AND feature_id=${id}`).rejects.toThrow('issue-family publisher provenance');
    await expect(sql`UPDATE harness_shared.work_items SET origin='remote:engineer-issues',item_kind='feature'
      WHERE workspace_id=${WS} AND feature_id=${id}`).rejects.toThrow('issue-family publisher provenance');
    await expect(sql`UPDATE harness_shared.work_items SET origin='remote:features-by-id'
      WHERE workspace_id=${WS} AND feature_id=${id}`).rejects.toThrow('feature-family publisher provenance');
    await expect(sql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,title,item_kind,origin,author_pubkey)
      VALUES (${WS},${HARNESS},'WI-ISSUE-TOKEN-INSERT','invalid','bug','remote:engineer-issues',${AUTHOR})`)
      .rejects.toThrow('work_items UPDATE');
    await sql.unsafe(`CREATE TABLE harness_shared.issue_signed_probe (
      id text PRIMARY KEY,title text,origin text,author_pubkey text,signer_device_pubkey text,
      fed_ts bigint,fed_hlc text,updated_at bigint);
      CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON harness_shared.issue_signed_probe
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write()`);
    await sql`INSERT INTO harness_shared.issue_signed_probe VALUES ('signed','original','remote',${AUTHOR},'signed-device',1500,NULL,NULL)`;
    await expect(sql`UPDATE harness_shared.issue_signed_probe SET title='local mutation' WHERE id='signed'`)
      .rejects.toThrow('publisher-signed remote row');
    await expect(sql`UPDATE harness_shared.issue_signed_probe SET origin='remote:engineer-issues',title='mutation' WHERE id='signed'`)
      .rejects.toThrow('work_items UPDATE');
  });

  it('does not leak receiver authority to a later local write or rollback in a batch', async () => {
    const { loser, winner } = await choices();
    const id = `WI-ISSUE-CLOCK-${++sequence}`;
    await sql.begin(async tx => {
      await runInProjectionBatch({ sqlFor: async () => tx as unknown as postgres.Sql,
        flush: async () => {}, recover: async () => {} }, async () => {
        await apply(issue(id, loser));
        await expect(tx.savepoint(async sp => {
          await sp`UPDATE harness_shared.work_items SET origin='remote:engineer-issues',author_pubkey=NULL
            WHERE workspace_id=${WS} AND feature_id=${id}`;
        })).rejects.toThrow('issue-family publisher provenance');
        await apply(issue(id, winner));
        await tx`UPDATE harness_shared.work_items SET title='local after remote'
          WHERE workspace_id=${WS} AND feature_id=${id}`;
      });
    });
    expect(await state(id)).toMatchObject({ title: 'local after remote', origin: 'local' });
    expect(await outbox(id)).toBe(1);
  });
});

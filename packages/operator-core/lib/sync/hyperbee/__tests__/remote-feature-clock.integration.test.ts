/** WI-6554700010008759 / D-028: receiver equal-key updates keep publisher clocks.
 * The forward migration stays DRAFT; it is applied only to this disposable DB.
 * These exercise the receiver-stamped apply seam and the real migrated triggers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { applyOpVia, runInProjectionBatch, type TableProjection } from '../projection';
import { buildHarnessFeaturesProjection, type HarnessFeatureRow } from '../projections/harness-features';
import { buildEngineerIssuesProjection, type EngineerIssueRow } from '../projections/engineer-issues';
import type { OpEnvelope } from '../op-envelope-types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const DRAFT = resolve(ROOT, 'libs/papercusp/libs/db/sql/1466-feature-receiver-equal-key-apply-clock.sql.DRAFT');
const WS = 'ws-remote-feature-clock';
const HARNESS = 'remote-feature-clock';
const AUTHOR = 'f'.repeat(64);
const OWN = 'e'.repeat(64);
let db: OrgTestDb;
let sql: postgres.Sql;
let baselineStamp: string;
let baselineCompletion: string;
let sequence = 0;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  const [r] = await sql`SELECT pg_get_functiondef('harness_shared.stamp_local_federated_write()'::regprocedure) AS body`;
  baselineStamp = r.body;
  const [completion] = await sql`SELECT pg_get_functiondef('harness_shared.stamp_work_item_completion_event_intent()'::regprocedure) AS body`;
  baselineCompletion = completion.body;
  await sql.unsafe(readFileSync(DRAFT, 'utf8'));
}, 240_000);
afterAll(async () => { await db?.cleanup(); }, 30_000);

function feature(id: string, title: string, payload?: unknown): HarnessFeatureRow {
  return {
    harness_slug: HARNESS, feature_id: id, title, summary: 'body', status: 'open',
    attempts: 0, claims: null, notes: null, metadata: {}, kind: 'feature',
    project_id: null, expected_cost_cents: null, tags: [], needs_human_review: false,
    ts: 1500, created_ts: 1000, updated_ts: 1500, parent_id: null, goal_id: null,
    taken_by: null, taken_at: null, expires_at: null, item_kind: 'feature',
    ...(payload === undefined ? {} : { payload }),
  };
}
function op(row: HarnessFeatureRow, ts = 1500, hlc?: string): OpEnvelope {
  return { type: 'put', table: 'features-by-id', hbKey: row.feature_id, value: row,
    ts, hlc, schema_version: 1, writerPubkey: 'forged-writer', sourceLogKeyHex: AUTHOR };
}
function apply(envelope: OpEnvelope) {
  const projection = buildHarnessFeaturesProjection({ workspaceId: WS, harnessSlug: HARNESS, sql });
  return applyOpVia(tag => tag === 'features-by-id' ? projection as TableProjection<unknown> : null,
    envelope, { ownLogKeyHex: OWN });
}
async function state(id: string) {
  const [r] = await sql`SELECT title, status, origin, author_pubkey, fed_ts::text, fed_hlc, payload,
    admission, admitted_by FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${id}`;
  return r;
}
async function outbox(id: string) {
  const [r] = await sql`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
    WHERE workspace_id=${WS} AND table_name='harness_features_consolidated' AND key=${id}`;
  return r.n;
}
async function titles(payload: postgres.JSONValue): Promise<[string, string]> {
  // Match the projection's PG tie-break, including PostgreSQL's jsonb text format.
  const rows = await sql`SELECT title, md5(concat_ws('|', 'feature', title, 'body', 'open',
    NULL::text, ${sql.json(payload)}::jsonb::text, NULL::text, NULL::text, NULL::text, NULL::text)) AS digest
    FROM (VALUES ('first'), ('second')) AS choices(title) ORDER BY digest`;
  return [rows[0].title, rows[1].title];
}
async function terminalWinner(payload: postgres.JSONValue): Promise<string> {
  const [candidate] = await sql`SELECT 'terminal-' || n AS title FROM generate_series(0,100) AS n
    WHERE md5(concat_ws('|','feature','terminal-' || n,'body','done',NULL::text,
      ${sql.json(payload)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text))
      > md5(concat_ws('|','feature','open','body','open',NULL::text,
      ${sql.json(payload)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text)) LIMIT 1`;
  expect(candidate).toBeDefined();
  return candidate.title;
}

describe('remote feature equal-key apply clock (real PG, draft 1466)', () => {
  for (const withHlc of [false, true]) for (const explicitPayload of [false, true]) {
    it(`converges in both orders and accepts an intermediate key (hlc=${withHlc}, payload=${explicitPayload})`, async () => {
      const payload = explicitPayload ? { scenario: 'same-writer' } : undefined;
      const [loser, winner] = await titles(payload ?? {});
      const hlc = withHlc ? '000000000001500:00000:publisher' : undefined;
      for (const order of [[loser, winner], [winner, loser]]) {
        const id = `F-REMOTE-CLOCK-${++sequence}`;
        for (const title of order) await apply(op(feature(id, title, payload), 1500, hlc));
        expect(await state(id)).toMatchObject({ title: winner, origin: 'remote', author_pubkey: AUTHOR,
          fed_ts: '1500', fed_hlc: hlc ?? null });
        expect((await state(id)).payload).toEqual(payload ?? {});
        expect(await outbox(id)).toBe(0);
        const nextHlc = withHlc ? '000000000001600:00000:publisher' : undefined;
        await apply(op(feature(id, 'intermediate', payload), 1600, nextHlc));
        expect(await state(id)).toMatchObject({ title: 'intermediate', origin: 'remote', fed_ts: '1600', fed_hlc: nextHlc ?? null });
        expect((await state(id)).payload).toEqual(payload ?? {});
        await apply(op(feature(id, 'stale', payload), 1400, withHlc ? '000000000001400:00000:publisher' : undefined));
        expect((await state(id)).title).toBe('intermediate');
        expect(await outbox(id)).toBe(0);
      }
    });
  }

  it('retains the existing local-write stamp after a remote equal-key winner', async () => {
    const id = `F-REMOTE-CLOCK-${++sequence}`;
    const [loser, winner] = await titles({});
    await apply(op(feature(id, loser)));
    await apply(op(feature(id, winner)));
    await sql`UPDATE harness_shared.work_items SET title='local mutation'
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect(await state(id)).toMatchObject({ title: 'local mutation', origin: 'local' });
    expect(Number((await state(id)).fed_ts)).toBeGreaterThan(1500);
    expect((await state(id)).fed_hlc).not.toBeNull();
    expect(await outbox(id)).toBe(1);
  });

  it('ignores forged wire provenance and keeps the admission promotion floor', async () => {
    const id = `F-REMOTE-CLOCK-${++sequence}`;
    const row = { ...feature(id, 'original'), origin: 'local', author_pubkey: OWN,
      admission: 'pending', admitted_by: null };
    await apply(op(row));
    expect(await state(id)).toMatchObject({ origin: 'remote', author_pubkey: AUTHOR, fed_ts: '1500' });
    await sql`UPDATE harness_shared.work_items SET admission='admitted', admitted_by='local-review'
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    const localStamp = await state(id);
    // Local promotion changes wire content and therefore advances the clock.
    // A newer remote operation must clear that clock as well as its admission floor.
    await apply(op({ ...row, title: 'new remote' }, Number(localStamp.fed_ts) + 10_000));
    expect(await state(id)).toMatchObject({ origin: 'remote', author_pubkey: AUTHOR,
      admission: 'admitted', admitted_by: 'local-review' });
    const refused = { ...feature(`F-REMOTE-CLOCK-${++sequence}`, 'unadmitted'), harness_slug: 'foreign-harness' };
    await apply(op(refused));
    expect(await state(refused.feature_id)).toBeUndefined();
  });

  it('cannot use the feature receiver token for issue-family rows or signed-table writes', async () => {
    const id = `WI-REMOTE-CLOCK-${++sequence}`;
    await sql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,title,status,item_kind,origin)
      VALUES (${WS},${HARNESS},${id},'issue','open','bug','local')`;
    await expect(sql`UPDATE harness_shared.work_items SET origin='remote:features-by-id',author_pubkey=${AUTHOR}
      WHERE workspace_id=${WS} AND feature_id=${id}`).rejects.toThrow('feature-family publisher provenance');
    await sql.unsafe(`CREATE TABLE harness_shared.remote_clock_signed_probe (
      id text PRIMARY KEY, title text, origin text, author_pubkey text, signer_device_pubkey text,
      fed_ts bigint, fed_hlc text, updated_at bigint);
      CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON harness_shared.remote_clock_signed_probe
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write()`);
    await sql`INSERT INTO harness_shared.remote_clock_signed_probe VALUES ('signed','original','remote',${AUTHOR},'signed-device',1500,NULL,NULL)`;
    await expect(sql`UPDATE harness_shared.remote_clock_signed_probe SET title='mutation' WHERE id='signed'`)
      .rejects.toThrow('publisher-signed remote row');
    await expect(sql`UPDATE harness_shared.remote_clock_signed_probe SET origin='remote:features-by-id',title='mutation' WHERE id='signed'`)
      .rejects.toThrow('work_items UPDATE');
  });

  it('isolates the receiver token from a later local write and a rolled-back savepoint in one batch', async () => {
    const id = `F-REMOTE-CLOCK-${++sequence}`;
    const [loser, winner] = await titles({});
    await sql.begin(async tx => {
      await runInProjectionBatch({ sqlFor: async () => tx as unknown as postgres.Sql,
        flush: async () => {}, recover: async () => {} }, async () => {
        await apply(op(feature(id, loser)));
        await expect(tx.savepoint(async sp => {
          await sp`UPDATE harness_shared.work_items SET origin='remote:features-by-id',author_pubkey=NULL
            WHERE workspace_id=${WS} AND feature_id=${id}`;
        })).rejects.toThrow('publisher provenance');
        await apply(op(feature(id, winner)));
        await tx`UPDATE harness_shared.work_items SET title='local after remote'
          WHERE workspace_id=${WS} AND feature_id=${id}`;
      });
    });
    expect(await state(id)).toMatchObject({ title: 'local after remote', origin: 'local' });
    expect(await outbox(id)).toBe(1);
  });

  it('preserves publisher content with the completion normalizer disabled', async () => {
    const payload = { scenario: 'without-normalization' };
    const [loser, winner] = await titles(payload);
    await sql.unsafe('ALTER TABLE harness_shared.work_items DISABLE TRIGGER stamp_before_fed_work_item_completion_event_intent_trg');
    try {
      for (const order of [[loser, winner], [winner, loser]]) {
        const id = `F-REMOTE-CLOCK-${++sequence}`;
        for (const title of order) await apply(op(feature(id, title, payload)));
        expect(await state(id)).toMatchObject({ title: winner, origin: 'remote', fed_ts: '1500', fed_hlc: null });
        expect((await state(id)).payload).toEqual(payload);
      }
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.work_items ENABLE TRIGGER stamp_before_fed_work_item_completion_event_intent_trg');
    }
  });

  for (const withHlc of [false, true]) for (const explicitPayload of [false, true]) {
    it(`keeps exact publisher payload for a remote terminal winner in both orders (hlc=${withHlc}, payload=${explicitPayload})`, async () => {
      const payload = explicitPayload ? { scenario: 'remote-close' } : undefined;
      const title = await terminalWinner(payload ?? {});
      const hlc = withHlc ? '000000000001500:00000:publisher' : undefined;
      for (const terminalFirst of [false, true]) {
        const id = `F-REMOTE-CLOCK-${++sequence}`;
        const open = feature(id, 'open', payload);
        const terminal = { ...feature(id, title, payload), status: 'done' };
        for (const row of terminalFirst ? [terminal, open] : [open, terminal]) await apply(op(row, 1500, hlc));
        expect(await state(id)).toMatchObject({ title, status: 'done', origin: 'remote', author_pubkey: AUTHOR,
          fed_ts: '1500', fed_hlc: hlc ?? null });
        expect((await state(id)).payload).toEqual(payload ?? {});
        expect(await outbox(id)).toBe(0);
      }
    });
  }

  for (const withHlc of [false, true]) {
    it(`accepts remote acknowledgement removal and reopen over a resident intent (hlc=${withHlc})`, async () => {
      const hlc = withHlc ? '000000000001600:00000:publisher' : undefined;
      for (const status of ['done', 'open']) {
        const id = `F-REMOTE-CLOCK-${++sequence}`;
        const payload = { scenario: 'remote-ack-cycle' };
        const intent = '12345678-1234-4234-8234-123456789abc';
        const pending = { ...payload, _completionEventIntentId: intent };
        await apply(op({ ...feature(id, 'resident', payload), status: 'done' }));
        // Seed publisher state through the existing moved-clock path. The next
        // real receiver apply stays at this same key and has no local fire receipt.
        await sql`UPDATE harness_shared.work_items SET payload=${sql.json(pending)},fed_ts=1600,
          fed_hlc=${hlc ?? null} WHERE workspace_id=${WS} AND feature_id=${id}`;
        expect(await state(id)).toMatchObject({ status: 'done', origin: 'remote', fed_ts: '1600' });
        expect((await state(id)).payload).toEqual(pending);
        const [fire] = await sql`SELECT count(*)::int AS n FROM harness_shared.event_key_fires
          WHERE event_key=${`work-item:done:${id}`}`;
        expect(fire.n).toBe(0);
        const [winner] = await sql`SELECT 'remote-cycle-' || n AS title FROM generate_series(0,100) AS n
          WHERE md5(concat_ws('|','feature','remote-cycle-' || n,'body',${status}::text,NULL::text,
            ${sql.json(payload)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text))
            > md5(concat_ws('|','feature','resident','body','done',NULL::text,
            ${sql.json(pending)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text)) LIMIT 1`;
        expect(winner).toBeDefined();
        await apply(op({ ...feature(id, winner.title, payload), status }, 1600, hlc));
        expect(await state(id)).toMatchObject({ title: winner.title, status, origin: 'remote',
          author_pubkey: AUTHOR, fed_ts: '1600', fed_hlc: hlc ?? null });
        expect((await state(id)).payload).toEqual(payload);
        expect(await outbox(id)).toBe(0);
        const nextHlc = withHlc ? '000000000001700:00000:publisher' : undefined;
        await apply(op({ ...feature(id, 'later-cycle', payload), status }, 1700, nextHlc));
        expect(await state(id)).toMatchObject({ title: 'later-cycle', status, origin: 'remote',
          fed_ts: '1700', fed_hlc: nextHlc ?? null });
        expect((await state(id)).payload).toEqual(payload);
        expect(await outbox(id)).toBe(0);
      }
    });
  }

  it('retains the deliberate INSERT policy for publisher-supplied completion intents', async () => {
    for (const status of ['open', 'done']) {
      const id = `F-REMOTE-CLOCK-${++sequence}`;
      const payload = { scenario: 'remote-insert-intent' };
      await apply(op({ ...feature(id, 'remote-insert', { ...payload,
        _completionEventIntentId: '12345678-1234-4234-8234-123456789abc' }), status }));
      expect(await state(id)).toMatchObject({ status, origin: 'remote', author_pubkey: AUTHOR,
        fed_ts: '1500', fed_hlc: null });
      expect((await state(id)).payload).toEqual(payload);
      expect(await outbox(id)).toBe(0);
    }
  });

  it('keeps local close/reopen cycles and requires a matching durable acknowledgement', async () => {
    const id = `F-REMOTE-CLOCK-${++sequence}`;
    const payload = { scenario: 'local-close' };
    await apply(op(feature(id, 'local-close', payload)));
    await sql`UPDATE harness_shared.work_items SET status='done' WHERE workspace_id=${WS} AND feature_id=${id}`;
    const first = await state(id);
    const firstIntent = first.payload._completionEventIntentId;
    expect(firstIntent).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).toMatchObject({ origin: 'local', status: 'done' });
    expect(Number(first.fed_ts)).toBeGreaterThan(1500);
    expect(first.fed_hlc).not.toBeNull();
    await sql`UPDATE harness_shared.work_items SET status='open' WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect((await state(id)).payload).toEqual(payload);
    await sql`UPDATE harness_shared.work_items SET status='done' WHERE workspace_id=${WS} AND feature_id=${id}`;
    const secondIntent = (await state(id)).payload._completionEventIntentId;
    expect(secondIntent).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondIntent).not.toBe(firstIntent);
    const pending = { ...payload, _completionEventIntentId: secondIntent };
    await sql`UPDATE harness_shared.work_items SET payload=${sql.json({ ...payload, _completionEventIntentId: 'forged' })}
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect((await state(id)).payload).toEqual(pending);
    await sql`UPDATE harness_shared.work_items SET payload=${sql.json(payload)} WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect((await state(id)).payload).toEqual(pending);
    await sql`INSERT INTO harness_shared.event_key_fires (workspace_id,event_key,last_payload)
      VALUES ('default',${`work-item:done:${id}`},${sql.json({ completionIntentId: firstIntent })})`;
    await sql`UPDATE harness_shared.work_items SET payload=${sql.json(payload)} WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect((await state(id)).payload).toEqual(pending);
    await sql`UPDATE harness_shared.event_key_fires SET last_payload=${sql.json({ completionIntentId: secondIntent })}
      WHERE workspace_id='default' AND event_key=${`work-item:done:${id}`}`;
    await sql`UPDATE harness_shared.work_items SET payload=${sql.json(payload)} WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect((await state(id)).payload).toEqual(payload);
    await sql`UPDATE harness_shared.work_items SET payload=${sql.json(pending)} WHERE workspace_id=${WS} AND feature_id=${id}`;
    expect((await state(id)).payload).toEqual(payload);
    expect(await outbox(id)).toBeGreaterThan(0);
  });

  it('causal negative control: only the old completion normalizer mints an intent on the same remote close', async () => {
    const payload = { scenario: 'completion-control' };
    const title = await terminalWinner(payload);
    const id = `F-REMOTE-CLOCK-${++sequence}`;
    await apply(op(feature(id, 'open', payload)));
    await sql.unsafe(baselineCompletion);
    try {
      await apply(op({ ...feature(id, title, payload), status: 'done' }));
      const row = await state(id);
      expect(row).toMatchObject({ origin: 'remote', fed_ts: '1500', fed_hlc: null });
      expect(row.payload._completionEventIntentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.payload).not.toEqual(payload);
    } finally {
      await sql.unsafe(readFileSync(DRAFT, 'utf8'));
    }
    const restoredId = `F-REMOTE-CLOCK-${++sequence}`;
    await apply(op(feature(restoredId, 'open', payload)));
    await apply(op({ ...feature(restoredId, title, payload), status: 'done' }));
    expect((await state(restoredId)).payload).toEqual(payload);
    expect(await outbox(restoredId)).toBe(0);
  });

  it('causal negative control: the old trigger restamps the same winning update', async () => {
    const id = `F-REMOTE-CLOCK-${++sequence}`;
    const [loser, winner] = await titles({ scenario: 'same-writer' });
    await apply(op(feature(id, loser, { scenario: 'same-writer' })));
    await sql.unsafe(baselineStamp);
    try {
      // Historical receiver used ordinary remote provenance. No other variable moves.
      await sql`UPDATE harness_shared.work_items SET title=${winner},origin='remote',author_pubkey=${AUTHOR},fed_ts=1500,fed_hlc=NULL
        WHERE workspace_id=${WS} AND feature_id=${id}`;
      expect((await state(id)).origin).toBe('local');
      expect(Number((await state(id)).fed_ts)).toBeGreaterThan(1500);
    } finally {
      await sql.unsafe(readFileSync(DRAFT, 'utf8'));
    }
  });

  it('observes completion normalization before the stamp on an actual equal-key remote close', async () => {
    const triggers = await sql`SELECT t.tgname, p.proname, pg_get_functiondef(p.oid) AS body
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='harness_shared.work_items'::regclass AND NOT t.tgisinternal
        AND (t.tgtype & 2)=2 ORDER BY t.tgname`;
    const names = triggers.map(t => t.tgname);
    expect(names.indexOf('stamp_before_fed_work_item_completion_event_intent_trg'))
      .toBeLessThan(names.indexOf('stamp_local_federated_write_trg'));
    const completion = triggers.find(t => t.proname === 'stamp_work_item_completion_event_intent');
    expect(completion?.body).toContain('NEW.fed_ts IS DISTINCT FROM OLD.fed_ts');
    await sql.unsafe(`CREATE TABLE harness_shared.receiver_clock_trace (
      n bigserial, trigger_name text, old_row jsonb, new_row jsonb);
      CREATE FUNCTION harness_shared.receiver_clock_trace() RETURNS trigger LANGUAGE plpgsql AS $trace$
      BEGIN
        INSERT INTO harness_shared.receiver_clock_trace(trigger_name,old_row,new_row)
          VALUES (TG_NAME,to_jsonb(OLD),to_jsonb(NEW));
        RETURN NEW;
      END $trace$;
      CREATE TRIGGER stamp_before_fed_work_item_completion_event_intent_tra
        BEFORE UPDATE ON harness_shared.work_items FOR EACH ROW
        EXECUTE FUNCTION harness_shared.receiver_clock_trace();
      CREATE TRIGGER stamp_before_fed_work_item_completion_event_intent_trh
        BEFORE UPDATE ON harness_shared.work_items FOR EACH ROW
        EXECUTE FUNCTION harness_shared.receiver_clock_trace()`);
    try {
      const id = `F-REMOTE-CLOCK-${++sequence}`;
      const [candidate] = await sql`SELECT 'trace-terminal-' || n AS title FROM generate_series(0,100) AS n
        WHERE md5(concat_ws('|','feature','trace-terminal-' || n,'body','done',NULL::text,'{}',NULL::text,NULL::text,NULL::text,NULL::text))
          > md5(concat_ws('|','feature','open','body','open',NULL::text,'{}',NULL::text,NULL::text,NULL::text,NULL::text)) LIMIT 1`;
      expect(candidate).toBeDefined();
      await apply(op(feature(id, 'open', {})));
      await apply(op({ ...feature(id, candidate.title, {}), status: 'done' }));
      const trace = await sql`SELECT trigger_name, old_row->>'status' AS old_status,
        new_row->>'status' AS new_status, new_row->>'origin' AS origin,
        new_row->>'fed_ts' AS fed_ts, new_row->>'fed_hlc' AS fed_hlc,
        new_row->'payload' AS payload FROM harness_shared.receiver_clock_trace
        WHERE new_row->>'feature_id'=${id} ORDER BY n`;
      console.info('WI8759-COMPLETION-TRIGGER-TRACE', JSON.stringify({ names, trace, result: await state(id) }));
      expect(trace).toHaveLength(2);
      expect(trace.map(row => row.payload)).toEqual([{}, {}]);
      expect(await state(id)).toMatchObject({ status: 'done', origin: 'remote', fed_ts: '1500' });
      expect((await state(id)).payload).toEqual({});
    } finally {
      await sql.unsafe(`DROP TRIGGER stamp_before_fed_work_item_completion_event_intent_tra ON harness_shared.work_items;
        DROP TRIGGER stamp_before_fed_work_item_completion_event_intent_trh ON harness_shared.work_items;
        DROP FUNCTION harness_shared.receiver_clock_trace(); DROP TABLE harness_shared.receiver_clock_trace`);
    }
  });

  it('bounds the feature token: the issue receiver still uses the ordinary local-stamp path', async () => {
    const projection = buildEngineerIssuesProjection({ workspaceId: WS, harnessSlug: HARNESS, sql });
    const issue = (id: string, title: string): EngineerIssueRow => ({
      harness_slug: HARNESS, issue_id: id, scope: `harness:${HARNESS}`, kind: 'bug', title,
      body: 'details', severity: 'minor', source: 'engineer', state: 'open', assignee: null,
      assigned_by: null, assigned_at: null, payload: { scenario: 'issue-clock' }, found_during: null,
      linked_feature_id: null, created_by: null, created_at: new Date(1000).toISOString(), created_ts: 1000,
    });
    const provenance = { origin: 'remote' as const, authorPubkey: AUTHOR, sourceLogKeyHex: AUTHOR, ts: 1500 };
    const id = `WI-REMOTE-CLOCK-${++sequence}`;
    await projection.writeToPg(issue(id, 'first'), provenance);
    const [resident] = await sql`SELECT payload FROM harness_shared.work_items
      WHERE workspace_id=${WS} AND feature_id=${id}`;
    const choices = await sql`SELECT title, md5(concat_ws('|','bug',title,'details','open',NULL::text,
      ${sql.json(resident.payload)}::jsonb::text,NULL::text,NULL::text,NULL::text,NULL::text)) AS digest
      FROM (VALUES ('first'), ('second')) AS titles(title) ORDER BY digest`;
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${id}`;
    const observations = [];
    for (const order of [[choices[0].title, choices[1].title], [choices[1].title, choices[0].title]]) {
      const rowId = `WI-REMOTE-CLOCK-${++sequence}`;
      for (const title of order) await projection.writeToPg(issue(rowId, title), provenance);
      const winner = await state(rowId);
      await projection.writeToPg(issue(rowId, 'intermediate'), { ...provenance, ts: 1600 });
      observations.push({ order, winner, intermediate: await state(rowId) });
    }
    console.info('WI8759-ISSUE-STATIONARY-CONTROL', JSON.stringify(observations));
    expect(observations[0].winner).toMatchObject({ title: choices[1].title, origin: 'local' });
    expect(Number(observations[0].winner.fed_ts)).toBeGreaterThan(1600);
    expect(observations[0].intermediate.title).toBe(choices[1].title);
    expect(observations[1].winner).toMatchObject({ title: choices[1].title, origin: 'remote', fed_ts: '1500' });
    expect(observations[1].intermediate).toMatchObject({ title: 'intermediate', origin: 'remote', fed_ts: '1600' });
  });
});

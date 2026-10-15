/**
 * P-017 (WI-10004021, plan external-app-access-to-workspaces-2026-09-29, D-032) against real Postgres:
 * a signed POST to a webhook starts the blueprint operation its armed binding names; a missing, bad
 * or stale signature is refused and writes nothing; the Remote access switch refuses when off; a
 * replayed delivery is deduped; a rotation keeps the previous key valid only for its overlap.
 *
 * The HTTP route (routes/webhooks) is driven with a real Request so the raw-body and path-param
 * plumbing is covered too; only its dependencies are pointed at this test database.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createWebhookRoutes } from '../endpoint-route/routes/webhooks';
import { createExternalTriggerBinding, setExternalTriggerBindingArmed } from './admin';
import { dispatchPendingTriggerRuns, type TriggerDispatchDeps } from './binding-engine';
import {
  WEBHOOK_DATATYPE_ID,
  createWebhookSource,
  handleWebhookDelivery,
  rotateWebhookSigningKey,
  signWebhook,
  type CreatedWebhook,
} from './webhook';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const WS = 'papercusp-workspace';
const DB_KEY = 'webhook-integration-test-key';

let org: OrgTestDb;
let sql: Sql;
let remoteOn = true;
let hook: CreatedWebhook;
let bindingId: string;

const deliver = (sourceId: string, body: string, headers: Record<string, string>, nowSec?: number) =>
  handleWebhookDelivery(
    { sourceId, headers: new Headers(headers), rawBody: new TextEncoder().encode(body) },
    {
      sql,
      encryptionKey: DB_KEY,
      remoteAccessEnabled: async () => remoteOn,
      ...(nowSec === undefined ? {} : { now: () => new Date(nowSec * 1000) }),
    },
  );

const [route] = createWebhookRoutes({
  deliver: (request) => handleWebhookDelivery(request, { sql, encryptionKey: DB_KEY, remoteAccessEnabled: async () => remoteOn }),
});

async function post(sourceId: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request(`http://127.0.0.1/api/hooks/${sourceId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const res = await (route as unknown as { handler: (req: Request, ctx: unknown) => Promise<Response> }).handler(request, {
    params: { sourceId },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function counts(): Promise<{ deliveries: number; runs: number }> {
  const [d] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ${hook.source.id}::uuid`;
  const [r] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.trigger_runs WHERE workspace_id = ${WS} AND binding_id = ${bindingId}::uuid`;
  return { deliveries: d!.n, runs: r!.n };
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const migration = path.join(REPO, 'libs/papercusp/libs/db/sql/1269-webhook-trigger-secrets.sql');
  await sql.unsafe(readFileSync(existsSync(migration) ? migration : `${migration}.DRAFT`, 'utf8'));

  hook = await createWebhookSource(sql, { workspaceId: WS, label: 'CI pushes', createdBy: 'test' }, { encryptionKey: DB_KEY });
  const binding = await createExternalTriggerBinding(sql, WS, {
    sourceId: hook.source.id,
    eventPattern: 'ext:webhook:push',
    operationHarnessSlug: 'papercusp',
    operationId: 'handle-push',
    operationInput: { lane: 'ci' },
    createdBy: 'test',
  });
  bindingId = binding.id;
  await setExternalTriggerBindingArmed(sql, WS, bindingId, true);
}, 180_000);

afterAll(async () => {
  await org?.cleanup?.();
});

beforeEach(() => {
  remoteOn = true;
});

describe('webhook source', () => {
  it('is a ready webhook source with its key stored encrypted, never in the clear', async () => {
    expect(hook.source).toMatchObject({ kind: 'webhook', status: 'ready', config: { label: 'CI pushes' } });
    expect(hook.path).toBe(`/api/hooks/${hook.source.id}`);
    const [row] = await sql<Array<{ plain: number; decrypted: string }>>`
      SELECT position(convert_to(${hook.signingKey}, 'UTF8') IN secret_ct) AS plain,
             pgp_sym_decrypt(secret_ct, ${DB_KEY}) AS decrypted
        FROM harness_shared.trigger_webhook_secrets WHERE workspace_id = ${WS} AND source_id = ${hook.source.id}::uuid`;
    expect(row!.plain).toBe(0);
    expect(row!.decrypted).toBe(hook.signingKey);
    const [dt] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.datatype_registry WHERE workspace_id = ${WS} AND id = ${WEBHOOK_DATATYPE_ID}`;
    expect(dt!.n).toBe(1);
  });
});

describe('signed delivery (R-22)', () => {
  it('a signed POST answers 202 and starts the operation its armed binding names', async () => {
    const before = await counts();
    const body = JSON.stringify({ ref: 'refs/heads/main', sha: 'abc123' });
    const t = nowSec();
    const res = await post(hook.source.id, body, {
      'papercusp-signature': signWebhook(hook.signingKey, t, body),
      'papercusp-event': 'push',
      'papercusp-delivery': 'delivery-1',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ ok: true, deliveryId: 'delivery-1', event: 'push', deduped: false });
    const after = await counts();
    expect(after.runs).toBe(before.runs + 1);

    const handle = {
      workspaceId: WS,
      harnessSlug: 'papercusp',
      receiptId: 7,
      operationId: 'handle-push',
      specificationRevision: 'b'.repeat(64),
      target: { kind: 'work-item' as const, id: 'WI-webhook-7' },
    };
    const submitOperation = vi.fn<NonNullable<TriggerDispatchDeps['submitOperation']>>(async () => handle);
    await expect(dispatchPendingTriggerRuns(sql, { submitOperation })).resolves.toMatchObject({ succeeded: 1, failed: 0 });
    expect(submitOperation).toHaveBeenCalledTimes(1);
    expect(submitOperation.mock.calls[0]![1]).toMatchObject({
      workspaceId: WS,
      harnessSlug: 'papercusp',
      operationId: 'handle-push',
      callerId: `trigger-binding:${bindingId}`,
      input: expect.objectContaining({ lane: 'ci' }),
    });
  });

  it('a replayed delivery id is deduped: 202, no second run', async () => {
    const before = await counts();
    const body = JSON.stringify({ ref: 'refs/heads/main', sha: 'abc123' });
    const res = await post(hook.source.id, body, {
      'papercusp-signature': signWebhook(hook.signingKey, nowSec(), body),
      'papercusp-event': 'push',
      'papercusp-delivery': 'delivery-1',
    });
    expect(res.status).toBe(202);
    expect(res.body.deduped).toBe(true);
    expect((await counts()).runs).toBe(before.runs);
  });

  it('an event no binding matches is accepted but starts nothing', async () => {
    const before = await counts();
    const body = JSON.stringify({ x: 1 });
    const res = await post(hook.source.id, body, {
      'papercusp-signature': signWebhook(hook.signingKey, nowSec(), body),
      'papercusp-event': 'tag',
    });
    expect(res.status).toBe(202);
    expect((await counts()).runs).toBe(before.runs);
  });
});

describe('refusals write nothing (R-23)', () => {
  const body = JSON.stringify({ ref: 'refs/heads/evil' });

  it('401 for a missing, malformed, wrong-key, tampered or stale signature', async () => {
    const before = await counts();
    const t = nowSec();
    const cases: Array<[Record<string, string>, string, string]> = [
      [{}, body, 'signature_missing'],
      [{ 'papercusp-signature': 'nonsense' }, body, 'signature_malformed'],
      [{ 'papercusp-signature': signWebhook('whsec_not_the_key', t, body) }, body, 'signature_invalid'],
      [{ 'papercusp-signature': signWebhook(hook.signingKey, t, body) }, body.replace('evil', 'good'), 'signature_invalid'],
      [{ 'papercusp-signature': signWebhook(hook.signingKey, t - 301, body) }, body, 'signature_stale'],
    ];
    for (const [headers, sent, reason] of cases) {
      const res = await post(hook.source.id, sent, { 'papercusp-event': 'push', ...headers });
      expect(res.status, reason).toBe(401);
      expect(res.body, reason).toEqual({ ok: false, error: 'signature_invalid', reason });
    }
    expect(await counts()).toEqual(before);
  });

  it('403 remote_access_off when the workspace Remote access switch is off, even when correctly signed', async () => {
    const before = await counts();
    remoteOn = false;
    const res = await post(hook.source.id, body, {
      'papercusp-signature': signWebhook(hook.signingKey, nowSec(), body),
      'papercusp-event': 'push',
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'remote_access_off' });
    expect(await counts()).toEqual(before);
  });

  it('404 with no detail for an unknown source or a disabled one', async () => {
    const before = await counts();
    const unknown = await post('7d3c1c6e-0000-4000-8000-000000000000', body, {
      'papercusp-signature': signWebhook(hook.signingKey, nowSec(), body),
    });
    expect(unknown).toEqual({ status: 404, body: { ok: false, error: 'not_found' } });

    const other = await createWebhookSource(sql, { workspaceId: WS }, { encryptionKey: DB_KEY });
    await sql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE workspace_id = ${WS} AND id = ${other.source.id}::uuid`;
    const disabled = await post(other.source.id, body, { 'papercusp-signature': signWebhook(other.signingKey, nowSec(), body) });
    expect(disabled).toEqual({ status: 404, body: { ok: false, error: 'not_found' } });
    expect(await counts()).toEqual(before);
  });
});

describe('rotation', () => {
  it('the previous key verifies during the overlap; with no overlap it stops at once', async () => {
    const other = await createWebhookSource(sql, { workspaceId: WS, label: 'rotation' }, { encryptionKey: DB_KEY });
    const body = JSON.stringify({ n: 1 });
    const send = (key: string) => deliver(other.source.id, body, { 'papercusp-signature': signWebhook(key, nowSec(), body) });

    const first = await rotateWebhookSigningKey(sql, { workspaceId: WS, sourceId: other.source.id, overlapSec: 3600 }, { encryptionKey: DB_KEY });
    expect(first.previousValidUntil).not.toBeNull();
    expect(first.signingKey).not.toBe(other.signingKey);
    expect((await send(other.signingKey)).status).toBe(202);
    expect((await send(first.signingKey)).status).toBe(202);

    const second = await rotateWebhookSigningKey(sql, { workspaceId: WS, sourceId: other.source.id, overlapSec: 0 }, { encryptionKey: DB_KEY });
    expect(second.previousValidUntil).toBeNull();
    expect((await send(first.signingKey)).status).toBe(401);
    expect((await send(other.signingKey)).status).toBe(401);
    expect((await send(second.signingKey)).status).toBe(202);

    await expect(
      rotateWebhookSigningKey(sql, { workspaceId: WS, sourceId: '7d3c1c6e-0000-4000-8000-000000000000' }, { encryptionKey: DB_KEY }),
    ).rejects.toThrow(/webhook_not_found/);
  });
});

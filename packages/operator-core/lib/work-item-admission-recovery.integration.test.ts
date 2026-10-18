import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  AdmissionRecoveryRefused, observeAdmissionRecoveryPickup, requestAdmissionRecovery, runAdmissionRecoveries,
  readAuthorizedComponentScreeningIds,
  type AdmissionRecoveryDeps,
} from './work-item-admission-recovery';

let db: FreshPgDb;
const scope = { workspaceId: 'ws-recovery', harnessSlug: 'papercusp', workItemId: 'WI-original' };
const input = { ...scope, caller: 'requester', target: 'reviewer' };
const authorize = vi.fn(async () => {});
beforeAll(async () => {
  db = await createFreshPgDb('admission-recovery');
  await db.sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.operator_secrets(name text PRIMARY KEY, value_b64 text);
    INSERT INTO harness_shared.operator_secrets VALUES ('spawn-signing-key', '${Buffer.alloc(32, 42).toString('base64')}');
    CREATE TABLE harness_shared.work_items (
      workspace_id text, harness_slug text, feature_id text, status text DEFAULT 'open',
      origin text DEFAULT 'local', taken_by text, admission text DEFAULT 'pending', payload jsonb,
      author_pubkey text, last_progress_at timestamptz,
      PRIMARY KEY(workspace_id, harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY, workspace_id text, install_slug text, name text, target_role text,
      active boolean DEFAULT true, trigger_config jsonb, next_fire_at timestamptz
    );
  `);
}, 60_000);
afterAll(async () => db?.cleanup());
beforeEach(async () => {
  authorize.mockReset().mockResolvedValue(undefined);
  await db.sql`UPDATE harness_shared.operator_secrets SET value_b64 = ${Buffer.alloc(32, 42).toString('base64')}`;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.routines`;
  await db.sql`
    INSERT INTO harness_shared.work_items(workspace_id,harness_slug,feature_id,payload)
    VALUES (${scope.workspaceId}, ${scope.harnessSlug}, ${scope.workItemId}, '{"keep":"original"}')`;
  await db.sql`
    INSERT INTO harness_shared.routines(id,workspace_id,install_slug,name,target_role,trigger_config,next_fire_at)
    VALUES ('real-promoter',${scope.workspaceId},${scope.harnessSlug},'work-item-admission-promoter',
      'system:work-item-admission-promoter','{"cron":"*/30 * * * *"}', now() + interval '30 minutes')`;
});
async function current() {
  const [row] = await db.sql`SELECT * FROM harness_shared.work_items WHERE feature_id = ${scope.workItemId}`;
  return row!;
}
function deps(overrides: Partial<AdmissionRecoveryDeps> = {}): AdmissionRecoveryDeps {
  return {
    authorize,
    lockSql: db.sql,
    screen: vi.fn(async (_scope, beforePersist) => {
      await beforePersist();
      await db.sql`UPDATE harness_shared.work_items SET admission = 'admitted' WHERE feature_id = ${scope.workItemId}`;
    }),
    dispatch: vi.fn(async () => {
      const row = await current();
      expect(row.admission).toBe('admitted');
      await db.sql`UPDATE harness_shared.work_items SET taken_by = 'reviewer' WHERE feature_id = ${scope.workItemId}`;
      return { ok: true, wake: { queued: 1, woken: 1 } } as Awaited<ReturnType<AdmissionRecoveryDeps['dispatch']>>;
    }),
    ...overrides,
  };
}

describe('original-item durable admission recovery', () => {
  async function heldComponentRequest() {
    const result = await requestAdmissionRecovery({ ...input, authority: {
      kind: 'signed-spawn', role: 'reviewer', expiresAtSec: 0,
      credentialSha256: 'a'.repeat(64),
    } }, { authorize }, db.sql);
    await db.sql`UPDATE harness_shared.work_items SET payload = payload || jsonb_build_object('_admissionRecovery',
      ${db.sql.json({ ...result.request, state: 'held', stage: 'screen', reason: 'outside-mutation-scope: component endpoints' })})`;
    authorize.mockClear();
    return (await current()).payload;
  }

  it('reads authenticated scope-held component priority without modifying or dispatching its request', async () => {
    const before = await heldComponentRequest();
    expect(await readAuthorizedComponentScreeningIds(scope, { authorize }, db.sql)).toEqual([scope.workItemId]);
    expect(authorize).toHaveBeenCalledWith(scope, expect.objectContaining({ requestId: before._admissionRecovery.requestId }));
    expect((await current()).payload).toEqual(before);
    expect((await current()).taken_by).toBeNull();
  });

  it.each(['pending', 'unreviewed'] as const)(
    'preserves the screening opportunity after an unjudged twin hold on a %s row', async (admission) => {
      await heldComponentRequest();
      for (const structured of [false, true]) {
        const heldAt = '2099-01-01T00:00:00Z';
        await db.sql`UPDATE harness_shared.work_items SET admission = ${admission}, payload = payload ||
          ${db.sql.json({
            admissionHold: {
              reason: 'deferred: twin WI-protected is claimed; held until it can be judged',
              actor: 'system:work-item-admission-promoter', heldAt,
              ...(structured ? { screeningDeferred: true } : {}),
            },
            ...(admission === 'unreviewed' ? { admissionReview: { lastRetryAt: heldAt } } : {}),
          })}`;
        const before = (await current()).payload;
        expect(await readAuthorizedComponentScreeningIds(scope, { authorize }, db.sql)).toEqual([scope.workItemId]);
        expect((await current()).payload).toEqual(before);
      }
    },
  );

  it.each(['judged', 'foreign-actor'])(
    'retires a hold that resembles a structural deferral but is %s', async (kind) => {
      await heldComponentRequest();
      await db.sql`UPDATE harness_shared.work_items SET payload = payload || ${db.sql.json({
        admissionHold: {
          reason: 'deferred: twin WI-protected is claimed; held until it can be judged',
          actor: kind === 'foreign-actor' ? 'unverified' : 'system:work-item-admission-promoter',
          heldAt: '2099-01-01T00:00:00Z',
          ...(kind === 'judged' ? { screeningDeferred: false } : {}),
        },
      })}`;
      expect(await readAuthorizedComponentScreeningIds(scope, { authorize }, db.sql)).toEqual([]);
    },
  );

  it.each(['signature', 'authority', 'peer', 'routine', 'foreign', 'malformed', 'changed', 'claim-during-authorization', 'reviewed', 'held-after-screen'])(
    'does not prioritize an ineligible component request: %s', async (failure) => {
      await heldComponentRequest();
      if (failure === 'signature') await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{_admissionRecovery,signature}', ${db.sql.json('0'.repeat(64))})`;
      if (failure === 'authority') authorize.mockRejectedValue(new AdmissionRecoveryRefused('revoked original authority'));
      if (failure === 'peer') await db.sql`UPDATE harness_shared.work_items SET taken_by = 'another-peer'`;
      if (failure === 'routine') await db.sql`UPDATE harness_shared.routines SET active = false`;
      if (failure === 'foreign') await db.sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign'`;
      if (failure === 'malformed') await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{_admissionRecovery,requestId}', '"invalid"')`;
      if (failure === 'reviewed') await db.sql`UPDATE harness_shared.work_items SET payload = payload ||
        jsonb_build_object('admissionReview', jsonb_build_object('lastRetryAt', '2099-01-01T00:00:00Z'))`;
      if (failure === 'held-after-screen') await db.sql`UPDATE harness_shared.work_items SET payload = payload ||
        jsonb_build_object('admissionHold', jsonb_build_object('heldAt', '2099-01-01T00:00:00Z'))`;
      if (failure === 'changed') authorize.mockImplementationOnce(async () => {
        await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{_admissionRecovery,state}', '"queued"')`;
      });
      if (failure === 'claim-during-authorization') authorize.mockImplementationOnce(async () => {
        await db.sql`UPDATE harness_shared.work_items SET taken_by = 'new-peer'`;
      });
      expect(await readAuthorizedComponentScreeningIds(scope, { authorize }, db.sql)).toEqual([]);
    },
  );

  it('persists and signs the original bounded dispatch instructions across retries', async () => {
    const first = await requestAdmissionRecovery({
      ...input, note: 'Independent review', body: 'Report findings; do not modify implementation.',
    }, { authorize }, db.sql);
    const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(retry.request).toMatchObject({
      version: 2, requestId: first.request.requestId,
      note: 'Independent review', body: 'Report findings; do not modify implementation.',
    });
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      summary: 'Independent review', instructions: 'Report findings; do not modify implementation.',
    }));
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await db.sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{_admissionRecovery,body}', '"forged instructions"')`;
    const forged = deps();
    await runAdmissionRecoveries(scope, forged, db.sql);
    expect(forged.dispatch).not.toHaveBeenCalled();
  });

  it('accepts legacy v1 signatures without allowing unsigned instructions to be attached', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const legacy = { ...first.request, version: 1 as const };
    legacy.signature = createHmac('sha256', Buffer.alloc(32, 42)).update(JSON.stringify([
      'admission-recovery-v1', scope.workspaceId, scope.harnessSlug, scope.workItemId,
      legacy.requestId, legacy.caller, legacy.target, legacy.routineId, legacy.requestedAt,
    ])).digest('hex');
    await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{_admissionRecovery}', ${db.sql.json(legacy)})`;
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{_admissionRecovery}',
      ${db.sql.json({ ...legacy, note: 'forged unsigned v1 instructions' })})`;
    const forged = deps();
    await runAdmissionRecoveries(scope, forged, db.sql);
    expect(forged.dispatch).not.toHaveBeenCalled();
    expect((await current()).payload._admissionRecovery.state).toBe('held');
  });

  it.each([
    { wake: { queued: 1, woken: 0 }, state: 'delivered', stage: 'await-pickup' },
    { wake: { queued: 0, woken: 1 }, state: 'held', stage: 'wake' },
    { wake: { woken: 1 }, state: 'delivered', stage: 'await-pickup' },
    { wake: { woken: 0 }, state: 'held', stage: 'wake' },
  ])('records queue truth without inferring pickup: $wake', async ({ wake, state, stage }) => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ dispatch: vi.fn(async () => ({ ok: true, wake }) as
      Awaited<ReturnType<AdmissionRecoveryDeps['dispatch']>>) });
    await runAdmissionRecoveries(scope, d, db.sql);
    expect((await current()).payload._admissionRecovery).toMatchObject({ state, stage, pickupConfirmed: false });
  });

  it('reports a screening hold before dispatch and resumes the same request after repair', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ screen: vi.fn(async () => undefined) });
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect((await current()).payload._admissionRecovery).toMatchObject({
      requestId: first.request.requestId, state: 'held', stage: 'screen',
      reason: expect.stringContaining('screening left the original item pending'), pickupConfirmed: false,
    });
    const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(retry.request).toMatchObject({ requestId: first.request.requestId, stage: 'queued' });
    await runAdmissionRecoveries(scope, deps(), db.sql);
    expect((await current()).payload._admissionRecovery).toMatchObject({ state: 'delivered', stage: 'await-pickup' });
  });

  it('retains the canonical assignment refusal in the original request', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ dispatch: vi.fn(async () => ({
      ok: false, wake: null, warning: 'no assignment landed',
      target: { requested: 'reviewer', ownerId: 'reviewer', present: true, sessionState: 'parked', wakeable: true },
      assignment: {
        ok: false, targetAgent: 'reviewer', requested: [scope.workItemId], actionable: [], assigned: [], retained: [],
        skipped: [{ workItemId: scope.workItemId, code: 'dependency_blocked' as const,
          reason: 'unresolved work-item blocker: WI-dependency' }], failed: [], executionWorkItemIds: [],
      },
    })) });
    await runAdmissionRecoveries(scope, d, db.sql);
    expect((await current()).payload._admissionRecovery).toMatchObject({
      state: 'held', stage: 'assign', reason: 'unresolved work-item blocker: WI-dependency', pickupConfirmed: false,
    });
  });

  it('reports current target guard refusals before a stale stored hold without changing protected rows', async () => {
    await db.sql`UPDATE harness_shared.work_items
      SET payload = payload || ${db.sql.json({ admissionHold: { reason: 'old ambiguity', runId: 'old-run' } })}`;
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ screen: vi.fn(async () => ({
      runId: 'current-screen',
      guardRefusals: [
        { itemId: 'WI-other', canonicalId: null, reason: 'remote-owned' as const, detail: 'unrelated refusal' },
        { itemId: scope.workItemId, canonicalId: null, reason: 'outside-mutation-scope' as const,
          detail: 'screened component requires mutations outside the exact target set; no component writes authorized' },
      ],
    })) });
    await runAdmissionRecoveries(scope, d, db.sql);
    const original = await current();
    expect(original).toMatchObject({ admission: 'pending', taken_by: null });
    expect(original.payload.admissionHold).toEqual({ reason: 'old ambiguity', runId: 'old-run' });
    expect(original.payload._admissionRecovery).toMatchObject({
      requestId: first.request.requestId, state: 'held', stage: 'screen', pickupConfirmed: false,
    });
    expect(original.payload._admissionRecovery.reason).toContain('current-screen');
    expect(original.payload._admissionRecovery.reason).toContain('outside-mutation-scope');
    expect(original.payload._admissionRecovery.reason).toContain('no component writes authorized');
    expect(original.payload._admissionRecovery.reason).toContain('ordinary component screening/review');
    expect(original.payload._admissionRecovery.reason).not.toMatch(/old ambiguity|unrelated refusal/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('does not attribute another item\'s guard refusal to the original stored hold', async () => {
    await db.sql`UPDATE harness_shared.work_items
      SET payload = payload || ${db.sql.json({ admissionHold: { reason: 'needs review', runId: 'hold-run' } })}`;
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ screen: vi.fn(async () => ({
      runId: 'other-screen',
      guardRefusals: [
        { itemId: 'WI-other', canonicalId: null, reason: 'claimed' as const, detail: 'other holder' },
      ],
    })) });
    await runAdmissionRecoveries(scope, d, db.sql);
    const reason = (await current()).payload._admissionRecovery.reason;
    expect(reason).toContain('admission hold from run hold-run: needs review');
    expect(reason).not.toMatch(/other-screen|other holder|ordinary component screening/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('concurrent/repeated requests persist one identity and atomically accelerate the real routine', async () => {
    // First commit establishes the visible identity; racing retries must preserve it.
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const retries = await Promise.all(Array.from({ length: 5 }, () => requestAdmissionRecovery(input, { authorize }, db.sql)));
    expect(new Set([first, ...retries].map((r) => r.request.requestId)).size).toBe(1);
    const [count] = await db.sql`SELECT count(*)::int AS n FROM harness_shared.work_items`;
    expect(count!.n).toBe(1);
    expect((await current()).payload).toMatchObject({ keep: 'original', _admissionRecovery: { state: 'queued' } });
    const [routine] = await db.sql`SELECT next_fire_at <= now() AS due FROM harness_shared.routines`;
    expect(routine!.due).toBe(true);
  });

  it('first-request races converge on the original item without a replacement task', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => requestAdmissionRecovery(input, { authorize }, db.sql)));
    const committed = attempts.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    expect(committed.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') expect(attempt.reason.message).toContain('retry this same item');
    }
    const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(new Set([...committed, retry].map((r) => r.request.requestId)).size).toBe(1);
    const [count] = await db.sql`SELECT count(*)::int AS n FROM harness_shared.work_items`;
    expect(count!.n).toBe(1);
  });

  it('isolates a malformed queued request and permits fresh authorized repair on the same item', async () => {
    await db.sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{_admissionRecovery}', '{"state":"queued","signature":"bad"}')`;
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    expect((await current()).payload._admissionRecovery).toMatchObject({
      state: 'held', pickupConfirmed: false, reason: expect.stringContaining('malformed'),
    });
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect((await current()).payload.keep).toBe('original');
  });

  it('key rotation denies automatic replay but a fresh authorized retry re-signs the same requestId', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    await db.sql`UPDATE harness_shared.operator_secrets SET value_b64 = ${Buffer.alloc(32, 43).toString('base64')}`;
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    expect((await current()).payload._admissionRecovery.state).toBe('held');
    const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(retry.request.requestId).toBe(first.request.requestId);
    expect(retry.request.signature).not.toBe(first.request.signature);
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['before-persist', 'after-dispatch'])('preserves a concurrently replaced request %s', async (phase) => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const replace = async () => {
      await db.sql`UPDATE harness_shared.work_items
        SET payload = jsonb_set(payload, '{_admissionRecovery,reason}', '"external replacement"')`;
    };
    const d = deps();
    if (phase === 'before-persist') {
      d.screen = vi.fn(async (_scope, beforePersist) => { await replace(); await beforePersist(); });
    } else {
      const dispatch = d.dispatch;
      d.dispatch = vi.fn(async (args) => { const result = await dispatch(args); await replace(); return result; });
    }
    await runAdmissionRecoveries(scope, d, db.sql);
    expect((await current()).payload._admissionRecovery).toMatchObject({ state: 'queued', reason: 'external replacement' });
    if (phase === 'before-persist') {
      expect(d.dispatch).not.toHaveBeenCalled();
      expect((await current()).admission).toBe('pending');
    }
  });

  it.each(['missing', 'paused', 'wrong-role', 'one-shot'])('refuses a %s routine without persisting a request', async (mode) => {
    if (mode === 'missing') await db.sql`DELETE FROM harness_shared.routines`;
    if (mode === 'paused') await db.sql`UPDATE harness_shared.routines SET active = false`;
    if (mode === 'wrong-role') await db.sql`UPDATE harness_shared.routines SET target_role = 'system:other'`;
    if (mode === 'one-shot') await db.sql`UPDATE harness_shared.routines SET trigger_config = '{}'`;
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('existing recurring');
    expect((await current()).payload).toEqual({ keep: 'original' });
  });

  it('caller revocation after enqueue holds the same item without screening or dispatch', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    authorize.mockRejectedValue(new AdmissionRecoveryRefused('requester no longer authorized'));
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    expect((await current()).payload._admissionRecovery).toMatchObject({ state: 'held', pickupConfirmed: false });
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('no longer authorized');
  });

  it('rejects a forged caller or a request transplanted onto another item', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await db.sql`
      INSERT INTO harness_shared.work_items(workspace_id,harness_slug,feature_id,payload)
      SELECT workspace_id,harness_slug,'WI-transplant',payload FROM harness_shared.work_items`;
    await db.sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{_admissionRecovery,caller}', '"forged"')
      WHERE feature_id = ${scope.workItemId}`;
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    const rows = await db.sql`SELECT payload->'_admissionRecovery'->>'reason' AS reason FROM harness_shared.work_items`;
    expect(rows.every((r) => r.reason.includes('provenance is invalid'))).toBe(true);
  });

  // WI-10006515: origin records how a row ARRIVED, not who wrote it (WI-10003565).
  async function strandAsRemote(authorKey: string) {
    // A key this workspace has written locally is one of OUR own-node keys.
    await db.sql`
      INSERT INTO harness_shared.work_items(workspace_id,harness_slug,feature_id,author_pubkey)
      VALUES (${scope.workspaceId}, ${scope.harnessSlug}, 'WI-own-key-witness', 'own-key')`;
    await db.sql`UPDATE harness_shared.work_items SET origin = 'remote', author_pubkey = ${authorKey}
      WHERE feature_id = ${scope.workItemId}`;
  }

  it('heals an own-node row stranded at origin=remote and recovers it instead of refusing', async () => {
    await strandAsRemote('own-key');
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(first.ok).toBe(true);
    const row = await current();
    expect(row.origin).toBe('local');
    expect(row.payload).toMatchObject({ keep: 'original', _admissionRecovery: { state: 'queued' } });
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect((await current()).taken_by).toBe('reviewer');
  });

  it('still refuses a true peer row at origin=remote and leaves it untouched', async () => {
    await strandAsRemote('peer-key');
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('originating actor');
    const row = await current();
    expect(row.origin).toBe('remote');
    expect(row.payload).toEqual({ keep: 'original' });
  });

  it('rechecks authority after screening latency and stops before admission persistence', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ screen: async (_scope, beforePersist) => {
      authorize.mockRejectedValue(new AdmissionRecoveryRefused('target policy revoked during model call'));
      await beforePersist();
      throw new Error('unreachable persistence');
    } });
    await runAdmissionRecoveries(scope, d, db.sql);
    expect((await current()).admission).toBe('pending');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a paused routine after queueing cannot screen or wake', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await db.sql`UPDATE harness_shared.routines SET active = false`;
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('replays after a crash following committed assignment without creating or rescreening', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    const originalDispatch = d.dispatch;
    d.dispatch = vi.fn(async (args) => {
      const result = await originalDispatch(args);
      if (vi.mocked(d.dispatch).mock.calls.length === 1) throw new Error('crash after assignment');
      return result;
    });
    await expect(runAdmissionRecoveries(scope, d, db.sql)).rejects.toThrow('crash after assignment');
    expect((await current()).taken_by).toBe('reviewer');
    expect((await current()).payload._admissionRecovery.state).toBe('queued');
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.screen).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledTimes(2);
    expect((await current()).payload._admissionRecovery).toMatchObject({
      requestId: first.request.requestId, state: 'delivered', pickupConfirmed: false,
    });
    const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(retry.request.requestId).toBe(first.request.requestId);
    await runAdmissionRecoveries(scope, d, db.sql);
    expect(d.dispatch).toHaveBeenCalledTimes(3);
    expect(d.screen).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent consumers, including the delivery window', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    await Promise.all([runAdmissionRecoveries(scope, d, db.sql), runAdmissionRecoveries(scope, d, db.sql)]);
    expect(d.screen).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not keep a transaction open while screening waits and keeps recovery serialized', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    let releaseScreen!: () => void;
    let screenStarted!: () => void;
    const screenGate = new Promise<void>((resolve) => { releaseScreen = resolve; });
    const screenStartedPromise = new Promise<void>((resolve) => { screenStarted = resolve; });
    const d = deps({
      screen: vi.fn(async (_scope, beforePersist) => {
        await beforePersist();
        screenStarted();
        await screenGate;
        await db.sql`UPDATE harness_shared.work_items SET admission = 'admitted' WHERE feature_id = ${scope.workItemId}`;
      }),
    });
    const running = runAdmissionRecoveries(scope, d, db.sql);
    try {
      await screenStartedPromise;
      const [activity] = await db.sql<{ count: number }[]>`SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state = 'idle in transaction'`;
      expect(activity?.count).toBe(0);

      const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
      expect(retry).toMatchObject({ ok: true, workItemId: scope.workItemId, inProgress: true });
    } finally {
      releaseScreen();
      await running;
    }
    expect((await current()).payload._admissionRecovery).toMatchObject({
      state: 'delivered', pickupConfirmed: false,
    });
  });

  it('refuses changed target, cross-scope identity, remote origin, and peer holds', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await expect(requestAdmissionRecovery({ ...input, target: 'other' }, { authorize }, db.sql)).rejects.toThrow('belongs to');
    await expect(requestAdmissionRecovery({ ...input, harnessSlug: 'elsewhere' }, { authorize }, db.sql)).rejects.toThrow('not found');
    await db.sql`UPDATE harness_shared.work_items SET origin = 'remote'`;
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('originating actor');
    await db.sql`UPDATE harness_shared.work_items SET origin = 'local', taken_by = 'peer'`;
    await expect(requestAdmissionRecovery(input, { authorize }, db.sql)).rejects.toThrow('held by peer');
  });

  it('an interrupted authorization read leaves the request queued for durable replay', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    authorize.mockRejectedValueOnce(new Error('policy store unavailable'));
    await expect(runAdmissionRecoveries(scope, deps(), db.sql)).rejects.toThrow('policy store unavailable');
    expect((await current()).payload._admissionRecovery.state).toBe('queued');
  });

  it.each(['before-claim', 'before-wake'])('holds and resumes the original request when caller is revoked %s', async (phase) => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps({ dispatch: vi.fn(async (args) => {
      expect(args.beforeMutate).toBeTypeOf('function');
      if (phase === 'before-wake') {
        await db.sql`UPDATE harness_shared.work_items SET taken_by = 'reviewer' WHERE feature_id = ${scope.workItemId}`;
      }
      authorize.mockRejectedValue(new AdmissionRecoveryRefused('original caller revoked during dispatch'));
      await args.beforeMutate!(phase === 'before-wake' ? 'wake' : 'claim');
      throw new Error('unreachable wake');
    }) });
    await runAdmissionRecoveries(scope, d, db.sql);
    expect((await current()).payload._admissionRecovery).toMatchObject({
      state: 'held', requestId: first.request.requestId, pickupConfirmed: false,
      reason: 'original caller revoked during dispatch', stage: phase === 'before-wake' ? 'wake' : 'assign',
    });
    expect((await current()).taken_by).toBe(phase === 'before-wake' ? 'reviewer' : null);
    authorize.mockResolvedValue(undefined);
    const retry = await requestAdmissionRecovery(input, { authorize }, db.sql);
    expect(retry.request.requestId).toBe(first.request.requestId);
    const resumed = deps();
    await runAdmissionRecoveries(scope, resumed, db.sql);
    expect(resumed.screen).not.toHaveBeenCalled();
    expect((await current()).payload._admissionRecovery.state).toBe('delivered');
  });

  it('confirms pickup only after the target records progress later than delivery', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    const delivered = (await current()).payload._admissionRecovery;
    expect(delivered).toMatchObject({ state: 'delivered', stage: 'await-pickup', pickupConfirmed: false });
    expect(delivered.deliveredAt).toBeTypeOf('string');

    const progressAt = new Date(Date.parse(delivered.deliveredAt) + 1);
    await db.sql`UPDATE harness_shared.work_items SET last_progress_at = ${progressAt.toISOString()}::timestamptz
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
        AND feature_id = ${scope.workItemId}`;
    await runAdmissionRecoveries(scope, d, db.sql);

    const observed = (await current()).payload._admissionRecovery;
    expect(observed).toMatchObject({
      requestId: first.request.requestId,
      state: 'delivered', stage: 'picked-up', pickupConfirmed: false,
      pickupObservation: {
        requestId: first.request.requestId,
        workItemId: scope.workItemId,
        target: input.target,
        deliveredAt: delivered.deliveredAt,
        verdict: 'confirmed',
        activityAt: progressAt.toISOString(),
        source: 'last-progress-at',
      },
    });
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps pickup unconfirmed when the target progress predates delivery', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    const d = deps();
    await runAdmissionRecoveries(scope, d, db.sql);
    const delivered = (await current()).payload._admissionRecovery;
    const progressAt = new Date(Date.parse(delivered.deliveredAt) - 1);
    await db.sql`UPDATE harness_shared.work_items SET last_progress_at = ${progressAt.toISOString()}::timestamptz
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
        AND feature_id = ${scope.workItemId}`;

    await runAdmissionRecoveries(scope, d, db.sql);

    expect((await current()).payload._admissionRecovery).toMatchObject({
      requestId: first.request.requestId,
      state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
      pickupObservation: {
        verdict: 'not-yet', activityAt: progressAt.toISOString(), source: 'last-progress-at',
        reason: expect.stringContaining('predates recovery delivery'),
      },
    });
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses pickup observations for a different request or target before reading activity', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    await runAdmissionRecoveries(scope, deps(), db.sql);
    const readActivity = vi.fn(async () => ({ assignee: input.target, lastProgressAt: new Date() }));

    await expect(observeAdmissionRecoveryPickup({
      ...scope, requestId: '00000000-0000-4000-8000-000000000000', target: input.target,
    }, { readActivity }, db.sql)).rejects.toThrow('does not match the saved recovery request and target');
    await expect(observeAdmissionRecoveryPickup({
      ...scope, requestId: first.request.requestId, target: 'different-target',
    }, { readActivity }, db.sql)).rejects.toThrow('does not match the saved recovery request and target');
    expect(readActivity).not.toHaveBeenCalled();
  });

  it('records an unreadable activity read as a failed measurement, not a negative pickup', async () => {
    await requestAdmissionRecovery(input, { authorize }, db.sql);
    await runAdmissionRecoveries(scope, deps(), db.sql);
    const readPickupActivity = vi.fn(async () => { throw new Error('activity store unavailable'); });

    await runAdmissionRecoveries(scope, deps({ readPickupActivity }), db.sql);

    expect(readPickupActivity).toHaveBeenCalledTimes(1);
    expect((await current()).payload._admissionRecovery).toMatchObject({
      state: 'delivered', stage: 'await-pickup', pickupConfirmed: false,
      pickupObservation: {
        verdict: 'unreadable', activityAt: null,
        reason: expect.stringContaining('measurement failed'),
      },
    });
  });

  it('keeps a duplicate not-yet receipt idempotent without changing its observation time', async () => {
    const first = await requestAdmissionRecovery(input, { authorize }, db.sql);
    await runAdmissionRecoveries(scope, deps(), db.sql);
    const delivered = (await current()).payload._admissionRecovery;
    const nowMs = Date.parse(delivered.deliveredAt) + 1_000;
    const args = { ...scope, requestId: first.request.requestId, target: input.target };

    const original = await observeAdmissionRecoveryPickup(args, { }, db.sql);
    const afterOriginal = (await current()).payload._admissionRecovery;
    const duplicate = await observeAdmissionRecoveryPickup({ ...args, nowMs: nowMs + 1_000 }, {}, db.sql);
    const afterDuplicate = (await current()).payload._admissionRecovery;

    expect(original).toMatchObject({ verdict: 'not-yet', requestId: first.request.requestId });
    expect(duplicate).toEqual(original);
    expect(afterDuplicate.pickupObservation).toEqual(afterOriginal.pickupObservation);
    expect(afterDuplicate.updatedAt).toBe(afterOriginal.updatedAt);
  });
});

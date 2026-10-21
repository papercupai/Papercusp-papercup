/**
 * P-018 (D-027 §3–§5, D-029 §5/§6): identity reaction planning, the receipt state
 * machine, the wearer-principal context and the emit-side enqueue.
 *
 * The receipt table and the subscription cancel run against an in-memory fake of
 * the four statements this module issues, so every assertion is about the state
 * the reaction leaves behind, not about which SQL string was sent. The real
 * PG + DBOS behaviour (SIGKILL recovery included) is the integration suite's job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/agent-mcp', async (orig) => ({
  ...(await orig<typeof import('@papercusp/agent-mcp')>()),
  dispatchProjectedTool: vi.fn(),
  lookupByMcpName: vi.fn(() => undefined),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: vi.fn(),
}));

import {
  identityRuleSubscriberId,
  IDENTITY_RULE_SUBSCRIPTION_KIND,
  type IdentityWearer,
} from '../agent-identities/identity-async-rules';
import { SU_WEARER_ROLE } from '../agent-identities/wearer-authority';
import type { AsyncRuleDeclaration } from '../cupboard/rule-store';
import type { LatchedEventSubscriber } from './await/store';
import {
  buildWearerReactionCtx,
  enqueueIdentityReactions,
  executeIdentityReaction,
  identityOperationRequestKey,
  IDENTITY_REACTION_SPAWN_ID,
  planIdentityReactions,
  UNRESOLVED_IDENTITY_FIRE,
  type IdentityDispatchInput,
  type IdentityReactionDeps,
  type IdentityReactionPayload,
} from './identity-reaction';

/* ------------------------------------------------------------------ */
/* An in-memory receipt table + subscription cancels.                   */
/* ------------------------------------------------------------------ */

interface Receipt {
  status: string;
  error: string | null;
  fire: string;
  contributor: string | null;
  ruleId: string;
  triggerTool: string;
  rootRunId: string;
}

function fakeDb() {
  const receipts = new Map<string, Receipt>();
  const cancels: Array<{ workspaceId: unknown; kind: unknown; ownerId: unknown; subscriberId: unknown; eventKey: unknown }> = [];
  const sql = (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join('?');
    const rows = (list: unknown[], count = list.length) => Object.assign(list, { count });
    if (text.includes('WITH ins AS')) {
      const [id, , ruleId, fire, triggerTool, rootRunId] = v as string[];
      if (!receipts.has(id)) {
        receipts.set(id, { status: 'authorizing', error: null, fire, contributor: null, ruleId, triggerTool, rootRunId });
      }
      return Promise.resolve(rows([{ status: receipts.get(id)!.status }]));
    }
    if (text.includes('UPDATE harness_shared.event_reactions')) {
      const [status, error, fire, contributor, id] = v as Array<string | null>;
      const row = receipts.get(id!);
      if (!row || row.status !== 'authorizing') return Promise.resolve(rows([]));
      Object.assign(row, { status, error, fire: fire ?? row.fire, contributor: contributor ?? row.contributor });
      return Promise.resolve(rows([{ dedup_id: id }]));
    }
    if (text.includes('INSERT INTO harness_shared.event_reactions')) {
      const [id, , ruleId, fire, triggerTool, rootRunId, error] = v as string[];
      if (!receipts.has(id)) {
        receipts.set(id, { status: 'refused', error, fire, contributor: null, ruleId, triggerTool, rootRunId });
      }
      return Promise.resolve(rows([]));
    }
    if (text.includes('UPDATE harness_shared.coord_entity_subscriptions')) {
      const [workspaceId, kind, ownerId, subscriberId, eventKey] = v;
      cancels.push({ workspaceId, kind, ownerId, subscriberId, eventKey });
      return Promise.resolve(rows([], 1));
    }
    throw new Error(`fakeDb: unexpected statement: ${text}`);
  };
  return { sql: sql as unknown as IdentityReactionDeps['sql'], receipts, cancels };
}

/* ------------------------------------------------------------------ */
/* Fixtures.                                                            */
/* ------------------------------------------------------------------ */

const WS = 'ws-1';
const OWNER = 'su-wearer-1';
const TAG = 'a'.repeat(16);
const EVENT = 'demo.fired';
const FIRE_ID = `${EVENT}@1790000000000000#1`;
const PIN = 'file-task';
const TARGET = { classId: 'demo.tasks', classVersion: '1.2.0', classRef: 'demo.tasks@1.2.0', verb: 'create' };

const RULE: AsyncRuleDeclaration = {
  id: PIN, title: 'File a task', description: 'files a task', version: '1.0.0',
  delivery: 'async', on: EVENT, fire: 'class:demo.tasks@1.2.0#create', args: { title: 'from rule' },
};

function wearer(over: Partial<IdentityWearer> & {
  rule?: AsyncRuleDeclaration; pinRef?: string; declaredClassNeeds?: string[] | null;
} = {}): IdentityWearer {
  const { rule = RULE, pinRef = PIN, declaredClassNeeds = null, ...rest } = over;
  return {
    ownerId: OWNER, workspaceId: WS, role: SU_WEARER_ROLE, harnessSlug: 'papercusp', revisionTag: TAG,
    rules: {
      applied: { specificationRevision: TAG.padEnd(64, '0'), stateRevision: 's1' },
      packagePins: [],
      pins: { rules: [{ identityId: 'ops-identity', pinRef, rule }], unreadable: [] },
      sync: { rules: [], unreadable: [] },
      declaredClassNeeds,
      recall: null,
    },
    ...rest,
  };
}

function subscriberRow(ownerId = OWNER, tag = TAG, pinRef = PIN): LatchedEventSubscriber {
  return {
    subscriber_id: identityRuleSubscriberId(ownerId, tag, pinRef),
    delivery_mode: 'muted',
    derived_from_kind: IDENTITY_RULE_SUBSCRIPTION_KIND,
    derived_from_ref: ownerId,
  };
}

function payloadFor(ownerId = OWNER, eventPayload: unknown = { kind: 'bug' }): IdentityReactionPayload {
  const { payloads } = planIdentityReactions({
    workspaceId: WS, eventKey: EVENT, fireId: FIRE_ID, payload: eventPayload, rows: [subscriberRow(ownerId)],
  });
  return payloads[0]!;
}

function deps(db: ReturnType<typeof fakeDb>, over: Partial<IdentityReactionDeps> = {}) {
  const dispatch = vi.fn(async (_input: IdentityDispatchInput) => ({ ok: true }) as { ok: boolean; error?: string });
  const all: IdentityReactionDeps = {
    sql: db.sql,
    readWearer: vi.fn(async (ownerId: string) => wearer({ ownerId })),
    resolvePot: vi.fn(async () => 'pot-a'),
    validateFire: vi.fn(async () => ({ ok: true as const, target: TARGET, capability: 'tasks:create' })),
    resolveFire: vi.fn(async () => ({
      status: 'resolved' as const, target: TARGET, tool: 'tasks:create', providerPackage: 'demo-tasks', providerVersion: '1.2.0',
      providerKind: 'tool' as const,
    })),
    readCeiling: vi.fn(async () => ({ potSlug: 'pot-a', ceilings: [], protectedAdditions: [] })),
    isRegisteredTool: vi.fn(() => true),
    readOperationSubmit: vi.fn(async () => ({ tool: 'blueprint:submit', capabilities: ['work_items:write'] })),
    dispatch,
    ...over,
  };
  return { all, dispatch: (over.dispatch as typeof dispatch | undefined) ?? dispatch };
}

/** A pot binding that resolves the verb to a blueprint operation (D-030). */
function operationFire(over: { operationHarnessSlug?: string | undefined } = { operationHarnessSlug: 'ops-harness' }) {
  return vi.fn(async () => ({
    status: 'resolved' as const, target: TARGET, tool: 'file-task', providerPackage: 'blueprint:ops-harness',
    providerVersion: '1.0.0', providerKind: 'operation' as const,
    ...('operationHarnessSlug' in over && over.operationHarnessSlug ? { operationHarnessSlug: over.operationHarnessSlug } : {}),
  }));
}

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  db = fakeDb();
  h.sql = db.sql;
});

/* ------------------------------------------------------------------ */


describe('locally authored rule authority (D-006)', () => {
  const address = { id: PIN, potSlug: 'pot-a', revision: 1, trigger: { tool: EVENT, args: {}, result: { ok: true } },
    cause: { depth: 2, chain: ['parent', 'local'], ruleId: 'local', rootRunId: 'root' } };
  const row = () => ({ workspaceId: WS, potSlug: 'pot-a', id: PIN, authorId: OWNER, definition: RULE,
    revision: 1, testedRevision: 1, testReceipt: { passed: true, samples: 1 }, enabled: true });
  const localPayload = () => ({ ...payloadFor(), localRule: address });
  it('dispatches through the live wearer, preserves the cause chain and dedupes a replay', async () => {
    const { all, dispatch } = deps(db, { readLocalRule: vi.fn(async () => row()), readWearer: vi.fn(async () => wearer({ revisionTag: 'new-live-identity' })) });
    expect(await executeIdentityReaction(localPayload(), all)).toMatchObject({ status: 'fired' });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, capabilities: ['tasks:create'], cause: address.cause }));
    expect(await executeIdentityReaction(localPayload(), all)).toMatchObject({ status: 'replayed' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it.each(['disabled', 'edited', 'untested', 'foreign-author', 'deleted'] as const)('refuses %s rows without dispatch', async (change) => {
    const altered = row();
    if (change === 'disabled') altered.enabled = false;
    if (change === 'edited') altered.revision = 2;
    if (change === 'untested') altered.testedRevision = 0;
    if (change === 'foreign-author') altered.authorId = 'another';
    const { all, dispatch } = deps(db, { readLocalRule: vi.fn(async () => change === 'deleted' ? null : altered) });
    expect(await executeIdentityReaction(localPayload(), all)).toMatchObject({ status: 'refused', code: 'rule-changed' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('refuses a detached author and a different pot without a synthetic fallback', async () => {
    const detached = deps(db, { readWearer: vi.fn(async () => null), readLocalRule: vi.fn(async () => row()) });
    expect(await executeIdentityReaction(localPayload(), detached.all)).toMatchObject({ status: 'refused', code: 'detached' });
    expect(detached.dispatch).not.toHaveBeenCalled();
    db = fakeDb(); h.sql = db.sql;
    const other = deps(db, { readLocalRule: vi.fn(async () => row()), resolvePot: vi.fn(async () => 'elsewhere') });
    expect(await executeIdentityReaction(localPayload(), other.all)).toMatchObject({ status: 'refused', code: 'unbound' });
    expect(other.dispatch).not.toHaveBeenCalled();
  });
  it('rechecks current ceilings and the local condition before authorizing', async () => {
    const denied = deps(db, { readLocalRule: vi.fn(async () => row()), readCeiling: vi.fn(async () => ({ potSlug: 'pot-a', ceilings: [{ denyCapabilities: ['tasks:*'] }], protectedAdditions: [] })) });
    expect(await executeIdentityReaction(localPayload(), denied.all)).toMatchObject({ status: 'refused', code: 'capability-empty' });
    expect(denied.dispatch).not.toHaveBeenCalled();
    db = fakeDb(); h.sql = db.sql;
    const missed = deps(db, { readLocalRule: vi.fn(async () => ({ ...row(), definition: { ...RULE, when: { 'args.kind': { equals: 'bug' } } } })) });
    expect(await executeIdentityReaction(localPayload(), missed.all)).toMatchObject({ status: 'refused', code: 'when-false' });
    expect(missed.dispatch).not.toHaveBeenCalled();
  });
});

describe('planIdentityReactions', () => {
  it('keeps identity-rule rows only and gives two wearers two receipts', () => {
    const other = subscriberRow('su-wearer-2');
    const { payloads, unparseable } = planIdentityReactions({
      workspaceId: WS, eventKey: EVENT, fireId: FIRE_ID, payload: { kind: 'bug' },
      rows: [
        subscriberRow(),
        other,
        { subscriber_id: 'loop:someone', delivery_mode: 'live', derived_from_kind: null, derived_from_ref: null },
        { subscriber_id: 'other-kind:x', delivery_mode: 'muted', derived_from_kind: 'plan-follow', derived_from_ref: OWNER },
      ],
    });
    expect(unparseable).toEqual([]);
    expect(payloads.map((p) => p.ownerId)).toEqual([OWNER, 'su-wearer-2']);
    expect(new Set(payloads.map((p) => p.receiptId)).size).toBe(2);
    expect(payloads[0]).toMatchObject({
      workspaceId: WS, revisionTag: TAG, pinRef: PIN, eventKey: EVENT, fireId: FIRE_ID, eventPayload: { kind: 'bug' },
    });
  });

  it('gives a replay of the same fire the same receipt, and a different fire a different one', () => {
    expect(payloadFor().receiptId).toBe(payloadFor().receiptId);
    const refire = planIdentityReactions({
      workspaceId: WS, eventKey: EVENT, fireId: `${EVENT}@1790000000000000#2`, payload: null, rows: [subscriberRow()],
    }).payloads[0]!;
    expect(refire.receiptId).not.toBe(payloadFor().receiptId);
  });

  it('reports an identity row whose subscriber id does not parse against its own owner', () => {
    const row = { ...subscriberRow(), derived_from_ref: 'someone-else' };
    const { payloads, unparseable } = planIdentityReactions({
      workspaceId: WS, eventKey: EVENT, fireId: FIRE_ID, payload: null, rows: [row],
    });
    expect(payloads).toEqual([]);
    expect(unparseable).toEqual([row.subscriber_id]);
  });
});

describe('buildWearerReactionCtx', () => {
  const ctx = buildWearerReactionCtx({
    workspaceId: WS, ownerId: OWNER, role: 'su', harnessSlug: 'papercusp', capabilities: ['tasks:create'],
    cause: { depth: 1, chain: [PIN], ruleId: PIN, rootRunId: FIRE_ID },
  });

  it('dispatches as the wearer: principal, ui client and grant subject are all the ownerId', () => {
    expect(ctx.principal?.slug).toBe(OWNER);
    expect(ctx.uiClientId).toBe(OWNER);
    expect(ctx.principal?.workspaceId).toBe(WS);
    expect(ctx.role).toBe('su');
    expect(ctx.spawnId).toBe(IDENTITY_REACTION_SPAWN_ID);
  });

  it('carries NO gate bypass and no superuser, and holds the dispatch to the allowlist', () => {
    expect(ctx).not.toHaveProperty('gateBypass');
    expect(ctx.isSuperuser).toBe(false);
    expect([...(ctx.principal?.capabilities ?? [])]).toEqual(['tasks:create']);
    expect(ctx.reactionCause).toEqual({ depth: 1, chain: [PIN], ruleId: PIN, rootRunId: FIRE_ID });
  });

  it('charges quota to the wearer: one quota subject across reactions, a fresh runId each (D-032)', () => {
    const again = buildWearerReactionCtx({
      workspaceId: WS, ownerId: OWNER, role: 'su', harnessSlug: 'papercusp', capabilities: ['tasks:create'],
      cause: { depth: 1, chain: [PIN], ruleId: PIN, rootRunId: FIRE_ID },
    });
    expect(ctx.quotaSubject).toBe(`wearer:${OWNER}`);
    expect(again.quotaSubject).toBe(ctx.quotaSubject);
    expect(again.runId).not.toBe(ctx.runId);
  });
});

describe('executeIdentityReaction', () => {
  it('authorizes from live state and dispatches the class verb as the wearer, then records fired', async () => {
    const payload = payloadFor();
    const { all, dispatch } = deps(db);
    await expect(executeIdentityReaction(payload, all)).resolves.toEqual({ status: 'fired', tool: 'tasks:create' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0]).toEqual({
      workspaceId: WS, ownerId: OWNER, role: 'su', harnessSlug: 'papercusp', tool: 'tasks:create',
      args: { title: 'from rule' }, capabilities: ['tasks:create'],
      cause: { depth: 1, chain: [PIN], ruleId: PIN, rootRunId: FIRE_ID },
    });
    expect(db.receipts.get(payload.receiptId)).toMatchObject({
      status: 'fired', error: null, fire: RULE.fire, contributor: 'identity:ops-identity',
      ruleId: PIN, triggerTool: `event:${EVENT}`, rootRunId: FIRE_ID,
    });
  });

  it('does not dispatch again on a replay of a settled receipt', async () => {
    const payload = payloadFor();
    const { all, dispatch } = deps(db);
    await executeIdentityReaction(payload, all);
    await expect(executeIdentityReaction(payload, all)).resolves.toEqual({ status: 'replayed', prior: 'fired' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('two wearers of one fire each get their own authorized effect', async () => {
    const { all, dispatch } = deps(db);
    await executeIdentityReaction(payloadFor(OWNER), all);
    await executeIdentityReaction(payloadFor('su-wearer-2'), all);
    expect(dispatch.mock.calls.map(([input]) => input.ownerId)).toEqual([OWNER, 'su-wearer-2']);
    expect([...db.receipts.values()].map((r) => r.status)).toEqual(['fired', 'fired']);
  });

  it('re-authorizes a receipt left authorizing by a crash, against the state as it is NOW', async () => {
    const payload = payloadFor();
    // A prior attempt authorized and died before dispatch: the receipt is still authorizing.
    db.receipts.set(payload.receiptId, {
      status: 'authorizing', error: null, fire: UNRESOLVED_IDENTITY_FIRE, contributor: null,
      ruleId: PIN, triggerTool: `event:${EVENT}`, rootRunId: FIRE_ID,
    });
    // ...and the wearer detached in between. Nothing decided before the crash is trusted.
    const { all, dispatch } = deps(db, { readWearer: vi.fn(async () => null) });
    await expect(executeIdentityReaction(payload, all)).resolves.toMatchObject({ status: 'refused', code: 'detached' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.receipts.get(payload.receiptId)?.status).toBe('refused');
  });

  it('records a dispatcher refusal or error as failed, never as fired', async () => {
    const payload = payloadFor();
    const { all } = deps(db, { dispatch: vi.fn(async () => ({ ok: false, error: 'quota_exceeded: daily cap' })) });
    await expect(executeIdentityReaction(payload, all)).resolves.toEqual({
      status: 'failed', tool: 'tasks:create', error: 'quota_exceeded: daily cap',
    });
    expect(db.receipts.get(payload.receiptId)).toMatchObject({ status: 'failed', error: 'quota_exceeded: daily cap' });
  });

  describe('operation providers (D-030)', () => {
    it('submits the bound operation AS THE WEARER through blueprint:submit, held to class ∪ submit capabilities', async () => {
      const payload = payloadFor();
      const { all, dispatch } = deps(db, { resolveFire: operationFire() });
      await expect(executeIdentityReaction(payload, all)).resolves.toEqual({ status: 'fired', tool: 'blueprint:submit' });
      expect(dispatch.mock.calls[0]![0]).toEqual({
        workspaceId: WS, ownerId: OWNER, role: 'su', harnessSlug: 'papercusp', tool: 'blueprint:submit',
        args: {
          harness: 'ops-harness', operationId: 'file-task',
          requestKey: identityOperationRequestKey(payload.receiptId), input: { title: 'from rule' },
        },
        capabilities: ['tasks:create', 'work_items:write'],
        cause: { depth: 1, chain: [PIN], ruleId: PIN, rootRunId: FIRE_ID },
      });
      expect(db.receipts.get(payload.receiptId)).toMatchObject({ status: 'fired', contributor: 'identity:ops-identity' });
    });

    it('a recovered re-dispatch of the same receipt reuses the same request key; another wearer gets another', async () => {
      const payload = payloadFor();
      const { all, dispatch } = deps(db, { resolveFire: operationFire() });
      await executeIdentityReaction(payload, all);
      // The crash window: dispatch returned, the terminal UPDATE never ran.
      db.receipts.get(payload.receiptId)!.status = 'authorizing';
      await executeIdentityReaction(payload, all);
      await executeIdentityReaction(payloadFor('su-wearer-2'), all);
      const keys = dispatch.mock.calls.map(([input]) => (input.args as { requestKey: string }).requestKey);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it('never widens past the class capability: an allowlist miss on it refuses before any submit', async () => {
      const payload = payloadFor();
      const { all, dispatch } = deps(db, {
        resolveFire: operationFire(),
        readCeiling: vi.fn(async () => ({ potSlug: 'pot-a', ceilings: [{ allowCapabilities: ['work_items:*'] }], protectedAdditions: [] })),
      });
      await expect(executeIdentityReaction(payload, all)).resolves.toMatchObject({
        status: 'refused', code: 'capability-empty', reason: expect.stringContaining('tasks:create'),
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('keys stay within the blueprint request-key limit however long the receipt id is', () => {
      const key = identityOperationRequestKey(`identity-reaction:${'x'.repeat(500)}`);
      expect(key.length).toBeLessThanOrEqual(200);
      expect(key).toBe(identityOperationRequestKey(`identity-reaction:${'x'.repeat(500)}`));
    });
  });

  it('THROWS on a failed live lookup and leaves the receipt authorizing, with nothing dispatched', async () => {
    const payload = payloadFor();
    const { all, dispatch } = deps(db, { readWearer: vi.fn(async () => { throw new Error('connection reset'); }) });
    await expect(executeIdentityReaction(payload, all)).rejects.toThrow('connection reset');
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.receipts.get(payload.receiptId)?.status).toBe('authorizing');
  });

  describe('refusals: recorded, terminal, zero dispatch', () => {
    const cases: Array<[string, string, (d: ReturnType<typeof fakeDb>) => Partial<IdentityReactionDeps>, boolean?]> = [
      ['detached', 'the owner wears no identity now', () => ({ readWearer: vi.fn(async () => null) }), true],
      ['attachment-changed', 'the owner wears a different revision', () => ({
        readWearer: vi.fn(async () => wearer({ revisionTag: 'b'.repeat(16) })),
      }), true],
      ['rule-changed', 'the revision no longer wears the rule', () => ({
        readWearer: vi.fn(async () => wearer({ pinRef: 'another-rule' })),
      })],
      ['rule-changed', 'the worn rule listens on another key', () => ({
        readWearer: vi.fn(async () => wearer({ rule: { ...RULE, on: 'demo.other' } })),
      })],
      ['when-false', 'the condition does not hold for this fire', () => ({
        readWearer: vi.fn(async () => wearer({ rule: { ...RULE, when: { 'payload.kind': 'feature' } } })),
      })],
      ['unbound', 'the wearer is scoped to no harness', () => ({
        readWearer: vi.fn(async () => wearer({ harnessSlug: null })),
      })],
      ['unbound', 'the harness resolves to no pot', () => ({ resolvePot: vi.fn(async () => null) })],
      ['unbound', 'the pot binds no provider for the verb', () => ({
        resolveFire: vi.fn(async () => ({ status: 'unbound' as const, target: TARGET, error: 'no provider' })),
      })],
      ['unbound', 'the bound tool is not registered', () => ({ isRegisteredTool: vi.fn(() => false) })],
      ['class-invalid', 'the class verb no longer validates', () => ({
        validateFire: vi.fn(async () => ({ ok: false as const, error: 'class demo.tasks@1.2.0 has no verb create' })),
      })],
      ['class-invalid', 'the fire no longer resolves', () => ({
        resolveFire: vi.fn(async () => ({ status: 'invalid' as const, error: 'bad fire' })),
      })],
      ['capability-empty', 'the identity declares no need for the class', () => ({
        readWearer: vi.fn(async () => wearer({ declaredClassNeeds: ['other.class@1'] })),
      })],
      ['capability-empty', 'the capability is in the protected floor', () => ({
        validateFire: vi.fn(async () => ({ ok: true as const, target: TARGET, capability: 'secrets:read' })),
        readCeiling: vi.fn(async () => ({ potSlug: 'pot-a', ceilings: [], protectedAdditions: ['secrets:*'] })),
      })],
      ['capability-empty', 'the pot/role ceiling denies the capability', () => ({
        readCeiling: vi.fn(async () => ({ potSlug: 'pot-a', ceilings: [{ denyCapabilities: ['tasks:*'] }], protectedAdditions: [] })),
      })],
      ['unbound', 'an operation provider pins no harness', () => ({ resolveFire: operationFire({ operationHarnessSlug: undefined }) })],
      ['unbound', 'no operation submit tool is registered', () => ({
        resolveFire: operationFire(), readOperationSubmit: vi.fn(async () => null),
      })],
      ['unbound', 'the provider is a recipe, which a reaction does not dispatch', () => ({
        resolveFire: vi.fn(async () => ({
          status: 'resolved' as const, target: TARGET, tool: 'recipe-x', providerPackage: 'p', providerVersion: '1',
          providerKind: 'recipe' as const,
        })),
      })],
      ['capability-empty', 'the ceiling denies the operation submit capability', () => ({
        resolveFire: operationFire(),
        readCeiling: vi.fn(async () => ({ potSlug: 'pot-a', ceilings: [{ denyCapabilities: ['work_items:*'] }], protectedAdditions: [] })),
      })],
      ['capability-empty', 'the ceiling allows the class capability but not the submit capability', () => ({
        resolveFire: operationFire(),
        readCeiling: vi.fn(async () => ({ potSlug: 'pot-a', ceilings: [{ allowCapabilities: ['tasks:*'] }], protectedAdditions: [] })),
      })],
    ];

    it.each(cases)('%s when %s', async (code, _why, override, cancelsRow) => {
      const payload = payloadFor();
      const { all, dispatch } = deps(db, override(db));
      const outcome = await executeIdentityReaction(payload, all);
      expect(outcome).toMatchObject({ status: 'refused', code });
      expect(dispatch).not.toHaveBeenCalled();
      const receipt = db.receipts.get(payload.receiptId)!;
      expect(receipt.status).toBe('refused');
      expect(receipt.error).toMatch(new RegExp(`^${code}: `));
      // A stale subscription row is cancelled exactly, and only for an attachment miss.
      if (cancelsRow) {
        expect(db.cancels).toEqual([{
          workspaceId: WS, kind: IDENTITY_RULE_SUBSCRIPTION_KIND, ownerId: OWNER,
          subscriberId: payload.subscriberId, eventKey: EVENT,
        }]);
      } else {
        expect(db.cancels).toEqual([]);
      }
      // A replay of a refused reaction stays refused and still dispatches nothing.
      await expect(executeIdentityReaction(payload, deps(db).all)).resolves.toEqual({ status: 'replayed', prior: 'refused' });
    });

    it('names an unreadable pin rather than guessing at it', async () => {
      const payload = payloadFor();
      const w = wearer();
      const unreadable = { ...w, rules: { ...w.rules, pins: { rules: [], unreadable: [{ identityId: 'ops-identity', pinRef: PIN, error: 'on: Required' }] } } };
      const { all } = deps(db, { readWearer: vi.fn(async () => unreadable) });
      await expect(executeIdentityReaction(payload, all)).resolves.toMatchObject({
        status: 'refused', code: 'rule-changed', reason: expect.stringContaining('on: Required'),
      });
    });
  });
});

describe('enqueueIdentityReactions', () => {
  const input = (rows: LatchedEventSubscriber[]) => ({ workspaceId: WS, eventKey: EVENT, fireId: FIRE_ID, payload: { kind: 'bug' }, rows });

  it('enqueues one durable reaction per identity row, keyed by its receipt', async () => {
    const enqueue = vi.fn(async (_p: IdentityReactionPayload) => 'enqueued' as const);
    const result = await enqueueIdentityReactions(input([subscriberRow(), subscriberRow('su-wearer-2')]), { enqueue, sql: db.sql });
    expect(result).toEqual({ enqueued: 2, refused: 0, uncertain: 0, unparseable: 0 });
    expect(enqueue.mock.calls.map(([p]) => p.receiptId)).toEqual([payloadFor().receiptId, payloadFor('su-wearer-2').receiptId]);
    expect(db.receipts.size).toBe(0);
  });

  it('records a durable-unavailable refusal when no durable path exists — never an in-process fire', async () => {
    const enqueue = vi.fn(async () => 'unavailable' as const);
    const result = await enqueueIdentityReactions(input([subscriberRow()]), { enqueue, sql: db.sql, log: () => {} });
    expect(result).toEqual({ enqueued: 0, refused: 1, uncertain: 0, unparseable: 0 });
    expect(db.receipts.get(payloadFor().receiptId)).toMatchObject({
      status: 'refused', error: expect.stringMatching(/^durable-unavailable: /), fire: UNRESOLVED_IDENTITY_FIRE,
    });
  });

  it('records NO refusal for an enqueue whose outcome is unknown (it may have committed)', async () => {
    const log = vi.fn();
    const enqueue = vi.fn(async () => { throw new Error('socket hang up'); });
    const result = await enqueueIdentityReactions(input([subscriberRow()]), { enqueue, sql: db.sql, log });
    expect(result).toEqual({ enqueued: 0, refused: 0, uncertain: 1, unparseable: 0 });
    expect(db.receipts.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
  });

  it('never throws, even when recording the refusal fails', async () => {
    const failing = (() => Promise.reject(new Error('pg down'))) as unknown as IdentityReactionDeps['sql'];
    const log = vi.fn();
    await expect(enqueueIdentityReactions(input([subscriberRow()]), {
      enqueue: async () => 'unavailable', sql: failing, log,
    })).resolves.toEqual({ enqueued: 0, refused: 0, uncertain: 0, unparseable: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pg down'));
  });

  it('skips and counts an unparseable identity row', async () => {
    const enqueue = vi.fn(async () => 'enqueued' as const);
    const result = await enqueueIdentityReactions(
      input([{ ...subscriberRow(), subscriber_id: 'identity-rule:garbage' }]), { enqueue, sql: db.sql, log: () => {} });
    expect(result).toEqual({ enqueued: 0, refused: 0, uncertain: 0, unparseable: 1 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

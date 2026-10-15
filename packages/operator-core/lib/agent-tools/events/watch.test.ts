/**
 * watch.test.ts — the unified `watch` primitive's routing (unify-watch-primitive P-007).
 * Deps mocked; asserts wake:false → inject/subscribe path, wake:true → the await registration
 * with the right cardinality + floor defaults.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator'],
  lookupByMcpName: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-watcher', ownerLabel: 'w', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' })),
}));
// WI-10005697: the await store is faked as a tiny IN-MEMORY ROW STORE rather than a pair
// of canned answers, so "register the identical standing watch twice" is a real
// idempotency assertion driven end-to-end through the handler. The fake lives in the
// vi.mock factory on purpose — installing it per-test via mockImplementation would need an
// `as never` cast, which raises the shrink-only lint:mock-cast-escape ratchet.
const fakeStore = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = [];
  return { rows, reset: () => void (rows.length = 0) };
});
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => {
    const row = {
      id: fakeStore.rows.length + 1,
      eventKey: i.eventKey,
      once: i.once,
      minSleepSec: i.minSleepSec ?? null,
      urgency: i.urgency ?? false,
      expiresTs: null,
      timeoutBehavior: i.timeoutBehavior,
      payloadFilter: i.payloadFilter ?? null,
    };
    fakeStore.rows.push(row);
    return row;
  }),
  cancelAwait: vi.fn(async () => true),
  // Identity mirrors the finder's SQL: event key + canonical payload filter + wake floor
  // + urgency, over standing deadline-free rows.
  findMatchingActiveStandingWatch: vi.fn(
    async (q: Record<string, unknown>) =>
      fakeStore.rows.find(
        (r) =>
          r.once === false &&
          r.eventKey === q.eventKey &&
          JSON.stringify(r.payloadFilter ?? null) === JSON.stringify(q.payloadFilter ?? null) &&
          (r.minSleepSec ?? null) === (q.minSleepSec ?? null) &&
          (r.urgency ?? false) === (q.urgency ?? false),
      ) ?? null,
  ),
}));
vi.mock('../../events/await/engine', () => ({
  startAwaitSweeper: vi.fn(),
  deliverToSpecificAwaits: vi.fn(async (i: { awaitRows: Array<{ id: number }> }) => ({ delivered: i.awaitRows.length })),
}));
vi.mock('./producer-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./producer-health')>()),
  resolveProducerHealthCertificate: vi.fn(async () => ({
    version: 1,
    producer: { kind: 'green-checkpoint', id: 'run-1' },
    owner: { ownerId: 'su-watcher', workItemId: null },
    issuedAtMs: 1,
    lastProgressAtMs: 1,
    lastFireAtMs: null,
    expectedCadenceMs: 120_000,
    verificationDeadlineMs: 120_001,
    details: { pipeline: 'papercusp' },
  })),
  resolveProgressLeaseCertificate: vi.fn(async () => ({
    version: 1,
    producer: { kind: 'delegated-progress', id: 'lease-1' },
    owner: { ownerId: 'su-worker', workItemId: 'WI-1' },
    issuedAtMs: 1, lastProgressAtMs: 1, lastFireAtMs: null,
    expectedCadenceMs: 60_000, verificationDeadlineMs: 60_001,
    progressLease: { leaseId: 'lease-1' },
  })),
}));
// P-008: the predicate engine is its own tested module (predicate-watch.test.ts /
// .integration.test.ts) — here only the tool's ROUTING into it is under test.
vi.mock('../../events/await/predicate-watch', () => ({
  PREDICATE_OPS: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'],
  registerPredicateWatch: vi.fn(async (i: Record<string, unknown>) => ({ ...i, intervalSec: i.intervalSec ?? 60, lastEval: null, active: true })),
  startPredicateWatchPoller: vi.fn(),
  evalPredicateWatch: vi.fn(async () => ({ fired: false, matched: false, deactivated: false })),
  resolvePredicateToolEffect: (projected: { effect?: unknown; effectForCall?: (args: unknown) => unknown }, args: unknown) => {
    if (projected.effectForCall) {
      try {
        const effect = projected.effectForCall(args);
        return effect === 'read' || effect === 'write' ? effect : 'unknown';
      } catch {
        return 'unknown';
      }
    }
    return projected.effect === 'read' || projected.effect === 'write' ? projected.effect : 'unknown';
  },
  // P-004 dedup: default no match — the individual dedup tests below override this.
  findMatchingActivePredicateWatch: vi.fn(async () => null),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-x' }));
vi.mock('../coordination/topics', () => ({ subscribeTopic: vi.fn(async (_id: unknown, slug: string, opts: Record<string, unknown>) => ({ target_ref: slug, delivery_mode: opts.mode ?? 'full', expires_ts: null })) }));
// WI-4014 Part 2: the targetKind:'event' sibling of subscribeTopic above.
vi.mock('../coordination/event-subscriptions', () => ({ subscribeEventKey: vi.fn(async (_id: unknown, key: string, opts: Record<string, unknown>) => ({ target_ref: key, delivery_mode: opts.mode ?? 'full', expires_ts: null })) }));

import watch from './watch';
import { lookupByMcpName, toArgsJsonSchema } from '@papercusp/agent-mcp';
import { registerAwait, cancelAwait, findMatchingActiveStandingWatch } from '../../events/await/store';
import { deliverToSpecificAwaits } from '../../events/await/engine';
import { registerPredicateWatch, evalPredicateWatch, findMatchingActivePredicateWatch } from '../../events/await/predicate-watch';
import { subscribeTopic } from '../coordination/topics';
import { subscribeEventKey } from '../coordination/event-subscriptions';
import { resolveProducerHealthCertificate, resolveProgressLeaseCertificate } from './producer-health';
import { compileJsonSchema } from '../../json-schema-validation';

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof watch.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await watch.handler(args as never, ctx)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

// WI-10005697: the in-memory fake await store (vi.mock factory above) persists across
// tests, and its row ids are observable in assertions, so it resets with the mocks.
beforeEach(() => {
  vi.clearAllMocks();
  fakeStore.reset();
});

describe('watch routing', () => {
  it('wake:false (default) → inject path: a standing topic subscription, no await', async () => {
    const out = await call({ pattern: 'locks', mode: 'digest', timeout_sec: 99 });
    expect(subscribeTopic).toHaveBeenCalledWith(expect.anything(), 'locks', { mode: 'digest', ttl_sec: 99 });
    expect(registerAwait).not.toHaveBeenCalled();
    expect(out.watch).toMatchObject({ wake: false, once: false, mode: 'digest' });
  });

  it('wake:true (default once) → a one-shot wake grant, no floor', async () => {
    const out = await call({ pattern: 'lock:grant:t1', wake: true });
    expect(subscribeTopic).not.toHaveBeenCalled();
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ eventKey: 'lock:grant:t1', policy: 'wake', once: true, minSleepSec: 0 });
    expect(out.watch).toMatchObject({ wake: true, once: true, min_sleep_sec: 0 });
  });

  it('wake:true once:false → a STANDING wake watch defaulting to the floor', async () => {
    await call({ pattern: 'feature:settled', wake: true, once: false });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ once: false, minSleepSec: 60 }); // standing floor default
    expect(arg.timeoutSec).toBeNull(); // standing watches have no default deadline
  });

  it('min_sleep_sec + urgency are honored on a standing wake watch', async () => {
    await call({ pattern: 'hot:key', wake: true, once: false, min_sleep_sec: 120, urgency: true });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ minSleepSec: 120, urgency: true });
  });

  it('EI-8998: payload_filter on a wake watch is threaded through to registerAwait', async () => {
    const filter = { queue_depth: { lt: 5 } };
    const out = await call({ pattern: 'queue:depth-changed', wake: true, payload_filter: filter });
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({ payloadFilter: filter });
    expect(out.watch).toMatchObject({ payload_filter: filter });
  });

  it('EI-8998: payload_filter on an inject (wake:false) watch is rejected loudly, not silently ignored', async () => {
    await expect(call({ pattern: 'locks', payload_filter: { x: 1 } })).rejects.toThrow(/payload_filter/);
    expect(subscribeTopic).not.toHaveBeenCalled();
  });

  it('EI-22459575798410641: targetKind on a wake:true watch is rejected loudly, not silently dropped', async () => {
    // The wake path never reads targetKind (it is resolved only inside the wake:false
    // inject branch), so before the guard these silently registered a plain wake grant
    // while the caller believed a standing event-key subscription had been created.
    await expect(call({ pattern: 'work-item:claimable', wake: true, targetKind: 'event' })).rejects.toThrow(/targetKind/);
    await expect(call({ pattern: 'some-topic', wake: true, targetKind: 'topic' })).rejects.toThrow(/targetKind/);
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('EI-22459575798410641: the targetKind refusal names both working forms so the caller is not left guessing', async () => {
    const err = await call({ pattern: 'work-item:claimable', wake: true, targetKind: 'event' }).catch((e: Error) => e);
    // The standing-and-re-invoking form is the one a deaf caller actually wants...
    expect((err as Error).message).toMatch(/wake:true, once:false/);
    // ...and the inject form is what targetKind was reaching for in the first place.
    expect((err as Error).message).toMatch(/wake:false, targetKind:"event"/);
  });

  // COVERAGE GAP, stated rather than papered over: targetKind:"interest" under wake:true must
  // stay legal (it returns from the interest branch above the new guard), but it cannot be
  // asserted here — the interest branch boots its sweeper against unmocked persistence, so the
  // call only reaches the DB and trips vitest-fail-on-console. Passing it would require a
  // console.error spy, and a test that needs error-suppression to go green masks the failures
  // it exists to catch. The property is held structurally instead: the guard sits AFTER the
  // isInterest early-return, so 'interest' is unreachable from it, and the schema-level tests
  // below still pin targetKind:"interest" + wake:true as valid input.

  it('verified one-shot wake attaches producer health and derives its first deadline from cadence', async () => {
    const producerHealth = { kind: 'green-checkpoint', pipeline: 'papercusp', expected_cadence_sec: 120 };
    await call({ pattern: 'release:green:papercusp', wake: true, producer_health: producerHealth });
    expect(resolveProducerHealthCertificate).toHaveBeenCalledWith({
      producerHealth,
      subscriberId: 'su-watcher',
      timeoutSec: undefined,
    });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      once: true,
      timeoutSec: 120,
      producerHealthCertificate: expect.objectContaining({ producer: { kind: 'green-checkpoint', id: 'run-1' } }),
    });
  });

  it('verified mode refuses inject, standing, predicate, and silent-expiry watches', async () => {
    const producer_health = { kind: 'green-checkpoint', pipeline: 'papercusp', expected_cadence_sec: 120 };
    await expect(call({ pattern: 'k', producer_health })).rejects.toThrow(/one-shot wake:true/);
    await expect(call({ pattern: 'k', wake: true, once: false, producer_health })).rejects.toThrow(/one-shot wake:true/);
    await expect(call({ pattern: 'k', wake: true, predicate: { tool: 'x', path: 'y', op: 'eq' }, producer_health })).rejects.toThrow(/one-shot wake:true/);
    await expect(call({ pattern: 'k', wake: true, on_timeout: 'expire', producer_health })).rejects.toThrow(/requires on_timeout/);
    expect(resolveProducerHealthCertificate).not.toHaveBeenCalled();
  });

  it('routes a delegated progress lease through the existing one-shot watch row', async () => {
    const progressLease = {
      source_kind: 'claim-transition', tool: 'work_items:get', args: { id: 'WI-1' }, path: 'results.0.workItem.state',
      units: 'state', expected_cadence_sec: 60, owner_id: 'su-worker',
      remedy: { kind: 'create-unblock-item', title: 'Unblock WI-1', harness: 'papercusp' },
    };
    await call({ pattern: 'work-item:done:WI-1', wake: true, progress_lease: progressLease });
    expect(resolveProgressLeaseCertificate).toHaveBeenCalledWith(expect.objectContaining({ progressLease, subscriberId: 'su-watcher' }));
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({ timeoutSec: 60 });
  });
});

describe('WI-4014 Part 2: targetKind routing (wake:false only)', () => {
  it('targetKind omitted defaults to "topic" (unchanged, backward compatible)', async () => {
    const out = await call({ pattern: 'locks' });
    expect(subscribeTopic).toHaveBeenCalledWith(expect.anything(), 'locks', { mode: undefined, ttl_sec: undefined });
    expect(subscribeEventKey).not.toHaveBeenCalled();
    expect(out.watch).toMatchObject({ targetKind: 'topic' });
  });

  it('targetKind:"event" routes to subscribeEventKey, NOT subscribeTopic', async () => {
    const out = await call({ pattern: 'lock:grant:t1', targetKind: 'event', mode: 'digest', timeout_sec: 42 });
    expect(subscribeEventKey).toHaveBeenCalledWith(expect.anything(), 'lock:grant:t1', { mode: 'digest', ttl_sec: 42 });
    expect(subscribeTopic).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
    expect(out.watch).toMatchObject({ pattern: 'lock:grant:t1', targetKind: 'event', wake: false, once: false, mode: 'digest' });
  });

  it('targetKind:"event" + once:true registers a one-shot notify await, not a standing subscription', async () => {
    const out = await call({
      pattern: 'conversation:answered:conv-1',
      targetKind: 'event',
      once: true,
      mode: 'digest',
      timeout_sec: 42,
      note: 'answer gate',
    });
    expect(subscribeEventKey).not.toHaveBeenCalled();
    expect(subscribeTopic).not.toHaveBeenCalled();
    expect(registerAwait).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: 'su-watcher',
        eventKey: 'conversation:answered:conv-1',
        policy: 'notify',
        note: 'answer gate',
        timeoutBehavior: 'expire',
        timeoutSec: 42,
        once: true,
      }),
    );
    expect(out.watch).toMatchObject({
      id: 1,
      pattern: 'conversation:answered:conv-1',
      targetKind: 'event',
      wake: false,
      once: true,
      mode: 'digest',
    });
  });

  // EI-22459575798410641 — this test previously PINNED the opposite behaviour ("targetKind
  // is ignored on a wake:true watch"), asserting that registerAwait was still called. That
  // pin was inverted deliberately, not incidentally: measured over 30 days, 11 of 39
  // watch:create calls (28%, across 18 agents) passed targetKind together with wake:true.
  // Every one silently received a ONE-SHOT wake grant in place of the standing event
  // subscription it asked for, and a one-shot that fires once and lapses is precisely the
  // mechanism of the fleet-member deafness tracked in EI-22445599755185355. Silently
  // honouring neither the arg nor the intent is worse than refusing, so the tool now fails
  // loud and names the working form. The routing fact this test really guarded — the wake
  // path must never reach the inject subscribers — is asserted below.
  it('targetKind on a wake:true watch is REFUSED (it was silently dropped; 28% of real calls hit this)', async () => {
    await expect(call({ pattern: 'feature:settled', targetKind: 'event', wake: true })).rejects.toThrow(/targetKind/);
    expect(subscribeEventKey).not.toHaveBeenCalled();
    expect(subscribeTopic).not.toHaveBeenCalled();
    // The refusal must be total: no await row is left behind for a call that was rejected.
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('a wake:true watch with NO targetKind still registers an await and never touches the inject subscribers', async () => {
    // The surviving half of the original pin: wake-path routing is unchanged for the
    // ordinary (targetKind-free) call, so the refusal above narrowed behaviour by exactly
    // the invalid combination and nothing more.
    await call({ pattern: 'feature:settled', wake: true });
    expect(subscribeEventKey).not.toHaveBeenCalled();
    expect(subscribeTopic).not.toHaveBeenCalled();
    expect(registerAwait).toHaveBeenCalled();
  });
});

describe('EI-25370968486651341: payload-filter validation before registration', () => {
  const validate = compileJsonSchema(toArgsJsonSchema('watch:create', watch.args as never));

  it.each([
    { all: [{ harness: 'papercusp' }, 'note', 'prose'] },
    { any: [false] },
    { all: [{ not: { some: { require: 1, of: [null] } } }] },
    { some: { require: 0, of: [{ kind: 'bug' }] } },
  ])('rejects malformed recursive filters in both the callable and published schemas: %j', (payload_filter) => {
    const args = { pattern: 'work-item:claimable', wake: true, once: false, payload_filter };
    expect(watch.args.safeParse(args).success).toBe(false);
    expect(validate(args)).toBe(false);
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('accepts and registers the scoped fleet filter without changing its contents', async () => {
    const payload_filter = {
      all: [
        { harness: { equals: 'papercusp' } },
        { any: [{ kind: { in: ['bug', 'change', 'task'] } }, { id: 'WI-1' }] },
        { not: { state: 'done' } },
      ],
    };
    const args = { pattern: 'work-item:claimable', wake: true, once: false, payload_filter };
    expect(watch.args.safeParse(args).success).toBe(true);
    expect(validate(args)).toBe(true);
    const out = await call(args);
    expect(out.watch.payload_filter).toEqual(payload_filter);
    expect(vi.mocked(registerAwait).mock.calls[0][0].payloadFilter).toEqual(payload_filter);
  });
});

describe('P-008 predicate watch routing', () => {
  const predicate = { tool: 'work_items:list', path: 'counts.open', op: 'gt', value: 5 };

  it('schema rejects targetKind:"interest" combined with a predicate before handler dispatch', () => {
    const parsed = watch.args.safeParse({ pattern: 'backlog', targetKind: 'interest', wake: true, predicate });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]).toMatchObject({ code: 'invalid_union' });
    }
  });

  it('publishes matcher alternatives so conflicting predicate fields are unrepresentable', () => {
    const published = toArgsJsonSchema('watch:create', watch.args as never) as {
      anyOf?: Array<{
        required?: string[];
        properties?: Record<string, { not?: unknown }>;
      }>;
      oneOf?: Array<{
        required?: string[];
        properties?: Record<string, { not?: unknown }>;
      }>;
    };
    const branches = published.anyOf ?? published.oneOf ?? [];
    const predicateBranch = branches.find((branch) => branch.required?.includes('predicate'));
    const nonPredicateBranches = branches.filter((branch) => !branch.required?.includes('predicate'));

    expect(branches).toHaveLength(2);
    expect(predicateBranch).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['predicate', 'wake']),
        properties: expect.objectContaining({
          targetKind: expect.objectContaining({ not: expect.anything() }),
          payload_filter: expect.objectContaining({ not: expect.anything() }),
        }),
      }),
    );
    expect(nonPredicateBranches).toHaveLength(1);
    expect(nonPredicateBranches[0].properties?.predicate).toEqual(expect.objectContaining({ not: expect.anything() }));
    expect(nonPredicateBranches[0].properties?.targetKind).toEqual(
      expect.objectContaining({ enum: ['topic', 'event', 'interest'] }),
    );

    const validate = compileJsonSchema(published);
    expect(validate({ pattern: 'backlog', targetKind: 'interest', wake: true, predicate })).toBe(false);
    expect(validate({ pattern: 'backlog', predicate, wake: true })).toBe(true);
    expect(validate({ pattern: 'backlog', targetKind: 'interest' })).toBe(true);
  });

  it('predicate on wake:false is rejected loudly', async () => {
    await expect(call({ pattern: 'backlog', predicate })).rejects.toThrow(/wake:true/);
    expect(subscribeTopic).not.toHaveBeenCalled();
  });

  it('schema rejects predicate with wake:false or the default before handler dispatch', () => {
    for (const args of [
      { pattern: 'backlog', wake: false, predicate },
      { pattern: 'backlog', predicate },
    ]) {
      const parsed = watch.args.safeParse(args);
      expect(parsed.success).toBe(false);
    }

    expect(watch.args.safeParse({ pattern: 'backlog', wake: true, predicate }).success).toBe(true);
  });

  it('interval_sec without a predicate is rejected (min_sleep_sec confusion guard)', async () => {
    await expect(call({ pattern: 'k', wake: true, interval_sec: 30 })).rejects.toThrow(/interval_sec/);
  });

  it('a non-read tool is refused before anything registers', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'write' } as never);
    await expect(call({ pattern: 'backlog', wake: true, predicate })).rejects.toThrow(/read-only/);
    expect(registerAwait).not.toHaveBeenCalled();
    expect(registerPredicateWatch).not.toHaveBeenCalled();
  });

  it('allows an argument-classified read call on a tool whose default effect is write', async () => {
    const effectForCall = vi.fn((args: unknown) => (args as { op?: string }).op === 'get' ? 'read' : 'write');
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'write', effectForCall } as never);
    const readArgs = { op: 'get' };
    const predicate = {
      tool: 'release:repair-queue',
      args: readArgs,
      path: 'repairQueue.admissionPrecheck.status',
      op: 'ne',
      value: 'running',
    };

    await call({ pattern: 'repair queue precheck', wake: true, predicate });

    expect(effectForCall).toHaveBeenCalledWith(readArgs);
    expect(registerPredicateWatch).toHaveBeenCalledWith(expect.objectContaining({ tool: 'release:repair-queue', args: readArgs }));
  });

  it('still refuses an argument-classified write call before anything registers', async () => {
    const effectForCall = vi.fn((args: unknown) => (args as { confirm?: boolean }).confirm ? 'write' : 'read');
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'write', effectForCall } as never);
    const writeArgs = { op: 'admit', confirm: true };
    const writePredicate = { ...predicate, tool: 'release:repair-queue', args: writeArgs };

    await expect(call({ pattern: 'repair queue admission', wake: true, predicate: writePredicate })).rejects.toThrow(/effect=write/);

    expect(effectForCall).toHaveBeenCalledWith(writeArgs);
    expect(registerAwait).not.toHaveBeenCalled();
    expect(registerPredicateWatch).not.toHaveBeenCalled();
  });

  it('happy path: await registers FIRST on the synthetic key, then the watch row, then ONE inline eval', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as ReturnType<typeof lookupByMcpName>);
    const out = await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });
    const awaitArg = vi.mocked(registerAwait).mock.calls[0][0] as Record<string, unknown>;
    expect(String(awaitArg.eventKey)).toMatch(/^predicate:[0-9a-f-]{36}$/);
    const rowArg = vi.mocked(registerPredicateWatch).mock.calls[0][0] as Record<string, unknown>;
    expect(rowArg).toMatchObject({ eventKey: awaitArg.eventKey, tool: 'work_items:list', op: 'gt', intervalSec: 30, role: 'su' });
    // Order: the await must exist before the row (GC invariant).
    expect(vi.mocked(registerAwait).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(registerPredicateWatch).mock.invocationCallOrder[0],
    );
    expect(evalPredicateWatch).toHaveBeenCalledTimes(1);
    expect(out.predicate).toMatchObject({ tool: 'work_items:list', op: 'gt', interval_sec: 30 });
    expect(out.first_eval).toMatchObject({ matched: false, fired: false });
    expect(out.watch.label).toBe('open backlog high');
  });

  it('an inline first-eval ERROR unwinds the await and throws (no dangling waiter)', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as ReturnType<typeof lookupByMcpName>);
    vi.mocked(evalPredicateWatch).mockResolvedValueOnce({ fired: false, matched: false, deactivated: false, error: 'role gate: denied' });
    await expect(call({ pattern: 'b', wake: true, predicate })).rejects.toThrow(/inline first eval.*role gate/s);
    expect(cancelAwait).toHaveBeenCalledWith({ awaitId: 1, subscriberId: 'su-watcher' });
  });
});

describe('P-004 predicate watch dedupe (EI-8998)', () => {
  const predicate = { tool: 'work_items:list', path: 'counts.open', op: 'gt', value: 5 };
  const existingRow = {
    id: 'watch-existing-1',
    eventKey: 'predicate:existing-1',
    intervalSec: 30,
    lastEval: false,
    lastValue: 3,
  };

  it('an identical active predicate JOINS the existing poller — no new row, no inline eval', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as ReturnType<typeof lookupByMcpName>);
    vi.mocked(findMatchingActivePredicateWatch).mockResolvedValueOnce(existingRow as never);
    const out = await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });

    expect(registerPredicateWatch).not.toHaveBeenCalled();
    expect(evalPredicateWatch).not.toHaveBeenCalled();
    const awaitArg = vi.mocked(registerAwait).mock.calls[0][0] as Record<string, unknown>;
    expect(awaitArg.eventKey).toBe('predicate:existing-1');
    expect(out.deduped).toMatchObject({ joined_watch_id: 'watch-existing-1' });
    expect(out.watch.pattern).toBe('predicate:existing-1');
    expect(out.first_eval).toMatchObject({ matched: false, fired: false });
    expect(deliverToSpecificAwaits).not.toHaveBeenCalled();
  });

  it('joining a row that is ALREADY true fires the new subscriber immediately, without a key-wide emit', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as ReturnType<typeof lookupByMcpName>);
    vi.mocked(findMatchingActivePredicateWatch).mockResolvedValueOnce({ ...existingRow, lastEval: true, lastValue: 9 } as never);
    const out = await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });

    expect(deliverToSpecificAwaits).toHaveBeenCalledTimes(1);
    const deliverArg = vi.mocked(deliverToSpecificAwaits).mock.calls[0][0];
    expect(deliverArg.awaitRows).toHaveLength(1);
    expect(out.first_eval).toMatchObject({ matched: true, fired: true, observed: 9 });
    expect(out.deduped).toMatchObject({ joined_watch_id: 'watch-existing-1' });
  });

  it('the dedup lookup is scoped by workspace/role/harness/tool/args/path/op/value/interval/once', async () => {
    vi.mocked(lookupByMcpName).mockReturnValue({ effect: 'read' } as ReturnType<typeof lookupByMcpName>);
    await call({ pattern: 'open backlog high', wake: true, predicate, interval_sec: 30 });
    expect(findMatchingActivePredicateWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-x',
        role: 'su',
        tool: 'work_items:list',
        path: 'counts.open',
        op: 'gt',
        value: 5,
        intervalSec: 30,
        once: true,
      }),
    );
  });
});

describe('WI-10005697: standing pattern watch dedupe', () => {
  // The motivating key on purpose: 'work-item:claimable' carries both a '-' and a ':',
  // the separators normalizeEventKey() strips. The finder compares the key EXACTLY for
  // that reason, and this case fails if that ever regresses to a normalized compare.
  const claimable = { pattern: 'work-item:claimable', wake: true, once: false, payload_filter: { id: 'WI-1' } };

  it('the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker', async () => {
    const first = await call({ ...claimable });
    const second = await call({ ...claimable });

    expect(registerAwait).toHaveBeenCalledTimes(1); // the second registration inserted nothing
    expect(fakeStore.rows).toHaveLength(1);
    expect(first.deduped).toBeUndefined();
    expect(second.deduped).toMatchObject({ joined_watch_id: first.watch.id });
    expect(second.watch.id).toBe(first.watch.id);
    expect(second.watch.payload_filter).toMatchObject({ id: 'WI-1' });
  });

  it('CALIBRATION: a DIFFERING payload_filter is a different watch and still gets its own row', async () => {
    const a = await call({ ...claimable, payload_filter: { id: 'WI-1' } });
    const b = await call({ ...claimable, payload_filter: { id: 'WI-2' } });

    expect(registerAwait).toHaveBeenCalledTimes(2);
    expect(fakeStore.rows).toHaveLength(2);
    expect(a.deduped).toBeUndefined();
    expect(b.deduped).toBeUndefined();
    expect(b.watch.id).not.toBe(a.watch.id);
  });

  it('CALIBRATION: a differing wake floor / urgency is a different watch and still gets its own row', async () => {
    await call({ ...claimable });
    await call({ ...claimable, min_sleep_sec: 600 });
    await call({ ...claimable, urgency: true });

    expect(registerAwait).toHaveBeenCalledTimes(3);
    expect(fakeStore.rows).toHaveLength(3);
  });

  it('the dedupe identity is scoped by subscriber + key + payload filter + floor + urgency', async () => {
    await call({ ...claimable, min_sleep_sec: 120, urgency: true });
    expect(findMatchingActiveStandingWatch).toHaveBeenCalledWith({
      subscriberId: 'su-watcher',
      eventKey: 'work-item:claimable',
      payloadFilter: { id: 'WI-1' },
      minSleepSec: 120,
      urgency: true,
    });
  });

  it('a ONE-SHOT wake is OUT of scope — it is consumed by its fire, so the dedupe never runs', async () => {
    await call({ pattern: 'feature:settled', wake: true, once: true });
    await call({ pattern: 'feature:settled', wake: true, once: true });

    expect(findMatchingActiveStandingWatch).not.toHaveBeenCalled();
    expect(registerAwait).toHaveBeenCalledTimes(2);
  });

  it('a DEADLINE-bearing standing watch is OUT of scope — its expiry is per-registration state', async () => {
    await call({ ...claimable, timeout_sec: 600 });
    await call({ ...claimable, timeout_sec: 600 });

    expect(findMatchingActiveStandingWatch).not.toHaveBeenCalled();
    expect(registerAwait).toHaveBeenCalledTimes(2);
  });
});

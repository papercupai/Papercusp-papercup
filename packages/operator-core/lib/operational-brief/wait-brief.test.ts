/**
 * wait-brief.test.ts — P-010 (spec OP-BRIEF-P010-WAIT): a lock/await wait brief exists ONLY
 * for a wait that materially blocks, and then always carries owner, deadline and an
 * actionable next step. Expectations are hand-written literals over hand-built records;
 * nothing here is recomputed through the projection under test.
 */
import { describe, expect, it } from 'vitest';
import type { AwaitRow } from '../events/await/types';
import { renderOperationalBrief } from './brief';
import {
  awaitNotBlockingReason,
  projectAwaitWaitOperationalBrief,
  projectLockWaitOperationalBrief,
  type LockWaitHolder,
} from './wait-brief';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');

function row(overrides: Partial<AwaitRow> = {}): AwaitRow {
  return {
    id: 42,
    workspaceId: 'ws',
    subscriberId: 'su-waiter',
    eventKey: 'lock:grant:T1',
    policy: 'wake',
    note: null,
    wakeHandle: { kind: 'adv-session', advSessionId: 7, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: null, pid: null },
    timeoutBehavior: 'wake',
    expiresTs: '2026-09-22T12:32:00.000Z',
    createdAt: '2026-09-22T11:59:00.000Z',
    firedAt: null,
    firedReason: null,
    cancelledAt: null,
    cancelReason: null,
    once: true,
    minSleepSec: null,
    urgency: false,
    payloadFilter: null,
    scopeKind: null,
    scopeRef: null,
    ...overrides,
  };
}

const holderA: LockWaitHolder = {
  path: 'lib/x.ts',
  owner: 'su-holder-a',
  owner_label: 'A',
  intent: 'refactor x',
  expires_ts: '2026-09-22T12:10:00.000Z',
};

const lockInput = {
  ticketId: 'T1',
  paths: ['lib/x.ts'],
  waitUntil: new Date('2026-09-22T12:30:00.000Z'),
  wakeAwait: row(),
  holders: [holderA],
  nowMs: NOW,
};

describe('projectLockWaitOperationalBrief — a queued wake_on_grant wait', () => {
  it('reports holder owner, the queue-window deadline, the next action and retry state', () => {
    const brief = projectLockWaitOperationalBrief(lockInput);
    expect(brief).not.toBeNull();
    expect(brief!.surface).toBe('lock-wait');
    expect(brief!.subject).toBe('lock lib/x.ts (ticket T1)');
    expect(brief!.state).toEqual({ status: 'known', value: 'queued-for-wake', source: 'agent_lock_waiters' });
    expect(brief!.owner).toEqual({ status: 'known', value: 'su-holder-a', source: 'agent_locks holder snapshot' });
    expect(brief!.deadline).toEqual({
      status: 'known',
      value: '2026-09-22T12:30:00.000Z',
      source: 'agent_lock_waiters.wait_until',
    });
    expect(brief!.nextAction).toEqual({
      status: 'known',
      value: 'END YOUR TURN. On grant you are re-invoked with lock_id and a running TTL: edit, then locks:release.',
      source: 'agent_lock_waiters',
    });
    expect(brief!.blockers).toEqual({
      status: 'known',
      value: ['lib/x.ts held by su-holder-a (A) for "refactor x" until 2026-09-22T12:10:00.000Z'],
      source: 'agent_locks holder snapshot',
    });
    expect(brief!.facts.awaitId).toEqual({ status: 'known', value: 42, source: 'event_awaits' });
    expect(brief!.facts.grantEventKey).toEqual({ status: 'known', value: 'lock:grant:T1', source: 'event_awaits' });
    expect(brief!.facts.holderLeaseEndsAt).toEqual({
      status: 'known',
      value: '2026-09-22T12:10:00.000Z',
      source: 'agent_locks holder snapshot',
    });
    expect(brief!.facts.retract).toBe("locks:cancel_wait { ticket_id: 'T1' } + events:cancel { await_id: 42 }");
    expect(brief!.facts.onWindowLapse).toBe(
      'If 2026-09-22T12:30:00.000Z passes without a grant you are woken with granted:false; re-run locks:acquire { wake_on_grant:true } to queue again.',
    );
    expect(brief!.unknowns).toEqual([]);
  });

  it('names every distinct holder, the LATEST lease end, and asks a likely-orphaned holder to release', () => {
    const holderB: LockWaitHolder = {
      path: 'lib/y.ts',
      owner: 'su-holder-b',
      intent: 'old task',
      expires_ts: '2026-09-22T12:20:00.000Z',
      holder_intent_diverged: true,
    };
    const brief = projectLockWaitOperationalBrief({ ...lockInput, paths: ['lib/x.ts', 'lib/y.ts'], holders: [holderA, holderB] });
    expect(brief!.owner).toEqual({ status: 'known', value: 'su-holder-a, su-holder-b', source: 'agent_locks holder snapshot' });
    expect(brief!.facts.holderLeaseEndsAt).toMatchObject({ status: 'known', value: '2026-09-22T12:20:00.000Z' });
    expect(brief!.nextAction).toMatchObject({
      status: 'known',
      value:
        'END YOUR TURN. On grant you are re-invoked with lock_id and a running TTL: edit, then locks:release. su-holder-b declared other work since taking the lock: coord:send them once asking them to release it.',
    });
    expect(brief!.blockers).toMatchObject({
      value: [
        'lib/x.ts held by su-holder-a (A) for "refactor x" until 2026-09-22T12:10:00.000Z',
        'lib/y.ts held by su-holder-b for "old task" until 2026-09-22T12:20:00.000Z — holder has moved to other work; likely orphaned',
      ],
    });
  });

  it('apply-on-grant says the caller is NOT woken on success', () => {
    const brief = projectLockWaitOperationalBrief({ ...lockInput, applyOnGrant: true });
    expect(brief!.state).toMatchObject({ value: 'queued-for-wake (apply-on-grant)' });
    expect(brief!.facts.applyOnGrant).toBe(true);
    expect(brief!.nextAction).toMatchObject({
      value:
        'END YOUR TURN. On grant the server applies your attached edit and drops a passive inbox note; you are woken only if the region changed and the edit must be redone.',
    });
  });

  it('a missing holder snapshot is an explicit unknown, never an empty "no blockers"', () => {
    const brief = projectLockWaitOperationalBrief({ ...lockInput, holders: [] });
    expect(brief!.owner.status).toBe('unknown');
    expect(brief!.blockers.status).toBe('unknown');
    expect(brief!.unknowns).toEqual(['owner', 'blockers', 'facts.holders', 'facts.holderLeaseEndsAt']);
    expect(brief!.deadline.status).toBe('known');
    expect(brief!.nextAction.status).toBe('known');
  });

  it('renders through the shared operational-brief rendering', () => {
    const text = renderOperationalBrief(projectLockWaitOperationalBrief(lockInput)!);
    expect(text.split('\n')[0]).toBe('[lock-wait] lock lib/x.ts (ticket T1) — queued-for-wake');
    expect(text).toContain('deadline: 2026-09-22T12:30:00.000Z');
  });
});

describe('projectLockWaitOperationalBrief — no brief when the wait does not block', () => {
  it('returns null with no registered wake await', () => {
    expect(projectLockWaitOperationalBrief({ ...lockInput, wakeAwait: null })).toBeNull();
  });
  it('returns null once the grant await has fired or been cancelled', () => {
    expect(projectLockWaitOperationalBrief({ ...lockInput, wakeAwait: row({ firedAt: '2026-09-22T11:59:30.000Z', firedReason: 'event' }) })).toBeNull();
    expect(projectLockWaitOperationalBrief({ ...lockInput, wakeAwait: row({ cancelledAt: '2026-09-22T11:59:30.000Z' }) })).toBeNull();
  });
  it('returns null after the queue window closed', () => {
    expect(projectLockWaitOperationalBrief({ ...lockInput, waitUntil: '2026-09-22T11:59:59.000Z' })).toBeNull();
  });
});

describe('projectAwaitWaitOperationalBrief — a pending one-shot wake await', () => {
  const awaitRow = row({ id: 9, eventKey: 'release:green:papercusp' });

  it('a catalogued key: owner is the catalogued emitter, deadline is expires_ts, timeout wake is explained', () => {
    const brief = projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, catalogEmitter: 'green-checkpoint routine', nowMs: NOW });
    expect(brief!.surface).toBe('await-wait');
    expect(brief!.subject).toBe('release:green:papercusp');
    expect(brief!.owner).toEqual({ status: 'known', value: 'green-checkpoint routine', source: 'events:catalog emitter' });
    expect(brief!.deadline).toEqual({ status: 'known', value: '2026-09-22T12:32:00.000Z', source: 'event_awaits.expires_ts' });
    expect(brief!.nextAction).toEqual({
      status: 'known',
      value:
        'END YOUR TURN. You are re-invoked when release:green:papercusp fires, or with a timeout wake by 2026-09-22T12:32:00.000Z. On a timeout wake, check that green-checkpoint routine is progressing before re-arming; a stalled emitter is your blocker to diagnose.',
      source: 'event_awaits',
    });
    expect(brief!.blockers).toEqual({ status: 'known', value: ['waiting for release:green:papercusp to fire'], source: 'event_awaits' });
    expect(brief!.facts).toEqual({
      awaitId: 9,
      eventKey: 'release:green:papercusp',
      onTimeout: 'wake',
      wakeHandle: { status: 'known', value: 'adv-session', source: 'event_awaits' },
      payloadFiltered: false,
      announced: false,
      retract: 'events:cancel { await_id: 9 }',
    });
    expect(brief!.unknowns).toEqual([]);
  });

  it('an announced gate: owner is the declarer, and a declarer that ended with no successor is a blocker', () => {
    const brief = projectAwaitWaitOperationalBrief({
      wakeAwait: awaitRow,
      announcement: { announcedBy: 'su-declarer', declaredByLiveness: 'ended', liveSuccessorIds: [] },
      nowMs: NOW,
    });
    expect(brief!.owner).toEqual({ status: 'known', value: 'su-declarer', source: 'events:emit announce declaration' });
    expect(brief!.facts.announced).toBe(true);
    expect(brief!.blockers).toMatchObject({
      value: [
        'waiting for release:green:papercusp to fire',
        'the declarer su-declarer has ended and no live successor carries the emit duty',
      ],
    });
  });

  it("on_timeout:'expire' warns that nothing wakes the caller at the deadline", () => {
    const brief = projectAwaitWaitOperationalBrief({ wakeAwait: row({ ...awaitRow, timeoutBehavior: 'expire' }), catalogEmitter: 'x', nowMs: NOW });
    expect(brief!.facts.onTimeout).toBe('expire');
    expect(brief!.nextAction).toMatchObject({
      value:
        "END YOUR TURN. If release:green:papercusp has not fired by 2026-09-22T12:32:00.000Z this await EXPIRES SILENTLY and nothing wakes you: keep another wake source (loop:arm) or re-register with on_timeout:'wake'.",
    });
  });

  it('an orphan key: owner is an explicit unknown and the next action is to confirm the emitter', () => {
    const brief = projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, noKnownEmitter: true, nowMs: NOW });
    expect(brief!.owner).toEqual({
      status: 'unknown',
      reason: 'no agent declared this key and it matches no catalogued emitter family; nobody is known to fire it',
    });
    expect(brief!.nextAction.status).toBe('known');
    expect(brief!.nextAction).toMatchObject({ value: expect.stringMatching(/^Nothing is known to fire release:green:papercusp: confirm/) });
    expect(brief!.blockers).toMatchObject({
      value: ['waiting for release:green:papercusp to fire', 'no emitter is known to fire this exact key; it may only ever time out'],
    });
    expect(brief!.unknowns).toEqual(['owner']);
  });

  it.each(['timeout', 'aborted', 'error'] as const)(
    'a catalog probe %s is inconclusive, not a confirmed missing emitter',
    (catalogProbeFailure) => {
      const brief = projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, catalogProbeFailure, nowMs: NOW });
      expect(brief!.owner).toEqual({
        status: 'unknown',
        reason: `events:catalog probe ${catalogProbeFailure} while this await was registered; emitter presence and owner are unknown`,
      });
      expect(brief!.blockers).toEqual({
        status: 'known',
        value: [
          'waiting for release:green:papercusp to fire',
          `events:catalog probe ${catalogProbeFailure}; emitter presence is unverified`,
        ],
        source: 'event_awaits',
      });
      expect(brief!.nextAction).toMatchObject({
        status: 'known',
        value: expect.stringContaining('do not treat this as proof that the key has no emitter'),
      });
      expect(brief!.nextAction.status === 'known' && brief!.nextAction.value).not.toMatch(/^Nothing is known to fire/);
      expect(brief!.unknowns).toEqual(['owner']);
    },
  );

  it('a predicate-watch registry probe failure is inconclusive, not a confirmed missing emitter', () => {
    const brief = projectAwaitWaitOperationalBrief({
      wakeAwait: row({ ...awaitRow, eventKey: 'predicate:watch-123' }),
      predicateWatchProbeFailure: 'error',
      nowMs: NOW,
    });
    expect(brief!.owner).toEqual({
      status: 'unknown',
      reason: 'predicate_watches probe error while this await was registered; emitter presence and owner are unknown',
    });
    expect(brief!.blockers.status === 'known' && brief!.blockers.value).toContain('predicate_watches probe error; emitter presence is unverified');
    expect(brief!.nextAction.status === 'known' && brief!.nextAction.value).toContain('do not treat this as proof that the key has no emitter');
    expect(brief!.nextAction.status === 'known' && brief!.nextAction.value).not.toMatch(/^Nothing is known to fire/);
  });

  it('emitter hints keep the owner gap truthful for pattern / uncatalogued / out-of-scope keys', () => {
    expect(projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, emitterHint: 'active-predicate-watch', nowMs: NOW })!.owner).toEqual({
      status: 'known',
      value: 'watch:create predicate poller',
      source: 'predicate_watches',
    });
    expect(projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, emitterHint: 'pattern', nowMs: NOW })!.owner).toEqual({
      status: 'unknown',
      reason: 'a pattern await matches many keys; the first to fire wakes you and each has its own emitter',
    });
    expect(projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, emitterHint: 'fired-uncatalogued', nowMs: NOW })!.owner).toEqual({
      status: 'unknown',
      reason: 'this key has fired before, but its family is not registered in events:catalog, so its emitter cannot be named',
    });
    expect(projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, emitterHint: 'declared-out-of-scope', nowMs: NOW })!.owner).toEqual({
      status: 'unknown',
      reason: 'an announcement outside your discovery scope declared this key; its declarer is not visible to this read',
    });
  });

  it('a missing wake handle is an explicit unknown carrying the registration note', () => {
    const brief = projectAwaitWaitOperationalBrief({
      wakeAwait: row({ ...awaitRow, wakeHandle: null }),
      catalogEmitter: 'x',
      wakeHandleNote: 'no adv session',
      nowMs: NOW,
    });
    expect(brief!.facts.wakeHandle).toEqual({
      status: 'unknown',
      reason: 'no session wake handle was captured at registration (no adv session); delivery falls back to whatever live channel reaches the subscriber',
    });
    expect(brief!.unknowns).toEqual(['facts.wakeHandle']);
  });
});

describe('awaitNotBlockingReason / projectAwaitWaitOperationalBrief — synchronous or non-blocking rows get no brief', () => {
  const cases: Array<[string, AwaitRow, string]> = [
    ['fired', row({ firedAt: '2026-09-22T11:59:30.000Z', firedReason: 'event' }), 'already fired (event) at 2026-09-22T11:59:30.000Z'],
    ['cancelled', row({ cancelledAt: '2026-09-22T11:59:40.000Z' }), 'cancelled at 2026-09-22T11:59:40.000Z'],
    ['lapsed', row({ expiresTs: '2026-09-22T11:00:00.000Z' }), 'lapsed at 2026-09-22T11:00:00.000Z'],
    ['standing watch', row({ once: false }), 'a standing watch re-arms on every fire; it is not a one-shot wait'],
    ['notify subscription', row({ policy: 'notify' }), 'policy notify never re-invokes the subscriber'],
    ['announce declaration', row({ policy: 'announce' }), 'policy announce never re-invokes the subscriber'],
  ];
  it.each(cases)('%s → reason and no brief', (_name, awaitRow, reason) => {
    expect(awaitNotBlockingReason(awaitRow, NOW)).toBe(reason);
    expect(projectAwaitWaitOperationalBrief({ wakeAwait: awaitRow, catalogEmitter: 'x', nowMs: NOW })).toBeNull();
  });
  it('a pending one-shot wake await IS blocking', () => {
    expect(awaitNotBlockingReason(row(), NOW)).toBeNull();
  });
});

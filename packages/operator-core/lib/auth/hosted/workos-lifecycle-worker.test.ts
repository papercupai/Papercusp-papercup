import { describe, expect, it, vi } from 'vitest';
import {
  WORKOS_REVOCATION_PROPAGATION_MS,
  WorkosLifecycleWorker,
  compareWorkosLifecycleCursor,
  projectWorkosLifecycleMutation,
  workosDirectoryIdentitySubject,
  type WorkosAccessClosureSignal,
  type WorkosLifecycleCursor,
  type WorkosLifecycleEvent,
  type WorkosLifecycleMutation,
  type WorkosLifecycleProjectionResult,
  type WorkosLifecycleProjectionStore,
} from './workos-lifecycle-worker';

const OCCURRED = new Date('2026-08-23T12:00:00.000Z');
const RECEIVED = new Date('2026-08-23T12:00:01.000Z');

class ReferenceStore implements WorkosLifecycleProjectionStore {
  readonly mutations: WorkosLifecycleMutation[] = [];
  private readonly eventIds = new Set<string>();
  private readonly watermarks = new Map<string, WorkosLifecycleCursor>();
  private readonly pending = new Map<string, { hostedSessionIds: string[] }>();

  async applyOrdered(input: {
    entityKey: string;
    cursor: WorkosLifecycleCursor;
    mutation: WorkosLifecycleMutation;
  }): Promise<WorkosLifecycleProjectionResult> {
    const pendingClosure = this.pending.get(input.cursor.eventId);
    if (this.eventIds.has(input.cursor.eventId)) {
      return { disposition: 'duplicate', ...(pendingClosure ? { pendingClosure } : {}) };
    }
    this.eventIds.add(input.cursor.eventId);
    const current = this.watermarks.get(input.entityKey);
    if (current && compareWorkosLifecycleCursor(input.cursor, current) <= 0) {
      return { disposition: 'stale' };
    }
    this.watermarks.set(input.entityKey, input.cursor);
    this.mutations.push(input.mutation);
    if (
      input.mutation.kind === 'set-user-status'
      || input.mutation.kind === 'set-organization-status'
      || input.mutation.kind === 'revoke-session'
      || input.mutation.kind === 'reduce-membership-access'
    ) {
      const closure = { hostedSessionIds: [`session-for-${input.entityKey}`] };
      this.pending.set(input.cursor.eventId, closure);
      return { disposition: 'applied', pendingClosure: closure };
    }
    return { disposition: 'applied' };
  }

  async acknowledgeClosure(eventId: string): Promise<void> {
    this.pending.delete(eventId);
  }
}

function base(eventId: string, version: string | number = 1) {
  return { eventId, version, occurredAt: OCCURRED, receivedAt: RECEIVED };
}

describe('WorkosLifecycleWorker', () => {
  it('orders directory changes independently from login identity and rejects stale replay', async () => {
    const store = new ReferenceStore();
    const worker = new WorkosLifecycleWorker(store, { closeAffectedAccess: vi.fn() });
    const directory: WorkosLifecycleEvent = {
      ...base('directory-off', 10), kind: 'directory.user.changed', state: 'inactive',
      userSubject: 'directory-user', directorySubject: 'directory', organizationSubject: 'organization',
    };
    expect((await worker.apply(directory)).disposition).toBe('applied');
    expect((await worker.apply(directory)).disposition).toBe('duplicate');
    expect((await worker.apply({ ...directory, ...base('directory-old', 1), state: 'active' })).disposition).toBe('stale');
    expect((await worker.apply({ ...base('login-user', 1), kind: 'user.upsert', userSubject: 'directory-user' })).disposition).toBe('applied');
    expect(store.mutations).toHaveLength(2);
    expect(store.mutations[0]).toMatchObject({ kind: 'reduce-directory-access', directorySubject: 'directory' });
    expect(store.mutations[1]).toMatchObject({ kind: 'upsert-user' });
    expect(workosDirectoryIdentitySubject('a:b', 'c', 'd')).not.toBe(workosDirectoryIdentitySubject('a', 'b:c', 'd'));
  });

  it('turns active directory users and added groups into observations, never local grants', () => {
    const identity = { userSubject: 'user', directorySubject: 'directory', organizationSubject: 'organization' };
    const active = projectWorkosLifecycleMutation({ ...base('active'), ...identity, kind: 'directory.user.changed', state: 'active' });
    expect(active).toEqual({
      kind: 'observe-directory-membership', provider: 'workos', userSubject: 'user',
      externalOrganizationId: 'organization', directorySubject: 'directory',
    });
    expect(projectWorkosLifecycleMutation({ ...base('added'), ...identity, kind: 'directory.group.membership', groupSubject: 'group', direction: 'added' }))
      .toEqual({
        kind: 'observe-directory-membership', provider: 'workos', userSubject: 'user',
        externalOrganizationId: 'organization', directorySubject: 'directory', groupSubject: 'group',
      });
    // An observation carries no role, grant, or membership material.
    expect(Object.keys(active)).not.toContain('role');
    expect(projectWorkosLifecycleMutation({ ...base('removed'), ...identity, kind: 'directory.group.membership', groupSubject: 'group', direction: 'removed' }))
      .toMatchObject({ kind: 'reduce-directory-access', groupSubject: 'group' });
  });
  it('projects identity, organization, and invitation existence without authority material', async () => {
    const store = new ReferenceStore();
    const closeAffectedAccess = vi.fn(async (_signal: WorkosAccessClosureSignal) => {});
    const worker = new WorkosLifecycleWorker(store, { closeAffectedAccess });

    await worker.apply({
      ...base('evt-user'),
      kind: 'user.upsert',
      userSubject: 'user_ABC',
      email: 'Person@Example.com',
      displayName: 'Person',
    });
    await worker.apply({
      ...base('evt-org'),
      kind: 'organization.upsert',
      organizationSubject: 'org_ABC',
      displayName: 'Example Org',
    });
    await worker.apply({
      ...base('evt-invite'),
      kind: 'invitation.upsert',
      invitationSubject: 'invite_ABC',
      organizationSubject: 'org_ABC',
      inviteeEmail: 'Invitee@Example.com',
    });

    expect(store.mutations).toEqual([
      expect.objectContaining({ kind: 'upsert-user', subject: 'user_ABC', email: 'person@example.com' }),
      expect.objectContaining({ kind: 'upsert-organization', externalOrganizationId: 'org_ABC' }),
      expect.objectContaining({
        kind: 'upsert-invitation-reference',
        externalInvitationId: 'invite_ABC',
        inviteeEmail: 'invitee@example.com',
      }),
    ]);
    expect(JSON.stringify(store.mutations)).not.toMatch(/password|secret|token|capabilit|permission|role/i);
    expect(closeAffectedAccess).not.toHaveBeenCalled();
  });

  it('is duplicate-safe and refuses stale/out-of-order projection updates', async () => {
    const store = new ReferenceStore();
    const worker = new WorkosLifecycleWorker(store, { closeAffectedAccess: vi.fn() });
    const newer: WorkosLifecycleEvent = {
      ...base('evt-new', 10),
      kind: 'user.upsert',
      userSubject: 'CaseSensitiveSubject',
      email: 'new@example.com',
    };
    const stale: WorkosLifecycleEvent = {
      ...base('evt-old', 2),
      kind: 'user.upsert',
      userSubject: 'CaseSensitiveSubject',
      email: 'old@example.com',
    };

    expect((await worker.apply(newer)).disposition).toBe('applied');
    expect((await worker.apply(newer)).disposition).toBe('duplicate');
    expect((await worker.apply(stale)).disposition).toBe('stale');
    expect(store.mutations).toHaveLength(1);
    expect(store.mutations[0]).toMatchObject({ subject: 'CaseSensitiveSubject', email: 'new@example.com' });
  });

  it('never grants membership/role authority and signals reductions within the 60-second bound', async () => {
    const store = new ReferenceStore();
    const signals: WorkosAccessClosureSignal[] = [];
    const worker = new WorkosLifecycleWorker(store, {
      closeAffectedAccess: async (signal) => { signals.push(signal); },
    });

    const ignoredMembership = await worker.apply({
      ...base('evt-membership-grant'),
      kind: 'membership.upsert',
      userSubject: 'user_1',
      organizationSubject: 'org_1',
    });
    const ignoredRole = await worker.apply({
      ...base('evt-role-elevate', 2),
      kind: 'role.changed',
      direction: 'grant-or-elevation',
      userSubject: 'user_1',
      organizationSubject: 'org_1',
    });
    const reduced = await worker.apply({
      ...base('evt-role-reduce', 3),
      kind: 'role.changed',
      direction: 'reduction',
      userSubject: 'user_1',
      organizationSubject: 'org_1',
    });

    expect(ignoredMembership.mutation).toMatchObject({
      kind: 'ignore-external-authority', cause: 'membership-upsert',
    });
    expect(ignoredRole.mutation).toMatchObject({
      kind: 'ignore-external-authority', cause: 'external-role-grant-or-elevation',
    });
    expect(reduced.mutation).toMatchObject({
      kind: 'reduce-membership-access', cause: 'external-role-reduced',
    });
    expect(store.mutations.some((mutation) => 'role' in mutation)).toBe(false);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      maxPropagationMs: WORKOS_REVOCATION_PROPAGATION_MS,
      channels: ['hosted-session', 'sse', 'websocket', 'pty-ticket', 'file-ticket', 'connector-ticket'],
    });
    expect(Date.parse(signals[0].deadlineAt) - Date.parse(signals[0].receivedAt)).toBe(60_000);
  });

  it('replays a durable closure obligation after a sink failure, then acknowledges it', async () => {
    const store = new ReferenceStore();
    const closeAffectedAccess = vi.fn()
      .mockRejectedValueOnce(new Error('transient sink failure'))
      .mockResolvedValueOnce(undefined);
    const worker = new WorkosLifecycleWorker(store, { closeAffectedAccess });
    const event: WorkosLifecycleEvent = {
      ...base('evt-session-revoke'),
      kind: 'session.revoked',
      sessionSubject: 'session_1',
    };

    await expect(worker.apply(event)).rejects.toThrow('transient sink failure');
    const replay = await worker.apply(event);
    expect(replay).toMatchObject({ disposition: 'duplicate', closureDelivered: true });
    expect(closeAffectedAccess).toHaveBeenCalledTimes(2);
    expect((await worker.apply(event)).closureDelivered).toBe(false);
  });

  it('runs a bounded periodic reconciliation pass in deterministic order', async () => {
    const store = new ReferenceStore();
    const worker = new WorkosLifecycleWorker(store, { closeAffectedAccess: vi.fn() });
    const pageCalls: Array<{ cursor?: string; limit: number }> = [];
    const older: WorkosLifecycleEvent = {
      ...base('evt-1', 1),
      kind: 'organization.upsert',
      organizationSubject: 'org_1',
      displayName: 'Old',
    };
    const newer: WorkosLifecycleEvent = {
      ...base('evt-2', 2),
      kind: 'organization.upsert',
      organizationSubject: 'org_1',
      displayName: 'New',
    };
    const source = {
      async listLifecyclePage(input: { cursor?: string; limit: number }) {
        pageCalls.push(input);
        return input.cursor ? { events: [newer] } : { events: [newer, older], nextCursor: 'page-2' };
      },
    };

    await expect(worker.reconcile(source, { pageSize: 25 })).resolves.toEqual({
      pages: 2,
      examined: 3,
      applied: 2,
      duplicate: 1,
      stale: 0,
      closuresDelivered: 0,
    });
    expect(pageCalls).toEqual([{ cursor: undefined, limit: 25 }, { cursor: 'page-2', limit: 25 }]);
    expect(store.mutations.map((mutation) => mutation.kind)).toEqual([
      'upsert-organization',
      'upsert-organization',
    ]);
  });
});

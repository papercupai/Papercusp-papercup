import { describe, expect, it, vi } from 'vitest';
import {
  isTestBlocking,
  memoryTestDowngradeStore,
  pgTestDowngradeStore,
  startOfUtcDay,
  validateTestDowngrade,
  type TestDowngradeRequest,
} from './test-downgrade-store';
import { makeTestDowngradeHandler, type TestDowngradeDeps } from '../agent-tools/release/test-downgrade';

const complete: TestDowngradeRequest = {
  testFile: 'packages/operator-core/lib/dream/dream-control-observations.test.ts',
  testCase: 'dream control > records a skipped pass',
  reason: 'fails on the frozen candidate only under the shared fixture; fix needs the P-008 determinism work',
  owner: 'su-807ee9d7',
  bugId: 'EI-1',
  author: 'su-807ee9d7',
};

describe('P-002 downgrade record completeness (R-1)', () => {
  it('accepts a complete record and returns a warning', () => {
    const result = validateTestDowngrade(complete);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.criticalArea).toBeNull();
    expect(result.warning).toContain('DOWNGRADED');
    expect(result.warning).toContain('EI-1');
  });

  it.each([
    ['reason', /missing reason/],
    ['owner', /missing owner/],
    ['bugId', /missing bugId/],
    ['author', /missing author/],
    ['testFile', /missing testFile/],
  ] as const)('refuses a record without %s', (field, problem) => {
    const result = validateTestDowngrade({ ...complete, [field]: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((entry) => problem.test(entry))).toBe(true);
  });

  it('lists every missing field in one refusal', () => {
    const result = validateTestDowngrade({ testFile: complete.testFile });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(4);
  });
});

describe('P-003 critical-area downgrade (R-2)', () => {
  const critical: TestDowngradeRequest = { ...complete, testFile: 'apps/operator/lib/release/deploy.test.ts' };

  it('refuses a critical-area downgrade without an acknowledgement naming the area (falsifiability probe)', () => {
    const result = validateTestDowngrade(critical);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.criticalArea?.id).toBe('deploy-release');
    expect(result.problems.join('\n')).toMatch(/missing acknowledgement.*deploy-release/);
    expect(validateTestDowngrade({ ...critical, acknowledgement: { area: 'gate', risk: 'x'.repeat(40) } }).ok).toBe(false);
  });

  it('accepts it with the acknowledgement and warns forcefully', () => {
    const result = validateTestDowngrade({
      ...critical,
      acknowledgement: { area: 'deploy-release', risk: 'a broken deploy rollback path may ship until EI-1 is fixed' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.criticalArea).toBe('deploy-release');
    expect(result.record.riskAcknowledgement).toContain('rollback');
    expect(result.warning).toContain('CRITICAL AREA');
  });
});

describe('P-002 blocking is derived from active records', () => {
  it('blocks a failing test unless an active downgrade covers exactly its file and case', async () => {
    const store = memoryTestDowngradeStore();
    const valid = validateTestDowngrade(complete);
    if (!valid.ok) throw new Error('fixture must be valid');
    const row = await store.insert(valid.record);
    if ('conflict' in row) throw new Error('unexpected conflict');
    const active = await store.listActive();
    expect(isTestBlocking(active, complete.testFile, complete.testCase)).toBe(false);
    // D-005: another case in the same file still blocks.
    expect(isTestBlocking(active, complete.testFile, 'dream control > another case')).toBe(true);
    await store.revoke(row.id, 'su-807ee9d7', 'fixed');
    expect(isTestBlocking(await store.listActive(), complete.testFile, complete.testCase)).toBe(true);
    // Deleting the record outright also restores blocking (R-1 falsifier 7).
    expect(isTestBlocking([], complete.testFile, complete.testCase)).toBe(true);
  });

  it('refuses a second active downgrade for the same case', async () => {
    const store = memoryTestDowngradeStore();
    const valid = validateTestDowngrade(complete);
    if (!valid.ok) throw new Error('fixture must be valid');
    await store.insert(valid.record);
    expect('conflict' in (await store.insert(valid.record))).toBe(true);
  });

  it('reads the digest window from the start of the UTC day', () => {
    expect(startOfUtcDay(new Date('2026-10-17T20:15:00.000Z')).toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });

  it('scopes every Postgres query by workspace and harness', async () => {
    const unsafe = vi.fn(async () => []);
    const store = pgTestDowngradeStore({ unsafe }, { workspaceId: 'ws', harnessSlug: 'pot' });
    await store.listActive();
    await store.listCreatedSince(new Date('2026-10-17T00:00:00.000Z'));
    for (const [query, params] of unsafe.mock.calls as unknown as Array<[string, unknown[]]>) {
      expect(query).toMatch(/workspace_id = \$1 AND harness_slug = \$2/);
      expect(params.slice(0, 2)).toEqual(['ws', 'pot']);
    }
    expect((unsafe.mock.calls[1] as unknown as [string, unknown[]])[1][2]).toBe('2026-10-17T00:00:00.000Z');
  });
});

describe('release:test-downgrade verb', () => {
  const ctx = { workspaceId: 'ws', harnessSlug: 'papercusp', uiClientId: 'su-807ee9d7', isSuperuser: true, role: 'su' };
  function harness(now = new Date('2026-10-17T12:00:00.000Z')) {
    const store = memoryTestDowngradeStore(() => now);
    const notifyOwner = vi.fn(async () => undefined);
    const deps: TestDowngradeDeps = { store: () => store, notifyOwner, now: () => now };
    return { store, notifyOwner, handler: makeTestDowngradeHandler(deps) };
  }
  const run = async (handler: ReturnType<typeof makeTestDowngradeHandler>, args: Record<string, unknown>) =>
    ((await handler(args as never, ctx)) as { data: Record<string, unknown> }).data;

  it('stores a complete downgrade, warns, and lists it in today’s digest', async () => {
    const { handler, notifyOwner } = harness();
    const created = await run(handler, { op: 'create', ...complete, author: undefined });
    expect(created.ok).toBe(true);
    expect(String(created.warning)).toContain('DOWNGRADED');
    expect(created.ownerNotified).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
    const digest = await run(handler, { op: 'digest' });
    expect((digest.createdToday as unknown[]).length).toBe(1);
  });

  it('refuses an incomplete record and stores nothing', async () => {
    const { handler, store } = harness();
    const refused = await run(handler, { op: 'create', testFile: complete.testFile, reason: 'x' });
    expect(refused.reason).toBe('incomplete_downgrade_record');
    expect(store.rows).toHaveLength(0);
  });

  it('notifies the owner immediately for an acknowledged critical-area downgrade', async () => {
    const { handler, notifyOwner, store } = harness();
    const refused = await run(handler, { op: 'create', ...complete, testFile: 'libs/papercusp/libs/db/src/migrate.test.ts' });
    expect(refused.ok).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
    const created = await run(handler, {
      op: 'create',
      ...complete,
      testFile: 'libs/papercusp/libs/db/src/migrate.test.ts',
      acknowledgement: { area: 'migrations-schema', risk: 'a migration ordering bug may reach the live database' },
    });
    expect(created.ok).toBe(true);
    expect(created.ownerNotified).toBe(true);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(store.rows[0]?.ownerNotifiedAt).not.toBeNull();
  });

  it('revoke makes the test block again', async () => {
    const { handler, store } = harness();
    const created = await run(handler, { op: 'create', ...complete });
    const id = (created.downgrade as { id: number }).id;
    expect((await run(handler, { op: 'revoke', id })).ok).toBe(true);
    expect(isTestBlocking(await store.listActive(), complete.testFile, complete.testCase)).toBe(true);
  });
});

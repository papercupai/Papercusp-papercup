/**
 * P-008 (green-main-ratchet-convergence-2026-10-17, R-7): the gate-side orchestrator. Pins the
 * effect ORDER (the de-quarantine work-item is filed before the quarantine row, so no row is
 * ever unowned), per-flip isolation of failures, the critical-area owner notice, and the owner
 * default.
 */
import { describe, expect, it } from 'vitest';
import { memoryTestDowngradeStore } from './test-downgrade-store';
import { FLAKY_QUARANTINE_KIND, type IsolationRetry } from './verdict-flip-quarantine';
import {
  FLAKY_QUARANTINE_DEFAULT_OWNER,
  FLAKY_QUARANTINE_OWNER_ENV,
  flakyQuarantineOwnerFromEnv,
  runVerdictFlipQuarantine,
  type VerdictFlipGateDeps,
} from './verdict-flip-quarantine-gate';

const SHA = 'a'.repeat(40);
const NOW = new Date('2026-10-17T12:00:00.000Z');
const DIRS: Record<string, string> = { '@papercusp/operator-core': 'packages/operator-core' };
const workspaceDirOf = (ws: string) => DIRS[ws] ?? null;
const retry = (file: string, outcome: IsolationRetry['outcome']): IsolationRetry => ({
  name: `@papercusp/operator-core::${file}`,
  outcome,
  via: 'load-flake-isolation',
});

function harness(over: Partial<VerdictFlipGateDeps> = {}) {
  const store = memoryTestDowngradeStore(() => NOW);
  const events: string[] = [];
  const deps: VerdictFlipGateDeps = {
    store,
    async fileWorkItem(draft) {
      events.push(`file rows=${store.rows.length} assignee=${draft.assignee}`);
      return `WI-${events.length}`;
    },
    async notifyOwner(_action, record) {
      events.push(`notify ${record.testFile}`);
    },
    ownerOf: () => 'human',
    now: () => NOW,
    ...over,
  };
  return { store, events, deps };
}

describe('runVerdictFlipQuarantine', () => {
  it('files the owner’s de-quarantine work-item BEFORE writing the quarantine row', async () => {
    const { store, events, deps } = harness();
    const { health, active } = await runVerdictFlipQuarantine(
      { candidateSha: SHA, retries: [retry('lib/x/flaky.test.ts', 'passed-on-rerun')], workspaceDirOf },
      deps,
    );
    expect(events[0]).toBe('file rows=0 assignee=human');
    expect(health).toMatchObject({ flips: 1, alreadyCovered: 0, unowned: [], errors: [] });
    expect(health.quarantined).toEqual([
      { testFile: 'packages/operator-core/lib/x/flaky.test.ts', testCase: '', owner: 'human', workItemId: 'WI-1' },
    ]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ kind: FLAKY_QUARANTINE_KIND, owner: 'human', bugId: 'WI-1' });
    expect(active.map((r) => r.testFile)).toEqual(['packages/operator-core/lib/x/flaky.test.ts']);
  });

  it('quarantines nothing for a file that failed again alone (no flip)', async () => {
    const { store, events, deps } = harness();
    const { health } = await runVerdictFlipQuarantine(
      { candidateSha: SHA, retries: [retry('lib/x/broken.test.ts', 'still-failing')], workspaceDirOf },
      deps,
    );
    expect(health.flips).toBe(0);
    expect(events).toEqual([]);
    expect(store.rows).toEqual([]);
  });

  it('writes no row when filing the work-item fails, and keeps going for the other flips', async () => {
    let calls = 0;
    const { store, deps } = harness({
      async fileWorkItem() {
        calls += 1;
        if (calls === 1) throw new Error('issue writer down');
        return 'WI-9';
      },
    });
    const { health } = await runVerdictFlipQuarantine(
      {
        candidateSha: SHA,
        retries: [retry('lib/x/one.test.ts', 'passed-on-rerun'), retry('lib/x/two.test.ts', 'passed-on-rerun')],
        workspaceDirOf,
      },
      deps,
    );
    expect(health.errors).toHaveLength(1);
    expect(health.errors[0]).toContain('issue writer down');
    expect(store.rows.map((r) => r.testFile)).toEqual(['packages/operator-core/lib/x/two.test.ts']);
    expect(store.rows[0]?.bugId).toBe('WI-9');
  });

  it('leaves a flip with no owner unquarantined (it keeps counting)', async () => {
    const { store, events, deps } = harness({ ownerOf: () => null });
    const { health } = await runVerdictFlipQuarantine(
      { candidateSha: SHA, retries: [retry('lib/x/flaky.test.ts', 'passed-on-rerun')], workspaceDirOf },
      deps,
    );
    expect(health.unowned).toEqual(['packages/operator-core/lib/x/flaky.test.ts']);
    expect(events).toEqual([]);
    expect(store.rows).toEqual([]);
  });

  it('does not re-quarantine a test an active row already covers', async () => {
    const { store, events, deps } = harness();
    const input = { candidateSha: SHA, retries: [retry('lib/x/flaky.test.ts', 'passed-on-rerun')], workspaceDirOf };
    await runVerdictFlipQuarantine(input, deps);
    const second = await runVerdictFlipQuarantine(input, deps);
    expect(second.health.alreadyCovered).toBe(1);
    expect(second.health.quarantined).toEqual([]);
    expect(store.rows).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('file'))).toHaveLength(1);
  });

  it('notifies the owner at once for a critical-area quarantine and records the notice', async () => {
    const { store, events, deps } = harness();
    await runVerdictFlipQuarantine(
      {
        candidateSha: SHA,
        retries: [retry('lib/release/deploy-rollback.test.ts', 'passed-on-rerun')],
        workspaceDirOf,
      },
      deps,
    );
    expect(events).toContain('notify packages/operator-core/lib/release/deploy-rollback.test.ts');
    expect(store.rows[0]?.criticalArea).not.toBeNull();
    expect(store.rows[0]?.riskAcknowledgement ?? '').not.toBe('');
    expect(store.rows[0]?.ownerNotifiedAt).toBe(NOW.toISOString());
  });
});

describe('flakyQuarantineOwnerFromEnv', () => {
  it('defaults to the human owner and honours the override', () => {
    expect(flakyQuarantineOwnerFromEnv({})).toBe(FLAKY_QUARANTINE_DEFAULT_OWNER);
    expect(flakyQuarantineOwnerFromEnv({ [FLAKY_QUARANTINE_OWNER_ENV]: '  su-flake-owner ' })).toBe('su-flake-owner');
    expect(flakyQuarantineOwnerFromEnv({ [FLAKY_QUARANTINE_OWNER_ENV]: '   ' })).toBe(FLAKY_QUARANTINE_DEFAULT_OWNER);
  });
});

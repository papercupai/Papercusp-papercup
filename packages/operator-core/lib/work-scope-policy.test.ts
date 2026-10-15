/**
 * work-scope-policy.test.ts — the workspace work-scope policy
 * (plan workspace-work-scope-policy-2026-09-04).
 * Run: cd packages/operator-core && npx vitest run lib/work-scope-policy.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkScopeException, WorkScopeSubject } from './work-scope-policy';

const store: { policy: Record<string, unknown> } = { policy: {} };
vi.mock('./pot-control-policy', () => ({
  placementOverride: vi.fn(() => store.policy),
  readPotControlPolicy: vi.fn(async () => store.policy),
  writePotControlPolicy: vi.fn(async (patch: Record<string, unknown>) => {
    store.policy = { ...store.policy, ...patch };
    return store.policy;
  }),
}));

const mod = await import('./work-scope-policy');
const {
  matchHarnessPattern,
  isHarnessInScope,
  evaluateWorkScope,
  gateWorkScope,
  workScopeSqlTerms,
  recordWorkScopeDecision,
  setWorkScopePolicy,
  clearWorkScopePolicy,
  reconcilePresencePot,
  classifyForRehome,
  isPlatformNonPotHarness,
  WORK_SCOPE_LEDGER_CAP,
} = mod;

const ENFORCE = { mode: 'enforce' as const, allowHarnesses: ['papercusp', 'papercusp/*'], setBy: 'role:su', reason: 'owner: papercusp only' };

beforeEach(() => {
  store.policy = {};
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('matchHarnessPattern', () => {
  it('reads policy in the requested workspace without substituting the process default', async () => {
    const { readPotControlPolicy } = await import('./pot-control-policy');
    store.policy = { workScope: ENFORCE };
    expect(await mod.readWorkScopePolicy('dispatch-workspace')).toMatchObject(ENFORCE);
    expect(readPotControlPolicy).toHaveBeenLastCalledWith('dispatch-workspace');
  });

  it('exact, root+sub glob, prefix glob, star', () => {
    expect(matchHarnessPattern('papercusp', 'papercusp')).toBe(true);
    expect(matchHarnessPattern('papercusp', 'papercusp-public-site')).toBe(false);
    expect(matchHarnessPattern('papercusp/*', 'papercusp')).toBe(true);
    expect(matchHarnessPattern('papercusp/*', 'papercusp/libs/generic/sync')).toBe(true);
    expect(matchHarnessPattern('papercusp/*', 'papercusp-public-site')).toBe(false);
    expect(matchHarnessPattern('paper*', 'papercusp-public-site')).toBe(true);
    expect(matchHarnessPattern('*', 'anything')).toBe(true);
    expect(matchHarnessPattern('', 'x')).toBe(false);
  });
});

describe('fail-open (the contract that keeps a missing policy from freezing the fleet)', () => {
  it('no policy → allowed, mode off → allowed, unscoped → allowed', () => {
    expect(evaluateWorkScope({ harness: 'sidestage' }, null)).toEqual({ allowed: true, reason: 'no-policy' });
    expect(evaluateWorkScope({ harness: 'sidestage' }, { mode: 'off', allowHarnesses: ['papercusp'] })).toEqual({ allowed: true, reason: 'mode-off' });
    expect(evaluateWorkScope({ harness: 'sidestage' }, { mode: 'enforce', allowHarnesses: [] })).toEqual({ allowed: true, reason: 'mode-off' });
    expect(evaluateWorkScope({ harness: null }, ENFORCE)).toEqual({ allowed: true, reason: 'unscoped' });
    expect(evaluateWorkScope({ harness: '*' }, ENFORCE)).toEqual({ allowed: true, reason: 'unscoped' });
    expect(isHarnessInScope('sidestage', null)).toBe(true);
  });
  it('a garbage stored value is treated as no policy', () => {
    store.policy = { workScope: { mode: 'weird' } };
    expect(evaluateWorkScope({ harness: 'sidestage' })).toEqual({ allowed: true, reason: 'no-policy' });
  });
});

describe('enforce', () => {
  it('admits the root and its sub-harnesses, denies other pots with a self-explaining message', () => {
    expect(evaluateWorkScope({ harness: 'papercusp' }, ENFORCE).allowed).toBe(true);
    expect(evaluateWorkScope({ harness: 'papercusp/libs/papercusp' }, ENFORCE).allowed).toBe(true);
    const v = evaluateWorkScope({ harness: 'sidestage', plan: 'sidestage-x' }, ENFORCE);
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('unreachable');
    expect(v.code).toBe('scope_denied');
    expect(v.harness).toBe('sidestage');
    expect(v.message).toContain("harness 'sidestage'");
    expect(v.message).toContain('papercusp, papercusp/*');
    expect(v.message).toContain('set by role:su');
  });
  it('exceptions admit by harness glob / plan / goal / workItem', () => {
    const p = { ...ENFORCE, exceptions: [
      { harness: 'portal', reason: 'r' },
      { plan: 'sidestage-auction', reason: 'r' },
      { goal: 'g-1', reason: 'r' },
      { workItem: 'WI-1', reason: 'r' },
    ] };
    expect(evaluateWorkScope({ harness: 'portal' }, p)).toMatchObject({ allowed: true, reason: 'exception' });
    expect(evaluateWorkScope({ harness: 'sidestage', plan: 'sidestage-auction' }, p).allowed).toBe(true);
    expect(evaluateWorkScope({ harness: 'sidestage', goal: 'g-1' }, p).allowed).toBe(true);
    expect(evaluateWorkScope({ harness: 'sidestage', workItem: 'WI-1' }, p).allowed).toBe(true);
    expect(evaluateWorkScope({ harness: 'sidestage', workItem: 'WI-2' }, p).allowed).toBe(false);
  });
});

describe('exception expiry — current decisions and SQL selection', () => {
  const instant = Date.parse('2030-01-02T03:04:05Z');
  let nowMs = instant;
  beforeEach(() => {
    nowMs = instant;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });
  afterEach(() => vi.restoreAllMocks());

  const axes = ['harness', 'plan', 'goal', 'workItem'] as const;
  const boundaries = [['future', 1], ['exact', 0], ['past', -1]] as const;
  const cases = axes.flatMap((axis) => boundaries.map(([label, offset]) => ({ axis, label, offset })));
  it.each(cases)('$axis exception at $label boundary agrees with SQL selection', ({ axis, offset }) => {
    const value = axis === 'harness' ? 'portal' : 'fixture-subject';
    const exception: WorkScopeException = {
      [axis]: value, reason: 'temporary grant', expiresAt: new Date(instant + offset).toISOString(),
    };
    const subject: WorkScopeSubject = { harness: 'portal', [axis]: value };
    const policy = { ...ENFORCE, exceptions: [exception] };
    expect(evaluateWorkScope(subject, policy).allowed).toBe(offset > 0);
    const terms = workScopeSqlTerms(policy);
    expect(terms).not.toBeNull();
    expect(terms?.exceptions !== undefined).toBe(offset > 0);
  });

  it.each(['not-a-date', '', '2030-01-02', '2030-02-31T00:00:00Z', null, 1893456000000])(
    'malformed stored expiry %j cannot grant or remove the SQL scope predicate', (expiresAt) => {
      const exception = { harness: '*', reason: 'invalid grant', expiresAt } as unknown as WorkScopeException;
      const policy = { ...ENFORCE, exceptions: [exception] };
      expect(evaluateWorkScope({ harness: 'portal' }, policy).allowed).toBe(false);
      expect(workScopeSqlTerms(policy)).toEqual(workScopeSqlTerms(ENFORCE));
    },
  );

  it('an expired wildcard does not hide a later active exception', () => {
    const policy = { ...ENFORCE, exceptions: [
      { harness: '*', reason: 'expired', expiresAt: new Date(instant).toISOString() },
      { harness: 'portal', reason: 'active', expiresAt: new Date(instant + 1).toISOString() },
    ] };
    expect(evaluateWorkScope({ harness: 'portal' }, policy)).toMatchObject({ allowed: true, exception: { reason: 'active' } });
    expect(evaluateWorkScope({ harness: 'other' }, policy).allowed).toBe(false);
    expect(workScopeSqlTerms(policy)?.exceptions?.exactHarnesses).toEqual(['portal']);
  });

  it('the same cached row stops granting at expiry without a cache refresh', () => {
    const policy = { ...ENFORCE, exceptions: [
      { harness: '*', reason: 'temporary', expiresAt: new Date(instant + 1).toISOString() },
    ] };
    store.policy = { workScope: policy };
    expect(evaluateWorkScope({ harness: 'portal' }).allowed).toBe(true);
    expect(workScopeSqlTerms()).toBeNull();
    nowMs += 1;
    expect(evaluateWorkScope({ harness: 'portal' }).allowed).toBe(false);
    expect(workScopeSqlTerms()).toEqual(workScopeSqlTerms(ENFORCE));
  });

  it('expiry does not remove an independent allow-list grant or an indefinite exception', () => {
    const policy = { ...ENFORCE, exceptions: [
      { harness: '*', reason: 'expired', expiresAt: new Date(instant).toISOString() },
      { harness: 'portal', reason: 'indefinite' },
    ] };
    expect(evaluateWorkScope({ harness: 'papercusp' }, policy)).toMatchObject({ allowed: true, reason: 'in-scope' });
    expect(evaluateWorkScope({ harness: 'portal' }, policy)).toMatchObject({ allowed: true, exception: { reason: 'indefinite' } });
    expect(workScopeSqlTerms(policy)?.exceptions?.exactHarnesses).toEqual(['portal']);
  });
});

describe('ledger', () => {
  it('gateWorkScope records a denial on the stored policy, bounded to the cap, and never records an allow', async () => {
    store.policy = { workScope: { ...ENFORCE } };
    const ok = await gateWorkScope('scheduler:get_next', { harness: 'papercusp', actor: 'su-a' });
    expect(ok.allowed).toBe(true);
    expect((store.policy.workScope as { ledger?: unknown }).ledger).toBeUndefined();
    const denied = await gateWorkScope('scheduler:get_next', { harness: 'sidestage', plan: 'p', actor: 'su-a' });
    expect(denied.allowed).toBe(false);
    const ws = store.policy.workScope as { ledger: { entries: unknown[]; counts: Record<string, number> } };
    expect(ws.ledger.counts.denied).toBe(1);
    expect(ws.ledger.entries).toHaveLength(1);
    expect(ws.ledger.entries[0]).toMatchObject({ site: 'scheduler:get_next', verdict: 'denied', harness: 'sidestage', subject: 'p', actor: 'su-a' });
    for (let i = 0; i < WORK_SCOPE_LEDGER_CAP + 5; i++) await recordWorkScopeDecision({ site: 's', verdict: 'held', harness: 'x' });
    const after = store.policy.workScope as { ledger: { entries: unknown[]; counts: Record<string, number> } };
    expect(after.ledger.entries).toHaveLength(WORK_SCOPE_LEDGER_CAP);
    expect(after.ledger.counts.held).toBe(WORK_SCOPE_LEDGER_CAP + 5);
    expect(after.ledger.counts.denied).toBe(1);
  });
  it('a ledger write failure never blocks the verdict', async () => {
    store.policy = { workScope: { ...ENFORCE } };
    const { writePotControlPolicy } = await import('./pot-control-policy');
    vi.mocked(writePotControlPolicy).mockRejectedValueOnce(new Error('pg down'));
    const v = await gateWorkScope('capability:launch-agent', { harness: 'sidestage' });
    expect(v.allowed).toBe(false);
  });
});

describe('set / clear', () => {
  it('set trims, stamps updatedAt, keeps the prior ledger; clear removes it', async () => {
    store.policy = { breakerThreshold: 5, workScope: { ...ENFORCE, ledger: { entries: [], counts: { denied: 3, held: 0, rehomed: 0 } } } };
    const stored = await setWorkScopePolicy({ mode: 'enforce', allowHarnesses: [' papercusp ', 'papercusp/*', ''], reason: 'r', setBy: 'role:su' });
    expect(stored.allowHarnesses).toEqual(['papercusp', 'papercusp/*']);
    expect(stored.updatedAt).toBeTruthy();
    expect(stored.ledger?.counts.denied).toBe(3);
    expect(store.policy.breakerThreshold).toBe(5); // sibling keys untouched
    await clearWorkScopePolicy();
    expect(store.policy.workScope).toBeUndefined();
    expect(store.policy.breakerThreshold).toBe(5);
  });
});

describe('workScopeSqlTerms', () => {
  it('splits exact slugs from LIKE prefixes; null when not enforced or star', () => {
    expect(workScopeSqlTerms(null)).toBeNull();
    expect(workScopeSqlTerms({ mode: 'enforce', allowHarnesses: ['*'] })).toBeNull();
    expect(workScopeSqlTerms(ENFORCE)).toEqual({ exact: ['papercusp', 'papercusp'], likePrefixes: ['papercusp/%'] });
    expect(workScopeSqlTerms({ mode: 'enforce', allowHarnesses: ['a_b*'] })).toEqual({ exact: [], likePrefixes: ['a\\_b%'] });
  });

  it('returns SQL terms for harness, plan, goal, and work-item exceptions', () => {
    expect(workScopeSqlTerms({
      mode: 'enforce',
      allowHarnesses: ['papercusp'],
      exceptions: [
        { harness: 'recipe-app', reason: 'explicit harness exception' },
        { harness: 'north/*', plan: 'plan-1', goal: 'goal-1', workItem: 'WI-1', reason: 'subject exceptions' },
      ],
    })).toEqual({
      exact: ['papercusp'],
      likePrefixes: [],
      exceptions: {
        exactHarnesses: ['recipe-app', 'north'],
        harnessLikePrefixes: ['north/%'],
        plans: ['plan-1'],
        goals: ['goal-1'],
        workItems: ['WI-1'],
      },
    });
  });

  it('emits no scope predicate when an exception admits every harness', () => {
    expect(workScopeSqlTerms({
      mode: 'enforce',
      allowHarnesses: ['papercusp'],
      exceptions: [{ harness: '*', reason: 'all harnesses' }],
    })).toBeNull();
  });
});

describe('reconcilePresencePot (P-010)', () => {
  it('corrects a requested pot that disagrees with the harness-derived pot; leaves agreement and unscoped alone', () => {
    expect(reconcilePresencePot({ requested: 'sb-devboard-hive', derived: 'papercusp', harnessSlug: 'papercusp' })).toMatchObject({ potSlug: 'papercusp', corrected: true });
    expect(reconcilePresencePot({ requested: 'papercusp', derived: 'papercusp', harnessSlug: 'papercusp' })).toEqual({ potSlug: 'papercusp', corrected: false });
    expect(reconcilePresencePot({ requested: null, derived: 'papercusp', harnessSlug: 'papercusp' })).toEqual({ potSlug: 'papercusp', corrected: false });
    expect(reconcilePresencePot({ requested: 'sb-devboard-hive', derived: 'papercusp', harnessSlug: '*' })).toEqual({ potSlug: 'sb-devboard-hive', corrected: false });
    expect(reconcilePresencePot({ requested: 'sb-devboard-hive', derived: null, harnessSlug: 'papercusp' })).toEqual({ potSlug: 'sb-devboard-hive', corrected: false });
  });
});

describe('classifyForRehome (P-009 — the non-naive half)', () => {
  it('keeps in-scope items, re-homes platform-referencing items, holds genuinely other-pot work', () => {
    expect(classifyForRehome({ harness: 'papercusp', title: 'x' }, ENFORCE)).toEqual({ action: 'keep', reason: 'in-scope' });
    const calendarBug = classifyForRehome({ harness: 'calendar', title: 'Repair package.json identity-leak quarantine for git-sync' }, ENFORCE);
    expect(calendarBug).toMatchObject({ action: 'rehome', to: 'papercusp' });
    if (calendarBug.action !== 'rehome') throw new Error('unreachable');
    expect(calendarBug.signals).toEqual(expect.arrayContaining(['term:git-sync', 'term:identity-leak']));
    const fixerFiled = classifyForRehome({ harness: 'portal', title: 'broken file', createdByRole: 'content-fixer' }, ENFORCE);
    expect(fixerFiled).toMatchObject({ action: 'rehome', signals: ['system-role:content-fixer'] });
    const pathRef = classifyForRehome({ harness: 'email', title: 'x', paths: ['packages/operator-core/lib/x.ts'] }, ENFORCE);
    expect(pathRef).toMatchObject({ action: 'rehome' });
    expect(classifyForRehome({ harness: 'sidestage', title: 'Seller copilot mission: add auction chat overlay', body: 'SideStage studio' }, ENFORCE)).toEqual({ action: 'hold', reason: 'no-platform-signal' });
  });

  // WI-10004723 (plan work-queue-bulk-cleanup-remediation-2026-10-01 P-003): 14 learning-loop alarms
  // filed under the legacy non-pot slug `operator:papercusp-workspace` carried no text signal, so
  // they were HELD as if they were another pot's work for 6 days.
  it('re-homes anything in the workspace operator harness, whatever its text says', () => {
    const alarm = classifyForRehome(
      { harness: 'operator:papercusp-workspace', title: 'LEARNING LOOP needs attention: negative-space (absent)' },
      ENFORCE,
    );
    expect(alarm).toEqual({ action: 'rehome', to: 'papercusp', signals: ['harness:operator:papercusp-workspace'] });
    expect(isPlatformNonPotHarness('operator:papercusp-workspace')).toBe(true);
    // Control: a real pot whose slug merely CONTAINS "operator" is still judged on its content.
    expect(isPlatformNonPotHarness('pot-operator-tools')).toBe(false);
    expect(classifyForRehome({ harness: 'pot-operator-tools', title: 'add a recipe card' }, ENFORCE)).toEqual({
      action: 'hold',
      reason: 'no-platform-signal',
    });
  });
});

/**
 * Unit tests for the explicit harness-scope resolver (_harness-scope.ts).
 * Pure function — covers the arg/ctx precedence + the '*'-as-no-choice rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessRequiredError } from '@papercusp/agent-mcp';
import {
  allowStalePlanRecoveryForMcpCall,
  harnessRequiredResult,
  harnessRequiredDetail,
  harnessScopedCtx,
  isAllHarnessSentinel,
  isEngineeringDocsSentinel,
  resolveConcreteHarnessSlug,
  defaultHarnessScopeInheritanceReaders,
  resolveHarnessScope,
  resolveInheritedHarnessScope,
  stripCallerOperatorScope,
} from './_harness-scope';

const defaultReaderMocks = vi.hoisted(() => ({
  withWorkspace: vi.fn(),
  getClaim: vi.fn(),
  getPresence: vi.fn(),
  getPlanHarnesses: vi.fn(),
  getClaimSpec: vi.fn(),
  getBrief: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: defaultReaderMocks.withWorkspace,
}));
vi.mock('../work-item-claims', () => ({ getActiveClaimForOwner: defaultReaderMocks.getClaim }));
vi.mock('./coordination/presence', () => ({ getPresence: defaultReaderMocks.getPresence }));
vi.mock('./plans/source', () => ({ planHarnessesForSlugs: defaultReaderMocks.getPlanHarnesses }));
vi.mock('../scheduler/claim-spec-store', () => ({ getClaimSpecRecord: defaultReaderMocks.getClaimSpec }));
vi.mock('../session-brief', () => ({ getSessionBrief: defaultReaderMocks.getBrief }));

const emptyReaders = () => ({
  claim: vi.fn(async () => ({})),
  plan: vi.fn(async () => ({})),
  fleet: vi.fn(async () => ({})),
  brief: vi.fn(async () => ({})),
});

describe('isAllHarnessSentinel', () => {
  it('treats * and all (any case) as the sentinel', () => {
    for (const v of ['*', 'all', 'ALL', ' All ']) expect(isAllHarnessSentinel(v)).toBe(true);
  });
  it('treats a real slug / empty / nullish as not-sentinel', () => {
    for (const v of ['papercup', 'restart', '', undefined, null]) expect(isAllHarnessSentinel(v)).toBe(false);
  });
});

describe('stripCallerOperatorScope (EI-20186804943808838)', () => {
  it('drops a caller-supplied operator-scope sentinel in any accepted spelling', () => {
    for (const v of ['*', 'all', 'ALL', ' All ']) {
      expect(stripCallerOperatorScope({ harness: v, plan: 'p' })).toEqual({ plan: 'p' });
    }
  });
  it('leaves a concrete harness untouched — a caller may still scope itself', () => {
    expect(stripCallerOperatorScope({ harness: 'papercusp', plan: 'p' })).toEqual({ harness: 'papercusp', plan: 'p' });
  });
  it('handles an absent context and an absent harness without inventing keys', () => {
    expect(stripCallerOperatorScope(undefined)).toEqual({});
    expect(stripCallerOperatorScope(null)).toEqual({});
    // Typed to match the REAL caller shape (recipes:search's zod-inferred context: `harness`
    // declared optional, simply absent at runtime). The annotation is load-bearing, not
    // decoration — an untyped `{ plan: 'p' }` literal shares no properties with the
    // all-optional constraint, so TS's weak-type check rejects it (TS2559) even though the
    // call is valid. This keeps the case honest: an ABSENT harness key, which is a different
    // input from `harness: undefined`.
    const noHarness: { harness?: string; plan: string } = { plan: 'p' };
    expect(stripCallerOperatorScope(noHarness)).toEqual({ plan: 'p' });
    expect('harness' in noHarness).toBe(false);
  });
  it('removes the key entirely rather than setting it undefined (so a later spread can supply it)', () => {
    // The call site spreads server-derived values AFTER this; a surviving `harness: undefined`
    // key would still be overwritten, but an own-key with undefined would defeat any `??`
    // consumer downstream. Assert the key is genuinely gone.
    expect(Object.keys(stripCallerOperatorScope({ harness: '*', plan: 'p' }))).toEqual(['plan']);
  });
});

describe('isEngineeringDocsSentinel (EI-18894866320087268)', () => {
  it('treats "engineering" (any case, trimmed) as the sentinel', () => {
    for (const v of ['engineering', 'ENGINEERING', ' Engineering ']) expect(isEngineeringDocsSentinel(v)).toBe(true);
  });
  it('does NOT treat all/*/a real slug/empty/nullish as the engineering sentinel', () => {
    for (const v of ['all', '*', 'papercup', 'restart', '', undefined, null]) {
      expect(isEngineeringDocsSentinel(v)).toBe(false);
    }
  });
  it("is a DISTINCT literal from isAllHarnessSentinel — neither predicate double-matches the other's sentinel", () => {
    expect(isAllHarnessSentinel('engineering')).toBe(false);
    expect(isEngineeringDocsSentinel('all')).toBe(false);
    expect(isEngineeringDocsSentinel('*')).toBe(false);
  });
});

describe('resolveHarnessScope', () => {
  it('explicit all arg → { all } (deliberate operator scope)', () => {
    expect(resolveHarnessScope('all', { harnessSlug: undefined })).toEqual({ kind: 'all' });
    expect(resolveHarnessScope('*', { harnessSlug: '*' })).toEqual({ kind: 'all' });
  });

  it('explicit concrete arg → { harness } (wins over ctx)', () => {
    expect(resolveHarnessScope('restart', { harnessSlug: 'papercup' })).toEqual({ kind: 'harness', slug: 'restart' });
  });

  it('no arg + concrete ctx → { harness } (scoped session)', () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: 'papercup' })).toEqual({ kind: 'harness', slug: 'papercup' });
  });

  it("no arg + ctx '*' (auto superuser default) → { none } (must opt in)", () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: '*' })).toEqual({ kind: 'none' });
  });

  it('no arg + unset ctx → { none }', () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: undefined })).toEqual({ kind: 'none' });
    expect(resolveHarnessScope(undefined, null)).toEqual({ kind: 'none' });
  });

  it("no arg + ctx 'all' literal → { none } (ctx all is not an explicit per-call choice)", () => {
    expect(resolveHarnessScope(undefined, { harnessSlug: 'all' })).toEqual({ kind: 'none' });
  });

  it('trims whitespace on the arg', () => {
    expect(resolveHarnessScope('  restart  ', null)).toEqual({ kind: 'harness', slug: 'restart' });
  });
});

describe('resolveInheritedHarnessScope (P-006)', () => {
  it('uses the canonical precedence and stops after the first usable binding', async () => {
    const readers = emptyReaders();
    readers.claim.mockResolvedValue({ harnesses: ['claimed'], refs: ['WI-1'] });
    readers.plan.mockResolvedValue({ harnesses: ['planned'] });

    const result = await resolveInheritedHarnessScope(
      { ownerId: 'su-1', workspaceId: 'ws-1', sessionHarness: 'session' },
      readers,
    );

    expect(result).toMatchObject({ kind: 'harness', slug: 'claimed', source: 'claim' });
    expect(readers.claim).toHaveBeenCalledOnce();
    expect(readers.plan).not.toHaveBeenCalled();
    expect(readers.fleet).not.toHaveBeenCalled();
  });

  it('lets an explicit harness win without consulting durable readers', async () => {
    const readers = emptyReaders();
    const result = await resolveInheritedHarnessScope(
      { explicitHarness: ' explicit ', sessionHarness: 'session' },
      readers,
    );
    expect(result).toMatchObject({ kind: 'harness', slug: 'explicit', source: 'explicit' });
    expect(readers.claim).not.toHaveBeenCalled();
  });

  it('falls through claim, plan, fleet, and brief before using session context', async () => {
    const readers = emptyReaders();
    const result = await resolveInheritedHarnessScope({ sessionHarness: 'session' }, readers);
    expect(result).toMatchObject({ kind: 'harness', slug: 'session', source: 'session' });
    expect(readers.claim).toHaveBeenCalledOnce();
    expect(readers.plan).toHaveBeenCalledOnce();
    expect(readers.fleet).toHaveBeenCalledOnce();
    expect(readers.brief).toHaveBeenCalledOnce();
  });

  it('fails deterministically with every conflicting candidate instead of guessing', async () => {
    const readers = emptyReaders();
    readers.plan.mockResolvedValue({ harnesses: ['alpha', 'beta', 'alpha'], refs: ['plan-a'] });
    const result = await resolveInheritedHarnessScope({}, readers);
    expect(result).toMatchObject({ kind: 'none', reason: 'ambiguous', source: 'plan' });
    expect(result.conflictingBindings.map((binding) => binding.harnessSlug)).toEqual(['alpha', 'beta']);
    expect(result.candidates).toEqual(result.conflictingBindings);
    expect(readers.fleet).not.toHaveBeenCalled();
  });

  it('fails closed on stale bindings and reader errors instead of falling through', async () => {
    const staleReaders = emptyReaders();
    staleReaders.claim.mockResolvedValue({ harnesses: ['old'], stale: true, refs: ['WI-old'] });
    await expect(resolveInheritedHarnessScope({ sessionHarness: 'session' }, staleReaders)).resolves.toMatchObject({
      kind: 'none',
      reason: 'stale',
      source: 'claim',
    });

    const errorReaders = emptyReaders();
    errorReaders.plan.mockRejectedValue(new Error('plan index unavailable'));
    await expect(resolveInheritedHarnessScope({ sessionHarness: 'session' }, errorReaders)).resolves.toMatchObject({
      kind: 'none',
      reason: 'reader_error',
      source: 'plan',
      detail: 'plan index unavailable',
    });
  });

  it('lets an explicit workspace bypass stale ambient bindings without weakening ordinary resolution', async () => {
    const readers = emptyReaders();
    readers.plan.mockResolvedValue({
      harnesses: ['papercusp'],
      refs: ['old-plan'],
      stale: true,
      detail: 'bound plan belongs to another workspace',
    });
    readers.brief.mockResolvedValue({ harnesses: ['scratch-harness'], refs: ['scratch-brief'] });

    await expect(
      resolveInheritedHarnessScope({ ownerId: 'su-1', workspaceId: 'scratch' }, readers),
    ).resolves.toMatchObject({ kind: 'none', reason: 'stale', source: 'plan' });

    await expect(
      resolveInheritedHarnessScope(
        { ownerId: 'su-1', workspaceId: 'scratch', allowStaleAmbientFallback: true },
        readers,
      ),
    ).resolves.toMatchObject({ kind: 'harness', slug: 'scratch-harness', source: 'brief' });
    expect(readers.brief).toHaveBeenCalledOnce();
  });

  it('preserves stored claim-spec warnings on the resolved fleet binding', async () => {
    const readers = emptyReaders();
    readers.fleet.mockResolvedValue({
      harnesses: ['papercusp'],
      refs: ['fleet-a'],
      warnings: ['fleet:fleet-a: ignored future field'],
    });

    await expect(resolveInheritedHarnessScope({}, readers)).resolves.toMatchObject({
      kind: 'harness',
      slug: 'papercusp',
      warnings: ['fleet:fleet-a: ignored future field'],
    });
  });

  it('lets the explicit stale-plan recovery path reach the current fleet binding', async () => {
    const stalePlanReaders = emptyReaders();
    stalePlanReaders.plan.mockResolvedValue({
      stale: true,
      refs: ['retired-plan'],
      detail: 'bound plan no longer resolves',
    });
    stalePlanReaders.fleet.mockResolvedValue({ harnesses: ['papercusp'], refs: ['fleet-slug'] });

    await expect(
      resolveInheritedHarnessScope({ ownerId: 'su-1', workspaceId: 'ws-1' }, stalePlanReaders),
    ).resolves.toMatchObject({ kind: 'none', reason: 'stale', source: 'plan' });
    expect(stalePlanReaders.fleet).not.toHaveBeenCalled();

    const recovered = await resolveInheritedHarnessScope(
      { ownerId: 'su-1', workspaceId: 'ws-1', allowStalePlanFallback: true },
      stalePlanReaders,
    );
    expect(recovered).toMatchObject({ kind: 'harness', slug: 'papercusp', source: 'fleet' });
    expect(recovered.candidates).toEqual([
      { source: 'fleet', harnessSlug: 'papercusp', refs: ['fleet-slug'] },
    ]);
  });

  it('keeps the explicit all sentinel distinct from one-harness inference', async () => {
    const result = await resolveInheritedHarnessScope({ explicitHarness: 'all' }, emptyReaders());
    expect(result).toEqual({ kind: 'all', source: 'explicit', candidates: [], conflictingBindings: [] });
  });
});

describe('default inherited-scope readers (EI-22575830430557187)', () => {
  const input = { ownerId: 'su-1', workspaceId: 'ws-1' };
  const tx = { transaction: true };

  beforeEach(() => {
    vi.clearAllMocks();
    defaultReaderMocks.withWorkspace.mockImplementation(async (_workspaceId, read) => read(tx));
  });

  it('routes claim lookup through one workspace transaction and forwards its tx', async () => {
    defaultReaderMocks.getClaim.mockResolvedValue({
      workspaceId: 'ws-1',
      harnessSlug: 'claimed',
      workItemId: 'WI-1',
      expired: false,
    });

    await expect(defaultHarnessScopeInheritanceReaders.claim(input)).resolves.toEqual({
      harnesses: ['claimed'],
      refs: ['WI-1'],
    });
    expect(defaultReaderMocks.withWorkspace).toHaveBeenCalledOnce();
    expect(defaultReaderMocks.withWorkspace).toHaveBeenCalledWith('ws-1', expect.any(Function));
    expect(defaultReaderMocks.getClaim).toHaveBeenCalledWith('ws-1', 'su-1', tx);
  });

  it('shares one bounded transaction across presence and plan ownership reads', async () => {
    defaultReaderMocks.getPresence.mockResolvedValue({ currentPlanSlug: 'plan-a', workspaceId: 'ws-1' });
    defaultReaderMocks.getPlanHarnesses.mockResolvedValue(new Map([['plan-a', ['planned']]]));

    await expect(defaultHarnessScopeInheritanceReaders.plan(input)).resolves.toEqual({
      harnesses: ['planned'],
      refs: ['plan-a'],
    });
    expect(defaultReaderMocks.withWorkspace).toHaveBeenCalledOnce();
    expect(defaultReaderMocks.getPresence).toHaveBeenCalledWith('su-1', tx);
    expect(defaultReaderMocks.getPlanHarnesses).toHaveBeenCalledWith('ws-1', ['plan-a'], tx);
  });

  it('routes fleet-spec and session-brief lookups through the same bounded seam', async () => {
    defaultReaderMocks.getClaimSpec.mockResolvedValue({
      source: 'fleet',
      harnessSlug: 'fleet-harness',
      fleetSlug: 'fleet-a',
      warnings: ['fleet:fleet-a: ignored future field'],
    });
    await expect(defaultHarnessScopeInheritanceReaders.fleet(input)).resolves.toEqual({
      harnesses: ['fleet-harness'],
      refs: ['fleet-a'],
      warnings: ['fleet:fleet-a: ignored future field'],
    });
    expect(defaultReaderMocks.withWorkspace).toHaveBeenCalledOnce();
    expect(defaultReaderMocks.getClaimSpec).toHaveBeenCalledWith(
      { cupId: 'su-1', workspaceId: 'ws-1' },
      tx,
    );

    defaultReaderMocks.withWorkspace.mockClear();
    defaultReaderMocks.getBrief.mockResolvedValue({ workspaceId: 'ws-1', harnessSlug: 'brief-harness' });
    await expect(defaultHarnessScopeInheritanceReaders.brief(input)).resolves.toEqual({
      harnesses: ['brief-harness'],
      refs: ['su-1'],
    });
    expect(defaultReaderMocks.withWorkspace).toHaveBeenCalledOnce();
    expect(defaultReaderMocks.getBrief).toHaveBeenCalledWith({ ownerId: 'su-1' }, tx);
  });

  it('does not open a transaction until a concrete workspace is available', async () => {
    await expect(defaultHarnessScopeInheritanceReaders.claim({ ownerId: 'su-1' })).resolves.toEqual({});
    expect(defaultReaderMocks.withWorkspace).not.toHaveBeenCalled();
    expect(defaultReaderMocks.getClaim).not.toHaveBeenCalled();
  });

  it('surfaces an acquisition failure to the resolver instead of falling back to a raw read', async () => {
    const failure = new Error('ConnectPhaseDeadlineError');
    defaultReaderMocks.withWorkspace.mockRejectedValue(failure);
    await expect(defaultHarnessScopeInheritanceReaders.claim(input)).rejects.toBe(failure);
    expect(defaultReaderMocks.getClaim).not.toHaveBeenCalled();
  });
});

describe('stale-plan MCP recovery predicate (EI-22589724741483734)', () => {
  it.each([
    ['coord:orient bootstrap', 'coord:orient', {}, true],
    ['fleet leave recovery', 'fleet:leave', {}, true],
    ['fleet step-down recovery alias', 'fleet:step-down', {}, true],
    ['direct omitted self-clear', 'coord:declare-intent', { intent: 'clear stale plan' }, true],
    ['direct null self-clear', 'coord:declare-intent', { intent: 'clear stale plan', current_plan_slug: null }, true],
    [
      'direct blank self-clear with empty lane',
      'coord:declare-intent',
      { intent: 'clear stale plan', current_plan_slug: '   ', items: [] },
      true,
    ],
    ['nonblank plan declaration', 'coord:declare-intent', { intent: 'claim', current_plan_slug: 'plan-a' }, false],
    ['nonempty lane declaration', 'coord:declare-intent', { intent: 'claim', items: ['P-001'] }, false],
    ['invalid items value', 'coord:declare-intent', { intent: 'clear stale plan', items: null }, false],
    ['unrelated tool', 'plans:get', {}, false],
    ['ordinary fleet mutation', 'fleet:join', { fleet: 'old-fleet' }, false],
  ])('%s → %s', (_label, toolName, args, expected) => {
    expect(allowStalePlanRecoveryForMcpCall(toolName, args)).toBe(expected);
  });
});

describe('resolveConcreteHarnessSlug', () => {
  it('concrete arg or ctx → that slug', () => {
    expect(resolveConcreteHarnessSlug('restart', { harnessSlug: 'papercup' })).toBe('restart');
    expect(resolveConcreteHarnessSlug(undefined, { harnessSlug: 'papercup' })).toBe('papercup');
  });

  it("operator '*' auto-default (no arg) → null (NOT silently swallowed as a '*' bucket)", () => {
    expect(resolveConcreteHarnessSlug(undefined, { harnessSlug: '*' })).toBeNull();
  });

  it('unset / null ctx → null', () => {
    expect(resolveConcreteHarnessSlug(undefined, { harnessSlug: undefined })).toBeNull();
    expect(resolveConcreteHarnessSlug(undefined, null)).toBeNull();
  });

  it("explicit 'all' / '*' arg → null (cross-harness scope is not a single harness)", () => {
    expect(resolveConcreteHarnessSlug('all', { harnessSlug: 'papercup' })).toBeNull();
    expect(resolveConcreteHarnessSlug('*', { harnessSlug: 'papercup' })).toBeNull();
  });
});

describe('harnessRequiredResult', () => {
  it('returns a fail-loud isError envelope with a harness_required error code', () => {
    const r = harnessRequiredResult('autoloop:status');
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('harness_required');
    expect(payload.tool).toBe('autoloop:status');
    expect(typeof payload.detail).toBe('string');
  });

  it('omits the tool field when no name is passed', () => {
    const payload = JSON.parse(harnessRequiredResult().content[0].text);
    expect(payload.error).toBe('harness_required');
    expect('tool' in payload).toBe(false);
  });
});

describe('harnessRequiredDetail (P-002 registry-guidance contradiction)', () => {
  it("tells a workspace-scoped caller to use a concrete harness and forbids the doomed 'all' retry", () => {
    const detail = harnessRequiredDetail({ workspaceId: 'workspace-1' });
    expect(detail).toContain("`harness: 'papercusp'`");
    expect(detail).toContain("Do not retry with `harness: 'all'`");
    expect(detail).toContain('harness_forbidden');
  });

  it("allows the 'all' sentinel only for a truly unscoped workspace context", () => {
    const detail = harnessRequiredDetail({ workspaceId: '*' });
    expect(detail).toContain("`harness: 'all'`");
    expect(detail).toContain('--all-workspaces');
    expect(detail).not.toContain('harness_forbidden');
  });
});

describe('harnessScopedCtx', () => {
  it('throws HarnessRequiredError when no harness is resolvable', () => {
    expect(() => harnessScopedCtx(undefined, { harnessSlug: '*' })).toThrow(HarnessRequiredError);
    expect(() => harnessScopedCtx(undefined, { harnessSlug: undefined })).toThrow(HarnessRequiredError);
  });

  it("pins plans:get's workspace-scoped harness_required correction away from harness:'all'", () => {
    expect(() => harnessScopedCtx(undefined, { harnessSlug: '*', workspaceId: 'workspace-1' })).toThrow(
      /Do not retry with `harness: 'all'`.*harness_forbidden/,
    );
  });

  it("'all' arg → ctx with harnessSlug '*' (preserving other ctx fields)", () => {
    expect(harnessScopedCtx('all', { harnessSlug: '*', runId: 'r' })).toEqual({ harnessSlug: '*', runId: 'r' });
  });

  it('concrete arg wins over ctx → ctx with that slug', () => {
    expect(harnessScopedCtx('restart', { harnessSlug: 'papercup' })).toEqual({ harnessSlug: 'restart' });
  });

  it('scoped session (concrete ctx, no arg) → that slug', () => {
    expect(harnessScopedCtx(undefined, { harnessSlug: 'papercup' })).toEqual({ harnessSlug: 'papercup' });
  });
});

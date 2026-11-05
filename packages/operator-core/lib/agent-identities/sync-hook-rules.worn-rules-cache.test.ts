/**
 * readAppliedWornRules caching (portable-identity-packages-2026-09-26 P-011).
 *
 * The pre-tool guard reads the worn rules on EVERY tool call, so only the cheap
 * applied-revision read may stay on that path: a resolved revision is cached by
 * its content-hash key, and an unreadable one is remembered for 30s so a missing
 * launch receipt does not cost every call the expensive artifact read.
 *
 * The cache is process-global (pinModuleState), so every case uses its own owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { appliedRows, readGateSelectedLaunchSpecMock, appliedIdentityArtifactMock } = vi.hoisted(() => ({
  appliedRows: new Map<string, unknown>(),
  readGateSelectedLaunchSpecMock: vi.fn(),
  appliedIdentityArtifactMock: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    // The one query: the owner's applied revision from session_briefs.
    sql: Object.assign(
      async (_strings: TemplateStringsArray, ownerId: string) =>
        appliedRows.has(ownerId) ? [{ applied: appliedRows.get(ownerId) }] : [],
      // Transaction-capable like the production org client (WI-40234); unused on this path.
      { begin: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(undefined) },
    ),
  }),
}));
vi.mock('../agent-tools/coordination/control-anchor', () => ({
  readGateSelectedLaunchSpec: readGateSelectedLaunchSpecMock,
}));
vi.mock('../capability-envelope/identity-grants-port', () => ({
  appliedOrCurrentIdentityArtifact: appliedIdentityArtifactMock,
}));

import { evaluateToolGuard, readAppliedIdentityRules, readAppliedWornRules, setLocalSyncRulesReader, type WornSyncRules } from './sync-hook-rules';
import { evaluateKernelSafetyRails, KERNEL_IDENTITY_ID, KERNEL_INPUT_BOUND_RULE_ID, KERNEL_SAFETY_RAILS } from './kernel-safety-rails';
import { readAppliedIdentityRecall } from './identity-recall';

const ruleArtifact = {
  inputs: [{
    kind: 'package', packageKind: 'rule', ref: 'no-rm', revision: '1.0.0', contentHash: 'h',
    value: { id: 'no-rm', title: 'no-rm', description: 'no-rm rule', version: '1.0.0', ref: 'no-rm',
      delivery: 'sync', sink: 'pre-tool', guard: { deny: { 'input.command': { matches: 'rm -rf' } } } },
  }],
};
const applied = (owner: string, stateRevision = 's1') =>
  appliedRows.set(owner, { specificationRevision: `spec-${owner}`, stateRevision });

beforeEach(() => {
  appliedRows.clear();
  readGateSelectedLaunchSpecMock.mockReset().mockResolvedValue({ launch: true });
  appliedIdentityArtifactMock.mockReset().mockReturnValue(ruleArtifact);
});
afterEach(() => {
  setLocalSyncRulesReader(null);
  vi.restoreAllMocks();
});

describe('authoritative identity read timing', () => {
  it('attributes revision, artifact and local reads while preserving revision freshness and caching', async () => {
    applied('owner-read-timing');
    const local = vi.fn(async () => ({ rules: [], unreadable: [] }));
    setLocalSyncRulesReader(local);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now += 5);
    const observe = vi.fn();
    await readAppliedWornRules('owner-read-timing', 'ws', observe);
    expect(observe.mock.calls.map(([timing]) => timing)).toEqual([
      { stage: 'applied_revision', durationMs: 5 },
      { stage: 'applied_artifact', durationMs: 5 },
      { stage: 'local_rules', durationMs: 5 },
    ]);
    await readAppliedWornRules('owner-read-timing', 'ws', observe);
    expect(readGateSelectedLaunchSpecMock).toHaveBeenCalledTimes(1);
    applied('owner-read-timing', 's2');
    await readAppliedWornRules('owner-read-timing', 'ws', observe);
    expect(readGateSelectedLaunchSpecMock).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls.filter(([timing]) => timing.stage === 'applied_revision')).toHaveLength(3);
    expect(local).toHaveBeenCalledTimes(3);
  });

  it('keeps a throwing observer from changing a refusal or replacing a read failure', async () => {
    applied('owner-read-timing-failure');
    const observe = vi.fn(() => { throw new Error('diagnostic sink failed'); });
    const pending = { tool: 'Bash', input: { command: 'rm -rf build' }, client: 'claude' };
    expect(await evaluateToolGuard(pending, () => readAppliedWornRules('owner-read-timing-failure', 'ws', observe)))
      .toMatchObject({ decision: 'deny', ruleId: 'no-rm' });
    const failure = new Error('local authoritative read failed');
    setLocalSyncRulesReader(async () => { throw failure; });
    await expect(readAppliedWornRules('owner-read-timing-failure', 'ws', observe)).rejects.toBe(failure);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'local_rules' }));
  });

  it('reports only the revision read when no identity is applied', async () => {
    const local = vi.fn(async () => ({ rules: [], unreadable: [] }));
    setLocalSyncRulesReader(local);
    const observe = vi.fn();
    expect(await readAppliedWornRules('owner-read-timing-none', 'ws', observe)).toBeNull();
    expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stage: 'applied_revision' }));
    expect(local).not.toHaveBeenCalled();
    expect(readGateSelectedLaunchSpecMock).not.toHaveBeenCalled();
  });
});

describe('readAppliedWornRules', () => {
  it('copies the exact APPLIED package pins without reading mutable sources or later revisions', async () => {
    applied('owner-package-pins');
    const packages = [{ kind: 'package', packageKind: 'blueprint', ref: 'paid', revision: '1.0.0', contentHash: 'old' },
      { kind: 'package', packageKind: 'recipe', ref: 'dependency', revision: '2', contentHash: 'dep' }];
    appliedIdentityArtifactMock.mockReturnValue({ inputs: packages });
    const worn = await readAppliedIdentityRules('owner-package-pins', 'ws');
    packages[0]!.contentHash = 'new';
    expect(worn?.packagePins).toEqual([
      { packageKind: 'blueprint', ref: 'paid', revision: '1.0.0', contentHash: 'old' },
      { packageKind: 'recipe', ref: 'dependency', revision: '2', contentHash: 'dep' },
    ]);
    expect(readGateSelectedLaunchSpecMock).toHaveBeenCalledWith(expect.anything(), 'owner-package-pins', 'ws',
      [{ specificationRevision: 'spec-owner-package-pins', stateRevision: 's1' }]);
  });
  it('is null, without an artifact read, when nothing is applied', async () => {
    expect(await readAppliedWornRules('owner-none', 'ws')).toBeNull();
    expect(readGateSelectedLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('resolves an applied revision once, and again only when the revision moves', async () => {
    applied('owner-cache');
    const first = await readAppliedWornRules('owner-cache', 'ws');
    expect(first?.rules.map((entry) => entry.rule.id)).toEqual(['no-rm']);
    expect(await readAppliedWornRules('owner-cache', 'ws')).toBe(first);
    expect(readGateSelectedLaunchSpecMock).toHaveBeenCalledTimes(1);

    applied('owner-cache', 's2');
    await readAppliedWornRules('owner-cache', 'ws');
    expect(readGateSelectedLaunchSpecMock).toHaveBeenCalledTimes(2);
    expect(appliedIdentityArtifactMock).toHaveBeenLastCalledWith({ launch: true },
      { specificationRevision: 'spec-owner-cache', stateRevision: 's2' });
    // WI-10004801: the launch record is read narrowed to exactly that pair's
    // receipt, never whole (a whole record reached 13 MB of identityHistory).
    expect(readGateSelectedLaunchSpecMock).toHaveBeenLastCalledWith(expect.anything(), 'owner-cache', 'ws',
      [{ specificationRevision: 'spec-owner-cache', stateRevision: 's2' }]);
  });

  it('remembers an unreadable revision for 30s, then reads it again', async () => {
    applied('owner-unreadable');
    appliedIdentityArtifactMock.mockReturnValue(null);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    await expect(readAppliedWornRules('owner-unreadable', 'ws')).rejects.toThrow('unreadable');
    await expect(readAppliedWornRules('owner-unreadable', 'ws')).rejects.toThrow('unreadable');
    expect(readGateSelectedLaunchSpecMock).toHaveBeenCalledTimes(1);

    // The receipt landed after the control state moved: past the TTL it resolves.
    appliedIdentityArtifactMock.mockReturnValue(ruleArtifact);
    now.mockReturnValue(1_000_000 + 30_001);
    expect((await readAppliedWornRules('owner-unreadable', 'ws'))?.rules).toHaveLength(1);
    expect(readGateSelectedLaunchSpecMock).toHaveBeenCalledTimes(2);
  });
});

/*
 * identity-system-everything-migration-2026-10-18 P-012 (R-19): the recall bounds
 * both recall ports run under are read from the APPLIED artifact, the same receipt
 * the worn guards read.
 */
describe('readAppliedIdentityRecall', () => {
  it("returns the applied artifact's declared bounds", async () => {
    applied('owner-recall');
    appliedIdentityArtifactMock.mockReturnValue({ ...ruleArtifact,
      configuration: { recall: { budgetShare: 0.25, memoryScopes: ['hive'], corpora: ['doc'] } } });
    expect(await readAppliedIdentityRecall('owner-recall', 'ws'))
      .toEqual({ budgetShare: 0.25, memoryScopes: ['hive'], corpora: ['doc'] });
  });
  it('is null when nothing is applied, or the applied identity declares no bounds', async () => {
    expect(await readAppliedIdentityRecall('owner-recall-none', 'ws')).toBeNull();
    applied('owner-recall-undeclared');
    expect(await readAppliedIdentityRecall('owner-recall-undeclared', 'ws')).toBeNull();
  });
  it('throws when an identity is applied but its artifact cannot be read', async () => {
    applied('owner-recall-unreadable');
    appliedIdentityArtifactMock.mockReturnValue(null);
    await expect(readAppliedIdentityRecall('owner-recall-unreadable', 'ws')).rejects.toThrow('unreadable');
  });
});

/*
 * R-11 (identity-system-everything-migration-2026-10-18 P-004): every listed
 * safety rail refuses a violating call whatever the session wears — no identity
 * package, a broken one, a read that throws — and before any worn read, so no
 * budget or worn state can drop it.
 */
describe('always-worn kernel safety rails (R-11)', () => {
  const bash = (command: string) => ({ tool: 'Bash', input: { command }, client: 'claude' });
  /** One violating call per listed rail, keyed by rail id. */
  const VIOLATIONS: Record<string, { tool: string; input: unknown; client: string }[]> = {
    'kernel:git-reset-hard': [
      bash('git reset --hard'),
      bash('cd /repo && git -C libs/papercusp reset --hard HEAD~1'),
      { tool: 'mcp__papercusp-su__capability_bash', input: { cmd: 'sudo -n git reset --hard origin/staging' }, client: 'claude' },
    ],
    'kernel:git-clean-force': [bash('git clean -fd'), bash('echo x; nohup git clean -xfd')],
    'kernel:git-checkout-all': [bash('git checkout .'), bash('git checkout -- :/'), bash('git restore .')],
    'kernel:git-stash': [
      bash('git stash'),
      bash('git stash pop'),
      { tool: 'exec_command', input: { cmd: 'git stash push -- src/a.ts' }, client: 'codex' },
      // WI-6554700010017558: drop/clear delete shared-stack entries; branch
      // switches the shared tree's branch. Only list/show are exempt.
      bash('git stash drop'),
      bash('git stash clear'),
      bash('git stash branch wip-x'),
      bash('git stash listx'),
    ],
  };

  const broken: WornSyncRules = { rules: [], unreadable: [{ identityId: 'broken-pack', pinRef: 'broken-pack', error: 'bad manifest' }] };
  // A package whose guard parses but cannot evaluate (an invalid pattern).
  const corrupted = {
    rules: [{ identityId: 'corrupt-pack', pinRef: 'corrupt-pack',
      rule: { id: 'corrupt', delivery: 'sync', sink: 'pre-tool', guard: { deny: { tool: { matches: '(' } }, reason: 'x' } } }],
    unreadable: [],
  } as unknown as WornSyncRules;
  const WORN_STATES: { name: string; read: () => Promise<WornSyncRules | null> }[] = [
    { name: 'no identity package (nothing applied)', read: async () => null },
    { name: 'the worn-rules read throws', read: async () => { throw new Error('db down'); } },
    { name: 'a broken identity package', read: async () => broken },
    { name: 'a corrupted identity package', read: async () => corrupted },
    { name: 'an empty identity package', read: async () => ({ rules: [], unreadable: [] }) },
  ];

  it('the listed rails are exactly the four shared-tree git rails, never an empty list', () => {
    expect(KERNEL_SAFETY_RAILS.map((rail) => rail.id).sort()).toEqual([
      'kernel:git-checkout-all', 'kernel:git-clean-force', 'kernel:git-reset-hard', 'kernel:git-stash',
    ]);
  });

  it('lists a violating call for every rail, so a new rail cannot ship untested', () => {
    expect(Object.keys(VIOLATIONS).sort()).toEqual(KERNEL_SAFETY_RAILS.map((rail) => rail.id).sort());
  });

  for (const [ruleId, calls] of Object.entries(VIOLATIONS)) {
    for (const state of WORN_STATES) {
      it(`${ruleId} refuses with ${state.name}, before any worn read`, async () => {
        for (const call of calls) {
          const read = vi.fn(state.read);
          const verdict = await evaluateToolGuard(call, read);
          expect(verdict, JSON.stringify(call)).toMatchObject({ decision: 'deny', identityId: KERNEL_IDENTITY_ID, ruleId });
          expect(read).not.toHaveBeenCalled();
        }
      });
    }
  }

  it('the worn guards still run after the rails pass (the real applied read, absent and present)', async () => {
    const call = bash('rm -rf build');
    expect(await evaluateToolGuard(call, () => readAppliedWornRules('owner-r11-none', 'ws'))).toEqual({ decision: 'none' });
    applied('owner-r11-worn');
    expect(await evaluateToolGuard(call, () => readAppliedWornRules('owner-r11-worn', 'ws')))
      .toMatchObject({ decision: 'deny', identityId: 'no-rm' });
  });

  it.each([
    bash('git status'),
    bash('git stash list'),
    bash('git stash show -p'),
    bash('git reset HEAD~1'),
    bash('git checkout main'),
    bash('git clean -n'),
    bash('echo "never git reset --hard"'),
    { tool: 'Edit', input: { command: 'git reset --hard' }, client: 'claude' },
  ])('does not refuse a call no rail lists: %j', (call) => {
    expect(evaluateKernelSafetyRails(call)).toEqual({ decision: 'none' });
  });

  it('a rail that cannot evaluate refuses (fail closed)', () => {
    const throwing = [{ id: 'kernel:bad', reason: 'x', deny: { tool: { matches: '(' } } }];
    expect(evaluateKernelSafetyRails(bash('ls'), throwing)).toMatchObject({ decision: 'deny', ruleId: 'kernel:bad' });
  });

  /*
   * The guard input bound is a budget: over it the adapter drops the input and
   * flags the call. No rail may be dropped by it, so a cut call to a tool a rail
   * reads is refused rather than passed unread.
   */
  describe('a call over the guard input bound (the input budget is exhausted)', () => {
    const cut = (tool: string) => ({ tool, input: null, client: 'claude', inputTruncated: true });
    const SHELL_TOOLS = ['Bash', 'exec_command', 'shell_command', 'shell', 'capability:bash', 'mcp__papercusp-su__capability_bash'];

    for (const rail of KERNEL_SAFETY_RAILS) {
      it(`${rail.id} alone refuses a cut input to every shell tool`, () => {
        for (const tool of SHELL_TOOLS) {
          expect(evaluateKernelSafetyRails(cut(tool), [rail]), tool).toEqual({
            decision: 'deny', identityId: KERNEL_IDENTITY_ID, ruleId: KERNEL_INPUT_BOUND_RULE_ID,
            reason: expect.stringContaining(rail.id),
          });
        }
      });
    }

    for (const state of WORN_STATES) {
      it(`a cut shell input is refused with ${state.name}, before any worn read`, async () => {
        const read = vi.fn(state.read);
        const verdict = await evaluateToolGuard(cut('Bash'), read);
        expect(verdict).toMatchObject({ decision: 'deny', identityId: KERNEL_IDENTITY_ID, ruleId: KERNEL_INPUT_BOUND_RULE_ID });
        expect(read).not.toHaveBeenCalled();
      });
    }

    it('names every rail the cut input hides from', () => {
      const verdict = evaluateKernelSafetyRails(cut('Bash'));
      for (const rail of KERNEL_SAFETY_RAILS) expect(verdict).toMatchObject({ reason: expect.stringContaining(rail.id) });
    });

    it('leaves a cut input to a tool no rail reads to the worn guards', () => {
      expect(evaluateKernelSafetyRails(cut('Write'))).toEqual({ decision: 'none' });
    });
  });
});

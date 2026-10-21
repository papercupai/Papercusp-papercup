/**
 * Worn sync hook rules (portable-identity-packages-2026-09-26 P-011; D-023 §3-5).
 *
 * The guard half is pure and fail-closed, so it is tested directly against
 * artifact-shaped inputs. The context half runs the REAL sink evaluator with the
 * provider and anchor reads as seams, so budget, omission and fence behaviour
 * come from the production evaluator rather than a restatement of it.
 */
import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSinkEvaluatorForTests } from './sink-evaluator';
import {
  dueSyncContextRules, evaluateHookContextSink, evaluatePreToolGuards, memoryHookTurnStore,
  isPapercuspEngineerIdentity, ruleMatchesTool, turnStartSyncRuleRequests, wearsPapercuspEngineer,
  wornSyncRules, type WornSyncRules,
} from './sync-hook-rules';
import { evaluateTurnStartPackageSink, packageSinkReceipt } from './turn-start-package-sink';

afterEach(() => resetSinkEvaluatorForTests());

const meta = (id: string) => ({ id, title: id, description: `${id} rule`, version: '1.0.0', ref: id });
const guardPin = (id: string, guard: Record<string, unknown>, tools?: string[]) => ({
  kind: 'package', packageKind: 'rule', ref: id, revision: '1.0.0', contentHash: `h-${id}`,
  value: { ...meta(id), delivery: 'sync', sink: 'pre-tool', ...(tools ? { tools } : {}), guard },
});
const contextPin = (id: string, sink: string, extra: Record<string, unknown> = {}) => ({
  kind: 'package', packageKind: 'rule', ref: id, revision: '1.0.0', contentHash: `h-${id}`,
  value: { ...meta(id), delivery: 'sync', sink,
    context: { ref: 'memory.recall@1', verb: 'recall', tokenBudget: 300, priority: 10, overBudget: 'truncate' }, ...extra },
});
const layer = (ref: string, rules: string[]) => ({
  kind: 'package', packageKind: 'blueprint', ref, revision: '1', contentHash: `h-${ref}`, value: {},
  dependencies: rules.map((rule) => ({ packageKind: 'rule', ref: rule, revision: '1.0.0', contentHash: `h-${rule}` })),
});
const artifact = (...inputs: unknown[]) => ({ inputs }) as never;
const call = (tool: string, input: unknown = {}) => ({ tool, input, client: 'claude' });

describe('wornSyncRules', () => {
  it('reads sync rule pins, attributes them to the pinning layer and skips async rules', () => {
    const worn = wornSyncRules(artifact(
      layer('safe-coder', ['no-rm']),
      guardPin('no-rm', { deny: { 'input.command': { matches: 'rm -rf' } } }),
      { kind: 'package', packageKind: 'rule', ref: 'notify', revision: '1.0.0', contentHash: 'h',
        value: { ...meta('notify'), delivery: 'async', on: 'coord:handoff', fire: 'class:notice.send@1.0.0#send' } },
    ));
    expect(worn.unreadable).toEqual([]);
    expect(worn.rules).toEqual([expect.objectContaining({ identityId: 'safe-coder', pinRef: 'no-rm' })]);
  });

  it('recognizes the engineer layer in bare and slot-qualified applied identities only', () => {
    expect(isPapercuspEngineerIdentity('papercusp-engineer')).toBe(true);
    expect(isPapercuspEngineerIdentity('domain:papercusp-engineer')).toBe(true);
    expect(isPapercuspEngineerIdentity('domain:researcher')).toBe(false);
    expect(wearsPapercuspEngineer({ packagePins: [
      { packageKind: 'blueprint', ref: 'domain:papercusp-engineer', revision: '1', contentHash: 'h' },
    ] })).toBe(true);
    expect(wearsPapercuspEngineer({ packagePins: [
      { packageKind: 'blueprint', ref: 'researcher', revision: '1', contentHash: 'h' },
    ] })).toBe(false);
  });

  it('keeps a pin that no longer parses as unreadable, named', () => {
    const worn = wornSyncRules(artifact(layer('l', ['bad']), { ...guardPin('bad', {}), value: { ...meta('bad'), delivery: 'sync' } }));
    expect(worn.rules).toEqual([]);
    expect(worn.unreadable).toEqual([expect.objectContaining({ identityId: 'l', pinRef: 'bad' })]);
  });
});

describe('evaluatePreToolGuards (fail closed, deny-only)', () => {
  const worn = (...pins: unknown[]): WornSyncRules => wornSyncRules(artifact(layer('coder', ['x']), ...pins));

  it('refuses when deny holds and names the identity and rule', () => {
    const rules = worn(guardPin('no-rm', { deny: { 'input.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' }));
    expect(evaluatePreToolGuards(rules, call('capability:bash', { command: 'rm -rf /' })))
      .toEqual({ decision: 'deny', identityId: 'no-rm', ruleId: 'no-rm', reason: 'no recursive deletes' });
    expect(evaluatePreToolGuards(rules, call('capability:bash', { command: 'ls' }))).toEqual({ decision: 'none' });
  });

  it('refuses outside allowOnly, and applies only to matching tools', () => {
    const rules = worn(guardPin('read-only-fs', { allowOnly: { 'input.mode': 'read' } }, ['fs:*']));
    expect(evaluatePreToolGuards(rules, call('fs:open', { mode: 'write' }))).toMatchObject({ decision: 'deny', ruleId: 'read-only-fs' });
    expect(evaluatePreToolGuards(rules, call('fs:open', { mode: 'read' }))).toEqual({ decision: 'none' });
    expect(evaluatePreToolGuards(rules, call('coord:send', { mode: 'write' }))).toEqual({ decision: 'none' });
  });

  // Every way a guard can fail to prove a call allowed, with the refusal the real evaluator owes.
  const failClosedScenarios = () => [
    // An invalid pattern is an author bug the matcher throws on at evaluation.
    { name: 'evaluation throws', rules: worn(guardPin('broken', { deny: { 'input.command': { matches: '[' } } })),
      pending: call('capability:bash', { command: 'ls' }), refusal: { ruleId: 'broken' } },
    { name: 'input cut', rules: worn(guardPin('no-rm', { deny: { 'input.command': { matches: 'rm -rf' } } })),
      pending: { ...call('capability:bash', { command: 'ls' }), inputTruncated: true },
      refusal: { ruleId: 'no-rm', reason: expect.stringContaining('exceeds') } },
    { name: 'pin unreadable', rules: wornSyncRules(artifact(layer('coder', ['bad']), { ...guardPin('bad', {}), value: null })),
      pending: call('anything'), refusal: { identityId: 'coder', ruleId: 'bad' } },
  ];
  const openings = (evaluate: typeof evaluatePreToolGuards) => failClosedScenarios()
    .filter(({ rules, pending }) => evaluate(rules, pending).decision !== 'deny').map(({ name }) => name);

  // Falsifiability control, kept permanently: the natural fail-OPEN bug. It
  // evaluates guards like the real one but swallows a throw and ignores both
  // the cut-input flag and unreadable pins.
  const failOpenControl: typeof evaluatePreToolGuards = (rules, pending) => {
    const event = { tool: pending.tool, input: pending.input, client: pending.client };
    for (const { identityId, rule } of rules.rules) {
      if (rule.sink !== 'pre-tool' || !rule.guard || !ruleMatchesTool(rule.tools, pending.tool)) continue;
      try {
        if (rule.guard.deny !== undefined && evaluateDataCondition(rule.guard.deny as DataCondition, event)) {
          return { decision: 'deny', identityId, ruleId: rule.id, reason: 'control' };
        }
      } catch { /* the bug under control: a throw reads as no refusal */ }
    }
    return { decision: 'none' };
  };

  it('refuses when evaluation throws, when input was cut, and when a worn pin no longer parses', () => {
    for (const { rules, pending, refusal } of failClosedScenarios()) {
      expect(evaluatePreToolGuards(rules, pending)).toMatchObject({ decision: 'deny', ...refusal });
    }
    expect(openings(evaluatePreToolGuards)).toEqual([]);
  });

  it('catches a fail-open evaluator in each of those scenarios (falsifiability control)', () => {
    // Calibration: the control agrees with the real evaluator wherever evaluation succeeds...
    const plain = worn(guardPin('no-rm', { deny: { 'input.command': { matches: 'rm -rf' } } }));
    for (const command of ['rm -rf /', 'ls']) {
      expect(failOpenControl(plain, call('capability:bash', { command })).decision)
        .toBe(evaluatePreToolGuards(plain, call('capability:bash', { command })).decision);
    }
    // ...so each scenario alone is what tells them apart.
    expect(openings(failOpenControl)).toEqual(['evaluation throws', 'input cut', 'pin unreadable']);
  });

  it('never approves: the only verdicts are deny and none', () => {
    const rules = worn(guardPin('allow-all', { allowOnly: { tool: { exists: true } } }));
    const verdict = evaluatePreToolGuards(rules, call('capability:bash'));
    expect(verdict).toEqual({ decision: 'none' });
    expect(Object.keys(verdict)).toEqual(['decision']);
  });
});

describe('tool filters and due context rules', () => {
  it('matches names and trailing-star prefixes', () => {
    expect(ruleMatchesTool(undefined, 'x')).toBe(true);
    expect(ruleMatchesTool(['fs:*'], 'fs:read')).toBe(true);
    expect(ruleMatchesTool(['fs:read'], 'fs:readdir')).toBe(false);
  });

  it('selects context rules by sink, and by the batch tools at post-tool', () => {
    const worn = wornSyncRules(artifact(
      contextPin('at-stop', 'stop'), contextPin('after-bash', 'post-tool', { tools: ['capability:bash'] }),
      guardPin('g', { deny: { tool: 'x' } }),
    ));
    expect(dueSyncContextRules(worn, 'stop').map((r) => r.rule.id)).toEqual(['at-stop']);
    expect(dueSyncContextRules(worn, 'post-tool', ['coord:send'])).toEqual([]);
    expect(dueSyncContextRules(worn, 'post-tool', ['capability:bash']).map((r) => r.rule.id)).toEqual(['after-bash']);
  });
});

describe('evaluateHookContextSink (fail open, visibly)', () => {
  const wearer = { stack: ['identity:coder'], attachmentRevision: 'spec:state', potSlug: 'pot' };
  const worn = wornSyncRules(artifact(layer('coder', ['a', 'b']), contextPin('a', 'stop'), contextPin('b', 'stop')));

  it('can reserve a PostToolUse sink for the papercusp-engineer identity', async () => {
    const nonEngineer = wornSyncRules(artifact(
      layer('researcher', ['a']), contextPin('a', 'post-tool'),
    ));
    const engineer = wornSyncRules(artifact(
      layer('papercusp-engineer', ['a']), contextPin('a', 'post-tool'),
    ));
    const deps = {
      readWearer: async () => wearer,
      turns: memoryHookTurnStore(),
      produceContext: async () => 'engineering advisory',
    };
    const quiet = await evaluateHookContextSink({
      ownerId: 'su-hooks-engineering-quiet', workspaceId: 'w', sink: 'post-tool',
      tools: ['capability:bash'], engineeringOnly: true,
      deps: { ...deps, readWornRules: async () => nonEngineer },
    });
    expect(quiet.text).toBe('');
    const loud = await evaluateHookContextSink({
      ownerId: 'su-hooks-engineering-loud', workspaceId: 'w', sink: 'post-tool',
      tools: ['capability:bash'], engineeringOnly: true,
      deps: { ...deps, readWornRules: async () => engineer },
    });
    expect(loud.text).toContain('engineering advisory');
  });

  it('delivers provider text and renders a failed provider as an omission marker', async () => {
    const out = await evaluateHookContextSink({
      ownerId: 'su-hooks-1', workspaceId: 'w', sink: 'stop',
      deps: {
        readWearer: async () => wearer, readWornRules: async () => worn, turns: memoryHookTurnStore(),
        produceContext: async ({ contribution }) => {
          if (contribution.id === 'b') throw new Error('provider down');
          return 'recalled context';
        },
      },
    });
    expect(out.text).toContain('recalled context');
    expect(out.text).toContain('⟦coder/b omitted: provider-error⟧');
    expect(out.result?.invocation.sink).toBe('stop');
  });

  it('fences a result evaluated against an attachment the wearer has since left', async () => {
    let revision = 'spec:state';
    const out = await evaluateHookContextSink({
      ownerId: 'su-hooks-2', workspaceId: 'w', sink: 'stop',
      deps: {
        readWearer: async () => ({ ...wearer, attachmentRevision: revision }),
        readWornRules: async () => worn, turns: memoryHookTurnStore(),
        produceContext: async () => { revision = 'spec:moved'; return 'stale'; },
      },
    });
    expect(out.text).toBe('');
  });

  it('shares the turn ceiling across sinks served by different workers (D-024)', async () => {
    const owner = 'su-hooks-3';
    const turns = memoryHookTurnStore();
    const { turnId } = await turns.begin(owner, 'w');
    const deps = {
      readWearer: async () => wearer, readWornRules: async () => worn, turns,
      produceContext: async () => 'x'.repeat(1_200),
      limits: { sinkBudget: { tokens: 400, wallClockMs: 750 }, turnCeiling: { tokens: 500, wallClockMs: 5_000 }, perSessionConcurrency: 2 },
    };
    const first = await evaluateHookContextSink({ ownerId: owner, workspaceId: 'w', sink: 'stop', deps });
    // A second worker has never seen this turn: only the shared store carries the spend.
    resetSinkEvaluatorForTests();
    const second = await evaluateHookContextSink({ ownerId: owner, workspaceId: 'w', sink: 'stop', deps });
    expect(first.result!.budget.tokens).toBe(400);
    expect(first.result!.deliveredTokens).toBeGreaterThan(0);
    expect(second.result!.budget.tokens).toBeLessThanOrEqual(500 - first.result!.deliveredTokens);
    expect(second.result!.invocation.turnId).toBe(turnId);
    expect((await turns.current(owner, 'w')).tokensSpent)
      .toBe(first.result!.deliveredTokens + second.result!.deliveredTokens);
  });

  it('a compaction opens a fresh turn, and a late charge to the old turn is ignored', async () => {
    const turns = memoryHookTurnStore();
    const before = await turns.begin('su-hooks-5', 'w');
    const out = await evaluateHookContextSink({
      ownerId: 'su-hooks-5', workspaceId: 'w', sink: 'compaction',
      deps: { readWearer: async () => wearer, readWornRules: async () => wornSyncRules(artifact(contextPin('c', 'compaction'))),
        turns, produceContext: async () => 'restored' },
    });
    expect(out.result!.invocation.turnId).not.toBe(before.turnId);
    const spent = await turns.current('su-hooks-5', 'w');
    await turns.charge('su-hooks-5', 'w', before.turnId, { tokens: 999, ms: 999 });
    expect(await turns.current('su-hooks-5', 'w')).toEqual(spent);
  });

  it('meters the time sinks took, not time since the turn began (D-024)', async () => {
    const owner = 'su-hooks-7';
    const turns = memoryHookTurnStore();
    await turns.begin(owner, 'w');
    const limits = { sinkBudget: { tokens: 400, wallClockMs: 750 }, turnCeiling: { tokens: 800, wallClockMs: 1_500 }, perSessionConcurrency: 2 };
    const deps = { readWearer: async () => wearer, readWornRules: async () => worn, turns, produceContext: async () => 'ctx', limits };
    // A turn already a minute old whose earlier sinks took 1.2s between them.
    const { turnId } = await turns.current(owner, 'w');
    await turns.charge(owner, 'w', turnId, { tokens: 0, ms: 1_200 });
    resetSinkEvaluatorForTests();
    const late = await evaluateHookContextSink({ ownerId: owner, workspaceId: 'w', sink: 'stop', deps });
    expect(late.result!.budget.wallClockMs).toBe(300);
    expect(late.text).toContain('ctx');
    expect((await turns.current(owner, 'w')).msSpent).toBe(1_200 + late.result!.elapsedMs);
    // Once the summed time reaches the ceiling, a further sink gets none.
    await turns.charge(owner, 'w', turnId, { tokens: 0, ms: 1_500 });
    resetSinkEvaluatorForTests();
    const spent = await evaluateHookContextSink({ ownerId: owner, workspaceId: 'w', sink: 'stop', deps });
    expect(spent.result!.budget).toMatchObject({ wallClockMs: 0, tokens: 0 });
    expect(spent.result!.started).toBe(0);
    expect(spent.result!.omissions.map((row) => row.reason)).toEqual(['budget-exhausted', 'budget-exhausted']);
  });

  it('degrades to nothing when the worn rules cannot be read', async () => {
    const out = await evaluateHookContextSink({
      ownerId: 'su-hooks-4', workspaceId: 'w', sink: 'compaction',
      deps: { readWearer: async () => wearer, readWornRules: async () => { throw new Error('db down'); }, turns: memoryHookTurnStore() },
    });
    expect(out).toEqual({ text: '', result: null, error: 'db down' });
  });

  it('delivers nothing when the shared turn is unreachable', async () => {
    const unreachable = { ...memoryHookTurnStore(), current: async () => { throw new Error('pg down'); } };
    const out = await evaluateHookContextSink({
      ownerId: 'su-hooks-6', workspaceId: 'w', sink: 'stop',
      deps: { readWearer: async () => wearer, readWornRules: async () => worn, turns: unreachable, produceContext: async () => 'x' },
    });
    expect(out).toMatchObject({ text: '', result: null, error: expect.stringContaining('hook turn unavailable') });
  });
});

describe('turn start: worn rules join the package sink invocation', () => {
  const wearer = { stack: ['identity:coder'], attachmentRevision: 'spec:state', potSlug: 'pot' };
  const blueprintContribution = {
    id: 'bp', ref: 'memory.recall@1', verb: 'recall',
    injection: { tokenBudget: 300, priority: 5, overBudget: 'truncate' as const },
  };
  const worn = wornSyncRules(artifact(layer('coder', ['r']), contextPin('r', 'turn-start'), contextPin('s', 'stop')));
  const packageDeps = {
    readWearer: async () => wearer,
    readDueContributions: async () => [blueprintContribution],
    produceContext: async ({ contribution }: { contribution: { id: string } }) => `from ${contribution.id}`,
  };

  it('evaluates blueprint and rule contributions under ONE budget, turn-start rules only', async () => {
    const sink = await evaluateTurnStartPackageSink({
      ownerId: 'su-hooks-ts-1', workspaceId: 'w', turnId: 'turn-1',
      deps: {
        ...packageDeps,
        readRuleRequests: (call) => turnStartSyncRuleRequests({ ...call, readWornRules: async () => worn }),
      },
    });
    expect(sink.result!.allocation.map((slot) => `${slot.identityId}/${slot.contributionId}`).sort())
      .toEqual(['coder/bp', 'coder/r']);
    expect(sink.result!.deliveries.map((row) => row.text).sort()).toEqual(['from bp', 'from r']);
    expect(sink.rulesError).toBeUndefined();
  });

  it('keeps the blueprint half and records the error when worn rules cannot be read', async () => {
    const sink = await evaluateTurnStartPackageSink({
      ownerId: 'su-hooks-ts-2', workspaceId: 'w', turnId: 't',
      deps: { ...packageDeps, readRuleRequests: async () => { throw new Error('applied identity artifact unreadable'); } },
    });
    expect(sink.result!.deliveries.map((row) => row.contributionId)).toEqual(['bp']);
    expect(sink.rulesError).toBe('applied identity artifact unreadable');
    expect(packageSinkReceipt(sink)).toMatchObject({ rulesError: 'applied identity artifact unreadable' });
  });

  it('adds nothing for a session that wears no identity', async () => {
    expect(await turnStartSyncRuleRequests({
      ownerId: 'o', workspaceId: 'w', wearer, produceContext: async () => 'x', readWornRules: async () => null,
    })).toEqual([]);
  });
});

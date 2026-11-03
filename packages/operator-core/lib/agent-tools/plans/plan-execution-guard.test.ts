import { describe, expect, it, vi } from 'vitest';
import { checkPlanExecutionGuard, isPlanImplementationCall, isPlanResearchCommand, planExecutionMeaning } from './plan-execution-guard';
import { resolveAgentGoal } from '../../agent-goal-ref';

const call = (toolName = 'apply_patch', args: unknown = { patch: 'implementation' }) =>
  ({ ownerId: 'su-builder', workspaceId: 'ws', toolName, args });
const binding = { planSlug: 'bound-plan', harnessSlug: 'project' };

describe('implementation authority before direct writes (EI-27540173897381380)', () => {
  it.each(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'capability:edit', 'capability:write', 'locks:acquire',
    'locks:acquire_granular', 'code:run', 'capability:bash', 'exec_command', 'shell', 'Bash',
    'mcp__papercusp_su__capability_edit', 'capability:launch-agent', 'fleet:launch-on-plan', 'plans:run-now'])('denies %s for a bound draft despite ad-hoc work/force/AUTO', async tool => {
    const result = await checkPlanExecutionGuard(call(tool, { force: true, purpose: 'repair', plan: 'another', mode: 'auto' }), {
      readBindings: async () => [binding], checkPlan: async () => ['plan_status:draft'],
    });
    expect(result).toMatchObject({ code: 'plan_execution_not_ready', planSlug: binding.planSlug });
    expect(result?.reason).toContain('plans:start');
  });
  it('allows an executable plan and a genuinely unbound single-item fix', async () => {
    expect(await checkPlanExecutionGuard(call(), { readBindings: async () => [binding], checkPlan: async () => [] })).toBeNull();
    const checkPlan = vi.fn();
    expect(await checkPlanExecutionGuard(call(), { readBindings: async () => [], checkPlan })).toBeNull();
    expect(checkPlan).not.toHaveBeenCalled();
  });
  it.each(['activation_audit_stale', 'conversation_audit_required', 'acceptance_bar_contract_not_ready'])('retains %s as an actionable blocker', async blocker => {
    expect(await checkPlanExecutionGuard(call(), { readBindings: async () => [binding], checkPlan: async () => [blocker] }))
      .toMatchObject({ blockers: [blocker] });
  });
  it('fails closed on unavailable authority or readiness instead of treating it as unbound', async () => {
    for (const deps of [
      { readBindings: async () => { throw Error('unavailable'); }, checkPlan: async () => [] },
      { readBindings: async () => [binding], checkPlan: async () => { throw Error('unavailable'); } },
    ]) expect(await checkPlanExecutionGuard(call(), deps)).toMatchObject({ blockers: ['plan_authority_unavailable'] });
  });
  it('checks the canonical selected work-item plan without inheriting an unrelated held plan', async () => {
    const selected = {
      planSlug: 'security-plan', harnessSlug: 'project', source: 'work-item' as const, sourceRef: 'EI-security',
    };
    const unrelated = {
      planSlug: 'unrelated-plan', harnessSlug: 'project',
      source: 'plan-item-claim' as const, sourceRef: 'unrelated-plan#P-008',
    };
    const goal = resolveAgentGoal({
      workItems: [{ id: 'EI-security' }],
      planItems: [{ planSlug: 'unrelated-plan', itemId: 'P-008' }],
    })!;
    expect(goal).toMatchObject({ ref: 'EI-security', source: 'work-item', competing: ['unrelated-plan#P-008'] });

    const checkPlan = vi.fn(async (binding: { planSlug: string }) =>
      binding.planSlug === 'unrelated-plan' ? ['plan_status:draft'] : []);
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [selected, unrelated],
      resolveGoal: async () => ({ goal, diagnostics: [] }),
      checkPlan,
    });

    expect(result).toBeNull();
    expect(checkPlan.mock.calls.map(([binding]) => binding.planSlug)).toEqual(['security-plan']);
  });
  it('records each checked binding while diagnostic failures cannot change allow or refusal', async () => {
    for (const blockers of [[], ['plan_not_started']]) {
      const timings: Array<{ stage: string; durationMs: number }> = [];
      const result = await checkPlanExecutionGuard({ ...call(), observeTiming: timing => {
        timings.push(timing); throw Error('broken timing sink');
      } }, {
        readBindings: async () => [binding],
        resolveGoal: async () => ({ goal: null, diagnostics: [] }),
        checkPlan: async (_binding, _workspace, observe) => {
          expect(observe).toBeTypeOf('function');
          return blockers;
        },
      });
      expect(timings.map(t => t.stage)).toEqual(['bindings', 'goal', 'binding']);
      expect(timings.every(t => Number.isFinite(t.durationMs) && t.durationMs >= 0)).toBe(true);
      if (blockers.length) expect(result).toMatchObject({ blockers });
      else expect(result).toBeNull();
    }
  });
  it('retains failed-read timing and the original fail-closed verdict', async () => {
    const timings: string[] = [];
    expect(await checkPlanExecutionGuard({ ...call(), observeTiming: t => { timings.push(t.stage); } }, {
      readBindings: async () => { throw Error('unavailable'); }, checkPlan: vi.fn(),
    })).toMatchObject({ blockers: ['plan_authority_unavailable'] });
    expect(timings).toEqual(['bindings']);
  });
  it('still refuses an unstarted plan attached to the selected work-item', async () => {
    const goal = resolveAgentGoal({
      workItems: [{ id: 'EI-security' }],
      planItems: [{ planSlug: 'unrelated-plan', itemId: 'P-008' }],
    })!;
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [
        { planSlug: 'security-plan', harnessSlug: 'project', source: 'work-item', sourceRef: 'EI-security' },
        { planSlug: 'unrelated-plan', harnessSlug: 'project', source: 'plan-item-claim', sourceRef: 'unrelated-plan#P-008' },
      ],
      resolveGoal: async () => ({ goal, diagnostics: [] }),
      checkPlan: async binding => binding.planSlug === 'security-plan' ? ['plan_not_started'] : ['plan_status:draft'],
    });

    expect(result).toMatchObject({
      code: 'plan_execution_not_ready',
      planSlug: 'security-plan',
      blockers: ['plan_not_started'],
    });
  });
  it('keeps the full binding census when current goal resolution is incomplete', async () => {
    const checkPlan = vi.fn(async (binding: { planSlug: string }) =>
      binding.planSlug === 'unrelated-plan' ? ['plan_status:draft'] : []);
    const result = await checkPlanExecutionGuard(call(), {
      readBindings: async () => [
        { planSlug: 'security-plan', harnessSlug: 'project', source: 'work-item', sourceRef: 'EI-security' },
        { planSlug: 'unrelated-plan', harnessSlug: 'project', source: 'plan-item-claim', sourceRef: 'unrelated-plan#P-008' },
      ],
      resolveGoal: async () => ({ goal: null, diagnostics: [{ leg: 'work-items' }] }),
      checkPlan,
    });

    expect(result).toMatchObject({ planSlug: 'unrelated-plan', blockers: ['plan_status:draft'] });
    expect(checkPlan).toHaveBeenCalledTimes(2);
  });
  it.each(['Read', 'Grep', 'Glob', 'plans:edit', 'plans:audit', 'plans:start', 'reports:publish', 'work_items:checkpoint'])('keeps %s available without reading blocked plan authority', async toolName => {
    const readBindings = vi.fn();
    expect(await checkPlanExecutionGuard(call(toolName), { readBindings, checkPlan: vi.fn() })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
  });
  it('permits read-only shell research but refuses redirection, interpreters, substitutions and external search hooks', () => {
    for (const command of ['pwd', 'rg -n scope source.ts | head -20', "cat 'source file.ts'", 'ls; wc -l source.ts'])
      expect(isPlanResearchCommand(command), command).toBe(true);
    for (const command of ['cat x > source.ts', 'python -c "open(\"x\",\"w\")"', 'rg --pre=sh x',
      'rg --hostname-bin sh x', 'ls $(touch x)', 'ls `touch x`', 'cat x\ntouch y', 'ls || touch x', 'ls |'])
      expect(isPlanResearchCommand(command), command).toBe(false);
    expect(isPlanImplementationCall('write_stdin', { chars: '' })).toBe(false);
    expect(isPlanImplementationCall('write_stdin', { chars: 'touch x\n' })).toBe(true);
  });
  it('permits bounded PTool contract reads and consult replies while refusing implementation calls', async () => {
    const readCommand = [
      "ptool plans:get --json - --harness=papercusp <<'JSON'",
      '{"slug":"review-plan"}',
      'JSON',
    ].join('\n');
    const replyCommand = [
      "ptool consult:reply --json - --harness=papercusp <<'JSON'",
      '{"conversation_id":"consult-1","kind":"answer","body":"Reviewed.","evidence":[{"session_id":"session-1","turn_idx":3}]}',
      'JSON',
    ].join('\n');
    const writeCommand = [
      "ptool work_items:set_state --json - <<'JSON'",
      '{"id":"WI-123","state":"done"}',
      'JSON',
    ].join('\n');

    expect(isPlanImplementationCall('exec_command', { cmd: readCommand })).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd: replyCommand })).toBe(false);
    expect(isPlanImplementationCall('exec_command', { cmd: writeCommand })).toBe(true);
    expect(isPlanImplementationCall('exec_command', { cmd: "ptool tools:invoke --json - <<'JSON'\n{}\nJSON" })).toBe(true);
    expect(isPlanImplementationCall('exec_command', { cmd: "ptool plans:get --json - <<JSON\n{}\nJSON" })).toBe(true);

    const readBindings = vi.fn(async () => [binding]);
    const checkPlan = vi.fn(async () => ['plan_status:draft']);
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: readCommand }), { readBindings, checkPlan })).toBeNull();
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: replyCommand }), { readBindings, checkPlan })).toBeNull();
    expect(readBindings).not.toHaveBeenCalled();
    expect(await checkPlanExecutionGuard(call('exec_command', { cmd: writeCommand }), { readBindings, checkPlan }))
      .toMatchObject({ code: 'plan_execution_not_ready', blockers: ['plan_status:draft'] });
    expect(readBindings).toHaveBeenCalledTimes(1);
  });
});

describe('reviewer read and decline are independent of plan activation (EI-27697470834897410)', () => {
  const ptool = (name: string, args: unknown) =>
    [`ptool ${name} --json - <<'JSON'`, JSON.stringify(args), 'JSON'].join('\n');

  it.each([false, true])('allows exact reviewer targets when plan authority is unavailable; wrapped=%s', async wrapped => {
    const readBindings = vi.fn(async () => { throw Error('authority unavailable'); });
    for (const [name, args] of [
      ['conversations:get', { id: 'consult-1' }],
      ['consult:decline', { conversation_id: 'consult-1', reason: 'Cannot read evidence' }],
    ] as const) {
      const cmd = wrapped ? ptool('tools:invoke', { name, args }) : ptool(name, args);
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), { readBindings, checkPlan: vi.fn() })).toBeNull();
    }
    expect(readBindings).not.toHaveBeenCalled();
  });

  it('keeps nested mutation targets, shell execution and altered wrappers fail-closed', async () => {
    const read = ptool('conversations:get', { id: 'consult-1' });
    const write = ptool('tools:invoke', { name: 'capability:write', args: { file_path: 'source.ts', content: 'changed' } });
    const nested = ptool('tools:invoke', { name: 'tools:invoke', args: { name: 'conversations:get', args: { id: 'consult-1' } } });
    const override = ptool('tools:invoke', { name: 'conversations:get', args: { id: 'consult-1' }, authenticatedPrincipal: 'someone-else' });
    for (const cmd of [write, nested, override, read + '\ntouch source.ts', read.replace("<<'JSON'", '<<JSON'),
      read.replace('ptool ', 'FAKE=1 ptool '), read.replace(' --json', ' --url=http://elsewhere --json')]) {
      expect(await checkPlanExecutionGuard(call('exec_command', { cmd }), {
        readBindings: async () => { throw Error('authority unavailable'); }, checkPlan: vi.fn(),
      }), cmd).toMatchObject({ blockers: ['plan_authority_unavailable'] });
    }
  });
});

describe('activation freshness', () => {
  const original = '---\ntitle: Scope\nstatus: ready\nupdated: 2026-10-31\n---\n# Scope\n## Now\n**State:** Ready\n**Next:** Build\n## Requirements\nPersist all pending work.\n## Phase 1\n- **P-001** `todo` Persist the queue blocked-by: P-002\n';
  it('does not invalidate activation for progress, Now, or whitespace alone', () => {
    const after = original.replace('status: ready', 'status: active').replace('updated: 2026-10-31', 'updated: 2026-11-01')
      .replace('**State:** Ready', '**State:** Implementing').replace('**Next:** Build', '**Next:** Verify').replace('`todo`', '`wip`');
    expect(planExecutionMeaning(after)).toBe(planExecutionMeaning(original));
  });
  const promoted = '\n## Promoted\n\n<!-- plan-pipeline: do not edit this block manually -->\n- [ ] WI-123 — Persist the queue <!-- P-001 -->\n';
  it('keeps activation current after first promotion and later receipt-only updates', () => {
    expect(planExecutionMeaning(original + promoted)).toBe(planExecutionMeaning(original));
    expect(planExecutionMeaning(original + promoted.replace('WI-123', 'WI-456').replace('[ ]', '[x]')))
      .toBe(planExecutionMeaning(original));
  });
  it.each([
    ['unmarked prose', promoted.replace('<!-- plan-pipeline: do not edit this block manually -->', '')],
    ['author prose within a marked block', promoted + 'The task must retain all failures.\n'],
    ['similar marker', promoted.replace('plan-pipeline:', 'plan-pipeline-copy:')],
    ['different heading', promoted.replace('## Promoted', '## Requirements')],
    ['fenced example', '\n```markdown\n' + promoted + '```\n'],
    ['following decision', promoted + '\n## Decisions\n### D-001 Preserve evidence\nNever delete failed attempts.\n'],
  ])('preserves activation authority for %s', (_kind, addition) => {
    expect(planExecutionMeaning(original + addition)).not.toBe(planExecutionMeaning(original));
  });
  it.each([['pending', 'completed'], ['P-002', 'P-003'], ['`todo`', '`dropped`']])('invalidates changed scope/dependencies: %s', (before, after) => {
    expect(planExecutionMeaning(original.replace(before, after))).not.toBe(planExecutionMeaning(original));
  });
});

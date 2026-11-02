import { describe, expect, it, vi } from 'vitest';
import { checkPlanExecutionGuard, isPlanImplementationCall, isPlanResearchCommand, planExecutionMeaning } from './plan-execution-guard';

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

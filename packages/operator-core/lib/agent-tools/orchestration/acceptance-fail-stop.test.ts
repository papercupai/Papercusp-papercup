import { describe, expect, it, vi } from 'vitest';
import { runToolOrchestration, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool, ToolResult } from '@papercusp/tooldef';
import { bindCurrentCallerDispatch } from './current-caller-dispatch';

const json = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const passing = {
  ok: true,
  classRef: 'plan-class-bugfix',
  classRefSource: 'active-acceptance-rubric',
  count: 1,
  rows: [{ specId: 'clause-1', verdict: 'pass', wouldBlock: [] }],
  wouldBlock: [],
};

function fixture(evaluate: () => Promise<unknown>) {
  const gate = vi.fn(async () => json({ ok: true }));
  const archive = vi.fn(async () => json({ ok: true }));
  const evaluator = vi.fn(async (_args: unknown) => json(await evaluate()));
  const tool = (name: string, effect: 'read' | 'write', fn: ProjectedTool['fn']): ProjectedTool => ({
    pluginName: 'acceptance-fail-stop-fixture', description: name,
    inputSchema: { type: 'object' }, capabilities: [], effect,
    expose: { mcp: { name } }, fn,
  }) as unknown as ProjectedTool;
  const tools = [
    tool('plans:evaluate-spec-test-adequacy', 'read', evaluator),
    tool('plans:set-plan-status', 'write', gate),
    tool('plans:certify-spec-clauses', 'write', gate),
    tool('work_items:comment', 'write', archive),
  ];
  // Exercise the same indirect spelling the original caller used.
  tools.push(tool('tools:invoke', 'read', async (args, ctx) => {
    const request = args as { name: string; args: unknown };
    const target = tools.find(t => t.expose.mcp?.name === request.name)!;
    return target.fn(request.args as never, ctx);
  }));
  const run = (script: string) => runToolOrchestration(script, {
    ctx: {
      log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
      workspaceId: 'acceptance-fixture', harnessSlug: 'papercusp',
      role: 'su', isSuperuser: true, tx: { fixture: true },
    } as unknown as UnifiedToolContext,
    deps: {}, tools, wrapDispatch: bindCurrentCallerDispatch,
  });
  return { run, gate, archive, evaluator };
}

describe('acceptance orchestration fail-stop (WI-6554700010012388)', () => {
  it.each([
    ['class refusal', { ok: false, code: 'plan_class_mismatch' }],
    ['semantic error', { ...passing, error: 'measurement unavailable' }],
    ['blocking evidence', { ...passing, wouldBlock: ['freshness'] }],
    ['unknown row', { ...passing, rows: [{ verdict: 'unknown', wouldBlock: [] }] }],
    ['incomplete rows', { ...passing, rows: [] }],
    ['missing receipt', null],
    ['partial receipt', { ...passing, partial: true }],
    ['shaped partial receipt', { ...passing, _partial: true }],
    ['truncated receipt', { ...passing, _projection: { truncated: true } }],
  ])('archives %s but dispatches no dependent gate/recruiter', async (_label, receipt) => {
    const f = fixture(async () => receipt);
    const result = await f.run(`
      const receipt = await tools.plans.evaluateSpecTestAdequacy({ slug: 'plan' });
      await tools.workItems.comment({ id: 'WI-fixture', body: JSON.stringify(receipt) });
      await tools.plans.setPlanStatus({ slug: 'plan', status: 'shipped' });
      return { reachedGate: true };
    `);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('acceptance_orchestration_stopped');
    expect(f.archive).toHaveBeenCalledOnce();
    expect(f.gate).not.toHaveBeenCalled();
    expect(f.evaluator).toHaveBeenCalledOnce();
  });

  it('cannot catch an uncertain evaluator error and replay or recruit through tools:invoke', async () => {
    const f = fixture(async () => { throw new Error('timeout: original outcome UNKNOWN'); });
    const result = await f.run(`
      const call = (name, args) => tools.tools.invoke({ name, args });
      try { await call('plans:evaluate-spec-test-adequacy', { slug: 'plan' }); } catch {}
      try { await call('plans:evaluate-spec-test-adequacy', { slug: 'plan' }); } catch {}
      try { await call('plans:certify-spec-clauses', { slug: 'plan' }); } catch {}
      await call('plans:set-plan-status', { slug: 'plan', status: 'shipped' });
    `);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('acceptance_orchestration_stopped');
    expect(f.evaluator).toHaveBeenCalledOnce();
    expect(f.gate).not.toHaveBeenCalled();
  });

  it('blocks a gate submitted while its evaluation is still pending', async () => {
    let release!: (value: unknown) => void;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    const pending = f.run(`
      await Promise.allSettled([
        tools.plans.evaluateSpecTestAdequacy({ slug: 'plan' }),
        tools.plans.setPlanStatus({ slug: 'plan', status: 'shipped' })
      ]);
      return { done: true };
    `);
    await vi.waitFor(() => expect(f.evaluator).toHaveBeenCalledOnce());
    release(passing);
    await pending;
    expect(f.gate).not.toHaveBeenCalled();
  });

  it('blocks the entire bulk gate if one selected plan has a refused evaluation', async () => {
    const f = fixture(async () => ({ ok: false, code: 'plan_class_mismatch' }));
    const result = await f.run(`
      await tools.plans.evaluateSpecTestAdequacy({ slug: 'plan' });
      await tools.plans.setPlanStatus({ slugs: ['other-plan', 'plan'], status: 'done' });
    `);
    expect(result.ok).toBe(false);
    expect(f.gate).not.toHaveBeenCalled();
  });

  it('allows paged historical criterion audits without treating a page as a current acceptance result', async () => {
    const historical = {
      ok: true,
      classRef: 'plan-class-bugfix',
      classRefSource: 'historical-scorecard',
      count: 1,
      rows: [{ specId: 'clause-1', verdict: 'fail', wouldBlock: ['traceability'] }],
      wouldBlock: ['traceability'],
      historicalAuditOnly: { asOf: '2026-10-24T06:20:09.275Z' },
    };
    const f = fixture(async () => historical);
    f.evaluator
      .mockResolvedValueOnce(json(historical))
      .mockResolvedValueOnce(json(historical))
      .mockResolvedValueOnce(json(passing));
    const result = await f.run(`
      const first = await tools.plans.evaluateSpecTestAdequacy({
        slug: 'plan', scorecardId: 'card', detail: 'full', criteria: ['traceability']
      });
      const second = await tools.plans.evaluateSpecTestAdequacy({
        slug: 'plan', scorecardId: 'card', detail: 'full', criteria: ['verification']
      });
      const current = await tools.plans.evaluateSpecTestAdequacy({ slug: 'plan' });
      await tools.plans.setPlanStatus({ slug: 'plan', status: 'shipped' });
      return { first, second, current };
    `);

    expect(result.ok).toBe(true);
    expect(f.evaluator).toHaveBeenCalledTimes(3);
    expect(f.gate).toHaveBeenCalledOnce();
  });

  it('does not let a historical scorecard audit authorize a dependent current gate', async () => {
    const f = fixture(async () => ({
      ok: true,
      classRef: 'plan-class-bugfix',
      classRefSource: 'historical-scorecard',
      count: 1,
      rows: [{ specId: 'clause-1', verdict: 'pass', wouldBlock: [] }],
      wouldBlock: [],
      historicalAuditOnly: { asOf: '2026-10-24T06:20:09.275Z' },
    }));
    const result = await f.run(`
      await tools.plans.evaluateSpecTestAdequacy({
        slug: 'plan', scorecardId: 'card', detail: 'full', criteria: ['traceability']
      });
      await tools.plans.setPlanStatus({ slug: 'plan', status: 'shipped' });
      return { reachedGate: true };
    `);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('acceptance_orchestration_stopped');
    expect(f.evaluator).toHaveBeenCalledOnce();
    expect(f.gate).not.toHaveBeenCalled();
  });

  it('uses the full evaluator receipt before applying a caller projection', async () => {
    const f = fixture(async () => passing);
    const result = await f.run(`
      const visible = await tools.plans.evaluateSpecTestAdequacy({
        slug: 'plan', projection: { pick: ['ok'] }
      });
      await tools.plans.setPlanStatus({ slug: 'plan', status: 'shipped' });
      return visible;
    `);
    expect(result).toMatchObject({ ok: true, summary: { ok: true } });
    expect(f.gate).toHaveBeenCalledOnce();
  });

  it('preserves successful class derivation, other plans, and separate runs', async () => {
    let receipt: unknown = { ok: false, code: 'plan_class_mismatch' };
    const f = fixture(async () => receipt);
    await f.run(`
      await tools.plans.evaluateSpecTestAdequacy({ slug: 'plan' });
      await tools.plans.setPlanStatus({ slug: 'other-plan', status: 'shipped' });
    `);
    expect(f.gate).toHaveBeenCalledOnce();
    receipt = passing;
    const result = await f.run(`
      await tools.plans.evaluateSpecTestAdequacy({ slug: 'plan' });
      await tools.plans.setPlanStatus({ slug: 'plan', status: 'shipped' });
    `);
    expect(result.ok).toBe(true);
    expect(f.gate).toHaveBeenCalledTimes(2);
    // Omitted classRef uses the evaluator's maintained active-rubric resolver.
    expect(f.evaluator.mock.calls[1]?.[0]).toEqual({ slug: 'plan' });
  });
});

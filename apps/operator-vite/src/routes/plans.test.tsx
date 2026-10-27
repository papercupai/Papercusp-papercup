// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { applyPayloadTier, serializeToolResponse } from '@papercusp/tooldef';
import PlanEngineeringEvidence from '@/app/_components/plans/PlanEngineeringEvidence';

// See inbox.test.tsx — the component moved to components/route-content/
// behind `lazyRouteComponent` (WI-5502); mock both router entry points.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  lazyRouteComponent: (loader: unknown) => loader,
}));

vi.mock('@/app/_components/plans/PlansPane', () => ({
  default: (props: { layout?: string }) => (
    <section
      data-testid="canonical-plans-pane"
      data-layout={props.layout ?? 'stack'}
    >
      <button data-testid="plans-cleanup-start" type="button">Clean up shown plans</button>
    </section>
  ),
}));

import { PlansEmbedRoute } from '../components/route-content/PlansEmbedRoute';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('/plans portal embed route', () => {
  it('mounts the canonical PlansPane and leaves its cleanup control intact', () => {
    render(<PlansEmbedRoute />);
    expect(screen.getByTestId('plans-portal-embed').getAttribute('data-portal-surface')).toBe('plans');
    expect(screen.getByTestId('canonical-plans-pane')).toBeTruthy();
    expect(screen.getByTestId('plans-cleanup-start')).toBeTruthy();
  });

  it('asks PlansPane for the split (list + dashboard) layout — Direction B (portal-work-two-pane-2026-09-01 P-003)', () => {
    render(<PlansEmbedRoute />);
    expect(
      screen.getByTestId('canonical-plans-pane').getAttribute('data-layout'),
    ).toBe('split');
  });
});

describe('selected plan engineering evidence detail', () => {
  const reference = (tool: string, args: Record<string, unknown>) => ({ tool, args });
  function fixture(applyWireBudget = false) {
    const nodes = [
      { id: 'item', kind: 'item', state: 'current', data: { item: 'P-001' }, ref: reference('plans:get', { slug: 'ee-feature', itemIds: ['P-001'] }) },
      { id: 'spec', kind: 'spec', state: 'current', data: { id: 'EE-1', revision: 2 }, ref: reference('plans:get-specs', { slug: 'ee-feature', specIds: ['EE-1'], revision: 2 }) },
      { id: 'direct', kind: 'decision', state: 'current', data: { decision: 'D-001', title: 'Explicit rule' }, ref: reference('plans:get', { slug: 'ee-feature', decisionId: 'D-001' }) },
      { id: 'broader', kind: 'decision', state: 'current', data: { decision: 'D-002', title: 'Plan context' }, ref: reference('plans:get', { slug: 'other-plan', decisionId: 'D-002' }) },
      { id: 'run', kind: 'test-run', state: 'historical', data: { id: 72101 }, ref: reference('testing:runs', { testRunIds: [72101], cases: true }) },
      { id: 'case', kind: 'test-case', state: 'stale', data: { key: 'ee.intent-exact', occurrence: 2 }, ref: reference('testing:runs', { testRunIds: [72101], cases: true }) },
      { id: 'boundary', kind: 'execution', state: 'current', data: { boundary: 'graph:query.evidence' }, ref: reference('testing:runs', { testRunIds: [72101], cases: true }) },
    ];
    const graph = { scope: { workspaceId: 'fixture', harness: 'papercusp' }, nodes,
      edges: [{ from: 'direct', to: 'item', basis: 'decision-item-ref' }, { from: 'broader', to: 'item', basis: 'plan-affects' }],
      execution: { status: 'observed' }, truncated: false, gaps: [] as unknown[] };
    const calls: { name: string; args: Record<string, unknown>; harness: string; confirmed: boolean }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)); calls.push(call);
      if (!call.confirmed) return new Response(JSON.stringify({ ok: false, error: 'confirmation_required' }), { status: 409 });
      const value = call.name === 'graph:query' ? { data: { status: 'measured', evidence: graph } }
        : { ok: true, resolved: call.args, record: call.name === 'plans:get-specs' ? 'EXACT_SPEC_REVISION_TWO'
          : call.name === 'plans:get' ? 'EXACT_DECISION' : call.name === 'testing:runs' ? 'EXACT_CASE_OCCURRENCE_TWO' : 'BOUND_TEST_EVIDENCE' };
      const result = applyWireBudget && call.name === 'graph:query'
        ? serializeToolResponse(applyPayloadTier({ toolName: call.name, tier: 'full', shape: undefined,
          response: { data: { status: 'measured', evidence: graph } }, args: call.args,
          explicitFullRequest: call.args.payloadTier === 'full', ceilingChars: 6000, log: () => {} }),
        { defaultCompact: false, includeStructured: true })
        : { structuredContent: value };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }));
    const renderPanel = () => render(<PlanEngineeringEvidence plan="ee-feature" item="P-001" harness="papercusp" onClose={() => {}} />);
    return { graph, calls, renderPanel };
  }
  it('ee.ui-wire-budget: retains exact records beyond the ordinary HTTP preview budget', async () => {
    const { graph, renderPanel } = fixture(true);
    graph.nodes.unshift(...Array.from({ length: 40 }, (_, index) => ({ id: `context-${index}`,
      kind: 'decision', state: 'historical', data: { decision: `D-context-${index}`, title: 'Context '.repeat(160) },
      ref: reference('plans:get', { slug: 'ee-feature', decisionId: `D-context-${index}` }) })));
    expect(JSON.stringify(graph).length).toBeGreaterThan(30_000);
    renderPanel();
    expect(await screen.findByRole('button', { name: 'EE-1 · revision 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ee.intent-exact · occurrence 2' })).toBeTruthy();
    expect(screen.getByText('· current · Observed instrumented boundary')).toBeTruthy();
  });
  it('ee.ui-ref-resolution: opens actual detail references with the exact requirement revision, decision and recorded run/case selectors', async () => {
    const { calls, renderPanel } = fixture(); renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'EE-1 · revision 2' }));
    await screen.findByText(/EXACT_SPEC_REVISION_TWO/);
    expect(calls.at(-1)).toMatchObject({ name: 'plans:get-specs', harness: 'papercusp', confirmed: true,
      args: { slug: 'ee-feature', specIds: ['EE-1'], revision: 2 } });
    fireEvent.click(screen.getByRole('button', { name: 'D-001 · Explicit rule' })); await screen.findByText(/EXACT_DECISION/);
    expect(calls.at(-1)?.args).toMatchObject({ decisionId: 'D-001' });
    fireEvent.click(screen.getByRole('button', { name: 'ee.intent-exact · occurrence 2' })); await screen.findByText(/EXACT_CASE_OCCURRENCE_TWO/);
    expect(calls.at(-1)?.args).toEqual({ testRunIds: [72101], cases: true, payloadTier: 'full' });
  });
  it('ee.ui-knowledge-labels: keeps static links, test results, boundary observations and stale/history/unknown states distinct', async () => {
    const { graph, renderPanel } = fixture(); graph.nodes[0]!.state = 'unknown'; renderPanel();
    await screen.findByRole('button', { name: 'EE-1 · revision 2' });
    expect(screen.getByText('· unknown · Declared · static')).toBeTruthy();
    expect(screen.getByText('· historical · Recorded test result')).toBeTruthy();
    expect(screen.getByText('· stale · Recorded test result')).toBeTruthy();
    expect(screen.getByText('· current · Observed instrumented boundary')).toBeTruthy();
    expect(screen.getByText(/Inferred relationships are not measured here/)).toBeTruthy();
  });
  it('ee.ui-context-scope: shows broader context separately and requests unscoped context only on explicit selection', async () => {
    const { calls, renderPanel } = fixture(); renderPanel();
    await screen.findByRole('button', { name: 'D-001 · Explicit rule' });
    expect(screen.getByText('· current · Direct rationale')).toBeTruthy();
    expect(screen.getByText('· current · Broader plan context')).toBeTruthy();
    expect(calls[0]?.args).toMatchObject({ plan: 'ee-feature', item: 'P-001', harnesses: ['papercusp'], include_context: false });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include unscoped decision context' }));
    await waitFor(() => expect(calls.filter(call => call.name === 'graph:query').at(-1)?.args.include_context).toBe(true));
  });
  it('ee.ui-repair-validity: rejects non-work-item IDs with the browser pattern constraint and accepts hyphenated work-item IDs', async () => {
    const { graph, calls, renderPanel } = fixture();
    graph.gaps = [{ code: 'no-visible-proof', at: reference('plans:get-specs', { slug: 'ee-feature', specIds: ['EE-1'], revision: 2 }) }];
    renderPanel(); fireEvent.click(await screen.findByRole('button', { name: 'Bind test evidence for EE-1' }));
    const owner = screen.getByRole('textbox', { name: 'Owning work item' }) as HTMLInputElement;
    fireEvent.change(owner, { target: { value: 'EI-123' } });
    expect(owner.validity.patternMismatch).toBe(true);
    expect(owner.checkValidity()).toBe(false);
    fireEvent.change(owner, { target: { value: 'WI-a-123' } });
    expect(owner.validity.patternMismatch).toBe(false);
    expect(owner.checkValidity()).toBe(true);
    expect(calls.every(call => call.name !== 'plans:bind-spec-evidence')).toBe(true);
  });
  it('ee.ui-repair: binds a recorded run through the existing writer at the selected exact revision and rereads the graph', async () => {
    const { graph, calls, renderPanel } = fixture();
    graph.gaps = [{ code: 'no-visible-proof', at: reference('plans:get-specs', { slug: 'ee-feature', specIds: ['EE-1'], revision: 2 }) }];
    renderPanel(); fireEvent.click(await screen.findByRole('button', { name: 'Bind test evidence for EE-1' }));
    expect(calls.every(call => call.name !== 'plans:bind-spec-evidence')).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Owning work item' }), { target: { value: 'WI-123' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Recorded test run' }), { target: { value: '72101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bind evidence' }));
    await waitFor(() => expect(calls.some(call => call.name === 'plans:bind-spec-evidence')).toBe(true));
    expect(calls.find(call => call.name === 'plans:bind-spec-evidence')).toEqual({ name: 'plans:bind-spec-evidence', harness: 'papercusp', confirmed: true,
      args: { slug: 'ee-feature', harness: 'papercusp', payloadTier: 'full', binding: { workItemId: 'WI-123', specId: 'EE-1', specRevision: 2, fromTestRun: 72101 } } });
    await waitFor(() => expect(calls.filter(call => call.name === 'graph:query').length).toBe(2));
  });
});

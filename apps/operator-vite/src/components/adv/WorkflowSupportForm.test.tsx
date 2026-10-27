// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ComponentProps, ReactNode } from 'react';
import type { BlueprintOperationHandle } from '@papercusp/pot-app-seam';
import type { ApprovedSupportWorkflow } from '@papercusp/operator-core/lib/blueprint/support-workflow-contract';
import { webcrypto } from 'node:crypto';
const ports = vi.hoisted(() => ({ query: vi.fn(), tool: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: ports.query }));
vi.mock('./ScheduleEditor', () => ({ runScheduleTool: ports.tool }));
vi.mock('./WorkflowOperationResult', () => ({ default: ({ handle }: { handle: BlueprintOperationHandle }) =>
  <p>Receipt {handle.receiptId} revision {handle.specificationRevision}</p>, workflowOperationSeam: {} }));
import WorkflowSupportForm from './WorkflowSupportForm';

const workflow: ApprovedSupportWorkflow = { harnessSlug: 'support', operationId: 'handoff', approvedRevision: 'a'.repeat(64),
  accountableOwner: 'support-owner', reviewerPrincipals: ['reviewer'], allowedSources: ['slack'],
  allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000 };
const document = { id: '00000000-0000-4000-8000-000000000001', title: 'Cobalt support request',
  source: 'slack', externalId: 'case-cobalt', snippet: 'The customer sees an error.' };
const handle: BlueprintOperationHandle = { workspaceId: 'workspace-a', harnessSlug: 'support', operationId: 'handoff',
  receiptId: 42, specificationRevision: workflow.approvedRevision, target: { kind: 'work-item', id: 'WI-42' } };
const renderForm = (props: Partial<ComponentProps<typeof WorkflowSupportForm>> = {}, searchParams = '') => render(
  <WorkflowSupportForm harnessSlug="support" operationId="handoff" {...props} />,
  { wrapper: ({ children }: { children: ReactNode }) => <NuqsTestingAdapter hasMemory searchParams={searchParams}>{children}</NuqsTestingAdapter> });
async function selectEvidence() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Support case reference' }), { target: { value: 'case-cobalt' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Find case evidence' }), { target: { value: 'cobalt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search allowed sources' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Include Cobalt support request' }));
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto);
  ports.query.mockReturnValue({ data: [{ supportWorkflow: workflow }], error: null }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('employee support selection on Workflows', () => {
  it('explains unavailable employee input and pending review without hiding the administration entry', () => {
    ports.query.mockReturnValue({ data: [{ supportWorkflow: null }], error: null });
    renderForm({ enterprise: true });
    expect(screen.getByText(/Employee action unavailable: no approved support workflow/)).toBeTruthy();
    expect(screen.getByText(/Business outcome pending/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh administration' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prepare handoff' })).toBeNull();
    expect(ports.tool).not.toHaveBeenCalled();
  });
  it('submits selected canonical evidence and the displayed revision through the typed operation seam', async () => {
    const submitOperations = vi.fn().mockResolvedValue([handle]);
    const search = vi.fn().mockResolvedValue([document]);
    renderForm({ seam: { submitOperations }, search });
    expect(screen.getByText('Accountable owner: support-owner')).toBeTruthy();
    expect(screen.getByText(/Maximum per run: \$0.10/)).toBeTruthy();
    await selectEvidence();
    expect(search).toHaveBeenCalledWith('cobalt', ['slack']);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await screen.findByText(/Preparation accepted/);
    expect(submitOperations).toHaveBeenCalledWith([expect.objectContaining({ harnessSlug: 'support', operationId: 'handoff',
      expectedSpecificationRevision: workflow.approvedRevision, requestKey: expect.stringMatching(/^support:/),
      input: { supportCaseId: 'case-cobalt', query: 'cobalt', approvedRevision: workflow.approvedRevision,
        documentIds: [document.id], requestedAction: 'prepare-handoff' } })]);
    expect(screen.getByText(`Receipt 42 revision ${workflow.approvedRevision}`)).toBeTruthy();
  });
  it('uses the organization-only existing search contract and rejects unauthorized or malformed evidence', async () => {
    // runScheduleTool parses the MCP text payload; dispatch has already
    // serialized the handler's data field as that payload's root.
    ports.tool.mockResolvedValue({ ok: true, data: { legs: { organization: { allowed: true } },
      results: [{ ...document, scope: 'organization' }] } });
    renderForm({ seam: { submitOperations: vi.fn() } });
    await selectEvidence();
    expect(ports.tool).toHaveBeenCalledWith('documents:search', { query: 'cobalt', sources: ['slack'], legs: ['organization'], limit: 50 });
    ports.tool.mockResolvedValue({ ok: true, data: { legs: { organization: { allowed: true } },
      results: [{ ...document, scope: 'organization', source: 'forbidden' }] } });
    fireEvent.click(screen.getByRole('button', { name: 'Search allowed sources' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid case search result');
    expect(screen.queryByRole('checkbox', { name: /^Include / })).toBeNull();
    ports.tool.mockResolvedValue({ ok: true, data: { legs: { organization: { allowed: false } }, results: [] } });
    fireEvent.click(screen.getByRole('button', { name: 'Search allowed sources' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('access was refused'));
  });
  it('preserves the request key on an uncertain submit retry and prevents a simultaneous duplicate', async () => {
    const submitOperations = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue([handle]);
    renderForm({ seam: { submitOperations }, search: vi.fn().mockResolvedValue([document]) });
    await selectEvidence();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await screen.findByText('Connection lost');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await screen.findByText(/Preparation accepted/);
    expect(submitOperations).toHaveBeenCalledTimes(2);
    expect(submitOperations.mock.calls[0][0][0].requestKey).toBe(submitOperations.mock.calls[1][0][0].requestKey);
  });
  it('clears evidence when the query changes and resets the form when the approved revision changes', async () => {
    const submitOperations = vi.fn();
    const props = { seam: { submitOperations }, search: vi.fn().mockResolvedValue([document]) };
    const view = renderForm(props);
    await selectEvidence();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find case evidence' }), { target: { value: 'different' } });
    expect(screen.queryByRole('checkbox', { name: /^Include / })).toBeNull();
    expect((screen.getByRole('button', { name: 'Prepare handoff' }) as HTMLButtonElement).disabled).toBe(true);
    ports.query.mockReturnValue({ data: [{ supportWorkflow: { ...workflow, approvedRevision: 'b'.repeat(64) } }] });
    view.rerender(<WorkflowSupportForm harnessSlug="support" operationId="handoff" {...props} />);
    expect((screen.getByRole('textbox', { name: 'Support case reference' }) as HTMLInputElement).value).toBe('');
    expect(submitOperations).not.toHaveBeenCalled();
  });
  it('replays an uncertain submission after the form reloads instead of creating a second operation', async () => {
    const submitOperations = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue([handle]);
    const props = { seam: { submitOperations }, search: vi.fn().mockResolvedValue([document]) };
    const view = renderForm(props);
    await selectEvidence();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await screen.findByText('Connection lost');
    view.unmount();
    renderForm(props);
    await selectEvidence();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare handoff' }));
    await screen.findByText(/Preparation accepted/);
    expect(submitOperations.mock.calls[0][0][0].requestKey).toBe(submitOperations.mock.calls[1][0][0].requestKey);
  });
  it('keeps an old URL receipt readable when the current declaration is unavailable after rollback', () => {
    ports.query.mockReturnValue({ data: undefined, error: new Error('undeclared') });
    renderForm({}, '?wfRun=' + encodeURIComponent(JSON.stringify(handle)));
    expect(screen.getByText(`Receipt 42 revision ${workflow.approvedRevision}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prepare handoff' })).toBeNull();
  });
  it('does not attach another operation receipt from the URL to the selected operation', () => {
    renderForm({}, '?wfRun=' + encodeURIComponent(JSON.stringify({ ...handle, operationId: 'foreign' })));
    expect(screen.queryByText(/Receipt 42/)).toBeNull();
  });
});

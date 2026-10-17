// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { webcrypto } from 'node:crypto';
import { workflowAdministrationHostFromInvoker, type BlueprintOperationHandle,
  type WorkflowAdministration as Administration } from '@papercusp/pot-app-seam';
import WorkflowAdministration from './WorkflowAdministration';

const handle: BlueprintOperationHandle = { workspaceId: 'workspace', harnessSlug: 'support', operationId: 'handoff',
  receiptId: 42, specificationRevision: 'a'.repeat(64), target: { kind: 'work-item', id: 'WI-42' } };
const data = (): Administration => ({ harnessSlug: 'support', operationId: 'handoff', approvedRevision: 'b'.repeat(64),
  version: '2', accountableOwner: 'admin', reviewerPrincipals: ['reviewer'], retainedRevisions: [], history: [], businessReviews: [],
  funding: { allocationId: 'project', month: '2026-10', maximumCostMicros: 100_000, capMicros: 1_000_000,
    availableMicros: 900_000, committedMicros: 100_000, unknownReason: null,
    costs: [{ reservationId: 'reservation:42', observedCostMicros: { value: 12_000 },
      providerFinalCostMicros: { unknownReason: 'provider-final-bill-not-recorded' } }] } });
const host = () => ({ read: vi.fn().mockResolvedValue(data()), act: vi.fn().mockResolvedValue({
  accepted: true, eventId: 'admin:1', replayed: false, wakeQueued: false, handled: false }) });
function mount(port = host(), selected: BlueprintOperationHandle | null = handle) {
  vi.stubGlobal('crypto', webcrypto);
  render(<NuqsTestingAdapter hasMemory searchParams="wfAdmin=true"><WorkflowAdministration
    harnessSlug="support" operationId="handoff" handle={selected} host={port} /></NuqsTestingAdapter>);
  return port;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('workflow administration', () => {
  it('opens in Enterprise with unread evidence explicit, and preserves owner authorization on refresh', async () => {
    const port = host(); port.read.mockRejectedValue(new Error('Requires authenticated accountable owner'));
    render(<NuqsTestingAdapter hasMemory><WorkflowAdministration harnessSlug="support" operationId="handoff"
      defaultExpanded host={port} /></NuqsTestingAdapter>);
    expect(screen.getByText(/history have not been read/)).toBeTruthy();
    expect(port.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh administration' }));
    expect((await screen.findByRole('alert')).textContent).toContain('authenticated accountable owner');
    expect(screen.queryByRole('button', { name: 'Promote revision' })).toBeNull();
    expect(port.act).not.toHaveBeenCalled();
  });
  it('shows finite allocation and measured/unknown costs with their evidence; pins a stop to the selected old receipt', async () => {
    const port = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh administration' }));
    await screen.findByText('Approved version 2');
    expect(screen.getByText(/Finite allocation: \$1.000000/)).toBeTruthy();
    expect(screen.getByText(/Observed: \$0.012000/)).toBeTruthy();
    expect(screen.getByText(/Unknown \(provider-final-bill-not-recorded\)/)).toBeTruthy();
    expect(screen.getByText('reservation:42')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Administrative reason' }), { target: { value: 'Internal stop drill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop selected run' }));
    await screen.findByText(/Cancellation settlement is still pending/);
    expect(port.act).toHaveBeenCalledWith({ harness: 'support', operationId: 'handoff' }, {
      action: 'stop', handle, expectedSpecificationRevision: 'b'.repeat(64), reason: 'Internal stop drill',
    }, expect.stringMatching(/^workflow-admin:[a-f0-9]{64}$/));
    expect(handle.specificationRevision).toBe('a'.repeat(64));
  });
  it('renders authorization refusal and never exposes administrative values after it', async () => {
    const port = host(); port.read.mockRejectedValue(new Error('Requires authenticated accountable owner'));
    mount(port);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh administration' }));
    expect((await screen.findByRole('alert')).textContent).toContain('authenticated accountable owner');
    expect(screen.queryByText(/Approved version/)).toBeNull();
    expect(port.act).not.toHaveBeenCalled();
  });
  it('keeps receipt actions disabled without a receipt and labels absent cost evidence unknown', async () => {
    const port = host(); const value = data(); value.funding!.costs = []; port.read.mockResolvedValue(value);
    mount(port, null);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh administration' }));
    await screen.findByText(/Actual model cost: Unknown/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Administrative reason' }), { target: { value: 'Reason' } });
    expect((screen.getByRole('button', { name: 'Revoke employee source access' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Stop selected run' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('routes local approval and rollback through the existing typed operation tools without a supplied principal', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ administration: data() }).mockResolvedValue({
      accepted: true, eventId: 'admin:2', replayed: true, wakeQueued: false, handled: false });
    const port = workflowAdministrationHostFromInvoker(invoke);
    const selection = { harness: 'support', operationId: 'handoff' };
    await port.read(selection);
    const action = { action: 'rollback' as const, targetRevision: 'a'.repeat(64),
      expectedSpecificationRevision: 'b'.repeat(64), reason: 'Internal rollback' };
    await port.act(selection, action, 'rollback:1');
    expect(invoke.mock.calls).toEqual([
      ['blueprint:status', { ...selection, administration: true }],
      ['blueprint:signal', { ...selection, administration: action, requestKey: 'rollback:1' }],
    ]);
    invoke.mockResolvedValueOnce({ administration: { ...data(), harnessSlug: 'other' } });
    await expect(port.read(selection)).rejects.toThrow(/different workflow/);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  });
  it('reuses an uncertain request identity, then permits a new action after durable history advances', async () => {
    const port = host();
    port.act.mockRejectedValueOnce(new Error('Response lost'));
    mount(port);
    const refresh = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh administration' }));
      await screen.findByText('Approved version 2');
    };
    await refresh();
    fireEvent.change(screen.getByRole('textbox', { name: 'Administrative reason' }), { target: { value: 'Intentional owner action' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop selected run' }));
    await screen.findByText('Response lost');
    await refresh();
    fireEvent.click(screen.getByRole('button', { name: 'Stop selected run' }));
    await screen.findByText(/Cancellation settlement is still pending/);
    expect(port.act.mock.calls[0]?.[2]).toBe(port.act.mock.calls[1]?.[2]);
    port.read.mockResolvedValue({ ...data(), history: [{ eventId: 'later-rollback', body: { action: 'rollback' } }] });
    await refresh();
    fireEvent.click(screen.getByRole('button', { name: 'Stop selected run' }));
    await waitFor(() => expect(port.act).toHaveBeenCalledTimes(3));
    expect(port.act.mock.calls[2]?.[2]).not.toBe(port.act.mock.calls[1]?.[2]);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const H = vi.hoisted(() => ({ request: vi.fn(async () => ({})), success: vi.fn(), error: vi.fn() }));
vi.mock('./ticket-integrations-client', () => ({ integrationRequest: H.request }));
vi.mock('sonner', () => ({ toast: { success: H.success, error: H.error } }));
import { ProviderSourceConfigForm } from './ProviderSourceConfigForm';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const schema = {
  type: 'object', required: ['resourceId'],
  properties: { resourceId: { type: 'string', title: 'Resource id' }, pageLimit: { type: 'integer', title: 'Page limit' }, harnessSlug: { type: 'string', title: 'Project' } },
};
describe('generic provider source config form', () => {
  it('renders schema labels and sends typed fields through the existing source endpoint', async () => {
    const onSaved = vi.fn();
    render(<ProviderSourceConfigForm source={{ id: 'source-1', config: { resourceId: 'old', pageLimit: 2, accountLabel: 'private', providerState: 'opaque' } }} displayName="Fixture Service" schema={schema} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Configure connection'));
    fireEvent.change(screen.getByLabelText(/Resource id/), { target: { value: 'resource-7' } });
    fireEvent.change(screen.getByLabelText(/Page limit/), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-1' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Fixture Service connection settings' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(H.request).toHaveBeenCalledWith('/sources/source-1/config', 'PATCH', { patch: { resourceId: 'resource-7', pageLimit: 3, harnessSlug: 'project-1' } });
    expect(screen.queryByText('accountLabel')).toBeNull();
  });
  it('shows backend validation failure without claiming a save or refreshing', async () => {
    H.request.mockRejectedValueOnce(new Error('Resource id is invalid'));
    const onSaved = vi.fn();
    render(<ProviderSourceConfigForm source={{ id: 's', config: {} }} displayName="Fixture Service" schema={schema} onSaved={onSaved} />);
    fireEvent.submit(screen.getByRole('form', { name: 'Fixture Service connection settings', hidden: true }));
    await waitFor(() => expect(H.error).toHaveBeenCalledWith('Resource id is invalid'));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

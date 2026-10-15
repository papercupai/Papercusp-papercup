// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DaoPolicyEditor from './DaoPolicyEditor';
const view = { directoryId: 'dao', localHomeSlug: 'joined-local', status: 'connected' as const };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('DAO owner policy editor', () => {
  it('preserves unedited fields and sends the reviewed policy version; a conflict keeps the draft', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, canEdit: true, policy: { policyVersion: 7, policy: { membership: 'open', future: { retained: true } } } }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: 'policy_version_conflict', detail: 'Reload before saving.' }) });
    vi.stubGlobal('fetch', fetcher); render(<DaoPolicyEditor view={view} />);
    await screen.findByText('Reviewed policy version 7');
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Membership admission' }));
    await user.click(screen.getByRole('option', { name: 'Approval required' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign and save policy' }));
    await screen.findByRole('alert');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ expectedPolicyVersion: 7, policy: { membership: 'approval', future: { retained: true } } });
    expect((screen.getByLabelText('Policy document') as HTMLTextAreaElement).value).toContain('retained');
  });
  it('keeps nonowners read-only and refuses malformed editor input', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, canEdit: false, policy: null, refusal: 'Owner signing device required' }) });
    vi.stubGlobal('fetch', fetcher); render(<DaoPolicyEditor view={view} />);
    await screen.findByText('Owner signing device required');
    expect((screen.getByRole('button', { name: 'Sign and save policy' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Policy document') as HTMLTextAreaElement).disabled).toBe(true);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  });
});

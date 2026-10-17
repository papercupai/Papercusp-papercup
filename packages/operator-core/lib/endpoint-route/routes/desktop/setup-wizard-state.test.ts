import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, update: vi.fn() }));
vi.mock('../../../operator-state-pg', () => ({
  readOperatorState: async () => store.state,
  updateOperatorState: async (table: string, _fallback: unknown, mutate: (state: Record<string, unknown>) => Record<string, unknown>) => {
    store.update(table); store.state = mutate(structuredClone(store.state)); return store.state;
  },
}));
vi.mock('../../../setup-wizard-install-id', () => ({ ensureInstallId: vi.fn() }));
vi.mock('../../../managed-update-policy', async importOriginal => ({
  ...(await importOriginal<object>()), readManagedUpdateChannel: vi.fn(() => null),
}));
import routes, { mergeSetupWizardState } from './setup-wizard-state';
import { ManagedUpdatePolicyError, readManagedUpdateChannel } from '../../../managed-update-policy';

describe('atomic onboarding merge', () => {
  beforeEach(() => { store.state = { step_status: { account: 'completed' }, install_id: 'install-a', dao_launches: { org: { revision: 4 } } }; store.update.mockReset(); vi.mocked(readManagedUpdateChannel).mockReset().mockReturnValue(null); });
  it('refuses a conflicting managed channel before any persistence', async () => {
    vi.mocked(readManagedUpdateChannel).mockReturnValue('stable');
    await expect(mergeSetupWizardState({ update_channel: 'alpha', telemetry_enabled: false }))
      .rejects.toMatchObject({ code: 'update_channel_managed', status: 409 });
    expect(store.update).not.toHaveBeenCalled();
    expect(store.state.telemetry_enabled).toBeUndefined();
  });
  it('allows the managed channel and unrelated edits without replacing identity or drafts', async () => {
    vi.mocked(readManagedUpdateChannel).mockReturnValue('stable');
    await mergeSetupWizardState({ update_channel: 'stable', telemetry_enabled: false });
    expect(store.state).toMatchObject({ update_channel: 'stable', telemetry_enabled: false, install_id: 'install-a', dao_launches: { org: { revision: 4 } } });
  });
  it('keeps unrelated wizard progress writable when policy is invalid', async () => {
    vi.mocked(readManagedUpdateChannel).mockImplementation(() => { throw new ManagedUpdatePolicyError('managed_policy_invalid', 'Invalid administrator policy'); });
    await mergeSetupWizardState({ telemetry_enabled: false });
    expect(store.state.telemetry_enabled).toBe(false);
    await expect(mergeSetupWizardState({ update_channel: 'stable' })).rejects.toMatchObject({ code: 'managed_policy_invalid' });
  });
  it('returns a controlled conflict from the PATCH surface', async () => {
    vi.mocked(readManagedUpdateChannel).mockReturnValue('stable');
    const patch = routes[1] as unknown as { handler: (req: Request) => Promise<Response> };
    const response = await patch.handler(new Request('http://fixture/api/desktop/setup-wizard-state', { method: 'PATCH', body: JSON.stringify({ update_channel: 'alpha' }) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'update_channel_managed' });
    expect(store.update).not.toHaveBeenCalled();
  });
  it('preserves organization drafts and unrelated setup data while editing wizard progress', async () => {
    await mergeSetupWizardState({ last_visited_step: 'permissions', step_status: { permissions: 'dismissed' } });
    expect(store.state.dao_launches).toEqual({ org: { revision: 4 } });
    expect(store.state.install_id).toBe('install-a');
    expect(store.state.step_status).toEqual({ account: 'completed', permissions: 'dismissed' });
    expect(store.update).toHaveBeenCalledWith('setup_wizard_state');
  });
  it('applies independent progress edits without dropping previous committed fields', async () => {
    await Promise.all([mergeSetupWizardState({ telemetry_enabled: false }), mergeSetupWizardState({ update_channel: 'beta' })]);
    expect(store.state.telemetry_enabled).toBe(false);
    expect(store.state.update_channel).toBe('beta');
    expect(store.state.dao_launches).toEqual({ org: { revision: 4 } });
    await mergeSetupWizardState({ step_status: { account: null } });
    expect(store.state.step_status).toEqual({});
  });
});

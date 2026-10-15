import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown>, update: vi.fn() }));
vi.mock('../../../operator-state-pg', () => ({
  readOperatorState: async () => store.state,
  updateOperatorState: async (table: string, _fallback: unknown, mutate: (state: Record<string, unknown>) => Record<string, unknown>) => {
    store.update(table); store.state = mutate(structuredClone(store.state)); return store.state;
  },
}));
vi.mock('../../../setup-wizard-install-id', () => ({ ensureInstallId: vi.fn() }));
import { mergeSetupWizardState } from './setup-wizard-state';

describe('atomic onboarding merge', () => {
  beforeEach(() => { store.state = { step_status: { account: 'completed' }, install_id: 'install-a', dao_launches: { org: { revision: 4 } } }; store.update.mockReset(); });
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

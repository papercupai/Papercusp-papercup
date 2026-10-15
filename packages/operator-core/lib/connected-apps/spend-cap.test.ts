/**
 * Spending caps stop LLM work (external-app-access-to-workspaces-2026-09-29 P-011, D-028).
 *
 *   R-27  a connected app whose recorded spend has reached its cap is refused new LLM-running calls.
 *
 * Exercised through the real dispatch seat (`enforceAppKeyScope`) with the spend read injected, plus
 * the pure verdict and the cap-near / cap-reached alerts the same check raises.
 */
import { describe, expect, it, vi } from 'vitest';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import type { ConnectedAppAlert } from './alerts';
import { enforceAppKeyScope, type EnforceAppKeyScopeDeps } from './enforce';
import { LLM_RUNNING_TOOLS, spendCapVerdict, type AppSpendStatus } from './spend';
import type { AppScopeRow } from './scope-policy';

// Copy-out mutation-probe seam: scripts/mutation-probe.sh points this at a mutated copy in its repo
// mirror, so the shared tree is never mutated. Unset, the real module loads.
vi.mock('./enforce', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_ENFORCE_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

const NOW = new Date('2026-09-30T12:00:00Z');
const KEY: AppScopeRow = {
  id: 'a'.repeat(16),
  workspace_id: 'ws-1',
  scopes: { tools: ['blueprint:*'] },
  revoked_at: null,
  paused_at: null,
  expires_at: null,
};
const APP = { id: KEY.id, workspace_id: 'ws-1', kind: 'service', label: 'nightly sync' };

function seat(spend: AppSpendStatus | null | Error | 'no-loader', alerts: ConnectedAppAlert[] = []) {
  const deps: EnforceAppKeyScopeDeps = {
    loadRow: async (id) => (id === KEY.id ? KEY : null),
    lookupTool: (name) => ({ name, capabilities: [] }),
    now: () => NOW,
    raiseAlert: async (alert) => { alerts.push(alert); },
    loadAlertedApp: async (id) => (id === APP.id ? APP : null),
  };
  if (spend !== 'no-loader') {
    deps.loadSpendStatus = async () => {
      if (spend instanceof Error) throw spend;
      return spend;
    };
  }
  return (toolName: string, slug = `app:${KEY.id}`) =>
    enforceAppKeyScope(
      { toolName, capabilities: [], boundary: 'http', args: {}, ctx: { principal: { slug, workspaceId: 'ws-1' }, workspaceId: 'ws-1' } } as unknown as KernelEnforcementRequest,
      deps,
    );
}

const AT_CAP: AppSpendStatus = { capCents: 500, spentCents: 500, windowSec: null };
const OVER_CAP: AppSpendStatus = { capCents: 500, spentCents: 731.5, windowSec: 30 * 24 * 3600 };
const UNDER_CAP: AppSpendStatus = { capCents: 500, spentCents: 120, windowSec: null };

describe('R-27: a key whose recorded spend reached its cap is refused new LLM-running calls', () => {
  it('refuses blueprint:submit and blueprint:resume at and over the cap', async () => {
    for (const status of [AT_CAP, OVER_CAP]) {
      const call = seat(status);
      for (const tool of ['blueprint:submit', 'blueprint:resume']) {
        expect(await call(tool)).toMatchObject({ decision: 'deny', code: 'app_scope:spend_cap_reached' });
      }
    }
  });

  it('a zero cap refuses new LLM work even at zero spend while preserving reads and cancel', async () => {
    const call = seat({ capCents: 0, spentCents: 0, windowSec: null });
    for (const tool of ['blueprint:submit', 'blueprint:resume']) {
      expect(await call(tool)).toMatchObject({ decision: 'deny', code: 'app_scope:spend_cap_reached' });
    }
    for (const tool of ['blueprint:status', 'blueprint:result', 'blueprint:events', 'blueprint:cancel']) {
      expect(await call(tool)).toBeNull();
    }
  });

  it('refuses through an access token of the key too: spend and the cap are the parent key’s', async () => {
    const call = seat(AT_CAP);
    // A token principal also needs its token row; a seat without a token loader refuses it outright,
    // so the refusal code proves the key is not waved through either way.
    const verdict = await call('blueprint:submit', `app:${KEY.id}/${'t'.repeat(16)}`);
    expect(verdict).toMatchObject({ decision: 'deny' });
  });

  it('allows LLM-running calls under the cap and with no cap', async () => {
    expect(await seat(UNDER_CAP)('blueprint:submit')).toBeNull();
    expect(await seat({ capCents: null, spentCents: 99_999, windowSec: null })('blueprint:submit')).toBeNull();
  });

  it('keeps reads and cancel allowed at the cap, so the app can still see and stop its work', async () => {
    const call = seat(OVER_CAP);
    for (const tool of ['blueprint:status', 'blueprint:result', 'blueprint:events', 'blueprint:cancel']) {
      expect(LLM_RUNNING_TOOLS.has(tool)).toBe(false);
      expect(await call(tool)).toBeNull();
    }
  });

  it('fails closed: a failed or missing spend read refuses the LLM-running call', async () => {
    expect(await seat(new Error('pool exhausted'))('blueprint:submit')).toMatchObject({ code: 'app_scope:spend_unavailable' });
    expect(await seat('no-loader')('blueprint:submit')).toMatchObject({ code: 'app_scope:spend_unavailable' });
    expect(await seat(null)('blueprint:submit')).toMatchObject({ code: 'app_scope:key_unknown' });
  });

  it('the code rides in the reason too, for transports that surface only the reason', async () => {
    const verdict = await seat(AT_CAP)('blueprint:submit');
    expect(verdict?.reason).toMatch(/^app_scope:spend_cap_reached — /);
  });
});

describe('the cap verdict and its alerts (D-006: a cap about to be hit)', () => {
  it('classifies spend against the cap', () => {
    expect(spendCapVerdict({ capCents: 1000, spentCents: 799, windowSec: null }).state).toBe('under');
    expect(spendCapVerdict({ capCents: 1000, spentCents: 800, windowSec: null }).state).toBe('near');
    expect(spendCapVerdict({ capCents: 1000, spentCents: 1000, windowSec: null }).state).toBe('reached');
    expect(spendCapVerdict({ capCents: 0, spentCents: 0, windowSec: null }).state).toBe('reached');
    expect(spendCapVerdict({ capCents: null, spentCents: 5, windowSec: null }).state).toBe('no-cap');
  });

  it('raises a cap-near alert and still allows the call; raises cap-reached with the refusal', async () => {
    const alerts: ConnectedAppAlert[] = [];
    expect(await seat({ capCents: 1000, spentCents: 900, windowSec: 86_400 }, alerts)('blueprint:submit')).toBeNull();
    expect(await seat(AT_CAP, alerts)('blueprint:submit')).toMatchObject({ code: 'app_scope:spend_cap_reached' });
    await vi.waitFor(() => expect(alerts).toHaveLength(2));
    expect(alerts[0]).toMatchObject({ kind: 'spend-cap-near', app: APP, spentCents: 900, capCents: 1000 });
    // A windowed cap's alert names the window it belongs to, so the next window can alert again.
    expect(alerts[0].windowStartMs).toBe(Math.floor(NOW.getTime() / 86_400_000) * 86_400_000);
    expect(alerts[1]).toMatchObject({ kind: 'spend-cap-reached', app: APP, windowStartMs: null });
  });

  it('raises nothing under the cap or for a non-LLM call', async () => {
    const alerts: ConnectedAppAlert[] = [];
    await seat(UNDER_CAP, alerts)('blueprint:submit');
    await seat(OVER_CAP, alerts)('blueprint:status');
    await new Promise((r) => setTimeout(r, 0));
    expect(alerts).toEqual([]);
  });
});

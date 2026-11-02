import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  workspaceCoordOn: false,
  buildSentinelContextDeps: vi.fn(() => ({ marker: 'deps' })),
  gatherSentinelContext: vi.fn(async (_deps: unknown, opts: { potSlug?: string }) => ({
    potSlug: opts.potSlug,
    anomalies: [],
    signals: [],
    headline: null,
  })),
  renderSentinelContext: vi.fn((ctx: { potSlug?: string }) => `status:${ctx.potSlug ?? ''}`),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => false) }));
vi.mock('@papercusp/flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags')>()),
  FLAGS: { PAPERCUP_PROACTIVE: 'sentinel-proactive' } }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  dispatchProjectedToolStream: vi.fn(),
  lookupByMcpName: vi.fn(),
}));
vi.mock('../agent-tools/index', () => ({}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
vi.mock('../voice-prefs', () => ({ loadVoicePrefs: vi.fn(async () => ({})) }));
vi.mock('../device-operator-actions', () => ({ isPaused: vi.fn(async () => false) }));
vi.mock('../operator-budget', () => ({ checkBudget: vi.fn(async () => ({ state: { exceeded: false } })) }));
vi.mock('../operator-conversations', () => ({ getOrCreateActiveConversation: vi.fn(async () => ({ id: 'conv-1' })) }));
vi.mock('../operator-converse-tags', () => ({ parseOperatorTurn: vi.fn(() => ({})) }));
vi.mock('../endpoint-route/routes/agent-mcp/operator-tts', () => ({ synthesize: vi.fn() }));
vi.mock('../voice-node/operator-voice-bus', () => ({ encodeResponseAudio: vi.fn() }));
vi.mock('../voice-node/wav', () => ({ decodeWavPcm16: vi.fn(), resamplePcm16: vi.fn() }));
vi.mock('../workspace-brain-scope', () => ({ isWorkspaceCoordinationOn: vi.fn(async () => h.workspaceCoordOn) }));
vi.mock('./papercup-context', async (importActual) => {
  const actual = await importActual<typeof import('./papercup-context')>();
  return {
    ...actual,
    buildSentinelContextDeps: h.buildSentinelContextDeps,
    gatherSentinelContext: h.gatherSentinelContext,
    renderSentinelContext: h.renderSentinelContext,
  };
});

import { buildSentinelSweepDeps, gatherFleetStatus } from './papercup-proactive-sweep-deps';
import { isPaused } from '../device-operator-actions';

beforeEach(() => {
  vi.mocked(isPaused).mockReset().mockResolvedValue(false);
  h.workspaceCoordOn = false;
  h.buildSentinelContextDeps.mockClear();
  h.gatherSentinelContext.mockClear();
  h.renderSentinelContext.mockClear();
});

it('withholds optional work when the durable pause policy cannot be read', async () => {
  vi.mocked(isPaused).mockRejectedValue(new Error('Startup policy unavailable'));
  await expect(buildSentinelSweepDeps(vi.fn()).isPaused()).rejects.toThrow('Startup policy unavailable');
});

describe('gatherFleetStatus scope label', () => {
  it('OFF passes the primary hive label through unchanged', async () => {
    const status = await gatherFleetStatus('papercusp-workspace', 'papercusp');

    expect(status.context).toBe('status:papercusp');
    expect(h.gatherSentinelContext).toHaveBeenCalledWith({ marker: 'deps' }, { potSlug: 'papercusp' });
  });

  it('ON renders the proactive Sentinel status as workspace-scoped across all hives', async () => {
    h.workspaceCoordOn = true;

    const status = await gatherFleetStatus('papercusp-workspace', 'papercusp');

    expect(status.context).toBe('status:workspace papercusp-workspace (all hives)');
    expect(h.gatherSentinelContext).toHaveBeenCalledWith(
      { marker: 'deps' },
      { potSlug: 'workspace papercusp-workspace (all hives)' },
    );
  });

  it('ON falls back to the workspace id label when the proactive sweep has no primary hive', async () => {
    h.workspaceCoordOn = true;

    const status = await gatherFleetStatus('papercusp-workspace', '');

    expect(status.context).toBe('status:workspace papercusp-workspace (all hives)');
    expect(h.buildSentinelContextDeps).toHaveBeenCalledWith('papercusp-workspace', '');
  });
});

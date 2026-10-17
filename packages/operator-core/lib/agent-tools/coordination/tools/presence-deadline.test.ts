/**
 * coord:presence optional-leg deadlines (EI-26067418447765797).
 *
 * The roster is useful without desktop attribution, coupling expansion, or
 * ambient mode chips. These tests keep each optional leg from turning a stalled
 * dependency into a stalled coord:presence call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_OPTIONAL_LEG_TIMEOUT_MS } from '../presence-snapshot';

const mocks = vi.hoisted(() => ({
  resolvePresenceScope: vi.fn(),
  assemblePresenceSnapshot: vi.fn(),
  listCouplingsFor: vi.fn(),
  deriveCouplings: vi.fn(),
  getModesForOwners: vi.fn(),
}));

vi.mock('../presence-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../presence-snapshot')>()),
  resolvePresenceScope: mocks.resolvePresenceScope,
  assemblePresenceSnapshot: mocks.assemblePresenceSnapshot,
}));

vi.mock('../../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'su-self', coordinationDomain: '/tmp/papercusp-test' })),
}));

vi.mock('../self-marker', () => ({
  resolveSelfRef: vi.fn(() => ({ ownerId: 'su-self' })),
  markSelfRows: vi.fn((rows: unknown[]) => rows),
}));

vi.mock('../presence-cursor-overlay', () => ({
  overlayPresenceCursors: vi.fn(async (rows: unknown[]) => rows),
}));

vi.mock('../../../coord/couplings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../coord/couplings')>()),
  listCouplingsFor: mocks.listCouplingsFor,
}));

vi.mock('../../../coord/coupling-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../coord/coupling-derivation')>()),
  deriveCouplings: mocks.deriveCouplings,
}));

vi.mock('../../../modes/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../modes/store')>()),
  getModesForOwners: mocks.getModesForOwners,
}));

vi.mock('../../../events/await/store', () => ({
  listParkedAwaitsForSubscribers: vi.fn(async () => []),
}));

vi.mock('../inbox-read-freshness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../inbox-read-freshness')>()),
  lastInboxReadAtBatch: vi.fn(async () => new Map()),
}));

import presenceTool from './presence';

const CTX = {
  workspaceId: 'test-workspace',
  harnessSlug: 'papercusp',
  isSuperuser: true,
};

const SNAPSHOT = {
  as_of: '2026-10-16T18:00:00.000Z',
  scope: 'workspace',
  etag: 'etag-1',
  summary: { active: 1, stale: 0, wakeable: 1, byState: { parked: 1, ended: 0, recorded: 0 } },
  active: [{ ownerId: 'su-self', sessionState: 'parked', wakeable: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePresenceScope.mockResolvedValue({ scope: 'workspace', wsId: 'test-workspace', potId: null });
  mocks.assemblePresenceSnapshot.mockResolvedValue(SNAPSHOT);
  mocks.listCouplingsFor.mockResolvedValue([]);
  mocks.deriveCouplings.mockResolvedValue([]);
  mocks.getModesForOwners.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('coord:presence optional-leg deadlines', () => {
  it('keeps a healthy mode read visible', async () => {
    mocks.getModesForOwners.mockResolvedValue(new Map([
      ['su-self', [{ mode: 'auto' }]],
    ]));

    const result = await presenceTool.handler({ include_coupling: false } as never, CTX as never) as {
      data: { active: Array<Record<string, unknown>> };
    };

    expect(result.data.active[0]?.modes).toEqual(['auto']);
  });

  it('degrades a wedged mode read and still returns the roster at the deadline', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.getModesForOwners.mockImplementation(() => new Promise(() => {}));
      const pending = presenceTool.handler({ include_coupling: false } as never, CTX as never);
      await vi.advanceTimersByTimeAsync(PRESENCE_OPTIONAL_LEG_TIMEOUT_MS + 1);
      const result = await pending as { data: { active: Array<Record<string, unknown>> } };

      expect(result.data.active).toHaveLength(1);
      expect(result.data.active[0]).not.toHaveProperty('modes');
    } finally {
      warn.mockRestore();
    }
  });

  it('degrades a wedged coupling read and still returns the roster at the deadline', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.listCouplingsFor.mockImplementation(() => new Promise(() => {}));
      const pending = presenceTool.handler({ include_coupling: true } as never, CTX as never);
      await vi.advanceTimersByTimeAsync(PRESENCE_OPTIONAL_LEG_TIMEOUT_MS + 1);
      const result = await pending as { data: { active: Array<Record<string, unknown>>; expanded?: unknown[] } };

      expect(result.data.active).toHaveLength(1);
      expect(result.data).not.toHaveProperty('expanded');
    } finally {
      warn.mockRestore();
    }
  });
});

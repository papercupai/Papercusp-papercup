/**
 * WI-10006748 — loading cadence-signals must not read the local presence module's bindings.
 *
 * Suites that exercise bootstrap-su blanket-mock `agent-tools/coordination/presence` with a
 * bare factory (e.g. `{ touchHeartbeat }`), because the real module constructs a
 * PgPresenceStore on load. bootstrap-su reaches this module transitively
 * (agent-tools/mode/set -> scout/run -> scout/cadence-signals). Vitest 4 throws on access to
 * an export the factory omitted, so any MODULE-SCOPE read of `listPresence` here crashed
 * those suites at COLLECTION, skipping every test in them. WI-39450 fixed the same defect for
 * PRESENCE_STALE_MS. This file pins the property for the whole module: it must load under a
 * presence mock that exports nothing.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../agent-tools/coordination/presence', () => ({}));

describe('cadence-signals module load (WI-10006748)', () => {
  it('evaluates without touching any export of a bare-mocked presence module', async () => {
    const mod = await import('./cadence-signals');
    expect(typeof mod.countLiveAgents).toBe('function');
  });

  it('injected deps still drive countLiveAgents without the presence module', async () => {
    const { countLiveAgents } = await import('./cadence-signals');
    const now = Date.parse('2026-10-06T16:00:00Z');
    const n = await countLiveAgents('ws', {
      listPresence: async () => [
        { ownerId: 'su-a', heartbeatAt: new Date(now - 1_000).toISOString() },
        { ownerId: 'su-b', heartbeatAt: new Date(now - 1_000).toISOString() },
      ],
      now: () => now,
      staleMs: 60_000,
    });
    expect(n).toBe(2);
  });
});

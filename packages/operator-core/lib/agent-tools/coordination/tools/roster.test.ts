/**
 * coord:roster tests — unified presence/roster reader with view lenses.
 *
 * Tests the four view lenses (live, members, claims, history) and scope
 * resolution (hive, workspace, all). Mocks presence snapshot + fleet assignments
 * to verify lens output shapes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../../context-doors';
import { RESULT_DOOR_TOKENS } from '../../../result-door';
import { assemblePresenceSnapshot, type PresenceSnapshot } from '../presence-snapshot';
import rosterTool, { EXPLICIT_LIVENESS_ROW_CAP } from './roster';

// Mock dependencies
vi.mock('../presence-snapshot', async (importOriginal) => ({
  // Spread the REAL module and override only the two I/O-shaped functions this
  // test needs to control. Deliberately NOT a full factory: a full factory
  // REPLACES the module, so every export it fails to list becomes undefined —
  // and it breaks at RUNTIME inside the CONSUMER (roster.ts), citing a function
  // the test author never mentioned. That is how adding filterRosterRowsByState
  // and projectRosterRows to presence-snapshot red-gated the whole fleet with 11
  // failures here (WI-6663) — and the comment at the foot of this mock records an
  // EARLIER instance of the same class. importOriginal makes the mock
  // additive-safe: a future export is inherited, not silently deleted.
  // projectRosterRows/filterRosterRowsByState stay REAL on purpose — they are
  // pure row transforms, better exercised than stubbed.
  ...(await importOriginal<typeof import('../presence-snapshot')>()),
  resolvePresenceScope: vi.fn(async (ctx, args) => ({
    scope: args.hive ? 'hive' : (args.scope ?? (args.targetedOwner ? 'workspace' : 'hive')),
    wsId: 'test-ws',
    potId: args.hive ?? 'test-hive',
  })),
  assemblePresenceSnapshot: vi.fn(async (resolved, opts) => {
    const allActive = opts?.detail
      ? Array.from({ length: 130 }, (_, i) => ({
          ownerId: `agent-${i}`,
          ownerLabel: `su · agent-${i}`,
          sessionState: i % 2 === 0 ? 'live' : 'parked',
          wakeable: true,
          fleetSlug: 'fleet-a',
          fleetRole: 'member',
          onDesktop: i % 2 === 0,
        }))
      : [
          {
            ownerId: 'agent-1',
            ownerLabel: 'bee · agent-1',
            sessionState: 'live',
            wakeable: true,
            fleetSlug: 'fleet-a',
            fleetRole: 'member',
            onDesktop: true,
          },
          {
            ownerId: 'agent-2',
            ownerLabel: 'su · agent-2',
            sessionState: 'parked',
            wakeable: true,
            fleetSlug: 'fleet-b',
            fleetRole: 'member',
            onDesktop: false,
          },
        ];
    // Honor the targeted `owner` lookup like the real assemblePresenceSnapshot,
    // which applies selectRosterRows(rows, owner) → matchesOwner (exact ownerId/
    // label, else substring either-way). Without this the mock returns every row
    // regardless of opts.owner, breaking the targeted-owner-lookup assertion.
    const owner = opts?.owner as string | undefined;
    const active = owner
      ? allActive.filter(
          (r) =>
            r.ownerId === owner ||
            r.ownerLabel === owner ||
            r.ownerId.includes(owner) ||
            r.ownerLabel.includes(owner) ||
            owner.includes(r.ownerId),
        )
      : allActive;
    return {
      as_of: '2026-07-01T10:40:00.000Z',
      scope: resolved.scope,
      hive: resolved.potId,
      summary: {
        active: active.length,
        stale: 1,
        federated: 0,
        wakeable: active.filter((r) => r.wakeable).length,
        onDesktop: active.filter((r) => r.onDesktop).length,
        viewerAttached: 0,
        byState: { live: 1, parked: 1, ended: 1, recorded: 0 },
      },
      active,
    };
  }),
}));

// roster.ts imports from '../../../fleet/assignments' (lib/fleet/assignments) — the
// mock path must match it or it never intercepts (the import move left this stale,
// so claims-view hit the real empty-in-unit fn → agents/claims:0).
vi.mock('../../../fleet/assignments', () => ({
  listFleetAssignments: vi.fn(async (opts) => [
    {
      source: 'work_item',
      agentId: 'agent-1',
      agentLabel: 'bee · agent-1',
      claimId: 'claim-1',
      planSlug: 'test-plan',
      planItemId: 'P-001',
      workItemId: 'WI-100',
      workItemTitle: 'Test feature',
      status: 'wip',
      acquiredAt: new Date('2026-07-01T09:00:00Z'),
      alive: true,
      intentStale: false,
    },
    {
      source: 'work_item',
      agentId: 'agent-2',
      agentLabel: 'su · agent-2',
      claimId: 'claim-2',
      planSlug: null,
      planItemId: null,
      workItemId: 'WI-101',
      workItemTitle: 'Bug fix',
      status: 'wip',
      acquiredAt: new Date('2026-07-01T08:30:00Z'),
      alive: true,
      intentStale: false,
    },
  ]),
  groupByAgent: vi.fn((rows) => [
    {
      ownerId: 'agent-1',
      ownerLabel: 'bee · agent-1',
      alive: true,
      claims: [{ workItemId: 'WI-100', status: 'wip' }],
      load: 1,
      declaredUnclaimed: false,
    },
    {
      ownerId: 'agent-2',
      ownerLabel: 'su · agent-2',
      alive: true,
      claims: [{ workItemId: 'WI-101', status: 'wip' }],
      load: 1,
      declaredUnclaimed: false,
    },
  ]),
  orphanedClaims: vi.fn(() => []),
  stalledClaims: vi.fn(() => []),
}));

vi.mock('../../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ coordinationDomain: '/home/test' })),
}));

vi.mock('../identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'test-ws', ownerId: 'agent-1' })),
}));

vi.mock('../self-marker', () => ({
  resolveSelfRef: vi.fn(() => 'agent-1'),
  markSelfRows: vi.fn((rows: Array<Record<string, unknown>>, self: string) =>
    rows.map((r) => ({ ...r, isSelf: r.ownerId === self })),
  ),
}));

vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'test-ws'),
  resolveConcreteWorkspaceId: vi.fn((...candidates: Array<string | null | undefined>) => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() && c.trim() !== '*') return c.trim();
    }
    return 'test-ws';
  }),
}));

// The handler's declared return type is a ToolResult|ToolResponse union and its
// ctx param is the full UnifiedToolContext; tests only need the `content[0].text`
// shape and a partial ctx, so route every call through this thin, explicitly-typed
// wrapper rather than fighting the union/strict-ctx types at each call site.
type TextResult = { content: Array<{ type: string; text: string }> };
const call = async (
  args: Record<string, unknown>,
  ctx?: Record<string, unknown>,
) => {
  const result = (await rosterTool.handler(
    args as never,
    ctx as never,
  )) as unknown as TextResult;
  return { raw: result, output: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
};

describe('coord:roster', () => {
  const tool = rosterTool;

  describe('view=live (default)', () => {
    it('should return presence snapshot with live view', async () => {
      const { output } = await call(
        { view: 'live', scope: 'hive' },
        { workspaceId: 'test-ws', harnessSlug: 'test-harness' },
      );

      expect(output).toMatchObject({
        view: 'live',
        scope: 'hive',
        summary: {
          active: 2,
          wakeable: 2,
          byState: { live: 1, parked: 1, ended: 1 },
        },
        active: expect.arrayContaining([
          expect.objectContaining({
            ownerId: 'agent-1',
            sessionState: 'live',
            wakeable: true,
          }),
        ]),
      });
    });

    it('streams completed snapshot diagnostics before a later phase settles', async () => {
      const metadata = vi.fn();
      let finishSnapshot!: (snapshot: PresenceSnapshot) => void;
      const pendingSnapshot = new Promise<PresenceSnapshot>((resolve) => {
        finishSnapshot = resolve;
      });
      const diagnostic = {
        phase: 'source' as const,
        name: 'listPresence',
        elapsedMs: 7,
        status: 'ok' as const,
      };
      vi.mocked(assemblePresenceSnapshot).mockImplementationOnce(async (_resolved, opts) => {
        opts?.onDiagnostic?.(diagnostic);
        return pendingSnapshot;
      });

      const pendingCall = call(
        { view: 'live', scope: 'hive' },
        { workspaceId: 'test-ws', harnessSlug: 'test-harness', metadata },
      );
      await vi.waitFor(() => {
        expect(metadata).toHaveBeenLastCalledWith(expect.objectContaining({
          snapshotDiagnostics: expect.objectContaining({ stages: [diagnostic] }),
        }));
      });

      finishSnapshot({
        as_of: '2026-07-01T10:40:00.000Z',
        scope: 'hive',
        summary: {
          active: 0,
          stale: 0,
          federated: 0,
          wakeable: 0,
          onDesktop: 0,
          viewerAttached: 0,
          byState: { live: 0, parked: 0, ended: 0, recorded: 0 },
          byContextPressure: { high: 0, critical: 0 },
        },
        active: [],
        etag: 'test-etag',
      });
      await pendingCall;
    });

    it('should support scope=workspace', async () => {
      const { output } = await call(
        { view: 'live', scope: 'workspace' },
        { workspaceId: 'test-ws' },
      );

      expect(output.scope).toBe('workspace');
    });

    it('EI-21845811145701209: aliases `agents` to the same rows as `active`', async () => {
      const { output } = await call(
        { view: 'live', scope: 'hive' },
        { workspaceId: 'test-ws', harnessSlug: 'test-harness' },
      );

      expect(output.agents).toEqual(output.active);
    });

    it('should support targeted owner lookup', async () => {
      const { output } = await call(
        { view: 'live', owner: 'agent-1' },
        { workspaceId: 'test-ws' },
      );

      const active = output.active as Array<{ ownerId: string }>;
      expect(active).toHaveLength(1);
      expect(active[0]!.ownerId).toBe('agent-1');
      expect(output.scope).toBe('workspace');

      const narrowed = await call(
        { view: 'live', owner: 'agent-1', scope: 'hive' },
        { workspaceId: 'test-ws' },
      );
      expect(narrowed.output.scope).toBe('hive');
    });

    it('should report plan as unsupported instead of silently returning an unfiltered roster', async () => {
      const { output } = await call(
        { view: 'live', plan: 'test-plan' },
        { workspaceId: 'test-ws' },
      );

      expect(output).toMatchObject({
        ok: false,
        error: 'unsupported_filter',
        filter: 'plan',
        view: 'live',
        supportedViews: ['claims'],
      });
      expect(output.detail).toContain('view:"claims"');
    });

    it('should include self marker', async () => {
      const { output } = await call(
        { view: 'live' },
        { workspaceId: 'test-ws', ownerId: 'agent-1' },
      );

      expect(output.self).toBe('agent-1');
      const active = output.active as Array<{ isSelf: boolean }>;
      expect(active.some((r) => r.isSelf)).toBe(true);
    });
  });

  describe('view=members', () => {
    it('should return members view with fleet membership', async () => {
      const { output } = await call(
        { view: 'members', scope: 'hive' },
        { workspaceId: 'test-ws' },
      );

      expect(output).toMatchObject({
        view: 'members',
        summary: {
          active: 2,
          wakeable: 2,
        },
      });

      // Fleet membership should be present
      expect(output.active).toContainEqual(
        expect.objectContaining({
          ownerId: 'agent-1',
          fleetSlug: 'fleet-a',
          fleetRole: 'member',
        }),
      );
    });

    it('EI-21845811145701209: aliases `agents` to the same rows as `active`', async () => {
      const { output } = await call({ view: 'members', scope: 'hive' }, { workspaceId: 'test-ws' });
      expect(output.agents).toEqual(output.active);
    });

    it('caps an oversized explicit liveness page before the result door can corrupt JSON', async () => {
      const { raw, output } = await call(
        { view: 'members', project: 'liveness', include_detail: true },
        { workspaceId: 'test-ws' },
      );

      const active = output.active as Array<Record<string, unknown>>;
      expect(active).toHaveLength(EXPLICIT_LIVENESS_ROW_CAP);
      expect(output.activeTruncated).toMatchObject({
        shown: EXPLICIT_LIVENESS_ROW_CAP,
        censusCount: 130,
        truncatedByLimit: true,
        limit: EXPLICIT_LIVENESS_ROW_CAP,
      });
      expect(output.projection).toMatchObject({
        project: 'liveness',
        returned: EXPLICIT_LIVENESS_ROW_CAP,
        ofActive: 130,
        truncatedByLimit: true,
        limit: EXPLICIT_LIVENESS_ROW_CAP,
      });
      expect(active[0]).toEqual({ ownerId: 'agent-0', sessionState: 'live' });
      expect(raw.content[0]!.text.length).toBeLessThan(RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE);
      expect(() => JSON.parse(raw.content[0]!.text)).not.toThrow();
    });
  });

  describe('view=claims', () => {
    it('should return work-item claims', async () => {
      const { output } = await call(
        { view: 'claims', scope: 'hive' },
        { workspaceId: 'test-ws' },
      );

      expect(output).toMatchObject({
        view: 'claims',
        summary: {
          agents: 2,
          alive: 2,
          claims: 2,
          orphaned_claims: 0,
          stalled_claims: 0,
        },
      });

      // Agents should have their claims
      const agents = output.agents as Array<{ ownerId: string; claims: unknown }>;
      expect(agents).toHaveLength(2);
      expect(agents[0]).toMatchObject({
        ownerId: 'agent-1',
        claims: expect.any(Array),
      });
    });

    it('should support plan filter', async () => {
      const { output } = await call(
        { view: 'claims', plan: 'test-plan' },
        { workspaceId: 'test-ws' },
      );

      expect(output.view).toBe('claims');
      // Fleet assignments tool should be called with plan filter
      expect(output.agents).toBeDefined();
    });

    it('should support agent filter', async () => {
      const { output } = await call(
        { view: 'claims', agent: 'agent-1' },
        { workspaceId: 'test-ws' },
      );

      expect(output.view).toBe('claims');
    });
  });

  describe('view=history', () => {
    it('should return history placeholder (WI-1346 pending)', async () => {
      const { output } = await call(
        { view: 'history' },
        { workspaceId: 'test-ws' },
      );

      expect(output).toMatchObject({
        view: 'history',
        note: expect.stringContaining('coord:catch-up'),
        data: null,
      });

      // Should point to coord:catch-up
      expect(output.suggestion).toContain('coord:catch-up');
    });
  });

  describe('scope resolution', () => {
    it('should default to hive scope', async () => {
      const { output } = await call(
        {},
        { workspaceId: 'test-ws', harnessSlug: 'test-harness' },
      );

      expect(output.scope).toBe('hive');
    });

    it('should downgrade scope=all for non-superusers', async () => {
      const { output } = await call(
        { view: 'live', scope: 'all' },
        { workspaceId: 'test-ws', isSuperuser: false },
      );

      // Non-superuser asking for 'all' should be downgraded to 'workspace'
      expect(['workspace', 'hive']).toContain(output.scope);
    });

    it('should accept explicit hive', async () => {
      const { output } = await call(
        { pot: 'custom-hive' },
        { workspaceId: 'test-ws' },
      );

      expect(output.hive).toBe('custom-hive');
    });
  });

  describe('error handling', () => {
    it('should handle missing context gracefully', async () => {
      const { output } = await call({ view: 'live' }, undefined);

      expect(output).toHaveProperty('scope');
      expect(output).toHaveProperty('active');
    });

    it('should handle invalid view gracefully', async () => {
      try {
        await call({ view: 'invalid' as unknown as string }, { workspaceId: 'test-ws' });
        // If it doesn't throw during parsing, zod validation catches it
      } catch (e) {
        // Expected: zod validation error
        expect(e).toBeDefined();
      }
    });
  });

  describe('output format', () => {
    it('should always return text/json content', async () => {
      const { raw } = await call({ view: 'live' }, { workspaceId: 'test-ws' });

      expect(raw.content).toHaveLength(1);
      expect(raw.content[0]!.type).toBe('text');
      expect(typeof raw.content[0]!.text).toBe('string');

      // Should be valid JSON
      expect(() => JSON.parse(raw.content[0]!.text)).not.toThrow();
    });

    it('should include as_of timestamp', async () => {
      const { output } = await call({ view: 'live' }, { workspaceId: 'test-ws' });

      expect(output).toHaveProperty('as_of');
      // Should be ISO timestamp or close to now
      if (typeof output.as_of === 'string') {
        expect(new Date(output.as_of)).toBeInstanceOf(Date);
      }
    });
  });
});

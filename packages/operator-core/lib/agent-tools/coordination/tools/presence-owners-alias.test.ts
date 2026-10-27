/**
 * coord:presence `ownerIds` compatibility coverage — the plural counterpart of
 * presence-owner-alias.test.ts.
 *
 * `owner`/`ownerId` already accept the roster row's singular field-name spelling
 * as a compatibility alias. Callers naturally guess the same pattern for the
 * bounded plural lookup (`owners`) and reach for `ownerIds` — the exact spelling
 * used internally throughout this package (see `ownerIds` as a function
 * parameter name in liveness-decoration.ts, presence-reaper.ts,
 * context-pressure.ts, etc.). EI-21631841527230352: a caller was rejected with
 * `invalid_args` for passing `ownerIds`, even though the sibling singular alias
 * (`ownerId` → `owner`) is accepted. This file proves `ownerIds` is now
 * normalized to the canonical `owners` selector the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  resolvePresenceScope: vi.fn(),
  assemblePresenceSnapshot: vi.fn(),
}));

vi.mock('../presence-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../presence-snapshot')>()),
  resolvePresenceScope: mocks.resolvePresenceScope,
  assemblePresenceSnapshot: mocks.assemblePresenceSnapshot,
}));

vi.mock('../../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ coordinationDomain: '/tmp/papercusp-test' })),
}));

vi.mock('../self-marker', () => ({
  resolveSelfRef: vi.fn(() => null),
  markSelfRows: vi.fn((rows: unknown[]) => rows),
}));

vi.mock('../presence-cursor-overlay', () => ({
  overlayPresenceCursors: vi.fn(async (rows: unknown[]) => rows),
}));

import presenceTool from './presence';

describe('coord:presence ownerIds compatibility alias', () => {
  beforeEach(() => {
    mocks.resolvePresenceScope.mockReset().mockResolvedValue({
      scope: 'workspace',
      wsId: 'test-workspace',
      potId: null,
    });
    mocks.assemblePresenceSnapshot.mockReset().mockResolvedValue({
      as_of: '2026-08-30T17:00:00.000Z',
      scope: 'workspace',
      etag: 'etag-1',
      summary: { active: 0, wakeable: 0, byState: {} },
      active: [],
    });
  });

  it('normalizes ownerIds to the canonical owners selector before scope and snapshot reads', async () => {
    // WI-6554700010029664: the fold runs in the schema's preprocess (dispatch parses before
    // the handler), so drive the handler with the PARSED args, exactly as dispatch does.
    await presenceTool.handler(
      presenceTool.args.parse({ ownerIds: ['su-a', 'su-b'] }) as never,
      { workspaceId: 'test-workspace', harnessSlug: 'papercusp', isSuperuser: true } as never,
    );

    expect(mocks.resolvePresenceScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetedOwner: true }),
    );
    expect(mocks.assemblePresenceSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owners: ['su-a', 'su-b'] }),
    );
    expect(mocks.assemblePresenceSnapshot.mock.calls[0]?.[1]).not.toHaveProperty('ownerIds');
  });

});

describe('coord:presence ownerIds schema validation', () => {
  // Zod schema validation runs at the dispatch layer (args.safeParse), never
  // inside .handler — mirrors presence-roster-select.test.ts's targeted-owner
  // schema coverage for owner/ownerId/owners.
  it('accepts ownerIds alone, and rejects it combined with owner/ownerId/owners', () => {
    expect(presenceTool.args.safeParse({ ownerIds: ['su-a', 'su-b'] }).success).toBe(true);
    expect(presenceTool.args.safeParse({ owner: 'su-a', ownerIds: ['su-b'] }).success).toBe(false);
    expect(presenceTool.args.safeParse({ ownerId: 'su-a', ownerIds: ['su-b'] }).success).toBe(false);
    expect(presenceTool.args.safeParse({ owners: ['su-a'], ownerIds: ['su-b'] }).success).toBe(false);
    expect(presenceTool.args.safeParse({ ownerIds: [] }).success).toBe(false);
    expect(presenceTool.args.safeParse({ ownerIds: Array.from({ length: 51 }, (_, i) => `su-${i}`) }).success).toBe(
      false,
    );
  });

  it('folds ownerId/ownerIds into owner/owners and does not advertise them (WI-6554700010029664)', () => {
    expect(presenceTool.args.parse({ ownerId: 'su-a' })).toEqual({ owner: 'su-a' });
    expect(presenceTool.args.parse({ ownerIds: ['su-a'] })).toEqual({ owners: ['su-a'] });
    // The canonical selector is untouched; an absent alias is a no-op.
    expect(presenceTool.args.parse({ owner: 'su-a' })).toEqual({ owner: 'su-a' });
    // "pass one, not both" still names the alias path the caller used.
    const both = presenceTool.args.safeParse({ owner: 'su-a', ownerId: 'su-b' });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.path).toEqual(['ownerId']);
    // ownerId combined with owners is still refused once folded into owner.
    expect(presenceTool.args.safeParse({ ownerId: 'su-a', owners: ['su-b'] }).success).toBe(false);
    const advertised = Object.keys(
      (z.toJSONSchema(presenceTool.args, { io: 'input' }) as { properties?: object }).properties ?? {},
    );
    expect(advertised).toContain('owner');
    expect(advertised).toContain('owners');
    expect(advertised).not.toContain('ownerId');
    expect(advertised).not.toContain('ownerIds');
  });
});

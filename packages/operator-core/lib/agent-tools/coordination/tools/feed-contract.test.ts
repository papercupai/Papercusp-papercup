/**
 * coord:feed's agent-facing time-filter contract.
 *
 * `since` is the preferred spelling used by neighboring coordination reads;
 * `since_ts` remains a compatibility alias for existing callers and docs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { splitLocalSchemaTarget } from '@papercusp/tooldef';
import {
  COORD_CONVERSATIONAL_KINDS,
  COORD_EXECUTABLE_KINDS,
} from '@papercusp/coordination/core';

const readCoordFeed = vi.hoisted(() =>
  vi.fn(async (
    _opts?: unknown,
    _observePhase?: (phase: {
      name: string;
      round: number;
      status: 'running' | 'fulfilled' | 'rejected';
      startedAt: string;
      elapsedMs: number | null;
      returnedRows?: number;
      exhausted?: boolean;
    }) => void,
  ): Promise<{
    rows: never[];
    nextCursor: string | null;
    nextCursorMsgId: string | null;
    total: number;
    byKind: Record<string, number>;
    tokens: number;
  }> => ({
    rows: [],
    nextCursor: null,
    nextCursorMsgId: null,
    total: 0,
    byKind: {},
    tokens: 0,
  })),
);

vi.mock('../feed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../feed')>();
  return { ...actual, readCoordFeed };
});

import tool from './feed';

beforeEach(() => {
  readCoordFeed.mockClear();
});

describe('coord:feed — since compatibility', () => {
  it('declares preferred `since` while retaining legacy `since_ts`', () => {
    expect(Object.keys(tool.args.shape)).toContain('since');
    expect(Object.keys(tool.args.shape)).toContain('since_ts');
  });

  it('maps preferred `since` to the existing readCoordFeed since_ts seam', async () => {
    await tool.handler({ since: '2026-08-12T00:00:00.000Z' } as never, {} as never);
    expect(readCoordFeed.mock.calls[0]?.[0]).toMatchObject({ since_ts: '2026-08-12T00:00:00.000Z' });
  });

  it('keeps legacy `since_ts` working and prefers `since` when both are supplied', async () => {
    await tool.handler({ since_ts: '2026-08-11T00:00:00.000Z' } as never, {} as never);
    expect(readCoordFeed.mock.calls.at(-1)?.[0]).toMatchObject({ since_ts: '2026-08-11T00:00:00.000Z' });

    await tool.handler(
      { since: '2026-08-12T00:00:00.000Z', since_ts: '2026-08-11T00:00:00.000Z' } as never,
      {} as never,
    );
    expect(readCoordFeed.mock.calls.at(-1)?.[0]).toMatchObject({ since_ts: '2026-08-12T00:00:00.000Z' });
  });
});

describe('coord:feed — ISO time-boundary validation', () => {
  it.each(['since', 'since_ts', 'before_ts'] as const)('rejects malformed double-Z `%s` values', (field) => {
    expect(
      tool.args.safeParse({ [field]: '2026-09-08T09:12:00ZZ' }).success,
      `${field} must reject malformed ISO timestamps before they become NaN filter bounds`,
    ).toBe(false);
  });

  it('accepts valid ISO time-boundary values', () => {
    expect(
      tool.args.safeParse({
        since: '2026-09-08T09:12:00.000Z',
        since_ts: '2026-09-08T09:12:00+00:00',
        before_ts: '2026-09-08T09:12:00Z',
      }).success,
    ).toBe(true);
  });
});

describe('coord:feed — fleet compatibility alias', () => {
  it('declares both canonical audience and legacy fleet filters', () => {
    expect(Object.keys(tool.args.shape)).toContain('audience');
    expect(Object.keys(tool.args.shape)).toContain('fleet');
  });

  it('normalizes a fleet slug or human name to the audience filter', async () => {
    await tool.handler({ fleet: 'Backend Team' } as never, {} as never);
    expect(readCoordFeed.mock.calls.at(-1)?.[0]).toMatchObject({ audience: '@fleet:backend-team' });
  });

  it('prefers the canonical audience when both filters are supplied', async () => {
    await tool.handler(
      { fleet: 'ignored-fleet', audience: '@topic:coordination' } as never,
      {} as never,
    );
    expect(readCoordFeed.mock.calls.at(-1)?.[0]).toMatchObject({ audience: '@topic:coordination' });
  });
});

describe('coord:feed — inbox-only shaping redirects (EI-22057308172107761)', () => {
  it.each([
    ['include_ambient', { include_ambient: true }],
    // The camelCase spelling redirects to the DECLARED snake_case key: a remedy whose args
    // use an undeclared alias fails guidance-registry conformance (WI-6554700010030420).
    ['includeAmbient', { include_ambient: true }],
    ['include_intents', { include_intents: true }],
    ['max_body_chars', { max_body_chars: 200 }],
  ] as const)('redirects `%s` to coord:inbox with a valid example', (key, args) => {
    expect(Object.keys(tool.args.shape)).not.toContain(key);
    expect(tool.guidance?.argRedirects?.[key]).toEqual({
      tool: 'coord:inbox',
      args,
      note: expect.stringContaining('coord:inbox'),
    });
  });
});

/**
 * EI-21830525619029268 — a read was rejected for passing `after` as the lower time bound.
 *
 * WHY THE GUESS IS THE TOOL'S OWN FAULT, not an API habit imported from elsewhere: this
 * tool declares `before_ts` / `before_msg_id` for the UPPER bound but spells the lower
 * bound `since`. A caller who has just read the `before_*` pair infers the symmetric
 * `after` from THIS schema. The bare rejection could only list accepted keys, and `since`
 * does not look like the counterpart of `before_ts` unless you already know it is.
 *
 * Kept a redirect, not an accepted alias: `since`/`since_ts` is the spelling shared across
 * the coordination reads, and a third accepted spelling here would widen the drift the
 * neighbouring tools are converging away from.
 */
describe('coord:feed — `after` lower-bound redirect (EI-21830525619029268)', () => {
  const declared = Object.keys(tool.args.shape);

  it('does not accept `after`, and does declare the `since` it redirects to', () => {
    expect(declared).not.toContain('after');
    expect(declared).toContain('since');
    expect(tool.args.safeParse({ after: '2026-09-05T00:00:00.000Z' }).success).toBe(false);
  });

  it('renders as a SAME-TOOL relocation to `since`, not a cross-tool misattribution (D-004)', () => {
    const target = tool.guidance?.argRedirects?.after;
    expect(typeof target).toBe('string');

    const split = splitLocalSchemaTarget(target as string, declared);
    // Null is the D-004 defect: the renderer would attribute the caller's own time
    // filter to some other tool while they are already in an error path.
    expect(split, '`after` redirect must be authored as `since — explanation`').not.toBeNull();
    expect(split?.path).toBe('since');
  });

  it('explains the before_ts asymmetry and that dropping the key widens the window', () => {
    const split = splitLocalSchemaTarget(tool.guidance?.argRedirects?.after as string, declared);
    // Without this, "unrecognized key" reads as "this tool has no lower bound", whose
    // honest remedy is to drop it — and dropping it SUCCEEDS, silently returning the
    // whole retained stream instead of the window that was asked for.
    expect(split?.note).toContain('before_ts');
    expect(split?.note).toMatch(/rename/i);
  });
});

describe('coord:feed — canonical kind filter parity', () => {
  it('accepts every canonical CoordKind, including executable yield', () => {
    const canonicalKinds = [...COORD_EXECUTABLE_KINDS, ...COORD_CONVERSATIONAL_KINDS];

    for (const kind of canonicalKinds) {
      expect(
        tool.args.safeParse({ kinds: [kind] }).success,
        `coord:feed should accept canonical kind ${kind}`,
      ).toBe(true);
    }
  });
});

describe('coord:feed — lossless composite pagination cursor', () => {
  it('declares the companion message-id input', () => {
    expect(Object.keys(tool.args.shape)).toContain('before_ts');
    expect(Object.keys(tool.args.shape)).toContain('before_msg_id');
  });

  it('passes the cursor pair to the reader and returns both halves to callers', async () => {
    readCoordFeed.mockResolvedValueOnce({
      rows: [],
      nextCursor: '2026-08-26T12:00:00.000Z',
      nextCursorMsgId: 'm-boundary',
      total: 3,
      byKind: { message: 3 },
      tokens: 0,
    });

    const result = (await tool.handler(
      {
        before_ts: '2026-08-26T12:00:00.000Z',
        before_msg_id: 'm-boundary',
      } as never,
      {} as never,
    )) as { content: { text: string }[] };

    expect(readCoordFeed.mock.calls.at(-1)?.[0]).toMatchObject({
      before_ts: '2026-08-26T12:00:00.000Z',
      before_msg_id: 'm-boundary',
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.next_cursor).toBe('2026-08-26T12:00:00.000Z');
    expect(payload.next_cursor_msg_id).toBe('m-boundary');
  });
});

describe('coord:feed — read-phase metadata', () => {
  it('persists per-surface timing phases through the invocation metadata context', async () => {
    readCoordFeed.mockImplementationOnce(async (_opts, observePhase) => {
      observePhase?.({
        name: 'surface-read:messages',
        round: 1,
        status: 'fulfilled',
        startedAt: '2026-10-31T00:00:00.000Z',
        elapsedMs: 12,
        returnedRows: 0,
        exhausted: true,
      });
      return {
        rows: [],
        nextCursor: null,
        nextCursorMsgId: null,
        total: 0,
        byKind: {},
        tokens: 0,
      };
    });

    const metadata = vi.fn();
    await tool.handler({ limit: 15 } as never, { metadata } as never);

    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      coordFeedRead: expect.objectContaining({
        schemaVersion: 'coord-feed-read-phases-v1',
        unit: 'ms',
        timing: 'awaited-helper-wall-time',
        resultState: 'fulfilled',
        request: expect.objectContaining({ limit: 15 }),
        readElapsedMs: expect.any(Number),
        phases: [expect.objectContaining({
          name: 'surface-read:messages',
          round: 1,
          status: 'fulfilled',
          elapsedMs: 12,
          returnedRows: 0,
          exhausted: true,
        })],
      }),
    }));
  });
});

import { describe, expect, it } from 'vitest';
import {
  ADV_SESSIONS_PAGE_LIMIT,
  NO_SESSION_HARNESS,
  NO_SESSION_PLAN,
  advSessionsSummarySelection,
  buildAdvSessionsPredicate,
  decodeAdvSessionsCursor,
  encodeAdvSessionsCursor,
  normalizeAdvSessionsListArgs,
  readAdvSessionsSummaryFromStore,
} from './adv-sessions-list-query';

describe('adv sessions list predicate', () => {
  it('canonicalizes multi-selects, clamps the bounded page, and rejects malformed cursors', () => {
    expect(
      normalizeAdvSessionsListArgs({
        workspaceId: ' ws-1 ',
        harnessSlugs: [' beta ', 'alpha', 'alpha', ''],
        planSlugs: [NO_SESSION_PLAN, 'plan-b', 'plan-b'],
        cursor: '{bad',
        limit: 50_000,
      }),
    ).toEqual({
      workspaceId: 'ws-1',
      harnessSlugs: ['alpha', 'beta'],
      planSlugs: [NO_SESSION_PLAN, 'plan-b'].sort(),
      cursor: null,
      limit: ADV_SESSIONS_PAGE_LIMIT,
    });
    expect(decodeAdvSessionsCursor('null')).toBeNull();
  });

  it('round-trips the immutable birth/id keyset cursor', () => {
    const cursor = encodeAdvSessionsCursor({
      id: 42,
      firstSeenAt: '2026-08-22T07:00:00.000Z',
    });
    expect(decodeAdvSessionsCursor(cursor)).toEqual({
      id: 42,
      firstSeenAt: '2026-08-22T07:00:00.000Z',
    });
  });

  it('projects the exact plan/harness selections used by the companion facet response', () => {
    const args = normalizeAdvSessionsListArgs({
      harnessSlugs: ['papercusp', NO_SESSION_HARNESS],
      planSlugs: ['plan-a'],
    });
    const selection = advSessionsSummarySelection(args)!;
    expect([...selection.get('harness')!]).toEqual([
      NO_SESSION_HARNESS,
      'papercusp',
    ]);
    expect([...selection.get('plan')!]).toEqual(['plan-a']);
    expect(buildAdvSessionsPredicate(args).fingerprint).toBe(JSON.stringify(args));
    expect(advSessionsSummarySelection(normalizeAdvSessionsListArgs({}))).toBeUndefined();
  });
});

describe('advSessions summary payload-growth guard', () => {
  it('materializes only facet scalars and reads launch JSON only while projection is pending', async () => {
    type Fragment = { strings: readonly string[]; values: unknown[]; then: (resolve: (rows: never[]) => unknown) => unknown };
    let query: Fragment | undefined;
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const fragment: Fragment = { strings, values, then: (resolve) => resolve([]) };
      query = fragment;
      return fragment;
    };
    const render = (fragment: Fragment): string => fragment.strings.reduce((text, part, index) => {
      const value = fragment.values[index];
      return text + part + (index < fragment.values.length
        ? value && typeof value === 'object' && 'strings' in value
          ? render(value as Fragment)
          : '?'
        : '');
    }, '');
    await readAdvSessionsSummaryFromStore(sql as never,
      buildAdvSessionsPredicate(normalizeAdvSessionsListArgs({ workspaceId: 'ws-1' })));
    const text = render(query!);
    expect(text).toContain('CASE WHEN a.launch_harness_projection IS NULL');
    expect(text).toContain("ELSE a.launch_harness_projection #>> '{}'");
    expect(text).toContain('session_corpus AS MATERIALIZED');
    for (const unused of ['to_jsonb(a)', 'a.port_metadata', 'a.cwd', 'a.label']) {
      expect(text).not.toContain(unused);
    }
  });
});

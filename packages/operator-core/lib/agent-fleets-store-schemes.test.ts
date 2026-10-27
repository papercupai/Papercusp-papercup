import type { Sql } from 'postgres';
import { expect, it, vi } from 'vitest';
import { getFleetSchemes } from './agent-fleets-store';
import { COLOR_SCHEMES, schemeForSlug } from './console-color-schemes';

it('reads only distinct requested bindings in one workspace and preserves catalog fallbacks', async () => {
  const bound = COLOR_SCHEMES[1]!;
  const unsafe = vi.fn().mockResolvedValue([
    { fleet_slug: 'bound', color_scheme: bound.name },
    { fleet_slug: 'legacy', color_scheme: null },
    { fleet_slug: 'unknown-scheme', color_scheme: 'not-in-the-catalog' },
  ]);
  const sql = { unsafe } as unknown as Sql;

  const result = await getFleetSchemes('ws-a',
    ['bound', 'legacy', 'unknown-scheme', 'missing', 'bound', ''], sql);

  expect(unsafe).toHaveBeenCalledTimes(1);
  expect(unsafe).toHaveBeenCalledWith(expect.stringContaining('workspace_id = $1'),
    ['ws-a', ['bound', 'legacy', 'unknown-scheme', 'missing']]);
  expect(unsafe.mock.calls[0]![0]).toContain('fleet_slug = ANY($2::text[])');
  expect(result.get('bound')).toEqual(bound);
  expect(result.get('legacy')).toEqual(schemeForSlug('legacy'));
  expect(result.get('unknown-scheme')).toEqual(schemeForSlug('unknown-scheme'));
  expect(result.has('missing')).toBe(false);
});

it('does not query when the requested set is empty', async () => {
  const unsafe = vi.fn();
  expect(await getFleetSchemes('ws-a', ['', ''], { unsafe } as unknown as Sql)).toEqual(new Map());
  expect(unsafe).not.toHaveBeenCalled();
});

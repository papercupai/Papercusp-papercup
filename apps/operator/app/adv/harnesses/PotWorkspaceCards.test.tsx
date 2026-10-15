// @vitest-environment jsdom
//
// PotWorkspaceCards — the all-mode (`?scope=all`, "All Pots") workspace view,
// redesigned as a flat, sortable RichGrid list (WI-3345). Purely presentational
// (props in, DOM out); deps are useLexicon (mocked) + the shared RichGrid. We
// assert the EMPTY state (with/without onCreate), one row per pot (roots +
// members), that a hive HOME is a root row and NOT also a member row, the
// description / shared / live-state affordances, and that clicking a root /
// member row fires onDrill with (hiveRootSlug, rowSlug).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// useLexicon: t('pot') → 'Pot', t('pot',{plural}) → 'Pots',
// t('harness',{plural}) → 'Harnesses'. Enough for the labels this view reads.
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string, opts?: { plural?: boolean }) => {
    const cap = term[0].toUpperCase() + term.slice(1);
    if (!opts?.plural) return cap;
    return term === 'pot' ? 'Pots' : term === 'harness' ? 'Harnesses' : `${cap}s`;
  },
}));

import PotWorkspaceCards, {
  flattenPotRows,
  type HiveWorkspaceCardsProps,
  type PotProject,
} from './PotWorkspaceCards';
import type { HiveGroup } from './harness-pot-groups';

afterEach(() => cleanup());

function proj(slug: string, over: Partial<PotProject> = {}): HiveGroup['root'] {
  return { slug, ...over } as HiveGroup['root'];
}
function group(rootSlug: string, members: HiveGroup['members'], rootOver: Partial<PotProject> = {}): HiveGroup {
  return { root: proj(rootSlug, rootOver), members };
}

describe('flattenPotRows', () => {
  it('emits one row per distinct pot: root first, then non-root members', () => {
    const rows = flattenPotRows([
      group('alpha', [proj('alpha'), proj('alpha-web')]),
      group('beta', [proj('beta')]),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(['alpha', 'alpha-web', 'beta']);
    // root carries the sub-harness count (non-root members); members carry null
    expect(rows[0]).toMatchObject({ slug: 'alpha', isRoot: true, memberCount: 1, hiveRootSlug: 'alpha' });
    expect(rows[1]).toMatchObject({ slug: 'alpha-web', isRoot: false, memberCount: null, hiveRootSlug: 'alpha', hiveLabel: 'alpha' });
    expect(rows[2]).toMatchObject({ slug: 'beta', isRoot: true, memberCount: 0 });
  });

  it('never emits the hive HOME as a member row', () => {
    const rows = flattenPotRows([
      group('demo-hive', [proj('demo-hive', { harness_kind: 'hive' }), proj('demo')], { harness_kind: 'hive' }),
    ]);
    expect(rows.map((r) => r.slug)).toEqual(['demo-hive', 'demo']);
    expect(rows[0]).toMatchObject({ slug: 'demo-hive', isRoot: true, kind: 'hive', memberCount: 1 });
    expect(rows[1]).toMatchObject({ slug: 'demo', isRoot: false, hiveRootSlug: 'demo-hive' });
  });
});

describe('<PotWorkspaceCards /> empty state', () => {
  it('renders the no-pots hint (pluralized, lowercased) with no grid rows', () => {
    render(<PotWorkspaceCards groups={[]} onDrill={vi.fn()} />);
    expect(screen.getByText(/no pots yet\./i)).toBeTruthy();
    expect(screen.queryByTestId('hive-card-alpha')).toBeNull();
  });

  it('omits the Create button when no onCreate is supplied', () => {
    render(<PotWorkspaceCards groups={[]} onDrill={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /create new pot/i })).toBeNull();
  });

  it('shows the Create button and fires onCreate when supplied', () => {
    const onCreate = vi.fn();
    render(<PotWorkspaceCards groups={[]} onDrill={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /create new pot/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

describe('<PotWorkspaceCards /> list', () => {
  // The root's own metadata (hasState/description/is_shared) lives on the ROOT
  // override — mirroring groupByHive, where the root and its lite entry are the
  // same object; the flat root row reads from `g.root`, not a member copy.
  const groups: HiveWorkspaceCardsProps['groups'] = [
    group(
      'alpha',
      [proj('alpha-web', { harness_kind: 'sub', hasState: false })],
      { hasState: true, is_shared: true, description: 'The alpha pot.' },
    ),
    group('beta', [proj('beta')]),
  ];

  it('renders the workspace-cards container and a row per pot', () => {
    render(<PotWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    expect(screen.getByTestId('pot-workspace-cards')).toBeTruthy();
    expect(screen.getByTestId('hive-card-alpha')).toBeTruthy();
    expect(screen.getByTestId('hive-member-alpha-web')).toBeTruthy();
    expect(screen.getByTestId('hive-card-beta')).toBeTruthy();
  });

  it('does NOT list the hive HOME (harness_kind:hive) as a member row', () => {
    const grps: HiveWorkspaceCardsProps['groups'] = [
      group('demo-hive', [proj('demo-hive', { harness_kind: 'hive' }), proj('demo', { hasState: true })], {
        harness_kind: 'hive',
      }),
    ];
    render(<PotWorkspaceCards groups={grps} onDrill={vi.fn()} />);
    expect(screen.getByTestId('hive-card-demo-hive')).toBeTruthy();
    expect(screen.queryByTestId('hive-member-demo-hive')).toBeNull();
    expect(screen.getByTestId('hive-member-demo')).toBeTruthy();
  });

  it('shows the shared affordance only on a shared root', () => {
    render(<PotWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    expect(screen.getByTestId('hive-card-alpha').querySelector('.pc-pot-shared')).toBeTruthy();
    expect(screen.getByTestId('hive-card-beta').querySelector('.pc-pot-shared')).toBeNull();
  });

  it('marks a pot with state via the is-live dot and shows the description', () => {
    render(<PotWorkspaceCards groups={groups} onDrill={vi.fn()} />);
    const alpha = screen.getByTestId('hive-card-alpha');
    expect(alpha.querySelector('.pc-pot-dot.is-live')).toBeTruthy();
    expect(alpha.textContent).toContain('The alpha pot.');
    // a pot without state → no live dot
    expect(screen.getByTestId('hive-member-alpha-web').querySelector('.pc-pot-dot.is-live')).toBeNull();
  });

  it('drills into the root when its row is clicked (hive===member===root)', () => {
    const onDrill = vi.fn();
    render(<PotWorkspaceCards groups={groups} onDrill={onDrill} />);
    fireEvent.click(screen.getByTestId('hive-card-alpha'));
    expect(onDrill).toHaveBeenCalledWith('alpha', 'alpha');
  });

  it('drills into a member with (hiveRoot, memberSlug)', () => {
    const onDrill = vi.fn();
    render(<PotWorkspaceCards groups={groups} onDrill={onDrill} />);
    fireEvent.click(screen.getByTestId('hive-member-alpha-web'));
    expect(onDrill).toHaveBeenCalledWith('alpha', 'alpha-web');
  });

  it.each(['Enter', ' '])('activates the focused root and exact member with %j', (key) => {
    const onDrill = vi.fn();
    render(<PotWorkspaceCards groups={groups} onDrill={onDrill} />);
    const root = screen.getByTestId('hive-card-alpha');
    const member = screen.getByTestId('hive-member-alpha-web');
    root.focus();
    expect(fireEvent.keyDown(root, { key })).toBe(false);
    member.focus();
    expect(fireEvent.keyDown(member, { key })).toBe(false);
    expect(onDrill.mock.calls).toEqual([['alpha', 'alpha'], ['alpha', 'alpha-web']]);
  });

  it('does not activate from another key, a modified chord or a descendant', () => {
    const onDrill = vi.fn();
    render(<PotWorkspaceCards groups={groups} onDrill={onDrill} />);
    const row = screen.getByTestId('hive-member-alpha-web');
    for (const event of [{ key: 'ArrowDown' }, { key: 'Enter', ctrlKey: true },
      { key: 'Enter', metaKey: true }, { key: ' ', altKey: true }, { key: 'Enter', shiftKey: true }]) {
      expect(fireEvent.keyDown(row, event)).toBe(true);
    }
    fireEvent.keyDown(row.querySelector('.pc-pot-name__slug')!, { key: 'Enter' });
    expect(onDrill).not.toHaveBeenCalled();
  });

  // WI-10006513: on the cloud portal's Work tab at 1024x650 the bare 0.9fr
  // Kind/Shared tracks fell to 58px — under the 62px "HARNESS" badge / 52px
  // "shared" pill + 20px cell padding — and every row cut its badge (cells
  // are overflow:hidden). The tracks must carry a px floor so the grid's
  // scroller takes the overflow instead.
  it('floors the Kind and Shared tracks so their badges are never cut on narrow windows', () => {
    const { container } = render(<PotWorkspaceCards groups={groups} onDrill={() => {}} />);
    const templates = [...container.querySelectorAll<HTMLElement>('*')]
      .map((el) => el.style.gridTemplateColumns)
      .filter(Boolean);
    // Positive control: the grid really rendered column templates to inspect.
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t).toContain('minmax(84px, 0.9fr)');
      expect(t).toContain('minmax(76px, 0.9fr)');
      // No chip-bearing 0.9fr track is left bare (the pre-fix shape).
      expect(t.split(' ').filter((track) => track === '0.9fr')).toHaveLength(0);
    }
  });
});

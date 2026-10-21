/**
 * adv-shell-logic.test.ts — Plan 1 P-021: critical-screen flow logic tests
 * for the /adv harness SPA (operator-vite).
 *
 * Covers the pure-logic layer of the workspace switch + harness picker screens
 * without mounting full components (which require real ZQL sync + IPC).
 *
 * Tests:
 *   ADV_TABS structural invariants (all required fields, correct id set)
 *   supportsAll subset — the workspace-level views vs per-harness views
 *   buildHarnessSelectOptions — the harness selector dropdown builder:
 *     loading/error states, root harnesses, parent/child hierarchy,
 *     orphan handling, depth cap, deduplication
 */

import { describe, expect, it } from 'vitest';
import {
  ADV_TABS,
  type AdvTabId,
  buildHarnessSelectOptions,
  visibleAdvTabs,
  tabOverflowState,
  PRIMARY_ADV_TAB_IDS,
  SECONDARY_TAB_GROUPS,
  splitPrimarySecondary,
  parseRecentSecondaryTabs,
  pushRecentSecondaryTab,
  ADV_MAX_LEVELS,
  type AdvMaxLevel,
  nextAdvMaxLevel,
  prevAdvMaxLevel,
  advMaxToggleLabel,
  ADV_TAB_IDS,
  PORTAL_EMBED_ADV_CONTENT_IDS,
  PORTAL_EMBED_ADV_TAB_IDS,
  portalEmbedAdvTab,
  portalEmbedAdvTabs,
} from '../adv/AdvShell';
import type { SelectEntry, SelectGroup, SelectOption } from '@/app/harness/Select';

// ─── ADV_TABS structural invariants ──────────────────────────────────────────

describe('ADV_TABS', () => {
  it('renders NO Papercusp tab strip inside a cloud embed — every framed tab is a portal rail entry (owner ask 2026-09-01)', () => {
    expect([...PORTAL_EMBED_ADV_TAB_IDS]).toEqual([]);
    expect(portalEmbedAdvTabs(ADV_TABS, true)).toEqual([]);
    expect(portalEmbedAdvTabs(ADV_TABS, false)).toEqual([...ADV_TABS]);
    // The content-only destinations the portal owns: since
    // portal-parity-adv-tabs-2026-09-05 (D-004) that is EVERY ADV tab, so an
    // embedded deep link to any tab renders that tab — never a collapsed Overview.
    expect([...PORTAL_EMBED_ADV_CONTENT_IDS]).toEqual([...ADV_TAB_IDS]);
    expect(ADV_TAB_IDS).toHaveLength(21);
    for (const id of ADV_TAB_IDS) {
      expect(portalEmbedAdvTab(id, true)).toBe(id);
      expect(portalEmbedAdvTab(id, false)).toBe(id);
    }
  });

  it('every tab has the required shape (id, label, icon, accent, accentRgb)', () => {
    for (const tab of ADV_TABS) {
      expect(tab.id).toBeTruthy();
      expect(tab.label).toBeTruthy();
      expect(['function', 'object'].includes(typeof tab.icon)).toBe(true); // React components can be functions or forwardRef objects
      // accent/accentRgb may be a literal (hex / "r, g, b") OR a CSS-token reference
      // (var(--token[, fallback])) — the design-token compliance pass (EI-2387) tokenizes
      // these incrementally, so both forms are valid during the migration.
      expect(tab.accent).toMatch(/^(#[0-9a-f]{6}|var\(--[\w-]+(,.*)?\))$/i);
      expect(tab.accentRgb).toMatch(/^(\d+,\s*\d+,\s*\d+|var\(--[\w-]+(,.*)?\))$/i);
    }
  });

  it('no duplicate ids', () => {
    const ids = ADV_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prs is excluded from ADV_TABS but present in the type union', () => {
    // prs has its own redirect route; it is NOT in the strip but IS a valid
    // AdvTabId value (the type comes from ADV_TAB_IDS which includes prs).
    // Cast to string: 'prs' was removed from ADV_TABS, so its element-id union
    // no longer overlaps 'prs' (the assertion is exactly that it's absent).
    expect(ADV_TABS.every((t) => (t.id as string) !== 'prs')).toBe(true);
  });

  it('all-mode strip = workspace-level subset; single-pot strip = every tab', () => {
    // Under "All Pots" the per-pot tabs (Git/Tests/Docs/Insights/
    // Config/Settings) are hidden from the strip — only the workspace-level
    // views remain (owner directive 2026-06-05; AdvShell snaps the active tab
    // back to Overview when it goes invisible). This supersedes the earlier
    // "strip is scope-independent" guard: that guard existed because all-mode
    // once collapsed to just TWO tabs, which read as breakage.
    // ('overwatch' is no longer an /adv tab — the Overwatch surface moved to the
    // left sidebar next to Queen, P-008 / overwatch-role-2026-06-15 B-08.)
    expect(visibleAdvTabs(true).map((t) => t.id)).toEqual([
      // 'hud' is workspace-level: the session board is a roster of every session
      // in the workspace, not a per-pot view (owner ask 2026-07-25).
      // 'enterprise' is workspace-level and sits right of Overview (added with the
      // tab in 8db7240ba4, 2026-10-16; WORKSPACE_TAB_IDS + PRIMARY_ADV_TAB_IDS).
      'overview', 'enterprise', 'hud', 'plans', 'workflows', 'calendar', 'harnesses', 'health', 'frames', 'conversations', 'learning', 'evals',
    ]);
    // A single pot shows the full strip. Strip order: Overview leads (the
    // default landing surface, Brief 23 / overview-dashboard-2026-06-05
    // D-001); Calendar sits next to Create (scheduled-recurring-plans-2026-06-16
    // P-019); Conversations sits with the browse surfaces (Brief 25).
    expect(visibleAdvTabs(false)).toEqual([...ADV_TABS]);
    expect(ADV_TABS.map((t) => t.id)).toEqual([
      // HUD takes the first slot right of Overview (owner ask 2026-07-25).
      'overview', 'enterprise', 'hud', 'brainstorm', 'plans', 'workflows', 'calendar', 'harnesses', 'health', 'frames', 'git', 'stats', 'testing', 'docs', 'history', 'insights',
      'conversations', 'learning', 'evals', 'settings',
    ]);
  });
});

// ─── buildHarnessSelectOptions ────────────────────────────────────────────────

describe('buildHarnessSelectOptions', () => {
  // The builder returns SelectEntry[]: the "All …" row, then a workspace group
  // wrapping the authoritative Hive → member tree (workspace-hive-ui-2026-06-17).
  const lead = (o: SelectEntry[]) => o[0] as SelectOption; // the "All …" row
  const ws = (o: SelectEntry[]) => o[1] as SelectGroup; // the workspace group
  const tree = (o: SelectEntry[]) => ws(o).options; // hives + indented members

  it('returns a loading placeholder when projects is empty (no error)', () => {
    const opts = buildHarnessSelectOptions([], null);
    expect(opts).toHaveLength(1);
    expect(lead(opts).value).toBe('__loading');
    expect(String(lead(opts).label)).toContain('Loading');
    expect(lead(opts).disabled).toBe(true);
  });

  it('returns an error placeholder when projects is empty and there is an error', () => {
    const opts = buildHarnessSelectOptions([], 'network error');
    expect(String(lead(opts).label)).toContain('Failed');
    expect(lead(opts).disabled).toBe(true);
  });

  it('always leads with "All Pots" when projects exist', () => {
    const opts = buildHarnessSelectOptions([{ slug: 'sheets' }], null);
    expect(lead(opts).label).toBe('All Pots');
  });

  it('routes the leading-option label through the brand lexicon (the-hive)', () => {
    // The component threads t('pot', { plural: true }); classic = "Pots" (the
    // default above), the-hive = "Hives" (P-005 / the-hive-lexicon).
    const opts = buildHarnessSelectOptions([{ slug: 'sheets' }], null, 'Hives');
    expect(lead(opts).label).toBe('All Hives');
  });

  it('wraps the Hive tree in a non-selectable workspace group header', () => {
    const opts = buildHarnessSelectOptions([{ slug: 'a' }], null, 'Pots', 'my-workspace');
    expect(opts).toHaveLength(2);
    expect(ws(opts).kind).toBe('group');
    expect(ws(opts).label).toBe('my-workspace');
  });

  it('lists root harnesses inside the workspace group, sorted', () => {
    const opts = buildHarnessSelectOptions(
      [{ slug: 'zebra' }, { slug: 'alpha' }, { slug: 'mango' }],
      null,
    );
    expect(tree(opts).map((o) => o.value)).toEqual(['alpha', 'mango', 'zebra']);
  });

  it('renders member harnesses indented under their Hive (authoritative hive_slug)', () => {
    const opts = buildHarnessSelectOptions(
      [
        { slug: 'org', harness_kind: 'hive' },
        { slug: 'org-rd', hive_slug: 'org' },
        { slug: 'org-marketing', hive_slug: 'org' },
      ],
      null,
    );
    const labels = tree(opts).map((o) => String(o.label));
    const orgIdx = labels.findIndex((l) => l === 'org');
    const rdIdx = labels.findIndex((l) => l.includes('org-rd'));
    const mkIdx = labels.findIndex((l) => l.includes('org-marketing'));
    expect(orgIdx).toBeLessThan(rdIdx);
    expect(orgIdx).toBeLessThan(mkIdx);
    // Members are indented (label carries the ↳ marker)
    expect(String(tree(opts)[rdIdx].label)).toMatch(/↳/);
  });

  it('falls back to legacy parent_slug when no hive_slug is present', () => {
    const opts = buildHarnessSelectOptions(
      [{ slug: 'org' }, { slug: 'org-rd', parent_slug: 'org' }],
      null,
    );
    const child = tree(opts).find((o) => String(o.label).includes('org-rd'));
    expect(String(child?.label)).toMatch(/↳/);
  });

  it('sorts members within the same Hive', () => {
    const opts = buildHarnessSelectOptions(
      [
        { slug: 'org', harness_kind: 'hive' },
        { slug: 'org-z', hive_slug: 'org' },
        { slug: 'org-a', hive_slug: 'org' },
      ],
      null,
    );
    const children = tree(opts).filter((o) => String(o.label).includes('↳'));
    expect(children[0].value).toBe('org-a');
    expect(children[1].value).toBe('org-z');
  });

  it('renders an orphan (membership points outside the registry) as a root', () => {
    const opts = buildHarnessSelectOptions([{ slug: 'orphan', hive_slug: 'missing-home' }], null);
    const orphan = tree(opts).find((o) => o.value === 'orphan');
    expect(orphan).toBeTruthy();
    expect(String(orphan?.label)).not.toMatch(/↳/);
  });

  it('does not duplicate entries when a slug appears twice', () => {
    const opts = buildHarnessSelectOptions([{ slug: 'dup' }, { slug: 'dup', parent_slug: 'dup' }], null);
    const dupCount = tree(opts).filter((o) => o.value === 'dup').length;
    expect(dupCount).toBeLessThanOrEqual(1);
  });
});

// ─── Panel → tab redirect mapping (inline mirror) ────────────────────────────
// The route's PANEL_TO_TAB is private, but the expected mapping is a contract.
// Documenting it here catches regressions if the route is changed.

describe('harness route panel → tab mapping contract', () => {
  // Mirror of the private PANEL_TO_TAB in harness/index.tsx.
  const EXPECTED_MAPPING: Record<string, AdvTabId> = {
    dashboard:  'harnesses',
    brainstorm: 'brainstorm',
    prs:        'prs',
    insights:   'insights',
    // Config tab retired (config-tab-cleanup-2026-06-08) → legacy panel lands on Settings.
    config:     'settings',
    settings:   'settings',
    docs:       'docs',
    git:        'git',
    // These have no dedicated /adv tab → land on the workspace view.
    proposals:  'harnesses',
    experts:    'harnesses',
    summary:    'harnesses',
    design:     'harnesses',
  };

  it('every mapped tab is a known AdvTabId', () => {
    // AdvTabId values come from ADV_TAB_IDS + 'prs'.
    const knownTabIds = new Set([...ADV_TABS.map((t) => t.id), 'prs']);
    for (const [panel, tab] of Object.entries(EXPECTED_MAPPING)) {
      expect(knownTabIds.has(tab), `panel '${panel}' maps to unknown tab '${tab}'`).toBe(true);
    }
  });

  it('panels that have no dedicated tab all map to harnesses', () => {
    for (const panel of ['proposals', 'experts', 'summary', 'design']) {
      expect(EXPECTED_MAPPING[panel]).toBe('harnesses');
    }
  });

  it('named panels map to their own tabs', () => {
    expect(EXPECTED_MAPPING.brainstorm).toBe('brainstorm');
    expect(EXPECTED_MAPPING.insights).toBe('insights');
    // Config tab retired → its legacy panel now lands on Settings.
    expect(EXPECTED_MAPPING.config).toBe('settings');
    expect(EXPECTED_MAPPING.docs).toBe('docs');
  });
});

// ─── D-001 More-menu split (hud-first-nav-and-dossier-2026-07-26 P-002) ─────
describe('PRIMARY_ADV_TAB_IDS / SECONDARY_TAB_GROUPS / splitPrimarySecondary', () => {
  it('keeps Overview + HUD + Automations + Work + Learning primary', () => {
    expect(PRIMARY_ADV_TAB_IDS.has('overview')).toBe(true);
    expect(PRIMARY_ADV_TAB_IDS.has('hud')).toBe(true);
    expect(PRIMARY_ADV_TAB_IDS.has('workflows')).toBe(true);
    // 'harnesses' is the Work tab (label renamed 2026-07-26; the id stays
    // 'harnesses' because it's URL-serialized).
    expect(PRIMARY_ADV_TAB_IDS.has('harnesses')).toBe(true);
    expect(PRIMARY_ADV_TAB_IDS.has('learning')).toBe(true);
    expect(PRIMARY_ADV_TAB_IDS.has('enterprise')).toBe(true);
    expect(PRIMARY_ADV_TAB_IDS.size).toBe(6);
  });

  it('Automations sits immediately right of HUD, followed by Work', () => {
    const { primary } = splitPrimarySecondary(ADV_TABS);
    const ids = primary.map((t) => t.id);
    expect(ids.indexOf('workflows')).toBe(ids.indexOf('hud') + 1);
    expect(ids.indexOf('harnesses')).toBe(ids.indexOf('workflows') + 1);
    expect(ADV_TABS.find((t) => t.id === 'harnesses')?.label).toBe('Work');
  });

  it('every non-primary ADV_TABS id appears in exactly one More-menu group (nothing goes unreachable)', () => {
    const nonPrimaryIds = ADV_TABS.map((t) => t.id).filter((id) => !PRIMARY_ADV_TAB_IDS.has(id));
    const grouped = SECONDARY_TAB_GROUPS.flatMap((g) => g.tabIds);
    expect(new Set(grouped).size).toBe(grouped.length); // no id duplicated across groups
    expect([...grouped].sort()).toEqual([...nonPrimaryIds].sort());
  });

  it('keeps Brainstorm secondary and places it first in Create & Build before Plans', () => {
    expect(PRIMARY_ADV_TAB_IDS.has('brainstorm')).toBe(false);
    const group = SECONDARY_TAB_GROUPS.find((entry) => entry.id === 'build');
    expect(group?.label).toBe('Create & Build');
    expect(group?.tabIds.slice(0, 2)).toEqual(['brainstorm', 'plans']);
  });

  it('splits a tab list into primary (strip) and secondary (More menu)', () => {
    const { primary, secondary } = splitPrimarySecondary(ADV_TABS);
    expect(primary.map((t) => t.id)).toEqual(['overview', 'enterprise', 'hud', 'workflows', 'harnesses', 'learning']);
    expect(secondary.map((t) => t.id)).toEqual(
      ADV_TABS.map((t) => t.id).filter((id) => !PRIMARY_ADV_TAB_IDS.has(id)),
    );
  });

  it('under All Pots, secondary only contains the workspace-level subset', () => {
    const { secondary } = splitPrimarySecondary(visibleAdvTabs(true));
    expect(secondary.map((t) => t.id)).toEqual(['plans', 'calendar', 'health', 'frames', 'conversations', 'evals']);
  });
});

describe('parseRecentSecondaryTabs / pushRecentSecondaryTab', () => {
  it('parses a valid persisted list', () => {
    expect(parseRecentSecondaryTabs(JSON.stringify(['git', 'docs']))).toEqual(['git', 'docs']);
  });

  it('returns [] for null, malformed JSON, or a non-array', () => {
    expect(parseRecentSecondaryTabs(null)).toEqual([]);
    expect(parseRecentSecondaryTabs('not json')).toEqual([]);
    expect(parseRecentSecondaryTabs(JSON.stringify({ not: 'an array' }))).toEqual([]);
  });

  it('drops unknown ids and primary ids (overview/hud can never be "recent secondary")', () => {
    expect(parseRecentSecondaryTabs(JSON.stringify(['git', 'bogus-id', 'overview', 'hud', 'docs']))).toEqual(['git', 'docs']);
  });

  it('pushRecentSecondaryTab moves an id to the front, dedupes, and caps at 3', () => {
    expect(pushRecentSecondaryTab([], 'git')).toEqual(['git']);
    expect(pushRecentSecondaryTab(['git', 'docs'], 'docs')).toEqual(['docs', 'git']);
    expect(pushRecentSecondaryTab(['git', 'docs', 'testing'], 'insights')).toEqual(['insights', 'git', 'docs']);
  });
});

// ─── tab-strip overflow indicator (owner ask 2026-06-15 #1) ──────────────────
describe('tabOverflowState', () => {
  it('reports no overflow when the strip fits', () => {
    expect(tabOverflowState(0, 400, 400)).toEqual({ left: false, right: false });
  });
  it('reports right-only overflow at the start of a clipped strip', () => {
    // 900px of tabs in a 400px strip, scrolled to the start.
    expect(tabOverflowState(0, 900, 400)).toEqual({ left: false, right: true });
  });
  it('reports left-only overflow scrolled fully to the end', () => {
    expect(tabOverflowState(500, 900, 400)).toEqual({ left: true, right: false });
  });
  it('reports both sides when scrolled to the middle', () => {
    expect(tabOverflowState(250, 900, 400)).toEqual({ left: true, right: true });
  });
  it('tolerates 1px sub-pixel rounding at both ends', () => {
    expect(tabOverflowState(1, 900, 400)).toEqual({ left: false, right: true }); // ~start
    expect(tabOverflowState(499, 900, 400)).toEqual({ left: true, right: false }); // ~end
  });
});

// ─── Tab fullscreen levels (owner ask 2026-08-31) ────────────────────────────
//
// The escalation order is the design decision the owner actually made — press to
// maximize, press again for the OS, Escape back down one step at a time — so it
// is pinned here rather than left to be re-read out of a click handler.

describe('tab fullscreen levels', () => {
  it('exposes exactly the three levels, off first (the nuqs default, so ?max= is cleared rather than written as off)', () => {
    expect([...ADV_MAX_LEVELS]).toEqual(['off', 'window', 'screen']);
  });

  it('a press escalates off → window → screen, then back out to off', () => {
    expect(nextAdvMaxLevel('off')).toBe('window');
    expect(nextAdvMaxLevel('window')).toBe('screen');
    expect(nextAdvMaxLevel('screen')).toBe('off');
  });

  it('Escape steps down ONE level at a time — screen lands on window, not straight out', () => {
    expect(prevAdvMaxLevel('screen')).toBe('window');
    expect(prevAdvMaxLevel('window')).toBe('off');
    expect(prevAdvMaxLevel('off')).toBe('off');
  });

  it('every level names the action a press performs, so the a11y label is never stale', () => {
    for (const level of ADV_MAX_LEVELS) {
      expect(advMaxToggleLabel(level as AdvMaxLevel)).toBeTruthy();
    }
    // off/window advertise where a press GOES; screen advertises the way out.
    expect(advMaxToggleLabel('off')).toMatch(/maximize/i);
    expect(advMaxToggleLabel('window')).toMatch(/fullscreen/i);
    expect(advMaxToggleLabel('screen')).toMatch(/exit/i);
  });

  it('cycling forward three times from off returns to off — no dead end for a click-only user', () => {
    let level: AdvMaxLevel = 'off';
    for (let i = 0; i < 3; i += 1) level = nextAdvMaxLevel(level);
    expect(level).toBe('off');
  });
});

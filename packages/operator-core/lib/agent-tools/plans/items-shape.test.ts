/**
 * Unit tests for plans:items payload-tier shaping (context-trimming-tiers-2026-07-01
 * P-021) — pure, no I/O.
 *
 * EI-18679411140143743: `coverageDivergence` (a plan item whose linked work is
 * fully done but whose own status is still non-terminal) must survive both the
 * trimmed and standard projections as `diverged` — a trimmed/standard session
 * (the common case) must not lose the one signal that flags a stale burn-down.
 */
import { describe, it, expect } from 'vitest';
import { shapePlansItems, PLANS_ITEMS_TIER_CAPS } from './items-shape';

function row(over: Record<string, unknown> = {}) {
  return {
    plan: 'my-plan',
    archived: false,
    item: { id: 'P-009', effectiveStatus: 'todo', importance: 'normal', text: 'do the thing' },
    coverage: { level: 'complete', workers: [] },
    coverageDivergence: true,
    ...over,
  };
}

describe('shapePlansItems — linked work-item id (scope-unique-identifiers P-003)', () => {
  for (const tier of ['trimmed', 'standard'] as const) {
    it(`${tier} tier keeps workItemId on every row and sends workItemIds only when several qualify`, () => {
      const out = shapePlansItems(
        {
          items: [
            row({ workItemId: 'WI-10008272', workItemIds: ['WI-10008272'] }),
            row({ item: { id: 'P-010', effectiveStatus: 'todo', importance: 'normal', text: 'x' }, workItemId: null, workItemIds: ['WI-3', 'WI-7'] }),
            row({ item: { id: 'P-011', effectiveStatus: 'todo', importance: 'normal', text: 'y' } }),
          ],
        },
        tier,
      ) as { items: Record<string, unknown>[] };
      expect(out.items[0]).toMatchObject({ id: 'P-009', workItemId: 'WI-10008272' });
      expect(out.items[0]).not.toHaveProperty('workItemIds');
      expect(out.items[1]).toMatchObject({ id: 'P-010', workItemId: null, workItemIds: ['WI-3', 'WI-7'] });
      expect(out.items[2]).toMatchObject({ id: 'P-011', workItemId: null });
    });
  }
});

describe('shapePlansItems — coverageDivergence -> diverged', () => {
  it('trimmed tier surfaces diverged:true for a divergent row', () => {
    const out = shapePlansItems({ items: [row()] }, 'trimmed') as { items: Record<string, unknown>[] };
    expect(out.items[0].diverged).toBe(true);
  });

  it('standard tier surfaces diverged:true for a divergent row', () => {
    const out = shapePlansItems({ items: [row()] }, 'standard') as { items: Record<string, unknown>[] };
    expect(out.items[0].diverged).toBe(true);
  });

  it('a non-divergent row (no coverageDivergence key) shapes to diverged:false in both tiers', () => {
    const clean = row({ coverageDivergence: undefined });
    delete (clean as Record<string, unknown>).coverageDivergence;
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapePlansItems({ items: [clean] }, tier) as { items: Record<string, unknown>[] };
      expect(out.items[0].diverged).toBe(false);
    }
  });

  it('the truncation placeholder row never claims diverged:true', () => {
    const rows = Array.from({ length: PLANS_ITEMS_TIER_CAPS.trimmed.rows + 5 }, (_, i) =>
      row({ item: { id: `P-${i}`, effectiveStatus: 'todo', importance: 'normal', text: 'x' } }),
    );
    const out = shapePlansItems({ items: rows }, 'trimmed') as { items: Record<string, unknown>[] };
    const placeholder = out.items[out.items.length - 1];
    expect(placeholder.plan).toBe('(truncated)');
    expect(String(placeholder.text)).toContain("tools:invoke { name:'plans:items'");
    expect(placeholder.diverged).toBe(false);
  });

  it('passes through non-array/absent items unchanged (defensive no-op)', () => {
    expect(shapePlansItems({ notItems: [] }, 'trimmed')).toEqual({ notItems: [] });
    expect(shapePlansItems(null, 'standard')).toBeNull();
  });
});

describe('shapePlansItems — specTriadDiagnostics', () => {
  it('flattens diagnostics to scalar records and clips the note in both tiers', () => {
    const note = 'triad explanation '.repeat(100);
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapePlansItems(
        {
          items: [],
          specTriadDiagnostics: [{
            plan: 'triad-gated-plan',
            missing: ['requirements', 'design'],
            scopeReason: 'created-after-epoch',
            note,
          }],
        },
        tier,
      ) as {
        specTriadDiagnostics: Array<{
          plan: string;
          missing: string | null;
          scopeReason: string | null;
          note: string | null;
        }>;
      };
      expect(out.specTriadDiagnostics).toEqual([
        {
          plan: 'triad-gated-plan',
          missing: 'requirements,design',
          scopeReason: 'created-after-epoch',
          note: expect.stringContaining('TRUNCATED'),
        },
      ]);
      expect(out.specTriadDiagnostics[0].note?.length).toBeLessThanOrEqual(
        PLANS_ITEMS_TIER_CAPS[tier].text,
      );
    }
  });

  it('preserves an empty diagnostic list for an unknown-scope read', () => {
    const out = shapePlansItems(
      { items: [], specTriadDiagnostics: [] },
      'trimmed',
    ) as { specTriadDiagnostics: unknown[] };
    expect(out.specTriadDiagnostics).toEqual([]);
  });
});

describe('shapePlansItems — citedTerminalRefs / citedWorkItems (EI-22173576329267385)', () => {
  it('trimmed tier surfaces citedTerminalRefs as a count, but never the detail list', () => {
    const out = shapePlansItems(
      {
        items: [
          row({
            citedWorkItems: [
              { ref: 'WI-1', state: 'done', terminal: true },
              { ref: 'WI-2', state: 'open', terminal: false },
            ],
          }),
        ],
      },
      'trimmed',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].citedTerminalRefs).toBe(1);
    expect(out.items[0].citedWorkItems).toBeUndefined();
  });

  it('standard tier surfaces both the count and the joined ref:state detail', () => {
    const out = shapePlansItems(
      {
        items: [
          row({
            citedWorkItems: [
              { ref: 'WI-1', state: 'done', terminal: true },
              { ref: 'WI-2', state: 'open', terminal: false },
            ],
          }),
        ],
      },
      'standard',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].citedTerminalRefs).toBe(1);
    expect(out.items[0].citedWorkItems).toBe('WI-1:done,WI-2:open');
  });

  it('an unresolved ref (state:null) renders as "unknown" in the joined detail', () => {
    const out = shapePlansItems(
      { items: [row({ citedWorkItems: [{ ref: 'WI-9', state: null, terminal: false }] })] },
      'standard',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].citedWorkItems).toBe('WI-9:unknown');
    expect(out.items[0].citedTerminalRefs).toBe(0);
  });

  it('a row with no citedWorkItems key shapes to citedTerminalRefs:0 and citedWorkItems:null', () => {
    const clean = row();
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapePlansItems({ items: [clean] }, tier) as { items: Record<string, unknown>[] };
      expect(out.items[0].citedTerminalRefs).toBe(0);
      if (tier === 'standard') expect(out.items[0].citedWorkItems).toBeNull();
    }
  });

  it('a row with an empty citedWorkItems array shapes the same as absent (0 / null)', () => {
    const out = shapePlansItems(
      { items: [row({ citedWorkItems: [] })] },
      'standard',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].citedTerminalRefs).toBe(0);
    expect(out.items[0].citedWorkItems).toBeNull();
  });

  it('all cited refs terminal counts every one, not just the first', () => {
    const out = shapePlansItems(
      {
        items: [
          row({
            citedWorkItems: [
              { ref: 'WI-1', state: 'done', terminal: true },
              { ref: 'WI-2', state: 'dropped', terminal: true },
              { ref: 'WI-3', state: 'deprecated', terminal: true },
            ],
          }),
        ],
      },
      'trimmed',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].citedTerminalRefs).toBe(3);
  });

  it('the truncation placeholder row never claims a nonzero citedTerminalRefs', () => {
    const rows = Array.from({ length: PLANS_ITEMS_TIER_CAPS.trimmed.rows + 5 }, (_, i) =>
      row({
        item: { id: `P-${i}`, effectiveStatus: 'todo', importance: 'normal', text: 'x' },
        citedWorkItems: [{ ref: 'WI-1', state: 'done', terminal: true }],
      }),
    );
    const out = shapePlansItems({ items: rows }, 'trimmed') as { items: Record<string, unknown>[] };
    const placeholder = out.items[out.items.length - 1];
    expect(placeholder.plan).toBe('(truncated)');
    expect(placeholder.citedTerminalRefs).toBe(0);
  });
});

describe('shapePlansItems — text_truncated marker (EI-18762253154342502)', () => {
  it('stamps text_truncated:true when the trimmed-tier cap actually clips item.text', () => {
    const longText = 'x'.repeat(PLANS_ITEMS_TIER_CAPS.trimmed.text + 50);
    const out = shapePlansItems(
      { items: [row({ item: { id: 'P-009', text: longText } })] },
      'trimmed',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].text_truncated).toBe(true);
    // EI-20038981829684213: the clip announces itself IN BAND, not only via the
    // sibling flag above — a `projection.pick` of the value alone strips the
    // sibling, and the marker has to survive that. The marker is variable-length
    // (it carries the omitted count), so the result is bounded BY the cap rather
    // than exactly equal to it.
    expect((out.items[0].text as string)).toContain('TRUNCATED');
    expect((out.items[0].text as string).length).toBeLessThanOrEqual(
      PLANS_ITEMS_TIER_CAPS.trimmed.text,
    );
  });

  it('stamps text_truncated:false when item.text fits under the cap untouched', () => {
    const out = shapePlansItems(
      { items: [row({ item: { id: 'P-009', text: 'short' } })] },
      'trimmed',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].text_truncated).toBe(false);
    expect(out.items[0].text).toBe('short');
  });

  it('the standard tier also stamps the marker (higher cap, same contract)', () => {
    const longText = 'y'.repeat(PLANS_ITEMS_TIER_CAPS.standard.text + 1);
    const out = shapePlansItems(
      { items: [row({ item: { id: 'P-009', text: longText } })] },
      'standard',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].text_truncated).toBe(true);
  });
});

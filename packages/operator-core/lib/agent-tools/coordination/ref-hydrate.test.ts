/**
 * ref-hydrate tests (coord-authority-hardening-2026-07-11 P-001): the typed-ref
 * parse/budget/render pure core, and hydrateRefs with INJECTED resolvers (the
 * unit surface is DB-free by design — the default msg/work-item resolvers are
 * exercised by their consuming tools' integration tests).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  applyRefBudget,
  BODY_REFS_OPT_OUT_FIELD,
  canonicalRefKey,
  clampSnippet,
  clampSnippetTail,
  DEFAULT_REF_BUDGET,
  detectBodyRefs,
  detectEntryBodyRefs,
  formatSessionTurnRef,
  GATE_REFS_FIELD,
  isBodyRefEligible,
  parseRefToken,
  readBodyRefsOptOut,
  readGateRefs,
  renderBodyRefsSuffix,
  renderGateRefsSuffix,
  renderHydratedRef,
  renderHydratedRefs,
  renderReplyQuoteSuffix,
  renderTerminalSubjectSuffix,
  type HydratableRef,
} from './ref-hydrate';
import { bodyRefWorkItemResolver, hydrateRefs, resolveGateRefStamps, type RefResolver } from './ref-hydrate-resolve';
import { findAnnouncementsForKey } from '../../events/await/store';
import { getWorkItem } from '../../work-items';
import { workItemFixture } from '../../testing/work-item-fixture';

vi.mock('../../events/await/store', () => ({ findAnnouncementsForKey: vi.fn() }));
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItem: vi.fn(),
  getWorkItemDetail: vi.fn(),
  isSettledWorkItemState: vi.fn(() => false),
}));
vi.mock('../../work-item-checkpoint', () => ({ getWorkItemCheckpoint: vi.fn(async () => null) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'papercusp-workspace') }));

describe('parseRefToken', () => {
  it('parses each typed ref shape', () => {
    expect(parseRefToken('msg:mrgf42eg-0000-abc')).toEqual({ kind: 'msg', id: 'mrgf42eg-0000-abc' });
    expect(parseRefToken('WI-4070')).toEqual({ kind: 'work-item', id: 'WI-4070' });
    expect(parseRefToken('wi:wi-4070')).toEqual({ kind: 'work-item', id: 'WI-4070' });
    expect(parseRefToken('ei-9501')).toEqual({ kind: 'work-item', id: 'EI-9501' });
    expect(parseRefToken('F-12')).toEqual({ kind: 'work-item', id: 'F-12' });
    expect(parseRefToken('conv-abc123')).toEqual({ kind: 'conversation', id: 'conv-abc123' });
    expect(parseRefToken('conversation:conv-abc123')).toEqual({ kind: 'conversation', id: 'conv-abc123' });
    expect(canonicalRefKey({ kind: 'conversation', id: 'conv-abc123' })).toBe('conversation:conv-abc123');
    expect(parseRefToken('plan:my-plan-2026-07-11#P-004')).toEqual({
      kind: 'plan-item',
      slug: 'my-plan-2026-07-11',
      item: 'P-004',
    });
    expect(parseRefToken('gate:fleet:p2p-git:phase1-green')).toEqual({
      kind: 'gate',
      key: 'fleet:p2p-git:phase1-green',
    });
    expect(parseRefToken('owner-turn')).toEqual({ kind: 'owner-turn' });
    expect(parseRefToken('session_turn:claude:session:with:colons:28')).toEqual({
      kind: 'session-turn',
      sourceKind: 'claude',
      sessionId: 'session:with:colons',
      turnIdx: 28,
    });
  });

  it('returns null for non-refs (never throws)', () => {
    for (const junk of ['', '   ', 'hello', 'WI-', 'plan:#P-001', 'msg:', 'XWI-123', 'session_turn:unknown:s:1', 'session_turn:claude:s:-1']) {
      expect(parseRefToken(junk)).toBeNull();
    }
  });

  it('formats session-turn coordinates canonically and preserves ids containing colons', () => {
    expect(formatSessionTurnRef({ sourceKind: 'codex', sessionId: 'rollout:with:colons', turnIdx: 7 })).toBe(
      'session_turn:codex:rollout:with:colons:7',
    );
  });
});

describe('detectBodyRefs (P-008 auto-detect)', () => {
  it('finds word-bounded WI/EI ids, in order, de-duped', () => {
    const refs = detectBodyRefs('WI-4070 is blocked on EI-9501; see WI-4070 again');
    expect(refs).toEqual([
      { kind: 'work-item', id: 'WI-4070' },
      { kind: 'work-item', id: 'EI-9501' },
    ]);
  });

  it('caps at max and ignores embedded / F- shapes', () => {
    const refs = detectBodyRefs('WI-1 WI-2 WI-3 WI-4 and XWI-9 F-77', 3);
    expect(refs.map((r) => (r.kind === 'work-item' ? r.id : ''))).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });

  it('is safe on empty input', () => {
    expect(detectBodyRefs('')).toEqual([]);
  });
});

describe('clampSnippet', () => {
  it('collapses whitespace to one verbatim line', () => {
    expect(clampSnippet('tell the fleet\n  to wind down,\t we will continue later', 200)).toBe(
      'tell the fleet to wind down, we will continue later',
    );
  });

  it('clamps with an ellipsis at the budget', () => {
    const out = clampSnippet('a'.repeat(300), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('applyRefBudget', () => {
  it('de-dupes by canonical key and keeps the first maxRefs', () => {
    const refs: HydratableRef[] = [
      { kind: 'work-item', id: 'WI-1' },
      { kind: 'work-item', id: 'WI-1' },
      { kind: 'msg', id: 'm1' },
      { kind: 'gate', key: 'g1' },
      { kind: 'work-item', id: 'WI-2' },
    ];
    const out = applyRefBudget(refs, { snippetChars: 200, maxRefs: 3 });
    expect(out.map(canonicalRefKey)).toEqual(['work-item:WI-1', 'msg:m1', 'gate:g1']);
    expect(canonicalRefKey({ kind: 'work-item', id: 'WI-1', harness: 'email' })).toBe(
      'work-item:WI-1@email',
    );
    expect(canonicalRefKey({ kind: 'work-item', id: 'WI-1', harness: 'papercusp' })).not.toBe(
      canonicalRefKey({ kind: 'work-item', id: 'WI-1', harness: 'email' }),
    );
    expect(canonicalRefKey({
      kind: 'session-turn',
      sourceKind: 'codex',
      sessionId: 'rollout:1',
      turnIdx: 7,
    })).toBe('session-turn:codex:rollout:1:7');
  });
});

describe('render', () => {
  it('quotes verbatim snippets and marks unresolved refs explicitly', () => {
    expect(
      renderHydratedRef({
        ref: { kind: 'msg', id: 'm1' },
        ok: true,
        label: 'msg m1 (15179 → @fleet:p2p-git, 2026-07-11T09:01Z)',
        snippet: 'wind down',
      }),
    ).toBe('↪ msg m1 (15179 → @fleet:p2p-git, 2026-07-11T09:01Z): "wind down"');
    expect(
      renderHydratedRef({ ref: { kind: 'gate', key: 'g1' }, ok: false, label: 'gate:g1', snippet: '', error: 'not_found' }),
    ).toBe('↪ gate:g1 — unresolved (not_found)');
  });

  it('renders one line per ref', () => {
    const block = renderHydratedRefs([
      { ref: { kind: 'work-item', id: 'WI-1' }, ok: true, label: 'WI-1 [bug/wip]', snippet: 't' },
      { ref: { kind: 'work-item', id: 'WI-2' }, ok: false, label: 'work-item:WI-2', snippet: '', error: 'not_found' },
    ]);
    expect(block.split('\n')).toHaveLength(2);
  });

  it('reply-quote suffix (P-005): `⤷ re` + quoted verbatim snippet; unresolved stays visible', () => {
    expect(
      renderReplyQuoteSuffix({
        ref: { kind: 'msg', id: 'm1' },
        ok: true,
        label: 'msg m1 (15179 → 4c85f, 2026-07-11T09:01Z)',
        snippet: 'is the Mac app actually draining?',
      }),
    ).toBe(' ⤷ re msg m1 (15179 → 4c85f, 2026-07-11T09:01Z): "is the Mac app actually draining?"');
    expect(
      renderReplyQuoteSuffix({ ref: { kind: 'msg', id: 'm2' }, ok: false, label: 'msg:m2', snippet: '', error: 'not_found' }),
    ).toBe(' ⤷ re msg:m2 — unresolved (not_found)');
    expect(
      renderReplyQuoteSuffix({ ref: { kind: 'msg', id: 'm3' }, ok: true, label: 'msg m3', snippet: '' }),
    ).toBe(' ⤷ re msg m3');
  });
});

describe('gate refs (P-006) — read/render pure core + send-time stamping', () => {
  beforeEach(() => vi.mocked(findAnnouncementsForKey).mockReset());

  it('readGateRefs round-trips valid stamps, drops malformed entries, caps at 3', () => {
    const env = {
      [GATE_REFS_FIELD]: [
        { key: 'fleet:p2p:phase1-green', status: 'declared' },
        { key: '', status: 'declared' }, // blank key dropped
        { key: 'k2', status: 'god-mode' }, // forged status dropped
        'not-an-object',
        { key: 'k3', status: 'fired' },
        { key: 'k4', status: 'undeclared' },
        { key: 'k5', status: 'declared' }, // beyond cap
      ],
    };
    expect(readGateRefs(env)).toEqual([
      { key: 'fleet:p2p:phase1-green', status: 'declared' },
      { key: 'k3', status: 'fired' },
      { key: 'k4', status: 'undeclared' },
    ]);
    expect(readGateRefs({})).toEqual([]);
    expect(readGateRefs(null)).toEqual([]);
    expect(readGateRefs({ [GATE_REFS_FIELD]: 'nope' })).toEqual([]);
  });

  it('renderGateRefsSuffix renders each EXACT key with its status; empty → \'\'', () => {
    expect(
      renderGateRefsSuffix([
        { key: 'fleet:p2p:phase1-green', status: 'declared' },
        { key: 'deploy:done:papercusp', status: 'fired' },
      ]),
    ).toBe(' ⛩ gate fleet:p2p:phase1-green [declared]; gate deploy:done:papercusp [fired]');
    expect(renderGateRefsSuffix([])).toBe('');
  });

  it('resolveGateRefStamps: declared / fired / undeclared by store state; error → unknown; dedupe+cap', async () => {
    vi.mocked(findAnnouncementsForKey).mockImplementation(async (key: string) => {
      if (key === 'g-fired') return [{ firedAt: '2026-07-11', firedReason: 'event', note: null, subscriberId: 's' }] as never;
      if (key === 'g-declared') return [{ firedAt: null, firedReason: null, note: null, subscriberId: 's' }] as never;
      if (key === 'g-boom') throw new Error('store down');
      return [] as never;
    });
    expect(await resolveGateRefStamps(['g-fired', 'g-declared', 'g-nope'])).toEqual([
      { key: 'g-fired', status: 'fired' },
      { key: 'g-declared', status: 'declared' },
      { key: 'g-nope', status: 'undeclared' },
    ]);
    expect(await resolveGateRefStamps(['g-boom'])).toEqual([{ key: 'g-boom', status: 'unknown' }]);
    // dedupe + trim + cap at 3
    const stamps = await resolveGateRefStamps([' g-declared ', 'g-declared', 'g-fired', 'g-nope', 'g-extra']);
    expect(stamps.map((s) => s.key)).toEqual(['g-declared', 'g-fired', 'g-nope']);
  });
});

describe('body auto-refs (P-008) — eligibility, opt-out, entry detection, tail clamp, suffix', () => {
  it('isBodyRefEligible: free-prose kinds only; any lifecycle stamp disqualifies', () => {
    expect(isBodyRefEligible({ kind: 'message' })).toBe(true);
    expect(isBodyRefEligible({ kind: 'escalation' })).toBe(true);
    expect(isBodyRefEligible({ kind: 'handoff' })).toBe(true);
    expect(isBodyRefEligible({ kind: 'escalation_resolved' })).toBe(true);
    // machine-stamped status lines: the id is structural, not a citation
    expect(isBodyRefEligible({ kind: 'message', lifecycle: 'intent' })).toBe(false);
    expect(isBodyRefEligible({ kind: 'message', lifecycle: 'claim' })).toBe(false);
    expect(isBodyRefEligible({ kind: 'plan_event' })).toBe(false);
    expect(isBodyRefEligible({ kind: 'ack' })).toBe(false);
    expect(isBodyRefEligible({ kind: 'notify' })).toBe(false);
    // defensive: malformed shapes degrade to ineligible, never throw
    expect(isBodyRefEligible(null)).toBe(false);
    expect(isBodyRefEligible({ kind: 42 as never })).toBe(false);
  });

  it('readBodyRefsOptOut: only a literal true opts out (forged values ignored)', () => {
    expect(readBodyRefsOptOut({ [BODY_REFS_OPT_OUT_FIELD]: true })).toBe(true);
    expect(readBodyRefsOptOut({ [BODY_REFS_OPT_OUT_FIELD]: 'yes' })).toBe(false);
    expect(readBodyRefsOptOut({ [BODY_REFS_OPT_OUT_FIELD]: false })).toBe(false);
    expect(readBodyRefsOptOut({})).toBe(false);
    expect(readBodyRefsOptOut(null)).toBe(false);
  });

  it('detectEntryBodyRefs: detects over summary AND body, de-duped across both, capped', () => {
    expect(
      detectEntryBodyRefs({ summary: 'fixing WI-1 now', body: 'WI-1 blocks EI-2; also WI-3 WI-4' }, 3),
    ).toEqual([
      { kind: 'work-item', id: 'WI-1' },
      { kind: 'work-item', id: 'EI-2' },
      { kind: 'work-item', id: 'WI-3' },
    ]);
    // non-string / absent fields degrade to empty, never throw
    expect(detectEntryBodyRefs({ summary: 42 as never })).toEqual([]);
    expect(detectEntryBodyRefs(null)).toEqual([]);
  });

  it('carries the envelope harness into each detected body ref', () => {
    expect(detectEntryBodyRefs({ summary: 'email item WI-10000680', harness_slug: 'email' })).toEqual([
      { kind: 'work-item', id: 'WI-10000680', harness: 'email' },
    ]);
  });

  it('does not resolve a prose id that is a strict prefix of a structured citation', () => {
    const fullId = 'EI-22489500008234936';
    const entry = {
      summary: 'Timeout fallback: EI-224 is still open',
      sections: [{ premises: [`work-item:${fullId}`], forYouBecause: { ref: fullId } }],
    };
    expect(detectEntryBodyRefs(entry as never)).toEqual([]);

    // The exact structured id remains eligible when it is also present in the
    // display text; only the ambiguous shorter prefix is fenced.
    expect(detectEntryBodyRefs({ ...entry, summary: `See EI-224 and ${fullId}` } as never)).toEqual([
      { kind: 'work-item', id: fullId },
    ]);
  });

  it('clampSnippetTail keeps the TAIL with a leading ellipsis, one-lined, bounded', () => {
    expect(clampSnippetTail('short note', 60)).toBe('short note');
    const long = `${'x'.repeat(100)} next: wire the opt-out\nflag + tests`;
    const out = clampSnippetTail(long, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('flag + tests')).toBe(true); // the freshest end survives
    expect(out).not.toContain('\n');
  });

  it('renderBodyRefsSuffix renders resolved refs `; `-joined — and SILENTLY skips misses (auto-detect is opportunistic, unlike declared refs)', () => {
    const ok1 = {
      ref: { kind: 'work-item', id: 'WI-4173' },
      ok: true,
      label: 'WI-4173 [feature/wip @4c85f]',
      snippet: 'D: auto-detect ids ⌁ …wire into delivery render',
    } as const;
    const ok2 = { ref: { kind: 'work-item', id: 'EI-9719' }, ok: true, label: 'EI-9719 [bug/open]', snippet: '' } as const;
    const miss = {
      ref: { kind: 'work-item', id: 'WI-9999' },
      ok: false,
      label: 'work-item:WI-9999',
      snippet: '',
      error: 'not_found',
    } as const;
    expect(renderBodyRefsSuffix([ok1, miss, ok2])).toBe(
      ' ↪ WI-4173 [feature/wip @4c85f]: "D: auto-detect ids ⌁ …wire into delivery render"; ↪ EI-9719 [bug/open]',
    );
    expect(renderBodyRefsSuffix([miss])).toBe('');
    expect(renderBodyRefsSuffix([])).toBe('');
  });

  it('renderTerminalSubjectSuffix marks terminal cited subjects and omits non-terminal/missing refs', () => {
    const terminal = {
      ref: { kind: 'work-item', id: 'EI-9719' },
      ok: true,
      label: 'EI-9719 [bug/done]',
      snippet: 'already shipped',
      terminalSubject: { state: 'done', closedAt: '2026-08-25T21:10:47.721Z' },
    } as const;
    const open = {
      ref: { kind: 'work-item', id: 'WI-4173' },
      ok: true,
      label: 'WI-4173 [bug/open]',
      snippet: 'still active',
    } as const;
    expect(renderTerminalSubjectSuffix([terminal, open])).toBe(
      ' ⚠ SUBJECT TERMINAL: EI-9719 [done] since 2026-08-25T21:10:47.721Z — this ask may already be satisfied',
    );
    expect(renderTerminalSubjectSuffix([open])).toBe('');
    expect(renderTerminalSubjectSuffix([{ ...terminal, ok: false }])).toBe('');
  });
});

describe('hydrateRefs (injected resolvers — DB-free)', () => {
  const wiResolver: RefResolver = async (ref, budget) =>
    ref.kind === 'work-item' && ref.id === 'WI-4070'
      ? { label: 'WI-4070 [bug/wip @4c5f0]', snippet: clampSnippet('VM-local wedge', budget.snippetChars) }
      : null;

  it('resolves hits, tags misses not_found, keeps input order', async () => {
    const out = await hydrateRefs(
      [
        { kind: 'work-item', id: 'WI-4070' },
        { kind: 'work-item', id: 'WI-9999' },
      ],
      { resolvers: { 'work-item': wiResolver } },
    );
    expect(out.map((h) => [h.ok, h.error ?? ''])).toEqual([
      [true, ''],
      [false, 'not_found'],
    ]);
    expect(out[0].label).toContain('WI-4070');
    expect(out[0].resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('preserves terminal subject metadata from a resolver', async () => {
    const out = await hydrateRefs([{ kind: 'work-item', id: 'EI-9719' }], {
      resolvers: {
        'work-item': async () => ({
          label: 'EI-9719 [bug/done]',
          snippet: 'already shipped',
          terminalSubject: { state: 'done', closedAt: '2026-08-25T21:10:47.721Z' },
        }),
      },
    });
    expect(out[0]).toMatchObject({
      ok: true,
      terminalSubject: { state: 'done', closedAt: '2026-08-25T21:10:47.721Z' },
    });
  });

  it('degrades a missing resolver to resolver_not_installed (fail-soft)', async () => {
    const [h] = await hydrateRefs([{ kind: 'gate', key: 'g1' }]);
    expect(h.ok).toBe(false);
    expect(h.error).toBe('resolver_not_installed');
  });

  it('degrades a throwing resolver to resolve_error (never throws)', async () => {
    const boom: RefResolver = async () => {
      throw new Error('store down');
    };
    const [h] = await hydrateRefs([{ kind: 'work-item', id: 'WI-1' }], {
      resolvers: { 'work-item': boom },
    });
    expect(h).toMatchObject({ ok: false, error: 'resolve_error' });
  });

  it('applies the budget before resolving (dedupe + cap)', async () => {
    let calls = 0;
    const counting: RefResolver = async (ref) => {
      calls++;
      return { label: canonicalRefKey(ref), snippet: 's' };
    };
    const out = await hydrateRefs(
      [
        { kind: 'work-item', id: 'WI-1' },
        { kind: 'work-item', id: 'WI-1' },
        { kind: 'work-item', id: 'WI-2' },
        { kind: 'work-item', id: 'WI-3' },
        { kind: 'work-item', id: 'WI-4' },
      ],
      { resolvers: { 'work-item': counting }, budget: { ...DEFAULT_REF_BUDGET, maxRefs: 3 } },
    );
    expect(out).toHaveLength(3);
    expect(calls).toBe(3);
  });

  it('body hydration resolves in the stamped harness and labels that scope', async () => {
    vi.mocked(getWorkItem).mockResolvedValue(workItemFixture({
      id: 'WI-10000680',
      kind: 'task',
      family: 'issue',
      state: 'open',
      harness: 'email',
      assignee: null,
      title: 'email draft',
      summary: 'proposal',
      payload: {},
      closedAt: null,
    }));

    const [hydrated] = await hydrateRefs(
      [{ kind: 'work-item', id: 'WI-10000680', harness: 'email' }],
      { resolvers: { 'work-item': bodyRefWorkItemResolver } },
    );

    expect(getWorkItem).toHaveBeenCalledWith('WI-10000680', 'email');
    expect(hydrated).toMatchObject({ ok: true, label: 'WI-10000680 [task/open in email]' });
  });

  it('fails closed when a harness-scoped lookup falls back to another harness', async () => {
    vi.mocked(getWorkItem).mockResolvedValue(workItemFixture({
      id: 'WI-10000680',
      kind: 'task',
      family: 'feature',
      state: 'dropped',
      harness: 'papercusp',
      assignee: null,
      title: 'old spec triad',
      summary: 'dropped',
      payload: {},
      closedAt: null,
    }));

    const [hydrated] = await hydrateRefs(
      [{ kind: 'work-item', id: 'WI-10000680', harness: 'email' }],
      { resolvers: { 'work-item': bodyRefWorkItemResolver } },
    );

    expect(hydrated).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('does not guess an unscoped WI id from another harness', async () => {
    vi.mocked(getWorkItem).mockReset();

    const [hydrated] = await hydrateRefs(
      [{ kind: 'work-item', id: 'WI-10000680' }],
      { resolvers: { 'work-item': bodyRefWorkItemResolver } },
    );

    expect(getWorkItem).not.toHaveBeenCalled();
    expect(hydrated).toMatchObject({ ok: false, error: 'not_found' });
  });
});

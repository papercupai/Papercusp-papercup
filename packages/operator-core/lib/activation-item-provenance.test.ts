import { describe, expect, it } from 'vitest';
import type { HitTurnOriginVerdict } from './agent-tools/sessions/turn-origin';
import {
  fetchOrderSourceTurns,
  fetchSourceTurns,
  isOwnerTurnVerdict,
  orderRowVerdict,
  parseOrderSourceRef,
  itemProvenanceLabelText,
  resolveItemProvenance,
  validateItemProvenanceDeclarations,
  type ProvenanceMappingInput,
  type TurnSql,
} from './activation-item-provenance';
import { buildBlindReviewBrief } from './blind-review-brief';

const OWNER = 'session_turn:claude:s1:0';
const OWNER_DIALOG = 'session_turn:claude:s1:4';
const ASSISTANT = 'session_turn:claude:s1:1';
const LOOP_FIRE = 'session_turn:claude:s1:2';
const MACHINE = 'session_turn:claude:s1:3';
const UNREADABLE = 'session_turn:claude:s1:99';

const verdicts: Record<string, HitTurnOriginVerdict> = {
  [OWNER]: 'owner-typed',
  [OWNER_DIALOG]: 'owner-dialog',
  [ASSISTANT]: 'not-user-turn',
  [LOOP_FIRE]: 'agent-injected',
  [MACHINE]: 'machine-surface',
};
const originOf = (ref: string) => verdicts[ref];

function mapping(id: string, sourceRefs: string[], planTargets: string[], disposition: ProvenanceMappingInput['disposition'] = 'covered'): ProvenanceMappingInput {
  return { id, sourceRefs, planTargets, disposition };
}

describe('resolveItemProvenance — R-1: an agent quoting itself does not count as the owner', () => {
  it('assistant, machine-injected and unknown-origin refs alone never make an item owner-sourced', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001'],
      mappings: [mapping('M-001', [ASSISTANT, LOOP_FIRE, MACHINE, UNREADABLE], ['P-001'])],
      originOf,
    });
    expect(result.items[0]).toMatchObject({ itemId: 'P-001', label: 'unresolved', reason: 'no_owner_ref' });
    expect(result.items[0]!.refs.map((ref) => [ref.verdict, ref.owner])).toEqual([
      ['not-user-turn', false],
      ['agent-injected', false],
      ['machine-surface', false],
      ['unknown', false],
    ]);
    expect(result.unresolved).toEqual(['P-001']);
  });

  it('the same mapping with one owner-typed ref makes the item owner-sourced', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001'],
      mappings: [mapping('M-001', [ASSISTANT, LOOP_FIRE, MACHINE, UNREADABLE, OWNER], ['P-001'])],
      originOf,
    });
    expect(result.items[0]).toMatchObject({ itemId: 'P-001', label: 'owner', mappingIds: ['M-001'] });
    expect(result.items[0]!.reason).toBeUndefined();
    expect(result.counts).toEqual({ owner: 1, derived: 0, 'agent-added': 0, unresolved: 0 });
  });

  it('owner-dialog answers (AskUserQuestion) count as owner speech', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-002'],
      mappings: [mapping('M-002', [OWNER_DIALOG], ['P-002'])],
      originOf,
    });
    expect(result.items[0]!.label).toBe('owner');
  });

  it('a rejected mapping never backs its targets, even with an owner ref', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-003'],
      mappings: [mapping('M-003', [OWNER], ['P-003'], 'rejected')],
      originOf,
    });
    expect(result.items[0]).toMatchObject({ label: 'unresolved', reason: 'no_mapping', mappingIds: [] });
  });

  it('an agent-added declaration cannot override owner backing', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001'],
      mappings: [mapping('M-001', [OWNER], ['P-001'])],
      originOf,
      declarations: [{ itemId: 'P-001', kind: 'agent-added', reason: 'mine' }],
    });
    expect(result.items[0]!.label).toBe('owner');
  });
});

describe('resolveItemProvenance — derived and agent-added declarations', () => {
  it('derived from an owner-backed decision or item resolves as derived', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002', 'P-003'],
      mappings: [mapping('M-001', [OWNER], ['P-001', 'D-001'])],
      originOf,
      declarations: [
        { itemId: 'P-002', kind: 'derived', from: ['D-001'] },
        { itemId: 'P-003', kind: 'derived', from: ['P-002'] },
      ],
    });
    expect(result.items.map((item) => [item.itemId, item.label])).toEqual([
      ['P-001', 'owner'],
      ['P-002', 'derived'],
      ['P-003', 'derived'],
    ]);
    expect(result.items[1]!.derivedFrom).toEqual(['D-001']);
  });

  it('derivation cannot launder an agent-only source into owner backing', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002'],
      mappings: [mapping('M-001', [ASSISTANT], ['P-001', 'D-001'])],
      originOf,
      declarations: [{ itemId: 'P-002', kind: 'derived', from: ['D-001', 'P-001'] }],
    });
    expect(result.items[1]).toMatchObject({ label: 'unresolved', reason: 'derived_source_not_owner_backed' });
  });

  it('a derivation cycle with no owner anchor never resolves', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002'],
      mappings: [],
      originOf,
      declarations: [
        { itemId: 'P-001', kind: 'derived', from: ['P-002'] },
        { itemId: 'P-002', kind: 'derived', from: ['P-001'] },
      ],
    });
    expect(result.unresolved).toEqual(['P-001', 'P-002']);
  });

  it('agent-added needs a non-empty reason', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002'],
      mappings: [],
      originOf,
      declarations: [
        { itemId: 'P-001', kind: 'agent-added', reason: 'regression test the owner did not ask for' },
        { itemId: 'P-002', kind: 'agent-added', reason: '   ' },
      ],
    });
    expect(result.items[0]).toMatchObject({ label: 'agent-added', agentReason: 'regression test the owner did not ask for' });
    expect(result.items[1]).toMatchObject({ label: 'unresolved', reason: 'agent_added_reason_missing' });
  });
});

describe('validateItemProvenanceDeclarations', () => {
  it('collects every structural problem', () => {
    const problems = validateItemProvenanceDeclarations(
      [
        { itemId: 'P-009', kind: 'agent-added', reason: 'x' },
        { itemId: 'P-001', kind: 'derived', from: [' '] },
        { itemId: 'P-001', kind: 'agent-added', reason: '' },
      ],
      ['P-001'],
    );
    expect(problems.map((problem) => [problem.itemId, problem.code])).toEqual([
      ['P-009', 'provenance_item_unknown'],
      ['P-001', 'provenance_derived_from_empty'],
      ['P-001', 'provenance_item_duplicate'],
      ['P-001', 'provenance_reason_empty'],
    ]);
  });
});

describe('labels', () => {
  it('only the three owner verdicts are owner speech', () => {
    expect(['owner-typed', 'owner-turn', 'owner-dialog'].every((v) => isOwnerTurnVerdict(v as HitTurnOriginVerdict))).toBe(true);
    expect(['agent-injected', 'machine-surface', 'synthetic', 'not-user-turn', 'unknown'].some((v) => isOwnerTurnVerdict(v as HitTurnOriginVerdict))).toBe(false);
    expect(itemProvenanceLabelText('agent-added')).toBe('Added by the agent');
  });
});

describe('fetchSourceTurns — WI-10004057: a long paste-wrapped injection is not owner evidence', () => {
  const envelope = '⟦turn-origin:loop-fire nonce:559df93b11f00c02⟧';
  const turnText = `<pasted_content id="9879">\n${envelope}\nLoop wake body\n${'x'.repeat(3000)}\n</pasted_content id="9879">\n`;
  // Emulates `left(text, width)` / `right(text, 256)` over the one stored turn.
  const fakeSql: TurnSql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    // Template order: left(text, width), right(text, tailWidth), then the WHERE values.
    const [width, tailWidth] = values as [number, number];
    return [
      {
        source_kind: 'claude',
        session_id: 's1',
        turn_idx: 2,
        speaker: 'user',
        head: turnText.slice(0, width),
        tail: turnText.slice(-tailWidth),
      },
    ];
  }) as TurnSql;

  it('classifies the turn from head + tail, so it cannot count as the owner', async () => {
    const turns = await fetchSourceTurns(fakeSql, 'ws', [LOOP_FIRE]);
    const verdict = turns.get(LOOP_FIRE)?.verdict;
    expect(verdict).toBe('agent-injected');
    expect(isOwnerTurnVerdict(verdict)).toBe(false);
  });
});

describe('fetchSourceTurns — WI-10004510: an unproven clean turn is not owner evidence', () => {
  const CLEAN = 'Okay, write this into a plan and implement it';
  // One stored row per ref; `turn_idx` doubles as the selector for its stored verdict.
  const stored: Record<number, string | null> = { 0: 'owner-typed', 5: 'unenrolled-origin', 6: null };
  const fakeSql: TurnSql = (async (strings: TemplateStringsArray) => {
    expect(strings.join('?')).toMatch(/turn_origin_verdict/);
    return Object.entries(stored).map(([idx, verdict]) => ({
      source_kind: 'claude', session_id: 's1', turn_idx: Number(idx), speaker: 'user',
      head: CLEAN, tail: CLEAN, turn_origin: null, turn_origin_verdict: verdict,
    }));
  }) as TurnSql;
  const PROVEN = 'session_turn:claude:s1:0';
  const UNENROLLED = 'session_turn:claude:s1:5';
  const PRE_794 = 'session_turn:claude:s1:6';

  it('reads a stored unenrolled-origin turn as unknown, and keeps a proven or never-classified one', async () => {
    const turns = await fetchSourceTurns(fakeSql, 'ws', [PROVEN, UNENROLLED, PRE_794]);
    expect(turns.get(PROVEN)?.verdict).toBe('owner-typed');
    expect(turns.get(UNENROLLED)?.verdict).toBe('unknown');
    expect(turns.get(PRE_794)?.verdict).toBe('owner-typed');
  });

  it('an item backed only by an unenrolled-origin turn stays unresolved; a proven turn resolves it', async () => {
    const turns = await fetchSourceTurns(fakeSql, 'ws', [PROVEN, UNENROLLED]);
    const lookup = (ref: string) => turns.get(ref)?.verdict;
    const unproven = resolveItemProvenance({ itemIds: ['P-001'], mappings: [mapping('M-001', [UNENROLLED], ['P-001'])], originOf: lookup });
    expect(unproven.items[0]).toMatchObject({ itemId: 'P-001', label: 'unresolved', reason: 'no_owner_ref' });
    const proven = resolveItemProvenance({ itemIds: ['P-001'], mappings: [mapping('M-001', [UNENROLLED, PROVEN], ['P-001'])], originOf: lookup });
    expect(proven.items[0]).toMatchObject({ itemId: 'P-001', label: 'owner' });
  });
});

describe('order:<id> source refs — WI-6554700010017011: an owner directive with no transcript turn', () => {
  const HOOK_CAPTURED = 'order:1970';
  const AGENT_RECORDED = 'order:1971';
  const ABSENT = 'order:1972';
  const LEGACY_MACHINE = 'order:174';
  const OWNER_WORDS = 'can we make an interactive diagram as well for the cupboard page?';
  // Shape of the real legacy rows #170-#181 (WI-10002491): a carry-respawn continuation the
  // pre-fix hook captured with captured_by_hook = true. Nobody typed it.
  const MACHINE_CONTINUATION =
    '\n\n<pasted_content id="6620">\n⟦turn-origin:self-compaction nonce:0cfb7d076ccba175⟧\nResume plan papercusp-com-cupboard-diagram-2026-10-17.\n</pasted_content id="6620">';
  const directives: Record<string, { verbatim: string; captured_by_hook: boolean }> = {
    174: { verbatim: MACHINE_CONTINUATION, captured_by_hook: true },
    1970: { verbatim: OWNER_WORDS, captured_by_hook: true },
    1971: { verbatim: 'relayed: the owner wants a cupboard diagram', captured_by_hook: false },
  };
  /** Serves owner_directives by id (emulating left/right(verbatim_text, width)) and records every query. */
  const makeSql = () => {
    const queries: string[] = [];
    const sql: TurnSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      if (!text.includes('harness_shared.owner_directives')) return [];
      expect(text).toMatch(/directives\.workspace_id = \?/);
      // Template order: left(text, width), right(text, tailWidth), then the WHERE values.
      const [width, tailWidth, workspace, ids] = values as [number, number, string, number[]];
      if (workspace !== 'ws') return [];
      return ids
        .filter((id) => directives[id])
        .map((id) => ({
          id: String(id),
          verbatim_head: directives[id]!.verbatim.slice(0, width),
          verbatim_tail: directives[id]!.verbatim.slice(-tailWidth),
          captured_by_hook: directives[id]!.captured_by_hook,
        }));
    }) as TurnSql;
    return { sql, queries };
  };

  it('parses only a positive integer directive id', () => {
    expect(parseOrderSourceRef(HOOK_CAPTURED)).toBe(1970);
    for (const bad of ['order:0', 'order:', 'order:abc', 'order:1970x', 'order:-3', ' order:1970', 'directive:1970', 'session_turn:claude:s1:0']) {
      expect(parseOrderSourceRef(bad)).toBeNull();
    }
  });

  it('a hook-captured directive is owner speech carrying the verbatim words; an agent relay is not', async () => {
    const { sql } = makeSql();
    const turns = await fetchSourceTurns(sql, 'ws', [HOOK_CAPTURED, AGENT_RECORDED, ABSENT]);
    expect(turns.get(HOOK_CAPTURED)).toEqual({ speaker: 'user', text: OWNER_WORDS, verdict: 'owner-typed' });
    expect(isOwnerTurnVerdict(turns.get(HOOK_CAPTURED)?.verdict)).toBe(true);
    // orders:record rows have no hook provenance: unknown, never owner and never "fabricated".
    expect(turns.get(AGENT_RECORDED)?.verdict).toBe('unknown');
    expect(isOwnerTurnVerdict(turns.get(AGENT_RECORDED)?.verdict)).toBe(false);
    expect(turns.has(ABSENT)).toBe(false);
  });

  it('a hook-captured row carrying a machine origin envelope (legacy #170-#181) is NOT owner speech', async () => {
    const { sql } = makeSql();
    const turns = await fetchSourceTurns(sql, 'ws', [LEGACY_MACHINE, HOOK_CAPTURED]);
    const legacy = turns.get(LEGACY_MACHINE)?.verdict;
    expect(legacy).toBeDefined();
    expect(legacy).not.toBe('owner-typed');
    expect(isOwnerTurnVerdict(legacy)).toBe(false);
    expect(turns.get(HOOK_CAPTURED)?.verdict).toBe('owner-typed');
  });

  it('orderRowVerdict only ever downgrades the hook proof', () => {
    expect(orderRowVerdict(false, OWNER_WORDS, OWNER_WORDS)).toBe('unknown');
    expect(orderRowVerdict(true, OWNER_WORDS, OWNER_WORDS)).toBe('owner-typed');
    expect(isOwnerTurnVerdict(orderRowVerdict(true, MACHINE_CONTINUATION, MACHINE_CONTINUATION))).toBe(false);
    expect(orderRowVerdict(false, MACHINE_CONTINUATION, MACHINE_CONTINUATION)).toBe('unknown');
  });

  it('is workspace-scoped: the same id in another workspace does not resolve', async () => {
    const { sql } = makeSql();
    expect((await fetchOrderSourceTurns(sql, 'other-ws', [HOOK_CAPTURED])).size).toBe(0);
  });

  it('issues no owner_directives query when no order ref is cited', async () => {
    const { sql, queries } = makeSql();
    await fetchSourceTurns(sql, 'ws', ['session_turn:claude:s1:0', 'order:abc']);
    expect(queries.some((query) => query.includes('owner_directives'))).toBe(false);
  });

  it('backs a plan item and reaches the blind-review brief as an owner turn', async () => {
    const { sql } = makeSql();
    const turns = await fetchSourceTurns(sql, 'ws', [HOOK_CAPTURED, AGENT_RECORDED], 4000);
    const provenance = resolveItemProvenance({
      itemIds: ['P-001', 'P-002'],
      mappings: [mapping('M-001', [HOOK_CAPTURED], ['P-001']), mapping('M-002', [AGENT_RECORDED], ['P-002'])],
      originOf: (ref) => turns.get(ref)?.verdict,
    });
    expect(provenance.items.map((item) => [item.itemId, item.label])).toEqual([['P-001', 'owner'], ['P-002', 'unresolved']]);
    const brief = buildBlindReviewBrief({
      planSlug: 'plan-a',
      activation: { auditSeq: 3, mappings: [{ sourceRefs: [HOOK_CAPTURED, AGENT_RECORDED] }] },
      turns,
    });
    expect(brief.ownerTurns).toEqual([{ ref: HOOK_CAPTURED, text: OWNER_WORDS }]);
    expect(brief.excludedRefs).toEqual([{ ref: AGENT_RECORDED, reason: 'not-owner' }]);
    expect(brief.text).toContain(OWNER_WORDS);
  });
});

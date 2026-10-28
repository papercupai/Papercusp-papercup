/**
 * Code-intel P-011 (plan code-intel-delivery-and-outcomes-2026-10-26): the SHADOW
 * code-dependency coupling. One describe per spec clause; each title names the clause.
 */
import { describe, expect, it } from 'vitest';
import {
  CODE_DEPENDENCY_FAN_IN_CAP,
  codeDependencyPairKey,
  codeDependencyViewFor,
  deriveCouplings,
  deriveCouplingsFromCodeDependency,
  type CodeDependencyEvidence,
  type CodeDependencyShadowResult,
} from './coupling-derivation';

const EDITOR = 'su-editor';
const HOLDER = 'su-holder';

function evidence(over: Partial<CodeDependencyEvidence> = {}): CodeDependencyEvidence {
  return {
    editorOwnerId: EDITOR,
    symbol: 'readHistoryCommits',
    path: 'lib/change-history.ts',
    callers: 'measured',
    holders: [{ ownerId: HOLDER, path: 'lib/query.ts', via: 'lock', live: true }],
    editorWorkTerminal: false,
    editorSessionLive: true,
    ...over,
  };
}

function holders(n: number): CodeDependencyEvidence['holders'] {
  return Array.from({ length: n }, (_, i) => ({ ownerId: `su-h${i}`, path: `lib/caller-${i}.ts`, via: 'lock' as const, live: true }));
}

describe('SPEC-P-011 — shadow mode logs the would-be edge and never surfaces it', () => {
  const rows = [{ ownerId: EDITOR }, { ownerId: HOLDER }];

  it('logs the code-dependency edge while neither agent sees it in the delivered coupling view', async () => {
    const logged: CodeDependencyShadowResult[] = [];
    const forEditor = await deriveCouplings(EDITOR, rows, {
      codeDependency: async () => ({ evidence: [evidence()], suppressedPairs: [] }),
      shadowLog: (r) => { logged.push(r); },
    });
    const forHolder = await deriveCouplings(HOLDER, rows, {
      codeDependency: async () => ({ evidence: [evidence()], suppressedPairs: [] }),
      shadowLog: (r) => { logged.push(r); },
    });
    expect(forEditor.map((d) => d.ownerId)).not.toContain(HOLDER);
    expect(forHolder.map((d) => d.ownerId)).not.toContain(EDITOR);
    expect(logged).toHaveLength(2);
    for (const r of logged) {
      expect(r.mode).toBe('shadow');
      expect(r.edges).toHaveLength(1);
      expect(r.edges[0]).toMatchObject({ a: EDITOR, b: HOLDER, symbol: 'readHistoryCommits' });
    }
  });

  it('does not read the code-dependency source when there is no shadow log to write to', async () => {
    let read = 0;
    await deriveCouplings(EDITOR, rows, {
      codeDependency: async () => { read += 1; return { evidence: [evidence()], suppressedPairs: [] }; },
    });
    expect(read).toBe(0);
  });

  it('delivers exactly what a run without the shadow source delivers, even when the shadow log throws', async () => {
    const rosterRows = [{ ownerId: EDITOR }, { ownerId: HOLDER }];
    const heldFiles = async () => new Map([[EDITOR, ['lib/query.ts']], [HOLDER, ['lib/query.ts']]]);
    const baseline = await deriveCouplings(EDITOR, rosterRows, { heldFiles });
    expect(baseline.length).toBeGreaterThan(0);
    const withShadow = await deriveCouplings(EDITOR, rosterRows, {
      heldFiles,
      codeDependency: async () => ({ evidence: [evidence()], suppressedPairs: [] }),
      shadowLog: () => { throw new Error('log down'); },
    });
    expect(withShadow).toEqual(baseline);
  });

  it('logs only pairs whose other endpoint is on the caller roster', async () => {
    const logged: CodeDependencyShadowResult[] = [];
    await deriveCouplings(EDITOR, [{ ownerId: EDITOR }], {
      codeDependency: async () => ({ evidence: [evidence()], suppressedPairs: [] }),
      shadowLog: (r) => { logged.push(r); },
    });
    expect(logged[0]!.edges).toEqual([]);
  });
});

describe('SPEC-P-011-B — an exported-signature change with callers in another live agent held files forms one bidirectional shadow edge naming the symbol', () => {
  it('forms exactly one undirected edge that both endpoints see, with a plain reason naming the symbol', () => {
    const r = deriveCouplingsFromCodeDependency([evidence()]);
    expect(r.edges).toHaveLength(1);
    const edge = r.edges[0]!;
    expect(edge.reason).toContain('readHistoryCommits');
    expect(edge.reason).toContain('lib/query.ts');
    expect(edge.reason).not.toMatch(/[<>*`[\]]/);
    expect(codeDependencyViewFor(EDITOR, r)).toEqual([{ peerOwnerId: HOLDER, because: edge.reason }]);
    expect(codeDependencyViewFor(HOLDER, r)).toEqual([{ peerOwnerId: EDITOR, because: edge.reason }]);
  });

  it('forms no edge for a same-agent caller, a holder that is not live, or a caller file that is not held', () => {
    expect(deriveCouplingsFromCodeDependency([evidence({
      holders: [{ ownerId: EDITOR, path: 'lib/query.ts', via: 'lock', live: true }],
    })]).edges).toEqual([]);
    const notLive = deriveCouplingsFromCodeDependency([evidence({
      holders: [{ ownerId: HOLDER, path: 'lib/query.ts', via: 'working-set', live: false }],
    })]);
    expect(notLive.edges).toEqual([]);
    expect(notLive.outcomes).toEqual([expect.objectContaining({ kind: 'no-holder' })]);
    expect(deriveCouplingsFromCodeDependency([evidence({ holders: [] })]).edges).toEqual([]);
  });

  it('skips evidence whose symbol is not an identifier (not an exported-signature change)', () => {
    expect(deriveCouplingsFromCodeDependency([evidence({ symbol: 'behavioural strand risk' })])).toEqual(
      { mode: 'shadow', edges: [], outcomes: [] },
    );
  });

  it('merges a holder with several caller files into one edge listing them all', () => {
    const r = deriveCouplingsFromCodeDependency([evidence({
      holders: [
        { ownerId: HOLDER, path: 'lib/b.ts', via: 'lock', live: true },
        { ownerId: HOLDER, path: 'lib/a.ts', via: 'working-set', live: true },
      ],
    })]);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.callerPaths).toEqual(['lib/a.ts', 'lib/b.ts']);
  });
});

describe('SPEC-P-011-C — a stale or unknown callers index forms no edge and records unknown', () => {
  it.each(['unknown', 'stale'] as const)('callers=%s yields no edge and an unknown outcome carrying that state', (callers) => {
    const r = deriveCouplingsFromCodeDependency([evidence({ callers })]);
    expect(r.edges).toEqual([]);
    expect(r.outcomes).toEqual([expect.objectContaining({ kind: 'unknown', callers })]);
    expect(r.outcomes.some((o) => o.kind === 'no-holder')).toBe(false);
  });
});

describe('SPEC-P-011-D — more than 5 caller-holding agents forms no edges and records a fan-in skip', () => {
  it('the cap is 5', () => {
    expect(CODE_DEPENDENCY_FAN_IN_CAP).toBe(5);
  });

  it('6 caller-holding agents form no edge at all and record one fan-in skip', () => {
    const r = deriveCouplingsFromCodeDependency([evidence({ holders: holders(6) })]);
    expect(r.edges).toEqual([]);
    expect(r.outcomes).toEqual([expect.objectContaining({ kind: 'fan-in-skip', holderCount: 6 })]);
  });

  it('5 caller-holding agents each form an edge', () => {
    const r = deriveCouplingsFromCodeDependency([evidence({ holders: holders(5) })]);
    expect(r.edges).toHaveLength(5);
    expect(new Set(r.edges.map((e) => e.holderOwnerId)).size).toBe(5);
  });

  it('the editor and non-live holders do not count toward the cap', () => {
    const extra = [
      { ownerId: EDITOR, path: 'lib/self.ts', via: 'lock' as const, live: true },
      { ownerId: 'su-gone', path: 'lib/gone.ts', via: 'lock' as const, live: false },
    ];
    expect(deriveCouplingsFromCodeDependency([evidence({ holders: [...holders(5), ...extra] })]).edges).toHaveLength(5);
  });
});

describe('SPEC-P-011-E — the edge ends when the editor work item is terminal', () => {
  it('a terminal editor work item forms no edge and records ended', () => {
    const r = deriveCouplingsFromCodeDependency([evidence({ editorWorkTerminal: true })]);
    expect(r.edges).toEqual([]);
    expect(r.outcomes).toEqual([expect.objectContaining({ kind: 'ended' })]);
  });

  it('an ended editor session also ends the edge', () => {
    expect(deriveCouplingsFromCodeDependency([evidence({ editorSessionLive: false })]).edges).toEqual([]);
  });

  it('the same evidence forms the edge while the work is live', () => {
    expect(deriveCouplingsFromCodeDependency([evidence({ editorWorkTerminal: false })]).edges).toHaveLength(1);
  });
});

describe('SPEC-P-011-F — an explicit decouple suppresses the pair until a re-couple', () => {
  it('a decoupled pair forms no edge and records suppressed, while another pair on the same symbol still forms', () => {
    const ev = evidence({ holders: [
      { ownerId: HOLDER, path: 'lib/query.ts', via: 'lock', live: true },
      { ownerId: 'su-other', path: 'lib/other.ts', via: 'lock', live: true },
    ] });
    const r = deriveCouplingsFromCodeDependency([ev], { suppressedPairs: new Set([codeDependencyPairKey(HOLDER, EDITOR)]) });
    expect(r.edges.map((e) => e.holderOwnerId)).toEqual(['su-other']);
    expect(r.outcomes).toContainEqual(expect.objectContaining({ kind: 'suppressed', peerOwnerId: HOLDER }));
  });

  it('the pair key is order-independent, and lifting the suppression (re-couple) re-forms the edge', () => {
    expect(codeDependencyPairKey(EDITOR, HOLDER)).toBe(codeDependencyPairKey(HOLDER, EDITOR));
    const suppressed = new Set([codeDependencyPairKey(EDITOR, HOLDER)]);
    expect(deriveCouplingsFromCodeDependency([evidence()], { suppressedPairs: suppressed }).edges).toEqual([]);
    suppressed.clear();
    expect(deriveCouplingsFromCodeDependency([evidence()], { suppressedPairs: suppressed }).edges).toHaveLength(1);
  });

  it('deriveCouplings passes the decouple mask from the source through to the shadow result', async () => {
    const logged: CodeDependencyShadowResult[] = [];
    await deriveCouplings(EDITOR, [{ ownerId: EDITOR }, { ownerId: HOLDER }], {
      codeDependency: async () => ({ evidence: [evidence()], suppressedPairs: [codeDependencyPairKey(EDITOR, HOLDER)] }),
      shadowLog: (r) => { logged.push(r); },
    });
    expect(logged[0]!.edges).toEqual([]);
    expect(logged[0]!.outcomes).toContainEqual(expect.objectContaining({ kind: 'suppressed' }));
  });
});

describe('AUTO-BAR-R-6-P-011 — the code-dependency coupling contract end to end (shadow)', () => {
  it('forms one bidirectional plain-reason edge only for live, measured, held, uncapped, undecoupled pairs', () => {
    const r = deriveCouplingsFromCodeDependency([
      evidence(),
      evidence({ symbol: 'unknownSym', callers: 'unknown' }),
      evidence({ symbol: 'cappedSym', holders: holders(6) }),
      evidence({ symbol: 'doneSym', editorWorkTerminal: true }),
    ]);
    expect(r.edges.map((e) => e.symbol)).toEqual(['readHistoryCommits']);
    expect(r.outcomes.map((o) => o.kind).sort()).toEqual(['edge', 'ended', 'fan-in-skip', 'unknown']);
    expect(codeDependencyViewFor(EDITOR, r)).toHaveLength(1);
    expect(codeDependencyViewFor(HOLDER, r)).toHaveLength(1);
  });
});

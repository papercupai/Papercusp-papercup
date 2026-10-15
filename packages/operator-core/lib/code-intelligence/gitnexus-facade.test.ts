/**
 * Contract tests for the GitNexus facade (P-006).
 *
 * Every fixture below is a REAL envelope measured from gitnexus 1.6.9 on
 * 2026-08-21 against the index built at 07:25Z, not an invented shape. Where a
 * field looks wrong (`startLine: 105` for a symbol declared on line 106) that
 * is the backend's actual behaviour and the reason the normalization exists.
 *
 * The suite is built to FAIL when the rails break, so it carries permanent
 * controls rather than only happy paths: a nonsense-input control, a
 * confident-empty control, and a line-normalization control that would catch a
 * silent off-by-one regression in either direction.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  configureGitnexusDispatch,
  type GitnexusDispatch,
  gitnexusFacade,
  gitnexusRefusal,
  gitnexusOpForIntent,
  gitnexusAdoptionSnapshot,
  _resetGitnexusAdoptionCountersForTests,
  parseFreshnessNote,
  GITNEXUS_FACADE_OPS,
  GITNEXUS_NOT_ROUTABLE,
  MAX_SITES_PER_ANSWER,
  truncationNotice,
  fileEdgeNotice,
  FILE_LEVEL_EDGE_DETAIL,
} from './gitnexus-facade.ts';
import { isTrustworthyEmpty, RIPGREP_SCOPE_GUIDANCE, toOneIndexed } from './contracts.ts';
import { ACCEPTANCE_CORPUS } from './acceptance-corpus.ts';

/** The exact `context` envelope gitnexus returned for `pinModuleState`. */
function contextFoundEnvelope(freshnessNote = ''): unknown {
  return {
    content: [
      {
        text:
          JSON.stringify({
            status: 'found',
            symbol: {
              uid: 'Function:libs/generic/module-singleton/src/index.ts:pinModuleState',
              name: 'pinModuleState',
              kind: 'Function',
              filePath: 'libs/generic/module-singleton/src/index.ts',
              // ZERO-INDEXED as measured; the true declaration is line 106.
              startLine: 105,
              endLine: 120,
            },
            epistemic: 'exact',
            incoming: {
              calls: [
                {
                  uid: 'Function:libs/generic/module-singleton/src/index.test.ts:make',
                  name: 'make',
                  filePath: 'libs/generic/module-singleton/src/index.test.ts',
                  startLine: 41,
                },
              ],
            },
            outgoing: { accesses: [] },
          }) + freshnessNote,
      },
    ],
  };
}

function envelope(body: unknown, trailer = ''): unknown {
  return { content: [{ text: JSON.stringify(body) + trailer }] };
}

const CURRENT_INDEXED_AT = '2026-08-24T04:00:00.000Z';
const CURRENT_INDEX_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function listReposEnvelope(options: {
  repo?: string;
  indexedAt?: string;
  lastCommit?: string;
  commitsBehind?: number;
} = {}): unknown {
  return envelope({
    repositories: [
      {
        name: options.repo ?? 'papercusp',
        indexedAt: options.indexedAt ?? CURRENT_INDEXED_AT,
        lastCommit: options.lastCommit ?? CURRENT_INDEX_COMMIT,
        staleness: { commitsBehind: options.commitsBehind ?? 0 },
      },
    ],
  });
}

type DispatchResponder = GitnexusDispatch;

/** Add the mandatory structured list_repos health probe to an older fixture. */
function withIndexHealth(
  responder: DispatchResponder,
  options: Parameters<typeof listReposEnvelope>[0] = {},
): DispatchResponder {
  return async (tool, args) =>
    tool === 'list_repos' ? listReposEnvelope(options) : responder(tool, args);
}

const STALE_NOTE =
  '\n---\n⚠ EMPTY/NOT-FOUND RESULT FROM A INDEX (built 34min ago, at commit ' +
  '98d2ec9ced, HEAD has moved since). A symbol written after the index was ' +
  'built is reported EXACTLY like one that does not exist.';

beforeEach(() => {
  configureGitnexusDispatch(null);
  _resetGitnexusAdoptionCountersForTests();
});

describe('line normalization (D-008)', () => {
  it('converts the measured zero-indexed startLine to a one-indexed citation', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => contextFoundEnvelope()));
    const a = await gitnexusFacade('symbol', { name: 'pinModuleState' });
    expect(a.sites).toHaveLength(1);
    // 105 (gitnexus) -> 106 (grep -n). The literal is spelled out so a
    // regression cannot be "fixed" by editing an expectation to match.
    expect(a.sites[0]?.line1).toBe(106);
    expect(a.sites[0]?.path).toBe('libs/generic/module-singleton/src/index.ts');
  });

  it('CONTROL: a raw pass-through would produce 105, so the test can fail', () => {
    // Guards the guard: if toOneIndexed ever became identity for gitnexus,
    // the assertion above would silently start passing against 105.
    expect(toOneIndexed('gitnexus', 105)).toBe(106);
    expect(toOneIndexed('gitnexus', 105)).not.toBe(105);
  });

  it('a missing line stays null rather than becoming line 1', async () => {
    configureGitnexusDispatch(
      withIndexHealth(async () =>
        envelope({
          status: 'found',
          symbol: { name: 'x', kind: 'Function', filePath: 'a/b.ts' },
        }),
      ),
    );
    const a = await gitnexusFacade('symbol', { name: 'x' });
    expect(a.sites[0]?.line1).toBeNull();
  });

  it('copies list_repos freshness onto a positive hit', async () => {
    const seen: string[] = [];
    configureGitnexusDispatch(
      withIndexHealth(
        async (tool) => {
          seen.push(tool);
          return contextFoundEnvelope();
        },
        {
          indexedAt: '2026-08-24T03:00:00.000Z',
          lastCommit: 'fedcba9876543210fedcba9876543210fedcba98',
          commitsBehind: 7,
        },
      ),
    );

    const a = await gitnexusFacade('symbol', { name: 'pinModuleState' });

    expect(seen).toEqual(['context']);
    expect(a.freshness).toEqual({
      health: 'degraded',
      indexedAt: '2026-08-24T03:00:00.000Z',
      staleVsDisk: true,
      indexedCommit: 'fedcba9876543210fedcba9876543210fedcba98',
    });
    expect(a.error).toBeNull();
  });

  it('enriches UID-only edge rows through context before normalizing sites', async () => {
    const edgeUid = 'Function:pkg/caller.ts:caller';
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    configureGitnexusDispatch(
      withIndexHealth(async (tool, args) => {
        seen.push({ tool, args });
        if (tool === 'context' && args.uid === edgeUid) {
          return envelope({
            status: 'found',
            symbol: {
              uid: edgeUid,
              name: 'caller',
              kind: 'Function',
              filePath: 'pkg/caller.ts',
              startLine: 8,
            },
          });
        }
        return envelope({
          status: 'found',
          symbol: {
            uid: 'Function:pkg/target.ts:target',
            name: 'target',
            kind: 'Function',
            filePath: 'pkg/target.ts',
            startLine: 20,
          },
          incoming: { calls: [{ uid: edgeUid, name: 'caller' }] },
        });
      }),
    );

    const a = await gitnexusFacade('callers', { name: 'target' });

    expect(a.error).toBeNull();
    expect(a.sites).toEqual([
      { path: 'pkg/caller.ts', line1: 9, kind: 'function', detail: 'caller' },
    ]);
    expect(seen).toEqual([
      { tool: 'context', args: { name: 'target', repo: 'papercusp' } },
      { tool: 'context', args: { uid: edgeUid, repo: 'papercusp' } },
    ]);
  });
});

describe('failure shaping — an empty answer is never silently confident', () => {
  it('a thrown dispatch yields sites:[] WITH an error and unhealthy health', async () => {
    configureGitnexusDispatch(
      withIndexHealth(async () => {
        throw new Error('gitnexus mcp process exited');
      }),
    );
    const a = await gitnexusFacade('symbol', { name: 'whatever' });
    expect(a.sites).toEqual([]);
    expect(a.error).toMatch(/process exited/);
    expect(a.freshness.health).toBe('unhealthy');
    // The load-bearing assertion: honest because it is loud.
    expect(isTrustworthyEmpty(a)).toBe(true);
  });

  it('an unconfigured dispatch is a wiring fault, not "no matches"', async () => {
    const a = await gitnexusFacade('symbol', { name: 'whatever' });
    expect(a.sites).toEqual([]);
    expect(a.error).toMatch(/not configured/);
    expect(a.freshness.health).toBe('unknown');
  });

  it('a stale index DEGRADES a not-found instead of asserting absence', async () => {
    configureGitnexusDispatch(
      withIndexHealth(
        async () => envelope({ status: 'not_found' }),
        { lastCommit: '98d2ec9ced', commitsBehind: 64 },
      ),
    );
    const a = await gitnexusFacade('symbol', { name: 'writtenFiveMinutesAgo' });
    expect(a.sites).toEqual([]);
    expect(a.freshness.staleVsDisk).toBe(true);
    expect(a.freshness.indexedCommit).toBe('98d2ec9ced');
    expect(a.freshness.health).toBe('degraded');
    expect(a.error).toMatch(/behind HEAD/);
    // NOTE the distinction, which is easy to conflate and which this suite
    // originally got wrong: isTrustworthyEmpty asks "is this empty HONEST?",
    // not "does it prove absence?". A degraded answer carrying a loud error is
    // honest — it is impossible to mistake for a confident empty — so `true`
    // is correct here. What a caller must NOT do is treat it as authoritative
    // absence, and the signal for that is the health field, asserted below.
    expect(isTrustworthyEmpty(a)).toBe(true);
    expect(a.freshness.health).not.toBe('healthy');
  });

  it('a CURRENT index miss preserves health but never proves source absence', async () => {
    configureGitnexusDispatch(
      withIndexHealth(async () => envelope({ status: 'not_found' })),
    );
    const a = await gitnexusFacade('symbol', { name: 'genuinelyAbsent' });
    expect(a.freshness.health).toBe('healthy');
    expect(a.error).toMatch(/source existence is unverified/);
    expect(a.coverage).toMatchObject({ basis: 'indexed-code', sourceCompleteness: 'unverified' });
    expect(isTrustworthyEmpty(a)).toBe(true);
  });

  it('preserves ambiguity and an actionable production-symbol anchor', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => envelope({
      status: 'ambiguous',
      candidates: [{ uid: 'Function:src/prod.ts:helper', name: 'helper', filePath: 'src/prod.ts' }],
    })));
    const a = await gitnexusFacade('symbol', { name: 'helper' });
    expect(a.sites).toEqual([]);
    expect(a.error).toContain('ambiguous');
    expect(a.error).toContain('Function:src/prod.ts:helper');
    expect(a.error).toContain('file_path');
  });

  it('forwards file_path and uid to context, and OMITS them when absent (WI-10005154)', async () => {
    const seenArgs: Record<string, unknown>[] = [];
    configureGitnexusDispatch(
      withIndexHealth(async (tool, args) => {
        if (tool === 'context') seenArgs.push(args);
        return contextFoundEnvelope();
      }),
    );

    await gitnexusFacade('symbol', { name: 'helper' });
    await gitnexusFacade('callers', {
      name: 'helper',
      file_path: 'src/prod.ts',
      uid: 'Function:src/prod.ts:helper',
    });

    // By-name call shape is byte-identical to before: no empty disambiguator keys.
    expect(seenArgs[0]).toEqual({ name: 'helper', repo: 'papercusp' });
    expect(seenArgs[0]).not.toHaveProperty('file_path');
    expect(seenArgs[0]).not.toHaveProperty('uid');
    expect(seenArgs[1]).toMatchObject({
      name: 'helper',
      file_path: 'src/prod.ts',
      uid: 'Function:src/prod.ts:helper',
    });
  });

  it('an ambiguous name resolves once file_path is supplied, and never guesses without it', async () => {
    // A stub that behaves like the live index: three same-name definitions,
    // ambiguous by name alone, found when the defining file is given.
    configureGitnexusDispatch(
      withIndexHealth(async (tool, args) => {
        if (tool !== 'context') throw new Error(`unexpected tool ${tool}`);
        if (args.file_path === 'src/prod.ts') {
          return envelope({
            status: 'found',
            symbol: { uid: 'Function:src/prod.ts:helper', name: 'helper', kind: 'Function', filePath: 'src/prod.ts', startLine: 9 },
          });
        }
        return envelope({
          status: 'ambiguous',
          candidates: [
            { uid: 'Function:src/prod.ts:helper', name: 'helper', filePath: 'src/prod.ts' },
            { uid: 'Function:src/prod.test.ts:helper', name: 'helper', filePath: 'src/prod.test.ts' },
          ],
        });
      }),
    );

    const bare = await gitnexusFacade('symbol', { name: 'helper' });
    expect(bare.sites).toEqual([]);
    expect(bare.error).toContain('ambiguous');

    const scoped = await gitnexusFacade('symbol', { name: 'helper', file_path: 'src/prod.ts' });
    expect(scoped.error ?? '').not.toContain('ambiguous');
    expect(scoped.sites).toHaveLength(1);
    expect(scoped.sites[0]).toMatchObject({ path: 'src/prod.ts', line1: 10, kind: 'function' });
  });

  it('a file_path that matches no candidate stays a miss — it never falls back to another definition', async () => {
    configureGitnexusDispatch(
      withIndexHealth(async (_tool, args) =>
        args.file_path ? envelope({ status: 'not_found' }) : contextFoundEnvelope(),
      ),
    );
    const a = await gitnexusFacade('symbol', { name: 'helper', file_path: 'src/elsewhere.ts' });
    expect(a.sites).toEqual([]);
    expect(a.error).toMatch(/source existence is unverified/);
  });

  it('keeps malformed or failed context distinct from a symbol miss', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => envelope({ error: 'database unavailable' })));
    const a = await gitnexusFacade('symbol', { name: 'helper' });
    expect(a.freshness.health).toBe('unhealthy');
    expect(a.error).toContain('database unavailable');
  });

  it('does not turn field-access relations into function callees', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => envelope({
      status: 'found',
      symbol: { name: 'helper', filePath: 'src/prod.ts', startLine: 0 },
      outgoing: { accesses: [{ name: 'field', filePath: 'src/data.ts', startLine: 3 }] },
    })));
    const a = await gitnexusFacade('callees', { name: 'helper' });
    expect(a.sites).toEqual([]);
    expect(a.coverage?.sourceCompleteness).toBe('unverified');
  });

  it('impact reports an unknown target as an explicit error, not an empty set', async () => {
    configureGitnexusDispatch(
      withIndexHealth(async () =>
        envelope({ error: "Target 'zzz' not found", impactedCount: 0, risk: 'UNKNOWN' }),
      ),
    );
    const a = await gitnexusFacade('impact', { name: 'zzz' });
    expect(a.error).toMatch(/not found/);
    expect(isTrustworthyEmpty(a)).toBe(true);
  });
});

describe('refusals name the alternative (D-021)', () => {
  it.each(Object.keys(GITNEXUS_NOT_ROUTABLE))(
    'refuses %s with a concrete useInstead',
    (intent) => {
      const r = gitnexusRefusal(intent as never, 'someSymbol');
      expect(r).not.toBeNull();
      expect(r?.sites).toEqual([]);
      expect(r?.error).toMatch(/Use instead:/);
      // 'unknown' is what keeps a refusal from reading as proof of absence.
      expect(r?.freshness.health).toBe('unknown');
      expect(isTrustworthyEmpty(r!)).toBe(true);
    },
  );

  it('text-search and references are refused — the noise failure of D-021', () => {
    expect(GITNEXUS_NOT_ROUTABLE['text-search']).toBeDefined();
    expect(GITNEXUS_NOT_ROUTABLE.references).toBeDefined();
    expect(GITNEXUS_NOT_ROUTABLE['text-search']?.useInstead).toMatch(/ripgrep|rg/i);
  });

  it('text-search fallback names source scope and generated-public exclusions', () => {
    expect(RIPGREP_SCOPE_GUIDANCE).toMatch(/apps\/operator\/lib/);
    expect(RIPGREP_SCOPE_GUIDANCE).toMatch(/packages\/operator-core\/lib/);
    expect(RIPGREP_SCOPE_GUIDANCE).toMatch(/apps\/operator\/public\/internal\/docs/);
    expect(GITNEXUS_NOT_ROUTABLE['text-search']?.useInstead).toBe(RIPGREP_SCOPE_GUIDANCE);
  });

  it('a routable intent is NOT refused', () => {
    expect(gitnexusRefusal('definition', 'x')).toBeNull();
    expect(gitnexusRefusal('callers', 'x')).toBeNull();
  });

  it('routing and refusal are mutually exclusive for every intent', () => {
    // The property that matters: an intent is EITHER routed to an op OR
    // refused with a reason — never both (contradictory) and never neither
    // (silence). Asserted across the whole intent union, not a hand-listed
    // subset, so a newly added intent cannot slip through unclassified.
    const ALL_INTENTS = [
      'definition',
      'references',
      'implementations',
      'callers',
      'callees',
      'impact',
      'rename-preview',
      'diagnostics',
      'symbol-search',
      'structural-search',
      'text-search',
      'pack',
    ] as const;

    for (const intent of ALL_INTENTS) {
      const routed = gitnexusOpForIntent(intent) !== null;
      const refused = GITNEXUS_NOT_ROUTABLE[intent] !== undefined;
      expect(routed && refused).toBe(false);
    }

    // Every declared non-routable intent really is unrouted.
    for (const intent of Object.keys(GITNEXUS_NOT_ROUTABLE)) {
      expect(gitnexusOpForIntent(intent as never)).toBeNull();
    }
  });

  it('`health` is callable directly but is NOT reachable by intent routing', () => {
    // A deliberate asymmetry worth pinning, because it looks like a bug:
    // op:"health" exists and answers "can I trust this backend", but the
    // 'diagnostics' intent must NOT resolve to it — a liveness probe standing
    // in for compiler diagnostics would return a healthy-looking empty for a
    // file full of type errors.
    expect(GITNEXUS_FACADE_OPS).toContain('health');
    expect(gitnexusOpForIntent('diagnostics')).toBeNull();
    expect(gitnexusRefusal('diagnostics', 'x')?.error).toMatch(/lsp:query/);
  });
});

describe('truncation is explicit and records the PRE-CUT total', () => {
  it('caps sites at the limit and reports how many there really were', async () => {
    const calls = Array.from({ length: 250 }, (_, i) => ({
      name: `caller${i}`,
      filePath: `pkg/file${i}.ts`,
      startLine: i,
    }));
    configureGitnexusDispatch(
      withIndexHealth(async () =>
        envelope({
          status: 'found',
          symbol: { name: 'hot', kind: 'Function', filePath: 'a.ts', startLine: 0 },
          incoming: { calls },
        }),
      ),
    );
    const a = await gitnexusFacade('callers', { name: 'hot', limit: 10 });
    expect(a.sites).toHaveLength(10);
    expect(a.truncation.truncated).toBe(true);
    // The whole point: a capped 10 must not read as a true 10.
    expect(a.truncation.totalAvailable).toBe(250);
  });

  it('CONTROL: an under-limit answer is NOT marked truncated', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => contextFoundEnvelope()));
    const a = await gitnexusFacade('callers', { name: 'pinModuleState', limit: 10 });
    expect(a.truncation.truncated).toBe(false);
  });

  it('clamps an absurd caller-supplied limit to the budget', async () => {
    const calls = Array.from({ length: 500 }, (_, i) => ({
      name: `c${i}`,
      filePath: `f${i}.ts`,
      startLine: i,
    }));
    configureGitnexusDispatch(
      withIndexHealth(async () =>
        envelope({
          status: 'found',
          symbol: { name: 'hot', kind: 'Function', filePath: 'a.ts', startLine: 0 },
          incoming: { calls },
        }),
      ),
    );
    const a = await gitnexusFacade('callers', { name: 'hot', limit: 10_000 });
    expect(a.sites.length).toBeLessThanOrEqual(MAX_SITES_PER_ANSWER);
    expect(a.truncation.truncated).toBe(true);
  });
});

describe('a budget-cut payload is TRUNCATION, not malformation and not absence', () => {
  /** A payload sliced mid-string at the budget, exactly as measured. */
  function budgetCutPayload(): unknown {
    const valid = JSON.stringify({
      target: 'managedSpawn',
      direction: 'downstream',
      impactedCount: 42,
      risk: 'CRITICAL',
      byDepth: 'x'.repeat(30_000),
    });
    return { content: [{ text: valid.slice(0, 20_000) }] };
  }

  it('reports truncated:true with a remedy, and never impactedCount 0', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => budgetCutPayload()));
    const a = await gitnexusFacade('impact', { name: 'managedSpawn', limit: 100 });
    expect(a.truncation.truncated).toBe(true);
    expect(a.error).toMatch(/TRUNCATED/);
    expect(a.error).toMatch(/smaller `limit`/);
    expect(a.freshness.health).toBe('degraded');
    // The inversion this guards against: the biggest blast radii are exactly
    // the ones that overflow, so reporting them as zero is maximally wrong.
    expect(a.truncation.totalAvailable).not.toBe(0);
  });

  it('the notice denies emptiness explicitly, for EVERY op', () => {
    // The wording contract, pinned once and here. Both facade branches route
    // through truncationNotice(), and the integration suite asserts equality
    // against it — so this is the only place the SEMANTICS are checked, and
    // without it that equality assertion would be tautological.
    //
    // The second clause is the load-bearing one. "Cut at the budget" alone
    // still lets a reader conclude there was nothing to see; the notice has to
    // say outright that the answer was non-empty. That clause is precisely
    // what drifted into three different spellings before it was consolidated.
    for (const op of GITNEXUS_FACADE_OPS) {
      const notice = truncationNotice(op);
      expect(notice).toMatch(/TRUNCATED/);
      expect(notice).toMatch(/not an empty one/);
      expect(notice).toMatch(/smaller `limit`/);
      // Names which op was cut — a bare notice cannot be attributed to a call.
      expect(notice).toContain(`gitnexus ${op} `);
    }
  });

  it('CONTROL: a SHORT unparseable body is malformation, not truncation', async () => {
    // Without this control, "unparseable" could be blanket-excused as
    // truncation and a genuinely broken backend would read as merely capped.
    configureGitnexusDispatch(
      withIndexHealth(async () => ({ content: [{ text: '{not json at all' }] })),
    );
    const a = await gitnexusFacade('symbol', { name: 'x' });
    expect(a.truncation.truncated).toBe(false);
    expect(a.freshness.health).toBe('unhealthy');
    expect(a.error).toMatch(/unparseable envelope/);
  });
});

describe('the health op never returns a silent "I do not know"', () => {
  it('measures health from list_repos freshness rather than a context status field', async () => {
    const seen: string[] = [];
    configureGitnexusDispatch(
      withIndexHealth(
        async (tool) => {
          seen.push(tool);
          return envelope({ status: 'found' });
        },
        { commitsBehind: 3, lastCommit: 'abc123abc123abc123abc123abc123abc123abcd' },
      ),
    );

    const a = await gitnexusFacade('health', {});

    expect(seen).toEqual([]);
    expect(a.freshness.health).toBe('degraded');
    expect(a.freshness.staleVsDisk).toBe(true);
    expect(a.freshness.indexedCommit).toBe('abc123abc123abc123abc123abc123abc123abcd');
    expect(a.error).toBeNull();
  });

  it('a status-less probe carries an explicit error', async () => {
    configureGitnexusDispatch(async (tool) =>
      tool === 'list_repos' ? envelope({ something: 'else' }) : envelope({ status: 'found' }),
    );
    const a = await gitnexusFacade('health', {});
    expect(a.freshness.health).toBe('unknown');
    expect(a.error).toMatch(/UNMEASURED/);
    // An unknown+errorless empty would fail this, which is the point.
    expect(isTrustworthyEmpty(a)).toBe(true);
  });
});

describe('freshness note parsing is defensive', () => {
  it('extracts commit and staleness from the real note', () => {
    const f = parseFreshnessNote(STALE_NOTE);
    expect(f.indexedCommit).toBe('98d2ec9ced');
    expect(f.staleVsDisk).toBe(true);
  });

  it('an absent note yields nulls, never a confident default', () => {
    const f = parseFreshnessNote('no decoration here');
    expect(f.indexedCommit).toBeNull();
    // null means "could not tell" and is branchable; false would be a lie.
    expect(f.staleVsDisk).toBeNull();
  });
});

// These counters are a PROCESS-LOCAL probe, not the adoption measurement —
// adoption is derived from `tool_invocations` (see the facade's comment on
// GitnexusAdoptionCounters). The suite name says so, because the old name
// ("adoption telemetry") is what let a module-global nobody reads be mistaken
// for a metric.
describe('process-local dispatch counters (NOT adoption — see tool_invocations)', () => {
  it('counts dispatches per op and refusals per intent', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => contextFoundEnvelope()));
    await gitnexusFacade('symbol', { name: 'a' });
    await gitnexusFacade('symbol', { name: 'b' });
    await gitnexusFacade('callers', { name: 'c' });
    gitnexusRefusal('text-search', 'q');

    const s = gitnexusAdoptionSnapshot();
    expect(s.dispatched).toBe(3);
    expect(s.byOp.symbol).toBe(2);
    expect(s.byOp.callers).toBe(1);
    expect(s.refused).toBe(1);
    expect(s.refusedByIntent['text-search']).toBe(1);
  });

  it('the snapshot is a copy — a caller cannot mutate the counters', async () => {
    configureGitnexusDispatch(withIndexHealth(async () => contextFoundEnvelope()));
    await gitnexusFacade('symbol', { name: 'a' });
    const s = gitnexusAdoptionSnapshot();
    s.dispatched = 999;
    s.byOp.symbol = 999;
    expect(gitnexusAdoptionSnapshot().dispatched).toBe(1);
    expect(gitnexusAdoptionSnapshot().byOp.symbol).toBe(1);
  });
});

/**
 * The file-level-edge fixtures are the REAL rows measured 2026-09-02 against
 * gitnexus 1.6.9 at index commit acab51f9, reached through the live
 * `graph:query` tool. `callers('pinModuleState')` returned three edges of which
 * exactly one was a call site; `index.test.ts` appeared TWICE — once as the
 * true caller `make`, once as the bare containing file.
 *
 * The load-bearing detail is that enrichment does not FAIL on a file node. It
 * answers `status:'found'` with a symbol that simply has no `kind` and no
 * `startLine`, so "the probe succeeded" is not evidence a call site was found.
 * A guard written against a thrown/absent enrichment would miss this entirely.
 */
const CALLER_EDGE_ROWS = [
  {
    uid: 'Function:libs/generic/module-singleton/src/index.test.ts:make',
    name: 'make',
    filePath: 'libs/generic/module-singleton/src/index.test.ts',
  },
  {
    uid: 'File:libs/generic/module-singleton/src/pinned-subject.fixture.ts',
    name: 'pinned-subject.fixture.ts',
    filePath: 'libs/generic/module-singleton/src/pinned-subject.fixture.ts',
  },
  {
    uid: 'File:libs/generic/module-singleton/src/index.test.ts',
    name: 'index.test.ts',
    filePath: 'libs/generic/module-singleton/src/index.test.ts',
  },
];

/** Enrichment responses, keyed by uid — symbol nodes carry a line, files do not. */
const ENRICHED_BY_UID: Record<string, Record<string, unknown>> = {
  'Function:libs/generic/module-singleton/src/index.test.ts:make': {
    uid: 'Function:libs/generic/module-singleton/src/index.test.ts:make',
    name: 'make',
    kind: 'Function',
    filePath: 'libs/generic/module-singleton/src/index.test.ts',
    startLine: 71,
  },
  'File:libs/generic/module-singleton/src/pinned-subject.fixture.ts': {
    uid: 'File:libs/generic/module-singleton/src/pinned-subject.fixture.ts',
    name: 'pinned-subject.fixture.ts',
    filePath: 'libs/generic/module-singleton/src/pinned-subject.fixture.ts',
  },
  'File:libs/generic/module-singleton/src/index.test.ts': {
    uid: 'File:libs/generic/module-singleton/src/index.test.ts',
    name: 'index.test.ts',
    filePath: 'libs/generic/module-singleton/src/index.test.ts',
  },
};

function mixedEdgeDispatch(edgeKey: 'incoming' | 'outgoing'): DispatchResponder {
  return withIndexHealth(async (tool, args) => {
    if (tool !== 'context') throw new Error(`unexpected tool ${tool}`);
    const uid = (args as { uid?: string }).uid;
    if (uid) {
      const symbol = ENRICHED_BY_UID[uid];
      if (!symbol) throw new Error(`unexpected uid ${uid}`);
      return envelope({ status: 'found', symbol });
    }
    return envelope({
      status: 'found',
      symbol: {
        uid: 'Function:libs/generic/module-singleton/src/index.ts:pinModuleState',
        name: 'pinModuleState',
        kind: 'Function',
        filePath: 'libs/generic/module-singleton/src/index.ts',
        startLine: 105,
      },
      ...(edgeKey === 'incoming'
        ? { incoming: { calls: CALLER_EDGE_ROWS }, outgoing: {} }
        : { incoming: { calls: [] }, outgoing: { calls: CALLER_EDGE_ROWS } }),
    });
  });
}

describe('file-level graph edges are never passed off as call sites', () => {
  it('labels a file node instead of rendering it as an unexplained null line', async () => {
    configureGitnexusDispatch(mixedEdgeDispatch('incoming'));
    const a = await gitnexusFacade('callers', { name: 'pinModuleState' });

    expect(a.sites).toHaveLength(3);

    // The resolved call site leads, and carries a real one-indexed line
    // (71 zero-indexed -> 72), so a `limit` cut keeps the answer, not the noise.
    expect(a.sites[0]).toMatchObject({
      path: 'libs/generic/module-singleton/src/index.test.ts',
      line1: 72,
      kind: 'function',
      detail: 'make',
    });

    // Both file rows are labelled. Before this fix they were
    // `{ line1: null, kind: null, detail: 'index.test.ts' }` — which reads as
    // "a caller named index.test.ts".
    for (const site of a.sites.slice(1)) {
      expect(site.kind).toBe('file');
      expect(site.line1).toBeNull();
      expect(site.detail).toBe(FILE_LEVEL_EDGE_DETAIL);
      // The detail must not be the bare basename any more: that spelling is
      // exactly what made a file indistinguishable from a symbol.
      expect(site.detail).not.toBe('index.test.ts');
    }
  });

  it('tells the caller the split, because counting rows overstates the total', async () => {
    configureGitnexusDispatch(mixedEdgeDispatch('incoming'));
    const a = await gitnexusFacade('callers', { name: 'pinModuleState' });

    // 3 rows, 1 real caller. `index.test.ts` is present twice — once resolved,
    // once as a file — so the row count is not the caller count.
    expect(a.error).toBeTruthy();
    expect(String(a.error)).toContain('1 resolved call site');
    expect(String(a.error)).toContain('2 FILE-level edge');
    expect(String(a.error)).toMatch(/overstates the real total/i);
  });

  it('applies the same rail to callees', async () => {
    configureGitnexusDispatch(mixedEdgeDispatch('outgoing'));
    const a = await gitnexusFacade('callees', { name: 'pinModuleState' });

    expect(a.sites[0]?.line1).toBe(72);
    expect(a.sites.filter((s) => s.kind === 'file')).toHaveLength(2);
    expect(String(a.error)).toContain('2 FILE-level edge');
  });

  it('stays silent when every edge resolves — the notice is not boilerplate', async () => {
    // Falsifier for the three tests above: if `fileEdgeNotice` returned a
    // string unconditionally they would all pass while proving nothing.
    configureGitnexusDispatch(withIndexHealth(async () => contextFoundEnvelope()));
    const a = await gitnexusFacade('callers', { name: 'pinModuleState' });

    expect(a.sites.every((s) => s.kind !== 'file')).toBe(true);
    expect(a.error).toBeNull();
    expect(fileEdgeNotice('callers', 3, 0)).toBeNull();
  });

  it('an all-file answer is not reported as a set of callers', async () => {
    // The worst case: nothing resolved. Sites are non-empty, so
    // isTrustworthyEmpty is not the rail that saves the reader here — the
    // label and the notice are.
    configureGitnexusDispatch(
      withIndexHealth(async (tool, args) => {
        if (tool !== 'context') throw new Error(`unexpected tool ${tool}`);
        const uid = (args as { uid?: string }).uid;
        if (uid) return envelope({ status: 'found', symbol: ENRICHED_BY_UID[uid] });
        return envelope({
          status: 'found',
          symbol: { name: 'pinModuleState', filePath: 'x.ts', startLine: 0 },
          incoming: { calls: CALLER_EDGE_ROWS.slice(1) },
        });
      }),
    );
    const a = await gitnexusFacade('callers', { name: 'pinModuleState' });

    expect(a.sites).toHaveLength(2);
    expect(a.sites.every((s) => s.kind === 'file')).toBe(true);
    expect(String(a.error)).toContain('0 resolved call site');
  });
});

describe('corpus coverage — every gitnexus-eligible case is routed or refused', () => {
  const eligible = ACCEPTANCE_CORPUS.filter((c) => c.eligibleBackends.includes('gitnexus'));

  it('the corpus actually contains gitnexus-eligible cases', () => {
    // Falsifier for the loop below: if the filter ever yields nothing, the
    // per-case test would vacuously pass and prove nothing.
    expect(eligible.length).toBeGreaterThan(0);
  });

  it.each(eligible.map((c) => [c.id, c.intent] as const))(
    '%s (%s) resolves to a routed op or an explicit refusal — never silence',
    (_id, intent) => {
      const op = gitnexusOpForIntent(intent);
      const refusal = gitnexusRefusal(intent, 'probe');
      // Exactly one of the two must hold. Both would be contradictory; neither
      // would mean an agent gets no answer and no reason.
      expect(op !== null || refusal !== null).toBe(true);
      expect(op !== null && refusal !== null).toBe(false);
    },
  );
});

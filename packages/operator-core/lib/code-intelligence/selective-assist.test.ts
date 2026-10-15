/**
 * P-006 behavioural tests for selective graph assistance.
 *
 * These drive the REAL facade (`gitnexusFacade`) through a stub dispatcher that
 * returns envelope shapes measured from gitnexus 1.6.9 (see
 * gitnexus-facade.test.ts), and the real frozen SELECTIVE_ACCEPTANCE_CORPUS for
 * the trigger population. Controls are permanent: legitimate NONUSES must
 * return `assist:'none'` with ZERO dispatches, and every failure shape must
 * keep the existing route and never block.
 */
import { describe, expect, it } from 'vitest';
import type { GitnexusDispatch } from './gitnexus-facade';
import { SELECTIVE_ACCEPTANCE_CORPUS } from './selective-corpus';
import { GRAPH_FAILURE_FALLBACK_GUIDANCE } from './graph-fallback-guidance';
import {
  ASSIST_SITE_LIMIT,
  assessFreshness,
  decideGraphAssist,
  runSelectiveAssist,
  verifySitesAgainstSource,
  type AssistIntent,
} from './selective-assist';

const INDEX_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

function envelope(body: unknown, trailer = ''): unknown {
  return { content: [{ text: JSON.stringify(body) + trailer }] };
}
function listRepos(lastCommit = INDEX_COMMIT): unknown {
  return envelope({
    repositories: [
      { name: 'papercusp', indexedAt: '2026-10-01T00:00:00.000Z', lastCommit, staleness: { commitsBehind: 0 } },
    ],
  });
}
/** `context` envelope; gitnexus startLine is ZERO-indexed (true line = startLine + 1). */
function contextFound(name: string, filePath: string, startLine: number, callers: Array<[string, number]> = []) {
  return envelope({
    status: 'found',
    symbol: { uid: `Function:${filePath}:${name}`, name, kind: 'Function', filePath, startLine, endLine: startLine + 9 },
    epistemic: 'exact',
    incoming: {
      calls: callers.map(([fp, line]) => ({ uid: `Function:${fp}:c`, name: 'c', filePath: fp, startLine: line })),
    },
    outgoing: { accesses: [] },
  });
}
function spyDispatch(respond: (tool: string) => unknown) {
  const calls: string[] = [];
  const dispatch: GitnexusDispatch = async (tool) => {
    calls.push(tool);
    return respond(tool);
  };
  return { dispatch, calls };
}
const FILE = 'packages/operator-core/lib/scheduler/get-next.ts';
const sourceWith = (line1: number, text: string) => (path: string) =>
  path === FILE ? [...Array(line1 - 1).fill('// filler'), text].join('\n') : null;

describe('decideGraphAssist — the two triggers', () => {
  it('fires on a known identifier for every identifier-shaped frozen corpus query', () => {
    const decisions = SELECTIVE_ACCEPTANCE_CORPUS.map((c) => [c.query, decideGraphAssist({ kind: 'navigate', query: c.query })] as const);
    const graph = decisions.filter(([, d]) => d.assist === 'graph');
    // The scheduler + fingerprint cases are camelCase identifiers: both must trigger.
    for (const q of ['getNextForBee', 'listSpecEvidence']) {
      const d = decideGraphAssist({ kind: 'navigate', query: q });
      expect(d.assist, q).toBe('graph');
      expect(d.trigger).toBe('known-symbol-navigation');
      expect(d.plan).toEqual({ op: 'symbol', args: { name: q, limit: ASSIST_SITE_LIMIT } });
    }
    expect(graph.length).toBeGreaterThanOrEqual(2);
    // Every decision, trigger or not, names the route to keep.
    for (const [, d] of decisions) expect(['rg', 'lsp']).toContain(d.fallback);
  });

  it('fires on a substantive change to an exported shared helper, and only then', () => {
    const base = { kind: 'change', symbol: 'managedSpawn', path: 'packages/operator-core/lib/task-manager/managed-spawn.ts', exported: true } as const;
    for (const change of ['signature', 'rename', 'removal', 'behavior'] as const) {
      const d = decideGraphAssist({ ...base, change });
      expect(d.assist, change).toBe('graph');
      expect(d.trigger).toBe('shared-helper-change');
      expect(d.plan?.op).toBe('callers');
      // The assist already knows the defining file; it must hand it to the facade
      // so a same-name definition elsewhere cannot make the lookup ambiguous.
      expect(d.plan?.args).toMatchObject({ name: 'managedSpawn', file_path: base.path });
      expect(d.fallback).toBe('lsp');
    }
    for (const change of ['comment', 'format', 'internal'] as const) {
      expect(decideGraphAssist({ ...base, change }).nonuse, change).toBe('trivial-change');
    }
    expect(decideGraphAssist({ ...base, change: 'signature', exported: false }).nonuse).toBe('not-exported');
    expect(decideGraphAssist({ ...base, change: 'signature', path: 'packages/operator-core/lib/task-manager/managed-spawn.test.ts' }).nonuse).toBe('test-or-generated-path');
    expect(decideGraphAssist({ ...base, change: 'signature', path: 'apps/operator/scripts/hooks/cc/x.mjs' }).nonuse).toBe('not-shared-path');
    expect(decideGraphAssist({ ...base, change: 'signature', path: 'packages/operator-core/lib/x.json' }).nonuse).toBe('non-code-target');
  });
});

describe('decideGraphAssist — legitimate nonuses stay on the existing route (no graph tax)', () => {
  const nonuses: Array<[string, AssistIntent, string]> = [
    ['log message string', { kind: 'navigate', query: 'initial terminal command exited with status' }, 'multi-term'],
    ['quoted error text', { kind: 'navigate', query: '"ECONNREFUSED 127.0.0.1"' }, 'multi-term'],
    ['env var', { kind: 'navigate', query: 'PAPERCUSP_SID' }, 'env-var-shaped'],
    ['process.env access', { kind: 'navigate', query: 'process.env.PORT' }, 'non-identifier'],
    ['config file', { kind: 'navigate', query: 'tsconfig.json' }, 'path-or-glob'],
    ['glob', { kind: 'navigate', query: 'src/**/*.ts' }, 'path-or-glob'],
    ['regex', { kind: 'navigate', query: 'foo.*bar' }, 'regex-pattern'],
    ['bare keyword', { kind: 'navigate', query: 'timeout' }, 'keyword-shaped'],
    ['empty', { kind: 'navigate', query: '   ' }, 'empty-query'],
    ['identifier searched only in logs', { kind: 'navigate', query: 'getNextForBee', scope: ['logs/operator.log'] }, 'non-code-target'],
    ['identifier searched only in docs/config', { kind: 'navigate', query: 'getNextForBee', scope: ['docs', 'config.yml'] }, 'non-code-target'],
  ];
  for (const [label, intent, reason] of nonuses) {
    it(`${label} -> none (${reason}) with zero dispatches`, async () => {
      const spy = spyDispatch(() => {
        throw new Error('graph must not be consulted for a nonuse');
      });
      const decision = decideGraphAssist(intent);
      expect(decision.assist).toBe('none');
      expect(decision.nonuse).toBe(reason);
      expect(decision.plan).toBeNull();
      const result = await runSelectiveAssist(intent, { dispatch: spy.dispatch, readSource: () => null });
      expect(result.outcome).toBe('skipped');
      expect(result.route).toBe(decision.fallback);
      expect(result.blocking).toBe(false);
      expect(spy.calls).toEqual([]);
    });
  }

  it('a code identifier searched in code (or with no scope) is NOT demoted by the scope rule', () => {
    expect(decideGraphAssist({ kind: 'navigate', query: 'getNextForBee', scope: ['packages', 'docs'] }).assist).toBe('graph');
    expect(decideGraphAssist({ kind: 'navigate', query: 'getNextForBee', scope: ['src/a.ts', 'logs'] }).assist).toBe('graph');
  });
});

describe('runSelectiveAssist — revision-aware, bounded, fail-open', () => {
  const intent: AssistIntent = { kind: 'navigate', query: 'getNextWorkItem' };
  const found = () => spyDispatch((tool) => (tool === 'list_repos' ? listRepos() : contextFound('getNextWorkItem', FILE, 2778)));

  it('uses the graph when the index matches the revision and current source corroborates the site', async () => {
    const spy = found();
    const r = await runSelectiveAssist(intent, {
      dispatch: spy.dispatch,
      currentRevision: () => INDEX_COMMIT,
      readSource: sourceWith(2779, 'export async function getNextWorkItem('),
    });
    expect(r.outcome).toBe('graph-used');
    expect(r.route).toBe('graph');
    expect(r.freshness?.state).toBe('fresh');
    expect(r.verifiedSites).toHaveLength(1);
    expect(r.verifiedSites[0]).toMatchObject({ path: FILE, line1: 2779 });
    // Bounded: exactly one symbol lookup (+ the facade's mandatory health probe), never a fan-out.
    expect(spy.calls.filter((t) => t === 'context')).toHaveLength(1);
    expect(spy.calls.length).toBeLessThanOrEqual(2);
    expect(r.note).toContain('verified against current source');
  });

  it('a behind-HEAD index is stale: keeps the existing route and says so', async () => {
    const r = await runSelectiveAssist(intent, {
      dispatch: found().dispatch,
      currentRevision: () => OTHER_COMMIT,
      readSource: sourceWith(2779, 'export async function getNextWorkItem('),
    });
    expect(r.outcome).toBe('graph-stale');
    expect(r.route).toBe('rg');
    expect(r.verifiedSites).toEqual([]);
    expect(r.note).toContain(GRAPH_FAILURE_FALLBACK_GUIDANCE);
  });

  it('a graph site that current source contradicts is uncorroborated, never acted on', async () => {
    const r = await runSelectiveAssist(intent, {
      dispatch: found().dispatch,
      currentRevision: () => INDEX_COMMIT,
      readSource: sourceWith(2779, 'export async function somethingElse('),
    });
    expect(r.outcome).toBe('graph-uncorroborated');
    expect(r.route).toBe('rg');
    expect(r.unverifiedSites).toHaveLength(1);
    expect(r.verifiedSites).toEqual([]);
  });

  it('a deleted/unreadable file is unverified, not a hit', async () => {
    const r = await runSelectiveAssist(intent, {
      dispatch: found().dispatch,
      currentRevision: () => INDEX_COMMIT,
      readSource: () => null,
    });
    expect(r.outcome).toBe('graph-uncorroborated');
  });

  it('not-found is graph-empty and never read as absence', async () => {
    const spy = spyDispatch((tool) => (tool === 'list_repos' ? listRepos() : envelope({ status: 'not_found' })));
    const r = await runSelectiveAssist(intent, { dispatch: spy.dispatch, currentRevision: () => INDEX_COMMIT, readSource: () => null });
    expect(['graph-empty', 'graph-failed']).toContain(r.outcome);
    expect(r.route).toBe('rg');
    expect(r.note).not.toMatch(/no such symbol exists|does not exist/i);
    expect(r.verifiedSites).toEqual([]);
  });

  it('every failure shape resolves to the existing route and NEVER throws or blocks', async () => {
    const shapes: Array<[string, GitnexusDispatch | null]> = [
      ['dispatcher throws', async () => { throw new Error('boom'); }],
      ['dispatcher unconfigured', null],
      ['backend error body', async (t) => (t === 'list_repos' ? listRepos() : envelope({ error: 'database unavailable' }))],
      ['garbage envelope', async () => ({ nonsense: true })],
    ];
    for (const [label, dispatch] of shapes) {
      const r = await runSelectiveAssist(intent, { dispatch, readSource: () => null });
      expect(r.blocking, label).toBe(false);
      expect(r.route, label).toBe('rg');
      expect(r.verifiedSites, label).toEqual([]);
      expect(r.outcome, label).not.toBe('graph-used');
    }
  });

  it('a hung backend is bounded by the timeout and falls back', async () => {
    const started = Date.now();
    const r = await runSelectiveAssist(intent, {
      dispatch: () => new Promise(() => undefined),
      readSource: () => null,
      timeoutMs: 25,
    });
    expect(r.outcome).toBe('graph-failed');
    expect(r.route).toBe('rg');
    expect(r.note).toContain('timed out after 25ms');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('shared-helper change lists consumers via callers and verifies each against current source', async () => {
    const consumer = 'packages/operator-core/lib/scheduler/claim-spec-store.ts';
    const spy = spyDispatch((tool) =>
      tool === 'list_repos' ? listRepos() : contextFound('getNextWorkItem', FILE, 2778, [[consumer, 547], ['packages/gone/deleted.ts', 3]]),
    );
    const r = await runSelectiveAssist(
      { kind: 'change', symbol: 'getNextWorkItem', path: FILE, exported: true, change: 'signature' },
      {
        dispatch: spy.dispatch,
        currentRevision: () => INDEX_COMMIT,
        readSource: (p) => (p === consumer ? 'await getNextWorkItem(args)' : null),
      },
    );
    expect(r.decision.trigger).toBe('shared-helper-change');
    expect(r.outcome).toBe('graph-used');
    expect(r.verifiedSites.map((s) => s.path)).toContain(consumer);
    // The consumer whose file no longer exists is surfaced as unverified, never silently dropped or trusted.
    expect(r.unverifiedSites.map((s) => s.path)).toContain('packages/gone/deleted.ts');
    expect(r.note).toContain('did NOT verify');
  });
});

describe('assessFreshness / verifySitesAgainstSource', () => {
  const answerWith = (freshness: Partial<{ staleVsDisk: boolean | null; indexedCommit: string | null }>) =>
    ({
      backend: 'gitnexus', intent: 'definition', query: 'x', sites: [],
      truncation: { truncated: false, totalAvailable: null, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: null, indexedCommit: null, ...freshness },
      latencyMs: 1, error: null,
    }) as const;

  it('stale beats everything; unknown is never silently fresh', () => {
    expect(assessFreshness(answerWith({ staleVsDisk: true, indexedCommit: INDEX_COMMIT }), INDEX_COMMIT).state).toBe('stale');
    expect(assessFreshness(answerWith({ indexedCommit: INDEX_COMMIT }), OTHER_COMMIT).state).toBe('stale');
    expect(assessFreshness(answerWith({ indexedCommit: INDEX_COMMIT }), INDEX_COMMIT.slice(0, 10)).state).toBe('fresh');
    expect(assessFreshness(answerWith({}), null).state).toBe('unknown');
    expect(assessFreshness(answerWith({ indexedCommit: INDEX_COMMIT }), null).state).toBe('unknown');
  });

  it('a definition site must name the symbol on its ONE-indexed line (off-by-one control)', () => {
    const site = { path: FILE, line1: 3, kind: 'function' } as const;
    const read = () => 'a\nb\nexport function target() {}\nd';
    expect(verifySitesAgainstSource('symbol', 'target', [site], read).verified).toHaveLength(1);
    // line 2 / line 4 do not hold it: an off-by-one site must NOT verify.
    for (const line1 of [2, 4]) {
      expect(verifySitesAgainstSource('symbol', 'target', [{ ...site, line1 }], read).verified).toHaveLength(0);
    }
    // Substring is not a token match.
    expect(verifySitesAgainstSource('symbol', 'target', [site], () => 'a\nb\nexport function targetExtra() {}').verified).toHaveLength(0);
  });
});

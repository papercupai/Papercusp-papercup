/**
 * LIVE integration test for selective graph assistance (plan
 * gitnexus-selective-hardening-and-comparison-2026-09-13, P-006).
 *
 * selective-assist.test.ts pins the decision/bounding/failure behaviour against
 * a stub dispatcher. This file proves the same rails against the REAL GitNexus
 * bridge + the REAL current source tree, driven by the frozen
 * SELECTIVE_ACCEPTANCE_CORPUS — so a backend or index change that a stub cannot
 * notice (line-base shift, empty-for-an-omitted-symbol, stale index) is caught.
 *
 * What it asserts, deliberately NOT a fixed set of graph answers (the index
 * trails the working tree on a shared, constantly-edited checkout, so a
 * "graph must say X" assertion would be flaky by construction):
 *   - every outcome keeps the invariants: never blocking, `route:'graph'` only
 *     when the graph was actually used, and every site called "verified" really
 *     holds up when THIS test re-reads the current file independently;
 *   - an index-omitted symbol (claimNextIssueWorkItem: work-items.ts exceeds the
 *     index size cap) is never read as absence, while the source proves it
 *     exists — the exact false-negative the plan exists to prevent;
 *   - legitimate text/log/runtime/path queries trigger ZERO live dispatches;
 *   - a backend crash falls back to the existing route.
 *
 * SKIPS MUST BE LOUD (see gitnexus-facade.integration.test.ts): if the pinned
 * gitnexus is not installed this prints why instead of silently passing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { GitnexusDispatch } from './gitnexus-facade.ts';
import { SELECTIVE_ACCEPTANCE_CORPUS } from './selective-corpus.ts';
import { GRAPH_FAILURE_FALLBACK_GUIDANCE } from './graph-fallback-guidance.ts';
import {
  ASSIST_SITE_LIMIT,
  ASSIST_TIMEOUT_MS,
  decideGraphAssist,
  runSelectiveAssist,
  type AssistDeps,
  type AssistResult,
} from './selective-assist.ts';

const require = createRequire(import.meta.url);

const ROOT = process.cwd().split('/packages/')[0];
const BRIDGE_PATH = join(ROOT, 'libs/papercusp/plugins/gitnexus-bridge/index.cjs');
const PINNED_BIN = join(homedir(), '.papercusp/vendor/gitnexus/node_modules/.bin/gitnexus');
const AVAILABLE = existsSync(BRIDGE_PATH) && existsSync(PINNED_BIN);

if (!AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    `[selective-assist.integration] SKIPPING — bridge=${existsSync(BRIDGE_PATH)} ` +
      `pinnedBin=${existsSync(PINNED_BIN)}. Install with: ` +
      `npm install --prefix ~/.papercusp/vendor/gitnexus gitnexus@1.6.9`,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bridge: any = null;
let liveCalls: string[] = [];

const readSource = (path: string): string | null => {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return null;
  }
};

function headRevision(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function liveDeps(extra: Partial<AssistDeps> = {}): AssistDeps {
  const dispatch: GitnexusDispatch = async (tool, args) => {
    liveCalls.push(tool);
    const { handlers } = await bridge.getDynamicTools();
    return handlers[tool](args, { workspaceId: 'papercusp-workspace' });
  };
  return { dispatch, readSource, currentRevision: headRevision, ...extra };
}

/** The test's OWN, independent re-check of a verified site against current source. */
function siteHoldsUp(r: AssistResult, symbol: string): void {
  for (const site of r.verifiedSites) {
    const body = readSource(site.path);
    expect(body, `${site.path} must be readable`).not.toBeNull();
    if (r.decision.plan?.op === 'symbol') {
      expect(site.line1, `${site.path} site needs a line`).not.toBeNull();
      expect(body!.split('\n')[site.line1! - 1]).toContain(symbol);
    } else {
      expect(body).toContain(symbol);
    }
  }
}

function invariants(r: AssistResult): void {
  expect(r.blocking).toBe(false);
  expect(r.elapsedMs).toBeLessThan(ASSIST_TIMEOUT_MS + 5_000);
  expect(r.verifiedSites.length).toBeLessThanOrEqual(ASSIST_SITE_LIMIT);
  if (r.outcome === 'graph-used') {
    expect(r.route).toBe('graph');
    expect(r.verifiedSites.length).toBeGreaterThan(0);
  } else {
    expect(['rg', 'lsp']).toContain(r.route);
    expect(r.verifiedSites).toEqual([]);
    expect(r.note).toMatch(/Continue with (rg|lsp)/);
  }
  // The graph is never allowed to assert absence: every non-skipped, non-used
  // outcome must carry the shared "graph unavailable, NOT no-such-symbol"
  // fallback guidance (or the empty-answer \"NOT evidence\" note).
  if (r.outcome !== 'skipped' && r.outcome !== 'graph-used') {
    expect(
      r.note.includes(GRAPH_FAILURE_FALLBACK_GUIDANCE) || r.note.includes('NOT evidence'),
      r.note,
    ).toBe(true);
  }
}

describe.skipIf(!AVAILABLE)('selective graph assist — live backend, real source', () => {
  beforeAll(async () => {
    bridge = require(BRIDGE_PATH);
    await bridge.getDynamicTools();
  }, 60_000);

  afterAll(() => {
    // MANDATORY — leaves no orphaned gitnexus child (see the facade suite).
    bridge?._resetChildrenForTests?.();
  });

  it(
    'known-symbol navigation over the frozen corpus keeps every rail and re-verifies against current source',
    async () => {
      const assisted = SELECTIVE_ACCEPTANCE_CORPUS.filter(
        (c) => decideGraphAssist({ kind: 'navigate', query: c.query }).assist === 'graph',
      );
      // Four of the five corpus queries are exact identifiers; the fifth is a URL path.
      expect(assisted.map((c) => c.query)).toEqual([
        'getNextForBee',
        'listSpecEvidence',
        'measureRepoFilesEvidenceAtRoot',
        'claimNextIssueWorkItem',
      ]);

      const withSites: string[] = [];
      for (const c of assisted) {
        liveCalls = [];
        const r = await runSelectiveAssist({ kind: 'navigate', query: c.query }, liveDeps());
        invariants(r);
        siteHoldsUp(r, c.query);
        // ONE facade call -> a small, bounded number of backend round trips.
        expect(liveCalls.length).toBeGreaterThan(0);
        expect(liveCalls.length).toBeLessThanOrEqual(4);
        if ((r.answer?.sites.length ?? 0) > 0) withSites.push(c.query);
        // eslint-disable-next-line no-console
        console.info(
          `[selective-assist.integration] ${c.id} query=${c.query} outcome=${r.outcome} ` +
            `route=${r.route} sites=${r.answer?.sites.length ?? 0} verified=${r.verifiedSites.length} calls=${liveCalls.length}`,
        );
      }

      // Positive control: the live backend answers a known symbol with sites at all.
      // Without this, a dead backend would make every rail above pass vacuously.
      expect(withSites.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    'an index-omitted symbol is never read as absence — and the source proves it exists',
    async () => {
      const omitted = SELECTIVE_ACCEPTANCE_CORPUS.find((c) => c.query === 'claimNextIssueWorkItem');
      expect(omitted).toBeDefined();
      const src = readSource('packages/operator-core/lib/work-items.ts');
      expect(src, 'work-items.ts must be readable').not.toBeNull();
      expect(src).toContain('export async function claimNextIssueWorkItem');

      const r = await runSelectiveAssist({ kind: 'navigate', query: 'claimNextIssueWorkItem' }, liveDeps());
      invariants(r);
      // Whatever the graph said, a verified site must be real, and an empty answer
      // must have pointed at the fallback with the "not evidence of absence" note.
      if (r.outcome === 'graph-empty') {
        expect(r.note).toContain('NOT evidence');
        expect(r.route === 'rg' || r.route === 'lsp').toBe(true);
      }
    },
    60_000,
  );

  it(
    'a stale revision downgrades the graph answer to the existing route, even for a known symbol',
    async () => {
      const r = await runSelectiveAssist(
        { kind: 'navigate', query: 'getNextForBee' },
        liveDeps({ currentRevision: () => '0123456789abcdef0123456789abcdef01234567' }),
      );
      invariants(r);
      // The index can only ever be the wrong revision here, so a graph-used result
      // would mean freshness is not actually being checked.
      expect(r.outcome).not.toBe('graph-used');
    },
    60_000,
  );

  it(
    'a substantive change to an exported shared helper asks for callers and re-verifies them against current source',
    async () => {
      liveCalls = [];
      const r = await runSelectiveAssist(
        {
          kind: 'change',
          symbol: 'pinModuleState',
          path: 'libs/generic/module-singleton/src/index.ts',
          exported: true,
          change: 'signature',
        },
        liveDeps(),
      );
      expect(r.decision.assist).toBe('graph');
      expect(r.decision.trigger).toBe('shared-helper-change');
      invariants(r);
      siteHoldsUp(r, 'pinModuleState');
      // ONE facade call. Callers resolves each returned edge with one `context`
      // round trip (gitnexus-facade.ts), so the worst case is list_repos + the
      // lookup + one resolve per site — bounded by the site cap, never open-ended.
      expect(liveCalls.length).toBeLessThanOrEqual(2 + ASSIST_SITE_LIMIT);
      // pinModuleState is consumed across the repo (CLAUDE.md prescribes it), so
      // a usable callers answer must list several verified consumer files.
      if (r.outcome === 'graph-used') {
        expect(new Set(r.verifiedSites.map((s) => s.path)).size).toBeGreaterThan(1);
      }
    },
    60_000,
  );

  it(
    'a same-name shared helper is disambiguated by the defining file, never by guessing a definition',
    async () => {
      // getNextWorkItem has more than one definition in the live index (a test
      // fixture mirror), so by name alone the facade refuses to pick one. The change
      // intent carries the defining file, which the assist now forwards as
      // `file_path` (WI-10005154) — so the lookup may resolve to the production
      // symbol. If the index is stale/unavailable the assist must still fall back
      // to lsp — never confidently answer for the wrong definition.
      const r = await runSelectiveAssist(
        {
          kind: 'change',
          symbol: 'getNextWorkItem',
          path: 'packages/operator-core/lib/scheduler/get-next.ts',
          exported: true,
          change: 'signature',
        },
        liveDeps(),
      );
      expect(r.decision.trigger).toBe('shared-helper-change');
      invariants(r);
      siteHoldsUp(r, 'getNextWorkItem');
      if (r.outcome !== 'graph-used') expect(r.route).toBe('lsp');
    },
    60_000,
  );

  it(
    'legitimate text / log / env / path / regex / multi-term queries trigger ZERO live graph dispatches',
    async () => {
      liveCalls = [];
      const nonuses = [
        'ECONNREFUSED',
        'GITNEXUS_MAX_FILE_SIZE',
        'ENOENT: no such file or directory',
        '/api/cupboard/publish-blueprint',
        'packages/operator-core/lib/**/*.ts',
        'getNextForBee|listSpecEvidence',
        'getNextForBee listSpecEvidence',
        '',
      ];
      for (const query of nonuses) {
        const r = await runSelectiveAssist({ kind: 'navigate', query }, liveDeps());
        expect(r.outcome, `query ${JSON.stringify(query)}`).toBe('skipped');
        expect(r.blocking).toBe(false);
        expect(['rg', 'lsp']).toContain(r.route);
      }
      // A trivial edit to a shared helper is also a non-use.
      const trivial = await runSelectiveAssist(
        {
          kind: 'change',
          symbol: 'getNextWorkItem',
          path: 'packages/operator-core/lib/scheduler/get-next.ts',
          exported: true,
          change: 'comment',
        },
        liveDeps(),
      );
      expect(trivial.outcome).toBe('skipped');
      expect(liveCalls).toEqual([]);
    },
    30_000,
  );

  it(
    'a backend crash resolves to the existing route, never a block or a throw',
    async () => {
      const crashing: GitnexusDispatch = async () => {
        throw new Error('simulated gitnexus bridge crash');
      };
      const r = await runSelectiveAssist(
        { kind: 'navigate', query: 'getNextForBee' },
        liveDeps({ dispatch: crashing }),
      );
      expect(r.blocking).toBe(false);
      expect(r.outcome).not.toBe('graph-used');
      expect(['rg', 'lsp']).toContain(r.route);
      expect(r.verifiedSites).toEqual([]);
    },
    30_000,
  );
});

/**
 * Boundaries for the code-search family — `code-search.definition-lookup`,
 * retargeted to `lsp:query` by P-002 of gitnexus-deterministic-integration-2026-10-05
 * (D-010).
 *
 * Every exclusion below removes real corpus atoms, and each one is here because
 * claiming it would point an agent at a call that answers about the WRONG TREE,
 * refuses, or cannot express the request in one call. The fix for a near-miss is
 * to narrow the PATTERN until the residue falls outside it (D-008), never to
 * loosen `cover()` — these pin that narrowing so it cannot quietly relax back.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { auditPair, matchingAtoms } from '../equivalence';
import { renderRoutingBlock } from '../routing-table';
import { assertPolicyTier } from '../types';
import type { CorpusFixture } from '../corpus';
import { resolveDirectoryAnchor } from '../../code-intelligence/lsp-adapter';
import {
  anchorForRoot,
  CALLERS_GRAPH_MEASUREMENT,
  CALLERS_GRAPH_OUTCOMES,
  callerIdentOf,
  CODE_SEARCH_PAIRS,
  coverCallersLookupAgainst,
  GITNEXUS_INDEX_FINDING,
  graphCallersLookup,
  lspDefinitionLookup,
  NESTED_PROJECT_CONTAINERS,
  parseGrepAtom,
  projectForAnchor,
  TS_PROJECT_ROOTS,
} from './code-search';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');

const claims = (atom: string) => matchingAtoms(lspDefinitionLookup, [{ sid: 's', ts: 't', atom }]).length === 1;
const cover = (atom: string) => lspDefinitionLookup.cover(atom);

describe('code-search.definition-lookup — what it claims (D-010a)', () => {
  it('claims a location-only definition lookup with one root inside one project', () => {
    expect(claims('grep -rn "export function findLiveHost" packages/operator-core/lib/')).toBe(true);
    expect(claims('grep -rln "class PgLinkStore" packages/coordination/src/ 2>/dev/null')).toBe(true);
    expect(claims('grep -rn "export interface PlanItem" libs/generic/plan-parser/src/*.ts')).toBe(true);
    expect(claims('grep -rn "export function createLogger" --include=*.ts libs/papercusp/packages/orchestrator/src/')).toBe(true);
  });

  it('maps a covered command onto lsp:query workspace_symbols, anchored on the grep root', () => {
    expect(cover('grep -rn "export function findLiveHost" packages/operator-core/lib/').expression).toBe(
      'lsp:query { op: "workspace_symbols", name: "findLiveHost", file: "packages/operator-core/lib" }',
    );
    // A glob segment is cut back to its directory; a file root stays a file anchor.
    expect(cover('grep -rn "export interface PlanItem" libs/generic/plan-parser/src/*.ts').expression).toContain(
      'file: "libs/generic/plan-parser/src"',
    );
    expect(cover('grep -rn "export function pinModuleState" libs/generic/module-singleton/src/index.ts').expression)
      .toContain('file: "libs/generic/module-singleton/src/index.ts"');
  });

  /**
   * `-E` cannot change the match for a pattern DEFINITION_RE already accepted:
   * the text is identifier characters, spaces and at most a leading `^`, and
   * anchors read the same in basic and extended syntax. `-F` would make `^`
   * literal, so it stays out.
   */
  it('covers -E, but not flags that change or reshape the answer', () => {
    expect(claims("grep -rnE 'export function sanitizeCheckpointLogText' apps/operator/lib/release/")).toBe(true);
    expect(cover("grep -rnE 'export function sanitizeCheckpointLogText' apps/operator/lib/release/").covered).toBe(true);
    expect(claims('grep -rnF "^export function x" packages/operator-core/lib')).toBe(false);
    expect(claims('grep -rnc "export function x" packages/operator-core/lib')).toBe(false);
    expect(claims('grep -rni "export function x" packages/operator-core/lib')).toBe(false);
    expect(claims('grep -rn --color=always "export function x" packages/operator-core/lib')).toBe(false);
  });

  it('accepts only TypeScript --include globs', () => {
    expect(claims('grep -rn "interface Foo" packages/operator-core/lib --include="*.tsx"')).toBe(true);
    expect(claims('grep -rn "interface Foo" packages/operator-core/lib --include=*.{ts,tsx}')).toBe(true);
    expect(claims('grep -rn "interface Foo" packages/operator-core/lib --include=*.sql')).toBe(false);
    expect(claims('grep -rn "interface HudGoalInput" apps/operator/app --include=*.ts*')).toBe(false);
    const sql = cover('grep -rn "interface Foo" packages/operator-core/lib/ --include=*.sql');
    expect(sql.covered).toBe(false);
    expect(sql.reason).toMatch(/does not index/);
  });

  it('routes, advises and names every key cover() emits', () => {
    expect(lspDefinitionLookup.toolName).toBe('lsp:query');
    for (const key of ['op', 'name', 'file', 'workspace_symbols']) {
      expect(lspDefinitionLookup.routing.use).toContain(key);
    }
    // D-010(b): the body route is named as the two-step, not hidden.
    expect(lspDefinitionLookup.advisoryText).toMatch(/capability:read/);
    expect(lspDefinitionLookup.routing.use).toMatch(/capability:read/);
  });

  it('teaches safe exclusions before falling back to exhaustive grep', () => {
    const guidance = lspDefinitionLookup.routing.insteadOf;
    expect(guidance).toContain('--exclude-dir={node_modules,.vitest-tmp,dist,coverage}');
    expect(guidance).toContain('--exclude-dir=sidecar');
    expect(guidance).toMatch(/generated bundles\/caches are not source evidence/i);
    expect(guidance).toMatch(/exhaustive exact-text search remains grep\/rg's job/i);
  });

  it('uses ripgrep output caps per file and per matching line', () => {
    const guidance = lspDefinitionLookup.routing.insteadOf;
    expect(guidance).toContain('rg -n --max-count 60');
    expect(guidance).toContain('--max-columns 256 --max-columns-preview');
    expect(guidance).toMatch(/caps matching lines per file and long lines/i);
  });
});

describe('code-search.definition-lookup — what it never claims', () => {
  /** D-010(b): workspace_symbols returns locations; a context grep reads the body. */
  it.each([
    ['-A N', 'grep -rn "class PgTaggableStore" -A 40 packages/coordination/src/'],
    ['-B N', 'grep -rn "class PgTaggableStore" -B 5 packages/coordination/src/'],
    ['attached cluster', 'grep -rnA5 "class PgTaggableStore" packages/coordination/src/'],
    ['-C', 'grep -rn -C3 "class PgTaggableStore" packages/coordination/src/'],
    ['--context', 'grep -rn --context=3 "class PgTaggableStore" packages/coordination/src/'],
  ])('a body read (%s)', (_label, atom) => {
    expect(claims(atom)).toBe(false);
    const result = cover(atom);
    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(/BODY|has no argument/);
  });

  it('names the two-step route when cover() sees a body read', () => {
    expect(cover('grep -rn "class PgTaggableStore" -A 40 packages/coordination/src/').reason).toMatch(
      /capability:read/,
    );
  });

  /** A symbol search covers ONE project, so two roots have no single faithful call. */
  it('more than one search root', () => {
    expect(claims('grep -rn "export function getHarnessAdminUrl" apps/operator/lib/*.ts libs/papercusp/libs/db/src/*.ts 2>/dev/null')).toBe(false);
    expect(claims('grep -rln "class PgPresenceStore" packages/coordination libs/generic/pubsub-substrate 2>/dev/null')).toBe(false);
    expect(cover('grep -rln "class PgPresenceStore" packages/coordination libs/generic/pubsub-substrate').reason).toMatch(/2 roots/);
  });

  /**
   * This box carries a second checkout (oddsmith) whose packages sit at the
   * same first path segment, so a bare `packages/` operand does not say which
   * repo it means.
   */
  it('a bare first-segment root, even beside a properly anchored one', () => {
    expect(claims('grep -rn "interface ResolvedItem" libs/generic/ packages/ --include=*.ts')).toBe(false);
    expect(claims('grep -rn "interface Foo" . --include=*.ts')).toBe(false);
    expect(claims('grep -rn "interface Foo" packages --include=*.ts')).toBe(false);
  });

  it('another checkout on this box', () => {
    expect(claims('grep -rn "class Oms" packages/oms/src/*.ts')).toBe(false);
    expect(claims('grep -rln "class PgPresenceStore" /home/dev/papercupai-workspace/papercup --include="*.ts"')).toBe(false);
    expect(cover('grep -rn "class Oms" packages/oms/src/').reason).toMatch(/not inside a known TypeScript project/);
  });

  /** `resolveDirectoryAnchor` refuses a directory spanning nested projects. */
  it('a root that contains a nested tsconfig project', () => {
    expect(claims('grep -rn "export function harnessRoot" libs/papercusp/packages/harness --include=*.ts')).toBe(false);
    expect(claims('grep -rn "export function promptHarnessRoot" libs/papercusp/packages/harness/')).toBe(false);
    expect(cover('grep -rn "export function harnessRoot" libs/papercusp/packages/harness').reason).toMatch(/nested tsconfig/);
    // A directory above every project (libs/generic holds ~70) is not inside one at all.
    expect(claims('grep -rln "export function createCrossTabControlStream" libs/generic/')).toBe(false);
    // Below the nested project is fine again.
    expect(claims('grep -rn "export function x" libs/papercusp/packages/harness/src')).toBe(true);
  });

  it('a non-TypeScript file root', () => {
    expect(claims('grep -rn "function defaultListProcPids" apps/operator/scripts/psu-launcher.mjs')).toBe(false);
    expect(cover('grep -rn "function defaultListProcPids" apps/operator/scripts/psu-launcher.mjs').reason).toMatch(/\.mjs file/);
  });

  it('a search with no path at all (the cwd died with the `cd`)', () => {
    expect(claims('grep -rn "export async function getHiveSetting" --include=*.ts')).toBe(false);
  });

  it('vendored code, shell expansions and stdout redirects', () => {
    expect(claims('grep -rn "function isBogon" node_modules/hyperdht/lib/*.js')).toBe(false);
    expect(claims('grep -rn "export function listenHubEnabled" $f')).toBe(false);
    expect(claims('grep -rln "interface PresenceRecord" $(grep -rln "x" packages/operator-core/lib/)')).toBe(false);
    expect(claims('grep -rn "export function findLiveHost" packages/operator-core/lib/ > /tmp/out.txt')).toBe(false);
  });

  /** Sampling limit, not a tool limit: the certification corpus holds none of these shapes. */
  it('declaration kinds outside the certification sample', () => {
    expect(claims('grep -rn "export const FEATURE_TERMINAL_STATES" packages/operator-core/lib/')).toBe(false);
    expect(claims('grep -rn "export type SessionState" --include=*.ts packages/operator-core/lib')).toBe(false);
  });
});

describe('code-search.definition-lookup — the project model stays true to the tree', () => {
  /**
   * The PIN on TS_PROJECT_ROOTS. One-directional on purpose: an entry that no
   * longer holds a tsconfig.json would make cover() claim a root the tool
   * refuses, so that fails here, naming the entry. A NEW project missing from
   * the list only means a grep this pair does not claim — conservative — so
   * adding a package elsewhere never reds this test.
   */
  it('every listed project root still holds a tsconfig.json', () => {
    const stale = TS_PROJECT_ROOTS.filter((p) => !existsSync(join(REPO_ROOT, p, 'tsconfig.json')));
    expect(stale, `remove these from TS_PROJECT_ROOTS in pairs/code-search.ts: ${stale.join(', ')}`).toEqual([]);
  });

  it('derives the nested-project containers from the list itself', () => {
    expect(NESTED_PROJECT_CONTAINERS).toEqual(['libs/papercusp/packages/harness']);
  });

  it('picks the innermost project and cuts globs to directories', () => {
    expect(projectForAnchor('libs/papercusp/packages/harness/docs-viewer/src')).toBe('libs/papercusp/packages/harness/docs-viewer');
    expect(projectForAnchor('apps/operator-docs/src')).toBe('apps/operator-docs');
    expect(projectForAnchor('apps/oddsmith')).toBeNull();
    expect(anchorForRoot('packages/operator-core/lib/**/*.ts')).toBe('packages/operator-core/lib');
    expect(anchorForRoot('packages/operator-core/lib/')).toBe('packages/operator-core/lib');
  });

  /**
   * The envelope-faithful / data-empty lesson (WI-6445): cover() proving a call
   * is WELL-FORMED says nothing about whether the tool ANSWERS it. So the
   * certified sample's roots are run through the tool's OWN anchor resolution.
   * A root that has since been deleted is skipped (grep would fail on it too);
   * the floor keeps this from passing vacuously.
   */
  it("the certified sample's roots resolve through lsp:query's own anchor logic", () => {
    const fixture = JSON.parse(
      readFileSync(join(HERE, '../fixtures/code-search.definition-lookup.sample.json'), 'utf8'),
    ) as CorpusFixture;
    let resolved = 0;
    const refused: string[] = [];
    for (const { atom } of fixture.sample) {
      expect(cover(atom).covered, atom).toBe(true);
      const anchor = anchorForRoot(parseGrepAtom(atom).paths[0]);
      const abs = join(REPO_ROOT, anchor);
      if (!existsSync(abs)) continue;
      if (statSync(abs).isFile()) {
        resolved += 1;
        continue;
      }
      const result = resolveDirectoryAnchor(abs, REPO_ROOT);
      if (result.error) refused.push(`${anchor}: ${result.error}`);
      else resolved += 1;
    }
    expect(refused).toEqual([]);
    expect(resolved).toBeGreaterThanOrEqual(Math.ceil(fixture.sample.length / 2));
  });
});

describe('code-search.definition-lookup — promotion state', () => {
  it('is certified equivalent and stays at observe until the registry promotes it', () => {
    expect(lspDefinitionLookup.expectedVerdict).toBe('equivalent');
    expect(lspDefinitionLookup.holdAtObserve).toBeUndefined();
    expect(assertPolicyTier(lspDefinitionLookup)).toBe('observe');
  });

  it('keeps the gitnexus index finding the reindex routine cites', () => {
    expect(GITNEXUS_INDEX_FINDING.refreshOwner).toContain('system:gitnexus-reindex');
    expect(GITNEXUS_INDEX_FINDING.note).toMatch(/scheduled analyze completions|graph canaries/i);
  });
});

// ── P-002(d) / D-010(d): code-search.callers-lookup ──────────────────────────

const claimsCallers = (atom: string) => matchingAtoms(graphCallersLookup, [{ sid: 's', ts: 't', atom }]).length === 1;
const coverCallers = (atom: string) => graphCallersLookup.cover(atom);

describe('code-search.callers-lookup — what it claims', () => {
  it('claims a recursive grep whose quoted pattern is IDENT(', () => {
    expect(claimsCallers('grep -rn "requirePrincipal(" --include=*.ts packages/operator-core/lib')).toBe(true);
    expect(claimsCallers("grep -rln 'readCell(' packages/operator-core/lib apps/operator/lib")).toBe(true);
    expect(claimsCallers('grep -n "registerDesktopSession(" -r packages/operator-core/lib apps/operator --include=*.ts')).toBe(true);
    expect(claimsCallers('grep -rnE "runGoldSet\\(" packages/operator-core/lib')).toBe(true);
  });

  it('does not claim definition lookups, non-recursive greps, expansions, redirects or vendored code', () => {
    expect(claimsCallers('grep -rn "export function requirePrincipal" packages/operator-core/lib')).toBe(false);
    expect(claimsCallers('grep -n "requirePrincipal(" packages/operator-core/lib/auth.ts')).toBe(false);
    expect(claimsCallers('grep -rn "$fn(" packages/operator-core/lib')).toBe(false);
    expect(claimsCallers('grep -rn "requirePrincipal(" packages/operator-core/lib > /tmp/x')).toBe(false);
    expect(claimsCallers('grep -rn "isBogon(" node_modules/hyperdht/lib')).toBe(false);
  });

  // WI-10006543: every line `"EventKey("` printed was another name (getEventKey( ...).
  it('does not claim a capitalised partial name, but claims it word-bounded', () => {
    expect(claimsCallers('grep -rn "EventKey(" --include=*.ts packages/operator-core/lib/cupboard')).toBe(false);
    expect(claimsCallers("grep -rn 'EventKey\\(' packages/operator-core/lib")).toBe(false);
    expect(claimsCallers('grep -rn "\\bEventKey(" packages/operator-core/lib')).toBe(true);
  });
});

describe('code-search.callers-lookup — cover() names every reason the graph cannot answer', () => {
  it('maps a resolved identifier onto graph:query callers over the grep roots', () => {
    expect(coverCallers('grep -rn "requirePrincipal(" --include=*.ts packages/operator-core/lib apps/operator/lib/')).toEqual({
      covered: true,
      expression: 'graph:query { op: "callers", name: "requirePrincipal", paths: ["packages/operator-core/lib","apps/operator/lib"] }',
    });
    // A directory that contains projects is still inside this repo.
    expect(coverCallers('grep -rln "splitMarkdown(" libs/generic').expression).toContain('paths: ["libs/generic"]');
  });

  it('covers a verified empty answer: no code file under the root has the call', () => {
    expect(coverCallers('grep -rn "failOnConsole(" packages/operator-core').covered).toBe(true);
  });

  it('refuses a capitalised partial name and an unmeasured identifier', () => {
    expect(coverCallers('grep -rn "EventKey(" packages/operator-core/lib').reason).toMatch(/partial-name search/);
    expect(coverCallers('grep -rn "neverMeasuredIdentifier(" packages/operator-core/lib').reason).toMatch(
      /no graph answerability measurement/,
    );
  });

  // Against an explicit measurement, so each refusal stays tested when no sampled name has it.
  it.each([
    ['error', /answered with an error/],
    ['missed', /omitted a line grep finds that is a call/],
  ] as const)('a measured %s identifier is not covered', (outcome, reason) => {
    const result = coverCallersLookupAgainst('grep -rn "someName(" packages/operator-core/lib', { someName: outcome }, {});
    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  it('covers a root-missing identifier only on the recorded missing roots', () => {
    const outcomes = { handler: 'root-missing' } as const;
    const missing = { handler: ['packages/agent-mcp/src/define-tool.ts'] };
    expect(coverCallersLookupAgainst('grep -rn "handler(" packages/agent-mcp/src/define-tool.ts', outcomes, missing)).toEqual({
      covered: true,
      expression: 'graph:query { op: "callers", name: "handler", paths: ["packages/agent-mcp/src/define-tool.ts"] }',
    });
    expect(coverCallersLookupAgainst('grep -rn "handler(" packages/operator-core/lib', outcomes, missing).reason).toMatch(
      /measured only on a search root that does not exist/,
    );
  });

  it.each([
    ['a bare first-segment root', 'grep -rn "requirePrincipal(" --include=*.ts packages apps libs', /not anchored inside this repo/],
    ['no search path', 'grep -rn "requirePrincipal(" --include=*.ts', /no search path/],
    ['a body read', 'grep -rn -A6 "requirePrincipal(" packages/operator-core/lib', /BODY/],
    ['a non-code --include', 'grep -rn "requirePrincipal(" --include=*.md packages/operator-core/lib', /does not index as code/],
    ['an unexpressible flag', 'grep -rnc "requirePrincipal(" packages/operator-core/lib', /`-c`/],
    ['an escaped paren in basic syntax', 'grep -rn "requirePrincipal\\(" packages/operator-core/lib', /unmatched paren in basic/],
    ['a bare paren in extended syntax', 'grep -rnE "requirePrincipal(" packages/operator-core/lib', /unmatched paren in extended/],
    ['an escaped paren under -F', 'grep -rnF "requirePrincipal\\(" packages/operator-core/lib', /backslash is literal/],
  ])('%s is not covered', (_label, atom, reason) => {
    const result = coverCallers(atom);
    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(reason);
  });

  it('accepts the escaped paren under -E and the bare paren under -F', () => {
    expect(coverCallers('grep -rnE "requirePrincipal\\(" packages/operator-core/lib').covered).toBe(true);
    expect(coverCallers('grep -rnF "requirePrincipal(" packages/operator-core/lib').covered).toBe(true);
  });

  it('parses the identifier out of word-bounded and escaped patterns', () => {
    expect(callerIdentOf('grep -rn "\\bsendMessage(" packages/operator-core/lib')).toBe('sendMessage');
    expect(callerIdentOf("grep -rnE 'runGoldSet\\(' packages")).toBe('runGoldSet');
    expect(callerIdentOf('grep -rn "export function x" packages')).toBeNull();
  });
});

describe('code-search.callers-lookup — measurement and promotion state', () => {
  const fixture = JSON.parse(
    readFileSync(join(HERE, '../fixtures/code-search.callers-lookup.sample.json'), 'utf8'),
  ) as CorpusFixture;

  it('measured every identifier in the frozen sample, and the tally matches the table', () => {
    const idents = fixture.sample.map(({ atom }) => callerIdentOf(atom));
    expect(idents.filter((i) => i === null)).toEqual([]);
    expect(idents.filter((i) => CALLERS_GRAPH_OUTCOMES[i!] === undefined)).toEqual([]);
    expect(Object.keys(CALLERS_GRAPH_OUTCOMES).sort()).toEqual([...new Set(idents as string[])].sort());
    const tally: Record<string, number> = {};
    for (const outcome of Object.values(CALLERS_GRAPH_OUTCOMES)) tally[outcome] = (tally[outcome] ?? 0) + 1;
    expect(tally).toEqual(CALLERS_GRAPH_MEASUREMENT.tally);
  });

  it('derives equivalent on the re-scoped sample, and records that verdict', () => {
    const audit = auditPair(graphCallersLookup, fixture.sample, fixture);
    expect(audit.failingCases).toEqual([]);
    expect(audit.verdict).toBe('equivalent');
    expect(graphCallersLookup.expectedVerdict).toBe('equivalent');
  });

  it('stays at observe and out of the routing table until `paths` is live on :3070', () => {
    expect(graphCallersLookup.toolName).toBe('graph:query');
    // The hold and the withheld routing name the deploy that blocks them and the work-item that owns lifting them (D-018).
    for (const reason of [graphCallersLookup.holdAtObserve, graphCallersLookup.routingWithheld]) {
      expect(reason).toMatch(/:3070/);
      expect(reason).toMatch(/WI-10006543/);
    }
    expect(assertPolicyTier(graphCallersLookup)).toBe('observe');
    expect(renderRoutingBlock(CODE_SEARCH_PAIRS)).not.toContain('who CALLS a symbol');
    expect(graphCallersLookup.advisoryText).toMatch(/answer with an error/);
  });

  it('the re-measure is against the first-party backend, with its evidence file in the tree', () => {
    expect(CALLERS_GRAPH_MEASUREMENT.backend).toMatch(/typescript-service/);
    const evidence = JSON.parse(readFileSync(join(HERE, '../../../../..', CALLERS_GRAPH_MEASUREMENT.evidence), 'utf8')) as {
      tally: Record<string, number>;
      rows: { name: string }[];
    };
    expect(evidence.tally).toEqual(CALLERS_GRAPH_MEASUREMENT.tally);
    expect(evidence.rows.map((r) => r.name).sort()).toEqual(Object.keys(CALLERS_GRAPH_OUTCOMES).sort());
  });
});

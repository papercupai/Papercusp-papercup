/**
 * Equivalence pairs — the CODE-SEARCH family (WI-6445; retargeted by P-002 of
 * gitnexus-deterministic-integration-2026-10-05, D-010).
 *
 * Population: the same 7d corpus every sibling pair cites held 6,115 RECURSIVE
 * grep atoms across 82 sessions. That whole population is emphatically NOT
 * claimed here — `grep -r` returns an EXHAUSTIVE, EXACT, DETERMINISTIC set of
 * text matches, and no code-intelligence tool is a substitute for that. This
 * file claims exactly ONE shape, the one where the questions genuinely coincide:
 * LOCATION-ONLY DEFINITION LOOKUP — "where is symbol X declared", asked of one
 * directory or file inside ONE TypeScript project.
 *
 * ── Why the tool is `lsp:query`, not `gitnexus.context` (D-010) ──────────────
 * Code-intelligence D-001 [owner 2026-08-21] routes definition/references
 * to the `lsp` facade and only call chains, impact and topology to GitNexus.
 * This pair used to route to `gitnexus.context`, which contradicted that ruling
 * and the hand-written storage-policy row beside it. Measured before the
 * retarget (WI-10006282): 138 advisory fires in 7 days across 42 sessions, and
 * ONE complied. `lsp:query { op: "workspace_symbols", name, file }` answers the
 * question from the compiler: every declaration site of the name, with its kind
 * and one-indexed line, for the tsconfig project that `file` names.
 *
 * ── What is deliberately NOT claimed, and why each one ───────────────────────
 *  - BODY READS (`-A`/`-B`/`-C`, `--context`). `workspace_symbols` returns
 *    locations, not bodies. The faithful form is two steps — `lsp:query` then
 *    `capability:read { offset, limit }` — and a pair maps onto ONE tool call,
 *    so this sub-population (520 of 837 fired atoms) stays bash in the generated
 *    table. The advisory still names the two-step route.
 *  - MORE THAN ONE SEARCH ROOT. A symbol search covers ONE project, so a grep
 *    over two trees has no single faithful call.
 *  - A ROOT THAT IS NOT INSIDE A KNOWN TYPESCRIPT PROJECT, or that CONTAINS a
 *    nested one. `lsp:query` resolves a directory anchor to the nearest
 *    tsconfig.json at-or-above it and REFUSES a directory spanning nested
 *    projects (`resolveDirectoryAnchor`), because answering for the outer
 *    project would read as absence for symbols in the inner ones. `cover()`
 *    must stay pure, so it decides this from {@link TS_PROJECT_ROOTS} — the
 *    tracked tsconfig.json set, pinned against the tree by a test — instead of
 *    walking the filesystem. A root outside every listed project is simply not
 *    claimed; nothing is guessed.
 *  - NON-TYPESCRIPT `--include` filters. tsserver indexes TS sources only.
 *  - `type` / `const` / `enum` declarations. The compiler does model them, but
 *    the certification corpus for this retarget is the advisory's own FIRES,
 *    which only ever contain `function` / `class` / `interface` shapes. Adding a
 *    keyword without a sample that contains it would certify nothing.
 *
 * ── A residue stated plainly rather than buried ──────────────────────────────
 * A grep with no `--include` also reads `.js`/`.mjs`/`.md` files under the root,
 * and tsserver does not index those, nor files a tsconfig excludes. For a
 * DEFINITION question in a TypeScript project that is judged acceptable: a
 * definition in a doc is a mention, not a declaration. A symbol defined only in
 * an excluded file is the case where grep still wins, and the advisory says so.
 *
 * ── The envelope-faithful, data-empty failure class ──────────────────────────
 * When this pair first shipped (pointing at gitnexus) the graph had NEVER
 * indexed this repo; every call it recommended would have hit an empty index,
 * and the harness still derived `equivalent`. `cover()` models a tool's ARGUMENT
 * ENVELOPE; it cannot prove the tool ANSWERS. That finding is retained as
 * {@link GITNEXUS_INDEX_FINDING} because the reindex routine and its tests cite
 * it. The LSP facade fails closed instead: an unanchored or unresolvable
 * symbol search refuses rather than returning an empty that reads as absence.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * The backing-index liveness finding for the code graph, recorded as DATA. It
 * no longer describes this pair's tool (D-010 moved definition lookups to LSP),
 * but it is the provenance of `system:gitnexus-reindex` and stays here so the
 * envelope-faithful/data-empty lesson keeps its evidence.
 */
export const GITNEXUS_INDEX_FINDING = {
  /** Before: `list_repos` returned exactly one, unrelated, checkout. */
  indexedBefore: false,
  probeBefore: "gitnexus.context { name: 'managedSetInterval' } → \"Symbol 'managedSetInterval' not found\"",
  /** After: `npx gitnexus analyze . --skip-agents-md --name papercusp`, 309.2s. */
  indexedAt: '2026-07-27',
  indexStats: { nodes: 234_905, edges: 373_483, clusters: 6067, flows: 300 },
  probeAfter:
    "gitnexus.context { name: 'managedSetInterval', kind: 'Function', repo: 'papercusp' } → found at " +
    'libs/generic/scheduled-registry/src/index.ts:221-262 with 24 incoming callers; ' +
    "{ name: 'BashSubstitutionPair', kind: 'Interface' } → found at " +
    'packages/operator-core/lib/bash-substitution/types.ts:72-157. Both claimed kinds verified.',
  refreshStep: 'npx gitnexus analyze . --skip-agents-md --name papercusp',
  /**
   * ⚠ `--skip-agents-md` is REQUIRED, not cosmetic: the default rewrites a
   * gitnexus section into CLAUDE.md and AGENTS.md, which in this repo are prompt
   * SOURCES spliced into every agent's context — and CLAUDE.md additionally holds
   * the generated routing table this very registry owns.
   */
  refreshOwner: 'system:gitnexus-reindex — durable hourly routine, cron 0 35 * * * *',
  note:
    'The index is a LOCAL artifact under <repo>/.gitnexus (gitignored). The durable system:gitnexus-reindex ' +
    'routine now owns refreshes; WI-6457 verified repeated scheduled analyze completions and healthy graph ' +
    'canaries on 2026-09-03/04, then re-probed managedSetInterval through gitnexus.context. commitsBehind can ' +
    'still rise between gated hourly runs, but the former unowned-decay blocker is closed.',
} as const;

/** `libs/generic/<pkg>` packages that carry their own tsconfig.json. */
const LIBS_GENERIC_PROJECTS = [
  'activity-bridge', 'agent-roster', 'artifact-registry', 'bench-metrics', 'cache', 'card-stack', 'chat-cards',
  'chat-protocol', 'control-mutation', 'debounce-coalesce', 'decision-model', 'dependency-order',
  'deployment-driver', 'desktop-ipc', 'dock-workbench', 'embedded-pg-discovery', 'eval-battery', 'event-reaction',
  'facets', 'failure-detector', 'fanout-resolver', 'gui-readiness', 'hash-chain', 'image-blankness',
  'ipc-endpoint-server', 'ipc-framing', 'kokoro-tts', 'lexicon', 'linkable-edges', 'locks-core', 'memory',
  'merkle-log', 'model-pricing', 'module-singleton', 'overlap-clusters', 'papergrid/bloom-grid', 'papergrid/grid',
  'papergrid/grid-core', 'papergrid/kv-persist', 'papergrid/kv-persist-indexeddb', 'plan-parser', 'plugin-loader',
  'projection-index', 'prospect-contract', 'pubsub-substrate', 'ranked-selection', 'rate-limit', 'release-profile',
  'rerank', 'resource-profile', 'result-encoding', 'resumable-download', 'rrf', 'rules', 'scheduled-registry',
  'search', 'search-core', 'seed-bundle', 'sequence-patterns', 'sse', 'step-program', 'structured-concurrency',
  'sync', 'tauri-release-kit', 'tauri-verify', 'template-kit', 'tooldef', 'tooldef-http', 'ui-primitives',
  'verification-harness',
].map((pkg) => `libs/generic/${pkg}`);

/**
 * Every directory in this repo that holds a tracked `tsconfig.json` — the units
 * a TypeScript symbol search can cover. Derived from
 * `git ls-files --recurse-submodules -- '*tsconfig.json'` (exact name; `_retired`
 * and generated `env-sidecars` copies excluded), and pinned by
 * `code-search.test.ts`, which fails if any entry stops holding a tsconfig.json.
 *
 * Anchoring on these is also what keeps the OTHER checkouts on this box out: an
 * `oddsmith` tree shares the first path segment (`packages/oms`,
 * `packages/treasury`, `apps/desktop`), so a one-segment anchor would claim
 * commands about a different repository. Every entry here is at least two
 * segments deep and names a project that exists in THIS tree.
 *
 * Completeness is NOT required: a project added later and missing here is only
 * a grep this pair does not claim — the conservative direction.
 */
export const TS_PROJECT_ROOTS: readonly string[] = [
  'apps/operator', 'apps/operator-docs', 'apps/operator-public', 'apps/operator-vite', 'apps/papercusp-docs',
  'apps/papercusp-publish', 'apps/the-swarm-site',
  'libs/agent-chat', 'libs/flags', 'libs/host-platform', 'libs/marketplace-public-ui', 'libs/papercusp-db',
  'libs/papercusp-publish-auth', 'libs/papercusp-shared', 'libs/test-config', 'libs/testing-shell',
  'libs/papercusp/libs/db', 'libs/papercusp/packages/blueprint-distribution', 'libs/papercusp/packages/cli',
  'libs/papercusp/packages/file-claim', 'libs/papercusp/packages/harness',
  'libs/papercusp/packages/harness/docs-viewer', 'libs/papercusp/packages/locks',
  'libs/papercusp/packages/orchestrator', 'libs/papercusp/plugins/gitnexus-bridge',
  'packages/agent-mcp', 'packages/backup', 'packages/coordination', 'packages/docs-engine', 'packages/omp-plugin',
  'packages/operator-core', 'packages/operator-ui', 'packages/tooldef-mcp',
  ...LIBS_GENERIC_PROJECTS,
];

/**
 * Roots inside a project that also CONTAIN another project — the directories
 * `resolveDirectoryAnchor` refuses. Derived from {@link TS_PROJECT_ROOTS}: every
 * ancestor of a nested project, from its enclosing project down.
 */
export const NESTED_PROJECT_CONTAINERS: readonly string[] = (() => {
  const out = new Set<string>();
  for (const inner of TS_PROJECT_ROOTS) {
    for (const outer of TS_PROJECT_ROOTS) {
      if (inner === outer || !inner.startsWith(`${outer}/`)) continue;
      const segments = inner.slice(outer.length + 1).split('/');
      for (let i = 0; i < segments.length; i += 1) {
        out.add([outer, ...segments.slice(0, i)].join('/'));
      }
    }
  }
  return [...out].sort();
})();

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest first, so an alternation never stops at a shorter sibling prefix. */
const byLengthDesc = (xs: readonly string[]) => [...xs].sort((a, b) => b.length - a.length).map(escapeRe);

/** A search operand inside one listed project: the project itself, or any path below it. */
const PROJECT_OPERAND = `(?:${byLengthDesc(TS_PROJECT_ROOTS).join('|')})(?:/\\S*)?`;

/** At least one search operand lies inside a known TypeScript project. */
const REQUIRE_PROJECT_ROOT = `(?=[^\\n]*(?:^|\\s)${PROJECT_OPERAND}(?=\\s|$))`;

/** A root that spans a nested project is refused by the tool, so it is not claimed. */
const EXCLUDE_CONTAINER_ROOT = `(?![^\\n]*(?:^|\\s)(?:${byLengthDesc(NESTED_PROJECT_CONTAINERS).join('|')})/?(?=\\s|$))`;

/**
 * The declaration keywords claimed. See the header for why `type`/`const`/`enum`
 * are absent — they are a sampling limit, not a tool limit.
 */
const DECL_KEYWORD = '(?:function|class|interface)';

/**
 * A quoted grep pattern that names a DECLARATION and an identifier. The quotes
 * are required: an unquoted `grep -rn export function foo` would make `function`
 * the pattern and `foo` a path, which is a different command.
 */
const DEFINITION_PATTERN =
  `(?:"\\^?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?${DECL_KEYWORD}\\s+[A-Za-z_$][\\w$]*"` +
  `|'\\^?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?${DECL_KEYWORD}\\s+[A-Za-z_$][\\w$]*')`;

/**
 * Atoms this family must never claim, excluded by PATTERN per D-008.
 *
 * A shell expansion (`$f`, `$(grep …)`) is genuinely undecidable — the corpus
 * contains `grep -rn -A 35 "interface PresenceRecord" $(grep -rln …`, where the
 * search root is the output of another command. An stdout redirect means the
 * command's literal effect includes a FILE the tool does not produce. `2>&1` /
 * `2>/dev/null` is NOT a redirect for this purpose — it is stderr plumbing.
 */
const EXCLUDE_UNEXPRESSIBLE = String.raw`(?![^\n]*[$\`])(?![^\n]*(?:^|\s)1?>)`;

/** `node_modules` is vendored and gitignored — no project indexes it as source. */
const EXCLUDE_VENDORED = String.raw`(?![^\n]*node_modules)`;

/**
 * D-010(b): a context request reads the BODY, which `workspace_symbols` does not
 * return. Any short cluster carrying A/B/C (`-A 30`, `-rnA5`, `-C3`) or a long
 * `--context` form takes the atom out of this pair entirely.
 */
const EXCLUDE_CONTEXT = String.raw`(?![^\n]*\s(?:-[A-Za-z]*[ABC]|--(?:after-|before-)?context))`;

/**
 * Any OTHER flag `cover()` cannot express is also excluded by pattern (D-008:
 * narrow until the residue falls outside). A short cluster carrying a letter
 * outside {@link EXPRESSIBLE_FLAGS} (`-c` counts, `-i` folds case, `-e` moves
 * the pattern), or a long flag other than `--include`. Measured on the fires
 * corpus this removed the `-rnc` count atom that was the pair's residue.
 */
const EXCLUDE_UNEXPRESSIBLE_FLAG =
  String.raw`(?![^\n]*\s(?:-[A-Za-z]*(?![rRlnwIhsE])[A-Za-z]|--(?!include(?:=|\s))[a-z]))`;

/** `--include` must name TypeScript sources only (`*.ts`, `"*.tsx"`, `*.{ts,tsx}`). */
const TS_EXT_ALT = '(?:ts|tsx|mts|cts)';
const TS_GLOB = `\\*\\.(?:${TS_EXT_ALT}|\\{${TS_EXT_ALT}(?:,${TS_EXT_ALT})*\\})`;
const EXCLUDE_NON_TS_INCLUDE = `(?![^\\n]*\\s--include(?:=|\\s+)(?!["']?${TS_GLOB}["']?(?:\\s|$))\\S)`;

/**
 * A FILE root must be a TypeScript source: `lsp:query` opens it as a document in
 * the TypeScript server, and a `.mjs` / `.json` / `.md` root is not one. Any
 * unquoted, non-flag operand ending in a non-TS extension takes the atom out.
 */
const EXCLUDE_NON_TS_FILE_ROOT = `(?![^\\n]*\\s(?!-)[^\\s"']*\\.(?!${TS_EXT_ALT}(?:\\s|$))[A-Za-z0-9]+(?=\\s|$))`;

/**
 * A second search root has no single faithful call. A path operand is any token
 * after the quoted pattern that is not a flag, stderr plumbing or backgrounding;
 * two of them take the atom out. (The pattern operand itself is quoted and comes
 * first, so it never counts; `--include <glob>` is consumed as one flag.)
 */
const SKIPPABLE_TOKEN = String.raw`(?:--include\s+\S+|-\S+|2>\S*|&)`;
const PATH_TOKEN = String.raw`(?!-|2>|&)\S+`;
const EXCLUDE_SECOND_ROOT =
  `(?![^\\n]*${DEFINITION_PATTERN}(?:\\s+${SKIPPABLE_TOKEN})*\\s+${PATH_TOKEN}` +
  `(?:\\s+${SKIPPABLE_TOKEN})*\\s+${PATH_TOKEN})`;

/** Stderr plumbing and backgrounding — neither changes the request. */
const TRAILING_NOISE = String.raw`(?:\s+2>(?:&1|\s*/dev/null))?(?:\s*&)?\s*`;

/** Source extensions the TypeScript server indexes. */
const TS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts']);

interface ParsedGrepCommand {
  /** The quoted search pattern, unquoted; null when none was found. */
  pattern: string | null;
  /** The declaration keyword inside `pattern`. */
  declKeyword: string | null;
  /** The identifier being looked up. */
  symbol: string | null;
  /** Non-flag operands after the pattern — the search roots. */
  paths: string[];
  /** Every flag, normalised to its bare name. */
  flags: string[];
  /** `--include` globs. */
  includes: string[];
  /** An after-context request (`-A n`). */
  afterContext: number | null;
  /** Any context request at all (`-A`/`-B`/`-C`/`--context`): a body read. */
  readsBody: boolean;
  /** Recursive (`-r`/`-R`, in any cluster). */
  recursive: boolean;
  /** An stdout redirect is present. */
  writes: boolean;
  /** An operand contains a shell expansion. */
  dynamic: boolean;
}

function tokenize(atom: string): string[] {
  return atom.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

/** Flags that consume the NEXT token as their argument. */
const ARG_FLAGS = new Set(['-A', '-B', '-C', '-e', '-m', '-f', '--include', '--exclude', '--exclude-dir']);

/** Long context flags, which always read the body. */
const LONG_CONTEXT_FLAGS = new Set(['--context', '--after-context', '--before-context']);

/** A quoted definition pattern, re-parsed to recover its parts. */
const DEFINITION_RE = new RegExp(
  `^\\^?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(${DECL_KEYWORD})\\s+([A-Za-z_$][\\w$]*)$`,
);

/** `grep [flags] <pattern> [paths…]`, with flags and pattern in any order. */
export function parseGrepAtom(atom: string): ParsedGrepCommand {
  const out: ParsedGrepCommand = {
    pattern: null, declKeyword: null, symbol: null, paths: [], flags: [], includes: [],
    afterContext: null, readsBody: false, recursive: false, writes: false, dynamic: false,
  };
  const tokens = tokenize(atom);
  const start = tokens.findIndex((t) => t === 'grep');
  if (start === -1) return out;

  for (let i = start + 1; i < tokens.length; i += 1) {
    const token = tokens[i];

    // Stderr plumbing and backgrounding are noise; a stdout redirect is a real artifact.
    if (/^2>/.test(token)) {
      if (token === '2>') i += 1;
      continue;
    }
    if (token === '&') continue;
    const redirect = /^(\d*)(?:>>|>)/.exec(token);
    if (redirect) {
      if (redirect[1] === '' || redirect[1] === '1') out.writes = true;
      if (/^\d*(?:>>|>)$/.test(token)) i += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const [bare, inlineValue] = token.includes('=')
        ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
        : [token, null];

      if (bare === '--include') {
        out.flags.push('--include');
        out.includes.push(unquote(inlineValue ?? tokens[++i] ?? ''));
        continue;
      }
      if (LONG_CONTEXT_FLAGS.has(bare)) {
        out.flags.push(bare);
        out.readsBody = true;
        if (inlineValue === null) i += 1;
        continue;
      }
      if (ARG_FLAGS.has(bare)) {
        out.flags.push(bare);
        const value = inlineValue ?? tokens[i + 1] ?? '';
        if (inlineValue === null) i += 1;
        if (bare === '-A') out.afterContext = Number.parseInt(value, 10);
        if (bare === '-A' || bare === '-B' || bare === '-C') out.readsBody = true;
        continue;
      }

      // A short cluster like `-rln`, or `-A30` / `-rnC3` with the count attached.
      const attached = /^-([A-Za-z]+)(\d+)$/.exec(bare);
      if (attached) {
        for (const ch of attached[1]) out.flags.push(`-${ch}`);
        if (attached[1].includes('A')) out.afterContext = Number.parseInt(attached[2], 10);
        if (/[ABC]/.test(attached[1])) out.readsBody = true;
        if (/[rR]/.test(attached[1])) out.recursive = true;
        continue;
      }
      if (!bare.startsWith('--')) {
        for (const ch of bare.slice(1)) out.flags.push(`-${ch}`);
        if (/[rR]/.test(bare)) out.recursive = true;
        // A cluster ENDING in A/B/C takes the next token as its count (`-rnA 5`).
        if (/[ABC]$/.test(bare)) {
          out.readsBody = true;
          if (bare.endsWith('A')) out.afterContext = Number.parseInt(tokens[i + 1] ?? '', 10);
          i += 1;
        } else if (/[ABC]/.test(bare)) {
          out.readsBody = true;
        }
        continue;
      }
      out.flags.push(bare);
      continue;
    }

    const operand = unquote(token);
    if (/[$`]/.test(operand)) out.dynamic = true;

    // The first quoted operand matching the definition shape is the PATTERN;
    // everything after it is a search path.
    if (out.pattern === null) {
      const match = DEFINITION_RE.exec(operand);
      if (match) {
        out.pattern = operand;
        out.declKeyword = match[1];
        out.symbol = match[2];
        continue;
      }
      // A non-definition first operand is still the pattern for grep's purposes.
      if (token !== unquote(token) || !/^[-/.\w*]/.test(operand)) {
        out.pattern = operand;
        continue;
      }
    }
    out.paths.push(operand);
  }

  return out;
}

/**
 * Turn a grep root into the `file` anchor `lsp:query` takes: drop a trailing
 * slash, and cut a glob segment back to the directory before it
 * (`packages/x/src/*.ts` → `packages/x/src`). Without `globstar`, `**` is just
 * `*`, so the same cut is faithful for it.
 */
export function anchorForRoot(root: string): string {
  const segments = root.replace(/\/+$/, '').split('/');
  const firstGlob = segments.findIndex((s) => /[*?[{]/.test(s));
  return (firstGlob === -1 ? segments : segments.slice(0, firstGlob)).join('/');
}

/** The project a repo-relative anchor lies in, or null when no listed project contains it. */
export function projectForAnchor(anchor: string): string | null {
  let best: string | null = null;
  for (const project of TS_PROJECT_ROOTS) {
    if ((anchor === project || anchor.startsWith(`${project}/`)) && (best === null || project.length > best.length)) {
      best = project;
    }
  }
  return best;
}

/** `--include` globs as extension lists: `*.ts` → [ts], `*.{ts,tsx}` → [ts, tsx]. */
function includeExtensions(glob: string): string[] | null {
  const brace = /\.\{([A-Za-z0-9,]+)\}$/.exec(glob);
  if (brace) return brace[1].split(',');
  const ext = /\.([A-Za-z0-9]+)$/.exec(glob)?.[1];
  return ext === undefined ? null : [ext];
}

/** Render the tool call a covered command maps onto. */
function expressionFor(symbol: string, anchor: string): string {
  return `lsp:query { op: "workspace_symbols", name: "${symbol}", file: "${anchor}" }`;
}

/**
 * Flags whose request `workspace_symbols` genuinely serves.
 *
 * `-l`/`-n` ask WHERE the definition is, which is exactly what the tool returns
 * (file and one-indexed line); `-r`/`-R` is the recursion this pattern requires;
 * `-w` asks for a whole-word match, and the tool matches a symbol NAME, which is
 * strictly that; `-I`/`-h`/`-s` are output/binary plumbing that does not change
 * the question; `--include` is a source-type filter checked separately.
 * Context flags are NOT here: D-010(b) excludes body reads by pattern.
 *
 * `-E` is covered because it cannot change the question for THIS pattern
 * shape: a pattern only reaches `cover()` after {@link DEFINITION_RE} accepts it,
 * so its text is identifier characters, spaces, and at most a leading `^` — and
 * `^`/`$` anchor identically in basic and extended syntax. (Measured: 3 of the
 * 286 fired atoms carried `-E`.) `-F` is NOT covered: it makes a leading `^`
 * literal, which does change the match.
 */
const EXPRESSIBLE_FLAGS = new Set(['-r', '-R', '-l', '-n', '-w', '-I', '-h', '-s', '-E', '--include']);

/** Everything `lsp:query workspace_symbols` can and cannot express about a parsed grep. */
export function coverDefinitionLookup(parsed: ParsedGrepCommand): CoverageResult {
  if (parsed.writes) {
    return { covered: false, reason: 'redirects the match output to a file; lsp:query returns a structured result and writes no artifact' };
  }
  if (parsed.dynamic) {
    return { covered: false, reason: 'a search operand is a shell expansion, so the searched tree is not decidable from the atom' };
  }
  if (!parsed.recursive) {
    return { covered: false, reason: 'not a recursive search: the command greps named files, not a tree' };
  }
  if (parsed.symbol === null || parsed.declKeyword === null) {
    return { covered: false, reason: 'the search pattern does not name a declaration keyword and an identifier, so it is not a definition lookup' };
  }
  if (parsed.readsBody) {
    return {
      covered: false,
      reason:
        'asks for context lines (-A/-B/-C), i.e. reads the BODY; workspace_symbols returns locations only, so the ' +
        'faithful form is two calls (lsp:query, then capability:read { offset, limit }), not one (D-010b)',
    };
  }

  const unexpressible = parsed.flags.find((f) => !EXPRESSIBLE_FLAGS.has(f));
  if (unexpressible) {
    return { covered: false, reason: `passes \`${unexpressible}\`, which lsp:query workspace_symbols has no argument for` };
  }

  for (const glob of parsed.includes) {
    const exts = includeExtensions(glob);
    if (exts === null || exts.some((ext) => !TS_EXTENSIONS.has(ext))) {
      return {
        covered: false,
        reason: `--include=${glob} reaches files the TypeScript server does not index (it indexes .ts/.tsx/.mts/.cts sources only)`,
      };
    }
  }

  if (parsed.paths.length === 0) {
    return {
      covered: false,
      reason: "no search path: grep walks the shell's cwd, which the atom no longer carries after `cd` was split off",
    };
  }
  if (parsed.paths.length > 1) {
    return {
      covered: false,
      reason: `searches ${parsed.paths.length} roots; a symbol search covers ONE tsconfig project, so there is no single faithful call`,
    };
  }

  const anchor = anchorForRoot(parsed.paths[0]);
  const fileExt = /\.([A-Za-z0-9]+)$/.exec(anchor.split('/').pop() ?? '')?.[1];
  if (fileExt !== undefined && !TS_EXTENSIONS.has(fileExt)) {
    return {
      covered: false,
      reason: `search root "${anchor}" is a .${fileExt} file, which the TypeScript server cannot open as a project document`,
    };
  }
  if (projectForAnchor(anchor) === null) {
    return {
      covered: false,
      reason:
        `search root "${parsed.paths[0]}" is not inside a known TypeScript project of this repo (a cwd-relative or ` +
        'absolute path, a directory above every project, or another checkout on this box such as oddsmith)',
    };
  }
  if (NESTED_PROJECT_CONTAINERS.includes(anchor)) {
    return {
      covered: false,
      reason: `search root "${anchor}" contains a nested tsconfig project, which lsp:query refuses as an anchor (one project per search)`,
    };
  }

  return { covered: true, expression: expressionFor(parsed.symbol, anchor) };
}

/**
 * P-002 / D-010 — `grep -r "<decl> <Ident>" <one root inside one TS project>`,
 * with no context flags: the one shape where a recursive grep and the compiler's
 * symbol index answer the SAME question. Certified on a fresh sample of the
 * advisory's own fires (see the fixture's `evidenceRef`).
 */
export const lspDefinitionLookup: BashSubstitutionPair = {
  id: 'code-search.definition-lookup',
  intentLabel: 'find-where-a-symbol-is-defined',
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}${EXCLUDE_VENDORED}${EXCLUDE_CONTEXT}${EXCLUDE_UNEXPRESSIBLE_FLAG}` +
      `${EXCLUDE_NON_TS_INCLUDE}${EXCLUDE_NON_TS_FILE_ROOT}${EXCLUDE_SECOND_ROOT}` +
      `${EXCLUDE_CONTAINER_ROOT}${REQUIRE_PROJECT_ROOT}` +
      `(?=[^\\n]*\\s${DEFINITION_PATTERN})` +
      `grep(?:\\s+-[A-Za-z]*[rR][A-Za-z]*)` +
      `[^\\n]*${TRAILING_NOISE}$`,
  ),
  toolName: 'lsp:query',
  advisoryText:
    'lsp:query { op: "workspace_symbols", name, file } answers "where is this defined" from the TypeScript compiler: ' +
    'every declaration site of the name with its kind and one-indexed line1, for the ONE tsconfig project that `file` ' +
    '(a file or a directory inside that project, e.g. the grep root) names. A directory spanning several projects ' +
    '(libs/generic) is refused, so anchor the package you mean. To read the body, follow with capability:read ' +
    '{ file_path, offset: line1, limit }. Searches across several projects, symbols in files a tsconfig excludes, ' +
    'and exact-text matching remain grep\'s job.',
  // Keep concise: this table is spliced into launch-prose surfaces with strict
  // ceilings (lint:launch-prose-budget).
  routing: {
    want: 'to find where a symbol is DEFINED',
    use: '`lsp:query { op: "workspace_symbols", name: "X", file: "<grep root>" }`; body: `capability:read`',
    insteadOf:
      '`rg -n --max-count 60 --max-columns 256 --max-columns-preview -F "export function X" <one project dir>` (caps matching lines per file and long lines; repo-wide: add `--exclude-dir={node_modules,.vitest-tmp,dist,coverage} --exclude-dir=sidecar` — generated bundles/caches are not source evidence; exhaustive exact-text search remains grep/rg\'s job)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    return coverDefinitionLookup(parseGrepAtom(atom));
  },
};

// ── P-002(d) / D-010(d): who CALLS this symbol ───────────────────────────────
//
// Population (30 days to 2026-10-06T08:00Z, harness_shared.session_turn_parts):
// recursive greps whose quoted pattern is `IDENT(` (D-017: 462 atoms, 131
// sessions before the WI-10006543 re-scope below; the fixture's
// totalAtoms/totalSessions carry the re-scoped count). graph:query
// { op:'callers', name, paths } is the routed tool.
//
// Backend (D-026, WI-10006543): graph:query callers is answered by the vendored
// TypeScript call hierarchy over the workspace's current source
// (code-intelligence/first-party-callers.ts, in a forked worker), not by the
// GitNexus index. It unions every declaration that carries the name, gives every
// site a line and has no index to go stale, so the GitNexus-era refusals
// (ambiguous names, file-level edges, symbols missing from the index) no longer
// occur. {@link CALLERS_GRAPH_OUTCOMES} is re-measured against it (D-027).
//
// Re-scoped by WI-10006543 (after D-027), and derived `equivalent` on the re-drawn
// sample (40/40, see CALLERS_GRAPH_MEASUREMENT):
//  - The population is greps whose EVERY root is anchored inside this repo. The
//    atom does not carry the cwd, and other checkouts on this box share a bare
//    `packages`/`apps`/`libs` first segment. 25 of the old 40 sampled atoms were such
//    greps; the bashPattern now leaves them out (EXCLUDE_UNANCHORED_ROOT).
//  - The tool takes `paths`, so it searches exactly the grep's roots. Repo-wide, a
//    name in thousands of files (`fetch`: 2,578) exhausted the worker.
//  - A capitalised `Name(` without a word boundary is a partial-name search
//    (PARTIAL_NAME_PATTERN) and is left out too.
// `cover()` therefore checks the envelope first, then looks the identifier up in
// {@link CALLERS_GRAPH_OUTCOMES}: the tool's own answer for each identifier in the
// frozen sample, measured on a named date. That table is evidence, not a model;
// re-measure it whenever the fixture or the backend changes.
//
// What a resolved answer means: grep's matches include the definition line,
// longer names ending in the pattern (`openEscalation(` matches
// `reopenEscalation(`), comments and strings. None of those are callers, so the
// tool answering with fewer lines is the faithful answer to "who calls X", not a
// loss. It can also return MORE than grep: a call through an alias
// (`const f = mod.sendMessage; f(...)`) or with type arguments (`fn<T>(`) has no
// `NAME(` text. An --include or --exclude-dir narrows within the roots; the
// answer carries a path on every site, so that subset is a filter over it.

/** A quoted `IDENT(` pattern, optionally word-bounded or with an escaped paren. */
const CALLER_PATTERN =
  String.raw`(?:"(?:\\b|\\<)?[A-Za-z_][\w$]*\\?\("|'(?:\\b|\\<)?[A-Za-z_][\w$]*\\?\(')`;

/** Recover the word boundary (if any), the identifier and whether the paren was escaped. */
const CALLER_RE = /^(\\b|\\<)?([A-Za-z_][\w$]*)(\\?)\($/;

/**
 * WI-10006543: a quoted `Name(` that starts with a capital and carries no word boundary. It matches
 * the tail of every camelCase name ending in it (`"EventKey("` prints `getEventKey(`,
 * `normalizeEventKey(`, ...), so the grep is a partial-name search, which graph:query callers (one
 * exact name) cannot express. Measured on the re-scoped sample: all 19 lines `EventKey(` printed
 * were other names, and no symbol is called `EventKey`. A word-bounded `"\bName("` asks for the
 * exact name and stays claimed.
 */
const PARTIAL_NAME_PATTERN = String.raw`(?:"[A-Z][\w$]*\\?\("|'[A-Z][\w$]*\\?\(')`;

/**
 * Multi-segment directories that CONTAIN a listed project without being inside one
 * (`libs/papercusp` holds `libs/papercusp/libs/db`). {@link repoAnchored} accepts them.
 */
const PROJECT_CONTAINERS: readonly string[] = (() => {
  const out = new Set<string>();
  for (const project of TS_PROJECT_ROOTS) {
    const segments = project.split('/');
    for (let i = 2; i < segments.length; i++) out.add(segments.slice(0, i).join('/'));
  }
  return [...out].filter((dir) => projectForAnchor(dir) === null).sort();
})();

/**
 * A search operand anchored inside this repo, read the way {@link repoAnchored} reads
 * {@link anchorForRoot}: a listed project or any path below it, or a containing
 * directory, optionally followed by one glob segment (`libs/papercusp/*`).
 */
const ANCHORED_OPERAND =
  `(?:${PROJECT_OPERAND}` +
  `|(?:${byLengthDesc(PROJECT_CONTAINERS).join('|')})(?:/(?:[^\\s/]*[*?[{][^\\s]*)?)?)`;

/** Flags that consume the NEXT token in their space form (`--include *.ts`). */
const CALLER_SKIPPABLE = String.raw`(?:--(?:include|exclude|exclude-dir)\s+\S+|-\S+|2>\S*|&)`;

/**
 * WI-10006543 / D-027: the population is greps whose EVERY search root is anchored in
 * this repo. Any token after the caller pattern that is not a flag, stderr plumbing or
 * an anchored operand (`.`, `packages/`, an absolute path, another checkout) takes the
 * atom out. A space-form `--include <glob>` can be read as a bare glob token here, so
 * that spelling is excluded too: a narrowing, never a false claim.
 */
const EXCLUDE_UNANCHORED_ROOT =
  `(?![^\\n]*${CALLER_PATTERN}(?:\\s+(?:${CALLER_SKIPPABLE}|${ANCHORED_OPERAND}(?=\\s|$)))*` +
  `\\s+(?!-|2>|&)(?!${ANCHORED_OPERAND}(?=\\s|$))\\S)`;

/** At least one anchored root: a rootless grep walks the shell's cwd, which the atom no longer carries. */
const REQUIRE_ANCHORED_ROOT = `(?=[^\\n]*\\s${ANCHORED_OPERAND}(?=\\s|$))`;

/** A partial-name search (see {@link PARTIAL_NAME_PATTERN}) is outside the population. */
const EXCLUDE_PARTIAL_NAME = `(?![^\\n]*\\s${PARTIAL_NAME_PATTERN}(?=\\s|$))`;

/** The identifier a caller-shaped grep asks about, or null. */
export function callerIdentOf(atom: string): string | null {
  const parsed = parseGrepAtom(atom);
  return parsed.pattern === null ? null : (CALLER_RE.exec(parsed.pattern)?.[2] ?? null);
}

/**
 * What graph:query callers answered for each identifier in the frozen callers
 * sample, joined with a grep-equivalence check of the same tree: every
 * `NAME(` line ripgrep finds in a code file that the answer omits is classified
 * by its AST node.
 *  - `resolved`: call sites with lines, and every grep line the answer omits is a
 *    declaration, comment, JSDoc or string.
 *  - `no-callers`: an empty answer, and every grep line is a declaration, comment
 *    or string. grep's answer contains no call either.
 *  - `not-found`: an empty answer, and grep finds no `NAME(` line at all.
 *  - `missed`: the answer omits a grep line that is a call. The worst class: an
 *    empty or short answer reads as "no other callers".
 *  - `error`: the tool answered with an error instead of sites.
 *  - `root-missing`: the sampled grep searched a path that does not exist (the
 *    agent's own grep failed on it too). The tool refuses that path by name, which
 *    is grep's answer, so ONLY the recorded roots in
 *    {@link CALLERS_GRAPH_MISSING_ROOTS} are covered; the name over any other root
 *    is unmeasured.
 */
export type CallersGraphOutcome = 'resolved' | 'no-callers' | 'not-found' | 'missed' | 'error' | 'root-missing';

/** Outcomes whose answer is the faithful answer to the grep's question. */
const COVERED_CALLER_OUTCOMES: ReadonlySet<CallersGraphOutcome> = new Set(['resolved', 'no-callers', 'not-found']);

export const CALLERS_GRAPH_MEASUREMENT = {
  measuredAt: '2026-10-06T21:09:00Z',
  headAtMeasurement: '902eb5976a2aa278aaf7f778fd227948d6b922cd',
  backend: 'typescript-service (code-intelligence/first-party-callers.ts, D-026)',
  tool:
    "graph:query { op: 'callers', name, limit: 500, paths: <the atom's own anchored roots> }: the real handler run " +
    'in-process on the staging working tree (forked worker, 60 s budget, 3,072 MB heap), not the deployed :3070 facade',
  grepCheck:
    'ripgrep `(?<![\\w$])NAME\\s*\\(` over ts/tsx/mts/cts/js/jsx/mjs/cjs outside node_modules, over the SAME roots, ' +
    'with --with-filename (a single-file root otherwise prints no path and parsed as zero lines); each omitted line ' +
    'classified by AST. A literal `NAME(` census over the same roots checks for partial-name searches.',
  remeasureCommand: 'node --import tsx scripts/remeasure-callers.ts [sampledName ...] (mandatory semantic reference + literal census; exits nonzero on incomplete or suspicious evidence)',
  evidence: 'docs/evidence/gitnexus-callers-remeasure-scoped-2026-10-06.json',
  tally: { resolved: 39, 'not-found': 1 },
} as const;

export const CALLERS_GRAPH_OUTCOMES: Readonly<Record<string, CallersGraphOutcome>> = {
  // Plus one call grep cannot see (su-session-host.test.ts).
  acceptCommand: 'resolved',
  appliedIdentityArtifact: 'resolved',
  applySessionPresenceSet: 'resolved',
  attributionMapForRepo: 'resolved',
  buildRubricTemplateData: 'resolved',
  claimIssue: 'resolved',
  createCheckpointTreeFixPrecheckRunner: 'resolved',
  // Plus two calls grep cannot see (plan-items/convert.integration.test.ts).
  createWorkItem: 'resolved',
  dispatchProjectedTool: 'resolved',
  enqueueDependencyPrebuild: 'resolved',
  ensurePotGitRepo: 'resolved',
  evaluateScorecardInstrumentContract: 'resolved',
  // No code file under the root contains `failOnConsole(`; the call lives in libs/test-config.
  failOnConsole: 'not-found',
  getContent: 'resolved',
  gitPipelineSnapshot: 'resolved',
  harnessFsAdapter: 'resolved',
  installPluginFromCupboard: 'resolved',
  invalidateFromSse: 'resolved',
  json: 'resolved',
  llmCallViaCodexGateway: 'resolved',
  mapLiveLockHoldingsForRepo: 'resolved',
  // 5 of grep's 131 lines are `reopenEscalation(`: another name, omitted by design.
  openEscalation: 'resolved',
  planAcceptanceChangedKey: 'resolved',
  preflightExactPlanAdmission: 'resolved',
  reactionRulesFor: 'resolved',
  readGoalPortfolioBrief: 'resolved',
  realCheckpointDeps: 'resolved',
  recordEditAttribution: 'resolved',
  registerConnectionAdapter: 'resolved',
  requirePrincipal: 'resolved',
  resolveControllerWorkspaceHostBootstrap: 'resolved',
  resolveMessageRef: 'resolved',
  rotateTestPgReuseGeneration: 'resolved',
  runPhysicalDrillCliToExit: 'resolved',
  scoutConfigDelta: 'resolved',
  setCommsTrust: 'resolved',
  setHiveSetting: 'resolved',
  splitMarkdown: 'resolved',
  terminalDependencies: 'resolved',
  // Plus one call grep cannot see.
  wakeRecipients: 'resolved',
};

/**
 * For each `root-missing` identifier, the anchored roots it was measured on, none of
 * which exists. Only a grep on exactly these roots is covered.
 */
export const CALLERS_GRAPH_MISSING_ROOTS: Readonly<Record<string, readonly string[]>> = {};

const CALLER_OUTCOME_REASON: Record<'missed' | 'error', string> = {
  missed:
    'graph:query callers omitted a line grep finds that is a call; a short or empty answer would read as "no other callers".',
  error:
    'graph:query callers answered with an error (for a name in thousands of files the worker runs out of heap); grep ' +
    'is still how this question gets asked.',
};

/** Flags whose request a repo-wide callers answer serves (paths are filters over it). */
const CALLER_EXPRESSIBLE_FLAGS = new Set([
  '-r', '-R', '-l', '-n', '-w', '-I', '-h', '-s', '-E', '-F', '-P', '--include', '--exclude-dir', '--exclude',
]);

/** Code the graph indexes; an --include outside it asks about docs or data. */
const CODE_EXTENSIONS = new Set([...TS_EXTENSIONS, 'js', 'jsx', 'mjs', 'cjs']);

/** Inside this repo: within a listed project, or a multi-segment directory that contains one. */
function repoAnchored(anchor: string): boolean {
  if (projectForAnchor(anchor) !== null) return true;
  return anchor.includes('/') && TS_PROJECT_ROOTS.some((p) => p.startsWith(`${anchor}/`));
}

/** Everything `graph:query callers` can and cannot express about a caller-shaped grep. */
export function coverCallersLookup(atom: string): CoverageResult {
  return coverCallersLookupAgainst(atom, CALLERS_GRAPH_OUTCOMES, CALLERS_GRAPH_MISSING_ROOTS);
}

/**
 * {@link coverCallersLookup} against an explicit measurement, so every outcome's
 * refusal stays testable when no sampled identifier currently has it.
 */
export function coverCallersLookupAgainst(
  atom: string,
  outcomes: Readonly<Record<string, CallersGraphOutcome>>,
  missingRoots: Readonly<Record<string, readonly string[]>>,
): CoverageResult {
  const parsed = parseGrepAtom(atom);
  if (parsed.writes) return { covered: false, reason: 'redirects the match output to a file; graph:query writes no artifact' };
  if (parsed.dynamic) return { covered: false, reason: 'a search operand is a shell expansion, so the searched tree is not decidable from the atom' };
  if (!parsed.recursive) return { covered: false, reason: 'not a recursive search: the command greps named files, not a tree' };
  const shape = parsed.pattern === null ? null : CALLER_RE.exec(parsed.pattern);
  if (!shape) return { covered: false, reason: 'the pattern is not a bare `IDENT(` call shape' };
  const ident = shape[2]!;
  const escaped = shape[3] === '\\';
  if (shape[1] === undefined && /^[A-Z]/.test(ident)) {
    return {
      covered: false,
      reason:
        `\`${ident}(\` without a word boundary also prints every camelCase name ending in it (get${ident}(), so it is a ` +
        'partial-name search; graph:query callers takes one exact name',
    };
  }
  const extended = parsed.flags.includes('-E') || parsed.flags.includes('-P');
  const fixed = parsed.flags.includes('-F');
  if (fixed ? escaped : escaped !== extended) {
    return {
      covered: false,
      reason: fixed
        ? 'with -F the backslash is literal, so the grep matches `IDENT\\(` text, not calls'
        : `grep rejects this pattern as an unmatched paren in ${extended ? 'extended' : 'basic'} syntax, so the command asks nothing`,
    };
  }
  if (parsed.readsBody) {
    return {
      covered: false,
      reason: 'asks for context lines (-A/-B/-C), i.e. reads the caller BODY; graph:query returns sites, so the faithful form is two calls',
    };
  }
  const unexpressible = parsed.flags.find((f) => !CALLER_EXPRESSIBLE_FLAGS.has(f));
  if (unexpressible) return { covered: false, reason: `passes \`${unexpressible}\`, which graph:query callers has no argument for` };
  for (const glob of parsed.includes) {
    const exts = includeExtensions(glob);
    if (exts === null || exts.some((ext) => !CODE_EXTENSIONS.has(ext))) {
      return { covered: false, reason: `--include=${glob} reaches files the code graph does not index as code` };
    }
  }
  if (parsed.paths.length === 0) {
    return { covered: false, reason: "no search path: grep walks the shell's cwd, which the atom no longer carries" };
  }
  const outside = parsed.paths.find((root) => !repoAnchored(anchorForRoot(root)));
  if (outside !== undefined) {
    return {
      covered: false,
      reason:
        `search root "${outside}" is not anchored inside this repo (a bare first segment such as packages/, a cwd-relative ` +
        'or absolute path, or another checkout on this box); the graph indexes this repo only',
    };
  }
  const outcome = outcomes[ident];
  if (outcome === undefined) {
    return { covered: false, reason: `no graph answerability measurement for \`${ident}\`; re-measure CALLERS_GRAPH_OUTCOMES` };
  }
  // The tool searches exactly these roots (graph:query `paths`), so the answer is grep's
  // question, not a repo-wide superset filtered by hand. A glob root is cut to its
  // anchor directory, which can only widen the searched set.
  const roots = [...new Set(parsed.paths.map(anchorForRoot))];
  const expression = `graph:query { op: "callers", name: "${ident}", paths: ${JSON.stringify(roots)} }`;
  if (outcome === 'root-missing') {
    const recorded = missingRoots[ident] ?? [];
    const unmeasured = roots.find((root) => !recorded.includes(root));
    if (unmeasured !== undefined) {
      return {
        covered: false,
        reason:
          `\`${ident}\` was measured only on a search root that does not exist; "${unmeasured}" is unmeasured, so ` +
          're-measure CALLERS_GRAPH_OUTCOMES',
      };
    }
    // grep fails on the missing path and graph:query refuses it by name: the same answer.
    return { covered: true, expression };
  }
  if (!COVERED_CALLER_OUTCOMES.has(outcome)) {
    return { covered: false, reason: CALLER_OUTCOME_REASON[outcome as 'missed' | 'error'] };
  }
  return { covered: true, expression };
}

/**
 * P-002(d) / D-010(d): `grep -r "IDENT(" <roots in this repo>` routed to
 * graph:query callers. Derived `equivalent` from the measured sample; held at
 * observe and withheld from the routing table until `paths` is live on :3070.
 */
export const graphCallersLookup: BashSubstitutionPair = {
  id: 'code-search.callers-lookup',
  intentLabel: 'find-who-calls-a-symbol',
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}${EXCLUDE_VENDORED}` +
      `(?=[^\\n]*\\s-[A-Za-z]*[rR])(?=[^\\n]*\\s${CALLER_PATTERN}(?=\\s|$))` +
      `${EXCLUDE_CONTEXT}${EXCLUDE_PARTIAL_NAME}${EXCLUDE_UNANCHORED_ROOT}${REQUIRE_ANCHORED_ROOT}` +
      `grep\\s[^\\n]*$`,
  ),
  toolName: 'graph:query',
  advisoryText:
    'graph:query { op: "callers", name, paths } answers "who calls X" from the TypeScript call hierarchy over the ' +
    'current source: call sites with path and one-indexed line1 under the given paths (your grep roots), for every ' +
    'symbol that carries the exact name, excluding the definition, comments and longer names that end in it. An empty ' +
    'answer means no call in any searched file; gitignored, hidden and node_modules paths are not searched. A name in ' +
    'thousands of files can exhaust the worker and answer with an error: grep is still how to ask then.',
  routing: {
    want: 'who CALLS a symbol',
    use: '`graph:query { op: "callers", name: "X", paths: ["<grep root>"] }` (sites with lines, every same-named symbol)',
    insteadOf: '`grep -rn "X(" <dirs>` — still required for a partial name or when the tool answers with an error',
  },
  expectedVerdict: 'equivalent',
  holdAtObserve:
    'Derived equivalent on the re-scoped sample (WI-10006543): 40 of 40 sampled greps are answered by graph:query ' +
    'callers over their own roots. The `paths` argument that makes this true is not yet live on :3070, which every ' +
    'agent calls, so the gate stays at observe until agent-tools/gitnexus/query.ts is deployed. Owned by WI-10006543 ' +
    '(D-018, D-027).',
  routingWithheld:
    'graph:query callers `paths` (agent-tools/gitnexus/query.ts) is not yet live on :3070. Lift with holdAtObserve ' +
    'once it is deployed, then run gen:tool-routing (WI-10006543).',
  cover: coverCallersLookup,
};

/** Every pair in the code-search family, in registry order. */
export const CODE_SEARCH_PAIRS: BashSubstitutionPair[] = [lspDefinitionLookup, graphCallersLookup];

/** Exported for the model-drift guard (D-015). */
export { EXPRESSIBLE_FLAGS, TS_EXTENSIONS };

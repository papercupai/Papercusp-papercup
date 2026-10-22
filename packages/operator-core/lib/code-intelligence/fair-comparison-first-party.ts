/**
 * P-017 first-party arms (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011, D-013, D-016). Both answer from the vendored TypeScript, so neither
 * brings in a third-party engine.
 *
 *  - `lsp-query`: the engine behind the `lsp:query` tool, which is the production
 *    LSP adapter over the vendored typescript-language-server. It is called
 *    in-process with the result limit raised, because the facade caps answers
 *    (D-013 rule 2). Its op set has no call hierarchy, so it declares definition,
 *    references and symbol-search only. A symbol search covers ONE tsconfig
 *    project (the adapter refuses to guess), so the case's anchorFile picks the
 *    project. Without one the arm anchors at the tree root. Recall lost to that
 *    is a measured property of the product, not an adapter defect.
 *  - `no-third-party`: the vendored TypeScript's own LanguageService over the
 *    whole tree as one program. Callers, callees and impact come from the same
 *    `provideCallHierarchy*` code that tsserver runs behind
 *    typescript-language-server. The production adapter has no call-hierarchy
 *    intent; adding one is a readiness and capability-matrix change this bench
 *    does not need (D-016). The program is built during index(), so no query
 *    can see a half-loaded project.
 *
 * The LSP adapter is reached through an injected `LspDoor`, so this module
 * never imports the adapter or its Postgres capability store.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type * as TsModule from 'typescript';
import type { CodeIntelAnswer, SymbolSite } from './contracts';
import type { PhaseCost } from './engine-comparison';
import type { ArmCapabilities, FairCase, FairIntent } from './fair-comparison';
import { guardedArm, type FairArm, type RawReply } from './fair-comparison-arms';
import { narrowToAnchor } from './fair-comparison-engines';
// The TypeScript-service core moved to ./typescript-service (WI-10006543) so the
// production callers path runs the code D-026 measured without importing this
// bench module. Re-exported here so the bench's own importers are unchanged.
import {
  dedupeSites as dedupe,
  hierarchyItems,
  identifierColumn,
  incomingCallSites,
  isExternalPath as isExternal,
  loadVendoredTypescript,
  openTsTree,
  tsDeclarations,
  tsSiteOf,
  type Ts,
  type TsTree,
} from './typescript-service';

export { identifierColumn, loadVendoredTypescript, openTsTree, type TsTree };

const joinNotes = (notes: readonly string[]): string | null => (notes.length > 0 ? notes.join('; ') : null);

// ─── lsp-query (first-party: the lsp:query engine) ───────────────────────────

/** The two lsp:query operations this arm uses, as the production adapter exposes them. */
export interface LspDoor {
  workspaceSymbols(q: { name: string; rootPath: string; anchor: string; limit: number }): Promise<CodeIntelAnswer>;
  references(q: { file: string; line1: number; character: number; rootPath: string }): Promise<CodeIntelAnswer>;
  /** Peak RSS of the language-server process tree, when the door can see it. */
  serverPeakRssKb?(): Promise<number | null>;
  close?(): Promise<void>;
}

export const LSP_QUERY_INTENTS: readonly FairIntent[] = ['definition', 'references', 'symbol-search'];
/** Far past any real answer (D-013 rule 2). The production facade caps at MAX_SITES_PER_ANSWER. */
export const LSP_QUERY_LIMIT = 100_000;
/** The adapter's empty-search caveat (symbolSearchEmptyCaveat): an empty answer, not a failure. */
const EMPTY_SYMBOL_SEARCH = /^no \w+ symbol named '/;

/**
 * Exact-name hits from one workspace-symbol answer. tsserver's search is fuzzy,
 * so only hits whose name equals the subject are kept (D-013 rule 1). An empty
 * search comes back as the adapter's caveat error and is read as an answer.
 */
export function symbolHits(a: CodeIntelAnswer, subject: string): { hits: SymbolSite[]; error: string | null; note: string | null } {
  if (a.error) {
    if (a.sites.length === 0 && EMPTY_SYMBOL_SEARCH.test(a.error)) return { hits: [], error: null, note: a.error.slice(0, 160) };
    return { hits: [], error: a.error, note: null };
  }
  const note = a.truncation.truncated ? `truncated by the engine: ${a.sites.length} of ${a.truncation.totalAvailable ?? 'unknown'}` : null;
  return { hits: a.sites.filter((s) => s.name === subject), error: null, note };
}

const readLineOf = async (absPath: string, line1: number): Promise<string> => (await readFile(absPath, 'utf8')).split('\n')[line1 - 1] ?? '';

/**
 * One case through lsp:query. definition and symbol-search are a workspace
 * symbol search. references first finds the declaration that way, then asks
 * textDocument/references with the cursor on the name, the way an agent does.
 */
export async function askLspQuery(
  door: LspDoor,
  kase: FairCase,
  treeRoot: string,
  readLine: (absPath: string, line1: number) => Promise<string> = readLineOf,
): Promise<RawReply> {
  const anchor = kase.anchorFile ? join(treeRoot, kase.anchorFile) : treeRoot;
  const found = symbolHits(await door.workspaceSymbols({ name: kase.subject, rootPath: treeRoot, anchor, limit: LSP_QUERY_LIMIT }), kase.subject);
  if (found.error !== null) return { sites: [], error: found.error };
  if (kase.intent === 'symbol-search') return { sites: found.hits, error: null, note: found.note };
  const decls = narrowToAnchor(kase, found.hits, (h) => h.path);
  if (kase.intent === 'definition') return { sites: decls, error: null, note: found.note };

  const notes = found.note ? [found.note] : [];
  const out: SymbolSite[] = [];
  for (const d of decls) {
    if (d.line1 === null) {
      notes.push(`${d.path}: symbol reported without a line`);
      continue;
    }
    const file = isAbsolute(d.path) ? d.path : join(treeRoot, d.path);
    const character = identifierColumn(await readLine(file, d.line1), kase.subject);
    if (character < 0) {
      notes.push(`${d.path}:${d.line1}: '${kase.subject}' is not on the symbol's line`);
      continue;
    }
    const refs = await door.references({ file, line1: d.line1, character, rootPath: treeRoot });
    if (refs.error) return { sites: [], error: refs.error };
    if (refs.truncation.truncated) notes.push(`references truncated by the engine at ${d.path}:${d.line1}`);
    out.push(...refs.sites);
  }
  return { sites: dedupe(out), error: null, note: joinNotes(notes) };
}

export interface LspQueryArmConfig {
  /** e.g. `typescript-language-server 6.0.0 / typescript 6.0.2`. */
  readonly version: string;
  readonly treeRoot: string;
  /**
   * Tree-relative file inside ONE tsconfig project, where the warm-up search
   * loads a project. Without it the warm-up anchors at the tree root, which the
   * adapter refuses on a tree with nested projects (the 2026-10-06 run: 113 of
   * them). That refusal aborted index(), so the arm answered no case at all.
   * Root-anchored refusals on individual cases stay a measured product property.
   */
  readonly warmupAnchor?: string;
  readonly loadAvg1?: () => number | null;
}

/** A name no tree defines: the warm-up search loads the project and proves readiness without answering anything. */
const WARMUP_SUBJECT = '__p017_fair_comparison_warmup__';

export function createLspQueryArm(cfg: LspQueryArmConfig, door: LspDoor, now?: () => number): FairArm {
  const capabilities: ArmCapabilities = { armId: 'lsp-query', version: cfg.version, intents: LSP_QUERY_INTENTS, licence: 'first-party' };
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    async index(): Promise<PhaseCost> {
      // lsp:query keeps no index of its own: "indexing" is starting the server
      // and loading the project behind the tree root.
      const t0 = performance.now();
      const anchor = cfg.warmupAnchor ? join(cfg.treeRoot, cfg.warmupAnchor) : cfg.treeRoot;
      const warm = symbolHits(
        await door.workspaceSymbols({ name: WARMUP_SUBJECT, rootPath: cfg.treeRoot, anchor, limit: 1 }),
        WARMUP_SUBJECT,
      );
      return {
        wallMs: performance.now() - t0,
        peakRssKb: (await door.serverPeakRssKb?.()) ?? null,
        ok: warm.error === null,
        error: warm.error,
        loadAvg1: cfg.loadAvg1?.() ?? null,
      };
    },
    ask: (kase) => askLspQuery(door, kase, cfg.treeRoot),
    ...(door.close ? { close: () => door.close!() } : {}),
  });
}

// ─── no-third-party (first-party: TypeScript LanguageService) ────────────────

export const NO_THIRD_PARTY_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact', 'definition', 'references', 'symbol-search'];

const itemId = (i: TsModule.CallHierarchyItem): string => `${i.file}#${i.selectionSpan.start}`;

/** One case through the LanguageService. Pure over an opened tree, so it is tested on the real micro repo. */
export function askTypescript(tree: TsTree, kase: FairCase): RawReply {
  // This program reads JS/TS only. Without admission, a foreign anchor has no
  // declaration and narrowToAnchor's same-name fallback searches unrelated
  // JS/TS homonyms (including expensive whole-tree reference queries). Keep
  // unsupported coverage explicit rather than answering a different question.
  if (kase.language && kase.language !== 'javascript' && kase.language !== 'typescript')
    return { sites: [], error: `declined: unsupported TypeScript LanguageService language '${kase.language}'` };
  const program = tree.service.getProgram();
  if (!program) return { sites: [], error: 'TypeScript produced no program for the tree' };
  const all = tsDeclarations(tree, program, kase.subject);
  if (kase.intent === 'symbol-search') return { sites: dedupe(all.map((d) => d.site)), error: null };
  const decls = narrowToAnchor(kase, all, (d) => d.site.path);
  const site = (fileName: string, pos: number, kind: string | null): SymbolSite => tsSiteOf(tree, program, fileName, pos, kind);
  switch (kase.intent) {
    case 'definition':
      return { sites: dedupe(decls.map((d) => d.site)), error: null };
    case 'references': {
      const out: SymbolSite[] = [];
      for (const d of decls) {
        for (const group of tree.service.findReferences(d.file, d.namePos) ?? []) {
          for (const ref of group.references) out.push(site(ref.fileName, ref.textSpan.start, null));
        }
      }
      return { sites: dedupe(out), error: null };
    }
    case 'callers': {
      // Raw answer: every call line (fromSpans). D-012 aliases extra lines in
      // one scope to that scope's unit. Shared with graph:query callers
      // (first-party-callers.ts), so the two cannot drift.
      return { sites: incomingCallSites(tree, program, decls), error: null };
    }
    case 'callees': {
      // A callee declared outside the tree (a default-lib or package method) is
      // neutral under D-012. Neutral sites carry no score, so omitting them is
      // score-equivalent; the count is kept in the note.
      const out: SymbolSite[] = [];
      let external = 0;
      for (const item of decls.flatMap((d) => hierarchyItems(tree, d))) {
        for (const call of tree.service.provideCallHierarchyOutgoingCalls(item.file, item.selectionSpan.start)) {
          const s = site(call.to.file, call.to.selectionSpan.start, call.to.kind);
          if (isExternal(s.path)) external += 1;
          else out.push(s);
        }
      }
      return { sites: dedupe(out), error: null, note: external > 0 ? `${external} callee(s) outside the tree omitted as neutral (D-012)` : null };
    }
    case 'impact': {
      // Upstream scopes to the case depth, each named by its declaration line.
      const depth = kase.depth ?? 2;
      let frontier = decls.flatMap((d) => hierarchyItems(tree, d));
      const seen = new Set(frontier.map(itemId));
      const out: SymbolSite[] = [];
      for (let level = 0; level < depth && frontier.length > 0; level += 1) {
        const next: TsModule.CallHierarchyItem[] = [];
        for (const item of frontier) {
          for (const call of tree.service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)) {
            if (seen.has(itemId(call.from))) continue;
            seen.add(itemId(call.from));
            out.push(site(call.from.file, call.from.selectionSpan.start, call.from.kind));
            next.push(call.from);
          }
        }
        frontier = next;
      }
      return { sites: dedupe(out), error: null };
    }
    default:
      return { sites: [], error: `declined: intent '${kase.intent}' is not a TypeScript LanguageService query` };
  }
}

export interface NoThirdPartyArmConfig {
  readonly treeRoot: string;
  /** The vendored TypeScript (loadVendoredTypescript), or the repo's own in tests. */
  readonly ts: Ts;
  readonly loadAvg1?: () => number | null;
}

export function createNoThirdPartyArm(cfg: NoThirdPartyArmConfig, now?: () => number): FairArm {
  const capabilities: ArmCapabilities = {
    armId: 'no-third-party',
    version: `typescript ${cfg.ts.version}`,
    intents: NO_THIRD_PARTY_INTENTS,
    licence: 'first-party',
  };
  let tree: TsTree | null = null;
  return guardedArm({
    capabilities,
    unavailable: null,
    ...(now ? { now } : {}),
    async index(): Promise<PhaseCost> {
      // In-process: peak RSS is this process's lifetime peak, so a run measures
      // one arm per process (the CLI does).
      const t0 = performance.now();
      let error: string | null = null;
      try {
        tree = openTsTree(cfg.ts, cfg.treeRoot);
        const program = tree.service.getProgram();
        if (!program) error = 'TypeScript produced no program for the tree';
        else program.getTypeChecker();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return { wallMs: performance.now() - t0, peakRssKb: process.resourceUsage().maxRSS, ok: error === null, error, loadAvg1: cfg.loadAvg1?.() ?? null };
    },
    async ask(kase) {
      if (!tree) return { sites: [], error: 'no-third-party: index() has not built the program' };
      return askTypescript(tree, kase);
    },
    async close() {
      tree?.service.dispose();
      tree = null;
    },
  });
}

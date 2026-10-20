import { z } from 'zod';
import { splitPlanSections } from './plan-sections';

/**
 * Plan declarations (plan-reuse-and-library-declarations-2026-10-20, D-001):
 * two plan-body sections, each holding one fenced JSON block, that state the
 * existing infrastructure a plan reuses and the third-party libraries it uses.
 * Same pattern as Product shaping (product-shaping.ts): the plan body is the
 * single source of truth, plans:new scaffolds the sections, plans:audit reports
 * schema problems by field path and the activation audit refuses a plan that
 * lacks a valid section. A plan with nothing to declare records a one-line
 * notApplicable reason instead of entries.
 */

export const REUSE_SECTION_HEADING = 'Existing infrastructure reused';
export const LIBRARIES_SECTION_HEADING = 'Third-party libraries';
export const REUSE_FENCE = 'reuse';
export const LIBRARIES_FENCE = 'libraries';

export const REUSE_REF_KINDS = ['file', 'symbol', 'tool', 'table', 'package', 'routine', 'doc'] as const;
export type ReuseRefKind = (typeof REUSE_REF_KINDS)[number];
export const LIBRARY_DECISIONS = ['owner-specified', 'already-in-project', 'skip-research', 'researched'] as const;
export type LibraryDecision = (typeof LIBRARY_DECISIONS)[number];

// Section descriptions written into the plan body by the scaffold. They describe
// what each section records (plan content), not agent identity, so they are
// phrased declaratively rather than as second-person instructions.
export const REUSE_SECTION_DESCRIPTION =
  'This section records the check for existing infrastructure made before anything new was designed, so nothing is duplicated. It names where the search looked (the code via lsp:query, graph:query and grep; the tool catalog via tools:find; the database via dev:pg_query describe; BORROWABLE.md; the docs) so a reviewer can judge the search. Each reused piece is listed by exact reference: a repo path, path#Symbol, tool name, schema.table, package, routine name or doc slug. Each new table, tool, service, routine or module the plan adds names the nearest existing thing and why it did not fit. A plan that builds nothing records a one-line notApplicable reason.';

export const LIBRARIES_SECTION_DESCRIPTION =
  'This section lists each need a third-party library could meet, one row per need, with how the library was chosen. No research is needed when the owner already named the library (owner-specified: sourceRef cites the owner turn), when the project already uses a library for this (already-in-project: package names it and existingUse says where it is used), or when the job is small or no suitable library is expected (skip-research: reason gives one line why). Research only when a library would remove a lot of work and fits the use case: the realistic options are compared, one is picked, and the runners-up are recorded with why (researched). A second library is never added for a job an existing dependency already does. A plan that needs no library records a one-line notApplicable reason.';

const required = (max = 2000) => z.string().trim().min(1, 'must not be empty').max(max);
// Genuinely optional: a hand-written row may omit the key (P-010 E2E found an already-in-project
// row with no `reason` refused as "expected string, received undefined"). Rules that need the value
// (a package for every non-skip-research row, a reason for skip-research) live in the superRefine.
const optionalText = (max = 2000) => z.string().trim().max(max).optional();
const notApplicable = z.string().trim().min(1, 'must be a one-line reason or null').max(500).nullable();
const OWNER_TURN_RE = /^session_turn:(claude|codex|omp|agent_chat):[^\s:]+:\d+$/;
const PLAN_ITEM_RE = /^P-\d{3,}$/;

export const reuseDeclarationSchema = z.object({
  searched: z.array(z.object({
    where: required(500),
    how: required(500),
    found: optionalText(1000),
  }).strict()).max(40),
  reused: z.array(z.object({
    ref: required(500),
    kind: z.enum(REUSE_REF_KINDS),
    provides: required(1000),
    items: z.array(z.string().regex(PLAN_ITEM_RE, 'must be a plan item id like P-001')).max(50).optional(),
  }).strict()).max(100),
  newSurfaces: z.array(z.object({
    name: required(300),
    kind: required(100),
    nearestExisting: required(500),
    whyNotReused: required(1000),
  }).strict()).max(50),
  notApplicable,
}).strict().superRefine((value, ctx) => {
  if (value.notApplicable !== null) return;
  if (value.searched.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['searched'],
      message: 'record at least one place you searched, or set notApplicable to a one-line reason' });
  }
  if (value.reused.length === 0 && value.newSurfaces.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reused'],
      message: 'list what you reuse or the new surfaces you add, or set notApplicable to a one-line reason' });
  }
});
export type ReuseDeclaration = z.infer<typeof reuseDeclarationSchema>;

export const librariesDeclarationSchema = z.object({
  needs: z.array(z.object({
    need: required(500),
    decision: z.enum(LIBRARY_DECISIONS),
    package: optionalText(214),
    reason: optionalText(1000),
    sourceRef: z.string().trim().max(500).nullable().optional(),
    existingUse: z.string().trim().max(500).nullable().optional(),
    candidates: z.array(z.object({
      name: required(214),
      verdict: z.enum(['chosen', 'rejected']),
      why: required(1000),
    }).strict()).max(10).optional(),
  }).strict().superRefine((row, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (row.decision !== 'skip-research' && !row.package) issue('package', `a ${row.decision} row must name the package`);
    if (row.decision === 'owner-specified' && !OWNER_TURN_RE.test(row.sourceRef ?? '')) {
      issue('sourceRef', 'an owner-specified row must cite the owner turn as session_turn:<kind>:<session>:<turn>');
    }
    if (row.decision === 'already-in-project' && !row.existingUse?.trim()) {
      issue('existingUse', 'an already-in-project row must say where the package is used today');
    }
    if (row.decision === 'skip-research' && !row.reason) issue('reason', 'a skip-research row needs a one-line reason');
    if (row.decision === 'researched') {
      const candidates = row.candidates ?? [];
      if (!candidates.some((c) => c.verdict === 'chosen' && c.name === row.package)) {
        issue('candidates', 'a researched row must list its package as the chosen candidate');
      }
      if (!candidates.some((c) => c.verdict === 'rejected') && !row.reason) {
        issue('candidates', 'a researched row needs at least one rejected runner-up, or a reason there is no alternative');
      }
    }
  })).max(50),
  notApplicable,
}).strict().superRefine((value, ctx) => {
  if (value.notApplicable === null && value.needs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['needs'],
      message: 'list at least one need, or set notApplicable to a one-line reason' });
  }
});
export type LibrariesDeclaration = z.infer<typeof librariesDeclarationSchema>;

export interface PlanDeclarationDiagnostic {
  code:
    | 'declaration_section_missing'
    | 'declaration_section_ambiguous'
    | 'declaration_block_missing_or_ambiguous'
    | 'declaration_invalid_json'
    | 'declaration_invalid';
  section: string;
  /** Dotted field path inside the JSON block (`needs.0.sourceRef`), or the section ref. */
  path: string;
  message: string;
}

export type DeclarationStatus = 'missing' | 'invalid' | 'not-applicable' | 'declared';

export interface DeclarationPreview<T> {
  status: DeclarationStatus;
  data: T | null;
  diagnostics: PlanDeclarationDiagnostic[];
}

export interface PlanDeclarationsPreview {
  ok: boolean;
  reuse: DeclarationPreview<ReuseDeclaration>;
  libraries: DeclarationPreview<LibrariesDeclaration>;
  diagnostics: PlanDeclarationDiagnostic[];
}

function previewSection<T extends { notApplicable: string | null }>(
  planContent: string,
  heading: string,
  fence: string,
  schema: z.ZodType<T>,
): DeclarationPreview<T> {
  const diagnostics: PlanDeclarationDiagnostic[] = [];
  const sectionRef = `section:${heading}`;
  const add = (code: PlanDeclarationDiagnostic['code'], path: string, message: string) =>
    diagnostics.push({ code, section: heading, path, message });
  const sections = splitPlanSections(planContent).filter((section) => section.level === 2 && section.heading === heading);
  if (sections.length === 0) {
    add('declaration_section_missing', sectionRef, `Add a "## ${heading}" section with one \`\`\`${fence} JSON block (plans:new scaffolds it).`);
    return { status: 'missing', data: null, diagnostics };
  }
  if (sections.length > 1) {
    add('declaration_section_ambiguous', sectionRef, `Keep exactly one "## ${heading}" section.`);
    return { status: 'invalid', data: null, diagnostics };
  }
  const fenceRe = new RegExp('^```' + fence + '\\s*\\n([\\s\\S]*?)\\n```\\s*$', 'gm');
  const blocks = [...sections[0]!.body.matchAll(fenceRe)];
  if (blocks.length !== 1) {
    add('declaration_block_missing_or_ambiguous', sectionRef, `Author exactly one \`\`\`${fence} JSON block in "## ${heading}".`);
    return { status: 'invalid', data: null, diagnostics };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0]![1]!);
  } catch (error) {
    add('declaration_invalid_json', sectionRef, `Repair the malformed ${fence} JSON (${error instanceof Error ? error.message : String(error)}).`);
    return { status: 'invalid', data: null, diagnostics };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 25)) {
      add('declaration_invalid', issue.path.length ? issue.path.join('.') : sectionRef, issue.message);
    }
    return { status: 'invalid', data: null, diagnostics };
  }
  return { status: parsed.data.notApplicable !== null ? 'not-applicable' : 'declared', data: parsed.data, diagnostics };
}

/**
 * Structural check of both declaration sections. Pure: it reads only the plan
 * body. Reference resolution and dependency checks are separate (they need the
 * tree, the tool registry and the database).
 */
export function previewPlanDeclarations(planContent: string): PlanDeclarationsPreview {
  const reuse = previewSection(planContent, REUSE_SECTION_HEADING, REUSE_FENCE, reuseDeclarationSchema);
  const libraries = previewSection(planContent, LIBRARIES_SECTION_HEADING, LIBRARIES_FENCE, librariesDeclarationSchema);
  const diagnostics = [...reuse.diagnostics, ...libraries.diagnostics];
  return { ok: diagnostics.length === 0, reuse, libraries, diagnostics };
}

/**
 * Plan statuses the activation gate applies to (R-3, D-003). Plans already
 * active or shipped are not retrofitted: they re-audit activation without
 * declaration sections exactly as before.
 */
export const DECLARATION_GATED_PLAN_STATUSES: ReadonlySet<string> = new Set(['draft', 'ready']);

export interface ActivationDeclarationBlocker {
  code: 'plan_declarations_invalid';
  section: string;
  status: DeclarationStatus;
  detail: string;
}

export interface ActivationDeclarationGate {
  /** False for a plan outside DECLARATION_GATED_PLAN_STATUSES (no retrofit); true for a plan with no status. */
  applies: boolean;
  /** True when the gate does not apply or both sections are declared / not applicable. */
  ok: boolean;
  preview: PlanDeclarationsPreview;
  blockers: ActivationDeclarationBlocker[];
}

/**
 * The activation gate's verdict on the two declaration sections (R-3). Shared
 * by plans:audit phase:activation (which refuses on it) and the activation
 * readiness preview (which lists the same blockers), so the two cannot disagree.
 */
export function evaluateActivationDeclarations(
  planContent: string,
  planStatus: string | null | undefined,
): ActivationDeclarationGate {
  const preview = previewPlanDeclarations(planContent);
  // D-013 #1: a plan with no recorded status is gated (fail closed), never waved through.
  const applies = planStatus == null || planStatus === '' || DECLARATION_GATED_PLAN_STATUSES.has(planStatus);
  const blockers = [
    { heading: REUSE_SECTION_HEADING, section: preview.reuse },
    { heading: LIBRARIES_SECTION_HEADING, section: preview.libraries },
  ]
    .filter(({ section }) => section.status === 'missing' || section.status === 'invalid')
    .map(({ heading, section }) => ({
      code: 'plan_declarations_invalid' as const,
      section: heading,
      status: section.status,
      detail: section.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; '),
    }));
  return { applies, ok: !applies || blockers.length === 0, preview, blockers };
}

// ── Reference resolver (R-4, D-002, D-004 #2, D-013 #2) ─────────────────────
//
// Each reuse entry must name something that exists. The resolver itself is pure:
// every lookup is injected (plan-declaration-resolvers.ts builds the production
// set), so a test can prove each kind's present and absent case and the audit
// can prove that a down backend reports "unverified" instead of refusing. Only a
// DEFINITIVE not-found (or a reference that is not in its kind's exact form)
// refuses activation. Exported for the per-item anchors proposed in rpt_63d990a4.

/** One reuse reference, split into the parts its kind's lookup needs. */
export interface ParsedReuseRef {
  kind: ReuseRefKind;
  ref: string;
  /** file / symbol: the repo-relative path (no leading `./`, no trailing `/`). */
  path?: string;
  /** symbol: the name after `#` (`Class.method` allowed). */
  symbol?: string;
  /** table: schema and relation. */
  schema?: string;
  table?: string;
  /** tool / package / routine / doc: the normalised lookup name. */
  name?: string;
}

export type ReferenceLookup =
  | { outcome: 'found'; via: string }
  | { outcome: 'not-found'; via: string }
  | { outcome: 'unavailable'; reason: string };

export type ReuseReferenceResolver = (ref: ParsedReuseRef) => Promise<ReferenceLookup>;
export type ReuseReferenceResolvers = Partial<Record<ReuseRefKind, ReuseReferenceResolver>>;

export type ReuseReferenceStatus = 'found' | 'not-found' | 'malformed' | 'unverified';

export interface ReuseReferenceCheck {
  ref: string;
  kind: ReuseRefKind;
  status: ReuseReferenceStatus;
  detail: string;
}

export interface ReuseReferenceBlocker {
  code: 'reuse_reference_unresolved' | 'reuse_item_unknown';
  ref: string;
  kind: ReuseRefKind;
  detail: string;
}

export interface ReuseReferenceReport {
  ok: boolean;
  checks: ReuseReferenceCheck[];
  blockers: ReuseReferenceBlocker[];
  /** Refs whose lookup backend was unavailable: recorded, never refused. */
  unverified: string[];
}

const REPO_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s#]+$/;
const SYMBOL_NAME_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+(?:[:.][A-Za-z0-9_-]+)+$/;
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/;
const ROUTINE_NAME_RE = /^[^\s]{1,200}$/;
const DOC_SLUG_RE = /^[a-z0-9][a-z0-9/_.-]*$/i;

/**
 * Package-name normalisation (D-013 #3): a subpath import names its package
 * (`lodash/fp` → `lodash`, `@scope/pkg/sub` → `@scope/pkg`). Shared with the
 * library checks (R-5) and the ship check (R-6) so all three match identically.
 */
export function normalisePackageName(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('@')) {
    const [scope, name] = value.split('/');
    return name ? `${scope}/${name}` : value;
  }
  return value.split('/')[0] ?? value;
}

function cleanRepoPath(value: string): string {
  return value.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Split a reference into its kind's exact form, or explain why it is not in it. */
export function parseReuseRef(kind: ReuseRefKind, rawRef: string): { ok: true; parsed: ParsedReuseRef } | { ok: false; detail: string } {
  const ref = rawRef.trim();
  const fail = (detail: string) => ({ ok: false as const, detail });
  switch (kind) {
    case 'file': {
      const p = cleanRepoPath(ref);
      if (!p || !REPO_PATH_RE.test(p)) return fail('a file entry must be a repo-relative path (no #, no leading /, no ..)');
      return { ok: true, parsed: { kind, ref, path: p } };
    }
    case 'symbol': {
      const hash = ref.indexOf('#');
      if (hash <= 0 || hash !== ref.lastIndexOf('#')) return fail('a symbol entry must be path#Symbol');
      const p = cleanRepoPath(ref.slice(0, hash));
      const symbol = ref.slice(hash + 1).trim();
      if (!REPO_PATH_RE.test(p)) return fail('the path before # must be repo-relative (no leading /, no ..)');
      if (!SYMBOL_NAME_RE.test(symbol)) return fail('the name after # must be an identifier such as fooBar or Class.method');
      return { ok: true, parsed: { kind, ref, path: p, symbol } };
    }
    case 'tool':
      if (!TOOL_NAME_RE.test(ref)) return fail('a tool entry must be the tool name, e.g. plans:audit');
      return { ok: true, parsed: { kind, ref, name: ref } };
    case 'table': {
      const parts = ref.split('.');
      if (parts.length !== 2 || !parts.every((part) => SQL_IDENT_RE.test(part))) return fail('a table entry must be schema.table');
      return { ok: true, parsed: { kind, ref, schema: parts[0], table: parts[1] } };
    }
    case 'package': {
      const name = normalisePackageName(ref);
      if (!PACKAGE_NAME_RE.test(name)) return fail('a package entry must be a package or crate name');
      return { ok: true, parsed: { kind, ref, name } };
    }
    case 'routine':
      if (!ROUTINE_NAME_RE.test(ref)) return fail('a routine entry must be the routine name (no spaces)');
      return { ok: true, parsed: { kind, ref, name: ref } };
    case 'doc': {
      const slug = ref.replace(/^\/?internal\/docs\//, '').replace(/^\/+|\/+$/g, '');
      if (!DOC_SLUG_RE.test(slug)) return fail('a doc entry must be the doc slug, e.g. agent-insights/derived-truth-ladder');
      return { ok: true, parsed: { kind, ref, name: slug } };
    }
  }
}

const RESOLVE_CONCURRENCY = 8;

/**
 * Resolve every reuse entry (and check each entry's `items` names a P-NNN item of
 * this plan). A missing resolver for a kind, or a resolver that throws, is an
 * unavailable backend: the entry is unverified, never refused.
 */
export async function resolveReuseReferences(
  declaration: ReuseDeclaration,
  options: { resolvers: ReuseReferenceResolvers; planItemIds: ReadonlySet<string> },
): Promise<ReuseReferenceReport> {
  const checks: ReuseReferenceCheck[] = new Array(declaration.reused.length);
  const blockers: ReuseReferenceBlocker[] = [];
  const resolveOne = async (index: number): Promise<void> => {
    const entry = declaration.reused[index]!;
    const parsed = parseReuseRef(entry.kind, entry.ref);
    if (!parsed.ok) {
      checks[index] = { ref: entry.ref, kind: entry.kind, status: 'malformed', detail: parsed.detail };
      return;
    }
    const resolver = options.resolvers[entry.kind];
    let lookup: ReferenceLookup;
    try {
      lookup = resolver ? await resolver(parsed.parsed) : { outcome: 'unavailable', reason: `no ${entry.kind} lookup is configured` };
    } catch (error) {
      lookup = { outcome: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
    }
    checks[index] = lookup.outcome === 'unavailable'
      ? { ref: entry.ref, kind: entry.kind, status: 'unverified', detail: lookup.reason }
      : { ref: entry.ref, kind: entry.kind, status: lookup.outcome, detail: lookup.via };
  };
  for (let start = 0; start < declaration.reused.length; start += RESOLVE_CONCURRENCY) {
    const batch = declaration.reused.slice(start, start + RESOLVE_CONCURRENCY).map((_, offset) => resolveOne(start + offset));
    await Promise.all(batch);
  }
  for (const check of checks) {
    if (check.status === 'not-found' || check.status === 'malformed') {
      blockers.push({
        code: 'reuse_reference_unresolved',
        ref: check.ref,
        kind: check.kind,
        detail: check.status === 'malformed' ? check.detail : `${check.kind} not found (${check.detail})`,
      });
    }
  }
  declaration.reused.forEach((entry) => {
    for (const item of entry.items ?? []) {
      if (!options.planItemIds.has(item)) {
        blockers.push({ code: 'reuse_item_unknown', ref: entry.ref, kind: entry.kind, detail: `${item} is not an item of this plan` });
      }
    }
  });
  return {
    ok: blockers.length === 0,
    checks,
    blockers,
    unverified: checks.filter((check) => check.status === 'unverified').map((check) => check.ref),
  };
}

// ── Library checks (R-5, D-004 #4/#6, D-013 #3) ─────────────────────────────
//
// The schema already enforces each decision's shape (owner-specified cites a turn,
// researched lists its chosen package and a runner-up or a reason). These checks
// add the facts the schema cannot see: an already-in-project package must be a
// dependency some workspace manifest declares, and an owner-specified sourceRef
// must be an owner-typed turn. Lookups are injected; an unavailable one leaves the
// row unverified, never refused.

export interface LibraryCheckDeps {
  /** Workspace dependency index (workspace-manifests.ts); null when the manifests could not be read. */
  packages: { isDependency(name: string): boolean } | null;
  /** Classifies session_turn refs; refs absent from the map were not found. Null when the turn ledger is unavailable. */
  ownerTurns: ((refs: readonly string[]) => Promise<Map<string, 'owner' | 'not-owner'>>) | null;
  /** Declared dependencies' package descriptions, for the researched-row advice. */
  dependencyDescriptions?: (() => Promise<ReadonlyMap<string, string>>) | null;
}

export interface LibraryCheckBlocker {
  code: 'library_not_a_dependency' | 'library_owner_turn_unresolved';
  row: number;
  need: string;
  detail: string;
}

export interface LibraryCheckReport {
  ok: boolean;
  blockers: LibraryCheckBlocker[];
  /** `needs.N` paths whose lookup was unavailable: recorded, never refused. */
  unverified: string[];
  /** Researched rows: existing dependencies whose description shares words with the need (advice only). */
  advice: Array<{ row: number; need: string; existingDependencies: string[] }>;
}

const ADVICE_STOPWORDS = new Set(['with', 'from', 'into', 'that', 'this', 'than', 'then', 'them', 'they', 'their', 'what', 'when', 'which', 'library', 'package', 'support', 'using', 'based', 'simple', 'small', 'fast']);
const adviceWords = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((word) => !ADVICE_STOPWORDS.has(word)));

export async function checkLibraryDeclarations(declaration: LibrariesDeclaration, deps: LibraryCheckDeps): Promise<LibraryCheckReport> {
  const blockers: LibraryCheckBlocker[] = [];
  const unverified: string[] = [];
  const advice: LibraryCheckReport['advice'] = [];
  const rows = declaration.needs.map((row, index) => ({ row, index }));

  for (const { row, index } of rows.filter(({ row }) => row.decision === 'already-in-project')) {
    const name = normalisePackageName(row.package ?? '');
    if (!deps.packages) { unverified.push(`needs.${index}`); continue; }
    if (!deps.packages.isDependency(name)) {
      blockers.push({ code: 'library_not_a_dependency', row: index, need: row.need,
        detail: `${name} is not a dependency of any workspace manifest; use researched or skip-research for a new package` });
    }
  }

  const ownerRows = rows.filter(({ row }) => row.decision === 'owner-specified');
  if (ownerRows.length > 0) {
    let verdicts: Map<string, 'owner' | 'not-owner'> | null = null;
    try {
      verdicts = deps.ownerTurns ? await deps.ownerTurns(ownerRows.map(({ row }) => row.sourceRef ?? '')) : null;
    } catch {
      verdicts = null;
    }
    for (const { row, index } of ownerRows) {
      if (!verdicts) { unverified.push(`needs.${index}`); continue; }
      const verdict = verdicts.get(row.sourceRef ?? '');
      if (verdict !== 'owner') {
        blockers.push({ code: 'library_owner_turn_unresolved', row: index, need: row.need,
          detail: verdict === 'not-owner'
            ? `${row.sourceRef} is not an owner-typed turn`
            : `${row.sourceRef} was not found in the turn ledger` });
      }
    }
  }

  const researched = rows.filter(({ row }) => row.decision === 'researched');
  if (researched.length > 0 && deps.dependencyDescriptions) {
    const descriptions = await deps.dependencyDescriptions().catch(() => null);
    if (descriptions) {
      for (const { row, index } of researched) {
        const words = adviceWords(row.need);
        const chosen = normalisePackageName(row.package ?? '');
        const existingDependencies = [...descriptions]
          .filter(([name, description]) => name !== chosen && [...adviceWords(description)].some((word) => words.has(word)))
          .map(([name]) => name)
          .sort()
          .slice(0, 5);
        if (existingDependencies.length > 0) advice.push({ row: index, need: row.need, existingDependencies });
      }
    }
  }

  return { ok: blockers.length === 0, blockers, unverified, advice };
}

export function reuseDeclarationScaffold(): string {
  const draft = {
    searched: [{ where: '', how: '', found: '' }],
    reused: [{ ref: '', kind: REUSE_REF_KINDS.join(' | '), provides: '', items: [] }],
    newSurfaces: [{ name: '', kind: '', nearestExisting: '', whyNotReused: '' }],
    notApplicable: null,
  };
  return `## ${REUSE_SECTION_HEADING}\n\n${REUSE_SECTION_DESCRIPTION}\n\n\`\`\`${REUSE_FENCE}\n${JSON.stringify(draft, null, 2)}\n\`\`\``;
}

export function librariesDeclarationScaffold(): string {
  const draft = {
    needs: [{
      need: '', decision: LIBRARY_DECISIONS.join(' | '), package: '', reason: '',
      sourceRef: null, existingUse: null, candidates: [{ name: '', verdict: 'chosen | rejected', why: '' }],
    }],
    notApplicable: null,
  };
  return `## ${LIBRARIES_SECTION_HEADING}\n\n${LIBRARIES_SECTION_DESCRIPTION}\n\n\`\`\`${LIBRARIES_FENCE}\n${JSON.stringify(draft, null, 2)}\n\`\`\``;
}

/** Both scaffolds, in plan order: reuse first, then libraries. */
export function planDeclarationsScaffold(): string {
  return `${reuseDeclarationScaffold()}\n\n${librariesDeclarationScaffold()}`;
}

const WALKTHROUGH_FIELD_MAX = 300;
const clip = (value: string) => (value.length > WALKTHROUGH_FIELD_MAX ? value.slice(0, WALKTHROUGH_FIELD_MAX - 1) + '…' : value);

/**
 * Owner-walkthrough lines for the approval read (R-7): every reuse entry, every
 * new surface with why nothing existing fit, and every library row with its
 * decision. Rendered from the parsed blocks, so it cannot drift from them.
 */
export function renderDeclarationsWalkthrough(preview: PlanDeclarationsPreview): string[] {
  const lines: string[] = [];
  const reuse = preview.reuse;
  if (reuse.status === 'not-applicable') {
    lines.push(`**Reuses:** nothing (${clip(reuse.data!.notApplicable!)})`);
  } else if (reuse.data) {
    if (reuse.data.reused.length) {
      lines.push('**Reuses:**', ...reuse.data.reused.map((entry) => `- \`${clip(entry.ref)}\` (${entry.kind}) — ${clip(entry.provides)}`));
    }
    if (reuse.data.newSurfaces.length) {
      lines.push('**New surfaces:**', ...reuse.data.newSurfaces.map((surface) =>
        `- ${clip(surface.name)} (${clip(surface.kind)}) — nearest existing: ${clip(surface.nearestExisting)}; not reused because: ${clip(surface.whyNotReused)}`));
    }
  } else {
    lines.push(`**Reuses:** not declared (${reuse.status})`);
  }
  const libraries = preview.libraries;
  if (libraries.status === 'not-applicable') {
    lines.push(`**Libraries:** none (${clip(libraries.data!.notApplicable!)})`);
  } else if (libraries.data) {
    lines.push('**Libraries:**', ...libraries.data.needs.map((row) =>
      `- ${clip(row.need)}: ${row.decision}${row.package ? ` \`${clip(row.package)}\`` : ''}${row.reason ? ` — ${clip(row.reason)}` : ''}`));
  } else {
    lines.push(`**Libraries:** not declared (${libraries.status})`);
  }
  return lines;
}

export interface PlanDeclarationsRegressionAdvisory {
  advisory: true;
  sections: Array<{ heading: string; before: DeclarationStatus; after: DeclarationStatus }>;
  diagnostics: PlanDeclarationDiagnostic[];
  next: string;
}

const parses = (status: DeclarationStatus) => status === 'declared' || status === 'not-applicable';

/**
 * Advisory for an edit of an existing plan (plans:edit, plans:set-content): only
 * when the write removes or breaks a declaration section that parsed before, so
 * edits to older plans that never had the sections stay quiet. The write lands.
 */
export function planDeclarationsRegressionAdvisory(
  before: string,
  after: string,
): PlanDeclarationsRegressionAdvisory | null {
  const prior = previewPlanDeclarations(before);
  const next = previewPlanDeclarations(after);
  const regressed = [
    { heading: REUSE_SECTION_HEADING, prior: prior.reuse, next: next.reuse },
    { heading: LIBRARIES_SECTION_HEADING, prior: prior.libraries, next: next.libraries },
  ].filter((pair) => parses(pair.prior.status) && !parses(pair.next.status));
  if (regressed.length === 0) return null;
  return {
    advisory: true,
    sections: regressed.map((pair) => ({ heading: pair.heading, before: pair.prior.status, after: pair.next.status })),
    diagnostics: regressed.flatMap((pair) => pair.next.diagnostics).slice(0, 5),
    next: 'Write accepted, but it removed or broke a declaration section that parsed before; activation of a draft or ready plan refuses until it parses again.',
  };
}

/**
 * Advisory for a plan content write or edit: when either declaration section is
 * missing or invalid the write still succeeds, and its response says so with the
 * scaffold. Null once both sections parse.
 */
export function planDeclarationsWriteAdvisory(content: string) {
  const preview = previewPlanDeclarations(content);
  if (preview.ok) return null;
  const missing = [preview.reuse, preview.libraries]
    .map((section, index) => ({ section, heading: index === 0 ? REUSE_SECTION_HEADING : LIBRARIES_SECTION_HEADING }))
    .filter(({ section }) => section.status === 'missing' || section.status === 'invalid');
  return {
    advisory: true as const,
    sections: missing.map(({ heading, section }) => ({ heading, status: section.status })),
    diagnostics: preview.diagnostics.slice(0, 5),
    scaffold: missing.some(({ section }) => section.status === 'missing') ? planDeclarationsScaffold() : null,
    next: 'Write accepted. The activation audit refuses a plan without valid "## Existing infrastructure reused" and "## Third-party libraries" sections; fill them in (or record a notApplicable reason).',
  };
}

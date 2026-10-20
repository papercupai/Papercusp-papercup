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

export const REUSE_DECLARATION_GUIDANCE =
  'Before designing anything new, check what already exists and reuse it instead of duplicating it. Look in the code (lsp:query, graph:query, grep), the tool catalog (tools:find), the database (dev:pg_query describe), BORROWABLE.md and the docs. List each piece you will reuse by exact reference: a repo path, path#Symbol, tool name, schema.table or package. Record where you searched so a reviewer can judge the search. For every new table, tool, service, routine or module you add, name the nearest existing thing and why it did not fit. A plan that builds nothing records a one-line notApplicable reason.';

export const LIBRARIES_DECLARATION_GUIDANCE =
  'List each need where a third-party library could do the work, one row per need, with how you decided. Do not research when the owner already named the library (owner-specified: cite the owner turn in sourceRef), when the project already uses a library for this (already-in-project: name the package and where it is used in existingUse), or when the job is small or you expect no suitable library (skip-research: one line why in reason). Research only when a library would remove a lot of work and fits the use case: compare the realistic options, pick one, and record the runners-up and why (researched). Never add a second library for a job an existing dependency already does. A plan that needs no library records a one-line notApplicable reason.';

const required = (max = 2000) => z.string().trim().min(1, 'must not be empty').max(max);
const optionalText = (max = 2000) => z.string().trim().max(max);
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
  /** False for a plan outside DECLARATION_GATED_PLAN_STATUSES (no retrofit). */
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
  const applies = planStatus != null && DECLARATION_GATED_PLAN_STATUSES.has(planStatus);
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

export function reuseDeclarationScaffold(): string {
  const draft = {
    searched: [{ where: '', how: '', found: '' }],
    reused: [{ ref: '', kind: REUSE_REF_KINDS.join(' | '), provides: '', items: [] }],
    newSurfaces: [{ name: '', kind: '', nearestExisting: '', whyNotReused: '' }],
    notApplicable: null,
  };
  return `## ${REUSE_SECTION_HEADING}\n\n${REUSE_DECLARATION_GUIDANCE}\n\n\`\`\`${REUSE_FENCE}\n${JSON.stringify(draft, null, 2)}\n\`\`\``;
}

export function librariesDeclarationScaffold(): string {
  const draft = {
    needs: [{
      need: '', decision: LIBRARY_DECISIONS.join(' | '), package: '', reason: '',
      sourceRef: null, existingUse: null, candidates: [{ name: '', verdict: 'chosen | rejected', why: '' }],
    }],
    notApplicable: null,
  };
  return `## ${LIBRARIES_SECTION_HEADING}\n\n${LIBRARIES_DECLARATION_GUIDANCE}\n\n\`\`\`${LIBRARIES_FENCE}\n${JSON.stringify(draft, null, 2)}\n\`\`\``;
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

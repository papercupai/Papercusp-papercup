/**
 * identity-surface-census — a script-derived inventory of every behavior-shaping
 * surface that sits OUTSIDE the identity system
 * (identity-system-everything-migration-2026-10-18 P-001; it seeds the P-005
 * shrink-only lint, R-16).
 *
 * WHAT IT COUNTS. Four classes, each DERIVED from a source of truth that already
 * exists, never from a hand-kept list (derived-truth ladder, rung 1):
 *
 *   flat-role-prompt  prompt markdown that is not an identity document:
 *                     - `blueprints/base/prompts/*.md`, classified by the existing
 *                       `BASE_ROLE_LIBRARY_DISPOSITION` table (its own test pins it
 *                       to the directory both ways); the kernel base text, sidecars
 *                       and the derived su PART documents are identity-system
 *                       documents and are skipped;
 *                     - `blueprints/<id>/prompts/*.md` of every blueprint whose
 *                       `blueprint.yaml` lacks the top-level `slots:` key (the
 *                       identity discriminator, identities-v1 D-013);
 *                     - `apps/operator/prompts/**\/*.md`, except the human tutorial
 *                       chapters, READMEs and `pot-instances/` (the reserved
 *                       `instance` tier of the identity stack).
 *   prompt-constant   a top-level UPPER_SNAKE `const` in non-test TypeScript whose
 *                     statically-known text is ≥ 300 chars and either addresses the
 *                     reader in the second person at least twice or carries a
 *                     prompt-shaped name (`*_PROMPT`, `*_SYSTEM`, `*_NUDGE`, …).
 *   injection-hook    every installed client hook ENTRYPOINT (`CC_HOOK_FILES`
 *                     minus `CC_HOOK_LIB_FILES` minus the status line) and every
 *                     OMP hook module, with a deterministic `kind` (see
 *                     {@link classifyHookSource}). `identity-dispatch` hooks are the
 *                     identity system's own delivery path and are recorded but
 *                     marked inside.
 *   kernel-splice     every distinct `<!-- PAPERCUSP-SU:… -->` splice marker in a
 *                     SOURCE prompt (derived part documents are skipped so a marker
 *                     is counted once, at its source).
 *
 * WHAT IT RECORDS. Identity only — class, id, path, name, kind — never a content
 * hash or a byte count. The inventory answers "which surfaces exist", which is
 * exactly what a shrink-only lint needs, and editing a prompt's TEXT must not churn
 * it (a census that moves on every prose edit reds the fleet gate for nothing).
 *
 * KNOWN LIMITS (stated so a reader does not over-trust the count): a prompt built
 * inside a function body, a lower-case `const`, or prose assembled from computed
 * values is not a `prompt-constant`; the judge mission briefs (P-007) and the Scout
 * lenses (P-011) are migrated by their own items. The hook `kind` is a lexical
 * classification of the entrypoint's own source.
 *
 * su RENDER PARITY. Per plan decision
 * identity-system-everything-migration-2026-10-18#D-008 this census does NOT render
 * a second su baseline: the su prompt's parity baseline is IDOP's frozen render
 * (identity-definitions-own-policy-2026-10-17#P-001), recorded as pending until it
 * exists ({@link SU_RENDER_PARITY_BASELINE}).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { moduleRepoRoot } from '../module-repo-root';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { BASE_ROLE_LIBRARY_DISPOSITION, CLIENT_SEAM_MARKER, SU_PART_DOCUMENTS } from '@papercusp/orchestrator/blueprint';
import { CC_HOOK_FILES, CC_HOOK_LIB_FILES } from '../desktop-install/papercusp-files';

export const IDENTITY_SURFACE_CLASSES = ['flat-role-prompt', 'prompt-constant', 'injection-hook', 'kernel-splice'] as const;
export type IdentitySurfaceClass = (typeof IDENTITY_SURFACE_CLASSES)[number];

export const HOOK_KINDS = ['identity-dispatch', 'guard', 'context', 'plumbing'] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

export interface IdentitySurfaceEntry {
  class: IdentitySurfaceClass;
  /** Stable key: `<class>:<path>` or `<class>:<path>#<name>`. */
  id: string;
  /** Superproject-relative POSIX path. */
  path: string;
  /** Constant name or splice-marker name. */
  name?: string;
  /** Sub-classification: the role-library disposition, the prompt home, the hook kind, or the constant's matching signal. */
  kind: string;
  /** True when the surface is already the identity system's own path (recorded for completeness, never a migration target). */
  inside?: true;
}

export interface IdentitySurfaceCensus {
  schemaVersion: 1;
  /** The command that regenerates the checked-in inventory. */
  generator: string;
  suRenderParityBaseline: string;
  counts: Record<IdentitySurfaceClass, number>;
  hookKinds: Record<HookKind, number>;
  entries: IdentitySurfaceEntry[];
}

export const IDENTITY_SURFACE_CENSUS_GENERATOR = 'npm run gen:identity-surface-census';
/** Superproject-relative path of the checked-in inventory. */
export const IDENTITY_SURFACE_CENSUS_REL = 'packages/operator-core/lib/agent-identities/identity-surface-census.generated.json';
/** D-008: the su prompt's parity baseline is IDOP's frozen render, not a second one rendered here. */
export const SU_RENDER_PARITY_BASELINE =
  'docs/evidence/idop-p001-baseline-2026-10-22.json#base (identity-definitions-own-policy-2026-10-17#P-001)';

const SUBMODULE = 'libs/papercusp';
const HARNESS_REL = `${SUBMODULE}/packages/harness`;
const BLUEPRINTS_REL = `${HARNESS_REL}/blueprints`;
const OPERATOR_PROMPTS_REL = 'apps/operator/prompts';
const CC_HOOKS_REL = 'apps/operator/scripts/hooks/cc';
const OMP_HOOKS_REL = 'apps/operator/scripts/hooks/omp';

/** The superproject root this module lives in (`packages/operator-core/lib/agent-identities` → four levels up). */
export function defaultCensusRoot(): string {
  return moduleRepoRoot(import.meta.url);
}

const entryId = (cls: IdentitySurfaceClass, path: string, name?: string) => (name ? `${cls}:${path}#${name}` : `${cls}:${path}`);

/** A tracked-file listing is a local index read; it never needs a minute. */
const GIT_LS_FILES_TIMEOUT_MS = 60_000;

function gitLsFiles(cwd: string, pathspecs: readonly string[]): string[] {
  const out = execFileSync('git', ['-C', cwd, 'ls-files', '-z', '--', ...pathspecs], { encoding: 'utf8', maxBuffer: 1 << 28, timeout: GIT_LS_FILES_TIMEOUT_MS });
  return out.split('\0').filter(Boolean);
}

// ── flat role prompts ─────────────────────────────────────────────────────────

/** True when a blueprint document declares the top-level `slots:` key — the identity discriminator. */
export function isIdentityBlueprint(yamlText: string): boolean {
  const raw = parseYaml(yamlText) as unknown;
  return !!raw && typeof raw === 'object' && Array.isArray((raw as { slots?: unknown }).slots);
}

const BASE_SKIP_DISPOSITIONS = new Set(['kernel-base', 'sidecar']);

/** `apps/operator/prompts` paths that are not agent prompts, or are already identity-stack tiers. */
export function isExcludedOperatorPrompt(relUnderPrompts: string): boolean {
  return relUnderPrompts.startsWith('tutorial/') || relUnderPrompts.startsWith('pot-instances/') || /(^|\/)README\.md$/.test(relUnderPrompts);
}

export function scanFlatRolePrompts(root: string): IdentitySurfaceEntry[] {
  const out: IdentitySurfaceEntry[] = [];
  const partDocs = new Set(SU_PART_DOCUMENTS.map((d) => `${HARNESS_REL}/${d.path}`));
  const disposition = new Map(BASE_ROLE_LIBRARY_DISPOSITION.map((r) => [r.file, r.disposition] as const));

  const blueprintsDir = join(root, BLUEPRINTS_REL);
  for (const bp of readdirSync(blueprintsDir, { withFileTypes: true })) {
    if (!bp.isDirectory()) continue;
    const promptsDir = join(blueprintsDir, bp.name, 'prompts');
    if (!existsSync(promptsDir)) continue;
    const yamlPath = join(blueprintsDir, bp.name, 'blueprint.yaml');
    if (bp.name !== 'base' && existsSync(yamlPath) && isIdentityBlueprint(readFileSync(yamlPath, 'utf8'))) continue;
    for (const f of readdirSync(promptsDir).filter((n) => n.endsWith('.md')).sort()) {
      const path = `${BLUEPRINTS_REL}/${bp.name}/prompts/${f}`;
      if (partDocs.has(path)) continue;
      if (bp.name === 'base') {
        const d = disposition.get(f);
        // An unclassified base prompt is su-decomposition.test.ts's failure to report; count it here as a role.
        if (d && BASE_SKIP_DISPOSITIONS.has(d)) continue;
        out.push({ class: 'flat-role-prompt', id: entryId('flat-role-prompt', path), path, kind: `base:${d ?? 'unclassified'}` });
      } else {
        out.push({ class: 'flat-role-prompt', id: entryId('flat-role-prompt', path), path, kind: 'blueprint-prompt' });
      }
    }
  }

  for (const rel of gitLsFiles(root, [`${OPERATOR_PROMPTS_REL}/*.md`])) {
    const under = rel.slice(OPERATOR_PROMPTS_REL.length + 1);
    if (isExcludedOperatorPrompt(under)) continue;
    out.push({ class: 'flat-role-prompt', id: entryId('flat-role-prompt', rel), path: rel, kind: 'operator-prompt' });
  }
  return out;
}

// ── TypeScript prompt constants ───────────────────────────────────────────────

/** Minimum statically-known length for a constant to count as a prompt. */
export const PROMPT_CONSTANT_MIN_CHARS = 300;
/** Second-person addresses needed (absent a prompt-shaped name). */
export const PROMPT_CONSTANT_MIN_SECOND_PERSON = 2;
export const PROMPT_CONSTANT_NAME_RE = /(?:^|_)(?:PROMPT|SYSTEM|PERSONA|DIRECTIVE|NUDGE|PREAMBLE|GUIDANCE|INSTRUCTIONS?)$/;
const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const SECOND_PERSON_RE = /\byou(?:r|rs|rself)?\b/gi;
/** Cheap prefilter: a file with no top-level UPPER_SNAKE const initialised from a literal is never parsed. */
const PREFILTER_RE = /^(?:export\s+)?const\s+[A-Z][A-Z0-9_]{2,}\s*(?::[^=\n]+)?=\s*[[`'"]/m;
/** Source that is not shipped behavior: tests, fixtures, generated code, scripts, styles, LLM-test scenarios. */
export const NON_SOURCE_PATH_RE = /(\.test\.|\.spec\.|\.d\.m?ts$|__tests__\/|__fixtures__\/|\/fixtures\/|\.generated\.|\/dist\/|\/scripts\/|\/test\/|\/e2e\/|\/llm-testing\/|\.styles\.ts$)/;

/** The statically-known text of an initializer (string / template / `[...]` / `[...].join()` / `+`), or null. */
export function staticText(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => s.literal.text).join('');
  if (ts.isArrayLiteralExpression(node)) {
    const parts = node.elements.map((e) => (ts.isSpreadElement(e) ? null : staticText(e)));
    return parts.length > 0 && parts.every((p) => p !== null) ? parts.join('\n') : null;
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
    return staticText(node.expression.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = staticText(node.left);
    const b = staticText(node.right);
    return a !== null && b !== null ? a + b : null;
  }
  return null;
}

/** Why a constant counts as a prompt, or null when it does not. */
export function promptConstantSignal(name: string, text: string): 'second-person' | 'prompt-named' | null {
  if (!UPPER_SNAKE_RE.test(name) || text.length < PROMPT_CONSTANT_MIN_CHARS) return null;
  if ((text.match(SECOND_PERSON_RE) ?? []).length >= PROMPT_CONSTANT_MIN_SECOND_PERSON) return 'second-person';
  if (PROMPT_CONSTANT_NAME_RE.test(name)) return 'prompt-named';
  return null;
}

/** The prompt constants declared at the TOP LEVEL of one TypeScript source. Pure. */
export function detectPromptConstants(path: string, sourceText: string): IdentitySurfaceEntry[] {
  if (!PREFILTER_RE.test(sourceText)) return [];
  const sf = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, false, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: IdentitySurfaceEntry[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      const text = staticText(d.initializer);
      if (text === null) continue;
      const signal = promptConstantSignal(d.name.text, text);
      if (signal) out.push({ class: 'prompt-constant', id: entryId('prompt-constant', path, d.name.text), path, name: d.name.text, kind: signal });
    }
  }
  return out;
}

export function scanPromptConstants(root: string): IdentitySurfaceEntry[] {
  const superFiles = gitLsFiles(root, ['packages/*.ts', 'packages/*.tsx', 'apps/operator/lib/*.ts', 'apps/operator/bin/*.ts']);
  const subFiles = gitLsFiles(join(root, SUBMODULE), ['packages/*.ts']).map((p) => `${SUBMODULE}/${p}`);
  const out: IdentitySurfaceEntry[] = [];
  for (const rel of [...superFiles, ...subFiles]) {
    if (NON_SOURCE_PATH_RE.test(rel)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue; // tracked but deleted in the working tree
    }
    out.push(...detectPromptConstants(rel, text));
  }
  return out;
}

// ── hooks ─────────────────────────────────────────────────────────────────────

/**
 * Lexical kind of a hook entrypoint, first match wins:
 *   identity-dispatch  it hands off to the client-neutral inject dispatcher (identity contributions)
 *   guard              it can refuse a call (`permissionDecision`, or an `exit 2` from a PreToolUse / `*guard*` hook)
 *   context            it emits agent-facing text, or is named as a nudge / context / reminder hook
 *   plumbing           none of the above (ledgers, lock bookkeeping, activity reports)
 */
export function classifyHookSource(fileName: string, text: string): HookKind {
  if (/hooks\/inject\/|inject\/(?:index|adapters\/)/.test(text)) return 'identity-dispatch';
  if (/permissionDecision/.test(text) || ((/^pretooluse-/.test(fileName) || /guard/.test(fileName)) && /\bexit 2\b/.test(text))) return 'guard';
  if (/additionalContext|systemMessage|"decision"|\bdecision\s*:/.test(text) || /nudge|context|reminder/.test(fileName)) return 'context';
  return 'plumbing';
}

export function scanInjectionHooks(root: string): IdentitySurfaceEntry[] {
  const out: IdentitySurfaceEntry[] = [];
  const add = (path: string, fileName: string) => {
    const kind = classifyHookSource(fileName, readFileSync(join(root, path), 'utf8'));
    out.push({ class: 'injection-hook', id: entryId('injection-hook', path), path, kind, ...(kind === 'identity-dispatch' ? { inside: true as const } : {}) });
  };
  for (const f of CC_HOOK_FILES as readonly string[]) {
    if (CC_HOOK_LIB_FILES.has(f) || f.startsWith('statusline-')) continue;
    const path = `${CC_HOOKS_REL}/${f}`;
    if (existsSync(join(root, path))) add(path, f);
  }
  for (const rel of gitLsFiles(root, [`${OMP_HOOKS_REL}/*.ts`])) {
    if (NON_SOURCE_PATH_RE.test(rel) || rel.slice(OMP_HOOKS_REL.length + 1).includes('/')) continue;
    add(rel, rel.slice(OMP_HOOKS_REL.length + 1));
  }
  return out;
}

// ── kernel splices ────────────────────────────────────────────────────────────

const SPLICE_RE = /<!--\s*PAPERCUSP-SU:([A-Za-z0-9_.-]+)(?::(?:BEGIN|END|START))?\s*-->/g;

/** Distinct splice-marker names in one prompt text, in first-seen order (the client seam excluded). */
export function spliceMarkerNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === CLIENT_SEAM_MARKER) continue;
    for (const m of line.matchAll(SPLICE_RE)) if (!names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

export function scanKernelSplices(root: string, flatPrompts: readonly IdentitySurfaceEntry[]): IdentitySurfaceEntry[] {
  const out: IdentitySurfaceEntry[] = [];
  for (const p of flatPrompts) {
    for (const name of spliceMarkerNames(readFileSync(join(root, p.path), 'utf8'))) {
      out.push({ class: 'kernel-splice', id: entryId('kernel-splice', p.path, name), path: p.path, name, kind: 'splice-marker' });
    }
  }
  return out;
}

// ── the census ────────────────────────────────────────────────────────────────

export function deriveIdentitySurfaceCensus(root: string = defaultCensusRoot()): IdentitySurfaceCensus {
  const flat = scanFlatRolePrompts(root);
  const entries = [...flat, ...scanPromptConstants(root), ...scanInjectionHooks(root), ...scanKernelSplices(root, flat)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`identity-surface census: duplicate entry id ${e.id}`);
    seen.add(e.id);
  }
  const counts = Object.fromEntries(IDENTITY_SURFACE_CLASSES.map((c) => [c, entries.filter((e) => e.class === c).length])) as Record<IdentitySurfaceClass, number>;
  const hookKinds = Object.fromEntries(HOOK_KINDS.map((k) => [k, entries.filter((e) => e.class === 'injection-hook' && e.kind === k).length])) as Record<HookKind, number>;
  return { schemaVersion: 1, generator: IDENTITY_SURFACE_CENSUS_GENERATOR, suRenderParityBaseline: SU_RENDER_PARITY_BASELINE, counts, hookKinds, entries };
}

/** Byte-stable serialization of a census (what the checked-in file holds). */
export function renderIdentitySurfaceCensus(census: IdentitySurfaceCensus): string {
  return `${JSON.stringify(census, null, 2)}\n`;
}

export function readCheckedInIdentitySurfaceCensus(root: string = defaultCensusRoot()): IdentitySurfaceCensus {
  return JSON.parse(readFileSync(join(root, IDENTITY_SURFACE_CENSUS_REL), 'utf8')) as IdentitySurfaceCensus;
}

export interface IdentitySurfaceCensusDiff {
  /** Surfaces present now but absent from the baseline. */
  added: IdentitySurfaceEntry[];
  /** Baseline surfaces that no longer exist. */
  removed: IdentitySurfaceEntry[];
  /** Same id, different class/kind/name/inside metadata. */
  changed: { id: string; baseline: IdentitySurfaceEntry; current: IdentitySurfaceEntry }[];
}

export function diffIdentitySurfaceCensus(baseline: Pick<IdentitySurfaceCensus, 'entries'>, current: Pick<IdentitySurfaceCensus, 'entries'>): IdentitySurfaceCensusDiff {
  const before = new Map(baseline.entries.map((e) => [e.id, e]));
  const after = new Map(current.entries.map((e) => [e.id, e]));
  const same = (a: IdentitySurfaceEntry, b: IdentitySurfaceEntry) => JSON.stringify(a) === JSON.stringify(b);
  return {
    added: [...after.values()].filter((e) => !before.has(e.id)),
    removed: [...before.values()].filter((e) => !after.has(e.id)),
    changed: [...after.values()].flatMap((e) => {
      const b = before.get(e.id);
      return b && !same(b, e) ? [{ id: e.id, baseline: b, current: e }] : [];
    }),
  };
}

/** One human-readable line per drifted entry, for the `--check` mode and the drift test. */
export function describeIdentitySurfaceCensusDiff(diff: IdentitySurfaceCensusDiff): string[] {
  return [
    ...diff.added.map((e) => `+ ${e.id} (${e.kind})`),
    ...diff.removed.map((e) => `- ${e.id} (${e.kind})`),
    ...diff.changed.map((c) => `~ ${c.id} (${c.baseline.kind} → ${c.current.kind})`),
  ];
}

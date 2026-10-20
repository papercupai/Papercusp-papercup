import { papercuspHome as resolveHostPapercuspHome, papercuspPath } from '@papercusp/host-platform/home';
/**
 * The PACKING leg of the code-intelligence routing table (plan
 * `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-016; rulings D-005 and
 * D-040).
 *
 * A pack is EVIDENCE. Unlike every other leg in this layer — which answers a
 * question with a list of sites a reader can go verify — a packer hands a
 * reviewer or a model a document they then reason about *as if it were the
 * repository*. That difference drives every design choice below:
 *
 *  - **The engine is pinned, exactly.** The pre-P-016 plugin ran
 *    `npx repomix`, which resolves whatever is latest at call time. Two packs
 *    cut minutes apart could therefore come from different engines with
 *    different default ignore sets and a different secret scanner — and two
 *    packs that disagree would be indistinguishable from two trees that
 *    disagree. Both binaries resolve by EXPLICIT VENDOR PATH, never through
 *    PATH and never through `npx`, and the resolved version must EQUAL the pin
 *    (not merely parse) so a drifted vendor dir is a loud refusal.
 *
 *  - **The dangerous flags are unreachable by construction.** Both CLIs expose
 *    flags that would silently make a pack unsafe or non-reproducible:
 *    repomix's `--no-security-check` disables secret scanning, `--remote`
 *    clones an arbitrary third-party repository, `-o` writes a file into the
 *    tree behind the lock arbitration, `--no-gitignore` packs ignored files.
 *    code2prompt's `--hidden` packs dotfiles (`.env` among them), `--no-ignore`
 *    bypasses gitignore, and `-t` reads an arbitrary Handlebars template off
 *    disk. The arg builders are PURE functions that cannot emit any of them,
 *    which makes that a property of the argv the tests assert rather than a
 *    promise in a comment.
 *
 *  - **The secret deny-set is not overridable.** It is appended to the ignore
 *    set on EVERY pack, by both engines, after caller input — so no caller
 *    argument can shorten it.
 *
 *  - **A measured asymmetry the router must respect (D-040):** repomix runs a
 *    secret scanner; code2prompt 4.2.0 has none, anywhere in its option
 *    surface. The two packers are therefore NOT interchangeable on a tree that
 *    may hold credentials, and every pack states which protection it actually
 *    had via `provenance.securityScan` rather than leaving a consumer to
 *    assume.
 *
 * `fileCount` is `null` — never `0` — when the selection could not be parsed
 * out of the pack. This is the same discipline `isTrustworthyEmpty` encodes for
 * the read legs: an unparseable pack must not be reportable as an empty one,
 * because "I could not tell what went in" and "nothing went in" are different
 * answers and only one of them is evidence.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getEncoding } from 'js-tiktoken';
import { minimatch } from 'minimatch';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { firstPartyCallersOffthread } from './first-party-callers-offthread.ts';
import { LSP_VENDOR_DIR } from './lsp-adapter.ts';
import { getBuildInfo } from '../build-info.ts';

import {
  DEFAULT_RESOURCE_BUDGET,
  type CodeIntelAnswer,
  type CodeIntelBackend,
  type CodeIntelIntent,
  type SymbolSite,
} from './contracts.ts';

let execFileAsync: ((...args: any[]) => Promise<any>) | undefined;
const runExecFile = (...args: any[]) => (execFileAsync ??= promisify(execFile) as any)(...args);

// ───────────────────────── pinned engines ─────────────────────────

/**
 * Pinned executable assets are host-shared inputs, not workspace state.
 *
 * A request or isolated test may set PAPERCUSP_HOME to a private workspace
 * data root. Resolving the vendor tree through papercuspPath() in that case
 * hides the maintained installation under ~/.papercusp/vendor and makes the
 * packer look unprovisioned. Keep this aligned with the LSP adapter's
 * host-level vendor resolution; workspace-scoped paths remain appropriate for
 * scratch artifacts below.
 */
export function resolvePackerVendorDir(engine: 'repomix' | 'code2prompt'): string {
  return join(resolveHostPapercuspHome({}, homedir()), 'vendor', engine);
}

/** Vendor roots. Provisioned by P-016; never installed at runtime. */
export const REPOMIX_VENDOR_DIR = resolvePackerVendorDir('repomix');
export const CODE2PROMPT_VENDOR_DIR = resolvePackerVendorDir('code2prompt');

/**
 * The EXACT pinned versions.
 *
 * These are not documentation — `assertIsRepomix`/`assertIsCode2Prompt` compare
 * the binary's own `--version` output against them and refuse on mismatch. A
 * range would defeat the purpose: "pinned" has to mean the pack can name the
 * one engine that produced it.
 */
export const REPOMIX_PINNED_VERSION = '1.18.0';
export const CODE2PROMPT_PINNED_VERSION = '4.2.0';

export type PackerEngine = Extract<CodeIntelBackend, 'repomix' | 'code2prompt'>;

/** repomix ships as an npm package; its bin lands in the vendor node_modules. */
export function resolveRepomixBin(): string | null {
  const bin = join(REPOMIX_VENDOR_DIR, 'node_modules', '.bin', 'repomix');
  return existsSync(bin) ? bin : null;
}

/**
 * code2prompt is a Rust binary, installed from the pinned GitHub release asset.
 *
 * ⚠ Deliberately NOT the npm package called `code2prompt`. That name on npm
 * resolves to `github.com/puntorigen/code2prompt`, an unrelated NodeJS *library*
 * that ships no executable at all — a same-name impostor on a different
 * registry (D-040). This is the `sg` trap from D-039 one layer up, which is why
 * identity here is proven from the `--version` STRING and not from the fact
 * that something answered.
 */
export function resolveCode2PromptBin(): string | null {
  const bin = join(CODE2PROMPT_VENDOR_DIR, 'bin', 'code2prompt');
  return existsSync(bin) ? bin : null;
}

export interface EngineIdentity {
  readonly engine: PackerEngine;
  readonly bin: string;
  readonly version: string;
}

type IdentityVerdict = { ok: true; version: string } | { ok: false; reason: string };

/**
 * repomix prints a BARE semver (measured at 1.18.0: `1.18.0`).
 *
 * A bare semver is weak identity on its own — many tools print one — so the
 * check that carries the weight is equality with the pin. That is also the
 * check that catches the failure this leg actually exists to prevent: a vendor
 * dir that drifted off the pin (an `npm update`, a range that re-resolved)
 * still answers `--version` perfectly well, just with the wrong engine.
 */
export function assertIsRepomix(versionOutput: string): IdentityVerdict {
  const text = versionOutput.trim();
  const m = /^(\d+\.\d+\.\d+)$/m.exec(text);
  if (!m) {
    return {
      ok: false,
      reason:
        `the resolved repomix binary did not print a bare semver (it printed ` +
        `${JSON.stringify(text.slice(0, 80))}).`,
    };
  }
  if (m[1] !== REPOMIX_PINNED_VERSION) {
    return {
      ok: false,
      reason:
        `pinned repomix has DRIFTED: expected exactly ${REPOMIX_PINNED_VERSION}, found ${m[1]}. ` +
        `A pack names the engine that produced it, so a drifted vendor dir is refused rather ` +
        `than silently producing evidence attributed to the wrong version.`,
    };
  }
  return { ok: true, version: m[1] };
}

/** code2prompt prints `code2prompt <semver>` (measured at 4.2.0). */
export function assertIsCode2Prompt(versionOutput: string): IdentityVerdict {
  const text = versionOutput.trim();
  const m = /^code2prompt\s+(\d+\.\d+\.\d+)/.exec(text);
  if (!m) {
    return {
      ok: false,
      reason:
        `the resolved binary does not identify as code2prompt (it printed ` +
        `${JSON.stringify(text.slice(0, 80))}). The npm package of the same name is an ` +
        `unrelated NodeJS library that ships no executable — see D-040.`,
    };
  }
  if (m[1] !== CODE2PROMPT_PINNED_VERSION) {
    return {
      ok: false,
      reason:
        `pinned code2prompt has DRIFTED: expected exactly ${CODE2PROMPT_PINNED_VERSION}, found ${m[1]}.`,
    };
  }
  return { ok: true, version: m[1] };
}

const ENGINE_SPEC: Readonly<
  Record<PackerEngine, { resolve: () => string | null; assert: (out: string) => IdentityVerdict; dir: string }>
> = Object.freeze({
  repomix: { resolve: resolveRepomixBin, assert: assertIsRepomix, dir: REPOMIX_VENDOR_DIR },
  code2prompt: { resolve: resolveCode2PromptBin, assert: assertIsCode2Prompt, dir: CODE2PROMPT_VENDOR_DIR },
});

/** Resolve AND verify identity. Every pack goes through this. */
export async function packerIdentity(
  engine: PackerEngine,
  exec: ExecFn = defaultExec,
): Promise<{ ok: true; identity: EngineIdentity } | { ok: false; reason: string }> {
  const spec = ENGINE_SPEC[engine];
  const bin = spec.resolve();
  if (!bin) {
    return {
      ok: false,
      reason:
        `pinned ${engine} is not provisioned. Expected it under ${spec.dir}. Provision it (P-016) ` +
        `rather than falling back to a PATH or npx lookup — an unpinned packer produces evidence ` +
        `no one can attribute to a version.`,
    };
  }
  try {
    const { stdout } = await exec(bin, ['--version'], { timeoutMs: 10_000 });
    const verdict = spec.assert(stdout);
    return verdict.ok ? { ok: true, identity: { engine, bin, version: verdict.version } } : verdict;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────── safety sets ─────────────────────────

/**
 * Never packed, by either engine, regardless of caller arguments.
 *
 * Appended AFTER caller ignores so no argument can shorten the set. This is the
 * only protection a code2prompt pack has (it ships no scanner at all), and it
 * is defence-in-depth for repomix on top of Secretlint.
 */
export const SECRET_DENY_GLOBS: readonly string[] = Object.freeze([
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_ecdsa*',
  '**/.npmrc',
  '**/.netrc',
  '**/.pgpass',
  '**/credentials',
  '**/credentials.*',
  '**/secrets.*',
  '**/service-account*.json',
  '**/*.jks',
]);

/**
 * Flags the repomix argv may NEVER contain, and why each one matters.
 *
 * Asserted against every produced argv, for every input — including a caller
 * trying to smuggle one through an include or ignore pattern.
 */
export const REPOMIX_FORBIDDEN_FLAGS: readonly string[] = Object.freeze([
  '--no-security-check', // disables Secretlint — the whole reason repomix is the default packer
  '--remote', // clones an arbitrary third-party repo: network fetch + unreviewed content
  '--remote-branch',
  '--remote-trust-config', // executes config from a remote repo
  '-o', // writes a file, bypassing the PreToolUse lock arbitration
  '--output',
  '--split-output', // same, several files
  '--copy', // exfiltrates the pack to the system clipboard
  '--no-gitignore', // packs ignored files, which is where secrets live
  '--no-dot-ignore',
]);

/**
 * Flags the code2prompt argv may NEVER contain.
 *
 * `-O`/`--output-file` is absent from this list ON PURPOSE: the builder always
 * emits `-O -` (stdout) and never accepts a caller path, so the flag is present
 * with a value that cannot write. The test asserts that exact pairing rather
 * than the flag's absence.
 */
export const CODE2PROMPT_FORBIDDEN_FLAGS: readonly string[] = Object.freeze([
  '-c', // clipboard exfiltration
  '--clipboard',
  '--no-ignore', // bypasses gitignore
  '--hidden', // packs dotfiles — .env among them
  '-t', // reads an arbitrary Handlebars template off disk
  '--template',
  '--tui', // interactive; would hang a spawned process forever
  '-L', // follows symlinks out of the workspace
  '--follow-symlinks',
  '--absolute-paths', // leaks host filesystem layout into the evidence
]);

/**
 * The reviewer framings a caller may ask for.
 *
 * A CLOSED enum mapping to text we own, deliberately not code2prompt's `-t`
 * (which takes a filesystem path and would be both an arbitrary-file-read and a
 * template-injection surface). "Validate diff/pack templates" in P-016 is
 * therefore satisfied by construction: an unknown name cannot resolve, and the
 * test asserts every enum member yields non-empty text.
 */
export const PACK_TEMPLATES = Object.freeze({
  none: '',
  'code-review':
    '# Code Review\n\nReview the following for correctness, clarity, and maintainability. ' +
    'Flag bugs, security issues, performance regressions, and unclear naming. Cite file:line references.\n\n',
  'security-audit':
    '# Security Audit\n\nAudit the following for security vulnerabilities. Focus on input validation, ' +
    'authentication/authorization, secrets handling, injection risks, and unsafe deserialization.\n\n',
  'refactor-prep':
    '# Refactor Preparation\n\nAnalyze the following and produce a refactor plan: identify duplication, ' +
    'suggest extractions, propose architectural improvements, and include an impact analysis.\n\n',
} as const);

export type PackTemplate = keyof typeof PACK_TEMPLATES;

export function templateHeader(name: PackTemplate | undefined): string {
  if (!name) return '';
  return PACK_TEMPLATES[name] ?? '';
}

// ───────────────────────── arguments ─────────────────────────

export type PackerOp = 'pack' | 'diff';
export type PackFormat = 'markdown' | 'xml';

export interface PackerArgs {
  /** Repo-relative globs. REQUIRED and non-empty — see buildRepomixArgs. */
  readonly include: readonly string[];
  readonly ignore?: readonly string[];
  readonly rootPath: string;
  readonly format?: PackFormat;
  readonly template?: PackTemplate;
  /** `diff` only: the ref to diff against. */
  readonly baseRef?: string;
  /** repomix only: collapse bodies to signatures. */
  readonly compress?: boolean;
}

/**
 * The pack's own byte ceiling.
 *
 * A pack never enters an agent's context inline — it is written to scratch and
 * referenced — so this bounds the ARTIFACT, not a result payload. The budget's
 * `resultTokensMax` governs what this module returns to the caller, which is
 * provenance plus a preview.
 */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;

/** Characters of the pack echoed back inline, well under resultTokensMax. */
export const PACK_PREVIEW_CHARS = Math.max(200, DEFAULT_RESOURCE_BUDGET.resultTokensMax);

/**
 * Refuse any caller pattern that could be READ AS A FLAG.
 *
 * Found by the smuggling cases in this module's tests, and it is a real hole
 * rather than a theoretical one: emitting `['--include', '--no-security-check']`
 * puts an attacker-controlled, flag-shaped token into argv, and whether the
 * engine's parser binds it as the value of `--include` or re-reads it as its own
 * option is a property of that parser's version — commander and clap both have
 * had both behaviours. A pack whose secret scanning depends on an argv parsing
 * quirk is not a pack anyone should trust.
 *
 * Two independent defences, because either alone would be a single point of
 * failure: this validation, and the `--flag=value` emission below (which is
 * unambiguous to every parser even if a pattern slipped through). A legitimate
 * glob never begins with `-`, so nothing useful is refused.
 */
function assertNotFlagShaped(patterns: readonly string[], field: string): void {
  for (const p of patterns) {
    if (p.startsWith('-')) {
      throw new Error(
        `${field} pattern ${JSON.stringify(p)} begins with '-' and could be parsed as an engine ` +
          `flag. Refused: a glob never starts with '-', and allowing one would make secret ` +
          `scanning depend on how the engine's argv parser resolves the ambiguity.`,
      );
    }
  }
}

function assertNoForbidden(argv: readonly string[], forbidden: readonly string[], engine: string): void {
  // Compare against the token, and against the `--flag=value` form, so a
  // forbidden flag cannot be smuggled through an attached value.
  for (const token of argv) {
    const head = token.split('=', 1)[0];
    if (forbidden.includes(head)) {
      throw new Error(
        `${engine} argv contained the forbidden flag ${head}. This is a bug in the arg builder, ` +
          `not a caller error — the builder is meant to make this unreachable.`,
      );
    }
  }
}

/**
 * Build repomix's argv. PURE.
 *
 * `include` is REQUIRED and must be non-empty. That is P-016's "explicit
 * include sets": with no include, repomix packs the entire working tree, which
 * on this monorepo is a multi-gigabyte document that is both useless as
 * evidence and a denial-of-service against whatever reads it. Refusing is
 * better than defaulting, because a silently-whole-repo pack looks exactly like
 * a correctly-scoped one until someone reads it.
 */
export function buildRepomixArgs(args: PackerArgs): string[] {
  if (args.include.length === 0) {
    throw new Error(
      'repomix requires an explicit, non-empty include set (P-016). Packing the whole tree by ' +
        'default produces evidence nobody scoped.',
    );
  }
  assertNotFlagShaped(args.include, 'include');
  assertNotFlagShaped(args.ignore ?? [], 'ignore');
  const ignore = [...(args.ignore ?? []), ...SECRET_DENY_GLOBS];
  // `--flag=value` throughout: an attached value is unambiguous to the parser,
  // so no emitted token can be re-read as an option.
  const argv = [
    '--stdout',
    '--quiet',
    `--style=${args.format === 'markdown' ? 'markdown' : 'xml'}`,
    `--include=${args.include.join(',')}`,
    `--ignore=${ignore.join(',')}`,
  ];
  if (args.compress) argv.push('--compress');
  assertNoForbidden(argv, REPOMIX_FORBIDDEN_FLAGS, 'repomix');
  return argv;
}

/**
 * Build code2prompt's argv. PURE.
 *
 * Always `-O -` (stdout): there is no caller-supplied output path anywhere in
 * this builder, so the engine cannot write into the shared tree behind the lock
 * arbitration.
 */
export function buildCode2PromptArgs(args: PackerArgs): string[] {
  if (args.include.length === 0) {
    throw new Error('code2prompt requires an explicit, non-empty include set (P-016).');
  }
  assertNotFlagShaped(args.include, 'include');
  assertNotFlagShaped(args.ignore ?? [], 'ignore');
  if (args.baseRef !== undefined) assertNotFlagShaped([args.baseRef], 'baseRef');
  const exclude = [...(args.ignore ?? []), ...SECRET_DENY_GLOBS];
  // Long `--flag=value` forms only. A short `-e <value>` would reintroduce the
  // detached-value ambiguity this builder exists to close, and `--output-file=-`
  // pins stdout in a form no parser can rebind.
  const argv = [
    args.rootPath,
    '--output-file=-',
    '--quiet',
    `--output-format=${args.format === 'xml' ? 'xml' : 'markdown'}`,
    `--include=${args.include.join(',')}`,
    `--exclude=${exclude.join(',')}`,
  ];
  if (args.baseRef) {
    // `--diff` is the working-tree diff; a base ref asks for a branch range.
    // Detached form on purpose: `--git-diff-branch` takes TWO values, which the
    // `=` form cannot express. Safe here only because assertNotFlagShaped above
    // has already guaranteed baseRef cannot begin with '-'.
    argv.push('--git-diff-branch', args.baseRef, 'HEAD');
  } else {
    argv.push('--diff');
  }
  assertNoForbidden(argv, CODE2PROMPT_FORBIDDEN_FLAGS, 'code2prompt');
  return argv;
}

// ───────────────────────── selection parsing ─────────────────────────

/**
 * Recover the file list from a produced pack.
 *
 * Returns `null` — never `[]` — when the format is not one this understands or
 * no file markers were found. A caller must be able to tell "the pack selected
 * nothing" from "I could not read the pack", because only the first is a
 * finding; reporting the second as `0` is the packing-plane version of the
 * confident-empty failure the read legs guard against.
 */
export function parseSelectedFiles(body: string, format: PackFormat): readonly string[] | null {
  const out: string[] = [];
  if (format === 'xml') {
    const re = /<file\s+path="([^"]+)"/g;
    for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m[1]);
  } else {
    const re = /^#{1,3}\s+File:\s+(.+?)\s*$/gm;
    for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m[1]);
  }
  if (out.length === 0) return null;
  return Array.from(new Set(out));
}

// ───────────────────────── provenance ─────────────────────────

export type SecurityScan =
  /** repomix: Secretlint ran (we can never pass --no-security-check) AND the deny-set applied. */
  | 'secretlint+deny-set'
  /** code2prompt: NO scanner exists in this engine; the deny-set is the only protection. */
  | 'deny-set-only';

export interface PackProvenance {
  readonly engine: PackerEngine;
  readonly engineVersion: string;
  readonly rootPath: string;
  /** HEAD at pack time. Null when the root is not a git checkout. */
  readonly commit: string | null;
  /**
   * True when the working tree differs from `commit`. A dirty pack is NOT
   * reproducible from the commit alone, and a consumer citing it as "the code
   * at <sha>" would be wrong — so this is stated, never inferred.
   */
  readonly dirty: boolean | null;
  readonly baseRef: string | null;
  readonly baseCommit: string | null;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly denyGlobs: readonly string[];
  readonly template: PackTemplate;
  /** Null when the selection could not be parsed. Never coerced to 0. */
  readonly fileCount: number | null;
  readonly bytes: number;
  readonly chars: number;
  readonly securityScan: SecurityScan;
  readonly capturedAt: string;
}

export interface PackArtifact {
  /** Scratch path holding the full pack. Null when nothing was written. */
  readonly path: string | null;
  readonly preview: string;
  readonly provenance: PackProvenance;
  /** P021: captured retrieval evidence; inference/model usage is not measured. */
  readonly bundle?: {
    readonly kind: 'captured-source';
    readonly sourcePaths: readonly string[] | null;
    readonly sha256: string;
    readonly truncated: boolean;
    readonly totalChars: number;
    readonly retainedChars: number;
    readonly tokens: { readonly tokenizer: 'o200k_base'; readonly source: number | null;
      readonly measuredPrefix: number; readonly measuredChars: number; readonly retained: number; readonly budget: number };
    readonly expansion: { readonly tool: 'capability:read'; readonly args: { readonly file_path: string;
      readonly byte_offset: 0; readonly byte_limit: 4096 }; readonly sha256: string };
    readonly limitations: readonly string[];
  };
}

let packTokenizer: ReturnType<typeof getEncoding> | undefined;
/** Preserve an exact source prefix and count it with the maintained tokenizer.
 * Large documents retain unknown totals; never report an extrapolation as tokens. */
function packPreview(document: string, path: string, selected: readonly string[] | null) {
  const tokenizer = packTokenizer ??= getEncoding('o200k_base');
  const budget = DEFAULT_RESOURCE_BUDGET.resultTokensMax;
  const prefix = (chars: number) => document.slice(0, chars > 0 && /[\uD800-\uDBFF]/.test(document[chars - 1]) ? chars - 1 : chars);
  let preview = prefix(Math.min(document.length, PACK_PREVIEW_CHARS));
  let retained = tokenizer.encode(preview, [], []).length;
  while (retained > budget) {
    preview = prefix(Math.min(preview.length - 1, Math.floor(preview.length * budget / retained)));
    retained = tokenizer.encode(preview, [], []).length;
  }
  // BPE on a long, uninterrupted source string has superlinear cost. A small
  // sample is measured exactly; the whole-document count remains unknown.
  const measured = prefix(Math.min(document.length, 256));
  const measuredPrefix = measured === preview ? retained : tokenizer.encode(measured, [], []).length;
  const sha256 = createHash('sha256').update(document).digest('hex');
  const bundle: NonNullable<PackArtifact['bundle']> = { kind: 'captured-source', sourcePaths: selected, sha256,
    truncated: preview.length < document.length, totalChars: document.length, retainedChars: preview.length,
    tokens: { tokenizer: 'o200k_base', source: measured.length === document.length ? measuredPrefix : null,
      measuredPrefix, measuredChars: measured.length, retained, budget },
    expansion: { tool: 'capability:read', args: { file_path: path, byte_offset: 0, byte_limit: 4096 }, sha256 },
    limitations: ['Captured source text is retrieval evidence; it does not establish runtime execution or inferred architecture.',
      ...(measured.length < document.length ? ['Total source tokens are unknown beyond the measured 256-character prefix.'] : []),
      ...(selected === null ? ['Source path enumeration could not be parsed; no completeness claim is made.'] : [])] };
  return { preview, bundle };
}

export interface PackerResult {
  readonly answer: CodeIntelAnswer;
  readonly artifact: PackArtifact | null;
}

/** P-010 extends the existing diff/graph plane; no separate index or service. */
export interface ChangeReportRequest {
  readonly symbol: string;
  readonly file: string;
  readonly line1?: number;
  readonly paths?: readonly string[];
  readonly limit?: number;
  readonly phase?: 'pre-edit' | 'pre-review';
  readonly previousFingerprint?: string;
}

export interface NativeChangeReport {
  readonly subject: ChangeReportRequest;
  readonly changed: readonly { path: string; line1: number | null; patch: string }[];
  readonly consumers: readonly SymbolSite[];
  readonly relevantTests: readonly SymbolSite[];
  readonly interfaces: {
    readonly status: 'measured' | 'unknown';
    readonly diagnostics: NonNullable<import('./first-party-callers').FirstPartyCallersAnswer['interfaces']>['diagnostics'];
    readonly registrations: NonNullable<import('./first-party-callers').FirstPartyCallersAnswer['interfaces']>['registrations'];
    readonly mismatchedConsumers: readonly SymbolSite[];
    readonly truncated: boolean;
    readonly limitations: readonly string[];
  };
  readonly testReach: {
    readonly symbol: string;
    readonly file: string;
    readonly status: 'found' | 'not-found-in-scope' | 'unknown';
    readonly tests: readonly SymbolSite[];
    readonly paths: readonly { testPath: string; siteIndices: readonly number[]; walk: 'forward' | 'reverse' }[];
    readonly executionCoverage: 'unmeasured';
    readonly gapSuggestion: string | null;
  };
  readonly recheck: readonly { path: string; reason: string }[];
  readonly sourceFingerprint: string;
  readonly freshness: 'first-read' | 'unchanged' | 'changed' | 'unmeasured';
  readonly provenance: { commit: string | null; dirty: boolean | null; baseCommit: string | null;
    runtime: ReturnType<typeof getBuildInfo>; graph: CodeIntelAnswer['evidence'] };
  readonly limitations: readonly string[];
  readonly bundle: NativeEvidenceBundle;
}

export interface ChangeReportEffects {
  readonly exec?: ExecFn;
  readonly graph?: (request: ChangeReportRequest, root: string) => Promise<CodeIntelAnswer>;
  readonly writeArtifact?: (body: string) => Promise<string>;
}

export interface NativeEvidenceBundle {
  readonly kind: 'native-source-path';
  readonly repositoryId: string | null;
  readonly sourceFingerprint: string | null;
  /** Complete records only. Omitted records remain in the captured artifact. */
  readonly context: {
    readonly sources: readonly NativeSourceExcerpt[];
    readonly symbols: readonly { site: SymbolSite; versionedSymbolId: string | null; contentHash: string | null }[];
    readonly paths: NonNullable<CodeIntelAnswer['traversal']>['paths'];
    readonly edges: NonNullable<CodeIntelAnswer['evidence']>['relationships'];
  };
  readonly omitted: { readonly sources: number; readonly symbols: number; readonly paths: number; readonly edges: number };
  readonly coverage: { readonly sourceCompleteness: 'unverified'; readonly inspectedFiles: readonly string[];
    readonly inspectedFilesTotal: number; readonly unavailableFiles: readonly string[];
    readonly unavailableFilesTotal: number; readonly fileListsTruncated: boolean;
    readonly backendTruncated: boolean; readonly traversalOutcome: string | null };
  readonly tokens: { readonly tokenizer: 'o200k_base'; readonly source: number | null;
    readonly measuredPrefix: number; readonly measuredChars: number; readonly retained: number;
    readonly processed: number; readonly budget: number };
  readonly expansion: NonNullable<PackArtifact['bundle']>['expansion'];
  readonly limitations: readonly string[];
}

interface NativeSourceExcerpt {
  readonly path: string;
  readonly contentHash: string;
  readonly line1: number;
  readonly text: string;
  readonly excerptChars: number;
  readonly truncated: boolean;
}

/** Reuse the pack scratch plane. Capture graph records and literal excerpts,
 * then select whole records for the result budget; never re-run on expansion. */
async function nativeEvidenceBundle(answer: CodeIntelAnswer, captured: ReadonlyMap<string, string>,
  write: (body: string) => Promise<string>): Promise<NativeEvidenceBundle> {
  const evidence = answer.evidence;
  const sites: { site: SymbolSite; versionedSymbolId: string | null; contentHash: string | null }[] =
    [answer.traversal?.start, answer.traversal?.target].filter(site => site !== undefined)
    .map(site => ({ site: site.site, versionedSymbolId: site.versionedSymbolId, contentHash: site.contentHash }));
  for (const [siteIndex, site] of answer.sites.entries()) {
    const identity = evidence?.siteIdentities.find(row => row.siteIndex === siteIndex);
    sites.push({ site, versionedSymbolId: identity?.versionedSymbolId ?? null, contentHash: identity?.contentHash ?? null });
  }
  for (const edge of evidence?.relationships ?? []) for (const endpoint of [edge.source, edge.target]) {
    if (endpoint && !sites.some(row => row.versionedSymbolId === endpoint.versionedSymbolId
      && row.site.path === endpoint.site.path && row.site.line1 === endpoint.site.line1)) sites.push(endpoint);
  }
  const sources: NativeSourceExcerpt[] = [];
  const seen = new Set<string>();
  const sourceHashes = new Map([...captured].map(([path, source]) =>
    [path, createHash('sha256').update(source).digest('hex')]));
  const sourceLines = new Map([...captured].map(([path, source]) => [path, source.split('\n')]));
  for (const { site, contentHash } of sites) {
    const source = captured.get(site.path);
    const key = `${site.path}:${site.line1}`;
    if (source === undefined || !contentHash || !site.line1 || !Number.isInteger(site.line1) || site.line1 < 1 || seen.has(key)
      || sourceHashes.get(site.path) !== contentHash) continue;
    seen.add(key);
    const lines = sourceLines.get(site.path)!;
    if (site.line1 > lines.length) continue;
    const text = lines.slice(site.line1 - 1, site.line1 + 2).join('\n');
    sources.push({ path: site.path, contentHash, line1: site.line1, text: text.slice(0, 4096),
      excerptChars: text.length, truncated: text.length > 4096 });
  }
  const full = { sources, symbols: sites, paths: answer.traversal?.paths ?? [], edges: evidence?.relationships ?? [] };
  const inspectedFiles = [...captured.keys()];
  const unavailableFiles = (evidence?.sourceScope.supportingFiles ?? []).filter(file => !captured.has(file.path)).map(file => file.path);
  const coverage: NativeEvidenceBundle['coverage'] = { sourceCompleteness: 'unverified', inspectedFiles: inspectedFiles.slice(0, 32),
    inspectedFilesTotal: inspectedFiles.length, unavailableFiles: unavailableFiles.slice(0, 32), unavailableFilesTotal: unavailableFiles.length,
    fileListsTruncated: inspectedFiles.length > 32 || unavailableFiles.length > 32,
    backendTruncated: answer.truncation.truncated, traversalOutcome: answer.traversal?.outcome ?? null };
  const limitations = ['Excerpts are inspected literal source; edge knowledge/origin remain the producer\'s observed, inferred or unknown classification.',
    'Static paths do not establish runtime execution, executed test coverage or repository completeness.',
    ...(unavailableFiles.length ? ['Changed, secret-denied, unavailable or non-symbol compiler inputs have no current source excerpt.'] : []),
    ...(sources.some(source => source.truncated) ? ['Captured line excerpts are capped at 4096 characters; longer line tails were not captured.'] : [])];
  const document = JSON.stringify({ kind: 'native-source-path', sourceScope: evidence?.sourceScope ?? null,
    context: full, coverage: { ...coverage, inspectedFiles, unavailableFiles, fileListsTruncated: false }, limitations });
  const path = await write(document);
  const context: { sources: NativeSourceExcerpt[]; symbols: typeof sites;
    paths: [...typeof full.paths]; edges: [...typeof full.edges] } = { sources: [], symbols: [], paths: [], edges: [] };
  // The same conservative character ceiling as pack previews keeps tokenizer
  // work bounded even for a pathological uninterrupted source word.
  for (const key of ['sources', 'symbols', 'paths', 'edges'] as const) {
    for (const record of full[key]) {
      const candidate = { ...context, [key]: [...context[key], record] };
      if (JSON.stringify(candidate).length <= PACK_PREVIEW_CHARS) Object.assign(context, candidate);
    }
  }
  const retainedText = JSON.stringify(context);
  const tokenizer = packTokenizer ??= getEncoding('o200k_base');
  let retained = tokenizer.encode(retainedText, [], []).length;
  let processed = retained;
  const budget = DEFAULT_RESOURCE_BUDGET.resultTokensMax;
  // JSON escaping can increase token density. Drop whole records, preserving
  // valid structured context and the expansion route rather than slicing JSON.
  while (retained > budget) {
    const key = (['edges', 'paths', 'symbols', 'sources'] as const).find(group => context[group].length);
    if (!key) break;
    context[key].pop();
    retained = tokenizer.encode(JSON.stringify(context), [], []).length;
    processed += retained;
  }
  const measured = document.slice(0, 256);
  const measuredPrefix = tokenizer.encode(measured, [], []).length;
  const sha256 = createHash('sha256').update(document).digest('hex');
  return { kind: 'native-source-path', repositoryId: evidence?.sourceScope.repositoryId ?? null,
    sourceFingerprint: evidence?.sourceScope.sourceFingerprint ?? null, context,
    omitted: { sources: full.sources.length - context.sources.length, symbols: full.symbols.length - context.symbols.length,
      paths: full.paths.length - context.paths.length, edges: full.edges.length - context.edges.length }, coverage,
    tokens: { tokenizer: 'o200k_base', source: document.length <= 256 ? measuredPrefix : null,
      measuredPrefix, measuredChars: measured.length, retained, processed: processed + measuredPrefix, budget },
    expansion: { tool: 'capability:read', args: { file_path: path, byte_offset: 0, byte_limit: 4096 }, sha256 }, limitations };
}

/** Bounded, current-source consequence evidence for a named edit or review. */
export async function nativeChangeReport(args: PackerArgs, subject: ChangeReportRequest,
  effects: ChangeReportEffects = {}): Promise<{ answer: CodeIntelAnswer; report: NativeChangeReport }> {
  const root = realpathSync(args.rootPath);
  if (!args.include.length || args.include.length > 32 || args.include.some(pattern => pattern.startsWith('-')))
    throw new Error('Change report requires 1..32 explicit include patterns without option-shaped values.');
  if (args.baseRef?.startsWith('-') || (args.baseRef && /[\r\n\0]/.test(args.baseRef)))
    throw new Error('Change-report baseRef must be a revision, not an option.');
  const safePath = (path: string) => {
    if (!path.trim() || isAbsolute(path) || path.includes('\\') || path.split('/').includes('..'))
      throw new Error('Change-report paths must be repository-relative paths without parent traversal.');
    const abs = resolve(root, path);
    if (existsSync(abs)) {
      const rel = relative(root, realpathSync(abs));
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Change-report source escapes the repository.');
    }
    return path;
  };
  safePath(subject.file);
  const paths = [...(subject.paths?.length ? subject.paths : ['.'])].map(safePath);
  if (paths.length > 50 || !/^[A-Za-z_$][\w$]*$/.test(subject.symbol))
    throw new Error('Change report requires one identifier and at most 50 source roots.');
  const limit = subject.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Change-report limit must be 1..500.');
  const exec = effects.exec ?? defaultExec;
  const limitations: string[] = [];
  const git = await readGitProvenance(root, args.baseRef, exec);
  let patch = '';
  try {
    patch = (await exec('git', ['diff', '--no-ext-diff', '--unified=3', ...(args.baseRef ? [args.baseRef] : []),
      '--', ...args.include, ...SECRET_DENY_GLOBS.map(glob => `:(exclude,glob)${glob}`)],
    { cwd: root, timeoutMs: 15_000, maxBuffer: 256 * 1024 })).stdout;
  } catch (error) { limitations.push(`Diff could not be measured: ${error instanceof Error ? error.message : String(error)}`); }
  const changed: { path: string; line1: number | null; patch: string }[] = [];
  for (const section of patch.split(/(?=^diff --git )/m).filter(Boolean)) {
    const file = /^\+\+\+ b\/(.+)$/m.exec(section)?.[1] ?? /^--- a\/(.+)$/m.exec(section)?.[1];
    if (!file) continue;
    const line = /^@@ .* \+(\d+)/m.exec(section)?.[1];
    changed.push({ path: file, line1: line ? Number(line) : null, patch: section.slice(0, 4_000) });
    if (section.length > 4_000) limitations.push(`Diff excerpt truncated for ${file}.`);
    if (changed.length >= 32) { limitations.push('Changed-file report capped at 32 files.'); break; }
  }
  if (!patch && subject.phase !== 'pre-edit') limitations.push('No diff was measured; a named subject alone does not establish an edited behavior.');
  const graph = effects.graph ?? ((request: ChangeReportRequest, graphRoot: string) => firstPartyCallersOffthread({
    vendorDir: LSP_VENDOR_DIR, root: graphRoot, op: 'impact', name: request.symbol,
    filePath: request.file, line1: request.line1, paths, limit, direction: 'downstream', maxDepth: 5, maxPaths: 20, includeInterfaces: true,
  }));
  const answer = await graph(subject, root);
  if (answer.error) limitations.push(answer.error);
  limitations.push('Consequences are static compiler call paths in the requested source scope; runtime execution and non-code consumers remain unverified.');
  limitations.push(...(answer.evidence?.graphScope.limitations ?? answer.coverage?.limitations ?? []));
  if (answer.truncation.truncated) limitations.push('Consumer results were truncated; omitted consumers remain unverified.');
  if (!answer.evidence?.sourceScope.sourceFingerprint) limitations.push('Compiler input identity was not measured.');
  // Literal locations are the oracle. No comment or generated prose becomes a consumer.
  const consumers = [...answer.sites];
  const relevantTests = consumers.filter(site => /(?:\.(?:test|spec)\.[^.]+$|\/(?:__tests__|tests)\/)/.test(site.path));
  const recheck = changed.filter(file => /(?:\.(?:md|mdx)$|(?:^|\/)evidence\/)/.test(file.path))
    .map(file => ({ path: file.path, reason: 'Changed documentation or evidence must be checked against the current consumer/source identity.' }));
  for (const site of consumers) if (/\.(?:md|mdx)$/.test(site.path))
    recheck.push({ path: site.path, reason: 'Source-derived reference to the edited symbol.' });
  const hash = createHash('sha256').update(patch).update(answer.evidence?.sourceScope.sourceFingerprint ?? 'unmeasured');
  // Hash every actual compiler input again AFTER analysis. An edit during a
  // worker run is a stale report, even when HEAD and file mtimes did not move.
  let measured = Boolean(answer.evidence?.sourceScope.sourceFingerprint);
  const captured = new Map<string, string>();
  const excerptPaths = new Set([subject.file, ...answer.sites.map(site => site.path),
    ...[answer.traversal?.start, answer.traversal?.target].flatMap(site => site ? [site.site.path] : []),
    ...(answer.evidence?.relationships ?? []).flatMap(edge => [edge.source, edge.target].flatMap(site => site ? [site.site.path] : []))]);
  for (const file of answer.evidence?.sourceScope.supportingFiles ?? []) {
    if (file.representation !== 'full-source') { measured = false; continue; }
    try {
      safePath(file.path);
      const bytes = readFileSync(join(root, file.path));
      const source = bytes.toString('utf8');
      const current = createHash('sha256').update(bytes).digest('hex');
      hash.update(file.path).update(current);
      if (current !== file.contentHash) { measured = false; limitations.push(`Source changed during analysis: ${file.path}.`); }
      else if (excerptPaths.has(file.path) && Buffer.from(source).equals(bytes)
        && !SECRET_DENY_GLOBS.some(pattern => minimatch(file.path, pattern, { dot: true }))) captured.set(file.path, source);
    } catch { measured = false; limitations.push(`Source is no longer readable: ${file.path}.`); }
  }
  const sourceFingerprint = hash.digest('hex');
  // Per-symbol reach reuses the compiler's versioned paths. Never turn an
  // unresolved callback, bounded negative or source drift into a test-gap claim.
  const relationships = new Map(answer.evidence?.relationships.map(edge => [edge.siteIndex, edge]) ?? []);
  const testPaths = new Set(relevantTests.map(site => site.path));
  const sourceHashes = new Map(answer.evidence?.sourceScope.supportingFiles.map(file => [file.path, file.contentHash]) ?? []);
  const reachPaths: { testPath: string; siteIndices: readonly number[]; walk: 'forward' | 'reverse' }[] = [];
  let rejectedReachPath = false;
  for (const path of answer.traversal?.paths ?? []) {
    const edges = path.siteIndices.map(index => relationships.get(index));
    if (!path.siteIndices.length || !path.siteIndices.every((index, offset) => {
      const edge = relationships.get(index);
      const from = path.walk === 'reverse' ? edge?.target : edge?.source;
      const previous = offset ? (path.walk === 'reverse' ? edges[offset - 1]?.source : edges[offset - 1]?.target)
        : answer.traversal?.start;
      return edge?.origin === 'compiler' && edge.knowledge === 'observed' && edge.binding === 'direct'
        && Boolean(edge.source?.versionedSymbolId && edge.target?.versionedSymbolId)
        && from?.versionedSymbolId === previous?.versionedSymbolId
        && sourceHashes.get(edge.source!.site.path) === edge.source!.contentHash
        && sourceHashes.get(edge.target!.site.path) === edge.target!.contentHash
        && Boolean(answer.sites[index])
        && /^[a-f0-9]{64}$/.test(edge.source?.contentHash ?? '') && /^[a-f0-9]{64}$/.test(edge.target?.contentHash ?? '');
    })) { rejectedReachPath = true; continue; }
    for (const testPath of new Set(path.siteIndices.map(index => answer.sites[index]?.path).filter(file => file && testPaths.has(file))))
      reachPaths.push({ testPath: testPath!, siteIndices: [...path.siteIndices], walk: path.walk });
  }
  const completeReach = measured && !answer.error && Boolean(answer.traversal)
    && answer.traversal?.outcome !== 'incomplete' && !answer.truncation.truncated && !rejectedReachPath;
  const reachStatus = measured && !answer.error && reachPaths.length ? 'found'
    : completeReach ? 'not-found-in-scope' : 'unknown';
  const testReach: NativeChangeReport['testReach'] = { symbol: subject.symbol, file: subject.file,
    status: reachStatus, tests: measured && !answer.error
      ? relevantTests.filter(site => reachPaths.some(path => path.testPath === site.path)) : [],
    paths: measured && !answer.error ? reachPaths : [], executionCoverage: 'unmeasured',
    gapSuggestion: reachStatus === 'not-found-in-scope'
      ? `No static test reach for ${subject.symbol} was found in the requested scope; add a calling test and run the baseline suite.` : null };
  limitations.push('Static test reach suggests tests to run; it does not establish executed coverage or passing tests.');
  const capturedInterfaces = (answer as import('./first-party-callers').FirstPartyCallersAnswer).interfaces;
  const interfaceMeasured = measured && !answer.error && capturedInterfaces?.status === 'measured';
  const interfaces: NativeChangeReport['interfaces'] = { status: interfaceMeasured ? 'measured' : 'unknown',
    diagnostics: interfaceMeasured ? capturedInterfaces.diagnostics : [], registrations: interfaceMeasured ? capturedInterfaces.registrations : [],
    mismatchedConsumers: interfaceMeasured ? capturedInterfaces.diagnostics.filter(diagnostic =>
      consumers.some(consumer => consumer.path === diagnostic.site.path)).map(diagnostic => diagnostic.site) : [],
    truncated: capturedInterfaces?.truncated ?? false,
    limitations: capturedInterfaces?.limitations ?? ['Interface diagnostics and static registrations were not supplied by the compiler worker.'] };
  const bundle = await nativeEvidenceBundle(answer, captured,
    effects.writeArtifact ?? (body => defaultWriteArtifact(body, 'native-source-path', 'markdown')));
  return { answer, report: { subject, changed, consumers, relevantTests, interfaces, testReach, recheck, sourceFingerprint,
    freshness: !measured ? 'unmeasured' : !subject.previousFingerprint ? 'first-read'
      : subject.previousFingerprint === sourceFingerprint ? 'unchanged' : 'changed',
    provenance: { ...git, runtime: getBuildInfo(), graph: answer.evidence }, limitations: [...new Set(limitations)], bundle,
  } };
}

// ───────────────────────── injected effects ─────────────────────────

export interface ExecOpts {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}
export type ExecFn = (bin: string, argv: readonly string[], opts?: ExecOpts) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (bin, argv, opts) => {
  const { stdout } = await runExecFile(bin, [...argv], {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? 180_000,
    maxBuffer: opts?.maxBuffer ?? MAX_PACK_BYTES,
  });
  return { stdout };
};

export interface PackerEffects {
  readonly exec: ExecFn;
  readonly writeArtifact: (body: string, engine: PackerEngine, format: PackFormat) => Promise<string>;
  readonly now: () => Date;
}

const defaultWriteArtifact = async (body: string, engine: PackerEngine | 'native-source-path', format: PackFormat): Promise<string> => {
  const dir = papercuspPath('scratch', 'packs');
  await mkdir(dir, { recursive: true });
  const sha = createShortHash(body);
  const path = join(dir, `${engine}-${sha}-${Date.now()}.${format === 'xml' ? 'xml' : 'md'}`);
  await writeFile(path, body, 'utf8');
  return path;
};

function createShortHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

export const DEFAULT_PACKER_EFFECTS: PackerEffects = Object.freeze({
  exec: defaultExec,
  writeArtifact: defaultWriteArtifact,
  now: () => new Date(),
});

// ───────────────────────── answers ─────────────────────────

const INTENT: CodeIntelIntent = 'pack';

function refusal(engine: PackerEngine, query: string, error: string, startedAt: number): PackerResult {
  return {
    answer: {
      backend: engine,
      intent: INTENT,
      query,
      sites: [],
      truncation: { truncated: false, totalAvailable: null, continuation: null },
      // NOT 'healthy': a refusal must never satisfy isTrustworthyEmpty, or
      // "the packer is not provisioned" reads as "the selection was empty".
      freshness: { health: 'unknown', indexedAt: null, staleVsDisk: null, indexedCommit: null },
      latencyMs: Date.now() - startedAt,
      error,
    },
    artifact: null,
  };
}

/** Resolve git facts for the provenance stamp. Never throws — absence is reported as null. */
export async function readGitProvenance(
  rootPath: string,
  baseRef: string | undefined,
  exec: ExecFn,
): Promise<{ commit: string | null; dirty: boolean | null; baseCommit: string | null }> {
  const git = async (argv: string[]): Promise<string | null> => {
    try {
      const { stdout } = await exec('git', argv, { cwd: rootPath, timeoutMs: 15_000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const commit = await git(['rev-parse', 'HEAD']);
  const status = commit === null ? null : await git(['status', '--porcelain']);
  const baseCommit = baseRef ? await git(['rev-parse', baseRef]) : null;
  return { commit, dirty: status === null ? null : status.length > 0, baseCommit };
}

/**
 * Produce a pack, or a diff-shaped reviewer prompt.
 *
 * NEVER writes into the workspace: the artifact goes to a scratch path outside
 * the tree, and neither arg builder can emit an engine flag that writes.
 * Refusals are ANSWERS — a disabled flag, an unprovisioned binary, a drifted
 * pin, an empty include set and a genuinely-empty selection are five distinct
 * states, and each returns something that says which.
 */
export async function packerFacade(
  op: PackerOp,
  args: PackerArgs,
  effects: PackerEffects = DEFAULT_PACKER_EFFECTS,
): Promise<PackerResult> {
  const started = Date.now();
  const engine: PackerEngine = op === 'diff' ? 'code2prompt' : 'repomix';
  const format: PackFormat = args.format ?? (op === 'diff' ? 'markdown' : 'xml');
  const query = `${op}:${args.include.join(',')}${args.baseRef ? ` vs ${args.baseRef}` : ''}`;

  if (!(await getFlag(FLAGS.CODE_INTEL_PACKERS, 'system').catch(() => false))) {
    return refusal(engine, query, `packing is disabled (${FLAGS.CODE_INTEL_PACKERS} is off)`, started);
  }
  if (args.include.length === 0) {
    return refusal(
      engine,
      query,
      'an explicit, non-empty include set is required (P-016): an unscoped pack of this monorepo is ' +
        'evidence nobody chose, and it is indistinguishable from a correctly-scoped one until read.',
      started,
    );
  }

  const id = await packerIdentity(engine, effects.exec);
  if (!id.ok) return refusal(engine, query, id.reason, started);

  let argv: string[];
  try {
    argv = engine === 'repomix' ? buildRepomixArgs(args) : buildCode2PromptArgs(args);
  } catch (err) {
    return refusal(engine, query, err instanceof Error ? err.message : String(err), started);
  }

  let body: string;
  try {
    const { stdout } = await effects.exec(id.identity.bin, argv, {
      cwd: args.rootPath,
      timeoutMs: 180_000,
      maxBuffer: MAX_PACK_BYTES,
    });
    body = stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = e.stderr?.trim() || e.message || String(err);
    return refusal(engine, query, detail.slice(0, 500), started);
  }

  const template = args.template ?? 'none';
  const document = templateHeader(template) + body;
  const selected = parseSelectedFiles(body, format);
  const git = await readGitProvenance(args.rootPath, args.baseRef, effects.exec);

  const provenance: PackProvenance = {
    engine,
    engineVersion: id.identity.version,
    rootPath: args.rootPath,
    commit: git.commit,
    dirty: git.dirty,
    baseRef: args.baseRef ?? null,
    baseCommit: git.baseCommit,
    include: [...args.include],
    ignore: [...(args.ignore ?? [])],
    denyGlobs: SECRET_DENY_GLOBS,
    template,
    fileCount: selected === null ? null : selected.length,
    bytes: Buffer.byteLength(document, 'utf8'),
    chars: document.length,
    securityScan: engine === 'repomix' ? 'secretlint+deny-set' : 'deny-set-only',
    capturedAt: effects.now().toISOString(),
  };

  const path = await effects.writeArtifact(document, engine, format);
  const sites: SymbolSite[] = (selected ?? []).map((p) => ({
    path: p,
    line1: null,
    kind: 'file',
    detail: null,
  }));

  return {
    answer: {
      backend: engine,
      intent: INTENT,
      query,
      sites,
      truncation: {
        // A pack that hit the byte ceiling is CUT, and saying so is the whole
        // point — a truncated pack read as complete is evidence of absence that
        // is really evidence of a buffer limit.
        truncated: provenance.bytes >= MAX_PACK_BYTES,
        totalAvailable: provenance.fileCount,
        continuation: null,
      },
      freshness: {
        // A packer reads the working tree on every run; there is no index to be
        // stale against. `staleVsDisk` therefore reports whether the tree is
        // dirty relative to the commit stamped in the provenance.
        health: 'healthy',
        indexedAt: provenance.capturedAt,
        staleVsDisk: git.dirty,
        indexedCommit: git.commit,
      },
      latencyMs: Date.now() - started,
      error: null,
    },
    artifact: { path, ...packPreview(document, path, selected), provenance },
  };
}

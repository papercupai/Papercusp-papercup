/**
 * RECURRENCE GUARD — an inline `vi.mock` of an engine this repo CONFIGURES AT
 * MODULE LOAD must stay LOAD-COMPLETE (EI-19466189284256419).
 *
 * WHY THIS EXISTS. Three modules here install a policy into a `@papercusp/*`
 * engine by CALLING it at module load (the P-017 self-install idiom), and each
 * is reached by a side-effect import rather than a boot hook:
 *
 *   lib/search/configure-search-defaults.ts -> configureSearchDefaults
 *   lib/lexicon/configure.ts                -> configureLexicon
 *   lib/memory/configure.ts                 -> configureMemory
 *
 * That design is deliberate and good — coverage is structural instead of
 * something every entry point must remember. But it has one sharp edge in
 * tests: an INLINE `vi.mock` factory replaces the engine WHOLESALE, so a mock
 * omitting the installed export does not fail an assertion — it fails
 * COLLECTION, before a single test runs. And a collection crash fails the whole
 * workspace task, taking unrelated sibling files down with it.
 *
 * That is precisely what red-pinned the fleet gate on 2026-08-03: verdict
 * 20:33:50Z (candidate 8564677998c4) reported THREE failing files, of which
 * only `lib/agent-tools/sessions/search.test.ts` was genuinely broken — the
 * other two passed in isolation. The class is disproportionate twice over: a
 * one-word omission stops the fleet, and the failing-file list it produces
 * points mostly at innocent files, so triage starts in the wrong place.
 *
 * THE INVARIANT. An inline-factory mock of one of these engines must declare
 * the export its policy module installs. A factory that spreads
 * `importOriginal()` is EXEMPT — it carries every export by construction, which
 * is why `agent-tools/__tests__/search-tools.test.ts` survived the incident
 * untouched and is the idiom to prefer for a partial mock.
 *
 * CALIBRATION over derivation. The installed export is declared in the table
 * below rather than inferred, because the real call is often INDIRECT (search
 * calls a local `installSearchDefaults()` at top level, which calls the engine
 * inside) and any inference cheap enough to trust here would either miss that
 * or over-constrain future mocks with every unrelated import. Instead each row
 * is CALIBRATED against its policy module: the guard fails loudly if the
 * binding stops being a value import, or the module-load-time call disappears.
 * A silently-vacuous guard is the failure mode this replaces.
 *
 * FALSIFIABILITY. The scanned root is env-overridable
 * (`PROBE_SEARCH_MOCK_LIB_ROOT`) so this guard can be proven to fail against a
 * crafted offender in a COPY outside the tree — never by mutating the shared
 * checkout, which git-sync would happily commit.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  probeStringLiteralBlindness,
  stripCommentsAndStrings,
  stripCommentsOnly,
} from '../../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const LIB_ROOT = process.env.PROBE_SEARCH_MOCK_LIB_ROOT ?? path.resolve(HERE, '..');

interface PolicyBinding {
  /** Policy module, relative to lib/, that self-installs at module load. */
  policy: string;
  /** The engine package it configures. */
  engine: string;
  /** The export it installs — what an inline mock of `engine` must declare. */
  installs: string;
}

/**
 * Adding a new module-load-time self-install? Add a row here. The calibration
 * test below will tell you immediately if the row does not describe reality.
 */
const POLICY_BINDINGS: PolicyBinding[] = [
  {
    policy: 'search/configure-search-defaults.ts',
    engine: '@papercusp/search',
    installs: 'configureSearchDefaults',
  },
  { policy: 'lexicon/configure.ts', engine: '@papercusp/lexicon', installs: 'configureLexicon' },
  { policy: 'memory/configure.ts', engine: '@papercusp/memory', installs: 'configureMemory' },
];

/**
 * Comments AND string contents are masked BEFORE scanning, not just inside a
 * matched factory — via the shared offset-preserving AST masker, never a regex.
 *
 * Both directions matter. A MENTION of an export must never satisfy the check,
 * and a `vi.mock(...)` that is not live code must never be scanned as if it
 * were: this file's own docblock, a commented-out mock, and — the one that
 * red-pinned the tip pre-flight (WI-10004152) — a mock written as a STRING
 * fixture, e.g. the negative control in `search/chunks/library-placement.test.ts`.
 *
 * Two masks, same offsets: `masked` (comments + string contents blanked) finds
 * the live `vi.mock(` anchors and balances parens without being fooled by a
 * paren inside a string; `commentless` (comments only) supplies the argument
 * text, because the mock TARGET is itself a string literal we must read.
 */
function stripComments(s: string, fileName = 'policy.ts'): string {
  return stripCommentsOnly(s, fileName);
}

/** Is `name` imported as a VALUE (not `type`) from `engine` in `src`? */
function valueImports(src: string, engine: string, name: string): boolean {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${engine.replace('/', '\\/')}['"]`);
  const m = src.match(re);
  if (!m) return false;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('type '))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .includes(name);
}

/** A call expression at column 0 — i.e. executed on import, not inside a fn. */
function hasModuleLoadCall(src: string): boolean {
  return /^[A-Za-z_$][\w$]*\s*\(/m.test(src);
}

function walkTests(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTests(p, out);
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Slice the balanced `(...)` of the vi.mock call starting at `openIdx`. */
function callArgs(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx);
}

function declaresKey(factory: string, name: string): boolean {
  return new RegExp(`(^|[{,\\s])${name}\\s*(:|,|\\})`).test(factory);
}

interface Offender {
  file: string;
  engine: string;
  missing: string;
}

const MOCK_CALL = /vi\.(?:do)?mock\s*\(/gi;
const BY_ENGINE = new Map(POLICY_BINDINGS.map((b) => [b.engine, b.installs]));

/**
 * The detector for ONE source text. Exported shape (source in, offenders out)
 * so the controls below can feed it planted sources without touching the tree.
 */
function scanSource(raw: string, fileName: string): Array<Omit<Offender, 'file'>> {
  // Cheap prefilter: most test files never mock anything; skip the AST pass.
  MOCK_CALL.lastIndex = 0;
  if (!MOCK_CALL.test(raw)) return [];
  const masked = stripCommentsAndStrings(raw, fileName);
  const commentless = stripCommentsOnly(raw, fileName);
  const found: Array<Omit<Offender, 'file'>> = [];
  const re = new RegExp(MOCK_CALL.source, MOCK_CALL.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const openIdx = masked.indexOf('(', m.index);
    if (openIdx < 0) continue;
    // Balance on the MASK (a paren inside a string cannot unbalance it), then
    // read the same span from the comment-only text, where the target survives.
    const span = callArgs(masked, openIdx).length;
    const args = commentless.slice(openIdx + 1, openIdx + 1 + span);
    const target = args.match(/^\s*['"]([^'"]+)['"]\s*,/);
    if (!target) continue; // no factory supplied — nothing to be incomplete
    const installs = BY_ENGINE.get(target[1]);
    if (!installs) continue;
    // A spread of the real module carries every export by construction.
    if (args.includes('importOriginal') || callsFactoryImporter(args)) continue;
    if (!declaresKey(args, installs)) found.push({ engine: target[1], missing: installs });
  }
  return found;
}

/**
 * The factory's first parameter is Vitest's real-module importer, and its NAME is
 * the author's choice: `async (orig) =>` and `async original =>` carry every export
 * exactly like `importOriginal` does. Matching only that literal identifier
 * reported two complete `...await original()` mocks as incomplete and red-pinned
 * the gate. A factory that CALLS its importer is exempt; one that merely declares
 * it and builds a partial object by hand is still scanned.
 */
const FACTORY_PARAM =
  /^\s*['"][^'"]+['"]\s*,\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>|function\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*))/;

function callsFactoryImporter(args: string): boolean {
  const m = args.match(FACTORY_PARAM);
  const param = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!param) return false;
  const body = args.slice((m!.index ?? 0) + m![0].length);
  const name = param.replace(/\$/g, '\\$');
  return new RegExp(`(?<![\\w$])${name}\\s*[<(]`).test(body);
}

function scan(): Offender[] {
  return walkTests(LIB_ROOT).flatMap((file) =>
    scanSource(readFileSync(file, 'utf8'), file).map((o) => ({
      file: path.relative(LIB_ROOT, file),
      ...o,
    })),
  );
}

/** A mock of a self-installed engine that omits its installed export. */
const OFFENDING_MOCK = "vi.mock('@papercusp/search', () => ({ chunkAwareVectorLeg: vi.fn() }));";

describe('inline mocks of self-installed engines stay load-complete', () => {
  // CALIBRATION: each row must still describe a real module-load-time install.
  // Without this, a renamed export or a policy module that stopped
  // self-installing would leave the scan below passing vacuously.
  it.each(POLICY_BINDINGS)('$policy still installs $installs at module load', (binding) => {
    const src = stripComments(readFileSync(path.join(LIB_ROOT, binding.policy), 'utf8'));
    expect(
      valueImports(src, binding.engine, binding.installs),
      `${binding.policy} no longer value-imports ${binding.installs} from ${binding.engine} — ` +
        `update POLICY_BINDINGS, or this guard silently stops covering that engine.`,
    ).toBe(true);
    expect(
      hasModuleLoadCall(src),
      `${binding.policy} has no module-load-time call — if the self-install was ` +
        `removed, drop its row from POLICY_BINDINGS.`,
    ).toBe(true);
  });

  // POSITIVE CONTROL: the planted offender, written as LIVE code, must be
  // flagged — otherwise the blindness control below passes vacuously (a dead
  // detector reports no phantom either).
  it('flags an incomplete inline mock written as live code', () => {
    expect(scanSource(`${OFFENDING_MOCK}\n`, 'planted.test.ts')).toEqual([
      { engine: '@papercusp/search', missing: 'configureSearchDefaults' },
    ]);
    // …and a complete / importOriginal-spreading one is not an offender.
    const complete = "vi.mock('@papercusp/search', () => ({ configureSearchDefaults: vi.fn() }));\n";
    const spread = "vi.mock('@papercusp/search', async (importOriginal) => ({ ...(await importOriginal()) }));\n";
    expect(scanSource(complete + spread, 'planted.test.ts')).toEqual([]);
    // The importer's name is the author's choice; a renamed one that is CALLED is
    // just as complete (the two real user/search*.test.ts mocks are written this way).
    const renamed =
      "vi.mock('@papercusp/search', async original => ({ ...await original<typeof import('@papercusp/search')>() }));\n" +
      "vi.mock('@papercusp/search', async (orig) => ({ ...(await orig()), runHybridSearch: vi.fn() }));\n";
    expect(scanSource(renamed, 'planted.test.ts')).toEqual([]);
    // …but declaring the importer without calling it carries nothing.
    const declaredOnly = "vi.mock('@papercusp/search', async (orig) => ({ chunkAwareVectorLeg: vi.fn() }));\n";
    expect(scanSource(declaredOnly, 'planted.test.ts')).toEqual([
      { engine: '@papercusp/search', missing: 'configureSearchDefaults' },
    ]);
  });

  // NEGATIVE CONTROL: the same mock appearing only in a string, a template
  // literal or a comment is a fixture/prose, not a mock (WI-10004152 — the
  // library-placement negative control red-pinned the tip pre-flight).
  it('does not flag a mock that appears only in a string, template or comment', () => {
    const probe = probeStringLiteralBlindness((src: string) => scanSource(src, 'probe.test.ts'), OFFENDING_MOCK);
    expect(probe.ok, probe.detail).toBe(true);
  });

  it('every inline-factory mock declares the installed export', () => {
    const offenders = scan();
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These mocks replace an engine wholesale but omit the export its policy ` +
          `module calls at module load, so the file fails COLLECTION (and takes its ` +
          `whole workspace task down with it):\n` +
          offenders
            .map((o) => `  ${o.file} — mocking ${o.engine}, missing: ${o.missing}`)
            .join('\n') +
          `\nFix: add \`<name>: vi.fn()\` to the factory, or spread ` +
          `\`importOriginal()\` to carry every export by construction.`,
    ).toEqual([]);
  });
});

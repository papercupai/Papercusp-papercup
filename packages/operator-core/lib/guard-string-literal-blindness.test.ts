/**
 * guard-string-literal-blindness.test.ts — the recurrence guard for the PHANTOM-OFFENDER class.
 *
 * THE DEFECT THIS EXISTS TO PREVENT (EI-19989853369726696 -> EI-19991116787260658):
 * a lint guard strips COMMENTS and then text-matches a call-shaped token, leaving STRING
 * LITERALS intact. A guard's error message quotes the very token the guard detects, so guards
 * are exactly the code most likely to contain their own detection tokens inside strings — and
 * `apps/operator/lib/release/green-checkpoint.ts` quoting another guard's failure text
 * ('... bypassed managedSetInterval (P-008) ...') minted a phantom offender that RED-PINNED the
 * fleet gate on a file that does not even import the symbol. Agents then triaged a call site
 * that did not exist, which reads as a triage failure rather than a guard defect.
 *
 * The root cause was never one guard: `stripComments` was COPY-PASTED into 16 scripts. This
 * suite ratchets that population down and proves the migrated ones are actually fixed.
 *
 * ⚠ NOT every guard may strip strings. Some detect tokens that legitimately live INSIDE string
 * or template literals — `check-drop-database-force` matches `DROP DATABASE`, which in TS source
 * appears ONLY inside a SQL template literal, so stripping strings there would convert a phantom
 * POSITIVE into a silent false NEGATIVE on dropping a database. The split is per CALL SITE, not
 * per guard: see `stripCommentsOnly`'s doc for the case where one guard needs both.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error -- .mjs guard script, no type declarations
import { usesEagerExecFilePromisify } from '../../../scripts/check-no-eager-execfile-promisify.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { usesModuleScopeFlagSubscribe } from '../../../scripts/check-no-module-scope-flag-subscribe.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { isRawAgentSpawnBypass } from '../../../scripts/check-no-raw-agent-spawn.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { usesRawSetInterval } from '../../../scripts/check-no-raw-setinterval.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { findOffendersInText } from '../../../scripts/check-no-retired-imports.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { findSelfReferentialExports } from '../../../scripts/check-no-self-referential-export.mjs';
// No @ts-expect-error: enrolled in tsconfig.declarations.json, so this import is genuinely typed
// and a directive here would be TS2578 "unused".
import { isUnenrolledDetachedSpawn } from '../../../scripts/check-no-unenrolled-detached-spawn.mjs';
// @ts-expect-error -- .mjs guard script, no type declarations
import { scanSource } from '../../../scripts/check-no-wire-compression.mjs';
// Enrolled in tsconfig.declarations.json — typed, no directive (see above).
import { countReexportChains } from '../../../scripts/check-typeless-reexport-trap.mjs';
import {
  firstLiveMatch,
  probeStringLiteralBlindness,
  stripCommentsAndStrings,
  stripCommentsOnly,
  // No @ts-expect-error here any more: the module is registered in tsconfig.declarations.json
  // (WI-37605) and now has a generated sibling .d.mts, so this import is genuinely typed. The
  // directive that used to sit here became TS2578 "unused" the moment that landed.
} from '../../../scripts/lib/strip-comments-and-strings.mjs';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

describe('stripCommentsAndStrings', () => {
  it('empties string contents while KEEPING delimiters, so nothing concatenates across the removal', () => {
    // Blanked with spaces rather than deleted: the output is the same LENGTH as the input, so
    // offsets and line numbers in the stripped text still address the source (EI-20064929206355679).
    const src = `const a = 'setInterval(';\nconst b = 2;`;
    const out = stripCommentsAndStrings(src, 'a.ts');
    expect(out).toBe(`const a = '            ';\nconst b = 2;`);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain('setInterval(');
  });

  it('does not let `//` inside a string start a comment (the mutual-escaping case)', () => {
    // A chained strip-comments-then-strip-strings pass gets this wrong and eats the rest of the line.
    const out = stripCommentsAndStrings(`const u = 'http://x'; const kept = 1;`);
    expect(out).toContain('const kept = 1;');
  });

  it("does not let a quote inside a comment open an unterminated literal (`// don't`)", () => {
    const out = stripCommentsAndStrings(`// don't\nconst kept = 'v';\n`);
    expect(out).toContain('const kept =');
  });

  it('PRESERVES ${...} template expressions as CODE — dropping them would trade a false positive for a false negative', () => {
    expect(stripCommentsAndStrings('const s = `a ${setInterval(fn)} b`;')).toContain('setInterval(fn)');
  });
});

// Each of these pairs a DECLINE with a FIRE in the SAME fixture. A stripper that returns nothing
// useful would satisfy every "does not contain" assertion on its own, so "it didn't flag" is only
// evidence when the same input proves it still CAN flag. (EI-20064929206355679: the pre-AST lexer
// carried all four defects below; each was measured against the real tree before being fixed.)
describe('the lexer defects an AST parse removes', () => {
  const detects = (src: string, name = 'a.ts') => /\bsetInterval\s*\(/.test(stripCommentsAndStrings(src, name));

  it('a regex literal containing a quote does not erase the code after it', () => {
    // OLD: the `'` in /['"]/ opened a phantom string that ran to the newline, DELETING the rest
    // of the line — a real call site on that line vanished, and the newline was eaten too.
    const src = `const RE = /['"]/; setInterval(fn, 1000);\n`;
    expect(detects(src)).toBe(true); // FIRES on the real offender...
    expect(detects(`const RE = /['"]/; const msg = 'setInterval(';\n`)).toBe(false); // ...and declines on the quoted one
  });

  it('keeps line numbers true across a block comment (they used to shift UP)', () => {
    // OLD: block comments were deleted NEWLINES AND ALL, so every later line moved up and any
    // caller counting lines in the stripped text reported the wrong one.
    const src = ['/* one', '   two', '   three */', 'setInterval(fn);', ''].join('\n');
    const out = stripCommentsAndStrings(src, 'a.ts');
    expect(out.split('\n')).toHaveLength(src.split('\n').length);
    expect(out.split('\n').findIndex((l) => l.includes('setInterval('))).toBe(3);
  });

  it('does not concatenate code across a removed block comment', () => {
    // The module keeps string delimiters precisely so nothing new is concatenated across a
    // removal — but OLD deleted block comments OUTRIGHT, so `*/const run = ...` collapsed onto
    // the line above and an ^-anchored module-scope detector fired on a declaration that is
    // not at line start. Blanking preserves the column, so it correctly declines.
    const glued = '/* c\n*/const run = promisify(execFile);\n';
    const anchored = /^(export\s+)?(const|let)\s+\w+\s*=\s*promisify\(\s*execFile\w*\s*\)/m;
    expect(anchored.test(stripCommentsAndStrings(glued, 'a.ts'))).toBe(false);
    // ...and a genuine column-0 declaration below a block comment still FIRES.
    expect(anchored.test(stripCommentsAndStrings('/* c\n*/\nconst run = promisify(execFile);\n', 'a.ts'))).toBe(true);
  });

  it('blanks a regex BODY, where a guard is most likely to quote its own token', () => {
    expect(detects('const RE = /setInterval(fn)/;\n')).toBe(false);
    expect(detects('const RE = /setInterval(fn)/;\nsetInterval(fn);\n')).toBe(true);
  });

  it('survives astral emoji before a literal (UTF-16 code units, not code points)', () => {
    // Splitting by code POINT desynchronises every offset after an emoji and mis-blanks real code.
    const src = `const icon = '🚨';\nsetInterval(fn);\n`;
    const out = stripCommentsAndStrings(src, 'a.ts');
    expect(out).toHaveLength(src.length);
    expect(out).toContain('setInterval(fn);');
  });
});

describe('stripCommentsOnly is regex-aware too (the phantom that reached the census)', () => {
  it('still blanks a comment that FOLLOWS a regex containing a quote', () => {
    // OLD: the quote opened a phantom string that never closed, so from there to EOF no comment
    // was blanked. Measured: it put a `role: 'cup'` read out of a doc comment into the
    // mug/kettle surface census.
    const src = `const RE = /'/;\nconst live = 'kept';\n// role: 'cup'\n`;
    const out = stripCommentsOnly(src, 'a.ts');
    expect(out).not.toContain("role: 'cup'"); // the comment is gone...
    expect(out).toContain("const live = 'kept'"); // ...and string VALUES are still readable
  });

  // NOT a defect of the pre-AST lexer (it got this right). This guards the AST implementation:
  // a comment starting on the same line as the previous token is TRAILING trivia, and a
  // leading-trivia-only scan silently leaves it standing as live code. That intermediate
  // resurrected a `kettle` mention inside a JSX comment during this very fix.
  it('blanks a JSX {/* ... */} comment — trailing trivia, which leading-only trivia scanning misses', () => {
    const src = 'const A = () => (<div>{/* role: kettle */}<b/></div>);\n';
    const out = stripCommentsOnly(src, 'a.tsx');
    expect(out).not.toContain('role: kettle');
    expect(out).toContain('<b/>');
  });

  it('leaves JSX TEXT alone — `//` in a URL is content, not a comment', () => {
    const src = 'const A = () => (<p>see https://x/y and role: kettle</p>);\n';
    expect(stripCommentsOnly(src, 'a.tsx')).toContain('role: kettle');
  });
});

describe('firstLiveMatch — the mask used as an ORACLE, for patterns that span code and string', () => {
  const live = (raw: string, re: RegExp) => firstLiveMatch(raw, stripCommentsAndStrings(raw, 'a.ts'), re);
  const IMPORT_RE = /(?:\bfrom\b|\bimport\b)\s*\(?\s*['"`][^'"`]*_retired\//;

  it('keeps a real import, whose SPECIFIER is legitimately a string literal', () => {
    expect(live(`import x from '_retired/y';\n`, IMPORT_RE)).not.toBeNull();
  });

  it('rejects the same text quoted inside a template literal', () => {
    expect(live('const doc = `\nimport x from \'_retired/y\';\n`;\n', IMPORT_RE)).toBeNull();
  });

  // THE REASON THIS IS A HELPER AND NOT AN INLINE `isLiveCodeAt` CHECK. A single exec returns the
  // LEFTMOST match; testing only that one rejects the whole line when a phantom happens to precede
  // a real hit, turning a false-positive fix into a silent false NEGATIVE.
  it('scans PAST a phantom to a real match later on the same line', () => {
    const raw = `const doc = 'import x from "_retired/y"'; import z from '_retired/y';\n`;
    expect(live(raw, IMPORT_RE)).not.toBeNull();
  });

  // A pattern opening with `^\s*` puts a SPACE at m.index, and a blanked character is also a
  // space — so anchoring on m.index reports a masked match as live and lets the phantom through.
  it('anchors on the first NON-WHITESPACE character, not on m.index', () => {
    const re = /^\s*export\s+\*\s+from\s+['"][^'"]+['"]/m;
    expect(live(`export * from './x';\n`, re)).not.toBeNull();
    expect(live('const doc = `\n  export * from \'./x\';\n`;\n', re)).toBeNull();
  });

  it('does not mutate the caller\'s regex or leak lastIndex between calls', () => {
    const shared = /\bgzip\b/g;
    const raw = 'gzip(); gzip();\n';
    const masked = stripCommentsAndStrings(raw, 'a.ts');
    expect(firstLiveMatch(raw, masked, shared)).not.toBeNull();
    expect(shared.lastIndex).toBe(0);
    expect(firstLiveMatch(raw, masked, shared)).not.toBeNull();
  });
});

describe('the probe itself is falsifiable (control + calibration)', () => {
  // CONTROL: the exact pre-fix implementation. If the probe cannot catch THIS, it cannot catch
  // anything, and every "ok" below would be vacuous.
  const brokenDetector = (src: string) => /\bsetInterval\s*\(/.test(stripCommentsOnly(src));
  // CALIBRATION: the same detector over the shared stripper. Proves the probe is not simply
  // flagging everything handed to it.
  const fixedDetector = (src: string) => /\bsetInterval\s*\(/.test(stripCommentsAndStrings(src));
  const TOKEN = 'a bare setInterval (P-008) is banned';

  it('CATCHES a comments-only detector (the defect that red-pinned the gate)', () => {
    const verdict = probeStringLiteralBlindness(brokenDetector, TOKEN);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('PHANTOM');
  });

  it('PASSES a detector that strips strings too', () => {
    expect(probeStringLiteralBlindness(fixedDetector, TOKEN).ok).toBe(true);
  });
});

describe('migrated guards do not mint phantom offenders from tokens quoted in prose', () => {
  const cases: Array<[string, (src: string) => unknown, string]> = [
    ['check-no-raw-setinterval', usesRawSetInterval, 'a bare setInterval (P-008) is banned'],
    ['check-no-raw-agent-spawn', isRawAgentSpawnBypass, 'never call buildInvokeOnce (use the ledger)'],
    [
      'check-no-eager-execfile-promisify',
      usesEagerExecFilePromisify,
      'const run = promisify(execFile) at module scope is banned',
    ],
    [
      'check-no-module-scope-flag-subscribe',
      usesModuleScopeFlagSubscribe,
      'onFlagChange (cb) at module scope is banned',
    ],
    // Added WI-37717. These five were "INCONCLUSIVE" under the previous probe — a mirror corpus
    // that planted the token in a /tmp tree and watched whether the guard fired. That probe could
    // never distinguish "read the file and correctly ignored it" from "never enumerated the file
    // at all", so a guard that mints phantoms and a guard that is clean produced the SAME result.
    // Handing the detector the prose form DIRECTLY removes that ambiguity: it cannot fail to read
    // an argument. All five were confirmed phantom-minting and then fixed.
    ['check-no-self-referential-export', (src: string) => findSelfReferentialExports('a.ts', src), 'export const foo = foo;'],
    ['check-typeless-reexport-trap', (src: string) => countReexportChains(src, 'a.ts'), `export * from '@x/trap';`],
    ['check-no-retired-imports', (src: string) => findOffendersInText('a.ts', src), `fetch('/plugins/orchestrator/spawn')`],
    [
      'check-no-unenrolled-detached-spawn',
      (src: string) => isUnenrolledDetachedSpawn('packages/x/a.ts', src),
      'spawn(cmd, args, { detached: true })',
    ],
    ['check-no-wire-compression', (src: string) => scanSource(src, 'a.ts'), 'createGzip() on the wire is banned'],
  ];

  for (const [name, detector, token] of cases) {
    it(`${name}: its own detection token, quoted in prose, is not a call site`, () => {
      // POSITIVE CONTROL FIRST — and it is not ceremony. A detector that never fires AT ALL
      // passes the phantom probe perfectly, so without this line a broken or mis-tokened entry
      // reads as the strongest possible pass. That is not hypothetical: while classifying these
      // guards, `check-explicit-presence` returned a clean verdict and the only reason it was not
      // recorded as clean is that this control showed its token never fired as bare code either.
      // A suspiciously tidy sweep of green is the tell — assert the teeth before the restraint.
      const bare = detector(`${token}\n`);
      expect(
        Array.isArray(bare) ? bare.length > 0 : Boolean(bare),
        `${name}: VACUOUS CASE — the token does not fire as bare code, so "no phantom" says ` +
          `nothing about string-literal blindness. Fix the token, do not delete the assertion.`,
      ).toBe(true);

      const verdict = probeStringLiteralBlindness(detector, token);
      expect(verdict.ok, `${name}: ${verdict.detail}`).toBe(true);
    });
  }
});

/**
 * Classification of one guard script, from its own source with ITS comments masked.
 *
 * Masking first is not a nicety: v1 of this census keyed on `.ts` appearing anywhere in the
 * script and counted 44 unmasked guards, because nearly every guard's header comment NAMES
 * the `.ts` files it scans. The classifier had the exact defect it was built to measure.
 * Masked, the honest number is 31. (EI-20045405992394901.)
 */
const SHARED_STRIPPER = /strip-comments-and-strings\.mjs/;
/**
 * Any comment stripper, ANY spelling and ANY binding form — `stripSqlComments`,
 * `const stripComments = …`, `maskCommentsAndStrings`, `blankStringLiterals`.
 *
 * ⚠ THE VERB SET IS LOAD-BEARING, and the old `strip`-only rule proves why: this comment
 * already CLAIMED "ANY spelling" while matching only /strip[A-Za-z]*Comments?/, and
 * `check-no-unthreaded-apply.mjs` sat in the corpus the whole time calling its private lexer
 * `maskCommentsAndStrings`. One name-specific regex gave TWO wrong answers about that file:
 * it read as masking NOTHING, so it landed in SCANS_UNMASKED_SOURCE (false — it did mask)
 * while escaping this shrink-only baseline (false — it was a copy-paste of the exact defect,
 * regex-blind included). A guard-of-guards that classifies by NAME cannot see a synonym, and
 * "any spelling" in a comment is not a rule. Widened 2026-08-10 (WI-37717).
 */
const STRIPPER_NAME = String.raw`(?:strip|mask|blank|scrub|elide|redact)[A-Za-z]*(?:Comments?|Strings?|Literals?|Bodies)`;
/**
 * A stripper DEFINITION, not a mention — and the distinction is the whole point (WI-37801).
 *
 * Matching any MENTION cannot work here, because the import statement of a migrated file
 * (`import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs'`) mentions a
 * stripper name itself. That collision is why the classifier used to return on the FIRST
 * match with `shared` ranked ahead of `hand-rolled`: it was the only way to stop every
 * migrated file from re-reporting as a hand-roller. But ordering traded one wrong answer for
 * another — it made a PARTIALLY migrated file permanently invisible, so the first migrated
 * call site in a file switched off enforcement for every hand-rolled stripper still in it.
 *
 * Anchoring on the definition forms dissolves the conflict instead of ranking it: a bare
 * import has no definition and still classifies `shared`, while a file that imports the
 * shared module AND defines its own stripper is correctly `hand-rolled`.
 */
const NAMED_STRIPPER_DEF = new RegExp(
  String.raw`\b(?:export\s+)?(?:async\s+)?function\s*\*?\s*${STRIPPER_NAME}\s*\(` +
    String.raw`|\b(?:const|let|var)\s+${STRIPPER_NAME}\s*=` +
    String.raw`|^[ \t]*(?:static\s+)?(?:async\s+)?${STRIPPER_NAME}\s*\([^)\n]*\)\s*\{`,
  'm',
);
/** The two copy-pasted regexes themselves, matched as literal text — they are the defect. */
const NAIVE_BLOCK_RE = String.raw`\/\*[\s\S]*?\*\/`;
const NAIVE_LINE_RE = String.raw`\/\/.*$`;
// `.createSourceFile(` is matched under ANY receiver: a guard that lazy-loads the compiler
// (`const t = loadTypescript(); t.createSourceFile(...)`) parses an AST just as surely as one
// spelled `ts.`, and the module-name string it required is blanked by the masking itself.
// check-no-unenrolled-detached-spawn.mjs read as 'unmasked' on exactly that alias (2026-09-28).
// `@typescript-eslint/typescript-estree` / `/parser` are parsers too: check-bundle-free-refs.mjs
// walks an ESTree + scope-manager AST and its `.test(` calls read identifier NAMES, never raw
// source, yet read as 'unmasked' because only the four parsers above were named (EI-25706078725120945).
const PARSES_AST =
  /from\s*['"]typescript['"]|\.createSourceFile\s*\(|@babel\/parser|@typescript-eslint\/(?:typescript-estree|parser)['"]|\bacorn\b|ts-morph/;
const SCANS_CODE_FILES = /\.tsx?['"`]|\.mjs['"`]|\.jsx['"`]|\.cts['"`]|\.mts['"`]/;
const TEXT_MATCHES = /\.test\s*\(|\.match(All)?\s*\(|\.includes\s*\(|\.exec\s*\(/;
const READS_FILES = /readFileSync|execFileSync\s*\(\s*['"](rg|grep)['"]/;

/**
 * Observe the guard's executable file selectors, rather than extension mentions in its
 * imports or fixtures (EI-20077125623815751). The filesystem and process APIs below are
 * inert: only module SOURCE is loaded from disk; guard reads see fixture contents, and
 * writes, subprocesses and unsupported modules make the result explicitly unknown.
 * Unknown never means clean. A positive read remains evidence even if a later operation
 * is unsupported; a negative result requires the complete synchronous fixture execution.
 */
function observeReaderCorpus(entry: string, inventory: string[], sources?: Record<string, string>, options: { testCallbacks?: boolean; argv?: string[] } = {}) {
  const root = path.resolve(SCRIPTS_DIR, '..');
  const reads = new Set<string>();
  const unsupported = new Set<string>();
  let enumerated = false;
  let directoryEntriesVisited = 0;
  let asynchronous = false;
  let exited = false;
  let completedTests = 0;
  let unsupportedTestSelection = false;
  const testBodies: Array<() => unknown> = [];
  const testHooks: Array<() => unknown> = [];
  const absolute = (p: unknown) => p instanceof URL ? fileURLToPath(p) : path.resolve(root, String(p));
  const relative = (p: unknown) => path.relative(root, absolute(p)).replaceAll('\\', '/');
  const deny = (operation: string): never => { unsupported.add(operation); throw new Error(operation); };
  const files = new Set(inventory);
  const directories = new Set(['']);
  const childNames = new Map<string, Set<string>>();
  for (const f of files) {
    let child = f;
    for (;;) {
      const parent = path.posix.dirname(child);
      const dir = parent === '.' ? '' : parent;
      directories.add(dir);
      if (!childNames.has(dir)) childNames.set(dir, new Set());
      childNames.get(dir)!.add(path.posix.basename(child));
      if (!dir) break;
      child = dir;
    }
  }
  // Index immediate children once. Filtering the complete inventory for every
  // directory made CSS-only walks exhaust the VM budget before their first read.
  const directoryChildren = new Map([...childNames].map(([dir, names]) => [dir, [...names].sort()]));
  const read = (p: unknown, encoding?: unknown) => {
    const rel = relative(p);
    reads.add(rel);
    // JSON is input to several selectors' preflight (a corrupt/empty baseline can exit
    // before scanning). Preserve tracked repository metadata, never host configuration.
    const text = rel.endsWith('.json') && !sources && files.has(rel) ? readFileSync(path.resolve(root, rel), 'utf8') : rel.endsWith('.json') ? '{}' : '';
    return encoding ? text : Buffer.from(text);
  };
  const fs = new Proxy({
    readFileSync: read,
    existsSync: (p: unknown) => files.has(relative(p)) || directories.has(relative(p)),
    realpathSync: absolute,
    statSync: (p: unknown) => ({ isFile: () => files.has(relative(p)), isDirectory: () => directories.has(relative(p)), size: 0 }),
    lstatSync: (p: unknown) => ({ isFile: () => files.has(relative(p)), isDirectory: () => directories.has(relative(p)), isSymbolicLink: () => false, size: 0 }),
    readdirSync: (p: unknown, options?: { withFileTypes?: boolean }) => {
      enumerated = true;
      const dir = relative(p);
      const prefix = dir ? dir + '/' : '';
      const names = directoryChildren.get(dir) ?? [];
      directoryEntriesVisited += names.length;
      return options?.withFileTypes ? names.map(name => ({ name, isDirectory: () => directories.has(prefix + name), isFile: () => files.has(prefix + name), isSymbolicLink: () => false })) : names;
    },
  }, { get(target, key) { return key in target ? target[key as keyof typeof target] : (..._args: unknown[]) => deny('fs.' + String(key)); } });
  const enumerate = () => { enumerated = true; return { files: [...files], unscanned: [] }; };
  const tracked = { listTrackedFiles: enumerate, listFilesIncludingUntracked: enumerate, describeUnscanned: () => '', declaredSubmodules: () => [] };
  const childProcess = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => {
    const command = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(' ');
    if (String(key).startsWith('exec') && /^git\s+(?:ls-files|grep)\b/.test(command)) {
      enumerated = true;
      return inventory.join(command.includes('-z') ? '\0' : '\n');
    }
    return deny('child_process.' + String(key) + ': ' + command);
  } });
  const exit = { corpusExit: true };
  const moduleCache = new Map<string, { exports: Record<string, unknown> }>();
  const context = createContext({
    Buffer, URL, URLSearchParams,
    console: { log() {}, error() {}, warn() {} },
    process: { argv: ['node', path.resolve(root, entry), ...(options.argv ?? [])], env: {}, cwd: () => root, exit: (code = 0) => { exited = true; if (code !== 0) unsupported.add('early nonzero exit: ' + code); throw exit; }, exitCode: 0, platform: process.platform },
    __observePromise: (value: unknown) => {
      if (value && typeof (value as PromiseLike<unknown>).then === 'function') {
        asynchronous = true;
        Promise.resolve(value).catch(() => {});
      }
      return value;
    },
    // An async guard may install its own .catch(() => process.exit(1)); observing
    // only its initial promise would leave that rejection chain running after the
    // census returned. Do not execute async bodies in this synchronous observer.
    __unsupportedAsync: () => { asynchronous = true; return Promise.resolve(undefined); },
    setTimeout: () => deny('setTimeout'), setInterval: () => deny('setInterval'),
  }, { codeGeneration: { strings: false, wasm: false } });
  const runCallback = (callback: () => unknown) => {
    context.__corpusCallback = callback;
    return new Script('__observePromise(__corpusCallback())').runInContext(context, { timeout: 500 });
  };
  const register = (suite: boolean) => {
    const fn = (_name: unknown, callback?: () => unknown) => {
      if (!callback) { unsupported.add('vitest missing callback'); return; }
      if (suite) runCallback(callback);
      else testBodies.push(callback);
    };
    return Object.assign(fn, {
      only: () => { unsupportedTestSelection = true; unsupported.add('vitest exclusive selection'); },
      skip: () => { unsupported.add('vitest skipped callback'); },
      todo: () => { unsupported.add('vitest todo callback'); },
      each: () => { unsupported.add('vitest parameterized callback'); return () => {}; },
    });
  };
  const vitest = {
    describe: register(true), it: register(false), test: register(false),
    // Assertions and mocks can change control flow. Do not pretend they passed.
    expect: () => deny('vitest assertion'),
    vi: new Proxy({}, { get: (_target, key) => () => deny('vitest.vi.' + String(key)) }),
    beforeAll: (callback: () => unknown) => { testHooks.push(callback); },
    beforeEach: (callback: () => unknown) => { testHooks.push(callback); },
    afterAll: () => { unsupported.add('vitest afterAll'); },
    afterEach: () => { unsupported.add('vitest afterEach'); },
  };
  const load = (specifier: string, importer: string): unknown => {
    const builtin = specifier.replace(/^node:/, '');
    if (specifier === 'vitest' && options.testCallbacks) return vitest;
    if (builtin === 'fs') return fs;
    if (builtin === 'path') return path;
    if (builtin === 'url') return url;
    if (builtin === 'crypto') return crypto;
    if (builtin === 'child_process') return childProcess;
    if (builtin === 'os') return { homedir: () => '/fixture-home', tmpdir: () => '/fixture-tmp', platform: () => process.platform };
    if (builtin === 'module') return { createRequire: () => (s: string) => load(s, importer) };
    let filename = specifier.startsWith('.') ? path.resolve(path.dirname(importer), specifier) : specifier.startsWith('@papercusp/operator-core/') ? path.resolve(root, 'packages/operator-core', specifier.slice('@papercusp/operator-core/'.length)) : path.resolve(root, specifier);
    if (filename.endsWith('/scripts/lib/tracked-files.mjs')) return tracked;
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@papercusp/operator-core/') && importer !== root) return deny('module: ' + specifier);
    const candidates = [filename, filename + '.ts', filename + '.mjs', filename + '.js', path.join(filename, 'index.ts')];
    filename = candidates.find(f => sources ? path.relative(root, f) in sources : existsSync(f)) ?? filename;
    if (!filename.startsWith(root + path.sep)) return deny('module outside repository');
    if (moduleCache.has(filename)) return moduleCache.get(filename)!.exports;
    const source = sources ? sources[path.relative(root, filename)] : readFileSync(filename, 'utf8');
    if (source === undefined) return deny('missing module: ' + path.relative(root, filename));
    const module = { exports: {} };
    moduleCache.set(filename, module);
    const code = ts.transpileModule(source, {
      // TypeScript preserves ESM for a .mjs input even when CommonJS is requested.
      // Parse the same bytes as .ts so the VM receives a require-based module.
      fileName: filename.replace(/\.[cm]js$/, '.ts'),
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      transformers: { before: [ctx => {
        const visit: ts.Visitor = node => {
          if (ts.isFunctionDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type,
              ts.factory.createBlock([ts.factory.createReturnStatement(ts.factory.createCallExpression(ts.factory.createIdentifier('__unsupportedAsync'), undefined, []))]));
          }
          if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            const body = ts.factory.createBlock([ts.factory.createReturnStatement(ts.factory.createCallExpression(ts.factory.createIdentifier('__unsupportedAsync'), undefined, []))]);
            return ts.isArrowFunction(node) ? ts.factory.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, body) : ts.factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
          }
          if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === 'url') return ts.factory.createStringLiteral(url.pathToFileURL(filename).href);
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'main') return ts.factory.createCallExpression(ts.factory.createIdentifier('__observePromise'), undefined, [ts.visitEachChild(node, visit, ctx)]);
          return ts.visitEachChild(node, visit, ctx);
        };
        return sf => ts.visitNode(sf, visit) as ts.SourceFile;
      }] },
    }).outputText.replace(/^#![^\n]*\n/, '\n');
    context.__module = module;
    context.__require = (s: string) => load(s, filename);
    context.__filename = filename;
    context.__dirname = path.dirname(filename);
    new Script(`(function(require,module,exports,__filename,__dirname){${code}\n})(__require,__module,__module.exports,__filename,__dirname)`, { filename }).runInContext(context, { timeout: 500 });
    return module.exports;
  };
  try { load(path.resolve(root, entry), root); }
  catch (error) { if (error !== exit) unsupported.add(String(error)); }
  if (options.testCallbacks && !unsupportedTestSelection) {
    // Hook ordering/state is not modeled. Their reads remain positive evidence,
    // but any hook makes a negative classification explicitly unsupported.
    if (testHooks.length) unsupported.add('vitest lifecycle hooks');
    for (const callback of [...testHooks, ...testBodies]) {
      try { runCallback(callback); completedTests++; }
      catch (error) { if (error !== exit) unsupported.add(String(error)); }
    }
  }
  const codeReads = [...reads].filter(f => /\.[cm]?[jt]sx?$/.test(f)).sort();
  const status = codeReads.length ? 'source' : unsupported.size || asynchronous || (!completedTests && ((!enumerated && !reads.size) || (!exited && !reads.size))) ? 'unknown' : 'non-source';
  return { status, codeReads, reads: [...reads].sort(), unsupported: [...unsupported].sort(), asynchronous, directoryEntriesVisited };
}

// Exact-source reviews from WI12281 concern the default CLI's DIRECT text consumer.
// They do not classify arbitrary exported helpers, CLI input paths or child builds.
const REVIEWED_READER_CORPUS: Record<string, { sha256: string; reason: string }> = {
  'check-docs-mirror.mjs': { sha256: '8018f05a09ac6e3e8208e086957e55b2cee30ea5b3688864deed5df39116b5b8', reason: 'Default .md/.mdx byte fingerprints and git path/time metadata; exported extension arrays are outside this invocation.' },
  'check-fleet-auth.mjs': { sha256: '1eb35e6bdbcfa86039834757fa4bc865dc8a517ab38f9befd8327e1d9ffa40a2', reason: 'Host /proc, fixed .env and credential JSON plus auth diagnostics; no real credentials or auth probes are executed here.' },
  'check-installed-patch-postimages.mjs': { sha256: 'b9a16e60051949a3d9c4154098ae99df55b86e02b53fc3d3bf770453866ece0d', reason: 'Patch header metadata and git byte hashes of installed targets, not JS/TS token matching.' },
  'check-mac-bash-portability.mjs': { sha256: '6bd7ca888080d8affba90c95c7e8742997f012adffcfcf97550d776ac5b4bfd1', reason: 'Shell entry points and a .sh-only invocation closure; shell analysis is outside this JS/TS census.' },
  'check-mdx.mjs': { sha256: 'd9802964aae5a84e47c4514630b50084f7161a12b86367e8927455ab31e7d611', reason: 'Default git inventory restricted to .mdx documentation, asynchronously compiled as MDX.' },
  'check-peer-dep-conflicts.mjs': { sha256: '85339c2018f8247451cdf4f10ff719dcf36b3b269ff491f3d672e007e0f7a3af', reason: 'Workspace globs select package.json manifests, lock JSON and dependency package.json metadata.' },
  'check-reachable-advisories.mjs': { sha256: 'ed17468fca3e2a6d4cc1099ab2dc0af3f911026e645ba6335cd172405ee3bc6b', reason: 'Default package manifests, baseline JSON and npm JSON diagnostics; optional fixture paths are unrestricted.' },
  'check-rust-advisories.mjs': { sha256: '0b301c96b171e6b58480ac40736325628de5801a1aef567dc340b5fe5a9c6fec', reason: 'Default Cargo.lock, baseline JSON and OSV records; explicit --lock/--osv-json paths are outside this review.' },
  'check-systemd-dropins-installed.mjs': { sha256: '27a924f38f144dd87d01299b603eaf4278ffb8eb3a629b7c99aabea8d6052ebd', reason: 'Tracked service/slice/scope .conf inputs, systemctl properties/live prefix-unit names and fixed autostart .desktop bytes; source re-reviewed after b6aae68230 (its gnome-terminal-server LimitNOFILESoft check is one more systemctl property read).' },
  'check-vite-externalized-warnings.mjs': { sha256: '70fe3293f3b40271c07994c416c7b266cc49a27450f9792d783982f79c0a3d7d', reason: 'Baseline JSON and child build diagnostics; child source loading is distinct from this direct text consumer.' },
};

// WI12476: these are SOURCE REVIEWS, not successful sandbox executions. A denied
// import/assertion can stop the inert VM before a real selector runs. Exact bytes
// pin the reviewed direct text consumers without allowing their effects to run.
// Scope is test callbacks in the default inert environment (no env overrides).
// Imports loading implementation code are not themselves direct text consumers.
// `sha256` may list SEVERAL reviewed blobs when the frozen repair lineage and staging carry
// different reviewed versions of one file, so the same guard bytes pass on both
// (frozen-lineage-red-burndown-2026-10-27#D-001 rule 2). Every listed blob is one a person
// reviewed; drop the superseded one once the lineages converge.
const REVIEWED_TEST_READER_CORPUS: Record<string, { sha256: string | readonly string[]; status: 'source' | 'non-source'; reason: string }> = {
  'apps/operator-vite/src/__tests__/dark-flag-route-contract.test.ts': { sha256: '322a839a3d202eb7cd478ab0fba70eba245e7a99b53747ea6eb5571a4919695f', status: 'source', reason: 'listSourceFiles selects non-test .ts/.tsx route files; gatedRoutes reads and strips their bytes.' },
  'apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts': { sha256: 'cc75f6b293ce65d632e7d839c84047b13f545eda5ea03cee1d3bfa5b36552f81', status: 'source', reason: 'Reads vite.config.ts and traverses client/workspace JS/TS imports, then inspects each selected source.' },
  'apps/operator/app/_components/monaco-cdn.test.ts': { sha256: '97a5d44ac35a76868e1c036e76b6a2110a6b942a47730df711ad3616cd336824', status: 'source', reason: 'Async live TypeScript enumeration and fixed live-source-files.ts/Monaco runtime reads; fs/promises is unsupported by the VM.' },
  'apps/operator/app/_components/porcupine-cdn.test.ts': { sha256: '632e01f0b5fbba4b1c12ec5740075ee32c1e79248fe3bc9ac9aa745173f6e5df', status: 'source', reason: 'Async fixed Porcupine engine TypeScript reads, alongside shell setup and model bytes.' },
  'apps/operator/app/_components/vditor-cdn.test.ts': { sha256: 'f302eb4a6012012d5fa492b77d1593ce4c648afd501de061dc725e02eccd5652', status: 'source', reason: 'Reads MarkdownEditor.tsx and enumerated live TypeScript constructors, plus fixed JavaScript bundles.' },
  'apps/operator/lib/chat-actions/ctx-wiring.test.ts': { sha256: '3e260183930b03b2453e8195dccb0d4e165378e214bf3ce4c6b6b7f36f1622ac', status: 'source', reason: 'actionModules reads sibling .ts action files; CTX_SITE reads SessionChatModal.tsx for supplied keys.' },
  'apps/operator/scripts/__tests__/backup-tier-split.test.ts': { sha256: ['d86d3c6ec7bd334ac6b24335958ecaac01f6b6a15809514fb3d05a1343ae487b', '44158090bbf15a40756eb23ee90f9bd4c8aee211c0883f0fda1390167486db3b'], status: 'non-source', reason: 'Default direct reads are .sh backup scripts (incl. kopia-cache-bootstrap.sh since 6878d407a4) and temp archive fixture bytes. Env override paths and child shell execution are outside this review.' },
  'packages/operator-core/lib/__tests__/affected-tests-passing-verdict-cache.test.ts': { sha256: ['aa56e01f22082d49168585df1d79c6c6840893307f51bb03c9d25611d2ce35ad', '07105649a749de82a0aa555afd41c2737f92c15bb2daadc535f17329ada03813'], status: 'source', reason: 'Directly reads affected-tests.mjs, green-checkpoint.ts, cache/scheduler/launcher sources and capability TypeScript, plus binary/package-lock bytes it only hashes.' },
  'packages/operator-core/lib/agent-tools/coordination/dispatch-intervention-reachable.test.ts': { sha256: 'f51d25a475aa5c9f609ed595180790b0eb58cde392f5953bcf474705b5663e34', status: 'source', reason: 'INVOKE_TS is a fixed orchestrator invoke.ts path; describe callback reads it to parse seed lists.' },
  'packages/operator-core/lib/chat-protocol-nodenext-export-extensions.test.ts': { sha256: 'f60b1c861e7c5e0752aaca5f1112c04ec5e321ab44a9109cd79c76f85d7c528b', status: 'source', reason: 'publishedSourceFiles enumerates chat-protocol/src .ts files and tests read each selected file.' },
  'packages/operator-core/lib/coord/holder-context.test.ts': { sha256: '8a0c2079118b67c04a920990f1255dc9bc4e52bab6d4a5367b66a728eee839d5', status: 'source', reason: 'readRepoFile selects fixed holder-context/lock/tool TypeScript; parity traversal reads selected .ts/.tsx sources.' },
  'packages/operator-core/lib/desktop-acl-command-sync.test.ts': { sha256: '22ec2dd8eb9ad20680f781a3494ec1af387ed096240688a3b962688997c14582', status: 'non-source', reason: 'Direct consumers are fixed main.rs, build.rs and capabilities/default.json; Rust is outside this JS/TS corpus.' },
  'packages/operator-core/lib/doc-claims/staging-sync-target-ref.test.ts': { sha256: '2bcc36e9d842fc7c72809edf7e224b3762977280a05c05326e97f6e0105bd05a', status: 'non-source', reason: 'Fixed sync-staging-checkout.sh and CLAUDE.md text consumers, plus inline shell control strings.' },
  'packages/operator-core/lib/doc-claims/system-closer-identity-registration.test.ts': { sha256: '560618e85f39a71c0a035a41546aa5d2371f83667954b47c8d71731ea567b36f', status: 'source', reason: 'walk traverses registered source roots and readFileSync consumes selected TypeScript terminal-state sites.' },
  'packages/operator-core/lib/execute-action-dispatch-contract.test.ts': { sha256: '0ce39f4d8085efe61432c14484d2e41019e72318a6e6609d7c50a1fc8959c405', status: 'source', reason: 'Reads execute-action.ts and recursively selected source emitters; duplicate __dirname blocks VM execution, not these selectors.' },
  'packages/operator-core/lib/harness/improvements/recursion-safety-invariants.test.ts': { sha256: '41747440bacff704c38e819dae21a4bc3693d30909497a661343b5420648ed7e', status: 'source', reason: 'TypeScript source walk reads and strips files to find recordBehaviorChange call sites.' },
  'packages/operator-core/lib/inference-gateway/egress-pool-resolution.test.ts': { sha256: '44d56a3cccb38072bdf91fd1b4ce1aa1c3f7edbe03db90e42ceba9f233cbde6d', status: 'source', reason: 'readdirSync(DIR) selects gateway .ts files; the guard reads and strips each candidate.' },
  'packages/operator-core/lib/scheduler/claimability-snapshot-projection-covers-floors.test.ts': { sha256: 'cf648cb9b09aaaf7929f9f3c599c274583afcee50fc9abdeff902f72ee24fe22', status: 'non-source', reason: 'No direct file reads: stripComments consumes SQL rendered by the real query builder and inline SQL controls.' },
  'packages/operator-core/lib/search/search-engine-mock-completeness.test.ts': { sha256: ['9d242066f01c4812e592fa0f89685be40cd485b7a4a38f3490456f349079b778', '8868713f863cf9f6c6ff8fe0efe21d38787a9de736a60e5a86b131392a587993'], status: 'source', reason: 'walkTests selects .test.ts files and scanSource consumes their bytes, alongside fixed binding policy source.' },
  'packages/operator-core/lib/sync-interest-single-contract.test.ts': { sha256: 'f587b3cbc136355bd6d310cc37792ee13cc842ab127d4dc5979c6cbad95e9bcf', status: 'source', reason: 'SCAN_ROOTS traverses apps/packages/libs, reads selected source files and a fixed probe route.' },
  'templates/papercusp-ui/checks/theme-tokens.test.ts': { sha256: 'b39ed85da2a53cb8c5fad3a1c909e430640b367e94ac5eba5eb504638f511355', status: 'non-source', reason: 'Default inert environment has no TEMPLATE_CHECKS_CONFIG and skips the suite. Configured paths are unrestricted and explicitly outside this review.' },
  // Positive executed-selector receipts from the last full census. Pin their exact
  // bytes so known baseline readers are not re-executed in the VM on every test run.
  'apps/operator-vite/src/lib/operator-core-client-boundary.test.ts': { sha256: 'ee2ad96fc5695c051cb545dee0028f8e4eea19fe93b59d012f2265e3eaaae3c1', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'apps/operator/app/_lints/design-primitives.test.ts': { sha256: '977074d3f6c22715256fd7f1f5e390d73a26d9ec57bdf948f59a64204c7bde2a', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'apps/operator/app/_lints/popper-stacking.test.ts': { sha256: '2d8e59806ea952917efbcc354366f3b4f37d97e42c418958487a7e876af01285', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'apps/operator/scripts/__tests__/watchdog-journald-independence.test.ts': { sha256: '50501eb8844fff98aee2073201de942232509f9d1e62f597b9717df7dd0f0ee6', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/__tests__/not-checked-non-gating-mirror.test.ts': { sha256: '2efce506875ee71b0c09e4ce400c9e3cad4a7e8212c14db3afb0744a14ef5aba', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/agent-tools/capability/base-dir.test.ts': { sha256: 'e1b2cd8b13a6282958927b2ef1397d425eae1f0f028df2a5c7f5a62d89ca467c', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/agent-tools/coordination/partial-jsonb-index-alignment.test.ts': { sha256: 'c8e1d7758a34a5f391ce2e184ba1f724a7a595653bbe8f5cae3ba1f2a325a09e', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/agent-tools/tool-tree-root.test.ts': { sha256: '7b848a0480b806abd402098d7f5ddb732ad3a19e0ceb965c20c577c7aa2a48e4', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/agent-tools/work_items/swallowed-work-item-read-guard.test.ts': { sha256: '157038cf8552068f221201e0a2d51e0df8af979fc4437d284b7dd4b516ed2250', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/conversation-context-projection-index.test.ts': { sha256: '9860317bacaeb6083f96448f8362cde6953246b3866f6b4972fdf77913bfb6a4', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/deployment/account-pool-write-path.test.ts': { sha256: '118b68a2bda22174250c5a9edaf786f84e374741c653a820caf47fbe15822267', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/doc-claims/identity-recovery-door.test.ts': { sha256: 'd83b35245bbec7abbb3512acd3c20aebd36ff34822ee7ca0198a6904d70e1623', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/goal-launch-resolver-coverage.test.ts': { sha256: 'a91c0b215fd6f6ee82ee06418fdab9f30ded3a75ea46a79c5cf7524ea22ba327', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/payload-object-shape-guard.test.ts': { sha256: '40a4898d106131adc42840dac049f62f84349eab05cc42c0f00dd699baf06e84', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/pg-stat-activity-role-visibility-guard.test.ts': { sha256: '022f1f6f4176665b0c0121d0556cc14529c69a8470de3ce2a84529f85b09d369', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/release/green-stall-watchdog-presence-columns.test.ts': { sha256: '787c5dab23c071892d4b72596ff0b0982d1d427d0e5ec24ecd6b656b13561cb4', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/sync-resolver/no-embedding-in-list-projection.test.ts': { sha256: 'a0c976cec9fbc6ad90d89270b33d98b1a792f6b3f174ba3119704f51b07800a7', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/sync-resolver/workspace-filter-coverage.test.ts': { sha256: '06058af28c780af53ef71767c0c3af2899c2745ff0c61ab031f318ac6ed1591b', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/sync/hyperbee/projections/__tests__/lww-guard-registry-lint.test.ts': { sha256: '8157b5e45793dfedd5dffb46a74de615a8f7dfb55781284342f38e611d04ab62', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/work-item-born-claimable.test.ts': { sha256: 'acf79adb2e6bdefe908f2ac9558ee38ed597e34410df305c5077021d5e6020d5', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/work-item-claim-freshness.kind-gate.test.ts': { sha256: 'f7883be5d412353dc77dac53a20211f70005c2dd83207eb0295ef06373dba9ac', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
  'packages/operator-core/lib/workspace-reg-current-guard.test.ts': { sha256: '8539d2134408051ba9af7c27761e0251307099c03a77f6b4f90e16ed231b936d', status: 'source', reason: 'Executed selector census observed JS/TS source reads; exact test bytes pin that positive source result.' },
};

/** True when `hex` is one of the reviewed blob pins for a REVIEWED_TEST_READER_CORPUS entry. */
function isReviewedBlob(pins: string | readonly string[], hex: string): boolean {
  return (typeof pins === 'string' ? [pins] : pins).includes(hex);
}

beforeAll(() => {
  // Fail at the pre-run boundary, before the expensive inert corpus census.
  // Concurrent edits need a content review, never an automatic hash refresh.
  // Collect EVERY drifted pin before failing: stopping at the first one hid six more
  // drifts and, behind them, an unrelated census red (WI-6554700010030423).
  const sha = (abs: string) => crypto.createHash('sha256').update(readFileSync(abs, 'utf8')).digest('hex');
  const drifted = [
    ...Object.entries(REVIEWED_READER_CORPUS)
      .filter(([file, review]) => sha(join(SCRIPTS_DIR, file)) !== review.sha256)
      .map(([file]) => `scripts/${file}: reviewed source drifted`),
    ...Object.entries(REVIEWED_TEST_READER_CORPUS)
      .filter(([file, review]) => !isReviewedBlob(review.sha256, sha(join(SCRIPTS_DIR, '..', file))))
      .map(([file]) => `${file}: reviewed test source drifted`),
  ];
  expect(drifted, 'review each drifted file\'s change and reclassify it before the census; never refresh a hash unread').toEqual([]);
});

function reviewedReaderCorpus(entry: string, result: ReturnType<typeof observeReaderCorpus>, source: string, argv: string[] = []) {
  const review = REVIEWED_READER_CORPUS[path.basename(entry)];
  if (!review || argv.length || crypto.createHash('sha256').update(source).digest('hex') !== review.sha256) {
    return { ...result, review: undefined };
  }
  return {
    ...result,
    status: result.status === 'source' ? 'source' : 'non-source',
    review: { ...review, scope: 'default CLI direct text consumer' },
  };
}

function reviewedTestReaderCorpus(entry: string, result: ReturnType<typeof observeReaderCorpus>, source: string, scope: { testCallbacks: boolean; defaultEnvironment: boolean }) {
  const review = REVIEWED_TEST_READER_CORPUS[entry];
  if (!scope.testCallbacks || !scope.defaultEnvironment || !review || !isReviewedBlob(review.sha256, crypto.createHash('sha256').update(source).digest('hex'))) {
    return { ...result, review: undefined };
  }
  return {
    ...result,
    // Positive executed reads always win. Preserve the original VM receipts:
    // reviewed status must never fabricate a codeReads entry or suppress denial.
    status: result.status === 'source' ? 'source' : review.status,
    review: { ...review, scope: 'test callbacks, default inert environment, direct text consumers', originalStatus: result.status },
  };
}

function observeReviewedTestReaderCorpus(
  entry: string,
  source: string,
  scope: { testCallbacks: boolean; defaultEnvironment: boolean },
  observe: () => ReturnType<typeof observeReaderCorpus>,
) {
  const review = REVIEWED_TEST_READER_CORPUS[entry];
  const exactSourceReview =
    scope.testCallbacks &&
    scope.defaultEnvironment &&
    review?.status === 'source' &&
    isReviewedBlob(review.sha256, crypto.createHash('sha256').update(source).digest('hex'));
  if (exactSourceReview) {
    // The exact-byte review is already positive source evidence. Re-executing the whole
    // test module in the inert VM adds no coverage and made this census exceed Vitest's
    // 60s timeout as the tracked test population grew (EI-25889569648954031).
    return reviewedTestReaderCorpus(
      entry,
      { status: 'source', codeReads: [], reads: [], unsupported: [], asynchronous: false, directoryEntriesVisited: 0 },
      source,
      scope,
    );
  }
  return reviewedTestReaderCorpus(entry, observe(), source, scope);
}

// Keep assertion evidence bounded even when a recursive reader selects the tree.
function corpusReceipt(result: ReturnType<typeof observeReaderCorpus> | undefined) {
  if (!result) return { status: 'not-observed' };
  return { ...result, codeReadCount: result.codeReads.length, codeReads: result.codeReads.slice(0, 3), readCount: result.reads.length, reads: result.reads.slice(0, 3), unsupported: result.unsupported.slice(0, 4) };
}

describe('reader corpus comes from executed selection, not quoted extensions', () => {
  const entry = 'scripts/corpus-fixture.mjs';
  const inventory = ['packages/example/src/main.ts', 'packages/example/src/view.tsx', 'apps/operator/scripts/systemd/example.service', 'docs/example.md', 'package.json'];
  const run = (source: string, extra: Record<string, string> = {}) => observeReaderCorpus(entry, inventory, { [entry]: source, ...extra });
  const enumerate = `import { readFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\\n');`;

  it('directory traversal visits only immediate children, independent of unrelated inventory', () => {
    const styles = Array.from({ length: 30 }, (_, i) => `styles/group-${i}/nested/leaf.css`);
    const unrelated = Array.from({ length: 100 }, (_, i) => `unrelated/group-${i}/main.ts`);
    const source = `import { readFileSync, readdirSync, statSync } from 'node:fs'; import { join } from 'node:path';
      function walk(dir) { for (const name of readdirSync(dir)) { const file = join(dir, name); if (statSync(file).isDirectory()) walk(file); else if (file.endsWith('.css')) readFileSync(file, 'utf8'); } }
      walk('styles');`;
    const result = observeReaderCorpus(entry, [...styles, ...unrelated], { [entry]: source });
    expect(result.status, JSON.stringify(result)).toBe('non-source');
    expect(result.reads).toEqual([...styles].sort());
    expect(result.directoryEntriesVisited).toBe(90);
  });

  it('sees regex-selected TS without any quoted code extension', () => {
    const source = enumerate + String.raw`for (const f of files) { if (!/\.(ts|tsx)$/.test(f)) continue; readFileSync(f, 'utf8'); }`;
    expect(SCANS_CODE_FILES.test(source), 'the old extension-mention rule must miss this control').toBe(false);
    const result = run(source);
    expect(result.codeReads, JSON.stringify(result)).toEqual(inventory.slice(0, 2));
  });

  it('follows selection through a predicate function and a filtered list', () => {
    const source = enumerate + String.raw`const accepted = f => /\.tsx?$/.test(f); const selected = files.filter(accepted); function scan(f) { readFileSync(f, 'utf8'); } for (const f of selected) scan(f);`;
    expect(SCANS_CODE_FILES.test(source)).toBe(false);
    expect(run(source).status, JSON.stringify(run(source))).toBe('source');
    expect(run(source).codeReads).toEqual(inventory.slice(0, 2));
  });

  it('does not treat a helper import as a source scan', () => {
    const source = `import { accept } from './selector.mjs';` + enumerate + `for (const f of files) if (accept(f)) readFileSync(f, 'utf8');`;
    expect(SCANS_CODE_FILES.test(source)).toBe(true);
    const result = run(source, { 'scripts/selector.mjs': `export const accept = f => f.endsWith('.service');` });
    expect(result.status).toBe('non-source');
    expect(result.reads).toEqual(['apps/operator/scripts/systemd/example.service']);
  });

  it('keeps a genuine scanner whose only quoted extension is its helper import', () => {
    const source = `import { accept } from './selector.mjs';` + enumerate + `for (const f of files) if (accept(f)) readFileSync(f, 'utf8');`;
    expect(run(source, { 'scripts/selector.mjs': String.raw`export const accept = f => /\.tsx?$/.test(f);` }).status).toBe('source');
  });

  it('does not confuse an entrypoint self-reference with its JSON corpus', () => {
    const source = `import { readFileSync } from 'node:fs'; if (process.argv[1].endsWith('corpus-fixture.mjs')) JSON.parse(readFileSync('package.json', 'utf8'));`;
    expect(SCANS_CODE_FILES.test(source)).toBe(true);
    expect(run(source).status).toBe('non-source');
  });

  it('does not count an extension regex held as fixture data', () => {
    const source = `import { readFileSync } from 'node:fs'; const fixture = '/\\.tsx?$/'; JSON.parse(readFileSync('package.json', 'utf8'));`;
    expect(run(source).status).toBe('non-source');
  });

  it('reports unsupported execution as unknown, with no clean inference', () => {
    const result = run(`import { readFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; spawnSync('node', ['other-guard.mjs']); readFileSync('packages/example/src/main.ts', 'utf8');`);
    expect(result.status).toBe('unknown');
    expect(result.unsupported.join(' ')).toContain('child_process.spawnSync');
  });

  it('runs a real CLI shebang through the same module wrapper', () => {
    const result = run('#!/usr/bin/env node\n' + enumerate + String.raw`for (const f of files) if (/\.tsx?$/.test(f)) readFileSync(f, 'utf8');`);
    expect(result.status, JSON.stringify(result)).toBe('source');
  });

  it('does not infer a non-source corpus from an early failed preflight', () => {
    const result = run(`import { readFileSync } from 'node:fs'; readFileSync('package.json', 'utf8'); process.exit(1); readFileSync('packages/example/src/main.ts', 'utf8');`);
    expect(result.status).toBe('unknown');
    expect(result.unsupported).toContain('early nonzero exit: 1');
  });

  it('does not leave an async CLI rejection chain alive after a synchronous census', () => {
    const result = run(`async function main() { throw new Error('fixture rejection'); } main().catch(() => process.exit(1));`);
    expect(result.status).toBe('unknown');
    expect(result.asynchronous).toBe(true);
  });

  it('retains a measured code read when a later operation is unsupported', () => {
    const result = run(`import { readFileSync, writeFileSync } from 'node:fs'; readFileSync('packages/example/src/main.ts', 'utf8'); writeFileSync('package.json', '{}');`);
    expect(result.status).toBe('source');
    expect(result.unsupported.join(' ')).toContain('fs.writeFileSync');
  });

  describe('Vitest callback corpus', () => {
    const runTest = (body: string, extra: Record<string, string> = {}) => {
      const testEntry = 'scripts/corpus-fixture.test.ts';
      return observeReaderCorpus(testEntry, inventory, { [testEntry]: body, ...extra }, { testCallbacks: true });
    };
    const imports = "import { describe, it } from 'vitest'; import { readFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process';";

    it('observes regex selection inside a registered test callback', () => {
      const body = imports + String.raw`describe('guard', () => { it('scan', () => { const files = execFileSync('git', ['ls-files'], {encoding: 'utf8'}).split('\n'); for (const f of files) if (/\.tsx?$/.test(f)) readFileSync(f, 'utf8'); }); });`;
      expect(SCANS_CODE_FILES.test(body)).toBe(false);
      expect(runTest(body).codeReads).toEqual(inventory.slice(0, 2));
    });

    it('follows a delegated selector without using its import extension as evidence', () => {
      const body = imports + "import { select } from './selector.mjs'; it('scan', () => { for (const f of select(execFileSync('git', ['ls-files'], {encoding:'utf8'}).split('\\n'))) readFileSync(f, 'utf8'); });";
      expect(runTest(body, { 'scripts/selector.mjs': String.raw`export const select = files => files.filter(f => /\.tsx?$/.test(f));` }).status).toBe('source');
      expect(runTest(body, { 'scripts/selector.mjs': "export const select = files => files.filter(f => f.endsWith('.service'));" }).status).toBe('non-source');
    });

    it('does not count fixture extensions or import-only helpers as code reads', () => {
      const result = runTest(imports + "import './selector.mjs'; it('metadata', () => { const fixture = 'a.ts'; readFileSync('package.json', 'utf8'); });", { 'scripts/selector.mjs': "export const fixture = 'b.ts';" });
      expect(result.status).toBe('non-source');
      expect(result.codeReads).toEqual([]);
    });

    it('retains skipped and asynchronous callbacks as unknown', () => {
      expect(runTest(imports + "it.skip('scan', () => readFileSync('a.ts', 'utf8'));").status).toBe('unknown');
      expect(runTest(imports + "it('scan', async () => readFileSync('a.ts', 'utf8'));").status).toBe('unknown');
    });

    it('does not run ordinary callbacks after an unsupported exclusive selection', () => {
      const result = runTest(imports + "it('not-selected', () => readFileSync('a.ts', 'utf8')); it.only('selected', () => readFileSync('package.json', 'utf8'));");
      expect(result.status).toBe('unknown');
      expect(result.codeReads).toEqual([]);
      expect(result.unsupported).toContain('vitest exclusive selection');
    });

    it('continues other callbacks after denial and never runs real effects', () => {
      const result = runTest(imports + "import { writeFileSync } from 'node:fs'; it('denied', () => writeFileSync('/fixture-denied', 'x')); it('source', () => readFileSync('packages/example/src/main.ts', 'utf8'));");
      expect(result.status).toBe('source');
      expect(result.unsupported.join(' ')).toContain('fs.writeFileSync');
    });
  });

  it('invalidates source-reviewed classifications on drift or explicit CLI arguments', () => {
    const entry = 'scripts/check-rust-advisories.mjs';
    const source = readFileSync(join(SCRIPTS_DIR, 'check-rust-advisories.mjs'), 'utf8');
    const unknown = { status: 'unknown', codeReads: [], reads: [], unsupported: ['async'], asynchronous: true, directoryEntriesVisited: 0 };
    expect(reviewedReaderCorpus(entry, unknown, source).status).toBe('non-source');
    expect(reviewedReaderCorpus(entry, unknown, source + '\nreadFileSync("new.ts");').status).toBe('unknown');
    expect(reviewedReaderCorpus(entry, unknown, source, ['--lock', 'new.ts']).status).toBe('unknown');
    expect(reviewedReaderCorpus(entry, { ...unknown, status: 'source', codeReads: ['new.ts'] }, source).status).toBe('source');
  });

  it('test reviews invalidate on drift and never turn a denied VM into observed reads', () => {
    const entry = 'apps/operator/app/_components/monaco-cdn.test.ts';
    const source = readFileSync(join(SCRIPTS_DIR, '..', entry), 'utf8');
    const unknown = { status: 'unknown', codeReads: [], reads: [], unsupported: ['fs/promises'], asynchronous: false, directoryEntriesVisited: 0 };
    const scope = { testCallbacks: true, defaultEnvironment: true };
    const reviewed = reviewedTestReaderCorpus(entry, unknown, source, scope);
    expect(reviewed.status).toBe('source');
    expect(reviewed.codeReads).toEqual([]);
    expect(reviewed.unsupported).toEqual(['fs/promises']);
    expect(reviewed.review?.originalStatus).toBe('unknown');
    expect(reviewedTestReaderCorpus(entry, unknown, source + '\n', scope).status).toBe('unknown');
    expect(reviewedTestReaderCorpus(entry, unknown, source, { ...scope, testCallbacks: false }).status).toBe('unknown');
  });

  it('non-source reviews cannot hide positive reads or classify a configured template invocation', () => {
    const entry = 'templates/papercusp-ui/checks/theme-tokens.test.ts';
    const source = readFileSync(join(SCRIPTS_DIR, '..', entry), 'utf8');
    const unknown = { status: 'unknown', codeReads: [], reads: [], unsupported: ['skipIf'], asynchronous: false, directoryEntriesVisited: 0 };
    const scope = { testCallbacks: true, defaultEnvironment: true };
    expect(reviewedTestReaderCorpus(entry, unknown, source, scope).status).toBe('non-source');
    expect(reviewedTestReaderCorpus(entry, unknown, source, { ...scope, defaultEnvironment: false }).status).toBe('unknown');
    expect(reviewedTestReaderCorpus(entry, { ...unknown, status: 'source', codeReads: ['configured.ts'] }, source, scope).status).toBe('source');
  });

  it('uses exact-byte positive test reviews without re-executing the reviewed module', () => {
    const entry = 'apps/operator-vite/src/__tests__/dark-flag-route-contract.test.ts';
    const source = readFileSync(join(SCRIPTS_DIR, '..', entry), 'utf8');
    const scope = { testCallbacks: true, defaultEnvironment: true };
    let observations = 0;
    const reviewed = observeReviewedTestReaderCorpus(entry, source, scope, () => {
      observations += 1;
      throw new Error('exact-byte source review should not re-run the census VM');
    });
    expect(observations).toBe(0);
    expect(reviewed.status).toBe('source');
    expect(reviewed.review?.originalStatus).toBe('source');

    const changed = observeReviewedTestReaderCorpus(entry, source + '\n', scope, () => {
      observations += 1;
      return { status: 'unknown', codeReads: [], reads: [], unsupported: [], asynchronous: false, directoryEntriesVisited: 0 };
    });
    expect(observations).toBe(1);
    expect(changed.status).toBe('unknown');
  });
});

/**
 * A call to one of the shared module's OWN exports. WI-37801 follow-up: a definition whose
 * body DELEGATES to the shared stripper is a thin alias, not a hand-roll — and counting it
 * as one punishes exactly the migration this guard exists to drive.
 *
 * Found the expensive way, an hour after the definition rule landed: `lint-migrations.mjs`
 * retired its private `stripSqlBodies` in favour of
 *   const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);
 * and the name-shaped rule scored that FULLY-MIGRATED file as hand-rolled, because
 * `maskSealingBodies` is `mask` + `Sealing` + `Bodies` in `const X =` form. The author had
 * done the right thing and the guard called it debt.
 */
const SHARED_EXPORT_CALL =
  /\b(?:stripCommentsAndStrings|stripCommentsOnly|stripSqlComments|stripSqlCommentsAndStrings|stripShellTrailingComment)\s*\(/;

/**
 * Does this source DEFINE its own stripper, as opposed to importing or aliasing the shared one?
 *
 * Checks EVERY definition site, not just the first: a file may hold a delegating alias AND a
 * real hand-roll, and stopping at the first match would let whichever came first decide — the
 * same first-match-wins mistake at one level down.
 *
 * Delegation is judged on the definition's OWN line, which is deliberately conservative: it
 * clears the one-line arrow alias above and nothing else. A multi-line wrapper that merely
 * forwards still reads as hand-rolled — a false positive that costs one BASELINE line, versus
 * a body-scanning rule that would exempt a real hand-roll for mentioning the shared module
 * somewhere inside it. That is the direction this guard must err in.
 */
function definesPrivateStripper(maskedSource: string): boolean {
  for (const m of maskedSource.matchAll(new RegExp(NAMED_STRIPPER_DEF.source, 'gm'))) {
    const nl = maskedSource.indexOf('\n', m.index);
    const line = maskedSource.slice(m.index, nl === -1 ? undefined : nl);
    if (SHARED_EXPORT_CALL.test(line)) continue;
    return true;
  }
  return false;
}

type Masking = 'shared' | 'hand-rolled' | 'ast' | 'unmasked';

function classifyMasking(maskedSource: string): Masking {
  // HAND-ROLLED IS TESTED FIRST, AHEAD OF THE SHARED IMPORT (WI-37801). The old order asked
  // "does this file import the shared module?" and returned on the first yes, which made the
  // classification per-FILE. Consolidation proceeds per CALL SITE, so the first migrated site
  // in a file silenced the guard for every stripper still living beside it — partial migration
  // was not merely unenforced, it was rewarded with a permanent exemption. Worse, that reached
  // the BASELINE below: an entry could be removed for a file that still hand-rolls, so the
  // shrink-only list shrank while the debt stayed. Both files it hid (lint-migrations.mjs,
  // check-migration-forward-compat.mjs) had in fact already been de-listed that way.
  //
  // Ordering is safe now only because the predicate anchors on DEFINITIONS: a migrated file
  // whose sole stripper reference is its own import has no definition site and still falls
  // through to `shared`. See NAMED_STRIPPER_DEF.
  if (
    definesPrivateStripper(maskedSource) ||
    maskedSource.includes(NAIVE_BLOCK_RE) ||
    maskedSource.includes(NAIVE_LINE_RE)
  ) {
    return 'hand-rolled';
  }
  if (SHARED_STRIPPER.test(maskedSource)) return 'shared';
  if (PARSES_AST.test(maskedSource)) return 'ast';
  return 'unmasked';
}

function maskedSourceOf(file: string): string {
  return stripCommentsOnly(readFileSync(join(SCRIPTS_DIR, file), 'utf8'), file);
}

const ALL_SCRIPTS = () => readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')).sort();
const GUARD_SCRIPTS = () => readdirSync(SCRIPTS_DIR).filter((f) => /^(check|lint)-.*\.mjs$/.test(f)).sort();

describe('the copy-pasted stripComments population is SHRINK-ONLY', () => {
  /**
   * Scripts that still hand-roll a comment stripper instead of importing the shared one.
   *
   * This list may SHRINK, never GROW. Removing an entry = migrating that guard (verify first
   * whether its token is legitimately string-resident — see the header note). Adding one means
   * a new copy-paste of the exact defect that froze the fleet gate; import the shared module
   * from `scripts/lib/strip-comments-and-strings.mjs` instead.
   *
   * Entries that are NOT JS/TS and so cannot use the shared module:
   *   check-unenrolled-mjs-imports.mjs  — strips `//` out of JSONC before JSON.parse
   *
   * ⚠ "shell `#` comments cannot use the shared module" WAS listed here for
   * check-assert-integrity.mjs and is now FALSE, for the same reason the SQL claim below died:
   * the module grew a shell arm (`stripShellTrailingComment`) on 2026-09-02 and that entry was
   * migrated onto it and REMOVED from this list. The trigger was a SECOND copy appearing —
   * check-pipefail-sigpipe.mjs landed 2026-09-02T19:15Z carrying the same loop with a NARROWER
   * `/\s/` predecessor class that missed a `#` after `;`, `&`, `|` or `(`. That is the whole
   * thesis of this guard observed live: the copy-paste drifted within a day, in the
   * false-negative direction, and only the shrink-only rule caught it. Both callers now
   * delegate, and the shared implementation keeps the wider class. "Shell cannot use the
   * shared module" must never be reintroduced as a reason for adding an entry.
   *
   * ⚠ "SQL cannot use the shared module" WAS listed here as a reason and is now FALSE: the
   * module grew a SQL path (stripSqlComments / stripSqlCommentsAndStrings, dispatched by
   * isSqlFile) on 2026-08-10, so `--`, nestable block comments, $tag$ bodies and quoted
   * identifiers are all covered. ALL THREE SQL entries — check-partial-index-alignment.mjs,
   * check-migration-forward-compat.mjs and lint-migrations.mjs — were migrated onto it and
   * REMOVED from this list that day (EI-20073035509369492). "SQL cannot use the shared module"
   * must never be reintroduced as a reason for adding an entry.
   *
   * ⚠ TWO of those three came BACK the same day (WI-37801), and the distinction matters when
   * you read them: only check-partial-index-alignment.mjs was fully migrated. The other two
   * migrated ONE call site while keeping a private stripper, and the classifier's
   * first-match-wins ordering made that invisible — so they were de-listed on a verdict the
   * measurement could not actually support. They are listed again on the DEFINITION-anchored
   * measurement. So a SQL-shaped entry here is not a relapse to the retired reason above; it
   * means that file still DEFINES its own stripper. Check which before acting on it.
   *
   * `check-timer-classification.mjs` is on this list holding a CORRECT private copy (it is the
   * donor the shared module was lifted from). It should collapse into the import, but was left
   * alone deliberately: it was the live subject of an in-flight gate incident when this landed.
   */
  const BASELINE = new Set([
    // check-assert-integrity.mjs was REMOVED here on 2026-09-02: its private stripShellComments
    // is now a one-line alias delegating to stripShellTrailingComment. See the shell note above.
    'check-declared-consumed.mjs',
    'check-drop-database-force.mjs',
    'check-lint-guard-reachability.mjs',
    // ⚠ RE-ADDED 2026-08-10 (WI-37801), having been REMOVED here earlier the SAME DAY
    // (EI-20073035509369492). The removal was made in good faith — that guard's own call site
    // genuinely migrated onto stripSqlComments — but the file still DEFINES a private
    // `stripComments(sql)` (:142), and the classifier could not see it: `shared` was returned on
    // the FIRST match, so importing the shared module anywhere exempted the whole file. Nothing
    // failed when the entry was dropped, and that silence IS the harm this list exists to
    // prevent: the shrink-only population shrank while the debt stayed exactly where it was.
    // It measured straight back in once classification anchored on DEFINITIONS rather than
    // mentions. Removing it again requires removing the private stripper, not another import.
    // The original migration note, still true of the migrated call site: its private pair
    // (`/* */` then `--[^\n]*`) was not quote-aware, so a `--` inside a STRING LITERAL erased the
    // rest of the line — swallowing any real DDL that followed it and reporting the migration
    // CLEAN. That is a false NEGATIVE on the one guard whose whole job is catching destructive
    // DDL before it ships. Comments only, NOT the strings variant: the RULES match DDL keywords,
    // and sealing $tag$ bodies would hide real DDL inside a DO block. Both directions are pinned
    // by falsifying controls in that guard's own selfTest().
    'check-migration-forward-compat.mjs',
    'check-no-proc-path-fixture.mjs',
    'check-no-raw-block-edge.mjs',
    'check-no-raw-install-slug-filter.mjs',
    'check-no-retired-style.mjs',
    // check-partial-index-alignment.mjs was REMOVED here on 2026-08-10 (EI-20073035509369492):
    // it now imports stripSqlComments. Its private copy handled `--` only, so a `--` inside a
    // quoted identifier was blanked as a comment — and blanking LIVE CODE can erase the very
    // presence guard the lint looks for, reporting an aligned query as a violation.
    // Comments only, strings intact: the key it matches on (`->> 'reviewBy'`) IS a string
    // literal, so the strings variant would take the detector silently 100% inert.
    'check-timer-classification.mjs',
    'check-unbounded-inbox-read.mjs',
    'check-unenrolled-mjs-imports.mjs',
    'check-workspace-deps-complete.mjs',
    // lint-migrations.mjs was REMOVED here on 2026-08-10 (EI-20073035509369492):
    // findLiteralTenantDefault now uses stripSqlComments. Its private pair DELETED comments
    // rather than blanking them, and was not quote-aware — so a `--` inside a string literal
    // erased the rest of the line, hiding any literal tenant default that followed it.
    // Comments only, NOT the strings variant: its main quarry is the ALTERs inside a
    // `DO $$ … $$` loop, which the strings variant would seal away entirely.
    // lint-migrations.mjs: RE-ADDED and then REMOVED AGAIN, both on 2026-08-10, and the round
    // trip is worth keeping because each step was correct on the evidence available at the time.
    // WI-37801 re-added it once classification anchored on DEFINITIONS, because the file then
    // genuinely still hand-rolled `stripSqlBodies`; that entry's note said it comes off "when
    // WI-37800 retires that stripper, not before". WI-37800 then retired it the same day,
    // replacing it with a one-line alias that DELEGATES to the shared module:
    //     const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);
    // which is the fully-migrated state this list exists to reward. So it is off the list.
    // ⚠ That alias also exposed a false positive in the definition rule itself — `maskSealingBodies`
    // is `mask`+`Sealing`+`Bodies` in `const X =` form, so a name-shaped rule scored a migrated
    // file as debt. Fixed by SHARED_EXPORT_CALL / definesPrivateStripper above; do not re-add
    // this entry on the strength of a stripper-shaped NAME alone — check whether the definition
    // delegates.
  ]);

  const measurePopulation = (): string[] =>
    ALL_SCRIPTS().filter((f) => classifyMasking(maskedSourceOf(f)) === 'hand-rolled');

  it('no NEW script hand-rolls its own comment stripper', () => {
    const added = measurePopulation().filter((f) => !BASELINE.has(f));
    expect(
      added,
      `These scripts hand-roll a comment stripper instead of importing scripts/lib/strip-comments-and-strings.mjs. ` +
        `That copy-paste IS the root cause of the phantom-offender class (EI-19991116787260658).`,
    ).toEqual([]);
  });

  it('the baseline does not carry entries that are already migrated (it must stay honest)', () => {
    // A stale baseline entry silently buys back budget for a future copy-paste.
    const stale = [...BASELINE].filter((f) => !measurePopulation().includes(f));
    expect(stale, 'Already-migrated scripts still listed in BASELINE — remove them.').toEqual([]);
  });

  it('the guards migrated to the shared stripper have NOT regressed to a private copy', () => {
    const migrated = [
      'check-no-eager-execfile-promisify.mjs',
      'check-no-module-scope-flag-subscribe.mjs',
      'check-no-raw-agent-spawn.mjs',
      'check-no-raw-setinterval.mjs',
      // EI-20045405992394901 — both were invisible to the name+form-specific predecessor rule.
      'lint-affected-gate.mjs',
      'check-derived-signal-firings.mjs',
    ];
    const regressed = migrated.filter((f) => measurePopulation().includes(f));
    expect(regressed, 'These were migrated to the shared stripper and must not re-declare one.').toEqual([]);
  });
});

/**
 * WI-10002074 — THE POPULATION WAS ITSELF THE BLIND SPOT.
 *
 * Everything above ratchets `scripts/*.mjs` and nothing else, because `ALL_SCRIPTS()` is a
 * `readdirSync(SCRIPTS_DIR)`. But nothing about the phantom-offender class is specific to a
 * `.mjs` under `scripts/` — `classifyMasking` never looks at a path, only at source text. A
 * tree-scanning guard written as a VITEST FILE carries the identical defect and was
 * structurally outside the detector that owns its class.
 *
 * That is not hypothetical, and the sizes are the argument (measured 2026-09-20):
 *   scripts/*.mjs      255 files ->  13 hand-rolled   <- the watched population
 *   tracked *.test.ts 7896 files ->  30 hand-rolled   <- the blind spot, ~2.3x larger
 * The trigger (EI-23769743489199449) was exactly one of these: a source-scanning guard in
 * `pg-read-query.test.ts` whose control fixture self-matched. It was fixed by hand because
 * no ratchet could see it.
 *
 * WI12280: the quoted-extension proxy missed regex/delegated selectors and counted
 * imports/fixture strings as corpus evidence. Inert module and test-callback execution
 * now measures that selection. Unsupported execution stays unknown, never clean.
 * Definition detection still masks strings, so quoted control strippers do not self-match.
 *
 * The naive-regex `includes()` arms of `classifyMasking` are deliberately NOT reused here.
 * They are sound only for a `.mjs` guard, where containing `\/\*[\s\S]*?\*\/` as text MEANS
 * hand-rolling it; across test files they were measured to mint 24 false positives on files
 * holding that regex as fixture data. Definition-anchored only, per WI-37801's reasoning.
 */
describe('tree-scanning guards written as .test.ts are IN the ratchet (WI-10002074)', () => {
  const REPO_ROOT = join(SCRIPTS_DIR, '..');

  /** Cheap superset gate: masking only ever REMOVES text, so a file with no stripper-ish token
   *  in its raw source cannot define one after masking. Skips ~99% of 7.9k files (4.8s -> ~1s). */
  const MIGHT_DEFINE_STRIPPER = /strip|mask|blank|scrub|elide|redact/;

  const trackedTests = (): string[] =>
    execFileSync('git', ['ls-files', '*.test.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean)
      // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
      .filter((f) => existsSync(join(REPO_ROOT, f)));

  const inventory = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const census = new Map<string, ReturnType<typeof observeReaderCorpus>>();
  const isTreeScanningGuard = (raw: string): boolean =>
    observeReaderCorpus('scripts/census-control.test.ts', inventory, { 'scripts/census-control.test.ts': raw }, { testCallbacks: true }).status === 'source';

  const measureTestPopulation = (): string[] => {
    const found: string[] = [];
    for (const rel of trackedTests()) {
      let raw: string;
      try {
        raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // tracked but absent (mid-sweep deletion) is not this guard's business
      }
      if (!MIGHT_DEFINE_STRIPPER.test(raw)) continue;
      if (!definesPrivateStripper(stripCommentsAndStrings(raw, rel))) continue;
      if (!census.has(rel)) census.set(rel, observeReviewedTestReaderCorpus(rel, raw, { testCallbacks: true, defaultEnvironment: true }, () => observeReaderCorpus(rel, inventory, undefined, { testCallbacks: true })));
      if (census.get(rel)!.status !== 'non-source') found.push(rel);
    }
    return found.sort();
  };

  /**
   * Source-reader debt reconciled by executable receipts in WI12280. Unsupported
   * modules are recorded separately below and cannot silently graduate to this baseline.
   */
  const TEST_BASELINE = new Set([
    'apps/operator-vite/src/__tests__/dark-flag-route-contract.test.ts',
    'apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts',
    'apps/operator-vite/src/lib/operator-core-client-boundary.test.ts',
    'apps/operator/app/_components/monaco-cdn.test.ts',
    'apps/operator/app/_components/porcupine-cdn.test.ts',
    'apps/operator/app/_components/vditor-cdn.test.ts',
    'apps/operator/app/_lints/design-primitives.test.ts',
    'apps/operator/app/_lints/popper-stacking.test.ts',
    'apps/operator/lib/chat-actions/ctx-wiring.test.ts',
    'apps/operator/scripts/__tests__/watchdog-journald-independence.test.ts',
    'packages/operator-core/lib/__tests__/affected-tests-passing-verdict-cache.test.ts',
    'packages/operator-core/lib/__tests__/not-checked-non-gating-mirror.test.ts',
    'packages/operator-core/lib/agent-tools/capability/base-dir.test.ts',
    'packages/operator-core/lib/agent-tools/coordination/dispatch-intervention-reachable.test.ts',
    'packages/operator-core/lib/agent-tools/coordination/partial-jsonb-index-alignment.test.ts',
    'packages/operator-core/lib/agent-tools/tool-tree-root.test.ts',
    'packages/operator-core/lib/agent-tools/work_items/swallowed-work-item-read-guard.test.ts',
    'packages/operator-core/lib/conversation-context-projection-index.test.ts',
    'packages/operator-core/lib/chat-protocol-nodenext-export-extensions.test.ts',
    'packages/operator-core/lib/coord/holder-context.test.ts',
    'packages/operator-core/lib/deployment/account-pool-write-path.test.ts',
    'packages/operator-core/lib/doc-claims/identity-recovery-door.test.ts',
    'packages/operator-core/lib/doc-claims/system-closer-identity-registration.test.ts',
    'packages/operator-core/lib/execute-action-dispatch-contract.test.ts',
    'packages/operator-core/lib/goal-launch-resolver-coverage.test.ts',
    'packages/operator-core/lib/harness/improvements/recursion-safety-invariants.test.ts',
    'packages/operator-core/lib/inference-gateway/egress-pool-resolution.test.ts',
    'packages/operator-core/lib/payload-object-shape-guard.test.ts',
    'packages/operator-core/lib/pg-stat-activity-role-visibility-guard.test.ts',
    'packages/operator-core/lib/release/green-stall-watchdog-presence-columns.test.ts',
    'packages/operator-core/lib/search/search-engine-mock-completeness.test.ts',
    'packages/operator-core/lib/sync-interest-single-contract.test.ts',
    'packages/operator-core/lib/sync-resolver/no-embedding-in-list-projection.test.ts',
    'packages/operator-core/lib/sync-resolver/workspace-filter-coverage.test.ts',
    'packages/operator-core/lib/sync/hyperbee/projections/__tests__/lww-guard-registry-lint.test.ts',
    'packages/operator-core/lib/work-item-born-claimable.test.ts',
    'packages/operator-core/lib/work-item-claim-freshness.kind-gate.test.ts',
    'packages/operator-core/lib/workspace-reg-current-guard.test.ts',
  ]);

  // Every current baseline entry has exact-byte positive source evidence. New
  // candidates still run through the inert VM; a review drift fails before the census.
  const TEST_UNRESOLVED_CORPUS = new Set<string>();

  it('no NEW .test.ts tree-scanning guard hand-rolls its own comment stripper', () => {
    const added = measureTestPopulation().filter((f) => !TEST_BASELINE.has(f) && !TEST_UNRESOLVED_CORPUS.has(f));
    expect(
      added,
      'These tree-scanning guards hand-roll a comment stripper instead of importing ' +
        'scripts/lib/strip-comments-and-strings.mjs. Being a .test.ts rather than a scripts/*.mjs ' +
        'does not change the defect (EI-23769743489199449) — it only used to hide it. ' +
        JSON.stringify(added.map(file => ({ file, ...corpusReceipt(census.get(file)) }))),
    ).toEqual([]);
  });

  it('the baseline does not carry entries that are already migrated (it must stay honest)', () => {
    const population = measureTestPopulation();
    const stale = [...TEST_BASELINE].filter((f) => !population.includes(f) || census.get(f)?.status !== 'source');
    expect(stale, 'Baseline entries without positive source evidence — classify unknowns separately or remove migrated entries. ' + JSON.stringify(stale.map(file => ({ file, ...corpusReceipt(census.get(file)) })))).toEqual([]);
  });

  it('an unresolved test cannot become a source reader without exposure review', () => {
    measureTestPopulation();
    const changed = [...TEST_UNRESOLVED_CORPUS].filter(f => census.get(f)?.status !== 'unknown');
    expect(changed, 'Reclassify from these receipts, never a blind list update: ' + JSON.stringify(changed.map(file => ({ file, ...corpusReceipt(census.get(file)) })))).toEqual([]);
  });

  // ---- falsifiability: controls that must keep answering both ways (never tree mutation) ----

  it('CATCHES a hand-rolled stripper in a .test.ts-shaped guard (positive control)', () => {
    const offender = [
      "const files = ['a.ts', 'b.ts'];",
      'const src = readFileSync(files[0], "utf8");',
      'function stripComments(s) { return s.replace(/x/g, ""); }',
      'if (src.includes("token")) throw new Error("boom");',
    ].join('\n');
    expect(isTreeScanningGuard("import { readFileSync } from 'node:fs';\n" + offender)).toBe(true);
    expect(definesPrivateStripper(stripCommentsAndStrings(offender, 'control.test.ts'))).toBe(true);
  });

  it('PASSES a guard that imports the shared stripper instead (negative control)', () => {
    const migrated = [
      "import { stripCommentsAndStrings } from '../scripts/lib/strip-comments-and-strings.mjs';",
      "const files = ['a.ts'];",
      'const src = stripCommentsAndStrings(readFileSync(files[0], "utf8"), files[0]);',
      'if (src.includes("token")) throw new Error("boom");',
    ].join('\n');
    expect(definesPrivateStripper(stripCommentsAndStrings(migrated, 'ok.test.ts'))).toBe(false);
  });

  /**
   * THE SELF-MATCH THAT THE STRINGS VIEW EXISTS TO CURE. This file quotes hand-rolled
   * strippers as fixtures; under a comments-only view it reports ITSELF as an offender.
   * Both directions are asserted so a future "simplification" back to one mask fails here
   * rather than silently re-minting a phantom offender against the guard-of-guards.
   */
  it('does NOT flag a stripper that appears only inside a STRING (the phantom this class is about)', () => {
    const quotedOnly = [
      "const files = ['a.ts'];",
      'const src = readFileSync(files[0], "utf8");',
      'const BAD_FIXTURE = "const stripComments = (s) => s.replace(/x/g, \'\')";',
      'if (src.includes(BAD_FIXTURE)) throw new Error("boom");',
    ].join('\n');
    // comments-only view still sees the quoted fixture: this is the false positive.
    expect(definesPrivateStripper(stripCommentsOnly(quotedOnly, 'phantom.test.ts'))).toBe(true);
    // +strings view does not: this is the cure, and why the split is load-bearing.
    expect(definesPrivateStripper(stripCommentsAndStrings(quotedOnly, 'phantom.test.ts'))).toBe(false);
  });

  it('this very file is NOT in its own population (the guard-of-guards must not self-match)', () => {
    expect(measureTestPopulation()).not.toContain(
      'packages/operator-core/lib/guard-string-literal-blindness.test.ts',
    );
  });
});

/**
 * EI-20045405992394901 — the population this suite could not see.
 *
 * Every rule above asks HOW a guard strips. A guard that strips NOTHING declares no stripper,
 * matches no rule, and is perfectly invisible — while being MORE exposed than the hand-rollers,
 * not less. `scripts/mug-kettle-surface-census.mjs` scanned raw source at all 9 detector sites,
 * reported a JSX comment as a new ungated entry point, and red-pinned the fleet gate on a
 * comment — fully compliant with this file the whole time.
 *
 * So this registry anchors on the PROPERTY (does it scan source it never masked?), not the
 * SPELLING. The control block below fails against the old name-specific rule on purpose: a
 * widening with no control is silently narrowed back the first time someone tidies it.
 */
describe('guards that scan UNMASKED source are visible, and the population is SHRINK-ONLY', () => {
  /**
   * check-/lint- guards that read JS/TS source and text-match against it without masking
   * comments or strings first. May SHRINK, never GROW with new debt. Correcting a
   * measurement may reveal an old member; document that independently of new debt.
   *
   * Being on this list is not automatically a bug — a guard whose token cannot appear in prose
   * is safe, and some (check-no-nul-in-source, check-no-control-bytes, check-smart-quotes) are
   * BYTE-level checks where masking would defeat the purpose. It is a declaration that the
   * exposure was considered. To remove an entry: import the shared module, or move to an AST
   * parse. To add one: don't — mask the source instead.
   */
  const SCANS_UNMASKED_SOURCE = new Set([
    // This guard intentionally scans comments (its subject is pending-action attribution),
    // so masking its own source would hide the prose it must inspect.
    'check-no-agent-intent-comments.mjs',
    // check-bundled-cli-entry-guards.mjs delegates the source-token scan to findGuards(),
    // whose shared implementation masks comments and strings before matching. The cheap
    // census cannot follow that imported helper, so keep this justified exposure here rather
    // than forcing a redundant second mask into the wrapper.
    'check-bundled-cli-entry-guards.mjs',
    'check-constant-conditional.mjs',
    // Measurement correction EI-20077125623815751: this existing byte/line guard
    // reads JS/TS even when the old quoted-extension rule missed it. Conflict markers
    // inside literals remain real conflicts, so masking would hide broken merges.
    'check-conflict-markers.mjs',
    // check-declared-deps-extracted.mjs reads package.json/package-lock.json and package-local
    // manifests, then imports runtime entrypoints in child processes. It never reads JS/TS
    // source to text-match code tokens; the census prefilter is fooled by its documented .mjs
    // paths plus generic readFileSync/.test usage, so masking would add no protection.
    'check-declared-deps-extracted.mjs',
    // check-insight-normative.mjs scans agent-insight DOCS (`isInsightDoc` selects .md/.mdx
    // frontmatter) — never JS/TS source. The census prefilter trips only on its
    // `./lib/tracked-files.mjs` import specifier (added 2026-09-04) plus a generic
    // readFileSync/.test pair; a JS comment stripper applied to Markdown would corrupt the
    // frontmatter it validates, so the exposure is recorded here instead.
    'check-insight-normative.mjs',
    // check-format.mjs was REMOVED here on 2026-09-28 (WI-10003582): PARSES_AST now matches
    // `.createSourceFile(` under any receiver, and check-format.mjs parses each file with
    // `typescript.createSourceFile(...)`, so the census classifies it as AST-parsing rather
    // than unmasked. The shrink-only baseline must not carry an entry the census no longer
    // measures.
    // check-env-feature-gates.mjs was REMOVED here on 2026-08-10 (WI-37717). BOTH passes now
    // detect over stripCommentsOnly() text (the `git grep` is a fast FILE FINDER, not the
    // detector). Two latent harms, both measured reachable: (1) a comment naming an
    // UNCLASSIFIED gate is reported as real, and `--strict` is CI-wired, so that is a red gate
    // for code that does not exist; (2) worse, `seen.add` runs BEFORE the classification test
    // and `seen` drives the stale-registry check, so a capability gate DELETED from code but
    // still described in a comment is never reported stale — its registry entry lingers
    // forever, defeating the anti-linger purpose the guard exists for (EI-2390).
    // Two live instances of the shape (both absorbed by ALLOW, hence currently invisible):
    // PAPERCUSP_SPAWNER_SIDECAR and PAPERCUSP_LOOP_PROFILER — the latter in a comment that
    // explains the env gate BECAME a flag, i.e. it is gone.
    // ⚠ comments ONLY: the operative token IS a string literal (`=== '1'`), so
    // stripCommentsAndStrings would take both passes silently 100% inert.
    // check-explicit-presence.mjs was REMOVED here on 2026-08-10 (WI-37717) because it now
    // imports stripCommentsOnly, which this file's classifier ranks as `shared`. Read that as
    // a PARTIAL mask, not a full one: it deliberately still text-matches against unmasked
    // STRINGS, because its corpus includes generated runner source living inside template
    // literals (admin-test-suites.ts) that carries the real incident shape. Measured over
    // 3,934 files: masking comments moved the corpus verdict by nothing (62 -> 62) while
    // ALSO masking strings dropped 8 rows, every one real code and not one a phantom. So it
    // cannot pass probeStringLiteralBlindness and is correctly absent from the cases table
    // above — "migrate it to the full stripper" is a REGRESSION, and its own header says so.
    // Reviewed WI-10006055: this wrapper matches Vite process diagnostics and
    // delegates generated HTML/asset inspection to bundle-budget.mjs. Its file
    // reads are build output; it never text-matches code tokens against source.
    'check-bundle-budget.mjs',
    'check-generic-first.mjs',
    // check-github-identity-terms.mjs STAYS (audited 2026-08-10, WI-37717) — and this entry is
    // the "exposure considered" kind, not the "needs a stripper" kind. Its corpus is `.md`/`.mdx`
    // under the docs root ONLY: there is no code file in it, so comment/string masking is not
    // merely unnecessary but UNDEFINED — the prose IS the detection target, and the shared
    // stripper is a TS/SQL parser with no markdown path. Importing it here would be a no-op at
    // best and would blank a URL tail at worst. There is nothing to migrate.
    // The phantom class IS real here, in its prose-specific form: the guard quotes the banned
    // phrasing in its own header, so a doc that must SAY the wrong phrase to correct it trips it.
    // Measured: all 3 near-miss lines in the corpus sit in spec/distribution.mdx — the single
    // hard-coded exclusion — so the ONLY doc explaining the identity split survived purely by
    // being named in the lint's source. A second such doc had no recourse but a code change.
    // Fixed the right way for a prose guard: an in-place `github-identity-justified: <reason>`
    // marker (same convention as `sql-snippet-justified:`), bare-marker-rejected, 3-line
    // lookback, pinned by __tests__/check-github-identity-terms.test.ts. Prose can now justify
    // itself without editing code — which is the actual defect a stripper could never have fixed.
    'check-github-identity-terms.mjs',
    // check-host-bundle-builds.mjs does not scan JS/TS source for code tokens. It invokes the
    // host bundler and compares the generated systemd runner byte-for-byte with its source;
    // `readFileSync` is used for equality, and `.test` only filters child-process diagnostics.
    // The property-based prefilter therefore sees a guard-shaped exposure, but masking would
    // not affect any analyzed text. Keep the exposure declared rather than adding a no-op import.
    'check-host-bundle-builds.mjs',
    // This test reads package.json to assert the postinstall command, then
    // regex-matches diagnostics from its fixture run. It never matches JS/TS
    // source text; masking that source would be a no-op. The quoted .mjs import
    // and readFileSync make the property prefilter classify it as a source guard.
    'check-installed-patch-postimages.test.mjs',
    // check-js-syntax.mjs does not text-match code tokens against source at all. Its offenders
    // come from `node --check` EXIT CODES and an eslint scope graph — two real parsers — so no
    // comment, string literal or prose can mint a phantom offender here. The property prefilter
    // is fooled by three incidental shapes, each measured 2026-08-30 against its own masked
    // source: SCANS_CODE_FILES matches `.mjs'` inside the `f.endsWith('.mjs')` SCOPE FILTER;
    // TEXT_MATCHES matches `f.includes('/_retired/')`, which tests a FILE PATH, and the
    // `text.match(...)` pair, which parses node's STDERR for `<path>:<line>` and `SyntaxError:`;
    // READS_FILES matches the `readFileSync` that hands source to eslint's PARSER.
    // It became visible here only when the load leg (EI-21892432987434951) introduced that read —
    // before it the guard shelled out to `node --check` alone and matched no predicate. Masking
    // would change nothing it analyses, so this is the "exposure considered" kind, not the
    // "needs a stripper" kind. A no-op stripper import would score it `shared` while masking
    // nothing, which is exactly the laundering this list exists to make visible. (WI-1309267)
    'check-js-syntax.mjs',
    // check-licenses.mjs (license gate, 2026-09-29) never text-matches JS/TS source. Its only
    // `readFileSync` feeds `JSON.parse` for lockfile/manifest JSON, and it reads artifact HEADER
    // BYTES via openSync/readSync to classify binaries. Measured against its own source: the
    // prefilter is fooled by the `.mjs'` in its `./check-lockfile-census.mjs` import and its argv
    // basename check, and by `.test(` / `.includes(` over license ids, lockfile keys and relative
    // PATHS. Masking would change nothing it analyses, so this is the "exposure considered" kind.
    'check-licenses.mjs',
    // check-migration-fixture-drift.mjs was REMOVED here on 2026-08-10 (WI-37717). It scans
    // TWO surfaces and both are now masked: migration .sql text via stripSqlComments (inside
    // extractIntroducedColumns — the input is definitionally SQL, so no extension dispatch is
    // needed) and .ts fixture text via stripCommentsOnly(text, relPath). Unmasked it was wrong
    // in BOTH directions, measured on the real corpus: 5 phantom columns off a commented-out
    // ALTER TABLE (563-memory-federation-capture-triggers.sql), and — the costlier one — 7 of
    // 14 real columns dropped on 299-scheduled-plans-schedule-fields.sql, because a statement
    // ends at the first `;` and prose in an interior comment supplied one early.
    // ⚠ comments ONLY, never stripCommentsAndStrings: these fixtures hold their CREATE TABLE
    // inside a template literal, so blanking strings takes the guard silently 100% inert.
    'check-no-box-identity.mjs',
    'check-no-cdn-egress.mjs',
    'check-no-control-bytes.mjs',
    'check-no-identity-literals.mjs',
    'check-no-nul-in-source.mjs',
    // check-no-restart-imports.mjs was REMOVED here on 2026-08-10 (WI-37717): it now imports
    // stripCommentsOnly, which this file's classifier ranks as `shared`. Same PARTIAL-mask
    // shape as check-explicit-presence above — it deliberately still matches unmasked STRINGS,
    // because its stated miss-class is "bare config strings" (package.json deps, tsconfig path
    // maps, transpilePackages arrays), which ARE string literals. Masking strings would blind
    // it to its PRIMARY target, so it cannot pass probeStringLiteralBlindness and is correctly
    // absent from the cases table. Its own --self-test pins that: the four STRING positive
    // controls fail loudly if anyone swaps in the full stripper.
    'check-okf-conformance.mjs',
    // check-scope-defaults.mjs was REMOVED here on 2026-08-10 (WI-37717). It always DID mask
    // comments, but with a hand-rolled per-line heuristic this classifier cannot see — the
    // documented mis-ranking shape (see the note above this set). It now imports
    // stripCommentsOnly, so it ranks `shared`. Strings stay unmasked deliberately: the scanned
    // expression `?? 'default'` IS a string literal, so a string-masking stripper would blind
    // it entirely. The heuristic it replaced was also WRONG in the false-negative direction —
    // it treated any earlier `//` as a comment start without checking for strings, so
    // `const u = 'https://x.com'; const ws = scope ?? 'default';` reported nothing.
    'check-shell-syntax.mjs',
    'check-smart-quotes.mjs',
    // check-sql-guidance-justified.mjs was REMOVED here on 2026-08-10 (WI-37717). Detection now
    // runs over stripCommentsOnly() for .ts; prose surfaces (.md/.mdx) are deliberately NOT
    // masked, because there the agent-facing text IS the corpus and a TS parser would blank
    // whatever follows a `//` in a URL. Same PARTIAL-mask shape as its siblings above — the
    // token it reads IS a string literal (`description: '…'`, the guidance object's values), so
    // stripCommentsAndStrings would take it silently 100% inert.
    // Unmasked it walked COMMENT text as code in `guidanceRegions()` and was wrong in BOTH
    // directions, each measured on the real corpus (986 agent-tool files):
    //   - an apostrophe in a comment inside the object ("a peer's", "they haven't") opens a fake
    //     string the walker never closes, so depth never returns to 0 and the region runs to EOF:
    //     work_items/claim_next.ts's region covered the whole 22KB file, which would report that
    //     tool's OWN implementation SQL as agent-facing guidance — precisely what the guard's
    //     header promises it does not flag. mode/set.ts over-ran by 5.5KB the same way;
    //   - the mirror image: a comment BETWEEN `description:` and its literal makes the walker see
    //     `/` instead of a quote and skip the region entirely (3 live today — the prompt-weight
    //     annotations agents add sit exactly there), and a brace in a comment closed
    //     dev/pipeline_position.ts's region 9KB early. Guidance past that point was never linted.
    // Both were LATENT, not live: none of the 3 affected files currently holds covered-table SQL,
    // and the tree verdict is unchanged at 3 (all .mdx). Reachable, though — claim_next.ts is a
    // work_items tool whose most likely future edit is exactly the SQL its runaway region covers.
    // ⚠ The MARKER window still reads RAW text: a justification is normally written AS a comment
    // (`// sql-snippet-justified: …`), so masking it would blank every justification in the repo
    // and turn the guard into a false-positive machine. `--self-test` case 4 pins that.
    // Reviewed WI-10006055: every readFileSync parses a package.json manifest;
    // includes() tests CLI argv. The quoted .mjs is an imported helper, not a
    // JS/TS scan target. A source masker would change none of these inputs.
    'check-partial-install.mjs',
    // ⚠ KNOWN FALSE POSITIVE, not debt — remove this entry when EI-20077125623815751 lands.
    // This guard never reads JS/TS source: it reads `package.json` and regex-tests
    // `JSON.stringify(declared)`. Its ONLY quoted-extension evidence is its own IMPORT
    // SPECIFIER (`from './lib/tracked-files.mjs'`), which SCANS_CODE_FILES cannot tell apart
    // from a scan target — the both-directions blindness EI-20077125623815751 tracks.
    // ⛔ DO NOT "fix" that by blanking module specifiers before SCANS_CODE_FILES. Measured
    // 2026-09-20: it drops the population 93 -> 75, silently de-guarding 18 files whose only
    // quoted extension is likewise an import — among them check-no-nul-in-source.mjs,
    // check-shell-syntax.mjs and check-constant-conditional.mjs, which genuinely DO scan
    // source. That trades one false positive for 18 false NEGATIVES, the direction this
    // suite must never err in. The real fix needs evidence of the file list actually being
    // iterated, not a quoted-extension proxy.
    'check-tracked-src-entry-dist.mjs',
    'check-vacuous-negative-assertions.mjs',
    // check-workspace-default-sql.mjs was REMOVED here on 2026-08-10 (WI-37717 /
    // EI-20073035509369492). Same PARTIAL-mask shape as its siblings above: it now imports
    // stripCommentsOnly and passes the real path, so masking DISPATCHES per file — this guard
    // scans both `.sql` migrations and `.ts` runtime DDL. Strings stay unmasked because the
    // matched token IS a string literal (`DEFAULT 'default'`).
    // It was the last of the three hand-rolled string-blind comment tests: any earlier `--` or
    // `//` counted as a comment start even inside a literal, so
    //   INSERT INTO t VALUES ('a--b'), (workspace_id ... DEFAULT 'default')
    // reported NOTHING. The SQL path it needed did not exist until this WI added it — the
    // shared stripper was a TypeScript parser that returned SQL completely unmasked.
    // ⚠ KNOWN FALSE POSITIVE, not debt — remove this entry when EI-20077125623815751 lands.
    // Runs lints against a committed snapshot; reads only JSON owner markers, and its `.test(` /
    // `.includes(` calls run over argv, SHAs and workspace names. Its only quoted-extension
    // evidence is an import specifier (`'../libs/test-config/src/tmpdir-guard.ts'`, added
    // 2026-10-10) — the check-tracked-src-entry-dist.mjs shape (EI-25706078725120945).
    'lint-as-committed.mjs',
    'lint-tsc-workspaces.mjs',
  ]);

  // Default-consumer reviews resolve the original ten unknowns at exact source bytes.
  // A changed/unreviewed consumer still fails as unknown; a measured source read
  // always overrides a review and needs its own exposure assessment.
  const UNRESOLVED_CORPUS = new Set<string>([]);

  const inventory = execFileSync('git', ['ls-files', '-z'], { cwd: path.resolve(SCRIPTS_DIR, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const census = new Map<string, ReturnType<typeof reviewedReaderCorpus>>();
  const measureUnmasked = (): string[] =>
    GUARD_SCRIPTS().filter((f) => {
      const masked = maskedSourceOf(f);
      if (!(TEXT_MATCHES.test(masked) && READS_FILES.test(masked))) return false;
      if (classifyMasking(masked) !== 'unmasked') return false;
      if (!census.has(f)) census.set(f, reviewedReaderCorpus('scripts/' + f, observeReaderCorpus('scripts/' + f, inventory), readFileSync(join(SCRIPTS_DIR, f), 'utf8')));
      // Unknown is conservatively retained. An unsupported operation must not hide a
      // source scanner, and its receipt stays available in the assertion diagnostics.
      return census.get(f)!.status !== 'non-source';
    });

  it('no NEW guard text-matches code tokens against source it never masked', () => {
    const added = measureUnmasked().filter((f) => !SCANS_UNMASKED_SOURCE.has(f) && !UNRESOLVED_CORPUS.has(f));
    expect(
      added,
      `These guards read unmasked JS/TS source or their executable corpus could not be determined. ` +
        `A guard's error message quotes the very token it detects, so prose that discusses the rule ` +
        `mints phantom offenders and reds the gate on a comment (EI-20045405992394901). Import ` +
        `stripCommentsOnly / stripCommentsAndStrings from scripts/lib/strip-comments-and-strings.mjs for measured source readers; resolve unknowns before classifying them. ` +
        JSON.stringify(added.map(file => ({ file, ...corpusReceipt(census.get(file)) }))),
    ).toEqual([]);
  });

  it('the unmasked baseline does not carry entries that already mask (it must stay honest)', () => {
    const stale = [...SCANS_UNMASKED_SOURCE].filter((f) => !measureUnmasked().includes(f));
    expect(stale, 'These guards now mask their source or demonstrably read a non-code corpus — remove them from SCANS_UNMASKED_SOURCE. ' + JSON.stringify(stale.map(file => ({ file, ...corpusReceipt(census.get(file)) })))).toEqual([]);
  });

  it('an unresolved reader cannot become a source reader without an exposure review', () => {
    measureUnmasked();
    const nowSource = [...UNRESOLVED_CORPUS].filter(f => census.get(f)?.status === 'source');
    expect(nowSource, 'These previously unknown readers now have positive source-read evidence; review their masking rather than silently retaining an unknown exemption.').toEqual([]);
  });

  it('the real systemd reader is non-source while the regex-only conflict reader is source', () => {
    measureUnmasked();
    expect(census.get('check-systemd-startlimit-placement.mjs')?.status).toBe('non-source');
    expect(census.get('check-conflict-markers.mjs')?.status).toBe('source');
  });

  it('default-consumer reviews remain bound to the exact reviewed script bytes', () => {
    for (const [file, review] of Object.entries(REVIEWED_READER_CORPUS)) {
      expect(crypto.createHash('sha256').update(readFileSync(join(SCRIPTS_DIR, file), 'utf8')).digest('hex'), file + ': review source changed; reclassify its direct consumer').toBe(review.sha256);
    }
  });

  // CONTROL. The rule this replaced was `/^(export\s+)?function\s+stripComments/m` — it keyed on
  // one SPELLING in one BINDING FORM. Each fixture below is a real shape found in scripts/ that
  // the old rule scored as clean. If someone narrows the classifier back, these fail.
  describe('CONTROL: the widened rule catches what the name-specific rule missed', () => {
    const OLD_RULE = /^(export\s+)?function\s+stripComments/m;
    const cases: Array<[string, string, Masking]> = [
      [
        'a stripper bound with const, not declared as a function (was in lint-affected-gate.mjs)',
        `const stripComments = (src) => src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');`,
        'hand-rolled',
      ],
      [
        'the naive regexes inlined with no named function at all (was in check-derived-signal-firings.mjs)',
        `const body = m[1].replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').split('\\n');`,
        'hand-rolled',
      ],
      [
        'a stripper for another language, so another name (check-partial-index-alignment.mjs)',
        `const stripSqlComments = (s) => s.replace(/--[^\\n]*/g, ' ');`,
        'hand-rolled',
      ],
      [
        'a guard that strips NOTHING — invisible to every HOW-shaped rule',
        `const src = readFileSync(f, 'utf8'); if (src.includes('setInterval(')) fail(f);`,
        'unmasked',
      ],
    ];

    for (const [name, fixture, expected] of cases) {
      it(name, () => {
        expect(OLD_RULE.test(fixture), 'CONTROL IS VACUOUS: the old rule already caught this').toBe(false);
        expect(classifyMasking(fixture)).toBe(expected);
      });
    }

    it('and still recognises the shape the old rule DID catch (no coverage was traded away)', () => {
      const fixture = `function stripComments(src) { return src; }`;
      expect(OLD_RULE.test(fixture)).toBe(true);
      expect(classifyMasking(fixture)).toBe('hand-rolled');
    });

    it('a bare import of the shared module is not itself a hand-roll', () => {
      // A migrated guard MENTIONS a stripper name in its own import statement. That must not
      // read as a hand-rolled definition, or migrating a file would move it from one baseline
      // to the other instead of off both. This is why the rule anchors on DEFINITION forms
      // rather than ranking `shared` ahead of `hand-rolled` (see NAMED_STRIPPER_DEF).
      const fixture = `import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';`;
      expect(classifyMasking(fixture)).toBe('shared');
    });

    // WI-37801 — THE FALSIFYING CONTROL FOR THE FIRST-MATCH-WINS BLIND SPOT.
    // Under the previous implementation this returned 'shared', so the assertion below fails
    // before the fix and passes after; that is what makes the fix verifiable rather than
    // plausible. The fixture is not hypothetical — it is the exact shape of lint-migrations.mjs,
    // which imports the shared SQL mask for findLiteralTenantDefault while still hand-rolling
    // stripSqlBodies (deliberately, WI-37800), and was de-listed from BASELINE while doing so.
    it('a file that BOTH imports the shared module AND defines a private stripper is hand-rolled', () => {
      const fixture = [
        `import { stripSqlComments } from './lib/strip-comments-and-strings.mjs';`,
        `export function stripSqlBodies(sqlText) {`,
        `  return sqlText.replace(/\\$([A-Za-z_]*)\\$/g, ' ');`,
        `}`,
      ].join('\n');
      expect(SHARED_STRIPPER.test(fixture), 'CONTROL IS VACUOUS: fixture must import the shared module').toBe(true);
      expect(classifyMasking(fixture)).toBe('hand-rolled');
    });

    // The mirror case, so the fix cannot be "call everything hand-rolled". A file that imports
    // the shared module and merely CALLS it — the shape every fully-migrated guard has — must
    // still be `shared`, including when the call sits at the start of a line.
    it('calling an imported stripper is not defining one', () => {
      const fixture = [
        `import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';`,
        `const masked = stripCommentsOnly(readFileSync(f, 'utf8'), f);`,
        `stripCommentsOnly(src, name);`,
      ].join('\n');
      expect(classifyMasking(fixture)).toBe('shared');
    });

    // WI-37801 follow-up, from a REAL false positive an hour after the definition rule landed:
    // lint-migrations.mjs retired its private stripSqlBodies for exactly this alias, and the
    // rule scored the now-migrated file as debt. A named wrapper that DELEGATES is the migrated
    // state — flagging it punishes the very consolidation this suite drives.
    it('a named alias that DELEGATES to the shared module is migrated, not hand-rolled', () => {
      const fixture = [
        `import { stripSqlCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';`,
        `const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);`,
      ].join('\n');
      // VACUITY GUARD: the alias must really look like a stripper definition, or this proves
      // nothing about the delegation carve-out — it would just be a name the rule never matched.
      expect(
        new RegExp(NAMED_STRIPPER_DEF.source, 'm').test(fixture),
        'CONTROL IS VACUOUS: the alias no longer matches the definition rule at all',
      ).toBe(true);
      expect(classifyMasking(fixture)).toBe('shared');
    });

    // ...and the carve-out must not become a laundering trick. A file that delegates in one
    // place and still hand-rolls in another is hand-rolled: definesPrivateStripper checks EVERY
    // definition site precisely so the first one cannot decide for the rest.
    it('a delegating alias does NOT launder a real hand-roll elsewhere in the same file', () => {
      const fixture = [
        `import { stripSqlCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';`,
        `const maskSealingBodies = (sqlText) => stripSqlCommentsAndStrings(sqlText);`,
        `function stripComments(sql) {`,
        `  return sql.replace(/--[^\\n]*/g, ' ');`,
        `}`,
      ].join('\n');
      expect(classifyMasking(fixture)).toBe('hand-rolled');
    });
  });
});

// @vitest-environment node
/**
 * tauri-bindings-sync — the checked-in specta bindings must actually be the
 * bindings for the commands the Rust app collects.
 *
 * WHY THIS EXISTS (EI-18899060060624700). From the papercup→papercusp rename
 * until 2026-07-28, `papercusp-desktop/src-tauri/src/main.rs` exported the
 * tauri-specta bindings to `"../../papercup/apps/operator/lib/tauri-bindings.ts"`.
 * That path is relative to the CRATE dir and specta CREATES missing parent
 * directories — so the export could not fail. It silently conjured a one-file
 * `papercup/` tree at the repo root, wrote every regeneration into it, and left
 * the real `apps/operator/lib/tauri-bindings.ts` 52 lines stale for ~7 weeks.
 * Every command added in that window (including `endpoint_ipc_status`, the IPC
 * health command an observability panel needed) had no typed binding in the tree
 * anything imports.
 *
 * Three silences stacked to hide it, and each is covered by one assertion here:
 *   1. a wrong export path cannot error, because specta mkdir -p's it
 *      → `it('exports to the canonical bindings path')` resolves the literal.
 *   2. only a debug run regenerates (`#[cfg(debug_assertions)]`), so nobody
 *      watches the write
 *      → assertion 2 does not depend on a run happening at all; it compares the
 *        committed file against the collected command list.
 *   3. nothing asserted the command list and the bindings agree, so a missing
 *      binding surfaced only as a TS error at a call site nobody had written yet
 *      → `it('has a binding for every collected command')`.
 *
 * If assertion 2 fails, the fix is NOT to hand-edit the bindings (the file is
 * generated — a hand-edit is lost on the next dev run). Run the desktop app in
 * dev (`cd papercusp-desktop && npm run dev`), which regenerates it in place.
 *
 * WHERE THE GENERATED FILE LIVES (EI-18899708711154370 · D-014, 2026-08-02). It is
 * `packages/operator-core/lib/tauri-bindings.ts`; `apps/operator/lib/tauri-bindings.ts`
 * is a re-export. There used to be TWO live copies imported side by side, because a
 * package cannot import from an app: with generation in apps/operator, operator-core
 * had to hand-maintain its own copy, which drifted 12 commands behind. specta writes
 * exactly one file, so the other was stale by construction. Hence assertion 1 pins
 * the export at the PACKAGE.
 *
 * A fourth silence, added the same day: the generated output did not typecheck
 * standalone (it referenced `Value` without declaring it), and nothing noticed
 * because the routine loop typechecks operator-core only
 * → `it('generated bindings declare every type they reference')`.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Walk up from this file to the monorepo root (the package.json with "workspaces"). */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('tauri-bindings-sync: could not locate the monorepo root');
}

const REPO_ROOT = findRepoRoot();
const CRATE_DIR = path.join(REPO_ROOT, 'papercusp-desktop', 'src-tauri');
const MAIN_RS = path.join(CRATE_DIR, 'src', 'main.rs');
/**
 * The ONE generated bindings file.
 *
 * It lives in `packages/operator-core`, not in this app (EI-18899708711154370 ·
 * no-http-anywhere-2026-07-28 D-014). Until 2026-08-02 specta wrote it here and
 * operator-core — which cannot import from an app — kept a hand-maintained second
 * copy that drifted 12 commands behind. `apps/operator/lib/tauri-bindings.ts` is now
 * a re-export, so this constant must keep pointing at the PACKAGE.
 */
const CANONICAL_BINDINGS = path.join(
  REPO_ROOT,
  'packages',
  'operator-core',
  'lib',
  'tauri-bindings.ts',
);

/**
 * The command names inside `tauri_specta::collect_commands![ ... ]`.
 *
 * Entries are paths (`endpoint_ipc::endpoint_ipc_status`) or bare idents
 * (`app_version`); specta registers them under the LAST segment, which is the
 * name the generated `__TAURI_INVOKE("...")` uses.
 */
function collectedCommands(mainRs: string): string[] {
  const macro = 'collect_commands![';
  const start = mainRs.indexOf(macro);
  if (start < 0) throw new Error('tauri-bindings-sync: collect_commands![ not found in main.rs');

  // Scan to the matching close bracket so the list can grow/reflow freely.
  let depth = 1;
  let i = start + macro.length;
  for (; i < mainRs.length && depth > 0; i++) {
    if (mainRs[i] === '[') depth++;
    else if (mainRs[i] === ']') depth--;
  }
  if (depth !== 0) throw new Error('tauri-bindings-sync: unterminated collect_commands![');

  return mainRs
    .slice(start + macro.length, i - 1)
    .split(',')
    .map((entry) => entry.replace(/\/\/[^\n]*/g, '').trim()) // strip line comments
    .filter(Boolean)
    .map((entry) => entry.split('::').pop()!.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/**
 * Whether the generated file invokes `name`.
 *
 * Specta emits TWO call shapes and a matcher must accept both — a plain
 * `__TAURI_INVOKE("app_version")` when the return type is inferred through a
 * wrapper (`typedError<T, E>(...)`), and a type-parameterised
 * `__TAURI_INVOKE<Registry>("workspaces_list")` otherwise. The first version of
 * this guard only matched the plain form and reported 13 present commands as
 * missing — a detector wrong in the alarming direction is still wrong, and would
 * have trained the next reader to ignore it. The generic is matched lazily so
 * nested type args (`__TAURI_INVOKE<DesktopWindow[]>`, `<Array<Foo>>`) still pair
 * with the right `(`.
 */
const invocationNames = new Map<string, Set<string>>();
function hasBinding(bindings: string, name: string): boolean {
  let names = invocationNames.get(bindings);
  if (!names) {
    names = new Set<string>();
    const source = ts.createSourceFile('tauri-bindings.ts', bindings, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === '__TAURI_INVOKE' && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0])) {
        names!.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    invocationNames.set(bindings, names);
  }
  return names.has(name);
}

/** The banner tauri-specta puts at the top of every file it generates. */
const GENERATED_BANNER = 'This file has been generated by Tauri Specta';

/**
 * Every checked-in file carrying the tauri-specta banner.
 *
 * WHY THIS IS SCANNED FOR (EI-18899708711154370). The bug this whole file guards
 * was TWO generated copies imported side by side — and the reason nothing caught it
 * is that both copies were individually well-formed. Only their PLURALITY was wrong,
 * and no assertion counted them. This one does.
 *
 * The live regression it prevents is specific: specta writes the file at app
 * STARTUP, so a desktop binary compiled BEFORE the export path moved still writes to
 * the OLD location. Running a stale binary therefore re-creates the duplicate —
 * silently, because every other assertion here only ever looks at the canonical
 * file and would stay green.
 */
function filesWithGeneratedBanner(): string[] {
  const SKIP = new Set([
    'node_modules',
    '.git',
    'target',
    'dist',
    '.next',
    'coverage',
    '_retired',
    'vendor',
  ]);
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir is not a finding
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.ts')) {
        const full = path.join(dir, e.name);
        try {
          // The banner is at the very top (line 1, or just under the `header` hook),
          // so a bounded read keeps this a whole-tree scan without reading the tree.
          if (readFileSync(full, 'utf8').slice(0, 4096).includes(GENERATED_BANNER)) {
            found.push(full);
          }
        } catch {
          /* unreadable file is not a finding */
        }
      }
    }
  };
  for (const top of ['apps', 'packages', 'libs', 'papercusp-desktop']) {
    walk(path.join(REPO_ROOT, top));
  }
  return found.sort();
}

/**
 * Names TypeScript provides itself, so a reference to one is never "undeclared".
 * Deliberately small — this file's generated surface uses very few of them, and a
 * bloated allowlist is how a real undeclared name gets waved through.
 */
const TS_GLOBAL_TYPES = new Set([
  'Array',
  'Boolean',
  'Date',
  'Error',
  'Exclude',
  'Extract',
  'Function',
  'Map',
  'NonNullable',
  'Number',
  'Object',
  'Omit',
  'Parameters',
  'Partial',
  'Pick',
  'Promise',
  'Readonly',
  'Record',
  'RegExp',
  'Required',
  'ReturnType',
  'Set',
  'String',
  'Symbol',
  'Uint8Array',
]);

/**
 * Type names the generated file REFERENCES but never declares, imports, or binds as
 * a generic parameter.
 *
 * WHY THIS IS ASSERTED (D-014c). specta 2.0.0-rc.24 expands `serde_json::Value`
 * INLINE at each use site, but its recursive arms cannot be inlined — so the
 * exporter emitted the bare name (`Value[]`, `{ [key in string]: Value }`) while
 * never emitting `export type Value`. The generated file therefore did not typecheck
 * standalone (4x TS2304), and that sat unnoticed because `lint:tsc` checks
 * `packages/operator-core` ONLY — the file lived in `apps/operator`, which nothing
 * in the routine loop typechecks. Now that the file IS in operator-core the compiler
 * would catch it, but only as a raw TS2304 with no hint of the cause; this names it.
 *
 * The fix for a failure here is in the GENERATOR (the `.header(...)` in main.rs),
 * never in the generated output — a hand-added declaration in the output was already
 * dropped once by a regeneration.
 */
function undeclaredTypeReferences(bindings: string): string[] {
  // Strip comments and string literals first: the generated file is full of prose
  // doc-comments and `__TAURI_INVOKE("...")` names whose capitalised words are not
  // type references.
  const code = bindings
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  const declared = new Set<string>(TS_GLOBAL_TYPES);
  for (const m of code.matchAll(/\b(?:type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]);
  }
  // Imported bindings, e.g. `import { invoke as __TAURI_INVOKE, Channel } from ...`.
  for (const m of code.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const spec of m[1].split(',')) {
      const name = spec.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) declared.add(name);
    }
  }
  for (const m of code.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]);
  }
  // Generic parameters, e.g. `function typedError<T, E>(...)` / `type Foo<T> = ...`.
  for (const m of code.matchAll(/\b(?:function|type|interface|class)\s+[\w$]+\s*<([^>]*)>/g)) {
    for (const param of m[1].split(',')) {
      const name = param.trim().split(/\s+/)[0]?.replace(/[^\w$]/g, '');
      if (name) declared.add(name);
    }
  }

  const referenced = new Set<string>();
  // A capitalised identifier NOT in a property-key position (`Bool:` / `Array?:`)
  // or a qualified member position (`Namespace.EventCallback` /
  // `import("...").Webview`). Qualified members are declared by their namespace
  // or import target; only the qualifier itself can be an undeclared local name.
  // The generated `Value` union is built from object keys named `Array`, `Object`,
  // `String`, `Number`, `Bool` — keys, not type references, and excluding them is
  // what keeps this check from crying wolf on every serde-tagged enum.
  for (const m of code.matchAll(/(?<!\.)\b([A-Z][\w$]*)\b(?!\s*\??\s*:)/g)) referenced.add(m[1]);

  return [...referenced].filter((name) => !declared.has(name)).sort();
}

/**
 * Builder calls chained onto `Typescript::default()` before the `,`.
 *
 * ⚠ THE TRAP THIS EXISTS FOR. These patterns used to require `Typescript::default()`
 * to be followed IMMEDIATELY by the comma. So the moment anyone configured the
 * generator — exactly what `.header(BINDINGS_HEADER)` does today (D-014) — the match
 * failed and `exportedBindingsPath` threw "could not find the specta export
 * destination". That is: changing the generator config silently disarms the very
 * guard that polices the generator config, and it fails as a confusing parse error
 * rather than as the assertion it is. Keep this tolerant of a chain.
 *
 * `[^()]*` per argument: enough for `.header(BINDINGS_HEADER)` and any other
 * ident/literal argument, and it deliberately does NOT try to balance nested parens
 * — an inlined argument containing `(` should fail loudly here rather than be
 * mis-parsed into a wrong export path.
 */
const BUILDER_CHAIN = String.raw`(?:\s*\.[A-Za-z_]\w*\([^()]*\))*`;

/**
 * The export destination declared in main.rs, as a path resolved from the crate
 * dir.
 *
 * Two accepted spellings, because both have been in the tree:
 *   - `concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/…")` — the current form.
 *     CARGO_MANIFEST_DIR *is* the crate dir, so the tail resolves against it.
 *   - a bare `"../../apps/…"` literal — resolved against the process CWD at run
 *     time, which is why this is no longer used (the same misdirected file turned
 *     up at three different depths). Still parsed so the assertion keeps meaning
 *     if someone reverts to it: it is checked against the crate dir, the only
 *     interpretation under which a relative literal is correct at all.
 */
function exportedBindingsPath(mainRs: string): { literal: string; resolved: string } {
  const anchored = mainRs.match(
    new RegExp(
      String.raw`\.export\(\s*specta_typescript::Typescript::default\(\)${BUILDER_CHAIN}\s*,\s*concat!\(\s*env!\("CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)"\s*,?\s*\)`,
    ),
  );
  if (anchored) {
    return {
      literal: `CARGO_MANIFEST_DIR + ${anchored[1]}`,
      resolved: path.resolve(CRATE_DIR, `.${anchored[1]}`),
    };
  }

  const bare = mainRs.match(
    new RegExp(
      String.raw`\.export\(\s*specta_typescript::Typescript::default\(\)${BUILDER_CHAIN}\s*,\s*"([^"]+)"`,
    ),
  );
  if (bare) return { literal: bare[1], resolved: path.resolve(CRATE_DIR, bare[1]) };

  throw new Error('tauri-bindings-sync: could not find the specta export destination in main.rs');
}

describe('tauri-specta bindings stay in sync with the Rust command list', () => {
  const mainRs = readFileSync(MAIN_RS, 'utf8');

  it('exports to the canonical bindings path, resolved from the crate dir', () => {
    const { literal, resolved } = exportedBindingsPath(mainRs);
    expect(
      resolved,
      `main.rs exports specta bindings to "${literal}", which resolves to\n  ${resolved}\n` +
        `but the frontend imports\n  ${CANONICAL_BINDINGS}\n` +
        'A mismatch cannot fail at run time (specta creates the directory), so it goes ' +
        'unnoticed until a call site needs a binding that was never written there.',
    ).toBe(CANONICAL_BINDINGS);
  });

  it('preserves receipt-backed bindings at startup while ordinary development regenerates them', () => {
    // Execute the production Rust export statement with a tiny stand-in for
    // specta's writer. This catches an unguarded startup write without building
    // the desktop or weakening the archive verifier's recorded-file census.
    const exportAt = mainRs.indexOf('.export(');
    const start = mainRs.lastIndexOf('#[cfg(debug_assertions)]', exportAt);
    const end = mainRs.indexOf('// P-009 single-instance guard', exportAt);
    expect(exportAt).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(exportAt);
    const directory = mkdtempSync(path.join(tmpdir(), 'bindings-export-'));
    try {
      const crate = path.join(directory, 'papercusp-desktop/src-tauri');
      const bindings = path.join(directory, 'packages/operator-core/lib/tauri-bindings.ts');
      mkdirSync(crate, { recursive: true });
      mkdirSync(path.dirname(bindings), { recursive: true });
      const source = path.join(directory, 'export.rs');
      const binary = path.join(directory, process.platform === 'win32' ? 'export.exe' : 'export');
      writeFileSync(source, `
mod specta_typescript {
    #[derive(Default)] pub struct Typescript;
    impl Typescript { pub fn header(self, _: &str) -> Self { self } }
}
struct SpectaBuilder;
impl SpectaBuilder {
    fn export(&self, _: specta_typescript::Typescript, path: &str) -> std::io::Result<()> {
        std::fs::write(path, "regenerated")
    }
}
fn main() {
    let specta_builder = SpectaBuilder;
    const BINDINGS_HEADER: &str = "fixture header";
    ${mainRs.slice(start, end)}
}
`);
      execFileSync('rustc', ['--edition=2021', '--crate-name', 'bindings_export_guard', source, '-o', binary], {
        env: { ...process.env, CARGO_MANIFEST_DIR: crate }, timeout: 20_000, stdio: 'pipe',
      });
      for (const receipt of ['/independent/verifier-source.json', '', undefined]) {
        const env = { ...process.env };
        delete env.VERIFY_TAURI_SOURCE_RECEIPT;
        if (receipt !== undefined) env.VERIFY_TAURI_SOURCE_RECEIPT = receipt;
        writeFileSync(bindings, 'committed bindings');
        execFileSync(binary, { env, timeout: 5_000, stdio: 'pipe' });
        expect(readFileSync(bindings, 'utf8'), `receipt=${JSON.stringify(receipt)}`)
          .toBe(receipt === undefined ? 'regenerated' : 'committed bindings');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not resurrect a dead pre-rename `papercup/` tree', () => {
    // All three depths the misdirected export was found writing to — three, not
    // one, because a relative path follows the process CWD and the CWD varied.
    // Each held exactly one file (the stray bindings); none is a real tree, so any
    // reappearance means the export destination regressed.
    const strays = [
      path.join(REPO_ROOT, 'papercup'),
      path.join(REPO_ROOT, 'tools', 'papercup'),
      path.join(REPO_ROOT, 'papercusp-desktop', 'src-tauri', 'papercup'),
    ].filter((p) => existsSync(p));

    expect(
      strays,
      'A stray `papercup/` directory is back. It is not a real tree — it is what a ' +
        'misdirected specta export creates. Check the export destination in ' +
        'papercusp-desktop/src-tauri/src/main.rs (it must stay anchored at ' +
        'CARGO_MANIFEST_DIR).',
    ).toEqual([]);
  });

  it('detects a missing binding (matcher is not vacuously permissive)', () => {
    // The loose regex above must still say NO to a command that is absent —
    // otherwise the assertion below is decoration. Positive control on a real
    // command, negative control on one that cannot exist.
    const bindings = readFileSync(CANONICAL_BINDINGS, 'utf8');
    expect(hasBinding(bindings, 'workspaces_list')).toBe(true); // parameterised form
    expect(hasBinding(bindings, 'endpoint_ipc_status')).toBe(true); // plain form
    expect(hasBinding(bindings, 'no_such_command_zzz')).toBe(false);
    const longType = `{ ${Array.from({ length: 40 }, (_, i) => `field${i}: Array<{ value: string }>`).join('; ')} }`;
    expect(hasBinding(`__TAURI_INVOKE<${longType}>("long_return", {})`, 'long_return')).toBe(true);
    expect(hasBinding('// __TAURI_INVOKE("comment_only")', 'comment_only')).toBe(false);
    expect(hasBinding('const text = \'__TAURI_INVOKE("string_only")\';', 'string_only')).toBe(false);
  });

  it('exactly ONE file carries the Tauri-Specta generated header', () => {
    const generated = filesWithGeneratedBanner();

    expect(
      generated,
      `Expected exactly one generated bindings file (${CANONICAL_BINDINGS}), found ` +
        `${generated.length}:\n  ${generated.join('\n  ')}\n\n` +
        'Two copies of this generated module is the exact defect EI-18899708711154370 ' +
        'removed: specta writes only ONE of them, so every other copy is stale by ' +
        'construction while still looking like a valid generated file.\n' +
        'MOST LIKELY CAUSE: a desktop binary built BEFORE the export path moved to ' +
        'packages/operator-core was run — specta exports at app startup, so a stale ' +
        'binary rewrites the OLD location. Rebuild (cd papercusp-desktop && npm run dev) ' +
        'and delete the copy that is not the canonical file; do not "fix" it by making ' +
        'the second copy a re-export, because the next stale run recreates it.',
    ).toEqual([CANONICAL_BINDINGS]);
  });

  it('detects an undeclared type reference (detector is not vacuously permissive)', () => {
    // Positive control: a file shaped like the real bug — `Value` referenced in the
    // two forms specta actually emits, declared nowhere.
    const broken = [
      'import { invoke as __TAURI_INVOKE, Channel } from "@tauri-apps/api/core";',
      'export type Thing = { items: Value[] };',
      'export type Bag = { map: { [key in string]: Value } };',
    ].join('\n');
    expect(undeclaredTypeReferences(broken)).toEqual(['Value']);

    // Negative controls: declaring it fixes it, and the serde-tagged union's object
    // KEYS (Bool/Array/Object/String/Number) must not be mistaken for references.
    expect(undeclaredTypeReferences(`export type Value = string;\n${broken}`)).toEqual([]);
    expect(
      undeclaredTypeReferences(
        'export type V = ({ Bool: boolean }) & { Array?: never; Object?: never; String?: never; Number?: never };',
      ),
    ).toEqual([]);
    expect(
      undeclaredTypeReferences(
        'import * as NS from "pkg"; export type V = NS.EventCallback<import("pkg").Webview>;',
      ),
    ).toEqual([]);
  });

  it('generated bindings declare every type they reference', () => {
    const bindings = readFileSync(CANONICAL_BINDINGS, 'utf8');
    const undeclared = undeclaredTypeReferences(bindings);

    expect(
      undeclared,
      `The generated bindings reference ${undeclared.length} type(s) they never ` +
        `declare: ${undeclared.join(', ')}.\n` +
        'This is a GENERATOR defect, not a file defect — specta expands some types ' +
        '(notably serde_json::Value) inline but cannot inline their recursive arms, ' +
        'so it emits the bare name and no declaration.\n' +
        'FIX IT IN THE GENERATOR CONFIG: the `.header(BINDINGS_HEADER)` call in ' +
        'papercusp-desktop/src-tauri/src/main.rs. Do NOT hand-add the declaration to ' +
        'the generated file — one was added there before and the next regeneration ' +
        'silently dropped it.',
    ).toEqual([]);
  });

  it('has a binding for every collected command', () => {
    const commands = collectedCommands(mainRs);
    // Sanity floor: a parse that silently yields nothing would make this test
    // vacuously green — exactly the failure mode it exists to catch.
    expect(commands.length).toBeGreaterThan(20);

    const bindings = readFileSync(CANONICAL_BINDINGS, 'utf8');
    const missing = commands.filter((name) => !hasBinding(bindings, name));

    expect(
      missing,
      `${missing.length} command(s) collected in main.rs have no binding in ` +
        'packages/operator-core/lib/tauri-bindings.ts. The file is GENERATED — do not ' +
        'hand-add them; run the desktop app in dev (cd papercusp-desktop && npm run dev) ' +
        'to regenerate it.',
    ).toEqual([]);
  });
});

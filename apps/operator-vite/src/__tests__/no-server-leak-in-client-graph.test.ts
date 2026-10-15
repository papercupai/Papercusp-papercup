// Guard: no SERVER-ONLY module may leak into the SPA's browser-eager import graph.
//
// A client React component that value-imports even ONE symbol from a server
// operator-core module drags that whole module — and everything it top-level
// imports — into the browser bundle. On the :3055 Vite dev graph there is NO
// tree-shaking and `node:` builtins are externalized to stubs that THROW on
// property access, so such a module evaluates and throws at module-init,
// white-screening the route ("This view hit an error":
// `get@__vite-browser-external:node:path` → `module code@…embedded-pg-discovery`).
// This exact class recurs (WI-5454: adv/KnowledgePackCandidates → knowledge-packs/
// candidates.ts pulled node:fs/node:path + sync-sse→embedded-pg-discovery into the
// browser). The typecheck can't catch it (aliases/graph aren't typed) and the unit
// suite never links the SPA — so this test IS the detector.
//
// ⚠ AND IT RECURRED WHILE THIS TEST WAS GREEN (WI-39514) — a detector that
// under-walks is worse than none, because its pass is read as an all-clear.
// `resolveSpec` returned null for any specifier that was not operator-core / `@/`
// / relative, so the walk stopped at the FIRST workspace-package hop and never saw:
//   app/adv/hud/goal-launch-settings-model → operator-core/lib/goal-launch-settings
//     → @papercusp/db-org → workspace-context → connection
//     → operator-core/lib/resource-profile → embedded-pg-discovery → node:path
// That threw at module-init inside a <Lazy>, was swallowed by CatchBoundaryImpl,
// and white-screened the ENTIRE /adv route for weeks. Workspace packages are now
// followed (`resolveWorkspacePkg`), vite's shim aliases are honored so the walk
// cannot invent a false leak, and both directions are pinned by controls below.
//
// FIX PATTERN when this fails: the client only needs a type or a pure constant —
// extract those into a client-safe `*-shared.ts` (types + pure values, ZERO
// node/server imports; `import type` from server modules is fine, it's erased),
// re-export them from the server module for existing callers, and point the
// client import at the shared file. See knowledge-packs/candidates-shared.ts.
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
// Helpers live in a plain module, never in a `.test.ts` — a test file imported by
// another test file collects twice and can register 0 tests under a shared-fork
// lane (gate red 761d0a85ac; guarded by no-test-file-imports.test.ts).
import { aliasMatches, parseShimAliases } from "./browser-shim-aliases";

const OPERATOR_VITE = resolve(__dirname, "../.."); // apps/operator-vite
const REPO_ROOT = resolve(OPERATOR_VITE, "../..");
const OPERATOR_ROOT = resolve(OPERATOR_VITE, "../operator"); // apps/operator ('@' alias)
const OPERATOR_CORE_LIB = resolve(REPO_ROOT, "packages/operator-core/lib");
const ENTRY = resolve(OPERATOR_VITE, "src/main.tsx");
const VITE_CONFIG = resolve(OPERATOR_VITE, "vite.config.ts");

/** node: builtins that vite.config aliases to a browser SHIM are safe in the SPA. */
function shimmedNodeBuiltins(): Set<string> {
  const cfg = readFileSync(VITE_CONFIG, "utf8");
  const out = new Set<string>();
  const re = /find:\s*\/\^(node:[a-z_/]+)\$\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cfg))) out.add(m[1]);
  return out;
}

/** A module in the client source trees can eagerly load its dynamic import()s. */
const isClient = (f: string): boolean =>
  f.includes("/apps/operator-vite/src/") || f.includes("/apps/operator/app/");

/**
 * Every client-reachable workspace source module is ours and must be safe.
 *
 * This used to classify only operator-core/operator files even after the graph
 * walker learned to follow workspace packages. That left the final inspection
 * blind to exactly the modules the resolver had just recovered: a
 * `@papercusp/plan-parser` barrel reached `node:crypto`, blanked :3055, and this
 * guard stayed green because the offending file lived under `libs/generic`.
 */
const isOwnCode = (f: string): boolean =>
  f.startsWith(REPO_ROOT + "/") && !f.includes("/node_modules/");

function fileFor(base: string): string | null {
  for (const c of [
    base,
    base + ".ts",
    base + ".tsx",
    base + ".js",
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Shim aliases from vite.config — a specifier vite redirects at a browser shim. */
const SHIM_ALIASES = parseShimAliases(readFileSync(VITE_CONFIG, "utf8"));

/**
 * The shim file a specifier is aliased to, or null. Resolving to the SHIM (rather
 * than the real module) is what keeps this walk honest in BOTH directions: the shim
 * is what actually ships, so walking the real server barrel instead would report a
 * leak the bundler never emits — the false-red class that has red-pinned this gate
 * before.
 */
function shimFor(spec: string): string | null {
  for (const a of SHIM_ALIASES) {
    if (aliasMatches(a.find, spec))
      return fileFor(join(OPERATOR_VITE, "src/shims", a.shim));
  }
  return null;
}

/**
 * Resolve a WORKSPACE package specifier (`@papercusp/db-org`,
 * `@papercusp/coordination/event-log`) to its SOURCE entry, the way vite does via
 * the npm-workspaces symlink in node_modules.
 *
 * ⚠ THIS IS THE EDGE THE WALK USED TO DROP (WI-39514). `resolveSpec` returned null
 * for every specifier that was not operator-core / `@/` / relative, on the stated
 * assumption that "other externals are browser-safe or explicitly shimmed". That is
 * true of THIRD-PARTY deps and false of our own workspace packages, so the walk
 * stopped dead at `@papercusp/db-org` and never saw the six hops behind it:
 *   goal-launch-settings -> @papercusp/db-org -> workspace-context -> connection
 *     -> operator-core/lib/resource-profile -> embedded-pg-discovery -> node:path
 * The guard stayed GREEN while that chain white-screened the entire /adv route.
 *
 * Only packages whose symlink lands INSIDE the repo are followed — a real
 * node_modules dependency stays unwalked, as before.
 */
function resolveWorkspacePkg(spec: string): string | null {
  const m = spec.match(/^(@[^/]+\/[^/]+|[^@./][^/]*)(?:\/(.*))?$/);
  if (!m) return null;
  const [, name, subpath] = m;
  let pkgDir: string;
  try {
    pkgDir = realpathSync(join(REPO_ROOT, "node_modules", name));
  } catch {
    return null;
  }
  // A WORKSPACE package symlinks OUT of node_modules into the repo's own source
  // tree. A third-party dep realpaths to somewhere under a node_modules/ directory
  // (usually the hoisted repo-root one, which is itself inside REPO_ROOT — so the
  // containment check alone is not enough to tell them apart).
  if (!pkgDir.startsWith(REPO_ROOT + "/") || pkgDir.includes("/node_modules/"))
    return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const exports = json.exports as Record<string, unknown> | string | undefined;
  const key = subpath ? `./${subpath}` : ".";
  if (exports && typeof exports === "object") {
    const hit = exports[key];
    if (typeof hit === "string") return fileFor(join(pkgDir, hit));
    if (hit && typeof hit === "object") {
      for (const v of Object.values(hit as Record<string, unknown>)) {
        if (typeof v === "string") {
          const f = fileFor(join(pkgDir, v));
          if (f) return f;
        }
      }
    }
  } else if (typeof exports === "string" && !subpath) {
    const f = fileFor(join(pkgDir, exports));
    if (f) return f;
  }
  if (subpath)
    return (
      fileFor(join(pkgDir, subpath)) ?? fileFor(join(pkgDir, "src", subpath))
    );
  for (const c of [json.module, json.main, "src/index.ts", "index.ts"]) {
    if (typeof c !== "string") continue;
    const f = fileFor(join(pkgDir, c));
    if (f) return f;
  }
  return null;
}

function resolveSpec(spec: string, fromFile: string): string | null {
  const s = spec.replace(/\?.*$/, "");
  // Shims first: vite's alias table wins over the real module (first match wins there too).
  const shim = shimFor(s);
  if (shim) return shim;
  if (s.startsWith("@papercusp/operator-core/lib/"))
    return fileFor(
      join(OPERATOR_CORE_LIB, s.slice("@papercusp/operator-core/lib/".length)),
    );
  if (s === "@papercusp/operator-core")
    return fileFor(join(REPO_ROOT, "packages/operator-core/index"));
  if (s.startsWith("@/")) return fileFor(join(OPERATOR_ROOT, s.slice(2)));
  if (s.startsWith(".")) return fileFor(resolve(dirname(fromFile), s));
  return resolveWorkspacePkg(s); // our own packages; third-party deps still return null
}

// Historical regex-parser failures explain why the scanner now uses the TypeScript AST.
// The former regex parser also mishandled side-effect imports and TypeScript type queries.
//
// ⚠ It was `[\s\S]*?` until 2026-08-02, which made a SIDE-EFFECT import (`import
// './x.css';` — no `from` clause) swallow every line after it until the next `from`,
// then report THAT statement's specifier. Two ways it lied, both silent:
//   - the former `^\s*type\b` guard tested the runaway's text (which starts at the CSS
//     specifier), never the real statement, so a type-only `export type {…} from
//     '<server module>'` — fully erased by the bundler — was recorded as a RUNTIME edge
//     and reported as a leak. That false positive red-pinned the fleet gate.
//   - every statement the runaway jumped OVER lost its edge entirely, so the graph was
//     also under-walked — real leaks could hide behind a side-effect import.
/**
 * Runtime edges declared in ONE module's source (type-only erased). The TypeScript
 * AST keeps typeof import('x').Member and import('x').Type queries out of the
 * runtime graph. Pure, so the scanner itself is unit-testable.
 */
function specsIn(src: string, allowDynamic: boolean): string[] {
  const source = ts.createSourceFile(
    "client-source.tsx",
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: string[] = [];
  const add = (specifier: ts.StringLiteralLike | undefined) => {
    if (specifier) out.push(specifier.text);
  };
  const importHasRuntimeBindings = (clause: ts.ImportClause | undefined) => {
    if (!clause) return true; // side-effect import
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    if (!bindings) return false;
    if (ts.isNamespaceImport(bindings)) return true;
    return (
      bindings.elements.length === 0 ||
      bindings.elements.some((el) => !el.isTypeOnly)
    );
  };
  const exportHasRuntimeBindings = (clause: ts.NamedExportBindings | undefined) => {
    if (!clause) return true; // export * from
    if (ts.isNamespaceExport(clause)) return true;
    return (
      clause.elements.length === 0 ||
      clause.elements.some((el) => !el.isTypeOnly)
    );
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && importHasRuntimeBindings(node.importClause)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      exportHasRuntimeBindings(node.exportClause)
    ) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(node.moduleSpecifier);
      }
    } else if (
      allowDynamic &&
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) add(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(out)];
}

/** Runtime edges (type-only erased). Dynamic import()s count only from client files. */
function edges(file: string): string[] {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return specsIn(src, isClient(file));
}

/** Unshimmed node: builtins a module top-level (non-type) imports. */
function unsafeNodeBuiltins(file: string, shimmed: Set<string>): string[] {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const found = new Set<string>();
  const re = /(?:^|\n)\s*import\b([\s\S]*?)from\s*['"](node:[^'"]+)['"]/g;
  const side = /(?:^|\n)\s*import\s*['"](node:[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/^\s*type\b/.test(m[1])) continue;
    if (!shimmed.has(m[2])) found.add(m[2]);
  }
  while ((m = side.exec(src))) if (!shimmed.has(m[1])) found.add(m[1]);
  return [...found];
}

describe("no server-only module leaks into the SPA browser-eager graph", () => {
  it("every client-reachable operator-core/operator module is browser-safe (no unshimmed node: builtins)", () => {
    const shimmed = shimmedNodeBuiltins();
    const seen = new Map<string, string[]>([[ENTRY, ["src/main.tsx"]]]);
    const queue: Array<[string, string[]]> = [[ENTRY, ["src/main.tsx"]]];
    while (queue.length) {
      const [file, path] = queue.shift()!;
      for (const spec of edges(file)) {
        const r = resolveSpec(spec, file);
        if (r && !seen.has(r)) {
          const np = [...path, `${spec} -> ${r.replace(REPO_ROOT + "/", "")}`];
          seen.set(r, np);
          queue.push([r, np]);
        }
      }
    }

    const leaks: string[] = [];
    for (const [file, chain] of seen) {
      if (!isOwnCode(file)) continue;
      const bi = unsafeNodeBuiltins(file, shimmed);
      if (bi.length) {
        leaks.push(
          `\n  ${file.replace(REPO_ROOT + "/", "")}  [${bi.join(", ")}]\n` +
            chain.map((p, i) => `      ${i}. ${p}`).join("\n"),
        );
      }
    }

    expect(
      leaks.length,
      `A server-only module reached the SPA's browser-eager import graph and imports an unshimmed node: builtin — it will throw at module-init on :3055 and white-screen the route.\n` +
        `Fix: extract the client-needed type/constant into a client-safe *-shared.ts (see knowledge-packs/candidates-shared.ts) and import from there.\n` +
        `Leaks:${leaks.join("\n")}\n`,
    ).toBe(0);
  });
});

// Guards the SCANNER above. The graph walk is only as honest as its statement
// parser, and a parser bug here is invisible in the worst way: it reports a leak
// that does not exist (red-pinning the gate on a type-only import the bundler
// erases) while simultaneously hiding the edges it ran past. Both directions are
// pinned below, so neither can regress silently.
// Guard: `process.env.NODE_ENV` must never gate behavior directly in the
// client-graph source trees (WI-7002 recurrence guard).
//
// `vite build` pins `process.env.NODE_ENV` to `'production'` regardless of
// `--mode`, and the bundler constant-folds any `process.env.NODE_ENV`
// comparison at BUILD time. Under the default desktop dev shell (`vite build
// --watch --mode development`), that silently and permanently disables every
// `process.env.NODE_ENV === 'development'` / `!== 'production'` dev gate in
// the bundle — with no error, no type failure, and no failing test, because
// the code still typechecks and the guarded branch simply never runs. This
// exact class hit three real sites (AdvShell's unreachable-tab self-check,
// DevReloadGate, lazy-with-retry's chunk-failure auto-reload) before all
// three were fixed to use `import.meta.env.MODE`, which correctly reflects
// `--mode` in every build (dev shell, HMR dev server, and the packaged
// production build) — see
// /internal/docs/agent-insights/dev-only-ui-gating-mode-not-dev.
//
// Scope is deliberately the two client-graph roots this repo's SPA bundles
// through Vite (`apps/operator-vite/src`, `apps/operator/app`) — NOT
// `libs/generic/*`. A domain-free library correctly defaults to
// `process.env.NODE_ENV !== 'production'` (the standard Node/bundler
// convention, e.g. `lazy-with-retry.ts`'s `defaultReloadOnFail`) and lets the
// ONE bundler context where that default is wrong correct it through an
// explicit `configure*()` seam call from a client-graph gate file
// (`lazy-reload-gate.ts`, `query-health-gate.ts`) — banning the pattern
// inside the library itself would break that (intentional, tested) design.
describe("no process.env.NODE_ENV gates in the client-graph source trees", () => {
  const CLIENT_GRAPH_ROOTS = [
    resolve(OPERATOR_VITE, "src"),
    resolve(OPERATOR_ROOT, "app"),
  ];

  function listFiles(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) listFiles(p, out);
      else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !/\.test\.(ts|tsx)$/.test(entry.name)
      )
        out.push(p);
    }
    return out;
  }

  /** Strip comments so a mention in prose (e.g. explaining WHY this guard
   *  exists, or referencing the fixed pattern) is never mistaken for a live
   *  gate. Block comments first, then line comments — mirrors the approach
   *  already used by the scanner above. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it("no client-graph file references process.env.NODE_ENV outside a comment", () => {
    const offenders: string[] = [];
    for (const root of CLIENT_GRAPH_ROOTS) {
      for (const file of listFiles(root, [])) {
        const src = readFileSync(file, "utf8");
        if (/process\.env\.NODE_ENV/.test(stripComments(src))) {
          offenders.push(file.replace(REPO_ROOT + "/", ""));
        }
      }
    }
    expect(
      offenders.length,
      `process.env.NODE_ENV is constant-folded to 'production' by \`vite build\` regardless of ` +
        `--mode, so a dev/prod gate written against it is silently dead code under this repo's ` +
        `dev shell (WI-7002). Use \`import.meta.env.MODE !== 'production'\` instead.\n` +
        `Offenders:\n${offenders.map((f) => `  ${f}`).join("\n")}\n`,
    ).toBe(0);
  });
});

// Guards the RESOLVER. A resolver that silently returns null does not fail — it
// under-walks, and the leak test then reports a confident green about a graph it
// never finished walking. That is exactly how WI-39514 stayed invisible: the walk
// stopped at `@papercusp/db-org` and the six hops to `node:path` behind it were
// never seen. These controls pin both directions so neither can regress quietly.
describe("workspace-package resolution (the WI-39514 blind spot)", () => {
  const from = join(OPERATOR_CORE_LIB, "goal-launch-settings.ts");

  it("follows a workspace package into its SOURCE entry", () => {
    // The exact edge that used to resolve to null.
    const r = resolveSpec("@papercusp/db-org", from);
    expect(
      r,
      "@papercusp/db-org must resolve — a null here restores the blind spot",
    ).toBe(join(REPO_ROOT, "libs/papercusp/libs/db/src/index.ts"));
  });

  it("resolves a subpath export through the package exports map", () => {
    expect(resolveSpec("@papercusp/coordination/presence", from)).toBe(
      join(REPO_ROOT, "packages/coordination/src/presence/index.ts"),
    );
  });

  it("prefers the browser SHIM over the real module when vite aliases one", () => {
    // The false-positive direction: walking the real event-log barrel would report
    // its node:fs backend as a leak the bundler never emits.
    expect(resolveSpec("@papercusp/coordination/event-log", from)).toBe(
      join(OPERATOR_VITE, "src/shims/coordination-event-log-browser.ts"),
    );
  });

  it("does NOT walk into third-party node_modules dependencies", () => {
    expect(resolveSpec("react", from)).toBeNull();
    expect(resolveSpec("zod", from)).toBeNull();
  });

  it("detects an unshimmed node: builtin in a real server module (known-positive)", () => {
    // Calibration: the scanner must actually flag the module at the end of the
    // WI-39514 chain, or the leak test's zero means nothing.
    const shimmed = shimmedNodeBuiltins();
    const target = join(
      REPO_ROOT,
      "libs/generic/embedded-pg-discovery/src/index.ts",
    );
    expect(unsafeNodeBuiltins(target, shimmed)).toContain("node:path");
  });

  it("reports a browser-safe module as clean (known-negative)", () => {
    const shimmed = shimmedNodeBuiltins();
    expect(
      unsafeNodeBuiltins(
        join(OPERATOR_CORE_LIB, "goal-launch-settings-shared.ts"),
        shimmed,
      ),
    ).toEqual([]);
  });
});

describe("import-graph scanner", () => {
  const specs = (src: string) => [...specsIn(src, true)].sort();

  it("a side-effect import does not swallow the statements after it", () => {
    // The 2026-08-02 regression: `[\s\S]*?` let `import './x.css';` run past its own
    // statement to the next `from`, mis-reporting a type-only re-export as a runtime
    // edge — a false leak that red-pinned the fleet gate.
    expect(
      specs(
        "import './x.css';\n\n/** doc */\nexport type {\n  A,\n} from '@srv/mod';\n",
      ),
    ).toEqual(["./x.css"]);
    // ...and every statement it jumped over kept its edge (the under-walk half).
    expect(
      specs(
        "import './x.css';\nimport { a } from 'p';\nimport { b } from 'q';\n",
      ),
    ).toEqual(["./x.css", "p", "q"]);
  });

  it("still records real value edges — including behind a side-effect import", () => {
    expect(
      specs("import './x.css';\nimport { realThing } from '@srv/mod';\n"),
    ).toEqual(["./x.css", "@srv/mod"]);
    expect(specs("import { a } from '@srv/mod';\n")).toEqual(["@srv/mod"]);
    expect(specs("export * from './b';\n")).toEqual(["./b"]);
    expect(specs("import('./lazy')\n")).toEqual(["./lazy"]);
  });

  it("erases type-only statements, which the bundler drops", () => {
    expect(specs("import type { a } from '@srv/mod';\n")).toEqual([]);
    expect(specs("export type {\n  A,\n  B,\n} from '@srv/mod';\n")).toEqual(
      [],
    );
  });

  it("does not treat TypeScript import type queries as runtime dynamic imports", () => {
    expect(
      specs(
        "interface PanelRow { reporterStatus?: Awaited<ReturnType<typeof import('@srv/reporter-status').readReporterStatus>>; }\n",
      ),
    ).toEqual([]);
  });
});

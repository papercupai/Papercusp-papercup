import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// P-006 (plan claude-md-projection-from-pg-2026-08-10) — the PreToolUse guard that
// refuses a hand-edit to a file DECLARING ITSELF GENERATED in its own header.
//
// Every fixture lives in a temp dir OUTSIDE the repo: this tree is swept by git-sync
// every few minutes, so mutating a tracked file to prove a guard fires can commit the
// mutant (EI-19450431506682666). The one exception is the read-only assertions over
// real repo artifacts at the bottom, which never write.

const HERE = dirname(fileURLToPath(import.meta.url));
// The subject is overridable so `scripts/mutation-probe.sh` can prove this suite is
// falsifiable via its COPY-OUT tier — mutate a copy outside the tree and point the
// suite at it, instead of mutating the shared checkout (which git-sync would commit
// mid-probe, EI-19450431506682666). Defaults to the real hook.
const HOOK =
  process.env.PAPERCUSP_GENERATED_GUARD_HOOK ||
  resolve(HERE, "..", "pretooluse-generated-file-edit-guard.mjs");
const REPO = resolve(HERE, "..", "..", "..", "..", "..", "..");

/** Run the hook exactly as Claude Code does: JSON on stdin, read the decision. */
function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): { denied: boolean; reason: string } {
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    // Cleared explicitly so an operator running with the bypass exported cannot
    // silently turn every deny-case here green.
    env: {
      ...process.env,
      PAPERCUSP_ALLOW_GENERATED_EDIT: "",
      ...env,
    } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!out.trim()) return { denied: false, reason: "" };
  const parsed = JSON.parse(out);
  const d = parsed.hookSpecificOutput ?? {};
  return {
    denied: d.permissionDecision === "deny",
    reason: d.permissionDecisionReason ?? "",
  };
}

const edit = (file_path: string, tool = "Edit") => ({
  tool_name: tool,
  tool_input: { file_path },
});
const applyPatch = (
  filePath: string,
  wrapped = false,
  operation = "Update",
) => {
  const patch = `*** Begin Patch\n*** ${operation} File: ${filePath}\n@@\n-old\n+new\n*** End Patch`;
  return { tool_name: "apply_patch", tool_input: wrapped ? { patch } : patch };
};

const GENERATED_HEAD =
  "<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->\n<!-- Projected from Postgres. -->\n\n# Body\n";
const HAND_AUTHORED_HEAD =
  "# Papercup — agent guide\n\n> Invariants + pointers only.\n";

let dir: string;
let generated: string;
let handAuthored: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "generated-guard-"));
  generated = join(dir, "GENERATED.md");
  handAuthored = join(dir, "HAND.md");
  writeFileSync(generated, GENERATED_HEAD, "utf8");
  writeFileSync(handAuthored, HAND_AUTHORED_HEAD, "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("pretooluse-generated-file-edit-guard — falsifiability in both directions", () => {
  it("DENIES an Edit to a file whose header declares it generated", () => {
    const { denied, reason } = runHook(edit(generated));
    expect(denied).toBe(true);
    expect(reason).toMatch(/declares itself GENERATED/);
    expect(reason).toContain(".papercusp/scratch/");
    expect(reason).toContain("code:run");
    expect(reason).toContain("Bash-resource gate");
  });

  it("ALLOWS an Edit to a hand-authored file — the guard must not fire on everything", () => {
    // The control that makes the test above meaningful: without it, a guard that
    // denied unconditionally would pass every other case here.
    expect(runHook(edit(handAuthored)).denied).toBe(false);
  });

  it.each(["Edit", "Write", "MultiEdit"])("covers %s", (tool) => {
    expect(runHook(edit(generated, tool)).denied).toBe(true);
  });

  it.each([
    ["raw", false],
    ["wrapped", true],
  ])(
    "DENIES a %s Codex apply_patch targeting a generated file",
    (_shape, wrapped) => {
      const { denied, reason } = runHook(applyPatch(generated, wrapped));
      expect(denied).toBe(true);
      expect(reason).toContain("apply_patch");
    },
  );

  it("ALLOWS apply_patch on a hand-authored file", () => {
    expect(runHook(applyPatch(handAuthored)).denied).toBe(false);
  });

  it.each(["Edit", "Write", "MultiEdit", "mcp__papercusp-su__capability_edit"])(
    "DENIES %s on installed dependency bytes shared with a frozen snapshot",
    (tool) => {
      const packageDir = join(dir, tool, "node_modules", "postgres");
      mkdirSync(packageDir, { recursive: true });
      const installed = join(packageDir, "connection.js");
      const snapshot = join(dir, tool, "frozen-connection.js");
      writeFileSync(installed, "export const generation = 'frozen';\n");
      linkSync(installed, snapshot);
      const result = runHook(edit(installed, tool));
      expect(result.denied).toBe(true);
      expect(result.reason).toMatch(/installed dependency/i);
      expect(result.reason).toContain("frozen");
      expect(result.reason).toContain("donor");
      expect(readFileSync(snapshot, "utf8")).toContain("'frozen'");
    },
  );

  it("DENIES Codex apply_patch through an alias to an installed package", () => {
    const packageDir = join(dir, "aliased", "node_modules", "postgres");
    mkdirSync(packageDir, { recursive: true });
    const installed = join(packageDir, "connection.js");
    writeFileSync(installed, "export default 1;\n");
    const alias = join(dir, "package-alias");
    symlinkSync(packageDir, alias, "dir");
    expect(runHook(applyPatch(join(alias, "connection.js"))).denied).toBe(true);
  });

  it("DENIES installed package edits before a snapshot is linked and despite the generated-file bypass", () => {
    const packageDir = join(dir, "unique", "node_modules", "postgres");
    mkdirSync(packageDir, { recursive: true });
    const installed = join(packageDir, "connection.js");
    writeFileSync(installed, "export default 1;\n");
    expect(runHook(edit(installed), { PAPERCUSP_ALLOW_GENERATED_EDIT: "1" }).denied).toBe(true);
  });

  it("ALLOWS a workspace source reached through a node_modules symlink", () => {
    const sourceDir = join(dir, "workspace-package");
    mkdirSync(sourceDir);
    const source = join(sourceDir, "source.js");
    writeFileSync(source, "export default 1;\n");
    const moduleDir = join(dir, "workspace-links", "node_modules");
    mkdirSync(moduleDir, { recursive: true });
    symlinkSync(sourceDir, join(moduleDir, "workspace"), "dir");
    expect(runHook(edit(join(moduleDir, "workspace", "source.js"))).denied).toBe(false);
  });

  it("ALLOWS an ordinary hardlinked source outside installed packages", () => {
    const original = join(dir, "ordinary-source.js");
    const alias = join(dir, "ordinary-source-alias.js");
    writeFileSync(original, "export default 1;\n");
    linkSync(original, alias);
    expect(runHook(edit(alias)).denied).toBe(false);
  });

  it("DENIES when any path in a multi-file apply_patch is generated", () => {
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${handAuthored}`,
      "@@",
      "-old",
      "+new",
      `*** Delete File: ${generated}`,
      "*** End Patch",
    ].join("\n");
    expect(
      runHook({ tool_name: "apply_patch", tool_input: { input: patch } })
        .denied,
    ).toBe(true);
  });

  it("DENIES an apply_patch move of a generated source", () => {
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${generated}`,
      `*** Move to: ${join(dir, "RENAMED.md")}`,
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    expect(
      runHook({ tool_name: "apply_patch", tool_input: patch }).denied,
    ).toBe(true);
  });

  it("ignores tools it does not police", () => {
    expect(runHook(edit(generated, "Bash")).denied).toBe(false);
    expect(runHook(edit(generated, "Read")).denied).toBe(false);
  });

  // ── the MCP twins of Edit/Write — a MEASURED hole, not a hypothetical ───────
  // The native three are not the whole set of file-writing tools on this fleet:
  // `capability:edit` / `capability:write` arrive as `mcp__<server>__capability_*`
  // with the SAME `file_path` argument and do the SAME thing. A tool-name check
  // listing only Edit/Write/MultiEdit skipped them before it ever read the file.
  //
  // Measured 2026-08-12: four projected docs under apps/operator-docs were
  // hand-edited within ~20h WHILE this guard was live, registered, and correctly
  // denying native Edits to those exact paths (project-authored-docs.ts --check
  // went exit 0 -> exit 1, 4 drifted). Replaying the hook by hand showed the
  // split precisely: `Edit` denied, `mcp__papercusp-su__capability_edit` allowed.
  it.each([
    "mcp__papercusp-su__capability_edit",
    "mcp__papercusp-su__capability_write",
    // The server segment is deliberately unpinned — renaming the MCP server must
    // not quietly re-open the hole.
    "mcp__some-other-server__capability_write",
  ])("DENIES %s to a generated file (the measured bypass)", (tool) => {
    expect(runHook(edit(generated, tool)).denied).toBe(true);
  });

  it("still ALLOWS the MCP twins on a hand-authored file", () => {
    // The control for the block above: proves those cases pass because the FILE
    // declares itself generated, not because the new matcher denies everything
    // whose name contains "capability_".
    expect(
      runHook(edit(handAuthored, "mcp__papercusp-su__capability_edit")).denied,
    ).toBe(false);
  });

  it("does not police MCP tools that do not write the target file", () => {
    // capability:bash stays OUT on purpose: shell writes are the documented,
    // accepted gap (PreToolUse cannot see `sed -i`), and the structural backstop
    // — the next projection refusing to overwrite drift — is what covers it.
    expect(
      runHook(edit(generated, "mcp__papercusp-su__capability_read")).denied,
    ).toBe(false);
    expect(
      runHook(edit(generated, "mcp__papercusp-su__capability_bash")).denied,
    ).toBe(false);
    // A tool merely CONTAINING "edit" is not a file write.
    expect(
      runHook(edit(generated, "mcp__papercusp-su__plans_edit")).denied,
    ).toBe(false);
  });

  // P-011's second half — "it must BLOCK a hand-edit and ALLOW a projector write" —
  // stated in the only vocabulary this hook has. A projector run is a Bash tool call
  // (or no tool call at all: the generator writes via node:fs), never Edit/Write, so
  // the guard cannot reach it. Asserting it here means a future widening of the
  // matcher that would start policing generator runs fails HERE, loudly, instead of
  // wedging every `gen:*` script on the fleet.
  it("ALLOWS the projector run itself, on a file it otherwise protects", () => {
    expect(
      runHook({
        tool_name: "Bash",
        tool_input: {
          command: "node scripts/project-doc-parts.mjs --write",
          file_path: generated,
        },
      }).denied,
    ).toBe(false);
  });

  it("fails OPEN on an absent file, a missing path, and malformed input", () => {
    expect(runHook(edit(join(dir, "no-such-file.md"))).denied).toBe(false);
    expect(runHook({ tool_name: "Edit", tool_input: {} }).denied).toBe(false);
    expect(
      runHook({
        tool_name: "apply_patch",
        tool_input: { patch: "not a patch" },
      }).denied,
    ).toBe(false);
    expect(runHook({}).denied).toBe(false);
  });

  it("honours the documented session bypass", () => {
    expect(
      runHook(edit(generated), { PAPERCUSP_ALLOW_GENERATED_EDIT: "1" }).denied,
    ).toBe(false);
    // …and only for the sanctioned values, so a stray empty/0 env cannot disarm it.
    expect(
      runHook(edit(generated), { PAPERCUSP_ALLOW_GENERATED_EDIT: "0" }).denied,
    ).toBe(true);
  });
});

describe("the refusal RELAYS the file’s own regenerator instead of hardcoding one", () => {
  // This is the property that lets a NEW generated file get a correct, specific
  // refusal with no change to the hook — and that stops the message drifting out of
  // date the way a hardcoded command would.
  it("quotes the marker line verbatim, including its regeneration command", () => {
    const f = join(dir, "CUSTOM.md");
    writeFileSync(
      f,
      "# T\n\n> **Generated — do not edit by hand.** Run `npm run gen:widgets`.\n",
    );
    const { denied, reason } = runHook(edit(f));
    expect(denied).toBe(true);
    expect(reason).toContain("npm run gen:widgets");
  });
});

describe("predicate precision — each clause is load-bearing", () => {
  const cases: Array<[string, string, boolean]> = [
    ["both tokens on ONE line", "// Generated — do not edit.\n", true],
    [
      "tokens on DIFFERENT lines",
      "# Generated report\n\nPlease do not edit the fixture.\n",
      false,
    ],
    [
      '"do not edit" alone (prose about something else)',
      "// Do not edit this test.\n",
      false,
    ],
    [
      '"generated" alone',
      "// Generated at runtime from the registry.\n",
      false,
    ],
    ["apostrophe form (don't edit)", "// Generated by X. don't edit.\n", true],
    [
      "marker below the 10-line header window",
      `${"x\n".repeat(12)}<!-- GENERATED do not edit -->\n`,
      false,
    ],
    // A 4KB minified .js.map line embedding a banner in sourcesContent was the ONE
    // false positive in the measured tree-wide population; the length cap drops it.
    [
      "minified blob line > 300 chars",
      `{"s":"${"y".repeat(400)} GENERATED do not edit"}\n`,
      false,
    ],
  ];
  it.each(cases)("%s -> deny=%s", (_name, content, expected) => {
    const f = join(dir, `case-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(f, content, "utf8");
    expect(runHook(edit(f)).denied).toBe(expected);
  });

  it("has a passing embedded --self-test", () => {
    const out = execFileSync("node", [HOOK, "--self-test"], {
      encoding: "utf8",
    });
    expect(out).not.toMatch(/FAIL/);
  });
});

describe("the real artifacts this protects in THIS repo", () => {
  // Read-only. Pins that the guard actually reaches the artifacts it was built for,
  // rather than only synthetic fixtures.
  it.each([
    "BORROWABLE.md",
    "AGENT-ENV.md",
    "packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md",
  ])("denies a hand-edit to %s", (rel) => {
    const p = resolve(REPO, rel);
    expect(
      existsSync(p),
      `${rel} should exist — fix the path, do not weaken the test`,
    ).toBe(true);
    expect(runHook(edit(p)).denied).toBe(true);
  });

  // ⚠ Deliberately a PROPERTY, not a fixed expectation. CLAUDE.md is hand-authored
  // today and becomes a projection at the P-006/D-014 cutover, at which point it
  // starts carrying the banner. Asserting "CLAUDE.md is allowed" would red the fleet
  // gate the moment this plan's own cutover lands. What must hold in BOTH eras is
  // that the guard agrees with the file: it denies iff the file declares itself
  // generated — which is exactly the self-arming behaviour the design rests on.
  it("denies CLAUDE.md iff CLAUDE.md declares itself generated (holds across the cutover)", () => {
    const p = resolve(REPO, "CLAUDE.md");
    const head = readFileSync(p, "utf8").split("\n").slice(0, 10);
    const declares = head.some(
      (l) =>
        l.length <= 300 &&
        /\b(?:auto[-\s]?)?generated\b/i.test(l) &&
        /\bdo\s*n(?:o|')?t\s+edit\b/i.test(l),
    );
    expect(runHook(edit(p)).denied).toBe(declares);
  });
});

describe("the canonical internal-docs build mirror", () => {
  const unmarkedMirrorArtifact = resolve(
    REPO,
    "apps/operator/public/internal/docs/agent-insights/.papercusp/memory/raw.md",
  );

  it.each(["Edit", "mcp__papercusp-su__capability_edit"])(
    "DENIES %s to a real mirror artifact even when the legacy artifact has no marker",
    (tool) => {
      expect(
        existsSync(unmarkedMirrorArtifact),
        "the stable read-only mirror fixture should exist — fix the path, do not weaken the test",
      ).toBe(true);
      const firstTenLines = readFileSync(unmarkedMirrorArtifact, "utf8")
        .split("\n")
        .slice(0, 10);
      expect(
        firstTenLines.some(
          (line) =>
            line.length <= 300 &&
            /\b(?:auto[-\s]?)?generated\b/i.test(line) &&
            /\bdo\s*n(?:o|')?t\s+edit\b/i.test(line),
        ),
        "this fixture must stay unmarked so the test exercises path containment, not the marker rule",
      ).toBe(false);

      const { denied, reason } = runHook(edit(unmarkedMirrorArtifact, tool));
      expect(denied).toBe(true);
      expect(reason).toContain("apps/operator-docs/src/content/docs");
      expect(reason).toContain("docs:author");
      expect(reason).toContain(".papercusp/scratch/");
      expect(reason).toContain("code:run");
    },
  );

  it("ALLOWS an outside file whose path merely contains the same directory words", () => {
    const lookalike = join(
      dir,
      "apps/operator/public/internal/docs/LOOKALIKE.md",
    );
    mkdirSync(dirname(lookalike), { recursive: true });
    writeFileSync(lookalike, HAND_AUTHORED_HEAD, "utf8");

    expect(runHook(edit(lookalike)).denied).toBe(false);
    expect(
      runHook(edit(lookalike, "mcp__papercusp-su__capability_edit")).denied,
    ).toBe(false);
  });

  it("preserves the documented bypass and generator-tool exclusion for the mirror rule", () => {
    expect(
      runHook(edit(unmarkedMirrorArtifact), {
        PAPERCUSP_ALLOW_GENERATED_EDIT: "1",
      }).denied,
    ).toBe(false);
    expect(runHook(edit(unmarkedMirrorArtifact, "Bash")).denied).toBe(false);
  });
});

describe("the installed Claude/Codex cc hook runtime mirror", () => {
  let runtimeHome: string;
  let runtimeDir: string;
  let installedHook: string;

  beforeAll(() => {
    runtimeHome = join(dir, "runtime-home");
    runtimeDir = join(runtimeHome, ".papercusp", "hooks", "cc");
    installedHook = join(runtimeDir, "ask-gate-mirror.sh");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(installedHook, HAND_AUTHORED_HEAD, "utf8");
  });

  it.each(["Edit", "mcp__papercusp-su__capability_edit"])(
    "DENIES %s to an installed hook copy and names its canonical source",
    (tool) => {
      const { denied, reason } = runHook(edit(installedHook, tool), {
        HOME: runtimeHome,
      });
      expect(denied).toBe(true);
      expect(reason).toContain("installed runtime copy");
      expect(reason).toContain(
        "apps/operator/scripts/hooks/cc/ask-gate-mirror.sh",
      );
    },
  );

  it("ALLOWS a lookalike hook path outside the current home mirror", () => {
    const lookalike = join(dir, "lookalike", ".papercusp", "hooks", "cc");
    const file = join(lookalike, "ask-gate-mirror.sh");
    mkdirSync(lookalike, { recursive: true });
    writeFileSync(file, HAND_AUTHORED_HEAD, "utf8");

    expect(runHook(edit(file), { HOME: runtimeHome }).denied).toBe(false);
  });
});

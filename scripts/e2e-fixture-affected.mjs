#!/usr/bin/env node
/**
 * Run the fixture-driven Playwright specs a change can break (WI-10006650).
 *
 * Registered as a repo-wide invariant guard on @papercusp/web
 * (`test:e2e:fixture-affected`). affected-tests attaches it only when a changed path sits in
 * some fixture spec's import closure (scripts/lib/e2e-fixture-specs.mjs). Then it forwards
 * the changed paths here and this script runs exactly the specs whose closure contains one.
 *
 * Usage:
 *   node scripts/e2e-fixture-affected.mjs --files=<a,b>   # the affected-tests forwarding form
 *   node scripts/e2e-fixture-affected.mjs --files-from=<json array file>
 *   node scripts/e2e-fixture-affected.mjs --print       # selection only, run nothing
 *   node scripts/e2e-fixture-affected.mjs               # no paths: run EVERY fixture spec
 *
 * The specs boot their own Vite server on an `e2e/__fixtures__` entry. So the operator dev
 * server is never started (`OPERATOR_E2E_REUSE_SERVER=1`), the same contract as
 * `test:phone-media`. No `--reporter` flag is passed: a CLI reporter replaces the config's
 * test-run ledger reporter (EI-25232220211651248), and the ledger row is the evidence.
 *
 * Exit: playwright's own status; 0 when no spec is selected; 2 on a usage or spawn failure.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import {
  E2E_WORKSPACE_DIR,
  fixtureSpecClosures,
  selectFixtureSpecs,
} from "./lib/e2e-fixture-specs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// This entry is called by plain node; register TS resolution before loading the
// maintained runner's source exports (which use .js specifiers for TS files).
register();
const { defaultEvidenceRoot, runHarness } = await import("@papercusp/verification-harness");

function parseArgs(argv) {
  const files = [];
  let print = false;
  for (const arg of argv) {
    if (arg === "--print") print = true;
    else if (arg.startsWith("--files=")) files.push(...arg.slice(8).split(",").filter(Boolean));
    else if (arg.startsWith("--files-from=")) {
      const list = JSON.parse(readFileSync(arg.slice(13), "utf8"));
      if (!Array.isArray(list)) throw new Error(`--files-from must name a JSON array: ${arg}`);
      files.push(...list.map(String));
    } else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else files.push(arg);
  }
  return { files, print };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`E2E_FIXTURE_USAGE_ERROR ${err.message}`);
    return 2;
  }
  const closures = fixtureSpecClosures({ rootDir: ROOT });
  for (const c of closures.filter((c) => !c.ok))
    console.log(`E2E_FIXTURE_CLOSURE_PARTIAL spec=${c.spec} unresolved=${c.unresolved.join(",")}`);
  const selection =
    args.files.length > 0
      ? selectFixtureSpecs({ closures, changedPaths: args.files })
      : { selected: closures.map((c) => c.spec), reasons: {} };
  console.log(
    `E2E_FIXTURE_SELECTION selected=${selection.selected.length} of=${closures.length} ` +
      `mode=${args.files.length > 0 ? "changed-paths" : "all"} specs=${selection.selected.join(",")}`,
  );
  for (const [spec, hits] of Object.entries(selection.reasons))
    console.log(`  ${spec} <- ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ` (+${hits.length - 5})` : ""}`);
  if (args.print || selection.selected.length === 0) return 0;

  const wsDir = path.join(ROOT, E2E_WORKSPACE_DIR);
  const specArgs = selection.selected.map((s) => path.relative(wsDir, path.join(ROOT, s)));
  let exitCode = 0;
  const result = await runHarness({
    contract: { name: "e2e-fixture-affected", phases: [
      { id: "browsers" },
      { id: "playwright", dependsOn: ["browsers"] },
    ] },
    evidenceRoot: defaultEvidenceRoot("e2e-fixture-affected"),
    runPhase: async (ctx) => {
      const browsers = ctx.phase === "browsers";
      ctx.markStep(browsers ? "ensure-playwright-browsers" : "selected-fixture-specs");
      const run = browsers
        ? spawnSync(process.execPath, [path.join(ROOT, "scripts/ensure-playwright-browsers.mjs")], { cwd: ROOT, stdio: "inherit" })
        : spawnSync("npx", ["--no-install", "playwright", "test", ...specArgs, "--workers=1"], {
          cwd: wsDir, stdio: "inherit", env: { ...process.env, OPERATOR_E2E_REUSE_SERVER: "1" },
        });
      if (run.status === 0 && !run.error) return { ok: true };
      exitCode = browsers || run.error ? 2 : (run.status ?? 1);
      const detail = run.error?.message ?? `exit=${run.status ?? run.signal}`;
      console.error(`${browsers ? "E2E_FIXTURE_BROWSERS_MISSING" : "E2E_FIXTURE_SPAWN_ERROR"} ${detail}`);
      return { ok: false, reasonCode: browsers ? "browsers-unavailable" : "playwright-failed", detail };
    },
  });
  return result.verdict === "pass" ? 0 : (exitCode || 1);
}

process.exitCode = await main();

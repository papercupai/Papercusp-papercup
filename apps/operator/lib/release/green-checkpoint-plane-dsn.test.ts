/**
 * WI-10006055: every gate path that runs a LIVE-plane lint must hand it the gate's operator
 * DSN. The first fix forwarded the DSN only through the main post-suite call. Three other
 * paths ran the same lints without one — runPostSuiteAtRef (no options), runGateAtRef and
 * runRepairTickLegs (raw suite env) — so those lints resolved `$PAPERCUSP_HOME/embedded-pg.json`
 * (the installed Server sidecar, 522 agent_facts rows). Round 24 of frozen queue ad82b273
 * reported `lint:plane-integrity` red at 382606c4 (`agent_facts.enforcement 0/522`, plane
 * metrics "regressed"), while the same lints passed against the operator DB (221k+ rows).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIVE_PLANE_LINT_SCRIPTS,
  NON_TEST_GATE_SCRIPTS,
  gateScriptEnv,
  runPostSuiteLegs,
  type CheckpointExec,
} from "./green-checkpoint";

const OPERATOR_DSN = "postgresql://op@localhost:5432/papercusp";

/** Pin the gate process's DSN keys so the default is measured, not inherited. */
function stubGateDsn(url: string | undefined): void {
  vi.stubEnv("HARNESS_ADMIN_DATABASE_URL", "");
  vi.stubEnv("HARNESS_DATABASE_URL", "");
  vi.stubEnv("DATABASE_URL", url ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("live-plane lints get the gate's operator DSN on every path (WI-10006055)", () => {
  it("classifies every script of the lint:plane-integrity re-run group as a live-plane lint", () => {
    const group = NON_TEST_GATE_SCRIPTS["lint:plane-integrity"];
    // Calibration: an empty group would make the containment check below vacuous.
    expect(group?.length ?? 0).toBeGreaterThan(0);
    for (const script of group ?? []) {
      expect(LIVE_PLANE_LINT_SCRIPTS.has(script), script).toBe(true);
    }
  });

  it("gateScriptEnv adds the DSN to a plane lint only, and defaults it from the gate process", () => {
    stubGateDsn(OPERATOR_DSN);
    const suiteEnv = { NODE_ENV: "test" };

    expect(gateScriptEnv("lint:plane-producers", suiteEnv).HARNESS_ADMIN_DATABASE_URL).toBe(
      OPERATOR_DSN,
    );
    expect(gateScriptEnv("lint:plane-ratchet", suiteEnv).HARNESS_ADMIN_DATABASE_URL).toBe(
      OPERATOR_DSN,
    );
    // A non-plane leg stays DSN-free: the candidate suite must not touch the operator DB.
    expect(gateScriptEnv("lint:tsc", suiteEnv)).toBe(suiteEnv);
    expect(gateScriptEnv("test:lane-stateful", suiteEnv).HARNESS_ADMIN_DATABASE_URL).toBeUndefined();
    // An explicit empty override opts out.
    expect(gateScriptEnv("lint:plane-producers", suiteEnv, {}).HARNESS_ADMIN_DATABASE_URL).toBeUndefined();
    // The suite env object is never mutated.
    expect(suiteEnv).toEqual({ NODE_ENV: "test" });
  });

  it("gateScriptEnv leaves a plane lint's resolution alone when the gate itself has no DSN", () => {
    stubGateDsn(undefined);
    expect(
      gateScriptEnv("lint:plane-producers", { NODE_ENV: "test" }).HARNESS_ADMIN_DATABASE_URL,
    ).toBeUndefined();
  });

  it("runPostSuiteLegs with no options (the runPostSuiteAtRef call) still hands plane lints the DSN", async () => {
    stubGateDsn(OPERATOR_DSN);
    const dir = mkdtempSync(join(tmpdir(), "green-postsuite-plane-dsn-default-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: Object.fromEntries(
            ["lint:tsc", "lint:plane-producers", "lint:plane-ratchet"].map((script) => [
              script,
              `node ${script}.mjs`,
            ]),
          ),
        }),
      );
      const seen = new Map<string, string | undefined>();
      const exec: CheckpointExec = async (cmd, args, opts) => {
        const runIndex = args.indexOf("run");
        const id = cmd === "npm" && runIndex >= 0 ? args[runIndex + 1]! : cmd;
        seen.set(id, opts?.env?.HARNESS_ADMIN_DATABASE_URL);
        return { code: 0, stdout: "", stderr: "" };
      };

      await runPostSuiteLegs(dir, { NODE_ENV: "test" }, exec, "apps/operator");

      // Calibration: both kinds of leg actually ran, so the assertions below measure something.
      expect(seen.has("lint:plane-producers")).toBe(true);
      expect(seen.has("lint:tsc")).toBe(true);
      expect(seen.get("lint:plane-producers")).toBe(OPERATOR_DSN);
      expect(seen.get("lint:plane-ratchet")).toBe(OPERATOR_DSN);
      expect(seen.get("lint:tsc")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * WI-6554700010009206: lint:migrations reads the reservation ledger
 * (`harness_shared.migration_reservations`) from the operator DB, but it was missing from
 * LIVE_PLANE_LINT_SCRIPTS and its runPostSuiteLegs exec got the DSN-free suite env. In the
 * checkpoint tree (no apps/operator/.env.local) it resolved the embedded-pg sidecar (:24680),
 * which has no reservation rows. Frozen candidate 70e89c73 went red with "917, 1130,
 * 1417..1465 on disk without a reservation row", while the same lint passed in the shared tree.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Does this script source open Postgres through the shared script resolver chain
 *  (scripts/lib/pg-url.mjs)? An import of the module alone is not enough: some scripts
 *  import only `applyEnvLocal`. Neither is a bare mention: lint-tsc-scripts.mjs names
 *  pg-url in a comment. Both conditions must hold. */
function opensPgViaScriptResolver(source: string): boolean {
  const importsResolver =
    /\bfrom\s+["'][^"']*\/pg-url\.mjs["']/.test(source) ||
    /\bimport\(\s*["'][^"']*\/pg-url\.mjs["']\s*\)/.test(source);
  return importsResolver && /\b(?:resolveScriptPgUrl|connectScriptPg)\b/.test(source);
}

/** The scripts/ files an npm script command executes directly (not transitive imports). */
function scriptEntrypoints(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s=])\.?\/?(scripts\/[\w./-]+\.(?:mjs|ts|js))\b/g)].map(
    (m) => m[1]!,
  );
}

describe("lint:migrations gets the gate's operator DSN (WI-6554700010009206)", () => {
  it("classifies lint:migrations as an operator-DB lint, and keeps its PG-free sibling DSN-free", () => {
    stubGateDsn(OPERATOR_DSN);
    const suiteEnv = { NODE_ENV: "test" };

    // runGateAtRef and runRepairTickLegs build every registered leg's env through gateScriptEnv.
    expect(NON_TEST_GATE_SCRIPTS["lint:migrations"]).toEqual(["lint:migrations"]);
    expect(LIVE_PLANE_LINT_SCRIPTS.has("lint:migrations")).toBe(true);
    expect(gateScriptEnv("lint:migrations", suiteEnv).HARNESS_ADMIN_DATABASE_URL).toBe(
      OPERATOR_DSN,
    );
    // lint:migration-forward-compat is a pure filesystem check, so it stays DSN-free.
    expect(gateScriptEnv("lint:migration-forward-compat", suiteEnv)).toBe(suiteEnv);
  });

  it("runPostSuiteLegs hands lint:migrations the DSN, preferring an explicit operatorPgEnv", async () => {
    stubGateDsn(OPERATOR_DSN);
    const dir = mkdtempSync(join(tmpdir(), "green-postsuite-migrations-dsn-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: Object.fromEntries(
            ["lint:tsc", "lint:migrations"].map((script) => [script, `node ${script}.mjs`]),
          ),
        }),
      );
      const runOnce = async (
        options?: Parameters<typeof runPostSuiteLegs>[4],
      ): Promise<Map<string, string | undefined>> => {
        const seen = new Map<string, string | undefined>();
        const exec: CheckpointExec = async (cmd, args, opts) => {
          const runIndex = args.indexOf("run");
          const id = cmd === "npm" && runIndex >= 0 ? args[runIndex + 1]! : cmd;
          seen.set(id, opts?.env?.HARNESS_ADMIN_DATABASE_URL);
          return { code: 0, stdout: "", stderr: "" };
        };
        // The suite env carries no DSN, as in production (canonicalGreenCheckpointSourceEnv).
        await runPostSuiteLegs(dir, { NODE_ENV: "test" }, exec, "apps/operator", options);
        return seen;
      };

      // No options: the runPostSuiteAtRef call shape. The DSN defaults from the gate process.
      const defaulted = await runOnce();
      // Calibration: the leg actually ran, so the assertions below measure something.
      expect(defaulted.has("lint:migrations")).toBe(true);
      expect(defaulted.has("lint:tsc")).toBe(true);
      expect(defaulted.get("lint:migrations")).toBe(OPERATOR_DSN);
      expect(defaulted.get("lint:tsc")).toBeUndefined();

      // An explicit operatorPgEnv (the main post-suite call) wins over the process default.
      const explicitDsn = "postgresql://explicit@localhost:5432/papercusp";
      const explicit = await runOnce({ operatorPgEnv: { HARNESS_ADMIN_DATABASE_URL: explicitDsn } });
      expect(explicit.get("lint:migrations")).toBe(explicitDsn);
      expect(explicit.get("lint:tsc")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the resolver detector matches real imports only, not comment mentions", () => {
    expect(
      opensPgViaScriptResolver(`import { resolveScriptPgUrl } from "./lib/pg-url.mjs";`),
    ).toBe(true);
    expect(
      opensPgViaScriptResolver(
        `const { resolveScriptPgUrl } = await import('./lib/pg-url.mjs');`,
      ),
    ).toBe(true);
    expect(opensPgViaScriptResolver(`import { connectScriptPg } from './lib/pg-url.mjs';`)).toBe(
      true,
    );
    // The lint-tsc-scripts.mjs shape: pg-url named in a comment, never imported.
    expect(opensPgViaScriptResolver(`// companions (pg-url, okf-backfill-packs, …)`)).toBe(false);
    // The lint-as-committed.mjs shape: imports the module for env loading only, opens no PG.
    expect(opensPgViaScriptResolver(`import { applyEnvLocal } from './lib/pg-url.mjs';`)).toBe(
      false,
    );
  });

  it("every registered gate leg whose entrypoint opens PG through pg-url.mjs gets the operator DSN", () => {
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const registered = [...new Set(Object.values(NON_TEST_GATE_SCRIPTS).flat())];

    const opensPg: string[] = [];
    const pgFree: string[] = [];
    for (const script of registered) {
      const command = scripts[script];
      if (!command) continue; // the gate skips a leg the tree does not declare
      const files = scriptEntrypoints(command).filter((f) => existsSync(join(REPO_ROOT, f)));
      const reachesPg = files.some((f) =>
        opensPgViaScriptResolver(readFileSync(join(REPO_ROOT, f), "utf8")),
      );
      (reachesPg ? opensPg : pgFree).push(script);
    }

    // Calibration, both ways: the known PG leg is detected, and the detector does not flag
    // every leg, so an empty `missing` below is a measurement rather than a vacuous pass.
    expect(opensPg).toContain("lint:migrations");
    expect(pgFree).toContain("lint:tsc");

    const missing = opensPg.filter((script) => !LIVE_PLANE_LINT_SCRIPTS.has(script));
    expect(
      missing,
      "these gate legs open PG via scripts/lib/pg-url.mjs but would run without the operator DSN, " +
        "so in the checkpoint tree they would read the embedded-pg discovery DB; add them to " +
        "LIVE_PLANE_LINT_SCRIPTS",
    ).toEqual([]);
  });
});

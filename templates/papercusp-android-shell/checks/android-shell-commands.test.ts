/**
 * Android host acceptance with atomic machine-readable evidence.
 * Config: TEMPLATE_CHECKS_CONFIG.androidShell.assertions.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runAndroidAssertionCommand,
  validateAndroidCommandPlan,
  type AndroidShellSection,
} from "./android-shell-contract.js";

const untilde = (path: string): string =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const configPath = process.env.TEMPLATE_CHECKS_CONFIG;
const config: Record<string, any> | null = configPath
  ? JSON.parse(readFileSync(resolve(untilde(configPath)), "utf8"))
  : null;
const appRoot: string | null = config
  ? resolve(
      dirname(resolve(untilde(configPath!))),
      untilde(config.app?.root ?? "."),
    )
  : null;
const section = config?.androidShell as AndroidShellSection | undefined;
const DEFAULT_TIMEOUT_MS = 600_000;
const OUTER_GRACE_MS = 5_000;
const outerTimeout =
  Math.max(
    DEFAULT_TIMEOUT_MS,
    ...(section?.assertions ?? []).map(
      (entry) => entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ),
  ) + OUTER_GRACE_MS;

function findMobileRepo(): string | null {
  const configured = process.env.PAPERCUP_MOBILE_REPO;
  const candidates = configured ? [resolve(configured)] : [];
  let ancestor = resolve(__dirname);
  for (;;) {
    candidates.push(join(ancestor, "papercup-rust-mobile"));
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return candidates.find((candidate) => existsSync(join(candidate, "Makefile"))) ?? null;
}

const mobileRepo = findMobileRepo();
// The desktop build copies template checks into its ignored sidecar tree. The
// monorepo test route sees both copies; only the canonical template should run
// this repository-level mobile gate so duplicate make invocations do not race.
const isGeneratedDesktopSidecar = /[\\/]papercusp-desktop[\\/]src-tauri[\\/]sidecar[\\/]/u.test(
  __dirname,
);

describe.skipIf(isGeneratedDesktopSidecar)("R-6 Android CI reachability detector", () => {
  it("keeps managed skip-ci commits on the complete automatic verification route", () => {
    expect(
      mobileRepo,
      "papercup-rust-mobile must be available via PAPERCUP_MOBILE_REPO or an ancestor checkout",
    ).toBeTruthy();
    if (!mobileRepo) return;
    const guard = spawnSync("make", ["test-android-ci"], {
      cwd: mobileRepo,
      encoding: "utf8",
    });
    expect(
      guard.status,
      [guard.error?.message, guard.stdout, guard.stderr]
        .filter(Boolean)
        .join("\n"),
    ).toBe(0);
    expect(guard.stdout).toContain(
      "Independent Android CI trigger/ownership/admission contract: passed",
    );
    expect(guard.stdout).toMatch(/mutation controls: \d+ rejected/u);
  }, 180_000);
});

describe.skipIf(!section)("android-shell-assertions", () => {
  it("keeps the outer Vitest budget beyond every child command", () => {
    const largestChild = Math.max(
      DEFAULT_TIMEOUT_MS,
      ...section!.assertions.map(
        (entry) => entry.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ),
    );
    expect(outerTimeout).toBeGreaterThan(largestChild);
  });

  it("declares the complete required assertion plan", () => {
    expect(validateAndroidCommandPlan(section!)).toEqual([]);
  });

  it.each(section?.assertions ?? [])(
    "$assertionId/$leg",
    (entry) => {
      const result = runAndroidAssertionCommand(
        appRoot!,
        section!.evidenceDir,
        entry,
      );
      expect(
        result.evidence.verdict,
        `${result.evidence.identity}: ${result.evidence.verdict}\nevidence: ${result.evidencePath}\n${result.output}`,
      ).toBe("pass");
    },
    outerTimeout,
  );
});
